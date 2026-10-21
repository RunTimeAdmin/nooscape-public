import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, max, notInArray, or, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2";
import { createHash, randomUUID } from "node:crypto";
import {
  agentDirectoryChainActivity,
  chainReputationCounts,
  agentDirectoryChainLinks,
  agentDirectoryEntries,
  agentDirectoryRegistryRows,
  agentDirectoryUsdgSettlements,
  agentEndpoints,
  agentIdentities,
  agentPublicSnapshots,
  agentReadModel,
  agentRecordWithdrawals,
  agentRegistrationResolutions,
  agentReputationEvents,
  agentSolanaActivity,
  agents,
  bscEntryEvidence,
  domainVerificationChallenges,
  evidenceEvents,
  ingestionRuns,
  ingestionSources,
  ingestionWorkerConfig,
  identityMergeReviews,
  InsertIngestionSource,
  IngestionSource,
  publisherBindings,
  publisherKeyHistory,
  publisherKeys,
  reviewItems,
  sourceObservationRuns,
  sourceObservations,
  sourceProjectionDecisions,
  users,
} from "../drizzle/schema";
import { breakerStream, databaseBreaker, guardPool, POOL_ACQUIRE_TIMEOUT_CODE } from "./dbBreaker";
import { fetchDomainControlProof } from "./domainVerification";
import { ROBINHOOD_HANDOUT_BLOCK_WINDOW } from "./ingestion/robinhood";
import { evmIdentityChain } from "./ingestion/evmIdentityChains";
import { erc8004ChainOfProtocol } from "./ingestion/erc8004Chains";
import type { A2aNormalizedCandidate, CatalogNormalizedCandidate, DirectoryChainActivityEvent, DirectoryEntryDraft, Erc8004RegistryCandidate, Erc8004ReputationEvent, RawObservationInput, SolanaChainActivityEvent, SolanaRegistryCandidate, UsdgSettlementEvent } from "./ingestion/types";
import { currentBnbSourceNote } from "./bscSourceNote";
import { BSC_NOT_CHECKED, registrationReadOf, type BscRegistrationRead } from "./bscRegistrationRead";
import { nameableRecord, overlayResolvedNames, ROBINHOOD_SOURCE_KEY, type ResolvedName } from "./robinhoodNamesCore";
import { sanitizePrimaryCapability, sanitizePublicText } from "./publicText";
import type { ValidatedPublisherKeyProof } from "./publisherVerification";
import { buildArrivals, ARRIVALS_NEWEST_PER_CHAIN, ARRIVALS_WINDOW_HOURS, type Arrivals } from "@shared/arrivals";
import { balancedNewest } from "@shared/balancedNewest";
import { buildChainStats, buildExtraChainStats, CHAINS, extraChainsOn, extraProtocolOf, listedChainOf, parseProtocolList, protocolsOf, protocolsOfChainsOff, type ChainStat, type ChainStatsInput, type ExtraChainKey, type ExtraChainStat, type RegistryProfile } from "@shared/chains";
import { buildNoosphereSample, MAX_FLEETS, MAX_LIGHTS, NOOSPHERE_PROTOCOLS, sampleModulus, type NoosphereSample } from "@shared/noosphere";
import { cachedDirectoryRead, cachedSearchRead, invalidateDirectoryReads, invalidateDirectoryReadsSoftly } from "./readCache";
import type { AgentDirectoryEntryRatings } from "./ratingsSurface";
import { computeRatingsSummary, parseReputationExternalKey, REPUTATION_KEY_PREFIX } from "./ratingsSurface";

let _db: ReturnType<typeof drizzle> | null = null;

/**
 * The host caps this database account at 500 new connections an hour. Past that
 * it refuses every further connection until the hour turns over
 * (ER_USER_LIMIT_REACHED, "max_connections_per_hour"), which took down the
 * operator console and every other call that needs a fresh connection. A
 * connection is therefore a budgeted resource, and the pool keeps the ones it has.
 *
 * Idle connections used to be retired on a timer (maxIdle 5, idleTimeout 45 s)
 * so the host's idle killer could not sever them silently. mysql2 destroys every
 * free connection beyond maxIdle within a second, and every connection idle past
 * idleTimeout, so any burst after a quiet moment reopened up to ten, and the
 * pages that poll every 8 to 20 seconds spent the hour's budget. maxIdle now
 * equals connectionLimit, which leaves mysql2's idle reaper off, and TCP
 * keepalive probes every 10 s keep an idle connection from being dropped without
 * notice (the default delay is the OS's two hours). A connection that does die is
 * noticed by the probe or the close and leaves the pool. If the host does refuse a
 * connection, dbBreaker.ts stops every request from dialling it again until a
 * cooldown has passed.
 *
 * A request also stops waiting for a connection after DB_ACQUIRE_TIMEOUT_MS
 * (guardPool). Without that, a database that stops answering holds all eight
 * connections in hung queries and every request behind them waits for as long as
 * the freeze lasts. The wait is long on purpose: while the cached aggregates
 * rebuild they hold most of the connections for several seconds, and a visitor
 * who waits that out gets a right answer where a short limit would give an empty
 * one. queueLimit is only a memory valve against that queue growing without bound.
 */
export const DB_POOL_OPTIONS = { connectionLimit: 8, maxIdle: 8, queueLimit: 2_000, enableKeepAlive: true, keepAliveInitialDelay: 10_000 } as const;

/** How long a request waits for a pooled connection before it is answered as a failed read. */
export const DB_ACQUIRE_TIMEOUT_MS = 30_000;

/** A process opens about ten connections and keeps them, so this many inside an hour means the pool is churning. */
export const DB_CONNECTIONS_WARN_PER_HOUR = 150;

/**
 * Logs once per hour-long window when the process has opened an unusual number
 * of connections, so a pool that starts churning again (a host that drops idle
 * connections, a code path that bypasses the pool) shows in the runtime log long
 * before the host's cap does.
 */
export function watchPoolConnections(pool: { on(event: "connection", listener: () => void): unknown }, now: () => number = Date.now) {
  let windowStart = now();
  let opened = 0;
  pool.on("connection", () => {
    if (now() - windowStart >= 3_600_000) {
      windowStart = now();
      opened = 0;
    }
    opened += 1;
    if (opened === DB_CONNECTIONS_WARN_PER_HOUR) {
      console.warn(`[Database] ${opened} connections opened within an hour; the host refuses new ones at 500.`);
    }
  });
}

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const pool = createPool({ uri: process.env.DATABASE_URL, ...DB_POOL_OPTIONS, stream: breakerStream(databaseBreaker) });
      watchPoolConnections(pool);
      guardPool(pool, databaseBreaker, { acquireTimeoutMs: DB_ACQUIRE_TIMEOUT_MS });
      _db = drizzle(pool);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export function requireDb<T>(db: T | null): T {
  if (!db) throw new Error("Nooscape live data requires a configured database.");
  return db;
}

function safeErrorSummary(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown ingestion error";
  return message.replace(/[\r\n]+/g, " ").slice(0, 1000);
}

function mapPositionFromHandle(handle: string) {
  let hash = 0;
  for (const character of handle) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { x: 12 + (hash % 76), y: 14 + ((hash >>> 8) % 70) };
}

function hashValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Version of the single published evidence-tier scale (docs/evidence-tier-scale-v1-2026-10-08.md). */
export const EVIDENCE_TIER_SCALE_VERSION = "evidence-tier-v1";

/** Domain-control verification is not permanent: a recheck renews this window. */
export const DOMAIN_VERIFICATION_VALIDITY_DAYS = 90;

