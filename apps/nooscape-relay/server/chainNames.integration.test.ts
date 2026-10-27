import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as schema from "../drizzle/schema";
import { externalKey } from "./ingestion/erc8004Chain";
import { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN, type Erc8004Chain } from "./ingestion/erc8004Chains";
import { Erc8004RpcBusyError, Erc8004RpcHttpError } from "./ingestion/erc8004Rpc";
import type { RegistrationNameResult } from "./ingestion/registrationFetch";
import { entryNameNote, uriHashOf } from "./robinhoodNamesCore";

/**
 * The Base, Arc and Ethereum name step against a real database (docs/approvals/2026-10-26-base-arc-names.md): the links read from the chain for
 * the entries that show the placeholder, newest first; the check that a link is the one the registry row recorded; the links queued,
 * read and kept; the names written where the name is still the placeholder; the names laid back over an entry the listing published
 * again; the pace of the reads; a node that limits its callers; and the gates of the step: the chain's switch, its source, its node and
 * its turn. The chain and the fetch are functions that answer per id and per link; the real chain read is in chainNamesRead.test.ts.
 * Skips when no database is reachable.
 */
// The directory reads are cached; the step clears them when it has named an entry. Nothing else about the cache is under test here.
const cache = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock("./readCache", async importOriginal => ({ ...(await importOriginal<typeof import("./readCache")>()), invalidateDirectoryReadsSoftly: cache.invalidate }));

const TEST_DB = "nooscape_chain_names_test";
const DB_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";

