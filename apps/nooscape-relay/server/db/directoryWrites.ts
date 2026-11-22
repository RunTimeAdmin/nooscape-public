/** What the passes write into the directory: entries, resolutions, chain links and the activity, settlement and reputation windows. Part of server/db.ts, which re-exports every module of this folder. */
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentDirectoryChainActivity, agentDirectoryChainLinks, agentDirectoryEntries, agentDirectoryUsdgSettlements, agentRegistrationResolutions, agentReputationEvents, agentSolanaActivity, IngestionSource } from "../../drizzle/schema";
import { ROBINHOOD_HANDOUT_BLOCK_WINDOW } from "../ingestion/robinhood";
import { type DirectoryChainActivityEvent, type DirectoryEntryDraft, type Erc8004ReputationEvent, type SolanaChainActivityEvent, type UsdgSettlementEvent } from "../ingestion/types";
import { invalidateDirectoryReadsSoftly } from "../readCache";
import { getDb, requireDb, withInvalidation } from "./core";
import { isSuppressedLocatorHost } from "./directoryVisibility";

/**
 * Upserts master-directory acknowledgements for one source run. Entries are
 * locator-class facts keyed by the source's own external key; repeated
 * observations refresh the display fields and seen dates but never create
 * trust, tiers, or map placement. Directory state is fully outside the
 * reviewed-run gate that governs public records.
 */
export const upsertAgentDirectoryEntries = withInvalidation(upsertAgentDirectoryEntriesImpl, invalidateDirectoryReadsSoftly);

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
export const markAgentDirectoryEntriesClosed = withInvalidation(markAgentDirectoryEntriesClosedImpl, invalidateDirectoryReadsSoftly);

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
export const applyAgentDirectoryActivityWindow = withInvalidation(applyAgentDirectoryActivityWindowImpl, invalidateDirectoryReadsSoftly);

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
export const applySolanaActivityWindow = withInvalidation(applySolanaActivityWindowImpl, invalidateDirectoryReadsSoftly);

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
export const applyUsdgSettlementWindow = withInvalidation(applyUsdgSettlementWindowImpl, invalidateDirectoryReadsSoftly);

async function applyUsdgSettlementWindowImpl(input: {
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
export const applyAgentDirectoryReputationWindow = withInvalidation(applyAgentDirectoryReputationWindowImpl, invalidateDirectoryReadsSoftly);

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
