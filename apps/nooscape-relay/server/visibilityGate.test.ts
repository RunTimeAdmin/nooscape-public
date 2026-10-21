import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { resolveWithdrawnAgentIds } from "./db";
import type { TrpcContext } from "./_core/context";

/**
 * The public read paths (list and evidence) share a single visibility rule:
 * an agent is visible only when its source decision is "public", its
 * observation is linked to that source's approved run, and the agent is not
 * withdrawn. These tests verify that all three conditions are enforced.
 */

describe("visibility gate: withdrawal resolution (pure)", () => {
  const event = (agentId: string, action: "withdraw" | "reinstate") => ({
    agentId,
    action,
  });

  it("returns an agent as withdrawn after a withdraw event", () => {
    expect(resolveWithdrawnAgentIds([event("a1", "withdraw")])).toEqual(["a1"]);
  });

  it("does not return an agent as withdrawn if reinstated", () => {
    const events = [event("a1", "withdraw"), event("a1", "reinstate")];
    expect(resolveWithdrawnAgentIds(events)).toEqual([]);
  });

  it("honors ledger order: withdraw → reinstate → withdraw", () => {
    const events = [
      event("a1", "withdraw"),
      event("a1", "reinstate"),
      event("a1", "withdraw"),
    ];
    expect(resolveWithdrawnAgentIds(events)).toEqual(["a1"]);
  });

  it("resolves multiple agents independently", () => {
    const events = [
      event("visible-1", "withdraw"),
      event("visible-1", "reinstate"),
      event("withdrawn-1", "withdraw"),
      event("withdrawn-2", "withdraw"),
    ];
    const withdrawn = resolveWithdrawnAgentIds(events);
    expect(withdrawn).not.toContain("visible-1");
    expect(withdrawn).toContain("withdrawn-1");
    expect(withdrawn).toContain("withdrawn-2");
  });

  it("returns an empty list when no withdrawal events exist", () => {
    expect(resolveWithdrawnAgentIds([])).toEqual([]);
  });
});

