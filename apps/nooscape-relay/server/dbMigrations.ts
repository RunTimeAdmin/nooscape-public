import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createConnection } from "mysql2/promise";

/**
 * Boot-time schema migrations. Replaces the one-off operator-gated "migration
 * bridge" tRPC mutations used for 0011-0014 (add, verify, remove): deploys now
 * apply pending migrations deterministically before the server accepts
 * traffic, so code that assumes a column/index can never ship ahead of the
 * schema change that provides it.
 *
 * Bookkeeping lives in a dedicated `nooscape_schema_migrations` table. The
 * pre-runner history (0000-0014, applied by hand through drizzle-kit, the
 * Hostinger panel, and the spent bridges) is stamped as applied on the first
 * boot and never re-executed; only migrations with a version above the
 * baseline are applied by this runner.
 */

/** Highest migration version applied by hand before this runner shipped. */
const BASELINE_VERSION = 14;

/**
 * Migrations the boot runner never applies. An operator applies each by hand, when they choose, by pasting its file
 * into the host's SQL console. The file stays in the drizzle folder, the journal and the snapshot chain, so
 * drizzle-kit's picture of the schema stays whole.
 *
 * 36: `owls_catch`, the Owl's Catch table (docs/owls-catch-2026-10-15.md, "The migration (0036) is run by hand").
 * 37: `agent_checks`, what Nooscape-Checker found when it asked an endpoint (docs/agent-checks-2026-10-16.md, "The migration (0037) is run by hand").
 * 38: `bsc_clusters` and `bsc_entry_evidence`, the fleets and templates of the BNB Chain registry (docs/bsc-clusters-2026-10-16.md, "The migration (0038) is run by hand").
 * 39: `bsc_feedback_events`, `bsc_rater_evidence` and `bsc_reputation_state`, the BNB Chain reputation feedback and the rater check (docs/bsc-rater-credibility-2026-10-16.md, "The migration (0039) is run by hand").
 * 40: `bsc_endpoint_host_groups`, the hosts that 50 or more listed BNB entries declare as their agent address host (docs/bsc-clusters-2026-10-16.md, "Endpoint-host groups").
 * 41: an index on `agent_directory_entries.firstSeenAt`, for the home page's "new in the last day" counts (docs/new-to-the-owl-2026-10-17.md, "The migration (0041) is run by hand").
 * 42: `agent_claim_nonces`, `agent_claims` and `agent_claim_edits`, the owner claim flow (docs/claims-2026-10-18.md, "The migration (0042) is run by hand").
 * 46: the `erc8004_base`, `erc8004_eth` and `erc8004_arc` protocol values on the four tables that carry the protocol list, for the Base, Ethereum and Arc identity passes (docs/multichain-erc8004-2026-10-20.md, "The migration (0046) is run by hand").
 * 49: drops `ingestion_worker_config`.`tickSeconds`, which the operator console set and nothing read (docs/worker-operations.md). The code no longer names it and runs the same with or without the column, so the operator runs this when it suits.
 * 51: the `solana_agenc` protocol value on the four tables that carry the protocol list, for the AgenC registry pass (docs/agenc-solana-2026-10-26.md, "The migration (0051) is run by hand"). It restates the whole list, which ends with the 0046 values, so it needs 0046 first.
 */
export const MANUAL_MIGRATIONS: readonly number[] = [36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 49, 51];

/**
 * Versions an operator recorded by hand under a name other than their file's, and left so. The runner counts a recorded version as applied and
 * skips its file, so a recorded name that is not the file's means the file never ran; every difference but these stops the boot.
 *
 * 47: `0047_base_scheduled_flip`, the Base flip the operator applied by hand on 20 October 2026, whose file was never merged. The host cap's
 * `0047_registry_overflow_counts` was skipped for it and its table created by hand (docs/flood-host-cap-2026-10-21.md, "What went wrong at the deploy").
 */
const RECORDED_UNDER_ANOTHER_NAME: Readonly<Record<number, string>> = { 47: "0047_base_scheduled_flip" };

const MIGRATIONS_TABLE = "nooscape_schema_migrations";

const withoutExtension = (name: string) => name.replace(/\.sql$/i, "");

/** Default migrations folder. The server runs with the app root as cwd. */
function defaultMigrationsDir() {
  return path.resolve(process.cwd(), "drizzle");
}

interface MigrationFile {
  version: number;
  /** Full file name including the version prefix, e.g. "0015_directory_entry_hidden.sql". */
  name: string;
  /** Absolute path to the .sql file. */
  file: string;
}

/** Parses the `NNNN_` version prefix of a drizzle migration file name. */
export function parseMigrationVersion(fileName: string): number | null {
  const match = /^(\d+)_/.exec(fileName);
  return match ? Number(match[1]) : null;
}

/**
 * Splits a drizzle migration file into executable statements on the
 * `--> statement-breakpoint` markers. Hand-review notes are written as `---`
 * lines, which MySQL does not accept as comments (its `--` comment form needs
 * a following space), so comment lines are stripped before execution.
 */
export function splitMigrationStatements(content: string): string[] {
  const statements: string[] = [];
  const chunks = content.split("--> statement-breakpoint");
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/).filter(line => !line.trimStart().startsWith("--"));
    const statement = lines.join("\n").trim();
    if (statement.length > 0) {
      statements.push(statement);
    }
  }
  return statements;
}

