import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN, type Erc8004Chain } from "./ingestion/erc8004Chains";

/**
 * The listing rules of each of the three chains on a real database: which registrations a chain's own rules hold out and which they
 * list, and that only the listed are published to the directory, under the chain's protocol. A registration reaches the directory
 * only if it has a usable profile link and a name that is not only a number and does not share its link, its host or its wallet with
 * as many others as the chain's rules say. The rows are made up; what is asserted is the stored result. The rules are passed to the
 * refresh as the pass passes them, from the chain's entry, and a second run with stricter rules shows they are the ones used.
 * Runs on a throwaway schema and skips when no database is reachable.
 */
const TEST_DB = "nooscape_multichain_listing_test";
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

const CASES: Array<[string, Erc8004Chain]> = [
  ["Ethereum", ETHEREUM_CHAIN],
  ["Base", BASE_CHAIN],
  ["Arc", ARC_CHAIN],
];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const LISTED = 1;
const NO_LINK = 0 as const;
const GROUPED = 2;
const NUMERIC_NAME = 4;

describe.skipIf(!dbReachable)("the listing rules of each chain against a real database", { timeout: 120_000 }, () => {
  type Registry = typeof import("./agentRegistryRows");
  let registry: Registry;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let sources: Record<string, schema.IngestionSource>;

  const sourceId = (chain: Erc8004Chain) => `src-listing-${chain.chainKey}`;
  const key = (chain: Erc8004Chain, name: string) => `eip155:${chain.chainId}:${chain.identityRegistry}:${name}`;
  const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const stateOf = async (chain: Erc8004Chain, name: string) => {
    const [row] = await writer
      .select({ listing: schema.agentDirectoryRegistryRows.listing })
      .from(schema.agentDirectoryRegistryRows)
      .where(and(eq(schema.agentDirectoryRegistryRows.sourceId, sourceId(chain)), eq(schema.agentDirectoryRegistryRows.externalKey, key(chain, name))));
    return row?.listing;
  };
  const publishedNames = async (chain: Erc8004Chain) =>
    (await writer.select({ k: schema.agentDirectoryEntries.externalKey, p: schema.agentDirectoryEntries.protocol }).from(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.sourceId, sourceId(chain)))).map(row => ({ name: row.k.split(":").pop()!, protocol: row.p }));

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
    // 0046 is manual, and alters tables the boot migrations make, so it is pasted after them, as the owner will.
    const owner = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0046_multichain_erc8004_protocols.sql", "utf8"))) await owner.query(statement);
    await owner.end();

    registry = await import("./agentRegistryRows");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "listing-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "listing-operator"));
    sources = {};
    for (const [, chain] of CASES) {
      const policy = chain.provider.kind === "pinned" ? chain.provider : { rootUrl: "https://arc-node.example", allowedHostname: "arc-node.example" };
      await writer.insert(schema.ingestionSources).values({
        id: sourceId(chain),
        sourceKey: chain.sourceKey,
        label: `${chain.label} ERC-8004 identity registry`,
        protocol: chain.protocol as (typeof schema.ingestionSources.$inferInsert)["protocol"],
        rootUrl: policy.rootUrl,
        allowedHostname: policy.allowedHostname,
        state: "active",
        createdByUserId: operator.id,
      });
      const [row] = await writer.select().from(schema.ingestionSources).where(eq(schema.ingestionSources.id, sourceId(chain)));
      sources[chain.chainKey] = row!;
    }
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  describe.each(CASES)("%s", (_name, chain) => {
    const rules = chain.listingRules!;
    const draft = (name: string, over: { displayName?: string; host?: string | null; owner?: string; link?: string; listing?: 0 | 3 }) => ({
      externalKey: key(chain, name),
      displayName: over.displayName ?? `Agent #${name}`,
      locatorHost: over.host === undefined ? `host-${name}.example` : over.host,
      registrant: over.owner ?? wallet(Number.parseInt(name.replace(/\D/g, "") || "1", 10) + 1_000_000),
      profileUriHash: hash(over.link ?? `link-${name}`),
      listing: over.listing ?? (3 as const),
      sourceSignalNote: `${chain.label} ERC-8004 registration. note`,
    });

    it("has rules of its own, none below 2, so a rule always holds something out", () => {
      for (const value of Object.values(rules)) expect(value).toBeGreaterThanOrEqual(2);
    });

    it("lists a clean registration and holds out one with no link, one named only with a number, and the groups its rules name", async () => {
      const drafts = [
        draft("clean", {}),
        draft("nolink", { host: null, listing: NO_LINK }),
        draft("numeric", { displayName: "424242" }),
        // A profile link shared by as many registrations as the rule names: each of them is grouped.
        ...Array.from({ length: rules.sharedProfileLinkFrom }, (_, n) => draft(`link${n}`, { link: "the-one-shared-link" })),
        // A host shared by as many as the rule names, each with a link and a wallet of its own.
        ...Array.from({ length: rules.sharedHostFrom }, (_, n) => draft(`host${n}`, { host: "platform.example" })),
        // A wallet that registered as many as the rule names, each with a host and a link of its own.
        ...Array.from({ length: rules.sharedWalletFrom }, (_, n) => draft(`wallet${n}`, { owner: wallet(777) })),
        // One short of each threshold stays listed.
        ...Array.from({ length: rules.sharedHostFrom - 1 }, (_, n) => draft(`nearhost${n}`, { host: "almost-platform.example" })),
        ...Array.from({ length: rules.sharedWalletFrom - 1 }, (_, n) => draft(`nearwallet${n}`, { owner: wallet(888) })),
      ];
      await registry.insertAgentRegistryRows({ source: sources[chain.chainKey]!, runId: "run-listing", drafts });
      await registry.refreshAgentRegistryListing(sources[chain.chainKey]!, { classify: true, publish: true, rules });

      expect(await stateOf(chain, "clean")).toBe(LISTED);
      expect(await stateOf(chain, "nolink")).toBe(NO_LINK);
      expect(await stateOf(chain, "numeric")).toBe(NUMERIC_NAME);
      for (let n = 0; n < rules.sharedProfileLinkFrom; n += 1) expect(await stateOf(chain, `link${n}`), `link${n}`).toBe(GROUPED);
      for (let n = 0; n < rules.sharedHostFrom; n += 1) expect(await stateOf(chain, `host${n}`), `host${n}`).toBe(GROUPED);
      for (let n = 0; n < rules.sharedWalletFrom; n += 1) expect(await stateOf(chain, `wallet${n}`), `wallet${n}`).toBe(GROUPED);
      for (let n = 0; n < rules.sharedHostFrom - 1; n += 1) expect(await stateOf(chain, `nearhost${n}`), `nearhost${n}`).toBe(LISTED);
      for (let n = 0; n < rules.sharedWalletFrom - 1; n += 1) expect(await stateOf(chain, `nearwallet${n}`), `nearwallet${n}`).toBe(LISTED);
    });

    it("publishes only the listed to the directory, under this chain's protocol, and none of the rest", async () => {
      const published = await publishedNames(chain);
      for (const entry of published) expect(entry.protocol).toBe(chain.protocol);
      const names = new Set(published.map(entry => entry.name));
      expect(names.has("clean")).toBe(true);
      for (const held of ["nolink", "numeric"]) expect(names.has(held), held).toBe(false);
      for (const grouped of ["link0", "host0", "wallet0"]) expect(names.has(grouped), grouped).toBe(false);
      // Exactly the listed: the clean one and the two groups that stopped one short of their rule.
      expect(names.size).toBe(1 + (rules.sharedHostFrom - 1) + (rules.sharedWalletFrom - 1));
    });

    it("uses the rules it is given: stricter ones hold out a group the chain's own rules list", async () => {
      // `nearhost` is one short of the chain's host rule, so it is listed. A rule one lower holds the whole group out.
      await registry.refreshAgentRegistryListing(sources[chain.chainKey]!, { classify: true, publish: true, rules: { ...rules, sharedHostFrom: rules.sharedHostFrom - 1 } });
      // Classification only moves pending and listed rows: the listed group is now grouped, and publishing removes it from the directory.
      expect(await stateOf(chain, "nearhost0")).toBe(GROUPED);
      const names = new Set((await publishedNames(chain)).map(entry => entry.name));
      expect(names.has("nearhost0")).toBe(false);
      expect(names.has("clean")).toBe(true);
    });
  });

  it("keeps each chain's rows to its own source, whatever the rows were named", async () => {
    for (const [, chain] of CASES) {
      const [{ total }] = await writer.select({ total: sql<number>`count(*)` }).from(schema.agentDirectoryRegistryRows).where(eq(schema.agentDirectoryRegistryRows.sourceId, sourceId(chain)));
      expect(Number(total)).toBeGreaterThan(50);
      const rows = await writer.select({ k: schema.agentDirectoryRegistryRows.externalKey, p: schema.agentDirectoryRegistryRows.protocol }).from(schema.agentDirectoryRegistryRows).where(eq(schema.agentDirectoryRegistryRows.sourceId, sourceId(chain)));
      for (const row of rows) {
        expect(row.k.startsWith(`eip155:${chain.chainId}:`)).toBe(true);
        expect(row.p).toBe(chain.protocol);
      }
    }
  });
});
