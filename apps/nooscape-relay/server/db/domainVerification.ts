/** Domain verification challenges and their rechecks. Part of server/db.ts, which re-exports every module of this folder. */
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentEndpoints, agentIdentities, agentReadModel, domainVerificationChallenges, evidenceEvents } from "../../drizzle/schema";
import { fetchDomainControlProof } from "../domainVerification";
import { OperatorRuleError } from "../operatorRuleError";
import { EVIDENCE_TIER_SCALE_VERSION, domainVerificationExpiry, getDb, requireDb, safeErrorSummary } from "./core";
import { getNewestVisibleSnapshotCard, snapshotCardFingerprint } from "./publicRecords";

export async function createDomainVerificationChallenge(input: {
  id: string;
  agentId: string;
  domain: string;
  tokenHash: string;
  proofUrl: string;
  expiresAt: Date;
  createdByUserId: number;
}) {
  const db = requireDb(await getDb());
  const identityRows = await db
    .select({ externalId: agentIdentities.externalId })
    .from(agentIdentities)
    .where(eq(agentIdentities.agentId, input.agentId));
  const endpointRows = await db
    .select({ endpointUrl: agentEndpoints.endpointUrl })
    .from(agentEndpoints)
    .where(eq(agentEndpoints.agentId, input.agentId));
  const knownDomains = [...identityRows.map(row => row.externalId), ...endpointRows.map(row => row.endpointUrl)]
    .map(value => {
      try {
        return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
      } catch {
        return null;
      }
    })
    .filter((domain): domain is string => Boolean(domain));
  if (!knownDomains.includes(input.domain)) {
    throw new OperatorRuleError("Domain verification can only target a domain already asserted by this agent.");
  }

  await db.insert(domainVerificationChallenges).values(input);
  return { id: input.id, expiresAt: input.expiresAt, proofUrl: input.proofUrl };
}

export async function getDomainVerificationChallenge(id: string) {
  const db = requireDb(await getDb());
  const [challenge] = await db
    .select()
    .from(domainVerificationChallenges)
    .where(eq(domainVerificationChallenges.id, id))
    .limit(1);
  return challenge;
}

/**
 * Operator-facing challenge ledger. It deliberately omits the token digest and
 * the retained object key: the UI can drive verification without ever holding
 * material that locates or reconstructs the proof bytes. Verified rows carry
 * the live card-pin status so an operator can see when a changed card or an
 * elapsed window has returned the record to tier_2.
 */
export async function listDomainChallenges() {
  const db = requireDb(await getDb());
  const challenges = await db
    .select({
      id: domainVerificationChallenges.id,
      agentId: domainVerificationChallenges.agentId,
      domain: domainVerificationChallenges.domain,
      proofUrl: domainVerificationChallenges.proofUrl,
      state: domainVerificationChallenges.state,
      expiresAt: domainVerificationChallenges.expiresAt,
      verifiedAt: domainVerificationChallenges.verifiedAt,
      verificationExpiresAt: domainVerificationChallenges.verificationExpiresAt,
      recheckedAt: domainVerificationChallenges.recheckedAt,
      revokedAt: domainVerificationChallenges.revokedAt,
      proofHash: domainVerificationChallenges.proofHash,
      createdAt: domainVerificationChallenges.createdAt,
    })
    .from(domainVerificationChallenges)
    .orderBy(desc(domainVerificationChallenges.createdAt));
  return Promise.all(
    challenges.map(async challenge => {
      let cardPinStatus: "current" | "changed" | "unpinned" | null = null;
      if (challenge.state === "verified" && !challenge.revokedAt) {
        const [readModelRow] = await db
          .select({ verifiedCardHash: agentReadModel.verifiedCardHash })
          .from(agentReadModel)
          .where(eq(agentReadModel.agentId, challenge.agentId))
          .limit(1);
        const visibleCard = await getNewestVisibleSnapshotCard(challenge.agentId);
        cardPinStatus =
          !readModelRow?.verifiedCardHash || !visibleCard
            ? "unpinned"
            : readModelRow.verifiedCardHash === snapshotCardFingerprint(visibleCard)
              ? "current"
              : "changed";
      }
      return { ...challenge, cardPinStatus };
    })
  );
}

