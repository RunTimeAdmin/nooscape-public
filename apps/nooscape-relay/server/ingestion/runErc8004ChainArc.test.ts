import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * The identity pass on Arc, run through the real RPC client against a fake node (fetch is stubbed), with a clock and a sleep the
 * test controls. Arc is the chain that shares a node with payment checks and whose host is the operator's own, so what is held
 * here is what that asks of the pass: it starts only while its switch is on and its endpoint is set and is the host the source
 * was staged on; its first call is the chain id; it makes one request at a time with a gap; it backs off and then stops with its
 * cursor kept; and nothing it throws, logs or records carries any part of X402_RPC. Every address and key below is made up.
 */
const state = vi.hoisted(() => ({
  beginIngestionRun: vi.fn(async (_source: unknown, _trigger: string) => "run-1"),
  finishIngestionRun: vi.fn(async (_input: unknown) => {}),
  keepWithinHostCap: vi.fn(async (_source: unknown, items: unknown[], _cap: number) => ({ kept: items, counted: 0 })),
  keepStoredTokens: vi.fn(async (_sourceId: string, events: unknown[]) => events),
  insertAgentRegistryRows: vi.fn(async (input: { drafts: unknown[] }) => input.drafts.length),
  applyAgentDirectoryActivityWindow: vi.fn(async (input: { activity: unknown[] }) => ({ acknowledgedCount: input.activity.length })),
  applyAgentRegistryUriUpdates: vi.fn(async (input: { updates: unknown[] }) => input.updates.length),
  refreshAgentRegistryListing: vi.fn(async (_source: unknown, _options: Record<string, unknown>) => ({ classified: false, published: null })),
  assertPublicHostname: vi.fn(async (_hostname: string) => {}),
}));

vi.mock("../db", () => ({
  beginIngestionRun: state.beginIngestionRun,
  finishIngestionRun: state.finishIngestionRun,
  applyAgentDirectoryActivityWindow: state.applyAgentDirectoryActivityWindow,
}));
vi.mock("../agentRegistryRows", () => ({
  insertAgentRegistryRows: state.insertAgentRegistryRows,
  keepWithinHostCap: state.keepWithinHostCap,
  keepStoredTokens: state.keepStoredTokens,
  applyAgentRegistryUriUpdates: state.applyAgentRegistryUriUpdates,
  refreshAgentRegistryListing: state.refreshAgentRegistryListing,
}));
vi.mock("./a2a", async importOriginal => ({ ...(await importOriginal<typeof import("./a2a")>()), assertPublicHostname: state.assertPublicHostname }));

import { Erc8004ChainOffError } from "./erc8004Chain";
import { ARC_CHAIN, ARC_LISTING_RULES } from "./erc8004Chains";
import { Erc8004RpcHttpError, Erc8004RpcNotConfiguredError } from "./erc8004Rpc";
import { hexNum, mintAt, registrationAt, uriUpdateAt } from "./erc8004TestChain";
import { runApprovedErc8004ChainSource } from "./runErc8004Chain";

const KEY = "K3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3y";
const HOST = "secret-node.example";
const PATH_PREFIX = "pfx-secret-9";
const ENDPOINT = `https://${HOST}/${PATH_PREFIX}/v1/${KEY}`;
const START = 21_156_191;
const W = ARC_CHAIN.maxLogRange;

function source(overrides: Record<string, unknown> = {}): IngestionSource {
  return {
    id: "source-arc",
    protocol: ARC_CHAIN.protocol,
    sourceKey: ARC_CHAIN.sourceKey,
    state: "active",
    rootUrl: `https://${HOST}`,
    allowedHostname: HOST,
    cursor: `arc:${START}`,
    executionPolicy: "manual_only",
    scheduleMinutes: 1_440,
    ...overrides,
  } as unknown as IngestionSource;
}

