import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the chain-activity totals read: the funnel's
 * "as of block N" label depends on measuredThroughBlock being the activity
 * ledger's high-water block (MAX(blockNumber)) — and on an empty ledger
 * mapping to null, never to a false 0, so the client falls back to a plain
 * "no estimates" chip instead of pinning counts to a fabricated block.
 *
 * The drizzle-orm/mysql2 driver is mocked with the real drizzle query builder
 * kept in place, fed by a fake mysql2 pool — so drizzle still generates the
 * real SQL string, which these tests capture and inspect. See
 * usdgTotals.test.ts for why "mysql2" itself cannot be mocked here.
 */

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

const captured: CapturedQuery[] = [];

// Scripted per-call responses in the mysql2 shape [rows, fields]. Rows are
// arrays because drizzle selects with rowsAsArray: true.
const scripted: Array<Array<Array<unknown>>> = [];

const fakePool = {
  query: async (config: { sql: string }, params?: unknown[]) => {
    captured.push({ sql: config.sql, params: params ?? [] });
    return [scripted.shift() ?? [], []];
  },
};

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

describe("readAgentDirectoryActivityTotals: as-of-block label facts", () => {
  it("returns the rollup counts plus the ledger high-water block", async () => {
    const { readAgentDirectoryActivityTotals } = await importDbWithDatabaseUrl();
    // Query order: the visibility-gated entry rollup, then the ledger MAX.
    scripted.push(
      [[8623, 6561, 6550, 275]],
      [[83123456]]
    );

    const totals = await readAgentDirectoryActivityTotals();

    expect(totals).toEqual({
      mintedEntries: 8623,
      secondaryTransfers: 6561,
      handoutTransfers: 6550,
      uriUpdates: 275,
      measuredThroughBlock: 83123456,
    });
    // The rollup reads the directory entries joined to their sources and is
    // gated by the shared visibility condition (active + not hidden).
    expect(captured[0].sql).toContain("agent_directory_entries");
    expect(captured[0].sql).toContain("ingestion_sources");
    expect(captured[0].sql).toContain("hidden");
    // The as-of fact reads the chain-activity ledger's MAX block.
    expect(captured[1].sql).toContain("agent_directory_chain_activity");
    expect(captured[1].sql).toContain("max");
  });

  it("maps an empty ledger to measuredThroughBlock null, never a false 0", async () => {
    const { readAgentDirectoryActivityTotals } = await importDbWithDatabaseUrl();
    // The entry rollup aggregate still yields one row (count 0); the MAX over
    // an empty ledger yields a single NULL.
    scripted.push(
      [[0, 0, 0, 0]],
      [[null]]
    );

    const totals = await readAgentDirectoryActivityTotals();

    expect(totals).toEqual({
      mintedEntries: 0,
      secondaryTransfers: 0,
      handoutTransfers: 0,
      uriUpdates: 0,
      measuredThroughBlock: null,
    });
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
