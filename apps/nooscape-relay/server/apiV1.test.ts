import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKED_TITLE, NOT_CHECKED_TITLE } from "../client/src/lib/registrationReadText";
import { OWNER_TEXT_NOTE } from "../client/src/lib/claimFlow";
import {
  ACKNOWLEDGED_STATEMENT,
  agentIdOfKey,
  API_CHAINS,
  API_LICENSE,
  API_V1_RATE_LIMIT,
  apiChainOfProtocol,
  apiV1Router,
  BATCH_MAX,
  BNB_CHECKED_LABEL,
  BNB_NOT_CHECKED_LABEL,
  endpointOf,
  OWNER_TEXT_STATEMENT,
  registerApiV1,
  type ApiV1Deps,
  type ClaimHistoryRead,
  type ClaimStateRead,
  type KeyAccess,
} from "./apiV1";
import { API_TIERS, ApiKeyError, BAD_KEY_PER_MINUTE, KEY_ADDRESS_PER_MINUTE, type ApiKeyRecord, type UsageReport } from "./apiKeys";
import { AGENT_ID_MAX_CHARS } from "./apiChains";
import { STATS_STATEMENT, type StatsRead } from "./apiStats";
import { API_V1_SPEC } from "./apiV1Spec";
import { problems, schemaOf } from "./apiV1Testing";
import { resetRateLimits } from "./rateLimit";

/**
 * The REST API on a real port with its data injected (docs/data-access-2026-10-19.md): every answer is checked against the OpenAPI
 * document the API serves, the document's paths against the router's, and the rules the spec sets (read only, no verdict words,
 * owner text always the owner's word, nothing served that the data layer did not give) against what comes back.
 */

// ---------------------------------------------------------------- fixtures

const WALLET = "0x14791697260e4c9a71f18484c9f997b308e59325";
const ROBINHOOD_KEY = `eip155:4663:${API_CHAINS.robinhood.registry}:7`;
const BNB_KEY = `eip155:56:${API_CHAINS.bnb.registry}:9`;
const SOLANA_KEY = "7Yw6u4v9kQ3pZ2r8s5t1x6c4b3n2m1k9j8h7g6f5d4e3";

const entry = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    displayName: "Alice Agent",
    locatorHost: "alice.example",
    protocol: "erc8004",
    sourceSignalNote: "Registered in the ERC-8004 identity registry.",
    registrant: WALLET,
    feedbackCount: 2,
    firstSeenAt: new Date("2026-10-01T00:00:00Z"),
    lastSeenAt: new Date("2026-10-18T12:00:00Z"),
    related: { sameWallet: 3, sameName: 0, sameHost: 1 },
    activity: { mintBlock: 123, secondaryTransferCount: 0, handoutCount: 0, uriUpdateCount: 1, events: [] },
    twin: null,
    ratings: { measuredThroughBlock: 500, totalEvents: 4, ratingCount: 3, activeRatingCount: 2, revokedCount: 1, responseCount: 0, events: [] },
    ...overrides,
  }) as never;

const claimState = (claim: ClaimStateRead["claim"]): ClaimStateRead => ({ available: true, claimable: true, claim });
const owner = (status: "active" | "frozen", profile: Partial<NonNullable<ClaimStateRead["claim"]>["profile"]> = {}) => ({
  status,
  wallet: WALLET,
  claimedAt: new Date("2026-10-18T20:00:00Z"),
  lastOwnerCheckAt: new Date("2026-10-18T21:00:00Z"),
  profile: { name: "Alice's name", website: "https://alice.example/", description: "Does research.", links: ["https://github.com/alice"], ...profile },
});

const NOW = new Date("2026-10-19T03:00:00Z");

/** What the site's chain tabs read at 02:58 UTC: three chains, each with the figures its tab shows, and one that measures no ratings. */
const STATS_READ: StatsRead = {
  readAt: "2026-10-19T02:58:00.000Z",
  chains: [
    { chain: "robinhood", indexed: true, acknowledged: 19883, reviewed: 18, feedbackEvents: 641, registries: [{ protocol: "erc8004", count: 19883 }], asOf: "2026-10-19T02:30:00.000Z" },
    {
      chain: "solana",
      indexed: true,
      acknowledged: 17576,
      reviewed: 7,
      feedbackEvents: 17546,
      registries: [
        { protocol: "solana_said", count: 14214 },
        { protocol: "solana_registry", count: 1591 },
        { protocol: "solana_8004", count: 1515 },
        { protocol: "solana_agenc", count: 256 },
      ],
      asOf: "2026-10-19T02:30:00.000Z",
    },
    { chain: "bnb", indexed: true, acknowledged: 6924, reviewed: 0, feedbackEvents: null, registries: [{ protocol: "erc8004_bsc", count: 6924 }], asOf: "2026-10-19T02:45:00.000Z" },
  ],
  extras: [],
  arrivals: {
    windowHours: 24,
    computedAt: "2026-10-19T02:47:00.000Z",
    chains: [
      { chain: "robinhood", indexed: true, added: 88, newest: [], registries: [] },
      { chain: "solana", indexed: true, added: 309, newest: [], registries: [] },
      { chain: "bnb", indexed: true, added: 88, newest: [], registries: [] },
    ],
  },
  bnbRegistrations: 392502,
};

const MIDNIGHT = new Date("2026-10-20T00:00:00Z");
const keyText = (letter: string) => `nsk_${letter.repeat(40)}`;
const KEY_FREE = keyText("a");
const KEY_PRO = keyText("b");

/** Keys held in memory: who each is, what each has used today, and every request counted, so a test can say what was counted. */
function fakeKeys(known: Record<string, ApiKeyRecord> = { [KEY_FREE]: { id: "key-free", tier: "free", prefix: "nsk_aaaaaa" }, [KEY_PRO]: { id: "key-pro", tier: "pro", prefix: "nsk_bbbbbb" } }) {
  const used = new Map<string, number>();
  const consumed: Array<{ keyId: string; endpoint: string }> = [];
  // Every key the server read from the database, once each: the real cache holds what it read (an unknown key too) for the next request.
  const reads: string[] = [];
  const access: KeyAccess = {
    resolve: async raw => {
      if (!reads.includes(raw)) reads.push(raw);
      return known[raw] ?? null;
    },
    isCached: raw => reads.includes(raw),
    consume: async (keyId, perDay, endpoint) => {
      const before = used.get(keyId) ?? 0;
      if (before >= perDay) return { allowed: false, limit: perDay, used: before, remaining: 0, resetsAt: MIDNIGHT };
      used.set(keyId, before + 1);
      consumed.push({ keyId, endpoint });
      return { allowed: true, limit: perDay, used: before + 1, remaining: perDay - before - 1, resetsAt: MIDNIGHT };
    },
    usage: async (record): Promise<UsageReport> => {
      const total = used.get(record.id) ?? 0;
      const limit = API_TIERS[record.tier].perDay;
      return {
        today: { date: "2026-10-19", used: total, remaining: limit - total, limit, resetsAt: MIDNIGHT },
        days: [
          { date: "2026-10-19", total, endpoints: { agent: total } },
          { date: "2026-10-18", total: 5, endpoints: { search: 5 } },
        ],
      };
    },
  };
  return { access, used, consumed, reads };
}

const historyItem = (overrides: Partial<ClaimHistoryRead["items"][number]> = {}): ClaimHistoryRead["items"][number] => ({
  seq: 1,
  kind: "claim",
  field: null,
  oldValue: null,
  newValue: null,
  withheld: false,
  wallet: WALLET,
  signatureDigest: "0f1e2d3c4b5a",
  reason: null,
  occurredAt: new Date("2026-10-18T20:00:00Z"),
  ...overrides,
});

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const post = (path: string, payload: unknown, key: string | null = KEY_FREE) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(key ? bearer(key) : {}) }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });

