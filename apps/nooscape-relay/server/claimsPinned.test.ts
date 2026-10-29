import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ assertPublicHostname: vi.fn(async (_host: string): Promise<void> => {}) }));
vi.mock("./ingestion/a2a", async importOriginal => ({ ...(await importOriginal<typeof import("./ingestion/a2a")>()), assertPublicHostname: mocks.assertPublicHostname }));

import { ENV } from "./_core/env";
import { callBaseRpcOnce, callEthereumRpcOnce, forgetCheckedPinnedNodes } from "./claimsPinned";
import { Erc8004RpcError, Erc8004RpcHttpError } from "./ingestion/erc8004Rpc";

/**
 * One read on Base's node and one on Ethereum's for the claim flow (docs/base-ethereum-claims-2026-10-28.md): the endpoint is the one the
 * chain's identity pass reads (BASE_RPC_URL, ETH_RPC_URL), pinned to a vendor's host, called once with no retry ladder, held to what a
 * claim needs of it (it answers as the chain and is at the head), given a gas limit for what a visitor can make it run, and never named
 * in what is thrown. The node is replaced by a stand-in for `fetch` that answers the chain id, the latest block and the call as each
 * test sets. These are the same checks claimsArc.test.ts makes of Arc's node, which shares their code (claimsNode.ts).
 */
const KEY = "K3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3y";
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const OWNER_OF = `0x6352211e${"0".repeat(63)}7`;

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

type Sent = { method: string; params: unknown[] };
let fetchMock: ReturnType<typeof vi.fn>;
let sent: Sent[];
/** What the stand-in node says: its chain id, how old its latest block is, and the answer to anything else. */
let node: { chainId: unknown; headAgeSeconds: number | null; answer: () => Response };
const SAVED = { base: ENV.baseRpcUrl, ethereum: ENV.ethRpcUrl };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T20:00:00Z"));
  mocks.assertPublicHostname.mockReset();
  mocks.assertPublicHostname.mockResolvedValue(undefined);
  forgetCheckedPinnedNodes();
  sent = [];
  node = { chainId: "0x2105", headAgeSeconds: 1, answer: () => json({ jsonrpc: "2.0", id: 1, result: "0xabc" }) };
  fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as Sent & { id: number };
    sent.push({ method: request.method, params: request.params });
    if (request.method === "eth_chainId") return json({ jsonrpc: "2.0", id: 1, result: node.chainId });
    if (request.method === "eth_getBlockByNumber") {
      const timestamp = node.headAgeSeconds === null ? undefined : `0x${(Math.floor(Date.now() / 1000) - node.headAgeSeconds).toString(16)}`;
      return json({ jsonrpc: "2.0", id: 1, result: { number: "0x10", ...(timestamp ? { timestamp } : {}) } });
    }
    return node.answer();
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  ENV.baseRpcUrl = SAVED.base;
  ENV.ethRpcUrl = SAVED.ethereum;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const methods = () => sent.map(request => request.method);

