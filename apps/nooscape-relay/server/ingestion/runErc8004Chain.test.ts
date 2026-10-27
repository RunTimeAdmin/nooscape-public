import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * The orchestrator of the identity pass, run on a chain that is not BNB Chain. The BNB tests (runBsc.test.ts) hold BNB Chain's
 * pass exactly; these show the pass reads the chain it is given: the chain it checks for, the registry it asks, the range it
 * tiles at, the cursor it writes, the hand-out hour it applies, the rules it classifies by, the switch that turns it on, and the
 * name in every message and log line. The database layer is mocked and the RPC is a fake, so every write is asserted exactly.
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
    refreshAgentRegistryListing: vi.fn(async (_source: unknown, _options: Record<string, unknown>) => ({ classified: false, published: null })),
    keepWithinHostCap: vi.fn(async (_source: unknown, items: unknown[], _cap: number): Promise<{ kept: unknown[]; counted: number }> => ({ kept: items, counted: 0 })),
    keepStoredTokens: vi.fn(async (_sourceId: string, events: unknown[]): Promise<unknown[]> => events),
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
  keepWithinHostCap: state.keepWithinHostCap,
  keepStoredTokens: state.keepStoredTokens,
}));

import { BSC_CHAIN, type Erc8004Chain } from "./erc8004Chains";
import { Erc8004RpcRangeError } from "./erc8004Rpc";
import { DEMO_CHAIN, hexNum, mintAt, registrationAt, uriUpdateAt, word } from "./erc8004TestChain";
import { runApprovedErc8004ChainSource } from "./runErc8004Chain";

const START = 5_000;
const W = DEMO_CHAIN.maxLogRange;

function source(overrides: Record<string, unknown> = {}): IngestionSource {
  return {
    id: "source-demo",
    protocol: DEMO_CHAIN.protocol,
    sourceKey: DEMO_CHAIN.sourceKey,
    state: "active",
    rootUrl: DEMO_CHAIN.provider.rootUrl,
    allowedHostname: DEMO_CHAIN.provider.allowedHostname,
    cursor: `demo:${START}`,
    executionPolicy: "manual_only",
    scheduleMinutes: 1_440,
    ...overrides,
  } as unknown as IngestionSource;
}

type FakeOptions = {
  finalized: number;
  logs?: unknown[];
  chainId?: string;
  /** Throw for a getLogs call whose window matches. */
  failAt?: (from: number, to: number) => Error | null;
};