function deps(overrides: Partial<ApiV1Deps> = {}): ApiV1Deps {
  return {
    now: () => NOW,
    findEntries: async (_protocols, key) => (key === ROBINHOOD_KEY ? [{ id: "11111111-1111-4111-8111-111111111111", protocol: "erc8004", externalKey: key }] : []),
    getEntry: async () => entry(),
    search: async () => ({ entries: [], matchedTotal: 0, matchedTotalCapped: false }) as never,
    keysOf: async () => new Map(),
    // The claim read worked and found no claim. A read that failed answers null, and a test says so.
    claimOf: async () => claimState(null),
    claimHistory: async () => null,
    checkFacts: async () => ({ activityThroughBlock: null, solana: null }),
    stats: async () => STATS_READ,
    keys: fakeKeys().access,
    ...overrides,
  };
}

let server: Server | null = null;
let base = "";

async function start(current: ApiV1Deps) {
  await stop();
  const app = express();
  registerApiV1(app, current);
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

const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
const body = async (response: Response) => (await response.json()) as Record<string, any>;

beforeEach(() => resetRateLimits());
afterAll(stop);

// ---------------------------------------------------------------- the document and the router

describe("the document the API serves", () => {
  beforeAll(() => start(deps()));

  it("describes exactly the routes the router has, each with the methods the document gives it, and only the watchlist and webhook write", () => {
    type Layer = { route?: { path: unknown; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } };
    const routesIn = (stack: Layer[]): Array<{ path: string; methods: string[] }> =>
      stack.flatMap(layer => {
        if (layer.route) return typeof layer.route.path === "string" ? [{ path: layer.route.path, methods: Object.keys(layer.route.methods).filter(name => layer.route!.methods[name] && name !== "_all") }] : [];
        return layer.handle?.stack ? routesIn(layer.handle.stack) : [];
      });
    const found: Record<string, string[]> = {};
    for (const route of routesIn(apiV1Router(deps()).stack as Layer[])) {
      if (route.methods.length === 0) continue;
      const path = `/api/v1${route.path === "/" ? "" : route.path}`.replace(":chain", "{chain}").replace(":id", "{id}").replace(":entry", "{nooscape_id}");
      found[path] = [...(found[path] ?? []), ...route.methods].sort();
    }
    const documented = Object.fromEntries(Object.entries(API_V1_SPEC.paths).map(([path, item]) => [path, Object.keys(item).sort()]));
    expect(found).toEqual(documented);
    // The batch lookup and the check read from a body and write nothing. The watchlist and the webhook write the key's own, and nothing else does.
    const notReads = Object.keys(found).filter(path => found[path]!.some(method => method !== "get"));
    expect(notReads.sort()).toEqual(["/api/v1/agents/batch", "/api/v1/check", "/api/v1/watches", "/api/v1/watches/{nooscape_id}", "/api/v1/webhook", "/api/v1/webhook/rotate-secret"]);
  });

  it("lists in the index only routes the document describes, each with a method the document gives it, and lists the stats among them", async () => {
    const index = await body(await get("/api/v1"));
    const paths = API_V1_SPEC.paths as Record<string, Record<string, unknown>>;
    for (const endpoint of index.endpoints as Array<{ method: string; path: string }>) {
      expect(paths[endpoint.path], endpoint.path).toBeDefined();
      expect(Object.keys(paths[endpoint.path]!), endpoint.path).toContain(endpoint.method.toLowerCase());
    }
    expect((index.endpoints as Array<{ method: string; path: string }>).map(endpoint => `${endpoint.method} ${endpoint.path}`)).toContain("GET /api/v1/stats");
  });

  it("is served at /api/v1/openapi.json, as OpenAPI 3.1, and is what the test checks against", async () => {
    const response = await get("/api/v1/openapi.json");
    expect(response.status).toBe(200);
    const spec = await body(response);
    expect(spec.openapi).toBe("3.1.0");
    expect(spec).toEqual(JSON.parse(JSON.stringify(API_V1_SPEC)));
    expect(spec.info.description).toContain("payment never changes a record");
  });

  it("answers its index in the shape it describes, with the limit it enforces", async () => {
    const answer = await body(await get("/api/v1"));
    expect(problems(schemaOf("IndexResponse"), answer)).toEqual([]);
    expect(answer.rate_limit.requests).toBe(API_V1_RATE_LIMIT.requests);
    expect(answer.chains.map((chain: { chain: string }) => chain.chain)).toEqual(["robinhood", "bnb", "solana"]);
    expect(answer.license).toEqual(API_LICENSE);
    expect(answer.keys.tiers).toEqual((["free", "builder", "pro"] as const).map(tier => ({ tier, per_minute: API_TIERS[tier].perMinute, per_day: API_TIERS[tier].perDay })));
  });

  it("keeps its labels the same as the words the site's pages use", () => {
    expect(BNB_CHECKED_LABEL).toBe(CHECKED_TITLE);
    expect(BNB_NOT_CHECKED_LABEL).toBe(NOT_CHECKED_TITLE);
    expect(OWNER_TEXT_STATEMENT).toBe(OWNER_TEXT_NOTE);
  });
});

// ---------------------------------------------------------------- one agent

describe("GET /api/v1/agents/{chain}/{id}", () => {
  it("answers one agent in the shape the document describes, dated by when it was last seen, from where it was read", async () => {
    await start(deps());
    const response = await get("/api/v1/agents/robinhood/7");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const answer = await body(response);
    expect(problems(schemaOf("AgentResponse"), answer)).toEqual([]);
    expect(answer.as_of).toBe("2026-10-18T12:00:00.000Z");
    expect(answer.source).toMatchObject({ kind: "registry", chain: "robinhood", chain_id: 4663, registry: "erc8004", registry_address: API_CHAINS.robinhood.registry, key: ROBINHOOD_KEY, mint_block: 123 });
    expect(answer.license).toEqual(API_LICENSE);
    expect(answer.data).toMatchObject({ chain: "robinhood", agent_id: "7", registry: "erc8004", name: "Alice Agent", registrant: WALLET, locator_host: "alice.example", page_url: "https://nooscape.si/agents/11111111-1111-4111-8111-111111111111" });
    expect(answer.data.related).toEqual({ same_wallet: 3, same_name: 0, same_host: 1 });
    expect(answer.data.ratings).toMatchObject({ rating_count: 3, revoked_count: 1, measured_through_block: 500 });
    expect(answer.data.claim).toBeNull();
  });

  it("says every agent is acknowledged and never reviewed, has no tier, and gives no verdict", async () => {
    await start(deps({ claimOf: async () => claimState(owner("active")) }));
    const answer = await body(await get("/api/v1/agents/robinhood/7"));
    expect(answer.data.evidence).toEqual({ layer: "acknowledged", level: null, label: null, read_at: null, statement: ACKNOWLEDGED_STATEMENT });
    const text = JSON.stringify(answer)
      .replace(ACKNOWLEDGED_STATEMENT, "")
      .replace(OWNER_TEXT_STATEMENT, "");
    expect(text).not.toMatch(/\b(tier_\d|safe|unsafe|trusted|trustworthy|certified|endorsed|rank|score|grade|rating_score)\b/i);
    expect(Object.keys(answer.data)).not.toEqual(expect.arrayContaining(["tier", "score", "verdict", "rank"]));
  });

  it("gives a BNB entry its registration read as 'Checked, unproven' with its date, or 'Not checked'", async () => {
    const bnb = (registrationRead: unknown) => ({
      ...deps(),
      findEntries: async (_p: readonly string[], key: string) => (key === BNB_KEY ? [{ id: "22222222-2222-4222-8222-222222222222", protocol: "erc8004_bsc", externalKey: key }] : []),
      getEntry: async () => entry({ id: "22222222-2222-4222-8222-222222222222", protocol: "erc8004_bsc", ratings: null, activity: null, registrationRead }),
    });
    await start(bnb({ checked: true, readAt: new Date("2026-10-18T01:20:00Z") }));
    let answer = await body(await get("/api/v1/agents/bnb/9"));
    expect(problems(schemaOf("AgentResponse"), answer)).toEqual([]);
    expect(answer.source).toMatchObject({ chain: "bnb", chain_id: 56, registry: "erc8004_bsc" });
    expect(answer.data.evidence).toMatchObject({ level: "checked_unproven", label: "Checked, unproven", read_at: "2026-10-18T01:20:00.000Z" });
    await start(bnb({ checked: false, readAt: null }));
    answer = await body(await get("/api/v1/agents/bnb/9"));
    expect(answer.data.evidence).toMatchObject({ level: "not_checked", label: "Not checked", read_at: null });
  });

  it("shows owner text only as the owner's word, only for a claim in force, and none while it is on hold", async () => {
    await start(deps({ claimOf: async () => claimState(owner("active")) }));
    let answer = await body(await get("/api/v1/agents/robinhood/7"));
    expect(problems(schemaOf("AgentResponse"), answer)).toEqual([]);
    expect(answer.data.claim).toMatchObject({ status: "active", wallet: WALLET, claimed_at: "2026-10-18T20:00:00.000Z" });
    expect(answer.data.claim.owner_text).toEqual({ statement: OWNER_TEXT_STATEMENT, name: "Alice's name", website: "https://alice.example/", description: "Does research.", links: ["https://github.com/alice"] });
    // The record beside it is untouched by the claim.
    expect(answer.data.name).toBe("Alice Agent");
    expect(answer.data.evidence.layer).toBe("acknowledged");

    await start(deps({ claimOf: async () => claimState(owner("frozen", { name: null, website: null, description: null, links: [] })) }));
    answer = await body(await get("/api/v1/agents/robinhood/7"));
    expect(answer.data.claim).toMatchObject({ status: "on_hold", owner_text: null });
    expect(JSON.stringify(answer)).not.toContain("Alice's name");

    await start(deps({ claimOf: async () => claimState(owner("active", { name: null, website: null, description: null, links: [] })) }));
    answer = await body(await get("/api/v1/agents/robinhood/7"));
    expect(answer.data.claim.owner_text).toBeNull();

    // The hold is held here as well as where the claim is read: text that arrives with a claim on hold is not shown.
    await start(deps({ claimOf: async () => claimState(owner("frozen")) }));
    answer = await body(await get("/api/v1/agents/robinhood/7"));
    expect(answer.data.claim).toMatchObject({ status: "on_hold", owner_text: null });
    expect(JSON.stringify(answer)).not.toContain("Alice's name");

    // A claim that cannot be read does not take the record down with it, and the answer is not kept for the minute a whole one is.
    await start(deps());
    expect((await get("/api/v1/agents/robinhood/7")).headers.get("cache-control")).toBe("private, max-age=60");
    await start(deps({ claimOf: async () => null }));
    const withoutClaim = await get("/api/v1/agents/robinhood/7");
    expect(withoutClaim.status).toBe(200);
    expect(withoutClaim.headers.get("cache-control")).toBe("no-store");
    expect((await body(withoutClaim)).data.claim).toBeNull();
  });

  it("answers 404 for an id nothing lists, and for an entry the data layer does not give, the same words either way", async () => {
    await start(deps({ getEntry: async () => null }));
    const unlisted = await get("/api/v1/agents/robinhood/99999");
    const hidden = await get("/api/v1/agents/robinhood/7");
    expect([unlisted.status, hidden.status]).toEqual([404, 404]);
    expect(await body(unlisted)).toEqual(await body(hidden));
    expect(unlisted.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a chain, an id or an option it does not know, with the reason", async () => {
    await start(deps());
    for (const [path, message] of [
      ["/api/v1/agents/ethereum/7", "chain must be one of"],
      ["/api/v1/agents/robinhood/seven", "digits only"],
      ["/api/v1/agents/robinhood/07", "digits only"],
      ["/api/v1/agents/solana/short", "Solana address"],
      ["/api/v1/agents/robinhood/7?registry=solana_said", "registry applies to solana only"],
      ["/api/v1/agents/robinhood/7?tier=1", "the only option is registry"],
    ] as const) {
      const response = await get(path);
      expect(response.status, path).toBe(400);
      const answer = await body(response);
      expect(problems(schemaOf("Error"), answer), path).toEqual([]);
      expect(answer.error.code).toBe("bad_request");
      expect(answer.error.message, path).toContain(message);
    }
  });

  it("answers 409 when more than one Solana registry lists an address, names them, and takes registry= to choose", async () => {
    const both = [
      { id: "33333333-3333-4333-8333-333333333333", protocol: "solana_said", externalKey: SOLANA_KEY },
      { id: "44444444-4444-4444-8444-444444444444", protocol: "solana_8004", externalKey: SOLANA_KEY },
    ];
    const seen: string[][] = [];
    await start(
      deps({
        findEntries: async (protocols, key) => {
          seen.push([...protocols]);
          return both.filter(match => key === SOLANA_KEY && protocols.includes(match.protocol));
        },
        getEntry: async id => entry({ id, protocol: both.find(match => match.id === id)!.protocol, registrant: null, locatorHost: null, ratings: null, activity: null }),
      })
    );
    const ambiguous = await get(`/api/v1/agents/solana/${SOLANA_KEY}`);
    expect(ambiguous.status).toBe(409);
    const answer = await body(ambiguous);
    expect(problems(schemaOf("Error"), answer)).toEqual([]);
    expect(answer.error).toMatchObject({ code: "ambiguous", registries: ["solana_8004", "solana_said"] });
    const chosen = await get(`/api/v1/agents/solana/${SOLANA_KEY}?registry=solana_said`);
    expect(chosen.status).toBe(200);
    const one = await body(chosen);
    expect(problems(schemaOf("AgentResponse"), one)).toEqual([]);
    expect(one.data).toMatchObject({ chain: "solana", agent_id: SOLANA_KEY, registry: "solana_said" });
    expect(one.source).toMatchObject({ chain_id: null, registry_address: null });
    expect(seen[1]).toEqual(["solana_said"]);
  });

  it("looks up an AgenC agent by its own account on the Solana chain, names the registry, and takes registry= to narrow to it", async () => {
    const AGENC_KEY = "AgEnCpda".padEnd(44, "x");
    const seen: string[][] = [];
    await start(
      deps({
        findEntries: async (protocols, key) => {
          seen.push([...protocols]);
          return key === AGENC_KEY && protocols.includes("solana_agenc") ? [{ id: "55555555-5555-4555-8555-555555555555", protocol: "solana_agenc", externalKey: AGENC_KEY }] : [];
        },
        getEntry: async id => entry({ id, protocol: "solana_agenc", registrant: null, locatorHost: null, ratings: null, activity: null }),
      })
    );
    const found = await get(`/api/v1/agents/solana/${AGENC_KEY}`);
    expect(found.status).toBe(200);
    const one = await body(found);
    expect(problems(schemaOf("AgentResponse"), one)).toEqual([]);
    expect(one.data).toMatchObject({ chain: "solana", agent_id: AGENC_KEY, registry: "solana_agenc" });
    expect(seen[0]).toEqual(["solana_8004", "solana_said", "solana_registry", "solana_agenc"]);
    const narrowed = await get(`/api/v1/agents/solana/${AGENC_KEY}?registry=solana_agenc`);
    expect(narrowed.status).toBe(200);
    expect(seen[1]).toEqual(["solana_agenc"]);
  });
});

// ---------------------------------------------------------------- search

describe("GET /api/v1/agents/search", () => {
  const row = (id: string, protocol: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    displayName: name,
    locatorHost: "alice.example",
    protocol,
    sourceSignalNote: null,
    registrant: WALLET,
    feedbackCount: null,
    firstSeenAt: new Date("2026-10-01T00:00:00Z"),
    lastSeenAt: new Date("2026-10-18T12:00:00Z"),
    related: { sameWallet: 0, sameName: 0, sameHost: 0 },
    ...extra,
  });

  it("answers a page of summaries, newest first as the search gave them, each with the path of its own answer", async () => {
    const calls: Array<{ query: string; limit: number; protocols?: readonly string[] }> = [];
    await start(
      deps({
        search: async input => {
          calls.push(input);
          return { entries: [row("a", "erc8004", "Alice"), row("b", "solana_said", "Bob", { registrant: null })], matchedTotal: 2, matchedTotalCapped: false } as never;
        },
        keysOf: async () => new Map([["a", ROBINHOOD_KEY], ["b", SOLANA_KEY]]),
      })
    );
    const response = await get("/api/v1/agents/search?q=alice");
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(problems(schemaOf("SearchResponse"), answer)).toEqual([]);
    expect(answer.as_of).toBe(NOW.toISOString());
    expect(answer.source).toEqual({ kind: "directory_search", chains: ["robinhood", "bnb", "solana"], registries: ["erc8004", "erc8004_bsc", "solana_8004", "solana_said", "solana_registry", "solana_agenc"] });
    expect(answer.data.matched_total).toBe(2);
    expect(answer.data.results.map((result: { agent_id: string }) => result.agent_id)).toEqual(["7", SOLANA_KEY]);
    expect(answer.data.results[0].links).toEqual({ agent: "/api/v1/agents/robinhood/7", page: "https://nooscape.si/agents/a" });
    expect(answer.data.query).toEqual({ q: "alice", owner: null, host: null, chain: null, limit: 10 });
    expect(calls).toEqual([{ query: "alice", limit: 10, protocols: ["erc8004", "erc8004_bsc", "solana_8004", "solana_said", "solana_registry", "solana_agenc"] }]);
  });

  it("limits a search to a chain's registries and takes owner and host as exact filters over the page", async () => {
    const calls: Array<{ query: string; protocols?: readonly string[] }> = [];
    await start(
      deps({
        search: async input => {
          calls.push(input);
          return {
            entries: [row("a", "erc8004", "Alice"), row("c", "erc8004", "Carol", { registrant: "0x1111111111111111111111111111111111111111", locatorHost: "alice.example.evil.test" })],
            matchedTotal: 2,
            matchedTotalCapped: false,
          } as never;
        },
        keysOf: async () => new Map([["a", ROBINHOOD_KEY], ["c", `eip155:4663:${API_CHAINS.robinhood.registry}:8`]]),
      })
    );
    const byOwner = await body(await get(`/api/v1/agents/search?owner=${WALLET.toUpperCase().replace("0X", "0x")}&chain=robinhood&limit=5`));
    expect(problems(schemaOf("SearchResponse"), byOwner)).toEqual([]);
    expect(byOwner.data.results.map((result: { agent_id: string }) => result.agent_id)).toEqual(["7"]);
    expect(byOwner.data).toMatchObject({ matched_total: 1, matched_total_capped: false });
    expect(calls[0]).toMatchObject({ protocols: ["erc8004"] });
    const byHost = await body(await get("/api/v1/agents/search?host=Alice.Example"));
    expect(byHost.data.results.map((result: { agent_id: string }) => result.agent_id)).toEqual(["7"]);
    expect(byHost.data.query.host).toBe("alice.example");
  });

  it("says 'at least' when a filter narrowed a full page, and skips an entry it cannot address", async () => {
    await start(
      deps({
        search: async () => ({ entries: [row("a", "erc8004", "Alice"), row("x", "erc8004", "No key")], matchedTotal: 40, matchedTotalCapped: false }) as never,
        keysOf: async () => new Map([["a", ROBINHOOD_KEY]]),
      })
    );
    const answer = await body(await get(`/api/v1/agents/search?owner=${WALLET}&limit=2`));
    expect(answer.data.results).toHaveLength(1);
    expect(answer.data).toMatchObject({ matched_total: 1, matched_total_capped: true });
  });

  it("refuses a search that is not exactly one of q, owner or host, or has a value out of range, or an option it does not know", async () => {
    await start(deps());
    for (const [query, message] of [
      ["", "exactly one of q, owner or host"],
      ["q=alice&owner=" + WALLET, "exactly one of q, owner or host"],
      ["q=a", "q: "],
      ["owner=0x123", "wallet address"],
      ["host=no spaces", "host name"],
      ["q=alice&chain=ethereum", "chain: "],
      ["q=alice&limit=0", "limit: "],
      ["q=alice&limit=26", "limit: "],
      ["q=alice&limit=ten", "limit: "],
      ["q=alice&format=csv", "format"],
      ["q=alice&q=bob", "q: "],
    ] as const) {
      const response = await get(`/api/v1/agents/search?${query}`);
      expect(response.status, query).toBe(400);
      const answer = await body(response);
      expect(problems(schemaOf("Error"), answer), query).toEqual([]);
      expect(answer.error.message.toLowerCase(), query).toContain(message.toLowerCase());
    }
  });

  it("tells a caller the search is busy, with a time to wait, and does not guess an empty answer", async () => {
    await start(deps({ search: async () => ({ entries: [], matchedTotal: 0, matchedTotalCapped: false, busy: true }) as never }));
    const response = await get("/api/v1/agents/search?q=alice");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("10");
    expect((await body(response)).error.code).toBe("unavailable");
  });
});

// ---------------------------------------------------------------- the rules of the surface

describe("GET /api/v1/stats", () => {
  type Row = { chain: string; registries: Array<{ registry: string; address: string | null; acknowledged: number }>; [field: string]: unknown };
  const rowsOf = (answer: Record<string, any>) => Object.fromEntries((answer.data.chains as Row[]).map(row => [row.chain, row])) as Record<string, Row>;

  it("answers what the directory holds on each chain, in the shape the document describes, dated by when the figures were read", async () => {
    await start(deps());
    const response = await get("/api/v1/stats");
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(problems(schemaOf("StatsResponse"), answer)).toEqual([]);
    expect(answer.as_of).toBe(STATS_READ.readAt);
    expect(answer.source).toEqual({ kind: "directory_stats", chains: ["robinhood", "bnb", "solana"] });
    expect(answer.license).toEqual(API_LICENSE);
    expect(answer.data.statement).toBe(STATS_STATEMENT);
    // The chains come in the order the index gives them, and the total adds up the entries listed on them.
    expect((answer.data.chains as Row[]).map(row => row.chain)).toEqual(["robinhood", "bnb", "solana"]);
    expect(answer.data.totals).toEqual({ acknowledged: 19883 + 6924 + 17576 });
  });

  it("gives each chain the figures its tab on the site gives it, and null where a figure is not measured and never zero", async () => {
    await start(deps());
    const rows = rowsOf(await body(await get("/api/v1/stats")));
    expect(rows.robinhood).toEqual({
      chain: "robinhood",
      label: "Robinhood Chain",
      chain_id: 4663,
      indexed: true,
      acknowledged: 19883,
      ratings_recorded: 641,
      registrations_on_chain: null,
      new_in_24h: 88,
      registries: [{ registry: "erc8004", address: API_CHAINS.robinhood.registry, acknowledged: 19883 }],
      last_read_at: "2026-10-19T02:30:00.000Z",
    });
    // BNB Chain counts the registrations its registry holds apart from the entries it lists, and counts no ratings.
    expect(rows.bnb).toMatchObject({ chain_id: 56, acknowledged: 6924, ratings_recorded: null, registrations_on_chain: 392502, new_in_24h: 88 });
    // Solana has no chain id, no one registry contract and four registries, largest first.
    expect(rows.solana).toMatchObject({ chain_id: null, acknowledged: 17576, ratings_recorded: 17546, registrations_on_chain: null, new_in_24h: 309 });
    expect(rows.solana!.registries).toEqual([
      { registry: "solana_said", address: null, acknowledged: 14214 },
      { registry: "solana_registry", address: null, acknowledged: 1591 },
      { registry: "solana_8004", address: null, acknowledged: 1515 },
      { registry: "solana_agenc", address: null, acknowledged: 256 },
    ]);
  });

  it("leaves a figure that could not be read null, and does not turn it into a zero", async () => {
    await start(deps({ stats: async () => ({ ...STATS_READ, arrivals: null, bnbRegistrations: null }) }));
    const answer = await body(await get("/api/v1/stats"));
    expect(problems(schemaOf("StatsResponse"), answer)).toEqual([]);
    for (const row of Object.values(rowsOf(answer))) expect(row.new_in_24h, row.chain).toBeNull();
    expect(rowsOf(answer).bnb!.registrations_on_chain).toBeNull();
    // What was read is unaffected.
    expect(answer.data.totals.acknowledged).toBe(19883 + 6924 + 17576);
  });

  it("reports a chain that is not read as not indexed, with no counts, and adds nothing to the total", async () => {
    const gone = (row: (typeof STATS_READ.chains)[number]) => (row.chain === "bnb" ? { ...row, indexed: false, acknowledged: null, feedbackEvents: null, registries: [], asOf: null } : row);
    await start(
      deps({
        stats: async () => ({
          ...STATS_READ,
          chains: STATS_READ.chains.map(gone),
          arrivals: { ...STATS_READ.arrivals!, chains: STATS_READ.arrivals!.chains.map(row => (row.chain === "bnb" ? { ...row, indexed: false, added: null } : row)) },
        }),
      })
    );
    const answer = await body(await get("/api/v1/stats"));
    expect(problems(schemaOf("StatsResponse"), answer)).toEqual([]);
    expect(rowsOf(answer).bnb).toMatchObject({ indexed: false, acknowledged: null, ratings_recorded: null, new_in_24h: null, registries: [], last_read_at: null });
    expect(answer.data.totals.acknowledged).toBe(19883 + 17576);
  });

  it("takes no option: a query string is refused before the figures are read, so it cannot be used to ask for them again", async () => {
    let reads = 0;
    await start(
      deps({
        stats: async () => {
          reads += 1;
          return STATS_READ;
        },
      })
    );
    const refused = await get("/api/v1/stats?refresh=1");
    expect(refused.status).toBe(400);
    expect((await body(refused)).error.code).toBe("bad_request");
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(reads).toBe(0);
    expect((await get("/api/v1/stats")).status).toBe(200);
    expect(reads).toBe(1);
  });

  it("needs no key, answers the same to a free key and a pro key, counts a keyed request under its own name, and is private to the caller for a minute", async () => {
    const keys = fakeKeys();
    await start(deps({ keys: keys.access }));
    const anonymous = await get("/api/v1/stats");
    expect(anonymous.headers.get("cache-control")).toBe("private, max-age=60");
    expect(anonymous.headers.get("vary")).toContain("Authorization");
    const expected = await body(anonymous);
    const free = await get("/api/v1/stats", { headers: bearer(KEY_FREE) });
    expect(free.headers.get("cache-control")).toBe("private, max-age=60");
    expect(await body(free)).toEqual(expected);
    expect(await body(await get("/api/v1/stats", { headers: bearer(KEY_PRO) }))).toEqual(expected);
    expect(keys.consumed.map(item => item.endpoint)).toEqual(["stats", "stats"]);
  });

  it("says only that the figures could not be read when they cannot, keeps the cause out of the answer, and tells the caller when to try again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await start(
        deps({
          stats: async () => {
            throw new Error("select `acknowledged` from `agent_directory_entries` where `protocol` = ?\nparams: erc8004_secret");
          },
        })
      );
      const response = await get("/api/v1/stats");
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("30");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await response.json())).not.toMatch(/select|agent_directory_entries|params|secret/i);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![1])).not.toContain("secret");
    } finally {
      warn.mockRestore();
    }
  });

  it("states what the counts are and are not, and has no verdict, score or ranking in any word or field name", async () => {
    await start(deps());
    const answer = await body(await get("/api/v1/stats"));
    const names = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(names) : value && typeof value === "object" ? Object.entries(value).flatMap(([key, inner]) => [key, ...names(inner)]) : []);
    for (const word of ["tier", "score", "verdict", "rank", "ranking"]) expect(names(answer), word).not.toContain(word);
    expect(JSON.stringify(answer).replace(STATS_STATEMENT, "")).not.toMatch(/\b(safe|unsafe|trusted|trustworthy|certified|endorsed|secure|score|rank|ranking|verdict)\b/i);
    expect(STATS_STATEMENT).toContain("not a count of the agents that exist or work");
    expect(STATS_STATEMENT).not.toMatch(/[\u2013\u2014]/);
  });

  it("requires every field the document declares for the stats, so a caller can rely on all of them", () => {
    const { StatsChain, StatsResponse } = API_V1_SPEC.components.schemas;
    for (const schema of [StatsChain, StatsResponse, StatsResponse.properties.data, StatsResponse.properties.data.properties.totals, StatsResponse.properties.source, StatsChain.properties.registries.items]) {
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
      expect(schema.additionalProperties).toBe(false);
    }
  });
});