describe.each([
  {
    label: "Base",
    read: callBaseRpcOnce,
    set: (value: string) => (ENV.baseRpcUrl = value),
    host: "base-mainnet.g.alchemy.com",
    path: `/v2/${KEY}`,
    chainId: "0x2105",
    otherChainId: "0x1",
    variable: "BASE_RPC_URL",
  },
  {
    label: "Ethereum",
    read: callEthereumRpcOnce,
    set: (value: string) => (ENV.ethRpcUrl = value),
    host: "eth-mainnet.nodereal.io",
    path: `/v1/${KEY}`,
    chainId: "0x1",
    otherChainId: "0x2105",
    variable: "ETH_RPC_URL",
  },
])("a read on $label's node", ({ label, read, set, host, path, chainId, otherChainId, variable }) => {
  const NODE = `https://${host}${path}`;
  beforeEach(() => {
    set(NODE);
    node.chainId = chainId;
  });

  it(`asks the chain id and the latest block first, then makes the call, all to the address in ${variable} and none redirected, and never checks the host is public`, async () => {
    expect(await read("eth_getCode", ["0x1", "latest"])).toBe("0xabc");
    expect(methods()).toEqual(["eth_chainId", "eth_getBlockByNumber", "eth_getCode"]);
    expect(sent[2]!.params).toEqual(["0x1", "latest"]);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(NODE);
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
    }
    // A vendor's host is pinned in the code, so it is not looked up again.
    expect(mocks.assertPublicHostname).not.toHaveBeenCalled();
  });

  it("gives an eth_call the gas it may use: a little for ownerOf, more for anything else, and leaves a gas the caller set", async () => {
    await read("eth_call", [{ to: "0x1", data: OWNER_OF }, "latest"]);
    await read("eth_call", [{ to: "0x2", data: `0x1626ba7e${"0".repeat(56)}` }, "latest"]);
    await read("eth_call", [{ to: "0x3", data: "0x", gas: "0x5208" }, "latest"]);
    const calls = sent.filter(request => request.method === "eth_call").map(request => request.params);
    expect(calls).toEqual([
      [{ to: "0x1", data: OWNER_OF, gas: "0x30d40" }, "latest"],
      [{ to: "0x2", data: `0x1626ba7e${"0".repeat(56)}`, gas: "0x2dc6c0" }, "latest"],
      [{ to: "0x3", data: "0x", gas: "0x5208" }, "latest"],
    ]);
    await read("eth_getCode", ["0x1", "latest"]);
    expect(sent.at(-1)!.params).toEqual(["0x1", "latest"]);
  });

  it("makes one attempt at the call and no more: a status the pass would try again is an error at once", async () => {
    node.answer = () => new Response("busy", { status: 503 });
    const error = await thrown(read("eth_call", [{ to: "0x1", data: OWNER_OF }, "latest"]));
    expect(error).toBeInstanceOf(Erc8004RpcHttpError);
    expect(error.message).toBe(`${label} eth_call returned HTTP 503.`);
    expect(methods().filter(method => method === "eth_call")).toHaveLength(1);
    sent.length = 0;
    node.answer = () => json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit exceeded" } });
    expect((await thrown(read("eth_call", []))).message).toBe(`${label} eth_call failed at the RPC layer: rate limit exceeded`);
    expect(methods().filter(method => method === "eth_call")).toHaveLength(1);
  });

  it("gives a revert in the node's own words, which is what the claim flow tells from an outage", async () => {
    node.answer = () => json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted: ERC721NonexistentToken" } });
    const error = await thrown(read("eth_call", [{ to: "0x1", data: OWNER_OF }, "latest"]));
    expect(error).toBeInstanceOf(Erc8004RpcError);
    expect(error.message).toContain("execution reverted");
  });

  it("puts neither the address nor its key in anything it throws, whatever the node says", async () => {
    const bodies = [
      { error: { code: -32000, message: `bad request to ${NODE}` } },
      { error: { code: -32000, message: `unknown route ${path} on ${host}` } },
    ];
    for (const body of bodies) {
      node.answer = () => json({ jsonrpc: "2.0", id: 1, ...body });
      const error = await thrown(read("eth_call", []));
      for (const secret of [NODE, KEY, path]) expect(`${error.message} ${error.name}`, secret).not.toContain(secret);
    }
    fetchMock.mockImplementation(async () => {
      throw new TypeError(`fetch failed for ${NODE}`);
    });
    forgetCheckedPinnedNodes();
    const failed = await thrown(read("eth_call", []));
    expect(failed.message).toBe(`${label}'s node could not be asked for its chain id.`);
    for (const secret of [NODE, KEY, path]) expect(failed.message, secret).not.toContain(secret);
  });

  it(`refuses when ${variable} is not set, is not an https address, carries credentials or names a host nobody approved, without asking anything`, async () => {
    for (const value of ["", "   ", "http://" + host + path, "not a url", `https://user:pw@${host}${path}`, `https://evil.example.org${path}`, `https://${host}.evil.example.org${path}`]) {
      set(value);
      const error = await thrown(read("eth_call", []));
      expect(error.message, value).toBe(`${label}'s node is not configured.`);
      for (const secret of [KEY, "evil.example.org"]) expect(error.message, secret).not.toContain(secret);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it(`must answer as ${label}: a node for another chain, whose registry has the same address, is refused before the call, and asked again`, async () => {
    node.chainId = otherChainId;
    const error = await thrown(read("eth_call", [{ to: "0x1", data: OWNER_OF }, "latest"]));
    expect(error.message).toBe(`${label}'s node did not answer as ${label}.`);
    expect(error).not.toBeInstanceOf(Erc8004RpcError);
    expect(methods()).toEqual(["eth_chainId"]);
    // A failed check is not remembered: the next read asks again, and a node that is the chain now is used.
    for (const wrong of [null, 56, "", "0x13b3", "8453", {}]) {
      node.chainId = wrong;
      expect((await thrown(read("eth_call", []))).message, JSON.stringify(wrong)).toBe(`${label}'s node did not answer as ${label}.`);
    }
    node.chainId = undefined;
    expect((await thrown(read("eth_call", []))).message).toBe(`${label}'s node could not be asked for its chain id.`);
    node.chainId = chainId.toUpperCase().replace("0X", "0x");
    expect(await read("eth_call", [])).toBe("0xabc");
  });

  it("is asked its chain id once in a while and not for every read", async () => {
    await read("eth_call", []);
    await read("eth_call", []);
    expect(methods().filter(method => method === "eth_chainId")).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 9 * 60_000));
    await read("eth_call", []);
    expect(methods().filter(method => method === "eth_chainId")).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    await read("eth_call", []);
    expect(methods().filter(method => method === "eth_chainId")).toHaveLength(2);
  });

  it("must be at the head: a node whose latest block is more than ten minutes old is refused, as one with no readable block time is", async () => {
    node.headAgeSeconds = 11 * 60;
    const behind = await thrown(read("eth_call", [{ to: "0x1", data: OWNER_OF }, "latest"]));
    expect(behind.message).toBe(`${label}'s node is behind.`);
    expect(behind).not.toBeInstanceOf(Erc8004RpcError);
    expect(methods()).toEqual(["eth_chainId", "eth_getBlockByNumber"]);
    node.headAgeSeconds = null;
    expect((await thrown(read("eth_call", []))).message).toBe(`${label}'s node is behind.`);
    node.headAgeSeconds = 9 * 60;
    expect(await read("eth_call", [])).toBe("0xabc");
  });

  it("has its head looked at about once a minute and not for every read, and a node that has fallen behind in the meantime is found", async () => {
    await read("eth_call", []);
    await read("eth_call", []);
    expect(methods().filter(method => method === "eth_getBlockByNumber")).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await read("eth_call", []);
    expect(methods().filter(method => method === "eth_getBlockByNumber")).toHaveLength(2);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    node.headAgeSeconds = 30 * 60;
    expect((await thrown(read("eth_call", []))).message).toBe(`${label}'s node is behind.`);
  });

  it("does not believe a latest block dated well ahead of this server's clock, and allows two minutes for a clock that is a little slow", async () => {
    const aheadMessage = `${label}'s node has a latest block dated ahead of this server's clock.`;
    node.headAgeSeconds = -10 * 60;
    const ahead = await thrown(read("eth_call", [{ to: "0x1", data: OWNER_OF }, "latest"]));
    expect(ahead.message).toBe(aheadMessage);
    expect(ahead).not.toBeInstanceOf(Erc8004RpcError);
    expect(methods()).toEqual(["eth_chainId", "eth_getBlockByNumber"]);
    node.headAgeSeconds = -121;
    expect((await thrown(read("eth_call", []))).message).toBe(aheadMessage);
    // A refused head is not remembered: the next read looks again, and a head within the allowance is used.
    node.headAgeSeconds = -120;
    expect(await read("eth_call", [])).toBe("0xabc");
  });

  it("does not trust a check that looks as if it was made in the future: after the clock goes back, the chain id and the head are asked again", async () => {
    await read("eth_call", []);
    expect(methods().filter(method => method === "eth_chainId")).toHaveLength(1);
    expect(methods().filter(method => method === "eth_getBlockByNumber")).toHaveLength(1);
    // The clock goes back an hour, and the node, which was fresh, is now 30 minutes behind it. Both checks used to count as made a moment ago.
    vi.setSystemTime(new Date(Date.now() - 60 * 60_000));
    node.headAgeSeconds = 30 * 60;
    expect((await thrown(read("eth_call", []))).message).toBe(`${label}'s node is behind.`);
    expect(methods().filter(method => method === "eth_chainId")).toHaveLength(2);
    expect(methods().filter(method => method === "eth_getBlockByNumber")).toHaveLength(2);
    // Once asked at the new time, each is remembered from then on and is not asked for every read.
    node.headAgeSeconds = 1;
    await read("eth_call", []);
    await read("eth_call", []);
    expect(methods().filter(method => method === "eth_chainId")).toHaveLength(2);
    expect(methods().filter(method => method === "eth_getBlockByNumber")).toHaveLength(3);
  });

  it("can never have a failed check read as a revert: whatever the node says to the chain id or the block, the failure is fixed text", async () => {
    fetchMock.mockImplementation(async () => json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }));
    const failedChainId = await thrown(read("eth_call", []));
    expect(failedChainId.message).toBe(`${label}'s node could not be asked for its chain id.`);
    expect(failedChainId).not.toBeInstanceOf(Erc8004RpcError);
    forgetCheckedPinnedNodes();
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as Sent;
      if (request.method === "eth_chainId") return json({ jsonrpc: "2.0", id: 1, result: chainId });
      return json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } });
    });
    const failedBlock = await thrown(read("eth_call", []));
    expect(failedBlock.message).toBe(`${label}'s node could not be asked for its latest block.`);
    expect(failedBlock).not.toBeInstanceOf(Erc8004RpcError);
  });
});

describe("the two nodes are separate", () => {
  it("each has its own address and its own checks: Base's being right says nothing of Ethereum's", async () => {
    ENV.baseRpcUrl = `https://base-mainnet.g.alchemy.com/v2/${KEY}`;
    ENV.ethRpcUrl = "";
    node.chainId = "0x2105";
    expect(await callBaseRpcOnce("eth_call", [])).toBe("0xabc");
    expect((await thrown(callEthereumRpcOnce("eth_call", []))).message).toBe("Ethereum's node is not configured.");
    // Base's chain id answer is not kept for Ethereum, which asks for its own.
    ENV.ethRpcUrl = `https://eth-mainnet.nodereal.io/v1/${KEY}`;
    sent.length = 0;
    expect((await thrown(callEthereumRpcOnce("eth_call", []))).message).toBe("Ethereum's node did not answer as Ethereum.");
    expect(methods()).toEqual(["eth_chainId"]);
  });
});
