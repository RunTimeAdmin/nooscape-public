import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * The operator's side of the extra chains, through the real router: staging a source for Ethereum, Base or Arc, and running it.
 * What is held: only the operator can do either; a chain whose switch is off cannot be staged and says so; a staged source is made
 * from the chain's entry and is manual_only; Arc's host is read from X402_RPC and nothing but the host is kept; the run goes to the
 * one chain pass with the right chain and only as the chain activity pass; and a refusal is put to the operator as what it is.
 * BNB Chain's staging and run are shown to go where they always went. The database and the runs themselves are replaced, so nothing
 * here reaches a database or a node.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedOperator: vi.fn(),
  listIngestionSources: vi.fn(async () => [] as unknown[]),
  createIngestionSource: vi.fn(async (_input: unknown) => ({ sourceId: "00000000-0000-4000-8000-000000000001" })),
  getIngestionSource: vi.fn(),
  runApprovedErc8004ChainSource: vi.fn(async (..._args: unknown[]) => ({ requestCount: 3, discoveredCount: 0, acceptedCount: 0, rejectedCount: 0, nextCursor: "x:1" })),
  runApprovedBscRegistrySource: vi.fn(async (..._args: unknown[]) => ({ requestCount: 3, discoveredCount: 0, acceptedCount: 0, rejectedCount: 0, nextCursor: "bsc:1" })),
}));
const OPERATOR = { id: 7, name: "Test Operator", role: "admin" as const, openId: "test-operator" };
const SOURCE_ID = "00000000-0000-4000-8000-0000000000aa";
const KEY = "K3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3y";

async function callerWith(operator: typeof OPERATOR | null) {
  vi.doMock("./operatorAuth", async importOriginal => ({ ...(await importOriginal<typeof import("./operatorAuth")>()), getAuthenticatedOperator: mocks.getAuthenticatedOperator }));
  vi.doMock("./db", async importOriginal => ({
    ...(await importOriginal<typeof import("./db")>()),
    listIngestionSources: mocks.listIngestionSources,
    createIngestionSource: mocks.createIngestionSource,
    getIngestionSource: mocks.getIngestionSource,
  }));
  vi.doMock("./ingestion/runErc8004Chain", async importOriginal => ({ ...(await importOriginal<typeof import("./ingestion/runErc8004Chain")>()), runApprovedErc8004ChainSource: mocks.runApprovedErc8004ChainSource }));
  vi.doMock("./ingestion/runBsc", async importOriginal => ({ ...(await importOriginal<typeof import("./ingestion/runBsc")>()), runApprovedBscRegistrySource: mocks.runApprovedBscRegistrySource }));
  mocks.getAuthenticatedOperator.mockResolvedValue(operator);
  const { appRouter } = await import("./routers");
  return appRouter.createCaller({ user: operator, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext);
}

const rejected = async (promise: Promise<unknown>) => (await promise.catch((reason: unknown) => reason)) as TRPCError;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("VITE_FEATURES", "");
  vi.stubEnv("X402_RPC", "");
});
afterEach(() => {
  vi.doUnmock("./operatorAuth");
  vi.doUnmock("./db");
  vi.doUnmock("./ingestion/runErc8004Chain");
  vi.doUnmock("./ingestion/runBsc");
  vi.unstubAllEnvs();
});

