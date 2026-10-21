import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * The identity pass on Ethereum, Base and Arc, walking the real logs recorded from each (erc8004ChainFixtures.ts) through a fake
 * node, with the database layer mocked so every write is asserted exactly. What is held: the walk applies windows in chain order and
 * a registration before the update that follows it, advances the cursor only past windows it applied, resumes after a failure
 * without applying anything twice, stops at its budget without publishing, and is quiet once caught up. The same behaviour, on three
 * chains whose ranges, caps and cursors differ, is the point: nothing in the pass is one chain's.
 */
const state = vi.hoisted(() => {
  const order: string[] = [];
  const lastId = (key: string) => key.split(":").pop();
  return {
    order,
    beginIngestionRun: vi.fn(async (_source: unknown, _trigger: string) => "run-1"),
    finishIngestionRun: vi.fn(async (_input: unknown) => {}),
    insertAgentRegistryRows: vi.fn(async (input: { drafts: Array<{ externalKey: string }> }) => {
      order.push(...input.drafts.map(draft => `entries:${lastId(draft.externalKey)}`));
      return input.drafts.length;
    }),
    applyAgentDirectoryActivityWindow: vi.fn(async (input: { activity: Array<{ kind: string; externalKey: string }> }) => {
      order.push(...input.activity.map(event => `${event.kind}:${lastId(event.externalKey)}`));
      return { acknowledgedCount: input.activity.length };
    }),
    keepWithinHostCap: vi.fn(async (_source: unknown, items: unknown[], _cap: number) => ({ kept: items, counted: 0 })),
    keepStoredTokens: vi.fn(async (_sourceId: string, events: unknown[]) => events),
    applyAgentRegistryUriUpdates: vi.fn(async (input: { updates: Array<{ externalKey: string }> }) => {
      order.push(...input.updates.map(update => `uri:${lastId(update.externalKey)}`));
      return input.updates.length;
    }),
    refreshAgentRegistryListing: vi.fn(async (_source: unknown, _options: Record<string, unknown>) => ({ classified: false, published: null })),
  };
});

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

import { Erc8004ChainOffError } from "./erc8004Chain";
import { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN, type Erc8004Chain } from "./erc8004Chains";
import { ARC_FIXTURES, BASE_FIXTURES, ETHEREUM_FIXTURES, type ChainFixtureLog, type ChainFixtures } from "./erc8004ChainFixtures";
import { runApprovedErc8004ChainSource } from "./runErc8004Chain";

const CASES: Array<[string, Erc8004Chain, ChainFixtures]> = [
  ["Ethereum", ETHEREUM_CHAIN, ETHEREUM_FIXTURES],
  ["Base", BASE_CHAIN, BASE_FIXTURES],
  ["Arc", ARC_CHAIN, ARC_FIXTURES],
];
const hex = (value: number) => `0x${value.toString(16)}`;
const blockOf = (log: ChainFixtureLog) => Number.parseInt(log.blockNumber as string, 16);
const allLogs = (fixtures: ChainFixtures): ChainFixtureLog[] => [
  ...Object.values(fixtures.registered).map(entry => entry.log),
  ...Object.values(fixtures.mints),
  fixtures.secondary.log,
  ...fixtures.uriUpdates.map(update => update.log),
];
/** Wide enough to walk the whole recorded span in one run, whatever the chain's own budget. */
const WALK_ALL = { maxWindows: 100_000, maxEvents: 1_000_000, maxElapsedMs: 120_000 };

function sourceFor(chain: Erc8004Chain, cursor: string | null): IngestionSource {
  const policy = chain.provider.kind === "pinned" ? chain.provider : { rootUrl: "https://arc-node.example", allowedHostname: "arc-node.example" };
  return {
    id: `source-${chain.chainKey}`,
    protocol: chain.protocol,
    sourceKey: chain.sourceKey,
    state: "active",
    rootUrl: policy.rootUrl,
    allowedHostname: policy.allowedHostname,
    cursor,
    executionPolicy: "manual_only",
    scheduleMinutes: 1_440,
  } as unknown as IngestionSource;
}

