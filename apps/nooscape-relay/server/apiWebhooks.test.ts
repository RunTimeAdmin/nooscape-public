import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { servedChains } from "./apiChains";
import { API_CHAINS, registerApiV1, type ApiV1Deps, type KeyAccess } from "./apiV1";
import { API_TIERS, type ApiKeyRecord } from "./apiKeys";
import { WEBHOOK_CHANGES_PER_MINUTE, type WebhookService } from "./apiWebhooks";
import { problems, schemaOf } from "./apiV1Check";
import { apiV1SpecFor } from "./apiV1Spec";
import { resetRateLimits } from "./rateLimit";
import { type SendResult } from "./webhookPass";
import { ARC_ENTRY, ROBINHOOD_ENTRY, SOLANA_ENTRY, memoryEventSource, memoryWebhookStore, type MemoryLedgers } from "./webhookTesting";
import { EVENT_TYPES, WATCH_LIMIT, signature, signingSecret } from "./webhooks";

/**
 * Watchlists and the webhook over the REST API (docs/data-access-2026-10-19.md, stage D5), through the real router with the store, the
 * ledgers and the network replaced: who may use it, what each call answers in the shape the document gives, what a bad call is told, what
 * is sent to an address that is set, and that one key never sees another's.
 */
const NOW = new Date("2026-10-19T12:00:00Z");
const MIDNIGHT = new Date("2026-10-20T00:00:00Z");
const keyText = (letter: string) => `nsk_${letter.repeat(40)}`;
const KEY_FREE = keyText("a");
const KEY_BUILDER = keyText("b");
const KEY_PRO = keyText("c");
const KEY_OTHER = keyText("d");
const SIGNING_KEY = "s".repeat(40);
const ROBINHOOD_KEY = `eip155:4663:${API_CHAINS.robinhood.registry}:42`;
const SOLANA_KEY = SOLANA_ENTRY.externalKey;
const ARC_KEY = ARC_ENTRY.externalKey;
const RECORDS: Record<string, ApiKeyRecord> = {
  [KEY_FREE]: { id: "key-free", tier: "free", prefix: "nsk_aaaaaa" },
  [KEY_BUILDER]: { id: "key-builder", tier: "builder", prefix: "nsk_bbbbbb" },
  [KEY_PRO]: { id: "key-pro", tier: "pro", prefix: "nsk_cccccc" },
  [KEY_OTHER]: { id: "key-other", tier: "builder", prefix: "nsk_dddddd" },
};

let server: Server | null = null;
let base = "";
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const call = (method: string, path: string, key: string | null = KEY_BUILDER, payload?: unknown) =>
  fetch(`${base}/api/v1${path}`, { method, headers: { ...(payload === undefined ? {} : { "content-type": "application/json" }), ...(key ? bearer(key) : {}) }, body: payload === undefined ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload) });
const json = async (response: Response) => (await response.json()) as Record<string, any>;

