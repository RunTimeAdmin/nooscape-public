import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPublisherAttestationPayload,
  createPublisherRotationPayload,
  fingerprintPublisherKey,
  validatePublisherKeyProof,
  validatePublisherRotationProof,
} from "./publisherVerification";

function signAttestation(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], input: Parameters<typeof createPublisherAttestationPayload>[0]) {
  const payload = createPublisherAttestationPayload(input);
  return {
    ...input,
    attestationSignature: sign(null, Buffer.from(payload.canonicalPayload), privateKey).toString("base64"),
  };
}

describe("publisher-key validation", () => {
  const initial = generateKeyPairSync("ed25519");
  const initialPem = initial.publicKey.export({ type: "spki", format: "pem" }).toString();
  const baseInput = {
    issuerName: "Example Agent Cooperative",
    publicKeyPem: initialPem,
    permittedDomainRoots: ["https://agents.example.org"],
    permittedProtocols: ["a2a" as const],
    policyVersion: "publisher-policy/2026-10",
    expiresAt: "2027-01-01T00:00:00.000Z",
  };

  it("accepts a self-signed Ed25519 publisher policy and fingerprints normalized SPKI material", () => {
    const proof = validatePublisherKeyProof(signAttestation(initial.privateKey, baseInput));

    expect(proof.publicKeyFingerprint).toBe(fingerprintPublisherKey(initialPem));
    expect(proof.permittedDomains).toEqual(["agents.example.org"]);
    expect(proof.permittedProtocols).toEqual(["a2a"]);
    expect(proof.proofHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects any change after a publisher attestation was signed", () => {
    const signed = signAttestation(initial.privateKey, baseInput);

    expect(() => validatePublisherKeyProof({ ...signed, issuerName: "Imposter Cooperative" })).toThrow(/signature/i);
  });

  it("validates a restricted rotation signed by the currently allowlisted key", () => {
    const replacement = generateKeyPairSync("ed25519");
    const replacementPem = replacement.publicKey.export({ type: "spki", format: "pem" }).toString();
    const nextProof = validatePublisherKeyProof(signAttestation(replacement.privateKey, { ...baseInput, publicKeyPem: replacementPem }));
    const rotationPayload = createPublisherRotationPayload({
      previousKeyId: "a8cc0a27-264a-4da7-9fe8-e719d0dafdd2",
      newKeyFingerprint: nextProof.publicKeyFingerprint,
      newProofHash: nextProof.proofHash,
    });
    const rotationSignature = sign(null, Buffer.from(rotationPayload), initial.privateKey).toString("base64");

    expect(
      validatePublisherRotationProof({
        previousPublicKeyPem: initialPem,
        previousKeyId: "a8cc0a27-264a-4da7-9fe8-e719d0dafdd2",
        newKeyFingerprint: nextProof.publicKeyFingerprint,
        newProofHash: nextProof.proofHash,
        rotationSignature,
      })
    ).toBe(rotationPayload);
  });
});
