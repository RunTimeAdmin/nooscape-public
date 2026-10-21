import { eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";
import { ARC_CHAIN, BASE_CHAIN, ERC8004_REPUTATION_REGISTRY, validateErc8004Chains, type Erc8004Chain } from "./ingestion/erc8004Chains";
import { Erc8004RpcRangeError } from "./ingestion/erc8004Rpc";
import { hexNum, word, type LogShape } from "./ingestion/erc8004TestChain";
import { ROBINHOOD_FEEDBACK_REVOKED_TOPIC, ROBINHOOD_NEW_FEEDBACK_TOPIC } from "./ingestion/robinhoodReputation";

/**
 * The ratings step against a real database (docs/extra-chain-ratings-2026-10-21.md). It counts a chain's reputation registry's NewFeedback and
 * FeedbackRevoked events and keeps only the two counts and the block it has read to. What is held: every event is counted once across windows,
 * runs and a lost race; a count is shown only once the read has reached the finalized head; the gap between runs; a result-size refusal halves
 * a window and the count stays exact; a fault in the provider's answer stops the window with its position kept; a chain that is off or has no
 * active source is not read; with the table missing the step does nothing; and the figure reaches the chain stats. Runs on a throwaway schema
 * and skips when no database is reachable.
 */
const TEST_DB = "nooscape_chain_ratings_test";
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

/** Arc's and Base's entries with small numbers, so a few hundred blocks are several windows. */
const ARC: Erc8004Chain = { ...ARC_CHAIN, deployBlock: 1_000, reputation: { registry: ERC8004_REPUTATION_REGISTRY, window: 100 } };
const BASE: Erc8004Chain = { ...BASE_CHAIN, deployBlock: 5_000, reputation: { registry: ERC8004_REPUTATION_REGISTRY, window: 100 } };
const MINUTE = 60_000;

const ratingLog = (block: number, logIndex: number, kind: "rating" | "revocation", over: Record<string, unknown> = {}): LogShape => ({
  address: ERC8004_REPUTATION_REGISTRY.toLowerCase(),
  topics: [kind === "rating" ? ROBINHOOD_NEW_FEEDBACK_TOPIC : ROBINHOOD_FEEDBACK_REVOKED_TOPIC, word(7), word(9), word(11)],
  data: "0x",
  blockNumber: hexNum(block),
  logIndex: hexNum(logIndex),
  transactionHash: word(block * 100 + logIndex),
  ...over,
});

describe.skipIf(!dbReachable)("the ratings step, against a real database", { timeout: 180_000 }, () => {
  let step: typeof import("./chainRatings");
  let db: typeof import("./db");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let readCache: typeof import("./readCache");
  const previousFeatures = process.env.VITE_FEATURES;

  /** A fake node for one chain: its logs by block, the finalized head, and a record of the calls. */
  const node = (logs: LogShape[], finalized: number, chain: Erc8004Chain, extra: { onLogs?: (from: number, to: number) => Promise<void> | void; refuseWiderThan?: number; chainId?: string } = {}) => {
    const calls = { getLogs: 0, widths: [] as number[] };
    const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
      if (method === "eth_chainId") return extra.chainId ?? chain.chainIdHex;
      if (method === "eth_getBlockByNumber") return { number: hexNum(finalized) };
      if (method === "eth_getLogs") {
        const filter = params[0] as { address: string; fromBlock: string; toBlock: string; topics: string[][] };
        expect(filter.address).toBe(ERC8004_REPUTATION_REGISTRY);
        expect(filter.topics).toEqual([[ROBINHOOD_NEW_FEEDBACK_TOPIC, ROBINHOOD_FEEDBACK_REVOKED_TOPIC]]);
        const from = Number.parseInt(filter.fromBlock, 16);
        const to = Number.parseInt(filter.toBlock, 16);
        calls.getLogs += 1;
        calls.widths.push(to - from + 1);
        if (extra.refuseWiderThan !== undefined && to - from + 1 > extra.refuseWiderThan) throw new Erc8004RpcRangeError("result_size", "too many results");
        await extra.onLogs?.(from, to);
        return logs.filter(log => Number.parseInt(log.blockNumber as string, 16) >= from && Number.parseInt(log.blockNumber as string, 16) <= to);
      }
      throw new Error(`unexpected ${method}`);
    };
    return { rpc, calls };
  };
  const clock = { t: Date.UTC(2026, 9, 21, 12, 0, 0) };
  const run = (chains: Erc8004Chain[], nodes: Record<string, (chain: Erc8004Chain) => (method: string, params: unknown[]) => Promise<unknown>>, over: Partial<import("./chainRatings").RatingsDeps> = {}) =>
    step.runChainRatings(
      { tickStartedAt: clock.t },
      { chains, now: () => clock.t, rpcFor: async chain => nodes[chain.chainKey]!(chain), budgetMs: 60_000, maxWindows: 200, ...over }
    );
  const rowOf = async (chainKey: string) => (await writer.select().from(schema.chainReputationCounts).where(eq(schema.chainReputationCounts.chainKey, chainKey)))[0];
  const forget = async (chainKey: string) => {
    await writer.delete(schema.chainReputationCounts).where(eq(schema.chainReputationCounts.chainKey, chainKey));
    readCache.invalidateDirectoryReads();
  };

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    process.env.VITE_FEATURES = "chain_arc,chain_base";
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    const baselineReplay = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baselineReplay.query(statement);
    }
    await baselineReplay.end();
    // The boot runner creates the counts table (0048) and skips the manual migrations; 0046 is pasted for the Base and Arc protocol values.
    const applied = await applyPendingMigrations(process.env.DATABASE_URL);
    expect(applied.some(name => name.startsWith("0048_"))).toBe(true);
    const connection = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8"))) await connection.query(statement);
    await connection.end();

    db = await import("./db");
    readCache = await import("./readCache");
    step = await import("./chainRatings");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "ratings-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "ratings-operator"));
    for (const [chain, host] of [[ARC, "arc-node.example"], [BASE, "base-mainnet.g.alchemy.com"]] as const) {
      await writer.insert(schema.ingestionSources).values({
        id: `src-${chain.chainKey}`,
        sourceKey: chain.sourceKey,
        label: `${chain.label} ERC-8004 identity registry`,
        protocol: chain.protocol as (typeof schema.ingestionSources.$inferInsert)["protocol"],
        rootUrl: `https://${host}`,
        allowedHostname: host,
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

  it("names the reputation registry on Ethereum, Base and Arc, and the entries are sound", async () => {
    const { ETHEREUM_CHAIN } = await import("./ingestion/erc8004Chains");
    const { ROBINHOOD_REPUTATION_REGISTRY } = await import("./ingestion/robinhoodReputation");
    expect(ERC8004_REPUTATION_REGISTRY).toBe(ROBINHOOD_REPUTATION_REGISTRY);
    for (const chain of [ETHEREUM_CHAIN, BASE_CHAIN, ARC_CHAIN]) expect(chain.reputation?.registry, chain.protocol).toBe(ERC8004_REPUTATION_REGISTRY);
    expect(validateErc8004Chains([ARC, BASE])).toEqual([]);
  });

  describe("counting", () => {
    // Eleven ratings and two revocations in blocks 1,000 to 1,449 (five windows of 100 blocks), finalized at 1,449.
    const logs: LogShape[] = [
      ...[1_000, 1_001, 1_099, 1_100, 1_150, 1_199, 1_200, 1_250, 1_333, 1_400, 1_449].map((block, i) => ratingLog(block, i, "rating")),
      ratingLog(1_101, 9, "revocation"),
      ratingLog(1_449, 10, "revocation"),
    ];

    it("counts each event once across windows and shows nothing until the read has reached the finalized head", async () => {
      const arc = node(logs, 1_449, ARC);
      const partial = await run([ARC], { arc: () => arc.rpc }, { maxWindows: 3 });
      expect(partial).toEqual([{ chainKey: "arc", state: "completed", windows: 3, ratings: 8, revocations: 1, caughtUp: false }]);
      let row = (await rowOf("arc"))!;
      expect([row.ratings, row.revocations, row.nextBlock, row.caughtUpAt]).toEqual([8, 1, 1_300, null]);
      readCache.invalidateDirectoryReads();
      expect(await db.readChainRatings()).toEqual({});

      // The gap between runs: nothing happens until it has passed, and then the read goes on from where it was.
      expect((await run([ARC], { arc: () => arc.rpc }))[0]!.state).toBe("waiting");
      clock.t += 30 * MINUTE;
      const rest = await run([ARC], { arc: () => arc.rpc });
      expect(rest).toEqual([{ chainKey: "arc", state: "completed", windows: 2, ratings: 3, revocations: 1, caughtUp: true }]);
      row = (await rowOf("arc"))!;
      expect([row.ratings, row.revocations, row.nextBlock]).toEqual([11, 2, 1_450]);
      expect(row.caughtUpAt).not.toBeNull();
      readCache.invalidateDirectoryReads();
      expect(await db.readChainRatings()).toEqual({ arc: 11 });
    });

    it("counts nothing again when it runs on a caught-up chain, and picks up what the chain adds", async () => {
      clock.t += 30 * MINUTE;
      const quiet = await run([ARC], { arc: () => node(logs, 1_449, ARC).rpc });
      expect(quiet).toEqual([{ chainKey: "arc", state: "completed", windows: 0, ratings: 0, revocations: 0, caughtUp: false }]);
      expect((await rowOf("arc"))!.ratings).toBe(11);
      clock.t += 30 * MINUTE;
      const later = [...logs, ratingLog(1_460, 0, "rating"), ratingLog(1_461, 0, "rating")];
      const grown = await run([ARC], { arc: () => node(later, 1_470, ARC).rpc });
      expect(grown[0]).toMatchObject({ state: "completed", windows: 1, ratings: 2, caughtUp: true });
      expect((await rowOf("arc"))!.ratings).toBe(13);
    });

    it("counts a window once when another run has moved the position meanwhile", async () => {
      await forget("arc");
      clock.t += 30 * MINUTE;
      const racer = node(logs, 1_449, ARC, {
        // While the second window is being read, another run counts it and moves the position past it.
        onLogs: async from => {
          if (from === 1_100) await writer.update(schema.chainReputationCounts).set({ nextBlock: 1_200, ratings: 4 }).where(eq(schema.chainReputationCounts.chainKey, "arc"));
        },
      });
      const result = await run([ARC], { arc: () => racer.rpc });
      expect(result[0]).toMatchObject({ state: "busy", windows: 1 });
      const row = (await rowOf("arc"))!;
      // The first window's three ratings were counted by this run and then overwritten by the other run's state; the second window's were not added twice.
      expect([row.nextBlock, row.ratings]).toEqual([1_200, 4]);
    });

    it("halves a window the provider says is too large, and the count stays exact", async () => {
      await forget("arc");
      clock.t += 30 * MINUTE;
      const strict = node(logs, 1_449, ARC, { refuseWiderThan: 70 });
      const result = await run([ARC], { arc: () => strict.rpc });
      expect(result[0]).toMatchObject({ state: "completed", ratings: 11, revocations: 2, caughtUp: true });
      expect(Math.max(...strict.calls.widths)).toBeGreaterThan(70);
      expect(strict.calls.widths.filter(width => width <= 70).length).toBeGreaterThan(0);
    });
  });

  describe("a fault in what the provider answers", () => {
    it.each([
      ["a log from another address", ratingLog(1_010, 0, "rating", { address: "0x0000000000000000000000000000000000000001" })],
      ["a log outside the window", ratingLog(9_999, 0, "rating")],
      ["a topic that was not asked for", ratingLog(1_010, 0, "rating", { topics: ["0x" + "ab".repeat(32), word(1), word(2), word(3)] })],
      ["a log without the four topics", ratingLog(1_010, 0, "rating", { topics: [ROBINHOOD_NEW_FEEDBACK_TOPIC, word(1)] })],
    ])("stops the window with %s, and keeps its position", async (_label, bad) => {
      await forget("arc");
      clock.t += 30 * MINUTE;
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const faulty = {
        rpc: async (method: string): Promise<unknown> => {
          if (method === "eth_chainId") return ARC.chainIdHex;
          if (method === "eth_getBlockByNumber") return { number: hexNum(1_449) };
          return [bad];
        },
      };
      const result = await run([ARC], { arc: () => faulty.rpc });
      expect(result[0]).toMatchObject({ state: "failed", windows: 0 });
      const row = (await rowOf("arc"))!;
      expect([row.ratings, row.revocations, row.nextBlock]).toEqual([0, 0, 1_000]);
      expect(String(errors.mock.calls.at(-1)?.[0])).toContain("nooscape_chain_ratings_failed");
      errors.mockRestore();
    });

    it("refuses an endpoint that does not confirm the chain's id", async () => {
      await forget("arc");
      clock.t += 30 * MINUTE;
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const wrong = node([], 1_449, ARC, { chainId: "0x1" });
      expect((await run([ARC], { arc: () => wrong.rpc }))[0]!.state).toBe("failed");
      expect(wrong.calls.getLogs).toBe(0);
      errors.mockRestore();
    });
  });

  describe("which chains are read", () => {
    it("reads each chain with a registry named, on its own position, and leaves a chain that is off alone", async () => {
      await forget("arc");
      await forget("base");
      clock.t += 30 * MINUTE;
      const arcLogs = [ratingLog(1_050, 0, "rating"), ratingLog(1_060, 0, "revocation")];
      const baseLogs = [ratingLog(5_010, 0, "rating"), ratingLog(5_020, 0, "rating"), ratingLog(5_130, 0, "rating")];
      const results = await run([ARC, BASE], { arc: () => node(arcLogs, 1_199, ARC).rpc, base: () => node(baseLogs, 5_199, BASE).rpc });
      expect(results.map(r => [r.chainKey, r.state, r.ratings, r.revocations])).toEqual([["arc", "completed", 1, 1], ["base", "completed", 3, 0]]);
      readCache.invalidateDirectoryReads();
      expect(await db.readChainRatings()).toEqual({ arc: 1, base: 3 });

      process.env.VITE_FEATURES = "chain_arc";
      clock.t += 30 * MINUTE;
      const offBase = await run([ARC, BASE], { arc: () => node(arcLogs, 1_199, ARC).rpc, base: () => { throw new Error("must not be opened"); } });
      expect(offBase.map(r => r.chainKey)).toEqual(["arc"]);
      process.env.VITE_FEATURES = "chain_arc,chain_base";
    });

    it("reads a chain only while its identity source is active", async () => {
      await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-base"));
      clock.t += 30 * MINUTE;
      const results = await run([BASE], { base: () => { throw new Error("must not be opened"); } });
      expect(results).toEqual([{ chainKey: "base", state: "no_source", windows: 0, ratings: 0, revocations: 0, caughtUp: false }]);
      await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, "src-base"));
    });

    it("does not start on a tick that has already run too long", async () => {
      const results = await step.runChainRatings({ tickStartedAt: clock.t - 101_000 }, { chains: [ARC], now: () => clock.t, rpcFor: async () => { throw new Error("must not be opened"); } });
      expect(results).toEqual([]);
    });

    it("stops starting windows when its time is up", async () => {
      await forget("arc");
      clock.t += 30 * MINUTE;
      const slow = node([ratingLog(1_010, 0, "rating")], 1_449, ARC, { onLogs: () => void (clock.t += 10_000) });
      const result = await run([ARC], { arc: () => slow.rpc }, { budgetMs: 25_000 });
      expect(result[0]).toMatchObject({ state: "completed", windows: 3, caughtUp: false });
    });
  });

  describe("the figure", () => {
    it("reaches the chain stats for a chain that has caught up, and says nothing for one that has not", async () => {
      await forget("arc");
      await forget("base");
      clock.t += 30 * MINUTE;
      const logs = [ratingLog(1_010, 0, "rating"), ratingLog(1_020, 0, "rating"), ratingLog(1_030, 0, "revocation")];
      await run([ARC], { arc: () => node(logs, 1_199, ARC).rpc });
      await run([BASE], { base: () => node([], 5_099, BASE).rpc }, { maxWindows: 0 });
      readCache.invalidateDirectoryReads();
      const stats = await db.readChainStatsWithExtras(["arc", "base"], {});
      const feedback = Object.fromEntries(stats.extras.map(extra => [extra.chain, extra.feedbackEvents]));
      // Arc counted 2 ratings (the revocation is not a rating). Base is indexed but has not been read to the head, so its figure is not measured.
      expect(feedback.arc).toBe(2);
      expect(feedback.base).toBeNull();
    });
  });

  describe("with the table missing", () => {
    it("does nothing, throws nothing and says nothing; the reader fails closed", async () => {
      await writer.execute(sql`DROP TABLE chain_reputation_counts`);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      clock.t += 30 * MINUTE;
      const results = await run([ARC], { arc: () => { throw new Error("must not be opened"); } });
      expect(results).toEqual([{ chainKey: "arc", state: "unavailable", windows: 0, ratings: 0, revocations: 0, caughtUp: false }]);
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
      readCache.invalidateDirectoryReads();
      await expect(db.readChainRatings()).rejects.toThrow();
      // The chain stats absorb it: the figure is simply not measured.
      await expect(db.readChainStatsWithExtras(["arc"], {})).resolves.toMatchObject({ extras: [{ chain: "arc", feedbackEvents: null }] });
    });
  });
});
