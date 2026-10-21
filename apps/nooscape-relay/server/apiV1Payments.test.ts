import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_CHAINS, API_V1_RATE_LIMIT, registerApiV1, type ApiV1Deps, type KeyAccess } from "./apiV1";
import { API_TIERS, type ApiKeyRecord } from "./apiKeys";
import { API_V1_SPEC } from "./apiV1Spec";
import { problems, schemaOf } from "./apiV1Check";
import { resetRateLimits } from "./rateLimit";
import { ARC_MAINNET } from "./x402";
import { createPaymentService } from "./x402Service";
import type { Rpc } from "./x402Chain";
import { facilitatorAnswers, fakeChain, headerOf, memoryLedger, newBuyer, newContractBuyer, newFacilitator, testConfig, TEST_CIRCLE_KEY } from "./x402Testing";

/**
 * Pay per call on the REST API (docs/data-access-2026-10-19.md, stage D4), over a real port with the data and the facilitator injected.
 * What it holds to: a caller with a key sees no change; a caller without one is asked for a price only where the spec says (a lookup
 * past the free limit, the check), is charged only for an answer that was built and delivered, and gets exactly the answer a key would
 * give; pay per call off, paused or without its table is the API as it was.
 */
const NOW = new Date("2026-10-19T03:00:00Z");
const ROBINHOOD_KEY = `eip155:4663:${API_CHAINS.robinhood.registry}:7`;
const ROBINHOOD_KEY_8 = `eip155:4663:${API_CHAINS.robinhood.registry}:8`;
const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const WALLET = "0x14791697260e4c9a71f18484c9f997b308e59325";
const KEY_FREE = `nsk_${"a".repeat(40)}`;
const KEY_PRO = `nsk_${"b".repeat(40)}`;
const cfg = testConfig();

const entry = () =>
  ({
    id: ENTRY_ID,
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
    ratings: null,
  }) as never;

function keys(): KeyAccess {
  const known: Record<string, ApiKeyRecord> = { [KEY_FREE]: { id: "key-free", tier: "free", prefix: "nsk_aaaaaa" }, [KEY_PRO]: { id: "key-pro", tier: "pro", prefix: "nsk_bbbbbb" } };
  return {
    resolve: async raw => known[raw] ?? null,
    consume: async (_id, perDay) => ({ allowed: true, limit: perDay, used: 1, remaining: perDay - 1, resetsAt: new Date("2026-10-20T00:00:00Z") }),
    usage: async record => ({ today: { date: "2026-10-19", used: 0, remaining: API_TIERS[record.tier].perDay, limit: API_TIERS[record.tier].perDay, resetsAt: new Date("2026-10-20T00:00:00Z") }, days: [] }),
  };
}

let server: Server | null = null;
let base = "";

function world(options: { config?: ReturnType<typeof testConfig> | null; ready?: boolean; script?: Parameters<typeof newFacilitator>[1]; overrides?: Partial<ApiV1Deps>; rpc?: Rpc | null } = {}) {
  const config = options.config === undefined ? cfg : options.config;
  const store = memoryLedger({ ready: options.ready });
  const facilitator = newFacilitator(config ?? cfg, options.script);
  const payments = config ? createPaymentService({ config, ledger: store.ledger, fetchImpl: facilitator.fetchImpl, rpc: options.rpc }) : null;
  const deps: ApiV1Deps = {
    now: () => NOW,
    findEntries: async (_protocols, key) => (key === ROBINHOOD_KEY || key === ROBINHOOD_KEY_8 ? [{ id: ENTRY_ID, protocol: "erc8004", externalKey: key }] : []),
    getEntry: async () => entry(),
    search: async () => ({ entries: [{ ...(entry() as object), id: ENTRY_ID }], matchedTotal: 1, matchedTotalCapped: false }) as never,
    keysOf: async () => new Map([[ENTRY_ID, ROBINHOOD_KEY]]),
    claimOf: async () => ({ available: true, claimable: true, claim: null }),
    claimHistory: async () => null,
    checkFacts: async () => ({ activityThroughBlock: null, solana: null }),
    keys: keys(),
    payments,
    ...options.overrides,
  };
  return { deps, store, facilitator, buyer: newBuyer(), payments };
}

