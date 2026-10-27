import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, collectMigrationFiles, MANUAL_MIGRATIONS, migrationLockName, parseMigrationVersion, splitMigrationStatements } from "./dbMigrations";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface SnapshotHeader {
  id: string;
  prevId: string;
}

/**
 * Tests for the boot-time migration runner. mysql2 is mocked at the connection
 * boundary: every query the runner sends is captured, and the SELECT of the
 * bookkeeping table answers with a scripted applied-set. Migration files are
 * real files written to a throwaway directory so the runner's file listing,
 * version parsing, statement splitting, and comment stripping are all
 * exercised for real.
 */

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

const captured: CapturedQuery[] = [];
// Scripted answer for `SELECT version FROM nooscape_schema_migrations`.
let scriptedAppliedVersions: Array<{ version: number; name?: string }> = [];
// When set, any query whose SQL contains this fragment rejects, simulating a
// broken migration statement.
let failOnSql: string | null = null;
let connectionEnded = false;
// The migration lock: whether another process holds it, and what the runner did with it and in what order.
let lockAvailable = true;
let lockEvents: string[] = [];
let lockArguments: unknown[][] = [];

vi.mock("mysql2/promise", () => ({
  createConnection: vi.fn(async () => ({
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("GET_LOCK")) {
        lockEvents.push("get");
        lockArguments.push(params ?? []);
        return [[{ acquired: lockAvailable ? 1 : 0 }], []];
      }
      if (sql.includes("RELEASE_LOCK")) {
        lockEvents.push("release");
        return [[{ released: 1 }], []];
      }
      if (!lockEvents.includes("first")) lockEvents.push("first");
      if (failOnSql !== null && sql.includes(failOnSql)) {
        throw new Error("simulated migration failure");
      }
      captured.push({ sql, params: params ?? [] });
      if (sql.includes("SELECT")) {
        return [scriptedAppliedVersions, []];
      }
      return [[], []];
    },
    end: async () => {
      connectionEnded = true;
      lockEvents.push("end");
    },
  })),
}));

function resetRun(appliedVersions: Array<number>, recordedNames: Record<number, string> = {}) {
  captured.length = 0;
  connectionEnded = false;
  failOnSql = null;
  lockAvailable = true;
  lockEvents = [];
  lockArguments = [];
  scriptedAppliedVersions = appliedVersions.map(version => (recordedNames[version] === undefined ? { version } : { version, name: recordedNames[version] }));
}

function writeFixture(dir: string, name: string, content: string) {
  writeFileSync(path.join(dir, name), content);
}

/** Main fixture set: one baseline migration (must never run) and two pending. */
function createMainFixtureDir() {
  const dir = mkdtempSync(path.join(process.cwd(), "migration-test-"));
  writeFixture(dir, "0001_seed.sql", "CREATE TABLE `baseline_never_runs` (id int);");
  writeFixture(
    dir,
    "0015_a.sql",
    "--- hand-review note that MySQL would reject as SQL\n" +
      "ALTER TABLE `t1` ADD `col` int;--> statement-breakpoint\n" +
      "UPDATE `t1` SET `col` = 1;"
  );
  writeFixture(dir, "0016_b.sql", "CREATE INDEX `t1_col_idx` ON `t1` (`col`);");
  return dir;
}

const mainFixtureDir = createMainFixtureDir();

afterAll(() => {
  rmSync(mainFixtureDir, { recursive: true, force: true });
});

describe("migration file parsing", () => {
  it("parses the numeric version prefix", () => {
    expect(parseMigrationVersion("0015_directory_entry_hidden.sql")).toBe(15);
    expect(parseMigrationVersion("0164_two_part.sql")).toBe(164);
    expect(parseMigrationVersion("notes.txt")).toBeNull();
  });

  it("splits on statement breakpoints and strips --- comment lines", () => {
    const content =
      "--- reviewed apply note\n" +
      "ALTER TABLE `t` ADD `c` int;--> statement-breakpoint\n" +
      "UPDATE `t` SET `c` = 1;--> statement-breakpoint\n" +
      "--- trailing note\n";
    const statements = splitMigrationStatements(content);
    expect(statements).toEqual(["ALTER TABLE `t` ADD `c` int;", "UPDATE `t` SET `c` = 1;"]);
  });

  it("lists migration files in ascending version order", async () => {
    const files = await collectMigrationFiles(mainFixtureDir);
    expect(files.map(file => file.version)).toEqual([1, 15, 16]);
  });
});

