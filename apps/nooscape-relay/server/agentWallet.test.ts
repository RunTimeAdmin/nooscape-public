import { beforeEach, describe, expect, it } from "vitest";
import { decodeAgentWallet, encodeGetAgentWallet, PAY_TO_READS_PER_CALLER_PER_MINUTE, readAgentWallet, readAgentWalletForCaller, resetWalletCache, WALLET_CACHE_MS, WALLET_NOT_READ } from "./agentWallet";
import { ChainUnavailableError, type EvmCall } from "./claimsChain";
import { resetRateLimits } from "./rateLimit";

/**
 * The one read the check's pay_to makes: `getAgentWallet(agentId)` on an ERC-8004 identity registry. The registry answers the zero
 * address for an agent with no wallet (it clears the wallet when an agent changes hands) and for an id that was never registered,
 * and it never reverts for either, so a revert is a registry that cannot answer, and a read that failed is never "none".
 */

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const CHAIN = { chainId: 8453, registry: REGISTRY };
const WALLET = "0xabcdef0123456789abcdef0123456789abcdef01";
const ZERO = `0x${"0".repeat(40)}`;
const word = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;

describe("encoding and decoding getAgentWallet", () => {
  it("encodes the registry's function with the id in one word, and refuses an id that is not a plain decimal that fits in one", () => {
    expect(encodeGetAgentWallet("7")).toBe(`0x00339509${"0".repeat(63)}7`);
    expect(encodeGetAgentWallet("0")).toBe(`0x00339509${"0".repeat(64)}`);
    expect(encodeGetAgentWallet("255")).toBe(`0x00339509${"0".repeat(62)}ff`);
    for (const bad of ["", "-1", "1.5", "0x7", "07", "abc", " 7", "1".repeat(79), String(2n ** 256n)]) expect(encodeGetAgentWallet(bad), bad).toBeNull();
  });

  it("reads an answer as a wallet in lower case, as none for the zero address, or as not an answer for anything else", () => {
    expect(decodeAgentWallet(word(WALLET))).toEqual({ kind: "wallet", address: WALLET });
    expect(decodeAgentWallet(word(WALLET.toUpperCase().replace("0X", "0x")))).toEqual({ kind: "wallet", address: WALLET });
    expect(decodeAgentWallet(word(ZERO))).toEqual({ kind: "none" });
    // An empty answer is a node with no code at the address or a broken one, never an agent with no wallet.
    const bad = [undefined, null, 5, "", "0x", "0x1234", `${word(WALLET)}00`, `0x${"f".repeat(64)}`, `0x${"1".repeat(24)}${WALLET.slice(2)}`, `0x${"g".repeat(64)}`];
    for (const answer of bad) expect(decodeAgentWallet(answer), String(answer)).toEqual({ kind: "bad" });
  });
});

describe("reading an agent's wallet from its registry", () => {
  it("asks the registry of the chain, at the latest block, and returns the wallet it holds", async () => {
    const calls: unknown[][] = [];
    const call: EvmCall = async (chainId, method, params) => {
      calls.push([chainId, method, params]);
      return { revert: false, result: word(WALLET) };
    };
    expect(await readAgentWallet(call, CHAIN, "7")).toEqual({ status: "held", wallet: WALLET });
    expect(calls).toEqual([[8453, "eth_call", [{ to: REGISTRY, data: encodeGetAgentWallet("7") }, "latest"]]]);
  });

  it("answers none for the zero address: an agent whose wallet was cleared or never set, and an id nobody registered", async () => {
    const call: EvmCall = async () => ({ revert: false, result: word(ZERO) });
    expect(await readAgentWallet(call, CHAIN, "7")).toEqual({ status: "none" });
  });

  it("never turns a read that failed into none: a revert, an outage, any other error and an answer that is no address are each not read, with a fixed reason", async () => {
    const cases: Array<[string, EvmCall, string]> = [
      ["a revert", async () => ({ revert: true }), WALLET_NOT_READ.noAnswer],
      ["an outage", async () => { throw new ChainUnavailableError(); }, WALLET_NOT_READ.chain],
      ["another error", async () => { throw new Error("boom at https://node.example/secret-key"); }, WALLET_NOT_READ.chain],
      ["an empty answer", async () => ({ revert: false, result: "0x" }), WALLET_NOT_READ.badAnswer],
      ["a short answer", async () => ({ revert: false, result: "0x1234" }), WALLET_NOT_READ.badAnswer],
    ];
    for (const [name, call, reason] of cases) {
      const read = await readAgentWallet(call, CHAIN, "7");
      expect(read, name).toEqual({ status: "not_read", reason });
      expect(JSON.stringify(read), name).not.toMatch(/node\.example|secret-key/);
    }
  });

  it("does not call the chain for an id that cannot be a token id", async () => {
    let called = false;
    const call: EvmCall = async () => {
      called = true;
      return { revert: false, result: word(WALLET) };
    };
    expect(await readAgentWallet(call, CHAIN, "not an id")).toEqual({ status: "not_read", reason: WALLET_NOT_READ.badId });
    expect(called).toBe(false);
  });
});

