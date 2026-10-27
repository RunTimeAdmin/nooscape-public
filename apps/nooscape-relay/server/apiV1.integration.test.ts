import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import express from "express";
import { createConnection, createPool } from "mysql2/promise";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { API_CHAINS } from "./apiChains";
import { problems, schemaOf } from "./apiV1Testing";

/**
 * The REST API against a real database (docs/data-access-2026-10-19.md): what it serves is what the site's own reads serve. A hidden
 * entry, one from a paused source and a registry the API does not cover are never in an answer; a claim shows the owner's words
 * beside the record and none of them while it is on hold; the search narrows to a chain and to an exact wallet or host. Skips when no
 * database is reachable.
 */
const TEST_DB = "nooscape_apiv1_test";
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
const WALLET = "0x14791697260e4c9a71f18484c9f997b308e59325";
const OTHER = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const SOL_ASSET = "7Yw6u4v9kQ3pZ2r8s5t1x6c4b3n2m1k9j8h7g6f5d4e3";
const SOL_OWNER = "5Gh8j2k4m6n9p3q5r7s9t2v4w6x8y3z5a7b9c2d4e6f8";

describe.skipIf(!dbReachable)("the REST API against a real database", { timeout: 120_000 }, () => {
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let server: Server;
  let base = "";
  let operatorUserId: number;
  let rateLimit: typeof import("./rateLimit");
  const ids: Record<string, string> = {};

  async function source(id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"], state: "active" | "paused" = "active") {
    await writer.insert(schema.ingestionSources).values({ id, sourceKey: `apiv1-${id}`, label: id, protocol, rootUrl: "https://apiv1.example/feed", allowedHostname: "apiv1.example", state, createdByUserId: operatorUserId });
  }
  async function entry(name: string, sourceId: string, protocol: (typeof schema.agentDirectoryEntries.$inferInsert)["protocol"], externalKey: string, extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}) {
    const id = `apiv1-${name}`;
    await writer.insert(schema.agentDirectoryEntries).values({ id, sourceId, externalKey, displayName: name, protocol, registrant: WALLET, locatorHost: "alice.example", sourceSignalNote: "Seeded.", ...extra });
    ids[name] = id;
  }

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    const baseline = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baseline.query(statement);
    }
    await baseline.end();
    await applyPendingMigrations(process.env.DATABASE_URL);
    // The claim tables are a manual migration, so a boot does not make them: run the file as the owner would paste it.
    const paste = await createConnection(process.env.DATABASE_URL);
    for (const statement of splitMigrationStatements(await readFile("drizzle/0042_agent_claims.sql", "utf8"))) await paste.query(statement);
    await paste.end();
    rateLimit = await import("./rateLimit");
    const { registerApiV1 } = await import("./apiV1");
    writer = drizzle(createPool(process.env.DATABASE_URL));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "apiv1-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "apiv1-operator"));
    operatorUserId = operator!.id;
    await source("src-rh", "erc8004");
    await source("src-bnb", "erc8004_bsc");
    await source("src-8004", "solana_8004");
    await source("src-said", "solana_said");
    await source("src-catalog", "catalog");
    await source("src-registry", "solana_registry");
    await source("src-paused", "erc8004", "paused");
    await entry("Alice Agent", "src-rh", "erc8004", `eip155:4663:${REGISTRY}:7`);
    await entry("Hidden Alice", "src-rh", "erc8004", `eip155:4663:${REGISTRY}:8`, { hidden: true });
    await entry("Paused Alice", "src-paused", "erc8004", `eip155:4663:${REGISTRY}:9`);
    await entry("Bnb Alice", "src-bnb", "erc8004_bsc", `eip155:56:${REGISTRY}:11`, { registrant: OTHER, locatorHost: "bnb.example" });
    await entry("Solana Alice", "src-8004", "solana_8004", SOL_ASSET, { registrant: SOL_OWNER, locatorHost: null });
    await entry("Said Alice", "src-said", "solana_said", SOL_ASSET, { registrant: SOL_OWNER, locatorHost: null });
    await entry("Said Bob", "src-said", "solana_said", SOL_OWNER, { registrant: SOL_OWNER, locatorHost: null });
    await entry("Catalog Alice", "src-catalog", "catalog", "catalog-key-1");
    // The same address, listed by a third Solana registry and hidden: it must not make an address look ambiguous.
    await entry("Hidden Registry Bob", "src-registry", "solana_registry", SOL_OWNER, { registrant: SOL_OWNER, locatorHost: null, hidden: true });
    const app = express();
    registerApiV1(app);
    await new Promise<void>(done => {
      server = app.listen(0, "127.0.0.1", () => done());
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>(done => (server ? server.close(() => done()) : done()));
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  const get = async (path: string) => {
    rateLimit.resetRateLimits();
    const response = await fetch(`${base}${path}`);
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, any> };
  };

  it("serves a visible agent as the site's own read does, dated by when it was last seen", async () => {
    const { status, json } = await get("/api/v1/agents/robinhood/7");
    expect(status).toBe(200);
    expect(problems(schemaOf("AgentResponse"), json)).toEqual([]);
    expect(json.data).toMatchObject({ chain: "robinhood", agent_id: "7", registry: "erc8004", nooscape_id: ids["Alice Agent"], name: "Alice Agent", registrant: WALLET, locator_host: "alice.example" });
    const [row] = await writer.select().from(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.id, ids["Alice Agent"]!));
    expect(json.as_of).toBe(row!.lastSeenAt.toISOString());
    expect(json.data.evidence).toMatchObject({ layer: "acknowledged", level: null });
    expect(json.data.claim).toBeNull();
  });

  it("never serves a hidden entry or one from a paused source, and answers both as it answers an id that was never listed", async () => {
    const never = await get("/api/v1/agents/robinhood/12345");
    for (const token of ["8", "9"]) {
      const answer = await get(`/api/v1/agents/robinhood/${token}`);
      expect(answer.status, token).toBe(404);
      expect(answer.json, token).toEqual(never.json);
    }
    // And once an entry is hidden after it was served, it is gone from the next read.
    await writer.update(schema.agentDirectoryEntries).set({ hidden: true }).where(eq(schema.agentDirectoryEntries.id, ids["Bnb Alice"]!));
    expect((await get("/api/v1/agents/bnb/11")).status).toBe(404);
    await writer.update(schema.agentDirectoryEntries).set({ hidden: false }).where(eq(schema.agentDirectoryEntries.id, ids["Bnb Alice"]!));
    expect((await get("/api/v1/agents/bnb/11")).status).toBe(200);
  });

  it("says a BNB entry is 'Not checked' while no registration read is on record, with the evidence table missing, and keeps it acknowledged", async () => {
    const { status, json } = await get("/api/v1/agents/bnb/11");
    expect(status).toBe(200);
    expect(problems(schemaOf("AgentResponse"), json)).toEqual([]);
    expect(json.source).toMatchObject({ chain: "bnb", chain_id: 56, registry: "erc8004_bsc" });
    expect(json.data.evidence).toMatchObject({ layer: "acknowledged", level: "not_checked", label: "Not checked", read_at: null });
  });

  it("shows a claim's owner text beside the record as the owner's word, none while the claim is on hold, and nothing once it ends", async () => {
    const now = new Date("2026-10-18T20:00:00Z");
    await writer.insert(schema.agentClaims).values({
      id: "apiv1-claim",
      entryId: ids["Alice Agent"]!,
      inForceEntryId: ids["Alice Agent"]!,
      protocol: "erc8004",
      chainId: 4663,
      registry: REGISTRY,
      tokenId: "7",
      wallet: WALLET,
      status: "active",
      claimedAt: now,
      statusChangedAt: now,
      lastOwnerCheckAt: now,
      signatureDigest: "a".repeat(64),
      name: "Alice, by Alice",
      website: "https://alice.example/",
      description: "Does research.",
      links: JSON.stringify(["https://github.com/alice"]),
    });
    let { json } = await get("/api/v1/agents/robinhood/7");
    expect(problems(schemaOf("AgentResponse"), json)).toEqual([]);
    expect(json.data.claim).toMatchObject({ status: "active", wallet: WALLET });
    expect(json.data.claim.owner_text).toMatchObject({ statement: "Written by the claim holder. Nooscape has not checked it, and it does not change how this entry is listed.", name: "Alice, by Alice", links: ["https://github.com/alice"] });
    expect(json.data.name).toBe("Alice Agent");
    expect(json.data.evidence.layer).toBe("acknowledged");

    await writer.update(schema.agentClaims).set({ status: "frozen" }).where(eq(schema.agentClaims.id, "apiv1-claim"));
    ({ json } = await get("/api/v1/agents/robinhood/7"));
    expect(json.data.claim).toMatchObject({ status: "on_hold", owner_text: null });
    expect(JSON.stringify(json)).not.toContain("Alice, by Alice");

    await writer.update(schema.agentClaims).set({ status: "revoked", inForceEntryId: null }).where(eq(schema.agentClaims.id, "apiv1-claim"));
    ({ json } = await get("/api/v1/agents/robinhood/7"));
    expect(json.data.claim).toBeNull();
    expect(JSON.stringify(json)).not.toContain("Alice, by Alice");
  });

  it("answers 409 for a Solana address two registries list, and the one asked for when registry= is given", async () => {
    const both = await get(`/api/v1/agents/solana/${SOL_ASSET}`);
    expect(both.status).toBe(409);
    expect(both.json.error).toMatchObject({ code: "ambiguous", registries: ["solana_8004", "solana_said"] });
    const one = await get(`/api/v1/agents/solana/${SOL_ASSET}?registry=solana_8004`);
    expect(one.status).toBe(200);
    expect(problems(schemaOf("AgentResponse"), one.json)).toEqual([]);
    expect(one.json.data).toMatchObject({ chain: "solana", agent_id: SOL_ASSET, registry: "solana_8004", name: "Solana Alice" });
    const single = await get(`/api/v1/agents/solana/${SOL_OWNER}`);
    expect(single.status, "a hidden listing of the same address is not a match").toBe(200);
    expect(single.json.data).toMatchObject({ registry: "solana_said", name: "Said Bob" });
  });

  it("searches the three chains' registries and nothing else, never a hidden or paused entry, newest first", async () => {
    const { status, json } = await get("/api/v1/agents/search?q=alice&limit=25");
    expect(status).toBe(200);
    expect(problems(schemaOf("SearchResponse"), json)).toEqual([]);
    const names = json.data.results.map((result: { name: string }) => result.name).sort();
    expect(names).toEqual(["Alice Agent", "Bnb Alice", "Said Alice", "Solana Alice"]);
    for (const hidden of ["Hidden Alice", "Paused Alice", "Catalog Alice"]) expect(names).not.toContain(hidden);
    for (const result of json.data.results) expect(result.links.agent).toBe(`/api/v1/agents/${result.chain}/${result.agent_id}`);
  });

  it("narrows a search to a chain, to an exact wallet and to an exact host", async () => {
    let answer = await get("/api/v1/agents/search?q=alice&chain=solana");
    expect(answer.json.data.results.map((result: { chain: string }) => result.chain)).toEqual(["solana", "solana"]);
    answer = await get("/api/v1/agents/search?q=alice&chain=bnb");
    expect(answer.json.data.results.map((result: { name: string }) => result.name)).toEqual(["Bnb Alice"]);
    answer = await get(`/api/v1/agents/search?owner=${WALLET}`);
    expect(answer.json.data.results.map((result: { name: string }) => result.name)).toEqual(["Alice Agent"]);
    answer = await get(`/api/v1/agents/search?owner=${OTHER}&chain=bnb`);
    expect(answer.json.data.results.map((result: { name: string }) => result.name)).toEqual(["Bnb Alice"]);
    answer = await get("/api/v1/agents/search?host=bnb.example");
    expect(answer.json.data.results.map((result: { name: string }) => result.name)).toEqual(["Bnb Alice"]);
    answer = await get("/api/v1/agents/search?host=alice.example");
    expect(answer.json.data.results.map((result: { name: string }) => result.name)).toEqual(["Alice Agent"]);
    expect(answer.json.data.results[0]).not.toHaveProperty("tier");
  });

  it("returns at most the limit, and an empty page for a search that matches nothing", async () => {
    const one = await get("/api/v1/agents/search?q=alice&limit=1");
    expect(one.json.data.results).toHaveLength(1);
    expect(one.json.data.matched_total).toBeGreaterThanOrEqual(1);
    const none = await get("/api/v1/agents/search?q=zzzznothingzzzz");
    expect(none.status).toBe(200);
    expect(none.json.data).toMatchObject({ results: [], matched_total: 0 });
  });

  // The stats read the site's own chain figures, so the same rows give the same counts. Each read below drops the shared read cache
  // first, as an operator's hide or a paused source does, so a change made here shows on the very next read.
  const stats = async () => {
    const { invalidateDirectoryReads } = await import("./readCache");
    invalidateDirectoryReads();
    const answer = await get("/api/v1/stats");
    expect(answer.status).toBe(200);
    expect(problems(schemaOf("StatsResponse"), answer.json)).toEqual([]);
    const rows = Object.fromEntries((answer.json.data.chains as Array<{ chain: string }>).map(row => [row.chain, row])) as Record<string, Record<string, any>>;
    return { json: answer.json, rows };
  };

  it("counts the entries the site's chain tabs count and no others: not a hidden one, one from a paused source or a locator protocol", async () => {
    const { json, rows } = await stats();
    expect(json.data.chains.map((row: { chain: string }) => row.chain)).toEqual(["robinhood", "bnb", "solana"]);
    // Nine rows are seeded. The visible ones on a chain are Alice Agent, Bnb Alice, Solana Alice and the two Said entries.
    expect(rows.robinhood).toMatchObject({ indexed: true, acknowledged: 1, ratings_recorded: null, registrations_on_chain: null, last_read_at: null });
    expect(rows.robinhood!.registries).toEqual([{ registry: "erc8004", address: API_CHAINS.robinhood.registry, acknowledged: 1 }]);
    expect(rows.bnb).toMatchObject({ indexed: true, acknowledged: 1, chain_id: 56 });
    expect(rows.solana).toMatchObject({ indexed: true, acknowledged: 3, chain_id: null, ratings_recorded: null });
    // Largest first, and the registry whose only entry is hidden is not listed with a zero.
    expect(rows.solana!.registries).toEqual([
      { registry: "solana_said", address: null, acknowledged: 2 },
      { registry: "solana_8004", address: null, acknowledged: 1 },
    ]);
    expect(json.data.totals).toEqual({ acknowledged: 5 });
    // The same figures as the site's own read of them.
    const { appRouter } = await import("./routers");
    const site = (await appRouter.createCaller({ req: {}, res: {}, user: null } as never).liveData.chainStats()).chains;
    expect(site.map(stat => stat.chain).sort()).toEqual(["bnb", "robinhood", "solana"]);
    for (const stat of site) {
      expect(rows[stat.chain], stat.chain).toMatchObject({ indexed: stat.indexed, acknowledged: stat.acknowledged, ratings_recorded: stat.feedbackEvents, last_read_at: stat.asOf });
      expect(rows[stat.chain]!.registries.map((registry: { registry: string; acknowledged: number }) => [registry.registry, registry.acknowledged]), stat.chain).toEqual(stat.registries.map(registry => [registry.protocol, registry.count]));
    }
  });

  it("takes the ratings, the registry's registrations, the last read and the entries first seen in a day from the rows that give the site's tabs theirs", async () => {
    // Solana's ratings are the 8004 registry's own counters on the visible accounts.
    await writer.update(schema.agentDirectoryEntries).set({ feedbackCount: 5 }).where(eq(schema.agentDirectoryEntries.id, ids["Solana Alice"]!));
    // BNB Chain's registrations are the registry rows its pass stored, listed or held out.
    for (const [index, listing] of [1, 1, 2, 0].entries()) {
      await writer.insert(schema.agentDirectoryRegistryRows).values({ id: `apiv1-bnb-row-${index}`, sourceId: "src-bnb", externalKey: `eip155:56:${REGISTRY}:${100 + index}`, displayName: `Registration ${index}`, protocol: "erc8004_bsc", listing });
    }
    // A chain was last read when its newest active source last succeeded: a paused source's time is not the chain's.
    const solanaOlder = new Date("2026-10-18T10:00:00Z");
    const solanaNewer = new Date("2026-10-19T10:00:00Z");
    const robinhoodRead = new Date("2026-10-18T09:00:00Z");
    await writer.update(schema.ingestionSources).set({ lastSuccessfulAt: solanaOlder }).where(eq(schema.ingestionSources.id, "src-8004"));
    await writer.update(schema.ingestionSources).set({ lastSuccessfulAt: solanaNewer }).where(eq(schema.ingestionSources.id, "src-said"));
    await writer.update(schema.ingestionSources).set({ lastSuccessfulAt: robinhoodRead }).where(eq(schema.ingestionSources.id, "src-rh"));
    await writer.update(schema.ingestionSources).set({ lastSuccessfulAt: new Date("2026-10-20T09:00:00Z") }).where(eq(schema.ingestionSources.id, "src-paused"));
    // Said Bob was first seen three days ago: it is listed, and it is not new in the last day.
    await writer.update(schema.agentDirectoryEntries).set({ firstSeenAt: new Date(Date.now() - 3 * 24 * 3_600_000) }).where(eq(schema.agentDirectoryEntries.id, ids["Said Bob"]!));
    const { rows } = await stats();
    expect(rows.solana).toMatchObject({ acknowledged: 3, ratings_recorded: 5, new_in_24h: 2, last_read_at: solanaNewer.toISOString() });
    expect(rows.bnb).toMatchObject({ acknowledged: 1, registrations_on_chain: 4, new_in_24h: 1 });
    expect(rows.robinhood).toMatchObject({ acknowledged: 1, registrations_on_chain: null, new_in_24h: 1, last_read_at: robinhoodRead.toISOString() });
  });

  it("shows an operator's hide and a paused source on the very next read, and reports a chain with no active source as not indexed and not zero", async () => {
    await writer.update(schema.agentDirectoryEntries).set({ hidden: true }).where(eq(schema.agentDirectoryEntries.id, ids["Alice Agent"]!));
    let read = await stats();
    expect(read.rows.robinhood).toMatchObject({ indexed: true, acknowledged: 0, new_in_24h: 0, registries: [] });
    expect(read.json.data.totals).toEqual({ acknowledged: 4 });

    await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, "src-rh"));
    read = await stats();
    expect(read.rows.robinhood).toEqual({
      chain: "robinhood",
      label: "Robinhood Chain",
      chain_id: 4663,
      indexed: false,
      acknowledged: null,
      ratings_recorded: null,
      registrations_on_chain: null,
      new_in_24h: null,
      registries: [],
      last_read_at: null,
    });
    expect(read.json.data.totals).toEqual({ acknowledged: 4 });

    await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, "src-rh"));
    await writer.update(schema.agentDirectoryEntries).set({ hidden: false }).where(eq(schema.agentDirectoryEntries.id, ids["Alice Agent"]!));
    read = await stats();
    expect(read.rows.robinhood).toMatchObject({ indexed: true, acknowledged: 1 });
    expect(read.json.data.totals).toEqual({ acknowledged: 5 });
  });
});