describe("applyPendingMigrations", () => {
  it("first boot: stamps the hand-applied baseline and applies only pending versions", async () => {
    resetRun([]);
    const applied = await applyPendingMigrations("mysql://test:test@localhost:3306/nooscape_test", mainFixtureDir);

    expect(applied).toEqual(["0015_a.sql", "0016_b.sql"]);
    // First two queries: ensure the bookkeeping table exists, read applied set.
    expect(captured[0].sql).toContain("CREATE TABLE IF NOT EXISTS");
    expect(captured[0].sql).toContain("nooscape_schema_migrations");
    expect(captured[1].sql).toContain("SELECT");
    // The baseline file (version 1) is stamped into the table, never executed.
    const baselineInserts = captured.filter(entry => entry.sql.includes("INSERT") && entry.params.length === 2 && entry.params[0] === 1);
    expect(baselineInserts.length).toBe(1);
    expect(captured.every(entry => !entry.sql.includes("baseline_never_runs"))).toBe(true);
    // Sequence after the applied-set read: baseline stamp insert, 0015's two
    // statements in order, its bookkeeping insert, then 0016 and its insert.
    const sqlSequence = captured.map(entry => entry.sql.replace(/\s+/g, " ").trim());
    expect(sqlSequence[2]).toContain("INSERT IGNORE");
    expect(sqlSequence[2]).toContain("nooscape_schema_migrations");
    expect(sqlSequence[3]).toContain("ALTER TABLE `t1` ADD `col` int");
    expect(sqlSequence[4]).toContain("UPDATE `t1` SET `col` = 1");
    expect(sqlSequence[5]).toContain("INSERT");
    expect(captured[5].params).toEqual([15, "0015_a.sql"]);
    expect(sqlSequence[6]).toContain("CREATE INDEX `t1_col_idx`");
    expect(sqlSequence[7]).toContain("INSERT");
    expect(captured[7].params).toEqual([16, "0016_b.sql"]);
    expect(connectionEnded).toBe(true);
  });

  it("current boot: applies nothing", async () => {
    resetRun([15, 16]);
    const applied = await applyPendingMigrations("mysql://test:test@localhost:3306/nooscape_test", mainFixtureDir);

    expect(applied).toEqual([]);
    // Only the table check and the applied-set read ran.
    expect(captured.length).toBe(2);
    expect(connectionEnded).toBe(true);
  });

  it("partially applied boot: applies only the missing version", async () => {
    resetRun([15]);
    const applied = await applyPendingMigrations("mysql://test:test@localhost:3306/nooscape_test", mainFixtureDir);

    expect(applied).toEqual(["0016_b.sql"]);
    expect(captured.every(entry => !entry.sql.includes("ALTER TABLE"))).toBe(true);
    expect(captured.some(entry => entry.sql.includes("CREATE INDEX"))).toBe(true);
  });

  it("fails loudly on a broken statement and still closes the connection", async () => {
    resetRun([]);
    failOnSql = "no_such_table";
    const failing = mkdtempSync(path.join(process.cwd(), "migration-test-"));
    try {
      writeFixture(failing, "0001_seed.sql", "CREATE TABLE `baseline_never_runs` (id int);");
      writeFixture(failing, "0017_c.sql", "SELECT `forced_failure` FROM `no_such_table`;");
      await expect(applyPendingMigrations("mysql://test:test@localhost:3306/nooscape_test", failing)).rejects.toThrow(
        "simulated migration failure"
      );
      // The finally block closed the connection despite the failure.
      expect(connectionEnded).toBe(true);
    } finally {
      rmSync(failing, { recursive: true, force: true });
    }
  });
});

