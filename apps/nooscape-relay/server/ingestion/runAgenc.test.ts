import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * Runner wiring tests for the AgenC registry pass: the unattended and identity guards fire before any run row is written, the `agenc:`
 * cursor persists only after the whole snapshot succeeds, the pass owns locatorHost (the endpoint and profile link are chain reads), and a
 * failure leaves the cursor and the directory untouched. The adapter is covered in agencChain.test.ts; here the db layer and the adapter are
 * mocked so every write call is asserted exactly.
 */
const mocks = vi.hoisted(() => ({
  beginIngestionRun: vi.fn(async (_source: unknown, _trigger: string) => "run-1"),
  finishIngestionRun: vi.fn(async (_input: unknown) => {}),
  listAgentDirectoryEntriesForSource: vi.fn(async (_sourceId: string): Promise<Array<{ externalKey: string }>> => []),
  upsertAgentDirectoryEntries: vi.fn(async (_input: unknown) => 0),
  fetchAgencChainState: vi.fn(async (_input: unknown) => ({})),
}));

vi.mock("../db", () => ({
  beginIngestionRun: mocks.beginIngestionRun,
  finishIngestionRun: mocks.finishIngestionRun,
  listAgentDirectoryEntriesForSource: mocks.listAgentDirectoryEntriesForSource,
  upsertAgentDirectoryEntries: mocks.upsertAgentDirectoryEntries,
}));

vi.mock("./agencChain", () => ({
  AGENC_CHAIN_SOURCE_KEY: "solana-agenc-agent-registry",
  isAgencChainSeedCursor: (cursor: string | null) => !(cursor !== null && cursor.startsWith("agenc:")),
  fetchAgencChainState: mocks.fetchAgencChainState,
}));

import { runApprovedAgencSource } from "./runAgenc";

const AGENT_A = "A".repeat(44);
const AGENT_B = "B".repeat(44);

const baseSource = {
  id: "source-agenc",
  protocol: "solana_agenc",
  sourceKey: "solana-agenc-agent-registry",
  state: "active",
  cursor: null as string | null,
  executionPolicy: "manual_only",
  scheduleMinutes: 1440,
};
const source = (overrides: Record<string, unknown> = {}) => ({ ...baseSource, ...overrides }) as unknown as IngestionSource;

const draft = (externalKey: string) => ({
  externalKey,
  displayName: "AgenC agent " + externalKey.slice(0, 8),
  locatorHost: "axon-agents.com",
  registrant: "W".repeat(44),
  accountPubkey: externalKey,
  profileUriHash: null,
  sourceSignalNote: "note",
});

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    slot: 4242,
    requestCount: 2,
    enumeratedCount: 2,
    drafts: [draft(AGENT_A), draft(AGENT_B)],
    tailResidueCount: 0,
    vanishedCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAgentDirectoryEntriesForSource.mockResolvedValue([]);
  mocks.fetchAgencChainState.mockResolvedValue(snapshot());
});

describe("runApprovedAgencSource guards", () => {
  it("rejects replays outright, before any run row is written", async () => {
    await expect(runApprovedAgencSource(source(), "replay")).rejects.toThrow("replays are rejected outright");
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });

  it("rejects an unattended run from a source not handed to the scheduler", async () => {
    await expect(runApprovedAgencSource(source({ executionPolicy: "manual_only" }), "scheduled")).rejects.toThrow("require the scheduled execution policy");
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });

  it("accepts an unattended run once the source holds the scheduled policy", async () => {
    await runApprovedAgencSource(source({ executionPolicy: "scheduled", cursor: "agenc:1" }), "scheduled");
    expect(mocks.beginIngestionRun).toHaveBeenCalledWith(expect.anything(), "scheduled");
  });

  it("refuses any source that is not the approved AgenC registry", async () => {
    await expect(runApprovedAgencSource(source({ sourceKey: "something-else" }), "manual")).rejects.toThrow("approved for the AgenC Solana agent registry only");
    await expect(runApprovedAgencSource(source({ protocol: "solana_said" }), "manual")).rejects.toThrow("approved for the AgenC Solana agent registry only");
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });
});

describe("runApprovedAgencSource run", () => {
  it("seeds when no agenc: cursor exists and persists agenc:<slot>", async () => {
    const result = await runApprovedAgencSource(source({ cursor: null }), "manual");
    const input = mocks.fetchAgencChainState.mock.calls[0]![0] as { seed: boolean; priorKeys: Set<string> };
    expect(input.seed).toBe(true);
    expect(input.priorKeys.size).toBe(0);
    const upsert = mocks.upsertAgentDirectoryEntries.mock.calls[0]![0] as { runId: string; entries: Array<{ externalKey: string }>; preserveLocatorHost?: boolean; insertOnly?: boolean };
    expect(upsert.runId).toBe("run-1");
    expect(upsert.entries.map(entry => entry.externalKey)).toEqual([AGENT_A, AGENT_B]);
    // This pass owns locatorHost and refreshes existing rows.
    expect(upsert.preserveLocatorHost).toBeUndefined();
    expect(upsert.insertOnly).toBeUndefined();
    expect(result).toEqual({ requestCount: 2, discoveredCount: 2, acceptedCount: 2, rejectedCount: 0, nextCursor: "agenc:4242" });
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", nextCursor: "agenc:4242" }));
  });

  it("hands the pass the keys of the agents the source already acknowledged, once an agenc: cursor exists", async () => {
    mocks.listAgentDirectoryEntriesForSource.mockResolvedValue([{ externalKey: AGENT_A }, { externalKey: AGENT_B }]);
    await runApprovedAgencSource(source({ cursor: "agenc:100" }), "manual");
    const input = mocks.fetchAgencChainState.mock.calls[0]![0] as { seed: boolean; priorKeys: Set<string> };
    expect(input.seed).toBe(false);
    expect([...input.priorKeys].sort()).toEqual([AGENT_A, AGENT_B]);
  });

  it("reports a missing agent as an exception in rejectedCount, and logs it with the residue count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.fetchAgencChainState.mockResolvedValue(snapshot({ vanishedCount: 2, tailResidueCount: 1 }));
    const result = await runApprovedAgencSource(source({ cursor: "agenc:100" }), "manual");
    expect(result.rejectedCount).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/2 previously acknowledged agent.*1 account.*bytes past the last field/);
    warn.mockRestore();
  });

  it("stays quiet when there is nothing to report", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runApprovedAgencSource(source({ cursor: "agenc:100" }), "manual");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("writes nothing and leaves the cursor untouched when the pass fails", async () => {
    mocks.fetchAgencChainState.mockRejectedValue(new Error("enumeration under the floor"));
    await expect(runApprovedAgencSource(source({ cursor: "agenc:100" }), "manual")).rejects.toThrow("under the floor");
    expect(mocks.upsertAgentDirectoryEntries).not.toHaveBeenCalled();
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", nextCursor: "agenc:100", counts: expect.objectContaining({ requestCount: 2, rejectedCount: 1 }) })
    );
  });

  it("records a failed run with the prior cursor when the directory write fails, so the next pass starts from the same place", async () => {
    mocks.upsertAgentDirectoryEntries.mockRejectedValueOnce(new Error("db down"));
    await expect(runApprovedAgencSource(source({ cursor: "agenc:100" }), "manual")).rejects.toThrow("db down");
    const finish = mocks.finishIngestionRun.mock.calls[0]![0] as { status: string; nextCursor: string | null };
    expect(finish.status).toBe("failed");
    expect(finish.nextCursor).toBe("agenc:100");
  });
});
