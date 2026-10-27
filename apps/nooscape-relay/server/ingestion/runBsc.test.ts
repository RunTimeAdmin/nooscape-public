import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * Orchestrator tests for the BNB Chain identity pass. The database layer is
 * mocked and the RPC is a fake that serves real fixture logs, so every write is
 * asserted exactly. The properties that matter: windows are applied strictly in
 * chain order however their fetches finish, the cursor advances only past
 * windows that were fully applied, progress survives a later failure, the
 * guards fire before any run row exists, registrations go to the registry rows
 * (never straight into the directory), and the listing refresh publishes only
 * once the walk is caught up and never fails a run.
 */
const state = vi.hoisted(() => {
  const order: string[] = [];
  const lastId = (key: string) => key.split(":").pop();
  return {
    order,
    beginIngestionRun: vi.fn(async (_source: unknown, _trigger: string) => "run-1"),
    finishIngestionRun: vi.fn(async (_input: unknown) => {}),
    insertAgentRegistryRows: vi.fn(async (input: { drafts: Array<{ externalKey: string }> }) => {
      order.push(`entries:${input.drafts.map(draft => lastId(draft.externalKey)).join(",")}`);
      return input.drafts.length;
    }),
    applyAgentDirectoryActivityWindow: vi.fn(async (input: { activity: unknown[] }) => {
      order.push(`ledger:${input.activity.length}`);
      return { acknowledgedCount: input.activity.length };
    }),
    applyAgentRegistryUriUpdates: vi.fn(async (input: { updates: Array<{ externalKey: string }> }) => {
      order.push(`uri:${input.updates.map(update => lastId(update.externalKey)).join(",")}`);
      return input.updates.length;
    }),
    refreshAgentRegistryListing: vi.fn(async (_source: unknown, _options: { classify: boolean; publish: boolean }) => ({ classified: false, published: null })),
  };
});

vi.mock("../db", () => ({
  beginIngestionRun: state.beginIngestionRun,
  finishIngestionRun: state.finishIngestionRun,
  applyAgentDirectoryActivityWindow: state.applyAgentDirectoryActivityWindow,
}));

vi.mock("../agentRegistryRows", () => ({
  insertAgentRegistryRows: state.insertAgentRegistryRows,
  applyAgentRegistryUriUpdates: state.applyAgentRegistryUriUpdates,
  refreshAgentRegistryListing: state.refreshAgentRegistryListing,
}));

import {
  BSC_ALLOWED_HOSTNAME,
  BSC_DEPLOY_BLOCK,
  BSC_IDENTITY_REGISTRY,
  BSC_IDENTITY_TOPIC_FILTER,
  BSC_MAX_LOG_RANGE,
  BSC_ROOT_URL,
  BSC_SOURCE_KEY,
  BscRegistryValidationError,
} from "./bscChain";
import { BSC_FIXTURE_MINTS, BSC_FIXTURE_REGISTERED, BSC_FIXTURE_URI_UPDATES } from "./bscFixtures";
import { BscRpcError, BscRpcRangeError } from "./bscRpc";
import { runApprovedBscRegistrySource } from "./runBsc";

const hexNum = (value: number) => `0x${value.toString(16)}`;
const word = (value: number) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;

type LogShape = Record<string, unknown> & { topics: string[] };
const regBase = BSC_FIXTURE_REGISTERED.empty!.log as LogShape;
const mintBase = BSC_FIXTURE_MINTS["6"]! as LogShape;
const updateBase = BSC_FIXTURE_URI_UPDATES[1]!.log as LogShape;

/** A registration (empty URI), the mint that goes with it, and a later URI update, cloned from real logs. */
const registration = (agentId: number, block: number, logIndex = 0): LogShape => ({
  ...regBase,
  blockNumber: hexNum(block),
  logIndex: hexNum(logIndex),
  transactionHash: word(block * 100 + logIndex),
  topics: [regBase.topics[0]!, word(agentId), regBase.topics[2]!],
});
const mint = (agentId: number, block: number, logIndex = 1): LogShape => ({
  ...mintBase,
  blockNumber: hexNum(block),
  logIndex: hexNum(logIndex),
  transactionHash: word(block * 100 + logIndex),
  topics: [mintBase.topics[0]!, mintBase.topics[1]!, mintBase.topics[2]!, word(agentId)],
});
const uriUpdate = (agentId: number, block: number, logIndex = 2): LogShape => ({
  ...updateBase,
  blockNumber: hexNum(block),
  logIndex: hexNum(logIndex),
  transactionHash: word(block * 100 + logIndex),
  topics: [updateBase.topics[0]!, word(agentId), updateBase.topics[2]!],
});

