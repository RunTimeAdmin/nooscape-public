/** The ingestion worker's configuration and the atomic claim of due sources. Part of server/db.ts, which re-exports every module of this folder. */
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { ingestionSources, ingestionWorkerConfig, IngestionSource } from "../../drizzle/schema";
import { chainSwitchCondition, getDb, requireDb, safeErrorSummary } from "./core";

export async function getOrCreateIngestionWorkerConfig() {
  const db = requireDb(await getDb());
  const id = "primary";
  await db.insert(ingestionWorkerConfig).values({ id }).onDuplicateKeyUpdate({ set: { id } });
  const [config] = await db.select().from(ingestionWorkerConfig).where(eq(ingestionWorkerConfig.id, id)).limit(1);
  if (!config) throw new Error("Unable to resolve ingestion worker configuration.");
  return config;
}

export async function configureIngestionWorker(input: {
  state: "paused" | "enabled";
  maxSourcesPerTick: number;
  minGlobalIntervalMinutes: number;
  updatedByUserId: number;
}) {
  const db = requireDb(await getDb());
  await getOrCreateIngestionWorkerConfig();
  await db.update(ingestionWorkerConfig).set(input).where(eq(ingestionWorkerConfig.id, "primary"));
  return getOrCreateIngestionWorkerConfig();
}

/**
 * How early a tick may arrive and still be claimed. The host's cron fires on the same 15-minute marks the global interval measures,
 * and its request reaches the app a few seconds either side of :05, so a tick that arrived 2 seconds earlier than the one before it
 * was refused as too soon and the worker lost it: about one tick in three on 2026-10-20 (docs/base-backfill-throughput-2026-10-20.md).
 * Thirty seconds covers that jitter and still makes a manual tick, or a second instance, wait out 14.5 minutes.
 */
export const CLAIM_EARLY_TOLERANCE_MS = 30_000;

/** Claims at most one due, active source for a host-managed worker tick. */
export async function claimDueIngestionSources() {
  const db = requireDb(await getDb());
  const config = await getOrCreateIngestionWorkerConfig();
  const now = new Date();
  if (config.state !== "enabled") return { config, sources: [] as IngestionSource[], reason: "paused" as const };
  const eligibleBefore = new Date(now.getTime() - config.minGlobalIntervalMinutes * 60_000 + CLAIM_EARLY_TOLERANCE_MS);
  const claimed = await db
    .update(ingestionWorkerConfig)
    .set({ lastStartedAt: now, lastError: null })
    .where(
      and(
        eq(ingestionWorkerConfig.id, "primary"),
        eq(ingestionWorkerConfig.state, "enabled"),
        or(isNull(ingestionWorkerConfig.lastStartedAt), lte(ingestionWorkerConfig.lastStartedAt, eligibleBefore))
      )
    );
  const affectedRows = Number((claimed as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
  if (affectedRows !== 1) return { config, sources: [] as IngestionSource[], reason: "rate_limited" as const };
  const sources = await db
    .select()
    .from(ingestionSources)
    .where(
      and(
        eq(ingestionSources.state, "active"),
        eq(ingestionSources.executionPolicy, "scheduled"),
        lte(ingestionSources.nextRunAt, now),
        // A chain that is switched off is left out, as it is from every read. Its pass refuses before it opens a run, and only a finished run
        // moves a source's nextRunAt, so a source of a chain that is off would be the oldest due one at every tick and take a place in it for good.
        chainSwitchCondition()
      )
    )
    .orderBy(ingestionSources.nextRunAt)
    .limit(config.maxSourcesPerTick);
  return { config, sources, reason: "due" as const };
}

export async function finishIngestionWorkerTick(error?: unknown) {
  const db = requireDb(await getDb());
  await db
    .update(ingestionWorkerConfig)
    .set({ lastCompletedAt: new Date(), lastError: error ? safeErrorSummary(error) : null })
    .where(eq(ingestionWorkerConfig.id, "primary"));
}
