import { and, eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";

/**
 * Database-backed tests of the EVM activity ledger with TWO chains in it. The
 * ledger, the entry rollups, and the public readers (totals, feed, day series,
 * per-agent activity) were written for Robinhood Chain alone. BNB Smart Chain
 * reads the same registry with the same event shapes, but its blocks are about
 * four times shorter, so three things must hold the moment a second chain's
 * rows exist:
 *   1. the Robinhood-facing public readers never count, list, or date a
 *      BSC row (BSC block numbers are in the 100 millions; Robinhood's are not),
 *   2. the hand-out rule uses each chain's own mint hour, both in the stored
 *      rollup and when a single agent's events are read back, and
 *   3. an incremental rollup touches only the entries a window named, so a
 *      373k-entry walk is not a full-source recompute per window.
 * Runs against a throwaway local MySQL schema built by the project's own
 * boot-time migration runner, and the whole file skips when no database is
 * reachable so the standard no-DB gate stays green.
 */
const TEST_DB = "nooscape_evm_scope_test";
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

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const ZERO = "0x" + "0".repeat(40);
const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const X = "0x" + "c".repeat(40);
const Y = "0x" + "d".repeat(40);
const rhKey = (id: number) => `eip155:4663:${REGISTRY}:${id}`;
const bscKey = (id: number) => `eip155:56:${REGISTRY}:${id}`;
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");

type Event = { kind: "mint" | "secondary" | "uri_update"; externalKey: string; blockNumber: number; transactionHash: string; logIndex: number; fromAddress: string | null; toAddress: string | null };
let txCounter = 1;
const mint = (key: string, block: number, to: string): Event => ({ kind: "mint", externalKey: key, blockNumber: block, transactionHash: tx(txCounter++), logIndex: 0, fromAddress: ZERO, toAddress: to });
const secondary = (key: string, block: number, from: string, to: string): Event => ({ kind: "secondary", externalKey: key, blockNumber: block, transactionHash: tx(txCounter++), logIndex: 0, fromAddress: from, toAddress: to });
const uriUpdate = (key: string, block: number): Event => ({ kind: "uri_update", externalKey: key, blockNumber: block, transactionHash: tx(txCounter++), logIndex: 0, fromAddress: null, toAddress: null });

describe.skipIf(!dbReachable)("two EVM identity chains in one ledger", () => {
  type Db = typeof import("./db");
  let db: Db;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let rhSource: NonNullable<Awaited<ReturnType<Db["getIngestionSource"]>>>;
  let bscSource: NonNullable<Awaited<ReturnType<Db["getIngestionSource"]>>>;

  const entryRow = async (id: string) => {
    const [row] = await writer.select().from(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.id, id));
    return row!;
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

    db = await import("./db");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "evm-scope-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "evm-scope-operator"));
    const sources = [
      { id: "src-rh", key: "robinhood-erc8004-identity-registry", protocol: "erc8004" as const, host: "rpc.mainnet.chain.robinhood.com" },
      { id: "src-bsc", key: "bsc-erc8004-identity-registry", protocol: "erc8004_bsc" as const, host: "bsc-mainnet.nodereal.io" },
    ];
    for (const source of sources) {
      await writer.insert(schema.ingestionSources).values({
        id: source.id,
        sourceKey: source.key,
        label: source.key,
        protocol: source.protocol,
        rootUrl: `https://${source.host}`,
        allowedHostname: source.host,
        state: "active",
        createdByUserId: operator.id,
      });
    }
    const entries = [
      { id: "e-rh-1", sourceId: "src-rh", protocol: "erc8004" as const, key: rhKey(1), name: "Robinhood agent one" },
      { id: "e-rh-2", sourceId: "src-rh", protocol: "erc8004" as const, key: rhKey(2), name: "Robinhood agent two" },
      { id: "e-bsc-1", sourceId: "src-bsc", protocol: "erc8004_bsc" as const, key: bscKey(1), name: "BSC agent one" },
      { id: "e-bsc-2", sourceId: "src-bsc", protocol: "erc8004_bsc" as const, key: bscKey(2), name: "BSC agent two" },
    ];
    for (const entry of entries) {
      await writer.insert(schema.agentDirectoryEntries).values({
        id: entry.id,
        sourceId: entry.sourceId,
        externalKey: entry.key,
        displayName: entry.name,
        protocol: entry.protocol,
      });
    }
    rhSource = (await db.getIngestionSource("src-rh"))!;
    bscSource = (await db.getIngestionSource("src-bsc"))!;

    // Robinhood: a hand-out (inside its 36,000-block hour) and a later change of hands (outside it).
    await db.applyAgentDirectoryActivityWindow({
      source: rhSource,
      activity: [
        mint(rhKey(1), 1_000, A),
        secondary(rhKey(1), 31_000, A, B),
        secondary(rhKey(1), 41_000, A, B),
        uriUpdate(rhKey(1), 50_000),
        mint(rhKey(2), 2_000, B),
      ],
    });
    // BSC: 7,000 blocks after the mint is inside its 8,000-block hour; 9,000 is outside it but
    // INSIDE Robinhood's 36,000, so a wrongly shared window would call it a hand-out.
    await db.applyAgentDirectoryActivityWindow({
      source: bscSource,
      handoutBlockWindow: 8_000,
      incrementalRollup: true,
      activity: [
        mint(bscKey(1), 120_000_000, X),
        secondary(bscKey(1), 120_007_000, X, Y),
        secondary(bscKey(1), 120_009_000, X, Y),
        uriUpdate(bscKey(1), 120_010_000),
        mint(bscKey(2), 120_000_500, Y),
      ],
    });
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("keeps the Robinhood totals and as-of block free of BSC rows", async () => {
    expect(await db.readAgentDirectoryActivityTotals()).toEqual({
      mintedEntries: 2,
      secondaryTransfers: 2,
      handoutTransfers: 1,
      uriUpdates: 1,
      // The ledger's high-water for Robinhood, never BSC's 120,010,000.
      measuredThroughBlock: 50_000,
    });
  });

  it("lists only Robinhood events in the feed, with the Robinhood hand-out rule", async () => {
    const feed = await db.readAgentDirectoryActivityFeed();
    expect(feed.map(event => event.blockNumber)).toEqual([50_000, 41_000, 31_000, 2_000, 1_000]);
    expect(feed.every(event => event.blockNumber < 1_000_000)).toBe(true);
    expect(feed.find(event => event.blockNumber === 31_000)!.isHandout).toBe(true);
    expect(feed.find(event => event.blockNumber === 41_000)!.isHandout).toBe(false);
  });

  it("builds the block-day series from Robinhood rows alone", async () => {
    const series = await db.readAgentDirectoryActivityDaySeries();
    // Robinhood's blocks all fall in day 0; a BSC row would add a day near 138 (120,000,000 / 864,000).
    expect(series).toEqual([{ day: 0, mints: 2, handouts: 1, laterTransfers: 1, uriEdits: 1 }]);
  });

  it("answers an empty feed and series, without reading the ledger, while no Robinhood source is active, and the same as before once one is", async () => {
    const { invalidateDirectoryReads } = await import("./readCache");
    await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-rh"));
    invalidateDirectoryReads();
    try {
      expect(await db.readAgentDirectoryActivityFeed()).toEqual([]);
      expect(await db.readAgentDirectoryActivityDaySeries()).toEqual([]);
    } finally {
      await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, "src-rh"));
      invalidateDirectoryReads();
    }
    expect((await db.readAgentDirectoryActivityFeed()).map(event => event.blockNumber)).toEqual([50_000, 41_000, 31_000, 2_000, 1_000]);
    expect(await db.readAgentDirectoryActivityDaySeries()).toEqual([{ day: 0, mints: 2, handouts: 1, laterTransfers: 1, uriEdits: 1 }]);
  });

  it("stores each chain's hand-out count with that chain's own mint hour", async () => {
    const rh = await entryRow("e-rh-1");
    expect([rh.mintBlock, rh.secondaryTransferCount, rh.handoutCount, rh.uriUpdateCount]).toEqual([1_000, 2, 1, 1]);
    const bsc = await entryRow("e-bsc-1");
    expect([bsc.mintBlock, bsc.secondaryTransferCount, bsc.handoutCount, bsc.uriUpdateCount]).toEqual([120_000_000, 2, 1, 1]);
    const untouched = await entryRow("e-bsc-2");
    expect([untouched.mintBlock, untouched.secondaryTransferCount, untouched.handoutCount]).toEqual([120_000_500, 0, 0]);
  });

  it("classifies a single agent's events with its own chain's mint hour when reading it back", async () => {
    const rh = await db.getAgentDirectoryEntry("e-rh-1");
    expect(rh!.activity!.events.map(event => [event.kind, event.isHandout])).toEqual([
      ["mint", false],
      ["secondary", true],
      ["secondary", false],
      ["uri_update", false],
    ]);
    const bsc = await db.getAgentDirectoryEntry("e-bsc-1");
    expect(bsc!.activity!.events.map(event => [event.kind, event.isHandout])).toEqual([
      ["mint", false],
      ["secondary", true],
      // 9,000 blocks after the mint: inside Robinhood's hour, outside BSC's.
      ["secondary", false],
      ["uri_update", false],
    ]);
  });

  it("recomputes only the entries a window named when the rollup is incremental", async () => {
    await writer.update(schema.agentDirectoryEntries).set({ handoutCount: 999 }).where(eq(schema.agentDirectoryEntries.id, "e-bsc-2"));
    await db.applyAgentDirectoryActivityWindow({
      source: bscSource,
      handoutBlockWindow: 8_000,
      incrementalRollup: true,
      activity: [secondary(bscKey(1), 120_020_000, Y, X)],
    });
    expect((await entryRow("e-bsc-1")).secondaryTransferCount).toBe(3);
    // Not named by the window, so not recomputed: the planted value survives.
    expect((await entryRow("e-bsc-2")).handoutCount).toBe(999);

    // The default (whole-source) recompute converges everything again.
    await db.applyAgentDirectoryActivityWindow({ source: bscSource, handoutBlockWindow: 8_000, activity: [secondary(bscKey(1), 120_020_000, Y, X)] });
    expect((await entryRow("e-bsc-2")).handoutCount).toBe(0);
  });

  it("handles a window naming more keys than one statement carries", async () => {
    const activity = Array.from({ length: 2_500 }, (_, index) => mint(bscKey(10_000 + index), 121_000_000 + index, X));
    await db.applyAgentDirectoryActivityWindow({ source: bscSource, handoutBlockWindow: 8_000, incrementalRollup: true, activity });
    const [{ total }] = await writer
      .select({ total: sql<number>`count(*)` })
      .from(schema.agentDirectoryChainActivity)
      .where(and(eq(schema.agentDirectoryChainActivity.sourceId, "src-bsc"), eq(schema.agentDirectoryChainActivity.kind, "mint")));
    expect(Number(total)).toBe(2 + 2_500);
  });

  it("leaves Robinhood's numbers exactly as they were after all of that", async () => {
    const totals = await db.readAgentDirectoryActivityTotals();
    expect([totals.mintedEntries, totals.secondaryTransfers, totals.handoutTransfers, totals.uriUpdates, totals.measuredThroughBlock]).toEqual([2, 2, 1, 1, 50_000]);
  });
});
