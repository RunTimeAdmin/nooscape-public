import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * The operator's side of the two A2A registries, through the real router: staging each source and running it. What is held: only the
 * operator can do either; each staged source is made from its preset, in review, manual only, on the registry's own host; staging it
 * twice makes one source; and a run goes to the registry runner for a registry and to the Agenstry runner for the Agenstry feed. The
 * database and the runs are replaced, so nothing here reaches a database or a registry.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedOperator: vi.fn(),
  listIngestionSources: vi.fn(async () => [] as unknown[]),
  createIngestionSource: vi.fn(async (_input: unknown) => ({ sourceId: "00000000-0000-4000-8000-000000000001" })),
  getIngestionSource: vi.fn(),
  runApprovedA2aRegistrySource: vi.fn(async (..._args: unknown[]) => ({ requestCount: 7, discoveredCount: 649, acceptedCount: 96, rejectedCount: 553, nextCursor: null })),
  runApprovedAgenstrySource: vi.fn(async (..._args: unknown[]) => ({ requestCount: 1, discoveredCount: 299073, acceptedCount: 99, rejectedCount: 23828, nextCursor: null })),
}));
const OPERATOR = { id: 7, name: "Test Operator", role: "admin" as const, openId: "test-operator" };
const SOURCE_ID = "00000000-0000-4000-8000-0000000000bb";

async function callerWith(operator: typeof OPERATOR | null) {
  vi.doMock("./operatorAuth", async importOriginal => ({ ...(await importOriginal<typeof import("./operatorAuth")>()), getAuthenticatedOperator: mocks.getAuthenticatedOperator }));
  vi.doMock("./db", async importOriginal => ({
    ...(await importOriginal<typeof import("./db")>()),
    listIngestionSources: mocks.listIngestionSources,
    createIngestionSource: mocks.createIngestionSource,
    getIngestionSource: mocks.getIngestionSource,
  }));
  vi.doMock("./ingestion/runA2aRegistry", async importOriginal => ({ ...(await importOriginal<typeof import("./ingestion/runA2aRegistry")>()), runApprovedA2aRegistrySource: mocks.runApprovedA2aRegistrySource }));
  vi.doMock("./ingestion/runAgenstry", async importOriginal => ({ ...(await importOriginal<typeof import("./ingestion/runAgenstry")>()), runApprovedAgenstrySource: mocks.runApprovedAgenstrySource }));
  mocks.getAuthenticatedOperator.mockResolvedValue(operator);
  const { appRouter } = await import("./routers");
  return appRouter.createCaller({ user: operator, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext);
}

const rejected = async (promise: Promise<unknown>) => (await promise.catch((reason: unknown) => reason)) as TRPCError;

const catalogSource = (sourceKey: string) => ({ id: SOURCE_ID, sourceKey, protocol: "catalog", state: "active", executionPolicy: "manual_only", cursor: null });

const PRESETS = [
  [
    "a2aregistry",
    {
      sourceKey: "a2aregistry-public-api",
      label: "a2aregistry.org community A2A registry",
      protocol: "catalog",
      rootUrl: "https://a2aregistry.org/api/agents",
      allowedHostname: "a2aregistry.org",
      scheduleMinutes: 1_440,
    },
  ],
  [
    "a2aRegistryApi",
    {
      sourceKey: "a2a-registry-org-public-api",
      label: "A2A Registry public API (a2a-registry.org)",
      protocol: "catalog",
      rootUrl: "https://api.a2a-registry.org/public/agents",
      allowedHostname: "api.a2a-registry.org",
      scheduleMinutes: 10_080,
    },
  ],
] as const;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.doUnmock("./operatorAuth");
  vi.doUnmock("./db");
  vi.doUnmock("./ingestion/runA2aRegistry");
  vi.doUnmock("./ingestion/runAgenstry");
});

// The first call imports the whole router graph, which can take a few seconds under a loaded full run.
describe("staging an A2A registry", { timeout: 30_000 }, () => {
  it.each(PRESETS)("is for the operator alone (%s)", async name => {
    const caller = await callerWith(null);
    const error = await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: name }));
    expect(error.code).toBe("UNAUTHORIZED");
    expect(mocks.createIngestionSource).not.toHaveBeenCalled();
  });

  it.each(PRESETS)("makes the %s source from its preset: in review, manual only, on the registry's own host", async (name, preset) => {
    const caller = await callerWith(OPERATOR);
    const staged = await caller.liveData.admin.registerApprovedPublicSource({ source: name });
    expect(staged).toMatchObject({ created: true, state: "review" });
    expect(mocks.createIngestionSource).toHaveBeenCalledTimes(1);
    expect(mocks.createIngestionSource).toHaveBeenLastCalledWith({ ...preset, executionPolicy: "manual_only", state: "review", createdByUserId: OPERATOR.id });
  });

  it.each(PRESETS)("makes one source however many times %s is staged", async (name, preset) => {
    mocks.listIngestionSources.mockResolvedValueOnce([{ id: "existing-id", state: "active", sourceKey: preset.sourceKey }]);
    const caller = await callerWith(OPERATOR);
    expect(await caller.liveData.admin.registerApprovedPublicSource({ source: name })).toEqual({ sourceId: "existing-id", state: "active", created: false });
    expect(mocks.createIngestionSource).not.toHaveBeenCalled();
  });
});

describe("running a catalog source", { timeout: 30_000 }, () => {
  it("is for the operator alone", async () => {
    mocks.getIngestionSource.mockResolvedValue(catalogSource("a2aregistry-public-api"));
    const caller = await callerWith(null);
    const error = await rejected(caller.liveData.admin.runSource({ sourceId: SOURCE_ID }));
    expect(error.code).toBe("UNAUTHORIZED");
    expect(mocks.runApprovedA2aRegistrySource).not.toHaveBeenCalled();
  });

  it.each(PRESETS)("sends the %s source to the registry runner as a manual run, and gives its answer back", async (_name, preset) => {
    const source = catalogSource(preset.sourceKey);
    mocks.getIngestionSource.mockResolvedValue(source);
    const caller = await callerWith(OPERATOR);
    const result = await caller.liveData.admin.runSource({ sourceId: SOURCE_ID });
    expect(mocks.runApprovedA2aRegistrySource).toHaveBeenCalledWith(source, "manual");
    expect(mocks.runApprovedAgenstrySource).not.toHaveBeenCalled();
    expect(result).toMatchObject({ discoveredCount: 649, acceptedCount: 96 });
  });

  it("still sends the Agenstry feed to the Agenstry runner", async () => {
    const source = catalogSource("agenstry-public-catalog");
    mocks.getIngestionSource.mockResolvedValue(source);
    const caller = await callerWith(OPERATOR);
    await caller.liveData.admin.runSource({ sourceId: SOURCE_ID });
    expect(mocks.runApprovedAgenstrySource).toHaveBeenCalledWith(source, "manual");
    expect(mocks.runApprovedA2aRegistrySource).not.toHaveBeenCalled();
  });

  it("refuses to run a source that has not been approved active", async () => {
    mocks.getIngestionSource.mockResolvedValue({ ...catalogSource("a2aregistry-public-api"), state: "review" });
    const caller = await callerWith(OPERATOR);
    const error = await rejected(caller.liveData.admin.runSource({ sourceId: SOURCE_ID }));
    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(mocks.runApprovedA2aRegistrySource).not.toHaveBeenCalled();
  });
});
