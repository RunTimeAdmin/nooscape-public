import { createConnection, type Connection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } from "./dbMigrations";

/**
 * Database-backed test of migration 0061, the Celo identity registry scheduled flip.
 * It runs against a throwaway local MySQL schema built with the project's own
 * boot-time migration runner, and the whole file skips when no database is
 * reachable so the standard no-DB gate stays green. The flip is a guarded UPDATE,
 * so the guards are what is tested: it must change exactly one healthy, seeded,
 * manual-only Celo identity source, and nothing else.
 */
const TEST_DB = "nooscape_celo_flip_test";
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

const CELO_KEY = "celo-erc8004-identity-registry";

describe.skipIf(!dbReachable)("migration 0061: Celo identity registry scheduled flip", { timeout: 60_000 }, () => {
  let conn: Connection;
  let flipStatements: string[];
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
    // The runner applies everything above the baseline, including 0061 (a no-op: no rows yet). It skips the manual 0046, 0051, 0053, 0057 and 0060,
    // which add the extra chains', AgenC's, Monad's, Gnosis's and Celo's protocol values, so they are applied by hand here in production's order, before any row
    // names those values.
    const applied = await applyPendingMigrations(url, "drizzle");
    expect(applied.some(name => name.startsWith("0061_"))).toBe(true);
    for (const version of [46, 51, 53, 57, 60]) {
      const manual = files.find(f => f.version === version);
      expect(manual, `migration ${version}`).toBeDefined();
      for (const statement of splitMigrationStatements(await readFile(manual!.file, "utf8"))) await conn.query(statement);
    }

    const flip = files.find(f => f.version === 61);
    expect(flip).toBeDefined();
    flipStatements = splitMigrationStatements(await readFile(flip!.file, "utf8"));
    expect(flipStatements).toHaveLength(1);

    await conn.query("INSERT INTO users (openId, name, role) VALUES ('flip-test', 'flip', 'admin')");
    const [[user]] = (await conn.query("SELECT id FROM users WHERE openId = 'flip-test'")) as unknown as [[{ id: number }]];
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
    lastSuccessfulAt: string | null;
    failureCount: number;
    nextRunAt: string | null;
  }>;

  // The seeded cadence is 60, not the 1440 the flip sets, so a test that expects 1440 shows the flip wrote it.
  async function seed(id: string, overrides: Overrides = {}) {
    const row = {
      sourceKey: CELO_KEY,
      protocol: "erc8004_celo",
      state: "active",
      executionPolicy: "manual_only",
      scheduleMinutes: 60,
      cursor: "celo:83295211",
      lastSuccessfulAt: "2026-11-20 18:50:00",
      failureCount: 0,
      nextRunAt: "2026-11-21 18:50:00",
      ...overrides,
    };
    await conn.query(
      "INSERT INTO ingestion_sources (id, sourceKey, label, protocol, rootUrl, allowedHostname, state, executionPolicy, scheduleMinutes, `cursor`, nextRunAt, lastSuccessfulAt, failureCount, createdByUserId) VALUES (?, ?, 'test', ?, 'https://celo-rpc.example', 'celo-rpc.example', ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, row.sourceKey, row.protocol, row.state, row.executionPolicy, row.scheduleMinutes, row.cursor, row.nextRunAt, row.lastSuccessfulAt, row.failureCount, userId]
    );
  }

  async function runFlip() {
    for (const statement of flipStatements) await conn.query(statement);
  }

  async function read(id: string) {
    const [[row]] = (await conn.query(
      "SELECT executionPolicy, scheduleMinutes, `cursor`, state, failureCount, TIMESTAMPDIFF(SECOND, nextRunAt, NOW()) AS secondsSinceNextRun FROM ingestion_sources WHERE id = ?",
      [id]
    )) as unknown as [[{ executionPolicy: string; scheduleMinutes: number; cursor: string | null; state: string; failureCount: number; secondsSinceNextRun: number }]];
    return row;
  }

  it("flips a healthy, seeded, manual-only Celo source to a daily schedule, due now", async () => {
    await seed("celo-ok");
    await runFlip();
    const row = await read("celo-ok");
    expect(row.executionPolicy).toBe("scheduled");
    expect(row.scheduleMinutes).toBe(1440);
    // nextRunAt was set to NOW(): it is within a few seconds of the check, not a day away.
    expect(Math.abs(row.secondsSinceNextRun)).toBeLessThan(30);
    // The cursor, the state, and the failure count are not touched.
    expect(row.cursor).toBe("celo:83295211");
    expect(row.state).toBe("active");
    expect(row.failureCount).toBe(0);
  });

  it("makes the source due now whatever time zone the session runs in", async () => {
    // nextRunAt is a TIMESTAMP: NOW() is right in any session, UTC_TIMESTAMP() only in a UTC one (see migration 0031).
    await conn.query("SET time_zone = '-05:00'");
    try {
      await seed("celo-zone");
      await runFlip();
      expect(Math.abs((await read("celo-zone")).secondsSinceNextRun)).toBeLessThan(30);
    } finally {
      await conn.query("SET time_zone = SYSTEM");
    }
  });

  it("is a no-op the second time (re-running after a crash or reboot is safe)", async () => {
    await seed("celo-twice");
    await runFlip();
    await conn.query("UPDATE ingestion_sources SET nextRunAt = '2030-01-01 00:00:00' WHERE id = 'celo-twice'");
    await runFlip();
    const [[row]] = (await conn.query("SELECT nextRunAt FROM ingestion_sources WHERE id = 'celo-twice'")) as unknown as [[{ nextRunAt: Date }]];
    expect(new Date(row.nextRunAt).getUTCFullYear()).toBe(2030);
  });

  it("never wakes an unseeded source (no cursor, or another chain's cursor)", async () => {
    await seed("celo-no-cursor", { cursor: null });
    await runFlip();
    expect((await read("celo-no-cursor")).executionPolicy).toBe("manual_only");
    for (const cursor of ["bsc:48400000", "base:12345678", "arc:13400000", "eth:24340000", "monad:118363000", "gnosis:49145439"]) {
      await conn.query("DELETE FROM ingestion_sources");
      await seed("celo-foreign-cursor", { cursor });
      await runFlip();
      expect((await read("celo-foreign-cursor")).executionPolicy).toBe("manual_only");
    }
  });

  it("leaves a paused, rejected, or in-review source alone", async () => {
    for (const state of ["paused", "rejected", "review"]) {
      await conn.query("DELETE FROM ingestion_sources");
      await seed(`celo-${state}`, { state });
      await runFlip();
      expect((await read(`celo-${state}`)).executionPolicy).toBe("manual_only");
    }
  });

  it("leaves a source with a recorded failure, or no recorded success, alone", async () => {
    await seed("celo-failed", { failureCount: 1 });
    await runFlip();
    expect((await read("celo-failed")).executionPolicy).toBe("manual_only");
    await conn.query("DELETE FROM ingestion_sources");
    await seed("celo-never-succeeded", { lastSuccessfulAt: null });
    await runFlip();
    expect((await read("celo-never-succeeded")).executionPolicy).toBe("manual_only");
  });

  it("does not overwrite an operator's cadence on an already-scheduled source", async () => {
    await seed("celo-tuned", { executionPolicy: "scheduled", scheduleMinutes: 720 });
    await runFlip();
    const row = await read("celo-tuned");
    expect(row.executionPolicy).toBe("scheduled");
    expect(row.scheduleMinutes).toBe(720);
  });

  it("flips only the approved source key, even for another Celo protocol row with a Celo cursor and a key close to it", async () => {
    await seed("celo-other-key", { sourceKey: "celo-erc8004-other-registry" });
    await runFlip();
    expect((await read("celo-other-key")).executionPolicy).toBe("manual_only");
  });

  it("names no protocol, so it is safe at every boot, including on a database that has not had the by-hand migration 0060", () => {
    // flipStatements holds the statement without the comments, which say that the protocol is not named.
    expect(flipStatements.join("\n")).not.toMatch(/protocol|erc8004_/i);
  });

  it("touches no other source, even a healthy manual-only one with a valid cursor", async () => {
    await seed("celo-ok");
    await seed("other-bsc", { sourceKey: "bsc-erc8004-identity-registry", protocol: "erc8004_bsc", cursor: "bsc:48400000" });
    await seed("other-base", { sourceKey: "base-erc8004-identity-registry", protocol: "erc8004_base", cursor: "base:12345678" });
    await seed("other-arc", { sourceKey: "arc-erc8004-identity-registry", protocol: "erc8004_arc", cursor: "arc:13400000" });
    await seed("other-eth", { sourceKey: "ethereum-erc8004-identity-registry", protocol: "erc8004_eth", cursor: "eth:24340000" });
    await seed("other-monad", { sourceKey: "monad-erc8004-identity-registry", protocol: "erc8004_monad", cursor: "monad:118363000" });
    await seed("other-gnosis", { sourceKey: "gnosis-erc8004-identity-registry", protocol: "erc8004_gnosis", cursor: "gnosis:49145439" });
    await runFlip();
    expect((await read("celo-ok")).executionPolicy).toBe("scheduled");
    for (const id of ["other-bsc", "other-base", "other-arc", "other-eth", "other-monad", "other-gnosis"]) {
      const row = await read(id);
      expect(row.executionPolicy).toBe("manual_only");
      expect(row.scheduleMinutes).toBe(60);
    }
  });
});

describe("the live check once the Celo pass is on the scheduler", () => {
  it("expects the Celo pass to have succeeded within 36 hours, a day and the slack the other daily sources get", async () => {
    const script = await readFile(new URL("../scripts/verify-live.mjs", import.meta.url), "utf8");
    expect(script).toMatch(/\berc8004_celo:\s*36\b/);
  });
});
