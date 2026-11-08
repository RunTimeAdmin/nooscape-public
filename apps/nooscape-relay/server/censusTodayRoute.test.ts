import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CensusToday } from "@shared/censusToday";
import type { TrpcContext } from "./_core/context";

/**
 * The public read behind the Today block, through the real router: it answers for the chains with a census report, only while the chain's
 * switch is on, and fails closed to nothing, never to zeros. The directory read is replaced.
 */
const mocks = vi.hoisted(() => ({ readCensusToday: vi.fn(async (_chain: string) => null as unknown) }));

const TODAY: CensusToday = {
  chain: "monad",
  asOf: "2026-11-07T01:00:00.000Z",
  figures: { stored: 4_400, listed: 150 },
  heldOut: { noLink: 1, grouped: 2, numericName: 0, pending: 0 },
  ratings: null,
};

async function caller() {
  vi.doMock("./censusToday", () => ({ readCensusToday: mocks.readCensusToday }));
  const { appRouter } = await import("./routers");
  return appRouter.createCaller({ user: null, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext);
}

const features = process.env.VITE_FEATURES;
beforeEach(() => {
  vi.resetModules();
  mocks.readCensusToday.mockReset();
  mocks.readCensusToday.mockResolvedValue(TODAY);
});
afterEach(() => {
  vi.doUnmock("./censusToday");
  vi.restoreAllMocks();
  if (features === undefined) delete process.env.VITE_FEATURES;
  else process.env.VITE_FEATURES = features;
});

// The first call imports the whole router graph, which can take a few seconds under a loaded full run.
describe("the Today block's read", { timeout: 30_000 }, () => {
  it("answers for a chain whose switch is on, to anyone", async () => {
    process.env.VITE_FEATURES = "claims,chain_monad";

    expect(await (await caller()).liveData.censusToday({ chain: "monad" })).toEqual({ today: TODAY });
    expect(mocks.readCensusToday).toHaveBeenCalledWith("monad");
  });

  it("answers nothing for a chain whose switch is off, and does not read the directory for it", async () => {
    process.env.VITE_FEATURES = "claims,chain_base";

    expect(await (await caller()).liveData.censusToday({ chain: "monad" })).toEqual({ today: null });
    expect(await (await caller()).liveData.censusToday({ chain: "gnosis" })).toEqual({ today: null });
    expect(mocks.readCensusToday).not.toHaveBeenCalled();
  });

  it("answers for BNB Chain and Robinhood Chain whatever the switches say", async () => {
    delete process.env.VITE_FEATURES;
    const api = await caller();

    await api.liveData.censusToday({ chain: "bnb" });
    await api.liveData.censusToday({ chain: "robinhood" });

    expect(mocks.readCensusToday.mock.calls).toEqual([["bnb"], ["robinhood"]]);
  });

  it("refuses a chain that has no census report", async () => {
    await expect((await caller()).liveData.censusToday({ chain: "solana" as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.readCensusToday).not.toHaveBeenCalled();
  });

  it("passes on nothing when the chain's source is not active", async () => {
    process.env.VITE_FEATURES = "chain_arc";
    mocks.readCensusToday.mockResolvedValueOnce(null);

    expect(await (await caller()).liveData.censusToday({ chain: "arc" })).toEqual({ today: null });
  });

  it("fails closed to nothing, and says so once in the log, when the read fails", async () => {
    process.env.VITE_FEATURES = "chain_base";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.readCensusToday.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    expect(await (await caller()).liveData.censusToday({ chain: "base" })).toEqual({ today: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("Census today read failed");
  });
});
