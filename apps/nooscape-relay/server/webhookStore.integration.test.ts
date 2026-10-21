import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { API_CHAINS } from "./apiChains";

/**
 * Watchlists and webhooks against a real database (docs/data-access-2026-10-19.md, stage D5): the four tables are a manual migration, so the
 * pass is first off, and then runs on the file as the owner would paste it, twice. The guards are the database's: one event is one row for a
 * key however often it is found, a delivery is taken by one run only, a webhook is turned off once, and the ledgers are read the way the
 * public reads them. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_webhooks_test";
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

const WALLET = "0x14791697260e4c9a71f18484c9f997b308e59325";
const OTHER = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const RH_KEY = (id: number) => `eip155:4663:${API_CHAINS.robinhood.registry}:${id}`;
const ARC_KEY = (id: number) => API_CHAINS.arc.keyOf(String(id));
const BNB_KEY = (id: number) => API_CHAINS.bnb.keyOf(String(id));
const SOL_ASSET = "7Yw6u4v9kQ3pZ2r8s5t1x6c4b3n2m1k9j8h7g6f5d4e3";
const SIGNING_KEY = "k".repeat(40);
const HOUR = 3_600_000;
const ALL = { keys: 1_000, perKey: 1_000 };

describe.skipIf(!dbReachable)("webhooks against a real database", { timeout: 120_000 }, () => {
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let store: typeof import("./webhookStore").dbWebhookStore;
  let forgetReady: () => void;
  let source: typeof import("./webhookEvents").dbEventSource;
  let pass: typeof import("./webhookPass");
  let splitMigrationStatements: typeof import("./dbMigrations").splitMigrationStatements;
  let operatorUserId: number;

  const raw = async (text: string) => (await writer.execute(sql.raw(text)))[0] as unknown as Array<Record<string, unknown>>;
  const pasteMigration = async () => {
    const paste = await createConnection(process.env.DATABASE_URL!);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0045_api_webhooks.sql", "utf8"))) await paste.query(statement);
    await paste.end();
    forgetReady();
  };
  const key = async (id: string, tier: string, revoked = false) => {
    await writer.insert(schema.apiKeys).values({ id, keyHash: id.padEnd(64, "0"), keyPrefix: `nsk_${id.slice(-6)}`, ownerEmail: `${id}@example.com`, tier, revokedAt: revoked ? new Date() : null });
  };
  async function sourceRow(id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"], state: "active" | "paused" = "active") {
    await writer.insert(schema.ingestionSources).values({ id, sourceKey: `wh-${id}`, label: id, protocol, rootUrl: "https://wh.example/feed", allowedHostname: "wh.example", state, createdByUserId: operatorUserId });
  }
  async function entry(id: string, sourceId: string, protocol: (typeof schema.agentDirectoryEntries.$inferInsert)["protocol"], externalKey: string, extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}) {
    await writer.insert(schema.agentDirectoryEntries).values({ id, sourceId, externalKey, displayName: id, protocol, registrant: WALLET, locatorHost: "alice.example", sourceSignalNote: "Seeded.", ...extra });
  }

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const migrations = await import("./dbMigrations");
    splitMigrationStatements = migrations.splitMigrationStatements;
    const baseline = await createConnection(process.env.DATABASE_URL);
    for (const file of (await migrations.collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baseline.query(statement);
    }
    await baseline.end();
    await migrations.applyPendingMigrations(process.env.DATABASE_URL);
    // The claim and key tables are manual migrations too, and the pass reads both.
    const paste = await createConnection(process.env.DATABASE_URL);
    for (const file of ["0042_agent_claims.sql", "0043_api_keys.sql", "0046_multichain_erc8004_protocols.sql"]) for (const statement of splitMigrationStatements(await readFile(`drizzle/${file}`, "utf8"))) await paste.query(statement);
    await paste.end();
    const storeModule = await import("./webhookStore");
    store = storeModule.dbWebhookStore;
    forgetReady = storeModule.forgetWebhooksReady;
    source = (await import("./webhookEvents")).dbEventSource;
    pass = await import("./webhookPass");
    writer = drizzle(createPool(process.env.DATABASE_URL));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "wh-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "wh-operator"));
    operatorUserId = operator!.id;
    await sourceRow("src-rh", "erc8004");
    await sourceRow("src-sol", "solana_8004");
    await sourceRow("src-paused", "erc8004", "paused");
    await sourceRow("src-bnb", "erc8004_bsc");
    await sourceRow("src-arc", "erc8004_arc");
    for (const [id, tier, revoked] of [["key-b", "builder", false], ["key-p", "pro", false], ["key-f", "free", false], ["key-r", "builder", true], ["key-d", "builder", false], ["key-x", "builder", false]] as const) await key(id, tier, revoked);
  });

  afterAll(async () => {
    await closePool?.();
  });

  it("is off until the migration is pasted, and a second paste changes nothing", async () => {
    expect(await store.ready()).toBe(false);
    expect(await pass.runWebhookPass({ signingKey: SIGNING_KEY })).toMatchObject({ status: "off", reason: expect.stringContaining("migration 0045") });
    await pasteMigration();
    expect(await store.ready()).toBe(true);
    await pasteMigration();
    expect(await store.ready()).toBe(true);
    const tables = await raw("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'api\\_%' ORDER BY table_name");
    expect(tables.map(row => row.name)).toEqual(expect.arrayContaining(["api_deliveries", "api_event_cursors", "api_watches", "api_webhooks"]));
  });

  it("keeps one watch for a key and a listing, in the order they were added, and counts them", async () => {
    expect(await store.addWatches("key-b", ["e1", "e2", "e3"])).toBe(3);
    expect(await store.addWatches("key-b", ["e2", "e4"])).toBe(1);
    expect(await store.addWatches("key-b", [])).toBe(0);
    expect(await store.countWatches("key-b")).toBe(4);
    expect(await store.countWatches("key-p")).toBe(0);
    expect((await store.listWatches("key-b")).map(watch => watch.entryId).sort()).toEqual(["e1", "e2", "e3", "e4"]);
    expect(await store.removeWatch("key-b", "e4")).toBe(true);
    expect(await store.removeWatch("key-b", "e4")).toBe(false);
    await store.setVisible("key-b", "e1", false);
    expect((await store.listWatches("key-b")).find(watch => watch.entryId === "e1")!.visible).toBe(false);
  });

  it("keeps one webhook for a key: a new one starts at version 1, setting it again keeps the version and clears the failures", async () => {
    const made = await store.setWebhook("key-b", "https://hooks.example.com/b");
    expect(made).toMatchObject({ keyId: "key-b", url: "https://hooks.example.com/b", secretVersion: 1, failures: 0, disabledAt: null });
    expect((await store.rotateSecret("key-b"))!.secretVersion).toBe(2);
    expect(await store.rotateSecret("nobody")).toBeNull();
    await store.recordResult("key-b", false, 3);
    await store.recordResult("key-b", false, 3);
    expect((await store.getWebhook("key-b"))).toMatchObject({ failures: 2, disabledAt: null });
    const again = await store.setWebhook("key-b", "https://hooks.example.com/b2");
    expect(again).toMatchObject({ url: "https://hooks.example.com/b2", secretVersion: 2, failures: 0, disabledAt: null });
    expect(await store.getWebhook("nobody")).toBeNull();
  });

  it("turns a webhook off at the limit, once, and a success clears the count", async () => {
    await store.setWebhook("key-d", "https://hooks.example.com/d");
    await store.recordResult("key-d", false, 3);
    await store.recordResult("key-d", false, 3);
    expect((await store.getWebhook("key-d"))!.disabledAt).toBeNull();
    await store.recordResult("key-d", true, 3);
    expect((await store.getWebhook("key-d"))!.failures).toBe(0);
    for (let index = 0; index < 3; index += 1) await store.recordResult("key-d", false, 3);
    const off = (await store.getWebhook("key-d"))!;
    expect(off.failures).toBe(3);
    expect(off.disabledAt).not.toBeNull();
    await raw("UPDATE api_webhooks SET disabledAt = '2026-01-01 00:00:00' WHERE keyId = 'key-d'");
    await store.recordResult("key-d", false, 3);
    expect((await store.getWebhook("key-d"))!.disabledAt!.getUTCFullYear()).toBe(2026);
    expect((await raw("SELECT disabledAt FROM api_webhooks WHERE keyId = 'key-d'"))[0]!.disabledAt).not.toBeNull();
    // Removing a webhook erases its address and turns it off, and keeps the row so that the secret's version is kept.
    await store.rotateSecret("key-d");
    expect(await store.deleteWebhook("key-d")).toBe(true);
    expect(await store.deleteWebhook("key-d")).toBe(false);
    expect(await store.getWebhook("key-d")).toBeNull();
    expect(await store.rotateSecret("key-d")).toBeNull();
    expect((await raw("SELECT url, secretVersion, failures, disabledAt FROM api_webhooks WHERE keyId = 'key-d'"))[0]).toMatchObject({ url: "", secretVersion: 2, failures: 0 });
    expect((await raw("SELECT disabledAt FROM api_webhooks WHERE keyId = 'key-d'"))[0]!.disabledAt).not.toBeNull();
    const back = await store.setWebhook("key-d", "https://hooks.example.com/d2");
    expect(back).toMatchObject({ url: "https://hooks.example.com/d2", secretVersion: 2, failures: 0, disabledAt: null });
  });

  it("counts a watch as live only for a Builder or Pro key that has not ended and has a webhook that is not off", async () => {
    await store.setWebhook("key-p", "https://hooks.example.com/p");
    await store.setWebhook("key-f", "https://hooks.example.com/f");
    await store.setWebhook("key-r", "https://hooks.example.com/r");
    await store.addWatches("key-p", ["e1"]);
    await store.addWatches("key-f", ["e1"]);
    await store.addWatches("key-r", ["e1"]);
    await store.addWatches("key-x", ["e1"]);
    const live = await store.liveWatches();
    expect(live.map(watch => `${watch.keyId}:${watch.entryId}`).sort()).toEqual(["key-b:e1", "key-b:e2", "key-b:e3", "key-p:e1"]);
    expect(live.find(watch => watch.keyId === "key-b" && watch.entryId === "e1")).toMatchObject({ visible: false, createdAt: expect.any(Date) });
    await raw("UPDATE api_webhooks SET disabledAt = NOW() WHERE keyId = 'key-p'");
    expect((await store.liveWatches()).some(watch => watch.keyId === "key-p")).toBe(false);
    await raw("UPDATE api_webhooks SET disabledAt = NULL WHERE keyId = 'key-p'");
  });

  describe("deliveries", () => {
    const row = (id: string, keyId: string, eventRef: string) => ({ id, keyId, eventRef, kind: "claim.changed", entryId: "e1", body: "{}" });

    it("is one row for a key and an event however often it is found, in the order written", async () => {
      expect(await store.insertDeliveries([row("d1", "key-b", "claim:1"), row("d2", "key-b", "claim:2"), row("d3", "key-p", "claim:1")])).toBe(3);
      expect(await store.insertDeliveries([row("d4", "key-b", "claim:1"), row("d5", "key-b", "claim:3")])).toBe(1);
      expect(await store.insertDeliveries([])).toBe(0);
      const all = await raw("SELECT id, seq FROM api_deliveries ORDER BY seq");
      expect(all.map(item => item.id)).toEqual(["d1", "d2", "d3", "d5"]);
      expect(await raw("SELECT COUNT(*) AS n FROM api_deliveries WHERE keyId = 'key-b' AND eventRef = 'claim:1'")).toEqual([{ n: 1 }]);
    });

    it("is due when pending and its time has come, for a live webhook only, oldest first", async () => {
      await store.insertDeliveries([row("d6", "key-r", "claim:1"), row("d7", "key-f", "claim:1")]);
      const due = await store.due(new Date(), ALL);
      expect(due.map(item => item.id)).toEqual(["d1", "d2", "d3", "d5"]);
      expect(due[0]).toMatchObject({ status: "pending", attempts: 0, lastStatus: null, body: "{}" });
      expect((await store.due(new Date(), { keys: 1, perKey: 2 })).map(item => item.id)).toEqual(["d1", "d2"]);
      expect(await store.due(new Date(Date.now() - 24 * HOUR), ALL)).toEqual([]);
    });

    it("takes at most a few of each key's due deliveries, for the keys whose oldest is oldest, so one long queue cannot fill a run", async () => {
      expect((await store.due(new Date(), { keys: 1, perKey: 1 })).map(item => item.id)).toEqual(["d1"]);
      expect((await store.due(new Date(), { keys: 2, perKey: 1 })).map(item => item.id)).toEqual(["d1", "d3"]);
      expect((await store.due(new Date(), { keys: 2, perKey: 5 })).map(item => item.id)).toEqual(["d1", "d2", "d3", "d5"]);
      expect((await store.due(new Date(), { keys: 1, perKey: 5 })).map(item => item.id)).toEqual(["d1", "d2", "d5"]);
    });

    it("is taken by one run: of five that ask at once, one is given it", async () => {
      const [first] = await store.due(new Date(), { keys: 1, perKey: 1 });
      const results = await Promise.all(Array.from({ length: 5 }, () => store.lease(first!.id, first!.nextAttemptAt, new Date(Date.now() + 120_000))));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await store.due(new Date(), ALL)).map(item => item.id)).not.toContain(first!.id);
      // A lease on what has changed since it was read is refused.
      expect(await store.lease(first!.id, first!.nextAttemptAt, new Date())).toBe(false);
    });

    it("records a success once, a failure with its next try, and a give-up", async () => {
      await store.markSent("d1", 204, new Date());
      await store.markSent("d1", 500, new Date());
      expect((await raw("SELECT status, attempts, lastStatus, sentAt FROM api_deliveries WHERE id = 'd1'"))[0]).toMatchObject({ status: "sent", attempts: 1, lastStatus: 204 });
      const next = new Date(Date.now() + HOUR);
      await store.markFailed("d2", { attempts: 1, next, status: 500, error: "http_500" });
      expect((await raw("SELECT status, attempts, lastStatus, lastError FROM api_deliveries WHERE id = 'd2'"))[0]).toMatchObject({ status: "pending", attempts: 1, lastStatus: 500, lastError: "http_500" });
      expect((await store.due(new Date(), ALL)).map(item => item.id)).not.toContain("d2");
      expect((await store.due(new Date(Date.now() + 2 * HOUR), ALL)).map(item => item.id)).toContain("d2");
      await store.markFailed("d3", { attempts: 6, next: null, status: null, error: "x".repeat(60) });
      expect((await raw("SELECT status, attempts, lastStatus, lastError FROM api_deliveries WHERE id = 'd3'"))[0]).toMatchObject({ status: "dead", attempts: 6, lastStatus: null, lastError: "x".repeat(40) });
      // A delivery that is no longer pending is not changed by a late result.
      await store.markFailed("d3", { attempts: 1, next, status: 500, error: "late" });
      expect((await raw("SELECT status FROM api_deliveries WHERE id = 'd3'"))[0]).toMatchObject({ status: "dead" });
    });

    it("lists a key's own, newest first, at most 50", async () => {
      expect((await store.recent("key-b", 10)).map(item => item.id)).toEqual(["d5", "d2", "d1"]);
      expect(await store.recent("key-b", 0)).toHaveLength(1);
      expect(await store.recent("nobody", 10)).toEqual([]);
    });

    it("clears out what is older than the date, giving up what was still waiting", async () => {
      await raw("UPDATE api_deliveries SET createdAt = DATE_SUB(NOW(), INTERVAL 40 DAY) WHERE id IN ('d1', 'd6')");
      expect(await store.purge(new Date(Date.now() - 30 * 24 * HOUR))).toBe(2);
      expect((await raw("SELECT id FROM api_deliveries ORDER BY seq")).map(item => item.id)).toEqual(["d2", "d3", "d5", "d7"]);
      expect((await raw("SELECT status, lastError FROM api_deliveries WHERE id = 'd2'"))[0]).toMatchObject({ status: "pending" });
      await raw("UPDATE api_deliveries SET createdAt = DATE_SUB(NOW(), INTERVAL 40 DAY) WHERE id = 'd2'");
      await store.purge(new Date(Date.now() - 30 * 24 * HOUR));
      expect(await raw("SELECT id FROM api_deliveries WHERE id = 'd2'")).toEqual([]);
    });
  });

  it("keeps a position for each pass, and moves it", async () => {
    expect(await store.getCursor("claims")).toBeNull();
    await store.setCursor("claims", "5");
    await store.setCursor("claims", "9");
    expect(await store.getCursor("claims")).toBe("9");
    await raw("DELETE FROM api_event_cursors");
  });

  describe("the ledgers it reads", () => {
    let t0: Date;
    let SINCE: Date;
    beforeAll(async () => {
      t0 = new Date();
      SINCE = new Date(t0.getTime() - 24 * HOUR);
      await entry("rh-42", "src-rh", "erc8004", RH_KEY(42));
      await entry("rh-43", "src-rh", "erc8004", RH_KEY(43));
      await entry("rh-hidden", "src-rh", "erc8004", RH_KEY(44), { hidden: true });
      await entry("rh-paused", "src-paused", "erc8004", RH_KEY(45));
      await entry("rh-closed", "src-rh", "erc8004", RH_KEY(46), { assetClosedAt: new Date() });
      await entry("sol-1", "src-sol", "solana_8004", SOL_ASSET);
      await entry("bnb-9", "src-bnb", "erc8004_bsc", `eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:9`);
      const base = { sourceId: "src-rh" };
      const old = new Date(t0.getTime() - 3 * HOUR);
      await writer.insert(schema.agentDirectoryChainActivity).values([
        { id: "act-mint", ...base, transactionHash: "0xmint", logIndex: 0, kind: "mint", blockNumber: 1_000, externalKey: RH_KEY(42), fromAddress: null, toAddress: WALLET, createdAt: old },
        { id: "act-hand", ...base, transactionHash: "0xhand", logIndex: 0, kind: "secondary", blockNumber: 1_500, externalKey: RH_KEY(42), fromAddress: WALLET, toAddress: OTHER },
        { id: "act-sale", ...base, transactionHash: "0xsale", logIndex: 0, kind: "secondary", blockNumber: 900_000, externalKey: RH_KEY(42), fromAddress: OTHER, toAddress: WALLET },
        { id: "act-old", ...base, transactionHash: "0xold", logIndex: 0, kind: "secondary", blockNumber: 800_000, externalKey: RH_KEY(42), fromAddress: OTHER, toAddress: WALLET, createdAt: old },
        { id: "act-uri", ...base, transactionHash: "0xuri", logIndex: 0, kind: "uri_update", blockNumber: 900_001, externalKey: RH_KEY(42), fromAddress: null, toAddress: null },
        { id: "act-other", ...base, transactionHash: "0xother", logIndex: 0, kind: "secondary", blockNumber: 900_002, externalKey: RH_KEY(43), fromAddress: OTHER, toAddress: WALLET },
      ]);
      await writer.insert(schema.agentSolanaActivity).values([
        { id: "sa-reg", sourceId: "src-sol", transactionSignature: "sigREG", slot: 1, externalKey: SOL_ASSET, kind: "register", fromOwner: null, toOwner: WALLET },
        { id: "sa-xfer", sourceId: "src-sol", transactionSignature: "sigXFER", slot: 2, externalKey: SOL_ASSET, kind: "transfer", fromOwner: WALLET, toOwner: OTHER },
        { id: "sa-prof", sourceId: "src-sol", transactionSignature: "sigPROF", slot: 3, externalKey: SOL_ASSET, kind: "profile_update", fromOwner: null, toOwner: null },
      ]);
      const rating = (id: string, sourceId: string, kind: "new_feedback" | "feedback_revoked" | "response_appended", agentId: number, hash: string) => ({ id, sourceId, transactionHash: hash, logIndex: 0, kind, blockNumber: 500, agentId, clientAddress: OTHER, feedbackIndex: 1 });
      await writer.insert(schema.agentReputationEvents).values([
        rating("rep-new", "src-rh", "new_feedback", 42, "0xnew"),
        rating("rep-rev", "src-rh", "feedback_revoked", 42, "0xrev"),
        rating("rep-resp", "src-rh", "response_appended", 42, "0xresp"),
        rating("rep-other-agent", "src-rh", "new_feedback", 43, "0xother43"),
        rating("rep-other-source", "src-paused", "new_feedback", 42, "0xothersource"),
        { ...rating("rep-bnb", "src-bnb", "new_feedback", 9, "0xbnb") },
      ]);
      for (const [index, kind] of ["claim", "edit", "freeze"].entries()) {
        await writer.insert(schema.agentClaimEdits).values({ id: `edit-${index}`, claimId: "claim-1", entryId: "rh-42", kind, field: kind === "edit" ? "website" : null, oldValue: "https://old.example", newValue: "https://new.example", wallet: WALLET, reason: null });
      }
      await writer.insert(schema.agentClaimEdits).values({ id: "edit-other", claimId: "claim-2", entryId: "rh-43", kind: "edit", field: "name", oldValue: "a", newValue: "b", wallet: WALLET, reason: null });
    });

    it("says which listings are in the public view, by the rule every public read uses", async () => {
      const found = await source.entries(["rh-42", "rh-hidden", "rh-paused", "rh-closed", "sol-1", "nobody"]);
      expect(Object.fromEntries(found.map(item => [item.id, item.visible]))).toEqual({ "rh-42": true, "rh-hidden": false, "rh-paused": false, "rh-closed": false, "sol-1": true });
      expect(found.find(item => item.id === "sol-1")).toMatchObject({ protocol: "solana_8004", sourceId: "src-sol", externalKey: SOL_ASSET });
      expect(await source.entries([])).toEqual([]);
    });

    it("reads the claim history forward by sequence, for the listings asked about, and carries no owner text", async () => {
      const all = await source.claimEdits(0, ["rh-42", "rh-43"], SINCE);
      expect(all.full).toBe(false);
      expect(all.rows.map(item => item.kind)).toEqual(["claim", "edit", "freeze", "edit"]);
      expect(all.rows.map(item => item.seq)).toEqual([...all.rows.map(item => item.seq)].sort((a, b) => a - b));
      expect(all.rows.every(item => typeof item.seq === "number")).toBe(true);
      expect(JSON.stringify(all.rows)).not.toContain("old.example");
      expect(JSON.stringify(all.rows)).not.toContain("new.example");
      const second = all.rows[1]!;
      expect((await source.claimEdits(second.seq, ["rh-42", "rh-43"], SINCE)).rows.map(item => item.kind)).toEqual(["freeze", "edit"]);
      expect((await source.claimEdits(0, ["rh-43"], SINCE)).rows.map(item => item.entryId)).toEqual(["rh-43"]);
      expect((await source.claimEdits(0, [], SINCE)).rows).toEqual([]);
      expect(await source.maxClaimSeq()).toBe(Math.max(...all.rows.map(item => item.seq)));
      // Rows older than the date are not read, so a re-read by sequence cannot reach what has been tidied away.
      await raw("UPDATE agent_claim_edits SET occurredAt = DATE_SUB(NOW(), INTERVAL 40 DAY) WHERE id = 'edit-0'");
      expect((await source.claimEdits(0, ["rh-42", "rh-43"], SINCE)).rows.map(item => item.kind)).toEqual(["edit", "freeze", "edit"]);
      expect((await source.claimEdits(0, ["rh-42", "rh-43"], new Date(t0.getTime() - 60 * 24 * HOUR))).rows).toHaveLength(4);
      await raw("UPDATE agent_claim_edits SET occurredAt = NOW() WHERE id = 'edit-0'");
    });

    it("reads ownership changes since a time: secondary transfers on the EVM ledger with the hand-out rule, and transfers on Solana", async () => {
      const entries = await source.entries(["rh-42", "rh-43", "sol-1"]);
      const found = await source.transfers(new Date(t0.getTime() - 5 * 60_000), entries);
      expect(found.full).toBe(false);
      const byRef = Object.fromEntries(found.rows.map(item => [item.ref, item]));
      expect(Object.keys(byRef).sort()).toEqual(["own:act-hand", "own:act-other", "own:act-sale", "own:sa-xfer"]);
      expect(byRef["own:act-hand"]).toMatchObject({ entryId: "rh-42", from: WALLET, to: OTHER, blockNumber: 1_500, transactionRef: "0xhand", isHandout: true });
      expect(byRef["own:act-sale"]).toMatchObject({ entryId: "rh-42", from: OTHER, to: WALLET, blockNumber: 900_000, isHandout: false });
      expect(byRef["own:act-other"]).toMatchObject({ entryId: "rh-43", isHandout: false });
      expect(byRef["own:sa-xfer"]).toMatchObject({ entryId: "sol-1", from: WALLET, to: OTHER, blockNumber: null, transactionRef: "sigXFER", isHandout: false });
      const wider = await source.transfers(new Date(t0.getTime() - 5 * HOUR), entries);
      expect(wider.rows.map(item => item.ref)).toContain("own:act-old");
      expect((await source.transfers(new Date(t0.getTime() + HOUR), entries)).rows).toEqual([]);
      expect((await source.transfers(new Date(t0.getTime() - 5 * HOUR), (await source.entries(["rh-43"])))).rows.map(item => item.entryId)).toEqual(["rh-43"]);
    });

    it("judges a hand-out by the chain's own mint hour: Arc's 7,080 blocks and BNB Chain's 8,000, and Robinhood Chain's 36,000 by default", async () => {
      await entry("arc-13", "src-arc", "erc8004_arc", ARC_KEY(13));
      await entry("rh-47", "src-rh", "erc8004", RH_KEY(47));
      const arcBase = { sourceId: "src-arc", externalKey: ARC_KEY(13) };
      const bnbBase = { sourceId: "src-bnb", externalKey: BNB_KEY(9) };
      const rhBase = { sourceId: "src-rh", externalKey: RH_KEY(47) };
      await writer.insert(schema.agentDirectoryChainActivity).values([
        { id: "arc-mint", ...arcBase, transactionHash: "0xarcmint", logIndex: 0, kind: "mint", blockNumber: 10_000, fromAddress: null, toAddress: WALLET, createdAt: new Date(t0.getTime() - 3 * HOUR) },
        { id: "arc-near", ...arcBase, transactionHash: "0xarcnear", logIndex: 0, kind: "secondary", blockNumber: 10_500, fromAddress: WALLET, toAddress: OTHER },
        { id: "arc-far", ...arcBase, transactionHash: "0xarcfar", logIndex: 0, kind: "secondary", blockNumber: 20_000, fromAddress: WALLET, toAddress: OTHER },
        { id: "bnb-mint", ...bnbBase, transactionHash: "0xbnbmint", logIndex: 0, kind: "mint", blockNumber: 10_000, fromAddress: null, toAddress: WALLET, createdAt: new Date(t0.getTime() - 3 * HOUR) },
        { id: "bnb-near", ...bnbBase, transactionHash: "0xbnbnear", logIndex: 0, kind: "secondary", blockNumber: 15_000, fromAddress: WALLET, toAddress: OTHER },
        { id: "bnb-far", ...bnbBase, transactionHash: "0xbnbfar", logIndex: 0, kind: "secondary", blockNumber: 30_000, fromAddress: WALLET, toAddress: OTHER },
        { id: "rh-mint-47", ...rhBase, transactionHash: "0xrhmint47", logIndex: 0, kind: "mint", blockNumber: 10_000, fromAddress: null, toAddress: WALLET, createdAt: new Date(t0.getTime() - 3 * HOUR) },
        { id: "rh-far-47", ...rhBase, transactionHash: "0xrhfar47", logIndex: 0, kind: "secondary", blockNumber: 30_000, fromAddress: WALLET, toAddress: OTHER },
        { id: "rh-late-47", ...rhBase, transactionHash: "0xrhlate47", logIndex: 0, kind: "secondary", blockNumber: 50_000, fromAddress: WALLET, toAddress: OTHER },
      ]);
      const entries = await source.entries(["arc-13", "bnb-9", "rh-47"]);
      const found = await source.transfers(new Date(t0.getTime() - 5 * 60_000), entries);
      const handout = Object.fromEntries(found.rows.filter(item => /^own:(arc|bnb|rh)-(near|far|late)/.test(item.ref)).map(item => [item.ref, item.isHandout]));
      expect(handout).toEqual({
        // Arc: 10,500 is 500 blocks after the mint, and 20,000 is 10,000, past 7,080.
        "own:arc-near": true,
        "own:arc-far": false,
        // BNB Chain: 5,000 blocks after the mint is inside 8,000, and 20,000 is not.
        "own:bnb-near": true,
        "own:bnb-far": false,
        // Robinhood Chain: 20,000 blocks after the mint is inside 36,000, and 40,000 is not.
        "own:rh-far-47": true,
        "own:rh-late-47": false,
      });
    });

    it("reads Robinhood ratings added or taken back, never a response, another agent's, another registry's or a BNB one", async () => {
      const entries = await source.entries(["rh-42", "bnb-9"]);
      const found = await source.ratings(new Date(t0.getTime() - 5 * 60_000), entries);
      expect(found.full).toBe(false);
      expect(found.rows.map(item => `${item.kind}:${item.ref}`).sort()).toEqual(["added:fb:rep-new", "revoked:fb:rep-rev"]);
      expect(found.rows.every(item => item.entryId === "rh-42")).toBe(true);
      expect(Object.keys(found.rows[0]!).sort()).toEqual(["createdAt", "entryId", "kind", "ref"]);
      expect(JSON.stringify(found.rows)).not.toContain(OTHER);
    });

    it("runs end to end: writes what is new for a watch, sends it signed, and finds nothing new the second time", async () => {
      await raw("DELETE FROM api_deliveries");
      await raw("DELETE FROM api_watches");
      await raw("DELETE FROM api_webhooks");
      await store.addWatches("key-b", ["rh-42", "sol-1"]);
      await store.setWebhook("key-b", "https://hooks.example.com/end-to-end");
      await store.addWatches("key-f", ["rh-42"]);
      await store.setWebhook("key-f", "https://hooks.example.com/free");
      // The watch is made now, so only what is written from here on is owed to it.
      await raw("UPDATE api_watches SET createdAt = DATE_SUB(NOW(), INTERVAL 1 MINUTE)");
      const sent: Array<{ url: string; type: string }> = [];
      const deps = {
        signingKey: SIGNING_KEY,
        send: async (url: string, input: { body: string; headers: Record<string, string> }) => {
          sent.push({ url, type: JSON.parse(input.body).type });
          return { ok: true as const, status: 200 };
        },
      };
      const first = await pass.runWebhookPass(deps);
      expect(first).toMatchObject({ status: "ran" });
      const types = sent.map(item => item.type).sort();
      // The hand-out and the sale on the Robinhood listing, the transfer on Solana, a new and a revoked rating, one claim history row each for freeze/edit/claim.
      expect(types.filter(type => type === "ownership.changed")).toHaveLength(3);
      expect(types.filter(type => type === "feedback.added")).toHaveLength(1);
      expect(types.filter(type => type === "feedback.revoked")).toHaveLength(1);
      expect(types.filter(type => type === "claim.changed")).toHaveLength(3);
      expect(sent.every(item => item.url === "https://hooks.example.com/end-to-end")).toBe(true);
      expect(await raw("SELECT COUNT(*) AS n FROM api_deliveries WHERE status = 'sent'")).toEqual([{ n: sent.length }]);
      const second = await pass.runWebhookPass(deps);
      expect(second).toMatchObject({ status: "ran", created: 0, sent: 0 });
      expect(sent.length).toBe(types.length);
      // Listing hidden by the operator: told once, and the watch remembers.
      await raw("UPDATE agent_directory_entries SET hidden = 1 WHERE id = 'rh-42'");
      expect(await pass.runWebhookPass(deps)).toMatchObject({ created: 1, sent: 1 });
      expect(sent.at(-1)!.type).toBe("listing.removed");
      expect(await pass.runWebhookPass(deps)).toMatchObject({ created: 0, sent: 0 });
      expect((await store.listWatches("key-b")).find(watch => watch.entryId === "rh-42")!.visible).toBe(false);
    });
  });
});