/** An ABI-encoded string, the way a URIUpdated event carries its new URI. */
const abiString = (value: string) => {
  const bytes = Buffer.from(value, "utf8");
  const padded = Buffer.concat([bytes, Buffer.alloc((32 - (bytes.length % 32)) % 32)]);
  return `0x${word(32).slice(2)}${word(bytes.length).slice(2)}${padded.toString("hex")}`;
};

const START = 79_258_000;
const W = BSC_MAX_LOG_RANGE;

function source(overrides: Record<string, unknown> = {}): IngestionSource {
  return {
    id: "source-bsc",
    protocol: "erc8004_bsc",
    sourceKey: BSC_SOURCE_KEY,
    state: "active",
    rootUrl: BSC_ROOT_URL,
    allowedHostname: BSC_ALLOWED_HOSTNAME,
    cursor: `bsc:${START}`,
    executionPolicy: "manual_only",
    scheduleMinutes: 1_440,
    ...overrides,
  } as unknown as IngestionSource;
}

type FakeOptions = {
  finalized: number;
  logs?: unknown[];
  chainId?: string;
  /** Throw for a getLogs call whose fromBlock matches. */
  failAt?: (from: number, to: number) => Error | null;
  /** Milliseconds to delay a getLogs call, by fromBlock. */
  delayAt?: (from: number) => number;
};

function fakeRpc(options: FakeOptions) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push({ method, params });
    if (method === "eth_chainId") return options.chainId ?? "0x38";
    if (method === "eth_getBlockByNumber") return { number: hexNum(options.finalized) };
    if (method === "eth_getLogs") {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      const from = Number.parseInt(filter.fromBlock, 16);
      const to = Number.parseInt(filter.toBlock, 16);
      const delay = options.delayAt?.(from) ?? 0;
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      const failure = options.failAt?.(from, to);
      if (failure) throw failure;
      return (options.logs ?? []).filter(log => {
        const block = Number.parseInt((log as { blockNumber: string }).blockNumber, 16);
        return block >= from && block <= to;
      });
    }
    throw new Error(`unexpected method ${method}`);
  };
  const logCalls = () => calls.filter(call => call.method === "eth_getLogs").map(call => call.params[0] as { fromBlock: string; toBlock: string; address: string; topics: unknown });
  return { rpc, calls, logCalls };
}

const finishedWith = (matcher: Record<string, unknown>) => expect(state.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining(matcher));