describe("the surface", () => {
  it("is read only: another method is refused with 405 and what is allowed, and a path it does not have is a JSON 404", async () => {
    await start(deps());
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await get("/api/v1/agents/robinhood/7", { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
      expect((await body(response)).error.code).toBe("method_not_allowed");
    }
    const missing = await get("/api/v1/nothing/here");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
    expect((await body(missing)).error.code).toBe("not_found");
    expect((await get("/api/v1/agents/robinhood/7", { method: "HEAD" })).status).toBe(200);
  });

  it("may be read from another site: a preflight is answered and counts against nothing, and answers carry the open headers", async () => {
    await start(deps());
    for (let index = 0; index < API_V1_RATE_LIMIT.requests + 5; index += 1) {
      const preflight = await get("/api/v1/agents/robinhood/7", { method: "OPTIONS", headers: { origin: "https://example.org", "access-control-request-method": "GET" } });
      expect(preflight.status).toBe(204);
    }
    const response = await get("/api/v1/agents/robinhood/7", { headers: { origin: "https://example.org" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, HEAD, POST, PUT, DELETE, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe("Content-Type, Authorization, PAYMENT-SIGNATURE");
    expect(response.headers.get("access-control-expose-headers")).toContain("PAYMENT-RESPONSE");
    expect(response.headers.get("vary")).toContain("Authorization");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
  });

  it("allows 30 requests a minute from one address, then says 429 with Retry-After, and writes what the Privacy page says it writes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await start(deps());
      let last: Response | null = null;
      for (let index = 0; index < API_V1_RATE_LIMIT.requests; index += 1) {
        last = await get("/api/v1/agents/robinhood/7");
        expect(last.status, `request ${index + 1}`).toBe(200);
      }
      expect(last!.headers.get("x-ratelimit-limit")).toBe("30");
      expect(last!.headers.get("x-ratelimit-remaining")).toBe("0");
      const refused = await get("/api/v1/agents/robinhood/7");
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      const answer = await body(refused);
      expect(problems(schemaOf("Error"), answer)).toEqual([]);
      expect(answer.error.code).toBe("rate_limited");
      expect(warn.mock.calls.map(call => String(call[0])).some(line => /^\[RateLimit\] api-v1 limit reached for .+ \(retry in \d+s\)$/.test(line))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("says only that a read failed when the data layer throws, keeps the cause out of the answer, and tells the caller when to try again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await start(
        deps({
          findEntries: async () => {
            throw new Error("select `externalKey` from `agent_directory_entries` where `externalKey` = ?\nparams: eip155:4663:secret");
          },
        })
      );
      const response = await get("/api/v1/agents/robinhood/7");
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("30");
      const text = JSON.stringify(await response.json());
      expect(text).not.toMatch(/select|agent_directory_entries|params|secret/i);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![1])).not.toContain("secret");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the chains", () => {
  it("maps each registry to one chain, and an id back from the key it is stored under", () => {
    expect(apiChainOfProtocol("erc8004")).toBe("robinhood");
    expect(apiChainOfProtocol("erc8004_bsc")).toBe("bnb");
    for (const protocol of ["solana_8004", "solana_said", "solana_registry", "solana_agenc"]) expect(apiChainOfProtocol(protocol)).toBe("solana");
    for (const protocol of ["a2a", "catalog", "census", "erc8004_reputation", "usdg_settlement"]) expect(apiChainOfProtocol(protocol), protocol).toBeNull();
    expect(agentIdOfKey("robinhood", ROBINHOOD_KEY)).toBe("7");
    expect(agentIdOfKey("bnb", BNB_KEY)).toBe("9");
    expect(agentIdOfKey("solana", SOLANA_KEY)).toBe(SOLANA_KEY);
    expect(API_CHAINS.robinhood.keyOf("7")).toBe(ROBINHOOD_KEY);
    expect(API_CHAINS.bnb.keyOf("9")).toBe(BNB_KEY);
  });
});

describe("what the API is held to at the source", () => {
  const server = fileURLToPath(new URL(".", import.meta.url));
  const app = join(server, "..");
  const read = (path: string) => readFileSync(path, "utf8");
  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap(item => {
      const path = join(directory, item.name);
      if (item.isDirectory()) return item.name === "node_modules" ? [] : sourceFiles(path);
      return /\.(ts|tsx)$/.test(item.name) && !/\.test\.tsx?$/.test(item.name) ? [path] : [];
    });
  const files = [...sourceFiles(server), ...sourceFiles(join(app, "client", "src")), ...sourceFiles(join(app, "shared"))].map(path => ({ file: relative(app, path).replaceAll("\\", "/"), text: read(path) }));
  const api = read(join(server, "apiV1.ts"));

  it("reads the record and writes nothing itself: its two POSTs are the batch lookup and the check, which read from a body, and the one place that writes is the watchlist file", () => {
    expect(api.match(/router\.(post|put|patch|delete|all)\(/g)).toEqual(["router.post(", "router.post("]);
    expect(api).toContain('router.post("/agents/batch"');
    expect(api).toContain('router.post("/check"');
    expect(api).not.toMatch(/\.(insert|update|delete)\(/);
    expect(api).not.toMatch(/(INSERT INTO|UPDATE [a-z_]+ SET|DELETE FROM)/);
    expect(api).toContain("webhookRoutes(");
    const webhooks = read(join(server, "apiWebhooks.ts"));
    // The routes are `router.delete(` and the queue is a Map (`tails.delete(`); a write to a table would be `db.delete(`, and it goes through the store, which is the only file that has one.
    expect(webhooks).not.toMatch(/(?<!router|tails)\.(insert|update|delete)\(/);
    expect(webhooks).not.toMatch(/(INSERT INTO|UPDATE [a-z_]+ SET|DELETE FROM)/);
  });

  it("reaches the claim code only through the public procedure, so the guard on who imports it still holds", () => {
    expect(api).not.toMatch(/from "\.\/claims/);
    expect(api).toContain(".claim.state({ entryId })");
    expect(api).toContain(".claim.history({ entryId })");
  });

  it("is mounted once, before the tRPC limiter and the body parsers, and nothing that serves a request imports the schema checker", () => {
    const index = read(join(server, "_core", "index.ts"));
    expect(index.indexOf("registerApiV1(app);")).toBeGreaterThan(index.indexOf("registerApiCachePolicy(app);"));
    expect(index.indexOf("registerApiV1(app);")).toBeLessThan(index.indexOf('app.use("/api/trpc"'));
    expect(index.match(/registerApiV1\(app\)/g)).toHaveLength(1);
    const importers = files.filter(({ text }) => /from "\.\/apiV1Testing"|from "\.\.\/apiV1Testing"/.test(text)).map(({ file }) => file);
    expect(importers).toEqual([]);
  });

  it("says the same limit in the code, the document and the developer page", () => {
    expect(API_V1_RATE_LIMIT).toEqual({ requests: 30, windowMs: 60_000 });
    expect(API_V1_SPEC.info.description).toContain("30 requests a minute");
    const page = read(join(app, "client", "src", "pages", "DeveloperApi.tsx"));
    expect(page).toContain("30 requests a minute");
    expect(page).toContain("/api/v1/agents/{chain}/{id}");
    expect(page).toContain("/api/v1/agents/search");
    expect(page).toContain("/api/v1/stats");
    // The stats are kept for the time the document says, and the page says it too.
    expect(JSON.stringify(API_V1_SPEC.paths["/api/v1/stats"])).toContain("up to five minutes");
    expect(page).toContain("up to five minutes");
  });

  it("lets a shared cache hold nothing about an agent: only the index and the document, which hold no per-caller state, are public", () => {
    const publics = api.match(/"public, max-age=\d+"/g) ?? [];
    expect(publics).toEqual(['"public, max-age=300"', '"public, max-age=300"']);
    expect(api).toMatch(/const cacheable = \(res: Response\) => res\.set\("Cache-Control", "private, max-age=60"\);/);
  });

  it("gives no verdict word anywhere in the document it serves, apart from the sentences that say what a record does not mean or that it gives no verdict", () => {
    const text = JSON.stringify(API_V1_SPEC).replace(ACKNOWLEDGED_STATEMENT, "").replace("nothing here says an agent is safe or unsafe", "");
    expect(text).not.toMatch(/\b(safe|unsafe|trusted|trustworthy|certified|endorsed|secure)\b/i);
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

// ---------------------------------------------------------------- keys

describe("a key", () => {
  it("raises the limit to the tier's, says which tier and how much of the day is left, and leaves the public limit untouched", async () => {
    const keys = fakeKeys();
    await start(deps({ keys: keys.access }));
    let last: Response | null = null;
    for (let index = 0; index < API_TIERS.free.perMinute; index += 1) {
      last = await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_FREE) });
      expect(last.status, `request ${index + 1}`).toBe(200);
    }
    expect(last!.headers.get("x-ratelimit-limit")).toBe("60");
    expect(last!.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(last!.headers.get("x-api-tier")).toBe("free");
    expect(last!.headers.get("x-quota-limit")).toBe("1000");
    expect(last!.headers.get("x-quota-remaining")).toBe("940");
    expect(last!.headers.get("x-quota-reset")).toBe(MIDNIGHT.toISOString());
    expect(problems(schemaOf("AgentResponse"), await body(last!))).toEqual([]);
    const refused = await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_FREE) });
    expect(refused.status).toBe(429);
    expect((await body(refused)).error.code).toBe("rate_limited");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // The refused request was not counted against the day, and a caller with no key still has all of its own 30.
    expect(keys.used.get("key-free")).toBe(60);
    expect((await get("/api/v1/agents/robinhood/7")).status).toBe(200);
  });

  it("stops a key at its day's total with 429 quota_exceeded and the seconds until 00:00 UTC, and does not count the refused request", async () => {
    const keys = fakeKeys();
    keys.used.set("key-free", API_TIERS.free.perDay - 1);
    await start(deps({ keys: keys.access }));
    const last = await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_FREE) });
    expect(last.status).toBe(200);
    expect(last.headers.get("x-quota-remaining")).toBe("0");
    const refused = await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_FREE) });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(refused.headers.get("retry-after")).toBe(String(21 * 60 * 60));
    const answer = await body(refused);
    expect(problems(schemaOf("Error"), answer)).toEqual([]);
    expect(answer.error.code).toBe("quota_exceeded");
    expect(keys.used.get("key-free")).toBe(API_TIERS.free.perDay);
    // The public tier is a different allowance: the same caller with no key is still served.
    expect((await get("/api/v1/agents/robinhood/7")).status).toBe(200);
  });

  it("refuses a key that is wrong with 401 and does not fall back to the public limit, and stops a run of guesses from one address", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await start(deps());
      for (const header of ["Bearer", "Bearer short", `Bearer ${keyText("z")}`, `Basic ${KEY_FREE}`, `bearer ${KEY_FREE}`, "", `Bearer ${KEY_FREE} extra`]) {
        const response = await get("/api/v1/agents/robinhood/7", { headers: { authorization: header } });
        expect(response.status, JSON.stringify(header)).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const answer = await body(response);
        expect(problems(schemaOf("Error"), answer)).toEqual([]);
        expect(answer.error.code).toBe("invalid_key");
        expect(JSON.stringify(answer)).not.toContain(KEY_FREE);
      }
      let status = 0;
      for (let index = 0; index < 20; index += 1) status = (await get("/api/v1/agents/robinhood/7", { headers: bearer(keyText("y")) })).status;
      expect(status).toBe(429);
      expect(warn.mock.calls.map(call => String(call[0])).some(line => /^\[RateLimit\] api-v1-badkey limit reached for .+ \(retry in \d+s\)$/.test(line))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("turns an address away before it reads a key that is not held, once the address has used up its wrong guesses, and still serves a key in use", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const keys = fakeKeys();
      await start(deps({ keys: keys.access }));
      // A key in use is read once and held.
      expect((await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_PRO) })).status).toBe(200);
      for (let index = 0; index < BAD_KEY_PER_MINUTE; index += 1) {
        expect((await get("/api/v1/agents/robinhood/7", { headers: bearer(`nsk_${String(index).padStart(40, "m")}`) })).status).toBe(401);
      }
      const readsBefore = keys.reads.length;
      // The next made-up key, and a real key the server does not hold, are refused without a read; a key it holds is served.
      const guess = await get("/api/v1/agents/robinhood/7", { headers: bearer(`nsk_${"n".repeat(40)}`) });
      const heldOut = await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_FREE) });
      expect([guess.status, heldOut.status]).toEqual([429, 429]);
      expect((await body(heldOut)).error.code).toBe("rate_limited");
      expect(Number(heldOut.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(keys.reads).toHaveLength(readsBefore);
      expect((await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_PRO) })).status).toBe(200);
      expect(keys.reads).toHaveLength(readsBefore);
    } finally {
      warn.mockRestore();
    }
  });

  it("caps what one address can do with keys at 300 a minute, so keys held by one machine do not multiply its allowance", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const letters = ["c", "d", "e", "f", "g", "h"];
      const known = Object.fromEntries(letters.map(letter => [keyText(letter), { id: `key-${letter}`, tier: "free", prefix: `nsk_${letter.repeat(6)}` } as ApiKeyRecord]));
      await start(deps({ keys: fakeKeys(known).access }));
      for (let index = 0; index < KEY_ADDRESS_PER_MINUTE; index += 1) {
        const response = await get("/api/v1/agents/robinhood/7", { headers: bearer(keyText(letters[index % 5]!)) });
        expect(response.status, `request ${index + 1}`).toBe(200);
      }
      const refused = await get("/api/v1/agents/robinhood/7", { headers: bearer(keyText("h")) });
      expect(refused.status).toBe(429);
      expect((await body(refused)).error.code).toBe("rate_limited");
      expect(warn.mock.calls.map(call => String(call[0])).some(line => /^\[RateLimit\] api-v1-key-ip limit reached for .+ \(retry in \d+s\)$/.test(line))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it("never changes what is served: the same agent, search and index answer the same to no key, a free key and a pro key", async () => {
    const claim = claimState(owner("active"));
    await start(deps({ claimOf: async () => claim, search: async () => ({ entries: [entry()], matchedTotal: 1, matchedTotalCapped: false }) as never, keysOf: async () => new Map([["11111111-1111-4111-8111-111111111111", ROBINHOOD_KEY]]) }));
    for (const path of ["/api/v1/agents/robinhood/7", "/api/v1/agents/search?q=alice"]) {
      const anonymous = await body(await get(path));
      const free = await body(await get(path, { headers: bearer(KEY_FREE) }));
      const pro = await body(await get(path, { headers: bearer(KEY_PRO) }));
      expect(free, path).toEqual(anonymous);
      expect(pro, path).toEqual(anonymous);
    }
  });

  it("caches an answer privately whether or not the request carries a key, and varies on the key", async () => {
    await start(deps());
    const anonymous = await get("/api/v1/agents/robinhood/7");
    const keyed = await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_FREE) });
    expect(anonymous.headers.get("cache-control")).toBe("private, max-age=60");
    expect(keyed.headers.get("cache-control")).toBe("private, max-age=60");
    // The same holds for a search, and for an answer that says an agent was not found or a key was wrong.
    expect((await get("/api/v1/agents/search?q=alice")).headers.get("cache-control")).toBe("private, max-age=60");
    expect((await get("/api/v1/agents/robinhood/8")).headers.get("cache-control")).toBe("no-store");
    expect((await get("/api/v1/agents/robinhood/7", { headers: bearer(keyText("z")) })).headers.get("cache-control")).toBe("no-store");
    expect(anonymous.headers.get("vary")).toContain("Authorization");
    expect(keyed.headers.get("vary")).toContain("Authorization");
  });

  it("answers 503 with a time to wait when the keys cannot be read, keeps the cause out of it, and leaves the public tier alone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failing = fakeKeys().access;
      await start(deps({ keys: { ...failing, resolve: async () => Promise.reject(new ApiKeyError("UNAVAILABLE")) } }));
      const unavailable = await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_FREE) });
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("retry-after")).toBe("60");
      expect((await body(unavailable)).error.code).toBe("unavailable");
      expect((await get("/api/v1/agents/robinhood/7")).status).toBe(200);

      await start(deps({ keys: { ...failing, consume: async () => { throw new Error("insert into `api_usage` values (?)\nparams: key-free"); } } }));
      const broken = await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_FREE) });
      expect(broken.status).toBe(503);
      expect(JSON.stringify(await broken.json())).not.toMatch(/insert|api_usage|params|key-free/i);
    } finally {
      warn.mockRestore();
    }
  });

  it("names the endpoint a request is counted under", () => {
    expect(endpointOf("/")).toBe("index");
    expect(endpointOf("/openapi.json")).toBe("openapi");
    expect(endpointOf("/usage")).toBe("usage");
    expect(endpointOf("/agents/search")).toBe("search");
    expect(endpointOf("/stats")).toBe("stats");
    expect(endpointOf("/agents/batch")).toBe("batch");
    expect(endpointOf("/agents/robinhood/7")).toBe("agent");
    expect(endpointOf("/agents/robinhood/7/history")).toBe("history");
    expect(endpointOf("/nothing")).toBe("other");
  });
});