describe("the names in the migration log", () => {
  const url = "mysql://test:test@localhost:3306/nooscape_test";
  const folder = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(process.cwd(), "migration-test-"));
    for (const [name, sql] of Object.entries(files)) writeFixture(dir, name, sql);
    return dir;
  };
  const withFolder = async (files: Record<string, string>, run: (dir: string) => Promise<void>) => {
    const dir = folder(files);
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("stops the boot and applies nothing when a version is recorded under another file's name", async () => {
    await withFolder(
      { "0001_seed.sql": "CREATE TABLE `baseline_never_runs` (id int);", "0090_new.sql": "CREATE TABLE `never_runs_90` (id int);", "0091_next.sql": "CREATE TABLE `never_runs_91` (id int);" },
      async dir => {
        resetRun([90], { 90: "0090_something_else.sql" });
        await expect(applyPendingMigrations(url, dir)).rejects.toThrow('version 90 is recorded as "0090_something_else.sql" and its file is "0090_new.sql"');
        // Not even the later, unrecorded 0091 ran, and the connection and the lock were given back.
        expect(captured.every(entry => !entry.sql.includes("never_runs"))).toBe(true);
        expect(connectionEnded).toBe(true);
        expect(lockEvents).toContain("release");
      }
    );
  });

  it("names every version that disagrees", async () => {
    await withFolder({ "0090_a.sql": "SELECT 1;", "0091_b.sql": "SELECT 1;" }, async dir => {
      resetRun([90, 91], { 90: "0090_x.sql", 91: "0091_y.sql" });
      const error = await applyPendingMigrations(url, dir).then(() => new Error("the boot did not stop"), (reason: unknown) => reason as Error);
      expect(error.message).toContain('version 90 is recorded as "0090_x.sql"');
      expect(error.message).toContain('version 91 is recorded as "0091_y.sql"');
    });
  });

  it("lets a version through that is recorded under its own file's name, with or without the .sql, and goes on to the next", async () => {
    await withFolder({ "0090_new.sql": "CREATE TABLE `table_90` (id int);", "0091_next.sql": "CREATE TABLE `table_91` (id int);" }, async dir => {
      resetRun([90], { 90: "0090_new" });
      expect(await applyPendingMigrations(url, dir)).toEqual(["0091_next.sql"]);
      resetRun([90], { 90: "0090_new.sql" });
      expect(await applyPendingMigrations(url, dir)).toEqual(["0091_next.sql"]);
    });
  });

  it("lets version 47 through under the name an operator recorded it by hand, and skips its file as before", async () => {
    await withFolder({ "0047_registry_overflow_counts.sql": "CREATE TABLE `overflow_never_created` (id int);" }, async dir => {
      resetRun([47], { 47: "0047_base_scheduled_flip.sql" });
      expect(await applyPendingMigrations(url, dir)).toEqual([]);
      expect(captured.every(entry => !entry.sql.includes("overflow_never_created"))).toBe(true);
    });
  });

  it("does not look at the names of the baseline or the manual migrations, which an operator records by hand", async () => {
    await withFolder({ "0005_old.sql": "SELECT 1;", "0043_api_keys.sql": "SELECT 1;" }, async dir => {
      resetRun([5, 43], { 5: "0005_other.sql", 43: "api_keys_by_hand" });
      expect(await applyPendingMigrations(url, dir)).toEqual([]);
    });
  });

  it("starts from the real folder against the log as production holds it: every version from 15 under its file's name, 47 under the Base flip", async () => {
    const real = (await collectMigrationFiles(path.resolve(process.cwd(), "drizzle"))).filter(file => file.version > 14);
    expect(real.some(file => file.version === 47)).toBe(true);
    resetRun(real.map(file => file.version), Object.fromEntries(real.map(file => [file.version, file.version === 47 ? "0047_base_scheduled_flip.sql" : file.name])));
    expect(await applyPendingMigrations(url)).toEqual([]);
  });
});

