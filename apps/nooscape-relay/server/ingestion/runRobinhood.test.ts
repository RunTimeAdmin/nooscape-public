import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * Orchestrator tests for the Robinhood identity-registry walks. An operator
 * click whose mode cannot run from the persisted cursor (a backfill after
 * bf:done, a registrant fill on the forward walk) is a mistake, not a fault. It
 * must be refused BEFORE a run row exists, so it records no failed run and
 * never raises the source's failure count, the same false failure the
 * reputation source had. Scheduled runs are deliberately not pre-checked: a
 * stuck scheduler is a real fault and the run record has to show it.
 */
const mocks = vi.hoisted(() => ({
  beginIngestionRun: vi.fn(async (_source: unknown, _trigger: string) => "run-1"),
  finishIngestionRun: vi.fn(async (_input: unknown) => {}),
  applyAgentDirectoryActivityWindow: vi.fn(async (_input: unknown) => ({ acknowledgedCount: 0 })),
  persistErc8004RegistryObservation: vi.fn(async (_input: unknown) => {}),
  readAgentDirectoryActivityHighWater: vi.fn(async (_sourceId: string): Promise<number | null> => null),
  upsertAgentDirectoryEntries: vi.fn(async (_input: unknown) => 0),
  fetchRobinhoodRegistry: vi.fn(async (_source: unknown, _options: unknown) => ({})),
}));

vi.mock("../db", () => ({
  beginIngestionRun: mocks.beginIngestionRun,
  finishIngestionRun: mocks.finishIngestionRun,
  applyAgentDirectoryActivityWindow: mocks.applyAgentDirectoryActivityWindow,
  persistErc8004RegistryObservation: mocks.persistErc8004RegistryObservation,
  readAgentDirectoryActivityHighWater: mocks.readAgentDirectoryActivityHighWater,
  upsertAgentDirectoryEntries: mocks.upsertAgentDirectoryEntries,
}));

// Keep the real cursor and mode rules; only the network adapter is replaced.
vi.mock("./robinhood", async importOriginal => {
  const original = await importOriginal<typeof import("./robinhood")>();
  return { ...original, fetchRobinhoodRegistry: mocks.fetchRobinhoodRegistry };
});

import { runApprovedRobinhoodRegistrySource } from "./runRobinhood";
import { RobinhoodRegistryValidationError, RobinhoodWalkModeRefusedError } from "./robinhood";

const FORWARD = `fw:85000000#0x${"0a".repeat(32)}`;
const source = (cursor: string | null, executionPolicy = "manual_only") =>
  ({ id: "source-id", protocol: "erc8004", state: "active", cursor, executionPolicy, scheduleMinutes: 15 }) as unknown as IngestionSource;

function snapshot(walkCursor: string | null = "bf:100") {
  return { requestCount: 3, discoveredCount: 4, observations: [], directory: [], activity: [], rejectedCount: 0, walkCursor };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchRobinhoodRegistry.mockResolvedValue(snapshot());
});

describe("an operator click the position cannot honor is refused before any run row exists", () => {
  const refusals: Array<[string, string | null, "backfill" | "registrants" | "activity", RegExp]> = [
    ["a backfill after the backfill finished (bf:done)", "bf:done", "backfill", /Backfill window cannot run.*backfill complete \(bf:done\)\. Fill registrants can run/],
    ["a backfill on the forward walk (fw:)", FORWARD, "backfill", /Backfill window cannot run.*forward walk \(fw:85000000\)\. Fill activity can run/],
    ["a registrant fill on the forward walk (fw:)", FORWARD, "registrants", /Fill registrants cannot run.*forward walk/],
    ["a registrant fill in the middle of the backfill (bf:<block>)", "bf:12058837", "registrants", /Fill registrants cannot run.*backfill in progress/],
    ["a registrant fill after the registrant walk finished (rb:done)", "rb:done", "registrants", /Fill registrants cannot run.*registrant walk complete/],
    ["an activity fill before the registrant walk finishes (rb:<block>)", "rb:5000", "activity", /Fill activity cannot run.*registrant walk in progress/],
    ["an activity fill on a fresh source", null, "activity", /Fill activity cannot run.*not started/],
  ];
  for (const [label, cursor, mode, message] of refusals) {
    it(`refuses ${label}`, async () => {
      const attempt = runApprovedRobinhoodRegistrySource(source(cursor), "manual", mode);
      await expect(attempt).rejects.toThrow(message);
      await expect(attempt).rejects.toBeInstanceOf(RobinhoodWalkModeRefusedError);
      expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
      expect(mocks.finishIngestionRun).not.toHaveBeenCalled();
      expect(mocks.fetchRobinhoodRegistry).not.toHaveBeenCalled();
    });
  }

  it("refuses a walk from a cursor that is not an approved position, also before a run row", async () => {
    await expect(runApprovedRobinhoodRegistrySource(source("garbage"), "manual", "backfill")).rejects.toThrow(/not an approved walk position/);
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });
});

