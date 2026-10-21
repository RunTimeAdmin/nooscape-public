import type { EventEmitter } from "node:events";
import net from "node:net";
import { createConnection } from "mysql2/promise";
import { createPool, type Pool } from "mysql2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionBreaker, breakerStream, guardPool, isCircuitOpenError } from "./dbBreaker";

/**
 * The pressure test replayed the host's hourly connection cap and counted 590
 * connection attempts in 30 seconds: every request that needed a connection
 * dialled the host and was refused. These replay it again against a real MySQL
 * (an account limited to a few new connections an hour, as on the host) and count
 * the attempts the server sees. They skip when no MySQL is reachable.
 */
const BASE_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";
const { hostname, port } = new URL(BASE_URL);

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

/** Whether the test server speaks TLS (mysql:8 generates a certificate when it first starts). */
const tlsAvailable = await (async () => {
  if (!dbReachable) return false;
  try {
    const probe = await createConnection({ uri: `${BASE_URL}/mysql`, ssl: { rejectUnauthorized: false } });
    const [rows] = await probe.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    await probe.end();
    return String((rows as Array<{ Value: string }>)[0]?.Value ?? "") !== "";
  } catch {
    return false;
  }
})();

/** The server's own count of connection attempts, successful or refused. */
async function serverConnectionAttempts() {
  const root = await createConnection(`${BASE_URL}/mysql`);
  try {
    const [rows] = await root.query("SHOW GLOBAL STATUS LIKE 'Connections'");
    return Number((rows as Array<{ Value: string }>)[0]!.Value);
  } finally {
    await root.end();
  }
}

const quietLog = { error: () => {}, warn: () => {} };

function guardedPool(uri: string, connectionLimit: number, breaker: ConnectionBreaker | null) {
  const pool = createPool({ uri, connectionLimit, maxIdle: connectionLimit, enableKeepAlive: true, keepAliveInitialDelay: 10_000, ...(breaker ? { stream: breakerStream(breaker) } : {}) });
  if (breaker) guardPool(pool, breaker, { acquireTimeoutMs: 60_000 });
  return pool;
}

const settled = (pool: Pool, count: number) => Promise.allSettled(Array.from({ length: count }, () => pool.promise().query("SELECT 1")));
const errorCodes = (results: PromiseSettledResult<unknown>[]) => results.map(result => (result.status === "rejected" ? String((result.reason as { code?: string }).code) : "ok"));

