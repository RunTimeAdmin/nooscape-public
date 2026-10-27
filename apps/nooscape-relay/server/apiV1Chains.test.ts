import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXTRA_CHAINS, extraProtocolOf, type ChainStat } from "@shared/chains";
import { API_CHAINS, CHAIN_KEYS, apiChainOfProtocol, servedChains } from "./apiChains";
import { STATS_STATEMENT, type StatsRead } from "./apiStats";
import { registerApiV1, searchAnswer, type ApiV1Deps } from "./apiV1";
import { API_TIERS, type ApiKeyRecord, type UsageReport } from "./apiKeys";
import { problems, schemaOf } from "./apiV1Testing";
import { API_V1_SPEC, apiV1SpecFor } from "./apiV1Spec";
import { externalKey } from "./ingestion/erc8004Chain";
import { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN } from "./ingestion/erc8004Chains";
import { resetRateLimits } from "./rateLimit";

/**
 * The REST API and the switches of Ethereum, Base and Arc (docs/multichain-erc8004-2026-10-20.md, stage 3). With every switch off the
 * API names the three chains it always has and nothing else: no new chain in the index, the lookups, the search, the check or the
 * document. A chain whose switch is on is served the way BNB Chain is, and so are the watchlist and the webhook (apiWebhooks.test.ts).
 */

const NOW = new Date("2026-10-20T03:00:00Z");
const WALLET = "0x14791697260e4c9a71f18484c9f997b308e59325";
const KEY = `nsk_${"a".repeat(40)}`;
const ORIGINAL = ["robinhood", "bnb", "solana"];

const CHAIN_OF = { ethereum: ETHEREUM_CHAIN, base: BASE_CHAIN, arc: ARC_CHAIN } as const;
const idOf = { ethereum: "11", base: "12", arc: "13" } as const;
const entryIdOf = (chain: keyof typeof CHAIN_OF) => `${{ ethereum: "e", base: "b", arc: "a" }[chain]}0000000-0000-4000-8000-000000000000`;

const entry = (chain: keyof typeof CHAIN_OF, overrides: Record<string, unknown> = {}) =>
  ({
    id: entryIdOf(chain),
    displayName: `${chain} agent`,
    locatorHost: "agents.example",
    protocol: CHAIN_OF[chain].protocol,
    sourceSignalNote: `${CHAIN_OF[chain].label} ERC-8004 registration.`,
    registrant: WALLET,
    feedbackCount: null,
    firstSeenAt: new Date("2026-10-19T00:00:00Z"),
    lastSeenAt: new Date("2026-10-20T01:00:00Z"),
    related: { sameWallet: 4, sameName: 0, sameHost: 2 },
    activity: null,
    twin: null,
    ratings: null,
    ...overrides,
  }) as never;

const record: ApiKeyRecord = { id: "key-pro", tier: "pro", prefix: "nsk_aaaaaa" };
const MIDNIGHT = new Date("2026-10-21T00:00:00Z");
const keys: ApiV1Deps["keys"] = {
  resolve: async raw => (raw === KEY ? record : null),
  consume: async (_id, perDay) => ({ allowed: true, limit: perDay, used: 1, remaining: perDay - 1, resetsAt: MIDNIGHT }),
  usage: async (): Promise<UsageReport> => ({ today: { date: "2026-10-20", used: 1, remaining: API_TIERS.pro.perDay - 1, limit: API_TIERS.pro.perDay, resetsAt: MIDNIGHT }, days: [] }),
};

/**
 * The site's chain figures, with a row for every extra chain whatever its switch says. The site gives a row only for a chain that is
 * on, so holding all three here shows the answer is held to the chains the API serves and does not trust the read to be.
 */
