import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";
import type { RegistrationFileResult } from "./ingestion/registrationFetch";
import type { DirectoryEntryDraft } from "./ingestion/types";

/**
 * The BNB registration-file step against a real database (docs/approvals/2026-10-17-bnb-registration-files.md): the evidence the
 * clustering step makes for web and ipfs links, the files read for it, what each try leaves on the entry, gate G1 and the groups
 * worked out again, the tries and the pace, a stale link, a failed chain read, and a step that never throws. The chain answers
 * `aggregate3` the way Multicall3 does and the fetch is a function that answers per link; the real ones are in
 * ingestion/bscMulticall.test.ts and ingestion/registrationFetch.test.ts. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_bsc_files_test";
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
const CID = "QmcsZip4oMCkS8UhrXDmG2Bo1WMaJzbQa35RX2h5QRn1xx";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const keyOf = (n: number) => `eip155:56:${REGISTRY}:${n}`;
const WALLET = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const inline = (record: Record<string, unknown>) => `data:application/json;base64,${Buffer.from(JSON.stringify(record)).toString("base64")}`;
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
const pad = (hex: string) => hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");

/** What Multicall3 returns for `tokenURI` reads: a string for an id that has one, a revert for an id that does not. */
function aggregate3Answer(uris: Array<string | null>): string {
  const elements = uris.map(uri => {
    if (uri === null) {
      const revert = pad(`7e273289${word(1)}`);
      return `${word(0)}${word(0x40)}${word(36)}${revert}`;
    }
    const text = Buffer.from(uri, "utf8").toString("hex");
    const encoded = `${word(32)}${word(text.length / 2)}${pad(text)}`;
    return `${word(1)}${word(0x40)}${word(encoded.length / 2)}${encoded}`;
  });
  let offset = uris.length * 32;
  const offsets = elements.map(element => {
    const at = offset;
    offset += element.length / 2;
    return word(at);
  });
  return `0x${word(32)}${word(uris.length)}${offsets.join("")}${elements.join("")}`;
}

const registration = (name: string, description: string, host = "api.shared.example.io") => JSON.stringify({ name, description, services: [{ name: "web", endpoint: `https://${host}/x` }] });