describe.skipIf(!dbReachable)("an account that has used its connections for the hour", { timeout: 60_000 }, () => {
  const users: string[] = [];
  const pools: Pool[] = [];

  afterEach(async () => {
    for (const pool of pools.splice(0)) await pool.promise().end().catch(() => {});
    const root = await createConnection(`${BASE_URL}/mysql`);
    for (const user of users.splice(0)) await root.query(`DROP USER IF EXISTS '${user}'@'%'`);
    await root.end();
  });

  /** An account allowed `perHour` new connections an hour, like the host's. */
  async function limitedAccount(perHour: number) {
    const user = `cap_${Math.random().toString(36).slice(2, 10)}`;
    const root = await createConnection(`${BASE_URL}/mysql`);
    await root.query(`CREATE USER '${user}'@'%' IDENTIFIED BY 'pw' WITH MAX_CONNECTIONS_PER_HOUR ${perHour}`);
    await root.end();
    users.push(user);
    return `mysql://${user}:pw@${hostname}:${port}`;
  }

  async function flushHourlyCounters() {
    const root = await createConnection(`${BASE_URL}/mysql`);
    await root.query("FLUSH USER_RESOURCES");
    await root.end();
  }

  /** The connections a pool opened, with the ids the server knows them by. */
  type Opened = Array<{ id: number; connection: EventEmitter }>;

  /** Holds `count` connections at once so the pool opens `count`, then gives them back. */
  async function open(pool: Pool, count: number): Promise<Opened> {
    const held = await Promise.all(Array.from({ length: count }, () => pool.promise().getConnection()));
    const ids = await Promise.all(held.map(async connection => Number(((await connection.query("SELECT CONNECTION_ID() AS id"))[0] as Array<{ id: number }>)[0]!.id)));
    for (const connection of held) connection.release();
    return held.map((connection, index) => ({ id: ids[index]!, connection: connection.connection }));
  }

  /**
   * Kills the connections on the server, then waits until the pool has seen each one go. A fixed pause was a guess at how
   * long that takes, and on a loaded machine the next request could still meet a dead connection the pool had not dropped
   * yet and get another error than the one the test is about. The pool's own listener for the end of a connection was added
   * first, so by the time this one runs the pool has let the connection go.
   */
  async function kill(opened: Opened) {
    const gone = opened.map(({ connection }) => new Promise<void>(resolve => {
      connection.once("end", () => resolve());
      connection.once("error", () => resolve());
    }));
    const root = await createConnection(`${BASE_URL}/mysql`);
    for (const { id } of opened) await root.query(`KILL CONNECTION ${id}`);
    await root.end();
    let timer: NodeJS.Timeout | undefined;
    const never = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the pool never saw the killed connections go")), 10_000);
    });
    try {
      await Promise.race([Promise.all(gone), never]);
    } finally {
      clearTimeout(timer);
    }
  }

  it("without the breaker, every request that needs a connection dials the host again (the control)", async () => {
    const uri = await limitedAccount(2);
    const pool = guardedPool(uri, 2, null);
    pools.push(pool);
    await kill(await open(pool, 2));
    const before = await serverConnectionAttempts();
    const results = await settled(pool, 40);
    const dialled = (await serverConnectionAttempts()) - before;
    expect(errorCodes(results).every(code => code === "ER_USER_LIMIT_REACHED")).toBe(true);
    // Each failed attempt frees the pool slot for the next, so the host sees an attempt per request (the 40, plus this probe's own).
    expect(dialled).toBeGreaterThanOrEqual(30);
  });

  it("with the breaker, the host is dialled once, then the requests fail at once without dialling", async () => {
    const uri = await limitedAccount(2);
    const breaker = new ConnectionBreaker({ baseCooldownMs: 600_000, log: quietLog });
    const pool = guardedPool(uri, 2, breaker);
    pools.push(pool);
    await kill(await open(pool, 2));
    const before = await serverConnectionAttempts();
    const results = await settled(pool, 40);
    const dialled = (await serverConnectionAttempts()) - before;
    const codes = errorCodes(results);
    expect(breaker.isOpen()).toBe(true);
    expect(codes.filter(code => code === "ER_USER_LIMIT_REACHED").length).toBeGreaterThanOrEqual(1);
    expect(codes.filter(code => code === "DB_CIRCUIT_OPEN").length).toBeGreaterThanOrEqual(30);
    expect(codes.every(code => code === "ER_USER_LIMIT_REACHED" || code === "DB_CIRCUIT_OPEN")).toBe(true);
    // The probe that measures the host's own count is one attempt of its own; the pool made at most two more.
    expect(dialled).toBeLessThanOrEqual(4);
    for (const result of results) if (result.status === "rejected") expect(isCircuitOpenError(result.reason) || (result.reason as { code?: string }).code === "ER_USER_LIMIT_REACHED").toBe(true);
  });

  it("leaves the connections the pool already holds working while it is open", async () => {
    const uri = await limitedAccount(3);
    const breaker = new ConnectionBreaker({ baseCooldownMs: 600_000, log: quietLog });
    const pool = guardedPool(uri, 3, breaker);
    pools.push(pool);
    const opened = await open(pool, 3);
    // Lose one of the three; replacing it needs a fourth connection, which the account is not allowed.
    await kill([opened[0]!]);
    const trip = await settled(pool, 3);
    expect(errorCodes(trip).filter(code => code === "ER_USER_LIMIT_REACHED").length).toBe(1);
    expect(breaker.isOpen()).toBe(true);
    // Two healthy connections remain. Two at a time are served from them without dialling; a third has nowhere to go.
    const pair = await settled(pool, 2);
    expect(errorCodes(pair)).toEqual(["ok", "ok"]);
    const trio = await settled(pool, 3);
    const codes = errorCodes(trio);
    expect(codes.filter(code => code === "ok").length).toBe(2);
    expect(codes.filter(code => code === "DB_CIRCUIT_OPEN").length).toBe(1);
  });

  it("answers every request that was waiting for a connection, instead of leaving them queued", async () => {
    const uri = await limitedAccount(2);
    const breaker = new ConnectionBreaker({ baseCooldownMs: 600_000, log: quietLog });
    const pool = guardedPool(uri, 2, breaker);
    pools.push(pool);
    const opened = await open(pool, 2);
    // Both connections are busy and five more requests wait for one; then both connections are lost.
    const busy = [1, 2].map(() => pool.promise().query("SELECT SLEEP(5)").catch(() => "lost"));
    await pause(150);
    const waiting = Array.from({ length: 5 }, () => pool.promise().query("SELECT 1").then(() => "ok", (error: { code?: string }) => String(error.code)));
    await pause(100);
    await kill(opened);
    const answered = await Promise.race([Promise.all(waiting), pause(5_000).then(() => "stuck" as const)]);
    expect(answered).not.toBe("stuck");
    expect((answered as string[]).every(code => code === "ER_USER_LIMIT_REACHED" || code === "DB_CIRCUIT_OPEN")).toBe(true);
    await Promise.all(busy);
  });

  it("tries again after the cooldown and carries on once the host accepts connections", async () => {
    const uri = await limitedAccount(2);
    const log = { error: vi.fn(), warn: vi.fn() };
    // The cooldown runs on a clock the test moves, as the unreachable-host tests below do, so no run is cut short by the real one.
    let time = 0;
    const breaker = new ConnectionBreaker({ baseCooldownMs: 300, maxCooldownMs: 300, now: () => time, log });
    const pool = guardedPool(uri, 2, breaker);
    pools.push(pool);
    await kill(await open(pool, 2));
    await settled(pool, 5);
    expect(breaker.isOpen()).toBe(true);
    // The hour turns over: the account may connect again, and the cooldown has run out.
    await flushHourlyCounters();
    time += 400;
    expect(await settled(pool, 1).then(errorCodes)).toEqual(["ok"]);
    expect(breaker.isOpen()).toBe(false);
    expect(await settled(pool, 2).then(errorCodes)).toEqual(["ok", "ok"]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0]![0])).toContain("ER_USER_LIMIT_REACHED");
  });
});