export async function completeDomainVerification(input: {
  challengeId: string;
  proofObjectKey: string;
  proofHash: string;
}) {
  const db = requireDb(await getDb());
  const challenge = await getDomainVerificationChallenge(input.challengeId);
  if (!challenge) throw new OperatorRuleError("Domain verification challenge not found.");
  if (challenge.state !== "pending" || challenge.expiresAt <= new Date()) {
    throw new OperatorRuleError("Domain verification challenge is no longer pending.");
  }

  const now = new Date();
  const verificationExpiresAt = domainVerificationExpiry(now);
  // Pin the exact card an operator can see publicly at verification time.
  const visibleCard = await getNewestVisibleSnapshotCard(challenge.agentId);

  const identityRows = await db
    .select({ id: agentIdentities.id, externalId: agentIdentities.externalId, sourceObservationId: agentIdentities.sourceObservationId })
    .from(agentIdentities)
    .where(eq(agentIdentities.agentId, challenge.agentId));
  const relevantIdentities = identityRows.filter(row => {
    try {
      return new URL(row.externalId).hostname.toLowerCase().replace(/\.$/, "") === challenge.domain;
    } catch {
      return false;
    }
  });
  if (relevantIdentities.length === 0) throw new OperatorRuleError("No matching asserted identity exists for this domain.");

  const latestObservationId = relevantIdentities[0]!.sourceObservationId;
  const eventId = randomUUID();
  await db.transaction(async tx => {
    await tx
      .update(domainVerificationChallenges)
      .set({
        state: "verified",
        verifiedAt: now,
        verificationExpiresAt,
        proofObjectKey: input.proofObjectKey,
        proofHash: input.proofHash,
      })
      .where(eq(domainVerificationChallenges.id, challenge.id));
    for (const identity of relevantIdentities) {
      await tx
        .update(agentIdentities)
        .set({ verificationState: "verified" })
        .where(eq(agentIdentities.id, identity.id));
    }
    const endpointRows = await tx
      .select({ id: agentEndpoints.id, endpointUrl: agentEndpoints.endpointUrl })
      .from(agentEndpoints)
      .where(eq(agentEndpoints.agentId, challenge.agentId));
    for (const endpoint of endpointRows) {
      try {
        if (new URL(endpoint.endpointUrl).hostname.toLowerCase().replace(/\.$/, "") === challenge.domain) {
          await tx.update(agentEndpoints).set({ domainVerification: "verified" }).where(eq(agentEndpoints.id, endpoint.id));
        }
      } catch {
        // Endpoint values are already normalized during ingestion; malformed legacy rows are ignored.
      }
    }
    await tx
      .update(agentReadModel)
      .set({
        evidenceTier: "tier_3",
        verificationExpiresAt,
        verifiedCardHash: visibleCard ? snapshotCardFingerprint(visibleCard) : null,
        evidenceSummary: JSON.stringify({
          status: "domain_control_verified",
          scale: EVIDENCE_TIER_SCALE_VERSION,
          domain: challenge.domain,
          challengeId: challenge.id,
          verificationExpiresAt: verificationExpiresAt.toISOString(),
          cardPinned: Boolean(visibleCard),
        }),
      })
      .where(eq(agentReadModel.agentId, challenge.agentId));
    await tx.insert(evidenceEvents).values({
      id: eventId,
      agentId: challenge.agentId,
      sourceObservationId: latestObservationId,
      eventType: "DOMAIN_CONTROL_VERIFIED",
      description: `HTTPS proof-file control verified for ${challenge.domain} under ${EVIDENCE_TIER_SCALE_VERSION}; valid until ${verificationExpiresAt.toISOString()}. Publisher identity remains unverified.`,
      proofReference: `https://${challenge.domain}/.well-known/nooscape-domain-verification/<redacted>`,
      payloadHash: input.proofHash,
      observedAt: now,
    });
  });
  return {
    agentId: challenge.agentId,
    domain: challenge.domain,
    evidenceTier: "tier_3" as const,
    publisherState: "unverified" as const,
    verificationExpiresAt,
  };
}

/**
 * Re-runs the live proof fetch for a verified challenge. Success renews the
 * validity window and re-pins the card the operator can currently see; any
 * failure — missing proof file, changed bytes, refused fetch — revokes the
 * upgrade fail-closed, returning the record to tier_2 evidence until a new
 * challenge succeeds.
 */
