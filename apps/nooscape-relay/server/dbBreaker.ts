import net from "node:net";

/**
 * Stops the app from hammering a database host that is refusing it.
 *
 * The host caps this account at 500 new connections an hour and, once the cap is
 * hit, refuses every connection until the hour turns over (ER_USER_LIMIT_REACHED).
 * Replaying that in the pressure test, every request that needed a connection
 * dialled the host again and failed: 590 attempts in 30 seconds. A refused attempt
 * costs the host work and the visitor a failed request, and retrying at that rate
 * keeps a transient refusal going. The breaker opens on the first refusal; while it
 * is open a new connection is not attempted and the caller fails at once with
 * DB_CIRCUIT_OPEN. Connections the pool already holds are untouched. After a
 * cooldown one attempt goes through; if the host accepts it the breaker closes, and
 * if it refuses it the breaker reopens with a longer cooldown.
 */

/** What a caller sees while the breaker is open. Callers treat it like any other connection failure. */
export const CIRCUIT_OPEN_CODE = "DB_CIRCUIT_OPEN";

/**
 * Errors that mean the host refused or could not be reached for a new connection,
 * as opposed to a bad query: the account's hourly and concurrent limits, the
 * server's connection limit, a blocked client host, and the network failures of a
 * connect. 1226, 1203, 1040 and 1129 on MySQL and MariaDB.
 */
