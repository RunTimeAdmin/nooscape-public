import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * Orchestrator tests for the Robinhood reputation walk. The point under test:
 * a mode that cannot run from the persisted cursor (a backfill click after the
 * backfill reached genesis, or a ratings fill before it does) is an operator
 * mistake, not a fault. It must be refused BEFORE a run row exists, so it
 * records no failed run and never raises the source's failure count. That
 * false failure was the standing "fail=2" warning on the reputation source.
 */
const mocks = vi.hoisted(() => ({
  beginIngestionRun: vi.fn(async (_source: unknown, _trigger: string) => "run-1"),
  finishIngestionRun: vi.fn(async (_input: unknown) => {}),
  applyAgentDirectoryReputationWindow: vi.fn(async (_input: unknown) => ({ acknowledgedCount: 0 })),
  readAgentDirectoryReputationHighWater: vi.fn(async (_sourceId: string): Promise<number | null> => null),
  fetchRobinhoodReputationRegistry: vi.fn(async (_source: unknown, _options: unknown) => ({})),
}));

vi.mock("../db", () => ({
  beginIngestionRun: mocks.beginIngestionRun,
  finishIngestionRun: mocks.finishIngestionRun,
  applyAgentDirectoryReputationWindow: mocks.applyAgentDirectoryReputationWindow,
  readAgentDirectoryReputationHighWater: mocks.readAgentDirectoryReputationHighWater,
}));

// Keep the real cursor and mode rules; only the network adapter is replaced.
vi.mock("./robinhoodReputation", async importOriginal => {
  const original = await importOriginal<typeof import("./robinhoodReputation")>();
  return { ...original, fetchRobinhoodReputationRegistry: mocks.fetchRobinhoodReputationRegistry };
});

import { runApprovedRobinhoodReputationSource } from "./runRobinhoodReputation";

const FORWARD_CURSOR = `fw:85000000#0x${"0a".repeat(32)}`;
const source = (cursor: string | null, executionPolicy = "manual_only") =>
  ({ id: "source-rep", protocol: "erc8004_reputation", state: "active", cursor, executionPolicy, scheduleMinutes: 1440 }) as unknown as IngestionSource;

function snapshot() {
  return { requestCount: 3, discoveredCount: 5, events: [{}, {}], rejectedCount: 0, walkCursor: "rb:done" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchRobinhoodReputationRegistry.mockResolvedValue(snapshot());
});

describe("a mode that cannot run from the cursor is refused before any run row exists", () => {
  const refusals: Array<[string, string | null, "backfill" | "activity", RegExp]> = [
    ["a backfill click after the backfill reached genesis (rb:done)", "rb:done", "backfill", /already reached genesis/],
    ["a backfill click on the forward walk (fw:)", FORWARD_CURSOR, "backfill", /already reached genesis/],
    ["a ratings fill before any backfill (no cursor)", null, "activity", /still backward/],
    ["a ratings fill in the middle of the backfill (rb:<block>)", "rb:12058837", "activity", /still backward/],
  ];
  for (const [label, cursor, mode, message] of refusals) {
    it(`refuses ${label}`, async () => {
      await expect(runApprovedRobinhoodReputationSource(source(cursor), "manual", mode)).rejects.toThrow(message);
      expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
      expect(mocks.finishIngestionRun).not.toHaveBeenCalled();
      expect(mocks.fetchRobinhoodReputationRegistry).not.toHaveBeenCalled();
    });
  }

  it("refuses a cursor that is not an approved reputation-walk position, also before a run row", async () => {
    await expect(runApprovedRobinhoodReputationSource(source("ac:12345"), "manual", "backfill")).rejects.toThrow(/not an approved reputation-walk position/);
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });
});

describe("a mode that fits the cursor runs normally", () => {
  it("runs the ratings fill from rb:done and records a completed run", async () => {
    const result = await runApprovedRobinhoodReputationSource(source("rb:done"), "manual", "activity");
    expect(mocks.beginIngestionRun).toHaveBeenCalledTimes(1);
    expect(mocks.fetchRobinhoodReputationRegistry).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ acceptedCount: 2, nextCursor: "rb:done" });
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("runs the ratings fill from the forward walk (fw:)", async () => {
    await runApprovedRobinhoodReputationSource(source(FORWARD_CURSOR), "manual", "activity");
    expect(mocks.beginIngestionRun).toHaveBeenCalledTimes(1);
  });

  it("runs the backfill from a fresh source and from a backward position", async () => {
    await runApprovedRobinhoodReputationSource(source(null), "manual", "backfill");
    await runApprovedRobinhoodReputationSource(source("rb:12058837"), "manual", "backfill");
    expect(mocks.beginIngestionRun).toHaveBeenCalledTimes(2);
  });
});

describe("real faults still record a failed run", () => {
  it("records a failed run, with the prior cursor, when the adapter itself fails after the mode fits", async () => {
    mocks.fetchRobinhoodReputationRegistry.mockRejectedValue(new Error("rpc down"));
    await expect(runApprovedRobinhoodReputationSource(source("rb:done"), "manual", "activity")).rejects.toThrow(/rpc down/);
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", nextCursor: "rb:done" }));
  });
});

describe("the existing trigger guards still come first", () => {
  it("rejects replays and unscheduled unattended runs before anything else", async () => {
    await expect(runApprovedRobinhoodReputationSource(source("rb:done"), "replay", "activity")).rejects.toThrow(/replays are rejected outright/);
    await expect(runApprovedRobinhoodReputationSource(source("rb:done", "manual_only"), "scheduled", "activity")).rejects.toThrow(/scheduled execution policy/);
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });
});
