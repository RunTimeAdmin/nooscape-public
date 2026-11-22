/** The directory's public reads: entries, counts, chain stats, samples and the facts an agent page and the check read. Part of server/db.ts, which re-exports every module of this folder. */
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, max, notInArray, sql } from "drizzle-orm";
import { agentDirectoryChainActivity, chainReputationCounts, agentDirectoryChainLinks, agentDirectoryListingPins, agentDirectoryEntries, agentReputationEvents, agentSolanaActivity, bscEntryEvidence, evidenceEvents, ingestionSources, sourceObservationRuns, sourceObservations, sourceProjectionDecisions } from "../../drizzle/schema";
import { isMissingTable, noteSectionFailure } from "../driverErrors";
import { evmIdentityChain } from "../ingestion/evmIdentityChains";
import { BSC_NOT_CHECKED, registrationReadOf, type BscRegistrationRead } from "../bscRegistrationRead";
import { publicDisplayName, sanitizePublicText } from "../publicText";
import { buildArrivals, ARRIVALS_NEWEST_PER_CHAIN, ARRIVALS_WINDOW_HOURS, type Arrivals } from "@shared/arrivals";
import { buildChainStats, buildExtraChainStats, CHAINS, extraChainsOn, extraProtocolOf, listedChainOf, parseProtocolList, protocolsOf, type ChainStat, type ChainStatsInput, type ExtraChainKey, type ExtraChainStat, type RegistryProfile } from "@shared/chains";
import { buildNoosphereSample, MAX_FLEETS, MAX_LIGHTS, NOOSPHERE_PROTOCOLS, sampleModulus, type NoosphereSample } from "@shared/noosphere";
import { cachedDirectoryRead } from "../readCache";
import { type AgentDirectoryEntryRatings, computeRatingsSummary, parseReputationExternalKey, REPUTATION_KEY_PREFIX } from "../ratingsSurface";
import { getDb, requireDb } from "./core";
import { listPublicIngestionSourceStatuses } from "./sources";
import { agentDirectoryRelatedCounts, directoryVisibilityCondition, sanitizeDirectoryEntry } from "./directoryVisibility";
import { WITHDRAWAL_EVENT_TYPES, listLiveAtlasRecords } from "./publicRecords";

/** Bound on chain-activity events returned for one entry page; the append-only ledger keeps every event. */
export const MAX_AGENT_ENTRY_ACTIVITY_EVENTS = 24;

/** Bound on reputation-ledger rows returned for one entry page (census average ≈ 2/agent; the ledger keeps every event). An agent with more has the oldest shown and the summary says so (`truncated`). */
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

/** The longest note a pin can carry (the column's width); the same bound goes on what is served. */
const PIN_NOTE_MAX = 300;

/**
 * An operator pin on the registration this entry was published from (migration 0056; docs/pin-disclosure-2026-11-05.md): the entry is listed
 * because the operator decided so, and the page and the API say that, with the date and the operator's note. Null when there is no pin, and
 * when the pins table cannot be read.
 */
type AgentDirectoryEntryPin = { pinnedAt: Date; note: string | null };

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
 * The two facts a page head names for a visible directory entry: what it is called and which protocol it is on. One row by key, under the
 * same visibility rule as the full read. The full read behind the page is up to thirteen queries; a crawler or a shared link asking for
 * the page's head needs none of them.
 */
