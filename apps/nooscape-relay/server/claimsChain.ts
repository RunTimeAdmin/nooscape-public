import { arcClaimsOn, baseClaimsOn, ethereumClaimsOn } from "@shared/features";
import { callArcRpcOnce } from "./claimsArc";
import { callBaseRpcOnce, callEthereumRpcOnce } from "./claimsPinned";
import { BscRpcError, callBscRpc } from "./ingestion/bscRpc";
import { BSC_CHAIN_ID, BSC_IDENTITY_REGISTRY } from "./ingestion/bscChain";
import { bscReadBucket, BSC_CU } from "./ingestion/bscBudget";
import { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN } from "./ingestion/erc8004Chains";
import { callRobinhoodRpcOnce, ROBINHOOD_IDENTITY_REGISTRY, ROBINHOOD_REGISTRY_CHAIN } from "./ingestion/robinhood";
import { decodeOwnerOf, encodeIsValidSignature, encodeOwnerOf, isValidSignatureAnswer } from "./claimsCrypto";
import { consumeRateLimit } from "./rateLimit";

/**
 * What a claim reads from a chain (docs/claims-2026-10-18.md), and nothing else: who the registry says owns an agent now
 * (`ownerOf`), whether an address is a contract, and whether a contract wallet accepts a signature (EIP-1271). Three read-only
 * `eth_call` and `eth_getCode` requests through the paced clients the passes already use: a BNB Chain read spends from the same
 * compute-unit bucket as the worker's own reads, and a Robinhood Chain, Arc, Base or Ethereum read is one attempt with no retry ladder, so a visitor
 * never waits out a throttle. It asks for no transaction, holds no key and sends nothing.
 */

export type ClaimChain = { protocol: "erc8004" | "erc8004_bsc" | "erc8004_arc" | "erc8004_base" | "erc8004_eth"; chainId: number; registry: string; label: string };

/** The EVM registries a claim can be made on. A directory entry of any other protocol cannot be claimed here. Arc's, Base's and Ethereum's count only while their claims are switched on. */
export const CLAIM_CHAINS: Record<ClaimChain["protocol"], ClaimChain> = {
  erc8004: { protocol: "erc8004", chainId: ROBINHOOD_REGISTRY_CHAIN.chainId, registry: ROBINHOOD_IDENTITY_REGISTRY, label: "Robinhood Chain" },
  erc8004_bsc: { protocol: "erc8004_bsc", chainId: BSC_CHAIN_ID, registry: BSC_IDENTITY_REGISTRY, label: "BNB Smart Chain" },
  erc8004_arc: { protocol: "erc8004_arc", chainId: ARC_CHAIN.chainId, registry: ARC_CHAIN.identityRegistry, label: "Arc" },
  erc8004_base: { protocol: "erc8004_base", chainId: BASE_CHAIN.chainId, registry: BASE_CHAIN.identityRegistry, label: "Base" },
  erc8004_eth: { protocol: "erc8004_eth", chainId: ETHEREUM_CHAIN.chainId, registry: ETHEREUM_CHAIN.identityRegistry, label: "Ethereum" },
};

/** The registries claimable now, in the order the words name them: each extra chain's only while its own switch and its claims switch are both on in the list. */
export const claimableChains = (features: string | undefined = process.env.VITE_FEATURES): ClaimChain[] => [
  CLAIM_CHAINS.erc8004,
  CLAIM_CHAINS.erc8004_bsc,
  ...(arcClaimsOn(features) ? [CLAIM_CHAINS.erc8004_arc] : []),
  ...(baseClaimsOn(features) ? [CLAIM_CHAINS.erc8004_base] : []),
  ...(ethereumClaimsOn(features) ? [CLAIM_CHAINS.erc8004_eth] : []),
];

export const claimChainOf = (protocol: string, features: string | undefined = process.env.VITE_FEATURES): ClaimChain | null => claimableChains(features).find(chain => chain.protocol === protocol) ?? null;

/** A read that cannot be answered now (the node is down, throttled or too slow). Its text is fixed and carries no address and no URL. */
export class ChainUnavailableError extends Error {
  constructor() {
    super("The chain could not be read right now.");
    this.name = "ChainUnavailableError";
  }
}

/** One JSON-RPC call on a chain: its result, or a `revert` when the call ran and reverted. Anything else that goes wrong throws ChainUnavailableError. */
export type EvmCall = (chainId: number, method: "eth_call" | "eth_getCode", params: unknown[]) => Promise<{ revert: true } | { revert: false; result: unknown }>;

