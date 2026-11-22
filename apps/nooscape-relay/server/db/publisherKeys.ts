/** Publisher key policies: staging, approval, revocation and expiry. Part of server/db.ts, which re-exports every module of this folder. */
import { and, desc, eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { randomUUID } from "node:crypto";
import { agentIdentities, agentReadModel, evidenceEvents, publisherBindings, publisherKeyHistory, publisherKeys, reviewItems } from "../../drizzle/schema";
import { type ValidatedPublisherKeyProof } from "../publisherVerification";
import { OperatorRuleError } from "../operatorRuleError";
import { EVIDENCE_TIER_SCALE_VERSION, getDb, requireDb } from "./core";

export type PublisherKeyState = "pending" | "allowlisted" | "expired" | "revoked";

/**
 * An allowlisted key whose configured expiry has elapsed is expired, not
 * allowlisted. Resolution is deterministic and time-based so every reader
 * (read-model refresh, publisher validation) fails closed even between
 * scheduled expiry runs. Keys without a configured expiry do not expire.
 */
export function effectivePublisherKeyState(state: PublisherKeyState, expiresAt: Date | null, now: Date = new Date()): PublisherKeyState {
  return state === "allowlisted" && expiresAt !== null && expiresAt <= now ? "expired" : state;
}

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function publisherStateForReadModel(state: PublisherKeyState) {
  return state === "allowlisted" ? "allowlisted" : state === "expired" ? "expired" : state === "revoked" ? "revoked" : "unverified";
}

/**
 * Writes a key-policy proposal only after its self-attestation is cryptographically
 * valid and the targeted identity has independently passed domain control.
 */
export async function stagePublisherKeyPolicy(input: {
  identityId: string;
  proof: ValidatedPublisherKeyProof;
  attestationObjectKey: string;
  rotationOfKeyId?: string;
  rotationProofHash?: string;
  createdByUserId: number;
}) {
  const db = requireDb(await getDb());
  const [identity] = await db
    .select({
      id: agentIdentities.id,
      agentId: agentIdentities.agentId,
      externalId: agentIdentities.externalId,
      sourceObservationId: agentIdentities.sourceObservationId,
      verificationState: agentIdentities.verificationState,
    })
    .from(agentIdentities)
    .where(eq(agentIdentities.id, input.identityId))
    .limit(1);
  if (!identity) throw new OperatorRuleError("Agent identity was not found.");
  if (identity.verificationState !== "verified") {
    throw new OperatorRuleError("Publisher-key validation requires a domain-verified agent identity.");
  }
  let assertedDomain: string;
  try {
    assertedDomain = new URL(identity.externalId).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    throw new OperatorRuleError("Publisher-key validation requires an HTTPS URL identity.");
  }
  if (!input.proof.permittedDomains.includes(assertedDomain)) {
    throw new OperatorRuleError("Publisher-key policy must permit the agent identity's verified domain.");
  }

  if (input.rotationOfKeyId) {
    const [previous] = await db
      .select()
      .from(publisherKeys)
      .where(eq(publisherKeys.id, input.rotationOfKeyId))
      .limit(1);
    if (!previous || previous.state !== "allowlisted") throw new OperatorRuleError("Publisher key rotation requires an active prior key.");
    if (previous.issuerName !== input.proof.issuerName) throw new OperatorRuleError("Publisher key rotation must retain the same issuer name.");
    const priorDomains = parseStringArray(previous.permittedDomains);
    const priorProtocols = parseStringArray(previous.permittedProtocols);
    if (!input.proof.permittedDomains.every(domain => priorDomains.includes(domain))) {
      throw new OperatorRuleError("Publisher key rotation may not expand permitted domains.");
    }
    if (!input.proof.permittedProtocols.every(protocol => priorProtocols.includes(protocol))) {
      throw new OperatorRuleError("Publisher key rotation may not expand permitted protocols.");
    }
  }

  const keyId = randomUUID();
  const reviewId = randomUUID();
  const bindingId = randomUUID();
  await db.transaction(async tx => {
    await tx.insert(publisherKeys).values({
      id: keyId,
      issuerName: input.proof.issuerName,
      publicKeyFingerprint: input.proof.publicKeyFingerprint,
      publicKeyPem: input.proof.publicKeyPem,
      permittedDomains: JSON.stringify(input.proof.permittedDomains),
      permittedProtocols: JSON.stringify(input.proof.permittedProtocols),
      state: "pending",
      expiresAt: input.proof.expiresAt,
      policyVersion: input.proof.policyVersion,
      attestationObjectKey: input.attestationObjectKey,
      attestationHash: input.proof.proofHash,
      attestationSignature: input.proof.attestationSignature,
      rotationOfKeyId: input.rotationOfKeyId ?? null,
      rotationProofHash: input.rotationProofHash ?? null,
      createdByUserId: input.createdByUserId,
    });
    await tx.insert(publisherKeyHistory).values({
      id: randomUUID(),
      publisherKeyId: keyId,
      state: "pending",
      reason: input.rotationOfKeyId ? `Rotation proposal from key ${input.rotationOfKeyId}.` : "New publisher key policy proposal.",
      changedByUserId: input.createdByUserId,
    });
    await tx.insert(publisherBindings).values({
      id: bindingId,
      agentIdentityId: identity.id,
      publisherKeyId: keyId,
      validationMethod: input.rotationOfKeyId ? "domain-control + self-attestation + prior-key-rotation" : "domain-control + self-attestation",
      sourceObservationId: identity.sourceObservationId,
    });
    await tx.insert(reviewItems).values({
      id: reviewId,
      type: "publisher_key",
      status: "pending",
      subjectType: "publisher_key",
      subjectId: keyId,
      rationale: "Cryptographic publisher-key proposal awaits a separate operator approval.",
      createdByUserId: input.createdByUserId,
    });
  });
  return { keyId, reviewId, bindingId, agentId: identity.agentId, state: "pending" as const };
}

/** What the read model refresh needs of the database: the pool, or the transaction a key's decision runs in. */
type ReadModelDb = Pick<ReturnType<typeof drizzle>, "select" | "update">;

async function refreshAgentPublisherReadModel(db: ReadModelDb, agentId: string) {
  const rows = await db
    .select({ state: publisherKeys.state, expiresAt: publisherKeys.expiresAt })
    .from(agentIdentities)
    .innerJoin(publisherBindings, eq(publisherBindings.agentIdentityId, agentIdentities.id))
    .innerJoin(publisherKeys, eq(publisherBindings.publisherKeyId, publisherKeys.id))
    .where(eq(agentIdentities.agentId, agentId));
  const now = new Date();
  const states = rows.map(row => effectivePublisherKeyState(row.state, row.expiresAt, now));
  const state: PublisherKeyState = states.some(candidate => candidate === "allowlisted")
    ? "allowlisted"
    : states.some(candidate => candidate === "revoked")
      ? "revoked"
      : states.some(candidate => candidate === "expired")
        ? "expired"
        : "pending";
  // Copy the expiry the allowlisted verdict rests on, so the public list path
  // can fail closed at read time before the next tick persists the transition.
  // Any allowlisted key without a configured expiry never lapses.
  const allowlistedExpiries = rows.filter((_, index) => states[index] === "allowlisted").map(row => row.expiresAt);
  let publisherExpiresAt: Date | null = null;
  for (const expiry of allowlistedExpiries) {
    if (expiry === null) {
      publisherExpiresAt = null;
      break;
    }
    if (publisherExpiresAt === null || expiry > publisherExpiresAt) publisherExpiresAt = expiry;
  }
  await db
    .update(agentReadModel)
    .set({
      publisherState: publisherStateForReadModel(state),
      publisherExpiresAt,
      // Publisher keys only ever raise a record: an allowlisted key is tier_4.
      // Every other key state (pending/expired/revoked) returns the record to
      // the tier_2 baseline under evidence-tier-v1, never a fabricated tier_3.
      evidenceTier: state === "allowlisted" ? "tier_4" : "tier_2",
      evidenceSummary: JSON.stringify({ status: `publisher_key_${state}`, scale: EVIDENCE_TIER_SCALE_VERSION, tier: state === "allowlisted" ? "tier_4" : "tier_2" }),
    })
    .where(eq(agentReadModel.agentId, agentId));
}

/** Approves a reviewed policy and records the transition as immutable evidence. */
export async function approvePublisherKeyPolicy(input: { keyId: string; decidedByUserId: number; rationale: string }) {
  const db = requireDb(await getDb());
  const [key] = await db.select().from(publisherKeys).where(eq(publisherKeys.id, input.keyId)).limit(1);
  if (!key) throw new OperatorRuleError("Publisher key proposal was not found.");
  if (key.state !== "pending") throw new OperatorRuleError("Only pending publisher key proposals can be approved.");
  if (key.createdByUserId === input.decidedByUserId) {
    throw new OperatorRuleError("Publisher-key approval requires an operator other than the proposal creator.");
  }
  if (key.expiresAt && key.expiresAt <= new Date()) throw new OperatorRuleError("Expired publisher key proposals cannot be approved.");

  const bindings = await db
    .select({ agentId: agentIdentities.agentId, sourceObservationId: publisherBindings.sourceObservationId })
    .from(publisherBindings)
    .innerJoin(agentIdentities, eq(publisherBindings.agentIdentityId, agentIdentities.id))
    .where(eq(publisherBindings.publisherKeyId, key.id));
  if (bindings.length === 0) throw new OperatorRuleError("Publisher key proposal had no identity binding.");
  const now = new Date();
  await db.transaction(async tx => {
    await tx
      .update(publisherKeys)
      .set({ state: "allowlisted", approvedByUserId: input.decidedByUserId, approvedAt: now })
      .where(eq(publisherKeys.id, key.id));
    await tx.insert(publisherKeyHistory).values({
      id: randomUUID(),
      publisherKeyId: key.id,
      state: "allowlisted",
      reason: input.rationale,
      changedByUserId: input.decidedByUserId,
      changedAt: now,
    });
    await tx
      .update(reviewItems)
      .set({ status: "approved", rationale: input.rationale, decidedByUserId: input.decidedByUserId, decidedAt: now })
      .where(and(eq(reviewItems.subjectType, "publisher_key"), eq(reviewItems.subjectId, key.id), eq(reviewItems.status, "pending")));
    if (key.rotationOfKeyId) {
      await tx.update(publisherKeys).set({ state: "revoked", revokedAt: now }).where(eq(publisherKeys.id, key.rotationOfKeyId));
      await tx.insert(publisherKeyHistory).values({
        id: randomUUID(),
        publisherKeyId: key.rotationOfKeyId,
        state: "revoked",
        reason: `Superseded by approved rotation ${key.id}.`,
        changedByUserId: input.decidedByUserId,
        changedAt: now,
      });
    }
    for (const binding of bindings) {
      await tx.insert(evidenceEvents).values({
        id: randomUUID(),
        agentId: binding.agentId,
        sourceObservationId: binding.sourceObservationId,
        eventType: "PUBLISHER_KEY_ALLOWLISTED",
        description: `Publisher key ${key.publicKeyFingerprint} was independently approved for ${key.issuerName}.`,
        proofReference: "private-retained-publisher-key-attestation",
        payloadHash: key.attestationHash,
        observedAt: now,
      });
    }
    // The read model the public lists are served from changes with the key, in the same commit. A refresh that fails undoes the approval, so
    // the two never disagree and the operator can try again; outside the transaction a failure left the key decided and the copy stale.
    for (const binding of bindings) await refreshAgentPublisherReadModel(tx, binding.agentId);
  });
  return { keyId: key.id, state: "allowlisted" as const, agentIds: bindings.map(binding => binding.agentId) };
}

export async function revokePublisherKeyPolicy(input: { keyId: string; decidedByUserId: number; rationale: string }) {
  const db = requireDb(await getDb());
  const [key] = await db.select().from(publisherKeys).where(eq(publisherKeys.id, input.keyId)).limit(1);
  if (!key) throw new OperatorRuleError("Publisher key was not found.");
  if (key.state === "revoked") return { keyId: key.id, state: "revoked" as const, agentIds: [] as string[] };
  const bindings = await db
    .select({ agentId: agentIdentities.agentId, sourceObservationId: publisherBindings.sourceObservationId })
    .from(publisherBindings)
    .innerJoin(agentIdentities, eq(publisherBindings.agentIdentityId, agentIdentities.id))
    .where(eq(publisherBindings.publisherKeyId, key.id));
  const now = new Date();
  await db.transaction(async tx => {
    await tx.update(publisherKeys).set({ state: "revoked", revokedAt: now }).where(eq(publisherKeys.id, key.id));
    await tx.insert(publisherKeyHistory).values({ id: randomUUID(), publisherKeyId: key.id, state: "revoked", reason: input.rationale, changedByUserId: input.decidedByUserId, changedAt: now });
    for (const binding of bindings) {
      await tx.insert(evidenceEvents).values({
        id: randomUUID(),
        agentId: binding.agentId,
        sourceObservationId: binding.sourceObservationId,
        eventType: "PUBLISHER_KEY_REVOKED",
        description: `Publisher key ${key.publicKeyFingerprint} was revoked.`,
        proofReference: "nooscape-publisher-policy",
        payloadHash: key.attestationHash,
        observedAt: now,
      });
    }
    // In the same commit as the revocation: a refresh that failed after it left the copy showing the revoked key's tier, and a second
    // revocation returns early, so nothing would have corrected it.
    for (const binding of bindings) await refreshAgentPublisherReadModel(tx, binding.agentId);
  });
  return { keyId: key.id, state: "revoked" as const, agentIds: bindings.map(binding => binding.agentId) };
}

/**
 * Applies deterministic expiry without accepting any external input or request.
 * Runs on every scheduled worker tick, including paused and rate-limited ones,
 * so an allowlisted key cannot outlive its configured window while ingestion
 * idles; each affected record also gets an immutable expiry evidence event.
 */
export async function expireDuePublisherKeys() {
  const db = requireDb(await getDb());
  const now = new Date();
  const expiring = await db
    .select({
      id: publisherKeys.id,
      createdByUserId: publisherKeys.createdByUserId,
      publicKeyFingerprint: publisherKeys.publicKeyFingerprint,
      attestationHash: publisherKeys.attestationHash,
    })
    .from(publisherKeys)
    .where(and(eq(publisherKeys.state, "allowlisted"), lte(publisherKeys.expiresAt, now)));
  for (const key of expiring) {
    const bindings = await db
      .select({ agentId: agentIdentities.agentId, sourceObservationId: publisherBindings.sourceObservationId })
      .from(publisherBindings)
      .innerJoin(agentIdentities, eq(publisherBindings.agentIdentityId, agentIdentities.id))
      .where(eq(publisherBindings.publisherKeyId, key.id));
    await db.transaction(async tx => {
      await tx.update(publisherKeys).set({ state: "expired" }).where(eq(publisherKeys.id, key.id));
      await tx.insert(publisherKeyHistory).values({
        id: randomUUID(),
        publisherKeyId: key.id,
        state: "expired",
        reason: "Configured publisher-key expiry elapsed.",
        changedByUserId: key.createdByUserId,
        changedAt: now,
      });
      for (const binding of bindings) {
        await tx.insert(evidenceEvents).values({
          id: randomUUID(),
          agentId: binding.agentId,
          sourceObservationId: binding.sourceObservationId,
          eventType: "PUBLISHER_KEY_EXPIRED",
          description: `Publisher key ${key.publicKeyFingerprint} reached its configured expiry; the record returns to the tier_2 baseline.`,
          proofReference: "nooscape-publisher-policy",
          payloadHash: key.attestationHash,
          observedAt: now,
        });
      }
    });
    for (const binding of bindings) await refreshAgentPublisherReadModel(db, binding.agentId);
  }
  return { expiredCount: expiring.length };
}

export async function getPublisherKeyById(keyId: string) {
  const db = requireDb(await getDb());
  const [key] = await db.select().from(publisherKeys).where(eq(publisherKeys.id, keyId)).limit(1);
  return key;
}

export async function listPublisherKeyPolicies() {
  const db = requireDb(await getDb());
  return db
    .select({
      id: publisherKeys.id,
      issuerName: publisherKeys.issuerName,
      publicKeyFingerprint: publisherKeys.publicKeyFingerprint,
      permittedDomains: publisherKeys.permittedDomains,
      permittedProtocols: publisherKeys.permittedProtocols,
      state: publisherKeys.state,
      expiresAt: publisherKeys.expiresAt,
      policyVersion: publisherKeys.policyVersion,
      rotationOfKeyId: publisherKeys.rotationOfKeyId,
      createdAt: publisherKeys.createdAt,
      approvedAt: publisherKeys.approvedAt,
      revokedAt: publisherKeys.revokedAt,
    })
    .from(publisherKeys)
    .orderBy(desc(publisherKeys.createdAt));
}


/**
 * Returns the strongest current publisher-key state for a persisted agent.
 * Allowlisted keys past their configured expiry resolve as expired here, so
 * the public surface fails closed immediately even before the next worker
 * tick persists the transition.
 */
export async function getPublisherValidationForAgent(agentId: string) {
  const db = await getDb();
  if (!db) return { status: "unverified" as const, publisherName: null, publicKeyFingerprint: null, verifiedAt: null, statusChangedAt: null };
  const rows = await db
    .select({
      state: publisherKeys.state,
      expiresAt: publisherKeys.expiresAt,
      issuerName: publisherKeys.issuerName,
      publicKeyFingerprint: publisherKeys.publicKeyFingerprint,
      validatedAt: publisherBindings.validatedAt,
      changedAt: publisherKeys.updatedAt,
    })
    .from(agentIdentities)
    .innerJoin(publisherBindings, eq(publisherBindings.agentIdentityId, agentIdentities.id))
    .innerJoin(publisherKeys, eq(publisherBindings.publisherKeyId, publisherKeys.id))
    .where(eq(agentIdentities.agentId, agentId));
  const now = new Date();
  const stateOrder: PublisherKeyState[] = ["allowlisted", "revoked", "expired", "pending"];
  const match = stateOrder
    .map(state => rows.find(row => effectivePublisherKeyState(row.state, row.expiresAt, now) === state))
    .find(Boolean);
  if (!match) {
    return { status: "unverified" as const, publisherName: null, publicKeyFingerprint: null, verifiedAt: null, statusChangedAt: null };
  }
  const status = effectivePublisherKeyState(match.state, match.expiresAt, now);
  if (status === "pending") {
    return { status: "unverified" as const, publisherName: null, publicKeyFingerprint: null, verifiedAt: null, statusChangedAt: null };
  }
  return {
    status,
    publisherName: match.issuerName,
    publicKeyFingerprint: match.publicKeyFingerprint,
    verifiedAt: match.validatedAt.toISOString(),
    statusChangedAt: match.changedAt.toISOString(),
  };
}
