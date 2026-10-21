import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

/**
 * The BNB fleets behind the lights on the home map, against a real database and through the public procedure: nothing
 * before the migration is run, nothing while the BNB Chain source is not approved, the largest groups first and no more
 * than the limit, no registration and no stored key in the answer, and the groups counted apart from the drawn ones.
 * Skips when no database is reachable. The shaping and the words are in mapFleets.test.ts.
 */
const TEST_DB = "nooscape_map_fleets_test";
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

const WALLET = "0x8ce2b1348740d27d6075f602ad679a041407fdec";

describe.skipIf(!dbReachable)("the map fleets against a real database", { timeout: 60_000 }, () => {
  let readCache: typeof import("./readCache");
  let appRouter: typeof import("./routers").appRouter;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;
  let pasteMigration: () => Promise<void>;

  const call = () => appRouter.createCaller({ req: {}, res: {}, user: null } as unknown as TrpcContext).liveData.mapFleets();
  const fresh = () => readCache.invalidateDirectoryReads();
  const cluster = (kind: string, clusterKey: string, memberCount: number, label: string | null = null, sourceId = "src-bnb", walletCount: number | null = null) =>
    writer.insert(schema.bscClusters).values({ id: `${sourceId}-${kind}-${clusterKey}`.slice(0, 36), sourceId, kind, clusterKey, label, memberCount, listedCount: 0, walletCount });

  async function source(id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"], state: "active" | "paused") {
    await writer.insert(schema.ingestionSources).values({ id, sourceKey: `fleets-${id}`, label: id, protocol, rootUrl: "https://fleets.example/feed", allowedHostname: "fleets.example", state, createdByUserId: operatorUserId });
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
    // The tables are a manual migration, so a boot does not make them: run the file as the owner would paste it.
    pasteMigration = async () => {
      const paste = await createConnection(process.env.DATABASE_URL!);
      for (const statement of splitMigrationStatements(await readFile("drizzle/0038_bsc_clusters.sql", "utf8"))) await paste.query(statement);
      await paste.end();
    };

    readCache = await import("./readCache");
    appRouter = (await import("./routers")).appRouter;
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "fleets-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "fleets-operator"));
    operatorUserId = operator!.id;
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  const NOTHING = { fleets: [], groups: 0, registrations: null, asOf: null, solana: { fleets: [], groups: 0, asOf: null }, robinhood: { fleets: [], groups: 0, asOf: null, listed: null } };

  it("answers nothing to draw before the migration is run, with no source and with the table missing", async () => {
    await fresh();
    expect(await call()).toEqual(NOTHING);
    await source("src-bnb", "erc8004_bsc", "active");
    await fresh();
    // The source is approved and the table is still not there.
    expect(await call()).toEqual(NOTHING);
  });

  it("answers nothing while the table is empty", async () => {
    await pasteMigration();
    await fresh();
    expect(await call()).toEqual(NOTHING);
  });

  it("returns the largest groups first, no more than ten, and counts the rest", async () => {
    for (let n = 0; n < 12; n += 1) await cluster("platform_host", `host-${String(n).padStart(2, "0")}.example.io`, 100 + n, `host-${String(n).padStart(2, "0")}.example.io`);
    await cluster("wallet", WALLET, 13_419, null, "src-bnb", 1);
    await cluster("shared_link", "ab".repeat(32), 126_839, "Ave.ai Trading Agent");
    await cluster("template", "0123456789abcdef", 300, "CryptoMaster Agent #2", "src-bnb", 300);
    await cluster("registry", "all", 375_343);
    await fresh();
    const answer = await call();
    expect(answer.fleets).toHaveLength(10);
    expect(answer.fleets.map(fleet => fleet.count)).toEqual([126_839, 13_419, 300, 111, 110, 109, 108, 107, 106, 105]);
    expect(answer.fleets.map(fleet => fleet.kind)).toEqual(["shared_link", "wallet", "template", ...Array(7).fill("platform_host")]);
    // Fifteen groups of the four kinds are stored; the registry summary row is not one of them.
    expect(answer).toMatchObject({ groups: 15, registrations: 375_343 });
    expect(Date.parse(answer.asOf!)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("returns the facts a light is made of and no registration, no entry and no stored key", async () => {
    await fresh();
    const answer = await call();
    const link = answer.fleets[0]!;
    const wallet = answer.fleets[1]!;
    expect(link).toMatchObject({ kind: "shared_link", name: "Ave.ai Trading Agent", wallet: null, count: 126_839 });
    expect(wallet).toMatchObject({ kind: "wallet", name: null, wallet: WALLET, count: 13_419, wallets: 1 });
    for (const fleet of answer.fleets) expect(Object.keys(fleet).sort()).toEqual(["chain", "count", "id", "kind", "name", "registry", "wallet", "wallets"]);
    for (const fleet of answer.fleets) expect(fleet).toMatchObject({ chain: "bnb", registry: null });
    const text = JSON.stringify(answer);
    expect(text).not.toContain("ab".repeat(32));
    expect(text).not.toContain("0123456789abcdef");
    expect(text).not.toMatch(/eip155|externalKey|agentId/);
  });

  it("is served from the cache until a write drops it, and answers the same twice", async () => {
    await fresh();
    const first = await call();
    await writer.update(schema.bscClusters).set({ memberCount: 999_999 }).where(eq(schema.bscClusters.clusterKey, "ab".repeat(32)));
    expect(await call()).toEqual(first);
    await fresh();
    expect((await call()).fleets[0]!.count).toBe(999_999);
  });

  it("answers nothing for a source an operator has not approved, and for groups of another source", async () => {
    await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-bnb"));
    await fresh();
    expect((await call()).fleets).toEqual([]);
    await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, "src-bnb"));
    await source("src-other", "erc8004", "active");
    await cluster("wallet", "0x2222222222222222222222222222222222222222", 5_000_000, null, "src-other");
    await fresh();
    const answer = await call();
    expect(answer.fleets[0]!.count).toBe(999_999);
    expect(answer.fleets.some(fleet => fleet.count === 5_000_000)).toBe(false);
  });

  describe("the Solana owner wallets", () => {
    const WALLET_A = "SolWalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const WALLET_B = "SolWalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const WALLET_C = "SolWalletCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const entries = async (sourceId: string, protocol: "solana_8004" | "solana_registry" | "solana_said", registrant: string, count: number, extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}, hiddenOf = 0, closedOf = 0) => {
      await writer.insert(schema.agentDirectoryEntries).values(
        Array.from({ length: count }, (_, index) => ({
          id: `${sourceId}-${registrant.slice(9, 10)}-${String(index).padStart(3, "0")}`.slice(0, 36),
          sourceId,
          externalKey: `key-${sourceId}-${registrant}-${index}`,
          displayName: `Entry ${index}`,
          protocol,
          registrant,
          hidden: index < hiddenOf,
          assetClosedAt: index >= hiddenOf && index < hiddenOf + closedOf ? new Date("2026-10-01T00:00:00Z") : null,
          ...extra,
        }))
      );
    };

    it("draws a light for each owner wallet a registry records for 100 or more visible entries, and for no other", async () => {
      await source("src-8004", "solana_8004", "active");
      await source("src-metaplex", "solana_registry", "active");
      await source("src-said", "solana_said", "active");
      await source("src-8004-paused", "solana_8004", "paused");
      // 8004: A holds 150, B 99 (one short), C 100 (exactly the minimum).
      await entries("src-8004", "solana_8004", WALLET_A, 150);
      await entries("src-8004", "solana_8004", WALLET_B, 99);
      await entries("src-8004", "solana_8004", WALLET_C, 100);
      // Metaplex: the same wallet A holds 120 there, which is a light of its own; D holds 100 but 5 are hidden and 2 closed, so 93 are visible.
      await entries("src-metaplex", "solana_registry", WALLET_A, 120);
      await entries("src-metaplex", "solana_registry", "SolWalletDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", 100, {}, 5, 2);
      // SAID has none, whatever a wallet holds; and a source an operator has not approved counts for nothing.
      await entries("src-said", "solana_said", "SolWalletSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS", 130);
      await entries("src-8004-paused", "solana_8004", "SolWalletPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP", 200);
      await fresh();
      const answer = await call();
      expect(answer.solana.fleets.map(light => [light.registry, light.wallet, light.count])).toEqual([
        ["8004", WALLET_A, 150],
        ["metaplex", WALLET_A, 120],
        ["8004", WALLET_C, 100],
      ]);
      expect(answer.solana.groups).toBe(3);
      expect(Date.parse(answer.solana.asOf!)).toBeGreaterThan(Date.now() - 60_000);
      for (const light of answer.solana.fleets) {
        expect(Object.keys(light).sort()).toEqual(["chain", "count", "id", "kind", "name", "registry", "wallet", "wallets"]);
        expect(light).toMatchObject({ kind: "wallet", chain: "solana", name: null, wallets: null });
        expect(light.id).toMatch(/^sol-fleet-[0-9a-f]{16}$/);
      }
    });

    it("answers no registration, entry or key, and leaves the BNB Chain lights as they were", async () => {
      await fresh();
      const answer = await call();
      const text = JSON.stringify(answer.solana);
      expect(text).not.toMatch(/key-src|src-8004|Entry \d|externalKey|agentId/);
      // The BNB Chain half is the answer it gave before there were Solana lights.
      expect(answer.fleets[0]!.count).toBe(999_999);
      expect(answer.fleets.every(fleet => fleet.chain === "bnb")).toBe(true);
    });

    it("is read from the directory itself: with the BNB Chain source not approved, the Solana lights are still there and the BNB Chain half is empty", async () => {
      await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-bnb"));
      await fresh();
      const answer = await call();
      expect(answer.fleets).toEqual([]);
      expect(answer.solana.fleets).toHaveLength(3);
      await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, "src-bnb"));
    });

    it("follows the directory: an entry hidden or a source paused takes a wallet below the minimum, once the cache is dropped", async () => {
      await writer.update(schema.agentDirectoryEntries).set({ hidden: true }).where(eq(schema.agentDirectoryEntries.id, "src-8004-C-000"));
      await fresh();
      expect((await call()).solana.fleets.map(light => light.count)).toEqual([150, 120]);
      await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-8004"));
      await fresh();
      expect((await call()).solana.fleets.map(light => [light.registry, light.count])).toEqual([["metaplex", 120]]);
    });
  });

  describe("the Robinhood Chain registering wallets", () => {
    const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const WALLET_C = "0xcccccccccccccccccccccccccccccccccccccccc";
    const WALLET_D = "0xdddddddddddddddddddddddddddddddddddddddd";
    const entries = async (sourceId: string, protocol: "erc8004" | "erc8004_bsc", registrant: string, count: number, hiddenOf = 0, closedOf = 0) => {
      await writer.insert(schema.agentDirectoryEntries).values(
        Array.from({ length: count }, (_, index) => ({
          id: `${sourceId}-${registrant.slice(2, 4)}-${String(index).padStart(3, "0")}`.slice(0, 36),
          sourceId,
          externalKey: `rh-key-${sourceId}-${registrant}-${index}`,
          displayName: `Agent #${index}`,
          protocol,
          registrant,
          hidden: index < hiddenOf,
          assetClosedAt: index >= hiddenOf && index < hiddenOf + closedOf ? new Date("2026-10-01T00:00:00Z") : null,
        }))
      );
    };

    it("draws a light for each registering wallet recorded against 100 or more visible entries, and for no other", async () => {
      await source("src-rh", "erc8004", "active");
      await source("src-rh-paused", "erc8004", "paused");
      // A holds 150, B 99 (one short), C 100 (exactly the minimum); D holds 100 but 5 are hidden and 2 closed, so 93 are visible.
      await entries("src-rh", "erc8004", WALLET_A, 150);
      await entries("src-rh", "erc8004", WALLET_B, 99);
      await entries("src-rh", "erc8004", WALLET_C, 100);
      await entries("src-rh", "erc8004", WALLET_D, 100, 5, 2);
      // A source an operator has not approved counts for nothing, and neither does another chain's protocol, however many a wallet holds.
      await entries("src-rh-paused", "erc8004", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", 200);
      await entries("src-bnb", "erc8004_bsc", "0xffffffffffffffffffffffffffffffffffffffff", 300);
      await fresh();
      const answer = await call();
      expect(answer.robinhood.fleets.map(light => [light.wallet, light.count])).toEqual([
        [WALLET_A, 150],
        [WALLET_C, 100],
      ]);
      expect(answer.robinhood.groups).toBe(2);
      // Every visible Robinhood Chain entry, counted in the same read: 150 + 99 + 100 + the 93 of D that are neither hidden nor closed.
      expect(answer.robinhood.listed).toBe(442);
      expect(Date.parse(answer.robinhood.asOf!)).toBeGreaterThan(Date.now() - 60_000);
      for (const light of answer.robinhood.fleets) {
        expect(Object.keys(light).sort()).toEqual(["chain", "count", "id", "kind", "name", "registry", "wallet", "wallets"]);
        expect(light).toMatchObject({ kind: "wallet", chain: "robinhood", name: null, registry: null, wallets: null });
        expect(light.id).toMatch(/^rh-fleet-[0-9a-f]{16}$/);
      }
    });

    it("answers no registration, entry or key, and leaves the BNB Chain and Solana lights as they were", async () => {
      await fresh();
      const answer = await call();
      expect(JSON.stringify(answer.robinhood)).not.toMatch(/rh-key|src-rh|Agent #|externalKey|agentId/);
      expect(answer.fleets.every(fleet => fleet.chain === "bnb")).toBe(true);
      expect(answer.solana.fleets.every(fleet => fleet.chain === "solana")).toBe(true);
    });

    it("follows the directory: an entry hidden or a source paused takes a wallet below the minimum, once the cache is dropped", async () => {
      await writer.update(schema.agentDirectoryEntries).set({ hidden: true }).where(eq(schema.agentDirectoryEntries.id, "src-rh-cc-000"));
      await fresh();
      const afterHide = (await call()).robinhood;
      expect(afterHide.fleets.map(light => light.count)).toEqual([150]);
      expect(afterHide.listed).toBe(441);
      await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-rh"));
      await fresh();
      expect((await call()).robinhood).toEqual({ fleets: [], groups: 0, asOf: null, listed: null });
    });
  });
});