function fakeRpc(options: FakeOptions) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push({ method, params });
    if (method === "eth_chainId") return options.chainId ?? DEMO_CHAIN.chainIdHex;
    if (method === "eth_getBlockByNumber") return { number: hexNum(options.finalized) };
    if (method === "eth_getLogs") {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      const from = Number.parseInt(filter.fromBlock, 16);
      const to = Number.parseInt(filter.toBlock, 16);
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

const run = (chain: Erc8004Chain, src: IngestionSource, rpc: (method: string, params: unknown[]) => Promise<unknown>, extra: { budget?: Partial<Erc8004Chain["budget"]> } = {}) =>
  runApprovedErc8004ChainSource(chain, src, "manual", "activity", { rpc, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  state.order.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the guards, in the chain's words, before any run row exists", () => {
  it("rejects replays, unattended runs from an unscheduled source, another chain's source and every mode but the chain pass", async () => {
    const { rpc } = fakeRpc({ finalized: START + 10 });
    await expect(runApprovedErc8004ChainSource(DEMO_CHAIN, source(), "replay", "activity", { rpc })).rejects.toThrow("Demo Chain identity registry replays are rejected outright.");
    await expect(runApprovedErc8004ChainSource(DEMO_CHAIN, source(), "scheduled", "activity", { rpc })).rejects.toThrow("Scheduled Demo Chain identity registry runs require the scheduled execution policy.");
    const approved = "The Demo Chain identity pass is approved for the Demo Chain ERC-8004 identity registry only.";
    await expect(run(DEMO_CHAIN, source({ protocol: BSC_CHAIN.protocol }), rpc)).rejects.toThrow(approved);
    await expect(run(DEMO_CHAIN, source({ sourceKey: BSC_CHAIN.sourceKey }), rpc)).rejects.toThrow(approved);
    for (const mode of ["observe", "backfill", "registrants"] as const) {
      await expect(runApprovedErc8004ChainSource(DEMO_CHAIN, source(), "manual", mode, { rpc })).rejects.toThrow("The Demo Chain identity registry has one surface, the chain pass; observe and the walk modes have no meaning here.");
    }
    expect(state.beginIngestionRun).not.toHaveBeenCalled();
  });

  it("will not run the demo chain's pass on BNB Chain's source, nor BNB Chain's pass on the demo chain's", async () => {
    const { rpc } = fakeRpc({ finalized: START + 10 });
    await expect(run(DEMO_CHAIN, source({ protocol: "erc8004_bsc", sourceKey: "bsc-erc8004-identity-registry" }), rpc)).rejects.toThrow(/approved for the Demo Chain/);
    await expect(run(BSC_CHAIN, source(), rpc)).rejects.toThrow(/approved for the BNB Chain/);
    expect(state.beginIngestionRun).not.toHaveBeenCalled();
  });

  it("refuses a source whose stored policy is not the chain's, and an inactive one, and records the failure against the prior cursor", async () => {
    for (const [overrides, message] of [
      [{ state: "paused" }, /Only active sources/],
      [{ allowedHostname: "evil.example.com" }, /Stored Demo Chain source policy does not match the approved RPC host/],
      [{ rootUrl: "https://evil.example.com" }, /Stored Demo Chain source policy does not match the approved RPC host/],
    ] as const) {
      const { rpc, calls } = fakeRpc({ finalized: START + 10 });
      await expect(run(DEMO_CHAIN, source(overrides), rpc)).rejects.toThrow(message);
      expect(calls).toHaveLength(0);
      expect(state.finishIngestionRun).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", nextCursor: `demo:${START}` }));
    }
  });

  it("refuses an endpoint that does not confirm the chain's own id", async () => {
    // BNB Chain's id is not this chain's.
    const { rpc } = fakeRpc({ finalized: START + 10, chainId: BSC_CHAIN.chainIdHex });
    await expect(run(DEMO_CHAIN, source(), rpc)).rejects.toThrow("Demo Chain RPC did not confirm the approved chain id 7777.");
    expect(state.insertAgentRegistryRows).not.toHaveBeenCalled();
    expect(state.refreshAgentRegistryListing).not.toHaveBeenCalled();
  });
});

describe("the walk on the chain", () => {
  it("starts a fresh source at the chain's deploy block, tiles at its range, asks its registry, and writes its cursor", async () => {
    const { rpc, logCalls } = fakeRpc({ finalized: 25_999 });
    const result = await run(DEMO_CHAIN, source({ cursor: null }), rpc);
    expect(logCalls().map(call => [Number.parseInt(call.fromBlock, 16), Number.parseInt(call.toBlock, 16)]).sort((a, b) => a[0]! - b[0]!)).toEqual([
      [1_000, 10_999],
      [11_000, 20_999],
      [21_000, 25_999],
    ]);
    for (const call of logCalls()) expect(call.address).toBe(DEMO_CHAIN.identityRegistry);
    expect(result.nextCursor).toBe("demo:26000");
    // Every finalized block was read, so the listing refresh publishes; nothing was written, so it classifies nothing.
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: false, publish: true });
  });

  it("applies a registration, then its mint, then the URI update that follows, each keyed to the chain", async () => {
    const logs = [uriUpdateAt(DEMO_CHAIN, 12, START + 7), mintAt(DEMO_CHAIN, 12, START + 5), registrationAt(DEMO_CHAIN, 12, START + 5)];
    const { rpc } = fakeRpc({ finalized: START + W - 1, logs });
    const result = await run(DEMO_CHAIN, source(), rpc);
    expect(state.order).toEqual(["entries:12", "ledger:2", "uri:12"]);
    const rows = state.insertAgentRegistryRows.mock.calls[0]![0] as { drafts: Array<{ externalKey: string; sourceSignalNote: string }> };
    expect(rows.drafts[0]!.externalKey).toBe(`eip155:7777:${DEMO_CHAIN.identityRegistry}:12`);
    expect(rows.drafts[0]!.sourceSignalNote).toContain("Demo Chain Mainnet ERC-8004 registration.");
    expect(result).toMatchObject({ acceptedCount: 3, rejectedCount: 0, nextCursor: `demo:${START + W}` });
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: true });
  });

  it("applies the chain's own hand-out hour to the ledger, where BNB Chain's is another length", async () => {
    const logs = [registrationAt(DEMO_CHAIN, 12, START + 5), mintAt(DEMO_CHAIN, 12, START + 5)];
    await run(DEMO_CHAIN, source(), fakeRpc({ finalized: START + W - 1, logs }).rpc);
    expect(state.applyAgentDirectoryActivityWindow).toHaveBeenCalledWith(expect.objectContaining({ handoutBlockWindow: 1_800, incrementalRollup: true, rollupTarget: "registry" }));
    expect(DEMO_CHAIN.handoutBlockWindow).not.toBe(BSC_CHAIN.handoutBlockWindow);
  });

  it("plans no more windows than the chain's own budget, and keeps its progress", async () => {
    const { rpc, logCalls } = fakeRpc({ finalized: START + 100 * W });
    const result = await run(DEMO_CHAIN, source(), rpc);
    expect(logCalls()).toHaveLength(10);
    expect(result.nextCursor).toBe(`demo:${START + 10 * W}`);
    // A caller's partial budget overrides the chain's for that field only.
    const narrow = fakeRpc({ finalized: START + 100 * W });
    expect((await run(DEMO_CHAIN, source(), narrow.rpc, { budget: { maxWindows: 3 } })).nextCursor).toBe(`demo:${START + 3 * W}`);
  });

  it("does not publish while windows remain, and stops early with the chain's tag in the log when a later window fails", async () => {
    const logs = [registrationAt(DEMO_CHAIN, 6, START + 5), registrationAt(DEMO_CHAIN, 7, START + W + 5)];
    const { rpc } = fakeRpc({ finalized: START + 3 * W - 1, logs, failAt: from => (from === START + W ? new Error("provider fault") : null) });
    const result = await run(DEMO_CHAIN, source(), rpc, { budget: { concurrency: 1 } });
    expect(result.nextCursor).toBe(`demo:${START + W}`);
    expect(state.order).toEqual(["entries:6"]);
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: false });
    expect(console.warn).toHaveBeenCalledWith(`[DEMO] pass stopped early at block ${START + W} after 1 window(s): provider fault`);
  });
});

