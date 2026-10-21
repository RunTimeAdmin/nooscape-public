import { and, eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN, type Erc8004Chain } from "./ingestion/erc8004Chains";
import { ARC_FIXTURES, BASE_FIXTURES, ETHEREUM_FIXTURES, type ChainFixtureLog, type ChainFixtures } from "./ingestion/erc8004ChainFixtures";

/**
 * The identity pass on Ethereum, Base and Arc against a real database, with a fake node that serves the REAL registry logs
 * recorded from each chain. It also shows what migration 0046 is for: on a database built the way boot builds it (which skips the
 * manual migrations) the new protocol values are refused, and after the file is pasted, twice, they are accepted and nothing else
 * has changed. What is checked is the stored result against facts an independent Python decode found: the registry rows, the
 * listing, the published entries, the ledger, the rollups, the URI update that gives an empty URI an IPFS link, and that three
 * chains share one database without touching each other. Runs on a throwaway schema and skips when no database is reachable.
 */
const TEST_DB = "nooscape_multichain_pass_test";
const BASE_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";
const PROTOCOL_TABLES = ["agent_directory_entries", "agent_directory_registry_rows", "ingestion_sources", "source_observations"];

const dbReachable = await (async () => {
  try {
    const probe = await createConnection(`${BASE_URL}/mysql`);
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

const hex = (value: number) => `0x${value.toString(16)}`;
const blockOf = (log: ChainFixtureLog) => Number.parseInt(log.blockNumber as string, 16);
const CASES: Array<[string, Erc8004Chain, ChainFixtures]> = [
  ["Ethereum", ETHEREUM_CHAIN, ETHEREUM_FIXTURES],
  ["Base", BASE_CHAIN, BASE_FIXTURES],
  ["Arc", ARC_CHAIN, ARC_FIXTURES],
];

/** The URI an agent ends the walk with: its latest recorded update, else the one it registered with. */
function finalFacts(fixtures: ChainFixtures, agentId: string) {
  const updates = fixtures.uriUpdates.filter(update => update.agentId === agentId).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const last = updates.at(-1);
  const registered = Object.values(fixtures.registered).find(entry => entry.expected.agentId === agentId)!.expected;
  return last
    ? { kind: last.newKind, hash: last.profileUriHash, host: last.locatorHost, updates: updates.length }
    : { kind: registered.uriKind, hash: registered.profileUriHash, host: registered.locatorHost, updates: 0 };
}
/** What the listing rules do to one registration: a web link, an IPFS reference or inline JSON that parsed is listed (nothing here is shared); the rest is held out. */
const expectedListing = (kind: string) => (kind === "web" || kind === "ipfs" || kind === "inline-json" ? 1 : 0);

describe.skipIf(!dbReachable)("the Ethereum, Base and Arc identity passes against a real database", { timeout: 120_000 }, () => {
  type Db = typeof import("./db");
  let db: Db;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let run: typeof import("./ingestion/runErc8004Chain").runApprovedErc8004ChainSource;
  const previousFeatures = process.env.VITE_FEATURES;
  const columnTypes: { before: Record<string, string>; afterFirst: Record<string, string>; afterSecond: Record<string, string> } = { before: {}, afterFirst: {}, afterSecond: {} };
  let refusedBeforeMigration: { threw: boolean; stored: string | null } = { threw: false, stored: null };

  const sourceId = (chain: Erc8004Chain) => `src-${chain.chainKey}`;
  const rpcFor = (chain: Erc8004Chain, fixtures: ChainFixtures, finalized: number) => {
    const logs = [
      ...Object.values(fixtures.registered).map(entry => entry.log),
      ...Object.values(fixtures.mints),
      fixtures.secondary.log,
      ...fixtures.uriUpdates.map(update => update.log),
    ];
    let logCalls = 0;
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      if (method === "eth_chainId") return fixtures.chainId;
      if (method === "eth_getBlockByNumber") return { number: hex(finalized) };
      if (method === "eth_getLogs") {
        logCalls += 1;
        const filter = params[0] as { fromBlock: string; toBlock: string; address: string };
        expect(filter.address).toBe(chain.identityRegistry);
        const from = Number.parseInt(filter.fromBlock, 16);
        const to = Number.parseInt(filter.toBlock, 16);
        return logs.filter(log => blockOf(log) >= from && blockOf(log) <= to);
      }
      throw new Error(`unexpected ${method}`);
    };
    return { rpc, logCalls: () => logCalls };
  };
  const finalizedOf = (fixtures: ChainFixtures) => Math.max(...[...Object.values(fixtures.registered).map(e => e.log), fixtures.secondary.log, ...fixtures.uriUpdates.map(u => u.log)].map(blockOf)) + 5;
  const sourceNow = async (chain: Erc8004Chain) => (await db.getIngestionSource(sourceId(chain)))!;
  const runToCompletion = async (chain: Erc8004Chain, fixtures: ChainFixtures, maxWindows = 100) => {
    const { rpc } = rpcFor(chain, fixtures, finalizedOf(fixtures));
    let runs = 0;
    for (;;) {
      const before = (await sourceNow(chain)).cursor;
      await run(chain, await sourceNow(chain), "manual", "activity", { rpc, budget: { maxWindows, concurrency: 8, maxElapsedMs: 600_000, maxEvents: 1_000_000 } });
      runs += 1;
      if ((await sourceNow(chain)).cursor === before) return runs;
      if (runs > 200) throw new Error("the walk did not converge");
    }
  };
  const keyOf = (chain: Erc8004Chain, agentId: string) => `eip155:${chain.chainId}:${chain.identityRegistry}:${agentId}`;
  const registryRow = async (chain: Erc8004Chain, agentId: string) => {
    const [row] = await writer
      .select()
      .from(schema.agentDirectoryRegistryRows)
      .where(and(eq(schema.agentDirectoryRegistryRows.sourceId, sourceId(chain)), eq(schema.agentDirectoryRegistryRows.externalKey, keyOf(chain, agentId))));
    return row;
  };
  const entryRow = async (chain: Erc8004Chain, agentId: string) => {
    const [row] = await writer
      .select()
      .from(schema.agentDirectoryEntries)
      .where(and(eq(schema.agentDirectoryEntries.sourceId, sourceId(chain)), eq(schema.agentDirectoryEntries.externalKey, keyOf(chain, agentId))));
    return row;
  };
  const countIn = async (table: typeof schema.agentDirectoryRegistryRows | typeof schema.agentDirectoryEntries, chain: Erc8004Chain) => {
    const [{ total }] = await writer.select({ total: sql<number>`count(*)` }).from(table).where(eq(table.sourceId, sourceId(chain)));
    return Number(total);
  };
  const columnTypesNow = async (connectionUrl: string) => {
    const connection = await createConnection(connectionUrl);
    try {
      const [rows] = (await connection.query(
        "SELECT TABLE_NAME AS t, COLUMN_TYPE AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'protocol' AND TABLE_NAME IN (?) ORDER BY TABLE_NAME",
        [TEST_DB, PROTOCOL_TABLES]
      )) as unknown as [Array<{ t: string; c: string }>];
      return Object.fromEntries(rows.map(row => [row.t, row.c]));
    } finally {
      await connection.end();
    }
  };

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    process.env.VITE_FEATURES = "chain_ethereum,chain_base,chain_arc";
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    const baselineReplay = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baselineReplay.query(statement);
    }
    await baselineReplay.end();
    // The boot runner skips the manual migrations, so this is the database the code meets before the owner pastes 0046.
    await applyPendingMigrations(process.env.DATABASE_URL);
    columnTypes.before = await columnTypesNow(process.env.DATABASE_URL);

    db = await import("./db");
    ({ runApprovedErc8004ChainSource: run } = await import("./ingestion/runErc8004Chain"));
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "multichain-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "multichain-operator"));

    // Before 0046 a source for a new chain cannot be written: the value is not in the list.
    try {
      await writer.insert(schema.ingestionSources).values({
        id: "src-refused",
        sourceKey: "base-erc8004-identity-registry",
        label: "Base ERC-8004 identity registry",
        protocol: "erc8004_base",
        rootUrl: "https://base-mainnet.g.alchemy.com",
        allowedHostname: "base-mainnet.g.alchemy.com",
        state: "active",
        createdByUserId: operator.id,
      });
      refusedBeforeMigration.threw = false;
    } catch {
      refusedBeforeMigration.threw = true;
    }
    const [stored] = await writer.select({ protocol: schema.ingestionSources.protocol }).from(schema.ingestionSources).where(eq(schema.ingestionSources.id, "src-refused"));
    refusedBeforeMigration.stored = stored?.protocol ?? null;
    await writer.delete(schema.ingestionSources).where(eq(schema.ingestionSources.id, "src-refused"));

    // The owner pastes the file. It is pasted twice here, to show a second paste, or a paste after a crash part-way, changes nothing.
    const content = await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8");
    const connection = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(content)) await connection.query(statement);
    columnTypes.afterFirst = await columnTypesNow(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(content)) await connection.query(statement);
    await connection.end();
    columnTypes.afterSecond = await columnTypesNow(process.env.DATABASE_URL);

    for (const [, chain] of CASES) {
      const policy = chain.provider.kind === "pinned" ? chain.provider : { rootUrl: "https://arc-node.example", allowedHostname: "arc-node.example" };
      await writer.insert(schema.ingestionSources).values({
        id: sourceId(chain),
        sourceKey: chain.sourceKey,
        label: `${chain.label} ERC-8004 identity registry`,
        protocol: chain.protocol as (typeof schema.ingestionSources.$inferInsert)["protocol"],
        rootUrl: policy.rootUrl,
        allowedHostname: policy.allowedHostname,
        state: "active",
        createdByUserId: operator.id,
      });
    }
  });

  afterAll(async () => {
    if (previousFeatures === undefined) delete process.env.VITE_FEATURES;
    else process.env.VITE_FEATURES = previousFeatures;
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  describe("migration 0046", () => {
    it("is what lets the new protocols in: on a database built by boot, a source for Base is refused", () => {
      expect(Object.keys(columnTypes.before).sort()).toEqual(PROTOCOL_TABLES);
      for (const table of PROTOCOL_TABLES) {
        expect(columnTypes.before[table], table).toContain("'erc8004_bsc'");
        expect(columnTypes.before[table], table).not.toContain("erc8004_base");
      }
      // A strict server refuses the insert; a lenient one would store an empty string. Either way the value is not stored.
      expect(refusedBeforeMigration.stored).not.toBe("erc8004_base");
      expect(refusedBeforeMigration.threw || refusedBeforeMigration.stored === "").toBe(true);
    });

    it("appends the three values, last and in order, to the list on all four tables", () => {
      for (const table of PROTOCOL_TABLES) {
        expect(columnTypes.afterFirst[table], table).toBe(`${columnTypes.before[table]!.slice(0, -1)},'erc8004_base','erc8004_eth','erc8004_arc')`);
      }
    });

    it("is a no-op when pasted a second time", () => {
      expect(columnTypes.afterSecond).toEqual(columnTypes.afterFirst);
    });
  });

  describe.each(CASES)("the %s pass", (_name, chain, fixtures) => {
    const registrations = Object.values(fixtures.registered).map(entry => entry.expected);
    const finalized = finalizedOf(fixtures);

    it("stores a source for the chain now that the protocol is in the list", async () => {
      const source = await sourceNow(chain);
      expect(source.protocol).toBe(chain.protocol);
      expect(source.cursor).toBeNull();
    });

    it("classifies as it walks but publishes nothing to the directory until the walk has caught up", async () => {
      const { rpc } = rpcFor(chain, fixtures, finalized);
      await run(chain, await sourceNow(chain), "manual", "activity", { rpc, budget: { maxWindows: 3, concurrency: 1, maxElapsedMs: 600_000, maxEvents: 1_000_000 } });
      expect((await sourceNow(chain)).cursor).toBe(`${chain.cursorPrefix}:${chain.deployBlock + 3 * chain.maxLogRange}`);
      expect(await countIn(schema.agentDirectoryEntries, chain)).toBe(0);
    });

    it("walks from the deploy block to the finalized head across budgeted runs and ends one block past it", async () => {
      const runs = await runToCompletion(chain, fixtures);
      expect(runs).toBeGreaterThanOrEqual(1);
      expect((await sourceNow(chain)).cursor).toBe(`${chain.cursorPrefix}:${finalized + 1}`);
    });

    it("stores every registration in the registry rows with exactly the facts the independent decode found", async () => {
      expect(await countIn(schema.agentDirectoryRegistryRows, chain)).toBe(registrations.length);
      for (const expected of registrations) {
        const row = (await registryRow(chain, expected.agentId))!;
        const final = finalFacts(fixtures, expected.agentId);
        expect(row, `agent ${expected.agentId}`).toBeDefined();
        expect(row.protocol).toBe(chain.protocol);
        expect(row.registrant).toBe(expected.owner);
        expect(row.displayName).toBe(expected.inlineName ?? `Agent #${expected.agentId}`);
        // The link is the one the walk ended with: an agent whose URI was updated later carries the update's.
        expect(row.profileUriHash).toBe(final.hash);
        expect(row.locatorHost).toBe(final.host);
        expect(row.uriUpdateCount).toBe(final.updates);
        expect(row.sourceSignalNote?.startsWith(`${chain.label} ERC-8004 registration. `)).toBe(true);
        expect(row.sourceSignalNote).toContain("current ownership is not verified");
        expect(row.hidden).toBe(false);
      }
    });

    it("lists what passes the rules and holds the rest out, publishing only the listed to the directory under this chain's protocol", async () => {
      let listed = 0;
      for (const expected of registrations) {
        const final = finalFacts(fixtures, expected.agentId);
        const want = expectedListing(final.kind);
        expect((await registryRow(chain, expected.agentId))!.listing, `agent ${expected.agentId}`).toBe(want);
        const entry = await entryRow(chain, expected.agentId);
        if (want === 1) {
          listed += 1;
          expect(entry, `agent ${expected.agentId}`).toBeDefined();
          expect(entry!.protocol).toBe(chain.protocol);
          expect(entry!.displayName).toBe((await registryRow(chain, expected.agentId))!.displayName);
        } else {
          expect(entry, `agent ${expected.agentId}`).toBeUndefined();
        }
      }
      expect(await countIn(schema.agentDirectoryEntries, chain)).toBe(listed);
      expect(listed).toBeGreaterThan(0);
    });

    it("gives an agent that registered with an empty URI the link its URIUpdated event set, and counts the change", async () => {
      const emptied = registrations.find(expected => expected.uriKind === "empty" && fixtures.uriUpdates.some(update => update.agentId === expected.agentId));
      if (!emptied) return;
      const update = fixtures.uriUpdates.find(candidate => candidate.agentId === emptied.agentId)!;
      const row = (await registryRow(chain, emptied.agentId))!;
      expect(row.profileUriHash).toBe(update.profileUriHash);
      expect(row.profileUriHash).not.toBe(emptied.profileUriHash);
      expect(row.listing).toBe(1);
      expect(row.displayName).toBe(`Agent #${emptied.agentId}`);
      expect((await entryRow(chain, emptied.agentId))!.profileUriHash).toBe(update.profileUriHash);
    });

    it("rolls the mints up onto their rows and published entries, and the change of hands onto the agent it belongs to", async () => {
      for (const expected of registrations) {
        const mint = fixtures.mints[expected.agentId]!;
        const row = (await registryRow(chain, expected.agentId))!;
        expect(row.mintBlock, `agent ${expected.agentId}`).toBe(blockOf(mint));
        const isSecondary = fixtures.secondary.agentId === expected.agentId;
        expect(row.secondaryTransferCount).toBe(isSecondary ? 1 : 0);
        const mintedTo = `0x${(mint.topics as string[])[2]!.slice(26).toLowerCase()}`;
        const handedOut = isSecondary && fixtures.secondary.from === mintedTo && fixtures.secondary.blockNumber - blockOf(mint) <= chain.handoutBlockWindow;
        expect(row.handoutCount).toBe(handedOut ? 1 : 0);
        const entry = await entryRow(chain, expected.agentId);
        if (entry) expect([entry.mintBlock, entry.secondaryTransferCount, entry.handoutCount]).toEqual([row.mintBlock, row.secondaryTransferCount, row.handoutCount]);
      }
    });

    it("keeps the ledger of every token it stored, with every event keyed to this chain", async () => {
      const rows = await writer.select().from(schema.agentDirectoryChainActivity).where(eq(schema.agentDirectoryChainActivity.sourceId, sourceId(chain)));
      const byKind = (kind: string) => rows.filter(row => row.kind === kind).length;
      // These chains carry a host cap, so an event is written only for a token that has a row (docs/flood-host-cap-2026-10-21.md). The
      // recorded logs are a sample of the registry, and some of their transfers and URI updates belong to a token whose registration is not in it.
      const stored = new Set(registrations.map(registration => registration.agentId));
      const secondary = stored.has(fixtures.secondary.agentId) ? 1 : 0;
      const uriUpdates = fixtures.uriUpdates.filter(update => stored.has(update.agentId)).length;
      expect([byKind("mint"), byKind("secondary"), byKind("uri_update")]).toEqual([registrations.length, secondary, uriUpdates]);
      expect(rows.every(row => row.externalKey.startsWith(`eip155:${chain.chainId}:${chain.identityRegistry}:`))).toBe(true);
    });

    it("is idempotent: rescanning from the deploy block changes no row and does not regress an updated URI", async () => {
      const snapshot = async () => ({
        registry: await writer.select().from(schema.agentDirectoryRegistryRows).where(eq(schema.agentDirectoryRegistryRows.sourceId, sourceId(chain))),
        entries: await writer.select().from(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.sourceId, sourceId(chain))),
        ledger: await writer.select().from(schema.agentDirectoryChainActivity).where(eq(schema.agentDirectoryChainActivity.sourceId, sourceId(chain))),
      });
      const before = await snapshot();
      await writer.update(schema.ingestionSources).set({ cursor: null }).where(eq(schema.ingestionSources.id, sourceId(chain)));
      await runToCompletion(chain, fixtures);
      const after = await snapshot();
      expect(after.ledger).toHaveLength(before.ledger.length);
      expect(after.registry).toHaveLength(before.registry.length);
      expect(after.entries).toHaveLength(before.entries.length);
      const key = (row: { externalKey: string }) => row.externalKey;
      const rowFields = (row: (typeof before.registry)[number]) => [row.externalKey, row.displayName, row.locatorHost, row.registrant, row.profileUriHash, row.mintBlock, row.secondaryTransferCount, row.handoutCount, row.uriUpdateCount, row.listing];
      expect(after.registry.sort((a, b) => key(a).localeCompare(key(b))).map(rowFields)).toEqual(before.registry.sort((a, b) => key(a).localeCompare(key(b))).map(rowFields));
      // The published entries are the same rows, not deleted and re-inserted.
      const entryFields = (row: (typeof before.entries)[number]) => [row.id, row.externalKey, row.profileUriHash, row.mintBlock, row.uriUpdateCount];
      expect(after.entries.sort((a, b) => key(a).localeCompare(key(b))).map(entryFields)).toEqual(before.entries.sort((a, b) => key(a).localeCompare(key(b))).map(entryFields));
    });

    it("is a quiet success once caught up: one chain-id call, one finalized call, no log reads", async () => {
      const node = rpcFor(chain, fixtures, finalized);
      const before = (await sourceNow(chain)).cursor;
      await run(chain, await sourceNow(chain), "manual", "activity", { rpc: node.rpc });
      expect(node.logCalls()).toBe(0);
      expect((await sourceNow(chain)).cursor).toBe(before);
    });
  });

  describe("three chains in one database", () => {
    it("keeps each chain's rows to its own source: the counts add up and no key belongs to another chain", async () => {
      let total = 0;
      for (const [, chain, fixtures] of CASES) {
        const count = await countIn(schema.agentDirectoryRegistryRows, chain);
        expect(count).toBe(Object.keys(fixtures.registered).length);
        total += count;
      }
      const [{ all }] = await writer.select({ all: sql<number>`count(*)` }).from(schema.agentDirectoryRegistryRows);
      expect(Number(all)).toBe(total);
      for (const [, chain] of CASES) {
        const rows = await writer.select({ key: schema.agentDirectoryRegistryRows.externalKey, protocol: schema.agentDirectoryRegistryRows.protocol }).from(schema.agentDirectoryRegistryRows).where(eq(schema.agentDirectoryRegistryRows.sourceId, sourceId(chain)));
        for (const row of rows) {
          expect(row.key.startsWith(`eip155:${chain.chainId}:`)).toBe(true);
          expect(row.protocol).toBe(chain.protocol);
        }
      }
    });

    it("shows each protocol once in the directory, with no entry under BNB Chain's", async () => {
      const rows = await writer.select({ protocol: schema.agentDirectoryEntries.protocol, total: sql<number>`count(*)` }).from(schema.agentDirectoryEntries).groupBy(schema.agentDirectoryEntries.protocol);
      expect(rows.map(row => row.protocol).sort()).toEqual(["erc8004_arc", "erc8004_base", "erc8004_eth"]);
    });
  });
});