const STATS_AT = "2026-10-20T02:58:00.000Z";
const statRow = (chain: ChainStat["chain"], acknowledged: number, feedbackEvents: number | null, registries: ChainStat["registries"]): ChainStat => ({ chain, indexed: true, acknowledged, reviewed: 0, feedbackEvents, registries, asOf: "2026-10-20T02:30:00.000Z" });
const ARRIVED = { robinhood: 5, solana: 6, bnb: 7, ethereum: 8, base: 9, arc: 10 } as const;
const STATS_READ: StatsRead = {
  readAt: STATS_AT,
  chains: [statRow("robinhood", 300, 40, [{ protocol: "erc8004", count: 300 }]), statRow("solana", 200, 10, [{ protocol: "solana_said", count: 150 }, { protocol: "solana_8004", count: 50 }]), statRow("bnb", 100, null, [{ protocol: "erc8004_bsc", count: 100 }])],
  extras: EXTRA_CHAINS.map((chain, index) => ({
    chain,
    indexed: true,
    acknowledged: 1000 * (index + 1),
    reviewed: 0,
    feedbackEvents: 7 * (index + 1),
    registries: [{ protocol: CHAIN_OF[chain].protocol, count: 1000 * (index + 1) }],
    asOf: "2026-10-20T02:40:00.000Z",
    registry: { recorded: 50_000 * (index + 1), listed: 1000 * (index + 1) },
  })),
  arrivals: { windowHours: 24, computedAt: STATS_AT, chains: Object.entries(ARRIVED).map(([chain, added]) => ({ chain: chain as keyof typeof ARRIVED, indexed: true, added, newest: [], registries: [] })) },
  bnbRegistrations: 5000,
};

type Calls = { find: Array<{ protocols: readonly string[]; key: string }>; search: Array<{ query: string; protocols?: readonly string[] }> };

/** The data layer holds one listing on each extra chain, and answers a lookup only for the key it is stored under. */
function deps(calls: Calls): ApiV1Deps {
  const byKey = new Map(EXTRA_CHAINS.map(chain => [API_CHAINS[chain].keyOf(idOf[chain]), chain] as const));
  return {
    now: () => NOW,
    findEntries: async (protocols, key) => {
      calls.find.push({ protocols, key });
      const chain = byKey.get(key);
      return chain && protocols.includes(CHAIN_OF[chain].protocol) ? [{ id: entryIdOf(chain), protocol: CHAIN_OF[chain].protocol, externalKey: key }] : [];
    },
    getEntry: async id => entry(EXTRA_CHAINS.find(chain => entryIdOf(chain) === id)!),
    search: async input => {
      calls.search.push(input);
      const wanted = EXTRA_CHAINS.filter(chain => (input.protocols ?? []).includes(CHAIN_OF[chain].protocol));
      return { entries: wanted.map(chain => entry(chain)), matchedTotal: wanted.length, matchedTotalCapped: false } as never;
    },
    keysOf: async ids => new Map(EXTRA_CHAINS.filter(chain => ids.includes(entryIdOf(chain))).map(chain => [entryIdOf(chain), API_CHAINS[chain].keyOf(idOf[chain])] as const)),
    claimOf: async () => null,
    claimHistory: async () => null,
    checkFacts: async () => ({ activityThroughBlock: null, solana: null }),
    stats: async () => STATS_READ,
    keys,
  };
}

let server: Server | null = null;
let base = "";
let calls: Calls;

async function start(features: string | undefined) {
  await stop();
  if (features === undefined) delete process.env.VITE_FEATURES;
  else process.env.VITE_FEATURES = features;
  calls = { find: [], search: [] };
  const app = express();
  registerApiV1(app, deps(calls));
  await new Promise<void>(done => {
    server = app.listen(0, "127.0.0.1", () => done());
  });
  const address = server!.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

async function stop() {
  if (!server) return;
  await new Promise<void>(done => server!.close(() => done()));
  server = null;
}

const get = (path: string) => fetch(`${base}${path}`);
const post = (path: string, payload: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, body: JSON.stringify(payload) });
const body = async (response: Response) => (await response.json()) as Record<string, any>;