describe("a window that cannot be parsed or applied", () => {
  const logs = [registrationAt(DEMO_CHAIN, 6, START + 5), registrationAt(DEMO_CHAIN, 7, START + W + 5)];

  it("keeps the windows before it, stops there and says so without the driver's parameters, when the database fails", async () => {
    state.insertAgentRegistryRows.mockImplementationOnce(async input => {
      state.order.push(`entries:${input.drafts.length}`);
      return input.drafts.length;
    });
    state.insertAgentRegistryRows.mockRejectedValueOnce(new Error("Failed query: insert into agent_directory_registry_rows (externalKey) values (?)" + String.fromCharCode(10) + "params: private-owner-key"));
    const { rpc } = fakeRpc({ finalized: START + 3 * W - 1, logs });
    const result = await run(DEMO_CHAIN, source(), rpc, { budget: { concurrency: 1 } });
    // The first window stands, the second is the next run's first, and the listing is not published while windows remain.
    expect(result.nextCursor).toBe(`demo:${START + W}`);
    expect(state.order).toEqual(["entries:1"]);
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: false });
    const warned = vi.mocked(console.warn).mock.calls.map(call => call.join(" ")).join(" ");
    expect(warned).toContain(`[DEMO] pass stopped early at block ${START + W} after 1 window(s): Failed query: insert into agent_directory_registry_rows (externalKey) values (?)`);
    expect(warned).not.toContain("private-owner-key");
  });

  it("keeps the windows before it when the node's answer for a later one is not one to trust", async () => {
    const crowded = Array.from({ length: DEMO_CHAIN.maxWindowLogs + 1 }, (_, index) => mintAt(DEMO_CHAIN, 1_000 + index, START + W + 5, index));
    const { rpc } = fakeRpc({ finalized: START + 3 * W - 1, logs: [registrationAt(DEMO_CHAIN, 6, START + 5), ...crowded] });
    const result = await run(DEMO_CHAIN, source(), rpc, { budget: { concurrency: 1 } });
    expect(result.nextCursor).toBe(`demo:${START + W}`);
    expect(vi.mocked(console.warn).mock.calls.map(call => call.join(" ")).join(" ")).toContain(`pass stopped early at block ${START + W} after 1 window(s): Demo Chain identity log response exceeds the approved bound`);
  });

  it("fails the run, with the cursor where it was, when the first window is the one that cannot be applied", async () => {
    state.insertAgentRegistryRows.mockRejectedValueOnce(new Error("lock wait timeout"));
    const { rpc } = fakeRpc({ finalized: START + 3 * W - 1, logs });
    await expect(run(DEMO_CHAIN, source(), rpc, { budget: { concurrency: 1 } })).rejects.toThrow("lock wait timeout");
    expect(state.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", nextCursor: `demo:${START}` }));
  });
});

