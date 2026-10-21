import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ assertPublicHostname: vi.fn(async (_host: string): Promise<void> => {}) }));
vi.mock("./ingestion/a2a", async importOriginal => ({ ...(await importOriginal<typeof import("./ingestion/a2a")>()), assertPublicHostname: mocks.assertPublicHostname }));

import { callArcRpcOnce, forgetCheckedArcNode } from "./claimsArc";
import { Erc8004RpcError, Erc8004RpcHttpError } from "./ingestion/erc8004Rpc";

/**
 * One read on Arc's node for the claim flow (docs/arc-claims-2026-10-20.md): the node's address is X402_RPC and may carry a key, so it
 * is read as the pass reads it, called once with no retry ladder, held to what a claim needs of it (a public host that answers as Arc and
 * is at the head), given a gas limit for what a visitor can make it run, and never named in what is thrown. The node is replaced by a
 * stand-in for `fetch` that answers the chain id, the latest block and the call as each test sets.
 */
const KEY = "K3yK3yK3yK3yK3yK3yK3yK3yK3yK3yK3y";
const NODE = `https://node.example.org/${KEY}`;
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
const SAVED_NODE = process.env.X402_RPC;
let fetchMock: ReturnType<typeof vi.fn>;
let sent: Sent[];
/** What the stand-in node says: its chain id, how old its latest block is, and the answer to anything else. */
let node: { chainId: unknown; headAgeSeconds: number | null; answer: () => Response };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T20:00:00Z"));
  process.env.X402_RPC = NODE;
  mocks.assertPublicHostname.mockReset();
  mocks.assertPublicHostname.mockResolvedValue(undefined);
  forgetCheckedArcNode();
  sent = [];
  node = { chainId: "0x13b2", headAgeSeconds: 1, answer: () => json({ jsonrpc: "2.0", id: 1, result: "0xabc" }) };
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
  if (SAVED_NODE === undefined) delete process.env.X402_RPC;
  else process.env.X402_RPC = SAVED_NODE;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const methods = () => sent.map(request => request.method);