export async function readAgentDirectoryHeadFacts(id: string): Promise<{ displayName: string; protocol: string } | null> {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ displayName: agentDirectoryEntries.displayName, protocol: agentDirectoryEntries.protocol })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(eq(agentDirectoryEntries.id, id), directoryVisibilityCondition()))
    .limit(1);
  return row ?? null;
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
  } catch (error) {
    // A table or column that is not there (migration 0013 not run on this database) leaves the section unmeasured, quietly; any other failure is logged.
    noteSectionFailure("Entry activity", error);
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
            externalKey: agentDirectoryEntries.externalKey,
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
            displayName: publicDisplayName(twinRow.displayName, twinRow.externalKey),
            protocol: twinRow.protocol,
            linkedProtocol: link.linkedProtocol,
            metadataKey: link.metadataKey,
            linkedExternalKey: link.linkedExternalKey,
          };
        }
      }
    }
  } catch (error) {
    // As above, for migration 0028.
    noteSectionFailure("Entry twin", error);
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
        const rows = await db
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
          .limit(MAX_AGENT_ENTRY_RATING_EVENTS + 1);
        // One row past the page says whether the agent has more events than the page shows.
        const truncated = rows.length > MAX_AGENT_ENTRY_RATING_EVENTS;
        ratings = computeRatingsSummary(truncated ? rows.slice(0, MAX_AGENT_ENTRY_RATING_EVENTS) : rows, await readAgentDirectoryReputationHighWater(source.id), truncated);
      }
    }
  } catch (error) {
    // A ledger that is not there leaves the ratings unmeasured, quietly; any other failure is logged.
    noteSectionFailure("Entry ratings", error);
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
      if (isMissingTable(error)) registrationRead = BSC_NOT_CHECKED;
      else noteSectionFailure("Entry registration read", error);
    }
  }
  // An operator pin on this entry's registration. The table comes with the boot runner (migration 0056); until it is there, or if it cannot be
  // read, the section is null and the entry reads as it did, quietly for a missing table and logged for any other failure.
  let pin: AgentDirectoryEntryPin | null = null;
  try {
    const [pinned] = await db
      .select({ pinnedAt: agentDirectoryListingPins.pinnedAt, note: agentDirectoryListingPins.note })
      .from(agentDirectoryListingPins)
      .where(and(eq(agentDirectoryListingPins.sourceId, selected.sourceId), eq(agentDirectoryListingPins.externalKey, selected.externalKey)))
      .limit(1);
    if (pinned) pin = { pinnedAt: pinned.pinnedAt, note: sanitizePublicText(pinned.note, PIN_NOTE_MAX) };
  } catch (error) {
    if (!isMissingTable(error)) noteSectionFailure("Entry pin", error);
  }
  return sanitizeDirectoryEntry({
    ...row,
    displayName: publicDisplayName(row.displayName, selected.externalKey),
    related,
    activity,
    twin,
    ratings,
    pin,
    ...(row.protocol === "erc8004_bsc" ? { registrationRead } : {}),
  });
}

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
function countRobinhoodFeedbackEvents() {
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
      externalKey: agentDirectoryEntries.externalKey,
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
      .map(row => ({ chain, id: row.id, displayName: publicDisplayName(row.displayName, row.externalKey), firstSeenAt: row.firstSeenAt })),
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
const MAP_ACKNOWLEDGED_LIMIT = 30;

/**
 * A fixed sample of the registrations the directory lists for one chain's protocol, for the home map, with how many it
 * lists in all. The sample is the entries whose id hashes lowest: the same set on every read until the listing itself
 * changes, picked by a rule that looks at nothing about an agent but its id. Visibility is the directory's own, as in
 * every public directory read: nothing hidden, closed, on a suppressed host or from an inactive source. These are
 * acknowledged entries and never reviewed records; the map draws them as such (docs/approvals/2026-10-15-informational-use-and-bnb-map.md).
 */
export function listMapAcknowledgedSample(protocol: "erc8004_bsc" | "erc8004_arc" | "solana_agenc", limit: number = MAP_ACKNOWLEDGED_LIMIT) {
  return cachedDirectoryRead(`directory:map-acknowledged:${protocol}:${limit}`, async () => {
    const db = requireDb(await getDb());
    const visible = and(eq(ingestionSources.protocol, protocol), directoryVisibilityCondition());
    const [rows, counted] = await Promise.all([
      db
        .select({ id: agentDirectoryEntries.id, externalKey: agentDirectoryEntries.externalKey, displayName: agentDirectoryEntries.displayName, locatorHost: agentDirectoryEntries.locatorHost })
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
      entries: rows.map(row => sanitizeDirectoryEntry({ id: row.id, displayName: publicDisplayName(row.displayName, row.externalKey), locatorHost: row.locatorHost, protocol })),
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
    .select({ id: agentDirectoryEntries.id, externalKey: agentDirectoryEntries.externalKey, displayName: agentDirectoryEntries.displayName })
    .from(agentDirectoryEntries)
    .innerJoin(ingestionSources, eq(agentDirectoryEntries.sourceId, ingestionSources.id))
    .where(and(inArray(agentDirectoryEntries.id, [...ids]), directoryVisibilityCondition()));
  return new Map(rows.map(row => [row.id, publicDisplayName(row.displayName, row.externalKey)] as [string, string]));
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
    } catch (error) {
      // The activity ledger is not there yet: not measured, quietly. Any other failure is logged.
      noteSectionFailure("Check facts activity ledger", error);
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
    } catch (error) {
      // The Solana ledger is not there yet: not measured, quietly. Any other failure is logged.
      noteSectionFailure("Check facts Solana ledger", error);
    }
  }
  return { activityThroughBlock, solana };
}
