import { createConnection, type Connection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } from "./dbMigrations";

/**
 * Database-backed test of migration 0055, the Arc identity registry hourly cadence. It runs against a throwaway local MySQL schema built with
 * the project's own boot-time migration runner, and the whole file skips when no database is reachable so the standard no-DB gate stays green.
 * The change is a guarded UPDATE, so the guards are what is tested: it must change exactly one active, scheduled, daily Arc identity source,
 * and nothing else.
 */
const TEST_DB = "nooscape_arc_hourly_test";
const BASE_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";
const VERSION = 55;

const dbReachable = await (async () => {
  try {
    const probe = await createConnection(`${BASE_URL}/mysql`);
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

const ARC_KEY = "arc-erc8004-identity-registry";

describe.skipIf(!dbReachable)("migration 0055: Arc identity registry hourly cadence", { timeout: 60_000 }, () => {
  let conn: Connection;
  let statements: string[];
  let userId: number;

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    const url = `${BASE_URL}/${TEST_DB}`;
    conn = await createConnection(url);

    // Versions 0000-0014 are applied by hand in production; replay them here as the gate test does.
    const files = await collectMigrationFiles("drizzle");
    for (const file of files.filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await conn.query(statement);
    }
    // The runner applies everything above the baseline, including this file (a no-op: no rows yet). It skips the manual 0046 and 0053, which add
    // the extra chains' protocol values (Arc, Base and Ethereum; Monad), so they are applied by hand here as they were in production, before any row names those values.
    const applied = await applyPendingMigrations(url, "drizzle");
    expect(applied.some(name => name.startsWith(`${String(VERSION).padStart(4, "0")}_`))).toBe(true);
    for (const version of [46, 53]) {
      const protocols = files.find(f => f.version === version);
      expect(protocols).toBeDefined();
      for (const statement of splitMigrationStatements(await readFile(protocols!.file, "utf8"))) await conn.query(statement);
    }

    const flip = files.find(f => f.version === VERSION);
    expect(flip).toBeDefined();
    statements = splitMigrationStatements(await readFile(flip!.file, "utf8"));
    expect(statements).toHaveLength(1);

    await conn.query("INSERT INTO users (openId, name, role) VALUES ('hourly-test', 'hourly', 'admin')");
    const [[user]] = (await conn.query("SELECT id FROM users WHERE openId = 'hourly-test'")) as unknown as [[{ id: number }]];
    userId = user.id;
  });

  afterAll(async () => {
    await conn?.end();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  beforeEach(async () => {
    await conn.query("DELETE FROM ingestion_sources");
  });

  type Overrides = Partial<{
    sourceKey: string;
    protocol: string;
    state: string;
    executionPolicy: string;
    scheduleMinutes: number;
    cursor: string | null;
    failureCount: number;
    nextRunAt: string | null;
  }>;

  // The seeded source is the one production has: scheduled, once a day, with a next run a day away, so a test that expects "due now" shows the change wrote it.
  async function seed(id: string, overrides: Overrides = {}) {
    const row = {
      sourceKey: ARC_KEY,
      protocol: "erc8004_arc",
      state: "active",
      executionPolicy: "scheduled",
      scheduleMinutes: 1440,
      cursor: "arc:28964123",
      failureCount: 0,
      nextRunAt: "2030-01-01 00:00:00",
      ...overrides,
    };
    await conn.query(
      "INSERT INTO ingestion_sources (id, sourceKey, label, protocol, rootUrl, allowedHostname, state, executionPolicy, scheduleMinutes, `cursor`, nextRunAt, lastSuccessfulAt, failureCount, createdByUserId) VALUES (?, ?, 'test', ?, 'https://example.test', 'example.test', ?, ?, ?, ?, ?, '2026-11-02 11:19:06', ?, ?)",
      [id, row.sourceKey, row.protocol, row.state, row.executionPolicy, row.scheduleMinutes, row.cursor, row.nextRunAt, row.failureCount, userId]
    );
  }

  async function runChange() {
    for (const statement of statements) await conn.query(statement);
  }

  async function read(id: string) {
    const [[row]] = (await conn.query(
      "SELECT executionPolicy, scheduleMinutes, `cursor`, state, failureCount, TIMESTAMPDIFF(SECOND, nextRunAt, NOW()) AS secondsSinceNextRun FROM ingestion_sources WHERE id = ?",
      [id]
    )) as unknown as [[{ executionPolicy: string; scheduleMinutes: number; cursor: string | null; state: string; failureCount: number; secondsSinceNextRun: number }]];
    return row;
  }

  it("moves an active, scheduled, daily Arc source to hourly, due now", async () => {
    await seed("arc-ok");
    await runChange();
    const row = await read("arc-ok");
    expect(row.executionPolicy).toBe("scheduled");
    expect(row.scheduleMinutes).toBe(60);
    // nextRunAt was set to NOW(): it is within a few seconds of the check, not years away.
    expect(Math.abs(row.secondsSinceNextRun)).toBeLessThan(30);
    // The cursor, the state and the failure count are not touched.
    expect(row.cursor).toBe("arc:28964123");
    expect(row.state).toBe("active");
    expect(row.failureCount).toBe(0);
  });

  it("makes the source due now whatever time zone the session runs in", async () => {
    // nextRunAt is a TIMESTAMP: NOW() is right in any session, UTC_TIMESTAMP() only in a UTC one (see migration 0031).
    await conn.query("SET time_zone = '-05:00'");
    try {
      await seed("arc-zone");
      await runChange();
      expect(Math.abs((await read("arc-zone")).secondsSinceNextRun)).toBeLessThan(30);
    } finally {
      await conn.query("SET time_zone = SYSTEM");
    }
  });

  it("is a no-op the second time (re-running after a crash or reboot is safe)", async () => {
    await seed("arc-twice");
    await runChange();
    await conn.query("UPDATE ingestion_sources SET nextRunAt = '2030-01-01 00:00:00' WHERE id = 'arc-twice'");
    await runChange();
    const [[row]] = (await conn.query("SELECT nextRunAt FROM ingestion_sources WHERE id = 'arc-twice'")) as unknown as [[{ nextRunAt: Date }]];
    expect(new Date(row.nextRunAt).getUTCFullYear()).toBe(2030);
  });

  it("does not overwrite an operator's cadence: only a source still on the daily one moves", async () => {
    for (const minutes of [15, 720, 60]) {
      await conn.query("DELETE FROM ingestion_sources");
      await seed("arc-tuned", { scheduleMinutes: minutes });
      await runChange();
      expect((await read("arc-tuned")).scheduleMinutes).toBe(minutes);
    }
  });

  it("leaves a manual-only Arc source alone: handing it to the scheduler is migration 0050's reviewed step", async () => {
    await seed("arc-manual", { executionPolicy: "manual_only" });
    await runChange();
    const row = await read("arc-manual");
    expect(row.executionPolicy).toBe("manual_only");
    expect(row.scheduleMinutes).toBe(1440);
  });

  it("leaves a paused, rejected, or in-review source alone", async () => {
    for (const state of ["paused", "rejected", "review"]) {
      await conn.query("DELETE FROM ingestion_sources");
      await seed(`arc-${state}`, { state });
      await runChange();
      expect((await read(`arc-${state}`)).scheduleMinutes).toBe(1440);
    }
  });

  it("never touches a source with no cursor, or another chain's cursor", async () => {
    await seed("arc-no-cursor", { cursor: null });
    await runChange();
    expect((await read("arc-no-cursor")).scheduleMinutes).toBe(1440);
    for (const cursor of ["bsc:48400000", "base:12345678"]) {
      await conn.query("DELETE FROM ingestion_sources");
      await seed("arc-foreign-cursor", { cursor });
      await runChange();
      expect((await read("arc-foreign-cursor")).scheduleMinutes).toBe(1440);
    }
  });

  it("moves only the approved source key, even for another Arc protocol row", async () => {
    await seed("arc-other-key", { sourceKey: "some-other-arc-source" });
    await runChange();
    expect((await read("arc-other-key")).scheduleMinutes).toBe(1440);
  });

  it("touches no other source, even a daily one with a valid cursor", async () => {
    await seed("arc-ok");
    await seed("other-bsc", { sourceKey: "bsc-erc8004-identity-registry", protocol: "erc8004_bsc", cursor: "bsc:48400000" });
    await seed("other-eth", { sourceKey: "ethereum-erc8004-identity-registry", protocol: "erc8004_eth", cursor: "eth:12345678" });
    await seed("other-monad", { sourceKey: "monad-erc8004-identity-registry", protocol: "erc8004_monad", cursor: "monad:52952790" });
    await runChange();
    expect((await read("arc-ok")).scheduleMinutes).toBe(60);
    for (const id of ["other-bsc", "other-eth", "other-monad"]) {
      const row = await read(id);
      expect(row.scheduleMinutes).toBe(1440);
      expect(row.secondsSinceNextRun).toBeLessThan(0);
    }
  });
});

describe("the live check once the Arc pass runs every hour", () => {
  it("expects the Arc pass to have succeeded within 12 hours, not the 36 a daily source gets", async () => {
    const script = await readFile(new URL("../scripts/verify-live.mjs", import.meta.url), "utf8");
    expect(script).toMatch(/\berc8004_arc:\s*12\b/);
  });
});
