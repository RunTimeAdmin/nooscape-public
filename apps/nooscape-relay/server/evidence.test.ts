import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sealEvidencePayload } from "./evidence";

describe("Nooscape evidence sealing", () => {
  it("signs a canonical payload with an independently verifiable Ed25519 signature", () => {
    const sealed = sealEvidencePayload({
      envelopeVersion: "Nooscape Persisted Evidence v1",
      agentId: "example-agent",
      entries: [{ id: "event-1", contentHash: "a".repeat(64) }],
    });

    expect(sealed.integrityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sealed.relayKeyId).toMatch(/^nooscape-/);
    expect(
      verify(
        null,
        Buffer.from(sealed.canonicalPayload),
        createPublicKey(sealed.relayPublicKeyPem),
        Buffer.from(sealed.signature, "base64")
      )
    ).toBe(true);
  });
});