const savedFeatures = process.env.VITE_FEATURES;
beforeEach(() => resetRateLimits());
afterEach(() => {
  if (savedFeatures === undefined) delete process.env.VITE_FEATURES;
  else process.env.VITE_FEATURES = savedFeatures;
});
afterAll(stop);

describe("the chains the API serves", () => {
  it("are the original three while every switch is off, whatever else is in the list", () => {
    for (const features of [undefined, "", "watch,patrols,claims", "chain_arcade,ethereum,base"]) {
      expect([...servedChains(features)], String(features)).toEqual(ORIGINAL);
      expect(servedChains(features), String(features)).toBe(CHAIN_KEYS);
    }
  });

  it("gain each extra chain whose switch is on, after the three, in the order Ethereum, Base, Arc", () => {
    expect([...servedChains("chain_base")]).toEqual([...ORIGINAL, "base"]);
    expect([...servedChains("chain_arc,chain_ethereum")]).toEqual([...ORIGINAL, "ethereum", "arc"]);
    expect([...servedChains("claims, CHAIN_BASE ,chain_ethereum,chain_arc")]).toEqual([...ORIGINAL, "ethereum", "base", "arc"]);
  });

  it("name an extra chain's protocol only among the chains given", () => {
    for (const chain of EXTRA_CHAINS) {
      expect(apiChainOfProtocol(CHAIN_OF[chain].protocol)).toBeNull();
      expect(apiChainOfProtocol(CHAIN_OF[chain].protocol, servedChains("chain_base,chain_ethereum,chain_arc"))).toBe(chain);
    }
    expect(apiChainOfProtocol("erc8004_bsc")).toBe("bnb");
    expect(apiChainOfProtocol("erc8004_base", servedChains("chain_ethereum"))).toBeNull();
    // With no list given it is the original three, whatever is switched on.
    process.env.VITE_FEATURES = "chain_ethereum,chain_base,chain_arc";
    for (const chain of EXTRA_CHAINS) expect(apiChainOfProtocol(CHAIN_OF[chain].protocol), chain).toBeNull();
  });

  it("store an agent under the key the chain pass writes, so a lookup finds what the pass stored", () => {
    for (const chain of EXTRA_CHAINS) {
      expect(API_CHAINS[chain].keyOf("12345")).toBe(externalKey(CHAIN_OF[chain], "12345"));
      expect(API_CHAINS[chain].protocols).toEqual([CHAIN_OF[chain].protocol]);
      expect(API_CHAINS[chain].protocols).toEqual([extraProtocolOf(chain)]);
      expect(API_CHAINS[chain].chainId).toBe(CHAIN_OF[chain].chainId);
      expect(API_CHAINS[chain].registry).toBe(CHAIN_OF[chain].identityRegistry);
    }
  });
});