describe("a read on Arc's node", () => {
  it("asks the chain id and the latest block first, then makes the call, all to the address in X402_RPC and none redirected", async () => {
    expect(await callArcRpcOnce("eth_getCode", ["0x1", "latest"])).toBe("0xabc");
    expect(methods()).toEqual(["eth_chainId", "eth_getBlockByNumber", "eth_getCode"]);
    expect(sent[2]!.params).toEqual(["0x1", "latest"]);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(NODE);
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
    }
  });

  it("gives an eth_call the gas it may use: a little for ownerOf, more for anything else, and leaves a gas the caller set", async () => {
    await callArcRpcOnce("eth_call", [{ to: "0x1", data: OWNER_OF }, "latest"]);
    await callArcRpcOnce("eth_call", [{ to: "0x2", data: `0x1626ba7e${"0".repeat(56)}` }, "latest"]);
    await callArcRpcOnce("eth_call", [{ to: "0x3", data: "0x", gas: "0x5208" }, "latest"]);
    const calls = sent.filter(request => request.method === "eth_call").map(request => request.params);
    expect(calls).toEqual([
      [{ to: "0x1", data: OWNER_OF, gas: "0x30d40" }, "latest"],
      [{ to: "0x2", data: `0x1626ba7e${"0".repeat(56)}`, gas: "0x2dc6c0" }, "latest"],
      [{ to: "0x3", data: "0x", gas: "0x5208" }, "latest"],
    ]);
    // Nothing else is given a gas field.
    await callArcRpcOnce("eth_getCode", ["0x1", "latest"]);
    expect(sent.at(-1)!.params).toEqual(["0x1", "latest"]);
  });

  it("makes one attempt at the call and no more: a status the pass would try again is an error at once", async () => {
    node.answer = () => new Response("busy", { status: 503 });
    const error = await thrown(callArcRpcOnce("eth_call", [{ to: "0x1", data: OWNER_OF }, "latest"]));
    expect(error).toBeInstanceOf(Erc8004RpcHttpError);
    expect(error.message).toBe("Arc eth_call returned HTTP 503.");
    expect(methods().filter(method => method === "eth_call")).toHaveLength(1);
    // A node that is busy at the RPC layer, which the pass would also wait out, is the same.
    sent.length = 0;
    node.answer = () => json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit exceeded" } });
    expect((await thrown(callArcRpcOnce("eth_call", []))).message).toBe("Arc eth_call failed at the RPC layer: rate limit exceeded");
    expect(methods().filter(method => method === "eth_call")).toHaveLength(1);
  });

  it("gives a revert in the node's own words, which is what the claim flow tells from an outage", async () => {
    node.answer = () => json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted: ERC721NonexistentToken" } });
    const error = await thrown(callArcRpcOnce("eth_call", [{ to: "0x1", data: OWNER_OF }, "latest"]));
    expect(error).toBeInstanceOf(Erc8004RpcError);
    expect(error.message).toContain("execution reverted");
  });

  it("puts neither the address nor its key nor its host in anything it throws, whatever the node says", async () => {
    const bodies = [
      { error: { code: -32000, message: `bad request to ${NODE}` } },
      { error: { code: -32000, message: `unknown route /${KEY} on node.example.org` } },
    ];
    for (const body of bodies) {
      node.answer = () => json({ jsonrpc: "2.0", id: 1, ...body });
      const error = await thrown(callArcRpcOnce("eth_call", []));
      for (const secret of [NODE, KEY, "node.example.org"]) expect(`${error.message} ${error.name}`, secret).not.toContain(secret);
    }
    fetchMock.mockImplementation(async () => {
      throw new TypeError(`fetch failed for ${NODE}`);
    });
    forgetCheckedArcNode();
    const failed = await thrown(callArcRpcOnce("eth_call", []));
    expect(failed.message).toBe("Arc's node could not be asked for its chain id.");
    for (const secret of [NODE, KEY, "node.example.org"]) expect(failed.message, secret).not.toContain(secret);
  });

  it("refuses when the node is not configured, or is not an https address, without asking anything", async () => {
    for (const value of [undefined, "", "   ", "http://node.example.org/x", "not a url"]) {
      if (value === undefined) delete process.env.X402_RPC;
      else process.env.X402_RPC = value;
      const error = await thrown(callArcRpcOnce("eth_call", []));
      expect(error.message, String(value)).toBe("Arc's node is not configured.");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.assertPublicHostname).not.toHaveBeenCalled();
  });
});

