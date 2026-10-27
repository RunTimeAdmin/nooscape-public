import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool, type Connection } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";

/**
 * The agent page's parts that may come back empty (its twin, activity, ratings and registration read), against a real database. A part
 * whose table is not there yet is left unmeasured, quietly, as before. A part that fails for any other reason is left unmeasured too,
 * and the log says which part and why, without the query's parameters: a timeout must not pass for missing data. Skips when no
 * database is reachable.
 */
const TEST_DB = "nooscape_entry_sections_test";
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

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const ENTRY_ID = "e-rh-1";

describe.skipIf(!dbReachable)("the agent page when a part of it cannot be read", () => {
  let db: typeof import("./db");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let ddl: Connection;

  /** Runs `body` with the twin table taken away and `replacement` (if any) in its place, and puts it back afterwards. */
  async function withTwinTable(replacement: string | null, body: () => Promise<void>) {
    await ddl.query("RENAME TABLE agent_directory_chain_links TO agent_directory_chain_links_held");
    try {
      if (replacement) await ddl.query(replacement);
      await body();
    } finally {
      await ddl.query("DROP VIEW IF EXISTS agent_directory_chain_links");
      await ddl.query("RENAME TABLE agent_directory_chain_links_held TO agent_directory_chain_links");
    }
  }

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

    db = await import("./db");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    ddl = await createConnection(process.env.DATABASE_URL);

    await writer.insert(schema.users).values({ openId: "entry-sections-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users);
    await writer.insert(schema.ingestionSources).values({
      id: "src-rh",
      sourceKey: "robinhood-erc8004-identity-registry",
      label: "Robinhood Chain ERC-8004 identity registry",
      protocol: "erc8004",
      rootUrl: "https://rpc.mainnet.chain.robinhood.com",
      allowedHostname: "rpc.mainnet.chain.robinhood.com",
      state: "active",
      createdByUserId: operator!.id,
    });
    await writer.insert(schema.agentDirectoryEntries).values({
      id: ENTRY_ID,
      sourceId: "src-rh",
      externalKey: `eip155:4663:${REGISTRY}:1`,
      displayName: "Robinhood agent one",
      protocol: "erc8004",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await ddl?.end();
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("gives a page head its name and protocol from one row, under the same visibility rule as the full read", async () => {
    expect(await db.readAgentDirectoryHeadFacts(ENTRY_ID)).toEqual({ displayName: "Robinhood agent one", protocol: "erc8004" });
    expect(await db.readAgentDirectoryHeadFacts("no-such-entry")).toBeNull();
    await ddl.query("UPDATE agent_directory_entries SET hidden = true WHERE id = ?", [ENTRY_ID]);
    try {
      expect(await db.readAgentDirectoryHeadFacts(ENTRY_ID)).toBeNull();
      expect(await db.getAgentDirectoryEntry(ENTRY_ID)).toBeNull();
    } finally {
      await ddl.query("UPDATE agent_directory_entries SET hidden = false WHERE id = ?", [ENTRY_ID]);
    }
    await ddl.query("UPDATE ingestion_sources SET state = 'paused' WHERE id = 'src-rh'");
    try {
      expect(await db.readAgentDirectoryHeadFacts(ENTRY_ID)).toBeNull();
    } finally {
      await ddl.query("UPDATE ingestion_sources SET state = 'active' WHERE id = 'src-rh'");
    }
  });

  it("serves the entry and says nothing when nothing is wrong", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entry = await db.getAgentDirectoryEntry(ENTRY_ID);
    expect(entry).not.toBeNull();
    expect(entry!.twin).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves the twin unmeasured and says nothing when its table is not there yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withTwinTable(null, async () => {
      const entry = await db.getAgentDirectoryEntry(ENTRY_ID);
      expect(entry).not.toBeNull();
      expect(entry!.displayName).toBe("Robinhood agent one");
      expect(entry!.twin).toBeNull();
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves the twin unmeasured and says which part failed and why when the failure is anything else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A table that answers with an error instead of rows: one row per entry whose link column is a scalar subquery that returns two
    // rows (ER_SUBQUERY_NO_1_ROW). It is built on the entries so that the read's own filters match, and the failing column is reached.
    const failing =
      "CREATE VIEW agent_directory_chain_links AS SELECT e.sourceId AS sourceId, e.externalKey AS externalKey, 'p' AS linkedProtocol, 'm' AS metadataKey, 'l' AS linkedExternalKey, (SELECT 1 UNION ALL SELECT 2) AS linkedEntryId, NOW() AS discoveredAt FROM agent_directory_entries e";
    await withTwinTable(failing, async () => {
      const entry = await db.getAgentDirectoryEntry(ENTRY_ID);
      expect(entry).not.toBeNull();
      expect(entry!.twin).toBeNull();
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.join(" ");
    expect(line).toContain("[LiveData] Entry twin could not be read:");
    expect(line).toContain("ER_SUBQUERY_NO_1_ROW");
    // Drizzle appends the parameters to its message; the line is made without them.
    expect(line).not.toContain("params:");
    expect(line).not.toContain("src-rh");
  });
});
