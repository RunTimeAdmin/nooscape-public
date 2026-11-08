import { createConnection, type Connection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } from "./dbMigrations";

/**
 * Database-backed test of migration 0057, the `erc8004_gnosis` protocol value (docs/gnosis-erc8004-2026-11-06.md). It shows what the file is for:
 * on a database built the way boot builds it (which skips the manual migrations, and the test then applies 0046, 0051 and 0053 as production has them)
 * a source for the Gnosis registry is refused, and after the file is pasted, twice, the value is accepted and nothing else moved. It also tries the
 * rollback the doc gives the owner, which the database must refuse while a row holds the value. The whole file skips when no database is reachable,
 * so the standard no-DB gate stays green.
 */
const TEST_DB = "nooscape_gnosis_protocol_test";
const BASE_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";
const TABLES = ["agent_directory_entries", "agent_directory_registry_rows", "ingestion_sources", "source_observations"];
const EARLIER = "'a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc','solana_agenc','erc8004_monad'";

const dbReachable = await (async () => {
  try {
    const probe = await createConnection(BASE_URL + "/mysql");
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbReachable)("migration 0057: the erc8004_gnosis protocol value", { timeout: 120_000 }, () => {
  let conn: Connection;
  let migration: string[];
  let userId: number;

  const quoted = (name: string) => "`" + name + "`";

  async function columnTypes(): Promise<Record<string, string>> {
    const [rows] = (await conn.query(
      "SELECT TABLE_NAME AS t, COLUMN_TYPE AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'protocol' AND TABLE_NAME IN (?)",
      [TEST_DB, TABLES]
    )) as unknown as [Array<{ t: string; c: string }>];
    return Object.fromEntries(rows.map(row => [row.t, row.c]));
  }

  async function paste() {
    for (const statement of migration) await conn.query(statement);
  }

  async function insertSource(id: string) {
    await conn.query(
      "INSERT INTO ingestion_sources (id, sourceKey, label, protocol, rootUrl, allowedHostname, state, executionPolicy, scheduleMinutes, createdByUserId) VALUES (?, ?, 'test', 'erc8004_gnosis', 'https://rpc.example', 'rpc.example', 'review', 'manual_only', 1440, ?)",
      [id, "gnosis-" + id, userId]
    );
  }

  beforeAll(async () => {
    const admin = await createConnection(BASE_URL + "/mysql");
    await admin.query("DROP DATABASE IF EXISTS " + quoted(TEST_DB));
    await admin.query("CREATE DATABASE " + quoted(TEST_DB));
    await admin.end();
    const url = BASE_URL + "/" + TEST_DB;
    conn = await createConnection(url);

    // Versions 0000-0014 are applied by hand in production; replay them here as the gate test does.
    const files = await collectMigrationFiles("drizzle");
    for (const file of files.filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await conn.query(statement);
    }
    // The boot runner skips every manual migration, 0057 among them. 0046, 0051 and 0053 are applied by hand, in that order and as production has them,
    // because the file restates their list.
    await applyPendingMigrations(url, "drizzle");
    for (const version of [46, 51, 53]) {
      const earlier = files.find(f => f.version === version);
      expect(earlier, String(version)).toBeDefined();
      for (const statement of splitMigrationStatements(await readFile(earlier!.file, "utf8"))) await conn.query(statement);
    }

    const file = files.find(f => f.version === 57);
    expect(file).toBeDefined();
    migration = splitMigrationStatements(await readFile(file!.file, "utf8"));
    expect(migration).toHaveLength(4);

    await conn.query("INSERT INTO users (openId, name, role) VALUES ('gnosis-migration-test', 'gnosis', 'admin')");
    const [[user]] = (await conn.query("SELECT id FROM users WHERE openId = 'gnosis-migration-test'")) as unknown as [[{ id: number }]];
    userId = user.id;
  });

  afterAll(async () => {
    await conn?.end();
    const admin = await createConnection(BASE_URL + "/mysql");
    await admin.query("DROP DATABASE IF EXISTS " + quoted(TEST_DB));
    await admin.end();
  });

  it("is what lets the Gnosis source in: on a database built by boot, a source for the protocol is refused", async () => {
    // Before the file the value is not in the list, so the lists end where 0053 left them.
    for (const type of Object.values(await columnTypes())) expect(type).toBe("enum(" + EARLIER + ")");
    let threw = false;
    try {
      await insertSource("refused");
    } catch {
      threw = true;
    }
    const [rows] = (await conn.query("SELECT protocol FROM ingestion_sources WHERE id = 'refused'")) as unknown as [Array<{ protocol: string }>];
    // A strict server refuses the row; a lax one stores the empty value. Either way the value is not stored.
    expect(threw || rows[0]?.protocol === "").toBe(true);
    await conn.query("DELETE FROM ingestion_sources WHERE id = 'refused'");
  });

  it("appends the value, last and in order, to the list on all four tables, and is a no-op when pasted a second time", async () => {
    await paste();
    const first = await columnTypes();
    expect(Object.keys(first).sort()).toEqual([...TABLES].sort());
    for (const type of Object.values(first)) expect(type).toBe("enum(" + EARLIER + ",'erc8004_gnosis')");
    await paste();
    expect(await columnTypes()).toEqual(first);
  });

  it("accepts a source for the protocol and a directory entry under it, and keeps every earlier value", async () => {
    await insertSource("gnosis-one");
    await conn.query("INSERT INTO agent_directory_entries (id, sourceId, externalKey, displayName, protocol) VALUES ('entry-1', 'gnosis-one', ?, 'Agent #1', 'erc8004_gnosis')", ["eip155:100:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:1"]);
    const [rows] = (await conn.query("SELECT protocol FROM agent_directory_entries WHERE id = 'entry-1'")) as unknown as [Array<{ protocol: string }>];
    expect(rows[0]?.protocol).toBe("erc8004_gnosis");
    // An earlier value still works, the last one before it among them: the file renumbered nothing.
    for (const [id, value] of [["entry-2", "erc8004_monad"], ["entry-3", "solana_agenc"]] as const) {
      await conn.query("INSERT INTO agent_directory_entries (id, sourceId, externalKey, displayName, protocol) VALUES (?, 'gnosis-one', ?, 'x', ?)", [id, "k-" + id, value]);
      const [kept] = (await conn.query("SELECT protocol FROM agent_directory_entries WHERE id = ?", [id])) as unknown as [Array<{ protocol: string }>];
      expect(kept[0]?.protocol).toBe(value);
    }
  });

  it("cannot be rolled back while a row holds the value, and can once none does", async () => {
    const rollback = TABLES.map(table => "ALTER TABLE " + quoted(table) + " MODIFY COLUMN `protocol` enum(" + EARLIER + ") NOT NULL");
    // The entry and the source from the test above hold the value: the database refuses to drop it, as the doc warns.
    let refused = false;
    try {
      for (const statement of rollback) await conn.query(statement);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    await conn.query("DELETE FROM agent_directory_entries");
    await conn.query("DELETE FROM ingestion_sources");
    for (const statement of rollback) await conn.query(statement);
    for (const type of Object.values(await columnTypes())) expect(type).toBe("enum(" + EARLIER + ")");
    // And the file puts it back.
    await paste();
    for (const type of Object.values(await columnTypes())) expect(type).toBe("enum(" + EARLIER + ",'erc8004_gnosis')");
  });
});
