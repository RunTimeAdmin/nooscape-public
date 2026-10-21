import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, ne, or } from "drizzle-orm";
import { extraChainsOn, type ChainStat, type ExtraChainStat } from "@shared/chains";
import {
  candidateCatches,
  MAX_AGENT_IDS,
  NO_CATCH,
  NO_RULE_MATCHED,
  NOVELTY_DAYS,
  utcDate,
  viewOf,
  WALLETS_READ,
  type CatchRow,
  type CatchView,
  type PastCatch,
  type PublicCatch,
  type StoredRule,
  type WalletInput,
} from "@shared/owlsCatch";
import { owlsCatch } from "../drizzle/schema";
import { getDb, listAgentDirectoryWallets, listVisibleDirectoryEntries, listVisibleDirectoryEntryIdsForRegistrant, readChainStats, readChainStatsWithExtras, requireDb } from "./db";

/**
 * The Owl's Catch against the database: choose the day's finding once, store it with the values its words are
 * made from, and read it back. The rules and the words are in shared/owlsCatch.ts and need no database.
 *
 * Only the worker's first tick of the UTC day writes (selectTodaysCatch); public reads only ever read, and fail
 * closed to "no catch" when the table cannot be read, as every other public read of this server does.
 */

export type CatchSelection = { date: string; status: "kept" | "selected" | "none" };

export type NewCatchRow = { date: string; rule: StoredRule; facts: string; sourceQuery: string; agentIds: string };

/** The reads and the write the selection needs, so a test can stand in for any of them. */
export type CatchDeps = {
  getRow: (date: string) => Promise<CatchRow | null>;
  /** Every milestone ever featured, and the fleets featured since the date. */
  listPast: (fleetsSince: string) => Promise<CatchRow[]>;
  readWallets: (limit: number) => Promise<WalletInput[]>;
  readChains: () => Promise<Array<ChainStat | ExtraChainStat>>;
  readEntryIds: (registrant: string, limit: number) => Promise<string[]>;
  insert: (row: NewCatchRow) => Promise<void>;
};

const rowColumns = {
  catchDate: owlsCatch.catchDate,
  rule: owlsCatch.rule,
  facts: owlsCatch.facts,
  sourceQuery: owlsCatch.sourceQuery,
  agentIds: owlsCatch.agentIds,
  selectedAt: owlsCatch.selectedAt,
};

export const defaultCatchDeps: CatchDeps = {
  async getRow(date) {
    const db = requireDb(await getDb());
    const [row] = await db.select(rowColumns).from(owlsCatch).where(eq(owlsCatch.catchDate, date)).limit(1);
    return row ?? null;
  },
  async listPast(fleetsSince) {
    const db = requireDb(await getDb());
    return db
      .select(rowColumns)
      .from(owlsCatch)
      .where(or(eq(owlsCatch.rule, "milestone"), and(eq(owlsCatch.rule, "fleet"), gte(owlsCatch.catchDate, fleetsSince))))
      .orderBy(desc(owlsCatch.catchDate));
  },
  readWallets: limit => listAgentDirectoryWallets(limit),
  readChains: async () => {
    // The extra chains whose switch is on are read too, so a round number one of them has just passed can be the day's catch.
    const extras = extraChainsOn(process.env.VITE_FEATURES);
    if (extras.length === 0) return readChainStats();
    const read = await readChainStatsWithExtras(extras, {});
    return [...read.chains, ...read.extras];
  },
  readEntryIds: (registrant, limit) => listVisibleDirectoryEntryIdsForRegistrant(registrant, limit),
  async insert(row) {
    const db = requireDb(await getDb());
    // INSERT IGNORE on the unique date: a second process choosing the same day is ignored, the first one stands.
    await db.insert(owlsCatch).ignore().values({ id: randomUUID(), catchDate: row.date, rule: row.rule, facts: row.facts, sourceQuery: row.sourceQuery, agentIds: row.agentIds });
  },
};

const jsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const pastOf = (row: CatchRow): PastCatch => ({ date: row.catchDate, rule: row.rule as StoredRule, facts: jsonOrNull(row.facts) });

/** The date NOVELTY_DAYS before `date`: a fleet featured on or after it is left alone. */
const fleetsSince = (date: string) => utcDate(new Date(Date.parse(`${date}T00:00:00Z`) - NOVELTY_DAYS * 86_400_000));

/**
 * Chooses and stores today's catch, once. If the day already has a row (a catch, or "none") it is kept. Otherwise
 * the candidates are read from the day's counts in the fixed order the rules give them, and the first that can be
 * stored with something behind it is: a fleet is skipped when none of its entries is visible any more, so a catch
 * is never stored with nothing to link to. With no candidate the day is stored as "none".
 */