const dbReachable = await (async () => {
  try {
    const probe = await createConnection(`${DB_URL}/mysql`);
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

const CID = "QmcsZip4oMCkS8UhrXDmG2Bo1WMaJzbQa35RX2h5QRn1xx";
const BOTH = "chain_base,chain_arc";
const ALL = "chain_base,chain_arc,chain_ethereum";
const keyOf = (chain: Erc8004Chain, id: number) => externalKey(chain, String(id));
const linkOf = (host: string, id: number) => `https://${host}/agent/${id}.json`;
const inline = (record: Record<string, unknown>) => `data:application/json;base64,${Buffer.from(JSON.stringify(record)).toString("base64")}`;
const NOTE = "Base ERC-8004 registration. The registry-recorded URI is a web link. Nooscape did not fetch it when it recorded this registration.";
const ZERO_WIDTH = String.fromCharCode(0x200b);
const BELL = String.fromCharCode(7);

describe.skipIf(!dbReachable)("the Base, Arc and Ethereum name step against a real database", { timeout: 60_000 }, () => {
  let names: typeof import("./chainNames");
  let listing: typeof import("./agentRegistryRows");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  const sourceIds = new Map<string, string>([
    [BASE_CHAIN.chainKey, "src-base"],
    [ARC_CHAIN.chainKey, "src-arc"],
    [ETHEREUM_CHAIN.chainKey, "src-ethereum"],
  ]);
  const idOf = (chain: Erc8004Chain) => sourceIds.get(chain.chainKey)!;

  /** What the fake chain answers for an id (a string, or null for a read that fails), and every batch it was asked. */
  const onChain = new Map<string, string | null>();
  const chainCalls: Array<{ chain: string; ids: string[] }> = [];
  const readUris = async (chain: Erc8004Chain, _source: unknown, ids: string[]) => {
    chainCalls.push({ chain: chain.chainKey, ids });
    return ids.map(id => onChain.get(`${chain.chainKey}:${id}`) ?? null);
  };
  /** What the fake fetch answers for a link, and every link it was asked. */
  const answers = new Map<string, RegistrationNameResult>();
  const asked: string[] = [];
  const resolve = async (uri: string): Promise<RegistrationNameResult> => {
    asked.push(uri);
    return answers.get(uri) ?? { status: "failed", reason: "no answer was set" };
  };
  const run = (over: Partial<import("./chainNames").ChainNamesDeps> & { tickStartedAt?: number } = {}) =>
    names.runChainNames({ resolve, readUris, intervalMs: 0, features: BOTH, ...over });
  const only = (chain: Erc8004Chain) => ({ chains: [chain] });

  const entry = async (chain: Erc8004Chain, id: number) =>
    (await writer.select().from(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.externalKey, keyOf(chain, id))))[0]!;
  const rows = async () => await writer.select().from(schema.agentRegistrationResolutions);
  const rowOf = async (uriHash: string) => (await rows()).find(row => row.uriHash === uriHash);
  /** An entry as the listing publishes it: the placeholder, the hash of the link the registry row recorded, and the registration note. */
  async function seed(chain: Erc8004Chain, id: number, recorded: string | null, over: { name?: string; note?: string | null; hidden?: boolean } = {}) {
    await writer.insert(schema.agentDirectoryEntries).values({
      id: `${chain.chainKey}-entry-${id}`,
      sourceId: idOf(chain),
      externalKey: keyOf(chain, id),
      displayName: over.name ?? `Agent #${id}`,
      protocol: chain.protocol as "erc8004_base" | "erc8004_arc" | "erc8004_eth",
      sourceSignalNote: over.note === undefined ? NOTE : over.note,
      profileUriHash: recorded === null ? null : uriHashOf(recorded),
      hidden: over.hidden ?? false,
    });
  }
  /** An entry whose link the chain gives back as recorded. */
  async function seedLink(chain: Erc8004Chain, id: number, link: string, name?: string) {
    await seed(chain, id, link);
    onChain.set(`${chain.chainKey}:${id}`, link);
    if (name !== undefined) answers.set(link, { status: "resolved", name });
  }
  const today = () => new Date().toISOString().slice(0, 10);

  let logSpy: MockInstance;
  let errorSpy: MockInstance;

  beforeAll(async () => {
    const admin = await createConnection(`${DB_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

    process.env.DATABASE_URL = `${DB_URL}/${TEST_DB}`;
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    const baselineReplay = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baselineReplay.query(statement);
    }
    await baselineReplay.end();
    await applyPendingMigrations(process.env.DATABASE_URL);
    // Migration 0046 is the owner's to paste (the boot runner skips it): it adds the protocol values of Ethereum, Base and Arc.
    const manual = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8"))) await manual.query(statement);
    await manual.end();

    names = await import("./chainNames");
    listing = await import("./agentRegistryRows");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "chain-names-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "chain-names-operator"));
    for (const chain of [BASE_CHAIN, ARC_CHAIN, ETHEREUM_CHAIN]) {
      const host = chain.provider.kind === "pinned" ? chain.provider.allowedHostname : "arc-node.example";
      await writer.insert(schema.ingestionSources).values({
        id: idOf(chain),
        sourceKey: chain.sourceKey,
        label: `${chain.label} names test`,
        protocol: chain.protocol as "erc8004_base" | "erc8004_arc" | "erc8004_eth",
        rootUrl: `https://${host}`,
        allowedHostname: host,
        state: "active",
        createdByUserId: operator!.id,
      });
    }
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${DB_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  beforeEach(async () => {
    // Each test starts from no entries, no kept reads, no pause and the first chain's turn.
    await writer.delete(schema.agentRegistrationResolutions);
    await writer.delete(schema.agentDirectoryRegistryRows);
    await writer.delete(schema.agentDirectoryEntries);
    await writer.update(schema.ingestionSources).set({ state: "active" });
    onChain.clear();
    answers.clear();
    asked.length = 0;
    chainCalls.length = 0;
    names.resetChainNamesClock();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("reads the links of the entries that show the placeholder in one batch, newest first, and names them from their files", async () => {
    // 100 and 101 are links to read. 102 holds JSON inside its link and no name. 103's link on the chain is not the one the row
    // recorded. 104's token reverts. 105 has a name of its own, and 106 is hidden.
    await seedLink(BASE_CHAIN, 100, linkOf("hosta.example", 100), "Alpha Bot");
    await seedLink(BASE_CHAIN, 101, `ipfs://${CID}`, "Beta");
    await seedLink(BASE_CHAIN, 102, inline({ description: "no name" }));
    await seed(BASE_CHAIN, 103, linkOf("hosta.example", 103));
    onChain.set("base:103", linkOf("hosta.example", 9103));
    await seed(BASE_CHAIN, 104, linkOf("hosta.example", 104));
    await seed(BASE_CHAIN, 105, linkOf("hosta.example", 105), { name: "Mark" });
    await seed(BASE_CHAIN, 106, linkOf("hosta.example", 106), { hidden: true });

    const outcome = await run(only(BASE_CHAIN));
    expect(outcome).toMatchObject({ state: "completed", chain: "base", healed: 0, discovered: 5, queued: 2, settled: 3, read: 2, resolved: 2, noName: 0, failed: 0, entriesNamed: 2, chainRead: "read", stoppedBy: null });
    // One batch, the newest first; the entry with a name and the hidden one are not in it.
    expect(chainCalls).toEqual([{ chain: "base", ids: ["104", "103", "102", "101", "100"] }]);
    expect([...asked].sort()).toEqual([`ipfs://${CID}`, linkOf("hosta.example", 100)].sort());
    expect((await entry(BASE_CHAIN, 100)).displayName).toBe("Alpha Bot");
    expect((await entry(BASE_CHAIN, 101)).displayName).toBe("Beta");
    for (const id of [102, 103, 104]) expect((await entry(BASE_CHAIN, id)).displayName, `${id}`).toBe(`Agent #${id}`);
    expect((await entry(BASE_CHAIN, 105)).displayName).toBe("Mark");
    expect((await entry(BASE_CHAIN, 106)).displayName).toBe("Agent #106");
    // The note says when the name was read, and only the notes of named entries change.
    expect((await entry(BASE_CHAIN, 100)).sourceSignalNote).toBe(`${NOTE}${entryNameNote(today())}`);
    expect((await entry(BASE_CHAIN, 102)).sourceSignalNote).toBe(NOTE);
    // What is kept: the two files that were read, and a settled row, never due, for each link that is not to be read.
    expect(await rowOf(uriHashOf(linkOf("hosta.example", 100)))).toMatchObject({ uriKind: "web", status: "resolved", attempts: 1, resolvedName: "Alpha Bot", uri: linkOf("hosta.example", 100), externalKey: keyOf(BASE_CHAIN, 100) });
    expect(await rowOf(uriHashOf(`ipfs://${CID}`))).toMatchObject({ uriKind: "ipfs", status: "resolved", attempts: 1, resolvedName: "Beta" });
    expect(await rowOf(uriHashOf(inline({ description: "no name" })))).toMatchObject({ uriKind: "other", status: "no_name", uri: "", resolvedName: null });
    expect(await rowOf(uriHashOf(linkOf("hosta.example", 103)))).toMatchObject({ uriKind: "other", status: "failed", failReason: "the link on the chain is not the one recorded", uri: "" });
    expect(await rowOf(uriHashOf(linkOf("hosta.example", 104)))).toMatchObject({ uriKind: "other", status: "failed", failReason: "the chain gave no link", uri: "" });
    expect((await rows()).length).toBe(5);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]![0]))).toMatchObject({ event: "nooscape_chain_names", chain: "base", read: 2, entriesNamed: 2 });

    // A second run asks neither the chain nor anyone else about any of them, and says nothing.
    chainCalls.length = 0;
    asked.length = 0;
    logSpy.mockClear();
    expect(await run(only(BASE_CHAIN))).toMatchObject({ state: "completed", chain: null, discovered: 0, read: 0, healed: 0, chainRead: null });
    expect(chainCalls).toEqual([]);
    expect(asked).toEqual([]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("names an entry from JSON that its link holds, with no request, and keeps the name for the entry's next publication", async () => {
    // Registered with no link, then set to JSON that carries a name: the pass named it from the link it was registered with, so it shows the placeholder.
    const named = inline({ name: "Inline Named", description: "set after registration" });
    const numeric = inline({ name: "4242" });
    await seedLink(BASE_CHAIN, 1030, named);
    await seedLink(BASE_CHAIN, 1031, numeric);
    expect(await run(only(BASE_CHAIN))).toMatchObject({ discovered: 2, queued: 0, settled: 2, read: 0, entriesNamed: 1 });
    expect(asked).toEqual([]);
    expect(await entry(BASE_CHAIN, 1030)).toMatchObject({ displayName: "Inline Named", sourceSignalNote: `${NOTE}${entryNameNote(today())}` });
    // A name that is only a number is not shown, whatever it came from.
    expect((await entry(BASE_CHAIN, 1031)).displayName).toBe("Agent #1031");
    expect(await rowOf(uriHashOf(named))).toMatchObject({ uriKind: "inline", status: "resolved", resolvedName: "Inline Named", uri: "", attempts: 1 });
    expect(await rowOf(uriHashOf(numeric))).toMatchObject({ uriKind: "other", status: "no_name", resolvedName: null });
    // The entry is published again with the placeholder, and the name is laid back without a request to the chain or anyone.
    await writer.update(schema.agentDirectoryEntries).set({ displayName: "Agent #1030", sourceSignalNote: NOTE }).where(eq(schema.agentDirectoryEntries.externalKey, keyOf(BASE_CHAIN, 1030)));
    chainCalls.length = 0;
    expect(await run(only(BASE_CHAIN))).toMatchObject({ healed: 1, entriesNamed: 1, discovered: 0 });
    expect(chainCalls).toEqual([]);
    expect((await entry(BASE_CHAIN, 1030)).displayName).toBe("Inline Named");
  });

  it("names an entry whose link the pass has since updated, once the row records the link the chain gives", async () => {
    const before = linkOf("hosta.example", 1);
    const after = linkOf("hosta.example", 2);
    await seed(BASE_CHAIN, 200, before);
    onChain.set("base:200", after);
    answers.set(after, { status: "resolved", name: "After Update" });
    expect(await run(only(BASE_CHAIN))).toMatchObject({ discovered: 1, queued: 0, settled: 1, read: 0, entriesNamed: 0 });
    expect((await entry(BASE_CHAIN, 200)).displayName).toBe("Agent #200");
    // The pass reads the update and the listing refresh copies the new hash onto the entry; the entry has no row for it yet.
    await writer.update(schema.agentDirectoryEntries).set({ profileUriHash: uriHashOf(after) }).where(eq(schema.agentDirectoryEntries.externalKey, keyOf(BASE_CHAIN, 200)));
    expect(await run(only(BASE_CHAIN))).toMatchObject({ discovered: 1, queued: 1, read: 1, resolved: 1, entriesNamed: 1 });
    expect((await entry(BASE_CHAIN, 200)).displayName).toBe("After Update");
    expect(asked).toEqual([after]);
  });

  it("lays a name that was read over an entry that shows the placeholder again, with no request", async () => {
    // The row of a link that was read, and an entry that shows the placeholder (published again from its registry row).
    const link = linkOf("hosta.example", 300);
    await seed(BASE_CHAIN, 300, link);
    await writer.insert(schema.agentRegistrationResolutions).values({
      id: "kept-300", sourceId: idOf(BASE_CHAIN), externalKey: keyOf(BASE_CHAIN, 300), uriHash: uriHashOf(link), uriKind: "web", uri: link,
      status: "resolved", failReason: null, resolvedName: "Gamma", attempts: 1, lastAttemptAt: new Date(), fetchedAt: new Date(),
    });
    expect(await run(only(BASE_CHAIN))).toMatchObject({ state: "completed", healed: 1, entriesNamed: 1, discovered: 0, read: 0, chainRead: null });
    expect(chainCalls).toEqual([]);
    expect(asked).toEqual([]);
    expect(await entry(BASE_CHAIN, 300)).toMatchObject({ displayName: "Gamma", sourceSignalNote: `${NOTE}${entryNameNote(today())}` });
    // Once named it is healed no more, and its note is not written twice.
    expect(await run(only(BASE_CHAIN))).toMatchObject({ healed: 0, entriesNamed: 0 });
    expect((await entry(BASE_CHAIN, 300)).sourceSignalNote).toBe(`${NOTE}${entryNameNote(today())}`);
  });

  it("keeps a link that did not answer queued, tries it again after six hours, and names the entry when it answers", async () => {
    const link = linkOf("flaky.example", 400);
    await seedLink(BASE_CHAIN, 400, link);
    answers.set(link, { status: "failed", reason: "HTTP 503" });
    expect(await run(only(BASE_CHAIN))).toMatchObject({ discovered: 1, queued: 1, read: 1, failed: 1, entriesNamed: 0 });
    expect(await entry(BASE_CHAIN, 400)).toMatchObject({ displayName: "Agent #400" });
    expect(await rowOf(uriHashOf(link))).toMatchObject({ status: "failed", attempts: 1, failReason: "HTTP 503" });
    // Five hours on it is not asked again, and the chain is not asked for it either. (The clock is the step's own, so the test does not
    // lean on how the database rounds the time of the last try.)
    const hoursOn = (hours: number) => ({ now: () => Date.now() + hours * 3_600_000 });
    chainCalls.length = 0;
    asked.length = 0;
    expect(await run({ ...only(BASE_CHAIN), ...hoursOn(5) })).toMatchObject({ discovered: 0, read: 0 });
    expect(chainCalls).toEqual([]);
    expect(asked).toEqual([]);
    // Seven hours on it is.
    answers.set(link, { status: "resolved", name: "Flaky Agent" });
    expect(await run({ ...only(BASE_CHAIN), ...hoursOn(7) })).toMatchObject({ read: 1, resolved: 1, entriesNamed: 1 });
    expect(await entry(BASE_CHAIN, 400)).toMatchObject({ displayName: "Flaky Agent" });
    expect(await rowOf(uriHashOf(link))).toMatchObject({ status: "resolved", attempts: 2 });
  });

  it("stops asking for a link after the tries the other name reads give it", async () => {
    const dead = linkOf("dead.example", 410);
    const empty = linkOf("empty.example", 411);
    await seedLink(BASE_CHAIN, 410, dead);
    await seedLink(BASE_CHAIN, 411, empty);
    answers.set(dead, { status: "failed", reason: "HTTP 503" });
    answers.set(empty, { status: "no_name" });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await run(only(BASE_CHAIN));
      await writer.update(schema.agentRegistrationResolutions).set({ lastAttemptAt: new Date(Date.now() - 7 * 3_600_000) });
    }
    // Five tries for a link that does not answer, two for a file with no name in it; the sixth run asks neither.
    expect(asked.filter(uri => uri === dead).length).toBe(5);
    expect(asked.filter(uri => uri === empty).length).toBe(2);
    asked.length = 0;
    await run(only(BASE_CHAIN));
    expect(asked).toEqual([]);
    expect(await rowOf(uriHashOf(dead))).toMatchObject({ status: "failed", attempts: 5 });
    expect(await rowOf(uriHashOf(empty))).toMatchObject({ status: "no_name", attempts: 2 });
  });

  it("reads at most the limit of files in a run and a few from any one host, newest first, and carries on in the next", async () => {
    for (let id = 500; id < 510; id += 1) await seedLink(BASE_CHAIN, id, linkOf("platform.example", id), `Platform ${id}`);
    for (let id = 510; id < 513; id += 1) await seedLink(BASE_CHAIN, id, linkOf("other.example", id), `Other ${id}`);
    const first = await run({ ...only(BASE_CHAIN), maxDiscover: 13 });
    expect(first).toMatchObject({ discovered: 13, read: 9, resolved: 9, entriesNamed: 9 });
    // Six from the platform, the highest ids, and all three of the other host.
    expect(asked.filter(uri => uri.includes("platform.example")).sort()).toEqual([509, 508, 507, 506, 505, 504].map(id => linkOf("platform.example", id)).sort());
    expect(asked.filter(uri => uri.includes("other.example")).length).toBe(3);
    asked.length = 0;
    const second = await run(only(BASE_CHAIN));
    expect(second).toMatchObject({ discovered: 0, read: 4, resolved: 4 });
    expect(asked.filter(uri => uri.includes("platform.example")).length).toBe(4);
    expect((await entry(BASE_CHAIN, 500)).displayName).toBe("Platform 500");
  });

  it("finds at most the batch size of entries in a run, and the next run takes the next ones", async () => {
    for (let id = 600; id < 610; id += 1) await seedLink(BASE_CHAIN, id, linkOf("quiet.example", id), `Quiet ${id}`);
    await run({ ...only(BASE_CHAIN), maxDiscover: 4, maxNames: 0 });
    expect(chainCalls).toEqual([{ chain: "base", ids: ["609", "608", "607", "606"] }]);
    chainCalls.length = 0;
    await run({ ...only(BASE_CHAIN), maxDiscover: 4, maxNames: 0 });
    expect(chainCalls).toEqual([{ chain: "base", ids: ["605", "604", "603", "602"] }]);
    // The links found are queued, so the next run with room to read takes the newest of them first.
    asked.length = 0;
    await run({ ...only(BASE_CHAIN), maxDiscover: 4, maxNames: 3 });
    expect(chainCalls.at(-1)!.ids).toEqual(["601", "600"]);
    expect(asked).toEqual([linkOf("quiet.example", 609), linkOf("quiet.example", 608), linkOf("quiet.example", 607)]);
  });

  it("writes a name only where the name is still the placeholder", async () => {
    const link = linkOf("hosta.example", 700);
    await seedLink(BASE_CHAIN, 700, link, "Read Name");
    // The entry gets a name of its own between the read of its link and the naming.
    const outcome = await run({
      ...only(BASE_CHAIN),
      resolve: async uri => {
        await writer.update(schema.agentDirectoryEntries).set({ displayName: "Its Own Name" }).where(eq(schema.agentDirectoryEntries.externalKey, keyOf(BASE_CHAIN, 700)));
        return resolve(uri);
      },
    });
    expect(outcome).toMatchObject({ state: "completed", read: 1, resolved: 1, entriesNamed: 0 });
    expect((await entry(BASE_CHAIN, 700)).displayName).toBe("Its Own Name");
  });

  it("does not take a name that is only a number, reads like the placeholder or cleans to nothing, and records it as a file with no name", async () => {
    const cases: Array<[number, string]> = [
      [710, "12345"],
      [711, "Agent #77"],
      [712, `${ZERO_WIDTH}${BELL} `],
      [713, "agent #5"],
    ];
    for (const [id, name] of cases) await seedLink(BASE_CHAIN, id, linkOf("odd.example", id), name);
    await seedLink(BASE_CHAIN, 714, linkOf("odd.example", 714), "A Real Name");
    expect(await run(only(BASE_CHAIN))).toMatchObject({ read: 5, resolved: 1, noName: 4, entriesNamed: 1 });
    for (const [id] of cases) {
      expect((await entry(BASE_CHAIN, id)).displayName, `${id}`).toBe(`Agent #${id}`);
      expect(await rowOf(uriHashOf(linkOf("odd.example", id))), `${id}`).toMatchObject({ status: "no_name", resolvedName: null, attempts: 1 });
    }
    expect((await entry(BASE_CHAIN, 714)).displayName).toBe("A Real Name");
  });

  it("cuts the note at the width of its column", async () => {
    const link = linkOf("hosta.example", 720);
    await seed(BASE_CHAIN, 720, link, { note: "x".repeat(500) });
    onChain.set("base:720", link);
    answers.set(link, { status: "resolved", name: "Long Note Agent" });
    await run(only(BASE_CHAIN));
    const long = await entry(BASE_CHAIN, 720);
    expect(long.displayName).toBe("Long Note Agent");
    expect(long.sourceSignalNote!.length).toBe(512);
  });

  it("stops reading the chain for two hours when the node limits its callers, says so once, and starts again when told the time has passed", async () => {
    await seedLink(BASE_CHAIN, 800, linkOf("hosta.example", 800), "After The Throttle");
    const throttled = await run({ ...only(BASE_CHAIN), readUris: async () => { throw new Erc8004RpcHttpError(429, "Base eth_call returned HTTP 429."); } });
    expect(throttled).toMatchObject({ state: "completed", chain: null, chainRead: "throttled", discovered: 0 });
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(errorSpy.mock.calls[0]![0]))).toEqual({
      event: "nooscape_chain_names_failed",
      message: "the Base tokenURI read could not be made: Base eth_call returned HTTP 429.; chain reads are paused for 2 hours",
    });
    // Nothing was recorded for the entry, and the next run does not ask the chain at all.
    expect(await rows()).toEqual([]);
    expect(await run(only(BASE_CHAIN))).toMatchObject({ chainRead: "paused", discovered: 0 });
    expect(chainCalls).toEqual([]);
    // Two hours on, it asks again.
    names.resetChainNamesClock();
    expect(await run(only(BASE_CHAIN))).toMatchObject({ chain: "base", chainRead: "read", discovered: 1, entriesNamed: 1 });
  });

  it("treats a forbidden answer, and a node that says it is busy, as a throttle too", async () => {
    await seedLink(BASE_CHAIN, 810, linkOf("hosta.example", 810), "Busy Agent");
    for (const error of [new Erc8004RpcHttpError(403, "Base eth_call returned HTTP 403."), new Erc8004RpcBusyError("Base eth_call failed at the RPC layer: rate limit")]) {
      names.resetChainNamesClock();
      errorSpy.mockClear();
      expect(await run({ ...only(BASE_CHAIN), readUris: async () => { throw error; } })).toMatchObject({ chainRead: "throttled" });
      expect(String(errorSpy.mock.calls[0]![0])).toContain("chain reads are paused for 2 hours");
    }
  });

  it("pauses for a shorter time after any other failure or an answer of the wrong shape", async () => {
    await seedLink(BASE_CHAIN, 820, linkOf("hosta.example", 820), "Other Failure");
    const shape = await run({ ...only(BASE_CHAIN), readUris: async () => null });
    expect(shape).toMatchObject({ chainRead: "failed", discovered: 0 });
    expect(JSON.parse(String(errorSpy.mock.calls[0]![0])).message).toBe("the Base tokenURI answer had an unexpected shape; chain reads are paused for 0.5 hours");
    expect(await run(only(BASE_CHAIN))).toMatchObject({ chainRead: "paused" });
    names.resetChainNamesClock();
    errorSpy.mockClear();
    expect(await run({ ...only(BASE_CHAIN), readUris: async () => { throw new Error("socket hang up"); } })).toMatchObject({ chainRead: "failed" });
    expect(JSON.parse(String(errorSpy.mock.calls[0]![0])).message).toBe("the Base tokenURI read could not be made: socket hang up; chain reads are paused for 0.5 hours");
  });

  it("still reads the links that are queued, and names what it can, while the chain read is paused", async () => {
    const link = linkOf("queued.example", 830);
    await seed(BASE_CHAIN, 830, link);
    await writer.insert(schema.agentRegistrationResolutions).values({
      id: "queued-830", sourceId: idOf(BASE_CHAIN), externalKey: keyOf(BASE_CHAIN, 830), uriHash: uriHashOf(link), uriKind: "web", uri: link,
      status: "failed", failReason: "not read yet", resolvedName: null, attempts: 0, lastAttemptAt: new Date(1000),
    });
    answers.set(link, { status: "resolved", name: "Queued Agent" });
    await seedLink(BASE_CHAIN, 831, linkOf("hosta.example", 831), "Waiting For The Chain");
    const outcome = await run({ ...only(BASE_CHAIN), readUris: async () => { throw new Error("node down"); } });
    expect(outcome).toMatchObject({ chain: "base", chainRead: "failed", read: 1, resolved: 1, entriesNamed: 1 });
    expect((await entry(BASE_CHAIN, 830)).displayName).toBe("Queued Agent");
    expect((await entry(BASE_CHAIN, 831)).displayName).toBe("Agent #831");
  });

  it("does not read the link of an entry that left the listing, was hidden, or has a name", async () => {
    const gone = linkOf("gone.example", 840);
    const hidden = linkOf("hidden.example", 841);
    const named = linkOf("named.example", 842);
    for (const [id, link] of [[840, gone], [841, hidden], [842, named]] as const) {
      await writer.insert(schema.agentRegistrationResolutions).values({
        id: `queued-${id}`, sourceId: idOf(BASE_CHAIN), externalKey: keyOf(BASE_CHAIN, id), uriHash: uriHashOf(link), uriKind: "web", uri: link,
        status: "failed", failReason: "not read yet", resolvedName: null, attempts: 0, lastAttemptAt: new Date(1000),
      });
    }
    await seed(BASE_CHAIN, 841, hidden, { hidden: true });
    await seed(BASE_CHAIN, 842, named, { name: "Has A Name" });
    expect(await run(only(BASE_CHAIN))).toMatchObject({ read: 0, discovered: 0 });
    expect(asked).toEqual([]);
  });

  it("never reads a row that is not a web or ipfs link, whatever its tries or its date", async () => {
    // A row of another kind, written with no tries and an old date, would be handed to the reader with an empty address if the step
    // went by its tries alone.
    const link = linkOf("hosta.example", 845);
    await seed(BASE_CHAIN, 845, link);
    await writer.insert(schema.agentRegistrationResolutions).values({
      id: "other-845", sourceId: idOf(BASE_CHAIN), externalKey: keyOf(BASE_CHAIN, 845), uriHash: uriHashOf(link), uriKind: "other", uri: "",
      status: "failed", failReason: "the chain gave no link", resolvedName: null, attempts: 0, lastAttemptAt: new Date(1000),
    });
    expect(await run(only(BASE_CHAIN))).toMatchObject({ read: 0, discovered: 0 });
    expect(asked).toEqual([]);
  });

  it("leaves the chain alone, and still reads what is queued, when the stored source is not the approved node", async () => {
    const link = linkOf("hosta.example", 850);
    await seedLink(BASE_CHAIN, 850, link, "Elsewhere");
    await writer.update(schema.ingestionSources).set({ rootUrl: "https://elsewhere.example" }).where(eq(schema.ingestionSources.id, idOf(BASE_CHAIN)));
    try {
      expect(await run(only(BASE_CHAIN))).toMatchObject({ chainRead: "skipped", discovered: 0, read: 0 });
      expect(chainCalls).toEqual([]);
    } finally {
      await writer.update(schema.ingestionSources).set({ rootUrl: "https://base-mainnet.g.alchemy.com" }).where(eq(schema.ingestionSources.id, idOf(BASE_CHAIN)));
    }
  });

  it("holds an Arc source to the host its own row records, and not to a host in the code", async () => {
    await seedLink(ARC_CHAIN, 860, linkOf("arc-agents.example", 860), "Arc Agent");
    expect(await run(only(ARC_CHAIN))).toMatchObject({ chain: "arc", chainRead: "read", discovered: 1, entriesNamed: 1 });
    expect((await entry(ARC_CHAIN, 860)).displayName).toBe("Arc Agent");
    await seedLink(ARC_CHAIN, 861, linkOf("arc-agents.example", 861), "Moved Node");
    names.resetChainNamesClock();
    await writer.update(schema.ingestionSources).set({ rootUrl: "https://other-node.example" }).where(eq(schema.ingestionSources.id, idOf(ARC_CHAIN)));
    try {
      chainCalls.length = 0;
      expect(await run(only(ARC_CHAIN))).toMatchObject({ chainRead: "skipped" });
      expect(chainCalls).toEqual([]);
    } finally {
      await writer.update(schema.ingestionSources).set({ rootUrl: "https://arc-node.example" }).where(eq(schema.ingestionSources.id, idOf(ARC_CHAIN)));
    }
  });

  it("does nothing for a chain whose switch is off, and a source that is not active", async () => {
    await seedLink(BASE_CHAIN, 870, linkOf("hosta.example", 870), "Base One");
    await seedLink(ARC_CHAIN, 871, linkOf("arc-agents.example", 871), "Arc One");
    expect(await run({ features: "" })).toEqual({ state: "no_source" });
    expect(await run({ features: "claims,chain_arc_not_this_one" })).toEqual({ state: "no_source" });
    expect(chainCalls).toEqual([]);
    // Only Base is on: Arc's entry is left alone, whoever's turn it is.
    names.resetChainNamesClock();
    expect(await run({ features: "chain_base" })).toMatchObject({ chain: "base", entriesNamed: 1 });
    expect((await entry(ARC_CHAIN, 871)).displayName).toBe("Agent #871");
    // A paused source is not read either.
    names.resetChainNamesClock();
    await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, idOf(ARC_CHAIN)));
    expect(await run({ ...only(ARC_CHAIN) })).toEqual({ state: "no_source" });
    expect((await entry(ARC_CHAIN, 871)).displayName).toBe("Agent #871");
  });

  it("takes one chain a run in turn, and leaves the run to the next chain when one has nothing to ask", async () => {
    for (let id = 900; id < 903; id += 1) await seedLink(BASE_CHAIN, id, linkOf("hosta.example", id), `Base ${id}`);
    for (let id = 950; id < 953; id += 1) await seedLink(ARC_CHAIN, id, linkOf("arc-agents.example", id), `Arc ${id}`);
    const small = { maxDiscover: 2, maxNames: 2 };
    expect(await run(small)).toMatchObject({ chain: "base", discovered: 2, read: 2 });
    expect(await run(small)).toMatchObject({ chain: "arc", discovered: 2, read: 2 });
    expect(await run(small)).toMatchObject({ chain: "base", discovered: 1, read: 1 });
    expect(await run(small)).toMatchObject({ chain: "arc", discovered: 1, read: 1 });
    // The turn order of the calls, one chain each time.
    expect(chainCalls.map(call => call.chain)).toEqual(["base", "arc", "base", "arc"]);
    // Everything is named and nothing is left to ask: no chain spends the run.
    expect(await run(small)).toMatchObject({ chain: null, discovered: 0, read: 0 });
    // A chain with nothing waiting leaves the run to the other, in the same run.
    await seedLink(ARC_CHAIN, 960, linkOf("arc-agents.example", 960), "Arc Only");
    names.resetChainNamesClock();
    expect(await run(small)).toMatchObject({ chain: "arc", discovered: 1, entriesNamed: 1 });
    // And so does a chain whose node is paused.
    await seedLink(BASE_CHAIN, 970, linkOf("hosta.example", 970), "Base Later");
    await seedLink(ARC_CHAIN, 971, linkOf("arc-agents.example", 971), "Arc Next");
    names.resetChainNamesClock();
    const baseDown = async (chain: Erc8004Chain, source: unknown, ids: string[]) => {
      if (chain.chainKey === "base") throw new Error("node down");
      return readUris(chain, source, ids);
    };
    expect(await run({ readUris: baseDown })).toMatchObject({ chain: "arc", chainRead: "failed", entriesNamed: 1 });
    expect((await entry(BASE_CHAIN, 970)).displayName).toBe("Agent #970");
    expect((await entry(ARC_CHAIN, 971)).displayName).toBe("Arc Next");
  });

  it("takes Ethereum in its turn after Base and Arc, and only while its switch is on", async () => {
    await seedLink(BASE_CHAIN, 1100, linkOf("hosta.example", 1100), "Base Turn");
    await seedLink(ARC_CHAIN, 1101, linkOf("arc-agents.example", 1101), "Arc Turn");
    await seedLink(ETHEREUM_CHAIN, 1102, linkOf("eth-agents.example", 1102), "Ethereum Turn");
    // Its switch is off: its entry is left alone however many runs there are, and the run it would have had goes unspent.
    expect(await run()).toMatchObject({ chain: "base", entriesNamed: 1 });
    expect(await run()).toMatchObject({ chain: "arc", entriesNamed: 1 });
    expect(await run()).toMatchObject({ chain: null, discovered: 0, read: 0 });
    expect(chainCalls.map(call => call.chain)).toEqual(["base", "arc"]);
    expect((await entry(ETHEREUM_CHAIN, 1102)).displayName).toBe("Agent #1102");
    // Switched on, it takes the turn that came round to it, and it is named from its own file.
    expect(await run({ features: ALL })).toMatchObject({ chain: "ethereum", chainRead: "read", discovered: 1, read: 1, entriesNamed: 1 });
    expect((await entry(ETHEREUM_CHAIN, 1102)).displayName).toBe("Ethereum Turn");
    expect(chainCalls.map(call => call.chain)).toEqual(["base", "arc", "ethereum"]);
  });

  it("holds an Ethereum source to NodeReal's host, and leaves the chain alone when the row records another", async () => {
    await seedLink(ETHEREUM_CHAIN, 1110, linkOf("eth-agents.example", 1110), "Ethereum Host");
    await writer.update(schema.ingestionSources).set({ rootUrl: "https://elsewhere.example" }).where(eq(schema.ingestionSources.id, idOf(ETHEREUM_CHAIN)));
    try {
      expect(await run({ ...only(ETHEREUM_CHAIN), features: ALL })).toMatchObject({ chainRead: "skipped", discovered: 0, read: 0 });
      expect(chainCalls).toEqual([]);
    } finally {
      await writer.update(schema.ingestionSources).set({ rootUrl: "https://eth-mainnet.nodereal.io" }).where(eq(schema.ingestionSources.id, idOf(ETHEREUM_CHAIN)));
    }
    names.resetChainNamesClock();
    expect(await run({ ...only(ETHEREUM_CHAIN), features: ALL })).toMatchObject({ chain: "ethereum", chainRead: "read", entriesNamed: 1 });
  });

  it("never lays one chain's name on another chain's entry, even for the same link", async () => {
    const shared = linkOf("both.example", 1);
    await seed(BASE_CHAIN, 980, shared);
    await seed(ARC_CHAIN, 981, shared);
    onChain.set("base:980", shared);
    onChain.set("arc:981", shared);
    answers.set(shared, { status: "resolved", name: "Same Link" });
    expect(await run(only(BASE_CHAIN))).toMatchObject({ entriesNamed: 1 });
    expect((await entry(BASE_CHAIN, 980)).displayName).toBe("Same Link");
    expect((await entry(ARC_CHAIN, 981)).displayName).toBe("Agent #981");
    expect((await rows()).map(row => row.sourceId)).toEqual([idOf(BASE_CHAIN)]);
  });

  it("keeps a name when the listing refreshes the entry, and names the entry again when the listing publishes it again", async () => {
    // Two registrations the listing has published, with the registry rows they were made from.
    const source = idOf(BASE_CHAIN);
    for (const id of [990, 991]) {
      const link = linkOf("listed.example", id);
      await writer.insert(schema.agentDirectoryRegistryRows).values({
        id: `row-${id}`, sourceId: source, externalKey: keyOf(BASE_CHAIN, id), displayName: `Agent #${id}`, locatorHost: "listed.example",
        protocol: "erc8004_base", sourceSignalNote: NOTE, registrant: "0x00000000000000000000000000000000000000aa", profileUriHash: uriHashOf(link), listing: 1,
      });
      onChain.set(`base:${id}`, link);
      answers.set(link, { status: "resolved", name: `Listed ${id}` });
    }
    expect(await listing.publishAgentRegistryListing(source)).toMatchObject({ inserted: 2, refreshed: 0, removed: 0 });
    expect(await run(only(BASE_CHAIN))).toMatchObject({ discovered: 2, read: 2, entriesNamed: 2 });
    const named = await entry(BASE_CHAIN, 990);
    expect(named).toMatchObject({ displayName: "Listed 990", sourceSignalNote: `${NOTE}${entryNameNote(today())}` });
    // A refresh that has something to copy (the pass rolled up a transfer) changes the entry's counts and leaves its name and note.
    await writer.update(schema.agentDirectoryRegistryRows).set({ secondaryTransferCount: 3 }).where(eq(schema.agentDirectoryRegistryRows.externalKey, keyOf(BASE_CHAIN, 990)));
    expect(await listing.publishAgentRegistryListing(source)).toMatchObject({ inserted: 0, refreshed: 1, removed: 0 });
    expect(await entry(BASE_CHAIN, 990)).toMatchObject({ displayName: "Listed 990", sourceSignalNote: named.sourceSignalNote, secondaryTransferCount: 3 });
    // The registration leaves the listing (a wallet's other registrations grouped it) and comes back: the entry is made again from the
    // row, with the placeholder, and the step lays the name back over it without a request.
    await writer.update(schema.agentDirectoryRegistryRows).set({ listing: 2 }).where(eq(schema.agentDirectoryRegistryRows.externalKey, keyOf(BASE_CHAIN, 991)));
    expect(await listing.publishAgentRegistryListing(source)).toMatchObject({ removed: 1 });
    await writer.update(schema.agentDirectoryRegistryRows).set({ listing: 1 }).where(eq(schema.agentDirectoryRegistryRows.externalKey, keyOf(BASE_CHAIN, 991)));
    expect(await listing.publishAgentRegistryListing(source)).toMatchObject({ inserted: 1 });
    expect((await entry(BASE_CHAIN, 991)).displayName).toBe("Agent #991");
    chainCalls.length = 0;
    asked.length = 0;
    expect(await run(only(BASE_CHAIN))).toMatchObject({ healed: 1, entriesNamed: 1, discovered: 0, read: 0 });
    expect(chainCalls).toEqual([]);
    expect(asked).toEqual([]);
    expect((await entry(BASE_CHAIN, 991)).displayName).toBe("Listed 991");
  });

  it("lets the pages show a new name at once: it clears the cached directory reads when it named an entry, and only then", async () => {
    await seedLink(BASE_CHAIN, 1050, linkOf("hosta.example", 1050), "Fresh Name");
    await seedLink(BASE_CHAIN, 1051, linkOf("hosta.example", 1051));
    answers.set(linkOf("hosta.example", 1051), { status: "no_name" });
    cache.invalidate.mockClear();
    // A run that names an entry clears them once.
    expect(await run(only(BASE_CHAIN))).toMatchObject({ entriesNamed: 1, noName: 1 });
    expect(cache.invalidate).toHaveBeenCalledTimes(1);
    // A run that names nothing leaves the cached pages as they are.
    cache.invalidate.mockClear();
    await seedLink(BASE_CHAIN, 1052, linkOf("hosta.example", 1052));
    answers.set(linkOf("hosta.example", 1052), { status: "failed", reason: "HTTP 503" });
    expect(await run(only(BASE_CHAIN))).toMatchObject({ entriesNamed: 0, failed: 1 });
    expect(cache.invalidate).not.toHaveBeenCalled();
  });

  it("runs at most every thirty minutes, and not on a tick that is already long", async () => {
    await seedLink(BASE_CHAIN, 1000, linkOf("hosta.example", 1000), "On Time");
    await seedLink(BASE_CHAIN, 1001, linkOf("hosta.example", 1001), "Later");
    // Not on a tick that has already run for more than 100 seconds, and that does not start the interval.
    expect(await names.runChainNames({ resolve, readUris, features: BOTH, tickStartedAt: Date.now() - 101_000 })).toEqual({ state: "too_late" });
    expect(chainCalls).toEqual([]);
    expect(await names.runChainNames({ resolve, readUris, features: BOTH, maxDiscover: 1, maxNames: 1 })).toMatchObject({ state: "completed", read: 1 });
    expect(await names.runChainNames({ resolve, readUris, features: BOTH })).toEqual({ state: "idle" });
    expect(chainCalls).toHaveLength(1);
    // Twenty-eight minutes on (the gate is two minutes under the interval) it runs again.
    const later = Date.now() + 29 * 60_000;
    expect(await names.runChainNames({ resolve, readUris, features: BOTH, now: () => later })).toMatchObject({ state: "completed", read: 1 });
  });

  it("never throws: a read that fails outright is one log line, the step says it is unavailable, and the next run works", async () => {
    const link = linkOf("hosta.example", 1010);
    await seedLink(BASE_CHAIN, 1010, link, "Recovered");
    const broken = await run({ ...only(BASE_CHAIN), resolve: async () => { throw new Error("socket closed"); } });
    expect(broken).toEqual({ state: "unavailable" });
    expect(JSON.parse(String(errorSpy.mock.calls[0]![0]))).toEqual({ event: "nooscape_chain_names_failed", message: "socket closed" });
    // The link was queued before the read failed, so the next run reads it.
    expect(await run(only(BASE_CHAIN))).toMatchObject({ state: "completed", read: 1, resolved: 1, entriesNamed: 1 });
  });

  it("does not start a second run while one is going", async () => {
    await seedLink(BASE_CHAIN, 1020, linkOf("hosta.example", 1020), "Slow");
    let release!: () => void;
    const gate = new Promise<void>(open => { release = open; });
    const slow = run({ ...only(BASE_CHAIN), resolve: async uri => { await gate; return resolve(uri); } });
    // Let the first run reach its read.
    while (chainCalls.length === 0) await new Promise(wake => setTimeout(wake, 5));
    expect(await run(only(BASE_CHAIN))).toEqual({ state: "busy" });
    release();
    expect(await slow).toMatchObject({ state: "completed", entriesNamed: 1 });
  });
});
