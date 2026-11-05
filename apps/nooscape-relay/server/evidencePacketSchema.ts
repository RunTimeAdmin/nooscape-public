import { z } from "zod";

/**
 * A signed evidence packet as the relay's procedures and the free verify endpoint take it. Unknown fields are dropped and the rest is
 * rebuilt in this order, which is the order the relay signed them in; verifier/src/verify.ts `readPacket` does the same for the package,
 * and server/evidencePacket.test.ts holds the two to the same answer.
 */
export const evidencePacketSchema = z.object({
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
