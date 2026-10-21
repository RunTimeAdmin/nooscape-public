import net from "node:net";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

/**
 * The breaker only helps if both pools db.ts builds go through it, share it, and
 * the request logs do not turn a pause into a line per request. Nothing here needs
 * a database: the host is a closed port.
 */
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "mysql://u:pw@127.0.0.1:1/db");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("./dbBreaker");
  vi.doUnmock("./db");
  vi.doUnmock("./agentRegistryRows");
  vi.doUnmock("./operatorAuth");
});

describe("the pools db.ts builds", { timeout: 60_000 }, () => {
  it("share one breaker: a refusal on the main pool holds back the search pool too, and nothing is dialled", async () => {
    const { getDb, withSearchConnection } = await import("./db");
    const { databaseBreaker, isCircuitOpenError, isConnectionRefusal } = await import("./dbBreaker");
    const db = (await getDb())!;

    const first = await db.execute(sql`SELECT 1`).catch((error: unknown) => error);
    expect(isConnectionRefusal(first)).toBe(true);
    expect(databaseBreaker.isOpen()).toBe(true);

    const dial = vi.spyOn(net, "connect");
    const second = await db.execute(sql`SELECT 1`).catch((error: unknown) => error);
    expect(isCircuitOpenError(second)).toBe(true);
    const search = await withSearchConnection(async () => 1).catch((error: unknown) => error);
    expect(isCircuitOpenError(search)).toBe(true);
    expect(dial).not.toHaveBeenCalled();
  });

  it("are each guarded with their own limit on waiting for a connection, and the main pool's queue has a valve", async () => {
    vi.doMock("./dbBreaker", async importOriginal => {
      const actual = await importOriginal<typeof import("./dbBreaker")>();
      return { ...actual, guardPool: vi.fn(actual.guardPool) };
    });
    const { getDb, withSearchConnection, DB_ACQUIRE_TIMEOUT_MS, DB_POOL_OPTIONS, SEARCH_ACQUIRE_TIMEOUT_MS } = await import("./db");
    const breaker = await import("./dbBreaker");
    const db = (await getDb())!;
    await withSearchConnection(async () => 1).catch(() => {});

    const calls = vi.mocked(breaker.guardPool).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toBe(breaker.databaseBreaker);
    expect(calls[1]![1]).toBe(breaker.databaseBreaker);
    expect(calls[0]![2]).toEqual({ acquireTimeoutMs: DB_ACQUIRE_TIMEOUT_MS });
    expect(calls[1]![2]).toEqual({ acquireTimeoutMs: SEARCH_ACQUIRE_TIMEOUT_MS });

    // Long enough to ride out an aggregate rebuild that holds most connections, short of the CDN's patience.
    expect(DB_ACQUIRE_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
    expect(DB_ACQUIRE_TIMEOUT_MS).toBeLessThanOrEqual(55_000);
    // A search is declined sooner than a page read gives up.
    expect(SEARCH_ACQUIRE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(SEARCH_ACQUIRE_TIMEOUT_MS).toBeLessThan(DB_ACQUIRE_TIMEOUT_MS);

    const pool = (db as unknown as { $client: { config: { queueLimit: number } } }).$client;
    expect(pool.config.queueLimit).toBe(DB_POOL_OPTIONS.queueLimit);
    expect(DB_POOL_OPTIONS.queueLimit).toBeGreaterThanOrEqual(1_000);
  });

  it("open the breaker from the search pool as well", async () => {
    const { getDb, withSearchConnection } = await import("./db");
    const { databaseBreaker, isCircuitOpenError, isConnectionRefusal } = await import("./dbBreaker");
    const search = await withSearchConnection(async () => 1).catch((error: unknown) => error);
    expect(isConnectionRefusal(search)).toBe(true);
    expect(databaseBreaker.isOpen()).toBe(true);
    const main = await (await getDb())!.execute(sql`SELECT 1`).catch((error: unknown) => error);
    expect(isCircuitOpenError(main)).toBe(true);
  });
});

const OPERATOR = { id: 1, name: "Test Operator", role: "admin" as const, openId: "test-operator" };
const paused = () => new Error("Failed query: select 1", { cause: Object.assign(new Error("paused"), { code: "DB_CIRCUIT_OPEN" }) });
const refused = () => new Error("Failed query: select 1", { cause: Object.assign(new Error("refused"), { code: "ER_USER_LIMIT_REACHED" }) });

/** The public reads that log their failures, and the operator read that does, with the data function each one calls. */
async function caller(failure: () => Error) {
  const reject = async () => {
    throw failure();
  };
  vi.doMock("./db", async importOriginal => {
    const actual = await importOriginal<typeof import("./db")>();
    return {
      ...actual,
      listIngestionSources: reject,
      getOrCreateIngestionWorkerConfig: reject,
      readAgentDirectoryActivityTotals: reject,
      readAgentDirectoryActivityFeed: reject,
      readAgentDirectoryActivityDaySeries: reject,
      readSolanaActivityFeed: reject,
      readSolanaActivityTotals: reject,
    };
  });
  vi.doMock("./agentRegistryRows", async importOriginal => ({ ...(await importOriginal<typeof import("./agentRegistryRows")>()), readBscRegistryProfile: reject }));
  vi.doMock("./operatorAuth", async importOriginal => ({ ...(await importOriginal<typeof import("./operatorAuth")>()), getAuthenticatedOperator: async () => OPERATOR }));
  const { appRouter } = await import("./routers");
  return appRouter.createCaller({ user: OPERATOR, req: { protocol: "https", headers: {} }, res: {} } as unknown as TrpcContext);
}

describe("a pause is logged once by the breaker, not by every read it fails", { timeout: 60_000 }, () => {
  const reads: Array<[string, (trpc: Awaited<ReturnType<typeof caller>>) => Promise<unknown>, "warn" | "error"]> = [
    ["the availability check", trpc => trpc.liveData.availability(), "warn"],
    ["the BNB Chain registry profile", trpc => trpc.liveData.directoryBscRegistry(), "warn"],
    ["the activity feed", trpc => trpc.liveData.directoryActivityFeed(), "warn"],
    ["the Solana activity feed", trpc => trpc.liveData.directorySolanaActivity(), "warn"],
    ["the operator's worker status", trpc => trpc.liveData.admin.workerStatus().catch(() => null), "error"],
  ];

  it.each(reads)("says nothing for %s while connections are paused", async (_name, read) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const trpc = await caller(paused);
    await read(trpc);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
  });

  it.each(reads)("still logs a refusal that did not come from the breaker for %s", async (_name, read, level) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const trpc = await caller(refused);
    await read(trpc);
    const log = level === "warn" ? warn : vi.mocked(console.error);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]!.join(" "))).toContain("ER_USER_LIMIT_REACHED");
  });
});