// The first call imports the whole router graph, which can take a few seconds under a loaded full run.
describe("staging a source for another chain", { timeout: 30_000 }, () => {
  it("is for the operator alone", async () => {
    const caller = await callerWith(null);
    vi.stubEnv("VITE_FEATURES", "chain_base");
    const error = await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: "base" }));
    expect(error.code).toBe("UNAUTHORIZED");
    expect(mocks.createIngestionSource).not.toHaveBeenCalled();
  });

  it("refuses a chain whose switch is off, and says which switch, creating nothing", async () => {
    const caller = await callerWith(OPERATOR);
    for (const [name, label, feature] of [["ethereum", "Ethereum", "chain_ethereum"], ["base", "Base", "chain_base"], ["arc", "Arc", "chain_arc"]] as const) {
      const error = await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: name }));
      expect(error.code, name).toBe("PRECONDITION_FAILED");
      expect(error.message, name).toBe(`The ${label} identity pass is switched off (${feature}), so its source cannot be staged.`);
    }
    expect(mocks.createIngestionSource).not.toHaveBeenCalled();
  });

  it("keeps one chain's switch from turning on another", async () => {
    vi.stubEnv("VITE_FEATURES", "chain_base");
    const caller = await callerWith(OPERATOR);
    expect((await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: "ethereum" }))).code).toBe("PRECONDITION_FAILED");
    expect((await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: "arc" }))).code).toBe("PRECONDITION_FAILED");
    expect(mocks.createIngestionSource).not.toHaveBeenCalled();
  });

  it("stages Ethereum and Base from their entries: their own key, protocol and provider host, in review, manual only", async () => {
    vi.stubEnv("VITE_FEATURES", "chain_ethereum,chain_base");
    const caller = await callerWith(OPERATOR);
    const staged = await caller.liveData.admin.registerApprovedPublicSource({ source: "ethereum" });
    expect(staged).toMatchObject({ created: true, state: "review" });
    expect(mocks.createIngestionSource).toHaveBeenLastCalledWith({
      sourceKey: "ethereum-erc8004-identity-registry",
      label: "Ethereum ERC-8004 identity registry",
      protocol: "erc8004_eth",
      rootUrl: "https://eth-mainnet.nodereal.io",
      allowedHostname: "eth-mainnet.nodereal.io",
      executionPolicy: "manual_only",
      scheduleMinutes: 1_440,
      state: "review",
      createdByUserId: OPERATOR.id,
    });
    await caller.liveData.admin.registerApprovedPublicSource({ source: "base" });
    expect(mocks.createIngestionSource).toHaveBeenLastCalledWith({
      sourceKey: "base-erc8004-identity-registry",
      label: "Base ERC-8004 identity registry",
      protocol: "erc8004_base",
      rootUrl: "https://base-mainnet.g.alchemy.com",
      allowedHostname: "base-mainnet.g.alchemy.com",
      executionPolicy: "manual_only",
      scheduleMinutes: 1_440,
      state: "review",
      createdByUserId: OPERATOR.id,
    });
  });

  it("stages Arc on the host X402_RPC names, and keeps that host alone: no port, path, query or key", async () => {
    vi.stubEnv("VITE_FEATURES", "chain_arc");
    vi.stubEnv("X402_RPC", `https://Arc-Node.example:8443/pfx-secret-9/v1/${KEY}?token=abc123`);
    const caller = await callerWith(OPERATOR);
    await caller.liveData.admin.registerApprovedPublicSource({ source: "arc" });
    expect(mocks.createIngestionSource).toHaveBeenLastCalledWith({
      sourceKey: "arc-erc8004-identity-registry",
      label: "Arc ERC-8004 identity registry",
      protocol: "erc8004_arc",
      rootUrl: "https://arc-node.example",
      allowedHostname: "arc-node.example",
      executionPolicy: "manual_only",
      scheduleMinutes: 1_440,
      state: "review",
      createdByUserId: OPERATOR.id,
    });
    const written = JSON.stringify(mocks.createIngestionSource.mock.calls);
    for (const piece of [KEY, "pfx-secret-9", "abc123", "8443", "/v1/"]) expect(written).not.toContain(piece);
  });

  it("refuses to stage Arc without a usable X402_RPC, in words that name the variable and never its value", async () => {
    vi.stubEnv("VITE_FEATURES", "chain_arc");
    const caller = await callerWith(OPERATOR);
    for (const value of ["", "http://secret-node.example/v1/x", "not an address"]) {
      vi.stubEnv("X402_RPC", value);
      const error = await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: "arc" }));
      expect(error.code, value).toBe("PRECONDITION_FAILED");
      expect(error.message, value).toBe("X402_RPC is not configured, so the Arc identity pass cannot run.");
    }
    vi.stubEnv("X402_RPC", `https://user:${KEY}@secret-node.example/v1/x`);
    const credentials = await rejected(caller.liveData.admin.registerApprovedPublicSource({ source: "arc" }));
    expect(credentials.message).toBe("X402_RPC must not carry userinfo.");
    expect(credentials.message).not.toContain(KEY);
    expect(mocks.createIngestionSource).not.toHaveBeenCalled();
  });

  it("returns the source that is already staged instead of making a second", async () => {
    vi.stubEnv("VITE_FEATURES", "chain_base");
    mocks.listIngestionSources.mockResolvedValueOnce([{ id: "existing-id", sourceKey: "base-erc8004-identity-registry", state: "active" }]);
    const caller = await callerWith(OPERATOR);
    expect(await caller.liveData.admin.registerApprovedPublicSource({ source: "base" })).toEqual({ sourceId: "existing-id", state: "active", created: false });
    expect(mocks.createIngestionSource).not.toHaveBeenCalled();
  });

  it("stages BNB Chain as it always did, with its switch beside it making no difference", async () => {
    const caller = await callerWith(OPERATOR);
    await caller.liveData.admin.registerApprovedPublicSource({ source: "bsc" });
    expect(mocks.createIngestionSource).toHaveBeenLastCalledWith({
      sourceKey: "bsc-erc8004-identity-registry",
      label: "BNB Smart Chain ERC-8004 identity registry",
      protocol: "erc8004_bsc",
      rootUrl: "https://bsc-mainnet.nodereal.io",
      allowedHostname: "bsc-mainnet.nodereal.io",
      executionPolicy: "manual_only",
      scheduleMinutes: 1_440,
      state: "review",
      createdByUserId: OPERATOR.id,
    });
  });
});