type NodeOptions = {
  finalized: number;
  chainId?: string;
  logs?: unknown[];
  /** The Response to send for the nth eth_getLogs call (from 1), or null to answer it properly. */
  getLogs?: (n: number, from: number) => Response | Error | null;
};

/** A fake Arc node behind a stubbed fetch, with the clock the pass is also given. */
function fakeNode(options: NodeOptions) {
  const clock = { now: 1_000_000 };
  const methods: string[] = [];
  const starts: number[] = [];
  const sleeps: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let logCalls = 0;
  const rpcResult = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  const handler = async (_url: string, init: RequestInit): Promise<Response> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      starts.push(clock.now);
      // Each request takes a few milliseconds, and yields, so two overlapping requests would be seen.
      await Promise.resolve();
      clock.now += 5;
      const request = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      methods.push(request.method);
      if (request.method === "eth_chainId") return rpcResult(options.chainId ?? ARC_CHAIN.chainIdHex);
      if (request.method === "eth_getBlockByNumber") return rpcResult({ number: hexNum(options.finalized) });
      if (request.method === "eth_getLogs") {
        logCalls += 1;
        const filter = request.params[0] as { fromBlock: string; toBlock: string };
        const from = Number.parseInt(filter.fromBlock, 16);
        const to = Number.parseInt(filter.toBlock, 16);
        const special = options.getLogs?.(logCalls, from);
        if (special instanceof Error) throw special;
        if (special) return special;
        return rpcResult((options.logs ?? []).filter(log => {
          const block = Number.parseInt((log as { blockNumber: string }).blockNumber, 16);
          return block >= from && block <= to;
        }));
      }
      throw new Error(`unexpected method ${request.method}`);
    } finally {
      inFlight -= 1;
    }
  };
  const deps = {
    now: () => clock.now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    random: () => 0,
  };
  return { handler, deps, clock, methods, starts, sleeps, stats: () => ({ maxInFlight, logCalls }) };
}

const run = (src: IngestionSource, node: ReturnType<typeof fakeNode>, extra: { budget?: Partial<typeof ARC_CHAIN.budget> } = {}) => {
  vi.stubGlobal("fetch", node.handler);
  return runApprovedErc8004ChainSource(ARC_CHAIN, src, "manual", "activity", { ...node.deps, ...extra });
};

let logged: string[] = [];
const capture = (...args: unknown[]) => void logged.push(args.map(arg => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));

beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.stubEnv("VITE_FEATURES", "chain_arc");
  vi.stubEnv("X402_RPC", ENDPOINT);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("starting the pass on Arc", () => {
  it("does not start while chain_arc is off: before any run row, any request, with a line in the log", async () => {
    vi.stubEnv("VITE_FEATURES", "chain_base,chain_ethereum");
    const node = fakeNode({ finalized: START + W });
    const error = await run(source(), node).catch(caught => caught as Error);
    expect(error).toBeInstanceOf(Erc8004ChainOffError);
    expect((error as Error).message).toBe("The Arc identity pass is switched off.");
    expect(state.beginIngestionRun).not.toHaveBeenCalled();
    expect(node.methods).toEqual([]);
    expect(logged).toContain("[ARC] the Arc identity pass was refused: its switch (chain_arc) is off.");
  });

  it("reports itself not configured when X402_RPC is unset, makes no request and keeps the cursor", async () => {
    vi.stubEnv("X402_RPC", "");
    const node = fakeNode({ finalized: START + W });
    const error = await run(source(), node).catch(caught => caught as Error);
    expect(error).toBeInstanceOf(Erc8004RpcNotConfiguredError);
    expect((error as Error).message).toBe("X402_RPC is not configured, so the Arc identity pass cannot run.");
    expect(node.methods).toEqual([]);
    expect(state.finishIngestionRun).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", nextCursor: `arc:${START}` }));
  });

  it("reports itself not configured when X402_RPC is not an https address", async () => {
    for (const value of ["http://secret-node.example/v1/x", "not an address", `https://user:${KEY}@${HOST}/v1/x`]) {
      vi.stubEnv("X402_RPC", value);
      const node = fakeNode({ finalized: START + W });
      const error = await run(source(), node).catch(caught => caught as Error);
      expect(error, value).toBeInstanceOf(Erc8004RpcNotConfiguredError);
      expect(node.methods, value).toEqual([]);
    }
  });

  it("refuses an endpoint on another host than the one the source was staged on, and asks nothing", async () => {
    vi.stubEnv("X402_RPC", `https://other-node.example/${PATH_PREFIX}/v1/${KEY}`);
    const node = fakeNode({ finalized: START + W });
    const error = await run(source(), node).catch(caught => caught as Error);
    expect(error).toBeInstanceOf(Erc8004RpcNotConfiguredError);
    expect((error as Error).message).toBe("X402_RPC does not point at the approved Arc RPC host.");
    expect(node.methods).toEqual([]);
    expect(state.assertPublicHostname).not.toHaveBeenCalled();
  });

  it("refuses a source whose origin is not its own host, which a staged row never is", async () => {
    const node = fakeNode({ finalized: START + W });
    await expect(run(source({ rootUrl: "https://elsewhere.example" }), node)).rejects.toThrow("Stored Arc source policy does not match the approved RPC host.");
    await expect(run(source({ rootUrl: `https://${HOST}/extra` }), node)).rejects.toThrow("Stored Arc source policy does not match the approved RPC host.");
    expect(node.methods).toEqual([]);
  });

  it("checks the staged host is a public one before it asks anything", async () => {
    const node = fakeNode({ finalized: START - 1 });
    await run(source(), node);
    expect(state.assertPublicHostname).toHaveBeenCalledWith(HOST);
    state.assertPublicHostname.mockRejectedValueOnce(new Error("The A2A hostname resolves to a forbidden network address."));
    const refused = fakeNode({ finalized: START - 1 });
    await expect(run(source(), refused)).rejects.toThrow("The Arc RPC host failed the public-network check: The A2A hostname resolves to a forbidden network address.");
    expect(refused.methods).toEqual([]);
  });

  it("asks the chain id first, and a wrong one stops the run before any block or log is asked", async () => {
    const node = fakeNode({ finalized: START + W, chainId: "0x1" });
    await expect(run(source(), node)).rejects.toThrow("Arc RPC did not confirm the approved chain id 5042.");
    expect(node.methods).toEqual(["eth_chainId"]);
    expect(state.insertAgentRegistryRows).not.toHaveBeenCalled();
  });
});

