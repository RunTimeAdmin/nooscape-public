import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { ENV } from "./_core/env";
import { sealEvidencePayload } from "./evidence";

const caller = () => appRouter.createCaller({ user: null, req: { protocol: "https", headers: {} }, res: {} } as TrpcContext);
const original = ENV.nooscapeEvidenceRetiredKeys;
afterEach(() => {
  ENV.nooscapeEvidenceRetiredKeys = original;
});

const AGENT = "rotated-agent";
const OLD_ID = "nooscape-production-ed25519-v0";
const RETIRED_AT = "2026-10-01T00:00:00.000Z";
const BEFORE_RETIREMENT = "2026-09-01T12:00:00.000Z";
const AFTER_RETIREMENT = "2026-10-17T12:00:00.000Z";

type PublisherValidation = { status: "allowlisted"; publisherName: string; publicKeyFingerprint: string; verifiedAt: string; statusChangedAt: string };

/** The payload exactly as the relay issues it (evidence.ts createPersistedEvidenceEnvelope), key order included. */
const payloadOf = (observedAt: string, publisherValidation?: PublisherValidation) => ({
  envelopeVersion: "Nooscape Persisted Evidence v1",
  agentId: AGENT,
  observedAt,
  publisherValidation,
  provenance: undefined,
  entries: [],
});

/** A packet signed by `keyPair` under `keyId`. */
function signedBy(keyPair: ReturnType<typeof generateKeyPairSync>, keyId: string, observedAt: string, publisherValidation?: PublisherValidation) {
  const canonicalPayload = JSON.stringify(payloadOf(observedAt, publisherValidation));
  return {
    algorithm: "SHA-256" as const,
    integrityHash: createHash("sha256").update(canonicalPayload).digest("hex"),
    signatureAlgorithm: "Ed25519" as const,
    signature: sign(null, Buffer.from(canonicalPayload), keyPair.privateKey).toString("base64"),
    relayPublicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    relayKeyId: keyId,
    canonicalPayload,
  };
}

function packetOf(sealed: ReturnType<typeof signedBy>, observedAt: string, publisherValidation?: PublisherValidation) {
  return {
    format: "Nooscape Signed Evidence Envelope v1" as const,
    exportedAt: observedAt,
    verification: { signatureAlgorithm: "Ed25519" as const, signedField: "envelope.canonicalPayload", publicKeyPem: sealed.relayPublicKeyPem, instructions: "rotation test" },
    envelope: {
      agentId: AGENT,
      observedAt,
      sequence: 0,
      ...sealed,
      relayMode: "production persisted-observation relay",
      ...(publisherValidation ? { publisherValidation } : {}),
      entries: [],
    },
  };
}

describe("verifying a packet after the signing key rotates", () => {
  const oldKey = generateKeyPairSync("ed25519");
  const oldPem = oldKey.publicKey.export({ type: "spki", format: "pem" }).toString();
  const listed = (status: "retired" | "revoked") =>
    JSON.stringify([{ keyId: OLD_ID, publicKeyPem: oldPem, status, ...(status === "retired" ? { retiredAt: RETIRED_AT } : {}) }]);
  const verify = (observedAt: string, publisherValidation?: PublisherValidation) =>
    caller().atlas.verifyEvidence({ packet: packetOf(signedBy(oldKey, OLD_ID, observedAt, publisherValidation), observedAt, publisherValidation) });
  const allowlisted = (at: string): PublisherValidation => ({ status: "allowlisted", publisherName: "Example Publisher", publicKeyFingerprint: "ed25519:example-0000", verifiedAt: at, statusChangedAt: at });

  it("accepts a packet signed by the active key", async () => {
    const observedAt = new Date().toISOString();
    const sealed = sealEvidencePayload(payloadOf(observedAt));
    const result = await caller().atlas.verifyEvidence({ packet: packetOf(sealed, observedAt) });
    expect(result).toMatchObject({ valid: true, verifiedByNooscape: true, issuedByCurrentRelay: true, keyStatus: "active", issues: [] });
  });

  it("rejects a packet from a key nobody published", async () => {
    const result = await verify(BEFORE_RETIREMENT);
    expect(result).toMatchObject({ signatureValid: true, valid: false, verifiedByNooscape: false, issuedByCurrentRelay: false, keyStatus: "unknown" });
  });

  it("accepts a packet signed by a retired key before it was retired", async () => {
    ENV.nooscapeEvidenceRetiredKeys = listed("retired");
    const result = await verify(BEFORE_RETIREMENT);
    expect(result).toMatchObject({ valid: true, verifiedByNooscape: true, issuedByCurrentRelay: false, keyStatus: "retired", issues: [] });
  });

  it("rejects a packet signed by a retired key but dated after the retirement", async () => {
    ENV.nooscapeEvidenceRetiredKeys = listed("retired");
    const result = await verify(AFTER_RETIREMENT);
    expect(result).toMatchObject({ signatureValid: true, valid: false, verifiedByNooscape: false, keyStatus: "retired" });
    expect(result.issues.join(" ")).toMatch(/dated after the key that signed it was retired/);
  });

  it("rejects a retired key's packet whose date cannot be read", async () => {
    ENV.nooscapeEvidenceRetiredKeys = listed("retired");
    const result = await verify("sometime");
    expect(result).toMatchObject({ valid: false, verifiedByNooscape: false, keyStatus: "retired" });
  });

  it("refuses a packet signed by a revoked key, with a plain reason", async () => {
    ENV.nooscapeEvidenceRetiredKeys = listed("revoked");
    const result = await verify(BEFORE_RETIREMENT);
    expect(result).toMatchObject({ valid: false, verifiedByNooscape: false, keyStatus: "revoked" });
    expect(result.issues.join(" ")).toMatch(/revoked/);
  });

  it("does not let a retired key vouch for a publisher's standing, which is a present-tense claim", async () => {
    ENV.nooscapeEvidenceRetiredKeys = listed("retired");
    const result = await verify(BEFORE_RETIREMENT, allowlisted(BEFORE_RETIREMENT));
    expect(result).toMatchObject({ verifiedByNooscape: true, publisherKeyAllowlisted: false, publisherName: null });
  });
});
