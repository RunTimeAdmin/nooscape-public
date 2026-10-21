import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callBscRpc: vi.fn(async (_method: string, _params: unknown[]): Promise<unknown> => "0x"),
  callRobinhoodRpcOnce: vi.fn(async (_body: Record<string, unknown>): Promise<{ result?: unknown; error?: { code?: unknown; message?: unknown } }> => ({ result: "0x" })),
  take: vi.fn(async (_cost: number) => {}),
  callArcRpcOnce: vi.fn(async (_method: string, _params: unknown[]): Promise<unknown> => "0x"),
}));

vi.mock("./ingestion/bscRpc", async importOriginal => ({ ...(await importOriginal<typeof import("./ingestion/bscRpc")>()), callBscRpc: mocks.callBscRpc }));
vi.mock("./ingestion/robinhood", async importOriginal => ({ ...(await importOriginal<typeof import("./ingestion/robinhood")>()), callRobinhoodRpcOnce: mocks.callRobinhoodRpcOnce }));
vi.mock("./ingestion/bscBudget", async importOriginal => ({ ...(await importOriginal<typeof import("./ingestion/bscBudget")>()), bscReadBucket: { take: mocks.take, spent: () => 0 } }));
vi.mock("./claimsArc", () => ({ callArcRpcOnce: mocks.callArcRpcOnce }));

import { BscRpcError } from "./ingestion/bscRpc";
import { Erc8004RpcError } from "./ingestion/erc8004Rpc";
import { callChain, callChainForWorker, CLAIM_CHAIN_READS_PER_MINUTE, CLAIM_CHAINS, ChainUnavailableError, claimableChains, claimChainOf, contractAcceptsSignature, isContractAddress, readOwnerOf, type EvmCall } from "./claimsChain";
import { personalMessageHash } from "./claimsCrypto";
import { resetRateLimits } from "./rateLimit";

/**
 * What a claim reads from a chain (docs/claims-2026-10-18.md): who owns an agent, whether an address is a contract, and whether a
 * contract wallet accepts a signature, through the paced clients, with a revert told apart from an outage.
 */
const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const word = `0x${"0".repeat(24)}${OWNER.slice(2)}`;
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

describe("the two registries a claim can be made on", () => {
  it("are Robinhood Chain and BNB Smart Chain, by the protocol of the directory entry, and no other", () => {
    expect(CLAIM_CHAINS.erc8004).toMatchObject({ chainId: 4663, registry: REGISTRY, label: "Robinhood Chain" });
    expect(CLAIM_CHAINS.erc8004_bsc).toMatchObject({ chainId: 56, registry: REGISTRY, label: "BNB Smart Chain" });
    expect(claimChainOf("erc8004")?.chainId).toBe(4663);
    expect(claimChainOf("erc8004_bsc")?.chainId).toBe(56);
    for (const other of ["solana_8004", "solana_said", "solana_registry", "a2a", "catalog", "erc8004_reputation", "", "constructor"]) expect(claimChainOf(other), other).toBeNull();
  });
});

