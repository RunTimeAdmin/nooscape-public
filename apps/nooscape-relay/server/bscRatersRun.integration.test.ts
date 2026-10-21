import { createHash } from "node:crypto";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";
import { BSC_REPUTATION_DEPLOY_BLOCK, BSC_REPUTATION_IMPL } from "./ingestion/bscReputation";
import { ROBINHOOD_FEEDBACK_REVOKED_TOPIC, ROBINHOOD_NEW_FEEDBACK_TOPIC } from "./ingestion/robinhoodReputation";
import type { DirectoryEntryDraft } from "./ingestion/types";

/**
 * The BNB rater step against a real database (docs/bsc-rater-credibility-2026-10-16.md): nothing before the migration is run,
 * the chain read in windows from where it left off, kept when a later window fails, stopped at a changed implementation or a log
 * that does not decode, and the ratings worked out only once the ledger has caught up. The chain is a function that answers the
 * three calls the step makes with logs built the way the registry builds them; the real logs are in
 * ingestion/bscReputation.test.ts. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_bsc_raters_test";
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
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const keyOf = (n: number) => `eip155:56:${REGISTRY}:${n}`;
const W = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
const hexNum = (n: number) => `0x${n.toString(16)}`;
const SLOT_WORD = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** A NewFeedback log built the way the registry builds one: three indexed topics, and a head of index, value, decimals, four offsets and a hash, then four empty strings. */
function feedbackLog(input: { agent: number; client: string; index: number; value: string; block: number; logIndex?: number; tx: string }) {
  const empty = [0, 0, 0, 0].map(() => word(0));
  const head = [word(input.index), word(BigInt(input.value)), word(0), word(256), word(288), word(320), word(352), word(0)];
  return {
    address: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    topics: [ROBINHOOD_NEW_FEEDBACK_TOPIC, `0x${word(input.agent)}`, `0x${input.client.slice(2).padStart(64, "0")}`, `0x${"22".repeat(32)}`],
    data: `0x${[...head, ...empty].join("")}`,
    blockNumber: hexNum(input.block),
    logIndex: hexNum(input.logIndex ?? 0),
    transactionHash: input.tx,
    removed: false,
  };
}

function revokedLog(input: { agent: number; client: string; index: number; block: number; tx: string }) {
  return {
    address: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    topics: [ROBINHOOD_FEEDBACK_REVOKED_TOPIC, `0x${word(input.agent)}`, `0x${input.client.slice(2).padStart(64, "0")}`, `0x${word(input.index)}`],
    data: "0x",
    blockNumber: hexNum(input.block),
    logIndex: "0x0",
    transactionHash: input.tx,
    removed: false,
  };
}

