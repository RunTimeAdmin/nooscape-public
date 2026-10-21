import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";
import { RobinhoodRegistryHttpError } from "./ingestion/robinhood";
import type { RegistrationNameResult } from "./ingestion/registrationFetch";
import { entryNameNote, ROBINHOOD_EXTERNAL_PREFIX, ROBINHOOD_SOURCE_KEY, uriHashOf } from "./robinhoodNamesCore";

/**
 * The entries part of the Robinhood name step against a real database (docs/approvals/2026-10-17-robinhood-entry-names.md): the
 * links read from the chain for entries that have none recorded, what is kept on each entry, the names written where the name is
 * still the placeholder, a link shared by several entries read once, the pace of the reads, a throttled node, and a step that
 * never throws. The chain and the fetch are functions that answer per id and per link; the real ones are in ingestion/*.test.ts.
 * Skips when no database is reachable.
 */
const TEST_DB = "nooscape_rh_entries_test";
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

const CID = "QmcsZip4oMCkS8UhrXDmG2Bo1WMaJzbQa35RX2h5QRn1xx";
const keyOf = (id: number) => `${ROBINHOOD_EXTERNAL_PREFIX}${id}`;
const linkOf = (host: string, id: number) => `https://${host}/robinhood/${id}.json`;
const inline = (record: Record<string, unknown>) => `data:application/json;base64,${Buffer.from(JSON.stringify(record)).toString("base64")}`;
const BACKFILL_NOTE = "Historical registration backfilled from chain history; acknowledged only.";

