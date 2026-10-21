import { TRPCError } from "@trpc/server";
import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { createPersistedEvidenceEnvelope, findRelayKey, signedAfterRetirement, type RelayKeyStatus } from "./evidence";
import { getPublisherValidationForAgent, isAgentPubliclyVisible } from "./db";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { apiKeysRouter } from "./routers/apiKeys";
import { apiPaymentsRouter } from "./routers/apiPayments";
import { claimRouter } from "./routers/claim";
import { liveDataRouter } from "./routers/liveData";
import { operatorRouter } from "./routers/operator";

/** A visible record's signed evidence, or not-found when none is retained for it. */
async function getEvidenceEnvelope(agentId: string) {
  const publisherValidation = await getPublisherValidationForAgent(agentId);
  const envelope = await createPersistedEvidenceEnvelope(agentId, publisherValidation);
  if (!envelope) throw new TRPCError({ code: "NOT_FOUND", message: "No evidence is retained for this agent." });
  return envelope;
}

const evidencePacketSchema = z.object({
  format: z.literal("Nooscape Signed Evidence Envelope v1"),
  exportedAt: z.string(),
  verification: z.object({
    signatureAlgorithm: z.string(),
    signedField: z.string(),
    publicKeyPem: z.string(),
    instructions: z.string(),
  }),
  envelope: z.object({
    agentId: z.string(),
    observedAt: z.string(),
    sequence: z.number(),
    algorithm: z.string(),
    integrityHash: z.string(),
    signatureAlgorithm: z.string(),
    signature: z.string(),
    relayPublicKeyPem: z.string(),
    relayKeyId: z.string().optional(),
    canonicalPayload: z.string(),
    relayMode: z.string(),
    publisherValidation: z.object({
      status: z.enum(["allowlisted", "expired", "revoked", "unverified"]),
      publisherName: z.string().nullable(),
      publicKeyFingerprint: z.string().nullable(),
      verifiedAt: z.string().nullable(),
      statusChangedAt: z.string().nullable(),
    }).optional(),
    entries: z.array(z.object({
      id: z.string(),
      observedAt: z.string(),
      event: z.string(),
      detail: z.string(),
      source: z.string(),
      proofReference: z.string(),
      provenance: z.object({
        observationId: z.string(),
        contentHash: z.string(),
        canonicalLocator: z.string(),
        validationStatus: z.enum(["valid", "invalid", "partial"]),
      }).optional(),
    })),
    provenance: z.object({
      evidenceClass: z.literal("persisted-observation"),
      sourceLabel: z.string(),
      sourceRoot: z.string(),
      canonicalLocator: z.string(),
      contentHash: z.string(),
      rawPayloadAccess: z.literal("private-object-store"),
      retentionPolicy: z.string(),
      validationStatus: z.enum(["valid", "invalid", "partial"]),
    }).optional(),
  }),
});

