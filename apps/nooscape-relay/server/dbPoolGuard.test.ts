import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionBreaker, guardPool, POOL_ACQUIRE_TIMEOUT_CODE } from "./dbBreaker";

type Connection = { release: () => void };
type Callback = (error: Error | null, connection?: Connection) => void;

/**
 * A pool whose getConnection only records the callback, so a test decides when
 * and how each caller is answered, as mysql2's queue does when connections free up.
 */
function fakePool() {
  const queued: Callback[] = [];
  const listeners: Array<() => void> = [];
  return {
    queued,
    on(_event: "connection", listener: () => void) {
      listeners.push(listener);
    },
    getConnection(callback: Callback) {
      queued.push(callback);
    },
    connectionOpened: () => listeners.forEach(listener => listener()),
  };
}

const capReached = () => Object.assign(new Error("max_connections_per_hour"), { code: "ER_USER_LIMIT_REACHED" });
const connection = (): Connection => ({ release: vi.fn() });

function guarded(acquireTimeoutMs = 1_000) {
  const pool = fakePool();
  const breaker = new ConnectionBreaker({ log: { error: () => {}, warn: () => {} } });
  guardPool(pool, breaker, { acquireTimeoutMs });
  return { pool, breaker };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a request waiting for a pooled connection", () => {
  it("is answered with a timeout once it has waited too long", () => {
    vi.useFakeTimers();
    const { pool } = guarded(1_000);
    const callback = vi.fn();
    pool.getConnection(callback);
    vi.advanceTimersByTime(999);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toMatchObject({ code: POOL_ACQUIRE_TIMEOUT_CODE });
  });

  it("hands the connection on, not to the caller that gave up, when one finally frees up", () => {
    vi.useFakeTimers();
    const { pool } = guarded(1_000);
    const callback = vi.fn();
    pool.getConnection(callback);
    vi.advanceTimersByTime(1_000);
    const freed = connection();
    pool.queued[0]!(null, freed);
    expect(freed.release).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("is never timed out once it has been served", () => {
    vi.useFakeTimers();
    const { pool } = guarded(1_000);
    const callback = vi.fn();
    pool.getConnection(callback);
    vi.advanceTimersByTime(400);
    const served = connection();
    pool.queued[0]!(null, served);
    vi.advanceTimersByTime(60_000);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, served);
    expect(served.release).not.toHaveBeenCalled();
  });

  it("is answered with the pool's own error when the pool fails it first", () => {
    vi.useFakeTimers();
    const { pool } = guarded(1_000);
    const callback = vi.fn();
    pool.getConnection(callback);
    const failure = new Error("Queue limit reached.");
    pool.queued[0]!(failure);
    vi.advanceTimersByTime(60_000);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(failure, undefined);
  });

  it("keeps the clock it started with when mysql2 hands it back to getConnection after a lost connection", () => {
    vi.useFakeTimers();
    const { pool } = guarded(1_000);
    const callback = vi.fn();
    pool.getConnection(callback);
    vi.advanceTimersByTime(600);
    // mysql2 re-dispatches a queued caller with the callback it was given.
    pool.getConnection(pool.queued[0]!);
    expect(pool.queued).toHaveLength(2);
    expect(pool.queued[1]).toBe(pool.queued[0]);
    vi.advanceTimersByTime(399);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("is served by the re-dispatched attempt when that one succeeds", () => {
    vi.useFakeTimers();
    const { pool } = guarded(1_000);
    const callback = vi.fn();
    pool.getConnection(callback);
    pool.getConnection(pool.queued[0]!);
    const served = connection();
    pool.queued[1]!(null, served);
    vi.advanceTimersByTime(60_000);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(null, served);
  });

  it("does not keep the process alive for a wait nobody is left to see", () => {
    const unref = vi.fn();
    vi.spyOn(globalThis, "setTimeout").mockImplementation((() => ({ unref })) as never);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const { pool } = guarded(1_000);
    pool.getConnection(vi.fn());
    expect(unref).toHaveBeenCalledTimes(1);
  });
});

describe("what the guard tells the breaker", () => {
  it("passes on a refusal that fails a caller that is still waiting", () => {
    const { pool, breaker } = guarded();
    const callback = vi.fn();
    pool.getConnection(callback);
    pool.queued[0]!(capReached());
    expect(breaker.isOpen()).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("passes on a refusal that arrives after the caller gave up", () => {
    vi.useFakeTimers();
    const { pool, breaker } = guarded(1_000);
    const callback = vi.fn();
    pool.getConnection(callback);
    vi.advanceTimersByTime(1_000);
    expect(breaker.isOpen()).toBe(false);
    pool.queued[0]!(capReached());
    expect(breaker.isOpen()).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not take a wait that ran out for a refusal", () => {
    vi.useFakeTimers();
    const { pool, breaker } = guarded(1_000);
    pool.getConnection(vi.fn());
    vi.advanceTimersByTime(5_000);
    expect(breaker.isOpen()).toBe(false);
  });

  it("closes the breaker when the pool opens a connection", () => {
    const { pool, breaker } = guarded();
    breaker.recordFailure(capReached());
    expect(breaker.isOpen()).toBe(true);
    pool.connectionOpened();
    expect(breaker.isOpen()).toBe(false);
  });
});
