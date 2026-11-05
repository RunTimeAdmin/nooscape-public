import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { KEY_MANIFEST_FORMAT, PACKET_FORMAT, type EvidenceEntry, type EvidencePacket, type PublisherValidation, type RelayKey } from "../src/verify";

/** Signed packets for the package's tests: built with Node's crypto the way the relay builds them, so no test depends on the relay. */

export const AGENT = "agent-under-test";
export const AT = "2026-11-01T12:00:00.000Z";
export const RETIRED_AT = "2026-10-01T00:00:00.000Z";

export type Signer = { privateKey: KeyObject; publicKey: KeyObject };
export const newSigner = (): Signer => generateKeyPairSync("ed25519");
export const pemOf = (signer: Signer) => signer.publicKey.export({ type: "spki", format: "pem" }).toString();
export const listed = (signer: Signer, keyId: string, status: RelayKey["status"], retiredAt?: string): RelayKey => ({ keyId, publicKeyPem: pemOf(signer), status, ...(retiredAt ? { retiredAt } : {}) });

export const ENTRY: EvidenceEntry = {
  id: "obs-1",
  observedAt: AT,
  event: "AGENT_OBSERVED",
  detail: "Observed in the public census.",
  source: "agent-economy-public-census",
  proofReference: "proof-1",
  provenance: { observationId: "obs-1", contentHash: "a".repeat(64), canonicalLocator: "https://example.test/agent", validationStatus: "valid" },
};
export const STANDING: PublisherValidation = { status: "allowlisted", publisherName: "Example Publisher", publicKeyFingerprint: "ed25519:example-0000", verifiedAt: AT, statusChangedAt: AT };
export const PROVENANCE = {
  evidenceClass: "persisted-observation" as const,
  sourceLabel: "census",
  sourceRoot: "https://example.test",
  canonicalLocator: "https://example.test/agent",
  contentHash: "b".repeat(64),
  rawPayloadAccess: "private-object-store" as const,
  retentionPolicy: "90 days",
  validationStatus: "valid" as const,
};

/** A packet as the relay issues it: the payload in the order the relay signs it, its digest and signature, and the export wrapper. */
export function packetOf(options: { signer: Signer; keyId?: string | null; observedAt?: string; full?: boolean; publisherValidation?: PublisherValidation | null }): EvidencePacket {
  const { signer, observedAt = AT, full = true } = options;
  const keyId = options.keyId === undefined ? "key-1" : options.keyId;
  const publisherValidation = options.publisherValidation === undefined ? (full ? STANDING : undefined) : options.publisherValidation ?? undefined;
  const provenance = full ? PROVENANCE : undefined;
  const entries = full ? [ENTRY] : [];
  const canonicalPayload = JSON.stringify({ envelopeVersion: "Nooscape Persisted Evidence v1", agentId: AGENT, observedAt, publisherValidation, provenance, entries });
  const relayPublicKeyPem = pemOf(signer);
  return {
    format: PACKET_FORMAT,
    exportedAt: observedAt,
    verification: { signatureAlgorithm: "Ed25519", signedField: "envelope.canonicalPayload", publicKeyPem: relayPublicKeyPem, instructions: "Verify the signature, then the digest." },
    envelope: {
      agentId: AGENT,
      observedAt,
      sequence: 4,
      algorithm: "SHA-256",
      integrityHash: createHash("sha256").update(canonicalPayload).digest("hex"),
      signatureAlgorithm: "Ed25519",
      signature: sign(null, Buffer.from(canonicalPayload), signer.privateKey).toString("base64"),
      relayPublicKeyPem,
      ...(keyId ? { relayKeyId: keyId } : {}),
      canonicalPayload,
      relayMode: "production persisted-observation relay",
      ...(publisherValidation ? { publisherValidation } : {}),
      entries,
      ...(provenance ? { provenance } : {}),
    },
  };
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** One signed packet, its signer, and the key list that publishes the signer's key the way /.well-known/nooscape-keys.json writes it. */
export function packetFixture(options: { keyId?: string } = {}) {
  const signer = newSigner();
  const keyId = options.keyId ?? "key-1";
  const packet = clone(packetOf({ signer, keyId }));
  const manifest = { format: KEY_MANIFEST_FORMAT, algorithm: "Ed25519", keys: [{ ...listed(signer, keyId, "active"), purpose: "Evidence-envelope verification" }] };
  return { signer, keyId, packet, manifest, copy: () => clone(packet) };
}

/** The fixture's key line in another state. */
export function listedFixture(fixture: ReturnType<typeof packetFixture>, status: RelayKey["status"], retiredAt?: string) {
  return { ...listed(fixture.signer, fixture.keyId, status, retiredAt), purpose: "Evidence-envelope verification" };
}
