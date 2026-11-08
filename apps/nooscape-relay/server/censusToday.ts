import { and, eq, sql } from "drizzle-orm";
import { CENSUS_SOURCE, type CensusChain, type CensusToday } from "@shared/censusToday";
import {
  agentDirectoryEntries,
  agentDirectoryRegistryOverflow,
  agentDirectoryRegistryRows,
  chainReputationCounts,
  ingestionSources,
  type IngestionSource,
} from "../drizzle/schema";
import { REGISTRY_LISTING } from "./agentRegistryRows";
import { getDb, requireDb } from "./db";
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
    const { kind, protocol, ratingsKey } = CENSUS_SOURCE[chain];
    const db = requireDb(await getDb());
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
    const [links] = await db.select({ total: sql<number>`count(distinct ${rows.profileUriHash})` }).from(rows).where(eq(rows.sourceId, source.id));
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
