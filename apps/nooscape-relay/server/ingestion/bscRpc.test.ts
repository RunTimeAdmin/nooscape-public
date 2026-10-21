import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BSC_MAX_RESPONSE_BYTES,
  BscRpcError,
  BscRpcHttpError,
  BscRpcNotConfiguredError,
  BscRpcRangeError,
  callBscRpc,
  resolveBscRpcUrl,
  scrubProviderText,
} from "./bscRpc";

/**
 * The BNB Chain RPC client. The endpoint URL carries the provider key, so the
 * property under test is that no error this module can produce contains it,
 * whether the failure is a network error, an HTTP status, a provider message,
 * a malformed value in the environment, or a timeout. Every test plants a
 * recognizable key and checks the thrown message for it.
 */
const KEY = "K3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3y";
const URL_WITH_KEY = `https://bsc-mainnet.nodereal.io/v1/${KEY}`;

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const noSleep = async () => {};

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("resolveBscRpcUrl", () => {
  it("refuses to run when the variable is unset, with a message that names the variable", () => {
    expect(() => resolveBscRpcUrl(undefined, "")).toThrow(BscRpcNotConfiguredError);
    expect(() => resolveBscRpcUrl(undefined, "")).toThrow(/BSC_RPC_URL is not configured/);
  });

  it("accepts the approved host over https and returns the value untouched", () => {
    expect(resolveBscRpcUrl(undefined, URL_WITH_KEY)).toBe(URL_WITH_KEY);
    expect(resolveBscRpcUrl(undefined, URL_WITH_KEY.replace("bsc-mainnet", "BSC-Mainnet"))).toContain("BSC-Mainnet");
  });

  const bad: Array<[string, string]> = [
    ["a bare key that is not a URL", KEY],
    ["a value that fails URL parsing", `not a url ${KEY}`],
    ["plain http", URL_WITH_KEY.replace("https:", "http:")],
    ["userinfo in the URL", `https://user:${KEY}@bsc-mainnet.nodereal.io/v1/x`],
    ["a different host", `https://evil.example.com/v1/${KEY}`],
    ["a look-alike host", `https://bsc-mainnet.nodereal.io.evil.example/v1/${KEY}`],
  ];
  for (const [label, value] of bad) {
    it(`rejects ${label}, and the message never echoes the value`, () => {
      const error = (() => {
        try {
          resolveBscRpcUrl(undefined, value);
        } catch (caught) {
          return caught as Error;
        }
        throw new Error("expected a rejection");
      })();
      expect(error).toBeInstanceOf(BscRpcNotConfiguredError);
      expect(error.message).not.toContain(KEY);
    });
  }
});