describe("with every switch off", () => {
  it("names the three chains in the index and serves the document word for word", async () => {
    await start(undefined);
    const index = await body(await get("/api/v1"));
    expect(index.chains.map((chain: { chain: string }) => chain.chain)).toEqual(ORIGINAL);
    expect(index.chains.map((chain: { label: string }) => chain.label)).toEqual(["Robinhood Chain", "BNB Chain", "Solana"]);
    expect(JSON.stringify(await body(await get("/api/v1/openapi.json")))).toBe(JSON.stringify(API_V1_SPEC));
    expect(apiV1SpecFor(servedChains(undefined))).toBe(API_V1_SPEC);
  });

  it("does not know an extra chain on a lookup, and does not ask the data layer about it", async () => {
    await start(undefined);
    for (const chain of EXTRA_CHAINS) {
      const response = await get(`/api/v1/agents/${chain}/${idOf[chain]}`);
      expect(response.status, chain).toBe(400);
      expect((await body(response)).error).toEqual({ code: "bad_request", message: "chain must be one of robinhood, bnb, solana" });
    }
    expect(calls.find).toEqual([]);
  });

  it("refuses an extra chain in a search or a check in the words it uses for any name that is not a chain", async () => {
    await start(undefined);
    const nonsense = await body(await get("/api/v1/agents/search?q=alice&chain=nonsense"));
    for (const chain of EXTRA_CHAINS) {
      const search = await get(`/api/v1/agents/search?q=alice&chain=${chain}`);
      expect(search.status).toBe(400);
      expect((await body(search)).error.message).toBe(nonsense.error.message);
      expect(nonsense.error.message).toContain('"robinhood"');
      expect(nonsense.error.message).not.toMatch(/ethereum|base|arc/i);
      const check = await post("/api/v1/check", { wallet: WALLET, chain });
      const nonsenseCheck = await body(await post("/api/v1/check", { wallet: WALLET, chain: "nonsense" }));
      expect(check.status).toBe(400);
      expect((await body(check)).error.message).toBe(nonsenseCheck.error.message);
    }
    expect(calls.search).toEqual([]);
  });

  it("searches only the registries it always has, and drops a listing of an extra chain if one reaches the page", async () => {
    await start(undefined);
    await get("/api/v1/agents/search?q=alice");
    expect(calls.search).toEqual([{ query: "alice", limit: 10, protocols: ["erc8004", "erc8004_bsc", "solana_8004", "solana_said", "solana_registry", "solana_agenc"] }]);
    const page = { entries: EXTRA_CHAINS.map(chain => entry(chain)), matchedTotal: 3, matchedTotalCapped: false } as never;
    const keysOf = new Map(EXTRA_CHAINS.map(chain => [entryIdOf(chain), API_CHAINS[chain].keyOf(idOf[chain])] as const));
    const answer = searchAnswer({ q: "alice", limit: 10 }, page, keysOf, NOW);
    expect((answer.data as { results: unknown[] }).results).toEqual([]);
    expect((answer.source as { chains: string[] }).chains).toEqual(ORIGINAL);
  });
});

