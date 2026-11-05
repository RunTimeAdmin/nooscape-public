import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

/**
 * Checks a Nooscape signed evidence packet (docs/verifier-2026-11-05.md). One file, no dependency but Node's crypto, and no network:
 * the server's `atlas.verifyEvidence`, the free `POST /api/v1/verify` and the `nooscape-verify` package all run this code, so they cannot
 * disagree about the same packet.
 *
 * What a check proves, and what it does not. It proves that the packet is the one a key signed (the SHA-256 digest of the canonical
 * payload, the Ed25519 signature over it, and the displayed fields rebuilt into that payload byte for byte), and that the key is one the
 * given key list publishes: active, or retired and the packet dated before the retirement. It says nothing about the agent the packet
 * is about, and it is only as trustworthy as the key list it is given.
 */

export const PACKET_FORMAT = "Nooscape Signed Evidence Envelope v1";
export const KEY_MANIFEST_FORMAT = "Nooscape Relay Key Manifest v1";
const PAYLOAD_VERSION = "Nooscape Persisted Evidence v1";

export type KeyStatus = "active" | "retired" | "revoked" | "unknown";

/** One line of the key list the relay publishes at /.well-known/nooscape-keys.json. */
export type RelayKey = {
  keyId: string;
  publicKeyPem: string;
  status: Exclude<KeyStatus, "unknown">;
  retiredAt?: string;
  note?: string;
};

export type PublisherValidation = {
  status: "allowlisted" | "expired" | "revoked" | "unverified";
  publisherName: string | null;
  publicKeyFingerprint: string | null;
  verifiedAt: string | null;
  statusChangedAt: string | null;
};

type ValidationStatus = "valid" | "invalid" | "partial";

export type EvidenceEntry = {
  id: string;
  observedAt: string;
  event: string;
  detail: string;
  source: string;
  proofReference: string;
  provenance?: { observationId: string; contentHash: string; canonicalLocator: string; validationStatus: ValidationStatus };
};

export type EvidenceEnvelope = {
  agentId: string;
  observedAt: string;
  sequence: number;
  algorithm: string;
  integrityHash: string;
  signatureAlgorithm: string;
  signature: string;
  relayPublicKeyPem: string;
  relayKeyId?: string;
  canonicalPayload: string;
  relayMode: string;
  publisherValidation?: PublisherValidation;
  entries: EvidenceEntry[];
  provenance?: {
    evidenceClass: "persisted-observation";
    sourceLabel: string;
    sourceRoot: string;
    canonicalLocator: string;
    contentHash: string;
    rawPayloadAccess: "private-object-store";
    retentionPolicy: string;
    validationStatus: ValidationStatus;
  };
};

export type EvidencePacket = {
  format: typeof PACKET_FORMAT;
  exportedAt: string;
  verification: { signatureAlgorithm: string; signedField: string; publicKeyPem: string; instructions: string };
  envelope: EvidenceEnvelope;
};

export type VerifyResult = {
  valid: boolean;
  hashValid: boolean;
  signatureValid: boolean;
  keyMatchesEnvelope: boolean;
  payloadMatchesEnvelopeFields: boolean;
  issuedByCurrentRelay: boolean;
  keyStatus: KeyStatus;
  verifiedByNooscape: boolean;
  agentId: string;
  observedAt: string;
  sequence: number;
  entryCount: number;
  signatureAlgorithm: string;
  publisherKeyAllowlisted: boolean;
  publisherName: string | null;
  issues: string[];
};

/**
 * The one written form of a public key: what Node exports, which is also what every signed packet carries in
 * relayPublicKeyPem. Two spellings of one key (line breaks, a missing final newline) compare equal after this.
 */
export const canonicalPem = (pem: string) => createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();

/**
 * The entry a packet's key falls under, or undefined. Both the id and the key bytes must match, so a forger who
 * copies a key id with their own key, or a real key under a new id, finds nothing. A revoked entry wins over
 * everything else, then the active one, then a retired one.
 */
