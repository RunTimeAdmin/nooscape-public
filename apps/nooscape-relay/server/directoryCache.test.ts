import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { eventually } from "./eventually";
import { setDirectorySoftQuietMsForTests } from "./readCache";

/**
 * Database-backed test of the directory aggregate cache wiring. The cache
 * itself is unit tested in readCache.test.ts; what needs a real database is
 * the claim that matters operationally: the heavy public aggregates are served
 * from the cache, an operator's write (hide, unhide, a source decision) drops
 * them so a visitor never sees a hidden entry or a paused source late, and an
 * ingestion write only marks them stale, so visitors keep the current counts
 * while one background reload replaces them. Runs against a throwaway local MySQL schema built by the
 * project's own boot-time migration runner, and the whole file skips when no
 * database is reachable so the standard no-DB gate stays green.
 */
const TEST_DB = "nooscape_dir_cache_test";
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

describe.skipIf(!dbReachable)("directory aggregate cache against a real database", () => {
  type Db = typeof import("./db");
  let db: Db;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;
  const SOURCE_ID = "cache-source";

  const draft = (key: string) => ({ externalKey: key, displayName: `Agent ${key}`, locatorHost: "cache.example", sourceSignalNote: "test" });

  async function source() {
    const row = await db.getIngestionSource(SOURCE_ID);
    if (!row) throw new Error("test source missing");
    return row;
  }

  beforeAll(async () => {
    // The reload starts at the first read after a write, instead of after the production quiet period.
    setDirectorySoftQuietMsForTests(0);
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

    await writer.insert(schema.users).values({ openId: "cache-test-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "cache-test-operator"));
    operatorUserId = operator.id;
    await writer.insert(schema.ingestionSources).values({
      id: SOURCE_ID,
      sourceKey: "cache-test-source",
      label: "Cache test source",
      protocol: "catalog",
      rootUrl: "https://cache.example/feed",
      allowedHostname: "cache.example",
      state: "active",
      createdByUserId: operatorUserId,
    });
    await db.upsertAgentDirectoryEntries({ source: await source(), runId: "run-seed", entries: [draft("a"), draft("b"), draft("c")] });
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  async function entryId(key: string) {
    const [row] = await writer.select({ id: schema.agentDirectoryEntries.id }).from(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.externalKey, key));
    return row.id;
  }

  it("serves a repeat read from the cache, and an ingestion write has a reload replace it behind the read", async () => {
    expect(await db.countAgentDirectoryEntries()).toBe(3);

    // A row inserted behind the module's back is invisible while the cache is fresh:
    // that is the cache working, and it proves the second read did not hit the table.
    await writer.insert(schema.agentDirectoryEntries).values({
      id: "raw-entry",
      sourceId: SOURCE_ID,
      externalKey: "raw",
      displayName: "Agent raw",
      protocol: "catalog",
    });
    expect(await db.countAgentDirectoryEntries()).toBe(3);

    // A real upsert marks the aggregate stale. The first read after it is still answered from the cache,
    // so nobody waits for the rebuild; the reload it starts then sees both the raw row and the new one.
    await db.upsertAgentDirectoryEntries({ source: await source(), runId: "run-2", entries: [draft("d")] });
    expect(await db.countAgentDirectoryEntries()).toBe(3);
    expect(await eventually(() => db.countAgentDirectoryEntries(), count => count === 5)).toBe(5);
  });

  it("caches the protocol breakdown too, and refreshes it after an ingestion write", async () => {
    const before = await db.breakdownAgentDirectoryByProtocol();
    expect(before).toEqual([{ protocol: "catalog", count: 5 }]);
    await writer.insert(schema.agentDirectoryEntries).values({ id: "raw-2", sourceId: SOURCE_ID, externalKey: "raw2", displayName: "Agent raw2", protocol: "catalog" });
    expect(await db.breakdownAgentDirectoryByProtocol()).toEqual([{ protocol: "catalog", count: 5 }]);
    await db.upsertAgentDirectoryEntries({ source: await source(), runId: "run-3", entries: [draft("e")] });
    expect(await db.breakdownAgentDirectoryByProtocol()).toEqual([{ protocol: "catalog", count: 5 }]);
    expect(await eventually(() => db.breakdownAgentDirectoryByProtocol(), rows => rows[0]?.count === 7)).toEqual([{ protocol: "catalog", count: 7 }]);
  });

  it("an operator hide and unhide show up on the very next read", async () => {
    const id = await entryId("a");
    // The count held from before may still be a stale one (the upserts above only marked it), so wait for
    // the reload to land first: what is under test is the very next read after the hide.
    const total = await eventually(() => db.countAgentDirectoryEntries(), count => count === 7);
    expect(total).toBe(7);
    await db.hideDirectoryEntry(id);
    expect(await db.countAgentDirectoryEntries()).toBe(total - 1);
    await db.unhideDirectoryEntry(id);
    expect(await db.countAgentDirectoryEntries()).toBe(total);
  });

  it("pausing a source drops its entries from the counts immediately, and reactivating restores them", async () => {
    const total = await db.countAgentDirectoryEntries();
    expect(total).toBeGreaterThan(0);
    await db.decideIngestionSource({ sourceId: SOURCE_ID, decision: "paused", decidedByUserId: operatorUserId, rationale: "cache test pause" });
    expect(await db.countAgentDirectoryEntries()).toBe(0);
    expect(await db.breakdownAgentDirectoryByProtocol()).toEqual([]);
    await db.decideIngestionSource({ sourceId: SOURCE_ID, decision: "active", decidedByUserId: operatorUserId, rationale: "cache test resume" });
    expect(await db.countAgentDirectoryEntries()).toBe(total);
  });

  it("the funnel counts and registrant count are cached and marked stale alongside", async () => {
    const first = await db.readAgentDirectoryFunnelCounts();
    expect(first.acknowledged).toBe(await db.countAgentDirectoryEntries());
    await writer.insert(schema.agentDirectoryEntries).values({ id: "raw-3", sourceId: SOURCE_ID, externalKey: "raw3", displayName: "Agent raw3", protocol: "catalog", locatorHost: "x.example" });
    expect((await db.readAgentDirectoryFunnelCounts()).acknowledged).toBe(first.acknowledged);
    await db.upsertAgentDirectoryEntries({ source: await source(), runId: "run-4", entries: [draft("f")] });
    expect((await db.readAgentDirectoryFunnelCounts()).acknowledged).toBe(first.acknowledged);
    const reloaded = await eventually(() => db.readAgentDirectoryFunnelCounts(), counts => counts.acknowledged === first.acknowledged + 2);
    expect(reloaded.acknowledged).toBe(first.acknowledged + 2);
  });
});
