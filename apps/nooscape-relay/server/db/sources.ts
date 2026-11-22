/** Ingestion sources and the observations a run leaves for review. Part of server/db.ts, which re-exports every module of this folder. */
import { and, desc, eq, max } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentIdentities, ingestionRuns, ingestionSources, InsertIngestionSource, reviewItems, sourceObservationRuns, sourceObservations } from "../../drizzle/schema";
import { chainSwitchCondition, getDb, requireDb } from "./core";

export async function createIngestionSource(
  values: Omit<InsertIngestionSource, "id" | "createdAt" | "updatedAt" | "failureCount" | "cursor" | "nextRunAt" | "lastSuccessfulAt" | "lastError">
) {
  const db = requireDb(await getDb());
  const sourceId = randomUUID();
  const reviewId = randomUUID();

  await db.transaction(async tx => {
    await tx.insert(ingestionSources).values({ ...values, id: sourceId });
    await tx.insert(reviewItems).values({
      id: reviewId,
      type: "source",
      status: "pending",
      subjectType: "ingestion_source",
      subjectId: sourceId,
      rationale: "New source is held in review until an administrator explicitly activates it.",
      createdByUserId: values.createdByUserId,
    });
  });

  return { sourceId, reviewId };
}

export async function listIngestionSources() {
  const db = requireDb(await getDb());
  return db.select().from(ingestionSources).orderBy(desc(ingestionSources.createdAt));
}

/**
 * Returns a deliberately narrow public view of source operations. It exposes
 * lifecycle and freshness, but never a source URL, object key, run error, or
 * operator identity.
 */
export async function listPublicIngestionSourceStatuses() {
  const db = requireDb(await getDb());
  return db
    .select({
      sourceKey: ingestionSources.sourceKey,
      label: ingestionSources.label,
      protocol: ingestionSources.protocol,
      hostname: ingestionSources.allowedHostname,
      state: ingestionSources.state,
      executionPolicy: ingestionSources.executionPolicy,
      lastSuccessfulAt: ingestionSources.lastSuccessfulAt,
      failureCount: ingestionSources.failureCount,
      createdAt: ingestionSources.createdAt,
      updatedAt: ingestionSources.updatedAt,
    })
    .from(ingestionSources)
    // A source of a chain whose switch is off is not listed, whether or not it was staged while the switch was on.
    .where(chainSwitchCondition())
    .orderBy(desc(ingestionSources.updatedAt));
}

export async function listReviewItems() {
  const db = requireDb(await getDb());
  return db.select().from(reviewItems).orderBy(desc(reviewItems.createdAt));
}

export async function getIngestionSource(sourceId: string) {
  const db = requireDb(await getDb());
  const [source] = await db.select().from(ingestionSources).where(eq(ingestionSources.id, sourceId)).limit(1);
  return source;
}

/** Returns only the latest evidence metadata needed for an operator review. */
export async function getLatestSourceObservation(sourceId: string) {
  const db = requireDb(await getDb());
  const [observation] = await db
    .select({
      id: sourceObservations.id,
      canonicalLocator: sourceObservations.canonicalLocator,
      rawObjectKey: sourceObservations.rawObjectKey,
      contentHash: sourceObservations.contentHash,
      contentType: sourceObservations.contentType,
      httpStatus: sourceObservations.httpStatus,
      validationStatus: sourceObservations.validationStatus,
      validationFindings: sourceObservations.validationFindings,
      observedAt: sourceObservations.observedAt,
    })
    .from(sourceObservations)
    .where(eq(sourceObservations.sourceId, sourceId))
    .orderBy(desc(sourceObservations.observedAt))
    .limit(1);
  if (!observation) return undefined;
  const [identity] = await db
    .select({ agentId: agentIdentities.agentId })
    .from(agentIdentities)
    .where(eq(agentIdentities.sourceObservationId, observation.id))
    .limit(1);
  return { ...observation, agentId: identity?.agentId ?? null };
}

/**
 * Returns the newest approved aggregate-census observation. Its raw payload
 * stays private; callers may derive a bounded public context server-side.
 */
export async function getLatestCensusObservation() {
  const db = requireDb(await getDb());
  const [observation] = await db
    .select({
      id: sourceObservations.id,
      sourceId: sourceObservations.sourceId,
      sourceLabel: ingestionSources.label,
      canonicalLocator: sourceObservations.canonicalLocator,
      rawObjectKey: sourceObservations.rawObjectKey,
      contentHash: sourceObservations.contentHash,
      observedAt: sourceObservations.observedAt,
    })
    .from(sourceObservations)
    .innerJoin(ingestionSources, eq(sourceObservations.sourceId, ingestionSources.id))
    .where(and(eq(sourceObservations.protocol, "census"), eq(ingestionSources.state, "active")))
    .orderBy(desc(sourceObservations.observedAt))
    .limit(1);
  return observation;
}

/**
 * Upper bound on how many observations of one run the operator review tooling
 * will list and batch-verify. Current intake ceilings (Agenstry 128, Metaplex
 * accepted 192) must stay at or below this so every retained observation of a
 * reviewed run can be hash- and governance-checked before projection.
 */
export const MAX_RUN_REVIEW_OBSERVATIONS = 256;

/**
 * Returns bounded observation metadata for the latest completed run only. This
 * avoids silently reviewing an arbitrary, truncated mix of historical source
 * observations when an approved run expands beyond earlier per-source ceilings.
 */
export async function listLatestRunObservationsForReview(sourceId: string, limit = MAX_RUN_REVIEW_OBSERVATIONS) {
  const db = requireDb(await getDb());
  const [run] = await db
    .select({
      id: ingestionRuns.id,
      trigger: ingestionRuns.trigger,
      discoveredCount: ingestionRuns.discoveredCount,
      acceptedCount: ingestionRuns.acceptedCount,
      rejectedCount: ingestionRuns.rejectedCount,
      finishedAt: ingestionRuns.finishedAt,
    })
    .from(ingestionRuns)
    .where(and(eq(ingestionRuns.sourceId, sourceId), eq(ingestionRuns.status, "completed")))
    .orderBy(desc(ingestionRuns.finishedAt), desc(ingestionRuns.startedAt))
    .limit(1);
  if (!run) return { run: null, observations: [] } as const;

  const observations = await db
    .select({
      id: sourceObservations.id,
      agentId: agentIdentities.agentId,
      canonicalLocator: sourceObservations.canonicalLocator,
      contentHash: sourceObservations.contentHash,
      rawObjectKey: sourceObservations.rawObjectKey,
      observedAt: sourceObservations.observedAt,
    })
    .from(sourceObservationRuns)
    .innerJoin(sourceObservations, eq(sourceObservationRuns.observationId, sourceObservations.id))
    .leftJoin(agentIdentities, eq(agentIdentities.sourceObservationId, sourceObservations.id))
    .where(eq(sourceObservationRuns.runId, run.id))
    .orderBy(desc(sourceObservationRuns.linkedAt), desc(sourceObservations.observedAt))
    .limit(Math.min(Math.max(limit, 1), MAX_RUN_REVIEW_OBSERVATIONS));
  return { run, observations } as const;
}
