import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, migrationLockName } from "./dbMigrations";

/**
 * The migration lock against a real MySQL: two boots that start together on a migration that cannot be run twice apply it once and
 * neither fails, and a boot that cannot get the lock fails within its wait without applying anything. Skips when no database is
 * reachable.
 */
const TEST_DB = "nooscape_migration_lock_test";
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

describe.skipIf(!dbReachable)("the migration lock against a real MySQL", { timeout: 60_000 }, () => {
  const url = `${BASE_URL}/${TEST_DB}`;
  const dirs: string[] = [];
  const fixture = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(process.cwd(), "migration-lock-test-"));
    dirs.push(dir);
    for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql);
    return dir;
  };
  const query = async (sql: string, params: unknown[] = []) => {
    const connection = await createConnection(url);
    try {
      return ((await connection.query(sql, params)) as [Array<Record<string, unknown>>, unknown])[0];
    } finally {
      await connection.end();
    }
  };
  const tableExists = async (name: string) => (await query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?", [TEST_DB, name]))[0]!.n === 1;

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
  });

  afterAll(async () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("applies a migration that cannot be run twice once, when two boots start together, and neither fails", async () => {
    const dir = fixture({ "0099_once.sql": "CREATE TABLE `lock_test_once` (`id` int NOT NULL);" });
    const results = await Promise.all([applyPendingMigrations(url, dir), applyPendingMigrations(url, dir), applyPendingMigrations(url, dir)]);
    expect(results.flat()).toEqual(["0099_once.sql"]);
    expect(await tableExists("lock_test_once")).toBe(true);
    const recorded = await query("SELECT `version` FROM `nooscape_schema_migrations` WHERE `version` = 99");
    expect(recorded).toHaveLength(1);
  });

  it("fails a boot that cannot get the lock within its wait, applies nothing, and goes on once the lock is free", async () => {
    const dir = fixture({ "0100_waits.sql": "CREATE TABLE `lock_test_waits` (`id` int NOT NULL);" });
    const holder = await createConnection(url);
    try {
      const [held] = (await holder.query("SELECT GET_LOCK(?, 5) AS acquired", [migrationLockName(url)])) as [Array<{ acquired: number }>, unknown];
      expect(Number(held[0]!.acquired)).toBe(1);
      const started = Date.now();
      await expect(applyPendingMigrations(url, dir, 1)).rejects.toThrow("Could not take the migration lock");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await tableExists("lock_test_waits")).toBe(false);
    } finally {
      await holder.end();
    }
    expect(await applyPendingMigrations(url, dir)).toEqual(["0100_waits.sql"]);
    expect(await tableExists("lock_test_waits")).toBe(true);
  });

  it("does not make a boot of one database wait for a boot of another on the same server", async () => {
    const other = `${BASE_URL}/nooscape_migration_lock_other`;
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query("DROP DATABASE IF EXISTS `nooscape_migration_lock_other`");
    await admin.query("CREATE DATABASE `nooscape_migration_lock_other`");
    await admin.end();
    const holder = await createConnection(url);
    try {
      await holder.query("SELECT GET_LOCK(?, 5)", [migrationLockName(url)]);
      const dir = fixture({ "0101_other.sql": "CREATE TABLE `lock_test_other` (`id` int NOT NULL);" });
      expect(await applyPendingMigrations(other, dir, 1)).toEqual(["0101_other.sql"]);
    } finally {
      await holder.end();
      const cleanup = await createConnection(`${BASE_URL}/mysql`);
      await cleanup.query("DROP DATABASE IF EXISTS `nooscape_migration_lock_other`");
      await cleanup.end();
    }
  });
});
