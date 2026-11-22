import { and, eq, inArray, sql } from "drizzle-orm";
import { CENSUS_SOURCE, SOLANA_CENSUS_REGISTRIES, solanaFigureKey, type CensusChain, type CensusToday } from "@shared/censusToday";
import {
  agentDirectoryEntries,
  agentDirectoryRegistryOverflow,
  agentDirectoryRegistryRows,
  bscFeedbackEvents,
  bscReputationState,
  chainReputationCounts,
  ingestionSources,
  type IngestionSource,
} from "../drizzle/schema";
import { EMPTY_URI_SHA256, REGISTRY_LISTING } from "./agentRegistryRows";
import { directoryVisibilityCondition, getDb, requireDb } from "./db";
import { isMissingTable } from "./driverErrors";
import { cachedDirectoryRead } from "./readCache";

const count = (value: unknown) => Number(value ?? 0);

/**
 * The counts of a registry census page's first table, as the directory holds them now. Each is the count the report's queries make
 * (docs/monad-census-queries-2026-11-01.sql, Q0, Q0b and Q1), so a figure here and the report's figure differ only because the
 * registry has moved. Every one is a count over an indexed column of one source's rows: no name, wallet, host or link is read out.
 * Null while the chain's source is not active. Cached like the other directory aggregates and dropped by every refresh.
 */
