import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../drizzle/schema";

const mocks = vi.hoisted(() => ({ assertPublicHostname: vi.fn(async (_hostname: string) => {}) }));
vi.mock("./ingestion/a2a", () => ({ assertPublicHostname: mocks.assertPublicHostname }));

import { readTokenUrisFromChain } from "./chainNames";
import { MULTICALL3 } from "./ingestion/bscMulticall";
import { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN, type Erc8004Chain } from "./ingestion/erc8004Chains";
import { Erc8004RpcHttpError, Erc8004RpcNotConfiguredError } from "./ingestion/erc8004Rpc";

/**
 * The chain read of the Base, Arc and Ethereum name step (docs/approvals/2026-10-26-base-arc-names.md): one `eth_call` through Multicall3 for the
 * tokenURI of each id, on the chain's own node, at the finalized block, in one attempt. The request and the answer below are the real
 * ones of NodeReal on 2026-10-16 for the ids 2, 1000 and 99999999 (server/ingestion/bscMulticall.test.ts): the registry is the same
 * contract at the same address on every chain, so the same ids give the same request on Base and on Arc. The endpoints below are made up.
 */
const REQUEST = "0x82ad56cb000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000008004a169fb4a3325136eb29fa0ceb6d2e539a432000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000024c87b56dd0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000008004a169fb4a3325136eb29fa0ceb6d2e539a432000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000024c87b56dd00000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000000000000000000000008004a169fb4a3325136eb29fa0ceb6d2e539a432000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000024c87b56dd0000000000000000000000000000000000000000000000000000000005f5e0ff00000000000000000000000000000000000000000000000000000000";
const RESPONSE = "0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002a307836343436616439383231303231656562396638356238613138623031353364353831363664313631000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000420222220000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000247e2732890000000000000000000000000000000000000000000000000000000005f5e0ff00000000000000000000000000000000000000000000000000000000";
const IDS = ["2", "1000", "99999999"];
const KEY = "K3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3y";

const BASE_URL = `https://base-mainnet.g.alchemy.com/v2/${KEY}`;
const ARC_URL = `https://arc-node.example/${KEY}/rpc`;
const ETHEREUM_URL = `https://eth-mainnet.nodereal.io/v1/${KEY}`;
/** A real chain entry with its endpoint made up, so the test does not depend on the environment. */
const withEndpoint = (chain: Erc8004Chain, url: string): Erc8004Chain => ({ ...chain, readRpcUrl: () => url });
const sourceAt = (host: string) => ({ allowedHostname: host }) as IngestionSource;

type Call = { chain: Erc8004Chain; method: string; params: unknown[]; options: { url?: string } };
const recorder = (answer: unknown) => {
  const calls: Call[] = [];
  const call = (async (chain: Erc8004Chain, method: string, params: unknown[], options: { url?: string } = {}) => {
    calls.push({ chain, method, params, options });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof import("./ingestion/erc8004Rpc").callRpc;
  return { calls, call };
};

beforeEach(() => mocks.assertPublicHostname.mockClear());

describe.each([
  ["Base", withEndpoint(BASE_CHAIN, BASE_URL), BASE_URL, "base-mainnet.g.alchemy.com"],
  ["Arc", withEndpoint(ARC_CHAIN, ARC_URL), ARC_URL, "arc-node.example"],
  ["Ethereum", withEndpoint(ETHEREUM_CHAIN, ETHEREUM_URL), ETHEREUM_URL, "eth-mainnet.nodereal.io"],
])("the %s chain read", (_name, chain, url, host) => {
  it("asks the chain's own node once, through Multicall3, at the finalized block, and decodes the answer", async () => {
    const { calls, call } = recorder(RESPONSE);
    const uris = await readTokenUrisFromChain(chain, sourceAt(host), IDS, call);
    expect(uris).toEqual(["0x6446ad9821021eeb9f85b8a18b0153d58166d161", ' "" ', null]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("eth_call");
    expect(calls[0]!.params).toEqual([{ to: MULTICALL3, data: REQUEST }, "finalized"]);
    expect(calls[0]!.options.url).toBe(url);
  });

  it("makes one attempt, and changes nothing else about how the chain is asked", async () => {
    const { calls, call } = recorder(RESPONSE);
    await readTokenUrisFromChain(chain, sourceAt(host), IDS, call);
    const asked = calls[0]!.chain;
    expect(asked.rpc.backoffMs).toEqual([]);
    // The chain's own limits, timeout and error words are the ones it already has.
    expect(asked.rpc).toEqual({ ...chain.rpc, backoffMs: [] });
    expect({ ...asked, rpc: chain.rpc }).toEqual(chain);
    // The entry the pass reads with keeps its retry ladder.
    expect(chain.rpc.backoffMs.length).toBeGreaterThan(0);
  });

  it("checks that the host is a public one before it asks, and says it is the RPC host that was checked", async () => {
    mocks.assertPublicHostname.mockRejectedValueOnce(new Error("The A2A hostname resolves to a forbidden network address."));
    const { calls, call } = recorder(RESPONSE);
    await expect(readTokenUrisFromChain(chain, sourceAt(host), IDS, call)).rejects.toThrow(
      `The ${chain.chainLabel} RPC host failed the public-network check: The A2A hostname resolves to a forbidden network address.`
    );
    expect(mocks.assertPublicHostname).toHaveBeenCalledWith(host);
    expect(calls).toEqual([]);
  });

  it("refuses an endpoint on a host other than the one the source row records, without naming the endpoint", async () => {
    const elsewhere = withEndpoint(chain, `https://elsewhere.example/${KEY}`);
    const { calls, call } = recorder(RESPONSE);
    const error = await readTokenUrisFromChain(elsewhere, sourceAt(host), IDS, call).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Erc8004RpcNotConfiguredError);
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).message).not.toContain("elsewhere.example");
    expect(calls).toEqual([]);
  });

  it("refuses an endpoint that is not set, or is not https", async () => {
    for (const bad of ["", `http://${host}/${KEY}`]) {
      const { calls, call } = recorder(RESPONSE);
      await expect(readTokenUrisFromChain(withEndpoint(chain, bad), sourceAt(host), IDS, call)).rejects.toBeInstanceOf(Erc8004RpcNotConfiguredError);
      expect(calls).toEqual([]);
    }
  });

  it("lets the node's refusal through as it is, so the step can tell a throttle from any other fault", async () => {
    const throttle = new Erc8004RpcHttpError(429, `${chain.chainLabel} eth_call returned HTTP 429.`);
    const { call } = recorder(throttle);
    await expect(readTokenUrisFromChain(chain, sourceAt(host), IDS, call)).rejects.toBe(throttle);
  });

  it("answers null for an answer that is not the shape of a multicall, so the step can pause the chain", async () => {
    for (const answer of ["0x", "not hex", null, RESPONSE.slice(0, 300)]) {
      const { call } = recorder(answer);
      expect(await readTokenUrisFromChain(chain, sourceAt(host), IDS, call)).toBeNull();
    }
  });
});