/**
 * What a node says when a call ran and the contract reverted: the words of the EVM, never a node's wording for a bad key, a missing
 * method or a throttle. (A custom error comes back as "execution reverted" too.) JSON-RPC code 3 is the standard code for it.
 */
const REVERT = /execution reverted|\brevert(ed)?\b/i;
const REVERT_CODE = 3;

/** A visitor's reads of one chain are held to this many a minute, so a flood of requests cannot use the compute-unit budget the worker shares. */
export const CLAIM_CHAIN_READS_PER_MINUTE = 60;

/**
 * The production call, with a revert told apart from an outage. `admit` holds a request's reads to the per-minute budget above, and
 * refuses (as an outage, "try again") rather than queue when it is spent. The worker's daily check does not take it: it is bounded by
 * the 25 claims a run, and it must not be starved by visitors, or starve them.
 */
function makeCallChain(options: { admit: boolean }): EvmCall {
  return async (chainId, method, params) => {
    try {
      if (options.admit && !consumeRateLimit(`claim-chain:${chainId}`, CLAIM_CHAIN_READS_PER_MINUTE, 60_000).allowed) throw new ChainUnavailableError();
      if (chainId === BSC_CHAIN_ID) {
        await bscReadBucket.take(BSC_CU.eth_call);
        return { revert: false, result: await callBscRpc(method, params) };
      }
      if (chainId === ROBINHOOD_REGISTRY_CHAIN.chainId) {
        const response = await callRobinhoodRpcOnce({ method, params });
        if (response.error) {
          const message = typeof response.error.message === "string" ? response.error.message : "";
          if (response.error.code === REVERT_CODE || REVERT.test(message)) return { revert: true };
          throw new ChainUnavailableError();
        }
        return { revert: false, result: response.result };
      }
      if (chainId === ARC_CHAIN.chainId) return { revert: false, result: await callArcRpcOnce(method, params) };
      if (chainId === BASE_CHAIN.chainId) return { revert: false, result: await callBaseRpcOnce(method, params) };
      if (chainId === ETHEREUM_CHAIN.chainId) return { revert: false, result: await callEthereumRpcOnce(method, params) };
      throw new ChainUnavailableError();
    } catch (error) {
      if (error instanceof ChainUnavailableError) throw error;
      // The BNB Chain and Arc clients (one class, which the BNB Chain client calls BscRpcError) word a revert as an RPC-layer failure that carries the node's own text.
      if (error instanceof BscRpcError && REVERT.test(error.message)) return { revert: true };
      throw new ChainUnavailableError();
    }
  };
}

/** For a visitor's request: held to the per-minute budget. */
export const callChain: EvmCall = makeCallChain({ admit: true });
/** For the worker's daily check. */
export const callChainForWorker: EvmCall = makeCallChain({ admit: false });

type OwnerRead = { status: "owner"; owner: string } | { status: "none" };

/**
 * The lower-case address the registry says owns the agent now, or `none` when the token does not exist (the call reverted) or the
 * registry answers the zero address. An empty answer is not "no owner": a node with no code at the address, or a broken one, answers
 * "0x", and that is an outage, so it is never taken as a token that is gone.
 */
export async function readOwnerOf(call: EvmCall, chain: ClaimChain, tokenId: string): Promise<OwnerRead> {
  const data = encodeOwnerOf(tokenId);
  if (data === null) return { status: "none" };
  const answer = await call(chain.chainId, "eth_call", [{ to: chain.registry, data }, "latest"]);
  if (answer.revert) return { status: "none" };
  if (typeof answer.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(answer.result)) throw new ChainUnavailableError();
  const owner = decodeOwnerOf(answer.result);
  return owner === null ? { status: "none" } : { status: "owner", owner };
}

/** True when the address holds contract code on the chain. */
export async function isContractAddress(call: EvmCall, chainId: number, address: string): Promise<boolean> {
  const answer = await call(chainId, "eth_getCode", [address, "latest"]);
  if (answer.revert) return false;
  return typeof answer.result === "string" && /^0x[0-9a-fA-F]+$/.test(answer.result) && answer.result.length > 2;
}

/** True when the contract wallet answers EIP-1271's magic value for this hash and signature. A reverting wallet does not accept it. */
export async function contractAcceptsSignature(call: EvmCall, chainId: number, address: string, hash: Uint8Array, signatureHex: string): Promise<boolean> {
  const answer = await call(chainId, "eth_call", [{ to: address, data: encodeIsValidSignature(hash, signatureHex) }, "latest"]);
  return !answer.revert && isValidSignatureAnswer(answer.result);
}
