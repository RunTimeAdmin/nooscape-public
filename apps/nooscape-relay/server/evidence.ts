import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { ENV } from "./_core/env";
import { getDb, listPersistedEvidenceEntries } from "./db";

export type PublisherValidation = {
  status: "allowlisted" | "expired" | "revoked" | "unverified";
  publisherName: string | null;
  publicKeyFingerprint: string | null;
  verifiedAt: string | null;
  statusChangedAt: string | null;
};

export type SignedEvidenceEntry = {
  id: string;
  observedAt: string;
  event: string;
  detail: string;
  source: string;
  proofReference: string;
  provenance?: {
    observationId: string;
    contentHash: string;
    canonicalLocator: string;
    validationStatus: "valid" | "invalid" | "partial";
  };
};

type EvidenceSigner = {
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  publicKeyPem: string;
  keyId: string;
};

let signer: EvidenceSigner | undefined;

/**
 * Loads the production signing identity from a server-only environment variable.
 * The generated key is deliberately a local-development fallback only; production
 * deployment validation requires NOOSCAPE_EVIDENCE_SIGNING_PRIVATE_KEY to be set.
 */
export function getEvidenceSigner(): EvidenceSigner {
  if (signer) return signer;

  const encodedPrivateKey = ENV.nooscapeEvidenceSigningPrivateKey;
  if (encodedPrivateKey) {
    const privateKey = createPrivateKey(Buffer.from(encodedPrivateKey, "base64").toString("utf8"));
    const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    signer = {
      privateKey,
      publicKeyPem,
      keyId: ENV.nooscapeEvidenceSigningKeyId || "nooscape-production-ed25519-v1",
    };
    return signer;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("NOOSCAPE_EVIDENCE_SIGNING_PRIVATE_KEY is required in production.");
  }

  const generated = generateKeyPairSync("ed25519");
  signer = {
    privateKey: generated.privateKey,
    publicKeyPem: generated.publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId: "nooscape-development-ephemeral",
  };
  return signer;
}

export type RelayKeyStatus = "active" | "retired" | "revoked" | "unknown";

export type RelayKeyEntry = {
  keyId: string;
  publicKeyPem: string;
  status: Exclude<RelayKeyStatus, "unknown">;
  retiredAt?: string;
  note?: string;
};

/**
 * The one written form of a public key: what Node exports, which is also what every signed packet carries in
 * relayPublicKeyPem. Two spellings of one key (line breaks, a missing final newline) compare equal after this.
 */
const canonicalPem = (pem: string) => createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();

const warned = new Set<string>();
function ignoreEntry(reason: string): [] {
  if (!warned.has(reason)) {
    warned.add(reason);
    console.warn(`[EvidenceKeys] ignoring part of NOOSCAPE_EVIDENCE_RETIRED_KEYS: ${reason}`);
  }
  return [];
}

/**
 * The retired and revoked keys from the environment. Anything that does not parse is ignored (and logged once), so a
 * bad edit never trusts a key. A retired key needs a retiredAt date, because the date is what bounds it: without one
 * there is nothing to say when it stopped signing. Only Ed25519 keys are accepted; the verifier accepts no other kind.
 */
export function listRetiredRelayKeys(raw = ENV.nooscapeEvidenceRetiredKeys): RelayKeyEntry[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ignoreEntry("the value is not valid JSON");
  }
  if (!Array.isArray(parsed)) return ignoreEntry("the value is not a JSON array");
  return parsed.flatMap((item, index): RelayKeyEntry[] => {
    if (!item || typeof item !== "object") return ignoreEntry(`entry ${index} is not an object`);
    const { keyId, publicKeyPem, status, retiredAt, note } = item as Record<string, unknown>;
    if (typeof keyId !== "string" || typeof publicKeyPem !== "string") return ignoreEntry(`entry ${index} needs a keyId and a publicKeyPem`);
    if (status !== "retired" && status !== "revoked") return ignoreEntry(`entry ${index} has a status other than "retired" or "revoked"`);
    if (status === "retired" && (typeof retiredAt !== "string" || !Number.isFinite(Date.parse(retiredAt)))) {
      return ignoreEntry(`entry ${index} is retired but has no valid retiredAt date`);
    }
    let pem: string;
    try {
      const key = createPublicKey(publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519") return ignoreEntry(`entry ${index} is not an Ed25519 key`);
      pem = canonicalPem(publicKeyPem);
    } catch {
      return ignoreEntry(`entry ${index} has a publicKeyPem that does not parse`);
    }
    return [{
      keyId,
      publicKeyPem: pem,
      status,
      ...(typeof retiredAt === "string" ? { retiredAt } : {}),
      ...(typeof note === "string" ? { note } : {}),
    }];
  });
}

/**
 * Every key the relay has used: the active one first, then the retired and revoked ones. This is what
 * /.well-known/nooscape-keys.json publishes. The active key appears once: a "revoked" entry for the key that is
 * still signing replaces its active line (the list then tells the truth, and the relay's own packets fail loudly),
 * and a "retired" entry for it is dropped, because a key still signing is not retired.
 */
