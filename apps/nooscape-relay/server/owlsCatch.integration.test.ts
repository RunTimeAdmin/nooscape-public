import { eq, inArray, like } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FLEET_MIN } from "@shared/noosphere";
import { MAX_AGENT_IDS, NOVELTY_DAYS, parseFacts, viewOf, type CatchRow } from "@shared/owlsCatch";
import * as schema from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * The Owl's Catch against a real database: the migration that creates its table, which fleets may be featured
 * (nothing hidden, closed, on a suppressed host or in a paused source ever is), a day decided once, a fleet
 * featured one day and not again for a month, milestones, two workers choosing the same day, an identity hidden
 * after its catch was chosen no longer shown, and the public reads failing closed when the table is not there. The rules and the words are in owlsCatch.test.ts. Skips when no
 * database is reachable.
 */
const TEST_DB = "nooscape_owls_catch_test";
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

const at = (day: string) => new Date(`${day}T00:20:00Z`);
const day = (offset: number) => new Date(Date.UTC(2026, 9, 1 + offset, 0, 20)).toISOString().slice(0, 10);

describe.skipIf(!dbReachable)("the Owl's Catch against a real database", { timeout: 60_000 }, () => {
  type Db = typeof import("./db");
  let db: Db;
  let catchDb: typeof import("./owlsCatch");
  let readCache: typeof import("./readCache");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;
  let appRouter: typeof import("./routers").appRouter;

  async function source(id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"], state: "active" | "paused") {
    await writer.insert(schema.ingestionSources).values({ id, sourceKey: `catch-${id}`, label: id, protocol, rootUrl: "https://catch.example/feed", allowedHostname: "catch.example", state, createdByUserId: operatorUserId });
  }

  /** `count` entries of one wallet, first seen a minute apart so their order is known. */
  async function fleet(sourceId: string, registrant: string, count: number, extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}, hiddenFrom = Number.POSITIVE_INFINITY) {
    const rows = Array.from({ length: count }, (_, index) => ({
      id: `${registrant}-${String(index).padStart(3, "0")}`,
      sourceId,
      externalKey: `key-${registrant}-${index}`,
      displayName: `Entry ${registrant} ${index}`,
      protocol: "erc8004" as const,
      registrant,
      locatorHost: "fleet.example.org",
      firstSeenAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
      hidden: index >= hiddenFrom,
      ...extra,
    }));
    await writer.insert(schema.agentDirectoryEntries).values(rows);
  }

  const rowOn = async (date: string) => {
    const [row] = await writer.select().from(schema.owlsCatch).where(eq(schema.owlsCatch.catchDate, date));
    return row;
  };
  const rowsInTable = async () => (await writer.select().from(schema.owlsCatch)).length;
  const toCatchRow = (row: typeof schema.owlsCatch.$inferSelect): CatchRow => ({ catchDate: row.catchDate, rule: row.rule, facts: row.facts, sourceQuery: row.sourceQuery, agentIds: row.agentIds, selectedAt: row.selectedAt });
  const fresh = () => readCache.invalidateDirectoryReads();
  const caller = () => appRouter.createCaller({ user: null, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext);

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
    // The table is a manual migration, so the boot does not make it: run the file as the owner would paste it.
    const manualMigration = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0036_owls_catch.sql", "utf8"))) await manualMigration.query(statement);
    // Migration 0046 is manual too: it adds Arc's protocol to the four tables.
    for (const statement of splitMigrationStatements(await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8"))) await manualMigration.query(statement);
    await manualMigration.end();

    db = await import("./db");
    catchDb = await import("./owlsCatch");
    readCache = await import("./readCache");
    appRouter = (await import("./routers")).appRouter;
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "catch-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "catch-operator"));
    operatorUserId = operator.id;

    await source("src-live", "erc8004", "active");
    await source("src-paused", "erc8004", "paused");
    // Two fleets that may be featured: 70 and 60 visible identities.
    await fleet("src-live", "0xfleetA", 70);
    await fleet("src-live", "0xfleetB", 60);
    // Four the public must never see, each with enough identities to be the largest: hidden, closed, on a suppressed host, in a paused source.
    await fleet("src-live", "0xhidden", 120, {}, 0);
    await fleet("src-live", "0xclosed", 110, { assetClosedAt: new Date() });
    await fleet("src-live", "0xsuppressed", 100, { locatorHost: "api.agentrank.info" });
    await fleet("src-paused", "0xpaused", 90);
    // 52 identities, ten of them hidden: 42 are visible, under the fleet minimum.
    await fleet("src-live", "0xfleetD", 52, {}, 42);
    // A wallet with fewer than the fleet minimum, and entries with no wallet. Together with the fleets above the
    // chain shows 321 visible entries: no round number it has just passed, so the first catches here are fleets.
    await fleet("src-live", "0xsmall", FLEET_MIN - 1);
    await writer.insert(schema.agentDirectoryEntries).values(Array.from({ length: 100 }, (_, index) => ({ id: `nowallet-${index}`, sourceId: "src-live", externalKey: `key-nowallet-${index}`, displayName: `No wallet ${index}`, protocol: "erc8004" as const })));
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  describe("the migration", () => {
    it("makes the table the code relies on: its columns, none of them null, and a unique date", async () => {
      const probe = await createConnection(process.env.DATABASE_URL!);
      const [columns] = (await probe.query("SHOW COLUMNS FROM `owls_catch`")) as [Array<{ Field: string; Type: string; Null: string }>, unknown];
      const [indexes] = (await probe.query("SHOW INDEX FROM `owls_catch`")) as [Array<{ Key_name: string; Column_name: string; Non_unique: number }>, unknown];
      await probe.end();
      expect(columns.map(column => column.Field)).toEqual(["id", "catchDate", "rule", "facts", "sourceQuery", "agentIds", "selectedAt"]);
      expect(columns.every(column => column.Null === "NO")).toBe(true);
      expect(indexes.filter(index => index.Key_name === "owls_catch_date_uq" && index.Column_name === "catchDate" && index.Non_unique === 0)).toHaveLength(1);
    });

    it("can be run again by hand without error and without touching a row (CREATE TABLE IF NOT EXISTS)", async () => {
      await writer.insert(schema.owlsCatch).values({ id: "kept-row", catchDate: "2025-01-01", rule: "none", facts: "{}", sourceQuery: "test", agentIds: "[]" });
      const { splitMigrationStatements } = await import("./dbMigrations");
      const probe = await createConnection(process.env.DATABASE_URL!);
      for (const statement of splitMigrationStatements(await readFile("drizzle/0036_owls_catch.sql", "utf8"))) await probe.query(statement);
      await probe.end();
      expect(await rowOn("2025-01-01")).toMatchObject({ id: "kept-row", rule: "none" });
      await writer.delete(schema.owlsCatch).where(eq(schema.owlsCatch.id, "kept-row"));
    });

    it("holds one row for a date: a second row for the same date is refused", async () => {
      await writer.insert(schema.owlsCatch).values({ id: "one", catchDate: "2025-01-02", rule: "none", facts: "{}", sourceQuery: "test", agentIds: "[]" });
      await expect(writer.insert(schema.owlsCatch).values({ id: "two", catchDate: "2025-01-02", rule: "none", facts: "{}", sourceQuery: "test", agentIds: "[]" })).rejects.toThrow();
      await writer.delete(schema.owlsCatch).where(eq(schema.owlsCatch.catchDate, "2025-01-02"));
    });
  });

  describe("what a fleet is made of", () => {
    it("is only what the public may see: the wallet list leaves out hidden, closed, suppressed and paused entries, and a wallet with none left", async () => {
      fresh();
      const wallets = await db.listAgentDirectoryWallets(40);
      const names = wallets.map(wallet => wallet.registrant);
      for (const never of ["0xhidden", "0xclosed", "0xsuppressed", "0xpaused"]) expect(names, never).not.toContain(never);
      expect(wallets.find(wallet => wallet.registrant === "0xfleetA")).toMatchObject({ agentCount: 70, dominantHost: "fleet.example.org" });
      expect(wallets.find(wallet => wallet.registrant === "0xfleetD")!.agentCount).toBe(42);
    });

    it("gives the ids of a fleet's visible entries, a fixed number of them, in the order they were first seen", async () => {
      const ids = await db.listVisibleDirectoryEntryIdsForRegistrant("0xfleetA", MAX_AGENT_IDS);
      expect(ids).toEqual(Array.from({ length: MAX_AGENT_IDS }, (_, index) => `0xfleetA-${String(index).padStart(3, "0")}`));
      expect(await db.listVisibleDirectoryEntryIdsForRegistrant("0xfleetA", 3)).toHaveLength(3);
    });

    it("gives none for a wallet whose entries are all out of sight, and none of a hidden entry for one with some", async () => {
      for (const never of ["0xhidden", "0xclosed", "0xsuppressed", "0xpaused", "0xnobody"]) expect(await db.listVisibleDirectoryEntryIdsForRegistrant(never, MAX_AGENT_IDS), never).toEqual([]);
      const visibleOfD = await db.listVisibleDirectoryEntryIdsForRegistrant("0xfleetD", 100);
      expect(visibleOfD).toHaveLength(42);
      expect(visibleOfD.every(id => Number(id.slice(-3)) < 42)).toBe(true);
    });
  });

  describe("which entries the public may see now", () => {
    it("says which of a list of entries are visible now, with the name each is recorded under, and none for an empty list or an id that is no entry", async () => {
      const asked = ["0xfleetA-000", "0xfleetD-041", "0xfleetD-042", "0xhidden-000", "0xclosed-000", "0xsuppressed-000", "0xpaused-000", "no-such-entry"];
      const found = await db.listVisibleDirectoryEntries(asked);
      expect(Array.from(found.keys()).sort()).toEqual(["0xfleetA-000", "0xfleetD-041"]);
      expect(found.get("0xfleetA-000")).toBe("Entry 0xfleetA 0");
      expect(found.get("0xfleetD-041")).toBe("Entry 0xfleetD 41");
      expect((await db.listVisibleDirectoryEntries([])).size).toBe(0);
    });
  });

  describe("choosing the day's catch", () => {
    it("chooses the largest fleet the public may see on the first day, and stores the values its words are made from", async () => {
      fresh();
      expect(await catchDb.selectTodaysCatch(at(day(0)))).toEqual({ date: day(0), status: "selected" });
      const row = (await rowOn(day(0)))!;
      expect(row.rule).toBe("fleet");
      expect(parseFacts("fleet", row.facts)).toEqual({ registrant: "0xfleetA", agentCount: 70, dominantHost: "fleet.example.org" });
      expect(JSON.parse(row.agentIds)).toEqual(Array.from({ length: MAX_AGENT_IDS }, (_, index) => `0xfleetA-${String(index).padStart(3, "0")}`));
      expect(row.sourceQuery).toContain("grouped by registering wallet");
      const view = viewOf(toCatchRow(row))!;
      expect(view.headline).toBe("One registering wallet is recorded against 70 identities.");
      expect(view.detail).toContain("fleet.example.org");
    });

    it("decides a day once: the second call finds the row, and nothing that changes in the meantime changes the day", async () => {
      const before = await rowOn(day(0));
      await writer.update(schema.agentDirectoryEntries).set({ hidden: true }).where(eq(schema.agentDirectoryEntries.registrant, "0xfleetA"));
      fresh();
      expect(await catchDb.selectTodaysCatch(at(day(0)))).toEqual({ date: day(0), status: "kept" });
      expect(await rowOn(day(0))).toEqual(before);
      expect(await rowsInTable()).toBe(1);
      await writer.update(schema.agentDirectoryEntries).set({ hidden: false }).where(eq(schema.agentDirectoryEntries.registrant, "0xfleetA"));
      fresh();
    });

    it("chooses a different fleet the next day, and a day with nothing left to say is stored as none", async () => {
      expect(await catchDb.selectTodaysCatch(at(day(1)))).toEqual({ date: day(1), status: "selected" });
      expect(parseFacts("fleet", (await rowOn(day(1)))!.facts)).toMatchObject({ registrant: "0xfleetB", agentCount: 60 });
      // Both fleets have been featured, and the rest are under the minimum or out of sight.
      expect(await catchDb.selectTodaysCatch(at(day(2)))).toEqual({ date: day(2), status: "none" });
      expect(await rowOn(day(2))).toMatchObject({ rule: "none", facts: "{}", agentIds: "[]" });
      expect(viewOf(toCatchRow((await rowOn(day(2)))!))).toBeNull();
    });

    it("features a fleet again only after thirty days, and never one of the wallets the public may not see, in seventy days", async () => {
      expect(NOVELTY_DAYS).toBe(30);
      const featured: string[] = [];
      for (let offset = 3; offset < 70; offset += 1) {
        const result = await catchDb.selectTodaysCatch(at(day(offset)));
        const stored = (await rowOn(day(offset)))!;
        if (result.status === "selected") featured.push(`${offset}:${(parseFacts("fleet", stored.facts) as { registrant: string }).registrant}`);
      }
      // A was featured on day 0 and is next eligible on day 30; B on day 1 and day 31; then A on day 60 and B on day 61.
      expect(featured).toEqual(["30:0xfleetA", "31:0xfleetB", "60:0xfleetA", "61:0xfleetB"]);
      for (const never of ["0xhidden", "0xclosed", "0xsuppressed", "0xpaused", "0xfleetD", "0xsmall"]) expect(featured.join(), never).not.toContain(never);
    });

    it("stores a fleet only with something to link to: one whose entries have all gone out of sight is passed over for the next", async () => {
      const date = day(100);
      const wallets = async () => [
        { registrant: "0xgone", agentCount: 500, dominantHost: null },
        { registrant: "0xfleetA", agentCount: 70, dominantHost: null },
      ];
      const result = await catchDb.selectTodaysCatch(at(date), {
        ...catchDb.defaultCatchDeps,
        readWallets: wallets,
        readChains: async () => [],
        readEntryIds: async registrant => (registrant === "0xgone" ? [] : catchDb.defaultCatchDeps.readEntryIds(registrant, MAX_AGENT_IDS)),
      });
      expect(result.status).toBe("selected");
      expect(parseFacts("fleet", (await rowOn(date))!.facts)).toMatchObject({ registrant: "0xfleetA" });
    });

    it("features a round number a chain has just passed before any fleet, once, and the next one when it comes", async () => {
      const chains = (reviewed: number) => async () => [{ chain: "robinhood" as const, indexed: true, acknowledged: 3, reviewed, feedbackEvents: null, registries: [], asOf: "2026-10-15T06:00:00.000Z" }];
      const withChains = (reviewed: number) => ({ ...catchDb.defaultCatchDeps, readWallets: async () => [], readChains: chains(reviewed) });
      expect(await catchDb.selectTodaysCatch(at(day(200)), withChains(51))).toEqual({ date: day(200), status: "selected" });
      const row = (await rowOn(day(200)))!;
      expect(row.rule).toBe("milestone");
      expect(row.agentIds).toBe("[]");
      expect(parseFacts("milestone", row.facts)).toEqual({ chain: "robinhood", metric: "reviewed", milestone: 50, value: 51, asOf: "2026-10-15T06:00:00.000Z" });
      expect(viewOf(toCatchRow(row))!.headline).toBe("Robinhood Chain has passed 50 reviewed records.");
      // The same count the next day has nothing new; a count that has passed the next round number is new.
      expect((await catchDb.selectTodaysCatch(at(day(201)), withChains(52))).status).toBe("none");
      expect((await catchDb.selectTodaysCatch(at(day(202)), withChains(104))).status).toBe("selected");
      expect(parseFacts("milestone", (await rowOn(day(202)))!.facts)).toMatchObject({ milestone: 100, value: 104 });
    });

    it("keeps one row when two workers choose the same day at once", async () => {
      const date = day(300);
      const results = await Promise.all([catchDb.selectTodaysCatch(at(date)), catchDb.selectTodaysCatch(at(date))]);
      expect(results.every(result => result.date === date)).toBe(true);
      const [{ count }] = (await (async () => {
        const probe = await createConnection(process.env.DATABASE_URL!);
        const [rows] = (await probe.query("SELECT COUNT(*) AS count FROM `owls_catch` WHERE `catchDate` = ?", [date])) as [Array<{ count: number }>, unknown];
        await probe.end();
        return [rows[0]!];
      })()) as [{ count: number }];
      expect(Number(count)).toBe(1);
    });
  });

  describe("reading it", () => {
    it("tells today's status: pending before the day is chosen, then selected, and none for a day with nothing", async () => {
      const date = day(400);
      expect((await catchDb.readTodaysCatch(at(date))).status).toBe("pending");
      await catchDb.selectTodaysCatch(at(date), { ...catchDb.defaultCatchDeps, readWallets: async () => [], readChains: async () => [] });
      const none = await catchDb.readTodaysCatch(at(date));
      expect(none).toMatchObject({ date, status: "none", today: null });
      // With nothing today, the latest is the newest day that was found.
      expect(none.latest).not.toBeNull();
      expect(none.latest!.date < date).toBe(true);
      const found = await catchDb.readTodaysCatch(at(day(61)));
      expect(found).toMatchObject({ date: day(61), status: "selected" });
      expect(found.today!.headline).toContain("recorded against 60 identities");
      expect(found.latest).toEqual(found.today);
    });

    it("lists the catches that were found, newest first, with no day that had none, and at most the limit", async () => {
      const all = await catchDb.readCatchArchive(100);
      expect(all.length).toBeGreaterThan(5);
      expect(all.map(view => view.date)).toEqual([...all.map(view => view.date)].sort().reverse());
      expect(all.every(view => view.headline.length > 0)).toBe(true);
      const none = (await writer.select().from(schema.owlsCatch)).filter(row => row.rule === "none").map(row => row.catchDate);
      expect(all.some(view => none.includes(view.date))).toBe(false);
      expect(await catchDb.readCatchArchive(3)).toHaveLength(3);
      expect(await catchDb.readCatchArchive(0)).toHaveLength(1);
      expect((await catchDb.readCatchArchive(10_000)).length).toBe(all.length);
    });

    it("gives one day's catch by its date, and nothing for a day with none, or a day not chosen", async () => {
      expect((await catchDb.readCatchForDate(day(0)))!.headline).toBe("One registering wallet is recorded against 70 identities.");
      expect(await catchDb.readCatchForDate(day(2))).toBeNull();
      expect(await catchDb.readCatchForDate("2031-01-01")).toBeNull();
    });

    it("caps the archive at a hundred and gives thirty by default, however many days have a catch", async () => {
      const rows = Array.from({ length: 105 }, (_, index) => ({
        id: `bulk-${index}`,
        catchDate: new Date(Date.UTC(2040, 0, 1 + index)).toISOString().slice(0, 10),
        rule: "milestone",
        facts: JSON.stringify({ chain: "robinhood", metric: "reviewed", milestone: 50, value: 51, asOf: null }),
        sourceQuery: "test",
        agentIds: "[]",
      }));
      await writer.insert(schema.owlsCatch).values(rows);
      try {
        const most = await catchDb.readCatchArchive(10_000);
        expect(most).toHaveLength(100);
        expect(most[0]!.date).toBe(rows[104]!.catchDate);
        expect(await catchDb.readCatchArchive(100)).toHaveLength(100);
        expect((await caller().liveData.owlsCatchArchive()).catches).toHaveLength(30);
        expect((await caller().liveData.owlsCatchArchive({})).catches).toHaveLength(30);
        expect((await caller().liveData.owlsCatchArchive({ limit: 100 })).catches).toHaveLength(100);
      } finally {
        await writer.delete(schema.owlsCatch).where(like(schema.owlsCatch.id, "bulk-%"));
      }
    });

    it("shows only the identities the public may still see: a fleet since partly hidden shows the rest, one since hidden entirely is not shown at all", async () => {
      const date = day(700);
      const ids = Array.from({ length: 5 }, (_, index) => `0xfleetB-${String(index).padStart(3, "0")}`);
      const named = (list: string[]) => list.map(id => ({ id, name: `Entry 0xfleetB ${Number(id.slice(-3))}` }));
      const hide = (hidden: boolean, among: string[]) => writer.update(schema.agentDirectoryEntries).set({ hidden }).where(inArray(schema.agentDirectoryEntries.id, among));
      await writer.insert(schema.owlsCatch).values({ id: "shown-later", catchDate: date, rule: "fleet", facts: JSON.stringify({ registrant: "0xfleetB", agentCount: 60, dominantHost: "fleet.example.org" }), sourceQuery: "test", agentIds: JSON.stringify(ids) });
      try {
        const whole = (await catchDb.readCatchForDate(date))!;
        expect(whole.agents).toEqual(named(ids));
        expect(whole).not.toHaveProperty("agentIds");

        await hide(true, ids.slice(0, 2));
        const rest = named(ids.slice(2));
        expect((await catchDb.readCatchForDate(date))!.agents).toEqual(rest);
        expect((await catchDb.readTodaysCatch(at(date))).today!.agents).toEqual(rest);
        expect((await catchDb.readCatchArchive(100)).find(view => view.date === date)!.agents).toEqual(rest);
        expect((await caller().liveData.owlsCatchByDate({ date })).catch!.agents).toEqual(rest);

        await hide(true, ids);
        expect(await catchDb.readCatchForDate(date)).toBeNull();
        expect((await catchDb.readCatchArchive(100)).some(view => view.date === date)).toBe(false);
        const today = await catchDb.readTodaysCatch(at(date));
        expect(today).toMatchObject({ status: "none", today: null });
        expect(today.latest!.date).not.toBe(date);
        expect(await caller().liveData.owlsCatchByDate({ date })).toEqual({ catch: null });
        expect((await caller().liveData.owlsCatchArchive()).catches.some(view => view.date === date)).toBe(false);
      } finally {
        await hide(false, ids);
        await writer.delete(schema.owlsCatch).where(eq(schema.owlsCatch.id, "shown-later"));
      }
    });

    it("keeps a milestone as it was found whatever is hidden, since it names no identity", async () => {
      const date = day(701);
      await writer.insert(schema.owlsCatch).values({ id: "milestone-kept", catchDate: date, rule: "milestone", facts: JSON.stringify({ chain: "robinhood", metric: "reviewed", milestone: 50, value: 51, asOf: "2026-10-15T06:00:00.000Z" }), sourceQuery: "test", agentIds: "[]" });
      try {
        const view = (await catchDb.readCatchForDate(date))!;
        expect(view.headline).toBe("Robinhood Chain has passed 50 reviewed records.");
        expect(view.agents).toEqual([]);
      } finally {
        await writer.delete(schema.owlsCatch).where(eq(schema.owlsCatch.id, "milestone-kept"));
      }
    });

    it("serves the same through the public procedures, which need no sign-in and reject what is not a date", async () => {
      const today = await caller().liveData.owlsCatch();
      expect(today.status).not.toBe("unavailable");
      expect((await caller().liveData.owlsCatchArchive({ limit: 2 })).catches).toHaveLength(2);
      expect((await caller().liveData.owlsCatchArchive()).catches.length).toBeGreaterThan(5);
      expect((await caller().liveData.owlsCatchByDate({ date: day(1) })).catch!.headline).toContain("60 identities");
      await expect(caller().liveData.owlsCatchByDate({ date: "2026-13-45" })).rejects.toThrow();
      await expect(caller().liveData.owlsCatchByDate({ date: "yesterday" })).rejects.toThrow();
      await expect(caller().liveData.owlsCatchArchive({ limit: 101 })).rejects.toThrow();
    });

    it("fails closed to no catch when the table cannot be read, and never throws at a visitor", async () => {
      const probe = await createConnection(process.env.DATABASE_URL!);
      await probe.query("RENAME TABLE `owls_catch` TO `owls_catch_away`");
      try {
        expect(await caller().liveData.owlsCatch()).toMatchObject({ status: "unavailable", today: null, latest: null });
        expect(await caller().liveData.owlsCatchArchive({ limit: 5 })).toEqual({ catches: [] });
        expect(await caller().liveData.owlsCatchByDate({ date: day(0) })).toEqual({ catch: null });
        // And the worker's step fails in the way the worker logs and skips: it throws, and chooses nothing.
        await expect(catchDb.selectTodaysCatch(at(day(500)))).rejects.toThrow();
      } finally {
        await probe.query("RENAME TABLE `owls_catch_away` TO `owls_catch`");
        await probe.end();
      }
      expect(await rowsInTable()).toBeGreaterThan(5);
    });
  });

  describe("an extra chain's round number", () => {
    const DAYS = [day(800), day(801)];
    const features = (list: string | undefined) => {
      if (list === undefined) delete process.env.VITE_FEATURES;
      else process.env.VITE_FEATURES = list;
      fresh();
    };
    // The real read of the chains, and no fleets, so the only thing that can be the day's catch is a round number.
    const deps = () => ({ ...catchDb.defaultCatchDeps, readWallets: async () => [] });

    beforeAll(async () => {
      // 252 visible entries on Arc: it has just passed 250. The other chains here have not just passed one.
      await source("src-arc", "erc8004_arc", "active");
      await writer.insert(schema.agentDirectoryEntries).values(
        Array.from({ length: 252 }, (_, index) => ({ id: `arc-${String(index).padStart(3, "0")}`, sourceId: "src-arc", externalKey: `key-arc-${index}`, displayName: `Arc entry ${index}`, protocol: "erc8004_arc" as const, firstSeenAt: new Date(Date.UTC(2026, 9, 20, 0, index % 60)) })),
      );
    });

    afterAll(async () => {
      delete process.env.VITE_FEATURES;
      fresh();
      await writer.delete(schema.owlsCatch).where(inArray(schema.owlsCatch.catchDate, DAYS));
      await writer.delete(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.protocol, "erc8004_arc"));
      await writer.delete(schema.ingestionSources).where(eq(schema.ingestionSources.id, "src-arc"));
    });

    it("is not featured while the chain's switch is off, though the chain is indexed and has just passed one", async () => {
      features(undefined);
      expect(await catchDb.selectTodaysCatch(at(day(800)), deps())).toEqual({ date: day(800), status: "none" });
      expect(await rowOn(day(800))).toMatchObject({ rule: "none" });
    });

    it("is featured once the switch is on, with the facts its words are made from and nothing to link to", async () => {
      features("chain_arc");
      expect(await catchDb.selectTodaysCatch(at(day(801)), deps())).toEqual({ date: day(801), status: "selected" });
      const stored = (await rowOn(day(801)))!;
      expect(stored.rule).toBe("milestone");
      expect(stored.agentIds).toBe("[]");
      expect(parseFacts("milestone", stored.facts)).toMatchObject({ chain: "arc", metric: "acknowledged", milestone: 250, value: 252 });
      expect(viewOf(toCatchRow(stored), "chain_arc")!.headline).toBe("Arc has passed 250 acknowledged entries.");
      // It is said once: the same count the next day has nothing new.
      expect((await catchDb.selectTodaysCatch(at(day(802)), deps())).status).toBe("none");
      await writer.delete(schema.owlsCatch).where(eq(schema.owlsCatch.catchDate, day(802)));
    });

    it("is read back only while the switch is on: by its day, in the archive, as today's catch and through the public procedures", async () => {
      features("chain_arc");
      expect((await catchDb.readCatchForDate(day(801)))!.headline).toBe("Arc has passed 250 acknowledged entries.");
      expect((await catchDb.readCatchArchive(100)).some(view => view.date === day(801))).toBe(true);
      expect((await catchDb.readTodaysCatch(at(day(801)))).status).toBe("selected");
      expect((await caller().liveData.owlsCatchByDate({ date: day(801) })).catch!.headline).toBe("Arc has passed 250 acknowledged entries.");
      features(undefined);
      expect(await catchDb.readCatchForDate(day(801))).toBeNull();
      expect((await catchDb.readCatchArchive(100)).some(view => view.date === day(801))).toBe(false);
      expect(await catchDb.readTodaysCatch(at(day(801)))).toMatchObject({ status: "none", today: null });
      expect(await caller().liveData.owlsCatchByDate({ date: day(801) })).toEqual({ catch: null });
      expect((await caller().liveData.owlsCatchArchive({ limit: 100 })).catches.some(view => view.date === day(801))).toBe(false);
    });
  });

  describe.each([
    { label: "Base", protocol: "erc8004_base" as const, feature: "chain_base", key: "base", first: 810, sourceId: "src-base-catch" },
    { label: "Ethereum", protocol: "erc8004_eth" as const, feature: "chain_ethereum", key: "ethereum", first: 820, sourceId: "src-eth-catch" },
  ])("$label's round number", ({ label, protocol, feature, key, first, sourceId }) => {
    const DAYS = [day(first), day(first + 1), day(first + 2)];
    const features = (list: string | undefined) => {
      if (list === undefined) delete process.env.VITE_FEATURES;
      else process.env.VITE_FEATURES = list;
      fresh();
    };
    // The real read of the chains, and no fleets, so the only thing that can be the day's catch is a round number.
    const deps = () => ({ ...catchDb.defaultCatchDeps, readWallets: async () => [] });
    const words = `${label} has passed 250 acknowledged entries.`;

    beforeAll(async () => {
      // 252 visible entries on the chain: it has just passed 250. The other chains here have not just passed one.
      await source(sourceId, protocol, "active");
      await writer.insert(schema.agentDirectoryEntries).values(
        Array.from({ length: 252 }, (_, index) => ({ id: `${key}-${String(index).padStart(3, "0")}`, sourceId, externalKey: `key-${key}-${index}`, displayName: `${label} entry ${index}`, protocol, firstSeenAt: new Date(Date.UTC(2026, 9, 28, 0, index % 60)) })),
      );
    });

    afterAll(async () => {
      delete process.env.VITE_FEATURES;
      fresh();
      await writer.delete(schema.owlsCatch).where(inArray(schema.owlsCatch.catchDate, DAYS));
      await writer.delete(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.protocol, protocol));
      await writer.delete(schema.ingestionSources).where(eq(schema.ingestionSources.id, sourceId));
    });

    it("is not featured while the chain's switch is off, nor while another chain's is on, though the chain is indexed and has just passed one", async () => {
      features(undefined);
      expect(await catchDb.selectTodaysCatch(at(day(first)), deps())).toEqual({ date: day(first), status: "none" });
      expect(await rowOn(day(first))).toMatchObject({ rule: "none" });
      await writer.delete(schema.owlsCatch).where(eq(schema.owlsCatch.catchDate, day(first)));
      features(feature === "chain_base" ? "chain_ethereum,chain_arc" : "chain_base,chain_arc");
      expect((await catchDb.selectTodaysCatch(at(day(first)), deps())).status).toBe("none");
    });

    it("is featured once the switch is on, with the facts its words are made from and nothing to link to", async () => {
      features(feature);
      expect(await catchDb.selectTodaysCatch(at(day(first + 1)), deps())).toEqual({ date: day(first + 1), status: "selected" });
      const stored = (await rowOn(day(first + 1)))!;
      expect(stored.rule).toBe("milestone");
      expect(stored.agentIds).toBe("[]");
      expect(parseFacts("milestone", stored.facts)).toMatchObject({ chain: key, metric: "acknowledged", milestone: 250, value: 252 });
      expect(viewOf(toCatchRow(stored), feature)!.headline).toBe(words);
      // It is said once: the same count the next day has nothing new.
      expect((await catchDb.selectTodaysCatch(at(day(first + 2)), deps())).status).toBe("none");
      await writer.delete(schema.owlsCatch).where(eq(schema.owlsCatch.catchDate, day(first + 2)));
    });

    it("is read back only while the switch is on: by its day, in the archive, as today's catch and through the public procedures", async () => {
      features(feature);
      expect((await catchDb.readCatchForDate(day(first + 1)))!.headline).toBe(words);
      expect((await catchDb.readCatchArchive(100)).some(view => view.date === day(first + 1))).toBe(true);
      expect((await catchDb.readTodaysCatch(at(day(first + 1)))).status).toBe("selected");
      expect((await caller().liveData.owlsCatchByDate({ date: day(first + 1) })).catch!.headline).toBe(words);
      features(undefined);
      expect(await catchDb.readCatchForDate(day(first + 1))).toBeNull();
      expect((await catchDb.readCatchArchive(100)).some(view => view.date === day(first + 1))).toBe(false);
      expect(await catchDb.readTodaysCatch(at(day(first + 1)))).toMatchObject({ status: "none", today: null });
      expect(await caller().liveData.owlsCatchByDate({ date: day(first + 1) })).toEqual({ catch: null });
      expect((await caller().liveData.owlsCatchArchive({ limit: 100 })).catches.some(view => view.date === day(first + 1))).toBe(false);
    });
  });

  describe("the pages around a catch, sent by the server with the real read", () => {
    let dist: string;
    let server: ReturnType<ReturnType<typeof express>["listen"]>;
    let base: string;

    beforeAll(async () => {
      const { catchPages } = await import("./catchPage");
      dist = mkdtempSync(path.join(os.tmpdir(), "catch-page-db-"));
      writeFileSync(path.join(dist, "index.html"), await readFile("client/index.html", "utf8"));
      const app = express();
      app.use(catchPages(dist));
      app.use("*", (_req, res) => {
        res.status(200).send("FALLBACK");
      });
      await new Promise<void>(resolve => {
        server = app.listen(0, "127.0.0.1", resolve);
      });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise(resolve => server?.close(resolve));
      if (dist) rmSync(dist, { recursive: true, force: true });
    });

    const page = async (pathname: string) => {
      const response = await fetch(base + pathname);
      return { status: response.status, body: await response.text() };
    };

    it("sends a day that has a catch as 200 with the day's own head, and a day that has none, or was never chosen, as 404", async () => {
      const found = await page(`/catch/${day(0)}`);
      expect(found.status).toBe(200);
      expect(found.body).toContain("<title>The Owl&#39;s Catch, 1 Oct 2026 | Nooscape</title>");
      expect(found.body).toContain("One registering wallet is recorded against 70 identities.");
      expect(found.body).toContain(`href="https://nooscape.si/catch/${day(0)}"`);
      const none = await page(`/catch/${day(2)}`);
      expect(none.status).toBe(404);
      expect(none.body).toContain('content="noindex, follow"');
      expect((await page("/catch/2031-01-01")).status).toBe(404);
      expect((await page("/catch")).status).toBe(200);
    });

    it("sends a day as 404 once every identity of its fleet has been hidden, and as 200 again when one is back", async () => {
      const date = day(702);
      const ids = ["0xfleetB-000", "0xfleetB-001"];
      await writer.insert(schema.owlsCatch).values({ id: "page-gone", catchDate: date, rule: "fleet", facts: JSON.stringify({ registrant: "0xfleetB", agentCount: 60, dominantHost: null }), sourceQuery: "test", agentIds: JSON.stringify(ids) });
      try {
        expect((await page(`/catch/${date}`)).status).toBe(200);
        await writer.update(schema.agentDirectoryEntries).set({ hidden: true }).where(inArray(schema.agentDirectoryEntries.id, ids));
        expect((await page(`/catch/${date}`)).status).toBe(404);
        await writer.update(schema.agentDirectoryEntries).set({ hidden: false }).where(eq(schema.agentDirectoryEntries.id, ids[0]!));
        expect((await page(`/catch/${date}`)).status).toBe(200);
      } finally {
        await writer.update(schema.agentDirectoryEntries).set({ hidden: false }).where(inArray(schema.agentDirectoryEntries.id, ids));
        await writer.delete(schema.owlsCatch).where(eq(schema.owlsCatch.id, "page-gone"));
      }
    });

    it("sends a day about an extra chain only while its switch is on", async () => {
      const date = day(803);
      await writer.insert(schema.owlsCatch).values({ id: "page-arc", catchDate: date, rule: "milestone", facts: JSON.stringify({ chain: "arc", metric: "acknowledged", milestone: 250, value: 252, asOf: null }), sourceQuery: "test", agentIds: "[]" });
      try {
        delete process.env.VITE_FEATURES;
        expect((await page(`/catch/${date}`)).status).toBe(404);
        process.env.VITE_FEATURES = "chain_arc";
        const on = await page(`/catch/${date}`);
        expect(on.status).toBe(200);
        expect(on.body).toContain("Arc has passed 250 acknowledged entries.");
      } finally {
        delete process.env.VITE_FEATURES;
        await writer.delete(schema.owlsCatch).where(eq(schema.owlsCatch.id, "page-arc"));
      }
    });

    it("sends the ordinary page when the table cannot be read, rather than an error", async () => {
      const probe = await createConnection(process.env.DATABASE_URL!);
      await probe.query("RENAME TABLE `owls_catch` TO `owls_catch_away`");
      try {
        const sent = await page(`/catch/${day(0)}`);
        expect(sent).toEqual({ status: 200, body: "FALLBACK" });
      } finally {
        await probe.query("RENAME TABLE `owls_catch_away` TO `owls_catch`");
        await probe.end();
      }
    });
  });
});