describe("with one switch on", () => {
  it("lists that chain after the three in the index, with its name and its registry", async () => {
    await start("chain_base");
    const index = await body(await get("/api/v1"));
    expect(index.chains).toEqual([
      { chain: "robinhood", label: "Robinhood Chain", registries: ["erc8004"] },
      { chain: "bnb", label: "BNB Chain", registries: ["erc8004_bsc"] },
      { chain: "solana", label: "Solana", registries: ["solana_8004", "solana_said", "solana_registry", "solana_agenc"] },
      { chain: "base", label: "Base", registries: ["erc8004_base"] },
    ]);
    const spec = apiV1SpecFor(servedChains("chain_base"));
    expect(problems(schemaOf("IndexResponse"), index, "$", spec)).toEqual([]);
  });

  it("serves one agent on that chain the way it serves one on BNB Chain, in the shape the served document describes", async () => {
    await start("chain_base");
    const response = await get(`/api/v1/agents/base/${idOf.base}`);
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(problems(schemaOf("AgentResponse"), answer, "$", apiV1SpecFor(servedChains("chain_base")))).toEqual([]);
    expect(answer.source).toMatchObject({ kind: "registry", chain: "base", chain_id: 8453, registry: "erc8004_base", registry_address: BASE_CHAIN.identityRegistry, key: `eip155:8453:${BASE_CHAIN.identityRegistry}:12` });
    expect(answer.data).toMatchObject({ chain: "base", agent_id: "12", registry: "erc8004_base", name: "base agent" });
    // Acknowledged and nothing more: no registration read, no tier, no verdict.
    expect(answer.data.evidence).toMatchObject({ layer: "acknowledged", level: null, label: null, read_at: null });
    expect(JSON.stringify(answer)).not.toMatch(/\b(tier_\d|trusted|trustworthy|certified|endorsed)\b/i);
    // The data layer was asked for that chain's registry only.
    expect(calls.find).toEqual([{ protocols: ["erc8004_base"], key: `eip155:8453:${BASE_CHAIN.identityRegistry}:12` }]);
  });

  it("does not know a chain whose switch is off, and says which chains it does", async () => {
    await start("chain_base");
    const response = await get(`/api/v1/agents/ethereum/${idOf.ethereum}`);
    expect(response.status).toBe(400);
    expect((await body(response)).error).toEqual({ code: "bad_request", message: "chain must be one of robinhood, bnb, solana, base" });
    expect((await get("/api/v1/agents/search?q=alice&chain=arc")).status).toBe(400);
  });

  it("searches that chain's registry with the others, narrows to it on request, and links each result to its own answer", async () => {
    await start("chain_base");
    const all = await body(await get("/api/v1/agents/search?q=alice"));
    expect(calls.search[0]!.protocols).toEqual(["erc8004", "erc8004_bsc", "solana_8004", "solana_said", "solana_registry", "solana_agenc", "erc8004_base"]);
    expect(all.source).toEqual({ kind: "directory_search", chains: [...ORIGINAL, "base"], registries: calls.search[0]!.protocols });
    const only = await body(await get("/api/v1/agents/search?q=alice&chain=base"));
    expect(calls.search[1]!.protocols).toEqual(["erc8004_base"]);
    expect(only.source).toEqual({ kind: "directory_search", chains: ["base"], registries: ["erc8004_base"] });
    expect(only.data.results).toHaveLength(1);
    expect(only.data.results[0]).toMatchObject({ chain: "base", agent_id: "12", registry: "erc8004_base", links: { agent: "/api/v1/agents/base/12" } });
    expect(only.data.query.chain).toBe("base");
    expect(problems(schemaOf("SearchResponse"), only, "$", apiV1SpecFor(servedChains("chain_base")))).toEqual([]);
  });

  it("names that chain in the document's lists of chains, the watchlist's included, and in the sentences that name the registries", async () => {
    await start("chain_base");
    const spec = await body(await get("/api/v1/openapi.json"));
    const served = JSON.stringify(spec);
    expect(served).toContain('"enum":["robinhood","bnb","solana","base"]');
    expect(served).toContain('"enum":["robinhood","bnb","solana","base",null]');
    expect(served).toContain("erc8004, erc8004_bsc, solana_8004, solana_said, solana_registry, solana_agenc, erc8004_base)");
    expect(served).toContain("The search covers the Robinhood Chain, BNB Smart Chain, Solana and Base registries.");
    expect(served).toContain("On robinhood, bnb and base the id is the registry token id.");
    // The watchlist's chain lists gain the chain too, with and without null.
    expect(spec.components.schemas.WatchList.properties.data.properties.watches.items.properties.chain.enum).toEqual([...ORIGINAL, "base", null]);
    expect(spec.components.schemas.WatchAddRequest.properties.agents.items.properties.chain.enum).toEqual([...ORIGINAL, "base"]);
    // With every switch off the lists are the original three, as they always were.
    const original = JSON.parse(JSON.stringify(API_V1_SPEC));
    expect(original.components.schemas.WatchList.properties.data.properties.watches.items.properties.chain.enum).toEqual([...ORIGINAL, null]);
    expect(original.components.schemas.WatchAddRequest.properties.agents.items.properties.chain.enum).toEqual(ORIGINAL);
  });

  it("narrows a check of a wallet to a chain that is on, and to no other", async () => {
    await start("chain_base");
    const response = await post("/api/v1/check", { wallet: WALLET, chain: "base" });
    expect(response.status).toBe(200);
    expect(calls.search.at(-1)!.protocols).toEqual(["erc8004_base"]);
    const answer = await body(response);
    expect(answer.data.results.map((result: { agent: { chain: string } }) => result.agent.chain)).toEqual(["base"]);
    expect((await post("/api/v1/check", { wallet: WALLET, chain: "arc" })).status).toBe(400);
  });

  it("answers a check for an agent on that chain with the flags the check already gives any EVM registry", async () => {
    await start("chain_base");
    const response = await post("/api/v1/check", { agent: { chain: "base", id: idOf.base } });
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(answer.data.results[0].agent).toMatchObject({ chain: "base", agent_id: "12", registry: "erc8004_base" });
    expect(Object.keys(answer.data.results[0].flags)).toEqual(["first_seen", "ownership_changes", "revoked_feedback", "fleet"]);
    expect(answer.data.results[0].flags.revoked_feedback.present).toBeNull();
  });
});