function domainVerificationExpiry(now: Date) {
  return new Date(now.getTime() + DOMAIN_VERIFICATION_VALIDITY_DAYS * 24 * 60 * 60 * 1_000);
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * Ensures the production-only operator token resolves to a persistent audit actor.
 * The token itself is never stored in the database: it exists only as a server
 * environment variable and is checked before this function is called.
 */
export async function ensureProductionOperator() {
  const db = requireDb(await getDb());
  const openId = "nooscape-production-operator";

  await db
    .insert(users)
    .values({
      openId,
      name: "Nooscape production operator",
      loginMethod: "server-operator-token",
      role: "admin",
      lastSignedIn: new Date(),
    })
    .onDuplicateKeyUpdate({
      set: {
        name: "Nooscape production operator",
        loginMethod: "server-operator-token",
        role: "admin",
        lastSignedIn: new Date(),
      },
    });

  const [operator] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  if (!operator) throw new Error("Unable to resolve the production operator identity.");
  return operator;
}

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
 * will list and batch-verify. Current intake ceilings (Agenstry 96, Metaplex
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

/**
 * Upserts master-directory acknowledgements for one source run. Entries are
 * locator-class facts keyed by the source's own external key; repeated
 * observations refresh the display fields and seen dates but never create
 * trust, tiers, or map placement. Directory state is fully outside the
 * reviewed-run gate that governs public records.
 */
export async function upsertAgentDirectoryEntries(input: Parameters<typeof upsertAgentDirectoryEntriesImpl>[0]) {
  // Any write that can change what the cached directory aggregates count
  // marks them stale, on success or failure (a failure may have written part of
  // it): they are served as they are and reloaded once the writes go quiet.
  try {
    return await upsertAgentDirectoryEntriesImpl(input);
  } finally {
    invalidateDirectoryReadsSoftly();
  }
}

async function upsertAgentDirectoryEntriesImpl(input: {
  source: IngestionSource;
  runId: string;
  entries: DirectoryEntryDraft[];
  /**
   * Chain-pass upserts set this: their drafts carry no locator host (a chain
   * read yields no URL), and the update set must therefore leave an existing
   * locatorHost — written by the API pilot — untouched instead of nulling it.
   */
  preserveLocatorHost?: boolean;
  /**
   * Insert-only acknowledgements (the Metaplex API pilot): existing rows are
   * never updated, so the API path can neither overwrite a chain-written
   * display name nor null a chain-written registrant. The chain activity
   * pass remains the only writer of owner and name for acknowledged rows.
   */
  insertOnly?: boolean;
  /**
   * Chain-pass live upserts set this: a live acknowledgement clears the
   * closure marker (assetClosedAt) so a re-registered asset returns to
   * public reads. The insert path always leaves the marker null.
   */
  clearAssetClosed?: boolean;
}) {
  if (input.entries.length === 0) return 0;
  const db = requireDb(await getDb());
  const seenAt = new Date();
  // Rows are mapped per chunk, not up front: a full Agenstry harvest carries
  // ~214k drafts, and holding both the drafts and their row images would
  // double the peak. 2,000-row batches keep each statement well under MySQL's
  // max_allowed_packet while completing a full harvest in ~107 statements.
  let upsertedCount = 0;
  const chunkSize = 2_000;
  for (let index = 0; index < input.entries.length; index += chunkSize) {
    const rows = input.entries.slice(index, index + chunkSize).map(entry => ({
      id: randomUUID(),
      sourceId: input.source.id,
      externalKey: entry.externalKey,
      displayName: entry.displayName,
      locatorHost: entry.locatorHost,
      protocol: input.source.protocol,
      sourceSignalNote: entry.sourceSignalNote,
      registrant: entry.registrant ?? null,
      // 8004 chain facts, written by the 8004 pass alone: every other source
      // leaves both undefined and its rows stay null. The update set carries
      // them via values() so a live 8004 acknowledgement refreshes both.
      accountPubkey: entry.accountPubkey ?? null,
      profileUriHash: entry.profileUriHash ?? null,
      // The live feedback counter (migration 0028, 8004 pass only): the
      // census-exact ratings number, refreshed every pass; count changes
      // fire no ledger event.
      feedbackCount: entry.feedbackCount ?? null,
      // Suppressed-domain rows are born hidden. The update set below
      // deliberately never touches `hidden`: a catalog refresh may refresh
      // display facts, but it can neither resurrect a suppressed or
      // operator-hidden row nor unhide one.
      hidden: isSuppressedLocatorHost(entry.locatorHost),
      lastSeenAt: seenAt,
      lastRunId: input.runId,
    }));
    if (input.insertOnly) {
      // INSERT-IGNORE, like the ledger writes: an API pilot row for an asset
      // the chain pass already acknowledged is left exactly as the chain
      // wrote it.
      await db.insert(agentDirectoryEntries).ignore().values(rows);
    } else {
      await db
        .insert(agentDirectoryEntries)
        .values(rows)
        .onDuplicateKeyUpdate({
          set: {
            displayName: sql.raw("values(`displayName`)"),
            ...(input.preserveLocatorHost ? {} : { locatorHost: sql.raw("values(`locatorHost`)") }),
            ...(input.clearAssetClosed ? { assetClosedAt: null } : {}),
            sourceSignalNote: sql.raw("values(`sourceSignalNote`)"),
            registrant: sql.raw("values(`registrant`)"),
            accountPubkey: sql.raw("values(`accountPubkey`)"),
            profileUriHash: sql.raw("values(`profileUriHash`)"),
            feedbackCount: sql.raw("values(`feedbackCount`)"),
            lastSeenAt: seenAt,
            lastRunId: input.runId,
          },
        });
    }
    upsertedCount += rows.length;
  }
  return upsertedCount;
}

/**
 * Marks the directory rows of assets a chain pass just acknowledged closing
 * (assetClosedAt). The update deliberately touches nothing else: a closed row
 * keeps its last acknowledged display name and registrant — no placeholder
 * rewrite, no owner clearing — and leaves every public read through the
 * visibility predicate. lastRunId records which run acknowledged the closure.
 */
export async function markAgentDirectoryEntriesClosed(input: Parameters<typeof markAgentDirectoryEntriesClosedImpl>[0]) {
  // Any write that can change what the cached directory aggregates count
  // marks them stale, on success or failure (a failure may have written part of
  // it): they are served as they are and reloaded once the writes go quiet.
  try {
    return await markAgentDirectoryEntriesClosedImpl(input);
  } finally {
    invalidateDirectoryReadsSoftly();
  }
}

async function markAgentDirectoryEntriesClosedImpl(input: {
  source: IngestionSource;
  runId: string;
  externalKeys: string[];
}) {
  if (input.externalKeys.length === 0) return 0;
  const db = requireDb(await getDb());
  const closedAt = new Date();
  const chunkSize = 2_000;
  let markedCount = 0;
  for (let index = 0; index < input.externalKeys.length; index += chunkSize) {
    const keys = input.externalKeys.slice(index, index + chunkSize);
    await db
      .update(agentDirectoryEntries)
      .set({ assetClosedAt: closedAt, lastRunId: input.runId })
      .where(
        and(
          eq(agentDirectoryEntries.sourceId, input.source.id),
          inArray(agentDirectoryEntries.externalKey, keys)
        )
      );
    markedCount += keys.length;
  }
  return markedCount;
}

/**
 * The source's prior registration-name resolutions (migration 0028) — the
 * fetch queue's idempotency state: which URI hashes resolved, which are
 * terminal, which may retry, and which names they carry for the enrichment
 * rule. Bounded by the live account census (one row per distinct
 * registration URI, under the 4,000-account scan ceiling).
 */
export async function listAgentRegistrationResolutions(sourceId: string): Promise<
  Array<{
    externalKey: string;
    uriHash: string;
    status: "resolved" | "no_name" | "failed";
    resolvedName: string | null;
    attempts: number;
  }>
> {
  const db = requireDb(await getDb());
  return db
    .select({
      externalKey: agentRegistrationResolutions.externalKey,
      uriHash: agentRegistrationResolutions.uriHash,
      status: agentRegistrationResolutions.status,
      resolvedName: agentRegistrationResolutions.resolvedName,
      attempts: agentRegistrationResolutions.attempts,
    })
    .from(agentRegistrationResolutions)
    .where(eq(agentRegistrationResolutions.sourceId, sourceId));
}

/**
 * Upserts one pass's resolution rows against the (sourceId, uriHash) key.
 * The status semantics live in the adapter — including attempts = prior + 1 —
 * and this write is the record. `fetchedAt` keeps its FIRST resolved
 * timestamp via COALESCE: resolved rows are never re-fetched, but the
 * chain-stored meta-name rows re-upsert every pass, and their resolution
 * time must not churn.
 */
export async function upsertAgentRegistrationResolutions(input: {
  source: IngestionSource;
  drafts: Array<{
    externalKey: string;
    uriHash: string;
    uriKind: string;
    uri: string;
    status: "resolved" | "no_name" | "failed";
    failReason: string | null;
    resolvedName: string | null;
    attempts: number;
  }>;
}) {
  if (input.drafts.length === 0) return 0;
  const db = requireDb(await getDb());
  const now = new Date();
  let upsertedCount = 0;
  const chunkSize = 2_000;
  for (let index = 0; index < input.drafts.length; index += chunkSize) {
    const rows = input.drafts.slice(index, index + chunkSize).map(draft => ({
      id: randomUUID(),
      sourceId: input.source.id,
      externalKey: draft.externalKey,
      uriHash: draft.uriHash,
      uriKind: draft.uriKind,
      uri: draft.uri,
      status: draft.status,
      failReason: draft.failReason,
      resolvedName: draft.resolvedName,
      attempts: draft.attempts,
      lastAttemptAt: now,
      fetchedAt: draft.status === "resolved" ? now : null,
    }));
    await db
      .insert(agentRegistrationResolutions)
      .values(rows)
      .onDuplicateKeyUpdate({
        set: {
          externalKey: sql.raw("values(`externalKey`)"),
          uriKind: sql.raw("values(`uriKind`)"),
          uri: sql.raw("values(`uri`)"),
          status: sql.raw("values(`status`)"),
          failReason: sql.raw("values(`failReason`)"),
          resolvedName: sql.raw("values(`resolvedName`)"),
          attempts: sql.raw("values(`attempts`)"),
          lastAttemptAt: sql.raw("values(`lastAttemptAt`)"),
          fetchedAt: sql.raw("COALESCE(`fetchedAt`, values(`fetchedAt`))"),
        },
      });
    upsertedCount += rows.length;
  }
  return upsertedCount;
}

/**
 * Upserts one pass's cross-chain reference rows (migration 0028) against the
 * (sourceId, externalKey, metadataKey, linkedExternalKey) key. Upsert-only by
 * design — nothing un-links. `linkedEntryId` resolves here, at the write:
 * exactly one acknowledged directory entry across all sources carrying the
 * linked value verbatim earns the pointer; zero or ambiguous matches stay
 * null rather than guessing a join. The live 8004 metadata vocabulary
 * ("erc8004-eth: #25045") matches none of the acknowledged externalKeys
 * today — the probe found no twin written as a machine-readable row — so
 * this usually resolves nothing, and that is the honest outcome.
 */
export async function upsertAgentDirectoryChainLinks(input: {
  source: IngestionSource;
  drafts: Array<{
    externalKey: string;
    metadataKey: string;
    linkedProtocol: "a2a" | "anp" | "agntcy" | "erc8004" | "erc8004_reputation" | "catalog" | "census" | "solana_registry" | "solana_8004" | "usdg_settlement" | "other";
    linkedExternalKey: string;
    metadataValueHash: string;
  }>;
}) {
  if (input.drafts.length === 0) return 0;
  const db = requireDb(await getDb());
  const linkedKeys = Array.from(new Set(input.drafts.map(draft => draft.linkedExternalKey)));
  const matches = await db
    .select({ id: agentDirectoryEntries.id, externalKey: agentDirectoryEntries.externalKey })
    .from(agentDirectoryEntries)
    .where(inArray(agentDirectoryEntries.externalKey, linkedKeys));
  const entryIdsByKey = new Map<string, string[]>();
  for (const match of matches) {
    const bucket = entryIdsByKey.get(match.externalKey);
    if (bucket) bucket.push(match.id);
    else entryIdsByKey.set(match.externalKey, [match.id]);
  }
  const now = new Date();
  const rows = input.drafts.map(draft => {
    const ids = entryIdsByKey.get(draft.linkedExternalKey);
    return {
      id: randomUUID(),
      sourceId: input.source.id,
      externalKey: draft.externalKey,
      metadataKey: draft.metadataKey,
      linkedProtocol: draft.linkedProtocol,
      linkedExternalKey: draft.linkedExternalKey,
      linkedEntryId: ids !== undefined && ids.length === 1 ? ids[0]! : null,
      metadataValueHash: draft.metadataValueHash,
      discoveredAt: now,
    };
  });
  let upsertedCount = 0;
  const chunkSize = 2_000;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    await db
      .insert(agentDirectoryChainLinks)
      .values(chunk)
      .onDuplicateKeyUpdate({
        set: {
          linkedProtocol: sql.raw("values(`linkedProtocol`)"),
          linkedEntryId: sql.raw("values(`linkedEntryId`)"),
          metadataValueHash: sql.raw("values(`metadataValueHash`)"),
          discoveredAt: sql.raw("values(`discoveredAt`)"),
        },
      });
    upsertedCount += chunk.length;
  }
  return upsertedCount;
}

/**
 * The source's own acknowledged directory rows, reduced to the fields the
 * Solana chain diffs need: externalKey → prior display name, locator host,
 * registrant, and whether a prior pass already acknowledged the asset closing
 * (assetClosedAt set). Deliberately bounded — a state-diff pass compares one
 * source against itself, and this source's row count is bounded by the
 * 4,000-asset scan ceiling.
 */
export async function listAgentDirectoryEntriesForSource(sourceId: string): Promise<
  Array<{
    externalKey: string;
    displayName: string | null;
    locatorHost: string | null;
    registrant: string | null;
    accountPubkey: string | null;
    profileUriHash: string | null;
    assetClosedAt: Date | null;
  }>
> {
  const db = requireDb(await getDb());
  return db
    .select({
      externalKey: agentDirectoryEntries.externalKey,
      displayName: agentDirectoryEntries.displayName,
      locatorHost: agentDirectoryEntries.locatorHost,
      registrant: agentDirectoryEntries.registrant,
      accountPubkey: agentDirectoryEntries.accountPubkey,
      profileUriHash: agentDirectoryEntries.profileUriHash,
      assetClosedAt: agentDirectoryEntries.assetClosedAt,
    })
    .from(agentDirectoryEntries)
    .where(eq(agentDirectoryEntries.sourceId, sourceId));
}

/**
 * Acknowledges one bounded chain-activity window into the append-only ledger
 * and recomputes the per-entry rollups the window can reach. Every event is
 * INSERT-IGNORE'd against the (sourceId, transactionHash, logIndex) key, so
 * re-applying a window — or re-running the whole walk — can never
 * double-count; the rollups are recomputed from the full ledger for the
 * source, so they stay a pure function of acknowledged events rather than of
 * run order.
 */
export async function applyAgentDirectoryActivityWindow(input: Parameters<typeof applyAgentDirectoryActivityWindowImpl>[0]) {
  // Any write that can change what the cached directory aggregates count
  // marks them stale, on success or failure (a failure may have written part of
  // it): they are served as they are and reloaded once the writes go quiet.
  try {
    return await applyAgentDirectoryActivityWindowImpl(input);
  } finally {
    invalidateDirectoryReadsSoftly();
  }
}

async function applyAgentDirectoryActivityWindowImpl(input: {
  source: IngestionSource;
  activity: DirectoryChainActivityEvent[];
  /**
   * Blocks in the chain's mint hour for the hand-out rule. Defaults to Robinhood
   * Chain's; a chain with a different block cadence passes its own, because the
   * rollup stores the classification on the entry.
   */
  handoutBlockWindow?: number;
  /**
   * Recompute the rollups only for the entries this window touched. The default
   * rebuilds the whole source's rollups, which is right for a few thousand
   * entries and quadratic for a few hundred thousand; a large walk passes true.
   */
  incrementalRollup?: boolean;
  /**
   * Which table holds the rows the rollups are written onto. The default is the
   * directory table; the BNB Chain registry keeps its registrations in the
   * registry rows table (agentRegistryRows.ts) and publishes the listed ones.
   */
  rollupTarget?: "registry";
}) {
  if (input.activity.length === 0) return { acknowledgedCount: 0 };
  const db = requireDb(await getDb());
  // Chunked like the directory upsert: a narrowed activity window can carry up
  // to the 10,000-event sub-window bound, and 2,000-row batches keep every
  // statement well inside MySQL's max_allowed_packet.
  const chunkSize = 2_000;
  for (let index = 0; index < input.activity.length; index += chunkSize) {
    const rows = input.activity.slice(index, index + chunkSize).map(event => ({
      id: randomUUID(),
      sourceId: input.source.id,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      kind: event.kind,
      blockNumber: event.blockNumber,
      externalKey: event.externalKey,
      fromAddress: event.fromAddress,
      toAddress: event.toAddress,
    }));
    await db.insert(agentDirectoryChainActivity).ignore().values(rows);
  }
  await recomputeAgentDirectoryActivityRollups(input.source.id, {
    handoutBlockWindow: input.handoutBlockWindow ?? ROBINHOOD_HANDOUT_BLOCK_WINDOW,
    externalKeys: input.incrementalRollup ? Array.from(new Set(input.activity.map(event => event.externalKey))) : undefined,
    table: input.rollupTarget === "registry" ? "agent_directory_registry_rows" : "agent_directory_entries",
  });
  return { acknowledgedCount: input.activity.length };
}

/**
 * Acknowledges one bounded Solana chain-activity window into the append-only
 * ledger, chunked and INSERT-IGNORE'd against the
 * (sourceId, transactionSignature, externalKey, kind) key exactly like the EVM
 * activity window — re-applying a window, or re-running a whole pass, can
 * never double-count, while one transaction that produced several kinds for
 * one asset (a transfer and a rename in the same tx) keeps every event. The
 * Metaplex diff derives no rollup columns today; the ledger is the replayable
 * record.
 */
export async function applySolanaActivityWindow(input: Parameters<typeof applySolanaActivityWindowImpl>[0]) {
  // Any write that can change what the cached directory aggregates count
  // marks them stale, on success or failure (a failure may have written part of
  // it): they are served as they are and reloaded once the writes go quiet.
  try {
    return await applySolanaActivityWindowImpl(input);
  } finally {
    invalidateDirectoryReadsSoftly();
  }
}

async function applySolanaActivityWindowImpl(input: {
  source: IngestionSource;
  events: SolanaChainActivityEvent[];
}) {
  if (input.events.length === 0) return { acknowledgedCount: 0 };
  const db = requireDb(await getDb());
  const chunkSize = 2_000;
  for (let index = 0; index < input.events.length; index += chunkSize) {
    const rows = input.events.slice(index, index + chunkSize).map(event => ({
      id: randomUUID(),
      sourceId: input.source.id,
      transactionSignature: event.transactionSignature,
      slot: event.slot,
      kind: event.kind,
      externalKey: event.externalKey,
      fromOwner: event.fromOwner,
      toOwner: event.toOwner,
    }));
    await db.insert(agentSolanaActivity).ignore().values(rows);
  }
  return { acknowledgedCount: input.events.length };
}

/**
 * Acknowledges one bounded USDG settlement window into the ledger. Chunked
 * like the activity window even though the settlement budget caps a window at
 * 200 rows — the INSERT-IGNORE key makes re-runs idempotent and public
 * totals stay a pure function of the ledger. Raw values stay exact decimal
 * strings; dollars are derived at render, never stored.
 */
export async function applyUsdgSettlementWindow(input: {
  source: IngestionSource;
  settlements: UsdgSettlementEvent[];
}) {
  if (input.settlements.length === 0) return { acknowledgedCount: 0 };
  const db = requireDb(await getDb());
  const chunkSize = 2_000;
  for (let index = 0; index < input.settlements.length; index += chunkSize) {
    const rows = input.settlements.slice(index, index + chunkSize).map(settlement => ({
      id: randomUUID(),
      sourceId: input.source.id,
      transactionHash: settlement.transactionHash,
      logIndex: settlement.logIndex,
      blockNumber: settlement.blockNumber,
      payerAddress: settlement.payerAddress,
      payeeAddress: settlement.payeeAddress,
      relayerAddress: settlement.relayerAddress,
      valueRaw: settlement.valueRaw,
    }));
    await db.insert(agentDirectoryUsdgSettlements).ignore().values(rows);
  }
  return { acknowledgedCount: input.settlements.length };
}

/**
 * Acknowledges one bounded ERC-8004 reputation window into the append-only
 * ratings ledger. Chunked and INSERT-IGNORE'd against the
 * (sourceId, transactionHash, logIndex) key exactly like the other chain
 * ledgers, so re-running a window — or the whole walk — can never
 * double-count. The pair-ordinal recompute afterwards maintains the
 * completeness check column — recomputed chain-order rank vs the emitted
 * feedbackIndex (docs/reputation-ingest-2026-10-11.md §3).
 */
export async function applyAgentDirectoryReputationWindow(input: Parameters<typeof applyAgentDirectoryReputationWindowImpl>[0]) {
  // Any write that can change what the cached directory aggregates count
  // marks them stale, on success or failure (a failure may have written part of
  // it): they are served as they are and reloaded once the writes go quiet.
  try {
    return await applyAgentDirectoryReputationWindowImpl(input);
  } finally {
    invalidateDirectoryReadsSoftly();
  }
}

async function applyAgentDirectoryReputationWindowImpl(input: {
  source: IngestionSource;
  events: Erc8004ReputationEvent[];
}) {
  if (input.events.length === 0) return { acknowledgedCount: 0 };
  const db = requireDb(await getDb());
  const chunkSize = 2_000;
  for (let index = 0; index < input.events.length; index += chunkSize) {
    const rows = input.events.slice(index, index + chunkSize).map(event => ({
      id: randomUUID(),
      sourceId: input.source.id,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      kind: event.kind,
      blockNumber: event.blockNumber,
      agentId: Number(event.agentId),
      clientAddress: event.clientAddress,
      feedbackIndex: event.feedbackIndex,
      valueRaw: event.valueRaw,
      valueDecimals: event.valueDecimals,
      tag1: event.tag1,
      tag2: event.tag2,
      endpoint: event.endpoint,
      feedbackUri: event.feedbackUri,
      feedbackHash: event.feedbackHash,
      responderAddress: event.responderAddress,
    }));
    await db.insert(agentReputationEvents).ignore().values(rows);
  }
  await recomputeReputationPairOrdinals(input.source.id);
  return { acknowledgedCount: input.events.length };
}

/**
 * Rebuilds the chain-order rank of every NewFeedback row within its
 * (agentId, clientAddress) pair. The contract emits that same counter as
 * feedbackIndex on every event, so on a complete ledger rank === feedbackIndex
 * for every row; recomputed over the whole pair after every apply, any
 * divergence is the mechanical deep-history gap detector the post-walk
 * reconciliation checks. The read side joins a FeedbackRevoked to the exact
 * rating it names via feedbackIndex and never deletes the rating row itself;
 * revoked rows keep pairOrdinal null.
 */
async function recomputeReputationPairOrdinals(sourceId: string) {
  const db = requireDb(await getDb());
  await db.execute(sql`
    UPDATE agent_reputation_events AS r
    JOIN (
      SELECT
        rated.id,
        ROW_NUMBER() OVER (
          PARTITION BY rated.agentId, rated.clientAddress
          ORDER BY rated.blockNumber, rated.logIndex
        ) AS pairOrdinal
      FROM agent_reputation_events AS rated
      WHERE rated.sourceId = ${sourceId} AND rated.kind = 'new_feedback'
    ) AS ranked ON r.id = ranked.id
    SET r.pairOrdinal = ranked.pairOrdinal
    WHERE r.sourceId = ${sourceId}
  `);
}

/**
 * Recomputes the mint / secondary-transfer / hand-out / URI-update rollups
 * onto every acknowledged entry of one source that the activity ledger has
 * reached. Entries the walk has not covered keep null — "not measured yet",
 * never a false zero — and because the rollup derives from the whole ledger a
 * re-run converges to the same values.
 */
async function recomputeAgentDirectoryActivityRollups(
  sourceId: string,
  options: { handoutBlockWindow: number; externalKeys?: string[]; table?: "agent_directory_entries" | "agent_directory_registry_rows" }
) {
  const db = requireDb(await getDb());
  // With explicit keys the recompute is limited to those entries, in chunks
  // that keep each statement's IN list small; without them it covers the
  // whole source exactly as it always has.
  const keyChunks: Array<string[] | null> = [];
  if (options.externalKeys) {
    for (let index = 0; index < options.externalKeys.length; index += 1_000) keyChunks.push(options.externalKeys.slice(index, index + 1_000));
  } else {
    keyChunks.push(null);
  }
  for (const keys of keyChunks) {
    const keyFilter = (alias: string) =>
      keys ? sql` AND ${sql.raw(alias)}.externalKey IN (${sql.join(keys.map(key => sql`${key}`), sql`, `)})` : sql``;
    await db.execute(sql`
      UPDATE ${sql.raw(options.table ?? "agent_directory_entries")} AS e
      JOIN (
        SELECT
          perKey.externalKey,
          perKey.mintBlock,
          perKey.mintTo,
          perKey.secondaryCount,
          perKey.uriCount,
          COALESCE(SUM(
            CASE
              WHEN ev.kind = 'secondary'
                AND perKey.mintBlock IS NOT NULL
                AND perKey.mintTo IS NOT NULL
                AND ev.blockNumber <= perKey.mintBlock + ${options.handoutBlockWindow}
                AND ev.fromAddress = perKey.mintTo
              THEN 1
              ELSE 0
            END
          ), 0) AS handoutCount
        FROM (
          SELECT
            a.externalKey,
            MIN(CASE WHEN a.kind = 'mint' THEN a.blockNumber END) AS mintBlock,
            MIN(CASE WHEN a.kind = 'mint' THEN a.toAddress END) AS mintTo,
            COUNT(CASE WHEN a.kind = 'secondary' THEN 1 END) AS secondaryCount,
            COUNT(CASE WHEN a.kind = 'uri_update' THEN 1 END) AS uriCount
          FROM agent_directory_chain_activity AS a
          WHERE a.sourceId = ${sourceId}${keyFilter("a")}
          GROUP BY a.externalKey
        ) AS perKey
        JOIN agent_directory_chain_activity AS ev
          ON ev.sourceId = ${sourceId} AND ev.externalKey = perKey.externalKey
        GROUP BY perKey.externalKey, perKey.mintBlock, perKey.mintTo, perKey.secondaryCount, perKey.uriCount
      ) AS rollup ON e.externalKey = rollup.externalKey
      SET
        e.mintBlock = rollup.mintBlock,
        e.secondaryTransferCount = rollup.secondaryCount,
        e.handoutCount = rollup.handoutCount,
        e.uriUpdateCount = rollup.uriCount
      WHERE e.sourceId = ${sourceId}${keyFilter("e")}
    `);
  }
}

/**
 * Look-alike counts for a batch of acknowledged entries: how many OTHER
 * entries share each entry's registering wallet, exact display name, or
 * locator host. Locator-class facts only — the counts group registrations,
 * they never identify an operator or rate an agent. Only entries from active
 * sources are counted.
 */
async function agentDirectoryRelatedCounts(
  entries: Array<{
    registrant: string | null;
    displayName: string;
    locatorHost: string | null;
    /** Set for registry-backed protocols; their wallet and host counts come from the registry rows. */
    protocol?: string;
    sourceId?: string;
  }>
) {
  if (entries.length === 0) return [];
  const db = requireDb(await getDb());
  // Every chain the ERC-8004 chain pass reads is registry-backed: BNB Chain, and Ethereum, Base and Arc beside it.
  const registryBacked = (entry: (typeof entries)[number]): entry is RegistryBackedEntry & (typeof entries)[number] =>
    entry.protocol !== undefined && erc8004ChainOfProtocol(entry.protocol) !== null && entry.sourceId !== undefined;
  const registryCounts = await registryRelatedCounts(db, entries.filter(registryBacked));
  const live = entries.filter(entry => !registryBacked(entry));
  const registrants = Array.from(new Set(live.map(entry => entry.registrant).filter((value): value is string => value !== null)));
  const names = Array.from(new Set(entries.map(entry => entry.displayName)));
  const hosts = Array.from(new Set(live.map(entry => entry.locatorHost).filter((value): value is string => value !== null)));
  const walletRows = registrants.length > 0
    ? await db
        .select({ value: agentDirectoryEntries.registrant, total: sql<number>`count(*)` })
        .from(agentDirectoryEntries)
        .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
        .where(and(inArray(agentDirectoryEntries.registrant, registrants), directoryVisibilityCondition()))
        .groupBy(agentDirectoryEntries.registrant)
    : [];
  const nameRows = await db
    .select({ value: agentDirectoryEntries.displayName, total: sql<number>`count(*)` })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(inArray(agentDirectoryEntries.displayName, names), directoryVisibilityCondition()))
    .groupBy(agentDirectoryEntries.displayName);
  const hostRows = hosts.length > 0
    ? await db
        .select({ value: agentDirectoryEntries.locatorHost, total: sql<number>`count(*)` })
        .from(agentDirectoryEntries)
        .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
        .where(and(inArray(agentDirectoryEntries.locatorHost, hosts), directoryVisibilityCondition()))
        .groupBy(agentDirectoryEntries.locatorHost)
    : [];
  const walletTotals = new Map(walletRows.map(row => [row.value, Number(row.total ?? 0)]));
  const nameTotals = new Map(nameRows.map(row => [row.value, Number(row.total ?? 0)]));
  const hostTotals = new Map(hostRows.map(row => [row.value, Number(row.total ?? 0)]));
  return entries.map(entry => {
    const sameName = Math.max(0, (nameTotals.get(entry.displayName) ?? 0) - 1);
    const fromRegistry = registryCounts.get(entry);
    if (fromRegistry) return { ...fromRegistry, sameName };
    return {
      // Exclude the entry itself: look-alikes are the other members of each group.
      sameWallet: Math.max(0, (entry.registrant ? walletTotals.get(entry.registrant) ?? 0 : 0) - 1),
      sameName,
      sameHost: Math.max(0, (entry.locatorHost ? hostTotals.get(entry.locatorHost) ?? 0 : 0) - 1),
    };
  });
}

type RegistryBackedEntry = { registrant: string | null; locatorHost: string | null; sourceId: string };

/**
 * Wallet and host look-alikes for registry-backed entries (the BNB Chain
 * registry): the OTHER registrations that share the entry's registering wallet
 * or locator host, counted over every registration the chain pass stored for
 * the source, listed or not. A published entry sits in a small group by
 * construction (fewer than the wallet and host thresholds), and the count says
 * how many registrations the listing holds out beside it. Each count is an
 * index-only scan on the registry rows table's composite indexes.
 */
async function registryRelatedCounts(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, entries: RegistryBackedEntry[]) {
  const counts = new Map<object, { sameWallet: number; sameHost: number }>();
  const bySource = new Map<string, RegistryBackedEntry[]>();
  for (const entry of entries) bySource.set(entry.sourceId, [...(bySource.get(entry.sourceId) ?? []), entry]);
  for (const [sourceId, group] of Array.from(bySource.entries())) {
    const wallets = Array.from(new Set(group.map(entry => entry.registrant).filter((value): value is string => value !== null)));
    const hosts = Array.from(new Set(group.map(entry => entry.locatorHost).filter((value): value is string => value !== null)));
    const walletRows = wallets.length > 0
      ? await db
          .select({ value: agentDirectoryRegistryRows.registrant, total: sql<number>`count(*)` })
          .from(agentDirectoryRegistryRows)
          .where(and(eq(agentDirectoryRegistryRows.sourceId, sourceId), inArray(agentDirectoryRegistryRows.registrant, wallets)))
          .groupBy(agentDirectoryRegistryRows.registrant)
      : [];
    const hostRows = hosts.length > 0
      ? await db
          .select({ value: agentDirectoryRegistryRows.locatorHost, total: sql<number>`count(*)` })
          .from(agentDirectoryRegistryRows)
          .where(and(eq(agentDirectoryRegistryRows.sourceId, sourceId), inArray(agentDirectoryRegistryRows.locatorHost, hosts)))
          .groupBy(agentDirectoryRegistryRows.locatorHost)
      : [];
    const walletTotals = new Map(walletRows.map(row => [row.value, Number(row.total ?? 0)]));
    const hostTotals = new Map(hostRows.map(row => [row.value, Number(row.total ?? 0)]));
    for (const entry of group) {
      counts.set(entry, {
        sameWallet: Math.max(0, (entry.registrant ? walletTotals.get(entry.registrant) ?? 0 : 0) - 1),
        sameHost: Math.max(0, (entry.locatorHost ? hostTotals.get(entry.locatorHost) ?? 0 : 0) - 1),
      });
    }
  }
  return counts;
}

/**
 * Source-level visibility condition for queries that read `ingestion_sources`
 * without joining the directory table: only active sources are visible.
 * Source-only queries must use this helper instead of
 * directoryVisibilityCondition, whose hidden-flag reference requires the
 * directory join — an unjoined column is a runtime SQL error on MySQL.
 */
function activeSourceCondition() {
  return eq(ingestionSources.state, "active");
}

/**
 * Operator-suppressed locator domains: a retired or untrusted service whose
 * entire domain — subdomains included — must never surface in the public
 * directory. AgentRank (agentrank.info) is a retired service whose domain no
 * longer resolves; migration 0015 hid the exact host only, which let
 * subdomain-hosted rows (api.agentrank.info) through, so the operator
 * directed a domain-wide rule (2026-10-11) instead of per-row hiding.
 */
export const SUPPRESSED_LOCATOR_DOMAINS: readonly string[] = ["agentrank.info"];

/** True when the host is a suppressed domain or any subdomain of one. */
export function isSuppressedLocatorHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase();
  return SUPPRESSED_LOCATOR_DOMAINS.some(
    domain => normalized === domain || normalized.endsWith(`.${domain}`)
  );
}

/**
 * SQL condition matching a suppressed locator host (or subdomain). Kept in one
 * place so the visibility predicate and any future query that must agree on
 * suppression cannot drift apart. It takes the column of the table it is read
 * for (the directory entries' by default, the registry rows' for the groups read).
 */
export function suppressedLocatorHostSql(column: AnyColumn = agentDirectoryEntries.locatorHost) {
  return sql.join(
    SUPPRESSED_LOCATOR_DOMAINS.flatMap(domain => [
      sql`${column} = ${domain}`,
      sql`${column} LIKE ${`%.${domain}`}`,
    ]),
    sql` OR `
  );
}

