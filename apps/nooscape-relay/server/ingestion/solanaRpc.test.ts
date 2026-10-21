import { afterEach, describe, expect, it, vi } from "vitest";
import { callSolanaRpc, getTransactionParams, parseTransactionResult, SOLANA_MAX_TRANSACTION_VERSION, SolanaRpcValidationError } from "./solanaRpc";

/**
 * The request timer must stay armed through the response-body read, not just
 * the header phase: a server that sends headers and then goes quiet would
 * otherwise park a scheduled run forever. These tests pin the shared RPC
 * client's contract; every per-adapter fetch follows the same shape.
 */
describe("callSolanaRpc", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns the parsed JSON-RPC envelope on a healthy call", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { slot: 42 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await callSolanaRpc("getVersion", [], { rpcUrl: "https://rpc.example" });

    expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: { slot: 42 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled response body under the armed request timer", async () => {
    // Headers arrive instantly; the body never does. The read only rejects
    // when the request's abort signal fires — the exact stall this guards
    // (a cleared-after-headers timer would leave the call parked forever).
    const fetchMock = vi.fn(async (_url: unknown, init: { signal: AbortSignal }) => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    // Fake only the timer primitives: stream and promise plumbing stays real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const call = callSolanaRpc("getVersion", [], { rpcUrl: "https://rpc.example" });
    // Handle the rejection the moment it fires: the verdict lands during the
    // timer advance, and a promise rejected before its handler attaches
    // surfaces as an unhandled rejection.
    const verdict = call.then(
      () => {
        throw new Error("expected the stalled body to time out");
      },
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(30_000);

    const error = await verdict;
    expect(error).toBeInstanceOf(SolanaRpcValidationError);
    expect((error as Error).message).toBe("Solana getVersion request timed out.");
    // A timeout verdict is not a transient HTTP error: no retry ladder.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Solana mainnet carries version 1 transactions (about one in six in a block sampled on 2026-10-16). A getTransaction that
 * names version 0 as the newest it supports is answered with error -32015 for each of them, and that error used to fail the
 * whole 8004 pass. The real answer of api.mainnet-beta.solana.com is the fixture.
 */
describe("getTransaction and transaction versions", () => {
  const UNSUPPORTED = {
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32015,
      message: 'Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1',
    },
  };

  it("asks for transactions up to version 1", () => {
    expect(SOLANA_MAX_TRANSACTION_VERSION).toBe(1);
    expect(getTransactionParams("sig")).toEqual(["sig", { encoding: "json", maxSupportedTransactionVersion: 1 }]);
  });

  it("reads a transaction this client cannot read as no transaction, the way a pruned one is", () => {
    expect(parseTransactionResult(UNSUPPORTED)).toBeNull();
  });

  it("returns a transaction, and null for a missing one", () => {
    const transaction = { meta: { logMessages: ["Program log: x"] } };
    expect(parseTransactionResult({ jsonrpc: "2.0", id: 1, result: transaction } as never)).toEqual(transaction);
    expect(parseTransactionResult({ jsonrpc: "2.0", id: 1, result: null } as never)).toBeNull();
  });

  it("still fails loudly on any other RPC error or a malformed answer", () => {
    expect(() => parseTransactionResult({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Node is behind by 5 slots" } } as never)).toThrow(SolanaRpcValidationError);
    expect(() => parseTransactionResult({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } } as never)).toThrow(/failed at the RPC layer: Invalid params/);
    expect(() => parseTransactionResult({ jsonrpc: "2.0", id: 1 } as never)).toThrow(SolanaRpcValidationError);
    expect(() => parseTransactionResult(null as never)).toThrow(SolanaRpcValidationError);
  });
});
