import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REGISTRY as VALIDATION_REGISTRY } from "../client/src/lib/validationRegistryReport";
import { ERC8004_CHAINS, ERC8004_REPUTATION_REGISTRY } from "./ingestion/erc8004Chains";
import { ROBINHOOD_REGISTRY_CHAIN, ROBINHOOD_RPC_URL } from "./ingestion/robinhood";
import { ROBINHOOD_REPUTATION_REGISTRY } from "./ingestion/robinhoodReputation";

/**
 * The upgrade tripwire (scripts/registry-tripwire.mjs, run once a day by deploy/vps/tripwire.sh). The three ERC-8004 registries are
 * upgradeable proxies, and what Nooscape reads and says rests on what each does. The script reads each proxy's implementation slot on
 * every chain the app reads and compares it with the implementation Nooscape verified. These tests hold the reading (a node that fails
 * is never "no change"), the comparison (a change is said, again on every run, and a quiet run is quiet), the secrecy of the node
 * addresses, the list of chains against the app's own, and the wiring from the image to the cron file.
 */

type Reading = { chain: string; registry: string; status: "read" | "unreadable"; implementation?: string | null; reason?: string };
type Slot = { status: "read"; implementation: string | null } | { status: "unreadable"; reason: string; unreachable: boolean };
type Deps = { fetchImpl?: typeof fetch; wait?: (ms: number) => Promise<void> };
type Tripwire = {
  IMPLEMENTATION_SLOT: string;
  REGISTRIES: readonly { name: string; title: string; proxy: string }[];
  CHAINS: readonly { key: string; label: string; chainId: number; env: string | null; rpcs: readonly string[] }[];
  PINS_VERIFIED: string;
  PINNED: Record<string, string>;
  PINNED_BY_CHAIN: Record<string, Record<string, string | null>>;
  pinFor: (chain: string, registry: string) => string | null;
  parseSlot: (result: unknown) => { ok: true; implementation: string | null } | { ok: false; reason: string };
  endpointsOf: (chain: { env: string | null; rpcs: readonly string[] }, env: Record<string, string | undefined>) => string[];
  readSlot: (endpoints: string[], proxy: string, deps?: Deps) => Promise<Slot>;
  readAll: (deps?: Deps & { env?: Record<string, string | undefined> }) => Promise<Reading[]>;
  evaluate: (readings: Reading[], options?: { now?: Date; heartbeat?: boolean }) => { lines: string[]; alerts: string[] };
  main: (options?: Deps & { argv?: string[]; env?: Record<string, string | undefined>; now?: Date; out?: (line: string) => void }) => Promise<number>;
};

const app = fileURLToPath(new URL("..", import.meta.url));
const kit = join(app, "deploy", "vps");
const tripwire = (await import(new URL("../scripts/registry-tripwire.mjs", import.meta.url).href)) as Tripwire;
const { CHAINS, REGISTRIES } = tripwire;

