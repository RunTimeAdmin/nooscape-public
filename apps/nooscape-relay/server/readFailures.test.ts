import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * Two public reads that fail closed, and what each leaves behind. The new-in-the-last-day counts answer no figures, never
 * zeros. The agent page's read answers "none", which the page words as "No agent found", so the cause goes to the server
 * log: a failed read of a real agent must not look like a missing one with nothing to find afterwards.
 */
describe("public reads that fail closed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function callerWith(replaced: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock("./db", async importOriginal => ({ ...(await importOriginal<typeof import("./db")>()), ...replaced }));
    const { appRouter } = await import("./routers");
    return appRouter.createCaller({ user: null, req: { protocol: "https", headers: {} }, res: {} } as TrpcContext);
  }

  it("answers no figures for the new-in-the-last-day counts when the read throws, and logs why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const caller = await callerWith({ readDirectoryArrivals: async () => { throw new Error("storage down"); } });
    expect(await caller.liveData.arrivals()).toEqual({ arrivals: null });
    expect(warn.mock.calls.map(call => String(call[0]))).toContain("[LiveData] Arrivals read failed:");
  });

  it("serves exactly what the reader returns for the new-in-the-last-day counts", async () => {
    const arrivals = { windowHours: 24, computedAt: "2026-10-18T00:00:00.000Z", chains: [{ chain: "robinhood", indexed: true, added: 3, newest: [] }] };
    const caller = await callerWith({ readDirectoryArrivals: async () => arrivals });
    expect(await caller.liveData.arrivals()).toEqual({ arrivals });
  });

  it("answers none for an agent profile when the read throws, and logs why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const caller = await callerWith({ listLiveAtlasRecords: async () => { throw new Error("storage down"); } });
    expect(await caller.liveData.agentProfile({ id: "some-entry" })).toEqual({ kind: "none", record: null, timeline: [], entry: null, checks: [] });
    expect(warn.mock.calls.map(call => String(call[0]))).toContain("[LiveData] Agent profile read failed:");
  });
});