/**
 * Excludes the sources of a chain whose switch is off (shared/features.ts, docs/multichain-erc8004-2026-10-20.md): Ethereum, Base
 * and Arc are read from `VITE_FEATURES` as the server runs, like every other switch, and what they hold is not shown, counted or
 * served until the owner turns them on. It names the protocols to leave out, so a database that has not run migration 0046 sees
 * a comparison with a value its list does not have, which matches no row. With every switch on there is nothing to leave out.
 */
function chainSwitchCondition() {
  const off = protocolsOfChainsOff(process.env.VITE_FEATURES) as Array<(typeof ingestionSources.protocol.enumValues)[number]>;
  return off.length > 0 ? notInArray(ingestionSources.protocol, off) : undefined;
}

/**
 * Shared visibility condition for directory reads (the query must join
 * `ingestion_sources` on sourceId): entries are visible only when (1) the
 * source is active, (2) the entry is not hidden, (3) its locator host is
 * not a suppressed domain, (4) a chain pass has not acknowledged the
 * asset closing (assetClosedAt), and (5) its chain's switch is on, for
 * the chains that have one. Inactive sources (paused, review,
 * rejected), operator-hidden entries, suppressed-domain rows (dead locator
 * hosts like agentrank.info and its subdomains), and chain-closed assets
 * (burned Metaplex Core assets whose rows keep their last facts) are
 * excluded. Every directory read uses this predicate so visibility rules
 * cannot drift apart; the suppressed-host clause is defense in depth
 * alongside the hidden flag and the harvest-time suppression, so even a
 * legacy visible row for a suppressed host stays out of every public read.
 */
function directoryVisibilityCondition() {
  return and(
    activeSourceCondition(),
    chainSwitchCondition(),
    eq(agentDirectoryEntries.hidden, false),
    isNull(agentDirectoryEntries.assetClosedAt),
    sql`(${agentDirectoryEntries.locatorHost} IS NULL OR NOT (${suppressedLocatorHostSql()}))`
  );
}

/**
 * Sanitizes directory entry fields for public presentation. Display names are
 * cleaned of control characters and invisible formatting; other locator-class
 * fields pass through unchanged (they're host/key strings, not prose).
 */
export function sanitizeDirectoryEntry<T extends { displayName: string }>(entry: T): T {
  const note = (entry as { sourceSignalNote?: string | null }).sourceSignalNote;
  return {
    ...entry,
    displayName: sanitizePublicText(entry.displayName, 255) ?? entry.displayName,
    // A BNB note stored before 2026-10-17 says "Nooscape did not fetch it"; it is served as the current sentence.
    ...(typeof note === "string" ? { sourceSignalNote: currentBnbSourceNote(note) } : {}),
  };
}

/**
 * Searches run on a small pool of their own, carved out of the same ten
 * connections the app holds (the main pool has eight, this one two). A text
 * search costs 0.5 to 5 seconds of database time, so a burst of them on the
 * shared pool held every connection and queued the page polls behind them; here
 * they queue among themselves, and past the queue limit a search is declined
 * with "busy" instead of waiting, as is one that has waited past
 * SEARCH_ACQUIRE_TIMEOUT_MS (a full queue of 8-second searches would otherwise be
 * a wait of up to 40 seconds). MySQL also stops a search that runs past
 * SEARCH_MAX_EXECUTION_MS rather than letting it hold a connection.
 */
export const SEARCH_POOL_OPTIONS = { connectionLimit: 2, maxIdle: 2, queueLimit: 10, enableKeepAlive: true, keepAliveInitialDelay: 10_000 } as const;
const SEARCH_MAX_EXECUTION_MS = 8_000;
export const SEARCH_ACQUIRE_TIMEOUT_MS = 10_000;

let _searchPool: Pool | null = null;

function getSearchPool() {
  if (!_searchPool && process.env.DATABASE_URL) {
    try {
      const pool = createPool({ uri: process.env.DATABASE_URL, ...SEARCH_POOL_OPTIONS, stream: breakerStream(databaseBreaker) });
      watchPoolConnections(pool);
      guardPool(pool, databaseBreaker, { acquireTimeoutMs: SEARCH_ACQUIRE_TIMEOUT_MS });
      // MySQL 5.7.8 and later take max_execution_time (milliseconds); MariaDB takes max_statement_time (seconds). The one
      // a server lacks is an unknown variable and is ignored.
      pool.on("connection", connection => {
        connection.query(`SET SESSION max_execution_time = ${SEARCH_MAX_EXECUTION_MS}`, () => {});
        connection.query(`SET SESSION max_statement_time = ${SEARCH_MAX_EXECUTION_MS / 1000}`, () => {});
      });
      _searchPool = pool;
    } catch (error) {
      console.warn("[Database] Failed to open the search pool:", error);
      _searchPool = null;
    }
  }
  return _searchPool;
}

/**
 * Runs `fn` on one connection of the search pool, which it holds for all of a
 * search's queries. The queue limit is therefore applied once per search: a
 * search either gets in line or is declined at the start (POOL_ENQUEUELIMIT),
 * and one that has begun is never turned away between its queries.
 */
export async function withSearchConnection<T>(fn: (db: MySql2Database<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const pool = getSearchPool();
  if (!pool) throw new Error("Nooscape live data requires a configured database.");
  const connection = await pool.promise().getConnection();
  try {
    return await fn(drizzle(connection));
  } finally {
    connection.release();
  }
}

/** The most matches a search counts; the page shows "N+" past it. */
const SEARCH_COUNT_CAP = 1000;

/**
 * One condition per index a query can be answered from. They are run as
 * separate queries and merged, because joining a name MATCH and a key MATCH with
 * OR forces a scan of the whole table (2 s against 0.5 s for the common word on
 * the 247k-row test data, and 0.9 s against 2 ms for a rare token).
 * - wallet-shaped queries (0x + hex) are an indexed prefix match on registrant;
 * - queries of 3 or more characters use the two FULLTEXT indexes (displayName and
 *   locatorHost together, externalKey on its own) with word-boundary matching, and
 *   a Solana-address-shaped query also tries the registrant prefix;
 * - 2-character queries are indexed prefixes on displayName and on locatorHost
 *   (below the FULLTEXT minimum token length).
 */
function directorySearchConditions(query: string): SQL[] {
  if (/^0x[0-9a-f]{4,40}$/i.test(query)) {
    // Prefix, not substring: the registrant index answers `0xabc…%` directly.
    return [sql`${agentDirectoryEntries.registrant} LIKE ${`${query.toLowerCase()}%`}`];
  }
  if (query.length >= 3) {
    // Boolean mode with wildcard suffix: 'kudos*' matches 'kudos' anywhere.
    // Escape special FULLTEXT chars and add wildcard suffix to each word.
    const fulltextTerm = query
      .replace(/[+\-><()~*"@]/g, " ")
      .trim()
      .split(/\s+/)
      .map(word => `+${word}*`)
      .join(" ");
    const conditions = [
      sql`MATCH(${agentDirectoryEntries.displayName}, ${agentDirectoryEntries.locatorHost}) AGAINST(${fulltextTerm} IN BOOLEAN MODE)`,
      sql`MATCH(${agentDirectoryEntries.externalKey}) AGAINST(${fulltextTerm} IN BOOLEAN MODE)`,
    ];
    // Solana base58 addresses are 32–44 chars ('0', 'O', 'I', 'l' excluded); a
    // real address is the floor, so short prose words can never trigger the
    // registrant prefix branch. The alphabet cannot produce a `0x…` string, so
    // this never collides with the EVM wallet branch above.
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(query)) conditions.push(sql`${agentDirectoryEntries.registrant} LIKE ${`${query}%`}`);
    return conditions;
  }
  const needle = `${query.replace(/[\\%_]/g, match => `\\${match}`)}%`;
  return [
    sql`${agentDirectoryEntries.displayName} LIKE ${needle} ESCAPE '\\\\'`,
    sql`${agentDirectoryEntries.locatorHost} LIKE ${needle} ESCAPE '\\\\'`,
  ];
}

/**
 * Why a search was declined rather than failed: the search pool's queue was full
 * (mysql2 raises a plain Error with this message and no code), the search waited
 * too long for a connection, or MySQL stopped the query for running too long
 * (3024 on MySQL, 1969 on MariaDB).
 */
export function isSearchOverload(error: unknown): boolean {
  for (let depth = 0, cause: unknown = error; cause && typeof cause === "object" && depth < 4; depth += 1) {
    const { code, errno, message } = cause as { code?: unknown; errno?: unknown; message?: unknown };
    if (message === "Queue limit reached." || code === "POOL_ENQUEUELIMIT" || code === POOL_ACQUIRE_TIMEOUT_CODE || code === "ER_QUERY_TIMEOUT" || errno === 3024 || errno === 1969) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

async function runDirectorySearch(input: { query: string; limit: number; protocols?: readonly string[] }) {
  // The search connection is given back before the look-alike counts, which run on the main pool.
  const { rows, matchedTotal } = await withSearchConnection(db => searchOnConnection(db, input));
  // Fold hints travel with every hit so one operator's registrations can be
  // seen for what they are at a glance, without trusting any of them.
  const related = await agentDirectoryRelatedCounts(rows);
  return {
    entries: rows.map(({ sourceId: _sourceId, ...entry }, index) => sanitizeDirectoryEntry({ ...entry, related: related[index] })),
    matchedTotal,
    matchedTotalCapped: matchedTotal >= SEARCH_COUNT_CAP,
  };
}

async function searchOnConnection(db: MySql2Database<Record<string, unknown>>, input: { query: string; limit: number; protocols?: readonly string[] }) {
  const conditions = directorySearchConditions(input.query);
  const columns = {
    id: agentDirectoryEntries.id,
    displayName: agentDirectoryEntries.displayName,
    locatorHost: agentDirectoryEntries.locatorHost,
    protocol: agentDirectoryEntries.protocol,
    sourceSignalNote: agentDirectoryEntries.sourceSignalNote,
    registrant: agentDirectoryEntries.registrant,
    // Census-exact on-chain feedback counter (8004 pass, migration 0028);
    // null for every other protocol and for rows the pass has not covered.
    feedbackCount: agentDirectoryEntries.feedbackCount,
    firstSeenAt: agentDirectoryEntries.firstSeenAt,
    lastSeenAt: agentDirectoryEntries.lastSeenAt,
    // Internal: scopes the registry look-alike counts; stripped before the response.
    sourceId: agentDirectoryEntries.sourceId,
  };
  // Newest first, then by name; the id settles ties so the same query always returns the same page.
  const newestFirst = [desc(agentDirectoryEntries.lastSeenAt), asc(agentDirectoryEntries.displayName), asc(agentDirectoryEntries.id)] as const;
  // The REST API searches the identity registries only; the page's search has no such limit.
  const protocolFilter = input.protocols && input.protocols.length > 0 ? inArray(agentDirectoryEntries.protocol, input.protocols as Array<(typeof agentDirectoryEntries.$inferSelect)["protocol"]>) : undefined;
  const visibleWhere = (condition: SQL) => and(condition, directoryVisibilityCondition(), protocolFilter);

  const bestRows = (condition: SQL) =>
    db
      .select(columns)
      .from(agentDirectoryEntries)
      .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
      .where(visibleWhere(condition))
      .orderBy(...newestFirst)
      .limit(input.limit);
  type SearchRow = Awaited<ReturnType<typeof bestRows>>[number];

  // The best `limit` rows for each index, one query at a time.
  const perCondition: SearchRow[][] = [];
  const byId = new Map<string, SearchRow>();
  for (const condition of conditions) {
    const rows = await bestRows(condition);
    perCondition.push(rows);
    for (const row of rows) byId.set(row.id, row);
  }

  // With several indexes the best rows of each are merged and MySQL orders them (its collation, not JavaScript's, decides ties).
  let entries: SearchRow[] = perCondition[0] ?? [];
  if (conditions.length > 1 && byId.size > 0) {
    entries = await db
      .select(columns)
      .from(agentDirectoryEntries)
      .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
      .where(and(inArray(agentDirectoryEntries.id, Array.from(byId.keys())), directoryVisibilityCondition(), protocolFilter))
      .orderBy(...newestFirst)
      .limit(input.limit);
  }

  // The count is capped at COUNT_CAP so a common word does not count every match. When no index filled its page, the rows in hand are every match.
  let matchedTotal: number;
  if (perCondition.every(rows => rows.length < input.limit)) {
    matchedTotal = byId.size;
  } else {
    const counted = new Set<string>();
    for (const condition of conditions) {
      const rows = await db
        .select({ id: agentDirectoryEntries.id })
        .from(agentDirectoryEntries)
        .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
        .where(visibleWhere(condition))
        .limit(SEARCH_COUNT_CAP);
      for (const row of rows) counted.add(row.id);
    }
    matchedTotal = Math.min(counted.size, SEARCH_COUNT_CAP);
  }

  return { rows: entries, matchedTotal };
}

/**
 * Newest visible directory entries matching a name, locator host, registry key,
 * or registering wallet (see directorySearchConditions). Entries from inactive
 * sources, hidden entries, and suppressed-domain hosts are excluded. Repeated
 * queries are answered from a short hold that every directory write drops, and
 * a search is declined with `busy` when the search pool's queue is full or
 * MySQL stopped it for running too long.
 */
export async function searchAgentDirectory(input: { query: string; limit: number; protocols?: readonly string[] }) {
  try {
    return await cachedSearchRead(`${input.limit}\u0000${input.query}\u0000${(input.protocols ?? []).join(",")}`, () => runDirectorySearch(input));
  } catch (error) {
    if (!isSearchOverload(error)) throw error;
    const now = Date.now();
    if (now - lastSearchDeclinedLogAt > 10_000) {
      lastSearchDeclinedLogAt = now;
      console.warn("[Search] declining searches: the search pool is busy or a query ran too long");
    }
    return { entries: [], matchedTotal: 0, matchedTotalCapped: false, busy: true as const };
  }
}

let lastSearchDeclinedLogAt = 0;

/** Bound on chain-activity events returned for one entry page; the append-only ledger keeps every event. */
export const MAX_AGENT_ENTRY_ACTIVITY_EVENTS = 24;

/** Bound on reputation-ledger rows returned for one entry page (census average ≈ 2/agent; the ledger keeps every event). */
const MAX_AGENT_ENTRY_RATING_EVENTS = 200;

/**
 * Chain-activity rollups plus the bounded event list for one entry page. Null
 * while migration 0013 is pending; once applied, an entry the activity walk
 * has not covered yet carries null counts — "not measured yet", never zero.
 */
type AgentDirectoryEntryActivity = {
  mintBlock: number | null;
  secondaryTransferCount: number | null;
  handoutCount: number | null;
  uriUpdateCount: number | null;
  events: Array<{
    kind: "mint" | "secondary" | "uri_update";
    blockNumber: number;
    transactionHash: string;
    logIndex: number;
    fromAddress: string | null;
    toAddress: string | null;
    /** True when this secondary Transfer is a platform hand-out (from the minting wallet, inside the mint-hour window). */
    isHandout?: boolean;
  }>;
};

/**
 * Twin linkage surfaced on an entry page (migration 0028): a chain-metadata
 * link from this entry to another directory entry whose external key matched
 * the link's linked key exactly once across all sources when the pass wrote
 * it. Unmatched or ambiguous links never resolve, so the field stays null
 * rather than pointing at a guess.
 */
type AgentDirectoryEntryTwin = {
  entryId: string;
  displayName: string;
  protocol: (typeof agentDirectoryEntries.$inferSelect)["protocol"];
  linkedProtocol: (typeof agentDirectoryChainLinks.$inferSelect)["linkedProtocol"];
  metadataKey: string;
  linkedExternalKey: string;
};

/**
 * The visible directory entries of the given registries that carry a registry key (`eip155:4663:<registry>:<token>` or a Solana
 * address). The same visibility rule as every public read: nothing hidden, closed, on a suppressed host or from an inactive source.
 * At most three come back, which is more than one only when the same Solana address is listed by more than one registry.
 */
export async function findVisibleDirectoryEntriesByKey(protocols: readonly string[], externalKey: string) {
  const db = requireDb(await getDb());
  return db
    .select({ id: agentDirectoryEntries.id, protocol: agentDirectoryEntries.protocol, externalKey: agentDirectoryEntries.externalKey })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(eq(agentDirectoryEntries.externalKey, externalKey), inArray(agentDirectoryEntries.protocol, protocols as Array<(typeof agentDirectoryEntries.$inferSelect)["protocol"]>), directoryVisibilityCondition()))
    .limit(3);
}

/** The registry keys of visible directory entries by id, for entries a search has already returned (so at most a page of ids). */
export async function listVisibleDirectoryKeys(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const db = requireDb(await getDb());
  const rows = await db
    .select({ id: agentDirectoryEntries.id, externalKey: agentDirectoryEntries.externalKey })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(inArray(agentDirectoryEntries.id, ids as string[]), directoryVisibilityCondition()));
  return new Map(rows.map(row => [row.id, row.externalKey]));
}

/**
 * One acknowledged directory entry by id, or null when the id is unknown or
 * the source is inactive. Entries from inactive sources are hidden.
 */
export async function getAgentDirectoryEntry(id: string) {
  const db = requireDb(await getDb());
  const [selected] = await db
    .select({
      id: agentDirectoryEntries.id,
      displayName: agentDirectoryEntries.displayName,
      locatorHost: agentDirectoryEntries.locatorHost,
      protocol: agentDirectoryEntries.protocol,
      sourceSignalNote: agentDirectoryEntries.sourceSignalNote,
      registrant: agentDirectoryEntries.registrant,
      // Census-exact on-chain feedback counter (8004 pass, migration 0028);
      // null for every other protocol and for rows the pass has not covered.
      feedbackCount: agentDirectoryEntries.feedbackCount,
      firstSeenAt: agentDirectoryEntries.firstSeenAt,
      lastSeenAt: agentDirectoryEntries.lastSeenAt,
      // Internal: scopes the registry look-alike counts and finds a BNB entry's registration read; stripped before the response.
      sourceId: agentDirectoryEntries.sourceId,
      externalKey: agentDirectoryEntries.externalKey,
      profileUriHash: agentDirectoryEntries.profileUriHash,
    })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(eq(agentDirectoryEntries.id, id), directoryVisibilityCondition()))
    .limit(1);
  if (!selected) return null;
  const { sourceId: _sourceId, externalKey: _externalKey, profileUriHash: _profileUriHash, ...row } = selected;
  const [related] = await agentDirectoryRelatedCounts([selected]);
  // Chain-activity facts arrive through gated migration 0013 and the activity
  // walk; while either is pending the section stays explicitly unmeasured
  // (null) instead of failing the whole entry read.
  let activity: AgentDirectoryEntryActivity | null = null;
  try {
    const [anchorRow] = await db
      .select({
        sourceId: agentDirectoryEntries.sourceId,
        externalKey: agentDirectoryEntries.externalKey,
        protocol: agentDirectoryEntries.protocol,
        mintBlock: agentDirectoryEntries.mintBlock,
        secondaryTransferCount: agentDirectoryEntries.secondaryTransferCount,
        handoutCount: agentDirectoryEntries.handoutCount,
        uriUpdateCount: agentDirectoryEntries.uriUpdateCount,
      })
      .from(agentDirectoryEntries)
      .where(eq(agentDirectoryEntries.id, id))
      .limit(1);
    // Chain activity exists only for EVM ERC-8004 identity entries; every other
    // protocol has no chain identity to measure, so the field stays null for
    // them exactly like the registering wallet does. The hand-out rule reads the
    // entry's own chain's mint hour (a block count differs by chain cadence).
    const evmChain = anchorRow ? evmIdentityChain(anchorRow.protocol) : null;
    if (anchorRow && evmChain) {
      const events = await db
        .select({
          kind: agentDirectoryChainActivity.kind,
          blockNumber: agentDirectoryChainActivity.blockNumber,
          transactionHash: agentDirectoryChainActivity.transactionHash,
          logIndex: agentDirectoryChainActivity.logIndex,
          fromAddress: agentDirectoryChainActivity.fromAddress,
          toAddress: agentDirectoryChainActivity.toAddress,
        })
        .from(agentDirectoryChainActivity)
        .where(
          and(
            eq(agentDirectoryChainActivity.sourceId, anchorRow.sourceId),
            eq(agentDirectoryChainActivity.externalKey, anchorRow.externalKey)
          )
        )
        .orderBy(asc(agentDirectoryChainActivity.blockNumber), asc(agentDirectoryChainActivity.logIndex))
        .limit(MAX_AGENT_ENTRY_ACTIVITY_EVENTS);
      // Classify hand-outs per event with the same rule as the rollup: a
      // secondary Transfer from the minting wallet inside the mint-hour
      // window. Events are ordered oldest-first, so the mint (when the ledger
      // holds it) is always within the bounded list to anchor the rule.
      const mintEvent = events.find(event => event.kind === "mint");
      const mintBlock = mintEvent?.blockNumber ?? null;
      const mintTo = mintEvent?.toAddress ?? null;
      activity = {
        mintBlock: anchorRow.mintBlock,
        secondaryTransferCount: anchorRow.secondaryTransferCount,
        handoutCount: anchorRow.handoutCount,
        uriUpdateCount: anchorRow.uriUpdateCount,
        events: events.map(event => ({
          ...event,
          isHandout:
            event.kind === "secondary" &&
            mintBlock !== null &&
            mintTo !== null &&
            event.fromAddress !== null &&
            event.fromAddress === mintTo &&
            event.blockNumber <= mintBlock + evmChain.handoutBlockWindow,
        })),
      };
    }
  } catch {
    // Migration 0013 is still pending on this database.
  }
  // Twin linkage arrives through gated migration 0028 and the metadata pass;
  // while either is pending this read fails fast and the section stays
  // explicitly unlinked (null) instead of failing the whole entry read — the
  // same posture as the activity section above.
  let twin: AgentDirectoryEntryTwin | null = null;
  try {
    const [anchor] = await db
      .select({
        sourceId: agentDirectoryEntries.sourceId,
        externalKey: agentDirectoryEntries.externalKey,
      })
      .from(agentDirectoryEntries)
      .where(eq(agentDirectoryEntries.id, id))
      .limit(1);
    if (anchor) {
      // First-discovered wins: one twin per entry in v1; upsert-only writes
      // mean a link, once present, never disappears under it.
      const [link] = await db
        .select({
          linkedProtocol: agentDirectoryChainLinks.linkedProtocol,
          metadataKey: agentDirectoryChainLinks.metadataKey,
          linkedExternalKey: agentDirectoryChainLinks.linkedExternalKey,
          linkedEntryId: agentDirectoryChainLinks.linkedEntryId,
        })
        .from(agentDirectoryChainLinks)
        .where(
          and(
            eq(agentDirectoryChainLinks.sourceId, anchor.sourceId),
            eq(agentDirectoryChainLinks.externalKey, anchor.externalKey),
            isNotNull(agentDirectoryChainLinks.linkedEntryId)
          )
        )
        .orderBy(asc(agentDirectoryChainLinks.discoveredAt))
        .limit(1);
      if (link?.linkedEntryId) {
        const [twinRow] = await db
          .select({
            id: agentDirectoryEntries.id,
            displayName: agentDirectoryEntries.displayName,
            protocol: agentDirectoryEntries.protocol,
          })
          .from(agentDirectoryEntries)
          .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
          .where(and(eq(agentDirectoryEntries.id, link.linkedEntryId), directoryVisibilityCondition()))
          .limit(1);
        if (twinRow) {
          twin = {
            entryId: twinRow.id,
            displayName: twinRow.displayName,
            protocol: twinRow.protocol,
            linkedProtocol: link.linkedProtocol,
            metadataKey: link.metadataKey,
            linkedExternalKey: link.linkedExternalKey,
          };
        }
      }
    }
  } catch {
    // Migration 0028 is still pending on this database.
  }
  // Registry ratings read the reputation ledger directly (no migration to
  // await); while the source row, ledger, or key join is unreadable the
  // section stays explicitly unmeasured (null) instead of failing the whole
  // entry read — the same posture as the sections above.
  let ratings: AgentDirectoryEntryRatings | null = null;
  try {
    if (row.protocol === "erc8004") {
      const [anchor] = await db
        .select({ externalKey: agentDirectoryEntries.externalKey })
        .from(agentDirectoryEntries)
        .where(eq(agentDirectoryEntries.id, id))
        .limit(1);
      const agentId = anchor ? parseReputationExternalKey(anchor.externalKey) : null;
      // One active reputation source per the ingestion design; a missing or
      // inactive source means the ledger has no public home yet — ratings
      // stays null rather than guessing a source.
      const [source] = await db
        .select({ id: ingestionSources.id })
        .from(ingestionSources)
        .where(and(eq(ingestionSources.protocol, "erc8004_reputation"), eq(ingestionSources.state, "active")))
        .limit(1);
      if (source && agentId !== null) {
        const events = await db
          .select({
            kind: agentReputationEvents.kind,
            blockNumber: agentReputationEvents.blockNumber,
            transactionHash: agentReputationEvents.transactionHash,
            logIndex: agentReputationEvents.logIndex,
            clientAddress: agentReputationEvents.clientAddress,
            feedbackIndex: agentReputationEvents.feedbackIndex,
            valueRaw: agentReputationEvents.valueRaw,
            valueDecimals: agentReputationEvents.valueDecimals,
            tag1: agentReputationEvents.tag1,
            tag2: agentReputationEvents.tag2,
          })
          .from(agentReputationEvents)
          .where(and(eq(agentReputationEvents.sourceId, source.id), eq(agentReputationEvents.agentId, agentId)))
          .orderBy(asc(agentReputationEvents.blockNumber), asc(agentReputationEvents.logIndex))
          .limit(MAX_AGENT_ENTRY_RATING_EVENTS);
        ratings = computeRatingsSummary(events, await readAgentDirectoryReputationHighWater(source.id));
      }
    }
  } catch {
    // Reputation ledger unreadable on this database.
  }
  // A BNB entry's registration read (docs/approvals/2026-10-18-bnb-checked-unproven.md): "checked" when its evidence row records a
  // read of the link it carries now, with the date of the read, and "not checked" for every other listed BNB entry, so the line
  // never works as a badge by omission. An entry of another protocol has no such field. With the evidence table missing
  // (migration 0038 not run) nothing has been read, so it is not checked; any other failure leaves the field null and the page
  // says nothing, rather than claim a read that did not happen or a gap that did.
  let registrationRead: BscRegistrationRead | null = null;
  if (row.protocol === "erc8004_bsc") {
    try {
      const [evidence] = await db
        .select({ readStatus: bscEntryEvidence.readStatus, readAt: bscEntryEvidence.readAt, profileUriHash: bscEntryEvidence.profileUriHash })
        .from(bscEntryEvidence)
        .where(and(eq(bscEntryEvidence.sourceId, selected.sourceId), eq(bscEntryEvidence.externalKey, selected.externalKey)))
        .limit(1);
      registrationRead = registrationReadOf(evidence, selected.profileUriHash);
    } catch (error) {
      registrationRead = isMissingTableError(error) ? BSC_NOT_CHECKED : null;
    }
  }
  return sanitizeDirectoryEntry({ ...row, related, activity, twin, ratings, ...(row.protocol === "erc8004_bsc" ? { registrationRead } : {}) });
}

/** True when the driver says a table is not there: its migration has not been run on this database. */
function isMissingTableError(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; cause instanceof Error && depth < 4; depth += 1) {
    if ("code" in cause && cause.code === "ER_NO_SUCH_TABLE") return true;
    cause = cause.cause;
  }
  return false;
}