const MONDAY = new Date("2026-11-23T05:37:00Z");
const TUESDAY = new Date("2026-11-24T05:37:00Z");
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const NEW_IMPLEMENTATION = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ZERO = `0x${"0".repeat(40)}`;
const word = (address: string | null) => `0x${"0".repeat(24)}${(address ?? ZERO).slice(2)}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = (address: string | null) => json({ jsonrpc: "2.0", id: 1, result: word(address) });
const noWait = async () => {};

type Call = { url: string; body: { method: string; params: string[] } };
/** A fetch that records each call and answers with what the test says; an Error it returns is thrown, as a node that cannot be reached throws. */
function fakeNode(respond: (call: Call) => Response | Error) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), body: JSON.parse(String(init?.body)) };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Every proxy on every chain answers its pinned implementation, except the slots named (`chain:registry`). `hosts` names nodes outside the public lists. */
function serve(changes: Record<string, string | null> = {}, hosts: Record<string, string> = {}) {
  return fakeNode(call => {
    const host = new URL(call.url).host;
    const chain = CHAINS.find(entry => entry.rpcs.some(rpc => new URL(rpc).host === host))?.key ?? hosts[host];
    const registry = REGISTRIES.find(entry => entry.proxy.toLowerCase() === call.body.params[0].toLowerCase())?.name;
    if (!chain || !registry) return json({ jsonrpc: "2.0", id: 1, error: { message: "unknown" } });
    const key = `${chain}:${registry}`;
    return answer(key in changes ? changes[key] : tripwire.pinFor(chain, registry));
  });
}

/** One reading for each slot, each at its pin, except the slots named: an address or null for another implementation, or "unreadable". */
function readings(changes: Record<string, string | null> = {}, unreadable: string[] = []): Reading[] {
  return CHAINS.flatMap(chain =>
    REGISTRIES.map(registry => {
      const key = `${chain.key}:${registry.name}`;
      if (unreadable.includes(key)) return { chain: chain.key, registry: registry.name, status: "unreadable" as const, reason: "the node did not answer" };
      return { chain: chain.key, registry: registry.name, status: "read" as const, implementation: key in changes ? changes[key] : tripwire.pinFor(chain.key, registry.name) };
    })
  );
}

describe("what a storage word says", () => {
  it("is the address in its low 20 bytes, lower case, or no implementation when the slot is empty", () => {
    expect(tripwire.parseSlot(word("0x7274E874CA62410A93BD8BF61C69D8045E399C02"))).toEqual({ ok: true, implementation: "0x7274e874ca62410a93bd8bf61c69d8045e399c02" });
    expect(tripwire.parseSlot(word(null))).toEqual({ ok: true, implementation: null });
  });

  it("is nothing at all for an answer that is not an EIP-1967 slot, never an empty slot", () => {
    const bad = [undefined, null, 7, "", "0x", "0x1234", `${word(NEW_IMPLEMENTATION)}00`, `0x${"g".repeat(64)}`, `0x${"1".repeat(24)}${NEW_IMPLEMENTATION.slice(2)}`];
    for (const result of bad) expect(tripwire.parseSlot(result), String(result)).toMatchObject({ ok: false });
  });
});

describe("the pins", () => {
  it("are lower-case addresses, and a chain's own pin wins over the common one", () => {
    expect(tripwire.PINS_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const registry of REGISTRIES) expect(tripwire.PINNED[registry.name], registry.name).toMatch(/^0x[0-9a-f]{40}$/);
    for (const [chain, own] of Object.entries(tripwire.PINNED_BY_CHAIN)) {
      expect(CHAINS.some(entry => entry.key === chain), chain).toBe(true);
      for (const [registry, pin] of Object.entries(own)) {
        expect(REGISTRIES.some(entry => entry.name === registry), registry).toBe(true);
        expect(pin === null || /^0x[0-9a-f]{40}$/.test(pin), `${chain} ${registry}`).toBe(true);
        expect(tripwire.pinFor(chain, registry)).toBe(pin);
      }
    }
    expect(tripwire.pinFor("base", "identity")).toBe(tripwire.PINNED.identity);
  });

  it("are what the chains held on 2026-11-20, so that moving one is a deliberate edit of this test as well", () => {
    expect(tripwire.PINS_VERIFIED).toBe("2026-11-20");
    expect(tripwire.PINNED).toEqual({
      identity: "0x7274e874ca62410a93bd8bf61c69d8045e399c02",
      reputation: "0x16e0fa7f7c56b9a767e34b192b51f921be31da34",
      validation: "0xdb31f5d9167f8ebc8b30fbbf814c4d297c2d7f99",
    });
    expect(tripwire.PINNED_BY_CHAIN).toEqual({ robinhood: { validation: "0x1b325b4035d264fe04f40a632b6798771127c79a" } });
  });
});

describe("which nodes are asked", () => {
  it("is the app's own setting first when it is an https address, then the public nodes, and an unusable setting is left out", () => {
    const base = CHAINS.find(entry => entry.key === "base")!;
    expect(tripwire.endpointsOf(base, { BASE_RPC_URL: "https://node.example.test/v2/key" })).toEqual(["https://node.example.test/v2/key", ...base.rpcs]);
    expect(tripwire.endpointsOf(base, { BASE_RPC_URL: "  https://node.example.test/v2/key  " })[0]).toBe("https://node.example.test/v2/key");
    for (const setting of [undefined, "", "   ", "http://node.example.test/v2/key", "not an address"]) expect(tripwire.endpointsOf(base, { BASE_RPC_URL: setting }), String(setting)).toEqual([...base.rpcs]);
    const robinhood = CHAINS.find(entry => entry.key === "robinhood")!;
    expect(tripwire.endpointsOf(robinhood, { BASE_RPC_URL: "https://node.example.test/v2/key" })).toEqual([...robinhood.rpcs]);
  });
});

describe("reading one proxy's implementation slot", () => {
  const proxy = REGISTRIES[0].proxy;

  it("asks eth_getStorageAt for the EIP-1967 implementation slot of the proxy at the latest block, and reads the answer", async () => {
    const node = fakeNode(() => answer("0x7274e874ca62410a93bd8bf61c69d8045e399c02"));
    const read = await tripwire.readSlot(["https://node.example.test"], proxy, { fetchImpl: node.fetchImpl, wait: noWait });
    expect(read).toEqual({ status: "read", implementation: "0x7274e874ca62410a93bd8bf61c69d8045e399c02" });
    expect(node.calls).toHaveLength(1);
    expect(node.calls[0].body).toMatchObject({ jsonrpc: "2.0", method: "eth_getStorageAt", params: [proxy, tripwire.IMPLEMENTATION_SLOT, "latest"] });
    expect(tripwire.IMPLEMENTATION_SLOT).toBe("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
  });

  it("reads an empty slot as no implementation", async () => {
    const node = fakeNode(() => answer(null));
    expect(await tripwire.readSlot(["https://node.example.test"], proxy, { fetchImpl: node.fetchImpl, wait: noWait })).toEqual({ status: "read", implementation: null });
  });

  it("asks a busy node again, after a pause, and a node that limits its callers is a busy node", async () => {
    let n = 0;
    const waits: number[] = [];
    const node = fakeNode(() => (++n === 1 ? json({}, 429) : n === 2 ? json({ error: { message: "Too many requests" } }) : answer(NEW_IMPLEMENTATION)));
    const read = await tripwire.readSlot(["https://node.example.test"], proxy, { fetchImpl: node.fetchImpl, wait: async ms => void waits.push(ms) });
    expect(read).toEqual({ status: "read", implementation: NEW_IMPLEMENTATION });
    expect(node.calls).toHaveLength(3);
    expect(waits).toEqual([1_000, 3_000]);
  });

  it("goes to the next node when the first cannot be reached, after three tries", async () => {
    const node = fakeNode(call => (call.url.startsWith("https://down.example.test") ? new TypeError("fetch failed") : answer(NEW_IMPLEMENTATION)));
    const read = await tripwire.readSlot(["https://down.example.test", "https://up.example.test"], proxy, { fetchImpl: node.fetchImpl, wait: noWait });
    expect(read).toEqual({ status: "read", implementation: NEW_IMPLEMENTATION });
    expect(node.calls.map(call => new URL(call.url).host)).toEqual(["down.example.test", "down.example.test", "down.example.test", "up.example.test"]);
  });

  it("does not ask again a node that answered no or answered nonsense, and goes to the next", async () => {
    const node = fakeNode(call => {
      if (call.url.startsWith("https://no.example.test")) return json({ error: { message: "method not supported" } });
      if (call.url.startsWith("https://odd.example.test")) return json({ result: "0x1234" });
      return answer(NEW_IMPLEMENTATION);
    });
    const read = await tripwire.readSlot(["https://no.example.test", "https://odd.example.test", "https://up.example.test"], proxy, { fetchImpl: node.fetchImpl, wait: noWait });
    expect(read).toEqual({ status: "read", implementation: NEW_IMPLEMENTATION });
    expect(node.calls.map(call => new URL(call.url).host)).toEqual(["no.example.test", "odd.example.test", "up.example.test"]);
  });

  it("is not read, with a reason that names no node, when every node fails: never an empty slot and never the pin", async () => {
    const timeout = Object.assign(new Error("took too long"), { name: "TimeoutError" });
    for (const [failure, reason] of [
      [new TypeError("fetch failed: https://node.example.test/v2/secret-key"), "the node could not be reached"],
      [timeout, "the node timed out"],
      [json({}, 503), "the node answered HTTP 503"],
      [json({ result: "0x" }), "the node's answer was not a 32-byte word"],
    ] as const) {
      const node = fakeNode(() => failure);
      const read = await tripwire.readSlot(["https://node.example.test/v2/secret-key"], proxy, { fetchImpl: node.fetchImpl, wait: noWait });
      expect(read.status, reason).toBe("unreadable");
      expect(read).toMatchObject({ reason });
      expect(JSON.stringify(read)).not.toContain("secret-key");
    }
  });

  it("is not read when there is no node to ask", async () => {
    expect(await tripwire.readSlot([], proxy)).toMatchObject({ status: "unreadable", reason: "no node address is set" });
  });
});

describe("reading every slot", () => {
  it("reads each registry on each chain, one chain's registries one after another", async () => {
    const node = serve();
    const all = await tripwire.readAll({ env: {}, fetchImpl: node.fetchImpl, wait: noWait });
    expect(all).toHaveLength(CHAINS.length * REGISTRIES.length);
    expect(all.every(reading => reading.status === "read")).toBe(true);
    expect(all.map(reading => `${reading.chain}:${reading.registry}`)).toEqual(CHAINS.flatMap(chain => REGISTRIES.map(registry => `${chain.key}:${registry.name}`)));
    expect(node.calls).toHaveLength(CHAINS.length * REGISTRIES.length);
  });

  it("asks a chain whose node does not answer once, and reports its other registries as not read for the same reason", async () => {
    const arc = new URL(CHAINS.find(entry => entry.key === "arc")!.rpcs[0]).host;
    const healthy = serve();
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), body: JSON.parse(String(init?.body)) };
      calls.push(call);
      if (new URL(call.url).host === arc) throw new TypeError("fetch failed");
      return healthy.fetchImpl(input, init);
    }) as typeof fetch;
    const all = await tripwire.readAll({ env: {}, fetchImpl, wait: noWait });
    const arcReadings = all.filter(reading => reading.chain === "arc");
    expect(arcReadings.map(reading => reading.status)).toEqual(["unreadable", "unreadable", "unreadable"]);
    expect(new Set(arcReadings.map(reading => reading.reason))).toEqual(new Set(["the node could not be reached"]));
    expect(calls.filter(call => new URL(call.url).host === arc)).toHaveLength(3);
    expect(all.filter(reading => reading.chain !== "arc").every(reading => reading.status === "read")).toBe(true);
  });
});

describe("what the readings say", () => {
  const total = CHAINS.length * REGISTRIES.length;

  it("is nothing when every slot is at its pin, and one summary line for the log", () => {
    const { lines, alerts } = tripwire.evaluate(readings(), { now: TUESDAY });
    expect(alerts).toEqual([]);
    expect(lines[0]).toBe(`registry tripwire: ${total} slots on ${CHAINS.length} chains: ${total} match the pins of ${tripwire.PINS_VERIFIED}, 0 differ, 0 not read`);
    expect(lines).toHaveLength(total + 1);
    expect(lines.slice(1).every(line => line.endsWith("matches"))).toBe(true);
  });

  it("says it is watching on a Monday, or when asked, and only when there is nothing else to say", () => {
    expect(MONDAY.getUTCDay()).toBe(1);
    expect(TUESDAY.getUTCDay()).toBe(2);
    const monday = tripwire.evaluate(readings(), { now: MONDAY }).alerts;
    expect(monday).toEqual([`registry tripwire is watching: all ${total} proxy slots on ${CHAINS.length} chains match the pins of ${tripwire.PINS_VERIFIED}.`]);
    expect(tripwire.evaluate(readings(), { now: TUESDAY, heartbeat: true }).alerts).toEqual(monday);
    expect(tripwire.evaluate(readings({ "base:identity": NEW_IMPLEMENTATION }), { now: MONDAY, heartbeat: true }).alerts).toHaveLength(1);
    expect(tripwire.evaluate(readings({ "base:identity": NEW_IMPLEMENTATION }), { now: MONDAY, heartbeat: true }).alerts[0]).not.toContain("is watching");
  });

  it("says a changed slot with the chain, the registry, the new implementation and the one verified, and says it again on the next run", () => {
    const run = () => tripwire.evaluate(readings({ "base:identity": NEW_IMPLEMENTATION }), { now: TUESDAY });
    const { lines, alerts } = run();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(`Base Identity Registry now ${NEW_IMPLEMENTATION}, verified ${tripwire.PINNED.identity}`);
    expect(alerts[0]).toContain("1 proxy slot differs");
    expect(alerts[0]).toContain("update PINNED in scripts/registry-tripwire.mjs");
    expect(alerts[0]).toContain("repeats on every run");
    expect(alerts[0]).not.toContain("Ethereum");
    expect(lines[0]).toContain(`${total - 1} match the pins of ${tripwire.PINS_VERIFIED}, 1 differ, 0 not read`);
    expect(lines.filter(line => line.includes("DIFFERS"))).toEqual([`  base identity          ${NEW_IMPLEMENTATION}  DIFFERS, verified ${tripwire.PINNED.identity}`]);
    expect(run().alerts).toEqual(alerts);
  });

  it("says a chain's own pin, an emptied slot, and a proxy that has an implementation where none was expected", () => {
    expect(tripwire.evaluate(readings({ "robinhood:validation": tripwire.PINNED.validation }), { now: TUESDAY }).alerts[0]).toContain(`Robinhood Chain Validation Registry now ${tripwire.PINNED.validation}, verified ${tripwire.pinFor("robinhood", "validation")}`);
    expect(tripwire.evaluate(readings({ "base:validation": null }), { now: TUESDAY }).alerts[0]).toContain(`Base Validation Registry now no implementation, verified ${tripwire.PINNED.validation}`);
    const own = tripwire.PINNED_BY_CHAIN;
    const before = own.arc;
    try {
      own.arc = { validation: null };
      expect(tripwire.evaluate(readings({ "arc:validation": null }), { now: TUESDAY }).alerts).toEqual([]);
      expect(tripwire.evaluate(readings({ "arc:validation": NEW_IMPLEMENTATION }), { now: TUESDAY }).alerts[0]).toContain(`Arc Validation Registry now ${NEW_IMPLEMENTATION}, verified no implementation`);
    } finally {
      if (before === undefined) delete own.arc;
      else own.arc = before;
    }
  });

  it("says a slot that could not be read apart from a change, and never counts it as either a match or a change", () => {
    const { lines, alerts } = tripwire.evaluate(readings({}, ["monad:identity"]), { now: MONDAY });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("could not read 1 slot: Monad Identity Registry (the node did not answer)");
    expect(alerts[0]).not.toContain("registry change");
    expect(lines[0]).toContain(`${total - 1} match the pins of ${tripwire.PINS_VERIFIED}, 0 differ, 1 not read`);
    expect(lines).toContain("  monad identity         not read: the node did not answer");
    const both = tripwire.evaluate(readings({ "base:identity": NEW_IMPLEMENTATION }, ["monad:identity"]), { now: TUESDAY }).alerts;
    expect(both).toHaveLength(2);
    expect(both[0]).toContain("registry change");
    expect(both[1]).toContain("could not read");
  });

  it("lists the first few changes and counts the rest, so a message stays short", () => {
    const changes = Object.fromEntries(CHAINS.slice(0, 4).flatMap(chain => REGISTRIES.map(registry => [`${chain.key}:${registry.name}`, NEW_IMPLEMENTATION] as const)));
    const alert = tripwire.evaluate(readings(changes), { now: TUESDAY }).alerts[0];
    expect(alert).toContain("12 proxy slots differ");
    expect(alert).toContain("; and 6 more");
    expect(alert.length).toBeLessThan(1_500);
  });

  it("uses plain words: no long dash, and no address of a node", () => {
    const messy = tripwire.evaluate(readings({ "base:identity": NEW_IMPLEMENTATION, "arc:validation": null }, ["monad:identity", "gnosis:reputation"]), { now: MONDAY });
    for (const text of [...messy.lines, ...messy.alerts]) {
      expect(text).not.toMatch(LONG_DASHES);
      expect(text).not.toMatch(/https?:/);
    }
  });
});

describe("the whole run", () => {
  const run = async (options: Parameters<Tripwire["main"]>[0]) => {
    const out: string[] = [];
    const code = await tripwire.main({ wait: noWait, ...options, out: line => void out.push(line) });
    return { code, out };
  };

  it("is quiet when the chains hold what was verified, and exits 0", async () => {
    const node = serve();
    const { code, out } = await run({ argv: [], env: {}, fetchImpl: node.fetchImpl, now: TUESDAY });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^registry tripwire: \d+ slots on 8 chains: \d+ match the pins of 2026-11-20, 0 differ, 0 not read$/);
    expect(out.some(line => line.startsWith("ALERT: "))).toBe(false);
  });

  it("says an upgrade of one proxy on one chain as one ALERT line that names it", async () => {
    const node = serve({ "ethereum:reputation": NEW_IMPLEMENTATION });
    const { code, out } = await run({ argv: [], env: {}, fetchImpl: node.fetchImpl, now: TUESDAY });
    expect(code).toBe(0);
    const alerts = out.filter(line => line.startsWith("ALERT: "));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(`Ethereum Reputation Registry now ${NEW_IMPLEMENTATION}`);
  });

  it("asks the app's own node first and never prints it, not even when it fails", async () => {
    const secret = "https://base-mainnet.g.alchemy.com/v2/secret-key-123";
    const node = serve({}, { "base-mainnet.g.alchemy.com": "base" });
    const calls: string[] = [];
    const failingKeyed = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      if (String(input) === secret) return json({}, 500);
      return node.fetchImpl(input, init);
    }) as typeof fetch;
    // Three tries at the keyed node for each of Base's three registries, which fails, and then the public node answers: no alert, and
    // nothing printed names the keyed node.
    const { out } = await run({ argv: [], env: { BASE_RPC_URL: secret }, fetchImpl: failingKeyed, now: TUESDAY });
    expect(calls.filter(url => url === secret)).toHaveLength(9);
    expect(calls.indexOf(secret)).toBeLessThan(calls.indexOf("https://base-rpc.publicnode.com"));
    expect(out.join("\n")).not.toMatch(/secret-key|alchemy/i);
    expect(out.filter(line => line.startsWith("ALERT: "))).toEqual([]);
    const healthyKeyed = await run({ argv: [], env: { BASE_RPC_URL: secret }, fetchImpl: node.fetchImpl, now: TUESDAY });
    expect(healthyKeyed.out.join("\n")).not.toMatch(/secret-key|alchemy/i);
    expect(node.calls.some(call => call.url === secret)).toBe(true);
  });

  it("says the Monday line on --heartbeat and refuses an argument it does not know", async () => {
    const node = serve();
    const heartbeat = await run({ argv: ["--heartbeat"], env: {}, fetchImpl: node.fetchImpl, now: TUESDAY });
    expect(heartbeat.out.filter(line => line.startsWith("ALERT: registry tripwire is watching"))).toHaveLength(1);
    const unknown = await run({ argv: ["--now"], env: {}, fetchImpl: node.fetchImpl, now: TUESDAY });
    expect(unknown.code).toBe(2);
    expect(unknown.out).toEqual(["usage: node scripts/registry-tripwire.mjs [--heartbeat]"]);
  });
});

describe("the list of chains and registries against the app's own", () => {
  it("watches every chain the app reads, with the same chain id, node setting and registry addresses", () => {
    expect(CHAINS.map(chain => chain.key).sort()).toEqual(["robinhood", ...ERC8004_CHAINS.map(chain => chain.chainKey)].sort());
    const identity = REGISTRIES.find(registry => registry.name === "identity")!.proxy.toLowerCase();
    const reputation = REGISTRIES.find(registry => registry.name === "reputation")!.proxy.toLowerCase();
    for (const app of ERC8004_CHAINS) {
      const watched = CHAINS.find(chain => chain.key === app.chainKey)!;
      expect(watched.chainId, app.chainKey).toBe(app.chainId);
      expect(watched.env, app.chainKey).toBe(app.rpcEnvVar);
      expect(app.identityRegistry.toLowerCase(), app.chainKey).toBe(identity);
      if (app.reputation) expect(app.reputation.registry.toLowerCase(), app.chainKey).toBe(reputation);
    }
    const robinhood = CHAINS.find(chain => chain.key === "robinhood")!;
    expect(robinhood.chainId).toBe(ROBINHOOD_REGISTRY_CHAIN.chainId);
    expect(robinhood.env).toBeNull();
    expect(robinhood.rpcs).toContain(ROBINHOOD_RPC_URL);
    expect(ROBINHOOD_REGISTRY_CHAIN.registry.toLowerCase()).toBe(identity);
    expect(ROBINHOOD_REPUTATION_REGISTRY.toLowerCase()).toBe(reputation);
    expect(ERC8004_REPUTATION_REGISTRY.toLowerCase()).toBe(reputation);
    expect(REGISTRIES.find(registry => registry.name === "validation")!.proxy.toLowerCase()).toBe(VALIDATION_REGISTRY.address.toLowerCase());
  });

  it("names each public node once, over https, and no chain twice", () => {
    expect(new Set(CHAINS.map(chain => chain.key)).size).toBe(CHAINS.length);
    expect(new Set(CHAINS.map(chain => chain.chainId)).size).toBe(CHAINS.length);
    const hosts = CHAINS.flatMap(chain => chain.rpcs.map(rpc => new URL(rpc)));
    for (const url of hosts) expect(url.protocol, url.href).toBe("https:");
    expect(new Set(hosts.map(url => url.host)).size).toBe(hosts.length);
  });
});

// Read only where the tree has the deploy kit.
describe.skipIf(!existsSync(kit))("the wiring from the image to the schedule", () => {
  const read = (name: string) => readFileSync(join(kit, name), "utf8");

  it("copies the script into the image, runs it in the app container, and sends each ALERT line to notify.sh", () => {
    expect(read("Dockerfile")).toMatch(/^COPY .*scripts\/registry-tripwire\.mjs .*\.\/scripts\/$/m);
    expect(read("tripwire.sh")).toContain("docker compose exec -T app node scripts/registry-tripwire.mjs");
    expect(read("tripwire.sh")).toContain("sed -n 's/^ALERT: //p'");
    expect(read("tripwire.sh")).toContain('bash ./notify.sh "$message"');
  });

  it("runs once a day through run.sh, and is installed by host-setup.sh like the backup schedule", () => {
    const schedule = read("tripwire.cron")
      .split("\n")
      .filter(line => line.trim() !== "" && !line.startsWith("#") && !/^[A-Z]+=/.test(line));
    expect(schedule).toEqual(["37 5 * * * root bash $KIT/run.sh tripwire bash $KIT/tripwire.sh"]);
    expect(read("host-setup.sh")).toContain('install -m 0644 "$here/tripwire.cron" /etc/cron.d/nooscape-tripwire');
  });
});