describe("the walk on a shared node", () => {
  const logs = [registrationAt(ARC_CHAIN, 7, START + 5), mintAt(ARC_CHAIN, 7, START + 5), uriUpdateAt(ARC_CHAIN, 7, START + 9)];

  it("reads the chain id, then the finalized block, then the windows, and writes the chain's cursor", async () => {
    const node = fakeNode({ finalized: START + 2 * W + 500, logs });
    const result = await run(source(), node);
    expect(node.methods).toEqual(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_getLogs", "eth_getLogs"]);
    expect(result).toMatchObject({ acceptedCount: 3, nextCursor: `arc:${START + 2 * W + 501}` });
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: true, rules: ARC_LISTING_RULES });
  });

  it("makes one request at a time, never two together", async () => {
    const node = fakeNode({ finalized: START + 5 * W, logs });
    await run(source(), node);
    expect(node.stats().maxInFlight).toBe(1);
    expect(node.stats().logCalls).toBe(6);
  });

  it("would make several together on a budget that allowed it, so the check above can fail", async () => {
    const node = fakeNode({ finalized: START + 5 * W, logs });
    // The pause between calls is for a run of one; the control takes it off to show requests do overlap when windows are fetched together.
    vi.stubGlobal("fetch", node.handler);
    const chain = { ...ARC_CHAIN, rpc: { ...ARC_CHAIN.rpc, minGapMs: 0 } };
    await runApprovedErc8004ChainSource(chain, source(), "manual", "activity", { ...node.deps, budget: { concurrency: 3 } });
    expect(node.stats().maxInFlight).toBeGreaterThan(1);
  });

  it("leaves at least the chain's gap between one request and the next", async () => {
    const node = fakeNode({ finalized: START + 3 * W, logs });
    await run(source(), node);
    const gaps = node.starts.slice(1).map((start, index) => start - node.starts[index]!);
    expect(gaps.length).toBe(node.starts.length - 1);
    // Each request takes 5 ms on the test's clock, so a start follows the last end by the gap.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(ARC_CHAIN.rpc.minGapMs! + 5);
  });

  it("plans no more than ten windows a run", async () => {
    const node = fakeNode({ finalized: START + 50 * W });
    const result = await run(source(), node);
    expect(node.stats().logCalls).toBe(10);
    expect(result.nextCursor).toBe(`arc:${START + 10 * W}`);
  });

  it("uses the chain's own listing rules for the step that applies URI updates, as for the listing", async () => {
    const node = fakeNode({ finalized: START + W, logs });
    await run(source(), node);
    expect(state.applyAgentRegistryUriUpdates).toHaveBeenCalledWith(expect.objectContaining({ rules: ARC_LISTING_RULES }));
  });
});

describe("a node that pushes back", () => {
  const status = (code: number) => new Response("", { status: code });

  it("backs off on a 429 on doubling waits, and goes on when the node answers", async () => {
    const node = fakeNode({ finalized: START + W - 1, getLogs: n => (n <= 2 ? status(429) : null) });
    const result = await run(source(), node);
    expect(node.sleeps.filter(ms => ms >= 1_000)).toEqual([1_000, 2_000]);
    expect(result.nextCursor).toBe(`arc:${START + W}`);
  });

  it("tries again after a timeout and after an answer that says the node is busy", async () => {
    const timedOut = fakeNode({ finalized: START + W - 1, getLogs: n => (n === 1 ? new DOMException("aborted", "AbortError") : null) });
    expect((await run(source(), timedOut)).nextCursor).toBe(`arc:${START + W}`);
    expect(timedOut.sleeps.filter(ms => ms >= 1_000)).toEqual([1_000]);
    const busy = fakeNode({
      finalized: START + W - 1,
      getLogs: n => (n === 1 ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit exceeded" } }), { status: 200 }) : null),
    });
    expect((await run(source(), busy)).nextCursor).toBe(`arc:${START + W}`);
  });

  it("stops, and keeps the cursor where it was, when the node keeps pushing back before any window is applied", async () => {
    const node = fakeNode({ finalized: START + 3 * W, getLogs: () => status(429) });
    const error = await run(source(), node).catch(caught => caught as Error);
    expect(error).toBeInstanceOf(Erc8004RpcHttpError);
    expect((error as Erc8004RpcHttpError).status).toBe(429);
    // The first try and one more after each of the three waits, then no more.
    expect(node.stats().logCalls).toBe(4);
    expect(node.sleeps.filter(ms => ms >= 1_000)).toEqual([1_000, 2_000, 4_000]);
    expect(state.finishIngestionRun).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", nextCursor: `arc:${START}` }));
    expect(state.insertAgentRegistryRows).not.toHaveBeenCalled();
  });

  it("stops after the windows it applied, keeping them, when the node pushes back later in the run", async () => {
    const node = fakeNode({ finalized: START + 3 * W, logs: [registrationAt(ARC_CHAIN, 7, START + 5)], getLogs: (_n, from) => (from >= START + W ? status(503) : null) });
    const result = await run(source(), node);
    expect(result.nextCursor).toBe(`arc:${START + W}`);
    expect(state.insertAgentRegistryRows).toHaveBeenCalledTimes(1);
    expect(logged.some(line => line.startsWith(`[ARC] pass stopped early at block ${START + W} after 1 window(s): Arc eth_getLogs returned HTTP 503.`))).toBe(true);
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: false, rules: ARC_LISTING_RULES });
  });
});

