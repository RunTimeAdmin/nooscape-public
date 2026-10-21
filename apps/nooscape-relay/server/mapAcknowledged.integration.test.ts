import { createHash } from "node:crypto";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * The sample of BNB Chain registrations on the home map, against a real database: which entries may be in it (nothing
 * hidden, closed, on a suppressed host, in a paused source or on another chain ever is), that it is the same fixed set
 * on every read and is picked by the id alone, that it never has more than the limit, that the count is of every visible
 * BNB entry and not of the sample, and that the public read answers with the same facts. Skips when no database is
 * reachable.
 */
const TEST_DB = "nooscape_map_ack_test";
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

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!dbReachable)("the map's acknowledged sample against a real database", { timeout: 60_000 }, () => {
  type Db = typeof import("./db");
  let db: Db;
  let readCache: typeof import("./readCache");
  let appRouter: typeof import("./routers").appRouter;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;

  async function source(id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"], state: "active" | "paused") {
    await writer.insert(schema.ingestionSources).values({ id, sourceKey: `map-${id}`, label: id, protocol, rootUrl: "https://map.example/feed", allowedHostname: "map.example", state, createdByUserId: operatorUserId });
  }

  async function entries(sourceId: string, prefix: string, count: number, protocol: "erc8004_bsc" | "erc8004", extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}) {
    await writer.insert(schema.agentDirectoryEntries).values(
      Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${String(index).padStart(3, "0")}`,
        sourceId,
        externalKey: `key-${prefix}-${index}`,
        displayName: `Entry ${prefix} ${index}`,
        protocol,
        locatorHost: "agents.example.org",
        firstSeenAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        ...extra,
      }))
    );
  }

  const fresh = () => readCache.invalidateDirectoryReads();
  const visibleBnbIds = Array.from({ length: 40 }, (_, index) => `bnb-${String(index).padStart(3, "0")}`);
  const lowestHashes = (limit: number) => [...visibleBnbIds].sort((a, b) => (sha256(a) < sha256(b) ? -1 : 1)).slice(0, limit);

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
    readCache = await import("./readCache");
    appRouter = (await import("./routers")).appRouter;
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "map-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "map-operator"));
    operatorUserId = operator.id;

    await source("src-bnb", "erc8004_bsc", "active");
    await source("src-bnb-paused", "erc8004_bsc", "paused");
    await source("src-robinhood", "erc8004", "active");
    // Forty BNB entries the public may see.
    await entries("src-bnb", "bnb", 40, "erc8004_bsc");
    // Entries on BNB Chain the public must never see: hidden, closed, on a suppressed host, in a paused source.
    await entries("src-bnb", "hidden", 5, "erc8004_bsc", { hidden: true });
    await entries("src-bnb", "closed", 5, "erc8004_bsc", { assetClosedAt: new Date() });
    await entries("src-bnb", "suppressed", 5, "erc8004_bsc", { locatorHost: "api.agentrank.info" });
    await entries("src-bnb-paused", "paused", 5, "erc8004_bsc");
    // Another chain's entries are not BNB's.
    await entries("src-robinhood", "robinhood", 20, "erc8004");
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("is the entries whose id hashes lowest, no more than the limit, and only BNB entries the public may see", async () => {
    await fresh();
    const sample = await db.listMapAcknowledgedSample("erc8004_bsc", 30);
    expect(sample.entries).toHaveLength(30);
    expect(sample.entries.map(entry => entry.id)).toEqual(lowestHashes(30));
    for (const entry of sample.entries) {
      expect(visibleBnbIds).toContain(entry.id);
      expect(entry.protocol).toBe("erc8004_bsc");
    }
  });

  it("counts every visible BNB entry, not the sample, and counts none of the entries it hides", async () => {
    await fresh();
    expect((await db.listMapAcknowledgedSample("erc8004_bsc", 5)).listed).toBe(40);
    expect((await db.listMapAcknowledgedSample("erc8004_bsc", 30)).listed).toBe(40);
  });

  it("is the same set in the same order on every read, and a smaller limit is the front of a larger one", async () => {
    await fresh();
    const first = await db.listMapAcknowledgedSample("erc8004_bsc", 30);
    await fresh();
    const second = await db.listMapAcknowledgedSample("erc8004_bsc", 30);
    expect(second.entries.map(entry => entry.id)).toEqual(first.entries.map(entry => entry.id));
    await fresh();
    const five = await db.listMapAcknowledgedSample("erc8004_bsc", 5);
    expect(five.entries.map(entry => entry.id)).toEqual(first.entries.slice(0, 5).map(entry => entry.id));
  });

  it("gives up an entry the moment it is hidden, and takes the next one in its place", async () => {
    await fresh();
    const before = await db.listMapAcknowledgedSample("erc8004_bsc", 30);
    const gone = before.entries[0]!.id;
    await writer.update(schema.agentDirectoryEntries).set({ hidden: true }).where(eq(schema.agentDirectoryEntries.id, gone));
    await fresh();
    const after = await db.listMapAcknowledgedSample("erc8004_bsc", 30);
    expect(after.entries.map(entry => entry.id)).not.toContain(gone);
    expect(after.entries).toHaveLength(30);
    expect(after.listed).toBe(39);
    await writer.update(schema.agentDirectoryEntries).set({ hidden: false }).where(eq(schema.agentDirectoryEntries.id, gone));
    await fresh();
  });

  it("is what the public read answers, naming the chain", async () => {
    await fresh();
    const caller = appRouter.createCaller({ user: null, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext);
    const answer = await caller.liveData.mapAcknowledged();
    expect(answer.chain).toBe("bnb");
    expect(answer.listed).toBe(40);
    expect(answer.entries.map(entry => entry.id)).toEqual(lowestHashes(30));
  });
});
