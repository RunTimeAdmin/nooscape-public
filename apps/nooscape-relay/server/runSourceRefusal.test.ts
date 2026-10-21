import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * What the operator sees when a walk click cannot run from the persisted
 * cursor. The run procedure used to turn every non-tRPC error into the generic
 * "Live data is temporarily unavailable.", so a refused click looked like an
 * outage. A refusal is now a BAD_REQUEST carrying its own message, no run row
 * is written, and every other fault keeps the generic message and still records
 * a failed run. Exercised through the real router, runner, and guards; only the
 * database reads and writes are replaced, and nothing here reaches the network.
 */
const mocks = vi.hoisted(() => ({
  getIngestionSource: vi.fn(),
  beginIngestionRun: vi.fn(async (_source: unknown, _trigger: string) => "run-1"),
  finishIngestionRun: vi.fn(async (_input: unknown) => {}),
  getAuthenticatedOperator: vi.fn(),
  assertPublicHostname: vi.fn(async (_hostname: string) => {}),
}));

const FORWARD = `fw:85000000#0x${"0a".repeat(32)}`;
const OPERATOR = { id: 1, name: "Test Operator", role: "admin" as const, openId: "test-operator" };

function source(overrides: Record<string, unknown>) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    state: "active",
    executionPolicy: "manual_only",
    scheduleMinutes: 1440,
    cursor: null,
    ...overrides,
  };
}

async function operatorCaller() {
  vi.doMock("./operatorAuth", async importOriginal => {
    const actual = await importOriginal<typeof import("./operatorAuth")>();
    return { ...actual, getAuthenticatedOperator: mocks.getAuthenticatedOperator };
  });
  vi.doMock("./db", async importOriginal => {
    const actual = await importOriginal<typeof import("./db")>();
    return {
      ...actual,
      getIngestionSource: mocks.getIngestionSource,
      beginIngestionRun: mocks.beginIngestionRun,
      finishIngestionRun: mocks.finishIngestionRun,
    };
  });
  // The BNB Chain pass checks its host resolves to a public address; no test here resolves anything.
  vi.doMock("./ingestion/a2a", async importOriginal => {
    const actual = await importOriginal<typeof import("./ingestion/a2a")>();
    return { ...actual, assertPublicHostname: mocks.assertPublicHostname };
  });
  mocks.getAuthenticatedOperator.mockResolvedValue(OPERATOR);
  const { appRouter } = await import("./routers");
  const ctx = { user: OPERATOR, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext;
  return appRouter.createCaller(ctx);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("./operatorAuth");
  vi.doUnmock("./db");
  vi.doUnmock("./ingestion/a2a");
});

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

// The first call imports the whole router graph, which took about 3 s alone and overran the 5 s default under a
// loaded full-suite run, so these suites get headroom.
describe("a refused walk click reaches the operator as a clear message", { timeout: 30_000 }, () => {
  it("tells the operator a backfill cannot run on the forward walk, and writes no run", async () => {
    mocks.getIngestionSource.mockResolvedValue(source({ protocol: "erc8004", sourceKey: "robinhood-erc8004-identity-registry", cursor: FORWARD }));
    const caller = await operatorCaller();
    const error = await rejection(caller.liveData.admin.runSource({ sourceId: "00000000-0000-4000-8000-000000000001", mode: "backfill" }));
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("BAD_REQUEST");
    expect((error as TRPCError).message).toBe("Backfill window cannot run from the current position, forward walk (fw:85000000). Fill activity can run from here.");
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
    expect(mocks.finishIngestionRun).not.toHaveBeenCalled();
  });

  it("does the same for the reputation source, whose guard now reaches the operator too", async () => {
    mocks.getIngestionSource.mockResolvedValue(source({ protocol: "erc8004_reputation", sourceKey: "robinhood-erc8004-reputation-registry", cursor: "rb:done" }));
    const caller = await operatorCaller();
    const error = await rejection(caller.liveData.admin.runSource({ sourceId: "00000000-0000-4000-8000-000000000001", mode: "backfill" }));
    expect((error as TRPCError).code).toBe("BAD_REQUEST");
    expect((error as TRPCError).message).toMatch(/already reached genesis/);
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });
});

