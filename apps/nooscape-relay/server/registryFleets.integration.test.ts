import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { ARC_CHAIN } from "./ingestion/erc8004Chains";

/**
 * The groups behind the formations on Arc's, Base's and Ethereum's own pages, counted over the registry rows of a real database (docs/chain-worlds-2026-10-20.md,
 * "The Arc world", and docs/base-world-2026-10-21.md): the registering wallets, hosts and profile links that 50 or more registrations share, every registration counted
 * whether it is listed or held out, and a registration that is hidden counted in none. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_registry_fleets_test";
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

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const arcKey = (id: string) => `eip155:${ARC_CHAIN.chainId}:${ARC_CHAIN.identityRegistry}:${id}`;

describe.skipIf(!dbReachable)("the groups of an extra chain's registry, against a real database", { timeout: 180_000 }, () => {
  let readCache: typeof import("./readCache");
  let registry: typeof import("./agentRegistryRows");
  let appRouter: typeof import("./routers").appRouter;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;
  let arcSource: schema.IngestionSource;

  const features = (list: string | undefined) => {
    if (list === undefined) delete process.env.VITE_FEATURES;
    else process.env.VITE_FEATURES = list;
    readCache.invalidateDirectoryReads();
  };
  const caller = () => appRouter.createCaller({ req: {}, res: {}, user: null } as never);
  let counter = 0;

  /** Registrations of one source. Each gets a profile link of its own unless one is given, and a host only when one is given. */
  async function register(source: schema.IngestionSource, count: number, over: { owner?: () => string; host?: string | null; link?: string; name?: (n: number) => string } = {}) {
    const drafts = Array.from({ length: count }, () => {
      counter += 1;
      const n = counter;
      return {
        externalKey: arcKey(String(n)),
        displayName: over.name ? over.name(n) : `Agent #${n}`,
        locatorHost: over.host === undefined ? null : over.host,
        registrant: over.owner ? over.owner() : wallet(10_000_000 + n),
        profileUriHash: over.link ? hash(over.link) : hash(`own-link-${n}`),
        listing: 3 as const,
        sourceSignalNote: "test",
      };
    });
    await registry.insertAgentRegistryRows({ source, runId: "run-1", drafts });
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
    // Migration 0046 is manual: it adds Arc's protocol to the four tables.
    const owner = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8"))) await owner.query(statement);
    await owner.end();

    readCache = await import("./readCache");
    registry = await import("./agentRegistryRows");
    appRouter = (await import("./routers")).appRouter;
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "fleets-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "fleets-operator"));
    operatorUserId = operator.id;
  });

  afterAll(async () => {
    delete process.env.VITE_FEATURES;
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  async function arcSourceRow(state: "active" | "paused" = "active") {
    await writer.insert(schema.ingestionSources).values({ id: "src-arc", sourceKey: "fleets-arc", label: "Arc", protocol: "erc8004_arc", rootUrl: "https://arc.example/rpc", allowedHostname: "arc.example", state, createdByUserId: operatorUserId });
    const [row] = await writer.select().from(schema.ingestionSources).where(eq(schema.ingestionSources.id, "src-arc"));
    arcSource = row!;
  }

  it("answers nothing while no source of the chain exists, and nothing before a walk has published", async () => {
    features("chain_arc");
    expect(await registry.readRegistryGroups("erc8004_arc", 50, 8)).toBeNull();
    await arcSourceRow("active");
    await register(arcSource, 3);
    // The rows are stored, and none is published into the directory yet: the walk has not caught up.
    expect(await registry.readRegistryGroups("erc8004_arc", 50, 8)).toBeNull();
    expect(await caller().liveData.registryFleets({ chain: "arc" })).toEqual({ fleets: [], groups: 0, walletGroups: 0, recorded: null, asOf: null });
    expect(await caller().liveData.chainSample({ chain: "arc" })).toEqual({ entries: [], listed: 0 });
  });

  describe("once a walk that caught up has published", () => {
    beforeAll(async () => {
      // Three wallets of 60, 55 and 49 registrations (the last is one short of the rule), two hosts of 52 and 50, a profile link
      // shared by 51 registrations that point at a host, another by 50 that share only a name, and one by 3.
      const owner = (n: number) => () => wallet(n);
      await register(arcSource, 60, { owner: owner(1) });
      await register(arcSource, 55, { owner: owner(2) });
      await register(arcSource, 49, { owner: owner(3) });
      await register(arcSource, 52, { host: "busy.example.app" });
      await register(arcSource, 50, { host: "small-but-enough.example.app" });
      await register(arcSource, 51, { link: "https://shared.example/one.json", host: "links.example" });
      await register(arcSource, 50, { link: "inline:one-template", name: () => "Same Name Agent" });
      await register(arcSource, 3, { link: "https://shared.example/three.json" });
      // Hidden registrations are counted in no group: a wallet of 50 of which 5 are hidden is a wallet of 45.
      await register(arcSource, 50, { owner: owner(4) });
      await writer.execute(sql`UPDATE agent_directory_registry_rows SET hidden = 1 WHERE registrant = ${wallet(4)} LIMIT 5`);
      // Another chain's registry rows are not Arc's.
      await writer.insert(schema.ingestionSources).values({ id: "src-bnb", sourceKey: "fleets-bnb", label: "BNB", protocol: "erc8004_bsc", rootUrl: "https://bnb.example/rpc", allowedHostname: "bnb.example", state: "active", createdByUserId: operatorUserId });
      const [bnb] = await writer.select().from(schema.ingestionSources).where(eq(schema.ingestionSources.id, "src-bnb"));
      await registry.insertAgentRegistryRows({
        source: bnb!,
        runId: "run-bnb",
        drafts: Array.from({ length: 70 }, (_, index) => ({ externalKey: `bnb-${index}`, displayName: `Agent #${index}`, locatorHost: "bnb-host.example", registrant: wallet(99), profileUriHash: hash(`bnb-${index}`), listing: 3 as const, sourceSignalNote: "test" })),
      });
      // The pass classifies and publishes: whatever passes the rules becomes an entry, so the registry has published something.
      await registry.refreshAgentRegistryListing(arcSource, { classify: true, publish: true });
      readCache.invalidateDirectoryReads();
    });

    it("counts the wallets, hosts and links at the minimum, every registration counted whether it is listed or held out", async () => {
      const read = (await registry.readRegistryGroups("erc8004_arc", 50, 8))!;
      const of = (kind: string) => read.groups.filter(group => group.kind === kind);
      expect(of("wallet").map(group => [group.key, group.count])).toEqual([
        [wallet(1), 60],
        [wallet(2), 55],
      ]);
      expect(of("platform_host").map(group => [group.key, group.count])).toEqual([
        ["busy.example.app", 52],
        ["links.example", 51],
        ["small-but-enough.example.app", 50],
      ]);
      expect(of("shared_link").map(group => group.count)).toEqual([51, 50]);
      expect(read.totals).toEqual({ wallet: 2, platform_host: 3, shared_link: 2 });
      // Everything the source holds, hidden registrations too: 3 + 60 + 55 + 49 + 52 + 50 + 51 + 50 + 3 + 50.
      expect(read.recorded).toBe(423);
    });

    it("labels a link by its host, or by the name its members record when it has none", async () => {
      const links = (await registry.readRegistryGroups("erc8004_arc", 50, 8))!.groups.filter(group => group.kind === "shared_link");
      expect(links[0]).toMatchObject({ host: "links.example", name: expect.stringMatching(/^Agent #\d+$/) });
      expect(links[1]).toMatchObject({ host: null, name: "Same Name Agent" });
    });

    it("keeps to the chain it is asked about, and does not count a wallet that registered on another chain", async () => {
      const read = (await registry.readRegistryGroups("erc8004_arc", 50, 8))!;
      expect(read.groups.map(group => group.key)).not.toContain(wallet(99));
      expect(read.groups.map(group => group.key)).not.toContain("bnb-host.example");
    });

    it("counts a hidden registration in no group", async () => {
      const wallets = (await registry.readRegistryGroups("erc8004_arc", 50, 8))!.groups.filter(group => group.kind === "wallet").map(group => group.key);
      // Fifty registrations, five of them hidden: forty-five, under the minimum.
      expect(wallets).not.toContain(wallet(4));
      // Asked for a lower minimum, the same wallet is there with what is left of it.
      const lower = (await registry.readRegistryGroups("erc8004_arc", 40, 8))!.groups.filter(group => group.kind === "wallet");
      expect(lower.find(group => group.key === wallet(4))?.count).toBe(45);
    });

    it("draws at most the limit of a kind and still counts all of them", async () => {
      const read = (await registry.readRegistryGroups("erc8004_arc", 50, 1))!;
      expect(read.groups.filter(group => group.kind === "platform_host")).toHaveLength(1);
      expect(read.totals.platform_host).toBe(3);
      expect(read.groups.find(group => group.kind === "platform_host")).toMatchObject({ key: "busy.example.app", count: 52 });
    });

    it("is served by the public read only while the chain's switch is on, as formations with a count and no registration", async () => {
      features(undefined);
      expect(await caller().liveData.registryFleets({ chain: "arc" })).toEqual({ fleets: [], groups: 0, walletGroups: 0, recorded: null, asOf: null });
      features("chain_base,chain_ethereum");
      expect((await caller().liveData.registryFleets({ chain: "arc" })).fleets).toEqual([]);
      features("chain_arc");
      const answer = await caller().liveData.registryFleets({ chain: "arc" });
      expect(answer.recorded).toBe(423);
      expect(answer.groups).toBe(7);
      expect(answer.walletGroups).toBe(2);
      expect(answer.fleets.map(fleet => [fleet.kind, fleet.count])).toEqual([
        ["wallet", 60],
        ["wallet", 55],
        ["platform_host", 52],
        ["platform_host", 51],
        ["platform_host", 50],
        ["shared_link", 51],
        ["shared_link", 50],
      ]);
      expect(answer.fleets.every(fleet => fleet.chain === "arc" && /^arc-fleet-[0-9a-f]{16}$/.test(fleet.id))).toBe(true);
      expect(typeof answer.asOf).toBe("string");
      // A registration is never returned: no key, no id of an entry, and no profile link.
      const text = JSON.stringify(answer);
      expect(text).not.toContain("eip155:");
      expect(text).not.toContain(hash("https://shared.example/one.json"));
    });

    it("answers nothing for a source that is paused", async () => {
      features("chain_arc");
      await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-arc"));
      readCache.invalidateDirectoryReads();
      expect(await registry.readRegistryGroups("erc8004_arc", 50, 8)).toBeNull();
      expect((await caller().liveData.registryFleets({ chain: "arc" })).fleets).toEqual([]);
      await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, "src-arc"));
      readCache.invalidateDirectoryReads();
      expect((await caller().liveData.registryFleets({ chain: "arc" })).fleets.length).toBeGreaterThan(0);
    });

    it("does not count a registration whose host moved to a suppressed domain after it was stored, though its hidden flag was never set", async () => {
      await register(arcSource, 50, { host: "moves-later.example.app" });
      const before = (await registry.readRegistryGroups("erc8004_arc", 50, 8))!;
      expect(before.groups.find(group => group.key === "moves-later.example.app")).toMatchObject({ kind: "platform_host", count: 50 });
      // A URI update moves a registration's host and leaves its hidden flag as it was.
      await writer.execute(sql`UPDATE agent_directory_registry_rows SET locatorHost = 'api.agentrank.info' WHERE locatorHost = 'moves-later.example.app'`);
      try {
        const after = (await registry.readRegistryGroups("erc8004_arc", 50, 8))!;
        const keys = after.groups.map(group => group.key);
        expect(keys).not.toContain("api.agentrank.info");
        expect(keys).not.toContain("moves-later.example.app");
        expect(after.totals.platform_host).toBe(before.totals.platform_host - 1);
        // The registry still holds them, and the suppressed domain is not named by any group.
        expect(after.recorded).toBe(before.recorded);
      } finally {
        await writer.execute(sql`DELETE FROM agent_directory_registry_rows WHERE locatorHost = 'api.agentrank.info'`);
      }
    });

    it("refuses a chain that has no page, and the sample of listed entries follows the same switch", async () => {
      features("chain_arc");
      await expect(caller().liveData.registryFleets({ chain: "bnb" } as never)).rejects.toThrow();
      await expect(caller().liveData.chainSample({ chain: "base" } as never)).rejects.toThrow();
      const on = await caller().liveData.chainSample({ chain: "arc" });
      // The registry published the registrations that pass the rules: here the three with a profile link of their own and no shared fact.
      expect(on.listed).toBeGreaterThan(0);
      expect(on.entries.length).toBe(Math.min(on.listed, 30));
      expect(on.entries.every(entry => entry.protocol === "erc8004_arc")).toBe(true);
      features(undefined);
      expect(await caller().liveData.chainSample({ chain: "arc" })).toEqual({ entries: [], listed: 0 });
    });

    it("serves Base's groups the same way, from Base's own rows and only while its switch is on, and never mixes the two chains", async () => {
      await writer.insert(schema.ingestionSources).values({ id: "src-base", sourceKey: "fleets-base", label: "Base", protocol: "erc8004_base", rootUrl: "https://base.example/rpc", allowedHostname: "base.example", state: "active", createdByUserId: operatorUserId });
      const [row] = await writer.select().from(schema.ingestionSources).where(eq(schema.ingestionSources.id, "src-base"));
      const baseSource = row!;
      // A wallet of 70, a host of 55 and three registrations that stand alone, which the pass publishes.
      await register(baseSource, 70, { owner: () => wallet(7) });
      await register(baseSource, 55, { host: "base-host.example.app" });
      await register(baseSource, 3);
      await registry.refreshAgentRegistryListing(baseSource, { classify: true, publish: true });

      features(undefined);
      expect(await caller().liveData.registryFleets({ chain: "base" })).toEqual({ fleets: [], groups: 0, walletGroups: 0, recorded: null, asOf: null });
      features("chain_arc,chain_ethereum");
      expect((await caller().liveData.registryFleets({ chain: "base" })).fleets).toEqual([]);
      features("chain_base");
      const base = await caller().liveData.registryFleets({ chain: "base" });
      expect(base.fleets.map(fleet => [fleet.chain, fleet.kind, fleet.count])).toEqual([
        ["base", "wallet", 70],
        ["base", "platform_host", 55],
      ]);
      expect(base.recorded).toBe(128);
      expect(base.groups).toBe(2);
      expect(base.walletGroups).toBe(1);
      expect(base.fleets.every(fleet => /^base-fleet-[0-9a-f]{16}$/.test(fleet.id))).toBe(true);
      // Arc's switch is off, so Arc answers nothing, and none of Arc's wallets or hosts is among Base's groups.
      expect((await caller().liveData.registryFleets({ chain: "arc" })).fleets).toEqual([]);
      expect(base.fleets.some(fleet => fleet.wallet === wallet(1) || fleet.name === "busy.example.app")).toBe(false);
      // With both on, each chain answers from its own rows only.
      features("chain_arc,chain_base");
      const arc = await caller().liveData.registryFleets({ chain: "arc" });
      expect(arc.fleets.length).toBeGreaterThan(0);
      expect(arc.fleets.every(fleet => fleet.chain === "arc")).toBe(true);
      expect(arc.fleets.some(fleet => fleet.wallet === wallet(7) || fleet.name === "base-host.example.app")).toBe(false);
      expect((await caller().liveData.registryFleets({ chain: "base" })).fleets.map(fleet => fleet.count)).toEqual([70, 55]);
      features(undefined);
    });

    it("serves Ethereum's groups the same way, from Ethereum's own rows and only while its switch is on, and never mixes the chains", async () => {
      await writer.insert(schema.ingestionSources).values({ id: "src-ethereum", sourceKey: "fleets-ethereum", label: "Ethereum", protocol: "erc8004_eth", rootUrl: "https://eth-mainnet.nodereal.io", allowedHostname: "eth-mainnet.nodereal.io", state: "active", createdByUserId: operatorUserId });
      const [row] = await writer.select().from(schema.ingestionSources).where(eq(schema.ingestionSources.id, "src-ethereum"));
      const ethereumSource = row!;
      // A wallet of 90, a host of 60 and three registrations that stand alone, which the pass publishes.
      await register(ethereumSource, 90, { owner: () => wallet(9) });
      await register(ethereumSource, 60, { host: "eth-host.example.app" });
      await register(ethereumSource, 3);
      await registry.refreshAgentRegistryListing(ethereumSource, { classify: true, publish: true });

      features(undefined);
      expect(await caller().liveData.registryFleets({ chain: "ethereum" })).toEqual({ fleets: [], groups: 0, walletGroups: 0, recorded: null, asOf: null });
      features("chain_arc,chain_base");
      expect((await caller().liveData.registryFleets({ chain: "ethereum" })).fleets).toEqual([]);
      features("chain_ethereum");
      const ethereum = await caller().liveData.registryFleets({ chain: "ethereum" });
      expect(ethereum.fleets.map(fleet => [fleet.chain, fleet.kind, fleet.count])).toEqual([
        ["ethereum", "wallet", 90],
        ["ethereum", "platform_host", 60],
      ]);
      expect(ethereum.recorded).toBe(153);
      expect(ethereum.groups).toBe(2);
      expect(ethereum.walletGroups).toBe(1);
      expect(ethereum.fleets.every(fleet => /^ethereum-fleet-[0-9a-f]{16}$/.test(fleet.id))).toBe(true);
      // The other chains' switches are off, so they answer nothing, and none of their wallets or hosts is among Ethereum's groups.
      expect((await caller().liveData.registryFleets({ chain: "arc" })).fleets).toEqual([]);
      expect((await caller().liveData.registryFleets({ chain: "base" })).fleets).toEqual([]);
      expect(ethereum.fleets.some(fleet => fleet.wallet === wallet(1) || fleet.wallet === wallet(7) || fleet.name === "busy.example.app" || fleet.name === "base-host.example.app")).toBe(false);
      // With all three on, each chain answers from its own rows only.
      features("chain_arc,chain_base,chain_ethereum");
      const arc = await caller().liveData.registryFleets({ chain: "arc" });
      expect(arc.fleets.length).toBeGreaterThan(0);
      expect(arc.fleets.every(fleet => fleet.chain === "arc")).toBe(true);
      expect(arc.fleets.some(fleet => fleet.wallet === wallet(9) || fleet.name === "eth-host.example.app")).toBe(false);
      expect((await caller().liveData.registryFleets({ chain: "base" })).fleets.map(fleet => fleet.count)).toEqual([70, 55]);
      expect((await caller().liveData.registryFleets({ chain: "ethereum" })).fleets.map(fleet => fleet.count)).toEqual([90, 60]);
      features(undefined);
    });
  });
});
