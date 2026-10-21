import { createConnection, type Connection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } from "./dbMigrations";

/**
 * Database-backed test of migration 0032, which clears the false failures on
 * the Robinhood reputation source. The migration is a guarded UPDATE, so the
 * guards are what is tested: it must clear exactly the "backfill already
 * reached genesis" refusals on a source at `rb:done`, and never a real fault.
 * Runs against a throwaway local MySQL schema built with the project's own
 * boot-time migration runner; the whole file skips when no database is
 * reachable so the standard no-DB gate stays green.
 */
const TEST_DB = "nooscape_rep_reset_test";
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

const REPUTATION_KEY = "robinhood-erc8004-reputation-registry";
const GUARD_MESSAGE = "The reputation backfill already reached genesis (rb:done); continue with the ratings fill (activity) mode.";

describe.skipIf(!dbReachable)("migration 0032: reputation false-failure reset", () => {
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

    const files = await collectMigrationFiles("drizzle");
    for (const file of files.filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await conn.query(statement);
    }
    const applied = await applyPendingMigrations(url, "drizzle");
    expect(applied.some(name => name.startsWith("0032_"))).toBe(true);

    const reset = files.find(f => f.version === 32);
    expect(reset).toBeDefined();
    statements = splitMigrationStatements(await readFile(reset!.file, "utf8"));
    expect(statements).toHaveLength(1);

    await conn.query("INSERT INTO users (openId, name, role) VALUES ('rep-reset-test', 'reset', 'admin')");
    const [[user]] = (await conn.query("SELECT id FROM users WHERE openId = 'rep-reset-test'")) as unknown as [[{ id: number }]];
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

  async function seed(id: string, overrides: Partial<{ sourceKey: string; protocol: string; cursor: string | null; failureCount: number; lastError: string | null }> = {}) {
    const row = {
      sourceKey: REPUTATION_KEY,
      protocol: "erc8004_reputation",
      cursor: "rb:done",
      failureCount: 2,
      lastError: GUARD_MESSAGE,
      ...overrides,
    };
    await conn.query(
      "INSERT INTO ingestion_sources (id, sourceKey, label, protocol, rootUrl, allowedHostname, state, executionPolicy, scheduleMinutes, `cursor`, failureCount, lastError, createdByUserId) VALUES (?, ?, 'test', ?, 'https://rpc.mainnet.chain.robinhood.com', 'rpc.mainnet.chain.robinhood.com', 'active', 'manual_only', 1440, ?, ?, ?, ?)",
      [id, row.sourceKey, row.protocol, row.cursor, row.failureCount, row.lastError, userId]
    );
  }

  const run = async () => {
    for (const statement of statements) await conn.query(statement);
  };
  const read = async (id: string) => {
    const [[row]] = (await conn.query("SELECT failureCount, lastError, `cursor` FROM ingestion_sources WHERE id = ?", [id])) as unknown as [[{ failureCount: number; lastError: string | null; cursor: string | null }]];
    return row;
  };

  it("clears the false failures on a reputation source at rb:done whose only error is the guard message", async () => {
    await seed("rep-ok");
    await run();
    const row = await read("rep-ok");
    expect(row.failureCount).toBe(0);
    expect(row.lastError).toBeNull();
    // The walk position is untouched.
    expect(row.cursor).toBe("rb:done");
  });

  it("never clears a real fault (any other error text)", async () => {
    for (const lastError of [
      "Robinhood Chain RPC returned HTTP 429.",
      "Forward-walk anchor reorg: block 85000000 now hashes to 0xabc, not the anchored 0xdef.",
      "Reputation log batch carried an unknown event topic.",
    ]) {
      await conn.query("DELETE FROM ingestion_sources");
      await seed("rep-real", { lastError });
      await run();
      const row = await read("rep-real");
      expect(row.failureCount).toBe(2);
      expect(row.lastError).toBe(lastError);
    }
  });

  it("leaves a source alone when its cursor is not exactly rb:done", async () => {
    for (const cursor of [null, "rb:12058837", `fw:85000000#0x${"0a".repeat(32)}`]) {
      await conn.query("DELETE FROM ingestion_sources");
      await seed("rep-cursor", { cursor });
      await run();
      expect((await read("rep-cursor")).failureCount).toBe(2);
    }
  });

  it("leaves a source with no recorded failure alone, and a second run is a no-op", async () => {
    await seed("rep-clean", { failureCount: 0, lastError: null });
    await run();
    expect(await read("rep-clean")).toMatchObject({ failureCount: 0, lastError: null });
    await conn.query("DELETE FROM ingestion_sources");
    await seed("rep-twice");
    await run();
    await run();
    expect((await read("rep-twice")).failureCount).toBe(0);
  });

  it("touches no other source, even one carrying the same guard message", async () => {
    await seed("rep-ok");
    await seed("other-source", { sourceKey: "robinhood-erc8004-identity-registry", protocol: "erc8004", cursor: "rb:done", failureCount: 1 });
    await run();
    expect((await read("rep-ok")).failureCount).toBe(0);
    const other = await read("other-source");
    expect(other.failureCount).toBe(1);
    expect(other.lastError).toBe(GUARD_MESSAGE);
  });
});