describe("with every switch on", () => {
  it("lists all six chains in order and serves one agent on each with its own chain id and registry", async () => {
    await start("chain_ethereum,chain_base,chain_arc");
    const index = await body(await get("/api/v1"));
    expect(index.chains.map((chain: { chain: string }) => chain.chain)).toEqual([...ORIGINAL, "ethereum", "base", "arc"]);
    expect(index.chains.slice(3).map((chain: { label: string }) => chain.label)).toEqual(["Ethereum", "Base", "Arc"]);
    const spec = apiV1SpecFor(servedChains("chain_ethereum,chain_base,chain_arc"));
    for (const [chain, chainId] of [["ethereum", 1], ["base", 8453], ["arc", 5042]] as const) {
      const answer = await body(await get(`/api/v1/agents/${chain}/${idOf[chain]}`));
      expect(answer.source).toMatchObject({ chain, chain_id: chainId, registry: CHAIN_OF[chain].protocol, registry_address: CHAIN_OF[chain].identityRegistry });
      expect(problems(schemaOf("AgentResponse"), answer, "$", spec), chain).toEqual([]);
    }
  });

  it("is one document, whatever order the switches were written in", () => {
    expect(apiV1SpecFor(servedChains("chain_arc,chain_base,chain_ethereum"))).toBe(apiV1SpecFor(servedChains("chain_ethereum,chain_base,chain_arc")));
  });

  it("looks up a batch across the chains for a caller with a key", async () => {
    await start("chain_ethereum,chain_base,chain_arc");
    const response = await post("/api/v1/agents/batch", { agents: EXTRA_CHAINS.map(chain => ({ chain, id: idOf[chain] })) });
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(answer.data.results.map((item: { chain: string; status: number }) => [item.chain, item.status])).toEqual([["ethereum", 200], ["base", 200], ["arc", 200]]);
  });
});

