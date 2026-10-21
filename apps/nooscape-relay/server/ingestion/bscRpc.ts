import { ENV } from "../_core/env";
import { BSC_ALLOWED_HOSTNAME } from "./bscChain";
import { BSC_CHAIN } from "./erc8004Chains";
import { callRpc, resolveRpcUrl } from "./erc8004Rpc";

/**
 * The BNB Smart Chain view of the identity pass's RPC client.
 *
 * The client is one implementation for every chain (erc8004Rpc.ts), driven by the chain's entry in erc8004Chains.ts. The
 * provider endpoint (NodeReal) carries the account key in its URL path, so the URL lives only in `BSC_RPC_URL` and nothing the
 * client throws, and nothing derived from a provider response, can contain it. This file gives the BNB Chain's entry its
 * long-standing names; the error classes are the same classes every chain's client throws, named for the chain when thrown.
 */

export {
  Erc8004RpcError as BscRpcError,
  Erc8004RpcHttpError as BscRpcHttpError,
  Erc8004RpcNotConfiguredError as BscRpcNotConfiguredError,
  Erc8004RpcRangeError as BscRpcRangeError,
  scrubProviderText,
} from "./erc8004Rpc";

/** A dense 50,000-block window measured 1.9 MB; 8 MiB is generous headroom, not a target. */
export const BSC_MAX_RESPONSE_BYTES = BSC_CHAIN.rpc.maxResponseBytes;

/**
 * The endpoint to call. It must be configured, https, free of credentials in
 * the userinfo position, and its host must be exactly the approved source's
 * allowed hostname, so changing the variable can never redirect the pass to a
 * host nobody approved. The returned string is secret and is passed straight to
 * the request; it is never logged or thrown.
 */
export function resolveBscRpcUrl(allowedHostname: string = BSC_ALLOWED_HOSTNAME, configured: string = ENV.bscRpcUrl): string {
  return resolveRpcUrl(BSC_CHAIN, allowedHostname, configured);
}

/**
 * One JSON-RPC call with a short transient-retry ladder (HTTP 429 and 5xx:
 * 1 s then 3 s). Every wire attempt is reported so the run's request count
 * stays honest. `url`, `sleep` and `countAttempt` are injectable for tests.
 */
export function callBscRpc(
  method: string,
  params: unknown[],
  options: { url?: string; countAttempt?: () => void; sleep?: (ms: number) => Promise<void> } = {}
): Promise<unknown> {
  return callRpc(BSC_CHAIN, method, params, options);
}
