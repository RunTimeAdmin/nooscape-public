import { and, eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { BASE_CHAIN } from "./ingestion/erc8004Chains";
import { hexNum, mintAt, registrationAt, word, type LogShape } from "./ingestion/erc8004TestChain";

/**
 * What ends a run of the Base pass, against a real database. The chain adds registrations from one host far faster than the pass walked
 * them while an event count ended each run: past the host's cap a window only counts, at about 17,000 events a second, so 40,000 events
 * took two seconds of the thirty a run was allowed. The pass is given Base's own budget here (nothing is passed in), a fake node that
 * serves four windows of 14,000 events from one host, and a clock the fake node moves. What is held: a run that only counts goes on past
 * 40,000 events to the end of its windows, and a run stops once its time budget has passed, however few events it has accepted. Runs on a
 * throwaway schema and skips when no database is reachable.
 */
const TEST_DB = "nooscape_base_run_budget_test";
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

const D = BASE_CHAIN.deployBlock;
const WINDOW = BASE_CHAIN.maxLogRange;
const WINDOWS = 4;
/** Agents a window holds, each a registration and a mint: 14,000 events a window, 56,000 in all, past the 40,000 that used to end a run. */
const AGENTS_PER_WINDOW = 7_000;
const FLOOD = "flood.example";

/** An ABI-encoded `string`, the shape of a Registered log's data. */
function abiString(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const padded = Buffer.concat([bytes, Buffer.alloc((32 - (bytes.length % 32)) % 32)]);
  return `0x${word(32).slice(2)}${word(bytes.length).slice(2)}${padded.toString("hex")}`;
}

/** One window's logs: every agent registered from the one host, spread over the window's blocks with a log index of its own in its block. */
function windowLogs(index: number): LogShape[] {
  const logs: LogShape[] = [];
  for (let i = 0; i < AGENTS_PER_WINDOW; i += 1) {
    const agent = index * AGENTS_PER_WINDOW + i + 1;
    const block = D + index * WINDOW + (i % WINDOW);
    const slot = Math.floor(i / WINDOW) * 2;
    logs.push({ ...registrationAt(BASE_CHAIN, agent, block, slot), data: abiString(`https://${FLOOD}/a/${agent}`) });
    logs.push(mintAt(BASE_CHAIN, agent, block, slot + 1));
  }
  return logs;
}

describe.skipIf(!dbReachable)("the run budget of the Base pass, against a real database", { timeout: 180_000 }, () => {
  let db: typeof import("./db");
  let run: typeof import("./ingestion/runErc8004Chain").runApprovedErc8004ChainSource;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  const previousFeatures = process.env.VITE_FEATURES;
  const sourceId = "src-run-budget";
  const byWindow = Array.from({ length: WINDOWS }, (_, index) => windowLogs(index));
  const FINALIZED = D + WINDOWS * WINDOW - 1;

  const sourceNow = async () => (await db.getIngestionSource(sourceId))!;
  const setCursor = async (cursor: string) => {
    await writer.update(schema.ingestionSources).set({ cursor }).where(eq(schema.ingestionSources.id, sourceId));
  };
  /** The fake node. Each `eth_getLogs` takes `stepMs` of the clock the run reads. */
  const runWith = async (stepMs: number) => {
    let clock = 0;
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      if (method === "eth_chainId") return BASE_CHAIN.chainIdHex;
      if (method === "eth_getBlockByNumber") return { number: hexNum(FINALIZED) };
      if (method === "eth_getLogs") {
        clock += stepMs;
        const from = Number.parseInt((params[0] as { fromBlock: string }).fromBlock, 16);
        return byWindow[(from - D) / WINDOW] ?? [];
      }
      throw new Error(`unexpected ${method}`);
    };
    await setCursor(`base:${D}`);
    await run(BASE_CHAIN, await sourceNow(), "manual", "activity", { rpc, now: () => clock });
    return (await sourceNow()).cursor;
  };
  const storedRows = async () => {
    const [{ total }] = await writer.select({ total: sql<number>`count(*)` }).from(schema.agentDirectoryRegistryRows).where(eq(schema.agentDirectoryRegistryRows.sourceId, sourceId));
    return Number(total);
  };
  const overflowCount = async () => {
    const [row] = await writer
      .select()
      .from(schema.agentDirectoryRegistryOverflow)
      .where(and(eq(schema.agentDirectoryRegistryOverflow.sourceId, sourceId), eq(schema.agentDirectoryRegistryOverflow.locatorHost, FLOOD)));
    return row ? Number(row.overflowCount) : 0;
  };

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
    // The boot runner applies the overflow table and skips the manual migrations; 0046 is pasted for the Base protocol value.
    await applyPendingMigrations(process.env.DATABASE_URL);
    const connection = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8"))) await connection.query(statement);
    await connection.end();

    db = await import("./db");
    ({ runApprovedErc8004ChainSource: run } = await import("./ingestion/runErc8004Chain"));
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "run-budget-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "run-budget-operator"));
    await writer.insert(schema.ingestionSources).values({
      id: sourceId,
      sourceKey: BASE_CHAIN.sourceKey,
      label: "Base ERC-8004 identity registry",
      protocol: "erc8004_base",
      rootUrl: "https://base-mainnet.g.alchemy.com",
      allowedHostname: "base-mainnet.g.alchemy.com",
      state: "active",
      createdByUserId: operator.id,
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

  it("holds more events than the count that used to end a run, so the test means something", () => {
    const events = byWindow.reduce((total, logs) => total + logs.length, 0);
    expect(events).toBe(WINDOWS * AGENTS_PER_WINDOW * 2);
    expect(events).toBeGreaterThan(40_000);
  });

  it("goes on past 40,000 events to the end of its windows while they only count", async () => {
    // No time passes, so only the event count could end the run. At a ceiling of 40,000 it would stop after the third window.
    expect(await runWith(0)).toBe(`base:${FINALIZED + 1}`);
    expect(await storedRows()).toBe(BASE_CHAIN.hostRowCap);
    expect(await overflowCount()).toBe(WINDOWS * AGENTS_PER_WINDOW - BASE_CHAIN.hostRowCap!);
  });

  it("stops once its time budget has passed, with far fewer events accepted than the ceiling allows", async () => {
    // Each read takes six seconds of the 20 the budget allows. The first two windows are read together (12 seconds) and applied; the next two
    // are read together (24 seconds), and the run is over before it applies either. At the old 30 seconds it would have applied the third.
    expect(await runWith(6_000)).toBe(`base:${D + 2 * WINDOW}`);
  });
});
