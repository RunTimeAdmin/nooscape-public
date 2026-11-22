import { makeClaimNode } from "./claimsNode";
import { isExtraChainKey } from "@shared/chains";
import { ERC8004_CHAINS, type PinnedErc8004Chain } from "./ingestion/erc8004Chains";
import { resolveRpcUrl } from "./ingestion/erc8004Rpc";

/**
 * One read on Base's node, one on Ethereum's, one on Monad's, one on Gnosis's and one on Celo's for the claim flow (docs/base-ethereum-claims-2026-10-28.md, docs/monad-claims-2026-11-01.md,
 * docs/gnosis-claims-2026-11-06.md, docs/celo-claims-2026-11-20.md): the endpoint the chain's identity pass reads, `BASE_RPC_URL` (Alchemy), `ETH_RPC_URL` (NodeReal), `MONAD_RPC_URL` (Alchemy), `GNOSIS_RPC_URL` (Alchemy) and `CELO_RPC_URL` (the Celo Foundation's public node, which takes no key). The checks they are held to (answering as the chain, being
 * at the head), the one attempt and the gas limits are claimsNode.ts's, shared with Arc.
 *
 * Each address is read as the pass reads it: it must be set, an https address with no userinfo, and its host must be exactly the host
 * the chain's entry pins (`resolveRpcUrl`), so changing the variable can never send a claim's reads to a host nobody approved. A vendor's
 * host is public and pinned in the code, so it is not checked to be public again. An address that is not usable is "not configured", in
 * fixed words, and never an answer.
 *
 * The address carries a key (Celo's public node takes none, but the address is held the same way). Nothing here puts it, or any part of it, in an error or a log line.
 */
const pinnedNode = (chain: PinnedErc8004Chain, name: string) =>
  makeClaimNode({
    chain,
    name,
    locate: () => {
      let url: string;
      try {
        url = resolveRpcUrl(chain);
      } catch {
        return null;
      }
      return { host: new URL(url).hostname.toLowerCase(), url };
    },
    checkHostIsPublic: false,
  });

/** One node for each extra chain whose host is pinned in its entry: every extra chain but Arc, which reads the operator's own node (claimsArc.ts). */
const nodes = new Map(
  ERC8004_CHAINS.filter((chain): chain is PinnedErc8004Chain => chain.provider.kind === "pinned" && isExtraChainKey(chain.chainKey)).map(chain => [chain.chainId, pinnedNode(chain, chain.chainLabel)] as const)
);

/** The chain ids that have a pinned node here. */
export const PINNED_CLAIM_CHAIN_IDS: readonly number[] = Array.from(nodes.keys());

/**
 * One JSON-RPC call on the node of one of those chains: its result, or the client's own failure. Throws, in fixed words, for a chain with
 * no pinned node, or when the node is not configured, does not answer as its chain or is behind.
 */
export function callPinnedRpcOnce(chainId: number, method: string, params: unknown[]): Promise<unknown> {
  const node = nodes.get(chainId);
  if (!node) return Promise.reject(new Error("That chain has no pinned node."));
  return node.call(method, params);
}

/** Forgets what was checked on every node, for a test. */
export function forgetCheckedPinnedNodes(): void {
  nodes.forEach(node => node.forget());
}
