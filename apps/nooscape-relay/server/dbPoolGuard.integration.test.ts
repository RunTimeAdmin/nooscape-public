import { createConnection } from "mysql2/promise";
import { createPool, type Pool } from "mysql2";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionBreaker, guardPool, POOL_ACQUIRE_TIMEOUT_CODE } from "./dbBreaker";

/**
 * A database that stops answering holds every pooled connection in a hung query,
 * and mysql2 keeps every request behind them waiting for as long as that lasts.
 * These run against a real MySQL (slow queries are SLEEP) and skip when none is
 * reachable.
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
const outcome = (promise: Promise<unknown>) => promise.then(() => "served", (error: { code?: string }) => String(error.code));

describe.skipIf(!dbReachable)("a pool whose connections are all held by slow queries", { timeout: 30_000 }, () => {
  const pools: Pool[] = [];
  afterEach(async () => {
    for (const pool of pools.splice(0)) await pool.promise().end().catch(() => {});
  });

  /**
   * A guarded pool whose connections are already open. The guard's limit applies to every caller, so with a cold pool it also
   * ran against the holders' own connection setup, and a handshake that outlasted it (a loaded machine) made a holder give up
   * and hand its connection to the very requests that were meant to wait. Here the limit is spent only on waiting for a free
   * connection, which is what these tests are about.
   */
  async function guardedPool(connectionLimit: number, acquireTimeoutMs: number) {
    const pool = createPool({ uri: `${BASE_URL}/mysql`, connectionLimit, maxIdle: connectionLimit });
    pools.push(pool);
    const open = await Promise.all(Array.from({ length: connectionLimit }, () => pool.promise().getConnection()));
    for (const connection of open) connection.release();
    guardPool(pool, new ConnectionBreaker({ log: { error: () => {}, warn: () => {} } }), { acquireTimeoutMs });
    return pool;
  }

  it("answers the request that waits too long, and keeps no connection for it", async () => {
    const pool = await guardedPool(1, 300);
    const holder = pool.promise().query("SELECT SLEEP(2)");
    await pause(100);
    const started = Date.now();
    expect(await outcome(pool.promise().query("SELECT 1"))).toBe(POOL_ACQUIRE_TIMEOUT_CODE);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(1_500);

    await holder;
    // The place in the queue the request gave up is served now and its connection goes straight back, so the next request gets it.
    expect(await Promise.race([outcome(pool.promise().query("SELECT 2")), pause(3_000).then(() => "stuck")])).toBe("served");
  });

  it("serves the requests that wait within the limit", async () => {
    const pool = await guardedPool(1, 5_000);
    const holder = pool.promise().query("SELECT SLEEP(0.5)");
    await pause(100);
    const waiting = await Promise.all([outcome(pool.promise().query("SELECT 1")), outcome(pool.promise().query("SELECT 2"))]);
    expect(waiting).toEqual(["served", "served"]);
    await holder;
  });

  it("answers every request that waited too long, not just the first", async () => {
    const pool = await guardedPool(2, 300);
    const holders = [pool.promise().query("SELECT SLEEP(1.5)"), pool.promise().query("SELECT SLEEP(1.5)")];
    await pause(100);
    const waiting = await Promise.all(Array.from({ length: 20 }, () => outcome(pool.promise().query("SELECT 1"))));
    expect(waiting.every(code => code === POOL_ACQUIRE_TIMEOUT_CODE)).toBe(true);
    await Promise.all(holders);
    // All twenty abandoned places drain without holding on to a connection.
    expect(await Promise.race([Promise.all([outcome(pool.promise().query("SELECT 1")), outcome(pool.promise().query("SELECT 2"))]), pause(3_000).then(() => "stuck" as const)])).toEqual(["served", "served"]);
  });
});