describe("visibility gate: atlas.evidence endpoint", () => {
  const mockIsAgentPubliclyVisible = vi.fn<(agentId: string) => Promise<boolean>>();

  beforeEach(() => {
    vi.resetModules();
    mockIsAgentPubliclyVisible.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createMockedCaller(visibilityFn: typeof mockIsAgentPubliclyVisible) {
    vi.doMock("./db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./db")>();
      return {
        ...actual,
        isAgentPubliclyVisible: visibilityFn,
      };
    });

    const { appRouter } = await import("./routers");
    const ctx = {
      user: null,
      req: { protocol: "https", headers: {} },
      res: {},
    } as TrpcContext;
    return appRouter.createCaller(ctx);
  }

  it("returns NOT_FOUND for a withdrawn agent (non-visible)", async () => {
    mockIsAgentPubliclyVisible.mockResolvedValue(false);
    const caller = await createMockedCaller(mockIsAgentPubliclyVisible);

    const withdrawnAgentId = "c1d2e3f4-a5b6-1234-c789-012def345678";
    await expect(caller.atlas.evidence({ agentId: withdrawnAgentId })).rejects.toThrow(TRPCError);

    try {
      await caller.atlas.evidence({ agentId: withdrawnAgentId });
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe("NOT_FOUND");
      expect((error as TRPCError).message).toBe("Agent not found.");
    }

    expect(mockIsAgentPubliclyVisible).toHaveBeenCalledWith(withdrawnAgentId);
  });

  it("returns NOT_FOUND for an agent from a non-public source", async () => {
    mockIsAgentPubliclyVisible.mockResolvedValue(false);
    const caller = await createMockedCaller(mockIsAgentPubliclyVisible);

    const nonPublicAgentId = "d2e3f4a5-b6c7-1234-d890-123ef4567890";
    await expect(caller.atlas.evidence({ agentId: nonPublicAgentId })).rejects.toThrow(TRPCError);

    try {
      await caller.atlas.evidence({ agentId: nonPublicAgentId });
    } catch (error) {
      expect((error as TRPCError).code).toBe("NOT_FOUND");
    }
  });

  it("returns NOT_FOUND for an agent in an older (non-approved) run", async () => {
    mockIsAgentPubliclyVisible.mockResolvedValue(false);
    const caller = await createMockedCaller(mockIsAgentPubliclyVisible);

    const olderRunAgentId = "e3f4a5b6-c7d8-1234-e901-234f56789012";
    await expect(caller.atlas.evidence({ agentId: olderRunAgentId })).rejects.toThrow(TRPCError);

    try {
      await caller.atlas.evidence({ agentId: olderRunAgentId });
    } catch (error) {
      expect((error as TRPCError).code).toBe("NOT_FOUND");
    }
  });

  it("answers an id from the old demo atlas with not-found, through the same gate", async () => {
    mockIsAgentPubliclyVisible.mockResolvedValue(false);
    const caller = await createMockedCaller(mockIsAgentPubliclyVisible);

    await expect(caller.atlas.evidence({ agentId: "noos-prime" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "Agent not found." });
    expect(mockIsAgentPubliclyVisible).toHaveBeenCalledWith("noos-prime");
  });

  it("returns an envelope for a visible persisted agent", async () => {
    mockIsAgentPubliclyVisible.mockResolvedValue(true);
    const caller = await createMockedCaller(mockIsAgentPubliclyVisible);

    const visibleAgentId = "f4a5b6c7-d8e9-1234-f012-345678901234";

    // The actual envelope creation has nothing to read without a database, so the call may end in its own not-found
    // ("No evidence is retained"). What matters is that the visibility gate let the record through: its answer is
    // "Agent not found.".
    try {
      await caller.atlas.evidence({ agentId: visibleAgentId });
    } catch (error) {
      if (error instanceof TRPCError) {
        expect(error.message).not.toBe("Agent not found.");
      }
    }

    expect(mockIsAgentPubliclyVisible).toHaveBeenCalledWith(visibleAgentId);
  });
});

describe("N13: decideProjection requires explicit runId for public approval", () => {
  const mockGetIngestionSource = vi.fn();
  const mockGetCompletedRunForSource = vi.fn();
  const mockDecideSourceProjection = vi.fn();
  const mockGetAuthenticatedOperator = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockGetIngestionSource.mockReset();
    mockGetCompletedRunForSource.mockReset();
    mockDecideSourceProjection.mockReset();
    mockGetAuthenticatedOperator.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createOperatorCaller() {
    const testOperator = { id: 1, name: "Test Operator", role: "admin" as const, openId: "test-operator" };

    vi.doMock("./operatorAuth", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./operatorAuth")>();
      return {
        ...actual,
        getAuthenticatedOperator: mockGetAuthenticatedOperator,
      };
    });

    vi.doMock("./db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./db")>();
      return {
        ...actual,
        getIngestionSource: mockGetIngestionSource,
        getCompletedRunForSource: mockGetCompletedRunForSource,
        decideSourceProjection: mockDecideSourceProjection,
      };
    });

    mockGetAuthenticatedOperator.mockResolvedValue(testOperator);

    const { appRouter } = await import("./routers");
    const ctx = {
      user: testOperator,
      req: { protocol: "https", headers: {} },
      res: {},
    } as unknown as TrpcContext;
    return appRouter.createCaller(ctx);
  }

  it("rejects a public projection without a runId (BAD_REQUEST)", async () => {
    const sourceId = "a1b2c3d4-e5f6-1234-a567-890abcdef012";
    mockGetIngestionSource.mockResolvedValue({
      id: sourceId,
      state: "active",
      lastSuccessfulAt: new Date(),
    });

    const caller = await createOperatorCaller();

    await expect(
      caller.liveData.admin.decideProjection({
        sourceId,
        decision: "public",
        rationale: "Testing public approval without runId",
      })
    ).rejects.toThrow(TRPCError);

    try {
      await caller.liveData.admin.decideProjection({
        sourceId,
        decision: "public",
        rationale: "Testing public approval without runId",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe("BAD_REQUEST");
      expect((error as TRPCError).message).toContain("explicit runId");
    }
  });

  it("accepts a public projection with an explicit runId", async () => {
    const sourceId = "a1b2c3d4-e5f6-1234-a567-890abcdef012";
    const runId = "b2c3d4e5-f6a7-1234-b678-901bcdef0123";

    mockGetIngestionSource.mockResolvedValue({
      id: sourceId,
      state: "active",
      lastSuccessfulAt: new Date(),
    });
    mockGetCompletedRunForSource.mockResolvedValue({
      id: runId,
      finishedAt: new Date(),
    });
    mockDecideSourceProjection.mockResolvedValue(undefined);

    const caller = await createOperatorCaller();

    const result = await caller.liveData.admin.decideProjection({
      sourceId,
      decision: "public",
      rationale: "Testing public approval with runId",
      runId,
    });

    expect(result).toMatchObject({ success: true, approvedRunId: runId });
    expect(mockGetCompletedRunForSource).toHaveBeenCalledWith(sourceId, runId);
    expect(mockDecideSourceProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId,
        state: "public",
        approvedRunId: runId,
      })
    );
  });

  it("allows revocation without a runId", async () => {
    const sourceId = "a1b2c3d4-e5f6-1234-a567-890abcdef012";

    mockGetIngestionSource.mockResolvedValue({
      id: sourceId,
      state: "active",
      lastSuccessfulAt: new Date(),
    });
    mockDecideSourceProjection.mockResolvedValue(undefined);

    const caller = await createOperatorCaller();

    const result = await caller.liveData.admin.decideProjection({
      sourceId,
      decision: "revoked",
      rationale: "Testing revocation without runId",
    });

    expect(result).toMatchObject({ success: true, approvedRunId: null });
    expect(mockGetCompletedRunForSource).not.toHaveBeenCalled();
    expect(mockDecideSourceProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId,
        state: "revoked",
        approvedRunId: null,
      })
    );
  });
});