function verifyEvidencePacket(packet: z.infer<typeof evidencePacketSchema>) {
  const { envelope, verification } = packet;
  const issues: string[] = [];
  const keyMatchesEnvelope = verification.publicKeyPem === envelope.relayPublicKeyPem;
  const hashValid = createHash("sha256").update(envelope.canonicalPayload).digest("hex") === envelope.integrityHash;
  let signatureValid = false;

  // The signature only covers the opaque canonicalPayload string, so the
  // verifier must rebuild that string from the displayed envelope fields and
  // require byte equality — otherwise a tampered agentId, entries array, or
  // publisherValidation block rides along on an untouched signature and the
  // packet reports `valid` while echoing forged content (review 2026-10-12).
  // The payload shape is exactly what sealEvidencePayload signed at issuance
  // (evidence.ts createPersistedEvidenceEnvelope), key order included.
  const payloadMatchesEnvelopeFields =
    JSON.stringify({
      envelopeVersion: "Nooscape Persisted Evidence v1",
      agentId: envelope.agentId,
      observedAt: envelope.observedAt,
      publisherValidation: envelope.publisherValidation,
      provenance: envelope.provenance,
      entries: envelope.entries,
    }) === envelope.canonicalPayload;
  if (!payloadMatchesEnvelopeFields) {
    issues.push("The signed canonical payload does not match the envelope's displayed fields.");
  }

  if (envelope.signatureAlgorithm !== "Ed25519" || verification.signatureAlgorithm !== "Ed25519") {
    issues.push("Unsupported signature algorithm; expected Ed25519.");
  }
  if (verification.signedField !== "envelope.canonicalPayload") {
    issues.push("The exported packet does not declare the expected signed payload.");
  }
  if (!keyMatchesEnvelope) {
    issues.push("The verification key does not match the key embedded in the evidence envelope.");
  }
  if (!hashValid) {
    issues.push("The SHA-256 digest does not match the canonical payload.");
  }

  try {
    signatureValid = verify(
      null,
      Buffer.from(envelope.canonicalPayload),
      createPublicKey(verification.publicKeyPem),
      Buffer.from(envelope.signature, "base64")
    );
  } catch {
    issues.push("The embedded public key or signature could not be parsed.");
  }
  if (!signatureValid) {
    issues.push("The Ed25519 signature is invalid for this canonical payload.");
  }

  // A packet is trusted when its key is the active one, or a retired one and the packet predates the retirement, so
  // rotating the signing key does not invalidate what was issued before. A revoked key, or one the relay never
  // published, is not trusted. issuedByCurrentRelay keeps its old meaning (the key that signs today); keyStatus says
  // which kind of key it was.
  const keyEntry = findRelayKey(envelope.relayKeyId, envelope.relayPublicKeyPem);
  // Annotated so the answer's type stays the four names and does not widen to string in the client.
  const keyStatus: RelayKeyStatus = keyEntry?.status ?? "unknown";
  const lateSigned = signedAfterRetirement(keyEntry, envelope.observedAt);
  const issuedByCurrentRelay = keyMatchesEnvelope && keyStatus === "active";
  const keyTrusted = issuedByCurrentRelay || (keyMatchesEnvelope && keyStatus === "retired" && !lateSigned);
  if (keyStatus === "revoked") {
    issues.push("The key that signed this packet has been revoked by Nooscape. Do not rely on it.");
  } else if (lateSigned) {
    issues.push("This packet is dated after the key that signed it was retired. A retired key should not sign new packets.");
  } else if (!keyTrusted) {
    issues.push("The envelope key is not pinned as an active Nooscape relay key.");
  }
  const publisherValidation = envelope.publisherValidation;
  // The relay states a publisher's standing when it issues a packet and the signature covers that statement, so it
  // counts only when the whole proof chain holds: the digest, the signature, the key and the displayed fields. It also
  // needs the key that signs today: a standing is a present-tense claim, and a packet from a retired key is old.
  const publisherKeyAllowlisted = Boolean(
    hashValid && signatureValid && keyMatchesEnvelope && payloadMatchesEnvelopeFields && issuedByCurrentRelay &&
    publisherValidation?.status === "allowlisted" &&
    publisherValidation.publisherName &&
    publisherValidation.publicKeyFingerprint
  );
  return {
    valid: hashValid && signatureValid && keyMatchesEnvelope && payloadMatchesEnvelopeFields && keyTrusted && issues.length === 0,
    hashValid,
    signatureValid,
    keyMatchesEnvelope,
    payloadMatchesEnvelopeFields,
    issuedByCurrentRelay,
    keyStatus,
    // The relay-authorship flag must rest on the whole proof chain: a forger
    // can copy the pinned public key and mirror the displayed fields, so key
    // pinning and field binding alone prove nothing. It is deliberately not
    // plain `valid`, which also folds in packet-shape issues (declared
    // signed field, algorithm headers) that do not bear on who signed it.
    verifiedByNooscape:
      hashValid && signatureValid && keyMatchesEnvelope && payloadMatchesEnvelopeFields && keyTrusted,
    agentId: envelope.agentId,
    observedAt: envelope.observedAt,
    sequence: envelope.sequence,
    entryCount: envelope.entries.length,
    signatureAlgorithm: envelope.signatureAlgorithm,
    publisherKeyAllowlisted,
    publisherName: publisherKeyAllowlisted ? publisherValidation?.publisherName ?? null : null,
    issues,
  };
}

export const appRouter = router({
  system: systemRouter,
  atlas: router({
    evidence: publicProcedure.input(z.object({ agentId: z.string() })).query(async ({ input }) => {
      const visible = await isAgentPubliclyVisible(input.agentId);
      if (!visible) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found." });
      }
      return getEvidenceEnvelope(input.agentId);
    }),
    verifyEvidence: publicProcedure.input(z.object({ packet: evidencePacketSchema })).mutation(({ input }) => verifyEvidencePacket(input.packet)),
  }),
  liveData: liveDataRouter,
  operator: operatorRouter,
  claim: claimRouter,
  apiKeys: apiKeysRouter,
  apiPayments: apiPaymentsRouter,
});

export type AppRouter = typeof appRouter;
