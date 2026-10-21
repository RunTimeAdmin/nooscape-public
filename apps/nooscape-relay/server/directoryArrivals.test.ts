import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARRIVALS_NEWEST_PER_CHAIN } from "@shared/arrivals";
import * as schema from "../drizzle/schema";

/**
 * What entered the directory in the last 24 hours, read from a real database with the entries the public must never see
 * (hidden, closed, on a suppressed host, from a paused source) and the ones outside the window sitting beside the ones it
 * may. The pure arithmetic is in shared/arrivals.test.ts. This half skips when no database is reachable.
 */
const TEST_DB = "nooscape_arrivals_test";
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

describe.skipIf(!dbReachable)("the directory's arrivals against a real database", () => {
  type Db = typeof import("./db");
  let db: Db;
  let readCache: typeof import("./readCache");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

  async function source(id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"], state: "active" | "paused") {
    await writer.insert(schema.ingestionSources).values({ id, sourceKey: `arrivals-${id}`, label: id, protocol, rootUrl: "https://arrivals.example/feed", allowedHostname: "arrivals.example", state, createdByUserId: operatorUserId });
  }

  async function entry(id: string, sourceId: string, protocol: (typeof schema.agentDirectoryEntries.$inferInsert)["protocol"], firstSeenAt: Date, extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}) {
    await writer.insert(schema.agentDirectoryEntries).values({ id, sourceId, externalKey: `key-${id}`, displayName: `Entry ${id}`, protocol, firstSeenAt, ...extra });
  }

  const chain = async (name: string) => (await db.readDirectoryArrivals()).chains.find(row => row.chain === name)!;
  // The extra chains are read from VITE_FEATURES as the server runs, and the read is cached, so a change of list drops the cache.
  const features = (list: string | undefined) => {
    if (list === undefined) delete process.env.VITE_FEATURES;
    else process.env.VITE_FEATURES = list;
    readCache.invalidateDirectoryReads();
  };

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    const baselineReplay = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baselineReplay.query(statement);
    }
    await baselineReplay.end();
    await applyPendingMigrations(process.env.DATABASE_URL);
    // Migration 0046 is manual: it adds Arc's protocol to the four tables.
    const owner = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8"))) await owner.query(statement);
    await owner.end();

    db = await import("./db");
    readCache = await import("./readCache");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "arrivals-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "arrivals-operator"));
    operatorUserId = operator.id;

    await source("src-rh", "erc8004", "active");
    await source("src-sol", "solana_registry", "active");
    await source("src-said", "solana_said", "active");
    await source("src-sol-paused", "solana_8004", "paused");
    await source("src-bnb", "erc8004_bsc", "paused");
    await source("src-catalog", "catalog", "active");
    await source("src-arc", "erc8004_arc", "active");

    // Robinhood: two inside the window, one outside it, and one each the public must not see.
    await entry("rh-new-1", "src-rh", "erc8004", hoursAgo(2), { displayName: "Mesh Gate" });
    await entry("rh-new-2", "src-rh", "erc8004", hoursAgo(10));
    await entry("rh-old", "src-rh", "erc8004", hoursAgo(30));
    await entry("rh-hidden", "src-rh", "erc8004", hoursAgo(1), { hidden: true });
    await entry("rh-closed", "src-rh", "erc8004", hoursAgo(1), { assetClosedAt: new Date() });
    await entry("rh-suppressed", "src-rh", "erc8004", hoursAgo(1), { locatorHost: "api.agentrank.info" });
    // Solana: more new entries than a chain's list names, in an active registry, and some in a paused one.
    for (let n = 1; n <= ARRIVALS_NEWEST_PER_CHAIN + 1; n += 1) await entry(`sol-${n}`, "src-sol", "solana_registry", hoursAgo(n));
    // A second Solana registry, active: its entries are interleaved with the first one's, and the chain names the newest of both.
    await entry("said-1", "src-said", "solana_said", hoursAgo(0.5));
    await entry("said-2", "src-said", "solana_said", hoursAgo(1.5));
    for (const n of [1, 2]) await entry(`sol-paused-${n}`, "src-sol-paused", "solana_8004", hoursAgo(n));
    // BNB: new entries in a source that is not active. A locator entry is on no chain.
    for (const n of [1, 2, 3]) await entry(`bnb-${n}`, "src-bnb", "erc8004_bsc", hoursAgo(n));
    await entry("catalog-new", "src-catalog", "catalog", hoursAgo(1));
    // Arc: two inside the window, one outside it and one the public must not see.
    await entry("arc-new-1", "src-arc", "erc8004_arc", hoursAgo(3), { displayName: "Harbor One" });
    await entry("arc-new-2", "src-arc", "erc8004_arc", hoursAgo(5));
    await entry("arc-old", "src-arc", "erc8004_arc", hoursAgo(40));
    await entry("arc-hidden", "src-arc", "erc8004_arc", hoursAgo(1), { hidden: true });
  });

  afterAll(async () => {
    delete process.env.VITE_FEATURES;
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("counts the visible entries first seen inside the window, and not the old, hidden, closed or suppressed ones", async () => {
    const robinhood = await chain("robinhood");
    expect(robinhood).toMatchObject({ indexed: true, added: 2 });
    expect(robinhood.newest.map(entry => [entry.id, entry.displayName])).toEqual([["rh-new-1", "Mesh Gate"], ["rh-new-2", "Entry rh-new-2"]]);
  });

  it("names a chain's newest entries first and no more than the limit, while counting all of them", async () => {
    const solana = await chain("solana");
    expect(solana.added).toBe(ARRIVALS_NEWEST_PER_CHAIN + 1 + 2);
    expect(solana.newest.map(entry => entry.id)).toEqual(["said-1", "sol-1", "said-2"]);
    for (const entry of solana.newest) expect(Date.parse(entry.firstSeenAt)).toBeGreaterThan(Date.now() - 24 * 3_600_000);
  });

  it("splits a chain's count by registry, and the split adds up to the count", async () => {
    const solana = await chain("solana");
    expect(solana.registries).toEqual([{ protocol: "solana_registry", count: ARRIVALS_NEWEST_PER_CHAIN + 1 }, { protocol: "solana_said", count: 2 }]);
    expect(solana.registries.reduce((sum, registry) => sum + registry.count, 0)).toBe(solana.added);
    expect((await chain("robinhood")).registries).toEqual([{ protocol: "erc8004", count: 2 }]);
  });

  it("leaves a paused source's entries out, and reports a chain with no active source as not indexed, never as zero", async () => {
    expect((await chain("solana")).newest.some(entry => entry.id.startsWith("sol-paused"))).toBe(false);
    expect(await chain("bnb")).toEqual({ chain: "bnb", indexed: false, added: null, newest: [], registries: [] });
  });

  it("leaves an extra chain out while its switch is off, though its entries are in the database", async () => {
    features(undefined);
    expect((await db.readDirectoryArrivals()).chains.map(row => row.chain)).toEqual(["robinhood", "solana", "bnb"]);
    // Another extra chain's switch does not bring Arc in: each chain that is on has a row, and Arc's entries are counted nowhere.
    features("chain_base,chain_ethereum");
    try {
      const read = await db.readDirectoryArrivals();
      expect(read.chains.map(row => row.chain)).toEqual(["robinhood", "solana", "bnb", "ethereum", "base"]);
      expect(read.chains.flatMap(row => row.registries).some(registry => registry.protocol === "erc8004_arc")).toBe(false);
      expect(read.chains.flatMap(row => row.newest).some(entry => entry.id.startsWith("arc-"))).toBe(false);
    } finally {
      features(undefined);
    }
  });

  it("adds Arc after the others once its switch is on: its visible entries inside the window, the newest first, and nothing the public must not see", async () => {
    features("chain_arc");
    try {
      const read = await db.readDirectoryArrivals();
      expect(read.chains.map(row => row.chain)).toEqual(["robinhood", "solana", "bnb", "arc"]);
      const arc = read.chains.find(row => row.chain === "arc")!;
      expect(arc).toMatchObject({ indexed: true, added: 2 });
      expect(arc.newest.map(entry => [entry.id, entry.displayName])).toEqual([["arc-new-1", "Harbor One"], ["arc-new-2", "Entry arc-new-2"]]);
      expect(arc.registries).toEqual([{ protocol: "erc8004_arc", count: 2 }]);
      // The original three read as they did with the switch off.
      expect(await chain("robinhood")).toMatchObject({ indexed: true, added: 2 });
      expect((await chain("solana")).added).toBe(ARRIVALS_NEWEST_PER_CHAIN + 1 + 2);
      expect(await chain("bnb")).toEqual({ chain: "bnb", indexed: false, added: null, newest: [], registries: [] });
    } finally {
      features(undefined);
    }
  });

  it("reports Arc as not indexed, never as zero, when its source is paused", async () => {
    features("chain_arc");
    try {
      await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-arc"));
      readCache.invalidateDirectoryReads();
      expect(await chain("arc")).toEqual({ chain: "arc", indexed: false, added: null, newest: [], registries: [] });
    } finally {
      await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, "src-arc"));
      features(undefined);
    }
  });

  it("is stamped with when it was counted", async () => {
    const read = await db.readDirectoryArrivals();
    expect(read.windowHours).toBe(24);
    expect(Math.abs(Date.now() - Date.parse(read.computedAt))).toBeLessThan(60_000);
  });
});