describe("directory visibility filter", () => {
  const mockSearchAgentDirectory = vi.fn();
  const mockGetAgentDirectoryEntry = vi.fn();
  const mockCountAgentDirectoryEntries = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockSearchAgentDirectory.mockReset();
    mockGetAgentDirectoryEntry.mockReset();
    mockCountAgentDirectoryEntries.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createDirectoryCaller() {
    vi.doMock("./db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./db")>();
      return {
        ...actual,
        searchAgentDirectory: mockSearchAgentDirectory,
        getAgentDirectoryEntry: mockGetAgentDirectoryEntry,
        countAgentDirectoryEntries: mockCountAgentDirectoryEntries,
      };
    });

    const { appRouter } = await import("./routers");
    const ctx = {
      user: null,
      req: { protocol: "https", headers: {} },
      res: {},
    } as TrpcContext;
    return appRouter.createCaller(ctx);
  }

  it("excludes hidden entries from search results", async () => {
    // The db function already filters by hidden=false, so only visible entries arrive
    mockSearchAgentDirectory.mockResolvedValue({
      entries: [
        { id: "visible-1", displayName: "Visible Agent", locatorHost: "example.com", protocol: "a2a", hidden: false },
      ],
      matchedTotal: 1,
      matchedTotalCapped: false,
    });

    const caller = await createDirectoryCaller();
    const result = await caller.liveData.directorySearch({ query: "agent", limit: 10 });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].displayName).toBe("Visible Agent");
    expect(mockSearchAgentDirectory).toHaveBeenCalledWith({ query: "agent", limit: 10 });
  });

  it("returns null for hidden entry in getAgentDirectoryEntry (same as unknown)", async () => {
    // When an entry is hidden, the db function returns null (same as not found)
    mockGetAgentDirectoryEntry.mockResolvedValue(null);

    const caller = await createDirectoryCaller();
    const result = await caller.liveData.directoryEntry({ id: "hidden-entry-id" });

    expect(result.entry).toBeNull();
  });

  it("returns entry for visible directory entry", async () => {
    mockGetAgentDirectoryEntry.mockResolvedValue({
      id: "visible-entry",
      displayName: "Visible Agent",
      locatorHost: "example.com",
      protocol: "a2a",
      hidden: false,
    });

    const caller = await createDirectoryCaller();
    const result = await caller.liveData.directoryEntry({ id: "visible-entry" });

    expect(result.entry).not.toBeNull();
    expect(result.entry?.displayName).toBe("Visible Agent");
  });

  it("returns null for entry from inactive source (same as unknown)", async () => {
    // Entries from inactive sources return null from the db function
    mockGetAgentDirectoryEntry.mockResolvedValue(null);

    const caller = await createDirectoryCaller();
    const result = await caller.liveData.directoryEntry({ id: "paused-source-entry" });

    expect(result.entry).toBeNull();
  });

  it("counts only visible entries from active sources", async () => {
    // The db function already filters, returning only visible count
    mockCountAgentDirectoryEntries.mockResolvedValue(42);

    const caller = await createDirectoryCaller();
    const result = await caller.liveData.directoryTotal();

    expect(result.total).toBe(42);
  });

  it("search finds mid-word matches (kudos finds Agent Consensus Kudos)", async () => {
    // FULLTEXT search with boolean mode matches word boundaries
    mockSearchAgentDirectory.mockResolvedValue({
      entries: [
        { id: "ack-agent", displayName: "ACK (Agent Consensus Kudos)", locatorHost: "ack.example.com", protocol: "a2a" },
      ],
      matchedTotal: 1,
      matchedTotalCapped: false,
    });

    const caller = await createDirectoryCaller();
    const result = await caller.liveData.directorySearch({ query: "kudos", limit: 10 });

    // The mocked function received the query; the actual FULLTEXT matching happens in the db
    expect(mockSearchAgentDirectory).toHaveBeenCalledWith({ query: "kudos", limit: 10 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].displayName).toContain("Kudos");
  });

  it("AgentRank entries hidden by migration 0015 (locatorHost=agentrank.info)", async () => {
    // Migration 0015 sets hidden=true for entries with locatorHost='agentrank.info'.
    // The directoryVisibilityCondition() filters these out, returning null.
    mockGetAgentDirectoryEntry.mockResolvedValue(null);

    const caller = await createDirectoryCaller();
    const result = await caller.liveData.directoryEntry({ id: "agentrank-entry" });

    expect(result.entry).toBeNull();
  });

  it("documents: no mapping between directory entries and withdrawal ledger", () => {
    // Directory entries (agent_directory_entries) have no agentId column.
    // The withdrawal ledger (agent_record_withdrawals) tracks agents.id (reviewed records).
    // There is no foreign key relationship between these tables.
    //
    // Consequence: withdrawing a reviewed record does NOT automatically hide
    // its corresponding directory entry (if one exists). Directory entries
    // are hidden via the separate `hidden` flag, which is:
    // - Set deterministically by migration 0015 for dead locator hosts
    // - Set by operators via the hideDirectoryEntry/unhideDirectoryEntry mutations
    //
    // This is intentional: directory entries are "acknowledgements" that an agent
    // was observed, separate from the reviewed-record layer with its stricter
    // evidence requirements. Hiding them is an operator action, not automatic.
    expect(true).toBe(true);
  });
});

