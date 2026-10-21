import { extraChainsOn, type ExtraChainKey } from "@shared/chains";
import { BSC_CHAIN_ID, BSC_IDENTITY_REGISTRY } from "./ingestion/bscChain";
import { ARC_CHAIN, BASE_CHAIN, ETHEREUM_CHAIN, type Erc8004Chain } from "./ingestion/erc8004Chains";
import { ROBINHOOD_IDENTITY_REGISTRY, ROBINHOOD_REGISTRY_CHAIN } from "./ingestion/robinhood";

/**
 * The chains the REST API covers and how an agent is named on each. Kept apart from the router so the webhook pass can name an agent the
 * way the API does without importing the router.
 */

const DECIMAL_ID = /^(0|[1-9]\d{0,77})$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type ApiChain = "robinhood" | "bnb" | "solana" | ExtraChainKey;

type ApiChainTable = { protocols: readonly string[]; chainId: number | null; registry: string | null; idPattern: RegExp; keyOf: (id: string) => string };

/** An EVM identity registry read by the chain pass: its protocol, chain id and registry address, and the key an agent is stored under. */
const chainPassTable = (chain: Erc8004Chain): ApiChainTable => ({
  protocols: [chain.protocol],
  chainId: chain.chainId,
  registry: chain.identityRegistry,
  idPattern: DECIMAL_ID,
  keyOf: id => `eip155:${chain.chainId}:${chain.identityRegistry}:${id}`,
});

/** Every chain the API can name, the registries behind each, and what an id on each looks like. A chain with no registry here is not served. */
export const API_CHAINS: Record<ApiChain, ApiChainTable> = {
  robinhood: {
    protocols: ["erc8004"],
    chainId: ROBINHOOD_REGISTRY_CHAIN.chainId,
    registry: ROBINHOOD_IDENTITY_REGISTRY,
    idPattern: DECIMAL_ID,
    keyOf: id => `eip155:${ROBINHOOD_REGISTRY_CHAIN.chainId}:${ROBINHOOD_IDENTITY_REGISTRY}:${id}`,
  },
  bnb: {
    protocols: ["erc8004_bsc"],
    chainId: BSC_CHAIN_ID,
    registry: BSC_IDENTITY_REGISTRY,
    idPattern: DECIMAL_ID,
    keyOf: id => `eip155:${BSC_CHAIN_ID}:${BSC_IDENTITY_REGISTRY}:${id}`,
  },
  solana: { protocols: ["solana_8004", "solana_said", "solana_registry"], chainId: null, registry: null, idPattern: BASE58, keyOf: id => id },
  ethereum: chainPassTable(ETHEREUM_CHAIN),
  base: chainPassTable(BASE_CHAIN),
  arc: chainPassTable(ARC_CHAIN),
};

/**
 * The three chains the API has always served, which need no switch. What is served now is {@link servedChains}: these, and each extra
 * chain whose switch is on. The watchlist and the webhook follow it (docs/arc-watch-2026-10-20.md), so an event for a listing on an
 * extra chain is sent only while its switch is on.
 */
export const CHAIN_KEYS: readonly ApiChain[] = ["robinhood", "bnb", "solana"];

/**
 * The chains the API serves under this switch list (shared/features.ts): the three above, then each of Ethereum, Base and Arc that is
 * on. The list is read as the server runs, so a request sees the switches as they are now; with all three off it is {@link CHAIN_KEYS}.
 */
export function servedChains(features: string | undefined = process.env.VITE_FEATURES): readonly ApiChain[] {
  const extra = extraChainsOn(features);
  return extra.length === 0 ? CHAIN_KEYS : [...CHAIN_KEYS, ...extra];
}

/** The API's chain name for a directory protocol among the chains given, or null for a protocol the API does not serve there. */
export function apiChainOfProtocol(protocol: string, chains: readonly ApiChain[] = CHAIN_KEYS): ApiChain | null {
  return chains.find(chain => API_CHAINS[chain].protocols.includes(protocol)) ?? null;
}

/** The agent's id on its registry, from the key the directory stores it under: the token id on an EVM registry, the address on Solana. */
export function agentIdOfKey(chain: ApiChain, externalKey: string): string {
  return chain === "solana" ? externalKey : (externalKey.split(":")[3] ?? externalKey);
}