/** Operator withdrawal notices carry reasons and never enter public surfaces. */
const WITHDRAWAL_EVENT_TYPES = ["RECORD_WITHDRAWN", "RECORD_REINSTATED"] as const;

/**
 * Public per-agent evidence timeline: the append-only governance events
 * (observations, domain checks, publisher-key changes), newest first.
 * Event types and descriptions are authored by Nooscape's own ingestion
 * and governance code, never by the agent. The query runs through the same
 * reviewed-run gate as evidence envelopes — only events whose observation
 * belongs to the currently approved run of an active, publicly projected
 * source are pulled — and operator withdrawal notices are excluded, so a
 * withdraw-and-reinstate cycle never publishes the operator's reason text
 * on the profile page and unapproved-run events never reach the timeline.
 * Observations are content-deduplicated and re-linked into each new run,
 * so a stable agent's timeline does not shrink when its run advances.
 */
export async function listAgentEvidenceTimeline(agentId: string, limit = 30) {
  const db = requireDb(await getDb());
  return db
    .select({
      eventType: evidenceEvents.eventType,
      description: evidenceEvents.description,
      observedAt: evidenceEvents.observedAt,
    })
    .from(evidenceEvents)
    .innerJoin(sourceObservations, eq(evidenceEvents.sourceObservationId, sourceObservations.id))
    .innerJoin(ingestionSources, and(eq(sourceObservations.sourceId, ingestionSources.id), eq(ingestionSources.state, "active")))
    .innerJoin(
      sourceProjectionDecisions,
      and(
        eq(sourceProjectionDecisions.sourceId, sourceObservations.sourceId),
        eq(sourceProjectionDecisions.state, "public"),
        isNotNull(sourceProjectionDecisions.approvedRunId)
      )
    )
    .innerJoin(
      sourceObservationRuns,
      and(
        eq(sourceObservationRuns.runId, sourceProjectionDecisions.approvedRunId),
        eq(sourceObservationRuns.observationId, evidenceEvents.sourceObservationId)
      )
    )
    .where(and(eq(evidenceEvents.agentId, agentId), notInArray(evidenceEvents.eventType, [...WITHDRAWAL_EVENT_TYPES])))
    .orderBy(desc(evidenceEvents.observedAt), asc(evidenceEvents.id))
    .limit(limit);
}

/** Total acknowledged agents in the master directory from active sources. */
export function countAgentDirectoryEntries() {
  return cachedDirectoryRead("directory:count", () => countAgentDirectoryEntriesUncached());
}

/** The uncached scan behind {@link countAgentDirectoryEntries}; only the cache wrapper calls it. */
async function countAgentDirectoryEntriesUncached() {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(directoryVisibilityCondition());
  return Number(row?.total ?? 0);
}

/** Acknowledged counts per protocol in the master directory from active sources, largest first. */
export function breakdownAgentDirectoryByProtocol() {
  return cachedDirectoryRead("directory:breakdown", () => breakdownAgentDirectoryByProtocolUncached());
}

/** The uncached scan behind {@link breakdownAgentDirectoryByProtocol}; only the cache wrapper calls it. */
async function breakdownAgentDirectoryByProtocolUncached() {
  const db = requireDb(await getDb());
  const rows = await db
    .select({ protocol: agentDirectoryEntries.protocol, count: sql<number>`count(*)` })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(directoryVisibilityCondition())
    .groupBy(agentDirectoryEntries.protocol);
  return rows
    .map(row => ({ protocol: row.protocol, count: Number(row.count ?? 0) }))
    .sort((left, right) => right.count - left.count);
}

/**
 * Ratings recorded on-chain against the visible Robinhood identities: the
 * reputation ledger's NewFeedback events (revoked ones included, since a
 * revocation is its own event), joined to the identity entries the directory
 * shows, so a hidden, closed or inactive-source entry's ratings never count.
 * Null when the reputation source or the identity source is not active, so
 * "not read" is never shown as zero.
 */
export function countRobinhoodFeedbackEvents() {
  return cachedDirectoryRead("directory:robinhood-feedback", () => countRobinhoodFeedbackEventsUncached());
}

/** The uncached scan behind {@link countRobinhoodFeedbackEvents}; only the cache wrapper calls it. */
async function countRobinhoodFeedbackEventsUncached(): Promise<number | null> {
  const db = requireDb(await getDb());
  const [reputation] = await db
    .select({ id: ingestionSources.id })
    .from(ingestionSources)
    .where(and(eq(ingestionSources.protocol, "erc8004_reputation"), eq(ingestionSources.state, "active")))
    .limit(1);
  if (!reputation) return null;
  const identities = await db
    .select({ id: ingestionSources.id })
    .from(ingestionSources)
    .where(and(eq(ingestionSources.protocol, "erc8004"), eq(ingestionSources.state, "active")));
  if (identities.length === 0) return null;
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(agentReputationEvents)
    .innerJoin(
      agentDirectoryEntries,
      and(
        // The source ids let the join use the (sourceId, externalKey) unique index, one lookup per event; without them it scans the table.
        inArray(agentDirectoryEntries.sourceId, identities.map(source => source.id)),
        sql`${agentDirectoryEntries.externalKey} = CONCAT(${REPUTATION_KEY_PREFIX}, ${agentReputationEvents.agentId})`
      )
    )
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(eq(agentReputationEvents.sourceId, reputation.id), eq(agentReputationEvents.kind, "new_feedback"), eq(agentDirectoryEntries.protocol, "erc8004"), directoryVisibilityCondition()));
  return Number(row?.count ?? 0);
}

/**
 * Ratings recorded on Solana: the sum of the feedback counters of the visible 8004 accounts, each the registry's own count
 * of the feedback records against that agent. Only the 8004 registry keeps ratings; the SAID and Metaplex registries have
 * none that Nooscape reads. Null when there is no active 8004 source or no account's counter has been read yet, so
 * "not read" is never shown as zero.
 */
export function countSolana8004Feedback() {
  return cachedDirectoryRead("directory:solana-8004-feedback", () => countSolana8004FeedbackUncached());
}

/** The uncached scan behind {@link countSolana8004Feedback}; only the cache wrapper calls it. */
async function countSolana8004FeedbackUncached(): Promise<number | null> {
  const db = requireDb(await getDb());
  const sources = await db
    .select({ id: ingestionSources.id })
    .from(ingestionSources)
    .where(and(eq(ingestionSources.protocol, "solana_8004"), eq(ingestionSources.state, "active")));
  if (sources.length === 0) return null;
  const [row] = await db
    .select({ total: sql<string | null>`sum(${agentDirectoryEntries.feedbackCount})`, read: sql<number>`count(${agentDirectoryEntries.feedbackCount})` })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    // The source ids let the scan use the (sourceId, externalKey) unique index instead of reading the whole table.
    .where(and(inArray(agentDirectoryEntries.sourceId, sources.map(source => source.id)), eq(agentDirectoryEntries.protocol, "solana_8004"), directoryVisibilityCondition()));
  if (!row || Number(row.read ?? 0) === 0) return null;
  return Number(row.total ?? 0);
}

/**
 * The per-chain figures behind the Home chain tabs. Every number comes from a
 * read that already applies the public rules: the directory breakdown (visible
 * entries only), the reviewed records (the reviewed-run gate and withdrawals,
 * read live, never cached) and the visible-entry join above. A chain with no
 * active source is reported as not indexed rather than as zero.
 */
export async function readChainStats(): Promise<ChainStat[]> {
  return buildChainStats(await readChainStatsInput());
}

/**
 * The chain tabs while an extra chain is on: the three rows {@link readChainStats} gives, unchanged, and a row for each extra chain
 * given, with the registry counts the caller read for it. One read of the directory serves both.
 */
export async function readChainStatsWithExtras(
  extras: readonly ExtraChainKey[],
  profiles: Partial<Record<ExtraChainKey, RegistryProfile | null>>,
): Promise<{ chains: ChainStat[]; extras: ExtraChainStat[] }> {
  const input = await readChainStatsInput();
  return { chains: buildChainStats(input), extras: buildExtraChainStats(input, extras, profiles) };
}

/**
 * The ratings counted in the extra chains' reputation registries, by chain key: the NewFeedback events the ratings step has counted
 * (server/chainRatings.ts). Only a chain whose read has reached the finalized head is here, because before that the count is a part of
 * the history; a chain that is not here is "not measured". Cached like the other aggregates and dropped by the step when it counts.
 */
export function readChainRatings(): Promise<Record<string, number>> {
  return cachedDirectoryRead("directory:chain-ratings", async () => {
    const db = requireDb(await getDb());
    const rows = await db
      .select({ chainKey: chainReputationCounts.chainKey, ratings: chainReputationCounts.ratings })
      .from(chainReputationCounts)
      .where(isNotNull(chainReputationCounts.caughtUpAt));
    return Object.fromEntries(rows.map(row => [row.chainKey, Number(row.ratings)]));
  });
}

async function readChainStatsInput(): Promise<ChainStatsInput> {
  const [byProtocol, records, robinhoodFeedback, solanaFeedback, chainFeedback, sources] = await Promise.all([
    breakdownAgentDirectoryByProtocol(),
    listLiveAtlasRecords(),
    // An unreadable ratings count leaves that one figure unmeasured; it does not fail the chain tabs.
    countRobinhoodFeedbackEvents().catch(() => null),
    countSolana8004Feedback().catch(() => null),
    // The same for a chain's own count, and with its table not there yet.
    readChainRatings().catch(() => ({}) as Record<string, number>),
    listPublicIngestionSourceStatuses(),
  ]);
  return { byProtocol, reviewedProtocols: records.map(record => parseProtocolList(record.protocols)), robinhoodFeedback, solanaFeedback, chainFeedback, sources };
}

/**
 * What entered the directory in the last day, per chain, for the Home page: how many visible entries each chain
 * gained and the newest few by name. It reads each entry's own first-seen time under the same visibility rule as every
 * other public count, so a hidden, closed or paused-source entry is never in it, and a chain with no active source is
 * reported as not indexed rather than as zero. The first-seen time is when the Owl first saw the entry.
 */
export function readDirectoryArrivals(): Promise<Arrivals> {
  return cachedDirectoryRead("directory:arrivals", () => readDirectoryArrivalsUncached());
}

async function readDirectoryArrivalsUncached(): Promise<Arrivals> {
  const db = requireDb(await getDb());
  const now = new Date();
  const since = new Date(now.getTime() - ARRIVALS_WINDOW_HOURS * 3_600_000);
  const sources = await listPublicIngestionSourceStatuses();
  type DirectoryProtocol = (typeof agentDirectoryEntries.protocol.enumValues)[number];
  const protocolsOnChain = (chain: (typeof CHAINS)[number]) => protocolsOf(chain) as DirectoryProtocol[];
  // The extra chains whose switch is on are read too, after the original three. Nothing of one that is off is read.
  const extras = extraChainsOn(process.env.VITE_FEATURES);
  const protocols = [...CHAINS.flatMap(protocolsOnChain), ...extras.map(chain => extraProtocolOf(chain) as DirectoryProtocol)];
  // One pass over the entries inside the window: each protocol's count and its newest few, by window functions. The first
  // version made four passes (one count and one list for each chain), which took 11 to 15 seconds on the host when the cache
  // was cold. With the index on `firstSeenAt` (migration 0041) the window is found without reading the whole table.
  const ranked = db
    .select({
      id: agentDirectoryEntries.id,
      displayName: agentDirectoryEntries.displayName,
      protocol: agentDirectoryEntries.protocol,
      firstSeenAt: agentDirectoryEntries.firstSeenAt,
      total: sql<number>`count(*) over (partition by ${agentDirectoryEntries.protocol})`.as("total"),
      place: sql<number>`row_number() over (partition by ${agentDirectoryEntries.protocol} order by ${agentDirectoryEntries.firstSeenAt} desc, ${agentDirectoryEntries.id} desc)`.as("place"),
    })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(directoryVisibilityCondition(), inArray(agentDirectoryEntries.protocol, protocols), gte(agentDirectoryEntries.firstSeenAt, since)))
    .as("ranked");
  const rows = await db.select().from(ranked).where(lte(ranked.place, ARRIVALS_NEWEST_PER_CHAIN));
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.protocol, Number(row.total ?? 0));
  // A chain with several protocols (Solana has three) gets the newest of all of them: each protocol's best few, merged.
  const newest = [...CHAINS, ...extras].flatMap(chain =>
    rows
      .filter(row => listedChainOf(row.protocol) === chain)
      .sort((left, right) => right.firstSeenAt.getTime() - left.firstSeenAt.getTime() || (left.id < right.id ? 1 : -1))
      .slice(0, ARRIVALS_NEWEST_PER_CHAIN)
      .map(row => ({ chain, id: row.id, displayName: sanitizeDirectoryEntry({ displayName: row.displayName }).displayName, firstSeenAt: row.firstSeenAt })),
  );
  return buildArrivals({
    now,
    counts: Array.from(counts, ([protocol, count]) => ({ protocol, count })),
    newest,
    activeProtocols: sources.filter(source => source.state === "active").map(source => source.protocol),
    extras,
  });
}

/**
 * The sample behind the Home hero (the Noosphere): the registered agents as lights. Every on-chain
 * registration the public may see is a candidate, every reviewed record is drawn, and the rest is a
 * sample chosen by the CRC32 of the entry id, so it is the same registrations on every read until the
 * data changes. It reads nothing but what the public reads already, through the same visibility rule,
 * and the lights it returns carry no name, no score and no rank (see shared/noosphere.ts).
 */
export function readNoosphereSample(): Promise<NoosphereSample> {
  return cachedDirectoryRead("directory:noosphere-sample", () => readNoosphereSampleUncached());
}

async function readNoosphereSampleUncached(): Promise<NoosphereSample> {
  const [byProtocol, wallets, records] = await Promise.all([
    breakdownAgentDirectoryByProtocol(),
    // The same key the Home wallet cards read, so this adds no scan.
    listAgentDirectoryWallets(MAX_FLEETS),
    listLiveAtlasRecords(),
  ]);
  const onChain = new Set<string>(NOOSPHERE_PROTOCOLS);
  const total = byProtocol.filter(row => onChain.has(row.protocol)).reduce((sum, row) => sum + Number(row.count), 0);
  const modulus = sampleModulus(total);
  const db = requireDb(await getDb());
  const hash = sql<number>`crc32(${agentDirectoryEntries.id})`;
  const rows = await db
    .select({ hash, protocol: agentDirectoryEntries.protocol, registrant: agentDirectoryEntries.registrant })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(inArray(agentDirectoryEntries.protocol, [...NOOSPHERE_PROTOCOLS]), directoryVisibilityCondition(), sql`mod(crc32(${agentDirectoryEntries.id}), ${modulus}) = 0`))
    .orderBy(hash)
    .limit(MAX_LIGHTS + 200);
  return buildNoosphereSample({
    now: new Date(),
    total,
    rows: rows.map(row => ({ hash: Number(row.hash), protocol: row.protocol, registrant: row.registrant })),
    reviewed: records.map(record => ({ agentId: record.agentId, protocols: record.protocols })),
    wallets,
  });
}

/**
 * Public wallet-concentration census over ERC-8004 acknowledgements from
 * active sources: the registering wallets behind the most acknowledged
 * registrations, largest count first. A wallet here paid the on-chain
 * registration transactions — it is not a verified operator, and the count
 * is never a rating.
 */
