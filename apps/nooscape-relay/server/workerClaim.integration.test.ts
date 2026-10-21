import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";

/**
 * The worker's claim of a tick against a real database. A tick is claimed only when the last claim is at least the global interval
 * old, less a tolerance: the host's cron fires on the same 15-minute marks the interval measures and its request reaches the app a few
 * seconds either side of :05, so with no tolerance a tick that arrived 2 seconds before the previous one's offset was refused and lost
 * (about one tick in three on 2026-10-20, docs/base-backfill-throughput-2026-10-20.md). The same file pins what the claim takes once a
 * tick is claimed: the due, active, scheduled sources, oldest next run first, no more than the configured number. Runs on a throwaway
 * schema and skips when no database is reachable.
 */
const TEST_DB = "nooscape_worker_claim_test";
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

describe.skipIf(!dbReachable)("the worker's claim of a tick against a real database", { timeout: 120_000 }, () => {
  type Db = typeof import("./db");
  let db: Db;
  let appDb: NonNullable<Awaited<ReturnType<Db["getDb"]>>>;
  let operatorId: number;

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

    db = await import("./db");
    // The claim reads and writes times through the app's own connection, so the test sets them through it too.
    appDb = (await db.getDb())!;
    await appDb.insert(schema.users).values({ openId: "claim-operator", role: "admin" });
    const [operator] = await appDb.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "claim-operator"));
    operatorId = operator.id;
  });

  afterAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
  const setConfig = (values: Partial<typeof schema.ingestionWorkerConfig.$inferInsert> = {}) => {
    const row = { state: "enabled" as const, tickSeconds: 900, maxSourcesPerTick: 2, minGlobalIntervalMinutes: 15, lastStartedAt: null, ...values };
    return appDb
      .insert(schema.ingestionWorkerConfig)
      .values({ id: "primary", ...row })
      .onDuplicateKeyUpdate({ set: row });
  };
  const lastClaim = async () => {
    const [row] = await appDb.select().from(schema.ingestionWorkerConfig).where(eq(schema.ingestionWorkerConfig.id, "primary"));
    return row!.lastStartedAt;
  };
  const addSource = (key: string, over: Partial<typeof schema.ingestionSources.$inferInsert> = {}) =>
    appDb.insert(schema.ingestionSources).values({
      id: key,
      sourceKey: key,
      label: key,
      protocol: "a2a",
      rootUrl: "https://example.test",
      allowedHostname: "example.test",
      state: "active",
      executionPolicy: "scheduled",
      createdByUserId: operatorId,
      nextRunAt: ago(60),
      ...over,
    });

  beforeEach(async () => {
    await appDb.delete(schema.ingestionSources);
    await setConfig();
  });

  describe("the interval between claims", () => {
    it("claims the first tick ever", async () => {
      const claim = await db.claimDueIngestionSources();
      expect(claim.reason).toBe("due");
      expect(await lastClaim()).not.toBeNull();
    });

    it("claims a tick that arrives on the 15 minute mark", async () => {
      await setConfig({ lastStartedAt: ago(15 * 60 + 5) });
      expect((await db.claimDueIngestionSources()).reason).toBe("due");
    });

    it("claims a tick that arrives a few seconds early, as the cron's does about one time in two", async () => {
      const before = ago(15 * 60 - 15);
      await setConfig({ lastStartedAt: before });
      expect((await db.claimDueIngestionSources()).reason).toBe("due");
      // The claim is recorded, so the next tick is measured from this one.
      expect((await lastClaim())!.getTime()).toBeGreaterThan(before.getTime() + 10_000);
    });

    it("refuses a tick that arrives well before the tolerance and leaves the last claim where it was", async () => {
      const before = ago(15 * 60 - 45);
      await setConfig({ lastStartedAt: before });
      expect((await db.claimDueIngestionSources()).reason).toBe("rate_limited");
      expect(Math.abs((await lastClaim())!.getTime() - before.getTime())).toBeLessThan(1_500);
    });

    it("still refuses a tick right after another: a manual tick, or a second instance", async () => {
      for (const seconds of [1, 120, 10 * 60]) {
        await setConfig({ lastStartedAt: ago(seconds) });
        expect((await db.claimDueIngestionSources()).reason).toBe("rate_limited");
      }
    });

    it("measures a longer interval the same way: the tolerance is 30 seconds, not a share", async () => {
      await setConfig({ minGlobalIntervalMinutes: 60, lastStartedAt: ago(60 * 60 - 15) });
      expect((await db.claimDueIngestionSources()).reason).toBe("due");
      await setConfig({ minGlobalIntervalMinutes: 60, lastStartedAt: ago(60 * 60 - 120) });
      expect((await db.claimDueIngestionSources()).reason).toBe("rate_limited");
    });

    it("answers paused without touching the last claim", async () => {
      const before = ago(60 * 60);
      await setConfig({ state: "paused", lastStartedAt: before });
      expect((await db.claimDueIngestionSources()).reason).toBe("paused");
      expect(Math.abs((await lastClaim())!.getTime() - before.getTime())).toBeLessThan(1_500);
    });
  });

  describe("what a claimed tick takes", () => {
    it("takes the due, active, scheduled sources, oldest next run first, no more than the limit", async () => {
      await addSource("src-c", { nextRunAt: ago(600) });
      await addSource("src-a", { nextRunAt: ago(1800) });
      await addSource("src-b", { nextRunAt: ago(1200) });
      await addSource("src-future", { nextRunAt: new Date(Date.now() + 600_000) });
      await addSource("src-manual", { executionPolicy: "manual_only", nextRunAt: ago(2400) });
      await addSource("src-paused", { state: "paused", nextRunAt: ago(3000) });
      const claim = await db.claimDueIngestionSources();
      expect(claim.reason).toBe("due");
      expect(claim.sources.map(source => source.id)).toEqual(["src-a", "src-b"]);
    });

    it("takes a newly due source only after the ones that have waited longer, which is why a busy queue starves a newcomer", async () => {
      // Three sources are overdue and the worker takes two: the one that became due last waits for the next tick.
      await addSource("old-1", { nextRunAt: ago(40 * 60) });
      await addSource("old-2", { nextRunAt: ago(30 * 60) });
      await addSource("newcomer", { nextRunAt: ago(5 * 60) });
      const claim = await db.claimDueIngestionSources();
      expect(claim.sources.map(source => source.id)).toEqual(["old-1", "old-2"]);
    });
  });
});