function rig(options: { available?: boolean; ping?: SendResult } = {}) {
  const mem = memoryWebhookStore({ "key-free": { tier: "free" }, "key-builder": { tier: "builder" }, "key-pro": { tier: "pro" }, "key-other": { tier: "builder" } }, () => NOW);
  const ledgers: MemoryLedgers = { entries: [{ ...ROBINHOOD_ENTRY }, { ...SOLANA_ENTRY }, { ...ARC_ENTRY }], claims: [], transfers: [], ratings: [] };
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  let ping: SendResult = options.ping ?? { ok: true, status: 204 };
  let counter = 0;
  const consumed: Array<{ keyId: string; endpoint: string }> = [];
  const keys: KeyAccess = {
    resolve: async raw => RECORDS[raw] ?? null,
    consume: async (keyId, perDay, endpoint) => {
      consumed.push({ keyId, endpoint });
      return { allowed: true, limit: perDay, used: consumed.length, remaining: perDay - consumed.length, resetsAt: MIDNIGHT };
    },
    usage: async () => ({ today: { date: "2026-10-19", used: 0, remaining: 1, limit: 1, resetsAt: MIDNIGHT }, days: [] }),
  };
  const service: WebhookService = {
    store: mem.store,
    entries: memoryEventSource(ledgers).entries,
    signingKey: SIGNING_KEY,
    send: async (url, input) => {
      sent.push({ url, ...input });
      return ping;
    },
    now: () => NOW,
    newId: () => `id-${(counter += 1)}`,
  };
  const deps: ApiV1Deps = {
    now: () => NOW,
    findEntries: async (protocols, key) => {
      // A real lookup is a database read: it lets other requests run, which is what a race needs.
      await new Promise(done => setImmediate(done));
      if (key === ROBINHOOD_KEY) return [{ id: ROBINHOOD_ENTRY.id, protocol: "erc8004", externalKey: key }];
      // The real lookup finds an Arc listing only while Arc's switch is on, as it finds no other listing of a chain that is off.
      if (key === ARC_KEY) return protocols.includes("erc8004_arc") && servedChains().includes("arc") ? [{ id: ARC_ENTRY.id, protocol: "erc8004_arc", externalKey: key }] : [];
      if (key === SOLANA_KEY && protocols.length > 1) return [{ id: SOLANA_ENTRY.id, protocol: "solana_8004", externalKey: key }, { id: "entry-sol-2", protocol: "solana_said", externalKey: key }];
      if (key === SOLANA_KEY) return [{ id: SOLANA_ENTRY.id, protocol: protocols[0]!, externalKey: key }];
      const robinhood = /:(\d+)$/.exec(key);
      return robinhood && key.startsWith("eip155:4663:") ? [{ id: `entry-extra-${robinhood[1]}`, protocol: "erc8004", externalKey: key }] : [];
    },
    getEntry: async () => null,
    search: async () => ({ entries: [], matchedTotal: 0, matchedTotalCapped: false }) as never,
    keysOf: async () => new Map(),
    claimOf: async () => null,
    claimHistory: async () => null,
    checkFacts: async () => ({ activityThroughBlock: null, solana: null }),
    keys,
    webhooks: options.available === false ? null : service,
  };
  return { mem, ledgers, sent, consumed, deps, setPing: (next: SendResult) => void (ping = next) };
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

const SAVED_FEATURES = process.env.VITE_FEATURES;
beforeEach(() => resetRateLimits());
afterEach(() => {
  if (SAVED_FEATURES === undefined) delete process.env.VITE_FEATURES;
  else process.env.VITE_FEATURES = SAVED_FEATURES;
});
afterAll(stop);

describe("who may use the watchlist and the webhook", () => {
  it("needs a key, and a Builder or Pro one: no key is 401, a free key is 403 naming the tier, and a body is not read first", async () => {
    await start(rig().deps);
    for (const [method, path] of [["GET", "/watches"], ["POST", "/watches"], ["DELETE", "/watches/x"], ["GET", "/webhook"], ["PUT", "/webhook"], ["DELETE", "/webhook"], ["POST", "/webhook/rotate-secret"], ["GET", "/webhook/deliveries"]] as const) {
      const none = await call(method, path, null);
      expect(none.status, `${method} ${path}`).toBe(401);
      expect((await json(none)).error.code).toBe("key_required");
      const free = await call(method, path, KEY_FREE, method === "POST" || method === "PUT" ? "this is not json {" : undefined);
      expect(free.status, `${method} ${path}`).toBe(403);
      expect((await json(free)).error).toMatchObject({ code: "tier_required", required_tier: "builder" });
    }
    expect((await call("GET", "/watches", KEY_BUILDER)).status).toBe(200);
    expect((await call("GET", "/watches", KEY_PRO)).status).toBe(200);
    expect((await call("GET", "/watches", "nsk_" + "z".repeat(40))).status).toBe(401);
  });

  it("answers 503 and says so while it is off: no service, or tables that do not exist", async () => {
    await start(rig({ available: false }).deps);
    const off = await call("GET", "/watches");
    expect(off.status).toBe(503);
    expect(off.headers.get("cache-control")).toBe("no-store");
    expect((await json(off)).error).toMatchObject({ code: "unavailable", message: "Watchlists and webhooks are not available yet." });
    const r = rig();
    r.mem.setReady(false);
    await start(r.deps);
    for (const [method, path, payload] of [["GET", "/watches"], ["POST", "/watches", { agents: [{ chain: "robinhood", id: "42" }] }], ["GET", "/webhook"], ["PUT", "/webhook", { url: "https://hooks.example.com/x" }], ["POST", "/webhook/rotate-secret"]] as const) {
      expect((await call(method, path, KEY_BUILDER, payload)).status, `${method} ${path}`).toBe(503);
    }
    expect(r.sent).toHaveLength(0);
  });

  it("counts each call against the key under the endpoint it is, and sends nothing to be cached", async () => {
    const r = rig();
    await start(r.deps);
    for (const [method, path] of [["GET", "/watches"], ["GET", "/webhook"], ["GET", "/webhook/deliveries"], ["DELETE", "/watches/entry-rh-1"]] as const) {
      const response = await call(method, path);
      expect(response.headers.get("cache-control"), `${method} ${path}`).toBe("no-store");
    }
    expect(r.consumed.map(item => item.endpoint)).toEqual(["watches", "webhook", "webhook", "watches"]);
  });
});

describe("the watchlist", () => {
  const add = (agents: unknown, key = KEY_BUILDER) => call("POST", "/watches", key, { agents });

  it("adds listings and says what became of each, in the order asked, in the shape the document gives", async () => {
    const r = rig();
    await start(r.deps);
    const response = await add([
      { chain: "robinhood", id: "42" },
      { chain: "robinhood", id: "42" },
      { chain: "robinhood", id: "99999" },
      { chain: "base", id: "1" },
      { chain: "robinhood", id: "not-a-number" },
      { chain: "robinhood", id: "7", registry: "solana_8004" },
      { chain: "solana", id: SOLANA_KEY },
    ]);
    expect(response.status).toBe(200);
    const answer = await json(response);
    expect(problems(schemaOf("WatchAddResponse"), answer)).toEqual([]);
    expect(answer.data.results.map((item: { status: string }) => item.status)).toEqual(["added", "already_watching", "added", "bad_request", "bad_request", "bad_request", "ambiguous"]);
    expect(answer.data.results[0]).toMatchObject({ chain: "robinhood", id: "42", nooscape_id: ROBINHOOD_ENTRY.id, message: null });
    expect(answer.data.results[3].message).toBe("chain must be one of robinhood, bnb, solana");
    expect(answer.data.results[6]).toMatchObject({ status: "ambiguous", nooscape_id: null });
    expect(answer.data.results[6].message).toContain("solana_8004, solana_said");
    expect(answer.data).toMatchObject({ limit: WATCH_LIMIT, watching: 2 });
    // Naming the registry settles the ambiguity.
    const settled = await json(await add([{ chain: "solana", id: SOLANA_KEY, registry: "solana_8004" }]));
    expect(settled.data.results[0]).toMatchObject({ status: "added", nooscape_id: SOLANA_ENTRY.id });
    expect(await r.mem.store.countWatches("key-builder")).toBe(3);
    // One that is not listed does not spoil the rest.
    const missing = await json(await add([{ chain: "solana", id: "1".repeat(40) }]));
    expect(missing.data.results[0]).toMatchObject({ status: "not_found", nooscape_id: null });
  });

  it("watches an agent on an extra chain only while the chain's switch is on, and says which chains it may name", async () => {
    const r = rig();
    await start(r.deps);
    // Switched off: Arc is not a chain here, and the answer names the three there are.
    const off = await json(await add([{ chain: "arc", id: "13" }]));
    expect(off.data.results[0]).toMatchObject({ status: "bad_request", nooscape_id: null, message: "chain must be one of robinhood, bnb, solana" });
    process.env.VITE_FEATURES = "chain_arc";
    const on = await json(await add([{ chain: "arc", id: "13" }, { chain: "arc", id: "13" }, { chain: "arc", id: "not-a-number" }, { chain: "arc", id: "13", registry: "solana_8004" }, { chain: "base", id: "1" }, { chain: "robinhood", id: "42" }]));
    expect(problems(schemaOf("WatchAddResponse"), on, "$", apiV1SpecFor(servedChains()))).toEqual([]);
    expect(on.data.results.map((item: { status: string }) => item.status)).toEqual(["added", "already_watching", "bad_request", "bad_request", "bad_request", "added"]);
    expect(on.data.results[0]).toMatchObject({ chain: "arc", id: "13", nooscape_id: ARC_ENTRY.id, message: null });
    expect(on.data.results[2].message).toBe("id must be a registry token id (digits only)");
    expect(on.data.results[3].message).toBe("registry applies to solana only");
    expect(on.data.results[4].message).toBe("chain must be one of robinhood, bnb, solana, arc");
    expect(await r.mem.store.countWatches("key-builder")).toBe(2);
  });

  it("lists a watched agent on an extra chain by that chain's name while it is on, and by no chain once it is off", async () => {
    const r = rig();
    await start(r.deps);
    process.env.VITE_FEATURES = "chain_arc";
    await add([{ chain: "arc", id: "13" }, { chain: "robinhood", id: "42" }]);
    const on = await json(await call("GET", "/watches"));
    expect(problems(schemaOf("WatchList"), on, "$", apiV1SpecFor(servedChains()))).toEqual([]);
    const byId = Object.fromEntries(on.data.watches.map((watch: { nooscape_id: string }) => [watch.nooscape_id, watch]));
    expect(byId[ARC_ENTRY.id]).toMatchObject({ chain: "arc", agent_id: "13", registry: "erc8004_arc", listed: true, page_url: `https://nooscape.si/agents/${ARC_ENTRY.id}` });
    expect(byId[ROBINHOOD_ENTRY.id]).toMatchObject({ chain: "robinhood", agent_id: "42" });
    // Switched off, the key still has the watch and can remove it, but the API names no chain for it.
    delete process.env.VITE_FEATURES;
    const off = await json(await call("GET", "/watches"));
    expect(problems(schemaOf("WatchList"), off)).toEqual([]);
    expect(off.data.watching).toBe(2);
    const arc = off.data.watches.find((watch: { nooscape_id: string }) => watch.nooscape_id === ARC_ENTRY.id);
    expect(arc).toMatchObject({ chain: null, agent_id: null, registry: null });
    expect((await call("DELETE", `/watches/${ARC_ENTRY.id}`)).status).toBe(200);
  });

  it("holds a key to 100 listings: what fits is added and the rest is told it did not", async () => {
    const r = rig();
    await start(r.deps);
    await r.mem.store.addWatches("key-builder", Array.from({ length: WATCH_LIMIT - 1 }, (_, index) => `filler-${index}`));
    const answer = await json(await add([{ chain: "robinhood", id: "42" }, { chain: "robinhood", id: "43" }]));
    expect(answer.data.results.map((item: { status: string }) => item.status)).toEqual(["added", "limit_reached"]);
    expect(answer.data.watching).toBe(WATCH_LIMIT);
    expect(await r.mem.store.countWatches("key-builder")).toBe(WATCH_LIMIT);
    // Another key's list is its own.
    expect((await json(await add([{ chain: "robinhood", id: "43" }], KEY_OTHER))).data.results[0].status).toBe("added");
  });

  it("holds a key to 100 listings even when its calls arrive at the same moment", async () => {
    const r = rig();
    await start(r.deps);
    const batch = (from: number) => Array.from({ length: 25 }, (_, index) => ({ chain: "robinhood", id: String(from + index) }));
    const answers = await Promise.all([0, 100, 200, 300, 400, 500].map(from => add(batch(1_000 + from))));
    expect(answers.every(response => response.status === 200)).toBe(true);
    expect(await r.mem.store.countWatches("key-builder")).toBe(WATCH_LIMIT);
    const statuses = (await Promise.all(answers.map(json))).flatMap(answer => answer.data.results.map((item: { status: string }) => item.status));
    expect(statuses.filter(status => status === "added")).toHaveLength(WATCH_LIMIT);
    expect(statuses.filter(status => status === "limit_reached")).toHaveLength(150 - WATCH_LIMIT);
  });

  it("refuses a body that is not 1 to 25 agents, with the reason, and one that is not JSON", async () => {
    await start(rig().deps);
    for (const bad of [[], Array.from({ length: 26 }, () => ({ chain: "robinhood", id: "42" })), [{ chain: "robinhood" }], [{ chain: "robinhood", id: "42", extra: 1 }], "nope"]) {
      const response = await add(bad);
      expect(response.status, JSON.stringify(bad).slice(0, 40)).toBe(400);
      expect((await json(response)).error.code).toBe("bad_request");
    }
    expect((await call("POST", "/watches", KEY_BUILDER, { agents: [{ chain: "robinhood", id: "42" }], more: true })).status).toBe(400);
    const broken = await call("POST", "/watches", KEY_BUILDER, "{ not json");
    expect(broken.status).toBe(400);
    expect((await json(broken)).error.message).toBe("The body is not valid JSON.");
    const large = await call("POST", "/watches", KEY_BUILDER, JSON.stringify({ agents: [{ chain: "robinhood", id: "4".repeat(5_000) }] }));
    expect(large.status).toBe(413);
  });

  it("lists what the key watches, and whether each is in the public view, in the shape the document gives", async () => {
    const r = rig();
    r.ledgers.entries[1]!.visible = false;
    await start(r.deps);
    await add([{ chain: "robinhood", id: "42" }, { chain: "solana", id: SOLANA_KEY, registry: "solana_8004" }]);
    const answer = await json(await call("GET", "/watches"));
    expect(problems(schemaOf("WatchList"), answer)).toEqual([]);
    expect(answer.data).toMatchObject({ limit: WATCH_LIMIT, watching: 2 });
    const byId = Object.fromEntries(answer.data.watches.map((watch: { nooscape_id: string }) => [watch.nooscape_id, watch]));
    expect(byId[ROBINHOOD_ENTRY.id]).toMatchObject({ chain: "robinhood", agent_id: "42", registry: "erc8004", listed: true, page_url: `https://nooscape.si/agents/${ROBINHOOD_ENTRY.id}` });
    expect(byId[SOLANA_ENTRY.id]).toMatchObject({ chain: "solana", agent_id: SOLANA_KEY, registry: "solana_8004", listed: false });
    expect((await json(await call("GET", "/watches", KEY_PRO))).data.watches).toEqual([]);
  });

  it("stops watching a listing, even one that has left the public view, and says so when it was not watched", async () => {
    const r = rig();
    r.ledgers.entries[0]!.visible = false;
    await start(r.deps);
    await add([{ chain: "robinhood", id: "42" }]);
    const gone = await call("DELETE", `/watches/${ROBINHOOD_ENTRY.id}`);
    expect(gone.status).toBe(200);
    const answer = await json(gone);
    expect(problems(schemaOf("WatchRemoveResponse"), answer)).toEqual([]);
    expect(answer.data).toEqual({ removed: true, nooscape_id: ROBINHOOD_ENTRY.id });
    const again = await call("DELETE", `/watches/${ROBINHOOD_ENTRY.id}`);
    expect(again.status).toBe(404);
    expect((await call("DELETE", "/watches/has%20space")).status).toBe(400);
  });

  it("keeps a key's list its own: another key cannot see it or remove from it", async () => {
    const r = rig();
    await start(r.deps);
    await add([{ chain: "robinhood", id: "42" }]);
    expect((await json(await call("GET", "/watches", KEY_OTHER))).data.watches).toEqual([]);
    expect((await call("DELETE", `/watches/${ROBINHOOD_ENTRY.id}`, KEY_OTHER)).status).toBe(404);
    expect(await r.mem.store.countWatches("key-builder")).toBe(1);
  });
});

describe("the webhook", () => {
  const put = (url: unknown, key = KEY_BUILDER) => call("PUT", "/webhook", key, { url });

  it("is not set until it is, and says what it may be sent", async () => {
    await start(rig().deps);
    const answer = await json(await call("GET", "/webhook"));
    expect(problems(schemaOf("WebhookResponse"), answer)).toEqual([]);
    expect(answer.data).toEqual({ configured: false, events: EVENT_TYPES });
  });

  it("is set to an https address, tested at once with a signed ping, and saved whatever the test got", async () => {
    const r = rig();
    await start(r.deps);
    const response = await put("https://hooks.example.com/nooscape");
    expect(response.status).toBe(200);
    const answer = await json(response);
    expect(problems(schemaOf("WebhookResponse"), answer)).toEqual([]);
    expect(answer.data).toMatchObject({ configured: true, url: "https://hooks.example.com/nooscape", status: "active", off_since: null, consecutive_failures: 0, secret_version: 1, ping: { ok: true, status: 204 } });
    expect(answer.data.signing_secret).toBe(signingSecret(SIGNING_KEY, "key-builder", 1));
    expect(r.sent).toHaveLength(1);
    const [ping] = r.sent;
    expect(ping!.url).toBe("https://hooks.example.com/nooscape");
    const sentBody = JSON.parse(ping!.body);
    expect(sentBody).toMatchObject({ type: "ping", agent: null, id: ping!.headers["x-nooscape-delivery"] });
    const timestamp = Number(ping!.headers["x-nooscape-timestamp"]);
    expect(ping!.headers["x-nooscape-signature"]).toBe(`t=${timestamp},v1=${signature(answer.data.signing_secret, timestamp, ping!.body)}`);
    expect(ping!.headers["x-nooscape-event"]).toBe("ping");

    // A test that fails is reported, and the address is kept.
    r.setPing({ ok: false, status: 500, error: "http_500" });
    const failed = await json(await put("https://hooks.example.com/other"));
    expect(failed.data).toMatchObject({ url: "https://hooks.example.com/other", ping: { ok: false, status: 500, error: "http_500" } });
    expect(problems(schemaOf("WebhookResponse"), failed)).toEqual([]);
    r.setPing({ ok: false, status: null, error: "forbidden_address" });
    expect((await json(await put("https://hooks.example.com/third"))).data.ping).toEqual({ ok: false, status: null, error: "forbidden_address" });
    expect((await json(await call("GET", "/webhook"))).data.url).toBe("https://hooks.example.com/third");
  });

  it("refuses an address that is not one it will call, with the reason, and sends nothing", async () => {
    const r = rig();
    await start(r.deps);
    const cases: Array<[unknown, string]> = [
      ["http://hooks.example.com/x", "url must be https"],
      ["https://user:pw@hooks.example.com/x", "url must not carry a user name or password"],
      ["https://hooks.example.com:8443/x", "url must not name a port: the standard https port is the only one used"],
      ["https://127.0.0.1/x", "url must name a public host, not an address or an internal name"],
      ["https://localhost/x", "url must name a public host, not an address or an internal name"],
      ["https://" + "a".repeat(600) + ".example.com/", "url must be at most 500 characters"],
      ["", "url must be an https address"],
      [42, "url must be an https address"],
      [undefined, "url must be an https address"],
    ];
    for (const [url, message] of cases) {
      const response = await put(url);
      expect(response.status, String(url).slice(0, 40)).toBe(400);
      expect((await json(response)).error).toMatchObject({ code: "bad_request", message });
    }
    expect((await call("PUT", "/webhook", KEY_BUILDER, { url: "https://hooks.example.com/x", secret: "mine" })).status).toBe(400);
    expect((await call("PUT", "/webhook", KEY_BUILDER, "{ no")).status).toBe(400);
    expect(r.sent).toHaveLength(0);
    expect(await r.mem.store.getWebhook("key-builder")).toBeNull();
  });

  it("limits how often it is changed, since setting it calls the address: six a minute, then 429 with a time to wait", async () => {
    const r = rig();
    await start(r.deps);
    for (let index = 0; index < WEBHOOK_CHANGES_PER_MINUTE; index += 1) expect((await put(`https://hooks.example.com/${index}`)).status).toBe(200);
    const over = await put("https://hooks.example.com/over");
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await json(over)).error.code).toBe("rate_limited");
    expect(r.sent).toHaveLength(WEBHOOK_CHANGES_PER_MINUTE);
    // Another key has its own allowance.
    expect((await put("https://hooks.example.com/x", KEY_OTHER)).status).toBe(200);
  });

  it("is shown to its key with its secret, and to no other key", async () => {
    await start(rig().deps);
    await put("https://hooks.example.com/mine");
    const mine = await json(await call("GET", "/webhook"));
    expect(mine.data).toMatchObject({ configured: true, url: "https://hooks.example.com/mine", status: "active" });
    expect(mine.data.signing_secret).toMatch(/^whsec_/);
    const theirs = await json(await call("GET", "/webhook", KEY_OTHER));
    expect(theirs.data.configured).toBe(false);
    expect(JSON.stringify(theirs)).not.toContain(mine.data.signing_secret);
    await put("https://hooks.example.com/theirs", KEY_OTHER);
    const otherSecret = (await json(await call("GET", "/webhook", KEY_OTHER))).data.signing_secret;
    expect(otherSecret).not.toBe(mine.data.signing_secret);
  });

  it("gives a new secret when asked, and the old one is no longer the one", async () => {
    const r = rig();
    await start(r.deps);
    expect((await call("POST", "/webhook/rotate-secret")).status).toBe(404);
    const first = (await json(await put("https://hooks.example.com/x"))).data.signing_secret;
    const rotated = await json(await call("POST", "/webhook/rotate-secret"));
    expect(problems(schemaOf("WebhookResponse"), rotated)).toEqual([]);
    expect(rotated.data).toMatchObject({ secret_version: 2 });
    expect(rotated.data.signing_secret).toBe(signingSecret(SIGNING_KEY, "key-builder", 2));
    expect(rotated.data.signing_secret).not.toBe(first);
    // Setting the address again keeps the version, so a key that only changes where it listens keeps its secret.
    expect((await json(await put("https://hooks.example.com/y"))).data.signing_secret).toBe(rotated.data.signing_secret);
  });

  it("does not bring back a secret that was rotated away when the webhook is removed and set again", async () => {
    await start(rig().deps);
    const first = (await json(await put("https://hooks.example.com/x"))).data.signing_secret;
    const rotated = (await json(await call("POST", "/webhook/rotate-secret"))).data.signing_secret;
    expect((await call("DELETE", "/webhook")).status).toBe(200);
    expect((await call("POST", "/webhook/rotate-secret")).status).toBe(404);
    const again = await json(await put("https://hooks.example.com/y"));
    expect(again.data.secret_version).toBe(2);
    expect(again.data.signing_secret).toBe(rotated);
    expect(again.data.signing_secret).not.toBe(first);
  });

  it("is turned back on by setting it again, and shows when and why it was off", async () => {
    const r = rig();
    await start(r.deps);
    await put("https://hooks.example.com/x");
    r.mem.webhooks.set("key-builder", { ...r.mem.webhooks.get("key-builder")!, failures: 20, disabledAt: new Date("2026-10-19T11:00:00Z") });
    const off = await json(await call("GET", "/webhook"));
    expect(problems(schemaOf("WebhookResponse"), off)).toEqual([]);
    expect(off.data).toMatchObject({ status: "off", off_since: "2026-10-19T11:00:00.000Z", consecutive_failures: 20, turned_off_after_failures: 20 });
    const back = await json(await put("https://hooks.example.com/x"));
    expect(back.data).toMatchObject({ status: "active", off_since: null, consecutive_failures: 0 });
  });

  it("is removed, and the watchlist stays", async () => {
    const r = rig();
    await start(r.deps);
    await call("POST", "/watches", KEY_BUILDER, { agents: [{ chain: "robinhood", id: "42" }] });
    await put("https://hooks.example.com/x");
    const removed = await json(await call("DELETE", "/webhook"));
    expect(problems(schemaOf("WebhookRemoveResponse"), removed)).toEqual([]);
    expect(removed.data).toEqual({ removed: true, configured: false });
    expect((await json(await call("DELETE", "/webhook"))).data.removed).toBe(false);
    expect((await json(await call("GET", "/webhook"))).data.configured).toBe(false);
    expect(await r.mem.store.countWatches("key-builder")).toBe(1);
  });

  it("lists the last deliveries written for the key and what became of each, and no other key's", async () => {
    const r = rig();
    await start(r.deps);
    await r.mem.store.insertDeliveries([
      { id: "d1", keyId: "key-builder", eventRef: "claim:1", kind: "claim.changed", entryId: ROBINHOOD_ENTRY.id, body: "{}" },
      { id: "d2", keyId: "key-builder", eventRef: "own:1", kind: "ownership.changed", entryId: ROBINHOOD_ENTRY.id, body: "{}" },
      { id: "d3", keyId: "key-other", eventRef: "claim:1", kind: "claim.changed", entryId: ROBINHOOD_ENTRY.id, body: "{}" },
    ]);
    await r.mem.store.markSent("d1", 200, NOW);
    await r.mem.store.markFailed("d2", { attempts: 2, next: new Date("2026-10-19T12:05:00Z"), status: 503, error: "http_503" });
    const answer = await json(await call("GET", "/webhook/deliveries"));
    expect(problems(schemaOf("WebhookDeliveries"), answer)).toEqual([]);
    expect(answer.data.deliveries.map((item: { id: string }) => item.id)).toEqual(["d2", "d1"]);
    expect(answer.data.deliveries[0]).toMatchObject({ type: "ownership.changed", status: "pending", attempts: 2, last_status: 503, last_error: "http_503", next_attempt_at: "2026-10-19T12:05:00.000Z", sent_at: null });
    expect(answer.data.deliveries[1]).toMatchObject({ status: "sent", attempts: 1, last_status: 200, next_attempt_at: null });
    expect(JSON.stringify(answer)).not.toContain('"body"');
    expect((await json(await call("GET", "/webhook/deliveries", KEY_PRO))).data.deliveries).toEqual([]);
  });
});

