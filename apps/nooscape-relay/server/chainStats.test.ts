import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildChainStats, chainOf, CHAINS, parseProtocolList } from "@shared/chains";
import * as schema from "../drizzle/schema";
import { REPUTATION_KEY_PREFIX } from "./ratingsSurface";

/**
 * The per-chain figures behind the Home chain tabs. The arithmetic is pure and
 * tested first; then the same figures are read from a real database with the
 * entries the public must never see (hidden, closed, on a suppressed host, from a
 * paused source, withdrawn) sitting beside the ones it may, and every one of them
 * must stay out of every number. The database half skips when none is reachable.
 */
describe("chainOf and parseProtocolList", () => {
  it("puts each protocol on the chain the directory already says it is on", () => {
    expect(chainOf("erc8004")).toBe("robinhood");
    expect(chainOf("erc8004_reputation")).toBe("robinhood");
    expect(chainOf("usdg_settlement")).toBe("robinhood");
    expect(["solana_registry", "solana_8004", "solana_said"].map(chainOf)).toEqual(["solana", "solana", "solana"]);
    expect(chainOf("erc8004_bsc")).toBe("bnb");
  });

  it("puts the locator protocols on no chain", () => {
    for (const protocol of ["a2a", "anp", "agntcy", "catalog", "census", "unheard-of"]) expect(chainOf(protocol)).toBeNull();
  });

  it("reads the stored protocols text, and anything else is none", () => {
    expect(parseProtocolList('["erc8004","a2a"]')).toEqual(["erc8004", "a2a"]);
    expect(parseProtocolList('["a",1,null]')).toEqual(["a"]);
    expect(parseProtocolList("{}")).toEqual([]);
    expect(parseProtocolList("nope")).toEqual([]);
    expect(parseProtocolList("")).toEqual([]);
  });
});