describe("GET /api/v1/usage", () => {
  it("needs a key, and tells the key what it has used in the shape the document describes", async () => {
    const keys = fakeKeys();
    await start(deps({ keys: keys.access }));
    const without = await get("/api/v1/usage");
    expect(without.status).toBe(401);
    expect((await body(without)).error.code).toBe("key_required");

    await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_FREE) });
    const response = await get("/api/v1/usage", { headers: bearer(KEY_FREE) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const answer = await body(response);
    expect(problems(schemaOf("UsageResponse"), answer)).toEqual([]);
    expect(answer.data.key).toEqual({ prefix: "nsk_aaaaaa", tier: "free" });
    expect(answer.data.limits).toEqual({ per_minute: API_TIERS.free.perMinute, per_day: API_TIERS.free.perDay });
    expect(answer.data.today.limit).toBe(1000);
    expect(answer.data.days[1]).toEqual({ date: "2026-10-18", total: 5, by_endpoint: { search: 5 } });
    expect(JSON.stringify(answer)).not.toContain(KEY_FREE);
    // The call to read the usage is itself a counted request.
    expect(keys.consumed.map(item => item.endpoint)).toEqual(["agent", "usage"]);
  });
});

describe("POST /api/v1/agents/batch", () => {
  const SECOND = "22222222-2222-4222-8222-222222222222";

  it("needs a key and takes only POST", async () => {
    await start(deps());
    const without = await post("/api/v1/agents/batch", { agents: [{ chain: "robinhood", id: "7" }] }, null);
    expect(without.status).toBe(401);
    expect((await body(without)).error.code).toBe("key_required");
    const put = await get("/api/v1/agents/batch", { method: "PUT", headers: bearer(KEY_FREE) });
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("POST, OPTIONS");
    expect((await get("/api/v1/agents/batch", { headers: bearer(KEY_FREE) })).status).toBe(405);
  });

  it("answers each agent on its own, in the order asked, with the status its own lookup would have had, and counts once", async () => {
    const keys = fakeKeys();
    await start(
      deps({
        keys: keys.access,
        findEntries: async (_protocols, key) => {
          if (key === ROBINHOOD_KEY) return [{ id: "11111111-1111-4111-8111-111111111111", protocol: "erc8004", externalKey: key }];
          if (key === SOLANA_KEY) return [{ id: "a", protocol: "solana_8004", externalKey: key }, { id: "b", protocol: "solana_said", externalKey: key }];
          return [];
        },
      })
    );
    const response = await post("/api/v1/agents/batch", {
      agents: [
        { chain: "robinhood", id: "7" },
        { chain: "robinhood", id: "8" },
        { chain: "nowhere", id: "1" },
        { chain: "robinhood", id: "abc" },
        { chain: "solana", id: SOLANA_KEY },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const answer = await body(response);
    expect(problems(schemaOf("BatchResponse"), answer)).toEqual([]);
    const results = answer.data.results as Array<Record<string, any>>;
    expect(results.map(item => item.status)).toEqual([200, 404, 400, 400, 409]);
    expect(results[0]!.agent.name).toBe("Alice Agent");
    expect(results[0]!.error).toBeNull();
    for (const item of results.slice(1)) {
      expect(item.agent, item.id).toBeNull();
      expect(item.source, item.id).toBeNull();
      expect(item.error.message.length, item.id).toBeGreaterThan(0);
    }
    expect(results[4]!.error.registries).toEqual(["solana_8004", "solana_said"]);
    expect(answer.source).toEqual({ kind: "batch", requested: 5 });
    expect(keys.consumed).toEqual([{ keyId: "key-free", endpoint: "batch" }]);
  });

  it("gives a batch agent the same single answer the lookup gives, and not an owner's text while the claim is on hold", async () => {
    await start(deps({ claimOf: async () => claimState(owner("frozen")) }));
    const single = await body(await get("/api/v1/agents/robinhood/7", { headers: bearer(KEY_FREE) }));
    const batch = await body(await post("/api/v1/agents/batch", { agents: [{ chain: "robinhood", id: "7" }] }));
    const item = batch.data.results[0];
    expect(item.agent).toEqual(single.data);
    expect(item.source).toEqual(single.source);
    expect(item.agent.claim.status).toBe("on_hold");
    expect(item.agent.claim.owner_text).toBeNull();
    expect(JSON.stringify(batch)).not.toContain("Does research");
  });

  it("serves an entry the data layer did not give as one that is not listed, with no data", async () => {
    await start(deps({ getEntry: async () => null }));
    const answer = await body(await post("/api/v1/agents/batch", { agents: [{ chain: "robinhood", id: "7" }] }));
    expect(answer.data.results[0]).toMatchObject({ status: 404, agent: null, source: null });
  });

  it("refuses a body that is not up to 25 agents with the reason, and a body that is not JSON, or too large", async () => {
    await start(deps());
    const tooMany = await post("/api/v1/agents/batch", { agents: Array.from({ length: BATCH_MAX + 1 }, () => ({ chain: "robinhood", id: "7" })) });
    expect(tooMany.status).toBe(400);
    expect((await body(tooMany)).error.message).toContain("agents");
    expect((await post("/api/v1/agents/batch", { agents: Array.from({ length: BATCH_MAX }, () => ({ chain: "robinhood", id: "7" })) })).status).toBe(200);
    // The longest id the pattern allows (78 digits) is taken and not found; one past the cap shared with the check and the watchlist is a malformed body.
    const longest = await post("/api/v1/agents/batch", { agents: [{ chain: "robinhood", id: "9".repeat(78) }] });
    expect(longest.status).toBe(200);
    expect((await body(longest)).data.results[0].status).toBe(404);
    expect((await post("/api/v1/agents/batch", { agents: [{ chain: "robinhood", id: "9".repeat(AGENT_ID_MAX_CHARS + 1) }] })).status).toBe(400);
    for (const payload of [{ agents: [] }, {}, { agents: [{ chain: "robinhood" }] }, { agents: [{ chain: "robinhood", id: "7", price: 1 }] }, { agents: [{ chain: "robinhood", id: "7" }], tier: "pro" }, { agents: "robinhood" }]) {
      const response = await post("/api/v1/agents/batch", payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      const answer = await body(response);
      expect(problems(schemaOf("Error"), answer)).toEqual([]);
      expect(answer.error.code).toBe("bad_request");
    }
    const notJson = await post("/api/v1/agents/batch", "{ not json");
    expect(notJson.status).toBe(400);
    expect((await body(notJson)).error.message).toContain("JSON");
    const noType = await fetch(`${base}/api/v1/agents/batch`, { method: "POST", headers: { ...bearer(KEY_FREE), "content-type": "text/plain" }, body: "agents" });
    expect(noType.status).toBe(400);
    const large = await post("/api/v1/agents/batch", JSON.stringify({ agents: [{ chain: "robinhood", id: "7" }], pad: "x".repeat(20_000) }));
    expect(large.status).toBe(413);
    expect((await body(large)).error.code).toBe("bad_request");
  });
});

describe("GET /api/v1/agents/{chain}/{id}/history", () => {
  const withEvents = (count: number) =>
    entry({
      activity: {
        mintBlock: 100,
        secondaryTransferCount: count - 1,
        handoutCount: 0,
        uriUpdateCount: 0,
        events: Array.from({ length: count }, (_value, index) => ({
          kind: index === 0 ? "mint" : "secondary",
          blockNumber: 100 + index,
          transactionHash: `0x${String(index).padStart(64, "0")}`,
          logIndex: index,
          fromAddress: index === 0 ? null : WALLET,
          toAddress: "0x00000000000000000000000000000000000000aa",
          isHandout: false,
        })),
      },
    });

  it("needs a key", async () => {
    await start(deps());
    const response = await get("/api/v1/agents/robinhood/7/history");
    expect(response.status).toBe(401);
    expect((await body(response)).error.code).toBe("key_required");
  });

  it("gives the registry events and the public history of the claims in the shape the document describes", async () => {
    const items = [historyItem({ seq: 1, kind: "claim" }), historyItem({ seq: 2, kind: "edit", field: "name", oldValue: null, newValue: "Alice's name", occurredAt: new Date("2026-10-18T21:00:00Z") })];
    await start(deps({ getEntry: async () => withEvents(3), claimHistory: async () => ({ available: true, claimable: true, truncated: false, items }) }));
    const response = await get("/api/v1/agents/robinhood/7/history", { headers: bearer(KEY_FREE) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    const answer = await body(response);
    expect(problems(schemaOf("HistoryResponse"), answer)).toEqual([]);
    expect(answer.data.registry_events).toHaveLength(3);
    expect(answer.data.registry_events[0]).toMatchObject({ kind: "mint", block_number: 100, from: null, is_handout: false });
    expect(answer.data.registry_events_truncated).toBe(false);
    expect(answer.data.claim_history.items.map((item: { seq: number }) => item.seq)).toEqual([1, 2]);
    expect(answer.data.claim_history.items[1]).toMatchObject({ kind: "edit", field: "name", new_value: "Alice's name", withheld: false });
    expect(answer.as_of).toBe("2026-10-18T12:00:00.000Z");
  });

  it("says when there may be more events than it returns, and gives text that is withheld as withheld, with no text", async () => {
    const held = historyItem({ seq: 2, kind: "edit", field: "description", oldValue: null, newValue: null, withheld: true });
    await start(deps({ getEntry: async () => withEvents(24), claimHistory: async () => ({ available: true, claimable: true, truncated: true, items: [held] }) }));
    const answer = await body(await get("/api/v1/agents/robinhood/7/history", { headers: bearer(KEY_FREE) }));
    expect(problems(schemaOf("HistoryResponse"), answer)).toEqual([]);
    expect(answer.data.registry_events_truncated).toBe(true);
    expect(answer.data.claim_history.truncated).toBe(true);
    expect(answer.data.claim_history.items[0]).toMatchObject({ withheld: true, old_value: null, new_value: null });
  });

  it("answers an agent with no events and no claims, and one the claim history cannot be read for, without guessing", async () => {
    await start(deps({ getEntry: async () => entry({ activity: null }), claimHistory: async () => null }));
    const answer = await body(await get("/api/v1/agents/robinhood/7/history", { headers: bearer(KEY_FREE) }));
    expect(problems(schemaOf("HistoryResponse"), answer)).toEqual([]);
    expect(answer.data.registry_events).toEqual([]);
    expect(answer.data.claim_history).toEqual({ available: false, truncated: false, items: [] });
  });

  it("is the same agent as the plain lookup: what the data layer does not give, or an id it does not know, is a 404, and a bad id a 400", async () => {
    await start(deps());
    const missing = await get("/api/v1/agents/robinhood/8/history", { headers: bearer(KEY_FREE) });
    expect(missing.status).toBe(404);
    expect((await get("/api/v1/agents/robinhood/abc/history", { headers: bearer(KEY_FREE) })).status).toBe(400);
    await start(deps({ getEntry: async () => null }));
    const gone = await get("/api/v1/agents/robinhood/7/history", { headers: bearer(KEY_FREE) });
    expect(gone.status).toBe(404);
    expect(JSON.stringify(await gone.json())).not.toContain("Alice");
  });
});

afterEach(() => vi.restoreAllMocks());
