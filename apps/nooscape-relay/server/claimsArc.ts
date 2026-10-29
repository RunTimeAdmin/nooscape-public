import { arcRpcHost } from "./arcRpc";
import { makeClaimNode } from "./claimsNode";
import { ARC_CHAIN } from "./ingestion/erc8004Chains";
import { resolveRpcUrl } from "./ingestion/erc8004Rpc";

/**
 * One read on Arc's node for the claim flow (docs/arc-claims-2026-10-20.md): the same node the identity pass reads, which is the
 * operator's own and is reached through `X402_RPC` (server/arcRpc.ts). The checks it is held to (a public host that answers as Arc and
 * is at the head), the one attempt and the gas limits are claimsNode.ts's, shared with Base and Ethereum. What is Arc's is where the
 * address comes from: it is read as the pass and the payment code read it, trimmed, https only, and the host is checked to be public
 * because it is the operator's own and not a vendor's pinned one.
 *
 * The address may carry a key. Nothing here puts it, or any part of it, in an error or a log line.
 */
const arcNode = makeClaimNode({
  chain: ARC_CHAIN,
  name: "Arc",
  locate: () => {
    const host = arcRpcHost();
    return host === null ? null : { host, url: resolveRpcUrl(ARC_CHAIN, host) };
  },
  checkHostIsPublic: true,
});

/**
 * One JSON-RPC call on Arc's node: its result, or the client's own failure (whose text carries no address). Throws, in fixed words,
 * when the node is not configured, is not public, does not answer as Arc or is behind.
 */
export const callArcRpcOnce = arcNode.call;

/** Forgets what was checked, for a test. */
export const forgetCheckedArcNode = arcNode.forget;