describe("Arc's registry", () => {
  const ARC_ON = "chain_arc,claims_arc";

  it("is a claim chain with Arc's own chain id and the registry's address", () => {
    expect(CLAIM_CHAINS.erc8004_arc).toMatchObject({ protocol: "erc8004_arc", chainId: 5042, registry: REGISTRY, label: "Arc" });
  });

  it("can be claimed only while Arc is on and its claims are on, each named in the list, and the first two are claimable whatever the list says", () => {
    expect(claimChainOf("erc8004_arc", ARC_ON)?.chainId).toBe(5042);
    expect(claimChainOf("erc8004_arc", " Claims , CLAIMS_ARC , Chain_Arc ")?.chainId).toBe(5042);
    for (const list of [undefined, "", "claims", "chain_arc", "claims_arc", "claims,chain_arc", "claims,claims_arc", "chain_base,chain_ethereum", "chain_arcade,claims_arcade"]) {
      expect(claimChainOf("erc8004_arc", list), String(list)).toBeNull();
      expect(claimChainOf("erc8004", list)?.chainId, String(list)).toBe(4663);
      expect(claimChainOf("erc8004_bsc", list)?.chainId, String(list)).toBe(56);
    }
    expect(claimableChains(undefined).map(chain => chain.label)).toEqual(["Robinhood Chain", "BNB Smart Chain"]);
    expect(claimableChains(ARC_ON).map(chain => chain.label)).toEqual(["Robinhood Chain", "BNB Smart Chain", "Arc"]);
    // No other chain that the pass reads is claimable, however its switch is set.
    for (const other of ["erc8004_base", "erc8004_eth"]) expect(claimChainOf(other, "chain_base,chain_ethereum,chain_arc,claims_arc,claims"), other).toBeNull();
  });

  it("reads the list from the switches as the server runs when none is given", () => {
    vi.stubEnv("VITE_FEATURES", ARC_ON);
    expect(claimChainOf("erc8004_arc")?.chainId).toBe(5042);
    vi.stubEnv("VITE_FEATURES", "chain_arc");
    expect(claimChainOf("erc8004_arc")).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("reading the owner", () => {
  const call = (answer: Awaited<ReturnType<EvmCall>>): EvmCall => vi.fn(async () => answer);

  it("asks ownerOf at the registry of the chain and returns the lower-case owner", async () => {
    const seen = vi.fn<EvmCall>(async () => ({ revert: false, result: word }));
    expect(await readOwnerOf(seen, CLAIM_CHAINS.erc8004, "7")).toEqual({ status: "owner", owner: OWNER });
    expect(seen).toHaveBeenCalledWith(4663, "eth_call", [{ to: REGISTRY, data: `0x6352211e${"0".repeat(63)}7` }, "latest"]);
  });

  it("says there is no owner for a revert and for the zero address, and asks nothing for an id that is not a number", async () => {
    expect(await readOwnerOf(call({ revert: true }), CLAIM_CHAINS.erc8004, "7")).toEqual({ status: "none" });
    expect(await readOwnerOf(call({ revert: false, result: `0x${"0".repeat(64)}` }), CLAIM_CHAINS.erc8004, "7")).toEqual({ status: "none" });
    const never = vi.fn<EvmCall>();
    expect(await readOwnerOf(never, CLAIM_CHAINS.erc8004, "7; drop")).toEqual({ status: "none" });
    expect(never).not.toHaveBeenCalled();
  });

  it("takes an empty or malformed answer for an outage, never for a token that is gone: a node with no code at the address answers 0x", async () => {
    for (const result of ["0x", "", null, undefined, 7, "0xzz", `0x${"1".repeat(63)}`, `0x${"0".repeat(65)}`]) {
      await expect(readOwnerOf(call({ revert: false, result }), CLAIM_CHAINS.erc8004, "7"), String(result)).rejects.toBeInstanceOf(ChainUnavailableError);
    }
  });

  it("lets an outage through as an outage, never as an answer about the owner", async () => {
    await expect(readOwnerOf(vi.fn<EvmCall>(async () => { throw new ChainUnavailableError(); }), CLAIM_CHAINS.erc8004_bsc, "7")).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});

describe("a contract wallet", () => {
  it("is an address with code, and not one with none or an answer that is not code", async () => {
    expect(await isContractAddress(async () => ({ revert: false, result: "0x6080" }), 56, OWNER)).toBe(true);
    for (const result of ["0x", "", null, "0xzz", 7]) expect(await isContractAddress(async () => ({ revert: false, result }), 56, OWNER), String(result)).toBe(false);
    expect(await isContractAddress(async () => ({ revert: true }), 56, OWNER)).toBe(false);
  });

  it("accepts a signature only when it answers the EIP-1271 magic value, and not when it reverts or answers anything else", async () => {
    const hash = personalMessageHash("x");
    const magic = `0x1626ba7e${"0".repeat(56)}`;
    expect(await contractAcceptsSignature(async () => ({ revert: false, result: magic }), 56, OWNER, hash, "0xabcd")).toBe(true);
    expect(await contractAcceptsSignature(async () => ({ revert: false, result: `0x${"0".repeat(64)}` }), 56, OWNER, hash, "0xabcd")).toBe(false);
    expect(await contractAcceptsSignature(async () => ({ revert: true }), 56, OWNER, hash, "0xabcd")).toBe(false);
  });
});

describe("the production call", () => {
  beforeEach(() => {
    mocks.callBscRpc.mockReset();
    mocks.callRobinhoodRpcOnce.mockReset();
    mocks.take.mockClear();
    resetRateLimits();
  });

  it("reads BNB Smart Chain through the shared compute-unit bucket, and spends the price of one eth_call from it", async () => {
    mocks.callBscRpc.mockResolvedValueOnce(word);
    expect(await callChain(56, "eth_call", [{ to: REGISTRY, data: "0x" }, "latest"])).toEqual({ revert: false, result: word });
    expect(mocks.take).toHaveBeenCalledWith(20);
    expect(mocks.callBscRpc).toHaveBeenCalledWith("eth_call", [{ to: REGISTRY, data: "0x" }, "latest"]);
  });

  it("reads Robinhood Chain once, with no retry ladder, and tells a revert from a failure by what the node says", async () => {
    mocks.callRobinhoodRpcOnce.mockResolvedValueOnce({ result: word });
    expect(await callChain(4663, "eth_getCode", [OWNER, "latest"])).toEqual({ revert: false, result: word });
    expect(mocks.callRobinhoodRpcOnce).toHaveBeenCalledWith({ method: "eth_getCode", params: [OWNER, "latest"] });
    mocks.callRobinhoodRpcOnce.mockResolvedValueOnce({ error: { message: "execution reverted: ERC721: invalid token ID" } });
    expect(await callChain(4663, "eth_call", [])).toEqual({ revert: true });
    mocks.callRobinhoodRpcOnce.mockResolvedValueOnce({ error: { code: 3, message: "" } });
    expect(await callChain(4663, "eth_call", [])).toEqual({ revert: true });
    mocks.callRobinhoodRpcOnce.mockRejectedValueOnce(new Error("request failed"));
    await expect(callChain(4663, "eth_call", [])).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it("takes what a node says about a bad key, a missing method or a throttle for an outage, never for a revert, so none of them can end a claim", async () => {
    for (const message of ["rate limit exceeded", "invalid token", "Invalid API key: token not found", "the method eth_call does not exist/is not available", "ERC721 gateway timeout", "nonexistent route", "unauthorized"]) {
      mocks.callRobinhoodRpcOnce.mockResolvedValueOnce({ error: { code: -32601, message } });
      await expect(callChain(4663, "eth_call", []), message).rejects.toBeInstanceOf(ChainUnavailableError);
      mocks.callBscRpc.mockRejectedValueOnce(new BscRpcError(`BNB Chain eth_call failed at the RPC layer: ${message}`));
      await expect(callChain(56, "eth_call", []), message).rejects.toBeInstanceOf(ChainUnavailableError);
    }
    for (const message of ["execution reverted", "execution reverted: ERC721: invalid token ID", "VM Exception: revert", "reverted"]) {
      mocks.callRobinhoodRpcOnce.mockResolvedValueOnce({ error: { code: -32000, message } });
      expect(await callChain(4663, "eth_call", []), message).toEqual({ revert: true });
    }
  });

  it("holds a visitor's reads of one chain to 60 a minute, refusing as an outage rather than queueing, and leaves the worker's own reads alone", async () => {
    mocks.callBscRpc.mockResolvedValue(word);
    for (let index = 0; index < CLAIM_CHAIN_READS_PER_MINUTE; index += 1) await callChain(56, "eth_call", []);
    await expect(callChain(56, "eth_call", [])).rejects.toBeInstanceOf(ChainUnavailableError);
    // The refused read never reached the bucket or the node.
    expect(mocks.take).toHaveBeenCalledTimes(CLAIM_CHAIN_READS_PER_MINUTE);
    expect(mocks.callBscRpc).toHaveBeenCalledTimes(CLAIM_CHAIN_READS_PER_MINUTE);
    // Another chain has its own budget, and the worker's call is not held to it.
    mocks.callRobinhoodRpcOnce.mockResolvedValue({ result: word });
    expect(await callChain(4663, "eth_call", [])).toEqual({ revert: false, result: word });
    expect(await callChainForWorker(56, "eth_call", [])).toEqual({ revert: false, result: word });
  });

  it("reads Arc once through the node's client, and takes a revert from the node's own words and anything else for an outage", async () => {
    mocks.callArcRpcOnce.mockReset();
    mocks.callArcRpcOnce.mockResolvedValueOnce(word);
    expect(await callChain(5042, "eth_call", [{ to: REGISTRY, data: "0x" }, "latest"])).toEqual({ revert: false, result: word });
    expect(mocks.callArcRpcOnce).toHaveBeenCalledWith("eth_call", [{ to: REGISTRY, data: "0x" }, "latest"]);
    for (const message of ["Arc eth_call failed at the RPC layer: execution reverted", "Arc eth_call failed at the RPC layer: execution reverted: ERC721NonexistentToken"]) {
      mocks.callArcRpcOnce.mockRejectedValueOnce(new Erc8004RpcError(message, "ArcRpcError"));
      expect(await callChain(5042, "eth_call", []), message).toEqual({ revert: true });
    }
    for (const message of ["Arc eth_call request timed out.", "Arc eth_call returned HTTP 503.", "Arc eth_call request failed.", "Arc eth_call failed at the RPC layer: rate limit exceeded", "Arc eth_call failed at the RPC layer: invalid token", "Arc eth_call failed at the RPC layer: the method eth_call does not exist/is not available", "Arc eth_call failed at the RPC layer: unauthorized"]) {
      mocks.callArcRpcOnce.mockRejectedValueOnce(new Erc8004RpcError(message, "ArcRpcError"));
      await expect(callChain(5042, "eth_call", []), message).rejects.toBeInstanceOf(ChainUnavailableError);
    }
    mocks.callArcRpcOnce.mockRejectedValueOnce(new Error("Arc's node is not configured."));
    await expect(callChain(5042, "eth_call", [])).rejects.toBeInstanceOf(ChainUnavailableError);
    // The worker's daily check reads Arc through the same client, with no per-minute budget.
    mocks.callArcRpcOnce.mockResolvedValueOnce(word);
    expect(await callChainForWorker(5042, "eth_call", [])).toEqual({ revert: false, result: word });
  });

  it("holds a visitor's reads of Arc to 60 a minute, with a budget of its own, and refuses as an outage without asking the node", async () => {
    mocks.callArcRpcOnce.mockReset();
    mocks.callArcRpcOnce.mockResolvedValue(word);
    for (let index = 0; index < CLAIM_CHAIN_READS_PER_MINUTE; index += 1) await callChain(5042, "eth_call", []);
    await expect(callChain(5042, "eth_call", [])).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(mocks.callArcRpcOnce).toHaveBeenCalledTimes(CLAIM_CHAIN_READS_PER_MINUTE);
    // Another chain's budget is its own, and the worker's call is not held to Arc's.
    mocks.callRobinhoodRpcOnce.mockResolvedValue({ result: word });
    expect(await callChain(4663, "eth_call", [])).toEqual({ revert: false, result: word });
    expect(await callChainForWorker(5042, "eth_call", [])).toEqual({ revert: false, result: word });
  });

  it("treats a revert on BNB Smart Chain as an answer, and any other failure, a chain it does not know and a missing key as an outage", async () => {
    mocks.callBscRpc.mockRejectedValueOnce(new BscRpcError("BNB Chain eth_call failed at the RPC layer: execution reverted"));
    expect(await callChain(56, "eth_call", [])).toEqual({ revert: true });
    mocks.callBscRpc.mockRejectedValueOnce(new BscRpcError("BNB Chain eth_call request timed out."));
    await expect(callChain(56, "eth_call", [])).rejects.toBeInstanceOf(ChainUnavailableError);
    mocks.callBscRpc.mockRejectedValueOnce(new Error("BSC_RPC_URL is not configured"));
    await expect(callChain(56, "eth_call", [])).rejects.toBeInstanceOf(ChainUnavailableError);
    await expect(callChain(1, "eth_call", [])).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it("never carries an address, a key or a query in what it throws", async () => {
    expect.assertions(1);
    mocks.callBscRpc.mockRejectedValueOnce(new BscRpcError("failed at https://bsc-mainnet.nodereal.io/v1/SECRETKEYSECRETKEYSECRETKEY"));
    await expect(callChain(56, "eth_call", [])).rejects.toMatchObject({ message: "The chain could not be read right now." });
  });
});