describe.skipIf(!dbReachable)("the BNB registration-file step against a real database", { timeout: 60_000 }, () => {
  let step: typeof import("./bscRegistrationFiles");
  let clustering: typeof import("./bscClusteringRun");
  let registry: typeof import("./agentRegistryRows");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let pasteMigration: () => Promise<void>;
  let source: schema.IngestionSource;
  let operatorId: number;

  /** What the chain answers for an id (a string, null for a revert), for the clustering step and for this one. */
  const clusterChain = new Map<number, string | null>();
  const stepChain = new Map<number, string | null>();
  const calls: string[][] = [];
  const rpcFor = (uris: Map<number, string | null>, record: string[][] = []) => async (_method: string, params: unknown[]) => {
    const data = (params[0] as { data: string }).data;
    const ids = Array.from(data.matchAll(/c87b56dd([0-9a-f]{64})/g)).map(match => Number(BigInt(`0x${match[1]}`)));
    record.push(ids.map(String));
    return aggregate3Answer(ids.map(id => uris.get(id) ?? null));
  };
  /** What the fake fetch answers for a link, and every link it was asked. */
  const files = new Map<string, RegistrationFileResult>();
  const asked: string[] = [];
  const readFileFake = async (uri: string): Promise<RegistrationFileResult> => {
    asked.push(uri);
    return files.get(uri) ?? { status: "failed", reason: "no answer was set" };
  };
  const run = (over: Partial<import("./bscRegistrationFiles").BscRegistrationFilesDeps> & { tickStartedAt?: number } = {}) =>
    step.runBscRegistrationFiles({ rpc: rpcFor(stepChain, calls), readFile: readFileFake, intervalMs: 0, ...over });

  const draft = (n: number, uri: string, overrides: Partial<DirectoryEntryDraft> = {}): DirectoryEntryDraft => ({
    externalKey: keyOf(n),
    displayName: `Agent #${n}`,
    locatorHost: null,
    registrant: WALLET(n),
    profileUriHash: sha(uri),
    sourceSignalNote: "BNB Smart Chain ERC-8004 registration. current ownership is not verified.",
    ...overrides,
  });
  const clear = async () => {
    await writer.delete(schema.bscEntryEvidence);
    await writer.delete(schema.bscClusters);
    await writer.delete(schema.agentDirectoryRegistryRows);
  };
  const evidence = async () => new Map((await writer.select().from(schema.bscEntryEvidence)).map(row => [Number(row.externalKey.split(":").pop()), row]));
  const ages = (status: string) => writer.update(schema.bscEntryEvidence).set({ readAt: new Date(Date.now() - 7 * 3_600_000) }).where(eq(schema.bscEntryEvidence.readStatus, status));
  /** Seeds listed entries, lets the clustering step make their evidence (a web or ipfs link is `link_not_read`), and aligns the step's chain with it. */
  async function seedAndCluster(entries: Array<[number, string]>) {
    await registry.insertAgentRegistryRows({ source, runId: "run-test", drafts: entries.map(([n, uri]) => draft(n, uri)) });
    await registry.classifyAgentRegistryListing(source.id);
    for (const [n, uri] of entries) {
      clusterChain.set(n, uri);
      stepChain.set(n, uri);
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await clustering.runBscClustering({ rpc: rpcFor(clusterChain), refreshMs: 0 });
    } finally {
      log.mockRestore();
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
    pasteMigration = async () => {
      const paste = await createConnection(process.env.DATABASE_URL!);
      for (const statement of splitMigrationStatements(await readFile("drizzle/0038_bsc_clusters.sql", "utf8"))) await paste.query(statement);
      await paste.end();
    };

    const db = await import("./db");
    registry = await import("./agentRegistryRows");
    clustering = await import("./bscClusteringRun");
    step = await import("./bscRegistrationFiles");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "files-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "files-operator"));
    operatorId = operator!.id;
    await writer.insert(schema.ingestionSources).values({
      id: "src-bsc",
      sourceKey: "bsc-erc8004-identity-registry",
      label: "BNB Chain test",
      protocol: "erc8004_bsc",
      rootUrl: "https://bsc-mainnet.nodereal.io",
      allowedHostname: "bsc-mainnet.nodereal.io",
      state: "active",
      createdByUserId: operatorId,
    });
    source = (await db.getIngestionSource("src-bsc"))!;
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("does nothing and says nothing until the clustering tables are there", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run()).toEqual({ state: "unavailable" });
      expect(calls).toEqual([]);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    await pasteMigration();
  });

  it("reads the files behind web and ipfs links in one batch, keeps each entry's template key and host, and works out G1 and the groups again", async () => {
    await clear();
    const twin = registration("Twin Bot", "Looks the same");
    const links = new Map<number, string>([
      [1, "https://a.example.io/1.json"],
      [2, "https://a.example.io/2.json"],
      [3, "https://b.example.io/3.json"],
      [4, `ipfs://${CID}`],
      [5, "http://c.example.io/5.json"],
      [7, "https://d.example.io/7.json"],
      [8, "https://e.example.io/8.json"],
      [9, "https://f.example.io/9.json"],
      [10, "https://g.example.io/10.json"],
      [11, "https://h.example.io/11.json"],
    ]);
    await seedAndCluster([...Array.from(links), [6, inline({ name: "Inline Bot", description: "Carries its file", services: [{ name: "web", endpoint: "https://inline.example.io/x" }] })]]);
    // Every web and ipfs link waits as link_not_read, and the inline one has been read.
    const before = await evidence();
    expect(Array.from(before).filter(([, row]) => row.readStatus === "link_not_read").map(([n]) => n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);
    expect(before.get(6)!.readStatus).toBe("inline");

    files.set(links.get(1)!, { status: "ok", text: twin });
    files.set(links.get(2)!, { status: "ok", text: twin });
    files.set(links.get(3)!, { status: "ok", text: registration("Solo Bot", "On its own", "solo.example.io") });
    files.set(links.get(4)!, { status: "ok", text: registration("Ipfs Bot", "Lives on ipfs", "ipfs-host.example.io") });
    files.set(links.get(7)!, { status: "ok", text: "<html>not a registration</html>" });
    files.set(links.get(8)!, { status: "gone" });
    files.set(links.get(9)!, { status: "failed", reason: "HTTP 503" });
    stepChain.set(10, null);
    // The chain has moved on past the evidence for 11: its link no longer hashes to the one that was recorded.
    stepChain.set(11, "https://h.example.io/moved.json");
    calls.length = 0;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const outcome = await run();
      expect(outcome).toMatchObject({ state: "completed", waiting: 10, chain: "read", fetched: 4, unparsed: 2, failed: 1, notFetchable: 1, unreadable: 1, stale: 1, stoppedBy: null });
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
    // One multicall for the ten, and the files of the five that were asked (not the http link, the revert or the stale one).
    expect(calls.length).toBe(1);
    expect(calls[0]!.slice().sort()).toEqual(["1", "10", "11", "2", "3", "4", "5", "7", "8", "9"].sort());
    expect(asked.sort()).toEqual([1, 2, 3, 4, 7, 8, 9].map(n => links.get(n)!).sort());

    const after = await evidence();
    const status = (n: number) => after.get(n)!.readStatus;
    expect([1, 2, 3, 4].map(status)).toEqual(["fetched", "fetched", "fetched", "fetched"]);
    expect(status(5)).toBe("link_not_fetchable");
    expect(status(7)).toBe("link_unparsed_1");
    expect(status(8)).toBe("link_unparsed_1");
    expect(status(9)).toBe("link_failed_1");
    expect(status(10)).toBe("unreadable");
    expect(status(11)).toBe("link_not_read");
    expect(status(6)).toBe("inline");
    // What the files gave: the template key and the host of the first agent address, and the same key for two registrations of one text.
    expect(after.get(1)!.templateKey).toMatch(/^[0-9a-f]{16}$/);
    expect(after.get(1)!.templateKey).toBe(after.get(2)!.templateKey);
    expect(after.get(1)!.templateKey).not.toBe(after.get(3)!.templateKey);
    expect(after.get(1)!.endpointHost).toBe("api.shared.example.io");
    expect(after.get(4)!.endpointHost).toBe("ipfs-host.example.io");
    expect(after.get(7)!.templateKey).toBeNull();
    // Gate G1 and the template groups were worked out again: the twins are a template group at once, the others are independent, the rest unread.
    expect([1, 2].map(n => [after.get(n)!.g1, after.get(n)!.templateSize])).toEqual([["template_group", 2], ["template_group", 2]]);
    expect([3, 4, 6].map(n => after.get(n)!.g1)).toEqual(["independent", "independent", "independent"]);
    expect([5, 7, 8, 9, 10, 11].map(n => after.get(n)!.g1)).toEqual(Array(6).fill("unread"));
    const templates = await writer.select().from(schema.bscClusters).where(eq(schema.bscClusters.kind, "template"));
    expect(templates.map(row => [row.clusterKey, row.memberCount, row.listedCount])).toEqual([[after.get(1)!.templateKey, 2, 2]]);
    // The registration file is not kept: only the key, the host, the status and the date.
    expect(Object.keys(after.get(1)!).sort()).toEqual(["computedAt", "endpointHost", "externalKey", "g1", "id", "profileUriHash", "readAt", "readStatus", "sourceId", "templateKey", "templateSize", "walletRegistrations"].sort());
  });

  it("tries a link that gave no file or no registration again after six hours, up to the limits, and then leaves it", async () => {
    asked.length = 0;
    calls.length = 0;
    // Within six hours only the stale entry is waiting, and it stays stale.
    expect(await run()).toMatchObject({ waiting: 1, fetched: 0, stale: 1, unparsed: 0, failed: 0 });
    expect(asked).toEqual([]);
    // After six hours: 7 is still not a registration (its second and last try), 8 is still not served (the same), 9 answers.
    await ages("link_unparsed_1");
    await ages("link_failed_1");
    files.set("https://f.example.io/9.json", { status: "ok", text: registration("Late Bot", "Answered at last", "late.example.io") });
    expect(await run()).toMatchObject({ waiting: 4, fetched: 1, unparsed: 2, failed: 0, stale: 1 });
    expect((await evidence()).get(7)!.readStatus).toBe("link_unparsed_2");
    expect((await evidence()).get(8)!.readStatus).toBe("link_unparsed_2");
    expect((await evidence()).get(9)).toMatchObject({ readStatus: "fetched", endpointHost: "late.example.io" });
    // Both are settled now: nothing is asked for them again however long it has been.
    await ages("link_unparsed_2");
    asked.length = 0;
    expect(await run()).toMatchObject({ waiting: 1, unparsed: 0, fetched: 0 });
    expect(asked).toEqual([]);
  });

  it("counts a link that does not answer up to five times, six hours apart, and then settles it", async () => {
    await seedAndCluster([[20, "https://flaky.example.io/20.json"]]);
    files.set("https://flaky.example.io/20.json", { status: "failed", reason: "HTTP 503" });
    const seen: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await writer.update(schema.bscEntryEvidence).set({ readAt: new Date(Date.now() - 7 * 3_600_000) }).where(eq(schema.bscEntryEvidence.externalKey, keyOf(20)));
      expect(await run()).toMatchObject({ failed: 1 });
      seen.push((await evidence()).get(20)!.readStatus);
    }
    expect(seen).toEqual(["link_failed_1", "link_failed_2", "link_failed_3", "link_failed_4", "link_failed_5"]);
    await writer.update(schema.bscEntryEvidence).set({ readAt: new Date(Date.now() - 7 * 3_600_000) }).where(eq(schema.bscEntryEvidence.externalKey, keyOf(20)));
    asked.length = 0;
    await run();
    expect(asked).not.toContain("https://flaky.example.io/20.json");
    expect((await evidence()).get(20)!.readStatus).toBe("link_failed_5");
  });

  it("reads at most a few files from one host in a run, and the rest in the next", async () => {
    await clear();
    const entries: Array<[number, string]> = [];
    for (let n = 100; n < 110; n += 1) entries.push([n, `https://platform.example.io/${n}.json`]);
    for (let n = 110; n < 113; n += 1) entries.push([n, `https://other.example.io/${n}.json`]);
    await seedAndCluster(entries);
    for (const [n, uri] of entries) files.set(uri, { status: "ok", text: registration(`Bot ${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`, `Entry ${n}`, `host-${n}.example.io`) });
    asked.length = 0;
    expect(await run()).toMatchObject({ waiting: 13, fetched: 9 });
    expect(asked.filter(uri => new URL(uri).hostname === "platform.example.io").length).toBe(6);
    expect(asked.filter(uri => new URL(uri).hostname === "other.example.io").length).toBe(3);
    asked.length = 0;
    expect(await run()).toMatchObject({ waiting: 4, fetched: 4 });
    expect(asked.filter(uri => new URL(uri).hostname === "platform.example.io").length).toBe(4);
  });

  it("finds at most the batch size of entries in a run, oldest first", async () => {
    await clear();
    const entries: Array<[number, string]> = [];
    for (let n = 200; n < 210; n += 1) entries.push([n, `https://batch.example.io/${n}.json`]);
    await seedAndCluster(entries);
    for (const [, uri] of entries) files.set(uri, { status: "failed", reason: "HTTP 503" });
    calls.length = 0;
    await run({ maxFiles: 4 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(4);
  });

  it("pauses chain reads for half an hour after a failed read or an answer of the wrong shape, and says so once", async () => {
    await clear();
    await seedAndCluster([[300, "https://pause.example.io/300.json"]]);
    files.set("https://pause.example.io/300.json", { status: "ok", text: registration("Pause Bot", "After the pause", "pause-host.example.io") });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      step.resetBscRegistrationFilesClock();
      const failed = await run({ rpc: async () => { throw new Error("BNB Chain eth_call returned HTTP 503."); } });
      expect(failed).toMatchObject({ state: "completed", chain: "failed", waiting: 1, fetched: 0 });
      expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({ event: "nooscape_bsc_files_failed", message: "the tokenURI read could not be made: BNB Chain eth_call returned HTTP 503.; chain reads are paused for 0.5 hours" });
      calls.length = 0;
      expect(await run()).toMatchObject({ chain: "paused" });
      expect(calls).toEqual([]);
      step.resetBscRegistrationFilesClock();
      error.mockClear();
      expect(await run({ rpc: async () => "0x1234" })).toMatchObject({ chain: "failed" });
      expect(JSON.parse(String(error.mock.calls[0]![0])).message).toBe("the tokenURI answer had an unexpected shape; chain reads are paused for 0.5 hours");
      step.resetBscRegistrationFilesClock();
      expect(await run()).toMatchObject({ chain: "read", fetched: 1 });
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it("stops starting reads when its time is up, and says so", async () => {
    await clear();
    const entries: Array<[number, string]> = [];
    for (let n = 400; n < 403; n += 1) entries.push([n, `https://time-${n}.example.io/${n}.json`]);
    await seedAndCluster(entries);
    for (const [n, uri] of entries) files.set(uri, { status: "ok", text: registration(`Timed ${n}`, `Entry ${n}`, `t-${n}.example.io`) });
    let clock = Date.now();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const outcome = await run({
        now: () => {
          const value = clock;
          clock += 10_000;
          return value;
        },
        budgetMs: 15_000,
      });
      expect(outcome).toMatchObject({ state: "completed", fetched: 1, stoppedBy: "time" });
      expect(await run()).toMatchObject({ fetched: 2 });
    } finally {
      log.mockRestore();
    }
  });

  it("runs on the next 30 minute tick even when its step starts a minute early, and not ten minutes after the last run", async () => {
    step.resetBscRegistrationFilesClock();
    const base = Date.now();
    const minutes = (count: number) => count * 60_000;
    expect(await run({ intervalMs: minutes(30), now: () => base })).toMatchObject({ state: "completed" });
    expect(await run({ intervalMs: minutes(30), now: () => base + minutes(10) })).toEqual({ state: "idle" });
    expect(await run({ intervalMs: minutes(30), now: () => base + minutes(29) })).toMatchObject({ state: "completed" });
    step.resetBscRegistrationFilesClock();
  });

  it("does nothing within its interval, with a tick that has run long, and without an active BNB source", async () => {
    step.resetBscRegistrationFilesClock();
    expect(await run({ intervalMs: 60_000 })).toMatchObject({ state: "completed" });
    expect(await run({ intervalMs: 60_000 })).toEqual({ state: "idle" });
    step.resetBscRegistrationFilesClock();
    expect(await run({ tickStartedAt: Date.now() - 120_000 })).toEqual({ state: "too_late" });
    // The limit is 100 seconds: a tick 90 seconds old still gets the step (at 60 it was skipped on the first tick, behind the names step at 76).
    expect(await run({ tickStartedAt: Date.now() - 90_000 })).toMatchObject({ state: "completed" });
    step.resetBscRegistrationFilesClock();
    await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-bsc"));
    expect(await run()).toEqual({ state: "no_source" });
    await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, "src-bsc"));
  });

  it("never throws: a read that blows up is one log line and an unavailable result, and the next run works", async () => {
    await clear();
    await seedAndCluster([[500, "https://boom.example.io/500.json"]]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      step.resetBscRegistrationFilesClock();
      expect(await run({ readFile: async () => { throw new Error("boom\nsecond line"); } })).toEqual({ state: "unavailable" });
      expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({ event: "nooscape_bsc_files_failed", message: "boom second line" });
      files.set("https://boom.example.io/500.json", { status: "ok", text: registration("Boom Bot", "Fine now", "boom-host.example.io") });
      expect(await run()).toMatchObject({ state: "completed", fetched: 1 });
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    const row = (await evidence()).get(500)!;
    expect(row).toMatchObject({ readStatus: "fetched", endpointHost: "boom-host.example.io" });
    expect(await writer.select().from(schema.bscEntryEvidence).where(and(eq(schema.bscEntryEvidence.externalKey, keyOf(500))))).toHaveLength(1);
  });
});