describe("a window the node refuses as too large", () => {
  // What the pass sees when a window's answer would pass the response cap (erc8004Rpc.ts), or the provider's own limit.
  const tooLarge = () => new Erc8004RpcRangeError("result_size", "Demo Chain eth_getLogs response exceeds the response limit.");
  const splitWarnings = () => vi.mocked(console.warn).mock.calls.filter(([line]) => String(line).includes("were too large for one read"));

  it("is read in halves, each applied on its own and in the chain's order, and the cursor ends past the whole window", async () => {
    const logs = [
      registrationAt(DEMO_CHAIN, 1, START + 10),
      mintAt(DEMO_CHAIN, 1, START + 10),
      registrationAt(DEMO_CHAIN, 2, START + 6_000),
      uriUpdateAt(DEMO_CHAIN, 1, START + 7_000),
    ];
    // Nothing wider than 2,500 blocks is answered: the window of 10,000 splits to 5,000, then to four quarters.
    const { rpc } = fakeRpc({ finalized: START + W - 1, logs, failAt: (from, to) => (to - from + 1 > 2_500 ? tooLarge() : null) });
    const result = await run(DEMO_CHAIN, source(), rpc);
    expect(result).toMatchObject({ acceptedCount: 4, rejectedCount: 0, nextCursor: `demo:${START + W}` });
    expect(state.order).toEqual(["entries:1", "ledger:1", "entries:2", "ledger:1", "uri:1"]);
    expect(splitWarnings()).toHaveLength(3);
    expect(console.warn).toHaveBeenCalledWith(`[DEMO] blocks ${START} to ${START + W - 1} were too large for one read and are read in halves.`);
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: true });
  });

  it("is held to the log bound half by half, so a window over the bound goes through when each half is under it", async () => {
    // 600 registrations, 313 in the first half of the window and 287 in the second; the chain's bound is 500 events.
    const dense = Array.from({ length: 600 }, (_, index) => registrationAt(DEMO_CHAIN, index + 1, START + 5 + index * 16));
    await expect(run(DEMO_CHAIN, source(), fakeRpc({ finalized: START + W - 1, logs: dense }).rpc)).rejects.toThrow("Demo Chain identity log response exceeds the approved bound of 500 events.");
    expect(state.insertAgentRegistryRows).not.toHaveBeenCalled();

    const halved = fakeRpc({ finalized: START + W - 1, logs: dense, failAt: (from, to) => (to - from + 1 > 5_000 ? tooLarge() : null) });
    const result = await run(DEMO_CHAIN, source(), halved.rpc);
    expect(result).toMatchObject({ acceptedCount: 600, nextCursor: `demo:${START + W}` });
    expect(state.insertAgentRegistryRows.mock.calls.map(([input]) => input.drafts.length)).toEqual([313, 287]);
  });

  it("fails the run, with the cursor where it was, when even the narrowest window is refused", async () => {
    const { rpc, logCalls } = fakeRpc({ finalized: START + W - 1, failAt: () => tooLarge() });
    await expect(run(DEMO_CHAIN, source(), rpc)).rejects.toThrow("Demo Chain eth_getLogs response exceeds the response limit.");
    expect(state.finishIngestionRun).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", nextCursor: `demo:${START}` }));
    expect(state.insertAgentRegistryRows).not.toHaveBeenCalled();
    // It halved to the floor and stopped there: a handful of levels, not an endless descent.
    expect(logCalls().length).toBeLessThan(40);
  });

  it("keeps the halves it applied when a later half is refused beyond the narrowest split, and stops there", async () => {
    const logs = [registrationAt(DEMO_CHAIN, 1, START + 10), registrationAt(DEMO_CHAIN, 2, START + 7_000)];
    // The second half of the window is refused whatever its width.
    const { rpc } = fakeRpc({ finalized: START + W - 1, logs, failAt: (from, to) => (to - from + 1 > 5_000 || from >= START + 5_000 ? tooLarge() : null) });
    const result = await run(DEMO_CHAIN, source(), rpc);
    expect(result.nextCursor).toBe(`demo:${START + 5_000}`);
    expect(state.order).toEqual(["entries:1"]);
    expect(console.warn).toHaveBeenCalledWith(`[DEMO] pass stopped early at block ${START + 5_000} after 1 window(s): Demo Chain eth_getLogs response exceeds the response limit.`);
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: false });
  });

  it("is not split when the refusal is of the block range, which is a planner fault", async () => {
    const { rpc } = fakeRpc({ finalized: START + W - 1, failAt: () => new Erc8004RpcRangeError("block_range", "Demo Chain eth_getLogs was rejected as exceeding the provider's block range.") });
    await expect(run(DEMO_CHAIN, source(), rpc)).rejects.toThrow("Demo Chain eth_getLogs was rejected as exceeding the provider's block range.");
    expect(splitWarnings()).toHaveLength(0);
  });
});

