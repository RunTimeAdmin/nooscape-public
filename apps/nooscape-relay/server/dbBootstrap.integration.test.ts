import { readFile } from "node:fs/promises";
import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, collectMigrationFiles } from "./dbMigrations";

/**
 * A database built from nothing (docs/bootstrap-from-empty-2026-11-04.md), against a real empty database: the runner refuses it unless
 * the operator asked, and builds the whole schema from every migration file, the baseline and the manual ones included, when asked. The
 * schema it builds is held to the tables that drizzle/schema.ts declares, so a table added to one and not to the other fails here, and
 * the files are shown to be enough to rebuild the app's database. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_bootstrap_test";
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

describe.skipIf(!dbReachable)("a database built from nothing", { timeout: 180_000 }, () => {
  const url = `${BASE_URL}/${TEST_DB}`;

  async function recreate() {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
  }
  async function rows<T>(sql: string): Promise<T[]> {
    const conn = await createConnection(url);
    try {
      const [result] = await conn.query(sql);
      return result as T[];
    } finally {
      await conn.end();
    }
  }
  const tableNames = async () =>
    // Sorted here and not by the server, whose collation puts an underscore after the letters where JavaScript puts it before.
    (await rows<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name <> 'nooscape_schema_migrations'")).map(row => row.t).sort();

  beforeAll(recreate);
  afterAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("is refused without the operator's word, with what to do, and no table is built", async () => {
    await recreate();
    await expect(applyPendingMigrations(url, "drizzle", 60, { bootstrapEmpty: false })).rejects.toThrow(/The database is empty.*NOOSCAPE_BOOTSTRAP_EMPTY_DATABASE=1/s);
    expect(await tableNames()).toEqual([]);
  });

  it("is built from every file when asked, to exactly the tables the schema declares, with every version recorded under its file's name", async () => {
    await recreate();
    const files = await collectMigrationFiles("drizzle");
    const applied = await applyPendingMigrations(url, "drizzle", 60, { bootstrapEmpty: true });
    expect(applied).toEqual(files.map(file => file.name));

    const declared = [...(await readFile("drizzle/schema.ts", "utf8")).matchAll(/mysqlTable\(\s*"([a-z0-9_]+)"/g)].map(match => match[1]!).sort();
    expect(await tableNames()).toEqual(declared);

    const log = await rows<{ version: number; name: string }>("SELECT version, name FROM nooscape_schema_migrations ORDER BY version");
    expect(log).toEqual(files.map(file => ({ version: file.version, name: file.name })));
  });

  it("applies nothing on the next start, with or without the word, and the schema can be read", async () => {
    expect(await applyPendingMigrations(url, "drizzle", 60, { bootstrapEmpty: false })).toEqual([]);
    expect(await applyPendingMigrations(url, "drizzle", 60, { bootstrapEmpty: true })).toEqual([]);
    expect(await rows("SELECT COUNT(*) AS n FROM agent_directory_entries")).toEqual([{ n: 0 }]);
    // A column from a late migration and a table from a manual one are there.
    expect(await rows("SELECT id FROM agent_claims LIMIT 1")).toEqual([]);
    expect(await rows("SELECT id FROM owls_catch LIMIT 1")).toEqual([]);
  });
});
