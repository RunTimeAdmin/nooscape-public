import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../drizzle/schema";

/**
 * Which cache invalidation each directory write uses.
 *
 * Ingestion writes mark the cached aggregates stale: visitors keep getting the
 * current counts, and one reload follows once the writes go quiet. An operator's
 * hide or unhide, and a source decision, drop them, so the very next read shows
 * the change. The choice is made at each call site, and the wrong one hides: the
 * counts come out right either way, only late, or at the price of a rebuild under
 * load. So every write is pinned to its kind here.
 *
 * The cache is two spies and there is no database. Each write fails on that, and
 * the invalidation runs in a `finally` that does not care how the write ended.
 */
const kinds = vi.hoisted(() => ({ strict: vi.fn(), soft: vi.fn() }));

vi.mock("./readCache", () => ({
  cachedDirectoryRead: (_key: string, load: () => Promise<unknown>) => load(),
  cachedSearchRead: (_key: string, load: () => Promise<unknown>) => load(),
  invalidateDirectoryReads: kinds.strict,
  invalidateDirectoryReadsSoftly: kinds.soft,
}));

vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, getDb: vi.fn(actual.getDb) };
});

let db: typeof import("./db");
let rows: typeof import("./agentRegistryRows");
const previousDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  db = await import("./db");
  rows = await import("./agentRegistryRows");
});

afterAll(() => {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

beforeEach(() => {
  kinds.strict.mockClear();
  kinds.soft.mockClear();
});

const source = { id: "source-1" } as IngestionSource;

/** A database whose every call fails, for the writes that look the database up before they start. */
const failingDatabase = {
  transaction: async () => {
    throw new Error("no database");
  },
};

async function invalidationsOf(write: () => Promise<unknown>) {
  await write().catch(() => undefined);
  return { strict: kinds.strict.mock.calls.length, soft: kinds.soft.mock.calls.length };
}

const ingestionWrites: Array<[string, () => Promise<unknown>]> = [
  ["upsertAgentDirectoryEntries", () => db.upsertAgentDirectoryEntries({ source, runId: "run-1", entries: [] } as never)],
  ["markAgentDirectoryEntriesClosed", () => db.markAgentDirectoryEntriesClosed({} as never)],
  ["applyAgentDirectoryActivityWindow", () => db.applyAgentDirectoryActivityWindow({} as never)],
  ["applySolanaActivityWindow", () => db.applySolanaActivityWindow({} as never)],
  ["applyAgentDirectoryReputationWindow", () => db.applyAgentDirectoryReputationWindow({} as never)],
  ["applyUsdgSettlementWindow", () => db.applyUsdgSettlementWindow({ source, settlements: [{}] } as never)],
  [
    "applyAgentRegistryUriUpdates",
    () => {
      vi.mocked(db.getDb).mockResolvedValueOnce(failingDatabase as never);
      return rows.applyAgentRegistryUriUpdates({ source, runId: "run-1", updates: [{ externalKey: "key-1" }] as never });
    },
  ],
  ["refreshAgentRegistryListing", () => rows.refreshAgentRegistryListing(source, { classify: false, publish: false })],
];

const operatorWrites: Array<[string, () => Promise<unknown>]> = [
  ["hideDirectoryEntry", () => db.hideDirectoryEntry("entry-1")],
  ["unhideDirectoryEntry", () => db.unhideDirectoryEntry("entry-1")],
  ["decideIngestionSource", () => db.decideIngestionSource({} as never)],
  // The hero sample embeds the reviewed set: a record taken out of it, or a source taken out of public view, must not be served from the cache.
  ["decideSourceProjection", () => db.decideSourceProjection({} as never)],
  ["decideRecordWithdrawal", () => db.decideRecordWithdrawal({} as never)],
];

describe("directory writes and the cache", () => {
  it.each(ingestionWrites)("%s marks the aggregates stale and drops nothing", async (_name, write) => {
    expect(await invalidationsOf(write)).toEqual({ strict: 0, soft: 1 });
  });

  it.each(operatorWrites)("%s drops the aggregates so the next read shows it", async (_name, write) => {
    expect(await invalidationsOf(write)).toEqual({ strict: 1, soft: 0 });
  });

  it("an update that changes nothing leaves the cache alone", async () => {
    expect(await invalidationsOf(() => rows.applyAgentRegistryUriUpdates({ source, runId: "run-1", updates: [] }))).toEqual({ strict: 0, soft: 0 });
  });
});
