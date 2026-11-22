/** What the directory shows: the visibility rule every public read uses, and the directory search with its own pool. Part of server/db.ts, which re-exports every module of this folder. */
import { and, asc, desc, eq, inArray, isNull, max, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2";
import { agentDirectoryEntries, agentDirectoryRegistryRows, ingestionSources } from "../../drizzle/schema";
import { breakerStream, databaseBreaker, guardPool, POOL_ACQUIRE_TIMEOUT_CODE } from "../dbBreaker";
import { erc8004ChainOfProtocol } from "../ingestion/erc8004Chains";
import { currentBnbSourceNote } from "../bscSourceNote";
import { publicDisplayName } from "../publicText";
import { cachedSearchRead } from "../readCache";
import { hostIsUnder } from "../hostName";
import { activeSourceCondition, chainSwitchCondition, getDb, requireDb, watchPoolConnections } from "./core";

/**
 * Look-alike counts for a batch of acknowledged entries: how many OTHER
 * entries share each entry's registering wallet, exact display name, or
 * locator host. Locator-class facts only — the counts group registrations,
 * they never identify an operator or rate an agent. Only entries from active
 * sources are counted.
 */
export async function agentDirectoryRelatedCounts(
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
 * Operator-suppressed locator domains: a retired or untrusted service whose
 * entire domain — subdomains included — must never surface in the public
 * directory. AgentRank (agentrank.info) is a retired service whose domain no
 * longer resolves; migration 0015 hid the exact host only, which let
 * subdomain-hosted rows (api.agentrank.info) through, so the operator
 * directed a domain-wide rule (2026-10-11) instead of per-row hiding.
 */
export const SUPPRESSED_LOCATOR_DOMAINS: readonly string[] = ["agentrank.info"];

/** True when the host is a suppressed domain or any subdomain of one, in any case and with any trailing dots (outside audit 2026-11-05, R16). */
export function isSuppressedLocatorHost(host: string | null | undefined): boolean {
  return SUPPRESSED_LOCATOR_DOMAINS.some(domain => hostIsUnder(host, domain));
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
export function directoryVisibilityCondition() {
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
 * cleaned of control characters and invisible formatting, and a name with nothing
 * left shows the registries' placeholder (publicDisplayName); other locator-class
 * fields pass through unchanged (they're host/key strings, not prose).
 */
export function sanitizeDirectoryEntry<T extends { displayName: string }>(entry: T): T {
  const note = (entry as { sourceSignalNote?: string | null }).sourceSignalNote;
  return {
    ...entry,
    displayName: publicDisplayName(entry.displayName, (entry as { externalKey?: string | null }).externalKey),
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

/** A whole host name: two or more dot-separated labels of letters, digits and hyphens. */
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * One condition per index a query can be answered from. They are run as
 * separate queries and merged, because joining a name MATCH and a key MATCH with
 * OR forces a scan of the whole table (2 s against 0.5 s for the common word on
 * the 247k-row test data, and 0.9 s against 2 ms for a rare token).
 * - wallet-shaped queries (0x + hex) are an indexed prefix match on registrant;
 * - queries of 3 or more characters use the two FULLTEXT indexes (displayName and
 *   locatorHost together, externalKey on its own) with word-boundary matching, and
 *   a Solana-address-shaped query also tries the registrant prefix;
 * - a query that is a whole host name also tries an exact match on locatorHost (its own index), because full text
 *   cannot find a host with a stopword label such as "com" or "www";
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
    // A whole host name is also matched exactly. Full text cannot answer it when a label of the host is a stopword (InnoDB's default list
    // has "com" and "www"): "+cubicle.algotrada.com*" matches nothing, so a .com host was never found by its name.
    if (HOST_NAME.test(query)) conditions.push(sql`${agentDirectoryEntries.locatorHost} = ${query.toLowerCase()}`);
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
    entries: rows.map(({ sourceId: _sourceId, externalKey, ...entry }, index) =>
      sanitizeDirectoryEntry({ ...entry, displayName: publicDisplayName(entry.displayName, externalKey), related: related[index] })
    ),
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
    // Internal: the id in the placeholder a name with nothing left shows; stripped before the response.
    externalKey: agentDirectoryEntries.externalKey,
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