beforeEach(() => {
  vi.clearAllMocks();
  state.order.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("guards fire before any run row exists", () => {
  it("rejects replays, unattended runs from an unscheduled source, other sources, and every mode but the chain pass", async () => {
    const { rpc } = fakeRpc({ finalized: START + 10 });
    await expect(runApprovedBscRegistrySource(source(), "replay", "activity", { rpc })).rejects.toThrow(/replays are rejected outright/);
    await expect(runApprovedBscRegistrySource(source(), "scheduled", "activity", { rpc })).rejects.toThrow(/scheduled execution policy/);
    await expect(runApprovedBscRegistrySource(source({ protocol: "erc8004" }), "manual", "activity", { rpc })).rejects.toThrow(/approved for the BNB Chain/);
    await expect(runApprovedBscRegistrySource(source({ sourceKey: "something-else" }), "manual", "activity", { rpc })).rejects.toThrow(/approved for the BNB Chain/);
    for (const mode of ["observe", "backfill", "registrants"] as const) {
      await expect(runApprovedBscRegistrySource(source(), "manual", mode, { rpc })).rejects.toThrow(/one surface, the chain pass/);
    }
    expect(state.beginIngestionRun).not.toHaveBeenCalled();
  });

  it("accepts an unattended run once the source holds the scheduled policy", async () => {
    const { rpc } = fakeRpc({ finalized: START + 10 });
    await runApprovedBscRegistrySource(source({ executionPolicy: "scheduled" }), "scheduled", "activity", { rpc });
    expect(state.beginIngestionRun).toHaveBeenCalledWith(expect.anything(), "scheduled");
  });
});

describe("faults before any read are recorded as failed runs with the prior cursor", () => {
  it.each([
    ["an inactive source", { state: "paused" }, /Only active sources/],
    ["a source whose host is not the approved one", { allowedHostname: "evil.example.com" }, /does not match the approved RPC host/],
    ["a source whose root URL is not the approved one", { rootUrl: "https://evil.example.com" }, /does not match the approved RPC host/],
  ])("%s", async (_label, overrides, message) => {
    const { rpc, calls } = fakeRpc({ finalized: START + 10 });
    await expect(runApprovedBscRegistrySource(source(overrides), "manual", "activity", { rpc })).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
    finishedWith({ status: "failed", nextCursor: `bsc:${START}` });
  });

  it("refuses an endpoint that does not confirm chain 56", async () => {
    const { rpc } = fakeRpc({ finalized: START + 10, chainId: "0x1" });
    await expect(runApprovedBscRegistrySource(source(), "manual", "activity", { rpc })).rejects.toThrow(/chain id 56/);
    finishedWith({ status: "failed", nextCursor: `bsc:${START}` });
    expect(state.insertAgentRegistryRows).not.toHaveBeenCalled();
    expect(state.refreshAgentRegistryListing).not.toHaveBeenCalled();
  });
});

describe("a caught-up walk is a quiet success", () => {
  it("writes nothing and leaves the cursor exactly where it was", async () => {
    const { rpc, logCalls } = fakeRpc({ finalized: START - 1 });
    const result = await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    expect(result).toMatchObject({ discoveredCount: 0, acceptedCount: 0, rejectedCount: 0, nextCursor: `bsc:${START}` });
    expect(logCalls()).toHaveLength(0);
    expect(state.insertAgentRegistryRows).not.toHaveBeenCalled();
    finishedWith({ status: "completed", nextCursor: `bsc:${START}` });
  });

  it("starts a fresh source at the deploy block", async () => {
    const { rpc, logCalls } = fakeRpc({ finalized: BSC_DEPLOY_BLOCK + 10 });
    const result = await runApprovedBscRegistrySource(source({ cursor: null }), "manual", "activity", { rpc });
    expect(logCalls()[0]!.fromBlock).toBe(hexNum(BSC_DEPLOY_BLOCK));
    expect(result.nextCursor).toBe(`bsc:${BSC_DEPLOY_BLOCK + 11}`);
  });
});

describe("a normal run", () => {
  const logs = [registration(6, START + 145), mint(6, START + 145), uriUpdate(6, START + 254), registration(7, START + W + 5), mint(7, START + W + 5)];

  it("asks for each window with the approved address, the three event topics, and exact bounds", async () => {
    const { rpc, logCalls } = fakeRpc({ finalized: START + 3 * W - 1, logs });
    await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    expect(logCalls().map(call => [call.fromBlock, call.toBlock])).toEqual([
      [hexNum(START), hexNum(START + W - 1)],
      [hexNum(START + W), hexNum(START + 2 * W - 1)],
      [hexNum(START + 2 * W), hexNum(START + 3 * W - 1)],
    ]);
    for (const call of logCalls()) {
      expect(call.address).toBe(BSC_IDENTITY_REGISTRY);
      expect(call.topics).toEqual(BSC_IDENTITY_TOPIC_FILTER);
    }
  });

  it("writes registry rows (not directory entries), then the ledger with the BSC hour and an incremental rollup onto them, then the URI facts", async () => {
    const { rpc } = fakeRpc({ finalized: START + W - 1, logs });
    const result = await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    expect(state.order).toEqual(["entries:6", "ledger:2", "uri:6"]);
    expect(state.insertAgentRegistryRows).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }));
    expect(state.applyAgentDirectoryActivityWindow).toHaveBeenCalledWith(
      expect.objectContaining({ handoutBlockWindow: 8_000, incrementalRollup: true, rollupTarget: "registry" })
    );
    // The fixture registration set no URI, so it is born excluded; a registration with a link is born pending.
    const drafts = (state.insertAgentRegistryRows.mock.calls[0]![0] as { drafts: Array<Record<string, unknown>> }).drafts;
    expect(drafts[0]).toMatchObject({ externalKey: `eip155:56:${BSC_IDENTITY_REGISTRY}:6`, listing: 0 });
    const update = (state.applyAgentRegistryUriUpdates.mock.calls[0]![0] as { updates: Array<Record<string, unknown>> }).updates[0]!;
    expect(update).toMatchObject({
      externalKey: `eip155:56:${BSC_IDENTITY_REGISTRY}:6`,
      locatorHost: BSC_FIXTURE_URI_UPDATES[1]!.locatorHost,
      hasProfileLink: true,
    });
    expect(update.profileUriHash).toBe(BSC_FIXTURE_URI_UPDATES[1]!.profileUriHash);
    expect(result).toMatchObject({ discoveredCount: 3, acceptedCount: 3, rejectedCount: 0, nextCursor: `bsc:${START + W}` });
    finishedWith({ status: "completed", nextCursor: `bsc:${START + W}` });
  });

  it("applies windows strictly in chain order even when a later window's fetch finishes first", async () => {
    const { rpc } = fakeRpc({ finalized: START + 2 * W - 1, logs, delayAt: from => (from === START ? 40 : 0) });
    await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    // The first window's fetch is the slow one; its writes must still come first.
    expect(state.order).toEqual(["entries:6", "ledger:2", "uri:6", "entries:7", "ledger:1"]);
  });

  it("advances the cursor to the end of the last window it applied, and counts what it could not use", async () => {
    const junk = [{ ...registration(8, START + 10), address: "0x" + "44".repeat(20) }, { ...registration(9, START + 11), removed: true }];
    const { rpc } = fakeRpc({ finalized: START + 2 * W + 100, logs: [...logs, ...junk] });
    const result = await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    expect(result.nextCursor).toBe(`bsc:${START + 2 * W + 101}`);
    expect(result.rejectedCount).toBe(2);
    expect(result.discoveredCount).toBe(7);
  });
});