async function start(deps: ApiV1Deps) {
  await stop();
  const app = express();
  registerApiV1(app, deps);
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

const lookup = (headers: Record<string, string> = {}, path = "/api/v1/agents/robinhood/7") => fetch(`${base}${path}`, { headers });
const check = (payload: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/v1/check`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
const CHECK_AGENT = { agent: { chain: "robinhood", id: "7" } };
const bodies = new WeakMap<Response, Promise<Record<string, any>>>();
/** A response's body, readable more than once. */
const json = (response: Response) => {
  if (!bodies.has(response)) bodies.set(response, response.json() as Promise<Record<string, any>>);
  return bodies.get(response)!;
};
const required = (response: Response) => JSON.parse(Buffer.from(response.headers.get("payment-required")!, "base64").toString("utf8")) as Record<string, any>;
const receipt = (response: Response) => JSON.parse(Buffer.from(response.headers.get("payment-response")!, "base64").toString("utf8")) as Record<string, any>;

/** Uses up the free limit of one address. */
async function useUpFreeLookups(already = 0) {
  for (let index = already; index < API_V1_RATE_LIMIT.requests; index += 1) expect((await lookup()).status).toBe(200);
}

beforeEach(() => {
  resetRateLimits();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
afterAll(stop);

describe("with pay per call off, paused or without its table", () => {
  it("is the API as it was: past the free limit a lookup is limited, and the check without a key needs a key", async () => {
    for (const options of [{ config: null }, { ready: false }]) {
      resetRateLimits();
      const { deps, facilitator } = world(options);
      await start(deps);
      const needsKey = await check(CHECK_AGENT);
      expect(needsKey.status).toBe(401);
      expect((await json(needsKey)).error.code).toBe("key_required");
      await useUpFreeLookups(1);
      const limited = await lookup();
      expect(limited.status, JSON.stringify(options)).toBe(429);
      expect(limited.headers.get("payment-required")).toBeNull();
      expect(facilitator.calls).toHaveLength(0);
    }
  });

  it("offers nothing new while paused, and still serves a caller whose payment is already recorded", async () => {
    const live = world({ config: testConfig({ X402_PAUSE_NEW: "1" }) });
    await start(live.deps);
    expect((await check(CHECK_AGENT)).status).toBe(401);
    await useUpFreeLookups(1);
    expect((await lookup()).status).toBe(429);
    // A payment recorded before the pause is resolved: the row exists and is paid.
    const before = world();
    const payment = before.buyer.pay(cfg, "check");
    await start(before.deps);
    const paid = await check(CHECK_AGENT, { "payment-signature": headerOf(payment) });
    expect(paid.status).toBe(200);
    const pausedService = createPaymentService({ config: testConfig({ X402_PAUSE_NEW: "1" }), ledger: before.store.ledger, fetchImpl: before.facilitator.fetchImpl });
    await start({ ...before.deps, payments: pausedService });
    const again = await check(CHECK_AGENT, { "payment-signature": headerOf(payment) });
    expect(again.status).toBe(200);
    expect(before.facilitator.calls).toHaveLength(1);
    const fresh = await check(CHECK_AGENT, { "payment-signature": headerOf(before.buyer.pay(cfg, "check")) });
    expect(fresh.status).toBe(503);
    expect(before.facilitator.calls).toHaveLength(1);
  });
});

describe("a lookup", () => {
  it("stays free within the limit, even when it carries a payment: nothing is charged and nothing recorded", async () => {
    const { deps, buyer, store, facilitator } = world();
    await start(deps);
    const response = await lookup({ "payment-signature": headerOf(buyer.pay(cfg, "agent")) });
    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect(facilitator.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("past the free limit is answered 402 with the price, and not 429", async () => {
    const { deps } = world();
    await start(deps);
    await useUpFreeLookups();
    const response = await lookup();
    expect(response.status).toBe(402);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const terms = required(response);
    expect(terms).toMatchObject({ x402Version: 2, accepts: [{ scheme: "exact", network: ARC_MAINNET, amount: "5000", payTo: cfg.payTo }], resource: { url: "https://nooscape.si/api/v1/agents/robinhood/7" } });
    const body = await json(response);
    expect(body).toEqual(terms);
    expect(problems(schemaOf("PaymentRequired"), body)).toEqual([]);
    expect(body.error).toContain("$0.005");
    expect(body.error).toContain(`${API_V1_RATE_LIMIT.requests} lookups a minute`);
  });

  it("is delivered for a payment, the same answer as a free one, with the settlement named in PAYMENT-RESPONSE, and is not cached", async () => {
    const { deps, buyer, store, facilitator } = world();
    await start(deps);
    const free = await json(await lookup());
    await useUpFreeLookups(1);
    const payment = buyer.pay(cfg, "agent");
    const paid = await lookup({ "payment-signature": headerOf(payment) });
    expect(paid.status).toBe(200);
    expect(await json(paid)).toEqual(free);
    expect(problems(schemaOf("AgentResponse"), await json(paid))).toEqual([]);
    expect(paid.headers.get("cache-control")).toBe("no-store");
    expect(receipt(paid)).toEqual({ success: true, transaction: store.rows[0]!.transaction, network: ARC_MAINNET, payer: buyer.address.toLowerCase() });
    expect(facilitator.calls).toHaveLength(1);
    expect(facilitator.calls[0]!.authorization).toBe(`Bearer ${TEST_CIRCLE_KEY}`);
    expect(store.rows[0]).toMatchObject({ status: "paid", endpoint: "agent", amount: 5000 });
    // The answer is lost on the way: the same request with the same payment is served again and not charged again.
    const retry = await lookup({ "payment-signature": headerOf(payment) });
    expect(retry.status).toBe(200);
    expect(facilitator.calls).toHaveLength(1);
  });

  it("costs nothing when it fails: not found, a bad option and a broken read are never charged", async () => {
    const world1 = world();
    await start(world1.deps);
    await useUpFreeLookups();
    const header = headerOf(world1.buyer.pay(cfg, "agent"));
    const missing = await lookup({ "payment-signature": header }, "/api/v1/agents/robinhood/999");
    expect(missing.status).toBe(404);
    const bad = await lookup({ "payment-signature": header }, "/api/v1/agents/robinhood/7?registry=nope");
    expect(bad.status).toBe(400);
    expect(world1.facilitator.calls).toHaveLength(0);
    expect(world1.store.rows).toHaveLength(0);

    resetRateLimits();
    const world2 = world({ overrides: { getEntry: async () => { throw new Error("db down\nparams: secret"); } } });
    await start(world2.deps);
    for (let index = 0; index < API_V1_RATE_LIMIT.requests; index += 1) await lookup();
    const broken = await lookup({ "payment-signature": headerOf(world2.buyer.pay(cfg, "agent")) });
    expect(broken.status).toBe(503);
    expect(JSON.stringify(await json(broken))).not.toContain("secret");
    expect(world2.facilitator.calls).toHaveLength(0);
    expect(world2.store.rows).toHaveLength(0);
  });

  it("is never served for a payment that is wrong: another price, a forged signature, junk, or another request's payment", async () => {
    const { deps, buyer, facilitator, store } = world();
    await start(deps);
    await useUpFreeLookups();
    const cheapCheck = buyer.pay(cfg, "check");
    for (const header of [headerOf(cheapCheck), "###", headerOf({ ...buyer.pay(cfg, "agent"), x402Version: 1 } as never)]) {
      const response = await lookup({ "payment-signature": header });
      expect(response.status, header.slice(0, 10)).toBe(402);
      expect(required(response).accepts).toHaveLength(1);
    }
    const forged = buyer.pay(cfg, "agent");
    forged.payload.authorization.nonce = `0x${"ee".repeat(32)}`;
    expect((await lookup({ "payment-signature": headerOf(forged) })).status).toBe(402);
    expect(facilitator.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
    // A paid payment is for the request it was made with.
    const payment = buyer.pay(cfg, "agent");
    expect((await lookup({ "payment-signature": headerOf(payment) })).status).toBe(200);
    const other = await lookup({ "payment-signature": headerOf(payment) }, "/api/v1/agents/robinhood/8");
    expect(other.status).toBe(402);
    expect((await json(other)).error).toContain("different request");
    expect(facilitator.calls).toHaveLength(1);
  });

  it("is not delivered while the payment is refused or pending, and is when it settles", async () => {
    const refusing = world({ script: [facilitatorAnswers.refused("insufficient_funds")] });
    await start(refusing.deps);
    await useUpFreeLookups();
    const refused = await lookup({ "payment-signature": headerOf(refusing.buyer.pay(cfg, "agent")) });
    expect(refused.status).toBe(402);
    expect((await json(refused)).error).toContain("insufficient_funds");
    expect(problems(schemaOf("PaymentRequired"), await json(refused))).toEqual([]);
    expect(refused.headers.get("payment-response")).toBeNull();

    resetRateLimits();
    const pending = world({ script: [facilitatorAnswers.pending()] });
    await start(pending.deps);
    await useUpFreeLookups();
    const payment = pending.buyer.pay(cfg, "agent");
    const wait = await lookup({ "payment-signature": headerOf(payment) });
    expect(wait.status).toBe(503);
    expect(wait.headers.get("retry-after")).toBe("5");
    expect((await json(wait)).error.payment_id).toMatch(/^nsc_/);
    expect(problems(schemaOf("Error"), await json(wait))).toEqual([]);
    const done = await lookup({ "payment-signature": headerOf(payment) });
    expect(done.status).toBe(200);
    expect(pending.facilitator.calls).toHaveLength(2);
  });

  it("is limited when too many payments come from one address, and when too many prices are asked for", async () => {
    const { deps, buyer } = world();
    await start(deps);
    await useUpFreeLookups();
    let last = 0;
    for (let index = 0; index < 61; index += 1) last = (await lookup({ "payment-signature": headerOf(buyer.pay(cfg, "check")) })).status;
    expect(last).toBe(429);
    resetRateLimits();
    await useUpFreeLookups();
    for (let index = 0; index < 300; index += 1) expect((await lookup()).status, `offer ${index + 1}`).toBe(402);
    expect((await lookup()).status).toBe(429);
  }, 60_000);

  it("is never allowed to throw out of the router, whatever shape a stranger's header has: the next request is still answered", async () => {
    const { deps, buyer, facilitator, store } = world();
    await start(deps);
    await useUpFreeLookups();
    const good = buyer.pay(cfg, "agent");
    const hostile: unknown[] = [{ toString: 1 }, { valueOf: 1 }, [1], 5, null, true];
    for (const field of ["scheme", "network", "amount", "asset", "payTo"] as const) {
      for (const value of hostile) {
        const header = Buffer.from(JSON.stringify({ ...good, accepted: { ...good.accepted, [field]: value } })).toString("base64");
        const response = await lookup({ "payment-signature": header });
        expect(response.status, `${field}=${JSON.stringify(value)}`).toBe(402);
        expect(response.headers.get("payment-required")).not.toBeNull();
      }
    }
    for (const junk of ["x", "e30=", Buffer.from("[]").toString("base64"), Buffer.from("null").toString("base64"), "A".repeat(15_000)]) {
      expect((await lookup({ "payment-signature": junk })).status).toBe(402);
    }
    expect((await lookup({ "payment-signature": headerOf(good) })).status).toBe(200);
    expect(facilitator.calls).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
  });

  it("is never charged for an answer that came out degraded: a claim read that failed, or check facts that could not be read, answer 503 and cost nothing", async () => {
    const claims = world({ overrides: { claimOf: async () => null } });
    await start(claims.deps);
    await useUpFreeLookups();
    const header = headerOf(claims.buyer.pay(cfg, "agent"));
    const degraded = await lookup({ "payment-signature": header });
    expect(degraded.status).toBe(503);
    expect(claims.facilitator.calls).toHaveLength(0);
    expect(claims.store.rows).toHaveLength(0);
    resetRateLimits();
    expect((await lookup()).status).toBe(200);

    const facts = world({ overrides: { checkFacts: async () => null } });
    await start(facts.deps);
    const noFacts = await check(CHECK_AGENT, { "payment-signature": headerOf(facts.buyer.pay(cfg, "check")) });
    expect(noFacts.status).toBe(503);
    expect(facts.facilitator.calls).toHaveLength(0);
    expect(facts.store.rows).toHaveLength(0);
    // A free answer is unchanged: a Pro key is still given the answer with "not measured".
    expect((await check(CHECK_AGENT, { authorization: `Bearer ${KEY_PRO}` })).status).toBe(200);
  });

  it("answers a check that matches no listing and does not charge for it, as it does not charge for an agent that is not listed", async () => {
    const { deps, buyer, facilitator, store } = world({ overrides: { search: async () => ({ entries: [], matchedTotal: 0, matchedTotalCapped: false }) as never } });
    await start(deps);
    const empty = await check({ wallet: WALLET }, { "payment-signature": headerOf(buyer.pay(cfg, "check")) });
    expect(empty.status).toBe(200);
    expect((await json(empty)).data.results).toEqual([]);
    expect(empty.headers.get("payment-response")).toBeNull();
    expect(facilitator.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("is never offered for a key's request, and the endpoints that are not for sale are limited as before", async () => {
    const { deps } = world();
    await start(deps);
    await useUpFreeLookups();
    for (const path of ["/api/v1/agents/search?q=alice", "/api/v1/agents/robinhood/7/history"]) {
      const response = await lookup({}, path);
      expect(response.status, path).toBe(429);
      expect(response.headers.get("payment-required")).toBeNull();
    }
    const keyed = await lookup({ authorization: `Bearer ${KEY_FREE}` });
    expect(keyed.status).toBe(200);
    expect(keyed.headers.get("payment-response")).toBeNull();
  });
});

describe("the check", () => {
  it("is offered for a price to a caller with no key, however many free lookups were used", async () => {
    const { deps } = world();
    await start(deps);
    await useUpFreeLookups();
    const offer = await check(CHECK_AGENT);
    expect(offer.status).toBe(402);
    expect(required(offer).accepts[0]).toMatchObject({ amount: "10000", network: ARC_MAINNET });
    expect((await json(offer)).error).toContain("$0.01");
    expect(problems(schemaOf("PaymentRequired"), await json(offer))).toEqual([]);
    expect(offer.headers.get("cache-control")).toBe("no-store");
  });

  it("is delivered for a payment with exactly the answer a Pro key gets: payment changes nothing about what is said", async () => {
    const { deps, buyer, store, facilitator } = world();
    await start(deps);
    const pro = await json(await check(CHECK_AGENT, { authorization: `Bearer ${KEY_PRO}` }));
    const paid = await check(CHECK_AGENT, { "payment-signature": headerOf(buyer.pay(cfg, "check")) });
    expect(paid.status).toBe(200);
    expect(await json(paid)).toEqual(pro);
    expect(problems(schemaOf("CheckResponse"), await json(paid))).toEqual([]);
    expect(receipt(paid).transaction).toBe(store.rows[0]!.transaction);
    expect(store.rows[0]).toMatchObject({ endpoint: "check", amount: 10000, status: "paid" });
    expect(facilitator.calls).toHaveLength(1);
  });

  it("is checked for a wallet or an address as well, and a payment is for that one question", async () => {
    const { deps, buyer, facilitator } = world();
    await start(deps);
    const payment = buyer.pay(cfg, "check");
    const header = headerOf(payment);
    const asked = await check({ wallet: WALLET }, { "payment-signature": header });
    expect(asked.status).toBe(200);
    expect((await json(asked)).data.subject).toMatchObject({ type: "wallet" });
    const other = await check({ url: "https://alice.example/x" }, { "payment-signature": header });
    expect(other.status).toBe(402);
    expect((await json(other)).error).toContain("different request");
    expect(facilitator.calls).toHaveLength(1);
    // The same for a check of one agent and then of another.
    const agentPayment = headerOf(buyer.pay(cfg, "check"));
    expect((await check(CHECK_AGENT, { "payment-signature": agentPayment })).status).toBe(200);
    const otherAgent = await check({ agent: { chain: "robinhood", id: "8" } }, { "payment-signature": agentPayment });
    expect(otherAgent.status).toBe(402);
    expect((await json(otherAgent)).error).toContain("different request");
    expect(facilitator.calls).toHaveLength(2);
  });

  it("costs nothing when the body is bad, the agent is not listed, or the read fails", async () => {
    const { deps, buyer, facilitator, store } = world();
    await start(deps);
    const header = headerOf(buyer.pay(cfg, "check"));
    expect((await check("{not json", { "payment-signature": header })).status).toBe(400);
    expect((await check({}, { "payment-signature": header })).status).toBe(400);
    expect((await check({ agent: { chain: "robinhood", id: "999" } }, { "payment-signature": header })).status).toBe(404);
    expect((await check({ agent: { chain: "nowhere", id: "1" } }, { "payment-signature": header })).status).toBe(400);
    expect(facilitator.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("is not changed for a caller with a key: a Pro key is served free, a free key is told it needs a Pro key, a bad key is refused, and a payment next to a key is not taken", async () => {
    const { deps, buyer, facilitator, store } = world();
    await start(deps);
    const header = headerOf(buyer.pay(cfg, "check"));
    const pro = await check(CHECK_AGENT, { authorization: `Bearer ${KEY_PRO}`, "payment-signature": header });
    expect(pro.status).toBe(200);
    expect(pro.headers.get("payment-response")).toBeNull();
    const free = await check(CHECK_AGENT, { authorization: `Bearer ${KEY_FREE}`, "payment-signature": header });
    expect(free.status).toBe(403);
    expect((await json(free)).error.code).toBe("tier_required");
    expect(free.headers.get("payment-required")).toBeNull();
    const bad = await check(CHECK_AGENT, { authorization: `Bearer nsk_${"z".repeat(40)}`, "payment-signature": header });
    expect(bad.status).toBe(401);
    expect(facilitator.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("is a GET-less route still: a GET of it is 405, never a price", async () => {
    const { deps } = world();
    await start(deps);
    const response = await lookup({}, "/api/v1/check");
    expect(response.status).toBe(405);
    expect(response.headers.get("payment-required")).toBeNull();
  });
});

describe("the index", () => {
  it("names the price and the receiving address only while pay per call is on", async () => {
    const live = world();
    await start(live.deps);
    const on = await json(await fetch(`${base}/api/v1`));
    expect(problems(schemaOf("IndexResponse"), on)).toEqual([]);
    expect(on.pay_per_call).toMatchObject({ protocol: "x402", version: 2, network: ARC_MAINNET, pay_to: cfg.payTo, prices: { lookup: { amount: "5000", usd: "$0.005" }, check: { amount: "10000", usd: "$0.01" } } });
    for (const options of [{ config: null }, { ready: false }, { config: testConfig({ X402_PAUSE_NEW: "1" }) }]) {
      await start(world(options).deps);
      const off = await json(await fetch(`${base}/api/v1`));
      expect(off.pay_per_call, JSON.stringify(options)).toBeUndefined();
      expect(problems(schemaOf("IndexResponse"), off)).toEqual([]);
    }
  });
});

describe("the count of payments left unresolved", () => {
  const age = async (store: ReturnType<typeof memoryLedger>, count: number) => {
    for (let index = 0; index < count; index += 1) {
      await store.ledger.begin({ paymentId: `nsc_${String(index).padStart(32, "0")}`, network: ARC_MAINNET, endpoint: "check", payer: `0x${"a1".repeat(20)}`, nonce: `0x${String(index).padStart(64, "0")}`, amount: 10000, validBefore: 1_792_390_000, subjectHash: "c".repeat(64) });
      store.rows[store.rows.length - 1]!.updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    }
  };

  it("is in the index while pay per call is on or paused, for the health check to read, and absent while it is off", async () => {
    const live = world();
    await age(live.store, 2);
    await start(live.deps);
    const on = await json(await fetch(`${base}/api/v1`));
    expect(on.payments_unresolved_over_hour).toBe(2);
    expect(problems(schemaOf("IndexResponse"), on)).toEqual([]);

    const paused = world({ config: testConfig({ X402_PAUSE_NEW: "1" }) });
    await age(paused.store, 1);
    await start(paused.deps);
    const stopped = await json(await fetch(`${base}/api/v1`));
    expect(stopped.payments_unresolved_over_hour).toBe(1);
    expect(stopped.pay_per_call).toBeUndefined();
    expect(problems(schemaOf("IndexResponse"), stopped)).toEqual([]);

    for (const options of [{ config: null }, { ready: false }]) {
      await start(world(options).deps);
      const off = await json(await fetch(`${base}/api/v1`));
      expect(off.payments_unresolved_over_hour, JSON.stringify(options)).toBeUndefined();
    }

    const broken = world();
    broken.store.ledger.stale = async () => {
      throw new Error("database down");
    };
    await start(broken.deps);
    const unknown = await json(await fetch(`${base}/api/v1`));
    expect(unknown.payments_unresolved_over_hour).toBeNull();
    expect(problems(schemaOf("IndexResponse"), unknown)).toEqual([]);
  });
});

describe("a smart-contract wallet", () => {
  const withNode = testConfig({ X402_RPC: "https://node.example/key" });
  const chainWorld = (extra: Parameters<typeof world>[0] = {}) => {
    const chain = fakeChain();
    return { chain, ...world({ config: withNode, rpc: chain.rpc, ...extra }) };
  };

  it("pays for a check like any other when a node is set: the same answer, the wallet named in the receipt, and the index says it is taken", async () => {
    const { deps, store, facilitator, chain } = chainWorld();
    await start(deps);
    const pro = await json(await check(CHECK_AGENT, { authorization: `Bearer ${KEY_PRO}` }));
    const wallet = newContractBuyer();
    const paid = await check(CHECK_AGENT, { "payment-signature": headerOf(wallet.pay(withNode, "check")) });
    expect(paid.status).toBe(200);
    expect(await json(paid)).toEqual(pro);
    expect(receipt(paid)).toMatchObject({ success: true, payer: wallet.address });
    expect(store.rows[0]).toMatchObject({ status: "paid", payer: wallet.address });
    expect(facilitator.calls).toHaveLength(1);
    expect(chain.calls).toHaveLength(1);
    const index = await json(await fetch(`${base}/api/v1`));
    expect(index.pay_per_call.wallets).toEqual(["regular", "smart_contract"]);
    expect(problems(schemaOf("IndexResponse"), index)).toEqual([]);
  });

  it("is refused 402 with the reason, and nothing is charged or recorded, when the chain says no; 503 when it cannot say", async () => {
    const { deps, store, facilitator, chain } = chainWorld();
    await start(deps);
    const wallet = newContractBuyer();
    chain.state.verdict = "invalid";
    const no = await check(CHECK_AGENT, { "payment-signature": headerOf(wallet.pay(withNode, "check")) });
    expect(no.status).toBe(402);
    expect((await json(no)).error).toMatch(/ERC-1271/);
    expect(problems(schemaOf("PaymentRequired"), await json(no))).toEqual([]);
    chain.state.verdict = "down";
    const unknown = await check(CHECK_AGENT, { "payment-signature": headerOf(wallet.pay(withNode, "check")) });
    expect(unknown.status).toBe(503);
    expect(unknown.headers.get("retry-after")).toBe("10");
    expect(problems(schemaOf("Error"), await json(unknown))).toEqual([]);
    expect(facilitator.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("is not taken when no node is set: the old refusal, and the index lists regular wallets only", async () => {
    const { deps, store, facilitator } = world();
    await start(deps);
    const no = await check(CHECK_AGENT, { "payment-signature": headerOf(newContractBuyer().pay(cfg, "check")) });
    expect(no.status).toBe(402);
    expect((await json(no)).error).toMatch(/smart-contract wallets are not accepted/);
    expect((await json(await fetch(`${base}/api/v1`))).pay_per_call.wallets).toEqual(["regular"]);
    expect(facilitator.calls).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("is served again for the same payment without a second look at the chain, and a lookup past the free limit works the same way", async () => {
    const { deps, chain, facilitator } = chainWorld();
    await start(deps);
    await useUpFreeLookups();
    const wallet = newContractBuyer();
    const payment = wallet.pay(withNode, "agent");
    expect((await lookup({ "payment-signature": headerOf(payment) })).status).toBe(200);
    chain.state.verdict = "used";
    expect((await lookup({ "payment-signature": headerOf(payment) })).status).toBe(200);
    expect(chain.calls).toHaveLength(1);
    expect(facilitator.calls).toHaveLength(1);
  });
});

describe("the document", () => {
  it("says a lookup and the check may answer 402, takes a PAYMENT-SIGNATURE header, and gives the other endpoints neither", () => {
    type Operation = { responses: Record<string, unknown>; parameters?: Array<{ name: string }> };
    const operations = Object.entries(API_V1_SPEC.paths).flatMap(([path, item]) => Object.values(item).map(operation => [path, operation as unknown as Operation] as const));
    for (const [path, operation] of operations) {
      const payable = path === "/api/v1/check" || path === "/api/v1/agents/{chain}/{id}";
      expect("402" in operation.responses, path).toBe(payable);
      expect((operation.parameters ?? []).some(parameter => parameter.name === "PAYMENT-SIGNATURE"), path).toBe(payable);
    }
  });
});

describe("what is written down", () => {
  it("never puts the signature, the facilitator's key or an address in the log", async () => {
    const { deps, buyer } = world();
    await start(deps);
    const payment = buyer.pay(cfg, "check");
    await check(CHECK_AGENT, { "payment-signature": headerOf(payment) });
    const logged = [console.log, console.warn, console.error].flatMap(spy => vi.mocked(spy).mock.calls.flat()).join(" ");
    expect(logged).not.toContain(payment.payload.signature);
    expect(logged).not.toContain(TEST_CIRCLE_KEY);
    expect(logged.toLowerCase()).not.toContain(buyer.address.toLowerCase());
    expect(logged).toMatch(/\[x402\] paid check nsc_/);
  });
});
