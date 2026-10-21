import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { createConnection, type Connection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Directory search against a real database, checked against the query it
 * replaced. The old search joined a name MATCH and a key MATCH with OR in one
 * statement, which forces a scan of the whole table (about 2 s at 247k rows); the
 * new one runs a query per index and merges them. This file keeps the old
 * statement as an oracle and requires the same page of results, in the same
 * order, and the same capped total, for a battery of queries over a table with
 * heavy ties, hidden rows, a paused source, a suppressed domain, and closed
 * assets. It also covers what the new search adds: a pool of its own, a decline
 * when that pool's queue is full, and a short hold on repeated queries. Runs
 * against a throwaway local MySQL schema built by the project's boot-time
 * migration runner, and skips when no database is reachable.
 */
const TEST_DB = "nooscape_search_test";
const BASE_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";

const dbReachable = await (async () => {
  try {
    const probe = await createConnection(`${BASE_URL}/mysql`);
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
const ROWS = 7_200;
const COUNT_CAP = 1000;
const wordOf = (n: number) => WORDS[n % WORDS.length]!;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The old statement's visibility predicate, written out in SQL. */
const VISIBLE = "s.state = 'active' AND e.hidden = 0 AND e.assetClosedAt IS NULL AND (e.locatorHost IS NULL OR NOT (e.locatorHost = 'agentrank.info' OR e.locatorHost LIKE '%.agentrank.info'))";

/** The old statement's match expression for a query, with its parameters. */
function oracleMatch(query: string): { sql: string; params: string[] } {
  if (/^0x[0-9a-f]{4,40}$/i.test(query)) return { sql: "e.registrant LIKE ?", params: [`${query.toLowerCase()}%`] };
  if (query.length >= 3) {
    const term = query.replace(/[+\-><()~*"@]/g, " ").trim().split(/\s+/).map(word => `+${word}*`).join(" ");
    const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(query);
    return {
      sql: `MATCH(e.displayName, e.locatorHost) AGAINST(? IN BOOLEAN MODE) OR MATCH(e.externalKey) AGAINST(? IN BOOLEAN MODE)${base58 ? " OR e.registrant LIKE ?" : ""}`,
      params: base58 ? [term, term, `${query}%`] : [term, term],
    };
  }
  const needle = `${query.replace(/[\\%_]/g, match => `\\${match}`)}%`;
  return { sql: "e.displayName LIKE ? ESCAPE '\\\\' OR e.locatorHost LIKE ? ESCAPE '\\\\'", params: [needle, needle] };
}

describe.skipIf(!dbReachable)("directory search against a real database", { timeout: 120_000 }, () => {
  type Db = typeof import("./db");
  let db: Db;
  let raw: Connection;

  async function oracle(query: string, limit: number) {
    const match = oracleMatch(query);
    const from = `FROM agent_directory_entries e JOIN ingestion_sources s ON e.sourceId = s.id WHERE (${match.sql}) AND ${VISIBLE}`;
    const [rows] = (await raw.query(`SELECT e.id ${from} ORDER BY e.lastSeenAt DESC, e.displayName ASC, e.id ASC LIMIT ${limit}`, match.params)) as unknown as [Array<{ id: string }>];
    const count = async () => {
      const [[counted]] = (await raw.query(`SELECT COUNT(*) AS total FROM (SELECT 1 ${from}) t`, match.params)) as unknown as [[{ total: number }]];
      return Number(counted.total);
    };
    let rawTotal = await count();
    // The oracle cannot disagree with itself: a page of rows means at least that many matches. In CI the first count after the seed has
    // answered 0 beside a full page of rows (three times, always on the first query of the battery), which is the full-text count's
    // fault and not the search's, so it is asked again before anything is compared to it. The test still fails if it never agrees.
    for (let attempt = 0; rows.length > 0 && rawTotal < rows.length && attempt < 10; attempt += 1) {
      await pause(200);
      rawTotal = await count();
    }
    return { ids: rows.map(row => row.id), total: Math.min(rawTotal, COUNT_CAP), rawTotal };
  }

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    raw = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await raw.query(statement);
    }
    await applyPendingMigrations(process.env.DATABASE_URL);
    db = await import("./db");

    await raw.query("INSERT INTO users (openId, name, role) VALUES ('search-test', 'search', 'admin')");
    const [[operator]] = (await raw.query("SELECT id FROM users WHERE openId = 'search-test'")) as unknown as [[{ id: number }]];
    for (const [id, state] of [["src-active", "active"], ["src-paused", "paused"]] as const) {
      await raw.query(
        "INSERT INTO ingestion_sources (id, sourceKey, label, protocol, rootUrl, allowedHostname, state, createdByUserId) VALUES (?, ?, ?, 'catalog', 'https://search.example', 'search.example', ?, ?)",
        [id, `search-${id}`, id, state, operator.id]
      );
    }
    await raw.query("SET SESSION cte_max_recursion_depth = 100000");
    // Ties on lastSeenAt are the rule (five distinct values), so the order depends on the name and then the id.
    await raw.query(
      `INSERT INTO agent_directory_entries (id, sourceId, externalKey, displayName, locatorHost, protocol, registrant, hidden, assetClosedAt, lastSeenAt)
       WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${ROWS})
       SELECT UUID(), IF(n % 7 = 0, 'src-paused', 'src-active'), CONCAT('cat-', n),
              CONCAT('Agent ', n, ' ', ELT(1 + n % 6, 'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot')),
              IF(n % 211 = 0, 'api.agentrank.info', CONCAT('h', n % 400, '.example.net')), 'catalog',
              IF(n % 10 = 0, CONCAT('0x', LPAD(HEX(n), 40, '0')), IF(n % 10 = 5, CONCAT(REPEAT('B', 38), LPAD(n % 1000, 4, '7')), NULL)),
              IF(n % 97 = 0, 1, 0), IF(n % 101 = 0, TIMESTAMP('2026-01-01'), NULL),
              TIMESTAMP('2026-02-01 00:00:00') + INTERVAL (n % 5) HOUR
       FROM seq`
    );
    // Thirty entries with the same name and the same time: only the id can say which twelve come first.
    await raw.query(
      `INSERT INTO agent_directory_entries (id, sourceId, externalKey, displayName, locatorHost, protocol, lastSeenAt)
       WITH RECURSIVE t (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 30)
       SELECT UUID(), 'src-active', CONCAT('twin-', n), 'Agent twin', 'twin.example.net', 'catalog', TIMESTAMP('2026-03-01')
       FROM t`
    );
    // Building the schema and 7,200 rows is database work, and on a loaded or throttled server it has run past the config's 60 second
    // hook limit (a skipped file, with nothing wrong in the search). The limit is for a hung hook, so it is set well past a slow one.
  }, 180_000);

  afterAll(async () => {
    await raw?.end();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  const BATTERY: Array<[string, string]> = [
    ["a common word", "alpha"],
    ["the same word in capitals", "ALPHA"],
    ["a name with its number", `Agent 1234 ${wordOf(1234)}`],
    ["a number with the wrong word", `Agent 1234 ${wordOf(1235)}`],
    ["two words no entry has together", "alpha bravo"],
    ["a host", "h77.example.net"],
    ["a rare host token", "h399"],
    ["a registry key", "cat-42"],
    ["a registry key prefix", "cat-4"],
    ["a word that is in every name", "agent"],
    ["an EVM wallet prefix", "0x0000000000000000"],
    ["a full EVM wallet", `0x${(1230).toString(16).padStart(40, "0")}`],
    ["a Solana address prefix", "B".repeat(38)],
    ["two characters", "ag"],
    ["two characters, capitals", "AG"],
    ["a percent sign", "%%"],
    ["an underscore", "a_"],
    ["a suppressed domain", "api.agentrank.info"],
    ["no match", "zzzzqqqq"],
    ["an apostrophe", "agent's"],
    ["only special characters", "+++"],
    ["twins with the same name and time", "twin"],
    ["twins found by key as well as by name", "twin-7"],
  ];

  for (const [label, query] of BATTERY) {
    it(`returns the old query's page and capped total for ${label}`, async () => {
      for (const limit of [12, 25]) {
        const expected = await oracle(query, limit).catch((error: unknown) => error as Error);
        if (expected instanceof Error) {
          // A query that is only special characters is not valid full-text syntax: the old statement failed, and the router answers empty.
          await expect(db.searchAgentDirectory({ query, limit }), `${query} / ${limit}`).rejects.toBeInstanceOf(Error);
          continue;
        }
        expect(expected.rawTotal, `${query} / ${limit}: the oracle's count is below its own page of rows`).toBeGreaterThanOrEqual(expected.ids.length);
        const actual = await db.searchAgentDirectory({ query, limit });
        expect(actual.entries.map(entry => entry.id), `${query} / ${limit}`).toEqual(expected.ids);
        expect(actual.matchedTotal, `${query} / ${limit} total`).toBe(expected.total);
        expect(actual.matchedTotalCapped, `${query} / ${limit} capped`).toBe(expected.rawTotal >= COUNT_CAP);
      }
    });
  }

  it("keeps hidden, closed, paused-source, and suppressed-domain rows out of every result", async () => {
    const { entries } = await db.searchAgentDirectory({ query: "agent", limit: 25 });
    const [rows] = (await raw.query("SELECT id, hidden, assetClosedAt, sourceId, locatorHost FROM agent_directory_entries WHERE id IN (?)", [entries.map(entry => entry.id)])) as unknown as [
      Array<{ hidden: number; assetClosedAt: Date | null; sourceId: string; locatorHost: string | null }>
    ];
    expect(rows.length).toBe(entries.length);
    for (const row of rows) {
      expect(row.hidden).toBe(0);
      expect(row.assetClosedAt).toBeNull();
      expect(row.sourceId).toBe("src-active");
      expect(row.locatorHost?.endsWith("agentrank.info")).toBe(false);
    }
  });

  it("counts a common word up to the cap and says so", async () => {
    const result = await db.searchAgentDirectory({ query: "alpha", limit: 12 });
    expect(result.matchedTotal).toBe(COUNT_CAP);
    expect(result.matchedTotalCapped).toBe(true);
  });

  it("counts a rare token exactly, without a cap", async () => {
    const result = await db.searchAgentDirectory({ query: "h399", limit: 12 });
    expect(result.matchedTotal).toBeGreaterThan(0);
    expect(result.matchedTotal).toBeLessThan(COUNT_CAP);
    expect(result.matchedTotalCapped).toBe(false);
  });

  it("answers a repeated search from a short hold, which an operator's write drops and an ingestion write leaves", async () => {
    const query = "echo";
    const first = await db.searchAgentDirectory({ query, limit: 12 });
    // A row inserted behind the module's back would be the newest match, but it is invisible while the hold lasts.
    await raw.query(
      "INSERT INTO agent_directory_entries (id, sourceId, externalKey, displayName, locatorHost, protocol, lastSeenAt) VALUES ('held-1', 'src-active', 'cat-held', 'Agent 99999 echo', 'held.example.net', 'catalog', TIMESTAMP('2030-01-01'))"
    );
    expect((await db.searchAgentDirectory({ query, limit: 12 })).entries[0]!.id).toBe(first.entries[0]!.id);
    // An ingestion write leaves the hold, which expires within a minute: a run writes a window every second or so,
    // and dropping every held search after each would send them all back to the database.
    const source = await db.getIngestionSource("src-active");
    await db.upsertAgentDirectoryEntries({ source: source!, runId: "run-held", entries: [{ externalKey: "cat-held-2", displayName: "Agent 99998 echo", locatorHost: "h.example.net", sourceSignalNote: "test" }] });
    expect((await db.searchAgentDirectory({ query, limit: 12 })).entries[0]!.id).toBe(first.entries[0]!.id);
    // An operator's write drops it, so the next search sees everything, here as a hide and unhide of the raw row.
    await db.hideDirectoryEntry("held-1");
    await db.unhideDirectoryEntry("held-1");
    expect((await db.searchAgentDirectory({ query, limit: 12 })).entries[0]!.id).toBe("held-1");
  });

  it("stops a search that runs too long on its own connections, and no other query", async () => {
    const limit = async (run: (query: ReturnType<typeof sql>) => Promise<unknown>) => {
      const result = (await run(sql`SELECT @@max_execution_time AS ms`)) as unknown as [Array<{ ms: number | string }>];
      return Number(result[0]![0]!.ms);
    };
    expect(await db.withSearchConnection(searchDb => limit(query => searchDb.execute(query)))).toBe(8_000);
    const [[mainSession]] = (await raw.query("SELECT @@max_execution_time AS ms")) as unknown as [[{ ms: number }]];
    expect(Number(mainSession.ms)).toBe(0);
  });

  it("runs on a pool of its own: a busy search pool declines new searches and leaves the main pool answering", async () => {
    const { SEARCH_POOL_OPTIONS } = db;
    // Two connections running and the queue full, then one more search.
    const blockers = Array.from({ length: SEARCH_POOL_OPTIONS.connectionLimit + SEARCH_POOL_OPTIONS.queueLimit }, () =>
      db.withSearchConnection(searchDb => searchDb.execute(sql`SELECT SLEEP(0.4)`))
    );
    const declined = await db.searchAgentDirectory({ query: "never-searched-before-xyz", limit: 12 });
    expect(declined).toMatchObject({ busy: true, entries: [], matchedTotal: 0 });

    // The main pool is not behind them: its query is answered before the search pool has got through the blockers (twelve sleeps of
    // 0.4 seconds on two connections take over two seconds), however fast or slow the machine is. A stopwatch limit on one query
    // measured the machine as much as the pool.
    const first = await Promise.race([db.listPublicIngestionSourceStatuses().then(() => "main pool" as const), Promise.all(blockers).then(() => "blockers" as const)]);
    expect(first).toBe("main pool");

    await Promise.all(blockers);
    // A decline is not held: the same search works once the queue has drained.
    const retried = await db.searchAgentDirectory({ query: "never-searched-before-xyz", limit: 12 });
    expect(retried).not.toHaveProperty("busy");
  });
});