describe("a click the position can honor runs normally", () => {
  const fits: Array<[string, string | null, "backfill" | "registrants" | "activity"]> = [
    ["a backfill on a fresh source", null, "backfill"],
    ["a backfill in the middle of the backfill", "bf:12058837", "backfill"],
    ["a registrant fill on a fresh source", null, "registrants"],
    ["a registrant fill after the backfill finished", "bf:done", "registrants"],
    ["a registrant fill in the middle of its walk", "rb:5000", "registrants"],
    ["an activity fill after the registrant walk finished", "rb:done", "activity"],
    ["an activity fill in the middle of its walk", "ac:777", "activity"],
    ["an activity fill after its walk finished", "ac:done", "activity"],
    ["an activity fill on the forward walk", FORWARD, "activity"],
  ];
  for (const [label, cursor, mode] of fits) {
    it(`runs ${label} and records a completed run`, async () => {
      const result = await runApprovedRobinhoodRegistrySource(source(cursor), "manual", mode);
      expect(mocks.beginIngestionRun).toHaveBeenCalledTimes(1);
      expect(mocks.fetchRobinhoodRegistry).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ requestCount: 3, nextCursor: "bf:100" });
      expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", nextCursor: "bf:100" }));
    });
  }

  it("runs observe from every position, including the forward walk and one it does not recognize", async () => {
    for (const cursor of [null, "bf:done", "rb:done", FORWARD, "garbage"]) {
      await runApprovedRobinhoodRegistrySource(source(cursor), "manual", "observe");
    }
    expect(mocks.beginIngestionRun).toHaveBeenCalledTimes(5);
  });

  it("keeps an observe run from erasing a walk position", async () => {
    await runApprovedRobinhoodRegistrySource(source(FORWARD), "manual", "observe");
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ nextCursor: FORWARD }));
  });
});

describe("real faults still record a failed run", () => {
  it("records a failed run, with the prior cursor, when the adapter fails after the mode fits", async () => {
    mocks.fetchRobinhoodRegistry.mockRejectedValue(new Error("rpc down"));
    await expect(runApprovedRobinhoodRegistrySource(source(FORWARD), "manual", "activity")).rejects.toThrow(/rpc down/);
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", nextCursor: FORWARD }));
  });

  it("does not pre-check scheduled runs: a stuck scheduler is a fault the run record must show", async () => {
    mocks.fetchRobinhoodRegistry.mockRejectedValue(new RobinhoodRegistryValidationError("Stored Robinhood cursor is not an approved forward-walk position."));
    await expect(runApprovedRobinhoodRegistrySource(source("bf:5", "scheduled"), "scheduled", "activity")).rejects.toThrow(/not an approved forward-walk position/);
    expect(mocks.beginIngestionRun).toHaveBeenCalledTimes(1);
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});

describe("the existing trigger guards still come first", () => {
  it("rejects replays and unscheduled unattended runs before anything else", async () => {
    await expect(runApprovedRobinhoodRegistrySource(source(FORWARD), "replay", "activity")).rejects.toThrow(/replays are rejected outright/);
    await expect(runApprovedRobinhoodRegistrySource(source(FORWARD, "manual_only"), "scheduled", "activity")).rejects.toThrow(/scheduled execution policy/);
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });
});
