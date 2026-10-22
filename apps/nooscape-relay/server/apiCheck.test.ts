import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ACKNOWLEDGED_STATEMENT, API_CHAINS, registerApiV1, type ApiV1Deps } from "./apiV1";
import { checkFlags, CHECK_RESULT_LIMIT, CHECK_STATEMENT, FIRST_SEEN_WITHIN_DAYS, hostOfUrl, REGISTRY_EVENT_LIST_LIMIT, type CheckFlagsInput } from "./apiCheck";
import { problems, schemaOf } from "./apiV1Check";
import { API_TIERS, type ApiKeyRecord } from "./apiKeys";
import { CHAIN_BLOCKS_PER_DAY } from "./db";
import { resetRateLimits } from "./rateLimit";

/**
 * The pre-flight check (docs/data-access-2026-10-19.md, stage D3), on a real port with its data injected. The access rules (a Pro key,
 * nothing before it is read), the three subjects, each flag at its edges, and the rules that hold whatever is asked: facts only, no
 * verdict, nothing a hidden record could add, and the same answer for every key.
 */

const NOW = new Date("2026-10-19T03:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const WALLET = "0x14791697260e4c9a71f18484c9f997b308e59325";
const SOLANA_WALLET = "5Gh8j2k4m6n9p3q5r7s9t2v4w6x8y3z5a7b9c2d4e6f8";
const ROBINHOOD_KEY = `eip155:4663:${API_CHAINS.robinhood.registry}:7`;
const ID = "11111111-1111-4111-8111-111111111111";

const keyText = (letter: string) => `nsk_${letter.repeat(40)}`;
const KEY_FREE = keyText("a");
const KEY_BUILDER = keyText("c");
const KEY_PRO = keyText("b");
const KEY_PRO_TWO = keyText("d");
const records: Record<string, ApiKeyRecord> = {
  [KEY_FREE]: { id: "k-free", tier: "free", prefix: "nsk_aaaaaa" },
  [KEY_BUILDER]: { id: "k-builder", tier: "builder", prefix: "nsk_cccccc" },
  [KEY_PRO]: { id: "k-pro", tier: "pro", prefix: "nsk_bbbbbb" },
  [KEY_PRO_TWO]: { id: "k-pro-two", tier: "pro", prefix: "nsk_dddddd" },
};
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

let counted: Array<{ keyId: string; endpoint: string }> = [];
const keys: ApiV1Deps["keys"] = {
  resolve: async raw => records[raw] ?? null,
  consume: async (keyId, perDay, endpoint) => {
    counted.push({ keyId, endpoint });
    return { allowed: true, limit: perDay, used: counted.length, remaining: perDay - counted.length, resetsAt: new Date("2026-10-20T00:00:00Z") };
  },
  usage: async record => ({ today: { date: "2026-10-19", used: 0, remaining: API_TIERS[record.tier].perDay, limit: API_TIERS[record.tier].perDay, resetsAt: new Date("2026-10-20T00:00:00Z") }, days: [] }),
};

type EntryOverrides = Record<string, unknown>;
const entry = (overrides: EntryOverrides = {}) =>
  ({
    id: ID,
    displayName: "Alice Agent",
    locatorHost: "alice.example",
    protocol: "erc8004",
    sourceSignalNote: "Registered in the ERC-8004 identity registry.",
    registrant: WALLET,
    feedbackCount: 2,
    firstSeenAt: new Date(NOW.getTime() - 10 * DAY),
    lastSeenAt: new Date("2026-10-18T12:00:00Z"),
    related: { sameWallet: 0, sameName: 0, sameHost: 0 },
    activity: { mintBlock: 100, secondaryTransferCount: 0, handoutCount: 0, uriUpdateCount: 0, events: [] },
    twin: null,
    ratings: { measuredThroughBlock: 500, totalEvents: 0, ratingCount: 0, activeRatingCount: 0, revokedCount: 0, responseCount: 0, events: [] },
    ...overrides,
  }) as never;

function deps(overrides: Partial<ApiV1Deps> = {}): ApiV1Deps {
  return {
    now: () => NOW,
    findEntries: async (_protocols, key) => (key === ROBINHOOD_KEY ? [{ id: ID, protocol: "erc8004", externalKey: key }] : []),
    getEntry: async () => entry(),
    search: async () => ({ entries: [], matchedTotal: 0, matchedTotalCapped: false }) as never,
    keysOf: async () => new Map(),
    claimOf: async () => null,
    claimHistory: async () => null,
    checkFacts: async () => ({ activityThroughBlock: null, solana: null }),
    keys,
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
const check = (payload: unknown, key: string | null = KEY_PRO) =>
  fetch(`${base}/api/v1/check`, { method: "POST", headers: { "content-type": "application/json", ...(key ? bearer(key) : {}) }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
const body = async (response: Response) => (await response.json()) as Record<string, any>;
const robinhood = { agent: { chain: "robinhood", id: "7" } };

beforeEach(() => {
  resetRateLimits();
  counted = [];
});
afterAll(stop);

// ---------------------------------------------------------------- who may ask

describe("POST /api/v1/check, who may ask", () => {
  it("needs a key, and a Pro one: a free or a Builder key is told the tier that opens it, before its body is read", async () => {
    await start(deps());
    const none = await check(robinhood, null);
    expect(none.status).toBe(401);
    expect((await body(none)).error.code).toBe("key_required");
    for (const key of [KEY_FREE, KEY_BUILDER]) {
      // A body that is not JSON is not looked at: the refusal comes first.
      const refused = await check("{ not json", key);
      expect(refused.status, key).toBe(403);
      const answer = await body(refused);
      expect(problems(schemaOf("Error"), answer)).toEqual([]);
      expect(answer.error).toMatchObject({ code: "tier_required", required_tier: "pro" });
      expect(answer.error.message).toContain("Pro key");
      expect(refused.headers.get("cache-control")).toBe("no-store");
    }
    expect((await check(robinhood, KEY_PRO)).status).toBe(200);
  });

  it("takes only POST", async () => {
    await start(deps());
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await fetch(`${base}/api/v1/check`, { method, headers: bearer(KEY_PRO) });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    }
  });

  it("counts once against the key's day, as the check, and answers every Pro key the same", async () => {
    await start(deps());
    const first = await body(await check(robinhood, KEY_PRO));
    const second = await body(await check(robinhood, KEY_PRO_TWO));
    expect(second).toEqual(first);
    expect(counted).toEqual([
      { keyId: "k-pro", endpoint: "check" },
      { keyId: "k-pro-two", endpoint: "check" },
    ]);
  });
});

// ---------------------------------------------------------------- the request

describe("POST /api/v1/check, the request", () => {
  it("takes exactly one of agent, wallet or url, with chain only for a wallet or a url, and refuses anything else with the reason", async () => {
    await start(deps());
    const cases: Array<[unknown, string]> = [
      [{}, "exactly one of agent, wallet or url"],
      [{ agent: { chain: "robinhood", id: "7" }, wallet: WALLET }, "exactly one of agent, wallet or url"],
      [{ wallet: WALLET, url: "https://alice.example/" }, "exactly one of agent, wallet or url"],
      [{ agent: { chain: "robinhood", id: "7" }, chain: "robinhood" }, "chain narrows a wallet or a url"],
      [{ wallet: "not a wallet" }, "wallet must be a wallet address"],
      [{ wallet: WALLET, chain: "ethereum" }, "chain"],
      [{ agent: { chain: "robinhood", id: "7", price: 1 } }, "agent"],
      [{ agent: { chain: "robinhood", id: "7" }, tier: "pro" }, "tier"],
      [{ url: "x" }, "url"],
      [{ url: "ftp://alice.example/agent" }, "url must be an http or https address with a host"],
      [{ url: "not a url at all" }, "url must be an http or https address with a host"],
      [{ url: "https://user:secret@alice.example/" }, "url must be an http or https address with a host"],
      [{ agent: "robinhood/7" }, "agent"],
    ];
    for (const [payload, message] of cases) {
      const response = await check(payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      const answer = await body(response);
      expect(problems(schemaOf("Error"), answer)).toEqual([]);
      expect(answer.error.code).toBe("bad_request");
      expect(answer.error.message, JSON.stringify(payload)).toContain(message);
    }
    expect((await check("{ not json")).status).toBe(400);
    expect((await check(JSON.stringify({ wallet: WALLET, pad: "x".repeat(5_000) }))).status).toBe(413);
  });

  it("takes the host of an address and nothing else of it, and fetches nothing", () => {
    expect(hostOfUrl("https://Alice.Example:8443/path?q=1#frag")).toBe("alice.example");
    expect(hostOfUrl("http://alice.example./a")).toBe("alice.example");
    expect(hostOfUrl("https://[2001:db8::1]/agent")).toBe("[2001:db8::1]");
    expect(hostOfUrl("https://203.0.113.7/agent")).toBe("203.0.113.7");
    for (const bad of ["", "alice.example", "ftp://alice.example", "javascript:alert(1)", "https://u:p@alice.example", "https://"]) expect(hostOfUrl(bad), bad).toBeNull();
    const source = readFileSync(fileURLToPath(new URL("./apiCheck.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/(^|[^\w.])fetch\(|safeFetch|node:http|node:dns|node:net/);
  });
});

// ---------------------------------------------------------------- an agent

describe("POST /api/v1/check for an agent", () => {
  it("answers in the shape the document describes, with the evidence level, four flags and the sources, dated by when the check ran", async () => {
    await start(deps({ checkFacts: async () => ({ activityThroughBlock: 5_000_000, solana: null }) }));
    const response = await check(robinhood);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const answer = await body(response);
    expect(problems(schemaOf("CheckResponse"), answer)).toEqual([]);
    expect(answer.as_of).toBe(NOW.toISOString());
    expect(answer.source).toEqual({ kind: "check", subject: "agent" });
    expect(answer.data.subject).toEqual({ type: "agent", value: "robinhood/7", host: null });
    expect(answer.data.statement).toBe(CHECK_STATEMENT);
    expect(answer.data.matched_total).toBe(1);
    expect(answer.data.matched_total_capped).toBe(false);
    const [result] = answer.data.results;
    expect(result.agent).toMatchObject({ chain: "robinhood", agent_id: "7", registry: "erc8004", nooscape_id: ID, name: "Alice Agent", registrant: WALLET, locator_host: "alice.example" });
    expect(result.evidence).toEqual({ layer: "acknowledged", level: null, label: null, read_at: null, statement: ACKNOWLEDGED_STATEMENT });
    expect(Object.keys(result.flags)).toEqual(["first_seen", "ownership_changes", "revoked_feedback", "fleet"]);
    expect(result.sources.registry).toMatchObject({ kind: "registry", chain: "robinhood", key: ROBINHOOD_KEY, last_seen_at: "2026-10-18T12:00:00.000Z" });
    expect(result.sources.activity_through_block).toBe(5_000_000);
    expect(result.sources.ratings_measured_through_block).toBe(500);
  });

  it("says a BNB listing's registration read in the site's words, and a Solana address that two registries list needs registry=", async () => {
    const bnbKey = `eip155:56:${API_CHAINS.bnb.registry}:9`;
    await start(deps({ findEntries: async (_p, key) => (key === bnbKey ? [{ id: ID, protocol: "erc8004_bsc", externalKey: key }] : []), getEntry: async () => entry({ protocol: "erc8004_bsc", registrationRead: { checked: true, readAt: new Date("2026-10-17T00:00:00Z") }, ratings: null }) }));
    const answer = await body(await check({ agent: { chain: "bnb", id: "9" } }));
    expect(problems(schemaOf("CheckResponse"), answer)).toEqual([]);
    expect(answer.data.results[0].evidence).toMatchObject({ level: "checked_unproven", label: "Checked, unproven", read_at: "2026-10-17T00:00:00.000Z" });
    expect(answer.data.results[0].sources.registration_read_at).toBe("2026-10-17T00:00:00.000Z");

    const solana = "7Yw6u4v9kQ3pZ2r8s5t1x6c4b3n2m1k9j8h7g6f5d4e3";
    await start(deps({ findEntries: async () => [{ id: "a", protocol: "solana_8004", externalKey: solana }, { id: "b", protocol: "solana_said", externalKey: solana }] }));
    const ambiguous = await check({ agent: { chain: "solana", id: solana } });
    expect(ambiguous.status).toBe(409);
    expect((await body(ambiguous)).error.registries).toEqual(["solana_8004", "solana_said"]);
  });

  it("answers 404 for an agent nothing lists, and for one the data layer does not give, and 400 for a chain or an id it does not know", async () => {
    await start(deps());
    expect((await check({ agent: { chain: "robinhood", id: "8" } })).status).toBe(404);
    expect((await check({ agent: { chain: "nowhere", id: "7" } })).status).toBe(400);
    expect((await check({ agent: { chain: "robinhood", id: "abc" } })).status).toBe(400);
    await start(deps({ getEntry: async () => null }));
    const hidden = await check(robinhood);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(await hidden.json())).not.toContain("Alice");
  });

  it("gives an agent whose ledger facts cannot be read the flags as not measured, and still answers", async () => {
    await start(deps({ checkFacts: async () => null, getEntry: async () => entry({ activity: null }) }));
    const answer = await body(await check(robinhood));
    expect(problems(schemaOf("CheckResponse"), answer)).toEqual([]);
    expect(answer.data.results[0].flags.ownership_changes.present).toBeNull();
    expect(answer.data.results[0].sources.activity_through_block).toBeNull();
  });
});

// ---------------------------------------------------------------- a wallet and an address

describe("POST /api/v1/check for a wallet or an endpoint URL", () => {
  const listed = (id: string, over: EntryOverrides = {}) => entry({ id, displayName: `Agent ${id}`, ...over }) as unknown as { id: string; protocol: string; registrant: string | null; locatorHost: string | null };

  function withListings(entries: Array<ReturnType<typeof listed>>, extra: Partial<ApiV1Deps> = {}) {
    const searches: Array<{ query: string; limit: number; protocols?: readonly string[] }> = [];
    return {
      searches,
      deps: deps({
        search: async input => {
          searches.push(input);
          return { entries, matchedTotal: entries.length, matchedTotalCapped: false } as never;
        },
        keysOf: async ids => new Map(ids.map((id, index) => [id, `eip155:4663:${API_CHAINS.robinhood.registry}:${100 + index}`])),
        getEntry: async id => entries.find(item => item.id === id) as never,
        ...extra,
      }),
    };
  }

  it("answers for the listings a wallet registered exactly, newest first as searched, and drops what only resembles it", async () => {
    const { deps: d, searches } = withListings([listed("one"), listed("two", { registrant: "0x0000000000000000000000000000000000000001" }), listed("three", { registrant: WALLET.toUpperCase().replace("0X", "0x") })]);
    await start(d);
    const response = await check({ wallet: WALLET });
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(problems(schemaOf("CheckResponse"), answer)).toEqual([]);
    expect(answer.source).toEqual({ kind: "check", subject: "wallet" });
    expect(answer.data.subject).toEqual({ type: "wallet", value: WALLET, host: null });
    expect(answer.data.results.map((result: { agent: { nooscape_id: string } }) => result.agent.nooscape_id)).toEqual(["one", "three"]);
    expect(answer.data.matched_total).toBe(2);
    expect(answer.data.matched_total_capped).toBe(false);
    expect(searches).toEqual([{ query: WALLET, limit: CHECK_RESULT_LIMIT, protocols: expect.arrayContaining(["erc8004", "erc8004_bsc", "solana_8004"]) }]);
  });

  it("narrows a wallet to a chain's registries, and says 'at least' when the page was full", async () => {
    const many = Array.from({ length: CHECK_RESULT_LIMIT }, (_value, index) => listed(`n${index}`));
    const { deps: d, searches } = withListings(many);
    await start(d);
    const answer = await body(await check({ wallet: WALLET, chain: "robinhood" }));
    expect(searches[0]!.protocols).toEqual(["erc8004"]);
    expect(answer.data.results).toHaveLength(CHECK_RESULT_LIMIT);
    expect(answer.data.matched_total_capped).toBe(true);
  });

  it("answers an empty list, not a 404, for a wallet or an address that nothing listed registered, and for a Solana wallet", async () => {
    const { deps: d } = withListings([]);
    await start(d);
    for (const payload of [{ wallet: WALLET }, { wallet: SOLANA_WALLET }, { url: "https://nobody.example/agent" }]) {
      const response = await check(payload);
      expect(response.status, JSON.stringify(payload)).toBe(200);
      const answer = await body(response);
      expect(problems(schemaOf("CheckResponse"), answer)).toEqual([]);
      expect(answer.data.results).toEqual([]);
      expect(answer.data.matched_total).toBe(0);
    }
  });

  it("matches an endpoint URL by its host alone, whatever its scheme, port, path or case, and never by a host that only contains it", async () => {
    const { deps: d, searches } = withListings([listed("one"), listed("two", { locatorHost: "alice.example.org" }), listed("three", { locatorHost: "sub.alice.example" })]);
    await start(d);
    const answer = await body(await check({ url: "http://Alice.Example:8080/v1/agent?x=1" }));
    expect(problems(schemaOf("CheckResponse"), answer)).toEqual([]);
    expect(answer.data.subject).toEqual({ type: "url", value: "http://Alice.Example:8080/v1/agent?x=1", host: "alice.example" });
    expect(answer.data.results.map((result: { agent: { nooscape_id: string } }) => result.agent.nooscape_id)).toEqual(["one"]);
    expect(searches[0]!.query).toBe("alice.example");
  });

  it("tells a caller the search is busy, with a time to wait, and does not guess an empty answer", async () => {
    await start(deps({ search: async () => ({ entries: [], matchedTotal: 0, matchedTotalCapped: false, busy: true }) as never }));
    const response = await check({ wallet: WALLET });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("10");
    expect((await body(response)).error.code).toBe("unavailable");
  });

  it("leaves out a listing whose registry key or entry the data layer does not give, so a hidden one adds nothing", async () => {
    const { deps: d } = withListings([listed("one"), listed("two")], { keysOf: async () => new Map([["one", ROBINHOOD_KEY]]) });
    await start(d);
    expect((await body(await check({ wallet: WALLET }))).data.results).toHaveLength(1);
    const { deps: e } = withListings([listed("one")], { getEntry: async () => null });
    await start(e);
    expect((await body(await check({ wallet: WALLET }))).data.results).toEqual([]);
  });
});

// ---------------------------------------------------------------- the flags

describe("the flags", () => {
  const input = (over: { chain?: CheckFlagsInput["chain"]; entry?: Partial<CheckFlagsInput["entry"]>; facts?: Partial<CheckFlagsInput["facts"]> } = {}): CheckFlagsInput => ({
    chain: "robinhood",
    now: NOW,
    entry: { firstSeenAt: new Date(NOW.getTime() - 10 * DAY), related: { sameWallet: 0, sameName: 0, sameHost: 0 }, activity: { secondaryTransferCount: 0, handoutCount: 0, events: [] }, ratings: { measuredThroughBlock: 500, ratingCount: 0, revokedCount: 0 }, ...over.entry },
    facts: { activityThroughBlock: 1_000, solana: null, ...over.facts },
    ...(over.chain ? { chain: over.chain } : {}),
  });

  describe("first seen", () => {
    it("is present for a listing first seen under 30 days ago and not from the 30th day on, and counts whole days", () => {
      const at = (days: number, extra = 0) => checkFlags(input({ entry: { firstSeenAt: new Date(NOW.getTime() - days * DAY - extra) } })).first_seen;
      expect(FIRST_SEEN_WITHIN_DAYS).toBe(30);
      expect(at(0)).toMatchObject({ present: true, days_since_first_seen: 0, threshold_days: 30 });
      expect(at(29, 23 * 60 * 60 * 1000)).toMatchObject({ present: true, days_since_first_seen: 29 });
      expect(at(30)).toMatchObject({ present: false, days_since_first_seen: 30 });
      expect(at(400)).toMatchObject({ present: false, days_since_first_seen: 400 });
      expect(at(5).first_seen_at).toBe(new Date(NOW.getTime() - 5 * DAY).toISOString());
    });

    it("is not measured without a date, never negative for a date in the future, and says it is not the registration date", () => {
      expect(checkFlags(input({ entry: { firstSeenAt: null } })).first_seen).toMatchObject({ present: null, first_seen_at: null, days_since_first_seen: null });
      expect(checkFlags(input({ entry: { firstSeenAt: new Date(NOW.getTime() + 3 * DAY) } })).first_seen.days_since_first_seen).toBe(0);
      expect(checkFlags(input()).first_seen.basis).toContain("It is not when the agent was registered");
    });
  });

  describe("ownership changes, on an EVM registry", () => {
    const event = (kind: string, blockNumber: number, isHandout = false) => ({ kind, blockNumber, isHandout });

    it("counts changes of hands apart from the hand-outs after a mint, gives the latest by block and its distance from the ledger's head, and block days on Robinhood Chain only", () => {
      const activity = { secondaryTransferCount: 4, handoutCount: 1, events: [event("mint", 100), event("secondary", 101, true), event("secondary", 500), event("uri_update", 600), event("secondary", 900), event("secondary", 700)] };
      const robin = checkFlags(input({ entry: { activity }, facts: { activityThroughBlock: 900 + 2 * CHAIN_BLOCKS_PER_DAY } })).ownership_changes;
      expect(robin).toMatchObject({ present: true, changes_recorded: 3, handouts_recorded: 1, latest_change_block: 900, ledger_through_block: 900 + 2 * CHAIN_BLOCKS_PER_DAY, blocks_since_latest_change: 2 * CHAIN_BLOCKS_PER_DAY, block_days_since_latest_change: 2, latest_change_recorded_at: null });
      expect(robin.basis).toContain("864,000 blocks");
      const bnb = checkFlags(input({ chain: "bnb", entry: { activity }, facts: { activityThroughBlock: 5_000 } })).ownership_changes;
      expect(bnb).toMatchObject({ present: true, latest_change_block: 900, blocks_since_latest_change: 4_100, block_days_since_latest_change: null });
      expect(bnb.basis).not.toContain("864,000");
    });

    it("is not present when every transfer was a hand-out, and says so for an agent that never moved", () => {
      const handedOut = checkFlags(input({ entry: { activity: { secondaryTransferCount: 2, handoutCount: 2, events: [event("mint", 10), event("secondary", 11, true), event("secondary", 12, true)] } } })).ownership_changes;
      expect(handedOut).toMatchObject({ present: false, changes_recorded: 0, handouts_recorded: 2, latest_change_block: null, blocks_since_latest_change: null });
      expect(checkFlags(input()).ownership_changes).toMatchObject({ present: false, changes_recorded: 0, handouts_recorded: 0 });
    });

    it("gives no latest block when the agent has more events than the list read for it holds, and still counts the changes", () => {
      const events = Array.from({ length: REGISTRY_EVENT_LIST_LIMIT }, (_value, index) => event(index === 0 ? "mint" : "secondary", 10 + index));
      const flag = checkFlags(input({ entry: { activity: { secondaryTransferCount: 40, handoutCount: 0, events } } })).ownership_changes;
      expect(flag).toMatchObject({ present: true, changes_recorded: 40, latest_change_block: null, blocks_since_latest_change: null });
      expect(flag.basis).toContain("more events than the list read for it holds");
      // With one fewer the list is complete and the latest is given.
      const complete = checkFlags(input({ entry: { activity: { secondaryTransferCount: 22, handoutCount: 0, events: events.slice(0, REGISTRY_EVENT_LIST_LIMIT - 1) } } })).ownership_changes;
      expect(complete.latest_change_block).toBe(10 + REGISTRY_EVENT_LIST_LIMIT - 2);
    });

    it("is not measured when the ledger has not covered the agent, which is not the same as none", () => {
      for (const activity of [null, { secondaryTransferCount: null, handoutCount: null, events: [] }, { secondaryTransferCount: 1, handoutCount: null, events: [] }]) {
        const flag = checkFlags(input({ entry: { activity } })).ownership_changes;
        expect(flag).toMatchObject({ present: null, changes_recorded: null });
        expect(flag.basis).toContain("not the same as none");
      }
    });

    it("gives the ledger's head as null when it is not read, and no distance", () => {
      const flag = checkFlags(input({ entry: { activity: { secondaryTransferCount: 1, handoutCount: 0, events: [event("secondary", 50)] } }, facts: { activityThroughBlock: null } })).ownership_changes;
      expect(flag).toMatchObject({ present: true, latest_change_block: 50, ledger_through_block: null, blocks_since_latest_change: null, block_days_since_latest_change: null });
    });
  });

  describe("ownership changes, on Solana", () => {
    it("counts the transfers Nooscape recorded and dates the latest by when it recorded it, and says that is no later than the transfer", () => {
      const flag = checkFlags(input({ chain: "solana", entry: { activity: null }, facts: { solana: { transfers: 2, latestRecordedAt: new Date("2026-10-15T10:00:00Z") } } })).ownership_changes;
      expect(flag).toMatchObject({ present: true, changes_recorded: 2, handouts_recorded: null, latest_change_block: null, latest_change_recorded_at: "2026-10-15T10:00:00.000Z" });
      expect(flag.basis).toContain("no later than that and may be earlier");
      expect(flag.basis).toContain("before Nooscape's first read");
    });

    it("is not present when none was recorded, and not measured for a registry with no ledger", () => {
      expect(checkFlags(input({ chain: "solana", entry: { activity: null }, facts: { solana: { transfers: 0, latestRecordedAt: null } } })).ownership_changes).toMatchObject({ present: false, changes_recorded: 0, latest_change_recorded_at: null });
      expect(checkFlags(input({ chain: "solana", entry: { activity: null }, facts: { solana: null } })).ownership_changes).toMatchObject({ present: null, changes_recorded: null });
    });
  });

  describe("revoked feedback", () => {
    it("gives the share of ratings later revoked, to three places, and is present when any was", () => {
      expect(checkFlags(input({ entry: { ratings: { measuredThroughBlock: 800, ratingCount: 12, revokedCount: 3 } } })).revoked_feedback).toMatchObject({ present: true, rating_count: 12, revoked_count: 3, revoked_share: 0.25, measured_through_block: 800 });
      expect(checkFlags(input({ entry: { ratings: { measuredThroughBlock: 800, ratingCount: 3, revokedCount: 1 } } })).revoked_feedback.revoked_share).toBe(0.333);
      expect(checkFlags(input({ entry: { ratings: { measuredThroughBlock: 800, ratingCount: 9, revokedCount: 0 } } })).revoked_feedback).toMatchObject({ present: false, revoked_share: 0 });
    });

    it("has no share without ratings, and is not measured where ratings are not read", () => {
      expect(checkFlags(input({ entry: { ratings: { measuredThroughBlock: 800, ratingCount: 0, revokedCount: 0 } } })).revoked_feedback).toMatchObject({ present: false, rating_count: 0, revoked_share: null });
      const unread = checkFlags(input({ chain: "bnb", entry: { ratings: null } })).revoked_feedback;
      expect(unread).toMatchObject({ present: null, rating_count: null, revoked_share: null });
      expect(unread.basis).toContain("Robinhood Chain only");
    });

    it("says it does not say whether a rating was fair", () => {
      expect(checkFlags(input({ entry: { ratings: { measuredThroughBlock: 1, ratingCount: 1, revokedCount: 1 } } })).revoked_feedback.basis).toContain("whether a rating was fair");
    });
  });

  describe("fleet", () => {
    it("counts the listings one wallet registered, this agent included, and the other agents sharing its host and name", () => {
      expect(checkFlags(input({ entry: { related: { sameWallet: 4, sameName: 1, sameHost: 2 } } })).fleet).toMatchObject({ present: true, listed_by_same_wallet: 5, same_host_others: 2, same_name_others: 1 });
      expect(checkFlags(input()).fleet).toMatchObject({ present: false, listed_by_same_wallet: 1 });
    });

    it("is not measured without the counts, and uses the site's definition: one wallet, and nothing more", () => {
      expect(checkFlags(input({ entry: { related: null } })).fleet).toMatchObject({ present: null, listed_by_same_wallet: null });
      expect(checkFlags(input()).fleet.basis).toContain("A fleet means identities registered by one wallet, and nothing more.");
    });
  });
});

// ---------------------------------------------------------------- the rules that hold whatever is asked

describe("what the check is held to", () => {
  it("gives no verdict: no safe, unsafe, trusted, risk, score or grade in any answer, apart from the statements that say what the facts are not", async () => {
    await start(
      deps({
        getEntry: async () => entry({ related: { sameWallet: 9, sameName: 3, sameHost: 4 }, activity: { mintBlock: 1, secondaryTransferCount: 5, handoutCount: 1, uriUpdateCount: 0, events: [] }, ratings: { measuredThroughBlock: 5, totalEvents: 0, ratingCount: 10, activeRatingCount: 4, revokedCount: 6, responseCount: 0, events: [] } }),
      })
    );
    const text = JSON.stringify(await body(await check(robinhood))).replace(CHECK_STATEMENT, "").replace(ACKNOWLEDGED_STATEMENT, "");
    expect(text).not.toMatch(/\b(safe|unsafe|trusted|trustworthy|untrusted|certified|endorsed|secure|risk|risky|suspicious|scam|malicious|legit|score|grade|rank|verdict|warning|red flag)\b/i);
    expect(text).not.toMatch(/[\u2013\u2014]/);
    // The one sentence exempt from that scan is pinned word for word, so it cannot grow a verdict of its own.
    expect(CHECK_STATEMENT).toBe(
      "These are dated facts about a listing, each with the date or block it was read at. None of them is a verdict: Nooscape does not say that an agent is safe or unsafe, and a flag that is present is a fact to weigh and not a finding."
    );
  });

  it("keeps the words of its code free of a verdict too, apart from the one statement", () => {
    // What the file says to the caller: its strings, not the comments that explain what the check is not.
    const source = readFileSync(fileURLToPath(new URL("./apiCheck.ts", import.meta.url)), "utf8");
    const words = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(CHECK_STATEMENT, "");
    expect(words).not.toMatch(/\b(unsafe|trusted|trustworthy|certified|endorsed|suspicious|scam|malicious|legit|verdict|risk)\b/i);
  });

  it("changes nothing: the check reads, and writes nothing to the database or anywhere else", () => {
    for (const file of ["./apiCheck.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source, file).not.toMatch(/\.(insert|update|delete)\(|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
    }
    const api = readFileSync(fileURLToPath(new URL("./apiV1.ts", import.meta.url)), "utf8");
    expect(api.slice(api.indexOf('router.post("/check"'), api.indexOf('router.get("/agents/:chain/:id/history"'))).not.toMatch(/\.(insert|update|delete)\(|writeFile|fetch\(/);
  });

  it("says the same tier, and the same four flags, in the code, the document and the pages", async () => {
    const { API_V1_SPEC } = await import("./apiV1Spec");
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    const post = (API_V1_SPEC.paths["/api/v1/check"] as { post: { description: string } }).post;
    expect(post.description).toContain("Needs a Pro key");
    const developer = read("../client/src/pages/DeveloperApi.tsx");
    expect(developer).toContain('path="/api/v1/check"');
    expect(developer).toContain("Pro key");
    for (const flag of ["first_seen", "ownership_changes", "revoked_feedback", "fleet"]) {
      expect(developer, flag).toContain(flag);
      expect(Object.keys((API_V1_SPEC.components.schemas.CheckResult.properties.flags.properties as Record<string, unknown>)), flag).toContain(flag);
    }
    expect(read("../client/src/lib/apiKeysFlow.ts")).toContain("needs a Pro key");
    // Where pay per call is on a call with no key can be paid for, and the pages say so beside the key.
    expect(read("../client/src/lib/apiKeysFlow.ts")).toContain("With no key it can be paid for per call where pay per call is on");
    expect(developer).toContain('label="Pro key, or pay per call');
    expect(read("../shared/apiKey.ts")).toContain('export const CHECK_MIN_TIER: ApiTier = "pro";');
  });

  it("opens the check to Pro and above alone, by one setting the plan names", async () => {
    const { CHECK_MIN_TIER, tierAtLeast } = await import("../shared/apiKey");
    expect(CHECK_MIN_TIER).toBe("pro");
    expect(tierAtLeast("pro", "pro")).toBe(true);
    expect(tierAtLeast("builder", "pro")).toBe(false);
    expect(tierAtLeast("free", "pro")).toBe(false);
    expect(tierAtLeast("free", "free")).toBe(true);
    expect(tierAtLeast("pro", "builder")).toBe(true);
  });
});
