import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The aggregates are rebuilt before a visitor asks: once at boot (Hostinger boots
 * the app twice on every deploy, and a cold cache costs the first visitors the
 * whole build) and again shortly after a burst of ingestion writes drops them,
 * but only while someone is actually reading. The router is replaced by a fake
 * here, so no database is involved.
 */
const procedures = [
  "directoryBreakdown",
  "directoryWalletCensus",
  "directoryBscRegistry",
  "directoryFunnel",
  "directoryUsdgSettlements",
  "directoryActivityFeed",
  "directorySolanaActivity",
  "noosphereSample",
  "mapAcknowledged",
  "mapFleets",
] as const;

const fake = vi.hoisted(() => ({ liveData: {} as Record<string, ReturnType<typeof vi.fn>> }));

vi.mock("./routers", () => ({ appRouter: { createCaller: () => fake } }));

async function modules() {
  vi.resetModules();
  const cache = await import("./readCache");
  const warm = await import("./warmReads");
  return { ...cache, ...warm };
}

beforeEach(() => {
  // setImmediate stays real so a test can wait for the event loop to report an unhandled rejection.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  for (const name of procedures) fake.liveData[name] = vi.fn(async () => ({}));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("warmPublicReads", () => {
  it("reads every procedure the homepage and the changes page poll", async () => {
    const { warmPublicReads } = await modules();
    await warmPublicReads();
    for (const name of procedures) expect(fake.liveData[name], name).toHaveBeenCalledTimes(1);
  });

  it("is not stopped by one procedure failing, and never throws", async () => {
    const { warmPublicReads } = await modules();
    fake.liveData.directoryFunnel = vi.fn(async () => {
      throw new Error("storage down");
    });
    await expect(warmPublicReads()).resolves.toBeUndefined();
    for (const name of procedures) expect(fake.liveData[name], name).toHaveBeenCalledTimes(1);
  });
});

