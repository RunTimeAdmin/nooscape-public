import { createHash, createPublicKey, verify } from "node:crypto";
import { normalizeHttpsDomain } from "./domainVerification";

export const supportedPublisherProtocols = ["a2a", "anp", "agntcy", "erc8004"] as const;
export type PublisherProtocol = (typeof supportedPublisherProtocols)[number];

export type PublisherKeyAttestation = {
  format: "Nooscape Publisher Key Attestation v1";
  issuerName: string;
  publicKeyFingerprint: string;
  permittedDomains: string[];
  permittedProtocols: PublisherProtocol[];
  policyVersion: string;
  expiresAt: string | null;
};

export type ValidatedPublisherKeyProof = {
  issuerName: string;
  publicKeyPem: string;
  publicKeyFingerprint: string;
  permittedDomains: string[];
  permittedProtocols: PublisherProtocol[];
  policyVersion: string;
  expiresAt: Date | null;
  canonicalPayload: string;
  proofHash: string;
  attestationSignature: string;
};

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function parseExpiry(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date <= new Date()) {
    throw new Error("Publisher-key expiry must be a future ISO 8601 timestamp when supplied.");
  }
  if (date.getTime() > Date.now() + 2 * 365 * 24 * 60 * 60 * 1_000) {
    throw new Error("Publisher-key expiry may not be more than two years in the future.");
  }
  return date;
}

function normalizeIssuer(value: string) {
  const issuer = value.trim().replace(/\s+/g, " ");
  if (issuer.length < 3 || issuer.length > 255) {
    throw new Error("Publisher issuer name must be between 3 and 255 characters.");
  }
  return issuer;
}

function normalizePolicyVersion(value: string) {
  const policyVersion = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(policyVersion)) {
    throw new Error("Publisher policy version has an invalid format.");
  }
  return policyVersion;
}

function normalizePublicKey(pem: string) {
  const key = createPublicKey(pem.trim());
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Publisher keys must be Ed25519 SPKI public keys.");
  }
  return key.export({ type: "spki", format: "pem" }).toString();
}

export function fingerprintPublisherKey(pem: string) {
  const normalizedPem = normalizePublicKey(pem);
  return `ed25519:sha256:${createHash("sha256").update(normalizedPem).digest("hex")}`;
}

export function createPublisherAttestationPayload(input: {
  issuerName: string;
  publicKeyPem: string;
  permittedDomainRoots: string[];
  permittedProtocols: PublisherProtocol[];
  policyVersion: string;
  expiresAt?: string | null;
}) {
  const issuerName = normalizeIssuer(input.issuerName);
  const publicKeyPem = normalizePublicKey(input.publicKeyPem);
  const permittedDomains = uniqueSorted(input.permittedDomainRoots.map(normalizeHttpsDomain));
  if (permittedDomains.length === 0 || permittedDomains.length > 20) {
    throw new Error("Publisher policy requires between one and twenty public HTTPS domains.");
  }
  const permittedProtocols = uniqueSorted(input.permittedProtocols) as PublisherProtocol[];
  if (permittedProtocols.length === 0 || permittedProtocols.some(protocol => !supportedPublisherProtocols.includes(protocol))) {
    throw new Error("Publisher policy requires at least one supported protocol.");
  }
  const expiry = parseExpiry(input.expiresAt);
  const attestation: PublisherKeyAttestation = {
    format: "Nooscape Publisher Key Attestation v1",
    issuerName,
    publicKeyFingerprint: fingerprintPublisherKey(publicKeyPem),
    permittedDomains,
    permittedProtocols,
    policyVersion: normalizePolicyVersion(input.policyVersion),
    expiresAt: expiry?.toISOString() ?? null,
  };
  return { ...attestation, publicKeyPem, expiresAt: expiry, canonicalPayload: JSON.stringify(attestation) };
}

export function validatePublisherKeyProof(input: {
  issuerName: string;
  publicKeyPem: string;
  permittedDomainRoots: string[];
  permittedProtocols: PublisherProtocol[];
  policyVersion: string;
  expiresAt?: string | null;
  attestationSignature: string;
}): ValidatedPublisherKeyProof {
  const normalized = createPublisherAttestationPayload(input);
  let signature: Buffer;
  try {
    signature = Buffer.from(input.attestationSignature, "base64");
  } catch {
    throw new Error("Publisher attestation signature must be base64.");
  }
  if (signature.byteLength === 0 || !verify(null, Buffer.from(normalized.canonicalPayload), createPublicKey(normalized.publicKeyPem), signature)) {
    throw new Error("Publisher-key attestation signature is invalid.");
  }
  return {
    issuerName: normalized.issuerName,
    publicKeyPem: normalized.publicKeyPem,
    publicKeyFingerprint: normalized.publicKeyFingerprint,
    permittedDomains: normalized.permittedDomains,
    permittedProtocols: normalized.permittedProtocols,
    policyVersion: normalized.policyVersion,
    expiresAt: normalized.expiresAt,
    canonicalPayload: normalized.canonicalPayload,
    proofHash: createHash("sha256").update(normalized.canonicalPayload).digest("hex"),
    attestationSignature: input.attestationSignature,
  };
}

export function createPublisherRotationPayload(input: {
  previousKeyId: string;
  newKeyFingerprint: string;
  newProofHash: string;
}) {
  return JSON.stringify({
    format: "Nooscape Publisher Key Rotation v1",
    previousKeyId: input.previousKeyId,
    newKeyFingerprint: input.newKeyFingerprint,
    newProofHash: input.newProofHash,
  });
}

export function validatePublisherRotationProof(input: {
  previousPublicKeyPem: string;
  previousKeyId: string;
  newKeyFingerprint: string;
  newProofHash: string;
  rotationSignature: string;
}) {
  let signature: Buffer;
  try {
    signature = Buffer.from(input.rotationSignature, "base64");
  } catch {
    throw new Error("Publisher key-rotation signature must be base64.");
  }
  const canonicalPayload = createPublisherRotationPayload(input);
  if (signature.byteLength === 0 || !verify(null, Buffer.from(canonicalPayload), createPublicKey(input.previousPublicKeyPem), signature)) {
    throw new Error("Publisher key-rotation signature is invalid.");
  }
  return canonicalPayload;
}