describe("callBscRpc", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("posts a JSON-RPC request to the configured URL without following redirects, and returns the result", async () => {
    fetchMock.mockResolvedValue(json({ jsonrpc: "2.0", id: 1, result: "0x38" }));
    const result = await callBscRpc("eth_chainId", [], { url: URL_WITH_KEY });
    expect(result).toBe("0x38");
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(URL_WITH_KEY);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  });

  it("retries transient HTTP statuses on a short ladder and counts every wire attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(json({ result: "0x1" }));
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await callBscRpc("eth_blockNumber", [], {
      url: URL_WITH_KEY,
      countAttempt: () => (attempts += 1),
      sleep: async ms => {
        sleeps.push(ms);
      },
    });
    expect(result).toBe("0x1");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([1_000, 3_000]);
  });

  it("gives up after the ladder with a status-only message", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    const error = await thrown(callBscRpc("eth_getLogs", [], { url: URL_WITH_KEY, sleep: noSleep }));
    expect(error).toBeInstanceOf(BscRpcHttpError);
    expect((error as BscRpcHttpError).status).toBe(503);
    expect(error.message).toBe("BNB Chain eth_getLogs returned HTTP 503.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a status that will not clear on its own", async () => {
    for (const status of [400, 401, 403, 404]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => new Response("", { status }));
      const error = await thrown(callBscRpc("eth_getLogs", [], { url: URL_WITH_KEY, sleep: noSleep }));
      expect((error as BscRpcHttpError).status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("classifies a block-range rejection and a result-size rejection, without echoing provider text", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: -32602, message: "exceed maximum block range: 50000" } }));
    const range = await thrown(callBscRpc("eth_getLogs", [], { url: URL_WITH_KEY }));
    expect(range).toBeInstanceOf(BscRpcRangeError);
    expect((range as BscRpcRangeError).reason).toBe("block_range");

    fetchMock.mockResolvedValueOnce(json({ error: { code: -32005, message: "query returned more than 10000 results" } }));
    const size = await thrown(callBscRpc("eth_getLogs", [], { url: URL_WITH_KEY }));
    expect(size).toBeInstanceOf(BscRpcRangeError);
    expect((size as BscRpcRangeError).reason).toBe("result_size");
  });

  it("scrubs token-like text out of any other provider error before surfacing it", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: -32000, message: `invalid api key ${KEY} for account` } }));
    const error = await thrown(callBscRpc("eth_getLogs", [], { url: URL_WITH_KEY }));
    expect(error).toBeInstanceOf(BscRpcError);
    expect(error.message).toContain("<redacted>");
    expect(error.message).not.toContain(KEY);
    expect(scrubProviderText(`${"x".repeat(500)}`).length).toBeLessThanOrEqual(200);
  });

  it("never lets the key out through a network failure, even when the underlying error carries it", async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed for ${URL_WITH_KEY}`));
    const error = await thrown(callBscRpc("eth_blockNumber", [], { url: URL_WITH_KEY }));
    expect(error).toBeInstanceOf(BscRpcError);
    expect(error.message).toBe("BNB Chain eth_blockNumber request failed.");
    expect(error.message).not.toContain(KEY);
    expect(String((error as { cause?: unknown }).cause ?? "")).not.toContain(KEY);
  });

  it("times out a request that never answers, under the armed timer", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const pending = thrown(callBscRpc("eth_getLogs", [], { url: URL_WITH_KEY }));
    await vi.advanceTimersByTimeAsync(30_001);
    const error = await pending;
    expect(error.message).toBe("BNB Chain eth_getLogs request timed out.");
  });

  it("refuses malformed responses instead of trusting them", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>nope</html>", { status: 200 }));
    expect((await thrown(callBscRpc("eth_blockNumber", [], { url: URL_WITH_KEY }))).message).toMatch(/not valid JSON/);
    fetchMock.mockResolvedValueOnce(json("just a string"));
    expect((await thrown(callBscRpc("eth_blockNumber", [], { url: URL_WITH_KEY }))).message).toMatch(/not a JSON-RPC object/);
    fetchMock.mockResolvedValueOnce(json({ jsonrpc: "2.0", id: 1 }));
    expect((await thrown(callBscRpc("eth_blockNumber", [], { url: URL_WITH_KEY }))).message).toMatch(/carries no result/);
  });

  it("refuses a response over the size cap, by declared length and by actual length", async () => {
    fetchMock.mockResolvedValueOnce(json({ result: [] }, { headers: { "content-length": String(BSC_MAX_RESPONSE_BYTES + 1) } }));
    const declared = await thrown(callBscRpc("eth_getLogs", [], { url: URL_WITH_KEY }));
    expect(declared).toBeInstanceOf(BscRpcRangeError);
    expect((declared as BscRpcRangeError).reason).toBe("result_size");

    fetchMock.mockResolvedValueOnce(new Response(`{"result":"${"a".repeat(BSC_MAX_RESPONSE_BYTES)}"}`, { status: 200 }));
    const actual = await thrown(callBscRpc("eth_getLogs", [], { url: URL_WITH_KEY }));
    expect(actual).toBeInstanceOf(BscRpcRangeError);
  });

  it("keeps the key out of every error message it can produce", async () => {
    const attempts: Array<() => void> = [
      () => fetchMock.mockResolvedValueOnce(new Response("", { status: 500 })),
      () => fetchMock.mockResolvedValueOnce(json({ error: { message: `bad ${KEY}` } })),
      () => fetchMock.mockRejectedValueOnce(new Error(KEY)),
      () => fetchMock.mockResolvedValueOnce(new Response(KEY, { status: 200 })),
    ];
    for (const arm of attempts) {
      fetchMock.mockReset();
      arm();
      // A 500 is transient and retried; keep the ladder from sleeping for real.
      fetchMock.mockResolvedValue(new Response("", { status: 500 }));
      arm();
      const error = await thrown(callBscRpc("eth_getLogs", [], { url: URL_WITH_KEY, sleep: noSleep }));
      expect(error.message).not.toContain(KEY);
    }
  });
});