const REFUSAL_CODES = new Set([
  "ER_USER_LIMIT_REACHED",
  "ER_TOO_MANY_USER_CONNECTIONS",
  "ER_CON_COUNT_ERROR",
  "ER_HOST_IS_BLOCKED",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const REFUSAL_ERRNOS = new Set([1226, 1203, 1040, 1129]);

/** Walks an error's cause chain, because a driver error can arrive wrapped. */
function causes(error: unknown): Array<{ code?: unknown; errno?: unknown }> {
  const chain: Array<{ code?: unknown; errno?: unknown }> = [];
  for (let depth = 0, cause: unknown = error; cause && typeof cause === "object" && depth < 4; depth += 1) {
    chain.push(cause as { code?: unknown; errno?: unknown });
    cause = (cause as { cause?: unknown }).cause;
  }
  return chain;
}

export function isConnectionRefusal(error: unknown): boolean {
  return causes(error).some(({ code, errno }) => (typeof code === "string" && REFUSAL_CODES.has(code)) || (typeof errno === "number" && REFUSAL_ERRNOS.has(errno)));
}

/** True when the error is the breaker's own refusal to dial, so a log line about it is already written once, by the breaker. */
export function isCircuitOpenError(error: unknown): boolean {
  return causes(error).some(({ code }) => code === CIRCUIT_OPEN_CODE);
}

function refusalLabel(error: unknown): string {
  for (const { code } of causes(error)) if (typeof code === "string" && REFUSAL_CODES.has(code)) return code;
  return "refused";
}

type ConnectionBreakerOptions = {
  /** Cooldown after the first refusal. */
  baseCooldownMs?: number;
  /** Cooldown never grows past this. It doubles on each refused probe. */
  maxCooldownMs?: number;
  /** A probe that reports nothing for this long is given up on, so one lost attempt cannot hold the breaker shut. */
  probeTimeoutMs?: number;
  now?: () => number;
  log?: Pick<Console, "error" | "warn">;
};

export class ConnectionBreaker {
  private state: "closed" | "open" | "probing" = "closed";
  private reopenAt = 0;
  private probeStartedAt = 0;
  private cooldownMs: number;
  private heldBack = 0;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: Pick<Console, "error" | "warn">;

  constructor(options: ConnectionBreakerOptions = {}) {
    this.baseCooldownMs = options.baseCooldownMs ?? 10_000;
    this.maxCooldownMs = options.maxCooldownMs ?? 120_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console;
    this.cooldownMs = this.baseCooldownMs;
  }

  /** Called before every attempt to open a connection. False means do not dial. */
  allowAttempt(): boolean {
    if (this.state === "closed") return true;
    const time = this.now();
    if (this.state === "open" && time >= this.reopenAt) {
      this.state = "probing";
      this.probeStartedAt = time;
      return true;
    }
    if (this.state === "probing" && time - this.probeStartedAt >= this.probeTimeoutMs) {
      this.probeStartedAt = time;
      return true;
    }
    this.heldBack += 1;
    return false;
  }

  /** A connection attempt failed. Only a refusal opens or extends the breaker; a probe that fails any other way gives the next caller the probe. */
  recordFailure(error: unknown) {
    // An attempt the breaker itself held back fails with its own code. That is not the host answering.
    if (isCircuitOpenError(error)) return;
    if (!isConnectionRefusal(error)) {
      if (this.state === "probing") {
        this.state = "open";
        this.reopenAt = this.now();
      }
      return;
    }
    // Attempts that were already in flight when the breaker opened report their refusals late; they add nothing.
    if (this.state === "open") return;
    const refused = refusalLabel(error);
    if (this.state === "probing") {
      this.cooldownMs = Math.min(this.cooldownMs * 2, this.maxCooldownMs);
      this.log.error(`[Database] The host still refuses new connections (${refused}). Next attempt in ${Math.round(this.cooldownMs / 1000)} s.`);
    } else {
      this.cooldownMs = this.baseCooldownMs;
      this.log.error(
        `[Database] The host refused a new connection (${refused}). Pausing new connection attempts for ${Math.round(this.cooldownMs / 1000)} s; connections already open keep working.`
      );
    }
    this.state = "open";
    this.reopenAt = this.now() + this.cooldownMs;
  }

  /** A connection was opened, so the host is accepting them. */
  recordSuccess() {
    if (this.state === "closed") return;
    this.log.warn(`[Database] The host is accepting connections again; ${this.heldBack} attempt${this.heldBack === 1 ? " was" : "s were"} held back while it was not.`);
    this.state = "closed";
    this.cooldownMs = this.baseCooldownMs;
    this.heldBack = 0;
  }

  isOpen() {
    return this.state !== "closed";
  }
}

/** A socket that fails at once with the breaker's code, so mysql2 reports a failed connection without dialling. */
function refusedSocket() {
  const socket = new net.Socket();
  const error = Object.assign(new Error("New database connections are paused because the host is refusing them."), { code: CIRCUIT_OPEN_CODE });
  // mysql2 attaches its error listener right after the stream factory returns.
  process.nextTick(() => socket.destroy(error));
  return socket;
}

type DialConfig = { host?: string; port?: number; socketPath?: string; enableKeepAlive?: boolean; keepAliveInitialDelay?: number };

/**
 * The stream factory mysql2 calls for every new connection (the pool option
 * `stream`). It dials exactly as mysql2's default does (keepalive and no-delay
 * included) unless the breaker says not to. mysql2 passes `{ config }` where its
 * type declares the flat connection options, hence the loose parameter.
 */
export function breakerStream(breaker: ConnectionBreaker) {
  return (options: unknown) => {
    if (!breaker.allowAttempt()) return refusedSocket();
    const config = (options as { config?: DialConfig } | undefined)?.config ?? {};
    if (config.socketPath) return net.connect(config.socketPath);
    const socket = net.connect(config.port ?? 3306, config.host);
    if (config.enableKeepAlive) socket.on("connect", () => socket.setKeepAlive(true, config.keepAliveInitialDelay));
    socket.setNoDelay(true);
    return socket;
  };
}

/** What a caller sees when it waited too long for a pooled connection. */
export const POOL_ACQUIRE_TIMEOUT_CODE = "POOL_ACQUIRE_TIMEOUT";

type PoolConnectionLike = { release(): void };
type PoolCallback = (error: Error | null, connection?: PoolConnectionLike) => void;
type GuardedPool = {
  on(event: "connection", listener: () => void): unknown;
  getConnection(callback: PoolCallback): unknown;
};

const ALREADY_GUARDED = Symbol("guarded pool callback");

/**
 * Guards every route to a pooled connection. Query, execute and getConnection
 * all go through the pool's getConnection, and so do the queued callers mysql2
 * hands back to it when a connection is lost.
 *
 * - The breaker learns what the pool learns: a new connection means the host is
 *   accepting them, and a failed one is checked for a refusal.
 * - A caller that waits longer than `acquireTimeoutMs` for a connection is
 *   answered with POOL_ACQUIRE_TIMEOUT. mysql2 has no such limit, so when every
 *   connection was held by a hung query the callers behind it waited for as long
 *   as the hang lasted (the pressure test's frozen database: requests waited out
 *   the whole freeze). The caller's place in mysql2's queue stays until a
 *   connection frees up; the connection it is then handed goes straight back, so
 *   a caller that gave up costs the queue slot and nothing else.
 */
export function guardPool(pool: GuardedPool, breaker: ConnectionBreaker, options: { acquireTimeoutMs: number }) {
  pool.on("connection", () => breaker.recordSuccess());
  const original = pool.getConnection.bind(pool);
  pool.getConnection = (callback: PoolCallback & { [ALREADY_GUARDED]?: true }) => {
    // A queued caller comes back here with the callback it was given. Its wait began at the first call.
    if (callback[ALREADY_GUARDED]) return original(callback);
    let gaveUp = false;
    const timer = setTimeout(() => {
      gaveUp = true;
      callback(Object.assign(new Error("Timed out waiting for a database connection."), { code: POOL_ACQUIRE_TIMEOUT_CODE }));
    }, options.acquireTimeoutMs);
    timer.unref();
    const guarded: PoolCallback & { [ALREADY_GUARDED]?: true } = (error, connection) => {
      clearTimeout(timer);
      if (error) breaker.recordFailure(error);
      if (gaveUp) {
        connection?.release();
        return;
      }
      callback(error, connection);
    };
    guarded[ALREADY_GUARDED] = true;
    return original(guarded);
  };
}

/** One breaker for the process: the main and search pools use the same account, so the host refuses both together. */
export const databaseBreaker = new ConnectionBreaker();
