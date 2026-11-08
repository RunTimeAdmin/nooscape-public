import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";

/**
 * Database-backed test of the Today block's counts: the figures of a registry census page's first table, read from the directory as it
 * stands. A registry that keeps its registrations in rows is counted from the rows, the registrations a host's cap counted and did not
 * store, the visible entries and the ratings; one that keeps entries is counted from the entries. Counts only: nothing read out is a
 * name, a wallet, a host or a link. It runs against a throwaway local schema built with the project's own migration runner; the file
 * skips when no database is reachable.
 */

const TEST_DB = "nooscape_census_today_test";
const BASE_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";
/** The SHA-256 of the empty string: a registration that set no profile link records it, and the census counts it as one link. */
const EMPTY_LINK = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const dbReachable = await (async () => {
  try {
    const probe = await createConnection(`${BASE_URL}/mysql`);
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbReachable)("the Today block's counts, against a real database", () => {
  type Reader = typeof import("./censusToday");
  let reader: Reader;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;

  async function source(key: string, protocol: schema.IngestionSource["protocol"], state: "active" | "paused", lastSuccessfulAt: Date | null) {
    await writer.insert(schema.ingestionSources).values({
      id: `src-${key}`,
      sourceKey: `census-today-${key}`,
      label: `Census today ${key}`,
      protocol,
      rootUrl: `https://census-today.example/${key}`,
      allowedHostname: "census-today.example",
      state,
      lastSuccessfulAt,
      createdByUserId: operatorUserId,
    });
    return `src-${key}`;
  }

  const row = (sourceId: string, n: number, values: { listing: number; registrant: string | null; host: string | null; link: string | null }) => ({
    id: `${sourceId}-row-${n}`,
    sourceId,
    externalKey: `key-${n}`,
    displayName: `Agent ${n}`,
    protocol: "erc8004_base" as const,
    registrant: values.registrant,
    locatorHost: values.host,
    profileUriHash: values.link,
    listing: values.listing,
  });

  const entry = (sourceId: string, n: number, values: { registrant: string | null; host: string | null; hidden?: boolean; protocol?: "erc8004_base" | "erc8004" }) => ({
    id: `${sourceId}-entry-${n}`,
    sourceId,
    externalKey: `entry-${n}`,
    displayName: `Entry ${n}`,
    protocol: values.protocol ?? ("erc8004_base" as const),
    registrant: values.registrant,
    locatorHost: values.host,
    hidden: values.hidden ?? false,
  });

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    // The boot runner stamps baseline versions 0000-0014 without executing them, so a fresh schema replays those files by hand first.
    const baselineReplay = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      const content = await readFile(file.file, "utf8");
      for (const statement of splitMigrationStatements(content)) {
        await baselineReplay.query(statement);
      }
    }
    await baselineReplay.end();
    await applyPendingMigrations(process.env.DATABASE_URL);
    // The boot runner skips the manual migrations; 0046 is pasted for the Base, Ethereum and Arc protocol values.
    const manual = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8"))) await manual.query(statement);
    await manual.end();

    reader = await import("./censusToday");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "census-today-operator", role: "admin" });
    const [operatorRow] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "census-today-operator"));
    operatorUserId = operatorRow.id;

    // Base: a registry in rows. Six registrations in four states, two wallets (one registration without one), two hosts, links with the empty one.
    const base = await source("base", "erc8004_base", "active", new Date("2026-11-07T01:30:00Z"));
    await writer.insert(schema.agentDirectoryRegistryRows).values([
      row(base, 1, { listing: 1, registrant: "wallet-a", host: "one.example", link: "link-a" }),
      row(base, 2, { listing: 1, registrant: "wallet-a", host: "one.example", link: "link-b" }),
      row(base, 3, { listing: 0, registrant: "wallet-a", host: null, link: EMPTY_LINK }),
      row(base, 4, { listing: 2, registrant: "wallet-b", host: "two.example", link: "link-a" }),
      row(base, 5, { listing: 2, registrant: "wallet-b", host: null, link: null }),
      row(base, 6, { listing: 3, registrant: null, host: null, link: null }),
    ]);
    // Counted and not stored: two hosts past the cap.
    await writer.insert(schema.agentDirectoryRegistryOverflow).values([
      { id: "overflow-1", sourceId: base, locatorHost: "flood.example", overflowCount: 100, lastBlock: 10 },
      { id: "overflow-2", sourceId: base, locatorHost: "flood2.example", overflowCount: 50, lastBlock: 11 },
    ]);
    // Two entries the directory shows and one an operator hid.
    await writer.insert(schema.agentDirectoryEntries).values([
      entry(base, 1, { registrant: "wallet-a", host: "one.example" }),
      entry(base, 2, { registrant: "wallet-b", host: "two.example" }),
      entry(base, 3, { registrant: "wallet-b", host: "two.example", hidden: true }),
    ]);
    await writer.insert(schema.chainReputationCounts).values({ chainKey: "base", ratings: 1_234, revocations: 2, nextBlock: 99, caughtUpAt: new Date("2026-10-21T00:00:00Z") });

    // Arc: an active source that has not finished a pass and has no rows, whose ratings are only part read.
    await source("arc", "erc8004_arc", "active", null);
    await writer.insert(schema.chainReputationCounts).values({ chainKey: "arc", ratings: 77, revocations: 0, nextBlock: 5, caughtUpAt: null });

    // Ethereum: a source an operator paused.
    const ethereum = await source("ethereum", "erc8004_eth", "paused", new Date("2026-11-01T00:00:00Z"));
    await writer.insert(schema.agentDirectoryRegistryRows).values(row(ethereum, 1, { listing: 1, registrant: "wallet-e", host: "e.example", link: "link-e" }));

    // Robinhood Chain: a registry that keeps entries. Four shown (two wallets, one without; two hosts, two without) and one hidden.
    const robinhood = await source("robinhood", "erc8004", "active", new Date("2026-11-06T22:00:00Z"));
    await writer.insert(schema.agentDirectoryEntries).values([
      entry(robinhood, 1, { registrant: "wallet-r1", host: "r1.example", protocol: "erc8004" }),
      entry(robinhood, 2, { registrant: "wallet-r1", host: "r1.example", protocol: "erc8004" }),
      entry(robinhood, 3, { registrant: "wallet-r2", host: "r2.example", protocol: "erc8004" }),
      entry(robinhood, 4, { registrant: null, host: null, protocol: "erc8004" }),
      entry(robinhood, 5, { registrant: "wallet-r3", host: "r3.example", hidden: true, protocol: "erc8004" }),
    ]);
  }, 120_000);

  afterAll(async () => {
    if (closePool) await closePool();
  }, 30_000);

  it("counts a registry in rows the way the census queries do: stored, counted past the cap, listed, wallets, hosts and links", async () => {
    const today = await reader.readCensusToday("base");

    expect(today).toEqual({
      chain: "base",
      asOf: "2026-11-07T01:30:00.000Z",
      figures: {
        onChain: 156,
        stored: 6,
        overflow: 150,
        // The entries shown: the hidden one is not.
        listed: 2,
        wallets: 2,
        withHttpsHost: 3,
        hosts: 2,
        // Three links and the empty one, which the census counts as a link of its own: link-a, link-b and the empty link.
        profileLinks: 3,
      },
      heldOut: { noLink: 1, grouped: 2, numericName: 0, pending: 1 },
      ratings: 1_234,
    });
  });

  it("says nothing of a part-read ratings count, and counts an active source that has no rows as zeros, with no time", async () => {
    const today = await reader.readCensusToday("arc");

    expect(today).toEqual({
      chain: "arc",
      asOf: null,
      figures: { onChain: 0, stored: 0, overflow: 0, listed: 0, wallets: 0, withHttpsHost: 0, hosts: 0, profileLinks: 0 },
      heldOut: { noLink: 0, grouped: 0, numericName: 0, pending: 0 },
      ratings: null,
    });
  });

  it("counts a registry that keeps entries from the entries the directory shows", async () => {
    const today = await reader.readCensusToday("robinhood");

    expect(today).toEqual({
      chain: "robinhood",
      asOf: "2026-11-06T22:00:00.000Z",
      figures: { listed: 4, wallets: 2, withHttpsHost: 3, hosts: 2 },
      heldOut: null,
      ratings: null,
    });
  });

  it("has nothing for a chain whose source is paused, and nothing for a chain that has no source", async () => {
    expect(await reader.readCensusToday("ethereum")).toBeNull();
    expect(await reader.readCensusToday("bnb")).toBeNull();
  });

  it("holds counts only: no wallet, host or link is in what it returns", async () => {
    const serialized = JSON.stringify([await reader.readCensusToday("base"), await reader.readCensusToday("robinhood")]);

    for (const word of ["wallet-", "one.example", "two.example", "flood.example", "link-a", EMPTY_LINK, "r1.example"]) expect(serialized).not.toContain(word);
  });

  it("is read through the directory's cache, so a second read does not go back to the database", async () => {
    const first = await reader.readCensusToday("base");
    await writer.insert(schema.agentDirectoryRegistryOverflow).values({ id: "overflow-3", sourceId: "src-base", locatorHost: "flood3.example", overflowCount: 1_000, lastBlock: 12 });

    expect(await reader.readCensusToday("base")).toEqual(first);

    const { invalidateDirectoryReads } = await import("./readCache");
    invalidateDirectoryReads();
    expect((await reader.readCensusToday("base"))?.figures.overflow).toBe(1_150);
  });
});
