import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * The homepage polls one agent's evidence every 8 seconds per visitor. A reviewed record's envelope is never held
 * back: its visibility (withdrawals) and publisher status are read live on every call.
 */
const validation = vi.fn(async () => ({ status: "unverified" as const, publisherName: null, publicKeyFingerprint: null, verifiedAt: null, statusChangedAt: null }));
const visible = vi.fn(async () => true);

async function caller() {
  vi.resetModules();
  vi.doMock("./db", async importOriginal => ({
    ...(await importOriginal<typeof import("./db")>()),
    getPublisherValidationForAgent: validation,
    isAgentPubliclyVisible: visible,
  }));
  const { appRouter } = await import("./routers");
  return appRouter.createCaller({ user: null, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext);
}

beforeEach(() => {
  vi.useFakeTimers();
  validation.mockClear();
  visible.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("./db");
});

// Each test imports the whole router graph afresh (so each gets its own cache), which takes a few seconds when the machine
// is busy; the 5 s default is not enough beside the rest of the suite.
describe("atlas.evidence for a reviewed record", { timeout: 60_000 }, () => {
  it("checks visibility and the publisher status on every read", async () => {
    const api = await caller();
    const id = "f4a5b6c7-d8e9-1234-f012-345678901234";
    // The envelope itself cannot be built without a database here; what matters is that nothing is held back.
    for (let i = 0; i < 3; i += 1) await api.atlas.evidence({ agentId: id }).catch(() => undefined);
    expect(visible).toHaveBeenCalledTimes(3);
    expect(validation).toHaveBeenCalledTimes(3);
  });

  it("answers a visible record that has no retained evidence with not-found, not a server error", async () => {
    const api = await caller();
    await expect(api.atlas.evidence({ agentId: "f4a5b6c7-d8e9-1234-f012-345678901234" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "No evidence is retained for this agent.",
    });
  });

  it("answers a withdrawn record with not-found on the very next read", async () => {
    const api = await caller();
    const id = "f4a5b6c7-d8e9-1234-f012-345678901234";
    visible.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await api.atlas.evidence({ agentId: id }).catch(() => undefined);
    await expect(api.atlas.evidence({ agentId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