export function listAgentDirectoryWallets(limit: number) {
  return cachedDirectoryRead(`directory:wallets:${limit}`, () => listAgentDirectoryWalletsUncached(limit));
}

/** The uncached scan behind {@link listAgentDirectoryWallets}; only the cache wrapper calls it. */
async function listAgentDirectoryWalletsUncached(limit: number) {
  const db = requireDb(await getDb());
  const rows = await db
    .select({ registrant: agentDirectoryEntries.registrant, agentCount: sql<number>`count(*)` })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(isNotNull(agentDirectoryEntries.registrant), directoryVisibilityCondition()))
    .groupBy(agentDirectoryEntries.registrant)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  if (rows.length === 0) return [];
  // Dominant locator host per wallet — where most of that wallet's
  // registrations were seen. A narration hint ("mostly example.com"), never
  // an identity claim: a shared host says nothing about who runs the agents.
  const hostRows = await db
    .select({
      registrant: agentDirectoryEntries.registrant,
      locatorHost: agentDirectoryEntries.locatorHost,
      total: sql<number>`count(*)`,
    })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(
      inArray(agentDirectoryEntries.registrant, rows.map(row => row.registrant).filter((value): value is string => value !== null)),
      directoryVisibilityCondition()
    ))
    .groupBy(agentDirectoryEntries.registrant, agentDirectoryEntries.locatorHost)
    .orderBy(desc(sql`count(*)`));
  const dominantHosts = new Map<string, string>();
  for (const hostRow of hostRows) {
    if (hostRow.registrant !== null && hostRow.locatorHost !== null && !dominantHosts.has(hostRow.registrant)) {
      dominantHosts.set(hostRow.registrant, hostRow.locatorHost);
    }
  }
  return rows.map(row => ({
    registrant: row.registrant!,
    agentCount: Number(row.agentCount ?? 0),
    dominantHost: dominantHosts.get(row.registrant!) ?? null,
  }));
}

/**
 * The owner wallets behind the Solana lights on the home map (docs/solana-lights-2026-10-18.md): for each of the given
 * protocols, every wallet the directory records as `registrant` for at least `minimum` entries, with how many, largest first.
 * The same visibility rule as every public directory read. It returns a wallet and a count and nothing about any one entry,
 * and the wallet is the owner the registry records today, which is not necessarily the one that registered the entry.
 */
export async function listSolanaOwnerHoldings(protocols: ReadonlyArray<"solana_8004" | "solana_registry">, minimum: number) {
  const db = requireDb(await getDb());
  const holdings = sql<number>`count(*)`;
  const rows = await db
    .select({ protocol: agentDirectoryEntries.protocol, registrant: agentDirectoryEntries.registrant, holdings })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(inArray(agentDirectoryEntries.protocol, [...protocols]), isNotNull(agentDirectoryEntries.registrant), directoryVisibilityCondition()))
    .groupBy(agentDirectoryEntries.protocol, agentDirectoryEntries.registrant)
    .having(sql`count(*) >= ${minimum}`)
    .orderBy(desc(holdings), asc(agentDirectoryEntries.protocol), asc(agentDirectoryEntries.registrant));
  return rows.map(row => ({ protocol: row.protocol as string, registrant: row.registrant!, holdings: Number(row.holdings) }));
}

/**
 * The registering wallets behind the Robinhood Chain lights on the home map (docs/robinhood-lights-2026-10-19.md): every wallet
 * the directory records as `registrant` for at least `minimum` Robinhood Chain ERC-8004 entries, with how many, largest first.
 * The same visibility rule as every public directory read. It returns a wallet and a count and nothing about any one entry, and
 * the wallet is the address that registered the identities, which is not necessarily the one that holds them now.
 */
export async function listRobinhoodRegistrantHoldings(minimum: number) {
  const db = requireDb(await getDb());
  const holdings = sql<number>`count(*)`;
  const rows = await db
    .select({ registrant: agentDirectoryEntries.registrant, holdings })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(eq(agentDirectoryEntries.protocol, "erc8004"), isNotNull(agentDirectoryEntries.registrant), directoryVisibilityCondition()))
    .groupBy(agentDirectoryEntries.registrant)
    .having(sql`count(*) >= ${minimum}`)
    .orderBy(desc(holdings), asc(agentDirectoryEntries.registrant));
  return rows.map(row => ({ registrant: row.registrant!, holdings: Number(row.holdings) }));
}

/** How many Robinhood Chain entries the directory lists, under the same visibility rule as every public directory read and as the wallets above. */
export async function countRobinhoodListed(): Promise<number> {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(eq(agentDirectoryEntries.protocol, "erc8004"), directoryVisibilityCondition()));
  return Number(row?.total ?? 0);
}

/** How many of a chain's listed registrations the home map shows beside the reviewed records. */
export const MAP_ACKNOWLEDGED_LIMIT = 30;

/**
 * A fixed sample of the registrations the directory lists for one chain's protocol, for the home map, with how many it
 * lists in all. The sample is the entries whose id hashes lowest: the same set on every read until the listing itself
 * changes, picked by a rule that looks at nothing about an agent but its id. Visibility is the directory's own, as in
 * every public directory read: nothing hidden, closed, on a suppressed host or from an inactive source. These are
 * acknowledged entries and never reviewed records; the map draws them as such (docs/approvals/2026-10-15-informational-use-and-bnb-map.md).
 */
export function listMapAcknowledgedSample(protocol: "erc8004_bsc" | "erc8004_arc", limit: number = MAP_ACKNOWLEDGED_LIMIT) {
  return cachedDirectoryRead(`directory:map-acknowledged:${protocol}:${limit}`, async () => {
    const db = requireDb(await getDb());
    const visible = and(eq(ingestionSources.protocol, protocol), directoryVisibilityCondition());
    const [rows, counted] = await Promise.all([
      db
        .select({ id: agentDirectoryEntries.id, displayName: agentDirectoryEntries.displayName, locatorHost: agentDirectoryEntries.locatorHost })
        .from(agentDirectoryEntries)
        .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
        .where(visible)
        .orderBy(asc(sql`sha2(${agentDirectoryEntries.id}, 256)`))
        .limit(limit),
      db
        .select({ listed: sql<number>`count(*)` })
        .from(agentDirectoryEntries)
        .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
        .where(visible),
    ]);
    return {
      entries: rows.map(row => sanitizeDirectoryEntry({ id: row.id, displayName: row.displayName, locatorHost: row.locatorHost, protocol })),
      listed: Number(counted[0]?.listed ?? 0),
    };
  });
}

/**
 * The ids of a registering wallet's visible directory entries, in a fixed order (first seen, then id), for the
 * Owl's Catch to store with a fleet. The same visibility rule as every public directory read: nothing hidden,
 * closed, on a suppressed host or from an inactive source. Uncached on purpose: it runs once a day, in the
 * worker, for one wallet, and must see what is visible at the moment the day's catch is chosen.
 */
export async function listVisibleDirectoryEntryIdsForRegistrant(registrant: string, limit: number): Promise<string[]> {
  const db = requireDb(await getDb());
  const rows = await db
    .select({ id: agentDirectoryEntries.id })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(eq(agentDirectoryEntries.registrant, registrant), directoryVisibilityCondition()))
    .orderBy(asc(agentDirectoryEntries.firstSeenAt), asc(agentDirectoryEntries.id))
    .limit(limit);
  return rows.map(row => row.id);
}

/**
 * Which of these directory entries the public may see now, by id and the name each is recorded under: the same
 * rule as every public directory read. The Owl's Catch asks it when it is read, so an entry hidden after a day's
 * catch was chosen is no longer linked.
 */
export async function listVisibleDirectoryEntries(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const db = requireDb(await getDb());
  const rows = await db
    .select({ id: agentDirectoryEntries.id, displayName: agentDirectoryEntries.displayName })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(inArray(agentDirectoryEntries.id, [...ids]), directoryVisibilityCondition()));
  return new Map(rows.map(row => [row.id, row.displayName] as [string, string]));
}

/**
 * Acknowledged-entry counts for the public honesty funnel: how far the
 * directory's population can travel from merely seen toward independently
 * proven. Locator counts only; the reviewed-record steps are composed by the
 * router from the evidence spine. Only entries from active sources are counted.
 */
export function readAgentDirectoryFunnelCounts() {
  return cachedDirectoryRead("directory:funnel-counts", () => readAgentDirectoryFunnelCountsUncached());
}

