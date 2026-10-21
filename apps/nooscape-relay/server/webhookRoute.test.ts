import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * The third cron job's endpoint, through the real router (docs/data-access-2026-10-19.md, stage D5): `liveData.admin.runWebhooks` is for the
 * operator's token and for nobody else, and with the token it runs the webhook pass and answers with the counts the run returns. A run that
 * throws answers "error" and nothing of the cause. Only the operator lookup and the run itself are replaced.
 */
const mocks = vi.hoisted(() => ({
  getAuthenticatedOperator: vi.fn(),
  runWebhookPass: vi.fn(async () => ({ status: "ran" as const, created: 2, sent: 2, retrying: 0, gaveUp: 0, disabled: 0, purged: 0, fullReads: [] as string[] })),
}));
const OPERATOR = { id: 1, name: "Test Operator", role: "admin" as const, openId: "test-operator" };

async function callerWith(operator: typeof OPERATOR | null) {
  vi.doMock("./operatorAuth", async importOriginal => {
    const actual = await importOriginal<typeof import("./operatorAuth")>();
    return { ...actual, getAuthenticatedOperator: mocks.getAuthenticatedOperator };
  });
  vi.doMock("./webhookPass", async importOriginal => ({ ...(await importOriginal<typeof import("./webhookPass")>()), runWebhookPass: mocks.runWebhookPass }));
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
  vi.doUnmock("./webhookPass");
});

// The first call imports the whole router graph, which can take a few seconds under a loaded full run.
describe("runWebhooks", { timeout: 30_000 }, () => {
  it("refuses a caller without the operator's token, and runs nothing", async () => {
    const caller = await callerWith(null);
    const error = await caller.liveData.admin.runWebhooks().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("UNAUTHORIZED");
    expect(mocks.runWebhookPass).not.toHaveBeenCalled();
  });

  it("runs the pass for the operator, once, and answers with what the run returns and nothing more", async () => {
    const caller = await callerWith(OPERATOR);
    const answer = await caller.liveData.admin.runWebhooks();
    expect(mocks.runWebhookPass).toHaveBeenCalledTimes(1);
    expect(answer).toEqual({ status: "ran", created: 2, sent: 2, retrying: 0, gaveUp: 0, disabled: 0, purged: 0, fullReads: [] });
  });

  it("answers error, and nothing of the cause, when the run cannot read the database", async () => {
    mocks.runWebhookPass.mockRejectedValueOnce(new Error("select * from api_webhooks where keyId = 'secret-key-id' failed"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const caller = await callerWith(OPERATOR);
    const answer = await caller.liveData.admin.runWebhooks();
    expect(answer).toEqual({ status: "error" });
    expect(JSON.stringify(answer)).not.toContain("secret-key-id");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is not a public procedure: asked for outside the admin router, there is nothing there", async () => {
    const caller = await callerWith(OPERATOR);
    const error = await (caller.liveData as unknown as { runWebhooks: () => Promise<unknown> }).runWebhooks().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("NOT_FOUND");
    expect(mocks.runWebhookPass).not.toHaveBeenCalled();
  });
});
