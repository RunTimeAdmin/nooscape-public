import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DB_CONNECTIONS_WARN_PER_HOUR, DB_POOL_OPTIONS, SEARCH_POOL_OPTIONS, watchPoolConnections } from "./db";

/**
 * The host refuses new connections past 500 an hour. A process normally opens
 * about ten and keeps them, so the pool logs when it has opened far more than
 * that: the signal that something is churning, well before the cap.
 */
const HOUR = 3_600_000;

function watched() {
  const pool = new EventEmitter();
  let clock = 1_000_000;
  watchPoolConnections(pool, () => clock);
  return {
    open: (count: number) => {
      for (let i = 0; i < count; i += 1) pool.emit("connection");
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the app's connection budget", () => {
  it("is still ten per process: the main pool and the search pool share what one pool held before", () => {
    // A deploy boots the app twice, and the host's concurrent-connection limit is not known to be higher than that allows.
    expect(DB_POOL_OPTIONS.connectionLimit + SEARCH_POOL_OPTIONS.connectionLimit).toBe(10);
  });

  it("keeps both pools' connections open instead of retiring idle ones", () => {
    expect(DB_POOL_OPTIONS.maxIdle).toBe(DB_POOL_OPTIONS.connectionLimit);
    expect(SEARCH_POOL_OPTIONS.maxIdle).toBe(SEARCH_POOL_OPTIONS.connectionLimit);
  });
});

describe("the pool's connection-count warning", () => {
  it("is set well under the host's cap and well over what restarts open", () => {
    expect(DB_CONNECTIONS_WARN_PER_HOUR).toBeLessThanOrEqual(250);
    // A deploy boots the app twice, and each boot fills a pool.
    expect(DB_CONNECTIONS_WARN_PER_HOUR).toBeGreaterThanOrEqual(DB_POOL_OPTIONS.connectionLimit * 4);
  });

  it("stays quiet at the connections a healthy process opens", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    watched().open(DB_CONNECTIONS_WARN_PER_HOUR - 1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once when the count reaches the threshold, not on every connection after it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    watched().open(DB_CONNECTIONS_WARN_PER_HOUR + 40);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(`${DB_CONNECTIONS_WARN_PER_HOUR} connections opened within an hour`);
  });

  it("keeps counting until the hour is over", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pool = watched();
    pool.open(DB_CONNECTIONS_WARN_PER_HOUR - 1);
    pool.advance(HOUR - 1);
    pool.open(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("counts each hour on its own", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pool = watched();
    pool.open(DB_CONNECTIONS_WARN_PER_HOUR - 1);
    pool.advance(HOUR);
    pool.open(DB_CONNECTIONS_WARN_PER_HOUR - 1);
    expect(warn).not.toHaveBeenCalled();
    // The new hour's count is live: it warns on its own 150th connection.
    pool.open(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