describe("the migration lock", () => {
  const url = "mysql://test:test@localhost:3306/nooscape_test";

  it("is taken before anything else, named for the database and held for 60 seconds at most, and given back before the connection ends", async () => {
    resetRun([]);
    await applyPendingMigrations(url, mainFixtureDir);
    expect(lockEvents).toEqual(["get", "first", "release", "end"]);
    expect(lockArguments).toEqual([["nooscape_migrations:nooscape_test", 60]]);
  });

  it("is given back when a statement fails, and a boot that finds it taken fails without applying anything", async () => {
    resetRun([]);
    failOnSql = "no_such_table";
    const failing = mkdtempSync(path.join(process.cwd(), "migration-test-"));
    try {
      writeFixture(failing, "0017_c.sql", "SELECT `forced_failure` FROM `no_such_table`;");
      await expect(applyPendingMigrations(url, failing)).rejects.toThrow("simulated migration failure");
      expect(lockEvents).toEqual(["get", "first", "release", "end"]);
    } finally {
      rmSync(failing, { recursive: true, force: true });
    }
    resetRun([]);
    lockAvailable = false;
    await expect(applyPendingMigrations(url, mainFixtureDir, 1)).rejects.toThrow("Could not take the migration lock");
    // It never reached a migration, never tried to release a lock it did not hold, and still closed the connection.
    expect(lockEvents).toEqual(["get", "end"]);
    expect(lockArguments).toEqual([["nooscape_migrations:nooscape_test", 1]]);
    expect(captured).toEqual([]);
  });

  it("is named by the database, so two databases on one server do not wait for each other, and stays within MySQL's 64 characters", () => {
    expect(migrationLockName("mysql://u:p@host:3306/one")).toBe("nooscape_migrations:one");
    expect(migrationLockName("mysql://u:p@host:3306/two")).toBe("nooscape_migrations:two");
    expect(migrationLockName(`mysql://u:p@host/${"d".repeat(100)}`)).toHaveLength(64);
    expect(migrationLockName("not a url")).toBe("nooscape_migrations:");
  });
});

/**
 * Manual migrations are applied by an operator, never by a boot. Versions 36 (the Owl's Catch table) and 37 (the
 * agent checks table) are the ones there are; the fixture gives 36 a file beside a baseline file and a boot migration.
 */
