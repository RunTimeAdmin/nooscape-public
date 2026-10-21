import { ERC8004_CHAINS } from "./erc8004Chains";
import { ROBINHOOD_HANDOUT_BLOCK_WINDOW } from "./robinhood";

/**
 * Per-chain facts for the EVM ERC-8004 identity registries, keyed by the protocol of the source that reads them. Every chain
 * deploys the same registry (same address, same event shapes), so the walks share their decoding, but block cadence differs
 * from chain to chain, so anything measured in blocks must come from here and never from a Robinhood constant.
 *
 * `handoutBlockWindow` is the block-proxied hour behind the hand-out rule (a secondary Transfer from the minting wallet inside
 * the mint hour is a platform hand-out, a chain fact about timing only). Robinhood Chain runs at about 0.101 s per block
 * (36,000 blocks). The chains read by the one chain pass (erc8004Chains.ts) each carry their own measured window, and this
 * map takes them from there, so a chain added to that list is known here with no further line.
 */
export type EvmIdentityChain = { chainId: number; label: string; handoutBlockWindow: number };

export const EVM_IDENTITY_CHAINS: Readonly<Record<string, EvmIdentityChain>> = {
  erc8004: { chainId: 4663, label: "Robinhood Chain", handoutBlockWindow: ROBINHOOD_HANDOUT_BLOCK_WINDOW },
  ...Object.fromEntries(ERC8004_CHAINS.map(chain => [chain.protocol, { chainId: chain.chainId, label: chain.label, handoutBlockWindow: chain.handoutBlockWindow }])),
};

/** The chain facts for a source protocol, or null when the protocol is not an EVM identity registry. */
export function evmIdentityChain(protocol: string): EvmIdentityChain | null {
  return Object.prototype.hasOwnProperty.call(EVM_IDENTITY_CHAINS, protocol) ? EVM_IDENTITY_CHAINS[protocol]! : null;
}
