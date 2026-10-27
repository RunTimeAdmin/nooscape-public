import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { eventually } from "./eventually";
import { invalidateDirectoryReads, setDirectorySoftQuietMsForTests } from "./readCache";

/**
 * Database-backed tests of the public Solana activity feed. The ledger
 * (`agent_solana_activity`) was written for the Metaplex and 8004 passes but
 * never read; this surface reads it for all three Solana registries. What
 * matters is that it follows exactly the public rules of every other directory
 * read: events for hidden, closed, paused-source, or suppressed-domain entries
 * must never surface, names are sanitized, the join is per source, and a new
 * ledger write shows once the cached feed has reloaded. Runs against a throwaway local
 * MySQL schema built by the project's own boot-time migration runner, and the
 * whole file skips when no database is reachable so the standard no-DB gate
 * stays green.
 */
const TEST_DB = "nooscape_sol_feed_test";
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

describe.skipIf(!dbReachable)("Solana activity feed against a real database", () => {
  type Db = typeof import("./db");
  let db: Db;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;

  const SOURCES = {
    said: { id: "src-said", key: "solana-said-agent-registry", protocol: "solana_said", state: "active" },
    e8004: { id: "src-8004", key: "solana-8004-agent-registry", protocol: "solana_8004", state: "active" },
    meta: { id: "src-meta", key: "metaplex-solana-agent-registry", protocol: "solana_registry", state: "active" },
    paused: { id: "src-paused", key: "paused-solana-source", protocol: "solana_8004", state: "paused" },
    // A registry on Solana whose pass writes no events: it is in the directory and never in the feed.
    agenc: { id: "src-agenc", key: "solana-agenc-agent-registry", protocol: "solana_agenc", state: "active" },
  } as const;

  const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
  const at = (minutes: number) => new Date(T0 + minutes * 60_000);
  const sig = (c: string) => c.repeat(88);

  async function entry(id: string, source: keyof typeof SOURCES, key: string, displayName: string, extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}) {
    await writer.insert(schema.agentDirectoryEntries).values({
      id,
      sourceId: SOURCES[source].id,
      externalKey: key,
      displayName,
      protocol: SOURCES[source].protocol,
      ...extra,
    });
  }

  async function event(id: string, source: keyof typeof SOURCES, key: string, kind: "register" | "transfer" | "profile_update" | "asset_closed", minutes: number, slot = 100) {
    await writer.insert(schema.agentSolanaActivity).values({
      id,
      sourceId: SOURCES[source].id,
      transactionSignature: sig(id.slice(-1)),
      slot,
      externalKey: key,
      kind,
      fromOwner: kind === "transfer" ? "FROMOWNER" : null,
      toOwner: kind === "asset_closed" ? null : "TOOWNER",
      createdAt: at(minutes),
    });
  }

  beforeAll(async () => {
    // The reload starts at the first read after a write, instead of after the production quiet period.
    setDirectorySoftQuietMsForTests(0);
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
    // The boot runner skips the manual migrations, which hold the protocol values of the extra chains (0046) and of AgenC (0051). They are
    // pasted here, as the owner pastes them, so that a source for AgenC can be written.
    const pasted = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version === 46 || f.version === 51)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await pasted.query(statement);
    }
    await pasted.end();

    db = await import("./db");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "sol-feed-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "sol-feed-operator"));
    operatorUserId = operator.id;
    for (const source of Object.values(SOURCES)) {
      await writer.insert(schema.ingestionSources).values({
        id: source.id,
        sourceKey: source.key,
        label: source.key,
        protocol: source.protocol,
        rootUrl: "https://api.mainnet-beta.solana.com",
        allowedHostname: "api.mainnet-beta.solana.com",
        state: source.state,
        createdByUserId: operatorUserId,
      });
    }

    // Visible entries on the three active registries. The same externalKey "K" on two sources must
    // never cross-match: the join is per source.
    await entry("e-said", "said", "K", "SAID agent one");
    await entry("e-8004", "e8004", "K", "8004 agent​ one");
    await entry("e-meta", "meta", "M", "Metaplex agent");
    await entry("e-agenc", "agenc", "A".repeat(44), "AgenC agent one");
    // Entries that must never surface.
    await entry("e-hidden", "said", "H", "Hidden agent", { hidden: true });
    await entry("e-closed", "e8004", "C", "Closed agent", { assetClosedAt: at(0) });
    await entry("e-paused", "paused", "P", "Paused-source agent");
    await entry("e-suppressed", "said", "S", "Suppressed host agent", { locatorHost: "api.agentrank.info" });

    await event("ev-1", "said", "K", "register", 10);
    await event("ev-2", "e8004", "K", "transfer", 20);
    await event("ev-3", "meta", "M", "profile_update", 30);
    await event("ev-4", "said", "K", "transfer", 40);
    await event("ev-5", "said", "H", "register", 50);
    await event("ev-6", "e8004", "C", "asset_closed", 60);
    await event("ev-7", "paused", "P", "register", 70);
    await event("ev-8", "said", "S", "register", 80);
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("returns visible events newest first, with protocol, entry, and a sanitized name", async () => {
    const feed = await db.readSolanaActivityFeed();
    expect(feed.map(e => e.id)).toEqual(["ev-4", "ev-3", "ev-2", "ev-1"]);
    expect(feed.map(e => [e.protocol, e.kind])).toEqual([
      ["solana_said", "transfer"],
      ["solana_registry", "profile_update"],
      ["solana_8004", "transfer"],
      ["solana_said", "register"],
    ]);
    // The zero-width space in the 8004 entry's name is removed for public presentation.
    expect(feed.find(e => e.id === "ev-2")!.displayName).toBe("8004 agent one");
    expect(feed[0]).toMatchObject({ entryId: "e-said", slot: 100, fromOwner: "FROMOWNER", toOwner: "TOOWNER" });
    expect(new Date(feed[0]!.recordedAt).getTime()).toBe(at(40).getTime());
  });

  it("never surfaces events for hidden, closed, paused-source, or suppressed-domain entries", async () => {
    const ids = (await db.readSolanaActivityFeed()).map(e => e.id);
    for (const hiddenEvent of ["ev-5", "ev-6", "ev-7", "ev-8"]) expect(ids).not.toContain(hiddenEvent);
  });

  it("joins per source: the same externalKey on two registries never cross-matches", async () => {
    const feed = await db.readSolanaActivityFeed();
    const saidEvents = feed.filter(e => e.protocol === "solana_said").map(e => e.entryId);
    const e8004Events = feed.filter(e => e.protocol === "solana_8004").map(e => e.entryId);
    expect(new Set(saidEvents)).toEqual(new Set(["e-said"]));
    expect(new Set(e8004Events)).toEqual(new Set(["e-8004"]));
    // Four visible events, not eight: a cross-join would have duplicated the shared key's events.
    expect(feed).toHaveLength(4);
  });

  it("respects a smaller limit and never exceeds the bound", async () => {
    expect((await db.readSolanaActivityFeed(2)).map(e => e.id)).toEqual(["ev-4", "ev-3"]);
    expect((await db.readSolanaActivityFeed(100_000)).length).toBeLessThanOrEqual(db.MAX_SOLANA_ACTIVITY_FEED_EVENTS);
  });

  it("counts events per registry and kind over the same visible entries", async () => {
    expect(await db.readSolanaActivityTotals()).toEqual([
      { protocol: "solana_8004", kind: "transfer", count: 1 },
      { protocol: "solana_registry", kind: "profile_update", count: 1 },
      { protocol: "solana_said", kind: "register", count: 1 },
      { protocol: "solana_said", kind: "transfer", count: 1 },
    ]);
  });

  it("shows a new ledger write once the cached feed has reloaded, because the Solana ledger write marks the cache stale", async () => {
    const before = await db.readSolanaActivityFeed();
    // A row inserted behind the module's back is invisible while the cache is fresh.
    await event("ev-9", "meta", "M", "register", 90);
    expect((await db.readSolanaActivityFeed()).map(e => e.id)).toEqual(before.map(e => e.id));

    // The real ledger write marks the cache stale. The next read is still answered from it, and the
    // reload behind that read sees both the raw row and the new one.
    const metaSource = await db.getIngestionSource(SOURCES.meta.id);
    await db.applySolanaActivityWindow({
      source: metaSource!,
      events: [{ kind: "transfer", externalKey: "M", transactionSignature: sig("z"), slot: 200, fromOwner: "OLD", toOwner: "NEW" }],
    });
    expect((await db.readSolanaActivityFeed()).map(e => e.id)).toEqual(before.map(e => e.id));
    const after = await eventually(() => db.readSolanaActivityFeed(), feed => feed.length === before.length + 2);
    expect(after.map(e => e.id)).toContain("ev-9");
    expect(after.some(e => e.slot === 200 && e.kind === "transfer")).toBe(true);
    expect(after).toHaveLength(before.length + 2);
  });

  it("keeps each registry's newest events in the feed when one registry's batch is newer than all of them", async () => {
    // One pass records 45 SAID registrations: more than the whole feed, and all newer than every 8004 and Metaplex event.
    for (let index = 0; index < 45; index += 1) {
      await writer.insert(schema.agentSolanaActivity).values({
        id: `batch-${index}`,
        sourceId: SOURCES.said.id,
        transactionSignature: `batch${index}`.padEnd(88, "b"),
        slot: 500 + index,
        externalKey: "K",
        kind: "register",
        toOwner: "TOOWNER",
        createdAt: at(200 + index),
      });
    }
    invalidateDirectoryReads();

    const feed = await db.readSolanaActivityFeed();
    const ids = feed.map(e => e.id);
    expect(feed).toHaveLength(db.MAX_SOLANA_ACTIVITY_FEED_EVENTS);
    // The older 8004 and Metaplex events are in, though 45 SAID events are newer; without the floor the feed is all SAID.
    expect(ids).toContain("ev-2");
    expect(ids).toEqual(expect.arrayContaining(["ev-3", "ev-9"]));
    expect(feed.filter(e => e.protocol === "solana_8004").length).toBe(1);
    expect(feed.filter(e => e.protocol === "solana_registry").length).toBe(3);
    // The rest of the feed is the newest of what is left, so an older SAID event stays out, and the list is newest first.
    expect(ids).not.toContain("ev-1");
    expect(ids).toContain("batch-44");
    const times = feed.map(e => new Date(e.recordedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("gives a Solana registry that writes no events no share of the floor and no place in the feed or the totals", async () => {
    // With four registries on Solana the floor of a limit of six would be one a registry. AgenC writes no ledger, so it takes none of it.
    const feed = await db.readSolanaActivityFeed(6);
    expect(feed.some(e => e.protocol === "solana_agenc")).toBe(false);
    expect(feed.filter(e => e.protocol === "solana_registry")).toHaveLength(2);
    expect((await db.readSolanaActivityTotals()).some(row => row.protocol === "solana_agenc")).toBe(false);
  });

  it("keeps fewer of each registry's newest when the limit is small, and still one or two of every registry", async () => {
    const small = await db.readSolanaActivityFeed(6);
    expect(small).toHaveLength(6);
    // A floor of two a registry: the 8004 registry has one event, Metaplex and SAID have two kept each, and one more is the newest left.
    expect(small.filter(e => e.protocol === "solana_8004").map(e => e.id)).toEqual(["ev-2"]);
    expect(small.filter(e => e.protocol === "solana_registry")).toHaveLength(2);
    // Below one a registry the feed is just the newest.
    expect((await db.readSolanaActivityFeed(2)).every(e => e.protocol !== "solana_8004")).toBe(true);
  });
});