describe("the stats", () => {
  type Row = { chain: string; registries: Array<{ registry: string; address: string | null; acknowledged: number }>; [field: string]: unknown };
  const rowsOf = (answer: Record<string, any>) => Object.fromEntries((answer.data.chains as Row[]).map(row => [row.chain, row])) as Record<string, Row>;
  const chainsOf = (answer: Record<string, any>) => (answer.data.chains as Row[]).map(row => row.chain);

  it("count the three chains and none of the extra ones while every switch is off, though the read holds them, and name no extra chain", async () => {
    await start(undefined);
    const answer = await body(await get("/api/v1/stats"));
    expect(answer.source).toEqual({ kind: "directory_stats", chains: ORIGINAL });
    expect(chainsOf(answer)).toEqual(ORIGINAL);
    expect(answer.data.totals).toEqual({ acknowledged: 300 + 100 + 200 });
    expect(problems(schemaOf("StatsResponse"), answer)).toEqual([]);
    expect(JSON.stringify(answer)).not.toMatch(/ethereum|\bbase\b|\barc\b/i);
    // The part of the document that describes the stats names none either, so it is the same document as before the switches.
    const described = JSON.stringify([API_V1_SPEC.paths["/api/v1/stats"], API_V1_SPEC.components.schemas.StatsChain, API_V1_SPEC.components.schemas.StatsResponse]);
    expect(described).not.toMatch(/ethereum|\bbase\b|\barc\b/i);
  });

  it("add a chain that is on after the three, with its chain id, its registry and the registrations the registry holds, in the shape the served document describes", async () => {
    await start("chain_base");
    const answer = await body(await get("/api/v1/stats"));
    expect(answer.source).toEqual({ kind: "directory_stats", chains: [...ORIGINAL, "base"] });
    expect(chainsOf(answer)).toEqual([...ORIGINAL, "base"]);
    expect(rowsOf(answer).base).toEqual({
      chain: "base",
      label: "Base",
      chain_id: 8453,
      indexed: true,
      acknowledged: 2000,
      ratings_recorded: 14,
      registrations_on_chain: 100_000,
      new_in_24h: 9,
      registries: [{ registry: "erc8004_base", address: BASE_CHAIN.identityRegistry, acknowledged: 2000 }],
      last_read_at: "2026-10-20T02:40:00.000Z",
    });
    expect(answer.data.totals).toEqual({ acknowledged: 300 + 100 + 200 + 2000 });
    expect(problems(schemaOf("StatsResponse"), answer, "$", apiV1SpecFor(servedChains("chain_base")))).toEqual([]);
    // The document before the switch does not name the chain, so the answer would not fit it.
    expect(problems(schemaOf("StatsResponse"), answer).length).toBeGreaterThan(0);
  });

  it("count all six chains in the order the index gives them while every switch is on, each extra chain with its own chain id and registry", async () => {
    await start("chain_ethereum,chain_base,chain_arc");
    const answer = await body(await get("/api/v1/stats"));
    expect(chainsOf(answer)).toEqual([...ORIGINAL, "ethereum", "base", "arc"]);
    expect(answer.data.totals).toEqual({ acknowledged: 300 + 100 + 200 + 1000 + 2000 + 3000 });
    for (const [chain, chainId] of [["ethereum", 1], ["base", 8453], ["arc", 5042]] as const) {
      const row = rowsOf(answer)[chain]!;
      expect(row, chain).toMatchObject({ chain_id: chainId });
      expect(row.registries, chain).toEqual([{ registry: CHAIN_OF[chain].protocol, address: CHAIN_OF[chain].identityRegistry, acknowledged: row.acknowledged }]);
    }
    // The registrations of a registry come from its own count, and BNB Chain keeps the count of its registry read; Robinhood Chain and Solana have none.
    expect(Object.values(rowsOf(answer)).map(row => row.registrations_on_chain)).toEqual([null, 5000, null, 50_000, 100_000, 150_000]);
    expect(Object.values(rowsOf(answer)).map(row => row.new_in_24h)).toEqual([5, 7, 6, 8, 9, 10]);
    expect(problems(schemaOf("StatsResponse"), answer, "$", apiV1SpecFor(servedChains("chain_ethereum,chain_base,chain_arc")))).toEqual([]);
  });

  it("name a chain that is on in the lists of chains in the served document, and only that one", async () => {
    await start("chain_base");
    const spec = await body(await get("/api/v1/openapi.json"));
    expect(spec.components.schemas.StatsChain.properties.chain.enum).toEqual([...ORIGINAL, "base"]);
    expect(spec.components.schemas.StatsResponse.properties.source.properties.chains.items.enum).toEqual([...ORIGINAL, "base"]);
    expect(API_V1_SPEC.components.schemas.StatsChain.properties.chain.enum).toEqual(ORIGINAL);
    expect(API_V1_SPEC.components.schemas.StatsResponse.properties.source.properties.chains.items.enum).toEqual(ORIGINAL);
  });

  it("say what the counts are and are not in the same words whatever the switches", async () => {
    for (const features of [undefined, "chain_ethereum,chain_base,chain_arc"]) {
      await start(features);
      expect((await body(await get("/api/v1/stats"))).data.statement, String(features)).toBe(STATS_STATEMENT);
    }
  });
});

describe("the watchlist and the webhook", () => {
  it("cover each chain the API serves: both files ask which chains are served, and name an agent among them", () => {
    for (const file of ["apiWebhooks.ts", "webhookPass.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source, file).toContain("servedChains");
      expect(source, file).toMatch(/apiChainOfProtocol\([^)]*,/);
      // The three chains that need no switch are not a list of their own here any more.
      expect(source, file).not.toContain("CHAIN_KEYS");
    }
  });
});
