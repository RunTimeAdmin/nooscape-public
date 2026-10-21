import { describe, expect, it } from "vitest";
import { createReadCache } from "./readCache";

/** A manually advanced clock and a loader that counts its calls. */
function harness(options: { ttlMs?: number; maxKeys?: number; refreshAheadMs?: number; refreshRetryMs?: number; softQuietMs?: number | (() => number); onRefreshError?: (key: string, error: unknown) => void } = {}) {
  let time = 1_000;
  const cache = createReadCache({ ...options, now: () => time });
  const advance = (ms: number) => {
    time += ms;
  };
  return { cache, advance };
}

const counter = <T>(value: T) => {
  let calls = 0;
  return { load: async () => (calls += 1, value), calls: () => calls };
};

describe("createReadCache", () => {
  it("serves a fresh value without reloading, then reloads after the TTL", async () => {
    const { cache, advance } = harness({ ttlMs: 30_000, refreshAheadMs: 0 });
    const loader = counter(7);
    expect(await cache.read("k", loader.load)).toBe(7);
    advance(29_999);
    expect(await cache.read("k", loader.load)).toBe(7);
    expect(loader.calls()).toBe(1);
    advance(2);
    expect(await cache.read("k", loader.load)).toBe(7);
    expect(loader.calls()).toBe(2);
  });

  it("coalesces concurrent callers onto one load", async () => {
    const { cache } = harness();
    let release!: (value: string) => void;
    let calls = 0;
    const load = () => {
      calls += 1;
      return new Promise<string>(resolve => {
        release = resolve;
      });
    };
    const first = cache.read("k", load);
    const second = cache.read("k", load);
    const third = cache.read("k", load);
    release("shared");
    expect(await Promise.all([first, second, third])).toEqual(["shared", "shared", "shared"]);
    expect(calls).toBe(1);
  });

  it("never caches a failure, and every waiter sees the error", async () => {
    const { cache } = harness();
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("storage down");
    };
    const results = await Promise.allSettled([cache.read("k", failing), cache.read("k", failing)]);
    expect(results.map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect(calls).toBe(1);
    // The next call retries from the source instead of replaying the failure.
    expect(await cache.read("k", async () => "recovered")).toBe("recovered");
  });

  it("does not serve a stale value after a failed reload", async () => {
    const { cache, advance } = harness({ ttlMs: 1_000 });
    expect(await cache.read("k", async () => "good")).toBe("good");
    advance(2_000);
    await expect(cache.read("k", async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
  });

  it("invalidate() drops cached values so the next read reloads", async () => {
    const { cache } = harness();
    const loader = counter("v");
    await cache.read("k", loader.load);
    cache.invalidate();
    await cache.read("k", loader.load);
    expect(loader.calls()).toBe(2);
  });

  it("a load already in flight when invalidate() runs is not stored", async () => {
    const { cache } = harness();
    let release!: (value: string) => void;
    const slow = cache.read("k", () => new Promise<string>(resolve => (release = resolve)));
    cache.invalidate();
    release("stale-by-then");
    // The waiting caller still gets its value...
    expect(await slow).toBe("stale-by-then");
    // ...but the cache did not keep it, so the next read goes to the source.
    expect(await cache.read("k", async () => "fresh")).toBe("fresh");
  });

  it("keeps keys independent", async () => {
    const { cache } = harness();
    const a = counter("a");
    const b = counter("b");
    expect(await cache.read("a", a.load)).toBe("a");
    expect(await cache.read("b", b.load)).toBe("b");
    expect(await cache.read("a", a.load)).toBe("a");
    expect([a.calls(), b.calls()]).toEqual([1, 1]);
  });

  it("evicts the oldest key past maxKeys", async () => {
    const { cache } = harness({ maxKeys: 2 });
    await cache.read("a", async () => 1);
    await cache.read("b", async () => 2);
    await cache.read("c", async () => 3);
    expect(cache.size()).toBe(2);
    const reloadA = counter(1);
    await cache.read("a", reloadA.load);
    expect(reloadA.calls()).toBe(1);
  });

  it("a TTL of 0 disables caching but still coalesces", async () => {
    const { cache } = harness({ ttlMs: 0 });
    const loader = counter("x");
    await cache.read("k", loader.load);
    await cache.read("k", loader.load);
    expect(loader.calls()).toBe(2);
    expect(cache.size()).toBe(0);
  });
});

/** A loader the test settles by hand, so it can look at the cache while a reload is still running. */
function manual<T>() {
  let calls = 0;
  let release!: (value: T) => void;
  let fail!: (error: Error) => void;
  const load = () => {
    calls += 1;
    return new Promise<T>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
  };
  return { load, calls: () => calls, release: (value: T) => release(value), fail: (error: Error) => fail(error) };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe("refresh-ahead", () => {
  it("reloads in the background once a value is half its TTL old, without making the caller wait", async () => {
    const { cache, advance } = harness({ ttlMs: 30_000 });
    expect(await cache.read("k", async () => "v1")).toBe("v1");
    advance(14_999);
    const young = manual<string>();
    expect(await cache.read("k", young.load)).toBe("v1");
    expect(young.calls()).toBe(0);

    advance(1);
    const reload = manual<string>();
    // The reload never finishes here, and the caller still gets the current value at once.
    expect(await cache.read("k", reload.load)).toBe("v1");
    expect(reload.calls()).toBe(1);

    reload.release("v2");
    await flush();
    expect(await cache.read("k", async () => "should not be asked")).toBe("v2");
  });

  it("starts one background reload at a time, however many callers arrive", async () => {
    const { cache, advance } = harness({ ttlMs: 30_000 });
    await cache.read("k", async () => "v1");
    advance(20_000);
    const reload = manual<string>();
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => cache.read("k", reload.load)));
    expect(answers).toEqual(["v1", "v1", "v1", "v1", "v1"]);
    expect(reload.calls()).toBe(1);
  });

  it("a reload that finishes before expiry means nobody ever waits for one", async () => {
    const { cache, advance } = harness({ ttlMs: 30_000 });
    let version = 0;
    const load = async () => `v${(version += 1)}`;
    await cache.read("k", load);
    for (let i = 0; i < 6; i += 1) {
      advance(20_000);
      // Every read is answered from the cache; the reload it triggers lands before the next one.
      await cache.read("k", load);
      await flush();
    }
    expect(version).toBeGreaterThan(3);
  });

  it("serves the old value, never an error, when the background reload fails, and never stores the failure", async () => {
    const errors: string[] = [];
    const { cache, advance } = harness({ ttlMs: 30_000, onRefreshError: (key, error) => errors.push(`${key}: ${(error as Error).message}`) });
    await cache.read("k", async () => "v1");
    advance(20_000);
    const failing = manual<string>();
    expect(await cache.read("k", failing.load)).toBe("v1");
    failing.fail(new Error("storage down"));
    await flush();
    expect(errors).toEqual(["k: storage down"]);
    expect(await cache.read("k", async () => "unused")).toBe("v1");
  });

  it("does not hammer a failing source: another background attempt waits out the retry delay", async () => {
    const { cache, advance } = harness({ ttlMs: 60_000, refreshAheadMs: 10_000, refreshRetryMs: 5_000 });
    await cache.read("k", async () => "v1");
    advance(12_000);
    let attempts = 0;
    const failing = async () => {
      attempts += 1;
      throw new Error("down");
    };
    await cache.read("k", failing);
    await flush();
    expect(attempts).toBe(1);
    advance(4_999);
    await cache.read("k", failing);
    await flush();
    expect(attempts).toBe(1);
    advance(2);
    await cache.read("k", failing);
    await flush();
    expect(attempts).toBe(2);
  });

  it("once the old value expires after failed reloads, the next read loads in the foreground and fails closed", async () => {
    const { cache, advance } = harness({ ttlMs: 30_000 });
    await cache.read("k", async () => "v1");
    advance(20_000);
    await cache.read("k", async () => Promise.reject(new Error("down")));
    await flush();
    advance(10_001);
    await expect(cache.read("k", async () => Promise.reject(new Error("still down")))).rejects.toThrow("still down");
  });

  it("an invalidate() while a background reload runs discards its result, and the next read loads again", async () => {
    const { cache, advance } = harness({ ttlMs: 30_000 });
    await cache.read("k", async () => "v1");
    advance(20_000);
    const reload = manual<string>();
    await cache.read("k", reload.load);
    cache.invalidate();
    reload.release("read-before-the-write");
    await flush();
    expect(await cache.read("k", async () => "after the write")).toBe("after the write");
  });

  it("callers that arrive after the old value expired share the reload that is already running", async () => {
    const { cache, advance } = harness({ ttlMs: 30_000 });
    await cache.read("k", async () => "v1");
    advance(20_000);
    const reload = manual<string>();
    await cache.read("k", reload.load);
    advance(11_000);
    const late = cache.read("k", async () => "a second load would answer this");
    reload.release("v2");
    expect(await late).toBe("v2");
    expect(reload.calls()).toBe(1);
  });

  it("refreshAheadMs of 0 turns it off", async () => {
    const { cache, advance } = harness({ ttlMs: 30_000, refreshAheadMs: 0 });
    await cache.read("k", async () => "v1");
    advance(29_000);
    const reload = manual<string>();
    expect(await cache.read("k", reload.load)).toBe("v1");
    expect(reload.calls()).toBe(0);
  });

  it("reports how long it has been since anything was read", async () => {
    const { cache, advance } = harness();
    expect(cache.idleMs()).toBe(Number.POSITIVE_INFINITY);
    await cache.read("k", async () => 1);
    advance(7_000);
    expect(cache.idleMs()).toBe(7_000);
  });
});

describe("softInvalidate", () => {
  /** A long TTL with refresh-ahead off, so only the soft invalidation can start a reload. */
  const soft = (options: { softQuietMs?: number | (() => number); refreshRetryMs?: number; onRefreshError?: (key: string, error: unknown) => void } = {}) =>
    harness({ ttlMs: 300_000, refreshAheadMs: 0, softQuietMs: 3_500, ...options });

  it("keeps serving the cached value, and reloads it in the background once the writes have been quiet", async () => {
    const { cache, advance } = soft();
    expect(await cache.read("k", async () => "v1")).toBe("v1");
    cache.softInvalidate();

    advance(3_499);
    const early = manual<string>();
    expect(await cache.read("k", early.load)).toBe("v1");
    expect(early.calls()).toBe(0);

    advance(1);
    const reload = manual<string>();
    // The reload never finishes here, and the caller still gets the current value at once.
    expect(await cache.read("k", reload.load)).toBe("v1");
    expect(reload.calls()).toBe(1);

    reload.release("v2");
    await flush();
    expect(await cache.read("k", async () => "should not be asked")).toBe("v2");
  });

  it("every further write pushes the reload back, so a burst of writes costs one reload", async () => {
    const { cache, advance } = soft();
    await cache.read("k", async () => "v1");
    const reload = manual<string>();
    for (let write = 0; write < 4; write += 1) {
      cache.softInvalidate();
      advance(3_000);
      expect(await cache.read("k", reload.load)).toBe("v1");
    }
    // Four writes, each 3 s after the one before: never 3.5 s of quiet, so nothing has been reloaded.
    expect(reload.calls()).toBe(0);
    advance(500);
    expect(await cache.read("k", reload.load)).toBe("v1");
    expect(reload.calls()).toBe(1);
  });

  it("starts one reload at a time, however many callers arrive", async () => {
    const { cache, advance } = soft();
    await cache.read("k", async () => "v1");
    cache.softInvalidate();
    advance(3_500);
    const reload = manual<string>();
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => cache.read("k", reload.load)));
    expect(answers).toEqual(["v1", "v1", "v1", "v1", "v1"]);
    expect(reload.calls()).toBe(1);
  });

  it("once the reload has landed the value is current again, and is not reloaded a second time", async () => {
    const { cache, advance } = soft();
    const loader = counter("v");
    await cache.read("k", loader.load);
    cache.softInvalidate();
    advance(3_500);
    await cache.read("k", loader.load);
    await flush();
    expect(loader.calls()).toBe(2);
    for (let i = 0; i < 5; i += 1) {
      advance(10_000);
      await cache.read("k", loader.load);
      await flush();
    }
    expect(loader.calls()).toBe(2);
  });

  it("a write that lands while the reload runs leaves what it loaded stale, so it is reloaded once more", async () => {
    const { cache, advance } = soft();
    await cache.read("k", async () => "v1");
    cache.softInvalidate();
    advance(3_500);
    const first = manual<string>();
    await cache.read("k", first.load);
    // Whatever the reload read may predate this write.
    cache.softInvalidate();
    first.release("v2");
    await flush();

    advance(3_500);
    const second = manual<string>();
    expect(await cache.read("k", second.load)).toBe("v2");
    expect(second.calls()).toBe(1);
    second.release("v3");
    await flush();
    expect(await cache.read("k", async () => "should not be asked")).toBe("v3");
  });

  it("a failed reload leaves the old value in service, is reported, and is not retried before the retry delay", async () => {
    const errors: string[] = [];
    const { cache, advance } = soft({ refreshRetryMs: 5_000, onRefreshError: (key, error) => errors.push(`${key}: ${(error as Error).message}`) });
    await cache.read("k", async () => "v1");
    cache.softInvalidate();
    advance(3_500);
    const failing = manual<string>();
    expect(await cache.read("k", failing.load)).toBe("v1");
    failing.fail(new Error("storage down"));
    await flush();
    expect(errors).toEqual(["k: storage down"]);

    advance(4_999);
    const early = manual<string>();
    expect(await cache.read("k", early.load)).toBe("v1");
    expect(early.calls()).toBe(0);
    advance(1);
    const retry = manual<string>();
    expect(await cache.read("k", retry.load)).toBe("v1");
    expect(retry.calls()).toBe(1);
  });

  it("does not extend the TTL: a stale value past it is loaded again in the foreground", async () => {
    const { cache, advance } = harness({ ttlMs: 10_000, refreshAheadMs: 0, softQuietMs: 60_000 });
    await cache.read("k", async () => "v1");
    cache.softInvalidate();
    advance(10_001);
    expect(await cache.read("k", async () => "v2")).toBe("v2");
  });

  it("invalidate() after it still drops the value, and what loads next is not treated as stale", async () => {
    const { cache, advance } = soft();
    const loader = counter("v");
    await cache.read("k", loader.load);
    cache.softInvalidate();
    cache.invalidate();
    await cache.read("k", loader.load);
    expect(loader.calls()).toBe(2);
    advance(60_000);
    await cache.read("k", loader.load);
    await flush();
    expect(loader.calls()).toBe(2);
  });

  it("an invalidate() while a soft reload runs discards its result, and the next read loads again", async () => {
    const { cache, advance } = soft();
    await cache.read("k", async () => "v1");
    cache.softInvalidate();
    advance(3_500);
    const reload = manual<string>();
    expect(await cache.read("k", reload.load)).toBe("v1");
    cache.invalidate();
    reload.release("read-before-the-hide");
    await flush();
    expect(await cache.read("k", async () => "after the hide")).toBe("after the hide");
  });

  it("reads the quiet period afresh at each call when it is given as a function", async () => {
    let quiet = 60_000;
    const { cache, advance } = soft({ softQuietMs: () => quiet });
    await cache.read("k", async () => "v1");
    cache.softInvalidate();
    advance(1_000);
    const reload = manual<string>();
    await cache.read("k", reload.load);
    expect(reload.calls()).toBe(0);
    quiet = 1_000;
    await cache.read("k", reload.load);
    expect(reload.calls()).toBe(1);
  });

  it("with no quiet period given, waits 3.5 seconds", async () => {
    const { cache, advance } = harness({ ttlMs: 300_000, refreshAheadMs: 0 });
    await cache.read("k", async () => "v1");
    cache.softInvalidate();
    advance(3_499);
    const reload = manual<string>();
    await cache.read("k", reload.load);
    expect(reload.calls()).toBe(0);
    advance(1);
    await cache.read("k", reload.load);
    expect(reload.calls()).toBe(1);
  });
});
