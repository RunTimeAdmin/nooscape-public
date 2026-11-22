/** The chain activity feeds and totals: registry events, Solana activity and USDG settlements. Part of server/db.ts, which re-exports every module of this folder. */
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { agentDirectoryChainActivity, agentDirectoryEntries, agentDirectoryUsdgSettlements, agentSolanaActivity, ingestionSources, IngestionSource } from "../../drizzle/schema";
import { ROBINHOOD_HANDOUT_BLOCK_WINDOW } from "../ingestion/robinhood";
import { evmIdentityChain } from "../ingestion/evmIdentityChains";
import { publicDisplayName } from "../publicText";
import { balancedNewest } from "@shared/balancedNewest";
import { cachedDirectoryRead } from "../readCache";
import { activeSourceCondition, getDb, requireDb } from "./core";
import { directoryVisibilityCondition, sanitizeDirectoryEntry } from "./directoryVisibility";

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
 * The ids of one protocol's active sources: a handful of rows. The ledger reads below name them, because the ledger holds every chain's
 * events (about 450,000 rows) and a read that names no source is planned from the sources table outward and walks all of them, then
 * drops the other chains' rows at the entry join. Naming the source lets the (sourceId, externalKey) index bound the walk to one chain.
 */
async function activeSourceIdsOf(db: ReturnType<typeof drizzle>, protocol: IngestionSource["protocol"]): Promise<string[]> {
  const rows = await db.select({ id: ingestionSources.id }).from(ingestionSources).where(and(eq(ingestionSources.protocol, protocol), eq(ingestionSources.state, "active")));
  return rows.map(row => row.id);
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

type DirectoryActivityFeedEvent = {
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

/** The chains whose own page has a feed beside Robinhood Chain's. Arc only. */
export type ChainFeedProtocol = "erc8004_arc";

/** The uncached scan behind {@link readAgentDirectoryActivityFeed} and {@link readChainActivityFeed}; only their cache wrappers call it. Robinhood Chain's unless a chain is named. */
async function readAgentDirectoryActivityFeedUncached(limit = MAX_AGENT_DIRECTORY_FEED_EVENTS, protocol: "erc8004" | ChainFeedProtocol = "erc8004") {
  const db = requireDb(await getDb());
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit) || MAX_AGENT_DIRECTORY_FEED_EVENTS, MAX_AGENT_DIRECTORY_FEED_EVENTS));
  const sourceIds = await activeSourceIdsOf(db, protocol);
  if (sourceIds.length === 0) return [];
  // A hand-out is a block count, which differs by chain: each chain reads its own mint hour.
  const handoutWindow = evmIdentityChain(protocol)?.handoutBlockWindow ?? ROBINHOOD_HANDOUT_BLOCK_WINDOW;
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
    .where(and(inArray(agentDirectoryChainActivity.sourceId, sourceIds), directoryVisibilityCondition(), eq(agentDirectoryEntries.protocol, protocol)))
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
    isHandout: isHandoutEvent(row.kind, Number(row.blockNumber), row.fromAddress, anchors.get(directoryActivityAnchorKey(row.sourceId, row.externalKey)), handoutWindow),
    entryId: row.entryId,
    displayName: publicDisplayName(row.displayName, row.externalKey),
  }));
}

/**
 * The newest measured identity events of one chain other than Robinhood Chain, for the rail on its own page: the same read as
 * Robinhood Chain's feed, scoped to the chain's protocol and to its own mint hour, with the block the chain's ledger is measured
 * through. Only events of the entries the directory lists, under the shared visibility rule: a registration the listing rules hold
 * out has events in the ledger and is never named here (docs/arc-feed-2026-11-02.md). Names go through the same clean-up as the
 * listed sample's. Empty, with no block, while no source of the chain is active.
 */
export function readChainActivityFeed(protocol: ChainFeedProtocol, limit = MAX_AGENT_DIRECTORY_FEED_EVENTS) {
  return cachedDirectoryRead(`directory:chain-activity-feed:${protocol}:${limit}`, async () => {
    const [feed, measuredThroughBlock] = await Promise.all([readAgentDirectoryActivityFeedUncached(limit, protocol), readChainActivityHighWater(protocol)]);
    return { feed: feed.map(event => sanitizeDirectoryEntry(event)), measuredThroughBlock };
  });
}

/** The highest block among the events the chain's active sources have recorded: the same fact "measured through block N" derives from for Robinhood Chain. Null when there is none. */
async function readChainActivityHighWater(protocol: ChainFeedProtocol): Promise<number | null> {
  const db = requireDb(await getDb());
  const sourceIds = await activeSourceIdsOf(db, protocol);
  if (sourceIds.length === 0) return null;
  const [row] = await db
    .select({ highWater: sql<number>`max(${agentDirectoryChainActivity.blockNumber})` })
    .from(agentDirectoryChainActivity)
    .where(inArray(agentDirectoryChainActivity.sourceId, sourceIds));
  return row?.highWater === null || row?.highWater === undefined ? null : Number(row.highWater);
}

type DirectoryActivityDayCounts = {
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
  const sourceIds = await activeSourceIdsOf(db, "erc8004");
  if (sourceIds.length === 0) return [];
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
    .where(and(inArray(agentDirectoryChainActivity.sourceId, sourceIds), directoryVisibilityCondition(), eq(agentDirectoryEntries.protocol, "erc8004")))
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
      inArray(agentDirectoryChainActivity.sourceId, sourceIds),
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

/**
 * The Solana registries whose passes write the activity ledger, which are the registries the feed reads. The AgenC pass writes none (docs/
 * agenc-solana-2026-10-26.md), so it has no events to show and takes no share of the floor: the floor is split across this list, not across
 * every protocol that is on Solana. A registry that later gets a ledger is added here on purpose.
 */
const SOLANA_FEED_PROTOCOLS = ["solana_registry", "solana_8004", "solana_said"] as const;

/** The uncached read behind {@link readSolanaActivityFeed}; only the cache wrapper calls it. */
async function readSolanaActivityFeedUncached(limit: number) {
  const db = requireDb(await getDb());
  type SolanaProtocol = (typeof agentDirectoryEntries.protocol.enumValues)[number];
  const protocols: SolanaProtocol[] = [...SOLANA_FEED_PROTOCOLS];
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
 *
 * Cached like the other directory aggregates (the warm-up reads it too): the one writer,
 * applyUsdgSettlementWindow, marks it stale, and an operator pausing or rejecting the source
 * drops it with the rest.
 */
export function readUsdgSettlementTotals() {
  return cachedDirectoryRead("directory:usdg-totals", () => readUsdgSettlementTotalsUncached());
}

/** The uncached read behind {@link readUsdgSettlementTotals}; only the cache wrapper calls it. */
async function readUsdgSettlementTotalsUncached() {
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
