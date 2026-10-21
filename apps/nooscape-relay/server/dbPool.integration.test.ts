import { createConnection } from "mysql2/promise";
import { createPool, type Pool } from "mysql2";
import { describe, expect, it } from "vitest";
import { DB_POOL_OPTIONS } from "./db";

/**
 * The host caps this database account at 500 new connections an hour and refuses
 * every connection after that until the hour turns over, so the pool has to keep
 * the connections it opens. These run against a real MySQL (mysql2's reaper is
 * what is under test) and skip when none is reachable.
 */
const BASE_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";

const dbReachable = await (async () => {
  try {
    const probe = await createConnection(`${BASE_URL}/mysql`);
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Runs `count` queries at once, each holding its connection for a moment, so the pool needs `count` connections. */
const burst = (pool: Pool, count: number) => Promise.all(Array.from({ length: count }, () => pool.promise().query("SELECT SLEEP(0.25)")));

describe.skipIf(!dbReachable)("the database pool and the host's hourly connection budget", { timeout: 30_000 }, () => {
  it("opens no new connection for a burst that follows a quiet moment", async () => {
    const pool = createPool({ uri: `${BASE_URL}/mysql`, ...DB_POOL_OPTIONS });
    let opened = 0;
    pool.on("connection", () => {
      opened += 1;
    });
    try {
      await burst(pool, DB_POOL_OPTIONS.connectionLimit);
      expect(opened).toBe(DB_POOL_OPTIONS.connectionLimit);
      // mysql2's idle reaper runs every second. The earlier settings (maxIdle 5, idleTimeout 45 s) had destroyed five of
      // these by now, so the second burst reopened them: ten page loads an hour apart cost a hundred connections.
      await pause(2_500);
      await burst(pool, DB_POOL_OPTIONS.connectionLimit);
      expect(opened).toBe(DB_POOL_OPTIONS.connectionLimit);
    } finally {
      await pool.promise().end();
    }
  });

  it("is the pool getDb builds, with the idle reaper off and TCP keepalive probing well inside a quiet minute", async () => {
    process.env.DATABASE_URL = `${BASE_URL}/mysql`;
    const { getDb } = await import("./db");
    const db = await getDb();
    const pool = (db as unknown as { $client: Pool }).$client;
    const config = (pool as unknown as { config: { maxIdle: number; connectionLimit: number; connectionConfig: { enableKeepAlive: boolean; keepAliveInitialDelay: number } } }).config;
    try {
      // The connection-count watcher is attached to this pool.
      expect(pool.listenerCount("connection")).toBeGreaterThan(0);
      expect(config.connectionLimit).toBe(DB_POOL_OPTIONS.connectionLimit);
      // mysql2 arms its idle reaper only while maxIdle is below connectionLimit.
      expect(config.maxIdle).toBe(config.connectionLimit);
      expect(config.connectionConfig.enableKeepAlive).toBe(true);
      expect(config.connectionConfig.keepAliveInitialDelay).toBeGreaterThan(0);
      expect(config.connectionConfig.keepAliveInitialDelay).toBeLessThanOrEqual(30_000);
    } finally {
      await pool.promise().end();
    }
  });
});