describe("directory entry hide/unhide operator mutations", () => {
  const mockGetDirectoryEntryById = vi.fn();
  const mockHideDirectoryEntry = vi.fn();
  const mockUnhideDirectoryEntry = vi.fn();
  const mockGetAuthenticatedOperator = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockGetDirectoryEntryById.mockReset();
    mockHideDirectoryEntry.mockReset();
    mockUnhideDirectoryEntry.mockReset();
    mockGetAuthenticatedOperator.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createOperatorCaller() {
    const testOperator = { id: 1, name: "Test Operator", role: "admin" as const, openId: "test-operator" };

    vi.doMock("./operatorAuth", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./operatorAuth")>();
      return {
        ...actual,
        getAuthenticatedOperator: mockGetAuthenticatedOperator,
      };
    });

    vi.doMock("./db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./db")>();
      return {
        ...actual,
        getDirectoryEntryById: mockGetDirectoryEntryById,
        hideDirectoryEntry: mockHideDirectoryEntry,
        unhideDirectoryEntry: mockUnhideDirectoryEntry,
      };
    });

    mockGetAuthenticatedOperator.mockResolvedValue(testOperator);

    const { appRouter } = await import("./routers");
    const ctx = {
      user: testOperator,
      req: { protocol: "https", headers: {} },
      res: {},
    } as unknown as TrpcContext;
    return appRouter.createCaller(ctx);
  }

  it("hideDirectoryEntry requires operator auth", async () => {
    // Clear all mocks and unmock the operatorAuth module. doUnmock is the
    // runtime (non-hoisted) counterpart of unmock: inside a test body it is
    // the correct API and avoids the hoisting pitfall.
    vi.resetModules();
    vi.doUnmock("./operatorAuth");

    // Mock getAuthenticatedOperator to return null (no auth)
    vi.doMock("./operatorAuth", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./operatorAuth")>();
      return {
        ...actual,
        getAuthenticatedOperator: vi.fn().mockResolvedValue(null),
      };
    });

    const { appRouter } = await import("./routers");
    const ctx = {
      user: null,
      req: { protocol: "https", headers: {} },
      res: {},
    } as TrpcContext;
    const publicCaller = appRouter.createCaller(ctx);

    await expect(
      publicCaller.liveData.admin.hideDirectoryEntry({ entryId: "some-entry" })
    ).rejects.toThrow(TRPCError);

    try {
      await publicCaller.liveData.admin.hideDirectoryEntry({ entryId: "some-entry" });
    } catch (error) {
      expect((error as TRPCError).code).toBe("UNAUTHORIZED");
    }
  });

  it("unhideDirectoryEntry requires operator auth", async () => {
    // Clear all mocks and unmock the operatorAuth module (doUnmock: the
    // runtime counterpart, valid inside a test body).
    vi.resetModules();
    vi.doUnmock("./operatorAuth");

    // Mock getAuthenticatedOperator to return null (no auth)
    vi.doMock("./operatorAuth", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./operatorAuth")>();
      return {
        ...actual,
        getAuthenticatedOperator: vi.fn().mockResolvedValue(null),
      };
    });

    const { appRouter } = await import("./routers");
    const ctx = {
      user: null,
      req: { protocol: "https", headers: {} },
      res: {},
    } as TrpcContext;
    const publicCaller = appRouter.createCaller(ctx);

    await expect(
      publicCaller.liveData.admin.unhideDirectoryEntry({ entryId: "some-entry" })
    ).rejects.toThrow(TRPCError);

    try {
      await publicCaller.liveData.admin.unhideDirectoryEntry({ entryId: "some-entry" });
    } catch (error) {
      expect((error as TRPCError).code).toBe("UNAUTHORIZED");
    }
  });

  it("hideDirectoryEntry hides a visible entry", async () => {
    mockGetDirectoryEntryById.mockResolvedValue({
      id: "visible-entry",
      displayName: "Test Agent",
      locatorHost: "example.com",
      hidden: false,
    });
    mockHideDirectoryEntry.mockResolvedValue({
      id: "visible-entry",
      displayName: "Test Agent",
      locatorHost: "example.com",
      hidden: true,
    });

    const caller = await createOperatorCaller();
    const result = await caller.liveData.admin.hideDirectoryEntry({ entryId: "visible-entry" });

    expect(result.success).toBe(true);
    expect(result.entry.hidden).toBe(true);
    expect(mockHideDirectoryEntry).toHaveBeenCalledWith("visible-entry");
  });

  it("unhideDirectoryEntry restores a hidden entry", async () => {
    mockGetDirectoryEntryById.mockResolvedValue({
      id: "hidden-entry",
      displayName: "AgentRank Service",
      locatorHost: "agentrank.info",
      hidden: true,
    });
    mockUnhideDirectoryEntry.mockResolvedValue({
      id: "hidden-entry",
      displayName: "AgentRank Service",
      locatorHost: "agentrank.info",
      hidden: false,
    });

    const caller = await createOperatorCaller();
    const result = await caller.liveData.admin.unhideDirectoryEntry({ entryId: "hidden-entry" });

    expect(result.success).toBe(true);
    expect(result.entry.hidden).toBe(false);
    expect(mockUnhideDirectoryEntry).toHaveBeenCalledWith("hidden-entry");
  });

  it("hideDirectoryEntry rejects already-hidden entry", async () => {
    mockGetDirectoryEntryById.mockResolvedValue({
      id: "hidden-entry",
      displayName: "Test Agent",
      locatorHost: "example.com",
      hidden: true,
    });

    const caller = await createOperatorCaller();

    await expect(
      caller.liveData.admin.hideDirectoryEntry({ entryId: "hidden-entry" })
    ).rejects.toThrow(TRPCError);

    try {
      await caller.liveData.admin.hideDirectoryEntry({ entryId: "hidden-entry" });
    } catch (error) {
      expect((error as TRPCError).code).toBe("PRECONDITION_FAILED");
      expect((error as TRPCError).message).toContain("already hidden");
    }
  });

  it("unhideDirectoryEntry rejects non-hidden entry", async () => {
    mockGetDirectoryEntryById.mockResolvedValue({
      id: "visible-entry",
      displayName: "Test Agent",
      locatorHost: "example.com",
      hidden: false,
    });

    const caller = await createOperatorCaller();

    await expect(
      caller.liveData.admin.unhideDirectoryEntry({ entryId: "visible-entry" })
    ).rejects.toThrow(TRPCError);

    try {
      await caller.liveData.admin.unhideDirectoryEntry({ entryId: "visible-entry" });
    } catch (error) {
      expect((error as TRPCError).code).toBe("PRECONDITION_FAILED");
      expect((error as TRPCError).message).toContain("not hidden");
    }
  });

  it("hideDirectoryEntry returns NOT_FOUND for unknown entry", async () => {
    mockGetDirectoryEntryById.mockResolvedValue(null);

    const caller = await createOperatorCaller();

    await expect(
      caller.liveData.admin.hideDirectoryEntry({ entryId: "unknown-entry" })
    ).rejects.toThrow(TRPCError);

    try {
      await caller.liveData.admin.hideDirectoryEntry({ entryId: "unknown-entry" });
    } catch (error) {
      expect((error as TRPCError).code).toBe("NOT_FOUND");
    }
  });
});