/** Lists migration files from a directory in ascending version order. */
export async function collectMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = await readdir(dir);
  const files: MigrationFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".sql")) continue;
    const version = parseMigrationVersion(name);
    if (version === null) continue;
    files.push({ version, name, file: path.join(dir, name) });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

/** How long a boot waits for another process that is applying migrations before it gives up and fails the start. */
const MIGRATION_LOCK_WAIT_SECONDS = 60;

/**
 * MySQL lock names are shared by the whole server, so the database is part of the name: two databases on one server do not wait
 * for each other. A lock name is at most 64 characters.
 */
export function migrationLockName(databaseUrl: string): string {
  let database = "";
  try {
    database = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    // A URL that does not parse cannot connect either; the lock name only needs to be stable.
  }
  return `nooscape_migrations:${database}`.slice(0, 64);
}

/**
 * Applies every migration above the recorded baseline, in ascending version
 * order, each inside its own statement sequence followed by a bookkeeping
 * insert. Returns the file names applied this boot (empty when current).
 * Throws on the first failure so the caller can refuse to serve traffic
 * against a stale schema — a half-applied migration fails the boot loudly
 * instead of leaving the API silently failing closed. A version that is recorded under another file's name fails it too (the file would be
 * skipped as applied and never run), except the one reviewed case in RECORDED_UNDER_ANOTHER_NAME. The manual migrations
 * (MANUAL_MIGRATIONS) are left for an operator and are never applied here.
 */
export async function applyPendingMigrations(databaseUrl: string, migrationsDir = defaultMigrationsDir(), lockWaitSeconds = MIGRATION_LOCK_WAIT_SECONDS): Promise<string[]> {
  const connection = await createConnection(databaseUrl);
  const lockName = migrationLockName(databaseUrl);
  let locked = false;
  try {
    // Only one process applies migrations at a time. A second one waits here and then finds them applied.
    const [lockRows] = (await connection.query("SELECT GET_LOCK(?, ?) AS acquired", [lockName, lockWaitSeconds])) as [Array<{ acquired: number | string | null }>, unknown];
    if (Number(lockRows?.[0]?.acquired) !== 1) {
      throw new Error("Could not take the migration lock: another process is applying migrations. Start again in a minute.");
    }
    locked = true;
    await connection.query(
      `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (` +
        " `version` int NOT NULL," +
        " `name` varchar(255) NOT NULL," +
        " `appliedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP," +
        ` PRIMARY KEY (\`version\`)` +
        ")"
    );
    const [rows] = (await connection.query(`SELECT \`version\`, \`name\` FROM \`${MIGRATIONS_TABLE}\``)) as [Array<{ version: number; name?: string }>, unknown];
    const appliedRows = (Array.isArray(rows) ? rows : []) as Array<{ version: number; name?: string }>;
    const applied = new Set<number>();
    const recordedAs = new Map<number, string>();
    for (const row of appliedRows) {
      applied.add(Number(row.version));
      if (typeof row.name === "string") recordedAs.set(Number(row.version), row.name);
    }
    const files = await collectMigrationFiles(migrationsDir);
    // A version recorded under another file's name would be skipped as applied and its file would never run. Nothing is applied until that is fixed.
    const skipped = files.filter(file => {
      const recorded = recordedAs.get(file.version);
      if (recorded === undefined || file.version <= BASELINE_VERSION || MANUAL_MIGRATIONS.includes(file.version)) return false;
      const recordedName = withoutExtension(recorded);
      return recordedName !== withoutExtension(file.name) && recordedName !== RECORDED_UNDER_ANOTHER_NAME[file.version];
    });
    if (skipped.length > 0) {
      const lines = skipped.map(file => `version ${file.version} is recorded as "${recordedAs.get(file.version)}" and its file is "${file.name}"`);
      throw new Error(
        `The migration log disagrees with the migration files: ${lines.join("; ")}. A version that is recorded counts as applied, so that file would never run. ` +
          "Run the file by hand and correct the log row, or rename the file, and start again."
      );
    }
    if (applied.size === 0) {
      // First boot with this runner: stamp the hand-applied history so the
      // bookkeeping table reflects the full schema story.
      for (const file of files) {
        if (file.version > BASELINE_VERSION) continue;
        await connection.query(
          `INSERT IGNORE INTO \`${MIGRATIONS_TABLE}\` (\`version\`, \`name\`) VALUES (?, ?)`,
          [file.version, file.name]
        );
      }
      console.log(`[Migrations] Stamped baseline: versions 0000-${BASELINE_VERSION} were applied by hand before this runner shipped.`);
    }
    const appliedNames: string[] = [];
    for (const file of files) {
      if (applied.has(file.version)) continue;
      // Baseline migrations were applied by hand before this runner shipped;
      // they are never replayed, whatever the bookkeeping table contains.
      if (file.version <= BASELINE_VERSION) continue;
      // Manual migrations wait for an operator, whatever the bookkeeping table contains.
      if (MANUAL_MIGRATIONS.includes(file.version)) continue;
      const content = await readFile(file.file, "utf8");
      for (const statement of splitMigrationStatements(content)) {
        await connection.query(statement);
      }
      await connection.query(`INSERT INTO \`${MIGRATIONS_TABLE}\` (\`version\`, \`name\`) VALUES (?, ?)`, [file.version, file.name]);
      appliedNames.push(file.name);
    }
    return appliedNames;
  } finally {
    if (locked) {
      // Ending the connection releases the lock as well; this is only so it is not held while the connection closes.
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => undefined);
    }
    await connection.end();
  }
}