export async function recheckDomainVerification(input: { challengeId: string }) {
  const db = requireDb(await getDb());
  const challenge = await getDomainVerificationChallenge(input.challengeId);
  if (!challenge) throw new OperatorRuleError("Domain verification challenge not found.");
  if (challenge.state !== "verified" || challenge.revokedAt) {
    throw new OperatorRuleError("Only an active verified challenge can be rechecked.");
  }

  const identityRows = await db
    .select({ id: agentIdentities.id, externalId: agentIdentities.externalId, sourceObservationId: agentIdentities.sourceObservationId })
    .from(agentIdentities)
    .where(eq(agentIdentities.agentId, challenge.agentId));
  const relevantIdentities = identityRows.filter(row => {
    try {
      return new URL(row.externalId).hostname.toLowerCase().replace(/\.$/, "") === challenge.domain;
    } catch {
      return false;
    }
  });
  const latestObservationId = relevantIdentities[0]?.sourceObservationId ?? identityRows[0]?.sourceObservationId;
  if (!latestObservationId) throw new OperatorRuleError("No asserted identity exists for this agent.");

  let proofHash: string | null = null;
  let failureReason: string | null = null;
  try {
    const proof = await fetchDomainControlProof(challenge.domain, challenge.id, challenge.tokenHash);
    proofHash = proof.proofHash;
  } catch (error) {
    failureReason = safeErrorSummary(error);
  }

  const now = new Date();
  const eventId = randomUUID();
  if (!proofHash) {
    await db.transaction(async tx => {
      await tx
        .update(domainVerificationChallenges)
        .set({ revokedAt: now })
        .where(eq(domainVerificationChallenges.id, challenge.id));
      for (const identity of relevantIdentities) {
        await tx.update(agentIdentities).set({ verificationState: "asserted" }).where(eq(agentIdentities.id, identity.id));
      }
      const endpointRows = await tx
        .select({ id: agentEndpoints.id, endpointUrl: agentEndpoints.endpointUrl })
        .from(agentEndpoints)
        .where(eq(agentEndpoints.agentId, challenge.agentId));
      for (const endpoint of endpointRows) {
        try {
          if (new URL(endpoint.endpointUrl).hostname.toLowerCase().replace(/\.$/, "") === challenge.domain) {
            await tx.update(agentEndpoints).set({ domainVerification: "unverified" }).where(eq(agentEndpoints.id, endpoint.id));
          }
        } catch {
          // Malformed legacy endpoint rows are ignored, as in the verify path.
        }
      }
      await tx
        .update(agentReadModel)
        .set({
          evidenceTier: "tier_2",
          verificationExpiresAt: null,
          verifiedCardHash: null,
          evidenceSummary: JSON.stringify({
            status: "domain_control_revoked",
            scale: EVIDENCE_TIER_SCALE_VERSION,
            domain: challenge.domain,
            challengeId: challenge.id,
            reason: failureReason,
          }),
        })
        .where(eq(agentReadModel.agentId, challenge.agentId));
      await tx.insert(evidenceEvents).values({
        id: eventId,
        agentId: challenge.agentId,
        sourceObservationId: latestObservationId,
        eventType: "DOMAIN_CONTROL_REVOKED",
        description: `Domain-control recheck for ${challenge.domain} failed (${failureReason ?? "unknown error"}). The record returns to tier_2 evidence until a new challenge succeeds.`,
        observedAt: now,
      });
    });
    return {
      outcome: "revoked" as const,
      agentId: challenge.agentId,
      domain: challenge.domain,
      evidenceTier: "tier_2" as const,
      reason: failureReason,
    };
  }

  const verificationExpiresAt = domainVerificationExpiry(now);
  const visibleCard = await getNewestVisibleSnapshotCard(challenge.agentId);
  await db.transaction(async tx => {
    await tx
      .update(domainVerificationChallenges)
      .set({ recheckedAt: now, verificationExpiresAt })
      .where(eq(domainVerificationChallenges.id, challenge.id));
    await tx
      .update(agentReadModel)
      .set({
        evidenceTier: "tier_3",
        verificationExpiresAt,
        verifiedCardHash: visibleCard ? snapshotCardFingerprint(visibleCard) : null,
        evidenceSummary: JSON.stringify({
          status: "domain_control_rechecked",
          scale: EVIDENCE_TIER_SCALE_VERSION,
          domain: challenge.domain,
          challengeId: challenge.id,
          verificationExpiresAt: verificationExpiresAt.toISOString(),
          cardPinned: Boolean(visibleCard),
        }),
      })
      .where(eq(agentReadModel.agentId, challenge.agentId));
    await tx.insert(evidenceEvents).values({
      id: eventId,
      agentId: challenge.agentId,
      sourceObservationId: latestObservationId,
      eventType: "DOMAIN_CONTROL_RECHECKED",
      description: `Live proof re-fetched for ${challenge.domain} under ${EVIDENCE_TIER_SCALE_VERSION}; verification renewed until ${verificationExpiresAt.toISOString()}.`,
      proofReference: `https://${challenge.domain}/.well-known/nooscape-domain-verification/<redacted>`,
      payloadHash: proofHash,
      observedAt: now,
    });
  });
  return {
    outcome: "renewed" as const,
    agentId: challenge.agentId,
    domain: challenge.domain,
    evidenceTier: "tier_3" as const,
    verificationExpiresAt,
  };
}
