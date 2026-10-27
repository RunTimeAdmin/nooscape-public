import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import express from "express";
import { createConnection, createPool } from "mysql2/promise";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { problems, schemaOf } from "./apiV1Testing";

/**
 * The pre-flight check against a real database (docs/data-access-2026-10-19.md, stage D3): the ledgers it reads, with real keys and the
 * tier gate. An EVM agent whose first transfer was a hand-out, a Solana agent with recorded transfers, ratings with a revocation, a fleet
 * of one wallet, and a hidden entry that must add nothing. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_apicheck_test";
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
const WALLET = "0x14791697260e4c9a71f18484c9f997b308e59325";
const OTHER = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const SOL_ASSET = "7Yw6u4v9kQ3pZ2r8s5t1x6c4b3n2m1k9j8h7g6f5d4e3";
const SOL_OWNER = "5Gh8j2k4m6n9p3q5r7s9t2v4w6x8y3z5a7b9c2d4e6f8";
const BLOCKS_PER_DAY = 864_000;
const txHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

describe.skipIf(!dbReachable)("the pre-flight check against a real database", { timeout: 120_000 }, () => {
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let server: Server;
  let base = "";
  let keys: typeof import("./apiKeys");
  let proKey = "";
  let freeKey = "";

  const post = (payload: unknown, key: string | null = proKey) =>
    fetch(`${base}/api/v1/check`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(payload) });
  const answer = async (payload: unknown) => {
    const response = await post(payload);
    expect(response.status, JSON.stringify(payload)).toBe(200);
    return (await response.json()) as Record<string, any>;
  };

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    const baseline = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baseline.query(statement);
    }
    await baseline.end();
    await applyPendingMigrations(process.env.DATABASE_URL);
    // The key tables are a manual migration: run the file as the owner would paste it.
    const paste = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0043_api_keys.sql", "utf8"))) await paste.query(statement);
    await paste.end();
    keys = await import("./apiKeys");
    writer = drizzle(createPool(process.env.DATABASE_URL));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "apicheck-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "apicheck-operator"));
    const source = (id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"]) =>
      writer.insert(schema.ingestionSources).values({ id, sourceKey: `check-${id}`, label: id, protocol, rootUrl: "https://check.example/feed", allowedHostname: "check.example", state: "active", createdByUserId: operator!.id });
    await source("src-rh", "erc8004");
    await source("src-bnb", "erc8004_bsc");
    await source("src-8004", "solana_8004");
    await source("src-rep", "erc8004_reputation");

    const entry = (id: string, sourceId: string, protocol: (typeof schema.agentDirectoryEntries.$inferInsert)["protocol"], externalKey: string, extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}) =>
      writer.insert(schema.agentDirectoryEntries).values({ id, sourceId, externalKey, displayName: id, protocol, registrant: WALLET, locatorHost: "alice.example", sourceSignalNote: "Seeded.", ...extra });
    const key = (token: number) => `eip155:4663:${REGISTRY}:${token}`;
    const now = Date.now();
    // Agent 7: minted at block 100, handed out at 101, changed hands at 500 and 900. The wallet registered two more (a fleet of three).
    // First seen five and a half days ago: MySQL rounds a timestamp to the second, so exactly five days could read as four.
    await entry("rh-7", "src-rh", "erc8004", key(7), { mintBlock: 100, secondaryTransferCount: 3, handoutCount: 1, uriUpdateCount: 0, firstSeenAt: new Date(now - 5.5 * 86_400_000) });
    await entry("rh-8", "src-rh", "erc8004", key(8), { mintBlock: 110, secondaryTransferCount: 0, handoutCount: 0, uriUpdateCount: 0, firstSeenAt: new Date(now - 90 * 86_400_000), lastSeenAt: new Date(now - 3_000) });
    await entry("rh-9", "src-rh", "erc8004", key(9), { mintBlock: 120, secondaryTransferCount: 0, handoutCount: 0, uriUpdateCount: 0, firstSeenAt: new Date(now - 90 * 86_400_000), lastSeenAt: new Date(now - 4_000) });
    await entry("rh-hidden", "src-rh", "erc8004", key(10), { hidden: true, mintBlock: 130, secondaryTransferCount: 5, handoutCount: 0, uriUpdateCount: 0 });
    await entry("rh-other", "src-rh", "erc8004", key(11), { registrant: OTHER, locatorHost: "other.example", mintBlock: 140, secondaryTransferCount: 0, handoutCount: 0, uriUpdateCount: 0 });
    await entry("bnb-9", "src-bnb", "erc8004_bsc", `eip155:56:${REGISTRY}:9`, { registrant: OTHER, locatorHost: "bnb.example" });
    await entry("sol-1", "src-8004", "solana_8004", SOL_ASSET, { registrant: SOL_OWNER, locatorHost: null, firstSeenAt: new Date(now - 60 * 86_400_000) });

    const event = (n: number, externalKey: string, kind: "mint" | "secondary" | "uri_update", blockNumber: number, from: string | null, to: string | null) =>
      writer.insert(schema.agentDirectoryChainActivity).values({ id: `ev-${n}`, sourceId: "src-rh", transactionHash: txHash(n), logIndex: n, kind, blockNumber, externalKey, fromAddress: from, toAddress: to });
    const zero = "0x0000000000000000000000000000000000000000";
    await event(1, key(7), "mint", 100, zero, WALLET);
    await event(2, key(7), "secondary", 101, WALLET, OTHER);
    // After the hand-out the agent changes hands twice, neither time from the minting wallet.
    await event(3, key(7), "secondary", 500, OTHER, "0x00000000000000000000000000000000000000b1");
    await event(4, key(7), "secondary", 900, "0x00000000000000000000000000000000000000b1", "0x00000000000000000000000000000000000000b2");
    // Another agent's event sets where the identity ledger stands: two block days past agent 7's latest change.
    await event(5, key(8), "mint", 900 + 2 * BLOCKS_PER_DAY, zero, WALLET);

    // Ratings for agent 7: four, one revoked.
    const rating = (n: number, kind: "new_feedback" | "feedback_revoked", client: string, block: number) =>
      writer.insert(schema.agentReputationEvents).values({ id: `rep-${n}`, sourceId: "src-rep", transactionHash: txHash(1000 + n), logIndex: n, kind, blockNumber: block, agentId: 7, clientAddress: client, feedbackIndex: 1, ...(kind === "new_feedback" ? { valueRaw: "90", valueDecimals: 0 } : {}) });
    for (const [n, client] of [OTHER, WALLET, "0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2"].entries()) await rating(n + 1, "new_feedback", client, 600 + n);
    await rating(9, "feedback_revoked", OTHER, 700);

    // Two transfers recorded for the Solana agent.
    for (const [n, recorded] of [new Date("2026-10-10T08:00:00Z"), new Date("2026-10-14T09:30:00Z")].entries()) {
      await writer.insert(schema.agentSolanaActivity).values({ id: `sa-${n}`, sourceId: "src-8004", transactionSignature: `sig${n}`.padEnd(88, "x"), slot: 300 + n, externalKey: SOL_ASSET, kind: "transfer", fromOwner: SOL_OWNER, toOwner: OTHER, createdAt: recorded });
    }

    const free = await keys.createApiKey({ email: "free@example.com", clientKey: "203.0.113.1" });
    freeKey = free.key;
    const pro = await keys.createApiKey({ email: "pro@example.com", clientKey: "203.0.113.2" });
    await keys.setKeyTier(pro.id, "pro");
    proKey = pro.key;

    const { registerApiV1 } = await import("./apiV1");
    const app = express();
    registerApiV1(app);
    await new Promise<void>(done => {
      server = app.listen(0, "127.0.0.1", () => done());
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    keys?.apiMeter.stop();
    await new Promise<void>(done => (server ? server.close(() => done()) : done()));
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("opens the check to a Pro key alone, from the real key tables, and refuses a free key and a missing one", async () => {
    expect((await post({ agent: { chain: "robinhood", id: "7" } }, null)).status).toBe(401);
    const refused = await post({ agent: { chain: "robinhood", id: "7" } }, freeKey);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string; required_tier: string } }).error).toMatchObject({ code: "tier_required", required_tier: "pro" });
    expect((await post({ agent: { chain: "robinhood", id: "7" } }, proKey)).status).toBe(200);
  });

  it("reads an EVM agent's ledgers: the changes of hands apart from the hand-out, the latest block and its distance from the ledger's head, the ratings and the fleet", async () => {
    const body = await answer({ agent: { chain: "robinhood", id: "7" } });
    expect(problems(schemaOf("CheckResponse"), body)).toEqual([]);
    const [result] = body.data.results;
    expect(result.flags.ownership_changes).toMatchObject({
      present: true,
      changes_recorded: 2,
      handouts_recorded: 1,
      latest_change_block: 900,
      ledger_through_block: 900 + 2 * BLOCKS_PER_DAY,
      blocks_since_latest_change: 2 * BLOCKS_PER_DAY,
      block_days_since_latest_change: 2,
    });
    expect(result.flags.revoked_feedback).toMatchObject({ present: true, rating_count: 4, revoked_count: 1, revoked_share: 0.25 });
    // The wallet registered 7, 8 and 9 (the hidden entry is not counted).
    expect(result.flags.fleet).toMatchObject({ present: true, listed_by_same_wallet: 3, same_host_others: 2 });
    expect(result.flags.first_seen).toMatchObject({ present: true, days_since_first_seen: 5, threshold_days: 30 });
    expect(result.sources.activity_through_block).toBe(900 + 2 * BLOCKS_PER_DAY);
    expect(result.sources.registry).toMatchObject({ kind: "registry", chain: "robinhood", key: `eip155:4663:${REGISTRY}:7` });
  });

  it("reads a Solana agent's recorded transfers and dates the latest by when Nooscape recorded it", async () => {
    const body = await answer({ agent: { chain: "solana", id: SOL_ASSET } });
    expect(problems(schemaOf("CheckResponse"), body)).toEqual([]);
    const [result] = body.data.results;
    expect(result.agent).toMatchObject({ chain: "solana", registry: "solana_8004" });
    expect(result.flags.ownership_changes).toMatchObject({ present: true, changes_recorded: 2, latest_change_block: null, latest_change_recorded_at: "2026-10-14T09:30:00.000Z" });
    expect(result.flags.revoked_feedback.present).toBeNull();
    expect(result.flags.first_seen).toMatchObject({ present: false });
  });

  it("says not measured, not none, for a BNB agent whose activity ledger has not covered it, and for ratings it does not read", async () => {
    const body = await answer({ agent: { chain: "bnb", id: "9" } });
    expect(problems(schemaOf("CheckResponse"), body)).toEqual([]);
    const [result] = body.data.results;
    expect(result.flags.revoked_feedback.present).toBeNull();
    expect(result.agent.registry).toBe("erc8004_bsc");
  });

  it("answers for a wallet's listings newest first, narrows to a chain, and leaves out a hidden entry", async () => {
    const body = await answer({ wallet: WALLET, chain: "robinhood" });
    expect(problems(schemaOf("CheckResponse"), body)).toEqual([]);
    const ids = body.data.results.map((result: { agent: { nooscape_id: string } }) => result.agent.nooscape_id);
    expect(ids).toEqual(expect.arrayContaining(["rh-7", "rh-8", "rh-9"]));
    expect(ids).not.toContain("rh-hidden");
    expect(ids).not.toContain("rh-other");
    expect(body.data.matched_total).toBe(ids.length);
    const solana = await answer({ wallet: SOL_OWNER });
    expect(solana.data.results.map((result: { agent: { nooscape_id: string } }) => result.agent.nooscape_id)).toEqual(["sol-1"]);
  });

  it("answers for an endpoint URL by its host alone", async () => {
    const body = await answer({ url: "https://Alice.Example:8443/v1/agent?x=1" });
    expect(body.data.subject.host).toBe("alice.example");
    const ids = body.data.results.map((result: { agent: { nooscape_id: string } }) => result.agent.nooscape_id);
    expect(ids).toEqual(expect.arrayContaining(["rh-7", "rh-8", "rh-9"]));
    expect(ids).not.toContain("rh-hidden");
    expect((await answer({ url: "https://nobody.example/" })).data.results).toEqual([]);
  });

  it("serves nothing for a hidden entry, answering as for one never listed", async () => {
    const hidden = await post({ agent: { chain: "robinhood", id: "10" } });
    const missing = await post({ agent: { chain: "robinhood", id: "99999" } });
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    expect((await post({ agent: { chain: "robinhood", id: "7" }, tier: "pro" })).status).toBe(400);
  });

  it("counts a check once against the key, as the check, and writes it to the table", async () => {
    await keys.apiMeter.flush();
    const report = await keys.readKeyUsage({ id: (await keys.resolveApiKey(proKey))!.id, tier: "pro", prefix: proKey.slice(0, 10) }, 1);
    expect(report.days[0]?.endpoints.check).toBeGreaterThan(0);
  });
});
