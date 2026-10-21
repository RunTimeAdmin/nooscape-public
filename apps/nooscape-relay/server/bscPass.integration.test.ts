import { and, eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import {
  BSC_ALLOWED_HOSTNAME,
  BSC_DEPLOY_BLOCK,
  BSC_IDENTITY_REGISTRY,
  BSC_ROOT_URL,
  BSC_SOURCE_KEY,
} from "./ingestion/bscChain";
import { BSC_FIXTURE_MINTS, BSC_FIXTURE_REGISTERED, BSC_FIXTURE_SECONDARY, BSC_FIXTURE_URI_UPDATES } from "./ingestion/bscFixtures";

/**
 * The whole BNB Chain identity pass against a real database, with a fake RPC
 * that serves REAL registry logs (every registration variant the registry
 * contains, their mints, a change of hands, and two URI updates). What is
 * checked is the stored result, compared with facts an independent Python
 * decode produced: the registry rows, the ledger, the rollups, the URI update
 * that turns agent 6's empty URI into an IPFS link, the listing (which
 * registrations reach the directory, and when), resuming across runs, and the
 * property a retry depends on, that rescanning from the start changes nothing
 * and never regresses an updated URI. Also checks the Robinhood readers stay
 * empty while a full BSC pass is in the same ledger. Runs against a throwaway
 * MySQL schema built by the project's boot-time migration runner, and skips
 * when no database is reachable.
 */
const TEST_DB = "nooscape_bsc_pass_test";
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

const hexNum = (value: number) => `0x${value.toString(16)}`;
const blockOf = (log: Record<string, unknown>) => Number.parseInt(log.blockNumber as string, 16);

/**
 * What the listing rules do to the real registrations, written out by hand from
 * the facts: three carry no usable profile link (an unrecognized scheme, inline
 * JSON that did not parse, an oversized inline URI) and are held out; agent 6
 * set no URI at registration but a URIUpdated later gave it an IPFS link, so it
 * is listed on its CURRENT link; the other nine each have a link of their own,
 * a host and a wallet nothing else shares, and are listed.
 */
const HELD_OUT = ["2", "164", "60342"];
const LISTED = ["0", "6", "137", "197", "696", "3061", "7588", "12244", "67781", "164228"];

// The walk and the listing refresh each run real statements against MySQL, and the file runs beside other database
// suites in a full run, so the 5 s default per test overran once under load and cascaded through the tests that
// depend on the walk. The tests that do not touch the walk are fast regardless.
describe.skipIf(!dbReachable)("the BNB Chain identity pass against a real database", { timeout: 60_000 }, () => {
  type Db = typeof import("./db");
  let db: Db;
  let registry: typeof import("./agentRegistryRows");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let run: typeof import("./ingestion/runBsc").runApprovedBscRegistrySource;
  let rpcLogCalls = 0;

  const allLogs = [
    ...Object.values(BSC_FIXTURE_REGISTERED).map(fixture => fixture.log),
    ...Object.values(BSC_FIXTURE_MINTS),
    BSC_FIXTURE_SECONDARY,
    ...BSC_FIXTURE_URI_UPDATES.map(fixture => fixture.log),
  ] as Array<Record<string, unknown>>;
  const finalized = Math.max(...allLogs.map(blockOf)) + 5;

  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_getBlockByNumber") return { number: hexNum(finalized) };
    if (method === "eth_getLogs") {
      rpcLogCalls += 1;
      const filter = params[0] as { fromBlock: string; toBlock: string; address: string };
      expect(filter.address).toBe(BSC_IDENTITY_REGISTRY);
      const from = Number.parseInt(filter.fromBlock, 16);
      const to = Number.parseInt(filter.toBlock, 16);
      return allLogs.filter(log => blockOf(log) >= from && blockOf(log) <= to);
    }
    throw new Error(`unexpected ${method}`);
  };

  const currentSource = async () => (await db.getIngestionSource("src-bsc"))!;
  const budget = { maxWindows: 40, concurrency: 8, maxElapsedMs: 600_000, maxEvents: 1_000_000 };
  /** Runs the pass in small budgeted steps until it is caught up, the way repeated operator clicks would. */
  const runToCompletion = async (maxWindows = 40) => {
    let runs = 0;
    for (;;) {
      const source = await currentSource();
      const before = source.cursor;
      await run(source, "manual", "activity", { rpc, budget: { ...budget, maxWindows } });
      runs += 1;
      if ((await currentSource()).cursor === before) return runs;
      if (runs > 100) throw new Error("the walk did not converge");
    }
  };
  const keyOf = (agentId: string) => `eip155:56:${BSC_IDENTITY_REGISTRY}:${agentId}`;
  const registryRowByAgent = async (agentId: string) => {
    const [row] = await writer
      .select()
      .from(schema.agentDirectoryRegistryRows)
      .where(and(eq(schema.agentDirectoryRegistryRows.sourceId, "src-bsc"), eq(schema.agentDirectoryRegistryRows.externalKey, keyOf(agentId))));
    return row;
  };
  const entryByAgent = async (agentId: string) => {
    const [row] = await writer
      .select()
      .from(schema.agentDirectoryEntries)
      .where(and(eq(schema.agentDirectoryEntries.sourceId, "src-bsc"), eq(schema.agentDirectoryEntries.externalKey, keyOf(agentId))));
    return row;
  };
  const directoryCount = async () => {
    const [{ total }] = await writer.select({ total: sql<number>`count(*)` }).from(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.sourceId, "src-bsc"));
    return Number(total);
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
    registry = await import("./agentRegistryRows");
    ({ runApprovedBscRegistrySource: run } = await import("./ingestion/runBsc"));
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "bsc-pass-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "bsc-pass-operator"));
    await writer.insert(schema.ingestionSources).values({
      id: "src-bsc",
      sourceKey: BSC_SOURCE_KEY,
      label: "BNB Smart Chain ERC-8004 identity registry",
      protocol: "erc8004_bsc",
      rootUrl: BSC_ROOT_URL,
      allowedHostname: BSC_ALLOWED_HOSTNAME,
      state: "active",
      createdByUserId: operator.id,
    });
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("classifies as it walks but publishes nothing to the directory until the walk has caught up", async () => {
    expect((await currentSource()).cursor).toBeNull();
    await run(await currentSource(), "manual", "activity", { rpc, budget: { ...budget, maxWindows: 5 } });
    expect((await currentSource()).cursor).not.toBe(`bsc:${finalized + 1}`);
    expect(await directoryCount()).toBe(0);
    // The registrations the first windows reached are already stored and classified.
    const [{ total }] = await writer
      .select({ total: sql<number>`count(*)` })
      .from(schema.agentDirectoryRegistryRows)
      .where(and(eq(schema.agentDirectoryRegistryRows.sourceId, "src-bsc"), sql`${schema.agentDirectoryRegistryRows.listing} <> 3`));
    expect(Number(total)).toBeGreaterThan(0);
  });

  it("walks from the deploy block to the finalized head across several budgeted runs", async () => {
    const runs = await runToCompletion();
    // About 380 windows at 40 per run, plus the final caught-up run that proves convergence.
    expect(runs).toBeGreaterThan(5);
    expect((await currentSource()).cursor).toBe(`bsc:${finalized + 1}`);
    expect(finalized - BSC_DEPLOY_BLOCK).toBeGreaterThan(10_000_000);
  });

  it("stores every registration variant in the registry rows with exactly the facts the independent decode found", async () => {
    const [{ total }] = await writer.select({ total: sql<number>`count(*)` }).from(schema.agentDirectoryRegistryRows).where(eq(schema.agentDirectoryRegistryRows.sourceId, "src-bsc"));
    expect(Number(total)).toBe(Object.keys(BSC_FIXTURE_REGISTERED).length);
    for (const [name, { expected }] of Object.entries(BSC_FIXTURE_REGISTERED)) {
      const row = (await registryRowByAgent(expected.agentId))!;
      expect(row, name).toBeDefined();
      expect(row.protocol).toBe("erc8004_bsc");
      expect(row.registrant).toBe(expected.owner);
      expect(row.displayName).toBe(expected.inlineName ?? `Agent #${expected.agentId}`);
      // Agent 6 had its URI changed later in the walk; every other row still carries its registration URI facts.
      if (expected.agentId !== "6") {
        expect(row.locatorHost).toBe(expected.locatorHost);
        expect(row.profileUriHash).toBe(expected.profileUriHash);
      }
      expect(row.sourceSignalNote).toContain("current ownership is not verified");
      expect(row.hidden).toBe(false);
    }
  });

  it("lists the registrations that pass the rules and holds the rest out of the directory", async () => {
    for (const agentId of HELD_OUT) {
      expect((await registryRowByAgent(agentId))!.listing, `agent ${agentId}`).toBe(0);
      expect(await entryByAgent(agentId), `agent ${agentId}`).toBeUndefined();
    }
    for (const agentId of LISTED) {
      expect((await registryRowByAgent(agentId))!.listing, `agent ${agentId}`).toBe(1);
      const entry = (await entryByAgent(agentId))!;
      expect(entry, `agent ${agentId}`).toBeDefined();
      expect(entry.protocol).toBe("erc8004_bsc");
      expect(entry.displayName).toBe((await registryRowByAgent(agentId))!.displayName);
    }
    expect(await directoryCount()).toBe(LISTED.length);
  });

  it("lists agent 6 on the IPFS link its URIUpdated event set, not on the empty URI it registered with, and counts the change", async () => {
    const update = BSC_FIXTURE_URI_UPDATES.find(fixture => fixture.agentId === "6")!;
    const row = (await registryRowByAgent("6"))!;
    expect(BSC_FIXTURE_REGISTERED.empty!.expected.agentId).toBe("6");
    expect(row.profileUriHash).toBe(update.profileUriHash);
    expect(row.profileUriHash).not.toBe(BSC_FIXTURE_REGISTERED.empty!.expected.profileUriHash);
    expect(row.locatorHost).toBeNull();
    // The registration-time name is kept: it is what the registration asserted.
    expect(row.displayName).toBe("Agent #6");
    expect(row.uriUpdateCount).toBe(1);
    const entry = (await entryByAgent("6"))!;
    expect([entry.profileUriHash, entry.uriUpdateCount, entry.mintBlock]).toEqual([update.profileUriHash, 1, row.mintBlock]);
  });

  it("rolls the mints up onto their registry rows and published entries, and leaves unminted ones unmeasured", async () => {
    for (const [agentId, log] of Object.entries(BSC_FIXTURE_MINTS)) {
      const row = (await registryRowByAgent(agentId))!;
      expect([row.mintBlock, row.secondaryTransferCount, row.handoutCount]).toEqual([blockOf(log as Record<string, unknown>), 0, 0]);
      const entry = await entryByAgent(agentId);
      if (LISTED.includes(agentId)) expect([entry!.mintBlock, entry!.secondaryTransferCount, entry!.handoutCount]).toEqual([row.mintBlock, 0, 0]);
    }
    // No mint Transfer was served for agent 137, so its rollups stay null: not measured, never a false zero.
    const unmeasured = (await registryRowByAgent("137"))!;
    expect([unmeasured.mintBlock, unmeasured.secondaryTransferCount, unmeasured.uriUpdateCount]).toEqual([null, null, null]);
    const unmeasuredEntry = (await entryByAgent("137"))!;
    expect([unmeasuredEntry.mintBlock, unmeasuredEntry.secondaryTransferCount, unmeasuredEntry.uriUpdateCount]).toEqual([null, null, null]);
  });

  it("keeps the whole ledger, including events for agents this fixture set never registered", async () => {
    const rows = await writer.select().from(schema.agentDirectoryChainActivity).where(eq(schema.agentDirectoryChainActivity.sourceId, "src-bsc"));
    const byKind = (kind: string) => rows.filter(row => row.kind === kind).length;
    expect([byKind("mint"), byKind("secondary"), byKind("uri_update")]).toEqual([Object.keys(BSC_FIXTURE_MINTS).length, 1, BSC_FIXTURE_URI_UPDATES.length]);
    expect(rows.every(row => row.externalKey.startsWith(`eip155:56:${BSC_IDENTITY_REGISTRY}:`))).toBe(true);
  });

  it("is idempotent: rescanning from the start changes no row and does not regress the updated URI", async () => {
    const snapshot = async () => ({
      registry: await writer.select().from(schema.agentDirectoryRegistryRows).where(eq(schema.agentDirectoryRegistryRows.sourceId, "src-bsc")),
      entries: await writer.select().from(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.sourceId, "src-bsc")),
      ledger: await writer.select().from(schema.agentDirectoryChainActivity).where(eq(schema.agentDirectoryChainActivity.sourceId, "src-bsc")),
    });
    const before = await snapshot();
    await writer.update(schema.ingestionSources).set({ cursor: null }).where(eq(schema.ingestionSources.id, "src-bsc"));
    await runToCompletion();
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
    expect((await registryRowByAgent("6"))!.profileUriHash).toBe(BSC_FIXTURE_URI_UPDATES.find(fixture => fixture.agentId === "6")!.profileUriHash);
  });

  it("is a quiet success once caught up: one chain-id call, one finalized call, no log reads", async () => {
    const before = rpcLogCalls;
    await run(await currentSource(), "manual", "activity", { rpc });
    expect(rpcLogCalls).toBe(before);
    const [last] = await writer.select().from(schema.ingestionRuns).where(eq(schema.ingestionRuns.sourceId, "src-bsc")).orderBy(sql`startedAt desc`).limit(1);
    expect(last!.status).toBe("completed");
  });

  it("records every run, and no run raised the failure count", async () => {
    const source = await currentSource();
    expect(source.failureCount).toBe(0);
    const runs = await writer.select().from(schema.ingestionRuns).where(eq(schema.ingestionRuns.sourceId, "src-bsc"));
    expect(runs.length).toBeGreaterThan(10);
    expect(runs.every(row => row.status === "completed")).toBe(true);
  });

  it("reports the registry: what the chain holds, what the listing publishes, and why the rest is held out", async () => {
    const profile = await registry.readAgentRegistryProfile("src-bsc");
    expect(profile).toMatchObject({ recorded: 13, listed: LISTED.length, published: LISTED.length, grouped: 0, withoutProfileLink: HELD_OUT.length, numericName: 0, pending: 0 });
    expect(profile.rules).toEqual({ sharedProfileLinkFrom: 2, sharedHostFrom: 50, sharedWalletFrom: 10 });
    expect(profile.sharedProfileGroups).toEqual([]);
  });

  it("searches only the listed registrations, and counts an entry's look-alikes over the whole registry", async () => {
    const found = await db.searchAgentDirectory({ query: "Agent", limit: 25 });
    const names = found.entries.map(entry => entry.displayName);
    for (const agentId of ["137", "197", "696"]) expect(names).toContain(`Agent #${agentId}`);
    for (const agentId of HELD_OUT) expect(names).not.toContain(`Agent #${agentId}`);
    // A held-out registration is findable by its registering wallet only through the registry rows, never the directory.
    const heldOutOwner = BSC_FIXTURE_REGISTERED.other_scheme!.expected.owner;
    expect((await db.searchAgentDirectory({ query: heldOutOwner, limit: 25 })).entries).toEqual([]);
    const row = (await entryByAgent("137"))!;
    const entry = (await db.getAgentDirectoryEntry(row.id))!;
    expect(entry.related).toEqual({ sameWallet: 0, sameName: 0, sameHost: 0 });
    expect(JSON.stringify(entry)).not.toContain("src-bsc");
    expect("sourceId" in entry).toBe(false);
  });

  it("counts the listed registrations in the public totals and the funnel's mint step, and not in the Robinhood readers", async () => {
    expect(await db.breakdownAgentDirectoryByProtocol()).toEqual([{ protocol: "erc8004_bsc", count: LISTED.length }]);
    expect(await db.countAgentDirectoryEntries()).toBe(LISTED.length);
    const listedMinted = Object.keys(BSC_FIXTURE_MINTS).filter(agentId => LISTED.includes(agentId)).length;
    expect(listedMinted).toBeGreaterThan(0);
    expect(await db.countAgentDirectoryMintMeasured()).toBe(listedMinted);
    // The Robinhood-facing totals must not count a single BSC mint, nor adopt BSC's block as their as-of block.
    expect(await db.readAgentDirectoryActivityTotals()).toEqual({ mintedEntries: 0, secondaryTransfers: 0, handoutTransfers: 0, uriUpdates: 0, measuredThroughBlock: null });
    expect(await db.readAgentDirectoryActivityFeed()).toEqual([]);
    expect(await db.readAgentDirectoryActivityDaySeries()).toEqual([]);
  });

  it("serves one listed agent's activity with the BSC mint hour", async () => {
    const row = (await entryByAgent("6"))!;
    const entry = await db.getAgentDirectoryEntry(row.id);
    expect(entry!.activity!.events.map(event => [event.kind, event.isHandout])).toEqual([
      ["mint", false],
      ["uri_update", false],
    ]);
  });
});
