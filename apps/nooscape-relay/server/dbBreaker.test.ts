import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { breakerStream, CIRCUIT_OPEN_CODE, ConnectionBreaker, isCircuitOpenError, isConnectionRefusal } from "./dbBreaker";

/** The host's hourly cap, as mysql2 reports it. */
const capReached = () => Object.assign(new Error("User 'u' has exceeded the 'max_connections_per_hour' resource"), { code: "ER_USER_LIMIT_REACHED", errno: 1226, fatal: true });

function breaker(options: { baseCooldownMs?: number; maxCooldownMs?: number; probeTimeoutMs?: number } = {}) {
  let time = 1_000_000;
  const log = { error: vi.fn(), warn: vi.fn() };
  const instance = new ConnectionBreaker({ baseCooldownMs: 10_000, maxCooldownMs: 40_000, probeTimeoutMs: 30_000, ...options, now: () => time, log });
  return { instance, log, advance: (ms: number) => (time += ms) };
}

describe("what counts as the host refusing a connection", () => {
  it("recognises the account and server limits by code or by number", () => {
    for (const code of ["ER_USER_LIMIT_REACHED", "ER_TOO_MANY_USER_CONNECTIONS", "ER_CON_COUNT_ERROR", "ER_HOST_IS_BLOCKED"]) {
      expect(isConnectionRefusal(Object.assign(new Error("x"), { code })), code).toBe(true);
    }
    for (const errno of [1226, 1203, 1040, 1129]) {
      expect(isConnectionRefusal(Object.assign(new Error("x"), { errno })), String(errno)).toBe(true);
    }
  });

  it("recognises the failures of a connect that never reached the server", () => {
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"]) {
      expect(isConnectionRefusal(Object.assign(new Error("x"), { code })), code).toBe(true);
    }
  });

  it("finds a refusal wrapped by the query builder", () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: capReached() });
    expect(isConnectionRefusal(wrapped)).toBe(true);
  });

  it("does not take a bad query, bad credentials, or a dropped connection for a refusal", () => {
    for (const code of ["ER_PARSE_ERROR", "ER_ACCESS_DENIED_ERROR", "ER_QUERY_TIMEOUT", "PROTOCOL_CONNECTION_LOST", "ECONNRESET", "ER_LOCK_DEADLOCK"]) {
      expect(isConnectionRefusal(Object.assign(new Error("x"), { code })), code).toBe(false);
    }
    expect(isConnectionRefusal(new Error("plain"))).toBe(false);
    expect(isConnectionRefusal(undefined)).toBe(false);
    expect(isConnectionRefusal("ER_USER_LIMIT_REACHED")).toBe(false);
  });

  it("finds the breaker's own code in a wrapped error", () => {
    const open = Object.assign(new Error("paused"), { code: CIRCUIT_OPEN_CODE });
    expect(isCircuitOpenError(open)).toBe(true);
    expect(isCircuitOpenError(Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("wrapped"), { cause: open }) }))).toBe(true);
    expect(isCircuitOpenError(capReached())).toBe(false);
    expect(isCircuitOpenError(null)).toBe(false);
  });
});