describe("buildChainStats", () => {
  const active = (protocol: string, lastSuccessfulAt: string | null = null) => ({ protocol, state: "active", lastSuccessfulAt });
  const base = {
    byProtocol: [
      { protocol: "catalog", count: 1000 },
      { protocol: "erc8004", count: 80 },
      { protocol: "solana_registry", count: 15 },
      { protocol: "solana_said", count: 40 },
    ],
    reviewedProtocols: [["erc8004", "a2a"], ["solana_registry"], ["solana_8004", "solana_registry"], ["catalog"], []],
    robinhoodFeedback: 9,
    sources: [active("erc8004", "2026-10-14T10:00:00.000Z"), active("erc8004_reputation", "2026-10-14T12:00:00.000Z"), active("solana_registry"), active("solana_said", "2026-10-14T11:00:00.000Z")],
  };

  it("gives one row per chain, always in the same order", () => {
    expect(buildChainStats(base).map(row => row.chain)).toEqual([...CHAINS]);
    expect(buildChainStats({ byProtocol: [], reviewedProtocols: [], robinhoodFeedback: null, sources: [] }).map(row => row.chain)).toEqual([...CHAINS]);
  });

  it("sums the directory's counts per chain and leaves locator protocols out", () => {
    const rows = buildChainStats(base);
    expect(rows.find(row => row.chain === "robinhood")!.acknowledged).toBe(80);
    expect(rows.find(row => row.chain === "solana")!.acknowledged).toBe(55);
  });

  it("counts a reviewed record once for a chain however many of its protocols are on it", () => {
    const rows = buildChainStats(base);
    expect(rows.find(row => row.chain === "robinhood")!.reviewed).toBe(1);
    expect(rows.find(row => row.chain === "solana")!.reviewed).toBe(2);
  });

  it("reports a chain with no active source as not indexed, with nothing measured, never as zero", () => {
    const bnb = buildChainStats({ ...base, byProtocol: [...base.byProtocol, { protocol: "erc8004_bsc", count: 6000 }], sources: [...base.sources, { protocol: "erc8004_bsc", state: "paused", lastSuccessfulAt: null }] }).find(row => row.chain === "bnb")!;
    expect(bnb).toEqual({ chain: "bnb", indexed: false, acknowledged: null, reviewed: null, feedbackEvents: null, registries: [], asOf: null });
  });

  it("reads feedback for Robinhood and for Solana, and only where each is read", () => {
    const rows = buildChainStats(base);
    expect(rows.find(row => row.chain === "robinhood")!.feedbackEvents).toBe(9);
    expect(rows.find(row => row.chain === "solana")!.feedbackEvents).toBeNull();
    expect(buildChainStats({ ...base, robinhoodFeedback: null }).find(row => row.chain === "robinhood")!.feedbackEvents).toBeNull();
    const withSolana = buildChainStats({ ...base, solanaFeedback: 10_634 });
    expect(withSolana.find(row => row.chain === "solana")!.feedbackEvents).toBe(10_634);
    // Solana's ratings never reach another chain, and a chain that is not indexed shows none however many were counted.
    expect(withSolana.find(row => row.chain === "robinhood")!.feedbackEvents).toBe(9);
    expect(withSolana.find(row => row.chain === "bnb")!.feedbackEvents).toBeNull();
    expect(buildChainStats({ ...base, solanaFeedback: 12, sources: [active("erc8004"), active("erc8004_reputation")] }).find(row => row.chain === "solana")!.feedbackEvents).toBeNull();
    // A count of zero is a count: it is kept, never turned into "not measured".
    expect(buildChainStats({ ...base, solanaFeedback: 0 }).find(row => row.chain === "solana")!.feedbackEvents).toBe(0);
  });

  it("lists the registries behind each chain, largest first, and none for a chain that is not indexed", () => {
    const rows = buildChainStats({ ...base, byProtocol: [...base.byProtocol, { protocol: "solana_8004", count: 0 }, { protocol: "solana_8004", count: 7 }] });
    expect(rows.find(row => row.chain === "solana")!.registries).toEqual([
      { protocol: "solana_said", count: 40 },
      { protocol: "solana_registry", count: 15 },
      { protocol: "solana_8004", count: 7 },
    ]);
    expect(rows.find(row => row.chain === "robinhood")!.registries).toEqual([{ protocol: "erc8004", count: 80 }]);
    // Locator protocols are on no chain, so they are in no chain's split.
    expect(rows.flatMap(row => row.registries).some(registry => registry.protocol === "catalog")).toBe(false);
    expect(buildChainStats({ ...base, sources: [] }).every(row => row.registries.length === 0)).toBe(true);
  });

  it("dates a chain by its newest successful active source, and by nothing when none has succeeded", () => {
    const rows = buildChainStats(base);
    expect(rows.find(row => row.chain === "robinhood")!.asOf).toBe("2026-10-14T12:00:00.000Z");
    expect(rows.find(row => row.chain === "solana")!.asOf).toBe("2026-10-14T11:00:00.000Z");
    const never = buildChainStats({ ...base, sources: [active("solana_registry")] }).find(row => row.chain === "solana")!;
    expect(never.asOf).toBeNull();
    expect(never.indexed).toBe(true);
    const paused = buildChainStats({ ...base, sources: [{ protocol: "solana_registry", state: "paused", lastSuccessfulAt: "2026-10-14T11:00:00.000Z" }] }).find(row => row.chain === "solana")!;
    expect(paused.asOf).toBeNull();
  });

  it("accepts dates as Date objects and ignores one that does not parse", () => {
    const rows = buildChainStats({ ...base, sources: [{ protocol: "solana_registry", state: "active", lastSuccessfulAt: new Date("2026-10-14T09:30:00Z") }, { protocol: "solana_said", state: "active", lastSuccessfulAt: "not a date" }] });
    expect(rows.find(row => row.chain === "solana")!.asOf).toBe("2026-10-14T09:30:00.000Z");
  });
});

const TEST_DB = "nooscape_chain_stats_test";
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