describe("what leaves the pass", () => {
  /** Everything a run can put out: what it throws, what it logs, and what it records about itself. */
  async function everythingOf(scenario: () => Promise<unknown>) {
    const outcome = await scenario().then(
      value => ({ value }),
      error => ({ error })
    );
    const parts = [JSON.stringify(outcome, (_key, value) => (value instanceof Error ? { name: value.name, message: value.message, cause: String(value.cause ?? "") } : value)), ...logged];
    // The run's own record is written whole, but for the source row, which legitimately holds the host the operator staged: what is
    // read of every write that carries the row is everything but the row.
    const withoutRow = (input: unknown) => ({ ...(input as object), source: undefined });
    parts.push(JSON.stringify(state.finishIngestionRun.mock.calls.map(([input]) => withoutRow(input))));
    for (const mock of [state.insertAgentRegistryRows, state.applyAgentRegistryUriUpdates, state.applyAgentDirectoryActivityWindow]) {
      parts.push(JSON.stringify(mock.mock.calls.map(([input]) => withoutRow(input))));
    }
    parts.push(JSON.stringify(state.refreshAgentRegistryListing.mock.calls.map(([, options]) => options)));
    return parts.join("\n");
  }
  const echo = (message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message } }), { status: 200 });
  const scenarios: Array<[string, () => Promise<unknown>]> = [
    ["a walk that succeeds", () => run(source(), fakeNode({ finalized: START + 2 * W, logs: [registrationAt(ARC_CHAIN, 7, START + 5)] }))],
    ["a node that keeps answering 429", () => run(source(), fakeNode({ finalized: START + W, getLogs: () => new Response("", { status: 429 }) }))],
    ["a node that echoes the whole address back", () => run(source(), fakeNode({ finalized: START + W, getLogs: () => echo(`cannot serve ${ENDPOINT}`) }))],
    ["a node that echoes the host and the path prefix back", () => run(source(), fakeNode({ finalized: START + W, getLogs: () => echo(`${HOST} refused /${PATH_PREFIX}/v1`) }))],
    ["a connection that fails with the address in its error", () => run(source(), fakeNode({ finalized: START + W, getLogs: () => new TypeError(`fetch failed for ${ENDPOINT}`) }))],
    ["a node that answers with something that is not JSON", () => run(source(), fakeNode({ finalized: START + W, getLogs: () => new Response(ENDPOINT, { status: 200 }) }))],
    ["a wrong chain id", () => run(source(), fakeNode({ finalized: START + W, chainId: "0x1" }))],
    ["an endpoint on another host", () => {
      vi.stubEnv("X402_RPC", `https://other-node.example/${PATH_PREFIX}/v1/${KEY}`);
      return run(source(), fakeNode({ finalized: START + W }));
    }],
    ["an endpoint that is unset", () => {
      vi.stubEnv("X402_RPC", "");
      return run(source(), fakeNode({ finalized: START + W }));
    }],
    ["a pass that is switched off", () => {
      vi.stubEnv("VITE_FEATURES", "");
      return run(source(), fakeNode({ finalized: START + W }));
    }],
  ];
  for (const [label, scenario] of scenarios) {
    it(`carries no part of X402_RPC in anything thrown, logged or recorded: ${label}`, async () => {
      const everything = await everythingOf(scenario);
      expect(everything).not.toContain(KEY);
      expect(everything).not.toContain(PATH_PREFIX);
      expect(everything).not.toContain("v1/K3y");
      expect(everything).not.toContain("secret-node");
      expect(everything).not.toContain("other-node");
    });
  }
});