describe("the connection breaker", () => {
  it("lets every attempt through until the host refuses one", () => {
    const { instance } = breaker();
    for (let i = 0; i < 20; i += 1) expect(instance.allowAttempt()).toBe(true);
    expect(instance.isOpen()).toBe(false);
  });

  it("opens on a refusal and holds every attempt back for the cooldown", () => {
    const { instance, advance } = breaker();
    instance.recordFailure(capReached());
    expect(instance.isOpen()).toBe(true);
    expect(instance.allowAttempt()).toBe(false);
    advance(9_999);
    expect(instance.allowAttempt()).toBe(false);
  });

  it("does not open for a failure that is not a refusal", () => {
    const { instance } = breaker();
    instance.recordFailure(Object.assign(new Error("syntax"), { code: "ER_PARSE_ERROR" }));
    expect(instance.isOpen()).toBe(false);
    expect(instance.allowAttempt()).toBe(true);
  });

  it("lets exactly one attempt through after the cooldown, and holds the rest back until it reports", () => {
    const { instance, advance } = breaker();
    instance.recordFailure(capReached());
    advance(10_000);
    expect(instance.allowAttempt()).toBe(true);
    expect(instance.allowAttempt()).toBe(false);
    expect(instance.allowAttempt()).toBe(false);
  });

  it("closes when the probe is accepted, and says how many attempts it held back", () => {
    const { instance, log, advance } = breaker();
    instance.recordFailure(capReached());
    instance.allowAttempt();
    instance.allowAttempt();
    advance(10_000);
    expect(instance.allowAttempt()).toBe(true);
    instance.recordSuccess();
    expect(instance.isOpen()).toBe(false);
    expect(instance.allowAttempt()).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toContain("2 attempts were held back");
  });

  it("reopens with a longer cooldown when the probe is refused, up to the maximum", () => {
    const { instance, log, advance } = breaker();
    instance.recordFailure(capReached());
    const cooldowns: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      const waited = [10_000, 20_000, 40_000, 40_000][round]!;
      advance(waited - 1);
      expect(instance.allowAttempt(), `round ${round} still cooling`).toBe(false);
      advance(1);
      expect(instance.allowAttempt(), `round ${round} probe`).toBe(true);
      instance.recordFailure(capReached());
      cooldowns.push(Number(/Next attempt in (\d+) s/.exec(String(log.error.mock.calls.at(-1)![0]))![1]));
    }
    expect(cooldowns).toEqual([20, 40, 40, 40]);
  });

  it("ignores refusals from attempts that were already in flight when it opened", () => {
    const { instance, log, advance } = breaker();
    instance.recordFailure(capReached());
    advance(5_000);
    instance.recordFailure(capReached());
    instance.recordFailure(capReached());
    expect(log.error).toHaveBeenCalledTimes(1);
    // The cooldown still ends ten seconds after the first refusal, not after the last.
    advance(5_000);
    expect(instance.allowAttempt()).toBe(true);
  });

  it("gives the next caller the probe at once when a probe fails some other way", () => {
    const { instance, advance } = breaker();
    instance.recordFailure(capReached());
    advance(10_000);
    expect(instance.allowAttempt()).toBe(true);
    instance.recordFailure(Object.assign(new Error("denied"), { code: "ER_ACCESS_DENIED_ERROR" }));
    expect(instance.allowAttempt()).toBe(true);
  });

  it("does not take the attempts it held back for a failed probe", () => {
    const { instance, advance } = breaker();
    instance.recordFailure(capReached());
    advance(10_000);
    expect(instance.allowAttempt()).toBe(true);
    // Callers held back while the probe is out fail with the breaker's own code, and report it.
    for (let i = 0; i < 5; i += 1) {
      expect(instance.allowAttempt()).toBe(false);
      instance.recordFailure(Object.assign(new Error("paused"), { code: CIRCUIT_OPEN_CODE }));
    }
    expect(instance.allowAttempt()).toBe(false);
  });

  it("gives up on a probe that never reports, so one lost attempt cannot hold it shut", () => {
    const { instance, advance } = breaker();
    instance.recordFailure(capReached());
    advance(10_000);
    expect(instance.allowAttempt()).toBe(true);
    advance(29_999);
    expect(instance.allowAttempt()).toBe(false);
    advance(1);
    expect(instance.allowAttempt()).toBe(true);
  });

  it("logs a transition once each, not a line per attempt", () => {
    const { instance, log, advance } = breaker();
    instance.recordFailure(capReached());
    for (let i = 0; i < 500; i += 1) instance.allowAttempt();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toContain("ER_USER_LIMIT_REACHED");
    expect(log.error.mock.calls[0]![0]).toContain("10 s");
    advance(10_000);
    instance.allowAttempt();
    instance.recordSuccess();
    instance.recordSuccess();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("says nothing when a connection opens while it is closed", () => {
    const { instance, log } = breaker();
    instance.recordSuccess();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

/**
 * The stream factory replaces mysql2's own dialling, so it has to dial the same
 * way: TCP keepalive after connect (the host's idle killer would otherwise drop a
 * quiet connection without notice) and no Nagle delay.
 */
describe("the stream the pool dials with", () => {
  const closers: Array<() => void> = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const close of closers.splice(0)) close();
  });

  function listen(target: number | string) {
    return new Promise<{ server: net.Server; port: number }>(resolve => {
      const server = net.createServer(connection => connection.on("error", () => {}));
      closers.push(() => server.close());
      server.listen(target, () => {
        const address = server.address();
        resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
      });
    });
  }

  const connected = (socket: net.Socket) => new Promise<void>(resolve => socket.once("connect", resolve));

  it("connects over TCP, with keepalive after connect and no delay, when the breaker allows it", async () => {
    const keepAlive = vi.spyOn(net.Socket.prototype, "setKeepAlive");
    const noDelay = vi.spyOn(net.Socket.prototype, "setNoDelay");
    const { port } = await listen(0);
    const socket = breakerStream(new ConnectionBreaker())({ config: { host: "127.0.0.1", port, enableKeepAlive: true, keepAliveInitialDelay: 10_000 } }) as net.Socket;
    closers.push(() => socket.destroy());
    expect(noDelay).toHaveBeenCalledWith(true);
    await connected(socket);
    expect(keepAlive).toHaveBeenCalledWith(true, 10_000);
  });

  it("leaves keepalive off when the pool is not configured for it", async () => {
    const keepAlive = vi.spyOn(net.Socket.prototype, "setKeepAlive");
    const { port } = await listen(0);
    const socket = breakerStream(new ConnectionBreaker())({ config: { host: "127.0.0.1", port, enableKeepAlive: false } }) as net.Socket;
    closers.push(() => socket.destroy());
    await connected(socket);
    expect(keepAlive).not.toHaveBeenCalled();
  });

  it("connects to a socket path when the configuration names one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nooscape-socket-"));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = process.platform === "win32" ? String.raw`\\.\pipe\nooscape-${process.pid}-${Date.now()}` : join(dir, "db.sock");
    await listen(path);
    const socket = breakerStream(new ConnectionBreaker())({ config: { socketPath: path } }) as net.Socket;
    closers.push(() => socket.destroy());
    await connected(socket);
  });

  it("does not dial while the breaker is holding attempts back: the socket fails with the breaker's code", async () => {
    const breaker = new ConnectionBreaker({ log: { error: () => {}, warn: () => {} } });
    breaker.recordFailure(capReached());
    const dial = vi.spyOn(net, "connect");
    const socket = breakerStream(breaker)({ config: { host: "127.0.0.1", port: 9 } }) as net.Socket;
    const error = await new Promise<Error>(resolve => socket.once("error", resolve));
    expect(dial).not.toHaveBeenCalled();
    expect((error as { code?: string }).code).toBe(CIRCUIT_OPEN_CODE);
  });
});