describe("manual migrations", () => {
  const url = "mysql://test:test@localhost:3306/nooscape_test";
  const manualDir = mkdtempSync(path.join(process.cwd(), "migration-test-"));
  writeFixture(manualDir, "0001_seed.sql", "CREATE TABLE `baseline_never_runs` (id int);");
  writeFixture(manualDir, "0015_a.sql", "CREATE TABLE `boot_table` (id int);");
  writeFixture(manualDir, "0036_manual.sql", "CREATE TABLE IF NOT EXISTS `manual_table` (id int);");
  afterAll(() => {
    rmSync(manualDir, { recursive: true, force: true });
  });

  it("are neither run nor recorded by the boot runner, which still applies the others", async () => {
    resetRun([]);
    expect(await applyPendingMigrations(url, manualDir)).toEqual(["0015_a.sql"]);
    expect(captured.some(entry => entry.sql.includes("manual_table"))).toBe(false);
    expect(captured.some(entry => entry.params[0] === 36)).toBe(false);
  });

  it("keep the Owl's Catch table out of every boot: version 36 is on the list, its file is the repository's, and a boot from the real folder never mentions the table", async () => {
    // Taking 36 off the list would make the next boot create the table.
    expect(MANUAL_MIGRATIONS).toContain(36);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0036_owls_catch.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0036_owls_catch.sql");
    expect(captured.some(entry => entry.sql.includes("owls_catch") || entry.params[0] === 36)).toBe(false);
  });

  it("keep the agent checks table out of every boot too: version 37 is on the list, its file is the repository's, and a boot from the real folder never mentions the table", async () => {
    // Taking 37 off the list would make the next boot create the table, and the checks could start before the owner chose.
    expect(MANUAL_MIGRATIONS).toContain(37);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0037_agent_checks.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0037_agent_checks.sql");
    expect(captured.some(entry => entry.sql.includes("agent_checks") || entry.params[0] === 37)).toBe(false);
  });

  it("keep the BNB cluster tables out of every boot as well: version 38 is on the list, its file is the repository's, and a boot from the real folder never mentions the tables", async () => {
    expect(MANUAL_MIGRATIONS).toContain(38);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0038_bsc_clusters.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0038_bsc_clusters.sql");
    expect(captured.some(entry => entry.sql.includes("bsc_clusters") || entry.sql.includes("bsc_entry_evidence") || entry.params[0] === 38)).toBe(false);
  });

  it("keep the BNB rater tables out of every boot too: version 39 is on the list, its file is the repository's, and a boot from the real folder never mentions the tables", async () => {
    expect(MANUAL_MIGRATIONS).toContain(39);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0039_bsc_rater_evidence.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0039_bsc_rater_evidence.sql");
    expect(captured.some(entry => entry.sql.includes("bsc_feedback_events") || entry.sql.includes("bsc_rater_evidence") || entry.sql.includes("bsc_reputation_state") || entry.params[0] === 39)).toBe(false);
  });

  it("keep the BNB endpoint-host table out of every boot as well: version 40 is on the list, its file is the repository's, and a boot from the real folder never mentions the table", async () => {
    expect(MANUAL_MIGRATIONS).toContain(40);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0040_bsc_endpoint_host_groups.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0040_bsc_endpoint_host_groups.sql");
    expect(captured.some(entry => entry.sql.includes("bsc_endpoint_host_groups") || entry.params[0] === 40)).toBe(false);
  });

  it("keep the API key tables out of every boot too: version 43 is on the list, its file is the repository's, and a boot from the real folder never mentions the tables", async () => {
    // Taking 43 off the list would make the next boot create the tables, and keys could open before the owner chose.
    expect(MANUAL_MIGRATIONS).toContain(43);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0043_api_keys.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0043_api_keys.sql");
    expect(captured.some(entry => entry.sql.includes("api_keys") || entry.sql.includes("api_usage") || entry.params[0] === 43)).toBe(false);
  });

  it("keep the payments table out of every boot too: version 44 is on the list, its file is the repository's, and a boot from the real folder never mentions the table", async () => {
    // Taking 44 off the list would make the next boot create the table, and pay per call could open before the owner chose.
    expect(MANUAL_MIGRATIONS).toContain(44);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0044_api_payments.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0044_api_payments.sql");
    expect(captured.some(entry => entry.sql.includes("api_payments") || entry.params[0] === 44)).toBe(false);
  });

  it("keep the watchlist and webhook tables out of every boot too: version 45 is on the list, its file is the repository's, and a boot from the real folder never mentions the tables", async () => {
    // Taking 45 off the list would make the next boot create the tables, and webhooks could open before the owner chose.
    expect(MANUAL_MIGRATIONS).toContain(45);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0045_api_webhooks.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0045_api_webhooks.sql");
    expect(captured.some(entry => entry.sql.includes("api_watches") || entry.sql.includes("api_webhooks") || entry.sql.includes("api_deliveries") || entry.sql.includes("api_event_cursors") || entry.params[0] === 45)).toBe(false);
  });

  it("keep the extra chains' protocol values out of every boot too: version 46 is on the list, its file is the repository's, and a boot from the real folder never mentions them", async () => {
    // Taking 46 off the list would make the next boot alter four large tables before the owner chose.
    expect(MANUAL_MIGRATIONS).toContain(46);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0046_multichain_erc8004_protocols.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0046_multichain_erc8004_protocols.sql");
    expect(captured.some(entry => entry.sql.includes("erc8004_base") || entry.sql.includes("erc8004_eth") || entry.sql.includes("erc8004_arc") || entry.params[0] === 46)).toBe(false);
  });

  it("make the 0046 file do exactly one thing: append the three values, last, to the protocol list of the four tables that carry it", () => {
    const content = readFileSync(path.resolve(process.cwd(), "drizzle", "0046_multichain_erc8004_protocols.sql"), "utf8");
    const statements = splitMigrationStatements(content);
    expect(statements).toHaveLength(4);
    const earlier = "'a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc'";
    const tables: string[] = [];
    for (const statement of statements) {
      const match = /^ALTER TABLE `(\w+)` MODIFY COLUMN `protocol` enum\((.+)\) NOT NULL;?$/s.exec(statement.trim());
      expect(match, statement.slice(0, 80)).not.toBeNull();
      tables.push(match![1]!);
      // The earlier list is untouched and in its order, and the three new values come after it: nothing is inserted mid-list.
      expect(match![2]).toBe(`${earlier},'erc8004_base','erc8004_eth','erc8004_arc'`);
    }
    expect(tables.sort()).toEqual(["agent_directory_entries", "agent_directory_registry_rows", "ingestion_sources", "source_observations"]);
    // Nothing else: no drop, no data written, no index, no other column.
    expect(statements.join("\n")).not.toMatch(/\b(DROP|DELETE|INSERT|UPDATE|TRUNCATE|CREATE|ADD)\b/i);
  });

  it("keep the AgenC protocol value out of every boot too: version 51 is on the list, its file is the repository's, and a boot from the real folder never mentions it", async () => {
    // Taking 51 off the list would make the next boot restate the whole protocol list, the 0046 values with it, before the owner chose.
    expect(MANUAL_MIGRATIONS).toContain(51);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0051_solana_agenc_protocol.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0051_solana_agenc_protocol.sql");
    expect(captured.some(entry => entry.sql.includes("solana_agenc") || entry.params[0] === 51)).toBe(false);
  });

  it("make the 0051 file do exactly one thing: append the one value, last, to the protocol list of the four tables that carry it", () => {
    const content = readFileSync(path.resolve(process.cwd(), "drizzle", "0051_solana_agenc_protocol.sql"), "utf8");
    const statements = splitMigrationStatements(content);
    expect(statements).toHaveLength(4);
    // The list 0046 left, in its order. The file restates it whole, so a database that has run 0046 is unchanged but for the new value.
    const earlier = "'a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc'";
    const tables: string[] = [];
    for (const statement of statements) {
      const match = /^ALTER TABLE `(\w+)` MODIFY COLUMN `protocol` enum\((.+)\) NOT NULL;?$/s.exec(statement.trim());
      expect(match, statement.slice(0, 80)).not.toBeNull();
      tables.push(match![1]!);
      // Nothing earlier is touched or reordered, and the new value comes after it: nothing is inserted mid-list.
      expect(match![2]).toBe(`${earlier},'solana_agenc'`);
    }
    expect(tables.sort()).toEqual(["agent_directory_entries", "agent_directory_registry_rows", "ingestion_sources", "source_observations"]);
    // Nothing else: no drop, no data written, no index, no other column.
    expect(statements.join("\n")).not.toMatch(/\b(DROP|DELETE|INSERT|UPDATE|TRUNCATE|CREATE|ADD)\b/i);
  });

  it("keep the claim tables out of every boot too: version 42 is on the list, its file is the repository's, and a boot from the real folder never mentions the tables", async () => {
    // Taking 42 off the list would make the next boot create the tables, and claims could open before the owner chose.
    expect(MANUAL_MIGRATIONS).toContain(42);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0042_agent_claims.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0042_agent_claims.sql");
    expect(captured.some(entry => entry.sql.includes("agent_claim") || entry.params[0] === 42)).toBe(false);
  });
});