function fakeNode(chain: Erc8004Chain, fixtures: ChainFixtures, finalized: number, failAt: (from: number) => Error | null = () => null) {
  const logs = allLogs(fixtures);
  const asked: Array<[number, number]> = [];
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    if (method === "eth_chainId") return fixtures.chainId;
    if (method === "eth_getBlockByNumber") return { ...fixtures.finalized, number: hex(finalized) };
    if (method === "eth_getLogs") {
      const filter = params[0] as { fromBlock: string; toBlock: string; address: string };
      expect(filter.address).toBe(chain.identityRegistry);
      const from = Number.parseInt(filter.fromBlock, 16);
      const to = Number.parseInt(filter.toBlock, 16);
      const failure = failAt(from);
      if (failure) throw failure;
      asked.push([from, to]);
      return logs.filter(log => blockOf(log) >= from && blockOf(log) <= to);
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, asked };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.order.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("VITE_FEATURES", "chain_ethereum,chain_base,chain_arc");
});
afterEach(() => vi.unstubAllEnvs());

describe.each(CASES)("the %s pass on its recording", (_name, chain, fixtures) => {
  const blocks = allLogs(fixtures).map(blockOf);
  const start = Math.min(...blocks) - 10;
  const finalized = Math.max(...blocks) + 20;
  const registrations = Object.keys(fixtures.registered).length;
  const cursor = (next: number) => `${chain.cursorPrefix}:${next}`;
  const rules = chain.listingRules;

  it("walks the span in windows no wider than the chain's own range, and ends one block past the finalized head", async () => {
    const node = fakeNode(chain, fixtures, finalized);
    const result = await runApprovedErc8004ChainSource(chain, sourceFor(chain, cursor(start)), "manual", "activity", { rpc: node.rpc, budget: WALK_ALL });
    expect(result.nextCursor).toBe(cursor(finalized + 1));
    expect(node.asked[0]![0]).toBe(start);
    for (const [from, to] of node.asked) expect(to - from + 1).toBeLessThanOrEqual(chain.maxLogRange);
    // Consecutive, in order, with nothing skipped and nothing read twice.
    node.asked.forEach(([from], index) => {
      if (index > 0) expect(from).toBe(node.asked[index - 1]![1] + 1);
    });
    expect(node.asked.at(-1)![1]).toBe(finalized);
    expect(Math.ceil((finalized - start + 1) / chain.maxLogRange)).toBe(node.asked.length);
  });

  it("stores every registration, mint, change of hands and URI update once, and counts them", async () => {
    const node = fakeNode(chain, fixtures, finalized);
    const result = await runApprovedErc8004ChainSource(chain, sourceFor(chain, cursor(start)), "manual", "activity", { rpc: node.rpc, budget: WALK_ALL });
    const expectedAccepted = registrations + registrations + 1 + fixtures.uriUpdates.length;
    expect(result).toMatchObject({ discoveredCount: allLogs(fixtures).length, acceptedCount: expectedAccepted, rejectedCount: 0 });
    const keys = state.insertAgentRegistryRows.mock.calls.flatMap(([input]) => input.drafts.map(draft => draft.externalKey));
    expect(keys).toHaveLength(registrations);
    expect(new Set(keys).size).toBe(registrations);
    for (const key of keys) expect(key.startsWith(`eip155:${chain.chainId}:${chain.identityRegistry}:`)).toBe(true);
    expect(state.order.filter(entry => entry.startsWith("mint:"))).toHaveLength(registrations);
    expect(state.order.filter(entry => entry.startsWith("secondary:"))).toHaveLength(1);
    expect(state.order.filter(entry => entry.startsWith("uri_update:"))).toHaveLength(fixtures.uriUpdates.length);
    expect(state.order.filter(entry => entry.startsWith("uri:"))).toHaveLength(fixtures.uriUpdates.length);
  });

  it("applies a registration before the URI update that follows it, whatever order the node answered in", async () => {
    await runApprovedErc8004ChainSource(chain, sourceFor(chain, cursor(start)), "manual", "activity", { rpc: fakeNode(chain, fixtures, finalized).rpc, budget: WALK_ALL });
    for (const update of fixtures.uriUpdates) {
      const registered = state.order.indexOf(`entries:${update.agentId}`);
      if (registered === -1) continue;
      expect(registered, `agent ${update.agentId}`).toBeLessThan(state.order.indexOf(`uri:${update.agentId}`));
    }
  });

  it("classifies what it wrote and, once every finalized block is read, publishes against this chain's own rules", async () => {
    await runApprovedErc8004ChainSource(chain, sourceFor(chain, cursor(start)), "manual", "activity", { rpc: fakeNode(chain, fixtures, finalized).rpc, budget: WALK_ALL });
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: true, rules });
    expect(state.applyAgentRegistryUriUpdates).toHaveBeenCalledWith(expect.objectContaining({ rules }));
    expect(state.applyAgentDirectoryActivityWindow).toHaveBeenCalledWith(expect.objectContaining({ handoutBlockWindow: chain.handoutBlockWindow, incrementalRollup: true, rollupTarget: "registry" }));
  });

  it("is quiet once caught up: nothing written, the cursor where it was, and a publish of whatever was classified", async () => {
    const node = fakeNode(chain, fixtures, finalized);
    const result = await runApprovedErc8004ChainSource(chain, sourceFor(chain, cursor(finalized + 1)), "manual", "activity", { rpc: node.rpc });
    expect(result).toMatchObject({ acceptedCount: 0, rejectedCount: 0, nextCursor: cursor(finalized + 1) });
    expect(node.asked).toEqual([]);
    expect(state.insertAgentRegistryRows).not.toHaveBeenCalled();
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: false, publish: true, rules });
  });

  it("stops at its event budget and does not publish while windows remain", async () => {
    const node = fakeNode(chain, fixtures, finalized);
    const result = await runApprovedErc8004ChainSource(chain, sourceFor(chain, cursor(start)), "manual", "activity", { rpc: node.rpc, budget: { ...WALK_ALL, maxEvents: 1, concurrency: 1 } });
    expect(Number.parseInt(result.nextCursor!.split(":")[1]!, 10)).toBeLessThan(finalized + 1);
    expect(result.acceptedCount).toBeGreaterThanOrEqual(1);
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: false, rules });
  });

  it("stops at its window budget at a window boundary, and a later run carries on from there to the same end", async () => {
    const first = fakeNode(chain, fixtures, finalized);
    const one = await runApprovedErc8004ChainSource(chain, sourceFor(chain, cursor(start)), "manual", "activity", { rpc: first.rpc, budget: { ...WALK_ALL, maxWindows: 3 } });
    expect(one.nextCursor).toBe(cursor(start + 3 * chain.maxLogRange));
    expect(first.asked).toHaveLength(3);
    const second = fakeNode(chain, fixtures, finalized);
    const two = await runApprovedErc8004ChainSource(chain, sourceFor(chain, one.nextCursor), "manual", "activity", { rpc: second.rpc, budget: WALK_ALL });
    expect(two.nextCursor).toBe(cursor(finalized + 1));
    expect(second.asked[0]![0]).toBe(start + 3 * chain.maxLogRange);
  });

  it("resumes after a later window fails without applying any registration twice", async () => {
    // The second window fails, so the first has been applied: a fault before any progress fails the run loudly instead (see below).
    const secondWindow = start + chain.maxLogRange;
    const firstNode = fakeNode(chain, fixtures, finalized, from => (from === secondWindow ? new Error("provider fault") : null));
    const stopped = await runApprovedErc8004ChainSource(chain, sourceFor(chain, cursor(start)), "manual", "activity", { rpc: firstNode.rpc, budget: { ...WALK_ALL, concurrency: 1 } });
    expect(stopped.nextCursor).toBe(cursor(secondWindow));
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toMatchObject({ publish: false });
    const secondNode = fakeNode(chain, fixtures, finalized);
    const done = await runApprovedErc8004ChainSource(chain, sourceFor(chain, stopped.nextCursor), "manual", "activity", { rpc: secondNode.rpc, budget: WALK_ALL });
    expect(done.nextCursor).toBe(cursor(finalized + 1));
    expect(secondNode.asked[0]![0]).toBe(secondWindow);
    const keys = state.insertAgentRegistryRows.mock.calls.flatMap(([input]) => input.drafts.map(draft => draft.externalKey));
    expect(keys).toHaveLength(registrations);
    expect(new Set(keys).size).toBe(registrations);
  });

  it("fails the run, with the cursor where it was, when the first window fails", async () => {
    const node = fakeNode(chain, fixtures, finalized, from => (from === start ? new Error("provider fault") : null));
    await expect(runApprovedErc8004ChainSource(chain, sourceFor(chain, cursor(start)), "manual", "activity", { rpc: node.rpc, budget: { ...WALK_ALL, concurrency: 1 } })).rejects.toThrow("provider fault");
    expect(state.finishIngestionRun).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", nextCursor: cursor(start) }));
    expect(state.insertAgentRegistryRows).not.toHaveBeenCalled();
  });

  it("fails closed on a cursor that is another chain's, malformed, or from before this chain's registry existed", async () => {
    const node = fakeNode(chain, fixtures, finalized);
    for (const bad of ["bsc:79027268", `${chain.cursorPrefix}:abc`, `${chain.cursorPrefix}:${chain.deployBlock - 1}`, `${chain.cursorPrefix}:-5`, "garbage"]) {
      await expect(runApprovedErc8004ChainSource(chain, sourceFor(chain, bad), "manual", "activity", { rpc: node.rpc }), bad).rejects.toThrow(/cursor|walk position/);
    }
    expect(node.asked).toEqual([]);
  });

  it("starts a fresh source at this chain's deploy block", async () => {
    const node = fakeNode(chain, fixtures, chain.deployBlock + 5);
    const result = await runApprovedErc8004ChainSource(chain, sourceFor(chain, null), "manual", "activity", { rpc: node.rpc, budget: WALK_ALL });
    expect(node.asked[0]![0]).toBe(chain.deployBlock);
    expect(result.nextCursor).toBe(cursor(chain.deployBlock + 6));
  });
});

