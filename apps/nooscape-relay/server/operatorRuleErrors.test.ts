import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * What the operator is told when a request fails. A rule of the product that refuses it (the four-eyes rule on a publisher key, a challenge
 * that is no longer pending) is said in its own words and is not logged as a storage failure; a fault of the database is still the one fixed
 * summary, with the cause in the log only. The real router, with the operator lookup and the two database writes replaced.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedOperator: vi.fn(),
  approvePublisherKeyPolicy: vi.fn(),
  revokePublisherKeyPolicy: vi.fn(),
}));
const OPERATOR = { id: 1, name: "Test Operator", role: "admin" as const, openId: "test-operator" };
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const RATIONALE = "A rationale of at least twelve characters.";

async function caller() {
  vi.doMock("./operatorAuth", async importOriginal => ({ ...(await importOriginal<typeof import("./operatorAuth")>()), getAuthenticatedOperator: mocks.getAuthenticatedOperator }));
  vi.doMock("./db", async importOriginal => ({
    ...(await importOriginal<typeof import("./db")>()),
    approvePublisherKeyPolicy: mocks.approvePublisherKeyPolicy,
    revokePublisherKeyPolicy: mocks.revokePublisherKeyPolicy,
  }));
  mocks.getAuthenticatedOperator.mockResolvedValue(OPERATOR);
  const { appRouter } = await import("./routers");
  // The class is taken after the modules are reset, so it is the one the router checks with.
  const { OperatorRuleError } = await import("./operatorRuleError");
  return { run: appRouter.createCaller({ user: OPERATOR, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext), OperatorRuleError };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.doUnmock("./operatorAuth");
  vi.doUnmock("./db");
  vi.restoreAllMocks();
});

// The first call imports the whole router graph, which can take a few seconds under a loaded full run.
describe("a request the operator made that a rule refuses", { timeout: 30_000 }, () => {
  it("says the rule in its own words, with a precondition failure, and logs no storage failure", async () => {
    const message = "Publisher-key approval requires an operator other than the proposal creator.";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { run, OperatorRuleError } = await caller();
    mocks.approvePublisherKeyPolicy.mockRejectedValueOnce(new OperatorRuleError(message));
    const refused = await run.liveData.admin.approvePublisherKey({ keyId: KEY_ID, rationale: RATIONALE }).catch((reason: unknown) => reason);
    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe("PRECONDITION_FAILED");
    expect((refused as TRPCError).message).toBe(message);
    expect(error).not.toHaveBeenCalled();
  });

  it("does the same for a revocation of a key that is not there", async () => {
    const { run, OperatorRuleError } = await caller();
    mocks.revokePublisherKeyPolicy.mockRejectedValueOnce(new OperatorRuleError("Publisher key was not found."));
    const refused = await run.liveData.admin.revokePublisherKey({ keyId: KEY_ID, rationale: RATIONALE }).catch((reason: unknown) => reason);
    expect((refused as TRPCError).message).toBe("Publisher key was not found.");
  });

  it("keeps the fixed summary for a fault of the database, and the cause in the log", async () => {
    mocks.approvePublisherKeyPolicy.mockRejectedValueOnce(new Error("Failed query: update publisher_keys set state = ?" + String.fromCharCode(10) + "params: allowlisted"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { run } = await caller();
    const refused = await run.liveData.admin.approvePublisherKey({ keyId: KEY_ID, rationale: RATIONALE }).catch((reason: unknown) => reason);
    expect((refused as TRPCError).code).toBe("PRECONDITION_FAILED");
    expect((refused as TRPCError).message).toBe("Live data is temporarily unavailable.");
    const logged = error.mock.calls.map(call => call.join(" ")).join(" ");
    expect(logged).toContain("[LiveData] storage failure: Failed query: update publisher_keys set state = ?");
    expect(logged).not.toContain("allowlisted");
  });
});