/** The uncached scan behind {@link readAgentDirectoryFunnelCounts}; only the cache wrapper calls it. */
async function readAgentDirectoryFunnelCountsUncached() {
  const db = requireDb(await getDb());
  const [acknowledgedRows, withLocatorRows] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)` })
      .from(agentDirectoryEntries)
      .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
      .where(directoryVisibilityCondition()),
    db
      .select({ total: sql<number>`count(*)` })
      .from(agentDirectoryEntries)
      .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
      .where(and(isNotNull(agentDirectoryEntries.locatorHost), directoryVisibilityCondition())),
  ]);
  return {
    acknowledged: Number(acknowledgedRows[0]?.total ?? 0),
    withLocator: Number(withLocatorRows[0]?.total ?? 0),
  };
}

/**
 * Entries whose ERC-8004 registering wallet is decoded and persisted. Counted
 * separately because the registrant column arrives through a gated migration:
 * while that migration is pending the funnel renders this step as explicitly
 * unmeasured instead of showing a false zero. Only entries from active sources
 * are counted.
 */
export function countAgentDirectoryRegistrants() {
  return cachedDirectoryRead("directory:registrants", () => countAgentDirectoryRegistrantsUncached());
}

/** The uncached scan behind {@link countAgentDirectoryRegistrants}; only the cache wrapper calls it. */
async function countAgentDirectoryRegistrantsUncached() {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(isNotNull(agentDirectoryEntries.registrant), directoryVisibilityCondition()));
  return Number(row?.total ?? 0);
}

/**
 * Chain-activity totals for the public funnel and home-page copy: how many
 * acknowledged entries have their minting measured, plus the ledger-wide
 * secondary-transfer, hand-out, and URI-update counts rolled up from those
 * entries — so the public totals and the per-agent page can never disagree.
 * measuredThroughBlock is the ledger's high-water block: the counts are
 * measured "as of" that block, because the activity walk only moves forward
 * from genesis to its walk point. The caller fails closed while migration
 * 0013 is pending: an unmeasured step renders as null, never as a false
 * zero. Only entries from active sources are counted.
 */
export function readAgentDirectoryActivityTotals() {
  return cachedDirectoryRead("directory:activity-totals", () => readAgentDirectoryActivityTotalsUncached());
}

/** The uncached scan behind {@link readAgentDirectoryActivityTotals}; only the cache wrapper calls it. */
async function readAgentDirectoryActivityTotalsUncached() {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({
      mintedEntries: sql<number>`count(*)`,
      secondaryTransfers: sql<number>`coalesce(sum(${agentDirectoryEntries.secondaryTransferCount}), 0)`,
      handoutTransfers: sql<number>`coalesce(sum(${agentDirectoryEntries.handoutCount}), 0)`,
      uriUpdates: sql<number>`coalesce(sum(${agentDirectoryEntries.uriUpdateCount}), 0)`,
    })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(isNotNull(agentDirectoryEntries.mintBlock), eq(agentDirectoryEntries.protocol, "erc8004"), directoryVisibilityCondition()));
  // The ledger-wide high-water block: every activity event the walk has
  // recorded lives at or below this block. Reading it in a separate small
  // query keeps the totals query a single-table rollup; an empty ledger maps
  // to null (not 0) so the client falls back to a plain "no estimates" chip
  // instead of pinning counts to a fabricated block.
  const [throughRow] = await db
    .select({ throughBlock: sql<number>`max(${agentDirectoryChainActivity.blockNumber})` })
    .from(agentDirectoryChainActivity)
    .innerJoin(ingestionSources, eq(agentDirectoryChainActivity.sourceId, ingestionSources.id))
    .where(eq(ingestionSources.protocol, "erc8004"));
  return {
    mintedEntries: Number(row?.mintedEntries ?? 0),
    secondaryTransfers: Number(row?.secondaryTransfers ?? 0),
    handoutTransfers: Number(row?.handoutTransfers ?? 0),
    uriUpdates: Number(row?.uriUpdates ?? 0),
    measuredThroughBlock: throughRow?.throughBlock === null || throughRow?.throughBlock === undefined
      ? null
      : Number(throughRow.throughBlock),
  };
}

/**
 * Entries whose mint block is measured, across every EVM identity registry the
 * directory lists (Robinhood Chain and BNB Chain). The honesty funnel's mint
 * step counts this rather than the Robinhood-only activity total, so the step
 * stays a subset of the acknowledged step once BNB Chain entries are listed.
 * The What-changed totals above stay Robinhood-only on purpose.
 */
export function countAgentDirectoryMintMeasured() {
  return cachedDirectoryRead("directory:mint-measured", () => countAgentDirectoryMintMeasuredUncached());
}

/** The uncached scan behind {@link countAgentDirectoryMintMeasured}; only the cache wrapper calls it. */
async function countAgentDirectoryMintMeasuredUncached() {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(isNotNull(agentDirectoryEntries.mintBlock), inArray(agentDirectoryEntries.protocol, ["erc8004", "erc8004_bsc"]), directoryVisibilityCondition()));
  return Number(row?.total ?? 0);
}

/**
 * The activity ledger's high-water block for one source — the same fact the
 * public "as of block N" label derives from. The forward walk seeds from it
 * so the cursor's anchor and the public label can never disagree. Null when
 * nothing is measured yet.
 */
export async function readAgentDirectoryActivityHighWater(sourceId: string): Promise<number | null> {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ highWater: sql<number>`max(${agentDirectoryChainActivity.blockNumber})` })
    .from(agentDirectoryChainActivity)
    .where(eq(agentDirectoryChainActivity.sourceId, sourceId));
  return row?.highWater === null || row?.highWater === undefined ? null : Number(row.highWater);
}

/**
 * The ratings ledger's high-water block for one source — the fact the
 * reputation forward walk seeds from, so the cursor's anchor and the public
 * "measured through" label can never disagree. Null when nothing is measured
 * yet.
 */
export async function readAgentDirectoryReputationHighWater(sourceId: string): Promise<number | null> {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ highWater: sql<number>`max(${agentReputationEvents.blockNumber})` })
    .from(agentReputationEvents)
    .where(eq(agentReputationEvents.sourceId, sourceId));
  return row?.highWater === null || row?.highWater === undefined ? null : Number(row.highWater);
}

/**
 * What a pre-flight check needs beyond the entry read (docs/data-access-2026-10-19.md, stage D3): where the identity ledger stands
 * (the high-water block that "as of block N" derives from) for an EVM entry, and the ownership transfers the Solana ledger has
 * recorded for a Metaplex or 8004 entry. A transfer is recorded when two reads of the registry show a new owner, so one that
 * happened before Nooscape's first read of the entry is not in it. The entry is found through the shared visibility rule, so a hidden
 * or closed one has none. A ledger that is not there yet (its migration is pending) reads as not measured, never as zero.
 */
export async function readAgentCheckFacts(entryId: string): Promise<{ activityThroughBlock: number | null; solana: { transfers: number; latestRecordedAt: Date | null } | null } | null> {
  const db = requireDb(await getDb());
  const [entry] = await db
    .select({ sourceId: agentDirectoryEntries.sourceId, externalKey: agentDirectoryEntries.externalKey, protocol: agentDirectoryEntries.protocol })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(eq(agentDirectoryEntries.id, entryId), directoryVisibilityCondition()))
    .limit(1);
  if (!entry) return null;
  let activityThroughBlock: number | null = null;
  // Every EVM identity registry keeps a ledger of its events: Robinhood Chain, BNB Chain, and Ethereum, Base and Arc.
  if (evmIdentityChain(entry.protocol) !== null) {
    try {
      activityThroughBlock = await readAgentDirectoryActivityHighWater(entry.sourceId);
    } catch {
      // The activity ledger's migration is pending: not measured.
    }
  }
  let solana: { transfers: number; latestRecordedAt: Date | null } | null = null;
  if (entry.protocol === "solana_8004" || entry.protocol === "solana_registry") {
    try {
      const [row] = await db
        .select({ transfers: sql<number>`count(*)`, latest: max(agentSolanaActivity.createdAt) })
        .from(agentSolanaActivity)
        .where(and(eq(agentSolanaActivity.sourceId, entry.sourceId), eq(agentSolanaActivity.externalKey, entry.externalKey), eq(agentSolanaActivity.kind, "transfer")));
      solana = { transfers: Number(row?.transfers ?? 0), latestRecordedAt: row?.latest ?? null };
    } catch {
      // The Solana ledger is not there yet: not measured.
    }
  }
  return { activityThroughBlock, solana };
}

/** Bound on events returned on the public What-changed page; the append-only ledger keeps every event. */
const MAX_AGENT_DIRECTORY_FEED_EVENTS = 40;

/**
 * One chain "day" at this chain's ≈0.1 s blocks: 86,400 s ≈ 864,000 blocks.
 * The ledger stores block numbers, not timestamps, so the series buckets by
 * block-day — an honest chain-derived proxy, never an invented clock.
 */
export const CHAIN_BLOCKS_PER_DAY = 864_000;

/** One ledger key's mint anchor: the earliest mint's block and minting wallet — the same facts the stored rollups derive. */
export type DirectoryMintAnchor = {
  sourceId: string;
  externalKey: string;
  anchorMintBlock: number | null;
  anchorMintTo: string | null;
};

/**
 * The stored hand-out rule (identical to the rollup's): a secondary Transfer
 * from the minting wallet inside the mint-hour window. Feed and series share
 * this classifier so the two surfaces can never disagree. The window is
 * Robinhood Chain's unless the caller gives another chain's own.
 */
export function isHandoutEvent(
  kind: DirectoryActivityFeedEvent["kind"],
  blockNumber: number,
  fromAddress: string | null,
  anchor: DirectoryMintAnchor | undefined,
  blockWindow: number = ROBINHOOD_HANDOUT_BLOCK_WINDOW
) {
  if (kind !== "secondary" || !anchor || anchor.anchorMintBlock === null || anchor.anchorMintTo === null) {
    return false;
  }
  return fromAddress !== null && fromAddress === anchor.anchorMintTo && blockNumber <= anchor.anchorMintBlock + blockWindow;
}

function directoryActivityAnchorKey(sourceId: string, externalKey: string) {
  return `${sourceId}\n${externalKey}`;
}

function directoryMintAnchorSelection() {
  return {
    sourceId: agentDirectoryChainActivity.sourceId,
    externalKey: agentDirectoryChainActivity.externalKey,
    anchorMintBlock: sql<number | null>`min(case when ${agentDirectoryChainActivity.kind} = 'mint' then ${agentDirectoryChainActivity.blockNumber} end)`,
    anchorMintTo: sql<string | null>`min(case when ${agentDirectoryChainActivity.kind} = 'mint' then ${agentDirectoryChainActivity.toAddress} end)`,
  };
}

/**
 * Mint anchors for explicit ledger keys only. Anchors are read as plain
 * grouped queries and joined in memory — never materialized as a derived
 * table inside a request query: joining a whole-ledger GROUP BY as a derived
 * table made these reads take tens of seconds at production ledger size
 * (quadratic in ledger rows), while point lookups on the (sourceId,
 * externalKey) index stay proportional to the page.
 */
async function readAgentDirectoryMintAnchors(
  db: ReturnType<typeof drizzle>,
  keys: Array<{ sourceId: string; externalKey: string }>
): Promise<DirectoryMintAnchor[]> {
  if (keys.length === 0) return [];
  return db
    .select(directoryMintAnchorSelection())
    .from(agentDirectoryChainActivity)
    .where(and(
      inArray(agentDirectoryChainActivity.sourceId, Array.from(new Set(keys.map(key => key.sourceId)))),
      inArray(agentDirectoryChainActivity.externalKey, Array.from(new Set(keys.map(key => key.externalKey))))
    ))
    .groupBy(agentDirectoryChainActivity.sourceId, agentDirectoryChainActivity.externalKey);
}

/** Every ledger key's mint anchor in one single-table grouped scan (the series needs the full map). */
async function readAllAgentDirectoryMintAnchors(db: ReturnType<typeof drizzle>): Promise<DirectoryMintAnchor[]> {
  return db
    .select(directoryMintAnchorSelection())
    .from(agentDirectoryChainActivity)
    .innerJoin(ingestionSources, eq(agentDirectoryChainActivity.sourceId, ingestionSources.id))
    .where(eq(ingestionSources.protocol, "erc8004"))
    .groupBy(agentDirectoryChainActivity.sourceId, agentDirectoryChainActivity.externalKey);
}

export type DirectoryActivityFeedEvent = {
  kind: "mint" | "secondary" | "uri_update";
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  fromAddress: string | null;
  toAddress: string | null;
  /** True when a secondary Transfer is a hand-out (from the minting wallet, inside the mint-hour window). */
  isHandout: boolean;
  entryId: string;
  displayName: string;
};

/**
 * The newest measured identity-registry events for the public What-changed
 * page: mints, hand-outs vs later changes of hands, and profile-link edits,
 * newest block first, each carrying the acknowledged entry it belongs to.
 * Events whose entry is hidden or whose source is inactive are excluded by
 * the shared visibility condition — the feed is a directory read like any
 * other. Callers render it "as of" the ledger's high-water block.
 */
export function readAgentDirectoryActivityFeed(limit = MAX_AGENT_DIRECTORY_FEED_EVENTS) {
  return cachedDirectoryRead(`directory:activity-feed:${limit}`, () => readAgentDirectoryActivityFeedUncached(limit));
}

/** The uncached scan behind {@link readAgentDirectoryActivityFeed}; only the cache wrapper calls it. */
async function readAgentDirectoryActivityFeedUncached(limit = MAX_AGENT_DIRECTORY_FEED_EVENTS) {
  const db = requireDb(await getDb());
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || MAX_AGENT_DIRECTORY_FEED_EVENTS, MAX_AGENT_DIRECTORY_FEED_EVENTS));
  const rows = await db
    .select({
      sourceId: agentDirectoryChainActivity.sourceId,
      externalKey: agentDirectoryChainActivity.externalKey,
      kind: agentDirectoryChainActivity.kind,
      blockNumber: agentDirectoryChainActivity.blockNumber,
      transactionHash: agentDirectoryChainActivity.transactionHash,
      logIndex: agentDirectoryChainActivity.logIndex,
      fromAddress: agentDirectoryChainActivity.fromAddress,
      toAddress: agentDirectoryChainActivity.toAddress,
      entryId: agentDirectoryEntries.id,
      displayName: agentDirectoryEntries.displayName,
    })
    .from(agentDirectoryChainActivity)
    .innerJoin(agentDirectoryEntries, and(
      eq(agentDirectoryEntries.sourceId, agentDirectoryChainActivity.sourceId),
      eq(agentDirectoryEntries.externalKey, agentDirectoryChainActivity.externalKey)
    ))
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(directoryVisibilityCondition(), eq(agentDirectoryEntries.protocol, "erc8004")))
    .orderBy(desc(agentDirectoryChainActivity.blockNumber), desc(agentDirectoryChainActivity.logIndex))
    .limit(boundedLimit);
  const anchors = new Map(
    (await readAgentDirectoryMintAnchors(db, rows.map(row => ({ sourceId: row.sourceId, externalKey: row.externalKey }))))
      .map(anchor => [directoryActivityAnchorKey(anchor.sourceId, anchor.externalKey), anchor])
  );
  return rows.map(row => ({
    kind: row.kind,
    blockNumber: Number(row.blockNumber),
    transactionHash: row.transactionHash,
    logIndex: Number(row.logIndex),
    fromAddress: row.fromAddress,
    toAddress: row.toAddress,
    isHandout: isHandoutEvent(row.kind, Number(row.blockNumber), row.fromAddress, anchors.get(directoryActivityAnchorKey(row.sourceId, row.externalKey))),
    entryId: row.entryId,
    displayName: row.displayName,
  }));
}

export type DirectoryActivityDayCounts = {
  /** Block-day index since genesis (blockNumber / 864,000); not a wall-clock date. */
  day: number;
  mints: number;
  handouts: number;
  laterTransfers: number;
  uriEdits: number;
};

/**
 * Per-block-day activity counts since launch for the What-changed series,
 * bucketed from block numbers (the ledger keeps no timestamps) and gated by
 * the same visibility condition as the feed, so the series can never disagree
 * with the public totals. Hand-outs and later changes of hands are split with
 * the same mint-anchor rule as the rollups.
 */
export function readAgentDirectoryActivityDaySeries() {
  return cachedDirectoryRead("directory:activity-day-series", () => readAgentDirectoryActivityDaySeriesUncached());
}

/** The uncached scan behind {@link readAgentDirectoryActivityDaySeries}; only the cache wrapper calls it. */
async function readAgentDirectoryActivityDaySeriesUncached() {
  const db = requireDb(await getDb());
  const dayColumn = sql<number>`floor(${agentDirectoryChainActivity.blockNumber} / ${CHAIN_BLOCKS_PER_DAY})`;
  const rows = await db
    .select({
      day: dayColumn,
      mints: sql<number>`count(case when ${agentDirectoryChainActivity.kind} = 'mint' then 1 end)`,
      secondaryTransfers: sql<number>`count(case when ${agentDirectoryChainActivity.kind} = 'secondary' then 1 end)`,
      uriEdits: sql<number>`count(case when ${agentDirectoryChainActivity.kind} = 'uri_update' then 1 end)`,
    })
    .from(agentDirectoryChainActivity)
    .innerJoin(agentDirectoryEntries, and(
      eq(agentDirectoryEntries.sourceId, agentDirectoryChainActivity.sourceId),
      eq(agentDirectoryEntries.externalKey, agentDirectoryChainActivity.externalKey)
    ))
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(directoryVisibilityCondition(), eq(agentDirectoryEntries.protocol, "erc8004")))
    .groupBy(dayColumn)
    .orderBy(dayColumn);
  const secondaryRows = await db
    .select({
      sourceId: agentDirectoryChainActivity.sourceId,
      externalKey: agentDirectoryChainActivity.externalKey,
      blockNumber: agentDirectoryChainActivity.blockNumber,
      fromAddress: agentDirectoryChainActivity.fromAddress,
    })
    .from(agentDirectoryChainActivity)
    .innerJoin(agentDirectoryEntries, and(
      eq(agentDirectoryEntries.sourceId, agentDirectoryChainActivity.sourceId),
      eq(agentDirectoryEntries.externalKey, agentDirectoryChainActivity.externalKey)
    ))
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(
      directoryVisibilityCondition(),
      eq(agentDirectoryEntries.protocol, "erc8004"),
      eq(agentDirectoryChainActivity.kind, "secondary")
    ));
  // The hand-out split folds in memory from the anchors map — the same facts
  // the rollup derives, read as a single-table grouped scan, never joined as
  // a derived table (see readAgentDirectoryMintAnchors).
  const anchors = new Map(
    (await readAllAgentDirectoryMintAnchors(db))
      .map(anchor => [directoryActivityAnchorKey(anchor.sourceId, anchor.externalKey), anchor])
  );
  const buckets = new Map<number, DirectoryActivityDayCounts>();
  for (const row of rows) {
    const day = Number(row.day);
    buckets.set(day, {
      day,
      mints: Number(row.mints ?? 0),
      handouts: 0,
      laterTransfers: 0,
      uriEdits: Number(row.uriEdits ?? 0),
    });
  }
  for (const row of secondaryRows) {
    const bucket = buckets.get(Math.floor(Number(row.blockNumber) / CHAIN_BLOCKS_PER_DAY));
    if (!bucket) continue; // unreachable: the row's own day always has a bucket
    if (isHandoutEvent("secondary", Number(row.blockNumber), row.fromAddress, anchors.get(directoryActivityAnchorKey(row.sourceId, row.externalKey)))) {
      bucket.handouts += 1;
    } else {
      bucket.laterTransfers += 1;
    }
  }
  return Array.from(buckets.values()).sort((left, right) => left.day - right.day);
}

/** The Solana ledgers' public feed is bounded like the identity registry's. */
export const MAX_SOLANA_ACTIVITY_FEED_EVENTS = 40;

/**
 * The newest anchored events across the Solana registries (Metaplex, 8004, and
 * SAID), read from `agent_solana_activity`. Each row is one registration, owner
 * or authority change, or profile edit, anchored to the transaction that made
 * it. The time shown is when Nooscape's pass recorded it (a bound on when it
 * happened, never the chain's own timestamp) and the slot is the observing
 * pass's. Entries are subject to exactly the same public rules as every other
 * directory read: only active sources, nothing hidden, closed, or on a
 * suppressed domain, so a closure event (whose entry has left every public
 * read) never surfaces. Served from the directory read cache; the Solana
 * ledger write invalidates it.
 *
 * It is the newest events overall with each registry's own newest few always in
 * ({@link SOLANA_FEED_FLOOR_PER_REGISTRY}), sorted newest first. A pass that records
 * a hundred SAID registrations at once would otherwise fill the whole feed and leave
 * no event of the 8004 or Metaplex registry in it.
 */
export function readSolanaActivityFeed(limit = MAX_SOLANA_ACTIVITY_FEED_EVENTS) {
  const bounded = Math.max(1, Math.min(Math.floor(limit) || MAX_SOLANA_ACTIVITY_FEED_EVENTS, MAX_SOLANA_ACTIVITY_FEED_EVENTS));
  return cachedDirectoryRead(`directory:solana-feed:${bounded}`, () => readSolanaActivityFeedUncached(bounded));
}

/** How many of each Solana registry's newest events the feed keeps whatever else is newer (fewer when the limit is small). */
export const SOLANA_FEED_FLOOR_PER_REGISTRY = 5;

/** The uncached read behind {@link readSolanaActivityFeed}; only the cache wrapper calls it. */
async function readSolanaActivityFeedUncached(limit: number) {
  const db = requireDb(await getDb());
  type SolanaProtocol = (typeof agentDirectoryEntries.protocol.enumValues)[number];
  const protocols = protocolsOf("solana") as SolanaProtocol[];
  // Each registry's newest `limit` events. The newest `limit` overall are among them, and so are each registry's own newest few.
  const perRegistry = await Promise.all(
    protocols.map(protocol =>
      db
        .select({
          id: agentSolanaActivity.id,
          kind: agentSolanaActivity.kind,
          slot: agentSolanaActivity.slot,
          transactionSignature: agentSolanaActivity.transactionSignature,
          fromOwner: agentSolanaActivity.fromOwner,
          toOwner: agentSolanaActivity.toOwner,
          recordedAt: agentSolanaActivity.createdAt,
          protocol: agentDirectoryEntries.protocol,
          entryId: agentDirectoryEntries.id,
          displayName: agentDirectoryEntries.displayName,
        })
        .from(agentSolanaActivity)
        .innerJoin(
          agentDirectoryEntries,
          and(eq(agentDirectoryEntries.sourceId, agentSolanaActivity.sourceId), eq(agentDirectoryEntries.externalKey, agentSolanaActivity.externalKey))
        )
        .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
        .where(and(directoryVisibilityCondition(), eq(agentDirectoryEntries.protocol, protocol)))
        .orderBy(desc(agentSolanaActivity.createdAt), desc(agentSolanaActivity.slot), desc(agentSolanaActivity.id))
        .limit(limit),
    ),
  );
  const rows = balancedNewest(perRegistry.flat(), {
    limit,
    floor: Math.min(SOLANA_FEED_FLOOR_PER_REGISTRY, Math.floor(limit / protocols.length)),
    group: row => row.protocol,
    compare: (a, b) => b.recordedAt.getTime() - a.recordedAt.getTime() || b.slot - a.slot || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  });
  return rows.map(sanitizeDirectoryEntry);
}

/**
 * How many anchored events each Solana registry has recorded, by kind, over
 * the same visible entries as the feed. A registry with no events yet is simply
 * absent: the page says so instead of showing a false zero.
 */
export function readSolanaActivityTotals() {
  return cachedDirectoryRead("directory:solana-totals", () => readSolanaActivityTotalsUncached());
}

/** The uncached read behind {@link readSolanaActivityTotals}; only the cache wrapper calls it. */
async function readSolanaActivityTotalsUncached() {
  const db = requireDb(await getDb());
  const rows = await db
    .select({ protocol: agentDirectoryEntries.protocol, kind: agentSolanaActivity.kind, count: sql<number>`count(*)` })
    .from(agentSolanaActivity)
    .innerJoin(
      agentDirectoryEntries,
      and(eq(agentDirectoryEntries.sourceId, agentSolanaActivity.sourceId), eq(agentDirectoryEntries.externalKey, agentSolanaActivity.externalKey))
    )
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(directoryVisibilityCondition())
    .groupBy(agentDirectoryEntries.protocol, agentSolanaActivity.kind);
  return rows
    .map(row => ({ protocol: row.protocol, kind: row.kind, count: Number(row.count ?? 0) }))
    .sort((a, b) => (a.protocol < b.protocol ? -1 : a.protocol > b.protocol ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/**
 * Rail-level USDG settlement totals over the one approved settlement ledger
 * from an active source. Aggregates only: settlement count, distinct
 * participant counts, the median raw value, the micropayment share ($0.01 and
 * under), and the measured block coverage. Values stay exact decimal strings —
 * dollars are derived at render, never stored. No registrant join and no
 * attribution number: the 2026-10-10 attribution probe found zero overlap
 * between settlement participants and registering wallets, so per the
 * census-integrity gate only rail facts ship. Returns null while no active
 * settlement source exists or nothing is measured — the caller renders the
 * gap, never a false zero.
 */
export async function readUsdgSettlementTotals() {
  const db = requireDb(await getDb());
  const [source] = await db
    .select({ id: ingestionSources.id })
    .from(ingestionSources)
    // Source-only read: gate on the active-source condition. The directory
    // visibility condition references agentDirectoryEntries.hidden and is only
    // valid in queries that join the directory table.
    .where(and(eq(ingestionSources.protocol, "usdg_settlement"), activeSourceCondition()));
  if (!source) return null;
  const [row] = await db
    .select({
      settlementCount: sql<number>`count(*)`,
      payerCount: sql<number>`count(distinct ${agentDirectoryUsdgSettlements.payerAddress})`,
      payeeCount: sql<number>`count(distinct ${agentDirectoryUsdgSettlements.payeeAddress})`,
      relayerCount: sql<number>`count(distinct ${agentDirectoryUsdgSettlements.relayerAddress})`,
      microPaymentCount: sql<number>`coalesce(sum(case when ${agentDirectoryUsdgSettlements.valueRaw} <= 10000 then 1 else 0 end), 0)`,
      firstBlock: sql<number>`min(${agentDirectoryUsdgSettlements.blockNumber})`,
      lastBlock: sql<number>`max(${agentDirectoryUsdgSettlements.blockNumber})`,
    })
    .from(agentDirectoryUsdgSettlements)
    .where(eq(agentDirectoryUsdgSettlements.sourceId, source.id));
  const settlementCount = Number(row?.settlementCount ?? 0);
  if (settlementCount === 0) return null;
  // Exact median over raw values: one bounded offset read of the ordered set
  // (the lower-middle row for an even count). No float ever touches a value.
  const middle = Math.floor((settlementCount - 1) / 2);
  const [medianRow] = await db
    .select({ valueRaw: agentDirectoryUsdgSettlements.valueRaw })
    .from(agentDirectoryUsdgSettlements)
    .where(eq(agentDirectoryUsdgSettlements.sourceId, source.id))
    .orderBy(asc(agentDirectoryUsdgSettlements.valueRaw))
    .limit(1)
    .offset(middle);
  return {
    settlementCount,
    payerCount: Number(row?.payerCount ?? 0),
    payeeCount: Number(row?.payeeCount ?? 0),
    relayerCount: Number(row?.relayerCount ?? 0),
    microPaymentCount: Number(row?.microPaymentCount ?? 0),
    medianValueRaw: medianRow?.valueRaw ?? null,
    firstBlock: Number(row?.firstBlock ?? 0),
    lastBlock: Number(row?.lastBlock ?? 0),
  };
}

/**
 * Internal lookup of a directory entry by id, ignoring visibility filters.
 * Used by operator mutations that need to find hidden entries.
 */
export async function getDirectoryEntryById(id: string) {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({
      id: agentDirectoryEntries.id,
      displayName: agentDirectoryEntries.displayName,
      locatorHost: agentDirectoryEntries.locatorHost,
      hidden: agentDirectoryEntries.hidden,
    })
    .from(agentDirectoryEntries)
    .where(eq(agentDirectoryEntries.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * The directory entry a claim is about (docs/claims-2026-10-18.md), under the same visibility rule as every public read: an entry
 * that is hidden, closed or from an inactive source cannot be claimed. Only what a claim needs is returned.
 */
export async function getDirectoryEntryForClaim(id: string) {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ id: agentDirectoryEntries.id, protocol: agentDirectoryEntries.protocol, externalKey: agentDirectoryEntries.externalKey, registrant: agentDirectoryEntries.registrant })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(eq(agentDirectoryEntries.id, id), directoryVisibilityCondition()))
    .limit(1);
  return row ?? null;
}

/** How many entries the directory lists for one registering wallet on one protocol, under the public visibility rule. The fleet rule of the claim flow reads it. */
export async function countVisibleEntriesOfRegistrant(protocol: "erc8004" | "erc8004_bsc" | "erc8004_arc", registrant: string): Promise<number> {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    // The pass stores the registering wallet lower-case, so this is an equality on the registrant index and not a scan.
    .where(and(eq(agentDirectoryEntries.protocol, protocol), eq(agentDirectoryEntries.registrant, registrant.toLowerCase()), directoryVisibilityCondition()));
  return Number(row?.total ?? 0);
}

/**
 * Operator-controlled hiding of a directory entry. Used for entries with dead
 * locator hosts (e.g. agentrank.info) or other operator-identified issues.
 * Returns the updated entry state; throws if the entry doesn't exist.
 */
export async function hideDirectoryEntry(entryId: Parameters<typeof hideDirectoryEntryImpl>[0]) {
  // Any write that can change what the cached directory aggregates count
  // drops them, on success or failure (a failure may have written part of it).
  try {
    return await hideDirectoryEntryImpl(entryId);
  } finally {
    invalidateDirectoryReads();
  }
}

async function hideDirectoryEntryImpl(entryId: string) {
  const db = requireDb(await getDb());
  const existing = await getDirectoryEntryById(entryId);
  if (!existing) throw new Error("Directory entry not found.");
  if (existing.hidden) throw new Error("Directory entry is already hidden.");
  await db
    .update(agentDirectoryEntries)
    .set({ hidden: true })
    .where(eq(agentDirectoryEntries.id, entryId));
  return { ...existing, hidden: true };
}

/**
 * Operator-controlled unhiding of a directory entry. Restores visibility
 * (subject to source state). Returns the updated entry state.
 */
export async function unhideDirectoryEntry(entryId: Parameters<typeof unhideDirectoryEntryImpl>[0]) {
  // Any write that can change what the cached directory aggregates count
  // drops them, on success or failure (a failure may have written part of it).
  try {
    return await unhideDirectoryEntryImpl(entryId);
  } finally {
    invalidateDirectoryReads();
  }
}

async function unhideDirectoryEntryImpl(entryId: string) {
  const db = requireDb(await getDb());
  const existing = await getDirectoryEntryById(entryId);
  if (!existing) throw new Error("Directory entry not found.");
  if (!existing.hidden) throw new Error("Directory entry is not hidden.");
  await db
    .update(agentDirectoryEntries)
    .set({ hidden: false })
    .where(eq(agentDirectoryEntries.id, entryId));
  return { ...existing, hidden: false };
}

/**
 * Lists currently hidden directory entries for the operator control plane.
 */
export async function listHiddenDirectoryEntries() {
  const db = requireDb(await getDb());
  return db
    .select({
      id: agentDirectoryEntries.id,
      displayName: agentDirectoryEntries.displayName,
      locatorHost: agentDirectoryEntries.locatorHost,
      protocol: agentDirectoryEntries.protocol,
    })
    .from(agentDirectoryEntries)
    .where(eq(agentDirectoryEntries.hidden, true))
    .orderBy(asc(agentDirectoryEntries.displayName))
    .limit(500);
}

export async function decideIngestionSource(input: Parameters<typeof decideIngestionSourceImpl>[0]) {
  // Any write that can change what the cached directory aggregates count
  // drops them, on success or failure (a failure may have written part of it).
  try {
    return await decideIngestionSourceImpl(input);
  } finally {
    invalidateDirectoryReads();
  }
}

async function decideIngestionSourceImpl(input: {
  sourceId: string;
  decision: "active" | "rejected" | "paused";
  decidedByUserId: number;
  rationale: string;
}) {
  const db = requireDb(await getDb());
  const now = new Date();
  const nextRunAt = input.decision === "active" ? now : null;

  await db.transaction(async tx => {
    await tx
      .update(ingestionSources)
      .set({ state: input.decision, nextRunAt })
      .where(eq(ingestionSources.id, input.sourceId));
    await tx
      .update(reviewItems)
      .set({
        status: input.decision === "active" ? "approved" : "rejected",
        rationale: input.rationale,
        decidedByUserId: input.decidedByUserId,
        decidedAt: now,
      })
      .where(
        and(
          eq(reviewItems.subjectType, "ingestion_source"),
          eq(reviewItems.subjectId, input.sourceId),
          eq(reviewItems.status, "pending")
        )
      );
  });
}

/**
 * Records a deliberate review-to-public (or revocation) presentation decision.
 * A `public` decision must name the reviewed completed run (`approvedRunId`)
 * that becomes the visible set; revocation clears the binding.
 */
export async function decideSourceProjection(input: {
  sourceId: string;
  state: "public" | "revoked";
  rationale: string;
  decidedByUserId: number;
  approvedRunId: string | null;
}) {
  const db = requireDb(await getDb());
  const now = new Date();
  await db
    .insert(sourceProjectionDecisions)
    .values({ ...input, decidedAt: now })
    .onDuplicateKeyUpdate({
      set: {
        state: input.state,
        rationale: input.rationale,
        decidedByUserId: input.decidedByUserId,
        decidedAt: now,
        approvedRunId: input.approvedRunId,
      },
    });
}

/** The newest completed run for a source; the only run a public decision may bind to. */
export async function getLatestCompletedRunForSource(sourceId: string) {
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
    .where(
      and(
        eq(ingestionRuns.sourceId, sourceId),
        eq(ingestionRuns.status, "completed"),
        isNotNull(ingestionRuns.finishedAt)
      )
    )
    .orderBy(desc(ingestionRuns.finishedAt), desc(ingestionRuns.startedAt))
    .limit(1);
  return run;
}

/** Validates a caller-supplied run before it may be bound to a public decision. */
export async function getCompletedRunForSource(sourceId: string, runId: string) {
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
    .where(
      and(
        eq(ingestionRuns.id, runId),
        eq(ingestionRuns.sourceId, sourceId),
        eq(ingestionRuns.status, "completed"),
        isNotNull(ingestionRuns.finishedAt)
      )
    )
    .limit(1);
  return run;
}

/** Per-source projection decisions for the operator control plane. */
export async function listSourceProjectionDecisions() {
  const db = requireDb(await getDb());
  return db.select().from(sourceProjectionDecisions);
}

/** Distinct agents whose retained snapshot was observed in one run. */
export async function countRunLinkedPublicSnapshots(runId: string) {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${agentPublicSnapshots.agentId})` })
    .from(agentPublicSnapshots)
    .innerJoin(
      sourceObservationRuns,
      and(
        eq(sourceObservationRuns.runId, runId),
        eq(sourceObservationRuns.observationId, agentPublicSnapshots.sourceObservationId)
      )
    );
  return Number(row?.count ?? 0);
}