describe("startReadWarming", () => {
  it("warms once at boot", async () => {
    const { startReadWarming } = await modules();
    startReadWarming();
    await vi.advanceTimersByTimeAsync(0);
    for (const name of procedures) expect(fake.liveData[name], name).toHaveBeenCalledTimes(1);
  });

  it("warms again after a burst of writes settles, once, and only if someone was reading", async () => {
    const { startReadWarming, cachedDirectoryRead, invalidateDirectoryReads } = await modules();
    startReadWarming();
    await vi.advanceTimersByTimeAsync(0);
    await cachedDirectoryRead("k", async () => 1);

    invalidateDirectoryReads();
    await vi.advanceTimersByTimeAsync(3_000);
    invalidateDirectoryReads();
    await vi.advanceTimersByTimeAsync(3_000);
    invalidateDirectoryReads();
    // Each write pushed the rebuild back; nothing has run yet.
    expect(fake.liveData.directoryFunnel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(fake.liveData.directoryFunnel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(fake.liveData.directoryFunnel).toHaveBeenCalledTimes(2);
  });

  it("a soft invalidation schedules the same rebuild, and a strict one in the same burst shares its timer", async () => {
    const { startReadWarming, cachedDirectoryRead, invalidateDirectoryReads, invalidateDirectoryReadsSoftly } = await modules();
    startReadWarming();
    await vi.advanceTimersByTimeAsync(0);
    await cachedDirectoryRead("k", async () => 1);

    invalidateDirectoryReadsSoftly();
    await vi.advanceTimersByTimeAsync(3_000);
    invalidateDirectoryReads();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(fake.liveData.directoryFunnel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(fake.liveData.directoryFunnel).toHaveBeenCalledTimes(2);
  });

  it("does not rebuild a dropped cache that nobody has read for minutes", async () => {
    const { startReadWarming, cachedDirectoryRead, invalidateDirectoryReads } = await modules();
    startReadWarming();
    await vi.advanceTimersByTimeAsync(0);
    await cachedDirectoryRead("k", async () => 1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    invalidateDirectoryReads();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.liveData.directoryFunnel).toHaveBeenCalledTimes(1);
  });

  it("an ingestion write alone schedules the warm-up, and the warm-up's own reads start the background reload", async () => {
    const { startReadWarming, cachedDirectoryRead, invalidateDirectoryReadsSoftly } = await modules();
    let version = 0;
    const load = async () => `v${(version += 1)}`;
    // The funnel stands in for the aggregates: the warm-up reads it through the cache.
    fake.liveData.directoryFunnel = vi.fn(() => cachedDirectoryRead("funnel", load));
    startReadWarming();
    await vi.advanceTimersByTimeAsync(0);
    expect(version).toBe(1);

    invalidateDirectoryReadsSoftly();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(version).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    // The warm-up found the writes quiet. It was answered from the cache, and the reload runs behind it.
    expect(fake.liveData.directoryFunnel).toHaveBeenCalledTimes(2);
    expect(version).toBe(2);
  });

  it("does not rebuild after a soft invalidation either when nobody has read for minutes", async () => {
    const { startReadWarming, cachedDirectoryRead, invalidateDirectoryReadsSoftly } = await modules();
    startReadWarming();
    await vi.advanceTimersByTimeAsync(0);
    await cachedDirectoryRead("k", async () => 1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    invalidateDirectoryReadsSoftly();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.liveData.directoryFunnel).toHaveBeenCalledTimes(1);
  });

  it("an invalidation with no warmer registered is harmless", async () => {
    const { cachedDirectoryRead, invalidateDirectoryReads } = await modules();
    await cachedDirectoryRead("k", async () => 1);
    expect(() => invalidateDirectoryReads()).not.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.liveData.directoryFunnel).not.toHaveBeenCalled();
  });

  it("a rebuild that fails does not become an unhandled rejection", async () => {
    const { setDirectoryReadsWarmer, cachedDirectoryRead, invalidateDirectoryReads } = await modules();
    setDirectoryReadsWarmer(async () => {
      throw new Error("storage down");
    });
    await cachedDirectoryRead("k", async () => 1);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      invalidateDirectoryReads();
      await vi.advanceTimersByTimeAsync(4_000);
      // Unhandled rejections are reported on a later turn of the real event loop.
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("aggregates after an ingestion write", () => {
  it("stay in service, and are reloaded in the background once the writes have been quiet for 3.5 seconds", async () => {
    const { cachedDirectoryRead, invalidateDirectoryReadsSoftly } = await modules();
    let version = 0;
    const load = async () => `v${(version += 1)}`;
    expect(await cachedDirectoryRead("k", load)).toBe("v1");

    invalidateDirectoryReadsSoftly();
    await vi.advanceTimersByTimeAsync(3_499);
    expect(await cachedDirectoryRead("k", load)).toBe("v1");
    expect(version).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    // The caller that finds the writes quiet is still answered from the cache; the reload runs behind it.
    expect(await cachedDirectoryRead("k", load)).toBe("v1");
    await vi.advanceTimersByTimeAsync(0);
    expect(version).toBe(2);
    expect(await cachedDirectoryRead("k", load)).toBe("v2");
    expect(version).toBe(2);
  });

  it("are dropped at once by an operator's write, whatever was marked stale before it", async () => {
    const { cachedDirectoryRead, invalidateDirectoryReads, invalidateDirectoryReadsSoftly } = await modules();
    let version = 0;
    const load = async () => `v${(version += 1)}`;
    await cachedDirectoryRead("k", load);
    invalidateDirectoryReadsSoftly();
    invalidateDirectoryReads();
    expect(await cachedDirectoryRead("k", load)).toBe("v2");
  });

  it("can be given a different quiet period for a test", async () => {
    const { cachedDirectoryRead, invalidateDirectoryReadsSoftly, setDirectorySoftQuietMsForTests } = await modules();
    setDirectorySoftQuietMsForTests(0);
    let version = 0;
    const load = async () => `v${(version += 1)}`;
    await cachedDirectoryRead("k", load);
    invalidateDirectoryReadsSoftly();
    expect(await cachedDirectoryRead("k", load)).toBe("v1");
    await vi.advanceTimersByTimeAsync(0);
    expect(await cachedDirectoryRead("k", load)).toBe("v2");
  });
});

describe("held search results", () => {
  it("are served again until a directory write drops them", async () => {
    const { cachedSearchRead, invalidateDirectoryReads } = await modules();
    let calls = 0;
    const search = async () => `result ${(calls += 1)}`;
    expect(await cachedSearchRead("12\u0000alpha", search)).toBe("result 1");
    expect(await cachedSearchRead("12\u0000alpha", search)).toBe("result 1");
    invalidateDirectoryReads();
    expect(await cachedSearchRead("12\u0000alpha", search)).toBe("result 2");
  });

  it("survive an ingestion write, which only marks the aggregates stale", async () => {
    const { cachedSearchRead, invalidateDirectoryReadsSoftly } = await modules();
    let calls = 0;
    const search = async () => `result ${(calls += 1)}`;
    expect(await cachedSearchRead("12 alpha", search)).toBe("result 1");
    invalidateDirectoryReadsSoftly();
    expect(await cachedSearchRead("12 alpha", search)).toBe("result 1");
  });

  it("are held for a minute, and no longer", async () => {
    const { cachedSearchRead } = await modules();
    let calls = 0;
    const search = async () => (calls += 1);
    await cachedSearchRead("k", search);
    await vi.advanceTimersByTimeAsync(59_000);
    await cachedSearchRead("k", search);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    await cachedSearchRead("k", search);
    expect(calls).toBe(2);
  });
});

describe("the server starts the warm-up", () => {
  it("only when a database is configured, once it is listening", () => {
    const source = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
    // The server's own listen call is the one that logs "Server running"; an earlier one only probes for a free port.
    const logged = source.indexOf("Server running on");
    expect(logged).toBeGreaterThan(-1);
    const start = source.lastIndexOf("server.listen(", logged);
    // The listen callback ends at the first line that is just "  });".
    const callback = source.slice(start, source.indexOf("\n  });", start));
    expect(callback).toContain("if (process.env.DATABASE_URL) startReadWarming();");
  });
});