describe.skipIf(!dbReachable)("the Robinhood entry names against a real database", { timeout: 60_000 }, () => {
  let names: typeof import("./robinhoodNames");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let sourceId: string;

  /** What the fake chain answers for an id (a string, or null for a read that fails), and every batch it was asked. */
  const chain = new Map<number, string | null>();
  const chainCalls: string[][] = [];
  const readUris = async (ids: string[]) => {
    chainCalls.push(ids);
    return ids.map(id => chain.get(Number(id)) ?? null);
  };
  /** What the fake fetch answers for a link, and every link it was asked. */
  const answers = new Map<string, RegistrationNameResult>();
  const asked: string[] = [];
  const resolve = async (uri: string): Promise<RegistrationNameResult> => {
    asked.push(uri);
    return answers.get(uri) ?? { status: "failed", reason: "no answer was set" };
  };
  const run = (over: Partial<import("./robinhoodNames").RobinhoodNamesDeps> & { tickStartedAt?: number } = {}) =>
    names.runRobinhoodNames({ resolve, readUris, intervalMs: 0, ...over });
  const entry = async (id: number) => (await writer.select().from(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.externalKey, keyOf(id))))[0]!;
  const rows = async () => (await writer.select().from(schema.agentRegistrationResolutions)).sort((a, b) => a.uri.localeCompare(b.uri));
  async function seed(id: number, displayName = `Agent #${id}`, note: string | null = BACKFILL_NOTE) {
    await writer.insert(schema.agentDirectoryEntries).values({ id: `rh-entry-${id}`, sourceId, externalKey: keyOf(id), displayName, protocol: "erc8004", sourceSignalNote: note });
  }
  const reset = () => {
    chainCalls.length = 0;
    asked.length = 0;
  };

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

    names = await import("./robinhoodNames");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "rh-entries-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "rh-entries-operator"));
    sourceId = "src-robinhood";
    await writer.insert(schema.ingestionSources).values({
      id: sourceId,
      sourceKey: ROBINHOOD_SOURCE_KEY,
      label: "Robinhood entries test",
      protocol: "erc8004",
      rootUrl: "https://rpc.mainnet.chain.robinhood.com",
      allowedHostname: "rpc.mainnet.chain.robinhood.com",
      state: "active",
      createdByUserId: operator!.id,
    });
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("reads the links of entries that have none recorded in one batch, newest id first, and records what each is", async () => {
    // 100 and 101 share one file; 102 is ipfs; 103 carries its name inside; 104 has no link; 105 is a token that reverts; 106 has a name of its own.
    for (const id of [105, 100, 104, 101, 103, 102]) await seed(id);
    await seed(106, "Mark");
    chain.set(100, linkOf("registrations.example", 98));
    chain.set(101, linkOf("registrations.example", 98));
    chain.set(102, `ipfs://${CID}`);
    chain.set(103, inline({ name: "Tinsel Bot", description: "x" }));
    chain.set(104, "");
    answers.set(linkOf("registrations.example", 98), { status: "resolved", name: "Gelato · muse #98" });
    answers.set(`ipfs://${CID}`, { status: "resolved", name: "Passkeys" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const outcome = await run();
      expect(outcome).toMatchObject({ state: "completed", discovered: 6, read: 2, resolved: 2, failed: 0, entriesNamed: 4, chain: "read", stoppedBy: null });
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
    // One batch, the newest id first, and none for the entry that already has a name.
    expect(chainCalls).toEqual([["105", "104", "103", "102", "101", "100"]]);
    // The shared file was asked once and named both entries.
    expect(asked.sort()).toEqual([`ipfs://${CID}`, linkOf("registrations.example", 98)].sort());
    expect((await entry(100)).displayName).toBe("Gelato · muse #98");
    expect((await entry(101)).displayName).toBe("Gelato · muse #98");
    expect((await entry(102)).displayName).toBe("Passkeys");
    expect((await entry(103)).displayName).toBe("Tinsel Bot");
    // No link, and a token that reverts, keep the placeholder and are not read again.
    expect((await entry(104)).displayName).toBe("Agent #104");
    expect((await entry(105)).displayName).toBe("Agent #105");
    expect((await entry(106)).displayName).toBe("Mark");
    // What is kept on each entry: the hash of its link (the empty link for none), and the note says when the name was read.
    expect((await entry(100)).profileUriHash).toBe(uriHashOf(linkOf("registrations.example", 98)));
    expect((await entry(104)).profileUriHash).toBe(uriHashOf(""));
    expect((await entry(105)).profileUriHash).toBe(uriHashOf(""));
    expect((await entry(106)).profileUriHash).toBeNull();
    const day = new Date().toISOString().slice(0, 10);
    expect((await entry(100)).sourceSignalNote).toBe(`${BACKFILL_NOTE}${entryNameNote(day)}`);
    expect((await entry(104)).sourceSignalNote).toBe(BACKFILL_NOTE);
    // One row for the shared file, one for the ipfs link, and nothing for a link that was never a link.
    const kept = await rows();
    expect(kept.map(row => [row.uriKind, row.status, row.attempts, row.resolvedName])).toEqual([
      ["web", "resolved", 1, "Gelato · muse #98"],
      ["ipfs", "resolved", 1, "Passkeys"],
    ]);
  });

  it("does not read the chain again for entries that have a link recorded, nor a file that was read", async () => {
    reset();
    expect(await run()).toMatchObject({ state: "completed", discovered: 0, read: 0, chain: null });
    expect(chainCalls).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("names a new entry that shares a file already read, at once and with no request", async () => {
    await seed(110);
    chain.set(110, linkOf("registrations.example", 98));
    reset();
    expect(await run()).toMatchObject({ discovered: 1, read: 0, entriesNamed: 1 });
    expect(asked).toEqual([]);
    expect((await entry(110)).displayName).toBe("Gelato · muse #98");
  });

  it("keeps a link that did not answer queued, tries it again after six hours, and names the entry when it answers", async () => {
    await seed(120);
    chain.set(120, linkOf("flaky.example", 120));
    answers.set(linkOf("flaky.example", 120), { status: "failed", reason: "HTTP 503" });
    reset();
    expect(await run()).toMatchObject({ discovered: 1, read: 1, failed: 1, entriesNamed: 0 });
    expect(await entry(120)).toMatchObject({ displayName: "Agent #120", profileUriHash: uriHashOf(linkOf("flaky.example", 120)) });
    expect((await rows()).find(row => row.uri === linkOf("flaky.example", 120))).toMatchObject({ status: "failed", attempts: 1, failReason: "HTTP 503" });
    // Within six hours it is not asked again, and the chain is not asked for it either.
    reset();
    expect(await run()).toMatchObject({ discovered: 0, read: 0 });
    expect(asked).toEqual([]);
    // After six hours it is.
    await writer.update(schema.agentRegistrationResolutions).set({ lastAttemptAt: new Date(Date.now() - 7 * 3_600_000) }).where(eq(schema.agentRegistrationResolutions.uri, linkOf("flaky.example", 120)));
    answers.set(linkOf("flaky.example", 120), { status: "resolved", name: "Flaky Agent" });
    expect(await run()).toMatchObject({ read: 1, resolved: 1, entriesNamed: 1 });
    expect(await entry(120)).toMatchObject({ displayName: "Flaky Agent" });
    expect((await rows()).find(row => row.uri === linkOf("flaky.example", 120))).toMatchObject({ status: "resolved", attempts: 2 });
  });

  it("reads at most the limit of files in a run and a few from any one host, and carries on in the next", async () => {
    for (let id = 200; id < 210; id += 1) {
      await seed(id);
      chain.set(id, linkOf("platform.example", id));
      answers.set(linkOf("platform.example", id), { status: "resolved", name: `Platform ${id}` });
    }
    for (let id = 210; id < 213; id += 1) {
      await seed(id);
      chain.set(id, linkOf("other.example", id));
      answers.set(linkOf("other.example", id), { status: "resolved", name: `Other ${id}` });
    }
    // One batch of at most `maxDiscover` entries: the 13 are found over two runs, then read at most 6 from the platform each run.
    reset();
    const first = await run({ maxDiscover: 13 });
    expect(first).toMatchObject({ discovered: 13, read: 9, resolved: 9 });
    expect(asked.filter(uri => uri.includes("platform.example")).length).toBe(6);
    expect(asked.filter(uri => uri.includes("other.example")).length).toBe(3);
    reset();
    const second = await run();
    expect(second).toMatchObject({ discovered: 0, read: 4 });
    expect(asked.filter(uri => uri.includes("platform.example")).length).toBe(4);
    expect((await entry(209)).displayName).toBe("Platform 209");
  });

  it("finds at most the batch size of entries in a run", async () => {
    for (let id = 300; id < 310; id += 1) await seed(id);
    reset();
    await run({ maxDiscover: 4 });
    expect(chainCalls).toEqual([["309", "308", "307", "306"]]);
    // The next four.
    reset();
    await run({ maxDiscover: 4 });
    expect(chainCalls).toEqual([["305", "304", "303", "302"]]);
  });

  it("writes a name only where the name is still the placeholder", async () => {
    await seed(400);
    chain.set(400, linkOf("registrations.example", 400));
    answers.set(linkOf("registrations.example", 400), { status: "resolved", name: "Read Name" });
    // The entry gets a real name of its own between the read of its link and the naming (a new observation).
    const first = await run({ readUris: async ids => { await writer.update(schema.agentDirectoryEntries).set({ displayName: "Its Own Name" }).where(eq(schema.agentDirectoryEntries.externalKey, keyOf(400))); return readUris(ids); }, maxDiscover: 20 });
    expect(first).toMatchObject({ state: "completed", read: 1, resolved: 1, entriesNamed: 0 });
    expect((await entry(400)).displayName).toBe("Its Own Name");
  });

  it("cuts the note at the width of its column, and does not name an entry whose read name cleans to nothing", async () => {
    await seed(410, "Agent #410", "x".repeat(500));
    await seed(411);
    chain.set(410, linkOf("registrations.example", 410));
    chain.set(411, linkOf("registrations.example", 411));
    answers.set(linkOf("registrations.example", 410), { status: "resolved", name: "Long Note Agent" });
    answers.set(linkOf("registrations.example", 411), { status: "resolved", name: " ​\u0007 " });
    await run({ maxDiscover: 20 });
    const long = await entry(410);
    expect(long.displayName).toBe("Long Note Agent");
    expect(long.sourceSignalNote!.length).toBe(512);
    expect((await entry(411)).displayName).toBe("Agent #411");
  });

  it("stops reading the chain for two hours when the node answers 429, says so once, and starts again when told the time has passed", async () => {
    await seed(500);
    chain.set(500, linkOf("registrations.example", 500));
    answers.set(linkOf("registrations.example", 500), { status: "resolved", name: "After The Throttle" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      reset();
      const throttled = await run({ readUris: async () => { throw new RobinhoodRegistryHttpError(429, "Robinhood Chain RPC returned HTTP 429."); } });
      expect(throttled).toMatchObject({ state: "completed", chain: "throttled", discovered: 0 });
      expect(error).toHaveBeenCalledOnce();
      expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({
        event: "nooscape_robinhood_names_failed",
        message: "the tokenURI read could not be made: Robinhood Chain RPC returned HTTP 429.; chain reads are paused for 2 hours",
      });
      // Nothing was recorded for the entry, and the next run does not ask the chain at all.
      expect((await entry(500)).profileUriHash).toBeNull();
      expect(await run()).toMatchObject({ chain: "paused", discovered: 0 });
      expect(chainCalls).toEqual([]);
      // Two hours on, it asks again.
      names.resetRobinhoodNamesClock();
      expect(await run()).toMatchObject({ chain: "read", discovered: 1, entriesNamed: 1 });
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it("pauses for a shorter time after any other failure or an answer of the wrong shape, and still reads the links that are queued", async () => {
    names.resetRobinhoodNamesClock();
    await seed(510);
    await seed(511);
    // A link is queued and waiting from an earlier discovery.
    await writer.insert(schema.agentRegistrationResolutions).values({
      id: "queued-1", sourceId, externalKey: keyOf(511), uriHash: uriHashOf(linkOf("queued.example", 511)), uriKind: "web", uri: linkOf("queued.example", 511),
      status: "failed", failReason: "not read yet", resolvedName: null, attempts: 0, lastAttemptAt: new Date(1000),
    });
    await writer.update(schema.agentDirectoryEntries).set({ profileUriHash: uriHashOf(linkOf("queued.example", 511)) }).where(eq(schema.agentDirectoryEntries.externalKey, keyOf(511)));
    answers.set(linkOf("queued.example", 511), { status: "resolved", name: "Queued Agent" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      reset();
      const shape = await run({ readUris: async () => null });
      expect(shape).toMatchObject({ chain: "failed", read: 1, resolved: 1, entriesNamed: 1 });
      expect((await entry(511)).displayName).toBe("Queued Agent");
      expect(JSON.parse(String(error.mock.calls[0]![0])).message).toBe("the tokenURI answer had an unexpected shape; chain reads are paused for 0.5 hours");
      expect(await run()).toMatchObject({ chain: "paused" });
      names.resetRobinhoodNamesClock();
      error.mockClear();
      const other = await run({ readUris: async () => { throw new Error("socket hang up"); } });
      expect(other).toMatchObject({ chain: "failed" });
      expect(JSON.parse(String(error.mock.calls[0]![0])).message).toBe("the tokenURI read could not be made: socket hang up; chain reads are paused for 0.5 hours");
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it("leaves the chain alone when the stored source is not the approved node", async () => {
    names.resetRobinhoodNamesClock();
    await writer.update(schema.ingestionSources).set({ rootUrl: "https://elsewhere.example" }).where(eq(schema.ingestionSources.id, sourceId));
    try {
      reset();
      expect(await run()).toMatchObject({ chain: "skipped", discovered: 0 });
      expect(chainCalls).toEqual([]);
    } finally {
      await writer.update(schema.ingestionSources).set({ rootUrl: "https://rpc.mainnet.chain.robinhood.com" }).where(eq(schema.ingestionSources.id, sourceId));
    }
  });
});