describe("methods", () => {
  it("answers 405 with what each path takes, for a method it does not", async () => {
    await start(rig().deps);
    const cases: Array<[string, string, string]> = [
      ["PATCH", "/watches", "GET, POST, OPTIONS"],
      ["DELETE", "/watches", "GET, POST, OPTIONS"],
      ["PUT", "/watches/x", "DELETE, OPTIONS"],
      ["POST", "/watches/x", "DELETE, OPTIONS"],
      ["POST", "/webhook", "GET, PUT, DELETE, OPTIONS"],
      ["GET", "/webhook/rotate-secret", "POST, OPTIONS"],
      ["PUT", "/webhook/deliveries", "GET, OPTIONS"],
    ];
    for (const [method, path, allow] of cases) {
      const response = await call(method, path);
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get("allow"), `${method} ${path}`).toBe(allow);
      expect((await json(response)).error.code).toBe("method_not_allowed");
    }
  });

  it("lets a page on another site make these calls, and still answers 405 for the rest of the API", async () => {
    await start(rig().deps);
    const preflight = await fetch(`${base}/api/v1/webhook`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, POST, PUT, DELETE, OPTIONS");
    const plain = await fetch(`${base}/api/v1/agents/robinhood/42`, { method: "DELETE" });
    expect(plain.status).toBe(405);
    expect(plain.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect((await fetch(`${base}/api/v1/watchlist`)).status).toBe(404);
  });
});

describe("the key's tier is read on each call", () => {
  it("lets a Pro key use all of it, and nothing here changes what the API says about an agent", async () => {
    const r = rig();
    await start(r.deps);
    expect((await call("POST", "/watches", KEY_PRO, { agents: [{ chain: "robinhood", id: "42" }] })).status).toBe(200);
    expect((await call("PUT", "/webhook", KEY_PRO, { url: "https://hooks.example.com/pro" })).status).toBe(200);
    expect(API_TIERS.free.perMinute).toBeLessThan(API_TIERS.builder.perMinute);
  });
});

describe("the service the server runs", () => {
  const saved = process.env.WEBHOOK_SIGNING_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.WEBHOOK_SIGNING_KEY;
    else process.env.WEBHOOK_SIGNING_KEY = saved;
    vi.resetModules();
    vi.restoreAllMocks();
  });
  const fresh = async () => {
    vi.resetModules();
    return (await import("./apiWebhooks")).sharedWebhookService();
  };

  it("is off without WEBHOOK_SIGNING_KEY, off with one that is too short (and says why in the log), and on with a good one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    delete process.env.WEBHOOK_SIGNING_KEY;
    expect(await fresh()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    process.env.WEBHOOK_SIGNING_KEY = "short";
    expect(await fresh()).toBeNull();
    expect(warn).toHaveBeenCalledWith("[Webhooks] off:", "WEBHOOK_SIGNING_KEY must be at least 32 characters");
    process.env.WEBHOOK_SIGNING_KEY = "k".repeat(40);
    const on = await fresh();
    expect(on).not.toBeNull();
    expect(on!.signingKey).toBe("k".repeat(40));
  });
});