describe("running a source of another chain", { timeout: 30_000 }, () => {
  const active = (protocol: string) => ({ id: SOURCE_ID, protocol, state: "active", sourceKey: `${protocol}-key`, cursor: null });

  it("sends each protocol to the one chain pass with its own chain, as a manual run", async () => {
    const caller = await callerWith(OPERATOR);
    const { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN } = await import("./ingestion/erc8004Chains");
    for (const [protocol, chain] of [["erc8004_eth", ETHEREUM_CHAIN], ["erc8004_base", BASE_CHAIN], ["erc8004_arc", ARC_CHAIN]] as const) {
      mocks.getIngestionSource.mockResolvedValueOnce(active(protocol));
      await caller.liveData.admin.runSource({ sourceId: SOURCE_ID, mode: "activity" });
      expect(mocks.runApprovedErc8004ChainSource).toHaveBeenLastCalledWith(chain, expect.objectContaining({ protocol }), "manual");
    }
    expect(mocks.runApprovedBscRegistrySource).not.toHaveBeenCalled();
  });

  it("still sends BNB Chain's source to its own entry point and not to the generic one", async () => {
    const caller = await callerWith(OPERATOR);
    mocks.getIngestionSource.mockResolvedValueOnce(active("erc8004_bsc"));
    await caller.liveData.admin.runSource({ sourceId: SOURCE_ID, mode: "activity" });
    expect(mocks.runApprovedBscRegistrySource).toHaveBeenCalledTimes(1);
    expect(mocks.runApprovedErc8004ChainSource).not.toHaveBeenCalled();
  });

  it("offers the chain activity pass only: observe and the walk modes have no meaning there", async () => {
    const caller = await callerWith(OPERATOR);
    for (const mode of ["observe", "backfill", "registrants"] as const) {
      mocks.getIngestionSource.mockResolvedValueOnce(active("erc8004_base"));
      const error = await rejected(caller.liveData.admin.runSource({ sourceId: SOURCE_ID, mode }));
      expect(error.code, mode).toBe("BAD_REQUEST");
      expect(error.message, mode).toBe("The Base identity registry supports the chain activity pass only.");
    }
    expect(mocks.runApprovedErc8004ChainSource).not.toHaveBeenCalled();
  });

  it("will not run a source that has not been approved", async () => {
    const caller = await callerWith(OPERATOR);
    mocks.getIngestionSource.mockResolvedValueOnce({ ...active("erc8004_eth"), state: "review" });
    const error = await rejected(caller.liveData.admin.runSource({ sourceId: SOURCE_ID, mode: "activity" }));
    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(mocks.runApprovedErc8004ChainSource).not.toHaveBeenCalled();
  });

  it("is for the operator alone", async () => {
    const caller = await callerWith(null);
    const error = await rejected(caller.liveData.admin.runSource({ sourceId: SOURCE_ID, mode: "activity" }));
    expect(error.code).toBe("UNAUTHORIZED");
    expect(mocks.runApprovedErc8004ChainSource).not.toHaveBeenCalled();
  });

  it("puts a refusal to the operator as what it is: switched off, not configured, or the node's fault", async () => {
    const caller = await callerWith(OPERATOR);
    const { Erc8004ChainOffError } = await import("./ingestion/erc8004Chain");
    const { Erc8004RpcError, Erc8004RpcNotConfiguredError } = await import("./ingestion/erc8004Rpc");
    const cases: Array<[Error, string, string]> = [
      [new Erc8004ChainOffError("The Base identity pass is switched off."), "PRECONDITION_FAILED", "The Base identity pass is switched off."],
      [new Erc8004RpcNotConfiguredError("BASE_RPC_URL is not configured, so the Base identity pass cannot run."), "PRECONDITION_FAILED", "BASE_RPC_URL is not configured, so the Base identity pass cannot run."],
      [new Erc8004RpcError("Base eth_getLogs request timed out.", "BaseRpcError"), "BAD_GATEWAY", "Base eth_getLogs request timed out."],
    ];
    for (const [failure, code, message] of cases) {
      mocks.getIngestionSource.mockResolvedValueOnce(active("erc8004_base"));
      mocks.runApprovedErc8004ChainSource.mockRejectedValueOnce(failure);
      const error = await rejected(caller.liveData.admin.runSource({ sourceId: SOURCE_ID, mode: "activity" }));
      expect([error.code, error.message]).toEqual([code, message]);
    }
  });
});
