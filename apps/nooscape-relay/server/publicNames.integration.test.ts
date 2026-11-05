import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";

/**
 * The name a public reader shows for an entry whose recorded name is nothing but control, zero-width or bidirectional characters (outside
 * audit of 2026-11-05, finding R17). Three readers used to serve the stored text as it was: the twin on the agent page, the names behind the
 * Owl's Catch and the Robinhood Chain activity feed. Each shows the registries' placeholder now ("Agent #<id>") and a name that has text
 * in it with the invisible characters taken out, and the search keeps the shape of its answer. Against a real database. Skips when no
 * database is reachable.
 */
const TEST_DB = "nooscape_public_names_test";
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
const ZERO = "0x" + "0".repeat(40);
const A = "0x" + "a".repeat(40);
const rhKey = (id: number) => `eip155:4663:${REGISTRY}:${id}`;
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");

/** Bidirectional override, zero-width space and BEL: nothing is left of it once the invisible characters are taken out. */
const BLANK = String.fromCharCode(0x202e, 0x200b, 0x0007);
const DIRTY = `Clean${String.fromCharCode(0)}Name${String.fromCharCode(0x200b)}`;

describe.skipIf(!dbReachable)("the name public readers show for an entry, against a real database", { timeout: 120_000 }, () => {
  type Db = typeof import("./db");
  let db: Db;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;

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

    await writer.insert(schema.users).values({ openId: "public-names-operator", role: "admin" });
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
    const entries = [
      { id: "e-anchor", key: rhKey(1), name: "Anchor agent", host: null },
      { id: "e-blank", key: rhKey(7), name: BLANK, host: "blank.example.org" },
      { id: "e-dirty", key: rhKey(8), name: DIRTY, host: null },
    ];
    for (const entry of entries) {
      await writer.insert(schema.agentDirectoryEntries).values({
        id: entry.id,
        sourceId: "src-rh",
        externalKey: entry.key,
        displayName: entry.name,
        locatorHost: entry.host,
        protocol: "erc8004",
      });
    }
    // The anchor names the blank-named entry as its twin.
    await writer.insert(schema.agentDirectoryChainLinks).values({
      id: "link-1",
      sourceId: "src-rh",
      externalKey: rhKey(1),
      metadataKey: "erc8004-eth",
      linkedProtocol: "erc8004",
      linkedExternalKey: rhKey(7),
      linkedEntryId: "e-blank",
      metadataValueHash: "0".repeat(64),
    });
    const source = (await db.getIngestionSource("src-rh"))!;
    const mint = (key: string, block: number, logIndex: number) => ({
      kind: "mint" as const,
      externalKey: key,
      blockNumber: block,
      transactionHash: tx(block),
      logIndex,
      fromAddress: ZERO,
      toAddress: A,
    });
    await db.applyAgentDirectoryActivityWindow({ source, activity: [mint(rhKey(7), 2_000, 0), mint(rhKey(8), 3_000, 0)] });
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("shows the placeholder on the agent page of an entry whose name is nothing but invisible characters, and the twin on another page", async () => {
    const page = await db.getAgentDirectoryEntry("e-blank");
    expect(page!.displayName).toBe("Agent #7");
    const anchor = await db.getAgentDirectoryEntry("e-anchor");
    expect(anchor!.displayName).toBe("Anchor agent");
    expect(anchor!.twin?.displayName).toBe("Agent #7");
  });

  it("gives the Owl's Catch the placeholder for that entry and the cleaned text for a name that has some", async () => {
    const names = await db.listVisibleDirectoryEntries(["e-anchor", "e-blank", "e-dirty"]);
    expect(names.get("e-anchor")).toBe("Anchor agent");
    expect(names.get("e-blank")).toBe("Agent #7");
    expect(names.get("e-dirty")).toBe("Clean Name");
  });

  it("names the entry in the Robinhood Chain activity feed the same way", async () => {
    const feed = await db.readAgentDirectoryActivityFeed();
    const named = new Map(feed.map(event => [event.entryId, event.displayName]));
    expect(named.get("e-blank")).toBe("Agent #7");
    expect(named.get("e-dirty")).toBe("Clean Name");
  });

  it("names the entry in search results the same way, and keeps the answer's shape (the key stays inside)", async () => {
    const { entries } = await db.searchAgentDirectory({ query: "blank.example.org", limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.displayName).toBe("Agent #7");
    expect(entries[0]).not.toHaveProperty("externalKey");
    expect(entries[0]).not.toHaveProperty("sourceId");
  });
});