describe("budgets", () => {
  it("plans no more windows than the budget allows and resumes exactly where it stopped", async () => {
    const { rpc } = fakeRpc({ finalized: START + 10 * W });
    const first = await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc, budget: { maxWindows: 3 } });
    expect(first.nextCursor).toBe(`bsc:${START + 3 * W}`);
    const second = await runApprovedBscRegistrySource(source({ cursor: first.nextCursor }), "manual", "activity", { rpc, budget: { maxWindows: 3 } });
    expect(second.nextCursor).toBe(`bsc:${START + 6 * W}`);
  });

  it("stops applying once the event budget is spent, after the window that crossed it", async () => {
    const logs = [registration(6, START + 5), mint(6, START + 5), registration(7, START + W + 5), mint(7, START + W + 5)];
    const { rpc } = fakeRpc({ finalized: START + 3 * W - 1, logs });
    const result = await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc, budget: { maxEvents: 2, concurrency: 3 } });
    expect(state.order).toEqual(["entries:6", "ledger:1"]);
    expect(result.nextCursor).toBe(`bsc:${START + W}`);
  });

  it("stops applying once the wall-clock budget is spent, keeping the window it finished", async () => {
    const logs = [registration(6, START + 5), registration(7, START + W + 5)];
    const { rpc } = fakeRpc({ finalized: START + 2 * W - 1, logs });
    let tick = 0;
    // The clock advances 15 s per reading: the start (15 s), the loop check (30 s), the first window's check
    // (45 s elapsed is 30 s, inside the 40 s budget), then the second window's check (45 s elapsed, over it).
    const now = () => (tick += 15_000);
    const result = await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc, now, budget: { maxElapsedMs: 40_000, concurrency: 2 } });
    expect(state.order).toEqual(["entries:6"]);
    expect(result.nextCursor).toBe(`bsc:${START + W}`);
  });
});

