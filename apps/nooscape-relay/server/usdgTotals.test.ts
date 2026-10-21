import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the USDG settlement totals read. The source-visibility
 * query reads `ingestion_sources` without joining the directory table, so its
 * WHERE clause must not reference agentDirectoryEntries.hidden — an unjoined
 * column is a runtime "Unknown column" SQL error on MySQL, which the router
 * catches and fails closed: the money panel silently disappears (totals: null)
 * despite valid settlement data.
 *
 * The drizzle-orm/mysql2 driver is mocked with the real drizzle query builder
 * kept in place, fed by a fake mysql2 pool — so drizzle still generates the
 * real SQL string, which these tests capture and inspect.
 */

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

const captured: CapturedQuery[] = [];

// Scripted per-call responses in the mysql2 shape [rows, fields]. Rows are
// arrays because drizzle selects with rowsAsArray: true.
const scripted: Array<Array<Array<unknown>>> = [];

// A fake mysql2 promise pool: drizzle's mysql2 session calls
// pool.query({ sql, rowsAsArray: true }, params) and expects [rows, fields].
const fakePool = {
  query: async (config: { sql: string }, params?: unknown[]) => {
    captured.push({ sql: config.sql, params: params ?? [] });
    return [scripted.shift() ?? [], []];
  },
};

// drizzle-orm/mysql2 is imported by the inlined source graph (server/db.ts),
// so mocking it intercepts the import; the factory keeps the real drizzle
// query builder — real SQL generation — but feeds it the fake pool instead of
// a real MySQL server. Mocking the "mysql2" package itself would not work:
// drizzle-orm is an externalized dependency whose internal imports bypass the
// mock registry.
vi.mock("drizzle-orm/mysql2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  return {
    ...actual,
    drizzle: vi.fn(() => actual.drizzle(fakePool as never)),
  };
});

async function importDbWithDatabaseUrl() {
  vi.resetModules();
  captured.length = 0;
  scripted.length = 0;
  process.env.DATABASE_URL = "mysql://test:test@localhost:3306/nooscape_test";
  return import("./db");
}

describe("readUsdgSettlementTotals: source-only visibility gate (regression)", () => {
  it("gates only on ingestion_sources.state — never the directory hidden flag", async () => {
    const { readUsdgSettlementTotals } = await importDbWithDatabaseUrl();
    scripted.push([["usdg-settlement-source"]]);

    await readUsdgSettlementTotals();

    // Two queries: the source select, then the totals aggregate, whose empty
    // scripted answer short-circuits the read to null before the median.
    expect(captured.length).toBe(2);
    const sourceSql = captured[0].sql;
    expect(sourceSql).toContain("ingestion_sources");
    expect(sourceSql).toContain("state");
    expect(captured[0].params).toContain("usdg_settlement");
    expect(captured[0].params).toContain("active");
    // The regression: directoryVisibilityCondition() references the hidden
    // column of agent_directory_entries. This query has no directory join, so
    // any hidden-flag reference here is an "Unknown column" SQL error.
    expect(sourceSql).not.toContain("hidden");
    expect(sourceSql).not.toContain("agent_directory_entries");
  });

  it("returns rail totals from the one active settlement source", async () => {
    const { readUsdgSettlementTotals } = await importDbWithDatabaseUrl();
    scripted.push(
      [["usdg-settlement-source"]],
      [[2, 2, 1, 1, 1, 85000000, 85000001]],
      [["6714"]]
    );

    const totals = await readUsdgSettlementTotals();

    expect(totals).toEqual({
      settlementCount: 2,
      payerCount: 2,
      payeeCount: 1,
      relayerCount: 1,
      microPaymentCount: 1,
      medianValueRaw: "6714",
      firstBlock: 85000000,
      lastBlock: 85000001,
    });
    // The aggregate and median queries read the settlement ledger, not the
    // directory, and filter by the selected source id.
    expect(captured[1].sql).toContain("agent_directory_usdg_settlements");
    expect(captured[1].params).toContain("usdg-settlement-source");
    expect(captured[2].sql).toContain("agent_directory_usdg_settlements");
  });

  it("returns null (fail closed) when no active settlement source exists", async () => {
    const { readUsdgSettlementTotals } = await importDbWithDatabaseUrl();
    scripted.push([]);

    expect(await readUsdgSettlementTotals()).toBeNull();
    expect(captured.length).toBe(1);
  });
});

const previousDatabaseUrl = process.env.DATABASE_URL;

afterAll(() => {
  // Never leak the fake DATABASE_URL into other test files sharing a worker.
  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
