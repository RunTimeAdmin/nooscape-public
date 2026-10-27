import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * The operator's side of the AgenC registry, through the real router: staging its source and running it. What is held: only the operator can
 * do either; the staged source is made from the preset, in review, manual only, on the public Solana RPC host and with the key the pass
 * accepts; staging it twice makes one source; the run goes to the AgenC pass and only as the chain activity pass; and a database that has
 * not had migration 0051 pasted is put to the operator as the step that is missing. The database and the run itself are replaced, so nothing
 * here reaches a database or a node.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedOperator: vi.fn(),
  listIngestionSources: vi.fn(async () => [] as unknown[]),
  createIngestionSource: vi.fn(async (_input: unknown) => ({ sourceId: "00000000-0000-4000-8000-000000000001" })),
  getIngestionSource: vi.fn(),
  runApprovedAgencSource: vi.fn(async (..._args: unknown[]) => ({ requestCount: 2, discoveredCount: 256, acceptedCount: 256, rejectedCount: 0, nextCursor: "agenc:461650417" })),
}));
const OPERATOR = { id: 7, name: "Test Operator", role: "admin" as const, openId: "test-operator" };
const SOURCE_ID = "00000000-0000-4000-8000-0000000000aa";

async function callerWith(operator: typeof OPERATOR | null) {
  vi.doMock("./operatorAuth", async importOriginal => ({ ...(await importOriginal<typeof import("./operatorAuth")>()), getAuthenticatedOperator: mocks.getAuthenticatedOperator }));
  vi.doMock("./db", async importOriginal => ({
    ...(await importOriginal<typeof import("./db")>()),
    listIngestionSources: mocks.listIngestionSources,
    createIngestionSource: mocks.createIngestionSource,
    getIngestionSource: mocks.getIngestionSource,
  }));
  vi.doMock("./ingestion/runAgenc", async importOriginal => ({ ...(await importOriginal<typeof import("./ingestion/runAgenc")>()), runApprovedAgencSource: mocks.runApprovedAgencSource }));
  mocks.getAuthenticatedOperator.mockResolvedValue(operator);
  const { appRouter } = await import("./routers");
  return appRouter.createCaller({ user: operator, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext);
}

const rejected = async (promise: Promise<unknown>) => (await promise.catch((reason: unknown) => reason)) as TRPCError;

const agencSource = (overrides: Record<string, unknown> = {}) => ({
  id: SOURCE_ID,
  sourceKey: "solana-agenc-agent-registry",
  protocol: "solana_agenc",
  state: "active",
  executionPolicy: "manual_only",
  cursor: null,
  ...overrides,
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.doUnmock("./operatorAuth");
  vi.doUnmock("./db");
  vi.doUnmock("./ingestion/runAgenc");
});

// The first call imports the whole router graph, which can take a few seconds under a loaded full run.
describe("staging the AgenC registry", { timeout: 30_000 }, () => {
  it("is for the operator alone", async () => {
    const caller = await callerWith(null);
    const error = await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: "agenc" }));
    expect(error.code).toBe("UNAUTHORIZED");
    expect(mocks.createIngestionSource).not.toHaveBeenCalled();
  });

  it("makes its source from the preset: the key the pass accepts, the protocol, the public Solana RPC host, in review, manual only", async () => {
    const caller = await callerWith(OPERATOR);
    const staged = await caller.liveData.admin.registerApprovedPublicSource({ source: "agenc" });
    expect(staged).toMatchObject({ created: true, state: "review" });
    expect(mocks.createIngestionSource).toHaveBeenCalledTimes(1);
    expect(mocks.createIngestionSource).toHaveBeenLastCalledWith({
      sourceKey: "solana-agenc-agent-registry",
      label: "AgenC Solana agent registry",
      protocol: "solana_agenc",
      rootUrl: "https://api.mainnet-beta.solana.com",
      allowedHostname: "api.mainnet-beta.solana.com",
      executionPolicy: "manual_only",
      scheduleMinutes: 1_440,
      state: "review",
      createdByUserId: OPERATOR.id,
    });
  });

  it("makes one source however many times it is staged", async () => {
    mocks.listIngestionSources.mockResolvedValueOnce([{ id: "existing-id", state: "active", sourceKey: "solana-agenc-agent-registry" }]);
    const caller = await callerWith(OPERATOR);
    expect(await caller.liveData.admin.registerApprovedPublicSource({ source: "agenc" })).toEqual({ sourceId: "existing-id", state: "active", created: false });
    expect(mocks.createIngestionSource).not.toHaveBeenCalled();
  });

  it("says which migration is missing when the database refuses the protocol value, and creates nothing else", async () => {
    mocks.createIngestionSource.mockRejectedValueOnce(Object.assign(new Error("Failed query: insert into ingestion_sources"), { cause: Object.assign(new Error("Data truncated for column 'protocol' at row 1"), { code: "WARN_DATA_TRUNCATED", errno: 1265 }) }));
    const caller = await callerWith(OPERATOR);
    const error = await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: "agenc" }));
    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(error.message).toContain("Paste migration 0051 first");
  });

  it("does not take a refusal of some other column, or some other failure, for the missing migration", async () => {
    mocks.createIngestionSource.mockRejectedValueOnce(Object.assign(new Error("Data truncated for column 'label' at row 1"), { code: "WARN_DATA_TRUNCATED" }));
    const caller = await callerWith(OPERATOR);
    const error = await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: "agenc" }));
    expect(error.message).toBe("Live data is temporarily unavailable.");
    mocks.createIngestionSource.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const second = await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: "agenc" }));
    expect(second.message).toBe("Live data is temporarily unavailable.");
  });

  it("gives another source's refusal of its protocol no word about 0051", async () => {
    mocks.createIngestionSource.mockRejectedValueOnce(Object.assign(new Error("Data truncated for column 'protocol' at row 1"), { code: "WARN_DATA_TRUNCATED" }));
    const caller = await callerWith(OPERATOR);
    const error = await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: "said" }));
    expect(error.message).toBe("Live data is temporarily unavailable.");
  });
});