export async function beginIngestionRun(source: IngestionSource, trigger: "manual" | "scheduled" | "replay") {
  const db = requireDb(await getDb());
  const runId = randomUUID();
  await db.insert(ingestionRuns).values({
    id: runId,
    sourceId: source.id,
    trigger,
    status: "running",
    cursorBefore: source.cursor,
  });
  return runId;
}

export async function finishIngestionRun(input: {
  runId: string;
  source: IngestionSource;
  status: "completed" | "failed" | "skipped";
  counts: { requestCount: number; discoveredCount: number; acceptedCount: number; rejectedCount: number };
  nextCursor: string | null;
  error?: unknown;
}) {
  const db = requireDb(await getDb());
  const now = new Date();
  const errorSummary = input.error ? safeErrorSummary(input.error) : null;
  const nextRunAt = new Date(now.getTime() + input.source.scheduleMinutes * 60_000);

  await db.transaction(async tx => {
    await tx
      .update(ingestionRuns)
      .set({
        status: input.status,
        cursorAfter: input.nextCursor,
        ...input.counts,
        errorSummary,
        finishedAt: now,
      })
      .where(eq(ingestionRuns.id, input.runId));

    await tx
      .update(ingestionSources)
      .set({
        cursor: input.nextCursor,
        nextRunAt,
        lastSuccessfulAt: input.status === "completed" ? now : input.source.lastSuccessfulAt,
        failureCount: input.status === "failed" ? input.source.failureCount + 1 : 0,
        lastError: errorSummary,
      })
      .where(eq(ingestionSources.id, input.source.id));
  });
}

export async function persistA2aObservation(input: {
  source: IngestionSource;
  runId: string;
  observation: RawObservationInput;
  candidate: A2aNormalizedCandidate;
}) {
  return persistSourceScopedAgentObservation({
    source: input.source,
    runId: input.runId,
    protocol: "a2a",
    parserVersion: "a2a-agent-card-v2-strong-identity",
    observation: input.observation,
    candidate: {
      displayName: input.candidate.displayName,
      displayHandle: input.candidate.handle,
      summary: input.candidate.summary,
      primaryCapability: input.candidate.primaryCapability,
      identityType: "a2a_url",
      externalId: input.candidate.agentCardUrl,
      protocols: ["a2a"],
      endpointUrl: input.candidate.endpointUrl,
      authentication: input.candidate.authentication,
      eventType: "A2A_AGENT_CARD_OBSERVED",
      eventDescription: `A2A AgentCard observed from approved source ${input.source.label}; identity resolves by AgentCard URL, not display name.`,
    },
  });
}

/**
 * Persists catalog-provided discovery metadata. It deliberately does not invoke
 * the advertised AgentCard or provider endpoint, and it does not inherit the
 * catalog's owner/domain/signed claims as Nooscape verification state.
 */
export async function persistCatalogObservation(input: {
  source: IngestionSource;
  runId: string;
  observation: RawObservationInput;
  candidate: CatalogNormalizedCandidate;
}) {
  return persistSourceScopedAgentObservation({
    source: input.source,
    runId: input.runId,
    protocol: "catalog",
    parserVersion: "agenstry-catalog-v2-source-scoped",
    observation: input.observation,
    candidate: {
      displayName: input.candidate.displayName,
      displayHandle: input.candidate.handle,
      summary: input.candidate.summary,
      primaryCapability: input.candidate.primaryCapability,
      // A catalog entry receives a catalog-scoped identity. An advertised A2A URL
      // can support a future merge review but never takes over a direct identity.
      identityType: "catalog_record",
      externalId: `${input.source.id}:${input.candidate.externalRecordId}`,
      protocols: ["catalog"],
      eventType: "CATALOG_AGENT_METADATA_OBSERVED",
      eventDescription: `Agent metadata observed in approved catalog ${input.source.label}; catalog verification signals remain assertions.`,
    },
  });
}

/**
 * Persists one public Metaplex registry record. The Solana mint is an asserted
 * identity anchor only: no chain RPC, authority proof, or advertised A2A service
 * is invoked by this path.
 */
export async function persistSolanaRegistryObservation(input: {
  source: IngestionSource;
  runId: string;
  observation: RawObservationInput;
  candidate: SolanaRegistryCandidate;
}) {
  return persistSourceScopedAgentObservation({
    source: input.source,
    runId: input.runId,
    protocol: "solana_registry",
    parserVersion: "metaplex-solana-registry-v2-source-scoped",
    observation: input.observation,
    candidate: {
      displayName: input.candidate.displayName,
      displayHandle: input.candidate.handle,
      summary: input.candidate.summary,
      primaryCapability: input.candidate.primaryCapability,
      identityType: "solana_mint",
      externalId: input.candidate.mintAddress,
      protocols: ["solana_registry", ...(input.candidate.agentCardUrl ? ["a2a"] : [])],
      endpointUrl: input.candidate.agentCardUrl,
      eventType: "SOLANA_REGISTRY_AGENT_METADATA_OBSERVED",
      eventDescription: `Solana agent metadata observed in approved Metaplex registry ${input.source.label}; mint, authority, wallet, and A2A declarations remain unverified assertions.`,
    },
  });
}

/**
 * Persists one ERC-8004 identity registration observed on the Robinhood Chain
 * registry. The owner and URI are registry-recorded assertions at registration
 * time: this path never dereferences a URI or queries current token state.
 */
export async function persistErc8004RegistryObservation(input: {
  source: IngestionSource;
  runId: string;
  observation: RawObservationInput;
  candidate: Erc8004RegistryCandidate;
}) {
  return persistSourceScopedAgentObservation({
    source: input.source,
    runId: input.runId,
    protocol: "erc8004",
    parserVersion: "robinhood-erc8004-identity-v1-source-scoped",
    observation: input.observation,
    candidate: {
      displayName: input.candidate.displayName,
      displayHandle: input.candidate.handle,
      summary: input.candidate.summary,
      primaryCapability: input.candidate.primaryCapability,
      identityType: "erc8004",
      externalId: input.candidate.externalId,
      protocols: ["erc8004"],
      eventType: "ERC8004_AGENT_REGISTERED",
      eventDescription:
        "ERC-8004 agent registration observed on the approved Robinhood Chain identity registry; owner, URI, and self-asserted metadata remain unverified assertions.",
    },
  });
}

/** Persists aggregate context only; this deliberately creates no agent profile. */
export async function persistCensusObservation(input: {
  source: IngestionSource;
  runId: string;
  observation: RawObservationInput;
}) {
  const db = requireDb(await getDb());
  const observationId = randomUUID();
  const locatorHash = hashValue(input.observation.canonicalLocator);
  const [existingObservation] = await db
    .select({ id: sourceObservations.id })
    .from(sourceObservations)
    .where(
      and(
        eq(sourceObservations.sourceId, input.source.id),
        eq(sourceObservations.locatorHash, locatorHash),
        eq(sourceObservations.contentHash, input.observation.contentHash)
      )
    )
    .limit(1);
  const persistedObservationId = existingObservation?.id ?? observationId;
  await db.transaction(async tx => {
    if (!existingObservation) {
      await tx.insert(sourceObservations).values({
        id: observationId,
        sourceId: input.source.id,
        protocol: "census",
        canonicalLocator: input.observation.canonicalLocator,
        locatorHash,
        contentHash: input.observation.contentHash,
        rawObjectKey: input.observation.rawObjectKey,
        contentType: input.observation.contentType,
        httpStatus: input.observation.httpStatus,
        parserVersion: "agent-economy-census-v1",
        validationStatus: input.observation.validationStatus,
        validationFindings: JSON.stringify(input.observation.validationFindings),
        observedAt: input.observation.observedAt,
      });
    }
    await tx
      .insert(sourceObservationRuns)
      .values({ runId: input.runId, observationId: persistedObservationId })
      .onDuplicateKeyUpdate({ set: { linkedAt: input.observation.observedAt } });
  });
  return { observationId: persistedObservationId };
}

type SourceScopedCandidate = {
  displayName: string;
  displayHandle: string;
  summary: string | null;
  primaryCapability: string | null;
  identityType: "a2a_url" | "catalog_record" | "solana_mint" | "erc8004";
  externalId: string;
  protocols: string[];
  endpointUrl?: string | null;
  authentication?: string | null;
  eventType: string;
  eventDescription: string;
};

export function displayHandleFromStrongIdentity(value: string, strongIdentity: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 132);
  return `${normalized || "agent"}-${hashValue(strongIdentity).slice(0, 10)}`;
}

/**
 * Writes a source-scoped observation and projection snapshot without merging on a
 * display name. The strong identity is immutable: an existing identity resolves
 * to its agent, and it is never re-pointed to a different record.
 */
export async function persistSourceScopedAgentObservation(input: {
  source: IngestionSource;
  runId: string;
  protocol: "a2a" | "catalog" | "solana_registry" | "erc8004";
  parserVersion: string;
  observation: RawObservationInput;
  candidate: SourceScopedCandidate;
}) {
  const db = requireDb(await getDb());
  const observationId = randomUUID();
  const locatorHash = hashValue(input.observation.canonicalLocator);
  const identityHash = hashValue(input.candidate.externalId);
  const [existingObservation] = await db
    .select({ id: sourceObservations.id })
    .from(sourceObservations)
    .where(
      and(
        eq(sourceObservations.sourceId, input.source.id),
        eq(sourceObservations.locatorHash, locatorHash),
        eq(sourceObservations.contentHash, input.observation.contentHash)
      )
    )
    .limit(1);
  const persistedObservationId = existingObservation?.id ?? observationId;

  await db.transaction(async tx => {
    if (!existingObservation) {
      await tx.insert(sourceObservations).values({
        id: observationId,
        sourceId: input.source.id,
        protocol: input.protocol,
        canonicalLocator: input.observation.canonicalLocator,
        locatorHash,
        contentHash: input.observation.contentHash,
        rawObjectKey: input.observation.rawObjectKey,
        contentType: input.observation.contentType,
        httpStatus: input.observation.httpStatus,
        parserVersion: input.parserVersion,
        validationStatus: input.observation.validationStatus,
        validationFindings: JSON.stringify(input.observation.validationFindings),
        observedAt: input.observation.observedAt,
      });
    }
    await tx
      .insert(sourceObservationRuns)
      .values({ runId: input.runId, observationId: persistedObservationId })
      .onDuplicateKeyUpdate({ set: { linkedAt: input.observation.observedAt } });

    const [knownIdentity] = await tx
      .select({ id: agentIdentities.id, agentId: agentIdentities.agentId })
      .from(agentIdentities)
      .where(and(eq(agentIdentities.identityType, input.candidate.identityType), eq(agentIdentities.externalIdHash, identityHash)))
      .limit(1);

    let agentId = knownIdentity?.agentId;
    if (!agentId) {
      agentId = randomUUID();
      const handle = displayHandleFromStrongIdentity(input.candidate.displayHandle, `${input.candidate.identityType}:${input.candidate.externalId}`);
      const position = mapPositionFromHandle(handle);
      await tx.insert(agents).values({
        id: agentId,
        displayName: input.candidate.displayName,
        handle,
        primaryCapability: input.candidate.primaryCapability,
        summary: input.candidate.summary,
        lifecycle: "unknown",
        mapX: position.x,
        mapY: position.y,
        firstSeenAt: input.observation.observedAt,
        lastSeenAt: input.observation.observedAt,
      });
      await tx.insert(agentIdentities).values({
        id: randomUUID(),
        agentId,
        identityType: input.candidate.identityType,
        externalId: input.candidate.externalId,
        externalIdHash: identityHash,
        sourceObservationId: persistedObservationId,
        verificationState: "asserted",
      });
      await tx.insert(agentReadModel).values({
        agentId,
        displayName: input.candidate.displayName,
        handle,
        primaryCapability: input.candidate.primaryCapability,
        summary: input.candidate.summary,
        protocols: JSON.stringify(input.candidate.protocols),
        publisherState: "unverified",
        evidenceTier: "tier_2",
        sourceCount: 1,
        lastObservedAt: input.observation.observedAt,
        evidenceSummary: JSON.stringify({ status: "source_scoped_metadata_observed", observationId: persistedObservationId }),
      });
    } else {
      // The public fields stay on the observation snapshot; an unreviewed source
      // cannot rewrite the canonical profile of a known strong identity.
      await tx.update(agents).set({ lastSeenAt: input.observation.observedAt }).where(eq(agents.id, agentId));
    }

    if (input.candidate.endpointUrl) {
      await tx
        .insert(agentEndpoints)
        .values({
          id: randomUUID(),
          agentId,
          protocol: "a2a",
          endpointUrl: input.candidate.endpointUrl,
          endpointHash: hashValue(input.candidate.endpointUrl),
          authentication: input.candidate.authentication ?? null,
          domainVerification: "unverified",
          lastHealth: "unknown",
          sourceObservationId: persistedObservationId,
          lastObservedAt: input.observation.observedAt,
        })
        .onDuplicateKeyUpdate({
          set: {
            sourceObservationId: persistedObservationId,
            authentication: input.candidate.authentication ?? null,
            lastObservedAt: input.observation.observedAt,
          },
        });
    }

    await tx
      .insert(agentPublicSnapshots)
      .values({
        id: randomUUID(),
        agentId,
        sourceId: input.source.id,
        sourceObservationId: persistedObservationId,
        displayName: input.candidate.displayName,
        displayHandle: displayHandleFromStrongIdentity(input.candidate.displayHandle, `${input.candidate.identityType}:${input.candidate.externalId}`),
        primaryCapability: input.candidate.primaryCapability,
        untrustedSelfDescription: input.candidate.summary,
        protocols: JSON.stringify(input.candidate.protocols),
        publisherState: "unverified",
        evidenceTier: "tier_2",
        sourceCount: 1,
        observedAt: input.observation.observedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          displayName: input.candidate.displayName,
          primaryCapability: input.candidate.primaryCapability,
          untrustedSelfDescription: input.candidate.summary,
          protocols: JSON.stringify(input.candidate.protocols),
          observedAt: input.observation.observedAt,
        },
      });

    // A replay can legitimately resolve to an observation retained before the
    // source-scoped projection schema existed. Ensure that both fresh and
    // replayed observations have exactly one persisted evidence event, so a
    // public snapshot can always produce a signed provenance envelope.
    const [existingEvidenceEvent] = await tx
      .select({ id: evidenceEvents.id })
      .from(evidenceEvents)
      .where(
        and(
          eq(evidenceEvents.agentId, agentId),
          eq(evidenceEvents.sourceObservationId, persistedObservationId),
          eq(evidenceEvents.eventType, input.candidate.eventType)
        )
      )
      .limit(1);
    if (!existingEvidenceEvent) {
      await tx.insert(evidenceEvents).values({
        id: randomUUID(),
        agentId,
        sourceObservationId: persistedObservationId,
        eventType: input.candidate.eventType,
        description: input.candidate.eventDescription,
        proofReference: input.observation.canonicalLocator,
        payloadHash: input.observation.contentHash,
        observedAt: input.observation.observedAt,
      });
    }
  });
  return { observationId: persistedObservationId };
}

export type PublicSnapshotRow = {
  agentId: string;
  displayName: string;
  handle: string;
  primaryCapability: string | null;
  summary: string | null;
  protocols: string;
  snapshotPublisherState: string;
  snapshotEvidenceTier: string;
  readModelPublisherState: string | null;
  readModelEvidenceTier: string | null;
  readModelVerificationExpiresAt: Date | null;
  readModelVerifiedCardHash: string | null;
  readModelPublisherExpiresAt: Date | null;
  sourceCount: number;
  lastObservedAt: Date;
};

/** Canonical fingerprint of the public card fields a domain verification pins. */
export function snapshotCardFingerprint(card: {
  displayName: string;
  primaryCapability: string | null;
  summary: string | null;
  protocols: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify([card.displayName, card.primaryCapability ?? "", card.summary ?? "", card.protocols]))
    .digest("hex");
}

/**
 * Read-time publisher-key resolution for the public list path, mirroring the
 * detail path: an allowlisted read-model state whose copied expiry has elapsed
 * resolves to expired without waiting for the next worker tick, so a lapsed
 * key fails closed on the list exactly as it does on validation.
 * `readModelPublisherState` uses the read-model enum (pending maps to
 * "unverified"), which effectivePublisherKeyState treats as pass-through —
 * only "allowlisted" is expiry-sensitive.
 */
function effectivePublisherState(snapshot: PublicSnapshotRow, now: Date) {
  const readModelState = snapshot.readModelPublisherState;
  if (!readModelState) return snapshot.snapshotPublisherState;
  return effectivePublisherKeyState(readModelState as PublisherKeyState, snapshot.readModelPublisherExpiresAt, now);
}

/**
 * Domain-control upgrades are enforced fail-closed at read time: a tier_3
 * read-model overlay projects only while its validity window is open and the
 * card the operator verified (pinned by fingerprint) is still the card being
 * served. Expired, revoked, or changed cards fall back to the snapshot tier
 * (tier_2) until an operator recheck or a new challenge succeeds. Publisher-key
 * upgrades are enforced the same way: a tier_4 overlay projects only while the
 * resolved publisher state is still allowlisted.
 */
function effectiveEvidenceTier(snapshot: PublicSnapshotRow, now: Date, publisherState: string) {
  const readModelTier = snapshot.readModelEvidenceTier;
  if (!readModelTier) return snapshot.snapshotEvidenceTier;
  const domainPinned =
    readModelTier === "tier_3" &&
    (snapshot.readModelVerificationExpiresAt !== null || snapshot.readModelVerifiedCardHash !== null);
  if (domainPinned) {
    const active =
      snapshot.readModelVerificationExpiresAt !== null &&
      snapshot.readModelVerificationExpiresAt > now &&
      snapshot.readModelVerifiedCardHash === snapshotCardFingerprint(snapshot);
    if (!active) return snapshot.snapshotEvidenceTier;
  }
  if (readModelTier === "tier_4" && publisherState !== "allowlisted") return snapshot.snapshotEvidenceTier;
  return readModelTier;
}

/**
 * A canonical agent may legitimately have multiple visible source snapshots.
 * Rows arrive ordered by observedAt descending; only the newest visible row per
 * agent is returned. Descriptive fields stay source-scoped on that row, while
 * live evidence governance (tier and publisher state) is a per-agent fact that
 * only operator-gated, evidence-backed flows can raise: overlay it so an
 * approved verification is never hidden behind projection-time snapshot
 * defaults. Source-served text is sanitized for presentation and version-like
 * capability values are suppressed; the stored snapshot is never modified.
 * Kept pure so the collapse rule stays unit tested.
 */
export function collapseVisibleSnapshots(rows: PublicSnapshotRow[], now: Date = new Date()) {
  const newestByAgent = new Map<string, PublicSnapshotRow>();
  for (const row of rows) {
    if (!newestByAgent.has(row.agentId)) newestByAgent.set(row.agentId, row);
  }
  return Array.from(newestByAgent.values()).map(snapshot => {
    const publisherState = effectivePublisherState(snapshot, now);
    return {
      agentId: snapshot.agentId,
      displayName: sanitizePublicText(snapshot.displayName, 255) ?? snapshot.displayName,
      handle: snapshot.handle,
      primaryCapability: sanitizePrimaryCapability(snapshot.primaryCapability),
      untrustedSummary: sanitizePublicText(snapshot.summary),
      protocols: snapshot.protocols,
      publisherState,
      evidenceTier: effectiveEvidenceTier(snapshot, now, publisherState),
      sourceCount: snapshot.sourceCount,
      lastObservedAt: snapshot.lastObservedAt,
    };
  });
}

/**
 * Withdrawal resolution is a pure fold over the append-only ledger in event
 * order (oldest first): the newest event per agent decides whether the record
 * is withheld. Kept pure so the rule stays unit tested.
 */
