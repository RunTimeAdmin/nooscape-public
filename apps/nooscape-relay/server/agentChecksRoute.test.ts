import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * The second cron job's endpoint, through the real router: `liveData.admin.runChecks` is for the operator's token and for
 * nobody else, and with the token it runs the checks and answers with what the run returns. Only the operator lookup and
 * the run itself are replaced, so nothing here reaches a database or a network.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedOperator: vi.fn(),
  runLivenessChecks: vi.fn(async () => ({ state: "completed" as const, due: 3, taken: 3, asked: 3, answered: 2, noAnswer: 1, skipped: 0, notReached: 0, recorded: 3, failedToRecord: 0, ms: 1200 })),
  readPublicChecks: vi.fn(),
  listLiveAtlasRecords: vi.fn(),
  listAgentEvidenceTimeline: vi.fn(),
  getAgentDirectoryEntry: vi.fn(),
}));
const OPERATOR = { id: 1, name: "Test Operator", role: "admin" as const, openId: "test-operator" };

async function callerWith(operator: typeof OPERATOR | null) {
  vi.doMock("./operatorAuth", async importOriginal => {
    const actual = await importOriginal<typeof import("./operatorAuth")>();
    return { ...actual, getAuthenticatedOperator: mocks.getAuthenticatedOperator };
  });
  vi.doMock("./agentChecks", async importOriginal => ({ ...(await importOriginal<typeof import("./agentChecks")>()), runLivenessChecks: mocks.runLivenessChecks }));
  mocks.getAuthenticatedOperator.mockResolvedValue(operator);
  const { appRouter } = await import("./routers");
  return appRouter.createCaller({ user: operator, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.doUnmock("./operatorAuth");
  vi.doUnmock("./agentChecks");
  vi.doUnmock("./db");
});

// The first call imports the whole router graph, which can take a few seconds under a loaded full run.
describe("runChecks", { timeout: 30_000 }, () => {
  it("refuses a caller without the operator's token, and runs nothing", async () => {
    const caller = await callerWith(null);
    const error = await caller.liveData.admin.runChecks().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("UNAUTHORIZED");
    expect(mocks.runLivenessChecks).not.toHaveBeenCalled();
  });

  it("runs the checks for the operator, once, and answers with what the run returns and nothing more", async () => {
    const caller = await callerWith(OPERATOR);
    const answer = await caller.liveData.admin.runChecks();
    expect(mocks.runLivenessChecks).toHaveBeenCalledTimes(1);
    expect(answer).toEqual({ state: "completed", due: 3, taken: 3, asked: 3, answered: 2, noAnswer: 1, skipped: 0, notReached: 0, recorded: 3, failedToRecord: 0, ms: 1200 });
  });

  it("is not a public procedure: asked for outside the admin router, there is nothing there", async () => {
    const caller = await callerWith(OPERATOR);
    const error = await (caller.liveData as unknown as { runChecks: () => Promise<unknown> }).runChecks().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("NOT_FOUND");
    expect(mocks.runLivenessChecks).not.toHaveBeenCalled();
  });
});

/**
 * The agent page's read, through the real router: a reviewed record carries the checks of its endpoints, an acknowledged entry
 * carries none and the checks are not even read for it, and a read that fails closes to "none" with an empty list. The
 * database functions and the checks read are replaced, so nothing here reaches a database or a network.
 */
describe("agentProfile and the checks", { timeout: 30_000 }, () => {
  const CHECK = { host: "agent.example.com", checkedAt: new Date("2026-10-16T10:00:00Z"), outcome: "answered" as const, statusCode: 200, latencyMs: 120, failing: false };

  async function profileCaller() {
    vi.doMock("./db", async importOriginal => ({
      ...(await importOriginal<typeof import("./db")>()),
      listLiveAtlasRecords: mocks.listLiveAtlasRecords,
      listAgentEvidenceTimeline: mocks.listAgentEvidenceTimeline,
      getAgentDirectoryEntry: mocks.getAgentDirectoryEntry,
    }));
    vi.doMock("./agentChecks", async importOriginal => ({ ...(await importOriginal<typeof import("./agentChecks")>()), readPublicChecks: mocks.readPublicChecks }));
    const { appRouter } = await import("./routers");
    return appRouter.createCaller({ user: null, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext);
  }

  it("carries the checks of a reviewed record, and reads them for that record's id", async () => {
    mocks.listLiveAtlasRecords.mockResolvedValue([{ agentId: "agent-1", displayName: "One" }]);
    mocks.listAgentEvidenceTimeline.mockResolvedValue([]);
    mocks.readPublicChecks.mockResolvedValue([CHECK]);
    const profile = await (await profileCaller()).liveData.agentProfile({ id: "agent-1" });
    expect(profile.kind).toBe("reviewed");
    expect(profile.checks).toEqual([CHECK]);
    expect(mocks.readPublicChecks).toHaveBeenCalledTimes(1);
    expect(mocks.readPublicChecks).toHaveBeenCalledWith("agent-1");
  });

  it("carries an empty list for an acknowledged entry, and does not read the checks for it", async () => {
    mocks.listLiveAtlasRecords.mockResolvedValue([]);
    mocks.getAgentDirectoryEntry.mockResolvedValue({ id: "entry-1", displayName: "Entry" });
    const profile = await (await profileCaller()).liveData.agentProfile({ id: "entry-1" });
    expect(profile.kind).toBe("acknowledged");
    expect(profile.checks).toEqual([]);
    expect(mocks.readPublicChecks).not.toHaveBeenCalled();
  });

  it("closes to none with an empty list when the records cannot be read", async () => {
    mocks.listLiveAtlasRecords.mockRejectedValue(new Error("down"));
    const profile = await (await profileCaller()).liveData.agentProfile({ id: "agent-1" });
    expect(profile).toEqual({ kind: "none", record: null, timeline: [], entry: null, checks: [] });
    expect(mocks.readPublicChecks).not.toHaveBeenCalled();
  });
});