describe("the listing rules", () => {
  const logs = [registrationAt(DEMO_CHAIN, 6, START + 5)];

  it("are the chain's own when it has some, and are not passed at all when it has none, so BNB Chain's defaults stand", async () => {
    const rules = { sharedProfileLinkFrom: 3, sharedHostFrom: 40, sharedWalletFrom: 8 };
    await run({ ...DEMO_CHAIN, listingRules: rules }, source(), fakeRpc({ finalized: START + W - 1, logs }).rpc);
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: true, rules });
    await run(DEMO_CHAIN, source(), fakeRpc({ finalized: START + W - 1, logs }).rpc);
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: true });
  });

  it("never fail a run whose windows are applied, and say so with the chain's tag", async () => {
    state.refreshAgentRegistryListing.mockRejectedValueOnce(new Error("lock wait timeout"));
    const result = await run(DEMO_CHAIN, source(), fakeRpc({ finalized: START + W - 1, logs }).rpc);
    expect(result.nextCursor).toBe(`demo:${START + W}`);
    expect(console.warn).toHaveBeenCalledWith("[DEMO] listing refresh failed and will be retried by the next run: lock wait timeout");
  });
});

describe("a chain's switch", () => {
  const gated: Erc8004Chain = { ...DEMO_CHAIN, feature: "watch" };

  it("keeps the pass from starting while it is off, before any run row exists, and says so in the log", async () => {
    vi.stubEnv("VITE_FEATURES", "");
    const { rpc, calls } = fakeRpc({ finalized: START + 10 });
    await expect(run(gated, source(), rpc)).rejects.toThrow("The Demo Chain identity pass is switched off.");
    expect(calls).toHaveLength(0);
    expect(state.beginIngestionRun).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[DEMO] the Demo Chain identity pass was refused: its switch (watch) is off.");
  });

  it("is off when the list names other features, and on when it names this one, in any case", async () => {
    vi.stubEnv("VITE_FEATURES", "claims,patrols");
    await expect(run(gated, source(), fakeRpc({ finalized: START + 10 }).rpc)).rejects.toThrow(/switched off/);
    vi.stubEnv("VITE_FEATURES", "Claims, WATCH");
    // Caught up (nothing finalized past the cursor), so a run that starts leaves the cursor where it was.
    await expect(run(gated, source(), fakeRpc({ finalized: START - 1 }).rpc)).resolves.toMatchObject({ nextCursor: `demo:${START}` });
    expect(state.beginIngestionRun).toHaveBeenCalledTimes(1);
  });

  it("does not apply to a chain with no switch, whatever the list says", async () => {
    vi.stubEnv("VITE_FEATURES", "");
    await expect(run(DEMO_CHAIN, source(), fakeRpc({ finalized: START - 1 }).rpc)).resolves.toBeDefined();
    expect(state.beginIngestionRun).toHaveBeenCalledTimes(1);
  });
});

