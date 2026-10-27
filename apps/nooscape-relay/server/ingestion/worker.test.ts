import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * Worker tick tests: the solana_8004 dispatch (the 8004 chain pass earned its
 * scheduled flip in migration 0027 the same way the Metaplex chain pass did in
 * 0021), the two-source tick loop (0027 raises maxSourcesPerTick to 2), and
 * the maintenance invariants — publisher-key expiry runs on every tick
 * including paused and rate-limited ones, a failing source never starves the
 * sources behind it, and manual-only protocols stay out of the scheduled
 * worker without aborting the tick. Every db call and protocol runner is
 * mocked, so each test asserts exactly which sources ran, in claim order,
 * with which trigger.
 */
const mocks = vi.hoisted(() => ({
  claimDueIngestionSources: vi.fn(
    async (): Promise<{ config: unknown; sources: IngestionSource[]; reason: "paused" | "rate_limited" | "due" }> => ({
      config: {},
      sources: [],
      reason: "paused",
    })
  ),
  expireDuePublisherKeys: vi.fn(async () => ({ expiredCount: 0 })),
  finishIngestionWorkerTick: vi.fn(async (_error?: unknown) => {}),
  selectTodaysCatch: vi.fn(async (): Promise<{ date: string; status: string }> => ({ date: "2026-10-15", status: "kept" })),
  runBscClustering: vi.fn(async (_options?: { tickStartedAt?: number }) => ({ state: "completed" })),
  runBscRaters: vi.fn(async (_options?: { tickStartedAt?: number }) => ({ state: "completed" })),
  runRobinhoodNames: vi.fn(async (_options?: { tickStartedAt?: number }) => ({ state: "completed" })),
  runBscRegistrationFiles: vi.fn(async (_options?: { tickStartedAt?: number }) => ({ state: "completed" })),
  runSaidNames: vi.fn(async (_options?: { tickStartedAt?: number }) => ({ state: "completed" })),
  runChainNames: vi.fn(async (_options?: { tickStartedAt?: number }) => ({ state: "completed" })),
  recheckClaims: vi.fn(async () => ({ checked: 0, revoked: 0, unavailable: 0, stoppedBy: "done" as const })),
  runApprovedA2aSource: vi.fn(async (_source: unknown, _trigger: string) => ({})),
  runApprovedAgenstrySource: vi.fn(async (_source: unknown, _trigger: string) => ({})),
  runApprovedAgentEconomySource: vi.fn(async (_source: unknown, _trigger: string) => ({})),
  runApproved8004SolanaSource: vi.fn(async (_source: unknown, _trigger: string) => ({})),
  runApprovedMetaplexRegistrySource: vi.fn(async (_source: unknown, _trigger: string, _mode: string) => ({})),
  runApprovedRobinhoodRegistrySource: vi.fn(async (_source: unknown, _trigger: string, _mode: string) => ({})),
}));

vi.mock("../db", () => ({
  claimDueIngestionSources: mocks.claimDueIngestionSources,
  expireDuePublisherKeys: mocks.expireDuePublisherKeys,
  finishIngestionWorkerTick: mocks.finishIngestionWorkerTick,
}));
vi.mock("../owlsCatch", () => ({ selectTodaysCatch: mocks.selectTodaysCatch }));
vi.mock("../bscClusteringRun", () => ({ runBscClustering: mocks.runBscClustering }));
vi.mock("../bscRatersRun", () => ({ runBscRaters: mocks.runBscRaters }));
vi.mock("../robinhoodNames", () => ({ runRobinhoodNames: mocks.runRobinhoodNames }));
vi.mock("../bscRegistrationFiles", () => ({ runBscRegistrationFiles: mocks.runBscRegistrationFiles }));
vi.mock("../saidNames", () => ({ runSaidNames: mocks.runSaidNames }));
vi.mock("../chainNames", () => ({ runChainNames: mocks.runChainNames }));
vi.mock("../claims", () => ({ recheckClaims: mocks.recheckClaims }));
vi.mock("./runA2a", () => ({ runApprovedA2aSource: mocks.runApprovedA2aSource }));
vi.mock("./runAgenstry", () => ({ runApprovedAgenstrySource: mocks.runApprovedAgenstrySource }));
vi.mock("./runAgentEconomy", () => ({ runApprovedAgentEconomySource: mocks.runApprovedAgentEconomySource }));
vi.mock("./run8004Solana", () => ({ runApproved8004SolanaSource: mocks.runApproved8004SolanaSource }));
vi.mock("./runMetaplex", () => ({ runApprovedMetaplexRegistrySource: mocks.runApprovedMetaplexRegistrySource }));
vi.mock("./runRobinhood", () => ({ runApprovedRobinhoodRegistrySource: mocks.runApprovedRobinhoodRegistrySource }));