export function readCensusToday(chain: CensusChain): Promise<CensusToday | null> {
  return cachedDirectoryRead(`directory:census-today:${chain}`, async () => {
    const censusSource = CENSUS_SOURCE[chain];
    const db = requireDb(await getDb());
    if (censusSource.kind === "solana") return readSolanaCensusToday(db);
    if (censusSource.kind === "bsc_ratings") return readBscRatingsToday(db);
    const { kind, protocol, ratingsKey } = censusSource;
    const [source] = await db
      .select({ id: ingestionSources.id, lastSuccessfulAt: ingestionSources.lastSuccessfulAt })
      .from(ingestionSources)
      .where(and(eq(ingestionSources.protocol, protocol as IngestionSource["protocol"]), eq(ingestionSources.state, "active")))
      .limit(1);
    if (!source) return null;
    const asOf = source.lastSuccessfulAt ? source.lastSuccessfulAt.toISOString() : null;

    const entries = agentDirectoryEntries;
    const [listedRow] = await db
      .select({ total: sql<number>`count(*)` })
      .from(entries)
      .where(and(eq(entries.sourceId, source.id), eq(entries.hidden, false)));
    const listed = count(listedRow?.total);

    if (kind === "entries") {
      const [shape] = await db
        .select({
          wallets: sql<number>`count(distinct ${entries.registrant})`,
          withHttpsHost: sql<number>`count(${entries.locatorHost})`,
          hosts: sql<number>`count(distinct ${entries.locatorHost})`,
        })
        .from(entries)
        .where(and(eq(entries.sourceId, source.id), eq(entries.hidden, false)));
      return {
        chain,
        asOf,
        figures: { listed, wallets: count(shape?.wallets), withHttpsHost: count(shape?.withHttpsHost), hosts: count(shape?.hosts) },
        heldOut: null,
        ratings: null,
      };
    }

    const rows = agentDirectoryRegistryRows;
    const states = await db.select({ listing: rows.listing, total: sql<number>`count(*)` }).from(rows).where(eq(rows.sourceId, source.id)).groupBy(rows.listing);
    const stateCount = (listing: number) => count(states.find(row => row.listing === listing)?.total);
    const stored = states.reduce((sum, row) => sum + count(row.total), 0);
    // One statement each, so each is a scan of one index of the source's rows.
    const [wallets] = await db.select({ total: sql<number>`count(distinct ${rows.registrant})` }).from(rows).where(eq(rows.sourceId, source.id));
    const [hostCounts] = await db
      .select({ withHttpsHost: sql<number>`count(${rows.locatorHost})`, hosts: sql<number>`count(distinct ${rows.locatorHost})` })
      .from(rows)
      .where(eq(rows.sourceId, source.id));
    // A registration that set no link records the hash of the empty text. That is not a link, and the reports' tables leave it out of this count, so the block does too.
    const [links] = await db
      .select({ total: sql<number>`count(distinct ${rows.profileUriHash})` })
      .from(rows)
      .where(and(eq(rows.sourceId, source.id), sql`${rows.profileUriHash} <> ${EMPTY_URI_SHA256}`));
    // The registrations a host's cap counted and did not store.
    const [overflowRow] = await db
      .select({ total: sql<number>`coalesce(sum(${agentDirectoryRegistryOverflow.overflowCount}), 0)` })
      .from(agentDirectoryRegistryOverflow)
      .where(eq(agentDirectoryRegistryOverflow.sourceId, source.id));
    const overflow = count(overflowRow?.total);

    let ratings: number | null = null;
    if (ratingsKey) {
      try {
        const [counted] = await db
          .select({ ratings: chainReputationCounts.ratings, caughtUpAt: chainReputationCounts.caughtUpAt })
          .from(chainReputationCounts)
          .where(eq(chainReputationCounts.chainKey, ratingsKey))
          .limit(1);
        // A count that has not read the whole history is a part of it, and a part is not shown.
        ratings = counted?.caughtUpAt ? count(counted.ratings) : null;
      } catch {
        // The ratings are a line of the block, not the block.
      }
    }

    return {
      chain,
      asOf,
      figures: {
        onChain: stored + overflow,
        stored,
        overflow,
        listed,
        wallets: count(wallets?.total),
        withHttpsHost: count(hostCounts?.withHttpsHost),
        hosts: count(hostCounts?.hosts),
        profileLinks: count(links?.total),
      },
      heldOut: {
        noLink: stateCount(REGISTRY_LISTING.NO_LINK),
        grouped: stateCount(REGISTRY_LISTING.GROUPED),
        numericName: stateCount(REGISTRY_LISTING.NUMERIC_NAME),
        pending: stateCount(REGISTRY_LISTING.PENDING),
      },
      ratings,
    };
  });
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * The Solana census's first table as the directory holds it now: for each of its three registries, the visible entries, their wallets,
 * their different links, those with an https link and the host names, counted as its query 1 counted them
 * (docs/solana-census-queries-2026-10-18.sql): visible as every directory read sees it (directoryVisibilityCondition). A registry whose
 * source is not active has no line. The time is the earliest of the three last passes, so every count is at least that recent.
 */
async function readSolanaCensusToday(db: Db): Promise<CensusToday | null> {
  const entries = agentDirectoryEntries;
  const sources = await db
    .select({ protocol: ingestionSources.protocol, lastSuccessfulAt: ingestionSources.lastSuccessfulAt })
    .from(ingestionSources)
    .where(and(inArray(ingestionSources.protocol, [...SOLANA_CENSUS_REGISTRIES]), eq(ingestionSources.state, "active")));
  if (sources.length === 0) return null;
  const rows = await db
    .select({
      protocol: entries.protocol,
      entries: sql<number>`count(*)`,
      wallets: sql<number>`count(distinct ${entries.registrant})`,
      distinctLinks: sql<number>`count(distinct ${entries.profileUriHash})`,
      withHttpsHost: sql<number>`count(${entries.locatorHost})`,
      hosts: sql<number>`count(distinct ${entries.locatorHost})`,
    })
    .from(entries)
    .innerJoin(ingestionSources, eq(entries.sourceId, ingestionSources.id))
    .where(and(directoryVisibilityCondition(), inArray(entries.protocol, [...SOLANA_CENSUS_REGISTRIES])))
    .groupBy(entries.protocol);
  const figures: Record<string, number> = {};
  for (const registry of SOLANA_CENSUS_REGISTRIES) {
    if (!sources.some(source => source.protocol === registry)) continue;
    const row = rows.find(candidate => candidate.protocol === registry);
    figures[solanaFigureKey(registry, "entries")] = count(row?.entries);
    figures[solanaFigureKey(registry, "wallets")] = count(row?.wallets);
    figures[solanaFigureKey(registry, "distinctLinks")] = count(row?.distinctLinks);
    figures[solanaFigureKey(registry, "withHttpsHost")] = count(row?.withHttpsHost);
    figures[solanaFigureKey(registry, "hosts")] = count(row?.hosts);
  }
  const passes = sources.map(source => source.lastSuccessfulAt?.getTime() ?? null);
  const asOf = passes.some(time => time === null) ? null : new Date(Math.min(...(passes as number[]))).toISOString();
  return { chain: "solana", asOf, figures, heldOut: null, ratings: null };
}

/**
 * The BNB Chain rating census's ledger as it stands now, counted from the events the rater step keeps (bsc_feedback_events) the way the
 * report counted them (server/bscRaters.ts, liveFeedback): every event, the ratings sent and the revocations, the ratings that stand (a
 * rating its own revocation has not removed), the wallets that sent a rating, the wallets with a rating that stands, and the agents with
 * a rating that stands. Null before the ledger holds an event. The time is when the rater step last wrote its state.
 */
async function readBscRatingsToday(db: Db): Promise<CensusToday | null> {
  try {
    return await countBscRatings(db);
  } catch (error) {
    // The ledger's tables come with a migration pasted by hand (0039); before it there is nothing to count, and that is not a fault.
    if (isMissingTable(error)) return null;
    throw error;
  }
}

async function countBscRatings(db: Db): Promise<CensusToday | null> {
  const events = bscFeedbackEvents;
  const [totals] = await db
    .select({
      events: sql<number>`count(*)`,
      ratingsSent: sql<number>`coalesce(sum(${events.kind} = 'feedback'), 0)`,
      revocations: sql<number>`coalesce(sum(${events.kind} = 'revoked'), 0)`,
      senders: sql<number>`count(distinct case when ${events.kind} = 'feedback' then ${events.clientAddress} end)`,
    })
    .from(events);
  if (!totals || count(totals.events) === 0) return null;
  const [standing] = await db
    .select({
      ratingsStand: sql<number>`count(*)`,
      raters: sql<number>`count(distinct f.clientAddress)`,
      agentsRated: sql<number>`count(distinct f.agentId)`,
    })
    .from(sql`bsc_feedback_events f`)
    .where(
      sql`f.kind = 'feedback' AND NOT EXISTS (SELECT 1 FROM bsc_feedback_events r WHERE r.kind = 'revoked' AND r.agentId = f.agentId AND r.clientAddress = f.clientAddress AND r.feedbackIndex = f.feedbackIndex)`
    );
  const [state] = await db.select({ updatedAt: bscReputationState.updatedAt }).from(bscReputationState).limit(1);
  return {
    chain: "bnb_ratings",
    asOf: state?.updatedAt ? state.updatedAt.toISOString() : null,
    figures: {
      events: count(totals.events),
      ratingsSent: count(totals.ratingsSent),
      revocations: count(totals.revocations),
      ratingsStand: count(standing?.ratingsStand),
      senders: count(totals.senders),
      raters: count(standing?.raters),
      agentsRated: count(standing?.agentsRated),
    },
    heldOut: null,
    ratings: null,
  };
}