describe("a host that cannot be reached", { timeout: 30_000 }, () => {
  const pools: Pool[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const pool of pools.splice(0)) await pool.promise().end().catch(() => {});
  });

  it("is dialled once, and the requests after that fail at once without opening a socket", async () => {
    const breaker = new ConnectionBreaker({ baseCooldownMs: 600_000, log: quietLog });
    // Nothing listens on port 1.
    const pool = guardedPool("mysql://u:pw@127.0.0.1:1/db", 4, breaker);
    pools.push(pool);
    const first = await settled(pool, 1);
    expect(errorCodes(first)).toEqual(["ECONNREFUSED"]);
    expect(breaker.isOpen()).toBe(true);

    const dial = vi.spyOn(net, "connect");
    // Failing at once means waiting for nothing: not for a socket, and not for the cooldown (ten minutes here). A sentinel far
    // past any slow machine and far short of the cooldown tells the two apart, which a stopwatch on a loaded machine does not.
    const results = await Promise.race([settled(pool, 100), pause(10_000).then(() => "stuck" as const)]);
    expect(results).not.toBe("stuck");
    expect(errorCodes(results as PromiseSettledResult<unknown>[]).every(code => code === "DB_CIRCUIT_OPEN")).toBe(true);
    expect(dial).not.toHaveBeenCalled();
  });

  it("is dialled again after the cooldown, by one request", async () => {
    let time = 0;
    const breaker = new ConnectionBreaker({ baseCooldownMs: 10_000, now: () => time, log: quietLog });
    const pool = guardedPool("mysql://u:pw@127.0.0.1:1/db", 4, breaker);
    pools.push(pool);
    await settled(pool, 1);
    const dial = vi.spyOn(net, "connect");
    expect(errorCodes(await settled(pool, 10)).every(code => code === "DB_CIRCUIT_OPEN")).toBe(true);
    expect(dial).not.toHaveBeenCalled();
    time += 10_000;
    const probe = await settled(pool, 10);
    expect(dial).toHaveBeenCalledTimes(1);
    expect(errorCodes(probe).filter(code => code === "ECONNREFUSED").length).toBe(1);
    expect(errorCodes(probe).filter(code => code === "DB_CIRCUIT_OPEN").length).toBe(9);
  });
});

/**
 * The breaker supplies the pool's sockets, and mysql2 upgrades the one it is given
 * to TLS when the connection asks for it. The host's database may require TLS, so
 * a socket from the breaker's factory has to survive that upgrade.
 */
describe.skipIf(!tlsAvailable)("a pool that dials through the breaker's stream", { timeout: 30_000 }, () => {
  const cipherOf = async (ssl: boolean) => {
    const pool = createPool({
      uri: `${BASE_URL}/mysql`,
      connectionLimit: 1,
      ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      stream: breakerStream(new ConnectionBreaker({ log: quietLog })),
    });
    try {
      const [rows] = await pool.promise().query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
      return String((rows as Array<{ Value: string }>)[0]!.Value);
    } finally {
      await pool.promise().end();
    }
  };

  it("negotiates TLS when the connection is configured for it", async () => {
    expect(await cipherOf(true)).not.toBe("");
  });

  it("stays in the clear when it is not (the control)", async () => {
    expect(await cipherOf(false)).toBe("");
  });
});