export async function selectTodaysCatch(now: Date = new Date(), deps: CatchDeps = defaultCatchDeps): Promise<CatchSelection> {
  const date = utcDate(now);
  if (await deps.getRow(date)) return { date, status: "kept" };

  const past = (await deps.listPast(fleetsSince(date))).map(pastOf);
  // One after the other: each is a scan of the directory, and the database has the public to serve.
  const wallets = await deps.readWallets(WALLETS_READ);
  const chains = await deps.readChains();
  for (const candidate of candidateCatches({ date, wallets, chains, past })) {
    const agentIds = candidate.rule === "fleet" ? await deps.readEntryIds(candidate.facts.registrant, MAX_AGENT_IDS) : [];
    if (candidate.rule === "fleet" && agentIds.length === 0) continue;
    await deps.insert({ date, rule: candidate.rule, facts: JSON.stringify(candidate.facts), sourceQuery: candidate.sourceQuery, agentIds: JSON.stringify(agentIds) });
    return { date, status: "selected" };
  }
  await deps.insert({ date, rule: NO_CATCH, facts: "{}", sourceQuery: NO_RULE_MATCHED, agentIds: "[]" });
  return { date, status: "none" };
}

// ------------------------------------------------------------------------------------------------ reads

export type TodaysCatch = {
  /** Today's UTC date. */
  date: string;
  /** "selected" once the day's catch is chosen, "none" for a day with nothing to report, "pending" before the day's first worker tick has chosen, "unavailable" when the table cannot be read. */
  status: "selected" | "none" | "pending" | "unavailable";
  today: PublicCatch | null;
  /** The newest catch that was found, which is today's when there is one. */
  latest: PublicCatch | null;
};

/** What a public read says when the table cannot be read: no catch, and no pretence that there is one. */
export const unavailableCatch = (now: Date = new Date()): TodaysCatch => ({ date: utcDate(now), status: "unavailable", today: null, latest: null });

/**
 * The views with only the identities the public may still see, each with the name it is recorded under. A hidden
 * entry is never featured, so a fleet whose stored entries have all been hidden since is not shown at all, and one
 * with some left shows those.
 */
async function stillVisible(views: CatchView[]): Promise<PublicCatch[]> {
  const visible = await listVisibleDirectoryEntries(Array.from(new Set(views.flatMap(view => view.agentIds))));
  return views.flatMap(view => {
    const { agentIds, ...rest } = view;
    const agents = agentIds.flatMap(id => {
      const name = visible.get(id);
      return name === undefined ? [] : [{ id, name }];
    });
    return view.rule === "fleet" && agents.length === 0 ? [] : [{ ...rest, agents }];
  });
}

/** The newest rows that hold a catch (not a "none" day), the views of them that read and may be shown, newest first. */
async function newestViews(limit: number): Promise<PublicCatch[]> {
  const db = requireDb(await getDb());
  // Read twice as many as wanted, so a few hidden since do not leave the list short.
  const rows = await db.select(rowColumns).from(owlsCatch).where(ne(owlsCatch.rule, NO_CATCH)).orderBy(desc(owlsCatch.catchDate)).limit(limit * 2);
  return (await stillVisible(rows.flatMap(row => viewOf(row, process.env.VITE_FEATURES) ?? []))).slice(0, limit);
}

/** One row's view, if it reads and may be shown. */
async function viewOfRow(row: CatchRow | null): Promise<PublicCatch | null> {
  const view = row ? viewOf(row, process.env.VITE_FEATURES) : null;
  return view ? ((await stillVisible([view]))[0] ?? null) : null;
}

export async function readTodaysCatch(now: Date = new Date()): Promise<TodaysCatch> {
  const date = utcDate(now);
  const row = await defaultCatchDeps.getRow(date);
  const today = await viewOfRow(row);
  const status: TodaysCatch["status"] = !row ? "pending" : today ? "selected" : "none";
  // A few rows are enough to find one that reads, should the newest not.
  const latest = today ?? (await newestViews(5))[0] ?? null;
  return { date, status, today, latest };
}

/** The catches that were found, newest first, at most `limit` (1 to 100). */
export async function readCatchArchive(limit: number): Promise<PublicCatch[]> {
  const wanted = Math.min(Math.max(Math.floor(limit), 1), 100);
  return newestViews(wanted);
}

/** One day's catch, or null for a day with none (or no row yet). */
export async function readCatchForDate(date: string): Promise<PublicCatch | null> {
  return viewOfRow(await defaultCatchDeps.getRow(date));
}
