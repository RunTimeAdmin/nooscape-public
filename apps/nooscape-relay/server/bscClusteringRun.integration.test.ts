import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";
import type { DirectoryEntryDraft } from "./ingestion/types";

/**
 * The BNB clustering step against a real database (docs/bsc-clusters-2026-10-16.md): the migration run as the owner would
 * paste it, the step doing nothing and saying nothing until it has, fleets over the whole registry, the evidence read for
 * each listed entry from a fake chain, gate G1 stored on the entries and as template groups, and a step that never throws.
 * The chain is a function that answers `aggregate3` the way Multicall3 does; the pure rules are in bscClusters.test.ts and
 * the real node's answer is in ingestion/bscMulticall.test.ts. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_bsc_clusters_test";
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

describe.skipIf(!dbReachable)("the BNB clustering against a real database", { timeout: 60_000 }, () => {
  let run: typeof import("./bscClusteringRun");
  let registry: typeof import("./agentRegistryRows");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let pasteMigration: () => Promise<void>;
  let source: schema.IngestionSource;
  let operatorId: number;

  /** The chain: uri for an id, or null (the read fails). Counts the calls. */
  const chain = (uris: Map<number, string | null>, calls: string[] = []) => ({
    calls,
    rpc: async (method: string, params: unknown[]) => {
      calls.push(method);
      const data = (params[0] as { data: string }).data;
      const ids = Array.from(data.matchAll(/c87b56dd([0-9a-f]{64})/g)).map(match => Number(BigInt(`0x${match[1]}`)));
      return aggregate3Answer(ids.map(id => uris.get(id) ?? null));
    },
  });

  const draft = (n: number, uri: string, overrides: Partial<DirectoryEntryDraft> = {}): DirectoryEntryDraft => ({
    externalKey: keyOf(n),
    displayName: `Agent #${n}`,
    locatorHost: null,
    registrant: WALLET(n),
    profileUriHash: sha(uri),
    sourceSignalNote: "BNB Smart Chain ERC-8004 registration. current ownership is not verified.",
    ...overrides,
  });
  const seed = (drafts: DirectoryEntryDraft[]) => registry.insertAgentRegistryRows({ source, runId: "run-test", drafts });
  const classify = () => registry.classifyAgentRegistryListing(source.id);
  const clear = async () => {
    await writer.delete(schema.bscEntryEvidence);
    await writer.delete(schema.bscClusters);
    await writer.delete(schema.agentDirectoryRegistryRows);
  };
  const evidence = async () => (await writer.select().from(schema.bscEntryEvidence)).sort((a, b) => a.externalKey.localeCompare(b.externalKey, "en", { numeric: true }));
  const clusters = async (kind?: string) => (await writer.select().from(schema.bscClusters)).filter(row => !kind || row.kind === kind);
  const go = (uris: Map<number, string | null>, over: Partial<import("./bscClusteringRun").ClusteringDeps> = {}) => {
    const fake = chain(uris);
    return { fake, result: run.runBscClustering({ rpc: fake.rpc, refreshMs: 0, ...over }) };
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
    // The tables are a manual migration, so a boot does not make them: run the file as the owner would paste it.
    pasteMigration = async () => {
      const paste = await createConnection(process.env.DATABASE_URL!);
      for (const statement of splitMigrationStatements(await readFile("drizzle/0038_bsc_clusters.sql", "utf8"))) await paste.query(statement);
      await paste.end();
    };

    const db = await import("./db");
    registry = await import("./agentRegistryRows");
    run = await import("./bscClusteringRun");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "clusters-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "clusters-operator"));
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

  describe("before the migration is run", () => {
    it("does nothing, asks the chain nothing and says nothing", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { fake, result } = go(new Map());
        expect(await result).toEqual({ state: "unavailable" });
        expect(fake.calls).toEqual([]);
        expect(log).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
    });
  });

  describe("the migration", () => {
    it("makes the tables the code relies on: their columns, the nullable ones, and the unique key of each", async () => {
      await pasteMigration();
      const probe = await createConnection(process.env.DATABASE_URL!);
      const columns = async (table: string) => ((await probe.query(`SHOW COLUMNS FROM \`${table}\``)) as [Array<{ Field: string; Null: string }>, unknown])[0];
      const indexes = async (table: string) => ((await probe.query(`SHOW INDEX FROM \`${table}\``)) as [Array<{ Key_name: string; Column_name: string; Seq_in_index: number; Non_unique: number }>, unknown])[0];
      const clusterColumns = await columns("bsc_clusters");
      const evidenceColumns = await columns("bsc_entry_evidence");
      const clusterIndexes = await indexes("bsc_clusters");
      const evidenceIndexes = await indexes("bsc_entry_evidence");
      await probe.end();
      expect(clusterColumns.map(column => column.Field)).toEqual(["id", "sourceId", "kind", "clusterKey", "label", "memberCount", "listedCount", "walletCount", "computedAt"]);
      expect(clusterColumns.filter(column => column.Null === "YES").map(column => column.Field)).toEqual(["label", "walletCount"]);
      expect(evidenceColumns.map(column => column.Field)).toEqual(["id", "sourceId", "externalKey", "profileUriHash", "readStatus", "templateKey", "endpointHost", "g1", "templateSize", "walletRegistrations", "readAt", "computedAt"]);
      expect(evidenceColumns.filter(column => column.Null === "YES").map(column => column.Field)).toEqual(["templateKey", "endpointHost"]);
      const columnsOf = (list: typeof clusterIndexes, name: string) => list.filter(index => index.Key_name === name).sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name);
      expect(columnsOf(clusterIndexes, "bsc_clusters_key_uq")).toEqual(["sourceId", "kind", "clusterKey"]);
      expect(columnsOf(clusterIndexes, "bsc_clusters_size_idx")).toEqual(["sourceId", "kind", "memberCount"]);
      expect(columnsOf(evidenceIndexes, "bsc_entry_evidence_key_uq")).toEqual(["sourceId", "externalKey"]);
      expect(columnsOf(evidenceIndexes, "bsc_entry_evidence_template_idx")).toEqual(["sourceId", "templateKey"]);
    });

    it("refers to nothing and is referred to by nothing, so both can be dropped alone", async () => {
      const probe = await createConnection(process.env.DATABASE_URL!);
      const [found] = (await probe.query(
        "SELECT TABLE_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL AND (TABLE_NAME IN ('bsc_clusters','bsc_entry_evidence') OR REFERENCED_TABLE_NAME IN ('bsc_clusters','bsc_entry_evidence'))",
        [TEST_DB]
      )) as [unknown[], unknown];
      await probe.end();
      expect(found).toEqual([]);
    });

    it("can be run again by hand without error and without touching a row", async () => {
      await writer.insert(schema.bscClusters).values({ id: "kept", sourceId: "src-bsc", kind: "wallet", clusterKey: WALLET(1), memberCount: 60, listedCount: 0 });
      await pasteMigration();
      expect((await clusters()).map(row => row.id)).toEqual(["kept"]);
      await clear();
    });
  });

  describe("fleets over the whole registry", () => {
    it("stores a wallet, a link and a host with the fleet minimum, with their sizes, and not a smaller group", async () => {
      await clear();
      const fleetUri = "https://shared.example.io/agent.json";
      await seed([
        // 52 registrations by one wallet, each with a link of its own.
        ...Array.from({ length: 52 }, (_, i) => draft(1000 + i, `https://w${i}.example.io/a.json`, { registrant: WALLET(900), locatorHost: `w${i}.example.io` })),
        // 55 registrations on one host, each by its own wallet.
        ...Array.from({ length: 55 }, (_, i) => draft(2000 + i, `https://platform.example.io/${i}.json`, { locatorHost: "platform.example.io" })),
        // 51 registrations of one link, named alike.
        ...Array.from({ length: 51 }, (_, i) => draft(3000 + i, fleetUri, { displayName: "Template Bot" })),
        // 49 on a host: below the bar.
        ...Array.from({ length: 49 }, (_, i) => draft(4000 + i, `https://small.example.io/${i}.json`, { locatorHost: "small.example.io" })),
        // No URI at all (the hash of the empty string) is not a shared link.
        ...Array.from({ length: 60 }, (_, i) => draft(5000 + i, "", { listing: 0 })),
      ]);
      await classify();
      const { fake, result } = go(new Map());
      const outcome = await result;
      expect(outcome).toMatchObject({ state: "completed", fleetsRefreshed: true, clusters: { wallet: 1, platform_host: 1, shared_link: 1, template: 0 } });
      // The 49 registrations on the small host are listed, and the fake chain knows none of them: three calls, nothing readable.
      expect(fake.calls).toEqual(["eth_call", "eth_call", "eth_call"]);
      expect(outcome).toMatchObject({ read: 49, unreadable: 49 });
      const wallet = (await clusters("wallet"))[0]!;
      expect([wallet.clusterKey, wallet.memberCount, wallet.listedCount]).toEqual([WALLET(900), 52, 0]);
      const host = (await clusters("platform_host"))[0]!;
      expect([host.clusterKey, host.label, host.memberCount]).toEqual(["platform.example.io", "platform.example.io", 55]);
      const link = (await clusters("shared_link"))[0]!;
      expect([link.clusterKey, link.label, link.memberCount]).toEqual([sha(fleetUri), "Template Bot", 51]);
      const [registry] = await clusters("registry");
      expect([registry!.clusterKey, registry!.memberCount, registry!.listedCount]).toEqual(["all", 52 + 55 + 51 + 49 + 60, 49]);
    });

    it("recomputes only when the stored ones are old, and drops a group that has shrunk below the bar", async () => {
      const [before] = await clusters("wallet");
      const quiet = go(new Map(), { refreshMs: 60_000 });
      expect(await quiet.result).toMatchObject({ state: "completed", fleetsRefreshed: false });
      expect((await clusters("wallet"))[0]!.computedAt).toEqual(before!.computedAt);
      // Ten of the wallet's registrations go (a re-scan never does this; a test of the rule does).
      await writer.delete(schema.agentDirectoryRegistryRows).where(and(eq(schema.agentDirectoryRegistryRows.registrant, WALLET(900)), eq(schema.agentDirectoryRegistryRows.locatorHost, "w0.example.io")));
      for (let i = 1; i < 6; i += 1) await writer.delete(schema.agentDirectoryRegistryRows).where(eq(schema.agentDirectoryRegistryRows.locatorHost, `w${i}.example.io`));
      expect(await go(new Map()).result).toMatchObject({ state: "completed", fleetsRefreshed: true, clusters: { wallet: 0, platform_host: 1, shared_link: 1 } });
    });
  });

  describe("the evidence of the listed entries", () => {
    const template = (n: number) => inline({ name: `Trader Bot ${n}`, description: "Swaps tokens for you", services: [{ name: "web", endpoint: "https://bots.example.io/api" }] });
    const lone = (name: string) => inline({ name, description: `${name} does one thing`, services: [{ name: "A2A", endpoint: `https://${name.toLowerCase().replace(/\W+/g, "-")}.example.io/card` }] });

    it("reads inline JSON from the chain, stores each entry's template key and G1 result, and groups the template", async () => {
      await clear();
      const uris = new Map<number, string | null>([
        [1, template(1)],
        [2, template(2)],
        [3, template(3)],
        [4, lone("Solo Desk")],
        [5, "https://web.example.io/agent.json"],
        [6, null],
      ]);
      await seed([
        ...[1, 2, 3].map(n => draft(n, uris.get(n)!, { displayName: `Trader Bot ${n}` })),
        draft(4, uris.get(4)!, { displayName: "Solo Desk" }),
        draft(5, uris.get(5)!, { locatorHost: "web.example.io" }),
        draft(6, "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"),
      ]);
      await classify();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const { fake, result } = go(uris);
        const outcome = await result;
        expect(outcome).toMatchObject({ state: "completed", read: 6, unreadable: 1, stale: 0, pendingAfter: 0, stoppedBy: null, clusters: { template: 1 } });
        // Six reads are one call.
        expect(fake.calls).toEqual(["eth_call"]);
        expect(log).toHaveBeenCalledOnce();
      } finally {
        log.mockRestore();
      }
      const rows = await evidence();
      const byN = (n: number) => rows.find(row => row.externalKey === keyOf(n))!;
      expect([1, 2, 3].map(n => [byN(n).g1, byN(n).templateSize])).toEqual([["template_group", 3], ["template_group", 3], ["template_group", 3]]);
      expect(new Set([1, 2, 3].map(n => byN(n).templateKey)).size).toBe(1);
      expect(byN(1)).toMatchObject({ readStatus: "inline", endpointHost: "bots.example.io", walletRegistrations: 1, profileUriHash: sha(uris.get(1)!) });
      expect(byN(4)).toMatchObject({ g1: "independent", readStatus: "inline", templateSize: 1, endpointHost: "solo-desk.example.io" });
      expect(byN(5)).toMatchObject({ g1: "unread", readStatus: "link_not_read", templateKey: null });
      expect(byN(6)).toMatchObject({ g1: "unread", readStatus: "unreadable", templateKey: null });
      const [group] = await clusters("template");
      expect(group).toMatchObject({ clusterKey: byN(1).templateKey, memberCount: 3, listedCount: 3, walletCount: 3, label: "Trader Bot 1" });
    });

    it("asks the chain about nothing it already holds evidence for, and recomputes nothing", async () => {
      const before = await evidence();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const { fake, result } = go(new Map(), { refreshMs: 60_000 });
        expect(await result).toMatchObject({ state: "completed", read: 0, fleetsRefreshed: false });
        expect(fake.calls).toEqual([]);
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
      expect(await evidence()).toEqual(before);
    });

    it("reads an entry again when its link changed, and drops the evidence of an entry that is no longer listed", async () => {
      const moved = lone("Moved Agent");
      await writer.update(schema.agentDirectoryRegistryRows).set({ profileUriHash: sha(moved), displayName: "Moved Agent" }).where(eq(schema.agentDirectoryRegistryRows.externalKey, keyOf(4)));
      await writer.update(schema.agentDirectoryRegistryRows).set({ listing: 2 }).where(eq(schema.agentDirectoryRegistryRows.externalKey, keyOf(3)));
      const { fake, result } = go(new Map([[4, moved]]), { refreshMs: 60_000 });
      expect(await result).toMatchObject({ state: "completed", read: 1 });
      expect(fake.calls).toEqual(["eth_call"]);
      const rows = await evidence();
      expect(rows.find(row => row.externalKey === keyOf(4))).toMatchObject({ profileUriHash: sha(moved), endpointHost: "moved-agent.example.io" });
      expect(rows.some(row => row.externalKey === keyOf(3))).toBe(false);
      // Template 1 and 2 are two now; entry 3 left the group.
      expect(rows.filter(row => row.g1 === "template_group").map(row => row.templateSize)).toEqual([2, 2]);
      expect((await clusters("template"))[0]).toMatchObject({ memberCount: 2 });
    });

    it("leaves an entry alone when the chain has moved past the registry row, and reads it after the row catches up", async () => {
      await clear();
      const current = lone("Alpha Bot");
      const newer = lone("Alpha Bot Two");
      await seed([draft(1, current, { displayName: "Alpha Bot" })]);
      await classify();
      const stale = await go(new Map([[1, newer]]), { refreshMs: 60_000 }).result;
      expect(stale).toMatchObject({ state: "completed", read: 0, stale: 1, pendingAfter: 0 });
      expect(await evidence()).toEqual([]);
      const later = await go(new Map([[1, current]]), { refreshMs: 60_000 }).result;
      expect(later).toMatchObject({ read: 1 });
      expect((await evidence())[0]).toMatchObject({ g1: "independent" });
    });
  });

  describe("the budgets and failures", () => {
    const listedAlone = async (count: number) => {
      await clear();
      const uris = new Map<number, string | null>();
      const drafts: DirectoryEntryDraft[] = [];
      for (let n = 1; n <= count; n += 1) {
        const uri = inline({ name: `Unique ${n}`, description: `Does thing number ${n} and nothing else` });
        uris.set(n, uri);
        drafts.push(draft(n, uri, { displayName: `Unique ${n}` }));
      }
      await seed(drafts);
      await classify();
      return uris;
    };

    it("reads at most the batches it is allowed in a run, twenty entries to a batch, and carries on in the next", async () => {
      const uris = await listedAlone(45);
      const first = go(uris, { maxBatches: 1, refreshMs: 60_000 });
      const one = await first.result;
      expect(one).toMatchObject({ read: 20, pendingAfter: 0 });
      expect(first.fake.calls.length).toBe(1);
      expect((await evidence()).length).toBe(20);
      const rest = go(uris, { maxBatches: 5, refreshMs: 60_000 });
      expect(await rest.result).toMatchObject({ read: 25 });
      expect(rest.fake.calls.length).toBe(2);
      expect((await evidence()).length).toBe(45);
    });

    it("stops starting batches when its time is up, and says so", async () => {
      const uris = await listedAlone(45);
      let clock = 0;
      const timed = chain(uris);
      const outcome = await run.runBscClustering({
        rpc: async (method, params) => {
          clock += 10_000;
          return timed.rpc(method, params);
        },
        now: () => clock,
        budgetMs: 15_000,
        refreshMs: 60_000,
      });
      expect(outcome).toMatchObject({ state: "completed", read: 40, stoppedBy: "time" });
      expect((await evidence()).length).toBe(40);
    });

    it("keeps what it read when the chain fails, says so without a link or a key, and never throws", async () => {
      const uris = await listedAlone(30);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let calls = 0;
      try {
        const good = chain(uris);
        const outcome = await run.runBscClustering({
          rpc: async (method, params) => {
            calls += 1;
            if (calls === 2) throw new Error("BNB Chain eth_call returned HTTP 503.");
            return good.rpc(method, params);
          },
          refreshMs: 60_000,
        });
        expect(outcome).toMatchObject({ state: "completed", read: 20, stoppedBy: "chain" });
        expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({ event: "nooscape_bsc_clusters_failed", message: "tokenURI batch could not be read: BNB Chain eth_call returned HTTP 503." });
      } finally {
        error.mockRestore();
      }
      expect((await evidence()).length).toBe(20);
    });

    it("treats an answer of the wrong shape as a failed read, not as a fact", async () => {
      await listedAlone(3);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const outcome = await run.runBscClustering({ rpc: async () => "0x1234", refreshMs: 60_000 });
        expect(outcome).toMatchObject({ state: "completed", read: 0, stoppedBy: "chain" });
      } finally {
        error.mockRestore();
      }
      expect(await evidence()).toEqual([]);
    });

    it("lets a second run find the first still going, and does nothing", async () => {
      const uris = await listedAlone(5);
      let release: () => void = () => {};
      const held = new Promise<void>(resolve => (release = resolve));
      const slow = chain(uris);
      const first = run.runBscClustering({ rpc: async (method, params) => (await held, slow.rpc(method, params)), refreshMs: 60_000 });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await run.runBscClustering({ rpc: slow.rpc })).toEqual({ state: "busy" });
      release();
      expect(await first).toMatchObject({ state: "completed", read: 5 });
    });

    it("leaves a tick that has already run long alone, and a database with no active BNB source", async () => {
      expect(await run.runBscClustering({ tickStartedAt: Date.now() - 120_000, rpc: chain(new Map()).rpc })).toEqual({ state: "too_late" });
      await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-bsc"));
      expect(await run.runBscClustering({ rpc: chain(new Map()).rpc })).toEqual({ state: "no_source" });
      await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, "src-bsc"));
    });
  });

  describe("the endpoint-host groups (migration 0040)", () => {
    const letters = (n: number) => String.fromCharCode(97 + (n % 26)) + String.fromCharCode(97 + (Math.floor(n / 26) % 26));
    const declaring = (n: number, host: string) => inline({ name: `Distinct ${letters(n)}`, description: "Declares one address", services: [{ name: "web", endpoint: `https://${host}/agent/${n}` }] });
    const uris = new Map<number, string | null>();
    const hostGroups = async () => (await writer.select().from(schema.bscEndpointHostGroups)).sort((a, b) => a.host.localeCompare(b.host));
    const pasteEndpointMigration = async () => {
      const { splitMigrationStatements } = await import("./dbMigrations");
      const paste = await createConnection(process.env.DATABASE_URL!);
      for (const statement of splitMigrationStatements(await readFile("drizzle/0040_bsc_endpoint_host_groups.sql", "utf8"))) await paste.query(statement);
      await paste.end();
    };

    it("carries on with the rest while the table is not there: entries and groups are stored, nothing is logged, and the result says null", async () => {
      await clear();
      const drafts: DirectoryEntryDraft[] = [];
      // 50 listed entries declare one host (the bar) and 49 another, each by its own wallet and each with a name of its own.
      for (let n = 1; n <= 99; n += 1) {
        const uri = declaring(n, n <= 50 ? "platform-a.example.io" : "platform-b.example.io");
        uris.set(n, uri);
        drafts.push(draft(n, uri, { displayName: `Distinct ${letters(n)}` }));
      }
      await seed(drafts);
      await classify();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await go(uris).result).toMatchObject({ state: "completed", read: 99, endpointHostGroups: null });
        expect(error).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
        log.mockRestore();
      }
      expect((await evidence()).length).toBe(99);
    });

    it("is made by the file the owner pastes: its columns, none nullable, one row to a host, no foreign key, and a second paste changes nothing", async () => {
      await pasteEndpointMigration();
      const probe = await createConnection(process.env.DATABASE_URL!);
      const [columns] = (await probe.query("SHOW COLUMNS FROM `bsc_endpoint_host_groups`")) as [Array<{ Field: string; Null: string }>, unknown];
      const [indexes] = (await probe.query("SHOW INDEX FROM `bsc_endpoint_host_groups`")) as [Array<{ Key_name: string; Column_name: string; Seq_in_index: number }>, unknown];
      const [found] = (await probe.query(
        "SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL AND (TABLE_NAME = 'bsc_endpoint_host_groups' OR REFERENCED_TABLE_NAME = 'bsc_endpoint_host_groups')",
        [TEST_DB]
      )) as [unknown[], unknown];
      await probe.end();
      expect(columns.map(column => column.Field)).toEqual(["id", "sourceId", "host", "listedCount", "walletCount", "ruleVersion", "ruleDate", "computedAt"]);
      expect(columns.filter(column => column.Null === "YES")).toEqual([]);
      expect(indexes.filter(index => index.Key_name === "bsc_endpoint_host_groups_key_uq").sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name)).toEqual(["sourceId", "host"]);
      expect(found).toEqual([]);
      await writer.insert(schema.bscEndpointHostGroups).values({ id: "kept", sourceId: "src-bsc", host: "kept.example.io", listedCount: 50, walletCount: 50, ruleVersion: "endpoint-host/1", ruleDate: "2026-10-17" });
      await pasteEndpointMigration();
      expect((await hostGroups()).map(row => row.id)).toEqual(["kept"]);
      await writer.delete(schema.bscEndpointHostGroups);
    });

    it("stores the host at the bar with its entries, its wallets and the rule's version and date, and the one below the bar not at all", async () => {
      expect(await go(uris).result).toMatchObject({ state: "completed", endpointHostGroups: 1 });
      const groups = await hostGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ sourceId: "src-bsc", host: "platform-a.example.io", listedCount: 50, walletCount: 50, ruleVersion: "endpoint-host/1", ruleDate: "2026-10-17" });
    });

    it("changes nothing else: every entry is still independent, and bsc_clusters holds no group for a host that entries declare", async () => {
      expect((await evidence()).map(row => row.g1)).toEqual(Array(99).fill("independent"));
      const rows = await clusters();
      expect(rows.every(row => ["wallet", "shared_link", "platform_host", "template", "registry"].includes(row.kind))).toBe(true);
      expect(rows.some(row => row.clusterKey.includes("platform-"))).toBe(false);
    });

    it("rewrites a row that carries an older rule, and drops a host that falls below the bar", async () => {
      await writer.update(schema.bscEndpointHostGroups).set({ ruleVersion: "endpoint-host/0", ruleDate: "2026-01-01", listedCount: 3 });
      expect(await go(uris).result).toMatchObject({ endpointHostGroups: 1 });
      expect((await hostGroups())[0]).toMatchObject({ host: "platform-a.example.io", listedCount: 50, ruleVersion: "endpoint-host/1", ruleDate: "2026-10-17" });
      // Two of the 50 stop being listed, so 48 are left.
      await writer.update(schema.agentDirectoryRegistryRows).set({ listing: 2 }).where(inArray(schema.agentDirectoryRegistryRows.externalKey, [keyOf(1), keyOf(2)]));
      expect(await go(uris).result).toMatchObject({ endpointHostGroups: 0 });
      expect(await hostGroups()).toEqual([]);
    });
  });
});
