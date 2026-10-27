import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { CIRCUIT_OPEN_CODE } from "./dbBreaker";

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

  /** The funnel with its counts and reviewed records answering, and the two steps that may be unmeasured given the reads to use. */
  async function funnelCaller(registrants: () => Promise<number>, activity: () => Promise<unknown>) {
    return callerWith({
      readAgentDirectoryFunnelCounts: async () => ({ acknowledged: 10, withLocator: 4 }),
      listLiveAtlasRecords: async () => [],
      countAgentDirectoryRegistrants: registrants,
      readAgentDirectoryActivityTotals: activity,
      countAgentDirectoryMintMeasured: async () => 3,
    });
  }
  const stepValue = (funnel: { steps: ReadonlyArray<{ key: string; value: number | null }> }, key: string) => funnel.steps.find(step => step.key === key)?.value;
  const driverError = (code: string) => new Error("Failed query: select 1", { cause: Object.assign(new Error("driver message"), { code }) });

  it("leaves the funnel's registrant and activity steps unmeasured, quietly, when their table or column is not there yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = async () => {
      throw driverError("ER_BAD_FIELD_ERROR");
    };
    const caller = await funnelCaller(missing, missing);
    const funnel = await caller.liveData.directoryFunnel();
    expect(stepValue(funnel, "withRegistrant")).toBeNull();
    expect(stepValue(funnel, "withMintMeasured")).toBeNull();
    expect(funnel.activityTotals).toBeNull();
    expect(stepValue(funnel, "acknowledged")).toBe(10);
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves the same steps unmeasured and logs which one failed and why when the failure is anything else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timedOut = async () => {
      throw driverError("ER_QUERY_TIMEOUT");
    };
    const caller = await funnelCaller(timedOut, timedOut);
    const funnel = await caller.liveData.directoryFunnel();
    expect(stepValue(funnel, "withRegistrant")).toBeNull();
    expect(stepValue(funnel, "withMintMeasured")).toBeNull();
    const lines = warn.mock.calls.map(call => call.join(" "));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[LiveData] Directory funnel registrant step could not be read:");
    expect(lines[1]).toContain("[LiveData] Directory funnel activity step could not be read:");
    expect(lines.every(line => line.includes("ER_QUERY_TIMEOUT"))).toBe(true);
  });

  it("answers none for an agent profile when the read throws, and logs why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const caller = await callerWith({ listLiveAtlasRecords: async () => { throw new Error("storage down"); } });
    expect(await caller.liveData.agentProfile({ id: "some-entry" })).toEqual({ kind: "none", record: null, timeline: [], entry: null, checks: [] });
    expect(warn.mock.calls.map(call => String(call[0]))).toContain("[LiveData] Agent profile read failed:");
  });

  /** Public reads that answer an empty value when they fail: what each answers, and the label its log line carries. */
  const EMPTY_ANSWERS: Array<[procedure: string, replaced: string[], call: (caller: Awaited<ReturnType<typeof callerWith>>) => Promise<unknown>, answer: unknown, label: string]> = [
    ["publicRecords", ["listLiveAtlasRecords"], caller => caller.liveData.publicRecords(), { records: [] }, "Public records"],
    ["publicCoverage", ["getLiveAtlasProvenanceCoverage"], caller => caller.liveData.publicCoverage(), { publicRecordCount: 0, provenanceReadyCount: 0, coveragePercent: 0 }, "Public coverage"],
    ["directorySearch", ["searchAgentDirectory"], caller => caller.liveData.directorySearch({ query: "alice" }), { entries: [], matchedTotal: 0 }, "Directory search"],
    ["directoryEntry", ["getAgentDirectoryEntry"], caller => caller.liveData.directoryEntry({ id: "some-entry" }), { entry: null }, "Directory entry"],
    ["directoryTotal", ["countAgentDirectoryEntries"], caller => caller.liveData.directoryTotal(), { total: 0 }, "Directory total"],
    ["directoryBreakdown", ["countAgentDirectoryEntries"], caller => caller.liveData.directoryBreakdown(), { total: 0, byProtocol: [] }, "Directory breakdown"],
    ["directoryWalletCensus", ["listAgentDirectoryWallets"], caller => caller.liveData.directoryWalletCensus(), { wallets: [] }, "Wallet census"],
    ["directoryUsdgSettlements", ["readUsdgSettlementTotals"], caller => caller.liveData.directoryUsdgSettlements(), { totals: null }, "USDG settlements"],
    ["directoryFunnel", ["readAgentDirectoryFunnelCounts"], caller => caller.liveData.directoryFunnel(), { steps: [], activityTotals: null }, "Directory funnel"],
    ["sourceStatuses", ["listPublicIngestionSourceStatuses"], caller => caller.liveData.sourceStatuses(), { sources: [] }, "Source statuses"],
  ];
  const failing = (names: string[], error: Error) => Object.fromEntries(names.map(name => [name, async () => { throw error; }]));

  it.each(EMPTY_ANSWERS)("%s answers its empty value and logs why when the read throws", async (_procedure, replaced, call, answer, label) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const caller = await callerWith(failing(replaced, new Error("storage down")));
    expect(await call(caller)).toEqual(answer);
    expect(warn.mock.calls.map(line => line.join(" "))).toEqual([`[LiveData] ${label} read failed: storage down`]);
  });

  it.each(EMPTY_ANSWERS)("%s answers its empty value and says nothing when the breaker has already said the database is paused", async (_procedure, replaced, call, answer) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const paused = Object.assign(new Error("The database is paused."), { code: CIRCUIT_OPEN_CODE });
    const caller = await callerWith(failing(replaced, paused));
    expect(await call(caller)).toEqual(answer);
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves the parameters the driver appends to its message out of the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const caller = await callerWith(failing(["countAgentDirectoryEntries"], new Error("Failed query: select count(*) from t where host = ?" + String.fromCharCode(10) + "params: private-host.example")));
    await caller.liveData.directoryTotal();
    const logged = warn.mock.calls.map(line => line.join(" ")).join(" ");
    expect(logged).toContain("Failed query: select count(*) from t where host = ?");
    expect(logged).not.toContain("private-host.example");
  });
});
