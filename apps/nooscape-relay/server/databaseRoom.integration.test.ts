import { readFile } from "node:fs/promises";
import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The size the room alarm reads, against a real database (finding R3 of the outside audit of 2026-11-05): the information schema's data and
 * index length of every table of the database the connection is made to, as a number, on both engines the project runs on. Skips when no
 * database is reachable.
 */
const TEST_DB = "nooscape_database_room_test";
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

describe.skipIf(!dbReachable)("the size of the database, read for the room alarm", { timeout: 120_000 }, () => {
  let room: typeof import("./databaseRoom");

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
    room = await import("./databaseRoom");
  });

  afterAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("is a number of bytes for the database the app is connected to, and not for the server's others", async () => {
    const bytes = await room.usedBytesOfThisDatabase();
    expect(Number.isFinite(bytes)).toBe(true);
    // The schema alone is a few hundred tables' pages (16 KB each at least) and nowhere near a gigabyte.
    expect(bytes).toBeGreaterThan(500_000);
    expect(bytes).toBeLessThan(500_000_000);
  });

  it("gives ok against the plan's limit, and critical when the limit is the size of the empty schema", async () => {
    const used = await room.usedBytesOfThisDatabase();
    const roomAgainst = async (limitBytes: number) => room.createDatabaseRoomReader({ usedBytes: room.usedBytesOfThisDatabase, limitBytes: () => limitBytes, log: () => {} })();
    expect(await roomAgainst(6_144 * 1024 * 1024)).toBe("ok");
    expect(await roomAgainst(Math.ceil(used / 0.8))).toBe("low");
    expect(await roomAgainst(used)).toBe("critical");
  });
});
