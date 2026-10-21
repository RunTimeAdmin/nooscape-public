import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARC_CHAIN, BASE_CHAIN, BSC_CHAIN, ETHEREUM_CHAIN } from "./erc8004Chains";
import {
  Erc8004RpcBusyError,
  Erc8004RpcError,
  Erc8004RpcHttpError,
  Erc8004RpcNotConfiguredError,
  Erc8004RpcRangeError,
  Erc8004RpcTimeoutError,
  callRpc,
  createPacer,
  providerPolicy,
  resolveRpcUrl,
  scrubProviderText,
} from "./erc8004Rpc";
import { DEMO_CHAIN } from "./erc8004TestChain";

/**
 * What the shared RPC client gained for the chains added after BNB Chain: a provider whose host is the operator's (Arc), a pause
 * between calls, waits with jitter, a retry for a timeout or a busy node, and the reading of a refusal's explanation (Base). Each
 * is switched on by a field of the chain's policy and is off for BNB Chain, so the tests also show BNB Chain still behaves as it
 * always has. Every endpoint here is made up, and the rule under test is the old one: no error carries any part of it.
 */
const KEY = "K3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3y";
const ARC_URL = `https://arc-node.example/v1/${KEY}`;
const BASE_URL = `https://base-mainnet.g.alchemy.com/v2/${KEY}`;

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("a provider that is the operator's own (Arc)", () => {
  it("reads the endpoint from X402_RPC and nowhere else", () => {
    vi.stubEnv("X402_RPC", ARC_URL);
    expect(ARC_CHAIN.readRpcUrl()).toBe(ARC_URL);
    vi.stubEnv("X402_RPC", "");
    expect(ARC_CHAIN.readRpcUrl()).toBe("");
    vi.stubEnv("X402_RPC", "http://not-https.example/v1/x");
    expect(ARC_CHAIN.readRpcUrl()).toBe("");
  });

  it("takes the host to compare against from the source row, which the operator staged", () => {
    expect(resolveRpcUrl(ARC_CHAIN, "arc-node.example", ARC_URL)).toBe(ARC_URL);
    expect(resolveRpcUrl(ARC_CHAIN, "ARC-Node.Example", ARC_URL)).toBe(ARC_URL);
  });

  it("refuses an endpoint whose host is not the row's: changing the variable cannot move the pass to a host nobody staged", () => {
    const error = (() => {
      try {
        resolveRpcUrl(ARC_CHAIN, "staged-node.example", ARC_URL);
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected a refusal");
    })();
    expect(error).toBeInstanceOf(Erc8004RpcNotConfiguredError);
    expect(error.message).toBe("X402_RPC does not point at the approved Arc RPC host.");
    expect(error.name).toBe("ArcRpcNotConfiguredError");
  });

  it("has no host of its own to fall back on, and says so plainly when none is given", () => {
    expect(() => resolveRpcUrl(ARC_CHAIN, undefined, ARC_URL)).toThrow(/give the host its source row records/);
  });

  it("says the pass is not configured when X402_RPC is unset, naming the variable and never a value", () => {
    const error = (() => {
      try {
        resolveRpcUrl(ARC_CHAIN, "arc-node.example", "");
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("expected a refusal");
    })();
    expect(error.message).toBe("X402_RPC is not configured, so the Arc identity pass cannot run.");
  });

  const bad: Array<[string, string]> = [
    ["plain http", ARC_URL.replace("https:", "http:")],
    ["userinfo in the address", `https://user:${KEY}@arc-node.example/v1/x`],
    ["a value that is not an address", `not a url ${KEY}`],
    ["a different host", `https://other-node.example/v1/${KEY}`],
  ];
  for (const [label, value] of bad) {
    it(`refuses ${label}, and neither the host nor the key is in what it says`, () => {
      const error = (() => {
        try {
          resolveRpcUrl(ARC_CHAIN, "arc-node.example", value);
        } catch (caught) {
          return caught as Error;
        }
        throw new Error("expected a refusal");
      })();
      expect(error).toBeInstanceOf(Erc8004RpcNotConfiguredError);
      expect(error.message).toMatch(/^X402_RPC /);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("arc-node");
      expect(error.message).not.toContain("other-node");
    });
  }

  it("gives a source row the host alone: lower case, no port, path, query or key, and https as the origin", () => {
    expect(providerPolicy(ARC_CHAIN, "https://ARC-Node.Example:8443/v1/KEYVALUE?token=abc#frag")).toEqual({ rootUrl: "https://arc-node.example", allowedHostname: "arc-node.example" });
    expect(providerPolicy(ARC_CHAIN, ARC_URL)).toEqual({ rootUrl: "https://arc-node.example", allowedHostname: "arc-node.example" });
  });

  it("will not give a row a host from an endpoint that is unset, http, or carries credentials", () => {
    for (const value of ["", "http://arc-node.example", `https://user:${KEY}@arc-node.example`, "garbage"]) {
      expect(() => providerPolicy(ARC_CHAIN, value), value).toThrow(Erc8004RpcNotConfiguredError);
    }
  });

  it("reads the variable by default, so staging uses what the host is set to", () => {
    vi.stubEnv("X402_RPC", ARC_URL);
    expect(providerPolicy(ARC_CHAIN)).toEqual({ rootUrl: "https://arc-node.example", allowedHostname: "arc-node.example" });
    vi.stubEnv("X402_RPC", "");
    expect(() => providerPolicy(ARC_CHAIN)).toThrow(/X402_RPC is not configured/);
  });

  it("gives a pinned chain's row its own origin and host, whatever its variable holds", () => {
    expect(providerPolicy(BSC_CHAIN, "")).toEqual({ rootUrl: "https://bsc-mainnet.nodereal.io", allowedHostname: "bsc-mainnet.nodereal.io" });
    expect(providerPolicy(BASE_CHAIN, "anything")).toEqual({ rootUrl: "https://base-mainnet.g.alchemy.com", allowedHostname: "base-mainnet.g.alchemy.com" });
    expect(providerPolicy(ETHEREUM_CHAIN, "")).toEqual({ rootUrl: "https://eth-mainnet.nodereal.io", allowedHostname: "eth-mainnet.nodereal.io" });
  });

  it("never lets X402_RPC out through a failure of a call, whatever failed", async () => {
    const arms: Array<() => void> = [
      () => fetchMock.mockResolvedValueOnce(new Response("", { status: 500 })),
      () => fetchMock.mockResolvedValueOnce(json({ error: { message: `bad ${ARC_URL} ${KEY}` } })),
      () => fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${ARC_URL}`)),
      () => fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError")),
      () => fetchMock.mockResolvedValueOnce(new Response(ARC_URL, { status: 200 })),
    ];
    for (const arm of arms) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(new Response("", { status: 429 }));
      arm();
      const error = await thrown(callRpc(ARC_CHAIN, "eth_getLogs", [], { url: ARC_URL, sleep: async () => {}, random: () => 0 }));
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("arc-node");
      expect(String((error as { cause?: unknown }).cause ?? "")).not.toContain(KEY);
    }
  });
});

describe("the pause between calls", () => {
  it("lets the first call go at once, and spaces each later call from the end of the one before", async () => {
    let clock = 1_000;
    const waits: number[] = [];
    const pace = createPacer(250, {
      now: () => clock,
      sleep: async ms => {
        waits.push(ms);
        clock += ms;
      },
    });
    fetchMock.mockImplementation(async () => {
      clock += 40;
      return json({ result: "0x1" });
    });
    await callRpc(ARC_CHAIN, "eth_chainId", [], { url: ARC_URL, pace });
    expect(waits).toEqual([]);
    await callRpc(ARC_CHAIN, "eth_blockNumber", [], { url: ARC_URL, pace });
    expect(waits).toEqual([250]);
    // A call that comes later than the gap is not held.
    clock += 400;
    await callRpc(ARC_CHAIN, "eth_getLogs", [], { url: ARC_URL, pace });
    expect(waits).toEqual([250]);
  });

  it("holds a retry to the gap as well as to the wait before it", async () => {
    let clock = 0;
    const waits: number[] = [];
    const sleeps: number[] = [];
    const pace = createPacer(250, {
      now: () => clock,
      sleep: async ms => {
        waits.push(ms);
        clock += ms;
      },
    });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(json({ result: "0x1" }));
    await callRpc(ARC_CHAIN, "eth_getLogs", [], {
      url: ARC_URL,
      pace,
      random: () => 0,
      sleep: async ms => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    // The wait on the ladder is 1,000 ms, which is longer than the gap, so the gap adds nothing after it.
    expect(sleeps).toEqual([1_000]);
    expect(waits).toEqual([]);
  });

  it("asks nothing of a chain that sets no gap: it makes its calls back to back, as BNB Chain always has", async () => {
    fetchMock.mockImplementation(async () => json({ result: "0x1" }));
    for (let i = 0; i < 5; i += 1) await callRpc(BSC_CHAIN, "eth_blockNumber", [], { url: "https://bsc-mainnet.nodereal.io/v1/x" });
    expect(BSC_CHAIN.rpc.minGapMs).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe("the ladder on a node that is shared (Arc)", () => {
  it("retries a retried status on doubling waits and then stops, with the status in the last error", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 429 }));
    const sleeps: number[] = [];
    let attempts = 0;
    const error = await thrown(callRpc(ARC_CHAIN, "eth_getLogs", [], { url: ARC_URL, countAttempt: () => (attempts += 1), random: () => 0, sleep: async ms => void sleeps.push(ms) }));
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(attempts).toBe(4);
    expect(error).toBeInstanceOf(Erc8004RpcHttpError);
    expect((error as Erc8004RpcHttpError).status).toBe(429);
    expect(error.message).toBe("Arc eth_getLogs returned HTTP 429.");
    expect(error.name).toBe("ArcRpcHttpError");
  });

  it("adds a random share of each wait, up to a quarter, so a retry is not at the same moment every time", async () => {
    const run = async (random: () => number) => {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
      const sleeps: number[] = [];
      await thrown(callRpc(ARC_CHAIN, "eth_getLogs", [], { url: ARC_URL, random, sleep: async ms => void sleeps.push(ms) }));
      return sleeps;
    };
    expect(await run(() => 0)).toEqual([1_000, 2_000, 4_000]);
    expect(await run(() => 0.5)).toEqual([1_125, 2_250, 4_500]);
    expect(await run(() => 1)).toEqual([1_250, 2_500, 5_000]);
  });

  it("tries a request that timed out again, and succeeds when the node answers", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError")).mockResolvedValueOnce(json({ result: "0xabc" }));
    const sleeps: number[] = [];
    expect(await callRpc(ARC_CHAIN, "eth_blockNumber", [], { url: ARC_URL, random: () => 0, sleep: async ms => void sleeps.push(ms) })).toBe("0xabc");
    expect(sleeps).toEqual([1_000]);
  });

  it("gives up on a node that keeps timing out, with the timeout error in the chain's words", async () => {
    fetchMock.mockImplementation(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const error = await thrown(callRpc(ARC_CHAIN, "eth_getLogs", [], { url: ARC_URL, random: () => 0, sleep: async () => {} }));
    expect(error).toBeInstanceOf(Erc8004RpcTimeoutError);
    expect(error).toBeInstanceOf(Erc8004RpcError);
    expect(error.message).toBe("Arc eth_getLogs request timed out.");
    expect(error.name).toBe("ArcRpcError");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("tries again when the node says it is busy, by code or by its words, and not for any other answer", async () => {
    for (const busy of [{ code: -32005, message: "limit exceeded" }, { code: -32000, message: "server is busy, try again later" }, { code: -32603, message: "Too many requests" }]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(json({ error: busy })).mockResolvedValueOnce(json({ result: "0x1" }));
      expect(await callRpc(ARC_CHAIN, "eth_getLogs", [], { url: ARC_URL, random: () => 0, sleep: async () => {} }), busy.message).toBe("0x1");
    }
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(json({ error: { code: -32000, message: "header not found" } }));
    const error = await thrown(callRpc(ARC_CHAIN, "eth_getBlockByNumber", [], { url: ARC_URL, random: () => 0, sleep: async () => {} }));
    expect(error.message).toBe("Arc eth_getBlockByNumber failed at the RPC layer: header not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a busy node's answer, when the ladder runs out, as an RPC error with the usual name and words", async () => {
    fetchMock.mockImplementation(async () => json({ error: { code: -32005, message: "limit exceeded" } }));
    const error = await thrown(callRpc(ARC_CHAIN, "eth_getLogs", [], { url: ARC_URL, random: () => 0, sleep: async () => {} }));
    expect(error).toBeInstanceOf(Erc8004RpcBusyError);
    expect(error.message).toBe("Arc eth_getLogs failed at the RPC layer: limit exceeded");
    expect(error.name).toBe("ArcRpcError");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("a chain that does not ask for those retries goes without them, as BNB Chain always has", () => {
  it("does not try a timeout again on BNB Chain, Ethereum, Base or the demo chain", async () => {
    for (const [chain, url] of [
      [BSC_CHAIN, "https://bsc-mainnet.nodereal.io/v1/x"],
      [ETHEREUM_CHAIN, "https://eth-mainnet.nodereal.io/v1/x"],
      [BASE_CHAIN, BASE_URL],
      [DEMO_CHAIN, "https://demo-mainnet.example/v1/x"],
    ] as const) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => {
        throw new DOMException("aborted", "AbortError");
      });
      const error = await thrown(callRpc(chain, "eth_getLogs", [], { url, sleep: async () => {} }));
      expect(error, chain.protocol).toBeInstanceOf(Erc8004RpcTimeoutError);
      expect(fetchMock, chain.protocol).toHaveBeenCalledTimes(1);
    }
  });

  it("does not try a busy answer again on BNB Chain, Ethereum, Base or the demo chain", async () => {
    for (const [chain, url] of [
      [BSC_CHAIN, "https://bsc-mainnet.nodereal.io/v1/x"],
      [ETHEREUM_CHAIN, "https://eth-mainnet.nodereal.io/v1/x"],
      [BASE_CHAIN, BASE_URL],
      [DEMO_CHAIN, "https://demo-mainnet.example/v1/x"],
    ] as const) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => json({ error: { code: -32005, message: "limit exceeded" } }));
      await thrown(callRpc(chain, "eth_getLogs", [], { url, sleep: async () => {} }));
      expect(fetchMock, chain.protocol).toHaveBeenCalledTimes(1);
    }
  });

  it("waits the exact ladder, with no random share, on a chain that sets no jitter", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    const sleeps: number[] = [];
    await thrown(callRpc(BSC_CHAIN, "eth_getLogs", [], { url: "https://bsc-mainnet.nodereal.io/v1/x", random: () => 1, sleep: async ms => void sleeps.push(ms) }));
    expect(sleeps).toEqual([1_000, 3_000]);
  });
});

/** What Alchemy sent on 2026-10-20 when it refused a window, as it sent it: an HTTP 400 with the explanation in the body. */
const ALCHEMY_TOO_WIDE =
  "Log response size exceeded. You can make eth_getLogs requests with up to a 10,000 block range and no limit on the response size, or you can request any block range with a cap of 10K logs in the response. Based on your parameters and the response size limit, this block range should work: [0x27bbd27, 0x27ecc9b]";
/** The first sentence of what its Free plan sent for a window of more than 10 blocks (the rest named a range that would work). */
const ALCHEMY_FREE_PLAN = "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.";

const refusal = (message: string, status = 400) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message } }), { status });

describe("a refusal the provider explains in the body of an error status (Base)", () => {
  it("names a window that is too wide as a result-size rejection, so a narrower window can be tried", async () => {
    fetchMock.mockResolvedValueOnce(refusal(ALCHEMY_TOO_WIDE));
    const error = await thrown(callRpc(BASE_CHAIN, "eth_getLogs", [], { url: BASE_URL }));
    expect(error).toBeInstanceOf(Erc8004RpcRangeError);
    expect((error as Erc8004RpcRangeError).reason).toBe("result_size");
    expect(error.message).toBe("Base eth_getLogs was rejected as returning too many results.");
    expect(error.name).toBe("BaseRpcRangeError");
  });

  it("names a plan that is too small as a block-range rejection, which a window of any size cannot fix", async () => {
    fetchMock.mockResolvedValueOnce(refusal(ALCHEMY_FREE_PLAN));
    const error = await thrown(callRpc(BASE_CHAIN, "eth_getLogs", [], { url: BASE_URL }));
    expect(error).toBeInstanceOf(Erc8004RpcRangeError);
    expect((error as Erc8004RpcRangeError).reason).toBe("block_range");
    expect(error.message).toBe("Base eth_getLogs was rejected as exceeding the provider's block range.");
  });

  it("falls back to the status when the body explains nothing: not JSON, no error, or too large", async () => {
    for (const body of ["<html>bad request</html>", JSON.stringify({ jsonrpc: "2.0", id: 1 }), JSON.stringify({ error: null }), "a".repeat(BASE_CHAIN.rpc.maxResponseBytes + 1)]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 400 }));
      const error = await thrown(callRpc(BASE_CHAIN, "eth_getLogs", [], { url: BASE_URL }));
      expect(error).toBeInstanceOf(Erc8004RpcHttpError);
      expect(error.message).toBe("Base eth_getLogs returned HTTP 400.");
    }
  });

  it("still retries a retried status on its ladder, and does not read its body", async () => {
    fetchMock.mockResolvedValueOnce(refusal("rate limited", 429)).mockResolvedValueOnce(json({ result: "0x1" }));
    const sleeps: number[] = [];
    expect(await callRpc(BASE_CHAIN, "eth_getLogs", [], { url: BASE_URL, sleep: async ms => void sleeps.push(ms) })).toBe("0x1");
    expect(sleeps).toEqual([1_000]);
  });

  it("scrubs token-like text out of an explanation before surfacing it", async () => {
    fetchMock.mockResolvedValueOnce(refusal(`invalid key ${KEY} for this app`));
    const error = await thrown(callRpc(BASE_CHAIN, "eth_getLogs", [], { url: BASE_URL }));
    expect(error.message).toContain("<redacted>");
    expect(error.message).not.toContain(KEY);
  });

  it("is not done for a chain that does not ask: BNB Chain, Ethereum and the demo chain see only the status, as ever", async () => {
    for (const [chain, url] of [
      [BSC_CHAIN, "https://bsc-mainnet.nodereal.io/v1/x"],
      [ETHEREUM_CHAIN, "https://eth-mainnet.nodereal.io/v1/x"],
      [DEMO_CHAIN, "https://demo-mainnet.example/v1/x"],
    ] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(refusal(ALCHEMY_TOO_WIDE));
      const error = await thrown(callRpc(chain, "eth_getLogs", [], { url }));
      expect(error, chain.protocol).toBeInstanceOf(Erc8004RpcHttpError);
      expect(error.message, chain.protocol).toBe(`${chain.chainLabel} eth_getLogs returned HTTP 400.`);
    }
  });

  it("names the same text, answered with a 200 as a node may, as a result-size rejection on any chain", async () => {
    for (const chain of [BSC_CHAIN, ETHEREUM_CHAIN, BASE_CHAIN, DEMO_CHAIN]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(json({ error: { code: -32602, message: ALCHEMY_TOO_WIDE } }));
      const error = await thrown(callRpc(chain, "eth_getLogs", [], { url: "https://x.example/v1/x" }));
      expect((error as Erc8004RpcRangeError).reason, chain.protocol).toBe("result_size");
    }
  });
});

describe("provider text that carries the endpoint", () => {
  const PRIVATE_URL = `https://private-node.example/pfx-secret-9/v1/${KEY}?token=abc123`;

  it("loses the endpoint's address, host, path and long path segments on a chain whose provider is the operator's", async () => {
    const texts = [
      `request to ${PRIVATE_URL} failed`,
      "upstream private-node.example refused the call",
      "no route for /pfx-secret-9/v1 on this node",
      "segment pfx-secret-9 is unknown",
    ];
    for (const text of texts) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(json({ error: { code: -32000, message: text } }));
      const error = await thrown(callRpc(ARC_CHAIN, "eth_getLogs", [], { url: PRIVATE_URL }));
      expect(error.message, text).not.toContain("private-node");
      expect(error.message, text).not.toContain("pfx-secret-9");
      expect(error.message, text).not.toContain(KEY);
      expect(error.message, text).not.toContain("abc123");
      expect(error.message, text).toMatch(/^Arc eth_getLogs failed at the RPC layer: /);
    }
  });

  it("leaves a pinned vendor chain's text as it always was: the vendor's host is public and is not removed", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: -32000, message: "bsc-mainnet.nodereal.io said no" } }));
    const error = await thrown(callRpc(BSC_CHAIN, "eth_getLogs", [], { url: "https://bsc-mainnet.nodereal.io/v1/x" }));
    expect(error.message).toBe("BNB Chain eth_getLogs failed at the RPC layer: bsc-mainnet.nodereal.io said no");
  });

  it("removes each secret piece from the text, longest first, and then any long token-like run", () => {
    expect(scrubProviderText("see https://h.example/a-long-path/x and h.example", ["https://h.example/a-long-path/x", "h.example"])).toBe("see <redacted> and <redacted>");
    expect(scrubProviderText(`key ${KEY} here`)).toBe("key <redacted> here");
    expect(scrubProviderText("x".repeat(500)).length).toBeLessThanOrEqual(200);
    expect(scrubProviderText("nothing to hide", ["unrelated"])).toBe("nothing to hide");
  });
});
