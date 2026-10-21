import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE_CHAIN, BSC_CHAIN, ETHEREUM_CHAIN, type Erc8004Chain } from "./erc8004Chains";
import { Erc8004RpcNotConfiguredError, resolveRpcUrl } from "./erc8004Rpc";

/**
 * The endpoint rules of the two chains whose provider is named in the code, Ethereum (NodeReal) and Base (Alchemy), held on the
 * real entries and not on a chain made for tests: each reads its own variable and no other, accepts its provider's host over https
 * and nothing else, and says what is wrong in words that name the variable and never what it holds. The values below are made up.
 */
const KEY = "K3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3y";
const CASES: Array<[string, Erc8004Chain, string, string]> = [
  ["Ethereum", ETHEREUM_CHAIN, "ETH_RPC_URL", "eth-mainnet.nodereal.io"],
  ["Base", BASE_CHAIN, "BASE_RPC_URL", "base-mainnet.g.alchemy.com"],
];

afterEach(() => vi.unstubAllEnvs());

describe.each(CASES)("the %s endpoint", (_name, chain, variable, host) => {
  const others = [BSC_CHAIN, ETHEREUM_CHAIN, BASE_CHAIN].filter(candidate => candidate !== chain);
  const otherHost = (candidate: Erc8004Chain) => (candidate.provider.kind === "pinned" ? candidate.provider.allowedHostname : "unreachable.example");

  it("names its own variable, and the host its provider serves it from", () => {
    expect(chain.rpcEnvVar).toBe(variable);
    expect(chain.provider).toEqual({ kind: "pinned", rootUrl: `https://${host}`, allowedHostname: host });
  });

  it("reads its own variable when asked, and not another chain's", async () => {
    // The environment object is read when ENV is first loaded, so the reader is exercised through a fresh load of the module.
    vi.resetModules();
    vi.stubEnv("BSC_RPC_URL", "https://bsc.example/v1/bsc");
    vi.stubEnv("ETH_RPC_URL", "https://eth.example/v1/eth");
    vi.stubEnv("BASE_RPC_URL", "https://base.example/v1/base");
    const { ETHEREUM_CHAIN: eth, BASE_CHAIN: base } = await import("./erc8004Chains");
    expect(eth.readRpcUrl()).toBe("https://eth.example/v1/eth");
    expect(base.readRpcUrl()).toBe("https://base.example/v1/base");
  });

  it("accepts its provider's host over https, whatever the case of the host, and returns the value untouched", () => {
    const url = `https://${host}/v1/${KEY}`;
    expect(resolveRpcUrl(chain, host, url)).toBe(url);
    expect(resolveRpcUrl(chain, host, `https://${host.toUpperCase()}/v1/${KEY}`)).toContain(host.toUpperCase());
  });

  const refused: Array<[string, (host: string) => string]> = [
    ["plain http", h => `http://${h}/v1/${KEY}`],
    ["userinfo in the address", h => `https://user:${KEY}@${h}/v1/x`],
    ["a look-alike host", h => `https://${h}.evil.example/v1/${KEY}`],
    ["a host the provider does not serve", () => `https://other-provider.example/v1/${KEY}`],
    ["a value that is not an address", () => `not a url ${KEY}`],
    ["nothing at all", () => ""],
  ];
  for (const [label, make] of refused) {
    it(`refuses ${label}, naming the variable and never the value`, () => {
      const value = make(host);
      const error = (() => {
        try {
          resolveRpcUrl(chain, host, value);
        } catch (caught) {
          return caught as Error;
        }
        throw new Error("expected a refusal");
      })();
      expect(error).toBeInstanceOf(Erc8004RpcNotConfiguredError);
      expect(error.message).toMatch(new RegExp(`^${variable} `));
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("evil.example");
      expect(error.message).not.toContain("other-provider");
    });
  }

  it("refuses the other chains' providers: a key for one chain cannot be put on another's variable", () => {
    for (const candidate of others) {
      expect(() => resolveRpcUrl(chain, host, `https://${otherHost(candidate)}/v1/${KEY}`), candidate.protocol).toThrow(Erc8004RpcNotConfiguredError);
    }
  });

  it("compares with the host its source row records, which for a pinned chain is its own", () => {
    expect(() => resolveRpcUrl(chain, "staged.example", `https://${host}/v1/${KEY}`)).toThrow(/does not point at the approved/);
  });
});