/**
 * Guard for the drizzle-kit bookkeeping the boot-time runner does not read.
 * Migrations 0014-0028 were hand-authored with no journal entries, which left
 * `drizzle-kit generate` diffing against the stale 0013 snapshot and emitting a
 * bogus migration re-stating every change since. The journal was backfilled;
 * this test keeps it from drifting again: every migration file needs a journal
 * entry (and vice versa), and every entry needs its snapshot in the id chain.
 */
describe("manual migration 49", () => {
  const url = "mysql://test:test@localhost:3306/nooscape_test";

  it("keeps the column drop out of every boot: version 49 is on the list, its file is the repository's, and a boot from the real folder never drops it", async () => {
    expect(MANUAL_MIGRATIONS).toContain(49);
    const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");
    expect((await collectMigrationFiles(repoDrizzleDir)).map(file => file.name)).toContain("0049_drop_worker_tick_seconds.sql");
    resetRun([]);
    const applied = await applyPendingMigrations(url, repoDrizzleDir);
    expect(applied).not.toContain("0049_drop_worker_tick_seconds.sql");
    expect(captured.some(entry => entry.sql.includes("DROP COLUMN") || entry.params[0] === 49)).toBe(false);
  });

  it("does one thing: drops the one column, and the code names it nowhere", async () => {
    const file = (await collectMigrationFiles(path.resolve(process.cwd(), "drizzle"))).find(entry => entry.version === 49)!;
    const statements = splitMigrationStatements(readFileSync(file.file, "utf8"));
    expect(statements).toEqual(["ALTER TABLE `ingestion_worker_config` DROP COLUMN `tickSeconds`;"]);
    for (const source of ["drizzle/schema.ts", "server/db.ts", "server/routers/liveData.ts"]) {
      expect(readFileSync(path.resolve(process.cwd(), source), "utf8"), source).not.toContain("tickSeconds");
    }
  });
});

