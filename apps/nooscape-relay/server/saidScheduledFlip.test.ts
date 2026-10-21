import { createConnection, type Connection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } from "./dbMigrations";

/**
 * Database-backed test of migration 0031, the SAID scheduled flip. It runs
 * against a throwaway local MySQL schema built with the project's own boot-time
 * migration runner, and the whole file skips when no database is reachable so
 * the standard no-DB gate stays green. The flip is a guarded UPDATE, so the
 * guards are what is tested: it must change exactly one healthy, seeded,
 * manual-only SAID source, and nothing else.
 */
const TEST_DB = "nooscape_said_flip_test";
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

const SAID_KEY = "solana-said-agent-registry";

describe.skipIf(!dbReachable)("migration 0031: SAID scheduled flip", () => {
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
    // The runner applies everything above the baseline, including 0031 (a no-op: no rows yet).
    const applied = await applyPendingMigrations(url, "drizzle");
    expect(applied.some(name => name.startsWith("0031_"))).toBe(true);

    const flip = files.find(f => f.version === 31);
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

  async function seed(id: string, overrides: Overrides = {}) {
    const row = {
      sourceKey: SAID_KEY,
      protocol: "solana_said",
      state: "active",
      executionPolicy: "manual_only",
      scheduleMinutes: 1440,
      cursor: "said:456494102",
      lastSuccessfulAt: "2026-10-13 15:38:43",
      failureCount: 0,
      nextRunAt: "2026-10-14 15:38:43",
      ...overrides,
    };
    await conn.query(
      "INSERT INTO ingestion_sources (id, sourceKey, label, protocol, rootUrl, allowedHostname, state, executionPolicy, scheduleMinutes, `cursor`, nextRunAt, lastSuccessfulAt, failureCount, createdByUserId) VALUES (?, ?, 'test', ?, 'https://api.mainnet-beta.solana.com', 'api.mainnet-beta.solana.com', ?, ?, ?, ?, ?, ?, ?, ?)",
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

  it("flips a healthy, seeded, manual-only SAID source to a 60-minute schedule, due now", async () => {
    await seed("said-ok");
    await runFlip();
    const row = await read("said-ok");
    expect(row.executionPolicy).toBe("scheduled");
    expect(row.scheduleMinutes).toBe(60);
    // nextRunAt was set to NOW(): it is within a few seconds of the check, not a day away.
    expect(Math.abs(row.secondsSinceNextRun)).toBeLessThan(30);
    // The seed cursor and the state are not touched.
    expect(row.cursor).toBe("said:456494102");
    expect(row.state).toBe("active");
  });

  it("is a no-op the second time (re-running after a crash or reboot is safe)", async () => {
    await seed("said-twice");
    await runFlip();
    await conn.query("UPDATE ingestion_sources SET nextRunAt = '2030-01-01 00:00:00' WHERE id = 'said-twice'");
    await runFlip();
    const [[row]] = (await conn.query("SELECT nextRunAt FROM ingestion_sources WHERE id = 'said-twice'")) as unknown as [[{ nextRunAt: Date }]];
    expect(new Date(row.nextRunAt).getUTCFullYear()).toBe(2030);
  });

  it("never wakes an unseeded source (no cursor, or a foreign cursor)", async () => {
    await seed("said-no-cursor", { cursor: null });
    await runFlip();
    expect((await read("said-no-cursor")).executionPolicy).toBe("manual_only");
    await conn.query("DELETE FROM ingestion_sources");
    await seed("said-foreign-cursor", { cursor: "s8004:123" });
    await runFlip();
    expect((await read("said-foreign-cursor")).executionPolicy).toBe("manual_only");
  });

  it("leaves a paused, rejected, or in-review source alone", async () => {
    for (const state of ["paused", "rejected", "review"]) {
      await conn.query("DELETE FROM ingestion_sources");
      await seed(`said-${state}`, { state });
      await runFlip();
      expect((await read(`said-${state}`)).executionPolicy).toBe("manual_only");
    }
  });

  it("leaves a source with a recorded failure, or no recorded success, alone", async () => {
    await seed("said-failed", { failureCount: 1 });
    await runFlip();
    expect((await read("said-failed")).executionPolicy).toBe("manual_only");
    await conn.query("DELETE FROM ingestion_sources");
    await seed("said-never-succeeded", { lastSuccessfulAt: null });
    await runFlip();
    expect((await read("said-never-succeeded")).executionPolicy).toBe("manual_only");
  });

  it("does not overwrite an operator's cadence on an already-scheduled source", async () => {
    await seed("said-tuned", { executionPolicy: "scheduled", scheduleMinutes: 15 });
    await runFlip();
    const row = await read("said-tuned");
    expect(row.executionPolicy).toBe("scheduled");
    expect(row.scheduleMinutes).toBe(15);
  });

  it("touches no other source, even a healthy manual-only one with a valid cursor", async () => {
    await seed("said-ok");
    await seed("other-8004", { sourceKey: "solana-8004-agent-registry", protocol: "solana_8004", cursor: "s8004:456000000" });
    await seed("other-reputation", { sourceKey: "robinhood-erc8004-reputation-registry", protocol: "erc8004_reputation", cursor: "rb:done" });
    await runFlip();
    expect((await read("said-ok")).executionPolicy).toBe("scheduled");
    for (const id of ["other-8004", "other-reputation"]) {
      const row = await read(id);
      expect(row.executionPolicy).toBe("manual_only");
      expect(row.scheduleMinutes).toBe(1440);
    }
  });
});
