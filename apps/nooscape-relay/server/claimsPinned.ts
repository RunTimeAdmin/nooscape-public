import { makeClaimNode } from "./claimsNode";
import { BASE_CHAIN, ETHEREUM_CHAIN, type PinnedErc8004Chain } from "./ingestion/erc8004Chains";
import { resolveRpcUrl } from "./ingestion/erc8004Rpc";

/**
 * One read on Base's node and one on Ethereum's for the claim flow (docs/base-ethereum-claims-2026-10-28.md): the endpoint the chain's
 * identity pass reads, `BASE_RPC_URL` (Alchemy) and `ETH_RPC_URL` (NodeReal). The checks they are held to (answering as the chain, being
 * at the head), the one attempt and the gas limits are claimsNode.ts's, shared with Arc.
 *
 * Each address is read as the pass reads it: it must be set, an https address with no userinfo, and its host must be exactly the host
 * the chain's entry pins (`resolveRpcUrl`), so changing the variable can never send a claim's reads to a host nobody approved. A vendor's
 * host is public and pinned in the code, so it is not checked to be public again. An address that is not usable is "not configured", in
 * fixed words, and never an answer.
 *
 * The address carries a key. Nothing here puts it, or any part of it, in an error or a log line.
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

const baseNode = pinnedNode(BASE_CHAIN, "Base");
const ethereumNode = pinnedNode(ETHEREUM_CHAIN, "Ethereum");

/** One JSON-RPC call on Base's node: its result, or the client's own failure. Throws, in fixed words, when the node is not configured, does not answer as Base or is behind. */
export const callBaseRpcOnce = baseNode.call;
/** One JSON-RPC call on Ethereum's node, as above. */
export const callEthereumRpcOnce = ethereumNode.call;

/** Forgets what was checked on both nodes, for a test. */
export function forgetCheckedPinnedNodes(): void {
  baseNode.forget();
  ethereumNode.forget();
}