describe("migration journal parity", () => {
  const repoDrizzleDir = path.resolve(process.cwd(), "drizzle");

  it("has a journal entry for every migration file and no orphaned entries", async () => {
    const files = await collectMigrationFiles(repoDrizzleDir);
    const journal = JSON.parse(readFileSync(path.join(repoDrizzleDir, "meta", "_journal.json"), "utf8")) as {
      entries: JournalEntry[];
    };

    let previousIdx = -1;
    for (const entry of journal.entries) {
      expect(entry.idx, `journal idx out of order at tag ${entry.tag}`).toBe(previousIdx + 1);
      previousIdx = entry.idx;
      const versionPrefix = parseMigrationVersion(`${entry.tag}.sql`);
      expect(versionPrefix, `journal tag ${entry.tag} lacks a numeric prefix`).not.toBeNull();
      expect(entry.idx).toBe(versionPrefix);
    }

    const fileTags = new Set(files.map(file => file.name.replace(/\.sql$/, "")));
    const journalTags = new Set(journal.entries.map(entry => entry.tag));
    expect(
      files.filter(file => !journalTags.has(file.name.replace(/\.sql$/, ""))).map(file => file.name),
      "migration files without a journal entry — drizzle-kit generate would emit a bogus migration"
    ).toEqual([]);
    expect(
      [...journalTags].filter(tag => !fileTags.has(tag)),
      "journal entries without a migration file — drizzle-kit migrate would fail to find the SQL"
    ).toEqual([]);
  });

  it("has a snapshot for every journal entry and the id chain is intact", () => {
    const journal = JSON.parse(readFileSync(path.join(repoDrizzleDir, "meta", "_journal.json"), "utf8")) as {
      entries: JournalEntry[];
    };

    // drizzle-kit marks the root snapshot's predecessor with the zero uuid.
    const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
    let previousId: string | null = ZERO_UUID;
    for (const entry of journal.entries) {
      const snapshotFile = path.join(repoDrizzleDir, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`);
      expect(existsSync(snapshotFile), `missing snapshot for journal entry ${entry.tag}`).toBe(true);
      const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8")) as SnapshotHeader;
      expect(snapshot.prevId, `snapshot for ${entry.tag} does not chain to its predecessor`).toBe(previousId);
      previousId = snapshot.id;
    }
  });
});