import { runRateLimitedIngestionTick } from "./worker";

const scheduledSource = (id: string, protocol: string) =>
  ({ id, protocol, state: "active", executionPolicy: "scheduled" } as unknown as IngestionSource);

describe("runRateLimitedIngestionTick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches a solana_8004 source to the 8004 chain pass with the scheduled trigger", async () => {
    const s8004 = scheduledSource("src-8004", "solana_8004");
    mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
    const result = await runRateLimitedIngestionTick();
    expect(mocks.runApproved8004SolanaSource).toHaveBeenCalledTimes(1);
    expect(mocks.runApproved8004SolanaSource).toHaveBeenCalledWith(s8004, "scheduled");
    expect(mocks.runApprovedMetaplexRegistrySource).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      state: "completed",
      attemptedSourceIds: ["src-8004"],
      completedSourceIds: ["src-8004"],
      failedSourceIds: [],
      expiredPublisherKeys: 0,
    });
  });

  it("runs every claimed source even when an earlier one fails, and reports the tick failed", async () => {
    // Migration 0027 raises the per-tick limit to two: the first source's
    // failure must not starve the second — each run owns its own run row,
    // cursor, and error, so the loop keeps going and the tick reports both.
    const failing = scheduledSource("src-fail", "erc8004");
    const healthy = scheduledSource("src-ok", "solana_8004");
    mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [failing, healthy], reason: "due" });
    mocks.runApprovedRobinhoodRegistrySource.mockRejectedValueOnce(new Error("chain rpc down"));
    const result = await runRateLimitedIngestionTick();
    expect(mocks.runApprovedRobinhoodRegistrySource).toHaveBeenCalledWith(failing, "scheduled", "activity");
    expect(mocks.runApproved8004SolanaSource).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      state: "failed",
      attemptedSourceIds: ["src-fail", "src-ok"],
      completedSourceIds: ["src-ok"],
      failedSourceIds: ["src-fail"],
    });
    expect(mocks.finishIngestionWorkerTick).toHaveBeenCalledTimes(1);
    const tickError = mocks.finishIngestionWorkerTick.mock.calls[0]![0] as Error;
    expect(tickError).toBeInstanceOf(Error);
    expect(tickError.message).toBe("chain rpc down");
  });

  it("keeps manual-only protocols out of the scheduled worker without stopping the tick", async () => {
    const reputation = scheduledSource("src-rating", "erc8004_reputation");
    const healthy = scheduledSource("src-ok", "solana_registry");
    mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [reputation, healthy], reason: "due" });
    const result = await runRateLimitedIngestionTick();
    expect(result.state).toBe("failed");
    expect(result.failedSourceIds).toEqual(["src-rating"]);
    expect(result.completedSourceIds).toEqual(["src-ok"]);
    // The Metaplex chain dispatch keeps its reviewed unattended mode.
    expect(mocks.runApprovedMetaplexRegistrySource).toHaveBeenCalledWith(healthy, "scheduled", "activity");
  });

  it("expires publisher keys on every tick, including paused and rate-limited ones", async () => {
    mocks.expireDuePublisherKeys.mockResolvedValueOnce({ expiredCount: 2 });
    mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [], reason: "paused" });
    const paused = await runRateLimitedIngestionTick();
    expect(paused).toMatchObject({ state: "paused", attemptedSourceIds: [], completedSourceIds: [], failedSourceIds: [], expiredPublisherKeys: 2 });
    mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [], reason: "rate_limited" });
    const limited = await runRateLimitedIngestionTick();
    expect(limited).toMatchObject({ state: "rate_limited", attemptedSourceIds: [], expiredPublisherKeys: 0 });
    // No source ran on either tick; neither ever claimed a tick row, so
    // there is nothing to finish.
    expect(mocks.runApproved8004SolanaSource).not.toHaveBeenCalled();
    expect(mocks.finishIngestionWorkerTick).not.toHaveBeenCalled();
  });

  it("never aborts the tick when publisher-key expiry itself fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.expireDuePublisherKeys.mockRejectedValueOnce(new Error("expiry db down"));
      const s8004 = scheduledSource("src-8004", "solana_8004");
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      const result = await runRateLimitedIngestionTick();
      // Best-effort maintenance: the expiry failure is logged and counted as
      // zero, and the claimed sources still run to completion.
      expect(result).toMatchObject({ state: "completed", expiredPublisherKeys: 0, completedSourceIds: ["src-8004"] });
      expect(errorLog).toHaveBeenCalledOnce();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("logs a failed publisher-key expiry on one line and at most 500 characters, as the other best-effort steps do", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A driver message can carry a statement with its line breaks and its parameters.
      const message = "Failed query: update publisher_keys" + String.fromCharCode(10) + "set state = ?" + String.fromCharCode(13, 10) + "params: " + "k".repeat(2_000);
      mocks.expireDuePublisherKeys.mockRejectedValueOnce(new Error(message));
      await runRateLimitedIngestionTick();
      const line = JSON.parse(String(errorLog.mock.calls[0]![0])) as { event: string; message: string };
      expect(line.event).toBe("nooscape_publisher_key_expiry_failed");
      expect(line.message).toHaveLength(500);
      expect(/[\r\n]+/.test(line.message)).toBe(false);
      expect(line.message.startsWith("Failed query: update publisher_keys set state = ? params: kkk")).toBe(true);
    } finally {
      errorLog.mockRestore();
    }
  });
  it("chooses the day's Owl's Catch after the ingestion work, on every kind of tick", async () => {
    const order: string[] = [];
    mocks.selectTodaysCatch.mockImplementation(async () => {
      order.push("catch");
      return { date: "2026-10-15", status: "kept" };
    });
    mocks.runApproved8004SolanaSource.mockImplementation(async () => {
      order.push("source");
      return {};
    });
    mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [scheduledSource("src-8004", "solana_8004")], reason: "due" });
    await runRateLimitedIngestionTick();
    expect(order).toEqual(["source", "catch"]);
    for (const reason of ["paused", "rate_limited"] as const) {
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [], reason });
      await runRateLimitedIngestionTick();
    }
    expect(mocks.selectTodaysCatch).toHaveBeenCalledTimes(3);
  });

  it("never lets the Owl's Catch fail the tick, or change what the tick reports", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.selectTodaysCatch.mockRejectedValueOnce(new Error("no such table\nowls_catch"));
      const s8004 = scheduledSource("src-8004", "solana_8004");
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      const result = await runRateLimitedIngestionTick();
      expect(result).toEqual({ state: "completed", attemptedSourceIds: ["src-8004"], completedSourceIds: ["src-8004"], failedSourceIds: [], expiredPublisherKeys: 0 });
      expect(errorLog).toHaveBeenCalledOnce();
      // One line, with no line break in the message, and a name an operator can search the log for.
      const line = String(errorLog.mock.calls[0]![0]);
      expect(JSON.parse(line)).toEqual({ event: "nooscape_owls_catch_failed", message: "no such table owls_catch" });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("clusters the BNB registry after the ingestion work, and only on a tick that claimed sources", async () => {
    const order: string[] = [];
    mocks.runApproved8004SolanaSource.mockImplementation(async () => {
      order.push("source");
      return {};
    });
    mocks.selectTodaysCatch.mockImplementation(async () => {
      order.push("catch");
      return { date: "2026-10-15", status: "kept" };
    });
    mocks.runBscClustering.mockImplementation(async () => {
      order.push("clusters");
      return { state: "completed" };
    });
    mocks.runBscRaters.mockImplementation(async () => {
      order.push("raters");
      return { state: "completed" };
    });
    mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [scheduledSource("src-8004", "solana_8004")], reason: "due" });
    const before = Date.now();
    await runRateLimitedIngestionTick();
    expect(order).toEqual(["source", "catch", "clusters", "raters"]);
    // It is told when the tick began, so it can leave a tick that has already run long alone.
    const started = mocks.runBscClustering.mock.calls[0]![0]!.tickStartedAt!;
    expect(started).toBeGreaterThanOrEqual(before);
    expect(started).toBeLessThanOrEqual(Date.now());
    // A failed tick claimed sources too; a paused one and a rate-limited one fetch nothing, and neither does the step.
    mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [scheduledSource("src-bad", "usdg_settlement")], reason: "due" });
    await runRateLimitedIngestionTick();
    expect(mocks.runBscClustering).toHaveBeenCalledTimes(2);
    expect(mocks.runBscRaters).toHaveBeenCalledTimes(2);
    for (const reason of ["paused", "rate_limited"] as const) {
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [], reason });
      await runRateLimitedIngestionTick();
    }
    expect(mocks.runBscClustering).toHaveBeenCalledTimes(2);
    expect(mocks.runBscRaters).toHaveBeenCalledTimes(2);
  });

  it("never lets the BNB rater step fail the tick, or stop the steps after it, or change what the tick reports", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.runBscRaters.mockRejectedValueOnce(new Error("no such table\nbsc_feedback_events"));
      const s8004 = scheduledSource("src-8004", "solana_8004");
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      const result = await runRateLimitedIngestionTick();
      expect(result).toEqual({ state: "completed", attemptedSourceIds: ["src-8004"], completedSourceIds: ["src-8004"], failedSourceIds: [], expiredPublisherKeys: 0 });
      expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).toEqual({ event: "nooscape_bsc_raters_failed", message: "no such table bsc_feedback_events" });
      // The clustering before it still ran, and a clustering that throws does not keep the raters from running.
      mocks.runBscClustering.mockRejectedValueOnce(new Error("clusters down"));
      mocks.runBscRaters.mockClear();
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      await runRateLimitedIngestionTick();
      expect(mocks.runBscRaters).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("runs the Robinhood name step on a tick that claimed sources, never on a paused or held-back one, and never lets it fail the tick", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s8004 = scheduledSource("src-8004", "solana_8004");
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      await runRateLimitedIngestionTick();
      expect(mocks.runRobinhoodNames).toHaveBeenCalledTimes(1);
      expect(mocks.runRobinhoodNames).toHaveBeenCalledWith({ tickStartedAt: expect.any(Number) });
      for (const reason of ["paused", "rate_limited"] as const) {
        mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [], reason });
        await runRateLimitedIngestionTick();
      }
      expect(mocks.runRobinhoodNames).toHaveBeenCalledTimes(1);
      mocks.runRobinhoodNames.mockRejectedValueOnce(new Error("names down\nsomething"));
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      const result = await runRateLimitedIngestionTick();
      expect(result).toEqual({ state: "completed", attemptedSourceIds: ["src-8004"], completedSourceIds: ["src-8004"], failedSourceIds: [], expiredPublisherKeys: 0 });
      expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).toEqual({ event: "nooscape_robinhood_names_failed", message: "names down something" });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("runs the BNB registration-file step on a tick that claimed sources, never on a paused or held-back one, and never lets it fail the tick or stop the steps before it", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s8004 = scheduledSource("src-8004", "solana_8004");
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      await runRateLimitedIngestionTick();
      expect(mocks.runBscRegistrationFiles).toHaveBeenCalledTimes(1);
      expect(mocks.runBscRegistrationFiles).toHaveBeenCalledWith({ tickStartedAt: expect.any(Number) });
      for (const reason of ["paused", "rate_limited"] as const) {
        mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [], reason });
        await runRateLimitedIngestionTick();
      }
      expect(mocks.runBscRegistrationFiles).toHaveBeenCalledTimes(1);
      mocks.runBscRegistrationFiles.mockRejectedValueOnce(new Error("files down\nsomething"));
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      const result = await runRateLimitedIngestionTick();
      expect(result).toEqual({ state: "completed", attemptedSourceIds: ["src-8004"], completedSourceIds: ["src-8004"], failedSourceIds: [], expiredPublisherKeys: 0 });
      expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).toEqual({ event: "nooscape_bsc_files_failed", message: "files down something" });
      // The step before it ran as well, and one that throws does not keep this one from running.
      mocks.runRobinhoodNames.mockRejectedValueOnce(new Error("names down"));
      mocks.runBscRegistrationFiles.mockClear();
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      await runRateLimitedIngestionTick();
      expect(mocks.runBscRegistrationFiles).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("runs the SAID name step last, on a tick that claimed sources, never on a paused or held-back one, and never lets it fail the tick or be stopped by the steps before it", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s8004 = scheduledSource("src-8004", "solana_8004");
      const order: string[] = [];
      mocks.runBscRegistrationFiles.mockImplementationOnce(async () => {
        order.push("files");
        return { state: "completed" };
      });
      mocks.runSaidNames.mockImplementationOnce(async () => {
        order.push("said");
        return { state: "completed" };
      });
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      await runRateLimitedIngestionTick();
      expect(order).toEqual(["files", "said"]);
      expect(mocks.runSaidNames).toHaveBeenCalledTimes(1);
      expect(mocks.runSaidNames).toHaveBeenCalledWith({ tickStartedAt: expect.any(Number) });
      for (const reason of ["paused", "rate_limited"] as const) {
        mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [], reason });
        await runRateLimitedIngestionTick();
      }
      expect(mocks.runSaidNames).toHaveBeenCalledTimes(1);
      mocks.runSaidNames.mockRejectedValueOnce(new Error("said names down\nsomething"));
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      const result = await runRateLimitedIngestionTick();
      expect(result).toEqual({ state: "completed", attemptedSourceIds: ["src-8004"], completedSourceIds: ["src-8004"], failedSourceIds: [], expiredPublisherKeys: 0 });
      expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).toEqual({ event: "nooscape_said_names_failed", message: "said names down something" });
      // A step before it that throws does not keep it from running.
      mocks.runBscRegistrationFiles.mockRejectedValueOnce(new Error("files down"));
      mocks.runSaidNames.mockClear();
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      await runRateLimitedIngestionTick();
      expect(mocks.runSaidNames).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("runs the Base, Arc and Ethereum name step after the SAID names, on a tick that claimed sources, never on a paused or held-back one, and never lets it fail the tick or be stopped by the steps before it", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s8004 = scheduledSource("src-8004", "solana_8004");
      const order: string[] = [];
      mocks.runSaidNames.mockImplementationOnce(async () => {
        order.push("said");
        return { state: "completed" };
      });
      mocks.runChainNames.mockImplementationOnce(async () => {
        order.push("chain-names");
        return { state: "completed" };
      });
      mocks.recheckClaims.mockImplementationOnce(async () => {
        order.push("claims");
        return { checked: 0, revoked: 0, unavailable: 0, stoppedBy: "done" as const };
      });
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      await runRateLimitedIngestionTick();
      expect(order).toEqual(["said", "chain-names", "claims"]);
      expect(mocks.runChainNames).toHaveBeenCalledTimes(1);
      expect(mocks.runChainNames).toHaveBeenCalledWith({ tickStartedAt: expect.any(Number) });
      for (const reason of ["paused", "rate_limited"] as const) {
        mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [], reason });
        await runRateLimitedIngestionTick();
      }
      expect(mocks.runChainNames).toHaveBeenCalledTimes(1);
      mocks.runChainNames.mockRejectedValueOnce(new Error("chain names down\nsomething"));
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      const result = await runRateLimitedIngestionTick();
      expect(result).toEqual({ state: "completed", attemptedSourceIds: ["src-8004"], completedSourceIds: ["src-8004"], failedSourceIds: [], expiredPublisherKeys: 0 });
      expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).toEqual({ event: "nooscape_chain_names_failed", message: "chain names down something" });
      // The step after it still ran, and a step before it that throws does not keep it from running.
      expect(mocks.recheckClaims).toHaveBeenCalledTimes(2);
      mocks.runSaidNames.mockRejectedValueOnce(new Error("said names down"));
      mocks.runChainNames.mockClear();
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      await runRateLimitedIngestionTick();
      expect(mocks.runChainNames).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("runs the daily check of claimed agents last, only on a tick that claimed sources, and never lets it fail the tick", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const s8004 = scheduledSource("src-8004", "solana_8004");
      const order: string[] = [];
      mocks.runSaidNames.mockImplementationOnce(async () => {
        order.push("said");
        return { state: "completed" };
      });
      mocks.recheckClaims.mockImplementationOnce(async () => {
        order.push("claims");
        return { checked: 2, revoked: 1, unavailable: 0, stoppedBy: "done" as const };
      });
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      await runRateLimitedIngestionTick();
      expect(order).toEqual(["said", "claims"]);
      expect(infoLog.mock.calls.map(call => String(call[0])).some(line => line.includes("nooscape_claim_recheck") && line.includes('"revoked":1'))).toBe(true);
      // A paused or held-back tick reads no chain, so it checks no claim.
      mocks.recheckClaims.mockClear();
      for (const reason of ["paused", "rate_limited"] as const) {
        mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [], reason });
        await runRateLimitedIngestionTick();
      }
      expect(mocks.recheckClaims).not.toHaveBeenCalled();
      // A failure is logged and changes nothing about what the tick reports.
      mocks.recheckClaims.mockRejectedValueOnce(new Error("claims down\nsomething"));
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      const result = await runRateLimitedIngestionTick();
      expect(result).toEqual({ state: "completed", attemptedSourceIds: ["src-8004"], completedSourceIds: ["src-8004"], failedSourceIds: [], expiredPublisherKeys: 0 });
      expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).toEqual({ event: "nooscape_claim_recheck_failed", message: "claims down something" });
    } finally {
      errorLog.mockRestore();
      infoLog.mockRestore();
    }
  });

  it("never lets the BNB clustering fail the tick, or change what the tick reports", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.runBscClustering.mockRejectedValueOnce(new Error("no such table\nbsc_clusters"));
      const s8004 = scheduledSource("src-8004", "solana_8004");
      mocks.claimDueIngestionSources.mockResolvedValueOnce({ config: {}, sources: [s8004], reason: "due" });
      const result = await runRateLimitedIngestionTick();
      expect(result).toEqual({ state: "completed", attemptedSourceIds: ["src-8004"], completedSourceIds: ["src-8004"], failedSourceIds: [], expiredPublisherKeys: 0 });
      expect(JSON.parse(String(errorLog.mock.calls[0]![0]))).toEqual({ event: "nooscape_bsc_clusters_failed", message: "no such table bsc_clusters" });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("says in the log when a day's catch is chosen, and nothing when it was already there", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      mocks.selectTodaysCatch.mockResolvedValueOnce({ date: "2026-10-16", status: "selected" });
      await runRateLimitedIngestionTick();
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "nooscape_owls_catch", date: "2026-10-16", status: "selected" }));
      log.mockClear();
      mocks.selectTodaysCatch.mockResolvedValueOnce({ date: "2026-10-16", status: "kept" });
      await runRateLimitedIngestionTick();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