export function findKey(keys: readonly RelayKey[], keyId: string | undefined, publicKeyPem: string): RelayKey | undefined {
  if (!keyId) return undefined;
  let pem: string;
  try {
    pem = canonicalPem(publicKeyPem);
  } catch {
    return undefined;
  }
  const matches = keys.filter(entry => entry.keyId === keyId && entry.publicKeyPem === pem);
  return matches.find(entry => entry.status === "revoked") ?? matches.find(entry => entry.status === "active") ?? matches.find(entry => entry.status === "retired");
}

/**
 * True when a packet is dated after the key that signed it was retired, or its date cannot be read. A retired key
 * should not sign anything new, so such a packet points at an old instance that is still running, or at a copied key.
 * This is a guard against mistakes. It does not stop someone who holds a leaked key, because the date is inside the
 * packet and they choose it. A leaked key is stopped by marking it "revoked".
 */
export function signedAfterRetirement(entry: RelayKey | undefined, observedAt: string): boolean {
  if (entry?.status !== "retired" || !entry.retiredAt) return false;
  return !(Date.parse(observedAt) <= Date.parse(entry.retiredAt));
}

/**
 * Checks one packet against a key list. `keys` is the list the caller trusts: the relay passes its own, and the package reads
 * the published one. A packet whose key is not in the list is reported with keyStatus "unknown" and is never trusted.
 */
