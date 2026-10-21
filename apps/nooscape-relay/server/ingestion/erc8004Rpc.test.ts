import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BSC_CHAIN } from "./erc8004Chains";
import { Erc8004RpcError, Erc8004RpcHttpError, Erc8004RpcNotConfiguredError, Erc8004RpcRangeError, callRpc, resolveRpcUrl, scrubProviderText } from "./erc8004Rpc";
import { DEMO_CHAIN } from "./erc8004TestChain";

/**
 * The RPC client of the identity pass, run on a chain that is not BNB Chain. The BNB tests (bscRpc.test.ts) hold BNB Chain's
 * client exactly; these show the client reads the chain it is given: its endpoint variable and host, its retry ladder, response
 * cap and timeout, and its name in every message and error. The rule under test is the one the BNB tests hold too: no error this
 * module can produce contains the provider key, whatever failed.
 */
const KEY = "K3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3y";
const URL_WITH_KEY = `https://demo-mainnet.example/v1/${KEY}`;

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

describe("resolveRpcUrl", () => {
  it("refuses to run when the variable is unset, naming this chain's variable and this chain", () => {
    const error = (() => {
      try {
        resolveRpcUrl(DEMO_CHAIN, undefined, "");
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected a refusal");
    })();
    expect(error).toBeInstanceOf(Erc8004RpcNotConfiguredError);
    expect(error.message).toBe("DEMO_RPC_URL is not configured, so the Demo Chain identity pass cannot run.");
    expect(error.name).toBe("DemoRpcNotConfiguredError");
  });

  it("accepts this chain's host over https and returns the value untouched, whatever the case of the host", () => {
    expect(resolveRpcUrl(DEMO_CHAIN, undefined, URL_WITH_KEY)).toBe(URL_WITH_KEY);
    expect(resolveRpcUrl(DEMO_CHAIN, undefined, URL_WITH_KEY.replace("demo-mainnet", "DEMO-Mainnet"))).toContain("DEMO-Mainnet");
  });

  it("takes the host to compare against from the source row when one is passed, and from the chain's entry otherwise", () => {
    expect(resolveRpcUrl(DEMO_CHAIN, "other-host.example", "https://other-host.example/v1/x")).toBe("https://other-host.example/v1/x");
    expect(() => resolveRpcUrl(DEMO_CHAIN, undefined, "https://other-host.example/v1/x")).toThrow(Erc8004RpcNotConfiguredError);
  });

  const bad: Array<[string, string]> = [
    ["a bare key that is not a URL", KEY],
    ["a value that fails URL parsing", `not a url ${KEY}`],
    ["plain http", URL_WITH_KEY.replace("https:", "http:")],
    ["userinfo in the URL", `https://user:${KEY}@demo-mainnet.example/v1/x`],
    ["BNB Chain's host, which is another chain's", `https://bsc-mainnet.nodereal.io/v1/${KEY}`],
    ["a look-alike host", `https://demo-mainnet.example.evil.example/v1/${KEY}`],
  ];
  for (const [label, value] of bad) {
    it(`rejects ${label}, and the message never echoes the value`, () => {
      const error = (() => {
        try {
          resolveRpcUrl(DEMO_CHAIN, undefined, value);
        } catch (caught) {
          return caught as Error;
        }
        throw new Error("expected a rejection");
      })();
      expect(error).toBeInstanceOf(Erc8004RpcNotConfiguredError);
      expect(error.message).toMatch(/^DEMO_RPC_URL /);
      expect(error.message).not.toContain(KEY);
    });
  }

  it("reads the value from the chain's own reader when none is passed", () => {
    const reading = { ...DEMO_CHAIN, readRpcUrl: () => URL_WITH_KEY };
    expect(resolveRpcUrl(reading)).toBe(URL_WITH_KEY);
    // BNB Chain's reader answers BNB Chain's variable, which is not set under test, and is not asked about the demo chain.
    expect(() => resolveRpcUrl({ ...BSC_CHAIN, readRpcUrl: () => "" })).toThrow(/BSC_RPC_URL is not configured/);
  });
});

describe("callRpc on the chain", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("posts to the configured URL without following redirects, and returns the result", async () => {
    fetchMock.mockResolvedValue(json({ jsonrpc: "2.0", id: 1, result: "0x1e61" }));
    expect(await callRpc(DEMO_CHAIN, "eth_chainId", [], { url: URL_WITH_KEY })).toBe("0x1e61");
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(URL_WITH_KEY);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
  });

  it("retries only the statuses the chain's policy names, on the chain's own ladder, and counts every wire attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(json({ result: "0x1" }));
    const sleeps: number[] = [];
    let attempts = 0;
    const result = await callRpc(DEMO_CHAIN, "eth_blockNumber", [], {
      url: URL_WITH_KEY,
      countAttempt: () => (attempts += 1),
      sleep: async ms => {
        sleeps.push(ms);
      },
    });
    expect(result).toBe("0x1");
    expect(attempts).toBe(4);
    expect(sleeps).toEqual([10, 20, 40]);
  });

  it("does not retry a status the policy leaves out, though BNB Chain's would retry it", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    const error = await thrown(callRpc(DEMO_CHAIN, "eth_getLogs", [], { url: URL_WITH_KEY, sleep: noSleep }));
    expect(error).toBeInstanceOf(Erc8004RpcHttpError);
    expect((error as Erc8004RpcHttpError).status).toBe(503);
    expect(error.message).toBe("Demo Chain eth_getLogs returned HTTP 503.");
    expect(error.name).toBe("DemoRpcHttpError");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    await thrown(callRpc(BSC_CHAIN, "eth_getLogs", [], { url: "https://bsc-mainnet.nodereal.io/v1/x", sleep: noSleep }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after the last wait with a status-only message", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 429 }));
    const error = await thrown(callRpc(DEMO_CHAIN, "eth_getLogs", [], { url: URL_WITH_KEY, sleep: noSleep }));
    expect((error as Erc8004RpcHttpError).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("classifies a range rejection and a result-size rejection in the chain's words, without echoing provider text", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: -32602, message: "exceed maximum block range: 10000" } }));
    const range = await thrown(callRpc(DEMO_CHAIN, "eth_getLogs", [], { url: URL_WITH_KEY }));
    expect(range).toBeInstanceOf(Erc8004RpcRangeError);
    expect((range as Erc8004RpcRangeError).reason).toBe("block_range");
    expect(range.message).toBe("Demo Chain eth_getLogs was rejected as exceeding the provider's block range.");
    expect(range.name).toBe("DemoRpcRangeError");

    fetchMock.mockResolvedValueOnce(json({ error: { code: -32005, message: "query returned more than 10000 results" } }));
    const size = await thrown(callRpc(DEMO_CHAIN, "eth_getLogs", [], { url: URL_WITH_KEY }));
    expect((size as Erc8004RpcRangeError).reason).toBe("result_size");
  });

  it("scrubs token-like text out of any other provider error before surfacing it", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: -32000, message: `invalid api key ${KEY} for account` } }));
    const error = await thrown(callRpc(DEMO_CHAIN, "eth_getLogs", [], { url: URL_WITH_KEY }));
    expect(error).toBeInstanceOf(Erc8004RpcError);
    expect(error.message).toContain("<redacted>");
    expect(error.message).not.toContain(KEY);
    expect(scrubProviderText("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });

  it("never lets the key out through a network failure, even when the underlying error carries it", async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed for ${URL_WITH_KEY}`));
    const error = await thrown(callRpc(DEMO_CHAIN, "eth_blockNumber", [], { url: URL_WITH_KEY }));
    expect(error.message).toBe("Demo Chain eth_blockNumber request failed.");
    expect(error.name).toBe("DemoRpcError");
    expect(error.message).not.toContain(KEY);
    expect(String((error as { cause?: unknown }).cause ?? "")).not.toContain(KEY);
  });

  it("times out at the chain's own limit, under the armed timer", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const pending = thrown(callRpc(DEMO_CHAIN, "eth_getLogs", [], { url: URL_WITH_KEY }));
    // 5 s on this chain, where BNB Chain's is 30 s.
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).message).toBe("Demo Chain eth_getLogs request timed out.");
  });

  it("refuses a response over the chain's own cap, by declared length and by actual length", async () => {
    const cap = DEMO_CHAIN.rpc.maxResponseBytes;
    fetchMock.mockResolvedValueOnce(json({ result: [] }, { headers: { "content-length": String(cap + 1) } }));
    const declared = await thrown(callRpc(DEMO_CHAIN, "eth_getLogs", [], { url: URL_WITH_KEY }));
    expect(declared).toBeInstanceOf(Erc8004RpcRangeError);
    expect((declared as Erc8004RpcRangeError).reason).toBe("result_size");
    fetchMock.mockResolvedValueOnce(new Response(`{"result":"${"a".repeat(cap)}"}`, { status: 200 }));
    expect(await thrown(callRpc(DEMO_CHAIN, "eth_getLogs", [], { url: URL_WITH_KEY }))).toBeInstanceOf(Erc8004RpcRangeError);
  });

  it("refuses malformed responses instead of trusting them, in the chain's words", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>nope</html>", { status: 200 }));
    expect((await thrown(callRpc(DEMO_CHAIN, "eth_blockNumber", [], { url: URL_WITH_KEY }))).message).toBe("Demo Chain eth_blockNumber response was not valid JSON.");
    fetchMock.mockResolvedValueOnce(json("just a string"));
    expect((await thrown(callRpc(DEMO_CHAIN, "eth_blockNumber", [], { url: URL_WITH_KEY }))).message).toBe("Demo Chain eth_blockNumber response is not a JSON-RPC object.");
    fetchMock.mockResolvedValueOnce(json({ jsonrpc: "2.0", id: 1 }));
    expect((await thrown(callRpc(DEMO_CHAIN, "eth_blockNumber", [], { url: URL_WITH_KEY }))).message).toBe("Demo Chain eth_blockNumber response carries no result.");
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
      fetchMock.mockResolvedValue(new Response("", { status: 429 }));
      arm();
      const error = await thrown(callRpc(DEMO_CHAIN, "eth_getLogs", [], { url: URL_WITH_KEY, sleep: noSleep }));
      expect(error.message).not.toContain(KEY);
    }
  });
});