describe.skipIf(!dbReachable)("chain stats against a real database", () => {
  type Db = typeof import("./db");
  let db: Db;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;
  const rhKey = (token: number) => `${REPUTATION_KEY_PREFIX}${token}`;

  async function source(id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"], state: "active" | "paused", lastSuccessfulAt?: Date) {
    await writer.insert(schema.ingestionSources).values({
      id,
      sourceKey: `chain-stats-${id}`,
      label: id,
      protocol,
      rootUrl: "https://chain-stats.example/feed",
      allowedHostname: "chain-stats.example",
      state,
      createdByUserId: operatorUserId,
      lastSuccessfulAt,
    });
  }

  async function entry(id: string, sourceId: string, protocol: (typeof schema.agentDirectoryEntries.$inferInsert)["protocol"], externalKey: string, extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}) {
    await writer.insert(schema.agentDirectoryEntries).values({ id, sourceId, externalKey, displayName: `Entry ${id}`, protocol, ...extra });
  }

  let eventSerial = 0;
  async function feedback(agentId: number, kind: "new_feedback" | "feedback_revoked" = "new_feedback") {
    eventSerial += 1;
    await writer.insert(schema.agentReputationEvents).values({
      id: `ev-${eventSerial}`,
      sourceId: "src-rh-rep",
      transactionHash: `0x${String(eventSerial).padStart(64, "0")}`,
      logIndex: 0,
      kind,
      blockNumber: 1_000 + eventSerial,
      agentId,
      clientAddress: `0x${"c".repeat(40)}`,
    });
  }

  /** A reviewed record: a snapshot of the shared approved run, carrying the given protocols. */
  async function reviewed(agentId: string, protocols: string[], sourceId = "src-reviewed", runId = "run-reviewed") {
    const observationId = `obs-${agentId}`;
    await writer.insert(schema.agents).values({ id: agentId, displayName: `Record ${agentId}`, handle: `handle-${agentId}` });
    await writer.insert(schema.sourceObservations).values({
      id: observationId,
      sourceId,
      protocol: "catalog",
      canonicalLocator: `https://chain-stats.example/${agentId}`,
      locatorHash: `loc-${agentId}`.padEnd(64, "0").slice(0, 64),
      contentHash: `hash-${agentId}`.padEnd(64, "0").slice(0, 64),
      rawObjectKey: `chain-stats/${agentId}`,
      contentType: "application/json",
      parserVersion: "chain-stats-test",
      validationStatus: "valid",
      validationFindings: "[]",
      observedAt: new Date(),
    });
    await writer.insert(schema.sourceObservationRuns).values({ runId, observationId });
    await writer.insert(schema.agentPublicSnapshots).values({
      id: `snap-${agentId}`,
      agentId,
      sourceId,
      sourceObservationId: observationId,
      displayName: `Record ${agentId}`,
      displayHandle: `handle-${agentId}`,
      protocols: JSON.stringify(protocols),
    });
  }

  async function approvedSource(sourceId: string, runId: string, state: "active" | "paused") {
    await source(sourceId, "catalog", state);
    await writer.insert(schema.ingestionRuns).values({ id: runId, sourceId, trigger: "manual", status: "completed", startedAt: new Date(), finishedAt: new Date() });
    await writer.insert(schema.sourceProjectionDecisions).values({ sourceId, state: "public", rationale: "chain stats test", decidedByUserId: operatorUserId, approvedRunId: runId });
  }

  const stat = async (chain: string) => (await db.readChainStats()).find(row => row.chain === chain)!;

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

    await writer.insert(schema.users).values({ openId: "chain-stats-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "chain-stats-operator"));
    operatorUserId = operator.id;

    await source("src-rh-id", "erc8004", "active", new Date("2026-10-14T10:00:00Z"));
    await source("src-rh-rep", "erc8004_reputation", "active", new Date("2026-10-14T12:00:00Z"));
    await source("src-sol-meta", "solana_registry", "active", new Date("2026-10-14T11:00:00Z"));
    await source("src-sol-8004", "solana_8004", "paused", new Date("2026-10-14T13:00:00Z"));
    await source("src-bnb", "erc8004_bsc", "paused");

    // Robinhood identities: two the public may see, and one each the public must not.
    await entry("rh-1", "src-rh-id", "erc8004", rhKey(1));
    await entry("rh-2-hidden", "src-rh-id", "erc8004", rhKey(2), { hidden: true });
    await entry("rh-3-closed", "src-rh-id", "erc8004", rhKey(3), { assetClosedAt: new Date() });
    await entry("rh-4-suppressed", "src-rh-id", "erc8004", rhKey(4), { locatorHost: "api.agentrank.info" });
    await entry("rh-5", "src-rh-id", "erc8004", rhKey(5));
    // Solana: three visible in the active registry, one hidden, and two in a paused registry.
    for (const n of [1, 2, 3]) await entry(`sol-${n}`, "src-sol-meta", "solana_registry", `sol-key-${n}`);
    await entry("sol-hidden", "src-sol-meta", "solana_registry", "sol-key-hidden", { hidden: true });
    // The 8004 registry's own feedback counters: 5 on one account, a counted zero on another, none read yet on a third, and 100
    // on a hidden account, which must never reach the sum.
    await entry("sol8004-1", "src-sol-8004", "solana_8004", "s8004-key-1", { feedbackCount: 5 });
    await entry("sol8004-2", "src-sol-8004", "solana_8004", "s8004-key-2", { feedbackCount: 0 });
    await entry("sol8004-unread", "src-sol-8004", "solana_8004", "s8004-key-unread");
    await entry("sol8004-hidden", "src-sol-8004", "solana_8004", "s8004-key-hidden", { feedbackCount: 100, hidden: true });
    // BNB: five entries in a source that is not active.
    for (const n of [1, 2, 3, 4, 5]) await entry(`bnb-${n}`, "src-bnb", "erc8004_bsc", `eip155:56:0xbnb:${n}`);

    // Ratings: for each identity above, and for a token with no entry at all.
    await feedback(1);
    await feedback(1);
    await feedback(1, "feedback_revoked");
    for (let count = 0; count < 3; count += 1) await feedback(2);
    await feedback(3);
    await feedback(4);
    await feedback(5);
    for (let count = 0; count < 4; count += 1) await feedback(99);

    // Reviewed records: one on Robinhood, two on Solana (one with both registries), one on no chain,
    // one that is withdrawn, and one from a source that is not active.
    await approvedSource("src-reviewed", "run-reviewed", "active");
    await approvedSource("src-reviewed-paused", "run-reviewed-paused", "paused");
    await reviewed("rec-rh", ["erc8004", "a2a"]);
    await reviewed("rec-sol", ["solana_registry"]);
    await reviewed("rec-sol-both", ["solana_8004", "solana_registry"]);
    await reviewed("rec-none", ["catalog"]);
    await reviewed("rec-withdrawn", ["erc8004"]);
    await reviewed("rec-paused", ["erc8004"], "src-reviewed-paused", "run-reviewed-paused");
    await writer.insert(schema.agentRecordWithdrawals).values({ agentId: "rec-withdrawn", action: "withdraw", reason: "chain stats test", decidedByUserId: operatorUserId });
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("counts only what the public may see, on each chain", async () => {
    const rows = await db.readChainStats();
    expect(rows.map(row => row.chain)).toEqual(["robinhood", "solana", "bnb"]);
    expect(await stat("robinhood")).toEqual({
      chain: "robinhood",
      indexed: true,
      // rh-1 and rh-5: the hidden, closed and suppressed-host entries are out.
      acknowledged: 2,
      // rec-rh only: the withdrawn record and the one from a paused source are out.
      reviewed: 1,
      // Two ratings on rh-1 and one on rh-5. Not the revocation, nor the ratings of the hidden, closed or suppressed
      // entries, nor of a token with no entry.
      feedbackEvents: 3,
      registries: [{ protocol: "erc8004", count: 2 }],
      asOf: "2026-10-14T12:00:00.000Z",
    });
    expect(await stat("solana")).toEqual({
      chain: "solana",
      indexed: true,
      // Three visible in the active registry; the hidden one and the paused registry's two are out.
      acknowledged: 3,
      // rec-sol and rec-sol-both, each once.
      reviewed: 2,
      // The 8004 registry is paused, so its counters are not read, and "not read" is not zero.
      feedbackEvents: null,
      registries: [{ protocol: "solana_registry", count: 3 }],
      // The paused registry's newer success is not counted.
      asOf: "2026-10-14T11:00:00.000Z",
    });
  });

  it("reports BNB Chain as not indexed while its source is not active, whatever its entries say", async () => {
    expect(await stat("bnb")).toEqual({ chain: "bnb", indexed: false, acknowledged: null, reviewed: null, feedbackEvents: null, registries: [], asOf: null });
  });

  it("sums the 8004 registry's feedback counters for Solana over the visible accounts, once that registry is active", async () => {
    const { invalidateDirectoryReads } = await import("./readCache");
    await db.decideIngestionSource({ sourceId: "src-sol-8004", decision: "active", decidedByUserId: operatorUserId, rationale: "chain stats test approve 8004" });
    const solana = await stat("solana");
    // 5 and a counted zero. The hidden account's 100 and the account whose counter is unread are out.
    expect(solana.feedbackEvents).toBe(5);
    expect(solana.acknowledged).toBe(6);
    expect(solana.registries).toHaveLength(2);
    expect(solana.registries).toEqual(expect.arrayContaining([{ protocol: "solana_registry", count: 3 }, { protocol: "solana_8004", count: 3 }]));
    // Solana's ratings reach no other chain.
    expect((await stat("robinhood")).feedbackEvents).toBe(3);

    // Hiding the account that holds the 5 takes it out on the very next read.
    await db.hideDirectoryEntry("sol8004-1");
    expect((await stat("solana")).feedbackEvents).toBe(0);
    await db.unhideDirectoryEntry("sol8004-1");
    expect((await stat("solana")).feedbackEvents).toBe(5);

    // No counter read on any visible account is "not measured", never zero.
    await writer.update(schema.agentDirectoryEntries).set({ feedbackCount: null }).where(eq(schema.agentDirectoryEntries.sourceId, "src-sol-8004"));
    invalidateDirectoryReads();
    expect((await stat("solana")).feedbackEvents).toBeNull();

    await db.decideIngestionSource({ sourceId: "src-sol-8004", decision: "paused", decidedByUserId: operatorUserId, rationale: "chain stats test pause 8004" });
    expect((await stat("solana")).registries).toEqual([{ protocol: "solana_registry", count: 3 }]);
  });

  it("drops a hidden entry from the counts and from its ratings on the very next read", async () => {
    await db.hideDirectoryEntry("rh-5");
    const robinhood = await stat("robinhood");
    expect(robinhood.acknowledged).toBe(1);
    expect(robinhood.feedbackEvents).toBe(2);
    await db.unhideDirectoryEntry("rh-5");
    expect((await stat("robinhood")).acknowledged).toBe(2);
    expect((await stat("robinhood")).feedbackEvents).toBe(3);
  });

  it("drops a record the moment an operator withdraws it, because the reviewed count is never cached", async () => {
    await writer.insert(schema.agentRecordWithdrawals).values({ agentId: "rec-rh", action: "withdraw", reason: "chain stats test", decidedByUserId: operatorUserId });
    expect((await stat("robinhood")).reviewed).toBe(0);
    await writer.insert(schema.agentRecordWithdrawals).values({ agentId: "rec-rh", action: "reinstate", reason: "chain stats test", decidedByUserId: operatorUserId });
    expect((await stat("robinhood")).reviewed).toBe(1);
  });

  it("leaves a chain's ratings unmeasured when its reputation source is not active, not zero", async () => {
    await db.decideIngestionSource({ sourceId: "src-rh-rep", decision: "paused", decidedByUserId: operatorUserId, rationale: "chain stats test pause" });
    const robinhood = await stat("robinhood");
    expect(robinhood.feedbackEvents).toBeNull();
    expect(robinhood.acknowledged).toBe(2);
    await db.decideIngestionSource({ sourceId: "src-rh-rep", decision: "active", decidedByUserId: operatorUserId, rationale: "chain stats test resume" });
    expect((await stat("robinhood")).feedbackEvents).toBe(3);
  });

  it("indexes BNB Chain, with its entries, once its source is approved", async () => {
    await db.decideIngestionSource({ sourceId: "src-bnb", decision: "active", decidedByUserId: operatorUserId, rationale: "chain stats test approve" });
    expect(await stat("bnb")).toMatchObject({ chain: "bnb", indexed: true, acknowledged: 5, reviewed: 0, feedbackEvents: null });
  });
});