describe("what a claim needs of the node", () => {
  it("must answer as Arc: a node for another chain, whose registry has the same address, is refused before the call, and asked again", async () => {
    node.chainId = "0x1";
    const error = await thrown(callArcRpcOnce("eth_call", [{ to: "0x1", data: OWNER_OF }, "latest"]));
    expect(error.message).toBe("Arc's node did not answer as Arc.");
    expect(error).not.toBeInstanceOf(Erc8004RpcError);
    expect(methods()).toEqual(["eth_chainId"]);
    // A failed check is not remembered: the next read asks again, and a node that is Arc now is used.
    for (const wrong of [null, 5042, "", "0x13b3", "5042", {}]) {
      node.chainId = wrong;
      expect((await thrown(callArcRpcOnce("eth_call", []))).message, JSON.stringify(wrong)).toBe("Arc's node did not answer as Arc.");
    }
    // An answer with no result at all is no answer, and is said so.
    node.chainId = undefined;
    expect((await thrown(callArcRpcOnce("eth_call", []))).message).toBe("Arc's node could not be asked for its chain id.");
    node.chainId = "0x13B2";
    expect(await callArcRpcOnce("eth_call", [])).toBe("0xabc");
  });

  it("is asked its chain id once in a while and not for every read, and again for another address", async () => {
    await callArcRpcOnce("eth_call", []);
    await callArcRpcOnce("eth_call", []);
    expect(methods().filter(method => method === "eth_chainId")).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 9 * 60_000));
    await callArcRpcOnce("eth_call", []);
    expect(methods().filter(method => method === "eth_chainId")).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    await callArcRpcOnce("eth_call", []);
    expect(methods().filter(method => method === "eth_chainId")).toHaveLength(2);
    process.env.X402_RPC = `https://other.example.org/${KEY}`;
    await callArcRpcOnce("eth_call", []);
    expect(methods().filter(method => method === "eth_chainId")).toHaveLength(3);
  });

  it("must be at the head: a node whose latest block is more than ten minutes old is refused, as one with no readable block time is", async () => {
    node.headAgeSeconds = 11 * 60;
    const behind = await thrown(callArcRpcOnce("eth_call", [{ to: "0x1", data: OWNER_OF }, "latest"]));
    expect(behind.message).toBe("Arc's node is behind.");
    expect(behind).not.toBeInstanceOf(Erc8004RpcError);
    expect(methods()).toEqual(["eth_chainId", "eth_getBlockByNumber"]);
    node.headAgeSeconds = null;
    expect((await thrown(callArcRpcOnce("eth_call", []))).message).toBe("Arc's node is behind.");
    node.headAgeSeconds = 9 * 60;
    expect(await callArcRpcOnce("eth_call", [])).toBe("0xabc");
    // A latest block that is not a block at all is no answer.
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as Sent;
      return json({ jsonrpc: "2.0", id: 1, result: request.method === "eth_chainId" ? "0x13b2" : request.method === "eth_getBlockByNumber" ? null : "0xabc" });
    });
    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    expect((await thrown(callArcRpcOnce("eth_call", []))).message).toBe("Arc's node is behind.");
  });

  it("has its head looked at about once a minute and not for every read", async () => {
    await callArcRpcOnce("eth_call", []);
    await callArcRpcOnce("eth_call", []);
    expect(methods().filter(method => method === "eth_getBlockByNumber")).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await callArcRpcOnce("eth_call", []);
    expect(methods().filter(method => method === "eth_getBlockByNumber")).toHaveLength(2);
    // And a node that has fallen behind in the meantime is found.
    vi.setSystemTime(new Date(Date.now() + 61_000));
    node.headAgeSeconds = 30 * 60;
    expect((await thrown(callArcRpcOnce("eth_call", []))).message).toBe("Arc's node is behind.");
  });

  it("can never have a failed check read as a revert: whatever the node says to the chain id or the block, the failure is fixed text", async () => {
    fetchMock.mockImplementation(async () => json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }));
    const chainId = await thrown(callArcRpcOnce("eth_call", []));
    expect(chainId.message).toBe("Arc's node could not be asked for its chain id.");
    expect(chainId).not.toBeInstanceOf(Erc8004RpcError);
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const request = JSON.parse(init.body) as Sent;
      return request.method === "eth_chainId" ? json({ jsonrpc: "2.0", id: 1, result: "0x13b2" }) : json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } });
    });
    const block = await thrown(callArcRpcOnce("eth_call", []));
    expect(block.message).toBe("Arc's node could not be asked for its latest block.");
    expect(block).not.toBeInstanceOf(Erc8004RpcError);
  });

  it("is checked for a public address before it is called, once in a while and not for every read, and again for another host", async () => {
    await callArcRpcOnce("eth_call", []);
    await callArcRpcOnce("eth_getCode", []);
    expect(mocks.assertPublicHostname).toHaveBeenCalledTimes(1);
    expect(mocks.assertPublicHostname).toHaveBeenCalledWith("node.example.org");
    process.env.X402_RPC = `https://other.example.org/${KEY}`;
    await callArcRpcOnce("eth_call", []);
    expect(mocks.assertPublicHostname).toHaveBeenCalledTimes(2);
    expect(mocks.assertPublicHostname).toHaveBeenLastCalledWith("other.example.org");
    forgetCheckedArcNode();
    await callArcRpcOnce("eth_call", []);
    expect(mocks.assertPublicHostname).toHaveBeenCalledTimes(3);
  });

  it("does not call a node whose host is not public, and does not remember that it passed", async () => {
    mocks.assertPublicHostname.mockRejectedValueOnce(new Error("The A2A hostname resolves to a forbidden network address."));
    await expect(callArcRpcOnce("eth_call", [])).rejects.toThrow("forbidden network address");
    expect(fetchMock).not.toHaveBeenCalled();
    await callArcRpcOnce("eth_call", []);
    expect(mocks.assertPublicHostname).toHaveBeenCalledTimes(2);
  });
});