export function listRelayKeys(raw = ENV.nooscapeEvidenceRetiredKeys): RelayKeyEntry[] {
  const active = getEvidenceSigner();
  const activePem = canonicalPem(active.publicKeyPem);
  const isActive = (entry: RelayKeyEntry) => entry.keyId === active.keyId && entry.publicKeyPem === activePem;
  const listed = listRetiredRelayKeys(raw);
  const activeIsRevoked = listed.some(entry => isActive(entry) && entry.status === "revoked");
  return [
    ...(activeIsRevoked ? [] : [{ keyId: active.keyId, publicKeyPem: activePem, status: "active" as const }]),
    ...listed.filter(entry => !(isActive(entry) && entry.status === "retired")),
  ];
}

/**
 * The entry a packet's key falls under, or undefined. Both the id and the key bytes must match, so a forger who
 * copies a key id with their own key, or a real key under a new id, finds nothing. A revoked entry wins over
 * everything else, then the active one, then a retired one.
 */
export function findRelayKey(keyId: string | undefined, publicKeyPem: string, raw = ENV.nooscapeEvidenceRetiredKeys): RelayKeyEntry | undefined {
  if (!keyId) return undefined;
  let pem: string;
  try {
    pem = canonicalPem(publicKeyPem);
  } catch {
    return undefined;
  }
  const matches = listRelayKeys(raw).filter(entry => entry.keyId === keyId && entry.publicKeyPem === pem);
  return matches.find(entry => entry.status === "revoked") ?? matches.find(entry => entry.status === "active") ?? matches.find(entry => entry.status === "retired");
}

export function relayKeyStatus(keyId: string | undefined, publicKeyPem: string, raw = ENV.nooscapeEvidenceRetiredKeys): RelayKeyStatus {
  return findRelayKey(keyId, publicKeyPem, raw)?.status ?? "unknown";
}

/**
 * True when a packet is dated after the key that signed it was retired, or its date cannot be read. A retired key
 * should not sign anything new, so such a packet points at an old instance that is still running, or at a copied key.
 * This is a guard against mistakes. It does not stop someone who holds a leaked key, because the date is inside the
 * packet and they choose it. A leaked key is stopped by marking it "revoked".
 */
export function signedAfterRetirement(entry: RelayKeyEntry | undefined, observedAt: string): boolean {
  if (entry?.status !== "retired" || !entry.retiredAt) return false;
  return !(Date.parse(observedAt) <= Date.parse(entry.retiredAt));
}

export function sealEvidencePayload(payload: Record<string, unknown>) {
  const activeSigner = getEvidenceSigner();
  const canonicalPayload = JSON.stringify(payload);
  return {
    algorithm: "SHA-256" as const,
    integrityHash: createHash("sha256").update(canonicalPayload).digest("hex"),
    signatureAlgorithm: "Ed25519" as const,
    signature: sign(null, Buffer.from(canonicalPayload), activeSigner.privateKey).toString("base64"),
    relayPublicKeyPem: activeSigner.publicKeyPem,
    relayKeyId: activeSigner.keyId,
    canonicalPayload,
  };
}

/**
 * Produces an exportable envelope only when the agent has persisted evidence.
 * This never fetches source URLs or returns private RustFS object keys or bytes.
 */
export async function createPersistedEvidenceEnvelope(
  agentId: string,
  publisherValidation: PublisherValidation
) {
  if (!(await getDb())) return undefined;

  const rows = await listPersistedEvidenceEntries(agentId);
  if (rows.length === 0) return undefined;

  const entries: SignedEvidenceEntry[] = rows.map(row => ({
    id: row.id,
    observedAt: row.observedAt.toISOString(),
    event: row.event,
    detail: row.detail,
    source: `${row.sourceLabel} · ${row.protocol.toUpperCase()}`,
    proofReference: row.proofReference ?? row.canonicalLocator,
    provenance: {
      observationId: row.observationId,
      contentHash: row.contentHash,
      canonicalLocator: row.canonicalLocator,
      validationStatus: row.validationStatus,
    },
  }));
  const latest = entries[0];
  if (!latest) return undefined;

  const provenance = {
    evidenceClass: "persisted-observation",
    sourceLabel: rows[0]?.sourceLabel ?? "Approved source",
    sourceRoot: rows[0]?.sourceRoot ?? "",
    canonicalLocator: latest.provenance?.canonicalLocator ?? "",
    contentHash: latest.provenance?.contentHash ?? "",
    rawPayloadAccess: "private-object-store",
    retentionPolicy: "GOVERNANCE / 90 days per observation",
    validationStatus: latest.provenance?.validationStatus ?? "partial",
  } as const;

  const sealed = sealEvidencePayload({
    envelopeVersion: "Nooscape Persisted Evidence v1",
    agentId,
    observedAt: latest.observedAt,
    publisherValidation,
    provenance,
    entries,
  });

  return {
    agentId,
    observedAt: latest.observedAt,
    sequence: entries.length,
    ...sealed,
    relayMode: "production persisted-observation relay",
    publisherValidation,
    provenance,
    entries,
  } as const;
}
