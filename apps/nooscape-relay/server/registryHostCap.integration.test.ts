import { and, eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { BASE_CHAIN, validateErc8004Chains, type Erc8004Chain } from "./ingestion/erc8004Chains";
import { hexNum, mintAt, registrationAt, uriUpdateAt, word, type LogShape } from "./ingestion/erc8004TestChain";

/**
 * The host cap on the chain pass, against a real database (docs/flood-host-cap-2026-10-21.md). One platform registered 140,000 agents a day
 * on Base, a registry row and two ledger rows each, against a database limit of 6 GB. A chain with a `hostRowCap` stores no more than that
 * many rows for one host: a registration past it is counted in agent_directory_registry_overflow and gets no row and no ledger event, and
 * neither does anything that later happens to its token. What is held here: the cap stores the first registrations of a host in chain order;
 * the count is exact and does not double when a window is applied again; the events of a stored token are kept and the events of a counted one
 * are dropped; the listing is what it would have been; the registry counts and the groups add the count back; and a chain without a cap (BNB
 * Chain) stores everything. Runs on a throwaway schema and skips when no database is reachable.
 */
const TEST_DB = "nooscape_host_cap_test";
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

const CAP = 8;
/** Base's chain with a small cap and rules that make the cap meaningful: a host of four or more registrations is a platform host, and the cap is twice that. */
const CHAIN: Erc8004Chain = {
  ...BASE_CHAIN,
  hostRowCap: CAP,
  listingRules: { sharedProfileLinkFrom: 2, sharedHostFrom: 4, sharedWalletFrom: 100 },
};
const D = CHAIN.deployBlock;
const FLOOD = "flood.example";
const SOLO = "solo.example";

/** An ABI-encoded `string`, the shape of a Registered log's data. */
function abiString(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const padded = Buffer.concat([bytes, Buffer.alloc((32 - (bytes.length % 32)) % 32)]);
  return `0x${word(32).slice(2)}${word(bytes.length).slice(2)}${padded.toString("hex")}`;
}
const registered = (id: number, block: number, uri: string) => ({ ...registrationAt(CHAIN, id, block, 0), data: abiString(uri) });
const mint = (id: number, block: number) => mintAt(CHAIN, id, block, 1);
const ADDRESS_WORD = (digit: string) => `0x${"0".repeat(24)}${digit.repeat(40)}`;
/** A transfer from a wallet that is not the zero address: a secondary transfer in the ledger. */
const handout = (id: number, block: number): LogShape => {
  const base = mintAt(CHAIN, id, block, 2);
  return { ...base, topics: [base.topics[0]!, ADDRESS_WORD("a"), ADDRESS_WORD("b"), word(id)] };
};
const blockOf = (log: LogShape) => Number.parseInt(log.blockNumber as string, 16);
const keyOf = (id: number) => `eip155:${CHAIN.chainId}:${CHAIN.identityRegistry}:${id}`;

describe.skipIf(!dbReachable)("the host cap, against a real database", { timeout: 180_000 }, () => {
  let registry: typeof import("./agentRegistryRows");
  let readCache: typeof import("./readCache");
  let db: typeof import("./db");
  let run: typeof import("./ingestion/runErc8004Chain").runApprovedErc8004ChainSource;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  const previousFeatures = process.env.VITE_FEATURES;
  let logs: LogShape[] = [];
  let operatorId = 0;

  const sourceId = "src-host-cap";
  const sourceNow = async () => (await db.getIngestionSource(sourceId))!;
  const setCursor = async (cursor: string | null) => {
    await writer.update(schema.ingestionSources).set({ cursor }).where(eq(schema.ingestionSources.id, sourceId));
  };
  const rpcFor = (finalized: number) => async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === "eth_chainId") return CHAIN.chainIdHex;
    if (method === "eth_getBlockByNumber") return { number: hexNum(finalized) };
    if (method === "eth_getLogs") {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      const from = Number.parseInt(filter.fromBlock, 16);
      const to = Number.parseInt(filter.toBlock, 16);
      return logs.filter(log => blockOf(log) >= from && blockOf(log) <= to);
    }
    throw new Error(`unexpected ${method}`);
  };
  const walk = async (chain: Erc8004Chain, finalized: number) => {
    const rpc = rpcFor(finalized);
    for (let runs = 0; runs < 20; runs += 1) {
      const before = (await sourceNow()).cursor;
      await run(chain, await sourceNow(), "manual", "activity", { rpc, budget: { maxWindows: 50, concurrency: 1, maxElapsedMs: 600_000, maxEvents: 1_000_000 } });
      if ((await sourceNow()).cursor === before) return;
    }
    throw new Error("the walk did not converge");
  };
  const storedIds = async (host: string) => {
    const rows = await writer
      .select({ key: schema.agentDirectoryRegistryRows.externalKey })
      .from(schema.agentDirectoryRegistryRows)
      .where(and(eq(schema.agentDirectoryRegistryRows.sourceId, sourceId), eq(schema.agentDirectoryRegistryRows.locatorHost, host)));
    return rows.map(row => Number(row.key.split(":").pop())).sort((a, b) => a - b);
  };
  const overflowOf = async (source = sourceId, host = FLOOD) => {
    const [row] = await writer
      .select()
      .from(schema.agentDirectoryRegistryOverflow)
      .where(and(eq(schema.agentDirectoryRegistryOverflow.sourceId, source), eq(schema.agentDirectoryRegistryOverflow.locatorHost, host)));
    return row ? { count: Number(row.overflowCount), lastBlock: Number(row.lastBlock) } : null;
  };
  const ledger = async () => {
    const rows = await writer
      .select({ kind: schema.agentDirectoryChainActivity.kind, key: schema.agentDirectoryChainActivity.externalKey })
      .from(schema.agentDirectoryChainActivity)
      .where(eq(schema.agentDirectoryChainActivity.sourceId, sourceId));
    const idOf = (key: string) => Number(key.split(":").pop());
    return {
      total: rows.length,
      mints: rows.filter(row => row.kind === "mint").map(row => idOf(row.key)).sort((a, b) => a - b),
      secondary: rows.filter(row => row.kind === "secondary").map(row => idOf(row.key)).sort((a, b) => a - b),
      uriUpdates: rows.filter(row => row.kind === "uri_update").map(row => idOf(row.key)).sort((a, b) => a - b),
    };
  };
  const rowCount = async (table: typeof schema.agentDirectoryRegistryRows | typeof schema.agentDirectoryEntries) => {
    const [{ total }] = await writer.select({ total: sql<number>`count(*)` }).from(table).where(eq(table.sourceId, sourceId));
    return Number(total);
  };
  const listingCounts = async () => {
    const rows = await writer
      .select({ listing: schema.agentDirectoryRegistryRows.listing, total: sql<number>`count(*)` })
      .from(schema.agentDirectoryRegistryRows)
      .where(eq(schema.agentDirectoryRegistryRows.sourceId, sourceId))
      .groupBy(schema.agentDirectoryRegistryRows.listing);
    return Object.fromEntries(rows.map(row => [row.listing, Number(row.total)]));
  };

  // Window one: twelve registrations from one host (agents 1 to 12), three from another (101 to 103), then a hand-out and a URI update for a
  // token that is stored and for one that is not. (The URI update gives agent 101 a link on another host, so it leaves its first one.) Window two: four more from the first host (13 to 16) and a hand-out for each kind of token.
  const firstWindow = () => [
    ...Array.from({ length: 12 }, (_, i) => [registered(i + 1, D + 100 + i, `https://${FLOOD}/a/${i + 1}`), mint(i + 1, D + 100 + i)]).flat(),
    ...Array.from({ length: 3 }, (_, i) => [registered(101 + i, D + 200 + i, `https://${SOLO}/agent/${101 + i}`), mint(101 + i, D + 200 + i)]).flat(),
    handout(3, D + 300),
    handout(9, D + 301),
    uriUpdateAt(CHAIN, 101, D + 310),
    uriUpdateAt(CHAIN, 10, D + 311),
  ];
  const secondWindow = () => [
    ...Array.from({ length: 4 }, (_, i) => [registered(13 + i, D + 1100 + i, `https://${FLOOD}/a/${13 + i}`), mint(13 + i, D + 1100 + i)]).flat(),
    handout(14, D + 1200),
    handout(4, D + 1201),
  ];
  const FINALIZED = D + 2500;

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    process.env.VITE_FEATURES = "chain_base";
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    const baselineReplay = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baselineReplay.query(statement);
    }
    await baselineReplay.end();
    // The boot runner applies 0047 (the overflow table) and skips the manual migrations; 0046 is pasted for the Base protocol value.
    const applied = await applyPendingMigrations(process.env.DATABASE_URL);
    expect(applied.some(name => name.startsWith("0047_"))).toBe(true);
    const connection = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8"))) await connection.query(statement);
    await connection.end();

    db = await import("./db");
    registry = await import("./agentRegistryRows");
    readCache = await import("./readCache");
    ({ runApprovedErc8004ChainSource: run } = await import("./ingestion/runErc8004Chain"));
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "host-cap-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "host-cap-operator"));
    operatorId = operator.id;
    await writer.insert(schema.ingestionSources).values({
      id: sourceId,
      sourceKey: CHAIN.sourceKey,
      label: "Base ERC-8004 identity registry",
      protocol: "erc8004_base",
      rootUrl: "https://base-mainnet.g.alchemy.com",
      allowedHostname: "base-mainnet.g.alchemy.com",
      state: "active",
      createdByUserId: operatorId,
    });
  });

  afterAll(async () => {
    if (previousFeatures === undefined) delete process.env.VITE_FEATURES;
    else process.env.VITE_FEATURES = previousFeatures;
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("is a valid chain entry: the cap leaves a host's stored rows over the bar the listing rule counts them against", () => {
    expect(validateErc8004Chains([CHAIN])).toEqual([]);
  });

  describe("the pass with a cap of eight rows a host", () => {
    it("stores the first eight registrations of the busy host and all of the small one, and counts the other four", async () => {
      logs = firstWindow();
      await walk(CHAIN, D + 999);
      expect(await storedIds(FLOOD)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(await storedIds(SOLO)).toEqual([102, 103]);
      expect(await rowCount(schema.agentDirectoryRegistryRows)).toBe(11);
      expect(await overflowOf()).toEqual({ count: 4, lastBlock: D + 111 });
      expect(await overflowOf(sourceId, SOLO)).toBeNull();
    });

    it("keeps the ledger events of stored tokens and drops those of the counted ones, mints included", async () => {
      expect(await ledger()).toEqual({ total: 13, mints: [1, 2, 3, 4, 5, 6, 7, 8, 101, 102, 103], secondary: [3], uriUpdates: [101] });
    });

    it("rolls the kept events up onto their rows and leaves the rest alone", async () => {
      const [three] = await writer.select().from(schema.agentDirectoryRegistryRows).where(eq(schema.agentDirectoryRegistryRows.externalKey, keyOf(3)));
      const [oneOhOne] = await writer.select().from(schema.agentDirectoryRegistryRows).where(eq(schema.agentDirectoryRegistryRows.externalKey, keyOf(101)));
      expect(three!.secondaryTransferCount).toBe(1);
      expect(three!.mintBlock).toBe(D + 102);
      expect(oneOhOne!.uriUpdateCount).toBe(1);
      expect(oneOhOne!.locatorHost).not.toBe(SOLO);
    });

    it("lists what it would have listed: the busy host is held out as a platform host and the small one is published", async () => {
      // 0 = no link, 1 = listed, 2 = grouped, 3 = pending, 4 = numeric name
      expect(await listingCounts()).toEqual({ 1: 3, 2: 8 });
      expect(await rowCount(schema.agentDirectoryEntries)).toBe(3);
    });

    it("counts a second window's registrations from the busy host and stores none of them", async () => {
      logs = [...firstWindow(), ...secondWindow()];
      await walk(CHAIN, FINALIZED);
      expect(await storedIds(FLOOD)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(await overflowOf()).toEqual({ count: 8, lastBlock: D + 1103 });
      // The hand-out of a stored token (agent 4) is kept; the hand-out of a counted one (agent 14) is dropped.
      expect(await ledger()).toEqual({ total: 14, mints: [1, 2, 3, 4, 5, 6, 7, 8, 101, 102, 103], secondary: [3, 4], uriUpdates: [101] });
    });

    it("reads the registry as a whole: every registration is recorded, stored or counted", async () => {
      readCache.invalidateDirectoryReads();
      expect(await registry.readRegistryCounts("erc8004_base")).toEqual({ recorded: 11 + 8, listed: 3 });
      const read = (await registry.readRegistryGroups("erc8004_base", 4, 8))!;
      expect(read.recorded).toBe(19);
      expect(read.groups.filter(group => group.kind === "platform_host")).toEqual([{ kind: "platform_host", key: FLOOD, count: 16, host: FLOOD, name: null }]);
      expect(read.totals.platform_host).toBe(1);
    });

    it("changes nothing when the same windows are applied again", async () => {
      await setCursor(null);
      await walk(CHAIN, FINALIZED);
      expect(await storedIds(FLOOD)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(await rowCount(schema.agentDirectoryRegistryRows)).toBe(11);
      expect(await overflowOf()).toEqual({ count: 8, lastBlock: D + 1103 });
      expect((await ledger()).total).toBe(14);
      readCache.invalidateDirectoryReads();
      expect((await registry.readRegistryCounts("erc8004_base"))!.recorded).toBe(19);
    });
  });

  describe("keepWithinHostCap on its own", () => {
    const item = (host: string | null, block: number, id: number) => ({ host, blockNumber: block, externalKey: `eip155:${CHAIN.chainId}:${CHAIN.identityRegistry}:${id}`, id });
    const draftOf = (entry: ReturnType<typeof item>) => ({
      externalKey: entry.externalKey,
      displayName: `Agent #${entry.id}`,
      locatorHost: entry.host,
      registrant: `0x${"0".repeat(39)}${entry.id % 10}`,
      profileUriHash: `hash-${entry.id}`,
      listing: 3 as const,
      sourceSignalNote: "test",
    });
    const second = "src-host-cap-direct";

    beforeAll(async () => {
      await writer.insert(schema.ingestionSources).values({
        id: second,
        sourceKey: "ethereum-erc8004-identity-registry",
        label: "Ethereum ERC-8004 identity registry",
        protocol: "erc8004_eth",
        rootUrl: "https://eth-mainnet.nodereal.io",
        allowedHostname: "eth-mainnet.nodereal.io",
        state: "active",
        createdByUserId: operatorId,
      });
    });

    const asSource = async () => (await db.getIngestionSource(second))!;

    it("never caps a registration with no https host", async () => {
      const items = [item(null, 10, 9001), item(null, 11, 9002)];
      expect(await registry.keepWithinHostCap(await asSource(), items, 1)).toEqual({ kept: items, counted: 0 });
    });

    it("keeps the first registrations of a host in order and counts the rest once, however often it is asked", async () => {
      const items = Array.from({ length: 8 }, (_, i) => item("direct.example", 100 + i, 9100 + i));
      const first = await registry.keepWithinHostCap(await asSource(), items, 5);
      expect(first.kept.map(entry => entry.id)).toEqual([9100, 9101, 9102, 9103, 9104]);
      expect(first.counted).toBe(3);
      // The caller stores what was kept; the same window then arrives again.
      await registry.insertAgentRegistryRows({ source: await asSource(), runId: "run-direct", drafts: first.kept.map(draftOf) });
      const again = await registry.keepWithinHostCap(await asSource(), items, 5);
      expect(again.kept.map(entry => entry.id)).toEqual([9100, 9101, 9102, 9103, 9104]);
      expect(again.counted).toBe(0);
      expect(await overflowOf(second, "direct.example")).toEqual({ count: 3, lastBlock: 107 });
    });

    it("does not count a registration that has a row, even when the host has no room left", async () => {
      // A window that stored all four of its registrations while the host had room, then arrives again with the host at its cap.
      const items = Array.from({ length: 4 }, (_, i) => item("late.example", 200 + i, 9200 + i));
      const first = await registry.keepWithinHostCap(await asSource(), items, 5);
      expect(first).toEqual({ kept: items, counted: 0 });
      await registry.insertAgentRegistryRows({ source: await asSource(), runId: "run-late", drafts: first.kept.map(draftOf) });
      await registry.insertAgentRegistryRows({ source: await asSource(), runId: "run-late", drafts: [item("late.example", 300, 9300)].map(draftOf) });
      const again = await registry.keepWithinHostCap(await asSource(), items, 4);
      expect(again).toEqual({ kept: items, counted: 0 });
      expect(await overflowOf(second, "late.example")).toBeNull();
    });

    it("reads the room of every host of a window, past the 1,000 hosts that one grouped count carries", async () => {
      // 1,100 hosts of one registration each. Two of them already hold their cap of three rows: one is read by the first count, the other
      // (the 1,051st) by the second. Every other host has room, and only those two registrations are counted.
      const hosts = Array.from({ length: 1_100 }, (_, i) => `many-${String(i).padStart(4, "0")}.example`);
      const fullHosts = [hosts[10]!, hosts[1_050]!];
      const stored = fullHosts.flatMap((host, h) => Array.from({ length: 3 }, (_, i) => item(host, 500 + i, 9500 + h * 10 + i)));
      await registry.insertAgentRegistryRows({ source: await asSource(), runId: "run-many", drafts: stored.map(draftOf) });
      const items = hosts.map((host, i) => item(host, 600 + i, 9600 + i));
      const { kept, counted } = await registry.keepWithinHostCap(await asSource(), items, 3);
      expect(counted).toBe(2);
      expect(kept.map(entry => entry.host)).toEqual(hosts.filter(host => !fullHosts.includes(host)));
      expect(await overflowOf(second, fullHosts[0]!)).toEqual({ count: 1, lastBlock: 610 });
      expect(await overflowOf(second, fullHosts[1]!)).toEqual({ count: 1, lastBlock: 1_650 });
    });

    it("keeps only the events of stored tokens", async () => {
      const events = [item("x", 1, 9100), item("x", 2, 9107), item("x", 3, 9200)];
      const kept = await registry.keepStoredTokens(second, events);
      expect(kept.map(event => event.id)).toEqual([9100, 9200]);
      expect(await registry.keepStoredTokens(second, [])).toEqual([]);
    });

    it("refuses a cap that is not a positive whole number", async () => {
      await expect(registry.keepWithinHostCap(await asSource(), [item("direct.example", 1, 1)], 0)).rejects.toThrow(/positive whole number/);
    });
  });

  describe("a chain without a cap", () => {
    it("stores every registration and every event, as BNB Chain always has", async () => {
      const uncapped: Erc8004Chain = { ...CHAIN, hostRowCap: undefined };
      await setCursor(null);
      await writer.delete(schema.agentDirectoryChainActivity).where(eq(schema.agentDirectoryChainActivity.sourceId, sourceId));
      await writer.delete(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.sourceId, sourceId));
      await writer.delete(schema.agentDirectoryRegistryRows).where(eq(schema.agentDirectoryRegistryRows.sourceId, sourceId));
      logs = [...firstWindow(), ...secondWindow()];
      await walk(uncapped, FINALIZED);
      expect(await rowCount(schema.agentDirectoryRegistryRows)).toBe(19);
      expect((await ledger()).secondary).toEqual([3, 4, 9, 14]);
      expect((await ledger()).uriUpdates).toEqual([10, 101]);
    });
  });
});