describe("failures", () => {
  const logs = [registration(6, START + 5), registration(7, START + W + 5), registration(8, START + 2 * W + 5)];

  it("keeps the windows it applied when a later window fails, and says so in the server log", async () => {
    const { rpc } = fakeRpc({
      finalized: START + 3 * W - 1,
      logs,
      failAt: from => (from === START + W ? new BscRpcError("BNB Chain eth_getLogs request failed.") : null),
    });
    const result = await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc, budget: { concurrency: 3 } });
    expect(state.order).toEqual(["entries:6"]);
    expect(result.nextCursor).toBe(`bsc:${START + W}`);
    finishedWith({ status: "completed", nextCursor: `bsc:${START + W}` });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("[BSC] pass stopped early"));
  });

  it("fails the run, with the prior cursor, when the very first window fails", async () => {
    const { rpc } = fakeRpc({ finalized: START + 2 * W - 1, logs, failAt: from => (from === START ? new BscRpcError("BNB Chain eth_getLogs returned HTTP 503.") : null) });
    await expect(runApprovedBscRegistrySource(source(), "manual", "activity", { rpc })).rejects.toThrow(/HTTP 503/);
    expect(state.order).toEqual([]);
    finishedWith({ status: "failed", nextCursor: `bsc:${START}` });
  });

  it("fails the run, with the prior cursor, when a database write fails, so the next run rescans safely", async () => {
    state.insertAgentRegistryRows.mockRejectedValueOnce(new Error("db down"));
    const { rpc } = fakeRpc({ finalized: START + W - 1, logs });
    await expect(runApprovedBscRegistrySource(source(), "manual", "activity", { rpc })).rejects.toThrow(/db down/);
    finishedWith({ status: "failed", nextCursor: `bsc:${START}` });
  });

  it("splits a window the provider calls too large, and a block-range rejection is a loud bug", async () => {
    const big = new BscRpcRangeError("result_size", "too many results");
    const { rpc, logCalls } = fakeRpc({
      finalized: START + W - 1,
      logs: [registration(6, START + 5), registration(7, START + W - 5)],
      failAt: (from, to) => (to - from + 1 === W ? big : null),
    });
    const result = await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    expect(logCalls()).toHaveLength(3);
    // Both halves came back and were applied, each as a window of its own, in chain order.
    expect(state.order).toEqual(["entries:6", "entries:7"]);
    expect(result.nextCursor).toBe(`bsc:${START + W}`);

    state.order.length = 0;
    const badRange = fakeRpc({ finalized: START + W - 1, failAt: () => new BscRpcRangeError("block_range", "range") });
    await expect(runApprovedBscRegistrySource(source(), "manual", "activity", { rpc: badRange.rpc })).rejects.toBeInstanceOf(BscRpcRangeError);
  });

  it("refuses a log response that is not an array", async () => {
    const rpc = async (method: string) => (method === "eth_chainId" ? "0x38" : method === "eth_getBlockByNumber" ? { number: hexNum(START + 10) } : { not: "an array" });
    await expect(runApprovedBscRegistrySource(source(), "manual", "activity", { rpc })).rejects.toBeInstanceOf(BscRegistryValidationError);
    finishedWith({ status: "failed", nextCursor: `bsc:${START}` });
  });

  it("refuses a finalized block that is not a block number", async () => {
    const rpc = async (method: string) => (method === "eth_chainId" ? "0x38" : { number: "not hex" });
    await expect(runApprovedBscRegistrySource(source(), "manual", "activity", { rpc })).rejects.toThrow(/did not return a block number/);
  });
});

describe("URI updates", () => {
  it("tells the registry rows whether each updated URI is still a usable profile link, in chain order", async () => {
    const logs = [
      registration(6, START + 5),
      { ...uriUpdate(6, START + 254), data: abiString("https://agent.example.com/card.json") },
      { ...uriUpdate(6, START + 255), data: abiString("") },
      { ...uriUpdate(6, START + 256), data: abiString("ftp://files.example.com/agent.json") },
    ];
    const { rpc } = fakeRpc({ finalized: START + W - 1, logs });
    await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    const updates = (state.applyAgentRegistryUriUpdates.mock.calls[0]![0] as unknown as { updates: Array<{ hasProfileLink: boolean; locatorHost: string | null }> }).updates;
    // A web link is usable and carries its host; clearing the URI and an unrecognized scheme are not usable links.
    expect(updates.map(update => [update.hasProfileLink, update.locatorHost])).toEqual([
      [true, "agent.example.com"],
      [false, null],
      [false, null],
    ]);
  });

  it("applies the facts of an update whose URI decodes and skips one that does not, while still counting the event", async () => {
    const undecodable = { ...uriUpdate(6, START + 300), data: "0x" };
    const logs = [registration(6, START + 5), uriUpdate(6, START + 254), undecodable];
    const { rpc } = fakeRpc({ finalized: START + W - 1, logs });
    const result = await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    const updates = (state.applyAgentRegistryUriUpdates.mock.calls[0]![0] as { updates: unknown[] }).updates;
    expect(updates).toHaveLength(1);
    // The registration plus both update events reach the ledger.
    expect(state.applyAgentDirectoryActivityWindow).toHaveBeenCalledWith(expect.objectContaining({ activity: expect.arrayContaining([]) }));
    expect((state.applyAgentDirectoryActivityWindow.mock.calls[0]![0] as { activity: unknown[] }).activity).toHaveLength(2);
    expect(result.acceptedCount).toBe(3);
  });
});