describe("a caller's reads", () => {
  const T0 = 1_800_000_000_000;
  let reads = 0;
  let answer: () => ReturnType<EvmCall> = async () => ({ revert: false, result: word(WALLET) });
  const call: EvmCall = async () => {
    reads += 1;
    return answer();
  };
  beforeEach(() => {
    resetWalletCache();
    resetRateLimits();
    reads = 0;
    answer = async () => ({ revert: false, result: word(WALLET) });
  });

  it("keeps a wallet and a none for 30 seconds, so repeated checks of one agent cost one read, and reads again after that", async () => {
    expect(await readAgentWalletForCaller(call, CHAIN, "7", "a", T0)).toEqual({ status: "held", wallet: WALLET, readAt: T0 });
    // A kept answer says when it was read.
    expect(await readAgentWalletForCaller(call, CHAIN, "7", "b", T0 + WALLET_CACHE_MS - 1)).toEqual({ status: "held", wallet: WALLET, readAt: T0 });
    expect(reads).toBe(1);
    answer = async () => ({ revert: false, result: word(ZERO) });
    expect(await readAgentWalletForCaller(call, CHAIN, "7", "a", T0 + WALLET_CACHE_MS)).toEqual({ status: "none", readAt: T0 + WALLET_CACHE_MS });
    expect(await readAgentWalletForCaller(call, CHAIN, "7", "a", T0 + WALLET_CACHE_MS + 1)).toEqual({ status: "none", readAt: T0 + WALLET_CACHE_MS });
    expect(reads).toBe(2);
    // Another agent, another chain and another registry are each a read of their own.
    await readAgentWalletForCaller(call, CHAIN, "8", "a", T0 + WALLET_CACHE_MS);
    await readAgentWalletForCaller(call, { ...CHAIN, chainId: 1 }, "7", "a", T0 + WALLET_CACHE_MS);
    await readAgentWalletForCaller(call, { ...CHAIN, registry: WALLET }, "7", "a", T0 + WALLET_CACHE_MS);
    expect(reads).toBe(5);
  });

  it("does not keep a read that was not made, so the next check asks again", async () => {
    answer = async () => {
      throw new ChainUnavailableError();
    };
    expect(await readAgentWalletForCaller(call, CHAIN, "7", "a", T0)).toEqual({ status: "not_read", reason: WALLET_NOT_READ.chain });
    answer = async () => ({ revert: false, result: word(WALLET) });
    expect(await readAgentWalletForCaller(call, CHAIN, "7", "a", T0 + 1)).toMatchObject({ status: "held", wallet: WALLET });
    expect(reads).toBe(2);
  });

  it("holds one caller to its reads a minute without asking the chain, leaves other callers alone, and still gives a kept answer", async () => {
    for (let index = 0; index < PAY_TO_READS_PER_CALLER_PER_MINUTE; index += 1) await readAgentWalletForCaller(call, CHAIN, String(index), "a", T0);
    expect(reads).toBe(PAY_TO_READS_PER_CALLER_PER_MINUTE);
    expect(await readAgentWalletForCaller(call, CHAIN, "999", "a", T0)).toEqual({ status: "not_read", reason: WALLET_NOT_READ.chain });
    expect(reads).toBe(PAY_TO_READS_PER_CALLER_PER_MINUTE);
    expect(await readAgentWalletForCaller(call, CHAIN, "0", "a", T0)).toMatchObject({ status: "held", wallet: WALLET });
    expect(await readAgentWalletForCaller(call, CHAIN, "999", "b", T0)).toMatchObject({ status: "held", wallet: WALLET });
    expect(await readAgentWalletForCaller(call, CHAIN, "1000", "a", T0 + 60_000)).toMatchObject({ status: "held", wallet: WALLET });
  });
});