describe("a search that is declined as busy", { timeout: 60_000 }, () => {
  it("is one that found the queue full, waited too long for a connection, or was stopped by MySQL; nothing else", async () => {
    const { isSearchOverload } = await import("./db");
    const failing = (properties: Record<string, unknown>) => Object.assign(new Error("x"), properties);
    expect(isSearchOverload(new Error("Queue limit reached."))).toBe(true);
    expect(isSearchOverload(failing({ code: "POOL_ENQUEUELIMIT" }))).toBe(true);
    expect(isSearchOverload(failing({ code: "POOL_ACQUIRE_TIMEOUT" }))).toBe(true);
    expect(isSearchOverload(failing({ code: "ER_QUERY_TIMEOUT" }))).toBe(true);
    expect(isSearchOverload(failing({ errno: 3024 }))).toBe(true);
    expect(isSearchOverload(failing({ errno: 1969 }))).toBe(true);
    // Wrapped by the query builder.
    expect(isSearchOverload(new Error("Failed query", { cause: failing({ code: "POOL_ACQUIRE_TIMEOUT" }) }))).toBe(true);
    for (const code of ["ER_USER_LIMIT_REACHED", "DB_CIRCUIT_OPEN", "ER_PARSE_ERROR", "ECONNREFUSED"]) {
      expect(isSearchOverload(failing({ code })), code).toBe(false);
    }
    expect(isSearchOverload(new Error("plain"))).toBe(false);
    expect(isSearchOverload(undefined)).toBe(false);
  });
});