describe("the listing refresh", () => {
  const logs = [registration(6, START + 5), mint(6, START + 5), registration(7, START + W + 5), mint(7, START + W + 5)];
  const lastRefresh = () => state.refreshAgentRegistryListing.mock.calls.at(-1)![1];

  it("classifies what the run wrote and publishes when the walk reached the finalized head", async () => {
    const { rpc } = fakeRpc({ finalized: START + 2 * W - 1, logs });
    await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    expect(state.refreshAgentRegistryListing).toHaveBeenCalledTimes(1);
    expect(state.refreshAgentRegistryListing.mock.calls[0]![0]).toMatchObject({ id: "source-bsc" });
    expect(lastRefresh()).toEqual({ classify: true, publish: true });
  });

  it("does not publish while windows remain: a partial read could list a row the next window groups", async () => {
    const { rpc } = fakeRpc({ finalized: START + 10 * W, logs });
    await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc, budget: { maxWindows: 2 } });
    expect(lastRefresh()).toEqual({ classify: true, publish: false });
  });

  it("does not publish after a failure stopped the walk short of the head, but still classifies what was applied", async () => {
    const { rpc } = fakeRpc({
      finalized: START + 3 * W - 1,
      logs,
      failAt: from => (from === START + W ? new BscRpcError("BNB Chain eth_getLogs request failed.") : null),
    });
    await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc, budget: { concurrency: 3 } });
    expect(lastRefresh()).toEqual({ classify: true, publish: false });
  });

  it("publishes on a quiet caught-up run without reclassifying", async () => {
    const { rpc } = fakeRpc({ finalized: START - 1 });
    await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    expect(lastRefresh()).toEqual({ classify: false, publish: true });
  });

  it("skips classification when the windows held nothing that changes a registry row", async () => {
    const { rpc } = fakeRpc({ finalized: START + W - 1, logs: [mint(6, START + 5)] });
    await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    expect(lastRefresh()).toEqual({ classify: false, publish: true });
  });

  it("classifies when only a URI update arrived", async () => {
    const { rpc } = fakeRpc({ finalized: START + W - 1, logs: [uriUpdate(6, START + 254)] });
    await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    expect(lastRefresh()).toEqual({ classify: true, publish: true });
  });

  it("never refreshes after a run that fails before applying anything", async () => {
    const { rpc } = fakeRpc({ finalized: START + 2 * W - 1, logs, failAt: from => (from === START ? new BscRpcError("BNB Chain eth_getLogs returned HTTP 503.") : null) });
    await expect(runApprovedBscRegistrySource(source(), "manual", "activity", { rpc })).rejects.toThrow(/HTTP 503/);
    expect(state.refreshAgentRegistryListing).not.toHaveBeenCalled();
  });

  it("logs a refresh failure and still completes the run with its cursor", async () => {
    state.refreshAgentRegistryListing.mockRejectedValueOnce(new Error("lock wait timeout"));
    const { rpc } = fakeRpc({ finalized: START + W - 1, logs });
    const result = await runApprovedBscRegistrySource(source(), "manual", "activity", { rpc });
    expect(result.nextCursor).toBe(`bsc:${START + W}`);
    finishedWith({ status: "completed", nextCursor: `bsc:${START + W}` });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("listing refresh failed"));
  });
});
