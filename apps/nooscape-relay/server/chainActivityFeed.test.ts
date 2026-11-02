import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { ARC_CHAIN } from "./ingestion/erc8004Chains";
import { ROBINHOOD_HANDOUT_BLOCK_WINDOW } from "./ingestion/robinhood";

/**
 * The feed on Arc's own page (docs/arc-feed-2026-11-02.md), against a real database with three chains in one activity ledger. The ledger holds
 * every event of every stored registration; the feed names only the entries the directory lists, under the directory's own visibility rule, scopes
 * to Arc, reads Arc's own mint hour for a hand-out, and says which block the chain's ledger is measured through. Robinhood Chain's feed, which
 * shares the read, must not move. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_chain_feed_test";
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
const arcKey = (id: number) => `eip155:${ARC_CHAIN.chainId}:${REGISTRY}:${id}`;
const rhKey = (id: number) => `eip155:4663:${REGISTRY}:${id}`;
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");

type Event = { kind: "mint" | "secondary" | "uri_update"; externalKey: string; blockNumber: number; transactionHash: string; logIndex: number; fromAddress: string | null; toAddress: string | null };
let txCounter = 1;
const mint = (key: string, block: number, to: string): Event => ({ kind: "mint", externalKey: key, blockNumber: block, transactionHash: tx(txCounter++), logIndex: 0, fromAddress: ZERO, toAddress: to });
const secondary = (key: string, block: number, from: string, to: string, logIndex = 0): Event => ({ kind: "secondary", externalKey: key, blockNumber: block, transactionHash: tx(txCounter++), logIndex, fromAddress: from, toAddress: to });
const uriUpdate = (key: string, block: number, logIndex = 0): Event => ({ kind: "uri_update", externalKey: key, blockNumber: block, transactionHash: tx(txCounter++), logIndex, fromAddress: null, toAddress: null });

const MINT = 29_000_000;
const WINDOW = ARC_CHAIN.handoutBlockWindow;

describe.skipIf(!dbReachable)("the feed on an extra chain's own page, against a real database", { timeout: 180_000 }, () => {
  type Db = typeof import("./db");
  let db: Db;
  let readCache: typeof import("./readCache");
  let appRouter: typeof import("./routers").appRouter;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let rhSource: NonNullable<Awaited<ReturnType<Db["getIngestionSource"]>>>;
  let arcSource: NonNullable<Awaited<ReturnType<Db["getIngestionSource"]>>>;

  const features = (list: string | undefined) => {
    if (list === undefined) delete process.env.VITE_FEATURES;
    else process.env.VITE_FEATURES = list;
    readCache.invalidateDirectoryReads();
  };
  const caller = () => appRouter.createCaller({ req: {}, res: {}, user: null } as never);
  const summary = (feed: Array<{ blockNumber: number; logIndex: number; kind: string; entryId: string; isHandout: boolean }>) =>
    feed.map(event => [event.blockNumber, event.logIndex, event.kind, event.entryId, event.isHandout]);

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
    // The migrations that add the extra chains' protocols are manual: the boot runner skips them (as the registry-groups test does).
    const owner = await createConnection(process.env.DATABASE_URL);
    for (const name of ["0046_multichain_erc8004_protocols", "0051_solana_agenc_protocol", "0053_monad_erc8004_protocol"]) {
      for (const statement of splitMigrationStatements(await readFile(`drizzle/${name}.sql`, "utf8"))) await owner.query(statement);
    }
    await owner.end();

    db = await import("./db");
    readCache = await import("./readCache");
    appRouter = (await import("./routers")).appRouter;
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "chain-feed-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "chain-feed-operator"));
    const sources = [
      { id: "src-rh", key: "robinhood-erc8004-identity-registry", protocol: "erc8004" as const, host: "rpc.mainnet.chain.robinhood.com" },
      { id: "src-arc", key: ARC_CHAIN.sourceKey, protocol: "erc8004_arc" as const, host: "arc.example" },
    ];
    for (const source of sources) {
      await writer.insert(schema.ingestionSources).values({ id: source.id, sourceKey: source.key, label: source.key, protocol: source.protocol, rootUrl: `https://${source.host}`, allowedHostname: source.host, state: "active", createdByUserId: operator.id });
    }
    // Listed entries, one that an operator hid, and a name that carries control and invisible characters. Token 4 is a registration the
    // directory does not list: it has events in the ledger and no entry.
    const dirty = `Clean${String.fromCharCode(0)}Name${String.fromCharCode(0x200b)}`;
    const entries = [
      { id: "e-rh-1", sourceId: "src-rh", protocol: "erc8004" as const, key: rhKey(1), name: "Robinhood agent one", hidden: false },
      { id: "e-arc-1", sourceId: "src-arc", protocol: "erc8004_arc" as const, key: arcKey(1), name: "Arc agent one", hidden: false },
      { id: "e-arc-2", sourceId: "src-arc", protocol: "erc8004_arc" as const, key: arcKey(2), name: "Arc agent two", hidden: false },
      { id: "e-arc-hidden", sourceId: "src-arc", protocol: "erc8004_arc" as const, key: arcKey(3), name: "Arc agent hidden", hidden: true },
      { id: "e-arc-dirty", sourceId: "src-arc", protocol: "erc8004_arc" as const, key: arcKey(5), name: dirty, hidden: false },
    ];
    for (const entry of entries) {
      await writer.insert(schema.agentDirectoryEntries).values({ id: entry.id, sourceId: entry.sourceId, externalKey: entry.key, displayName: entry.name, protocol: entry.protocol, hidden: entry.hidden });
    }
    rhSource = (await db.getIngestionSource("src-rh"))!;
    arcSource = (await db.getIngestionSource("src-arc"))!;

    await db.applyAgentDirectoryActivityWindow({ source: rhSource, activity: [mint(rhKey(1), 1_000, A), secondary(rhKey(1), 2_000, A, B)] });
    await db.applyAgentDirectoryActivityWindow({
      source: arcSource,
      handoutBlockWindow: WINDOW,
      activity: [
        mint(arcKey(1), MINT, A),
        // The last block of Arc's mint hour is a hand-out, the next block is not, and 10,000 blocks is inside Robinhood Chain's hour and outside Arc's.
        secondary(arcKey(1), MINT + WINDOW, A, B),
        secondary(arcKey(1), MINT + WINDOW + 1, A, B),
        secondary(arcKey(1), MINT + 10_000, A, B),
        uriUpdate(arcKey(1), MINT + 20_000),
        mint(arcKey(2), MINT + 500, B),
        // Two events in one block: the later log first.
        uriUpdate(arcKey(2), MINT + 1_000, 1),
        secondary(arcKey(2), MINT + 1_000, B, A, 5),
        mint(arcKey(5), MINT + 15_000, A),
        // Events of a hidden entry and of a registration nobody lists: newer than every listed one.
        mint(arcKey(3), MINT + 30_000, A),
        mint(arcKey(4), MINT + 40_000, A),
      ],
    });
  });

  afterAll(async () => {
    delete process.env.VITE_FEATURES;
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("lists the events of the entries the directory lists on Arc, newest block first and the later log first within a block", async () => {
    features("chain_arc");
    const { feed } = await db.readChainActivityFeed("erc8004_arc");
    expect(summary(feed)).toEqual([
      [MINT + 20_000, 0, "uri_update", "e-arc-1", false],
      [MINT + 15_000, 0, "mint", "e-arc-dirty", false],
      [MINT + 10_000, 0, "secondary", "e-arc-1", false],
      [MINT + WINDOW + 1, 0, "secondary", "e-arc-1", false],
      [MINT + WINDOW, 0, "secondary", "e-arc-1", true],
      [MINT + 1_000, 5, "secondary", "e-arc-2", true],
      [MINT + 1_000, 1, "uri_update", "e-arc-2", false],
      [MINT + 500, 0, "mint", "e-arc-2", false],
      [MINT, 0, "mint", "e-arc-1", false],
    ]);
    expect(feed.every(event => event.transactionHash.startsWith("0x") && event.displayName.length > 0)).toBe(true);
    expect(feed.find(event => event.kind === "mint" && event.entryId === "e-arc-1")).toMatchObject({ displayName: "Arc agent one", fromAddress: ZERO, toAddress: A });
  });

  it("names neither an entry an operator hid nor a registration the directory does not list, though both have events in the ledger", async () => {
    features("chain_arc");
    const { feed } = await db.readChainActivityFeed("erc8004_arc");
    expect(feed.map(event => event.entryId)).not.toContain("e-arc-hidden");
    expect(feed.some(event => event.blockNumber === MINT + 30_000 || event.blockNumber === MINT + 40_000)).toBe(false);
  });

  it("measures the feed through the highest block the chain's ledger holds, the events of registrations it does not name included", async () => {
    features("chain_arc");
    expect((await db.readChainActivityFeed("erc8004_arc")).measuredThroughBlock).toBe(MINT + 40_000);
  });

  it("calls a transfer a hand-out by Arc's own mint hour, not Robinhood Chain's", async () => {
    features("chain_arc");
    const { feed } = await db.readChainActivityFeed("erc8004_arc");
    const at = (block: number) => feed.find(event => event.blockNumber === block && event.kind === "secondary")!;
    expect(at(MINT + WINDOW).isHandout).toBe(true);
    expect(at(MINT + WINDOW + 1).isHandout).toBe(false);
    // Inside Robinhood Chain's hour and outside Arc's: a window borrowed from Robinhood Chain would call it a hand-out.
    expect(10_000).toBeLessThanOrEqual(ROBINHOOD_HANDOUT_BLOCK_WINDOW);
    expect(10_000).toBeGreaterThan(WINDOW);
    expect(at(MINT + 10_000).isHandout).toBe(false);
  });

  it("cleans a name of control and invisible characters, as the listed sample's names are", async () => {
    features("chain_arc");
    const { feed } = await db.readChainActivityFeed("erc8004_arc");
    expect(feed.find(event => event.entryId === "e-arc-dirty")!.displayName).toBe("Clean Name");
  });

  it("leaves Robinhood Chain's feed and totals as they were, and keeps its rows out of Arc's", async () => {
    features("chain_arc");
    const robinhood = await db.readAgentDirectoryActivityFeed();
    expect(robinhood.map(event => [event.blockNumber, event.entryId])).toEqual([
      [2_000, "e-rh-1"],
      [1_000, "e-rh-1"],
    ]);
    expect(robinhood.find(event => event.blockNumber === 2_000)!.isHandout).toBe(true);
    const totals = await db.readAgentDirectoryActivityTotals();
    expect([totals.mintedEntries, totals.secondaryTransfers, totals.measuredThroughBlock]).toEqual([1, 1, 2_000]);
    const { feed } = await db.readChainActivityFeed("erc8004_arc");
    expect(feed.map(event => event.entryId)).not.toContain("e-rh-1");
  });

  it("answers nothing, and no block, while no source of the chain is active, and the same as before once one is", async () => {
    features("chain_arc");
    const before = await db.readChainActivityFeed("erc8004_arc");
    await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-arc"));
    readCache.invalidateDirectoryReads();
    try {
      expect(await db.readChainActivityFeed("erc8004_arc")).toEqual({ feed: [], measuredThroughBlock: null });
    } finally {
      await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, "src-arc"));
      readCache.invalidateDirectoryReads();
    }
    expect(await db.readChainActivityFeed("erc8004_arc")).toEqual(before);
  });

  it("is served through the public read only while Arc's switch is on, and only for Arc", async () => {
    features("chain_arc");
    const direct = await db.readChainActivityFeed("erc8004_arc");
    expect(await caller().liveData.chainActivityFeed({ chain: "arc" })).toEqual(direct);
    expect(direct.feed).toHaveLength(9);

    for (const list of [undefined, "", "chain_base,chain_ethereum,chain_monad"]) {
      features(list);
      expect(await caller().liveData.chainActivityFeed({ chain: "arc" }), String(list)).toEqual({ feed: [], measuredThroughBlock: null });
    }
    // The directory's own rule hides the chain's entries while its switch is off, so even the read underneath names none.
    features(undefined);
    expect((await db.readChainActivityFeed("erc8004_arc")).feed).toEqual([]);

    features("chain_arc");
    await expect(caller().liveData.chainActivityFeed({ chain: "base" as never })).rejects.toThrow();
    await expect(caller().liveData.chainActivityFeed({ chain: "robinhood" as never })).rejects.toThrow();
  });

  it("holds at 40 events, the newest, when more are recorded", async () => {
    features("chain_arc");
    const rows = Array.from({ length: 45 }, (_, index) => ({ id: `e-arc-more-${index}`, sourceId: "src-arc", externalKey: arcKey(1_000 + index), displayName: `More agent ${index}`, protocol: "erc8004_arc" as const }));
    await writer.insert(schema.agentDirectoryEntries).values(rows);
    await db.applyAgentDirectoryActivityWindow({
      source: arcSource,
      handoutBlockWindow: WINDOW,
      incrementalRollup: true,
      activity: rows.map((row, index) => mint(row.externalKey, 30_000_000 + index, A)),
    });
    readCache.invalidateDirectoryReads();
    const { feed } = await db.readChainActivityFeed("erc8004_arc");
    expect(feed).toHaveLength(40);
    expect(feed[0]!.blockNumber).toBe(30_000_044);
    expect(feed.at(-1)!.blockNumber).toBe(30_000_005);
    expect(feed.every((event, index) => index === 0 || feed[index - 1]!.blockNumber > event.blockNumber)).toBe(true);
  });
});
