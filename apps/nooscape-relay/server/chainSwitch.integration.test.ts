import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { BASE_CHAIN } from "./ingestion/erc8004Chains";

/**
 * What a switch does to the public reads, on a real database (docs/multichain-erc8004-2026-10-20.md, stage 3). Ethereum, Base and
 * Arc are read from VITE_FEATURES as the server runs. While a chain's switch is off, nothing of it is counted, listed, searched,
 * found by key, read as an entry, named in the source list or given a row in the chain tabs, whatever its source and entries hold;
 * with every switch off the reads give what they gave before the chains existed. This file runs the same reads with the switches
 * off, on one at a time and all on, on a database before and after migration 0046 (which adds the three protocols to the enum).
 * Skips when no database is reachable.
 */
const TEST_DB = "nooscape_chain_switch_test";
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

const ALL_ON = "chain_ethereum,chain_base,chain_arc";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const baseKey = (id: string) => `eip155:${BASE_CHAIN.chainId}:${BASE_CHAIN.identityRegistry}:${id}`;

describe.skipIf(!dbReachable)("the chain switches on the public reads, against a real database", { timeout: 180_000 }, () => {
  type Db = typeof import("./db");
  let db: Db;
  let readCache: typeof import("./readCache");
  let registry: typeof import("./agentRegistryRows");
  let appRouter: typeof import("./routers").appRouter;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;
  let baseSource: schema.IngestionSource;

  const features = (list: string | undefined) => {
    if (list === undefined) delete process.env.VITE_FEATURES;
    else process.env.VITE_FEATURES = list;
    readCache.invalidateDirectoryReads();
  };
  const chainStats = async () => (await appRouter.createCaller({ req: {}, res: {}, user: null } as never).liveData.chainStats()) as { chains: Array<Record<string, unknown>>; extras?: Array<Record<string, unknown>> };
  const protocolsInBreakdown = async () => (await db.breakdownAgentDirectoryByProtocol()).map(row => `${row.protocol}:${row.count}`).sort();
  const sourceProtocols = async () => (await db.listPublicIngestionSourceStatuses()).map(source => source.protocol).sort();
  const searched = async () => (await db.searchAgentDirectory({ query: "zebracorn", limit: 25 })).entries.map(entry => entry.protocol).sort();

  async function source(id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"], state: "active" | "paused" = "active") {
    await writer.insert(schema.ingestionSources).values({ id, sourceKey: `switch-${id}`, label: id, protocol, rootUrl: "https://switch.example/feed", allowedHostname: "switch.example", state, createdByUserId: operatorUserId });
  }

  async function entries(sourceId: string, prefix: string, count: number, protocol: (typeof schema.agentDirectoryEntries.$inferInsert)["protocol"], extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}) {
    await writer.insert(schema.agentDirectoryEntries).values(
      Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`,
        sourceId,
        externalKey: `key-${prefix}-${index}`,
        displayName: `Zebracorn ${prefix} ${index}`,
        protocol,
        locatorHost: `${prefix}.example.org`,
        firstSeenAt: new Date(Date.UTC(2026, 9, 1, 0, index)),
        ...extra,
      }))
    );
  }

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
    // Migration 0046 is manual and not run by the boot migrations: this database is the one the owner has before pasting it.
    await applyPendingMigrations(process.env.DATABASE_URL);

    db = await import("./db");
    readCache = await import("./readCache");
    registry = await import("./agentRegistryRows");
    appRouter = (await import("./routers")).appRouter;
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "switch-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "switch-operator"));
    operatorUserId = operator.id;

    // The directory as it was before the extra chains: Robinhood Chain and BNB Chain.
    await source("src-robinhood", "erc8004");
    await source("src-bnb", "erc8004_bsc");
    await entries("src-robinhood", "robinhood", 3, "erc8004");
    await entries("src-bnb", "bnb", 4, "erc8004_bsc");
  });

  afterAll(async () => {
    delete process.env.VITE_FEATURES;
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  let before: { breakdown: string[]; sources: string[]; found: string[]; stats: string; count: number };

  it("reads as it always did with every switch off, on a database that has not run migration 0046", async () => {
    features(undefined);
    before = {
      breakdown: await protocolsInBreakdown(),
      sources: await sourceProtocols(),
      found: await searched(),
      stats: JSON.stringify(await chainStats()),
      count: await db.countAgentDirectoryEntries(),
    };
    expect(before.breakdown).toEqual(["erc8004:3", "erc8004_bsc:4"]);
    expect(before.sources).toEqual(["erc8004", "erc8004_bsc"]);
    expect(before.found).toEqual(["erc8004", "erc8004", "erc8004", "erc8004_bsc", "erc8004_bsc", "erc8004_bsc", "erc8004_bsc"]);
    expect(before.count).toBe(7);
    const stats = JSON.parse(before.stats);
    // The answer is the three rows and nothing else: no `extras` key to tell a switch exists.
    expect(Object.keys(stats)).toEqual(["chains"]);
    expect(stats.chains.map((row: { chain: string }) => row.chain)).toEqual(["robinhood", "solana", "bnb"]);
    expect(stats.chains.map((row: { acknowledged: number | null }) => row.acknowledged)).toEqual([3, null, 4]);
  });

  it("reads the same with the switches on but the migration not run: a comparison with a value the enum does not have matches nothing", async () => {
    features(ALL_ON);
    expect(await protocolsInBreakdown()).toEqual(before.breakdown);
    expect(await sourceProtocols()).toEqual(before.sources);
    expect(await searched()).toEqual(before.found);
    expect(await db.findVisibleDirectoryEntriesByKey(["erc8004_base"], baseKey("1"))).toEqual([]);
    const stats = await chainStats();
    expect(JSON.stringify({ chains: stats.chains })).toBe(before.stats);
    // The tabs for the three chains are there and read "not indexed": no source for them has been staged.
    expect(stats.extras!.map(row => row.chain)).toEqual(["ethereum", "base", "arc"]);
    for (const row of stats.extras!) expect(row).toMatchObject({ indexed: false, acknowledged: null, reviewed: null, feedbackEvents: null, registries: [], asOf: null, registry: null });
  });

  describe("after migration 0046", () => {
    beforeAll(async () => {
      const { splitMigrationStatements } = await import("./dbMigrations");
      const owner = await createConnection(process.env.DATABASE_URL!);
      for (const statement of splitMigrationStatements(await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8"))) await owner.query(statement);
      await owner.end();

      await source("src-ethereum", "erc8004_eth");
      await source("src-base", "erc8004_base");
      await source("src-arc", "erc8004_arc");
      await entries("src-arc", "arc", 3, "erc8004_arc");
      // Base goes through the real path: seven registrations recorded, five of them listed and published as entries.
      const [row] = await writer.select().from(schema.ingestionSources).where(eq(schema.ingestionSources.id, "src-base"));
      baseSource = row!;
      const draft = (name: string, over: { displayName?: string; host?: string | null; owner?: string; listing?: 0 | 3 }) => ({
        externalKey: baseKey(name),
        displayName: over.displayName ?? `Zebracorn base ${name}`,
        locatorHost: over.host === undefined ? `host-${name}.example` : over.host,
        registrant: over.owner ?? wallet(Number.parseInt(name, 10) + 5_000_000),
        profileUriHash: hash(`link-${name}`),
        listing: over.listing ?? (3 as const),
        sourceSignalNote: `${BASE_CHAIN.label} ERC-8004 registration.`,
      });
      await registry.insertAgentRegistryRows({
        source: baseSource,
        runId: "run-switch",
        drafts: [
          // Agent 1 shares its wallet with agent 6, which the listing holds out: the look-alike count must include it.
          draft("1", { owner: wallet(42) }),
          draft("2", {}),
          draft("3", {}),
          draft("4", {}),
          draft("5", {}),
          draft("6", { owner: wallet(42), host: null, listing: 0 }),
          draft("7", { displayName: "7" }),
        ],
      });
      await registry.refreshAgentRegistryListing(baseSource, { classify: true, publish: true, rules: BASE_CHAIN.listingRules });
      // Ethereum is mid-walk: four registrations recorded, none published yet. Its tab has no registry sentence until a pass that caught up publishes.
      const [ethereum] = await writer.select().from(schema.ingestionSources).where(eq(schema.ingestionSources.id, "src-ethereum"));
      await registry.insertAgentRegistryRows({
        source: ethereum!,
        runId: "run-switch-eth",
        drafts: ["1", "2", "3", "4"].map(name => ({
          externalKey: `eip155:1:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:${name}`,
          displayName: `Zebracorn ethereum ${name}`,
          locatorHost: `eth-${name}.example`,
          registrant: wallet(9_000_000 + Number.parseInt(name, 10)),
          profileUriHash: hash(`eth-link-${name}`),
          listing: 3 as const,
          sourceSignalNote: "Ethereum ERC-8004 registration.",
        })),
      });
      // The pass keeps a ledger of the registry's events: one mint, which the check reads the ledger's high-water block from.
      await writer.insert(schema.agentDirectoryChainActivity).values({
        id: "activity-base-1",
        sourceId: "src-base",
        transactionHash: `0x${"ab".repeat(32)}`,
        logIndex: 0,
        kind: "mint",
        blockNumber: 41_700_000,
        externalKey: baseKey("1"),
        fromAddress: `0x${"0".repeat(40)}`,
        toAddress: wallet(42),
      });
    });

    const BASE_ENTRY = async () => {
      const [found] = await writer
        .select({ id: schema.agentDirectoryEntries.id })
        .from(schema.agentDirectoryEntries)
        .where(and(eq(schema.agentDirectoryEntries.sourceId, "src-base"), eq(schema.agentDirectoryEntries.externalKey, baseKey("1"))));
      return found!.id;
    };

    it("hides all three chains while every switch is off, though their sources are active and their entries are published", async () => {
      features(undefined);
      expect(await protocolsInBreakdown()).toEqual(before.breakdown);
      expect(await sourceProtocols()).toEqual(before.sources);
      expect(await searched()).toEqual(before.found);
      expect(await db.countAgentDirectoryEntries()).toBe(before.count);
      expect(JSON.stringify(await chainStats())).toBe(before.stats);
      // Found by key, read as an entry and counted by wallet: none of it sees the chain.
      expect(await db.findVisibleDirectoryEntriesByKey(["erc8004_base"], baseKey("1"))).toEqual([]);
      expect(await db.getAgentDirectoryEntry(await BASE_ENTRY())).toBeNull();
      expect(await db.readAgentCheckFacts(await BASE_ENTRY())).toBeNull();
      expect((await db.listVisibleDirectoryKeys([await BASE_ENTRY()])).size).toBe(0);
      expect(await db.listAgentDirectoryWallets(10)).not.toEqual(expect.arrayContaining([expect.objectContaining({ registrant: wallet(42) })]));
    });

    it("shows a chain whose switch is on, and only that chain", async () => {
      features("chain_base");
      expect(await protocolsInBreakdown()).toEqual([...before.breakdown, "erc8004_base:5"].sort());
      expect(await sourceProtocols()).toEqual(["erc8004", "erc8004_base", "erc8004_bsc"]);
      expect(await db.countAgentDirectoryEntries()).toBe(before.count + 5);
      expect((await searched()).filter(protocol => protocol === "erc8004_base")).toHaveLength(5);
      expect(await searched()).not.toContain("erc8004_eth");
      expect(await searched()).not.toContain("erc8004_arc");
      const found = await db.findVisibleDirectoryEntriesByKey(["erc8004_base"], baseKey("1"));
      expect(found).toHaveLength(1);
      // Read as an entry, with the look-alike count taken over the whole registry: the held-out registration by the same wallet is counted.
      const entry = await db.getAgentDirectoryEntry(found[0]!.id);
      expect(entry).toMatchObject({ protocol: "erc8004_base", displayName: "Zebracorn base 1", related: { sameWallet: 1 } });
      expect(entry!.activity!.events).toEqual([expect.objectContaining({ kind: "mint", blockNumber: 41_700_000, isHandout: false })]);
      // The check reads the ledger's high-water block for this chain too, as it does for Robinhood Chain and BNB Chain.
      expect(await db.readAgentCheckFacts(found[0]!.id)).toEqual({ activityThroughBlock: 41_700_000, solana: null });

      const stats = await chainStats();
      expect(JSON.stringify({ chains: stats.chains })).toBe(before.stats);
      expect(stats.extras).toHaveLength(1);
      expect(stats.extras![0]).toMatchObject({ chain: "base", indexed: true, acknowledged: 5, reviewed: 0, feedbackEvents: null, registries: [{ protocol: "erc8004_base", count: 5 }], registry: { recorded: 7, listed: 5 } });
    });

    it("keeps each other chain hidden while its own switch is off, and shows them in the order Ethereum, Base, Arc when all are on", async () => {
      features("chain_ethereum,chain_arc");
      expect(await protocolsInBreakdown()).toEqual([...before.breakdown, "erc8004_arc:3"].sort());
      expect(await db.findVisibleDirectoryEntriesByKey(["erc8004_base"], baseKey("1"))).toEqual([]);
      let stats = await chainStats();
      // Ethereum is indexed (its source is active) but lists nothing yet, and says nothing of the registrations it has recorded, because
      // no pass that caught up has published: a count of a part of the chain would be wrong. Arc has entries and no registry rows.
      expect(stats.extras!.map(row => [row.chain, row.indexed, row.acknowledged, row.registry])).toEqual([["ethereum", true, 0, null], ["arc", true, 3, null]]);

      features(ALL_ON);
      expect(await db.countAgentDirectoryEntries()).toBe(before.count + 8);
      expect(await sourceProtocols()).toEqual(["erc8004", "erc8004_arc", "erc8004_base", "erc8004_bsc", "erc8004_eth"]);
      stats = await chainStats();
      expect(stats.extras!.map(row => [row.chain, row.acknowledged])).toEqual([["ethereum", 0], ["base", 5], ["arc", 3]]);
    });

    it("goes back to what it was when the switches are turned off again", async () => {
      features(undefined);
      expect(await protocolsInBreakdown()).toEqual(before.breakdown);
      expect(await sourceProtocols()).toEqual(before.sources);
      expect(await searched()).toEqual(before.found);
      expect(JSON.stringify(await chainStats())).toBe(before.stats);
    });
  });
});