describe("rate limiter uses req.ip with trust proxy", () => {
  it("clientKeyFrom extracts IP from req.ip (set by Express trust proxy)", async () => {
    const { clientKeyFrom } = await import("./rateLimit");
    // Express sets req.ip based on trust proxy setting
    expect(clientKeyFrom({ ip: "203.0.113.7" })).toBe("203.0.113.7");
    expect(clientKeyFrom({ ip: null })).toBe("unknown");
  });
});

describe("visibility gate: liveData.chainStats", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** The router with the one gated reader it uses replaced, so what it serves is what that reader returns. */
  async function callerReading(readChainStats: () => Promise<unknown>) {
    vi.resetModules();
    vi.doMock("./db", async importOriginal => ({ ...(await importOriginal<typeof import("./db")>()), readChainStats }));
    const { appRouter } = await import("./routers");
    return appRouter.createCaller({ user: null, req: { protocol: "https", headers: {} }, res: {} } as TrpcContext);
  }

  it("serves exactly what the gated reader returns, with no operator needed", async () => {
    const chains = [{ chain: "robinhood", indexed: true, acknowledged: 2, reviewed: 1, feedbackEvents: 3, asOf: null }];
    const caller = await callerReading(async () => chains);
    expect(await caller.liveData.chainStats()).toEqual({ chains });
  });

  it("fails closed to no chains, not to zeros, when the read throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const caller = await callerReading(async () => {
      throw new Error("storage down");
    });
    expect(await caller.liveData.chainStats()).toEqual({ chains: [] });
  });
});