export function resolveWithdrawnAgentIds(
  events: Array<{ agentId: string; action: "withdraw" | "reinstate" }>
) {
  const latestActionByAgent = new Map<string, "withdraw" | "reinstate">();
  for (const event of events) latestActionByAgent.set(event.agentId, event.action);
  const withdrawn: string[] = [];
  latestActionByAgent.forEach((action, agentId) => {
    if (action === "withdraw") withdrawn.push(agentId);
  });
  return withdrawn.sort();
}

/**
 * Resolves the currently withdrawn agentIds from the append-only ledger.
 * Fails closed: if the ledger cannot be read (for example before migration
 * 0010 is applied), the error propagates so the public read refuses to serve
 * rather than risk exposing a record an operator withheld. The empty census
 * during that window is the reviewed deploy signal for the operator bridge.
 */
export async function listActiveWithdrawnAgentIds() {
  const db = requireDb(await getDb());
  const events = await db
    .select({ agentId: agentRecordWithdrawals.agentId, action: agentRecordWithdrawals.action })
    .from(agentRecordWithdrawals)
    .orderBy(asc(agentRecordWithdrawals.id));
  return resolveWithdrawnAgentIds(events);
}

/**
 * Shared join conditions for the reviewed-run visibility gate. A snapshot is
 * visible only when its source is currently `active`, its source decision is
 * "public", AND its observation is linked to the decision's explicitly
 * approved run. Every public read composes these exact conditions
 * (listLiveAtlasRecords, getLiveAtlasProvenanceCoverage,
 * getNewestVisibleSnapshotCard, isAgentPubliclyVisible, and the persisted
 * evidence pull), so visibility logic cannot drift apart.
 */

/** Decision side of the gate: public state bound to an explicitly approved run. */
function publicDecisionJoinCondition() {
  return and(
    eq(sourceProjectionDecisions.sourceId, agentPublicSnapshots.sourceId),
    eq(sourceProjectionDecisions.state, "public"),
    isNotNull(sourceProjectionDecisions.approvedRunId)
  );
}

/** Observation side of the gate: the retained observation belongs to the approved run. */
function approvedRunJoinCondition() {
  return and(
    eq(sourceObservationRuns.runId, sourceProjectionDecisions.approvedRunId),
    eq(sourceObservationRuns.observationId, agentPublicSnapshots.sourceObservationId)
  );
}

/**
 * Source-state side of the gate: a paused or rejected source stops serving its
 * already-public records immediately — the operator's decision about the
 * source outranks the earlier projection decision, with no write-back needed.
 */
function activeSourceJoinCondition() {
  return and(eq(ingestionSources.id, agentPublicSnapshots.sourceId), eq(ingestionSources.state, "active"));
}

function visibilityGateJoins(db: ReturnType<typeof drizzle>) {
  return db
    .select({ agentId: agentPublicSnapshots.agentId })
    .from(agentPublicSnapshots)
    .innerJoin(sourceProjectionDecisions, publicDecisionJoinCondition())
    .innerJoin(sourceObservationRuns, approvedRunJoinCondition())
    .innerJoin(ingestionSources, activeSourceJoinCondition());
}

/**
 * Public records are readable only through the reviewed-run gate: a snapshot is
 * visible when its source is currently `active`, its source decision is
 * `public`, and its retained observation is linked to the decision's explicitly
 * approved run. Snapshots and observations are retained per content hash, so
 * the last approved version stays visible while a newer, unreviewed run is
 * withheld; pausing or rejecting a source hides its records immediately.
 */
export async function listLiveAtlasRecords() {
  const db = requireDb(await getDb());
  const snapshots = await db
    .select({
      agentId: agentPublicSnapshots.agentId,
      displayName: agentPublicSnapshots.displayName,
      handle: agentPublicSnapshots.displayHandle,
      primaryCapability: agentPublicSnapshots.primaryCapability,
      summary: agentPublicSnapshots.untrustedSelfDescription,
      protocols: agentPublicSnapshots.protocols,
      snapshotPublisherState: agentPublicSnapshots.publisherState,
      snapshotEvidenceTier: agentPublicSnapshots.evidenceTier,
      readModelPublisherState: agentReadModel.publisherState,
      readModelEvidenceTier: agentReadModel.evidenceTier,
      readModelVerificationExpiresAt: agentReadModel.verificationExpiresAt,
      readModelVerifiedCardHash: agentReadModel.verifiedCardHash,
      readModelPublisherExpiresAt: agentReadModel.publisherExpiresAt,
      sourceCount: agentPublicSnapshots.sourceCount,
      lastObservedAt: agentPublicSnapshots.observedAt,
    })
    .from(agentPublicSnapshots)
    .innerJoin(sourceProjectionDecisions, publicDecisionJoinCondition())
    .innerJoin(sourceObservationRuns, approvedRunJoinCondition())
    .innerJoin(ingestionSources, activeSourceJoinCondition())
    .leftJoin(agentReadModel, eq(agentReadModel.agentId, agentPublicSnapshots.agentId))
    .orderBy(desc(agentPublicSnapshots.observedAt));

  // Withdrawals apply before the collapse: a record an operator withheld never
  // reaches the served set, and an unreadable ledger fails the whole read
  // rather than risk exposing it.
  const withdrawn = new Set(await listActiveWithdrawnAgentIds());
  return withRobinhoodNames(db, collapseVisibleSnapshots(snapshots.filter(row => !withdrawn.has(row.agentId))));
}

/**
 * Lays the names read from Robinhood registration links over the placeholders ("Agent #8623") of served records
 * (docs/approvals/2026-10-17-robinhood-names.md). Only the display name changes: the retained observation, the evidence packet
 * and the handle do not. A record that gets a name also carries `nameReadAt`, the day it was read, so a page can say where the
 * name came from. It reads the resolutions table only when a served record has a placeholder and a link to read, and it
 * fails open: a read that cannot be made leaves the records as they were, never a record out of the set.
 */
async function withRobinhoodNames<T extends { agentId: string; displayName: string; untrustedSummary: string | null }>(db: ReturnType<typeof drizzle>, records: T[]): Promise<Array<T & { nameReadAt?: string }>> {
  if (!records.some(record => nameableRecord(record) !== null)) return records;
  try {
    const rows = await db
      .select({ uriHash: agentRegistrationResolutions.uriHash, resolvedName: agentRegistrationResolutions.resolvedName, fetchedAt: agentRegistrationResolutions.fetchedAt })
      .from(agentRegistrationResolutions)
      .innerJoin(ingestionSources, eq(ingestionSources.id, agentRegistrationResolutions.sourceId))
      .where(and(eq(ingestionSources.sourceKey, ROBINHOOD_SOURCE_KEY), eq(agentRegistrationResolutions.status, "resolved")));
    const resolved = new Map<string, ResolvedName>();
    for (const row of rows) if (row.resolvedName) resolved.set(row.uriHash, { name: row.resolvedName, readAt: row.fetchedAt ? row.fetchedAt.toISOString() : null });
    return overlayResolvedNames(records, resolved);
  } catch {
    return records;
  }
}

/**
 * Single-record visibility check using the same rule as listLiveAtlasRecords:
 * visible when the agent has at least one snapshot from a public source linked
 * to that source's approved run AND the agent is not withdrawn. This predicate
 * uses the shared visibilityGateJoins helper so the rules cannot drift apart.
 */
export async function isAgentPubliclyVisible(agentId: string): Promise<boolean> {
  const db = requireDb(await getDb());

  const [snapshot] = await visibilityGateJoins(db)
    .where(eq(agentPublicSnapshots.agentId, agentId))
    .limit(1);

  if (!snapshot) return false;

  const withdrawn = await listActiveWithdrawnAgentIds();
  return !withdrawn.includes(agentId);
}

/** Append-only withdrawal ledger in event order (oldest first). */
export async function listRecordWithdrawalEvents() {
  const db = requireDb(await getDb());
  return db
    .select({
      agentId: agentRecordWithdrawals.agentId,
      action: agentRecordWithdrawals.action,
      reason: agentRecordWithdrawals.reason,
      decidedAt: agentRecordWithdrawals.decidedAt,
    })
    .from(agentRecordWithdrawals)
    .orderBy(asc(agentRecordWithdrawals.id));
}

/**
 * Newest reviewed-run snapshot summary per requested agent. Used by the
 * operator control plane: withdrawn records no longer appear in the served
 * set, so this lookup resolves their display identity from the retained
 * snapshot instead.
 */
export async function listNewestGatedSnapshotSummaries(agentIds: string[]) {
  if (agentIds.length === 0) return [];
  const db = requireDb(await getDb());
  const rows = await db
    .select({
      agentId: agentPublicSnapshots.agentId,
      displayName: agentPublicSnapshots.displayName,
      handle: agentPublicSnapshots.displayHandle,
      observedAt: agentPublicSnapshots.observedAt,
    })
    .from(agentPublicSnapshots)
    .innerJoin(
      sourceProjectionDecisions,
      and(
        eq(sourceProjectionDecisions.sourceId, agentPublicSnapshots.sourceId),
        eq(sourceProjectionDecisions.state, "public"),
        isNotNull(sourceProjectionDecisions.approvedRunId)
      )
    )
    .innerJoin(
      sourceObservationRuns,
      and(
        eq(sourceObservationRuns.runId, sourceProjectionDecisions.approvedRunId),
        eq(sourceObservationRuns.observationId, agentPublicSnapshots.sourceObservationId)
      )
    )
    .where(inArray(agentPublicSnapshots.agentId, agentIds))
    .orderBy(desc(agentPublicSnapshots.observedAt));
  const newestByAgent = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!newestByAgent.has(row.agentId)) newestByAgent.set(row.agentId, row);
  }
  return Array.from(newestByAgent.values());
}

/**
 * Append-only withdrawal decision: records the operator's reason in the ledger
 * and persists a matching evidence event against the record's newest
 * reviewed-run observation. The source, its approved run, and all retained
 * evidence remain untouched; the read path re-resolves visibility from the
 * newest ledger event, so a reinstate restores the record.
 */
export async function decideRecordWithdrawal(input: {
  agentId: string;
  action: "withdraw" | "reinstate";
  reason: string;
  decidedByUserId: number;
}) {
  const db = requireDb(await getDb());
  const now = new Date();
  return db.transaction(async tx => {
    const [newest] = await tx
      .select({ observationId: agentPublicSnapshots.sourceObservationId })
      .from(agentPublicSnapshots)
      .innerJoin(
        sourceProjectionDecisions,
        and(
          eq(sourceProjectionDecisions.sourceId, agentPublicSnapshots.sourceId),
          eq(sourceProjectionDecisions.state, "public"),
          isNotNull(sourceProjectionDecisions.approvedRunId)
        )
      )
      .innerJoin(
        sourceObservationRuns,
        and(
          eq(sourceObservationRuns.runId, sourceProjectionDecisions.approvedRunId),
          eq(sourceObservationRuns.observationId, agentPublicSnapshots.sourceObservationId)
        )
      )
      .where(eq(agentPublicSnapshots.agentId, input.agentId))
      .orderBy(desc(agentPublicSnapshots.observedAt))
      .limit(1);
    if (!newest) {
      throw new Error("No reviewed-run observation exists for this record; withdrawal applies only to records under the served gate.");
    }
    await tx.insert(agentRecordWithdrawals).values({
      agentId: input.agentId,
      action: input.action,
      reason: input.reason,
      decidedByUserId: input.decidedByUserId,
      decidedAt: now,
    });
    await tx.insert(evidenceEvents).values({
      id: randomUUID(),
      agentId: input.agentId,
      sourceObservationId: newest.observationId,
      eventType: input.action === "withdraw" ? "RECORD_WITHDRAWN" : "RECORD_REINSTATED",
      description:
        input.action === "withdraw"
          ? `Record withdrawn from the public census by an operator: ${input.reason} The source, its approved run, and retained evidence are unchanged.`
          : `Record reinstated to the public census by an operator: ${input.reason} Visibility re-resolves through the reviewed-run gate.`,
      proofReference: "nooscape-census-governance",
      payloadHash: hashValue(`${input.agentId}\n${input.action}\n${input.reason}`),
      observedAt: now,
    });
    return { agentId: input.agentId, action: input.action } as const;
  });
}

/**
 * Newest card among rows visible under the reviewed-run gate — the exact card
 * domain verification pins: what an operator can see is what gets verified,
 * and a later approved card change breaks the pin until the operator rechecks.
 */
export async function getNewestVisibleSnapshotCard(agentId: string) {
  const db = requireDb(await getDb());
  const [card] = await db
    .select({
      displayName: agentPublicSnapshots.displayName,
      primaryCapability: agentPublicSnapshots.primaryCapability,
      summary: agentPublicSnapshots.untrustedSelfDescription,
      protocols: agentPublicSnapshots.protocols,
    })
    .from(agentPublicSnapshots)
    .innerJoin(sourceProjectionDecisions, publicDecisionJoinCondition())
    .innerJoin(sourceObservationRuns, approvedRunJoinCondition())
    .innerJoin(ingestionSources, activeSourceJoinCondition())
    .where(eq(agentPublicSnapshots.agentId, agentId))
    .orderBy(desc(agentPublicSnapshots.observedAt))
    .limit(1);
  return card ?? null;
}

/**
 * Computes a public-safe coverage summary without exposing raw-object keys or
 * evidence payloads. A record is provenance-ready only when its approved
 * source-scoped snapshot has at least one persisted evidence event for the
 * exact retained observation.
 */
export async function getLiveAtlasProvenanceCoverage() {
  const db = requireDb(await getDb());
  const rows = await db
    .select({
      agentId: agentPublicSnapshots.agentId,
      evidenceEventId: evidenceEvents.id,
    })
    .from(agentPublicSnapshots)
    .innerJoin(sourceProjectionDecisions, publicDecisionJoinCondition())
    .innerJoin(sourceObservationRuns, approvedRunJoinCondition())
    .innerJoin(ingestionSources, activeSourceJoinCondition())
    .leftJoin(
      evidenceEvents,
      and(
        eq(evidenceEvents.agentId, agentPublicSnapshots.agentId),
        eq(evidenceEvents.sourceObservationId, agentPublicSnapshots.sourceObservationId)
      )
    );

  // Coverage mirrors the served set: withdrawn records are excluded exactly as
  // in listLiveAtlasRecords so the public counts stay reconciled.
  const withdrawn = new Set(await listActiveWithdrawnAgentIds());
  const coverageByAgent = new Map<string, boolean>();
  for (const row of rows) {
    if (withdrawn.has(row.agentId)) continue;
    coverageByAgent.set(row.agentId, Boolean(coverageByAgent.get(row.agentId) || row.evidenceEventId));
  }
  const publicRecordCount = coverageByAgent.size;
  const provenanceReadyCount = Array.from(coverageByAgent.values()).filter(Boolean).length;
  return {
    publicRecordCount,
    provenanceReadyCount,
    coveragePercent: publicRecordCount === 0 ? 0 : Math.round((provenanceReadyCount / publicRecordCount) * 100),
  } as const;
}

/**
 * Returns public provenance references for a persisted record. Raw object bytes
 * remain private in RustFS; callers receive only their stable digest and locator.
 * Entries bind to the reviewed-run gate — only events whose observation belongs
 * to an approved run of a currently-active source with a public projection
 * decision are pulled, and operator withdrawal notices are excluded, so an
 * envelope never carries unapproved-run events or operator reasons.
 */
export async function listPersistedEvidenceEntries(agentId: string) {
  const db = requireDb(await getDb());
  return db
    .select({
      id: evidenceEvents.id,
      observedAt: evidenceEvents.observedAt,
      event: evidenceEvents.eventType,
      detail: evidenceEvents.description,
      proofReference: evidenceEvents.proofReference,
      payloadHash: evidenceEvents.payloadHash,
      observationId: sourceObservations.id,
      contentHash: sourceObservations.contentHash,
      canonicalLocator: sourceObservations.canonicalLocator,
      protocol: sourceObservations.protocol,
      validationStatus: sourceObservations.validationStatus,
      sourceLabel: ingestionSources.label,
      sourceRoot: ingestionSources.rootUrl,
    })
    .from(evidenceEvents)
    .innerJoin(sourceObservations, eq(evidenceEvents.sourceObservationId, sourceObservations.id))
    .innerJoin(ingestionSources, and(eq(sourceObservations.sourceId, ingestionSources.id), eq(ingestionSources.state, "active")))
    .innerJoin(
      sourceProjectionDecisions,
      and(
        eq(sourceProjectionDecisions.sourceId, sourceObservations.sourceId),
        eq(sourceProjectionDecisions.state, "public"),
        isNotNull(sourceProjectionDecisions.approvedRunId)
      )
    )
    .innerJoin(
      sourceObservationRuns,
      and(
        eq(sourceObservationRuns.runId, sourceProjectionDecisions.approvedRunId),
        eq(sourceObservationRuns.observationId, evidenceEvents.sourceObservationId)
      )
    )
    .where(and(eq(evidenceEvents.agentId, agentId), notInArray(evidenceEvents.eventType, [...WITHDRAWAL_EVENT_TYPES])))
    .orderBy(desc(evidenceEvents.observedAt));
}

export async function getPublisherPolicyForIdentity(identityId: string) {
  const db = requireDb(await getDb());
  return db
    .select({
      publisherKeyId: publisherKeys.id,
      issuerName: publisherKeys.issuerName,
      state: publisherKeys.state,
      bindingId: publisherBindings.id,
    })
    .from(publisherBindings)
    .innerJoin(publisherKeys, eq(publisherBindings.publisherKeyId, publisherKeys.id))
    .where(eq(publisherBindings.agentIdentityId, identityId));
}

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
    throw new Error("Domain verification can only target a domain already asserted by this agent.");
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
  if (!challenge) throw new Error("Domain verification challenge not found.");
  if (challenge.state !== "pending" || challenge.expiresAt <= new Date()) {
    throw new Error("Domain verification challenge is no longer pending.");
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
  if (relevantIdentities.length === 0) throw new Error("No matching asserted identity exists for this domain.");

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
  if (!challenge) throw new Error("Domain verification challenge not found.");
  if (challenge.state !== "verified" || challenge.revokedAt) {
    throw new Error("Only an active verified challenge can be rechecked.");
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
  if (!latestObservationId) throw new Error("No asserted identity exists for this agent.");

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
  tickSeconds: number;
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
        lte(ingestionSources.nextRunAt, now)
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
  if (!identity) throw new Error("Agent identity was not found.");
  if (identity.verificationState !== "verified") {
    throw new Error("Publisher-key validation requires a domain-verified agent identity.");
  }
  let assertedDomain: string;
  try {
    assertedDomain = new URL(identity.externalId).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    throw new Error("Publisher-key validation requires an HTTPS URL identity.");
  }
  if (!input.proof.permittedDomains.includes(assertedDomain)) {
    throw new Error("Publisher-key policy must permit the agent identity's verified domain.");
  }

  if (input.rotationOfKeyId) {
    const [previous] = await db
      .select()
      .from(publisherKeys)
      .where(eq(publisherKeys.id, input.rotationOfKeyId))
      .limit(1);
    if (!previous || previous.state !== "allowlisted") throw new Error("Publisher key rotation requires an active prior key.");
    if (previous.issuerName !== input.proof.issuerName) throw new Error("Publisher key rotation must retain the same issuer name.");
    const priorDomains = parseStringArray(previous.permittedDomains);
    const priorProtocols = parseStringArray(previous.permittedProtocols);
    if (!input.proof.permittedDomains.every(domain => priorDomains.includes(domain))) {
      throw new Error("Publisher key rotation may not expand permitted domains.");
    }
    if (!input.proof.permittedProtocols.every(protocol => priorProtocols.includes(protocol))) {
      throw new Error("Publisher key rotation may not expand permitted protocols.");
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

async function refreshAgentPublisherReadModel(db: ReturnType<typeof drizzle>, agentId: string) {
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
  const allowlistedExpiries = rows.filter((row, index) => states[index] === "allowlisted").map(row => row.expiresAt);
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
  if (!key) throw new Error("Publisher key proposal was not found.");
  if (key.state !== "pending") throw new Error("Only pending publisher key proposals can be approved.");
  if (key.createdByUserId === input.decidedByUserId) {
    throw new Error("Publisher-key approval requires an operator other than the proposal creator.");
  }
  if (key.expiresAt && key.expiresAt <= new Date()) throw new Error("Expired publisher key proposals cannot be approved.");

  const bindings = await db
    .select({ agentId: agentIdentities.agentId, sourceObservationId: publisherBindings.sourceObservationId })
    .from(publisherBindings)
    .innerJoin(agentIdentities, eq(publisherBindings.agentIdentityId, agentIdentities.id))
    .where(eq(publisherBindings.publisherKeyId, key.id));
  if (bindings.length === 0) throw new Error("Publisher key proposal had no identity binding.");
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
  });
  for (const binding of bindings) await refreshAgentPublisherReadModel(db, binding.agentId);
  return { keyId: key.id, state: "allowlisted" as const, agentIds: bindings.map(binding => binding.agentId) };
}

export async function revokePublisherKeyPolicy(input: { keyId: string; decidedByUserId: number; rationale: string }) {
  const db = requireDb(await getDb());
  const [key] = await db.select().from(publisherKeys).where(eq(publisherKeys.id, input.keyId)).limit(1);
  if (!key) throw new Error("Publisher key was not found.");
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
  });
  for (const binding of bindings) await refreshAgentPublisherReadModel(db, binding.agentId);
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