export function verifyEvidencePacket(packet: EvidencePacket, keys: readonly RelayKey[]): VerifyResult {
  const { envelope, verification } = packet;
  const issues: string[] = [];
  const keyMatchesEnvelope = verification.publicKeyPem === envelope.relayPublicKeyPem;
  const hashValid = createHash("sha256").update(envelope.canonicalPayload).digest("hex") === envelope.integrityHash;
  let signatureValid = false;

  // The signature only covers the opaque canonicalPayload string, so the
  // verifier must rebuild that string from the displayed envelope fields and
  // require byte equality; otherwise a tampered agentId, entries array, or
  // publisherValidation block rides along on an untouched signature and the
  // packet reports `valid` while echoing forged content (review 2026-10-12).
  // The payload shape is exactly what sealEvidencePayload signed at issuance
  // (evidence.ts createPersistedEvidenceEnvelope), key order included.
  const payloadMatchesEnvelopeFields =
    JSON.stringify({
      envelopeVersion: PAYLOAD_VERSION,
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
    signatureValid = verifySignature(
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
  const keyEntry = findKey(keys, envelope.relayKeyId, envelope.relayPublicKeyPem);
  // Annotated so the answer's type stays the four names and does not widen to string in the client.
  const keyStatus: KeyStatus = keyEntry?.status ?? "unknown";
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
  // needs the key that signs today. That ties a standing to key rotation and not to the clock: it is the standing the relay held when it
  // issued the packet, and the publisher is not looked up again here. Read it as "allowlisted when this packet was issued"
  // (docs/evidence-key-rotation.md).
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
    // Echoed from beside the signed bytes, not from inside them: a label, not a checkpoint. entryCount is the signed one.
    sequence: envelope.sequence,
    entryCount: envelope.entries.length,
    signatureAlgorithm: envelope.signatureAlgorithm,
    publisherKeyAllowlisted,
    publisherName: publisherKeyAllowlisted ? publisherValidation?.publisherName ?? null : null,
    issues,
  };
}

// ---------------------------------------------------------------- reading what a person hands over

class ShapeError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const reject = (path: string, want: string): never => {
  throw new ShapeError(`${path} must be ${want}`);
};
const text = (value: unknown, path: string) => (typeof value === "string" ? value : reject(path, "a string"));
const nullableText = (value: unknown, path: string) => (value === null ? null : text(value, path));
const count = (value: unknown, path: string) => (typeof value === "number" && Number.isFinite(value) ? value : reject(path, "a number"));
const record = (value: unknown, path: string) => (isObject(value) ? value : reject(path, "an object"));
const oneOf = <T extends string>(value: unknown, path: string, allowed: readonly T[]): T => (allowed.includes(value as T) ? (value as T) : reject(path, `one of ${allowed.join(", ")}`));
const exactly = <T extends string>(value: unknown, path: string, want: T): T => (value === want ? want : reject(path, `"${want}"`));
const present = <T>(value: unknown, read: (value: unknown) => T): T | undefined => (value === undefined ? undefined : read(value));

const VALIDATION: readonly ValidationStatus[] = ["valid", "invalid", "partial"];

/**
 * A packet handed over as JSON, checked for shape and rebuilt the way the signed payload is: only the fields the packet defines, in
 * the order the relay wrote them. The relay's own `atlas.verifyEvidence` does the same through its schema, and a test holds the two to
 * the same answer for the same input. A packet that is not in this shape is refused with the field that is wrong; one that is, is
 * not yet believed (verifyEvidencePacket decides that).
 */
export function readPacket(input: unknown): { ok: true; packet: EvidencePacket } | { ok: false; error: string } {
  try {
    const root = record(input, "the packet");
    // The format first: a file that is not a packet at all should be told so before it is told which of its fields is missing.
    const format = exactly(root.format, "format", PACKET_FORMAT);
    const verification = record(root.verification, "verification");
    const e = record(root.envelope, "envelope");
    const publisherValidation = present(e.publisherValidation, value => {
      const p = record(value, "envelope.publisherValidation");
      return {
        status: oneOf(p.status, "envelope.publisherValidation.status", ["allowlisted", "expired", "revoked", "unverified"] as const),
        publisherName: nullableText(p.publisherName, "envelope.publisherValidation.publisherName"),
        publicKeyFingerprint: nullableText(p.publicKeyFingerprint, "envelope.publisherValidation.publicKeyFingerprint"),
        verifiedAt: nullableText(p.verifiedAt, "envelope.publisherValidation.verifiedAt"),
        statusChangedAt: nullableText(p.statusChangedAt, "envelope.publisherValidation.statusChangedAt"),
      };
    });
    if (!Array.isArray(e.entries)) reject("envelope.entries", "a list");
    const entries = (e.entries as unknown[]).map((item, index): EvidenceEntry => {
      const path = `envelope.entries[${index}]`;
      const entry = record(item, path);
      const provenance = present(entry.provenance, value => {
        const p = record(value, `${path}.provenance`);
        return {
          observationId: text(p.observationId, `${path}.provenance.observationId`),
          contentHash: text(p.contentHash, `${path}.provenance.contentHash`),
          canonicalLocator: text(p.canonicalLocator, `${path}.provenance.canonicalLocator`),
          validationStatus: oneOf(p.validationStatus, `${path}.provenance.validationStatus`, VALIDATION),
        };
      });
      return {
        id: text(entry.id, `${path}.id`),
        observedAt: text(entry.observedAt, `${path}.observedAt`),
        event: text(entry.event, `${path}.event`),
        detail: text(entry.detail, `${path}.detail`),
        source: text(entry.source, `${path}.source`),
        proofReference: text(entry.proofReference, `${path}.proofReference`),
        ...(provenance ? { provenance } : {}),
      };
    });
    const provenance = present(e.provenance, value => {
      const p = record(value, "envelope.provenance");
      return {
        evidenceClass: exactly(p.evidenceClass, "envelope.provenance.evidenceClass", "persisted-observation"),
        sourceLabel: text(p.sourceLabel, "envelope.provenance.sourceLabel"),
        sourceRoot: text(p.sourceRoot, "envelope.provenance.sourceRoot"),
        canonicalLocator: text(p.canonicalLocator, "envelope.provenance.canonicalLocator"),
        contentHash: text(p.contentHash, "envelope.provenance.contentHash"),
        rawPayloadAccess: exactly(p.rawPayloadAccess, "envelope.provenance.rawPayloadAccess", "private-object-store"),
        retentionPolicy: text(p.retentionPolicy, "envelope.provenance.retentionPolicy"),
        validationStatus: oneOf(p.validationStatus, "envelope.provenance.validationStatus", VALIDATION),
      };
    });
    const relayKeyId = present(e.relayKeyId, value => text(value, "envelope.relayKeyId"));
    const packet: EvidencePacket = {
      format,
      exportedAt: text(root.exportedAt, "exportedAt"),
      verification: {
        signatureAlgorithm: text(verification.signatureAlgorithm, "verification.signatureAlgorithm"),
        signedField: text(verification.signedField, "verification.signedField"),
        publicKeyPem: text(verification.publicKeyPem, "verification.publicKeyPem"),
        instructions: text(verification.instructions, "verification.instructions"),
      },
      envelope: {
        agentId: text(e.agentId, "envelope.agentId"),
        observedAt: text(e.observedAt, "envelope.observedAt"),
        sequence: count(e.sequence, "envelope.sequence"),
        algorithm: text(e.algorithm, "envelope.algorithm"),
        integrityHash: text(e.integrityHash, "envelope.integrityHash"),
        signatureAlgorithm: text(e.signatureAlgorithm, "envelope.signatureAlgorithm"),
        signature: text(e.signature, "envelope.signature"),
        relayPublicKeyPem: text(e.relayPublicKeyPem, "envelope.relayPublicKeyPem"),
        ...(relayKeyId !== undefined ? { relayKeyId } : {}),
        canonicalPayload: text(e.canonicalPayload, "envelope.canonicalPayload"),
        relayMode: text(e.relayMode, "envelope.relayMode"),
        ...(publisherValidation ? { publisherValidation } : {}),
        entries,
        ...(provenance ? { provenance } : {}),
      },
    };
    return { ok: true, packet };
  } catch (error) {
    if (error instanceof ShapeError) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * The key list handed over as JSON: the document the relay publishes at /.well-known/nooscape-keys.json, or a bare list of its keys.
 * An entry that does not parse is left out and named in `ignored`, so a bad line never trusts a key: it needs a key id, an Ed25519
 * public key, a status of active, retired or revoked, and for a retired key the date it stopped signing.
 */
export function readKeyManifest(input: unknown): { keys: RelayKey[]; ignored: string[] } {
  const ignored: string[] = [];
  if (isObject(input) && input.format !== undefined && input.format !== KEY_MANIFEST_FORMAT) {
    return { keys: [], ignored: [`the document is not a "${KEY_MANIFEST_FORMAT}"`] };
  }
  const items = Array.isArray(input) ? input : isObject(input) && Array.isArray(input.keys) ? input.keys : null;
  if (!items) return { keys: [], ignored: ["the document has no list of keys"] };
  const keys = items.flatMap((item, index): RelayKey[] => {
    const skip = (reason: string): RelayKey[] => {
      ignored.push(`entry ${index} ${reason}`);
      return [];
    };
    if (!isObject(item)) return skip("is not an object");
    const { keyId, publicKeyPem, status, retiredAt, note } = item;
    if (typeof keyId !== "string" || keyId === "" || typeof publicKeyPem !== "string") return skip("needs a keyId and a publicKeyPem");
    if (status !== "active" && status !== "retired" && status !== "revoked") return skip('has a status other than "active", "retired" or "revoked"');
    if (status === "retired" && (typeof retiredAt !== "string" || !Number.isFinite(Date.parse(retiredAt)))) return skip("is retired but has no valid retiredAt date");
    let pem: string;
    try {
      if (createPublicKey(publicKeyPem).asymmetricKeyType !== "ed25519") return skip("is not an Ed25519 key");
      pem = canonicalPem(publicKeyPem);
    } catch {
      return skip("has a publicKeyPem that does not parse");
    }
    return [{ keyId, publicKeyPem: pem, status, ...(typeof retiredAt === "string" ? { retiredAt } : {}), ...(typeof note === "string" ? { note } : {}) }];
  });
  return { keys, ignored };
}
