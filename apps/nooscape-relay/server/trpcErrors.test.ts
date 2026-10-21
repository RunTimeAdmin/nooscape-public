import { readFileSync } from "node:fs";
import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logUnexpectedTrpcError, publicProcedure, router, UNEXPECTED_ERROR_MESSAGE } from "./_core/trpc";

/**
 * What a caller learns from a failed call, and what the server keeps. A driver
 * error is the SQL statement with its parameter values; the lockout of
 * 2026-10-14 put the operator account's name and the table layout in front of
 * whoever made the call, and logged nothing. Deliberate TRPCErrors choose their
 * own messages and are untouched.
 */
const DRIVER_MESSAGE = "Failed query: select `id`, `openId` from `users` where `users`.`openId` = ? limit ?\nparams: nooscape-production-operator,1";

function driverFailure() {
  const mysql = Object.assign(new Error("User 'dbuser' has exceeded the 'max_connections_per_hour' resource (current value: 500)"), {
    code: "ER_USER_LIMIT_REACHED",
  });
  return new Error(DRIVER_MESSAGE, { cause: mysql });
}

/** What a request sees while the connection breaker has paused new connections: the driver's wrapper around the breaker's own error. */
function pausedFailure() {
  const open = Object.assign(new Error("New database connections are paused because the host is refusing them."), { code: "DB_CIRCUIT_OPEN" });
  return new Error(DRIVER_MESSAGE, { cause: open });
}

const testRouter = router({
  driver: publicProcedure.query(() => {
    throw driverFailure();
  }),
  paused: publicProcedure.query(() => {
    throw pausedFailure();
  }),
  bug: publicProcedure.query(() => {
    throw new Error("Cannot read properties of undefined (reading 'secretField')");
  }),
  refused: publicProcedure.query(() => {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Live data is temporarily unavailable." });
  }),
  missing: publicProcedure.query(() => {
    throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found." });
  }),
  unauthorized: publicProcedure.query(() => {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Production operator authentication is required." });
  }),
});

async function call(path: string) {
  const response = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req: new Request(`http://localhost/api/trpc/${path}`),
    router: testRouter,
    createContext: async () => ({}) as never,
    onError: logUnexpectedTrpcError,
  });
  const text = await response.text();
  const error = (JSON.parse(text) as { error: { json: { message: string; data: Record<string, unknown> } } }).error.json;
  return { status: response.status, text, error };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an unexpected exception", () => {
  it("answers the caller with a fixed message: no statement, no parameter values, no stack", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, text, error } = await call("driver");
    expect(status).toBe(500);
    expect(error.message).toBe(UNEXPECTED_ERROR_MESSAGE);
    // superjson carries an undefined field as null.
    expect(error.data.stack ?? null).toBeNull();
    // A stack would name this file.
    for (const leaked of ["select", "users", "params", "nooscape-production-operator", "ER_USER_LIMIT_REACHED", "max_connections_per_hour", "trpcErrors.test"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("does the same for a plain bug", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { error, text } = await call("bug");
    expect(error.message).toBe(UNEXPECTED_ERROR_MESSAGE);
    expect(text).not.toContain("secretField");
  });

  it("is logged with its path, the statement, and the cause's error code, but not the parameter values", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await call("driver");
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain("[tRPC] unexpected error on driver");
    expect(line).toContain("Failed query: select");
    expect(line).toContain("(ER_USER_LIMIT_REACHED)");
    expect(line).toContain("max_connections_per_hour");
    expect(line).not.toContain("params");
    expect(line).not.toContain("nooscape-production-operator");
  });

  it("is logged without repeating the statement it wraps", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await call("driver");
    const line = String(log.mock.calls[0]![0]);
    expect(line.split("Failed query").length - 1).toBe(1);
  });

  it("is not logged request by request while the breaker has paused new connections, and still answers with the fixed message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, error } = await call("paused");
    expect(status).toBe(500);
    expect(error.message).toBe(UNEXPECTED_ERROR_MESSAGE);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("a deliberate TRPCError", () => {
  it.each([
    ["refused", 412, "Live data is temporarily unavailable."],
    ["missing", 404, "Agent not found."],
    ["unauthorized", 401, "Production operator authentication is required."],
  ])("keeps its own message and is not logged (%s)", async (path, status, message) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await call(path);
    expect(result.status).toBe(status);
    expect(result.error.message).toBe(message);
    expect(log).not.toHaveBeenCalled();
  });

  it("still answers an unknown procedure with a bare not-found that echoes no path", async () => {
    const { status, error } = await call("noSuchProcedure");
    expect(status).toBe(404);
    expect(error.message).toBe("Not found.");
    expect(error.data.path ?? null).toBeNull();
  });
});

describe("the server wires the logger in", () => {
  it("passes it to the tRPC middleware", () => {
    const source = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/createExpressMiddleware\(\{[^}]*onError: logUnexpectedTrpcError/s);
  });
});