describe.each(CASES)("the %s switch", (_name, chain, fixtures) => {
  const others = CASES.map(([, candidate]) => candidate).filter(candidate => candidate !== chain);

  it("keeps the pass from starting while it is off, whichever other chains are on: no run row, no request", async () => {
    vi.stubEnv("VITE_FEATURES", others.map(candidate => candidate.feature).join(","));
    const node = fakeNode(chain, fixtures, chain.deployBlock + 5);
    await expect(runApprovedErc8004ChainSource(chain, sourceFor(chain, null), "manual", "activity", { rpc: node.rpc })).rejects.toBeInstanceOf(Erc8004ChainOffError);
    expect(state.beginIngestionRun).not.toHaveBeenCalled();
    expect(node.asked).toEqual([]);
  });

  it("starts once its own switch alone is on, and refuses a scheduled run from a source that was never handed to the scheduler", async () => {
    vi.stubEnv("VITE_FEATURES", chain.feature!);
    const node = fakeNode(chain, fixtures, chain.deployBlock - 1);
    await expect(runApprovedErc8004ChainSource(chain, sourceFor(chain, null), "manual", "activity", { rpc: node.rpc })).resolves.toBeDefined();
    expect(state.beginIngestionRun).toHaveBeenCalledTimes(1);
    await expect(runApprovedErc8004ChainSource(chain, sourceFor(chain, null), "scheduled", "activity", { rpc: node.rpc })).rejects.toThrow(/require the scheduled execution policy/);
  });
});
