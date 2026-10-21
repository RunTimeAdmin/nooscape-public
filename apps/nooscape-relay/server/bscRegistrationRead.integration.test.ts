import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * The registration read on a BNB entry's page (docs/approvals/2026-10-18-bnb-checked-unproven.md), against a real database and
 * through the public procedure the page reads: checked only for a read of the link the entry carries now, with its date; "not
 * checked" for every other listed BNB entry, before the migration is run and for each status that is not a read; no field at all for
 * another protocol's entry; nothing internal in the answer; null, not a guess, when the read itself fails. Skips when no database is
 * reachable. The rule is in bscRegistrationRead.test.ts and the words in client/src/lib/registrationReadText.test.ts.
 */
const TEST_DB = "nooscape_registration_read_test";
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

const HASH = (letter: string) => letter.repeat(64);
const READ_AT = new Date("2026-10-16T12:00:00Z");

describe.skipIf(!dbReachable)("a BNB entry's registration read against a real database", { timeout: 60_000 }, () => {
  let appRouter: typeof import("./routers").appRouter;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;
  let pasteMigration: () => Promise<void>;
  let n = 0;

  const profile = (id: string) => appRouter.createCaller({ req: {}, res: {}, user: null } as unknown as TrpcContext).liveData.agentProfile({ id });
  async function source(id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"], state: "active" | "paused" = "active") {
    await writer.insert(schema.ingestionSources).values({ id, sourceKey: `read-${id}`, label: id, protocol, rootUrl: "https://read.example/feed", allowedHostname: "read.example", state, createdByUserId: operatorUserId });
  }
  /** A listed entry on a source, with the hash of the link it carries; its id, and the key evidence rows are made for. */
  async function entry(sourceId: string, protocol: "erc8004_bsc" | "erc8004", profileUriHash: string | null) {
    n += 1;
    const id = `read-entry-${n}`;
    const externalKey = `bsc:56:${n}`;
    await writer.insert(schema.agentDirectoryEntries).values({ id, sourceId, externalKey, displayName: `Entry ${n}`, protocol, profileUriHash, registrant: `0x${String(n).padStart(40, "0")}` });
    return { id, externalKey };
  }
  const evidence = (sourceId: string, externalKey: string, readStatus: string, profileUriHash: string, readAt: Date = READ_AT) =>
    writer.insert(schema.bscEntryEvidence).values({ id: `ev-${externalKey}`.slice(0, 36), sourceId, externalKey, profileUriHash, readStatus, g1: "independent", templateSize: 1, walletRegistrations: 1, readAt, computedAt: readAt });

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
    // The BNB Chain tables are a manual migration, so a boot does not make them: run the file as the owner would paste it.
    pasteMigration = async () => {
      const paste = await createConnection(process.env.DATABASE_URL!);
      for (const statement of splitMigrationStatements(await readFile("drizzle/0038_bsc_clusters.sql", "utf8"))) await paste.query(statement);
      await paste.end();
    };

    appRouter = (await import("./routers")).appRouter;
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "read-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "read-operator"));
    operatorUserId = operator!.id;
    await source("src-bnb", "erc8004_bsc");
    await source("src-rh", "erc8004");
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("says not checked before the evidence table exists, since nothing has been read", async () => {
    const bnb = await entry("src-bnb", "erc8004_bsc", HASH("a"));
    const answer = await profile(bnb.id);
    expect(answer.kind).toBe("acknowledged");
    expect(answer.entry).toMatchObject({ registrationRead: { checked: false, readAt: null } });
  });

  it("says checked, with the date, for a registration decoded from the link or read from the file the link names", async () => {
    await pasteMigration();
    const inline = await entry("src-bnb", "erc8004_bsc", HASH("b"));
    const fetched = await entry("src-bnb", "erc8004_bsc", HASH("c"));
    await evidence("src-bnb", inline.externalKey, "inline", HASH("b"), new Date("2026-10-16T12:00:00Z"));
    await evidence("src-bnb", fetched.externalKey, "fetched", HASH("c"), new Date("2026-10-18T01:20:00Z"));
    const a = (await profile(inline.id)).entry!;
    const b = (await profile(fetched.id)).entry!;
    expect(a.registrationRead).toEqual({ checked: true, readAt: new Date("2026-10-16T12:00:00Z") });
    expect(b.registrationRead).toEqual({ checked: true, readAt: new Date("2026-10-18T01:20:00Z") });
  });

  it("says not checked for every status that is not a read, for no row, for a read of an older link and for an entry with no link hash", async () => {
    for (const [status, letter] of [["link_not_read", "d"], ["link_failed_2", "e"], ["link_unparsed_1", "f"], ["link_not_fetchable", "g"], ["unreadable", "h"]] as const) {
      const row = await entry("src-bnb", "erc8004_bsc", HASH(letter));
      await evidence("src-bnb", row.externalKey, status, HASH(letter));
      expect((await profile(row.id)).entry!.registrationRead, status).toEqual({ checked: false, readAt: null });
    }
    const none = await entry("src-bnb", "erc8004_bsc", HASH("i"));
    expect((await profile(none.id)).entry!.registrationRead).toEqual({ checked: false, readAt: null });
    const stale = await entry("src-bnb", "erc8004_bsc", HASH("j"));
    await evidence("src-bnb", stale.externalKey, "inline", HASH("z"));
    expect((await profile(stale.id)).entry!.registrationRead).toEqual({ checked: false, readAt: null });
    const unhashed = await entry("src-bnb", "erc8004_bsc", null);
    await evidence("src-bnb", unhashed.externalKey, "inline", HASH("k"));
    expect((await profile(unhashed.id)).entry!.registrationRead).toEqual({ checked: false, readAt: null });
  });

  it("has no such field on another protocol's entry, and returns nothing internal on a BNB one", async () => {
    const rh = await entry("src-rh", "erc8004", HASH("m"));
    await evidence("src-rh", rh.externalKey, "inline", HASH("m"));
    const other = (await profile(rh.id)).entry!;
    expect(Object.keys(other)).not.toContain("registrationRead");
    const bnb = await entry("src-bnb", "erc8004_bsc", HASH("n"));
    await evidence("src-bnb", bnb.externalKey, "inline", HASH("n"));
    const keys = Object.keys((await profile(bnb.id)).entry!);
    expect(keys).toContain("registrationRead");
    for (const internal of ["sourceId", "externalKey", "profileUriHash"]) expect(keys, internal).not.toContain(internal);
  });

  it("does not change the entry: it is still acknowledged, listed as before, with no tier and no record", async () => {
    const bnb = await entry("src-bnb", "erc8004_bsc", HASH("o"));
    await evidence("src-bnb", bnb.externalKey, "fetched", HASH("o"));
    const answer = await profile(bnb.id);
    expect(answer).toMatchObject({ kind: "acknowledged", record: null, checks: [] });
    expect(answer.entry).toMatchObject({ protocol: "erc8004_bsc" });
    expect(Object.keys(answer.entry!)).not.toContain("evidenceTier");
  });

  it("answers null, not a guess, when the read itself fails, and still returns the entry", async () => {
    const bnb = await entry("src-bnb", "erc8004_bsc", HASH("p"));
    await evidence("src-bnb", bnb.externalKey, "inline", HASH("p"));
    const pool = createPool(process.env.DATABASE_URL!);
    try {
      await pool.query("ALTER TABLE bsc_entry_evidence RENAME COLUMN readAt TO readAtMoved");
      const answer = await profile(bnb.id);
      expect(answer.kind).toBe("acknowledged");
      expect(answer.entry).toMatchObject({ displayName: expect.any(String), registrationRead: null });
    } finally {
      await pool.query("ALTER TABLE bsc_entry_evidence RENAME COLUMN readAtMoved TO readAt").catch(() => {});
      await pool.end();
    }
    expect((await profile(bnb.id)).entry!.registrationRead).toMatchObject({ checked: true });
  });
});