describe("a chain with a host cap", () => {
  const capped: Erc8004Chain = { ...DEMO_CHAIN, hostRowCap: 100 };
  const abiString = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    const padded = Buffer.concat([bytes, Buffer.alloc((32 - (bytes.length % 32)) % 32)]);
    return `0x${word(32).slice(2)}${word(bytes.length).slice(2)}${padded.toString("hex")}`;
  };
  const registeredAt = (id: number, block: number, uri: string) => ({ ...registrationAt(DEMO_CHAIN, id, block), data: abiString(uri) });
  const idOf = (key: string) => key.split(":").pop();

  it("asks for nothing when the chain has no cap: every registration and event goes through as it always has", async () => {
    const logs = [registeredAt(12, START + 5, "https://platform.example/a/12"), mintAt(DEMO_CHAIN, 12, START + 5)];
    await run(DEMO_CHAIN, source(), fakeRpc({ finalized: START + W - 1, logs }).rpc);
    expect(state.keepWithinHostCap).not.toHaveBeenCalled();
    expect(state.keepStoredTokens).not.toHaveBeenCalled();
    expect(state.order).toEqual(["entries:12", "ledger:1"]);
  });

  it("offers each window's registrations to the cap with the host of their URIs and the chain's cap, in chain order", async () => {
    const logs = [
      registeredAt(13, START + 6, "https://platform.example/a/13"),
      registeredAt(12, START + 5, "https://platform.example/a/12"),
      registrationAt(DEMO_CHAIN, 14, START + 7),
    ];
    await run(capped, source(), fakeRpc({ finalized: START + W - 1, logs }).rpc);
    expect(state.keepWithinHostCap).toHaveBeenCalledTimes(1);
    const [, items, cap] = state.keepWithinHostCap.mock.calls[0]!;
    expect(cap).toBe(100);
    expect((items as Array<{ host: string | null; blockNumber: number; externalKey: string }>).map(item => [idOf(item.externalKey), item.host, item.blockNumber])).toEqual([
      ["12", "platform.example", START + 5],
      ["13", "platform.example", START + 6],
      ["14", null, START + 7],
    ]);
  });

  it("stores only the registrations the cap keeps, and the events of the tokens it kept, and classifies for what it stored", async () => {
    const logs = [
      registeredAt(12, START + 5, "https://platform.example/a/12"),
      mintAt(DEMO_CHAIN, 12, START + 5),
      registeredAt(13, START + 6, "https://platform.example/a/13"),
      mintAt(DEMO_CHAIN, 13, START + 6),
      uriUpdateAt(DEMO_CHAIN, 12, START + 8),
      uriUpdateAt(DEMO_CHAIN, 13, START + 9),
    ];
    // Agent 12 is the one the cap counts; the ledger holds agent 13's events and not 12's.
    state.keepWithinHostCap.mockImplementationOnce(async (_source, items) => ({ kept: (items as Array<{ externalKey: string }>).filter(item => idOf(item.externalKey) === "13"), counted: 1 }));
    state.keepStoredTokens.mockImplementationOnce(async (_id, events) => (events as Array<{ externalKey: string }>).filter(event => idOf(event.externalKey) === "13"));
    const result = await run(capped, source(), fakeRpc({ finalized: START + W - 1, logs }).rpc);
    expect(state.order).toEqual(["entries:13", "ledger:2", "uri:13"]);
    // The budget counts what the window held, not what was stored; the counted registration is still an event read.
    expect(result).toMatchObject({ acceptedCount: 6, rejectedCount: 0, nextCursor: `demo:${START + W}` });
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: true, publish: true });
  });

  it("writes nothing for a window whose registrations were all counted, and does not ask for a classification", async () => {
    const logs = [registeredAt(12, START + 5, "https://platform.example/a/12"), mintAt(DEMO_CHAIN, 12, START + 5), uriUpdateAt(DEMO_CHAIN, 12, START + 8)];
    state.keepWithinHostCap.mockImplementationOnce(async () => ({ kept: [], counted: 1 }));
    state.keepStoredTokens.mockImplementationOnce(async () => []);
    await run(capped, source(), fakeRpc({ finalized: START + W - 1, logs }).rpc);
    expect(state.insertAgentRegistryRows).not.toHaveBeenCalled();
    expect(state.applyAgentDirectoryActivityWindow).not.toHaveBeenCalled();
    expect(state.applyAgentRegistryUriUpdates).not.toHaveBeenCalled();
    expect(state.refreshAgentRegistryListing.mock.calls.at(-1)![1]).toEqual({ classify: false, publish: true });
  });
});
