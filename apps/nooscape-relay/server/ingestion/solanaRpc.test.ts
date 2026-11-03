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
 * The body is read as a stream and cut off at 16 MiB of bytes. It used to be `response.text()` followed by a length check, so a provider
 * that sent no length and went on sending was held in memory to the end before anything was refused, and the check counted characters
 * (outside review of 2 November 2026, L1).
 */
describe("the response body cap", () => {
  const CAP = 16 * 1024 * 1024;
  const json = { "content-type": "application/json" };
  const TOO_LARGE = "Solana getVersion response exceeds the 16 MiB response limit.";
  /** A JSON object of exactly `bytes` ASCII bytes: 11 characters before the filler and 2 after. */
  const objectOf = (bytes: number) => `{"result":"${"a".repeat(bytes - 13)}"}`;
  const serves = (body: BodyInit | null, headers: Record<string, string> = json) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers })));
  const call = () => callSolanaRpc("getVersion", [], { rpcUrl: "https://rpc.example" });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("accepts a body of exactly 16 MiB and refuses one byte more", async () => {
    serves(objectOf(CAP));
    expect(((await call()) as { result: string }).result).toHaveLength(CAP - 13);

    serves(objectOf(CAP + 1));
    await expect(call()).rejects.toThrow(TOO_LARGE);
    await expect(call()).rejects.toBeInstanceOf(SolanaRpcValidationError);
  });

  it("counts bytes and not characters", async () => {
    // 6,000,000 characters of 3 bytes each: 18,000,000 bytes, under the cap as a character count.
    serves(`{"result":"${"€".repeat(6_000_000)}"}`);
    await expect(call()).rejects.toThrow(TOO_LARGE);
  });

  it("stops reading a body that runs on past the cap, and cancels it", async () => {
    let pulled = 0;
    let cancelled = false;
    // 64 MiB in 1 MiB chunks, with no length: finite so that a regression to reading it whole fails this test and does not fill the memory.
    const long = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) controller.close();
        else controller.enqueue(new Uint8Array(1024 * 1024).fill(97));
      },
      cancel() {
        cancelled = true;
      },
    });
    serves(long);

    await expect(call()).rejects.toThrow(TOO_LARGE);

    expect(cancelled).toBe(true);
    // 17 MiB passes the cap; the stream may be one chunk ahead of the reader. It is not read on.
    expect(pulled).toBeLessThanOrEqual(19);
  });

  it("refuses a declared length over the cap without reading the body", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(10));
      },
    });
    serves(body, { ...json, "content-length": String(CAP + 1) });

    await expect(call()).rejects.toThrow(TOO_LARGE);

    // A stream asks for its first chunk when it is made; the reader never asks for more.
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("keeps the request timer armed while a streamed body stalls", async () => {
    // The stream errors when the request's abort signal fires, as the platform's does: a body that stops mid-stream times out like a slow header.
    const fetchMock = vi.fn(
      async (_url: unknown, init: { signal: AbortSignal }) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal.addEventListener("abort", () => controller.error(new DOMException("The operation was aborted", "AbortError")));
            },
          }),
          { status: 200, headers: json }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const verdict = call().then(
      () => {
        throw new Error("expected the stalled body to time out");
      },
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect((await verdict as Error).message).toBe("Solana getVersion request timed out.");
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