describe("any other fault keeps the generic message and still records a failed run", { timeout: 30_000 }, () => {
  it("does not mistake an adapter fault for an operator mistake", async () => {
    // The mode fits the cursor, so the run opens; the adapter then rejects the
    // source (its key is not the approved one) before any network call.
    mocks.getIngestionSource.mockResolvedValue(source({ protocol: "erc8004", sourceKey: "not-the-approved-source", cursor: FORWARD }));
    const caller = await operatorCaller();
    const error = await rejection(caller.liveData.admin.runSource({ sourceId: "00000000-0000-4000-8000-000000000001", mode: "activity" }));
    expect((error as TRPCError).code).toBe("PRECONDITION_FAILED");
    expect((error as TRPCError).message).toBe("Live data is temporarily unavailable.");
    expect(mocks.beginIngestionRun).toHaveBeenCalledTimes(1);
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", nextCursor: FORWARD }));
  });
});

// The BNB Chain pass's failures are fixed, URL-free messages by construction, so the operator is told which one it
// was. They used to read as "Live data is temporarily unavailable.", so a first run that failed because the endpoint
// variable was unset looked exactly like an outage.
describe("a BNB Chain run that fails tells the operator which failure it was", { timeout: 30_000 }, () => {
  const BSC = {
    protocol: "erc8004_bsc",
    sourceKey: "bsc-erc8004-identity-registry",
    rootUrl: "https://bsc-mainnet.nodereal.io",
    allowedHostname: "bsc-mainnet.nodereal.io",
  };
  const run = async () => {
    const caller = await operatorCaller();
    return rejection(caller.liveData.admin.runSource({ sourceId: "00000000-0000-4000-8000-000000000001", mode: "activity" }));
  };

  it("names the missing endpoint variable, records a failed run, and reaches neither DNS nor the provider", async () => {
    vi.stubEnv("BSC_RPC_URL", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.getIngestionSource.mockResolvedValue(source(BSC));
    const error = await run();
    expect((error as TRPCError).code).toBe("PRECONDITION_FAILED");
    expect((error as TRPCError).message).toBe("BSC_RPC_URL is not configured, so the BNB Chain identity pass cannot run.");
    expect(mocks.assertPublicHostname).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", nextCursor: null }));
  });

  it("names a variable that points at the wrong host, before any network call", async () => {
    vi.stubEnv("BSC_RPC_URL", "https://evil.example.com/v1/not-the-approved-host");
    mocks.getIngestionSource.mockResolvedValue(source(BSC));
    const error = await run();
    expect((error as TRPCError).message).toBe("BSC_RPC_URL does not point at the approved BNB Chain RPC host.");
    expect(mocks.assertPublicHostname).not.toHaveBeenCalled();
  });

  it("tells the operator a provider refusal was HTTP 401, with no trace of the endpoint or its key", async () => {
    vi.stubEnv("BSC_RPC_URL", "https://bsc-mainnet.nodereal.io/v1/TESTKEYTESTKEYTESTKEYTESTKEY12");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("denied", { status: 401 }));
    mocks.getIngestionSource.mockResolvedValue(source(BSC));
    const error = await run();
    expect((error as TRPCError).code).toBe("BAD_GATEWAY");
    expect((error as TRPCError).message).toBe("BNB Chain eth_chainId returned HTTP 401.");
    expect(JSON.stringify(error)).not.toContain("TESTKEY");
    expect(mocks.assertPublicHostname).toHaveBeenCalledWith("bsc-mainnet.nodereal.io");
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("says what failed when the RPC host does not pass the public-network check", async () => {
    vi.stubEnv("BSC_RPC_URL", "https://bsc-mainnet.nodereal.io/v1/TESTKEYTESTKEYTESTKEYTESTKEY12");
    mocks.assertPublicHostname.mockRejectedValueOnce(new Error("The A2A hostname could not be resolved."));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.getIngestionSource.mockResolvedValue(source(BSC));
    const error = await run();
    expect((error as TRPCError).code).toBe("BAD_GATEWAY");
    expect((error as TRPCError).message).toBe("The BNB Chain RPC host failed the public-network check: The A2A hostname could not be resolved.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