describe("running the AgenC registry", { timeout: 30_000 }, () => {
  it("is for the operator alone", async () => {
    mocks.getIngestionSource.mockResolvedValue(agencSource());
    const caller = await callerWith(null);
    const error = await rejected(caller.liveData.admin.runSource({ sourceId: SOURCE_ID, mode: "activity" }));
    expect(error.code).toBe("UNAUTHORIZED");
    expect(mocks.runApprovedAgencSource).not.toHaveBeenCalled();
  });

  it("sends the chain activity pass to the AgenC pass as a manual run, and gives its answer back", async () => {
    const source = agencSource();
    mocks.getIngestionSource.mockResolvedValue(source);
    const caller = await callerWith(OPERATOR);
    const result = await caller.liveData.admin.runSource({ sourceId: SOURCE_ID, mode: "activity" });
    expect(mocks.runApprovedAgencSource).toHaveBeenCalledTimes(1);
    expect(mocks.runApprovedAgencSource).toHaveBeenCalledWith(source, "manual");
    expect(result).toMatchObject({ discoveredCount: 256, nextCursor: "agenc:461650417" });
  });

  it("refuses every other mode before anything runs, and says what the one mode is", async () => {
    mocks.getIngestionSource.mockResolvedValue(agencSource());
    const caller = await callerWith(OPERATOR);
    for (const mode of ["observe", "backfill", "registrants"] as const) {
      const error = await rejected(caller.liveData.admin.runSource({ sourceId: SOURCE_ID, mode }));
      expect(error.code, mode).toBe("BAD_REQUEST");
      expect(error.message, mode).toBe("The AgenC Solana registry supports the chain activity pass only.");
    }
    expect(mocks.runApprovedAgencSource).not.toHaveBeenCalled();
  });

  it("does not run a source that has not been approved", async () => {
    mocks.getIngestionSource.mockResolvedValue(agencSource({ state: "review" }));
    const caller = await callerWith(OPERATOR);
    const error = await rejected(caller.liveData.admin.runSource({ sourceId: SOURCE_ID, mode: "activity" }));
    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(error.message).toBe("Approve the source before running ingestion.");
    expect(mocks.runApprovedAgencSource).not.toHaveBeenCalled();
  });
});