describe.skipIf(!dbReachable)("the BNB rater step against a real database", { timeout: 60_000 }, () => {
  let run: typeof import("./bscRatersRun");
  let registry: typeof import("./agentRegistryRows");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let pasteMigration: () => Promise<void>;
  let source: schema.IngestionSource;

  const START = BSC_REPUTATION_DEPLOY_BLOCK;
  /** Three windows of 50,000 blocks. */
  const FINALIZED = START + 149_999;
  let txCounter = 0;
  const tx = () => `0x${(++txCounter).toString(16).padStart(64, "0")}`;
  type Logs = Array<Record<string, unknown>>;

  /** The chain: the logs it holds, the implementation behind the registry, and a count of each call. A window that is in `failAt` fails. */
  const chain = (logs: Logs, options: { implementation?: string; failAt?: number; finalized?: number } = {}) => {
    const calls: string[] = [];
    return {
      calls,
      rpc: async (method: string, params: unknown[]) => {
        calls.push(method);
        if (method === "eth_getStorageAt") return SLOT_WORD(options.implementation ?? BSC_REPUTATION_IMPL);
        if (method === "eth_getBlockByNumber") return { number: hexNum(options.finalized ?? FINALIZED) };
        if (method === "eth_getLogs") {
          const filter = params[0] as { fromBlock: string; toBlock: string };
          const from = Number.parseInt(filter.fromBlock, 16);
          const to = Number.parseInt(filter.toBlock, 16);
          if (options.failAt !== undefined && from <= options.failAt && options.failAt <= to) throw new Error("BNB Chain eth_getLogs returned HTTP 503.");
          return logs.filter(log => {
            const block = Number.parseInt(String(log.blockNumber), 16);
            return block >= from && block <= to;
          });
        }
        throw new Error(`unexpected ${method}`);
      },
    };
  };
  const go = (over: Partial<import("./bscRatersRun").RatersDeps>, logs: Logs, options: Parameters<typeof chain>[1] = {}) => {
    const fake = chain(logs, options);
    return { fake, result: run.runBscRaters({ rpc: fake.rpc, ...over }) };
  };

  const draft = (n: number, registrant: string, overrides: Partial<DirectoryEntryDraft> = {}): DirectoryEntryDraft => ({
    externalKey: keyOf(n),
    displayName: `Agent #${n}`,
    locatorHost: null,
    registrant,
    profileUriHash: sha(`uri-${n}`),
    sourceSignalNote: "BNB Smart Chain ERC-8004 registration. current ownership is not verified.",
    ...overrides,
  });
  const seedRows = (drafts: DirectoryEntryDraft[]) => registry.insertAgentRegistryRows({ source, runId: "run-test", drafts });
  const reset = async () => {
    await writer.delete(schema.bscRaterEvidence);
    await writer.delete(schema.bscFeedbackEvents);
    await writer.delete(schema.bscReputationState);
    await writer.delete(schema.agentDirectoryRegistryRows);
  };
  const state = async () => (await writer.select().from(schema.bscReputationState))[0];
  const ledger = async () => writer.select().from(schema.bscFeedbackEvents);
  const evidence = async () => (await writer.select().from(schema.bscRaterEvidence)).sort((a, b) => a.agentId - b.agentId);

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
    pasteMigration = async () => {
      const paste = await createConnection(process.env.DATABASE_URL!);
      for (const statement of splitMigrationStatements(await readFile("drizzle/0039_bsc_rater_evidence.sql", "utf8"))) await paste.query(statement);
      await paste.end();
    };

    const db = await import("./db");
    registry = await import("./agentRegistryRows");
    run = await import("./bscRatersRun");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "raters-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "raters-operator"));
    await writer.insert(schema.ingestionSources).values({
      id: "src-bsc",
      sourceKey: "bsc-erc8004-identity-registry",
      label: "BNB Chain test",
      protocol: "erc8004_bsc",
      rootUrl: "https://bsc-mainnet.nodereal.io",
      allowedHostname: "bsc-mainnet.nodereal.io",
      state: "active",
      createdByUserId: operator!.id,
    });
    source = (await db.getIngestionSource("src-bsc"))!;
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  describe("before the migration is run", () => {
    it("does nothing, asks the chain nothing and says nothing", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { fake, result } = go({}, []);
        expect(await result).toEqual({ state: "unavailable" });
        expect(fake.calls).toEqual([]);
        expect(log).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
    });
  });

  describe("the migration", () => {
    it("makes the tables the code relies on, with the unique keys the step writes against", async () => {
      await pasteMigration();
      const probe = await createConnection(process.env.DATABASE_URL!);
      const columns = async (table: string) => ((await probe.query(`SHOW COLUMNS FROM \`${table}\``)) as [Array<{ Field: string; Null: string }>, unknown])[0];
      const indexes = async (table: string) => ((await probe.query(`SHOW INDEX FROM \`${table}\``)) as [Array<{ Key_name: string; Column_name: string; Seq_in_index: number }>, unknown])[0];
      const events = await columns("bsc_feedback_events");
      const rated = await columns("bsc_rater_evidence");
      const marker = await columns("bsc_reputation_state");
      const eventIndexes = await indexes("bsc_feedback_events");
      const ratedIndexes = await indexes("bsc_rater_evidence");
      await probe.end();
      expect(events.map(column => column.Field)).toEqual(["id", "transactionHash", "logIndex", "kind", "blockNumber", "agentId", "clientAddress", "feedbackIndex", "valueRaw", "valueDecimals", "createdAt"]);
      expect(events.filter(column => column.Null === "YES").map(column => column.Field)).toEqual(["feedbackIndex", "valueRaw", "valueDecimals"]);
      expect(rated.map(column => column.Field)).toEqual(["id", "sourceId", "externalKey", "agentId", "rawEvents", "rawRaters", "concentratedRaters", "uniformRaters", "linkedRaters", "independentRaters", "weightedEvents", "ownerRegistrations", "ownerFleet", "qualifies", "computedAt"]);
      expect(marker.map(column => column.Field)).toEqual(["id", "nextBlock", "finalizedBlock", "implementation", "evaluatedAt", "updatedAt"]);
      const of = (list: typeof eventIndexes, name: string) => list.filter(index => index.Key_name === name).sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name);
      expect(of(eventIndexes, "bsc_feedback_event_uq")).toEqual(["transactionHash", "logIndex"]);
      expect(of(ratedIndexes, "bsc_rater_evidence_key_uq")).toEqual(["sourceId", "externalKey"]);
    });

    it("refers to nothing and is referred to by nothing, so all three can be dropped alone", async () => {
      const probe = await createConnection(process.env.DATABASE_URL!);
      const [found] = (await probe.query(
        "SELECT TABLE_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL AND (TABLE_NAME IN ('bsc_feedback_events','bsc_rater_evidence','bsc_reputation_state') OR REFERENCED_TABLE_NAME IN ('bsc_feedback_events','bsc_rater_evidence','bsc_reputation_state'))",
        [TEST_DB]
      )) as [unknown[], unknown];
      await probe.end();
      expect(found).toEqual([]);
    });

    it("can be run again by hand without error and without touching a row", async () => {
      await writer.insert(schema.bscReputationState).values({ id: "bsc", nextBlock: 5 });
      await pasteMigration();
      expect((await state())?.nextBlock).toBe(5);
      await reset();
    });
  });

  describe("the read", () => {
    it("reads the windows from the registry's first block, records each rating once, and moves the cursor window by window", async () => {
      await reset();
      const logs: Logs = [
        feedbackLog({ agent: 1, client: W(1), index: 1, value: "85", block: START + 10, tx: tx() }),
        feedbackLog({ agent: 2, client: W(1), index: 2, value: "90", block: START + 60_000, tx: tx() }),
        feedbackLog({ agent: 1, client: W(2), index: 1, value: "100", block: START + 120_000, tx: tx() }),
      ];
      const first = go({ maxWindows: 2 }, logs);
      expect(await first.result).toMatchObject({ state: "completed", windows: 2, inserted: 2, caughtUp: false, stoppedBy: null, evaluated: false, report: null });
      // The implementation check, the finalized block and one read a window.
      expect(first.fake.calls).toEqual(["eth_getStorageAt", "eth_getBlockByNumber", "eth_getLogs", "eth_getLogs"]);
      expect((await state())?.nextBlock).toBe(START + 100_000);
      expect(await ledger()).toHaveLength(2);
      // The next run carries on from there, finds the rest, and has caught up.
      const second = go({ maxWindows: 2 }, logs);
      expect(await second.result).toMatchObject({ windows: 1, inserted: 1, caughtUp: true, evaluated: true });
      expect((await state())?.nextBlock).toBe(FINALIZED + 1);
      expect(await ledger()).toHaveLength(3);
      // A run with nothing new asks only the two cheap questions and evaluates nothing.
      const third = go({}, logs);
      expect(await third.result).toMatchObject({ windows: 0, inserted: 0, caughtUp: true, evaluated: false });
      expect(third.fake.calls).toEqual(["eth_getStorageAt", "eth_getBlockByNumber"]);
    });

    it("never records a rating twice, even when a window is read again", async () => {
      const logs: Logs = [feedbackLog({ agent: 1, client: W(1), index: 1, value: "85", block: START + 10, tx: "0x" + "ab".repeat(32) })];
      await writer.update(schema.bscReputationState).set({ nextBlock: START });
      const again = go({}, logs);
      expect(await again.result).toMatchObject({ caughtUp: true });
      const rows = await ledger();
      expect(rows.filter(row => row.transactionHash === "0x" + "ab".repeat(32))).toHaveLength(1);
    });

    it("keeps what it read when a later window fails, says so without the endpoint, and carries on from there", async () => {
      await reset();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const logs: Logs = [feedbackLog({ agent: 1, client: W(1), index: 1, value: "85", block: START + 10, tx: tx() }), feedbackLog({ agent: 2, client: W(1), index: 2, value: "90", block: START + 60_000, tx: tx() })];
        const outcome = await go({}, logs, { failAt: START + 60_000 }).result;
        expect(outcome).toMatchObject({ state: "completed", windows: 1, inserted: 1, caughtUp: false, stoppedBy: "chain" });
        expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({ event: "nooscape_bsc_raters_failed", message: "the reputation read stopped: BNB Chain eth_getLogs returned HTTP 503." });
        expect((await state())?.nextBlock).toBe(START + 50_000);
        expect(await ledger()).toHaveLength(1);
        expect(await go({}, logs).result).toMatchObject({ windows: 2, inserted: 1, caughtUp: true });
        expect(await ledger()).toHaveLength(2);
      } finally {
        error.mockRestore();
      }
    });

    it("stops before anything is read when the registry sits behind another implementation, and says which", async () => {
      await reset();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const other = "0x1111111111111111111111111111111111111111";
        const fake = go({}, [feedbackLog({ agent: 1, client: W(1), index: 1, value: "85", block: START + 10, tx: tx() })], { implementation: other });
        expect(await fake.result).toMatchObject({ windows: 0, inserted: 0, caughtUp: false, stoppedBy: "implementation", evaluated: false });
        expect(fake.fake.calls).toEqual(["eth_getStorageAt"]);
        expect((await state())?.implementation).toBe(other);
        expect(JSON.parse(String(error.mock.calls[0]![0])).message).toContain(other);
        expect(await ledger()).toHaveLength(0);
      } finally {
        error.mockRestore();
      }
    });

    it("stops at a log that does not decode, keeps the windows before it, and does not move the cursor past it", async () => {
      await reset();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const bad = { ...feedbackLog({ agent: 2, client: W(1), index: 2, value: "90", block: START + 60_000, tx: tx() }), data: "0x1234" };
        const logs: Logs = [feedbackLog({ agent: 1, client: W(1), index: 1, value: "85", block: START + 10, tx: tx() }), bad];
        const outcome = await go({}, logs).result;
        expect(outcome).toMatchObject({ windows: 1, inserted: 1, caughtUp: false, stoppedBy: "decode" });
        expect((await state())?.nextBlock).toBe(START + 50_000);
        expect(JSON.parse(String(error.mock.calls[0]![0])).message).toContain("did not decode");
      } finally {
        error.mockRestore();
      }
    });

    it("stops starting windows when its time is up, and says so", async () => {
      await reset();
      let clock = 0;
      const fake = chain([]);
      const outcome = await run.runBscRaters({
        rpc: async (method, params) => {
          clock += 10_000;
          return fake.rpc(method, params);
        },
        now: () => clock,
        budgetMs: 25_000,
      });
      // Two cheap questions take 20 seconds of the fake clock, so one window starts and the next does not.
      expect(outcome).toMatchObject({ state: "completed", windows: 1, stoppedBy: "time" });
    });
  });

  describe("the ratings", () => {
    /** The agents 1 to 22 rated by three concentrated wallets; agents 1 to 5 also by ordinary wallets; the owner of agent 3 rates it; agent 5's owner is a fleet wallet. */
    async function scenario() {
      await reset();
      const heavy = [W(1001), W(1002), W(1003)];
      const logs: Logs = [];
      // Each (agent, wallet) pair rates once, so its counter is 1, as the contract numbers it.
      let n = 0;
      for (const client of heavy) for (let agent = 1; agent <= 22; agent += 1) logs.push(feedbackLog({ agent, client, index: 1, value: "70", block: START + 1_000 + ++n, tx: tx() }));
      const ordinary: Array<[number, string, string]> = [
        [1, W(1), "85"], [1, W(2), "90"], [1, W(3), "100"],
        [2, W(4), "80"], [2, W(5), "95"], [2, W(6), "75"],
        [3, W(7), "88"], [3, W(8), "92"], [3, W(9), "81"],
        [5, W(10), "90"], [5, W(11), "91"], [5, W(12), "92"], [5, W(13), "93"],
        [4, W(14), "90"], [4, W(15), "70"],
      ];
      for (const [agent, client, value] of ordinary) logs.push(feedbackLog({ agent, client, index: 1, value, block: START + 20_000 + ++n, tx: tx() }));
      // A rating that was revoked: agent 4 had a third rater, who took it back.
      logs.push(feedbackLog({ agent: 4, client: W(16), index: 1, value: "99", block: START + 30_000, tx: tx() }));
      logs.push(revokedLog({ agent: 4, client: W(16), index: 1, block: START + 30_001, tx: tx() }));
      const FLEET = W(500);
      await seedRows([
        ...Array.from({ length: 22 }, (_, n) => draft(n + 1, n + 1 === 3 ? W(9) : n + 1 === 5 ? FLEET : W(3000 + n))),
        ...Array.from({ length: 49 }, (_, n) => draft(100 + n, FLEET)),
      ]);
      return logs;
    }

    it("sets aside the concentrated wallets, the owner's own wallet and a fleet's agents, and counts the independent raters that are left", async () => {
      const logs = await scenario();
      const outcome = await go({}, logs).result;
      expect(outcome).toMatchObject({ state: "completed", caughtUp: true, evaluated: true });
      const rows = await evidence();
      const by = (agent: number) => rows.find(row => row.agentId === agent)!;
      expect(rows).toHaveLength(22);
      expect(by(1)).toMatchObject({ externalKey: keyOf(1), rawEvents: 6, rawRaters: 6, concentratedRaters: 3, uniformRaters: 0, linkedRaters: 0, independentRaters: 3, weightedEvents: 3, ownerFleet: false, qualifies: true });
      expect(by(2)).toMatchObject({ rawRaters: 6, concentratedRaters: 3, independentRaters: 3, qualifies: true });
      // Agent 3's owner is one of its three ordinary raters, so two are left.
      expect(by(3)).toMatchObject({ rawRaters: 6, concentratedRaters: 3, linkedRaters: 1, independentRaters: 2, qualifies: false });
      // Agent 4 has two raters that stand (the third was revoked).
      expect(by(4)).toMatchObject({ rawRaters: 5, independentRaters: 2, qualifies: false });
      // Agent 5 has four independent raters and an owner that registered 50 agents, which puts it in a fleet.
      expect(by(5)).toMatchObject({ rawRaters: 7, independentRaters: 4, ownerRegistrations: 50, ownerFleet: true, qualifies: false });
      // The agents only the concentrated wallets rated have nothing left.
      expect(by(10)).toMatchObject({ rawRaters: 3, concentratedRaters: 3, independentRaters: 0, weightedEvents: 0, qualifies: false });
      expect(rows.filter(row => row.qualifies).map(row => row.agentId)).toEqual([1, 2]);
      expect((outcome as { report: unknown }).report).toMatchObject({ ratings: 3 * 22 + 15, raters: 3 + 15, agentsRated: 22, concentratedRaters: 3, concentratedEvents: 66, raw: 22, rawNotFleetOwned: 21, afterConcentrated: 4, afterLinked: 3, qualifying: 2 });
      expect((await state())?.evaluatedAt).not.toBeNull();
    });

    it("evaluates again on new ratings, drops the evidence of an agent whose ratings were all taken back, and leaves a stable ledger alone", async () => {
      const logs = await scenario();
      await go({}, logs).result;
      const before = (await evidence()).map(row => [row.agentId, row.independentRaters, row.qualifies]);
      // Nothing new and not due: not evaluated again.
      expect(await go({}, logs).result).toMatchObject({ evaluated: false });
      // Due: evaluated again, to the same result.
      expect(await go({ reevaluateMs: 0 }, logs).result).toMatchObject({ evaluated: true });
      expect((await evidence()).map(row => [row.agentId, row.independentRaters, row.qualifies])).toEqual(before);
      // The chain moves on. A fourth ordinary rater on agent 3, and the agent qualifies.
      logs.push(feedbackLog({ agent: 3, client: W(17), index: 99, value: "86", block: FINALIZED + 10, tx: tx() }));
      expect(await go({}, logs, { finalized: FINALIZED + 50_000 }).result).toMatchObject({ inserted: 1, evaluated: true });
      expect((await evidence()).find(row => row.agentId === 3)).toMatchObject({ independentRaters: 3, qualifies: true });
      // Every rating of agent 1 taken back: no evidence for it.
      for (const client of [W(1), W(2), W(3), W(1001), W(1002), W(1003)]) {
        logs.push(revokedLog({ agent: 1, client, index: 1, block: FINALIZED + 60_000, tx: tx() }));
      }
      await go({}, logs, { finalized: FINALIZED + 100_000 }).result;
      expect((await evidence()).some(row => row.agentId === 1)).toBe(false);
    });

    it("is never worked out on a ledger that has not caught up", async () => {
      const logs = await scenario();
      const partial = await go({ maxWindows: 1 }, logs).result;
      expect(partial).toMatchObject({ caughtUp: false, evaluated: false });
      expect(await evidence()).toEqual([]);
    });
  });

  describe("the guards", () => {
    it("lets a second run find the first still going, leaves a tick that has already run long alone, and has nothing to do without an approved source", async () => {
      await reset();
      let release: () => void = () => {};
      const held = new Promise<void>(resolve => (release = resolve));
      const slow = chain([]);
      const first = run.runBscRaters({ rpc: async (method, params) => (await held, slow.rpc(method, params)) });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await run.runBscRaters({ rpc: slow.rpc })).toEqual({ state: "busy" });
      release();
      await first;
      expect(await run.runBscRaters({ tickStartedAt: Date.now() - 120_000, rpc: slow.rpc })).toEqual({ state: "too_late" });
      await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-bsc"));
      const idle = go({}, []);
      expect(await idle.result).toEqual({ state: "no_source" });
      expect(idle.fake.calls).toEqual([]);
      await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, "src-bsc"));
    });
  });
});
