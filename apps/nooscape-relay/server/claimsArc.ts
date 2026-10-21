import { arcRpcHost } from "./arcRpc";
import { assertPublicHostname } from "./ingestion/a2a";
import { ARC_CHAIN } from "./ingestion/erc8004Chains";
import { callRpc, resolveRpcUrl } from "./ingestion/erc8004Rpc";

/**
 * One read on Arc's node for the claim flow (docs/arc-claims-2026-10-20.md): the same node the identity pass reads, which is the
 * operator's own and is reached through `X402_RPC` (server/arcRpc.ts). The client is the pass's, with its timeout, its response cap and
 * its rule that nothing it throws can hold the address, but it makes one attempt and no more: a visitor's claim is never held up
 * waiting out a retry ladder, as a Robinhood Chain read is not, and a read that fails is "try again" to the visitor.
 *
 * A claim decides who owns an agent from what this node says, so the node is held to more than the pass holds it to, where the pass
 * has a source row and a run to check it against:
 *  - it must answer as Arc (`eth_chainId`), because `X402_RPC` is also the payment code's setting and the registry has the same
 *    address on every chain it runs on, so a node for another chain would answer for another chain's token;
 *  - it must be at the chain's head, because a node that is resyncing or was restored from an older copy answers from the past, and a
 *    token that was minted or sold since would read as gone or as its old owner's;
 *  - it must resolve to a public address, as the pass requires before every run.
 * Any of these failing is an outage ("try again"), never an answer. Each check's failure is a fixed text, so nothing the node says can
 * reach a caller and none of it can be read as a revert.
 *
 * The address may carry a key. Nothing here puts it, or any part of it, in an error or a log line.
 */
const ARC_ONE_ATTEMPT = { ...ARC_CHAIN, rpc: { ...ARC_CHAIN.rpc, backoffMs: [] as readonly number[] } };

/** How long it is remembered that the node is public and answers as Arc, and that it is at the head. */
const NODE_CHECKED_FOR_MS = 10 * 60_000;
const HEAD_CHECKED_FOR_MS = 60_000;
/** A node whose latest block is older than this is behind. Arc's blocks come about every half second and are final at once. */
const HEAD_MAX_AGE_SECONDS = 10 * 60;

/**
 * The most gas an `eth_call` may use. The only thing a visitor chooses to run is a contract wallet's `isValidSignature` (EIP-1271), and a
 * wallet that burns what it is given would otherwise use all the node allows; `ownerOf` on the registry needs far less.
 */
const OWNER_OF_SELECTOR = "0x6352211e";
const OWNER_OF_GAS = "0x30d40";
const OTHER_CALL_GAS = "0x2dc6c0";

let nodeChecked: { host: string; at: number } | null = null;
let headChecked: number | null = null;

/** Forgets what was checked, for a test. */
export function forgetCheckedArcNode(): void {
  nodeChecked = null;
  headChecked = null;
}

const unusable = (why: string) => new Error(`Arc's node ${why}.`);

async function assertNodeIsArc(host: string, url: string, now: number): Promise<void> {
  if (nodeChecked && nodeChecked.host === host && now - nodeChecked.at < NODE_CHECKED_FOR_MS) return;
  await assertPublicHostname(host);
  let id: unknown;
  try {
    id = await callRpc(ARC_ONE_ATTEMPT, "eth_chainId", [], { url });
  } catch {
    throw unusable("could not be asked for its chain id");
  }
  if (typeof id !== "string" || id.toLowerCase() !== ARC_CHAIN.chainIdHex) throw unusable("did not answer as Arc");
  nodeChecked = { host, at: now };
}

async function assertHeadIsFresh(url: string, now: number): Promise<void> {
  if (headChecked !== null && now - headChecked < HEAD_CHECKED_FOR_MS) return;
  let block: unknown;
  try {
    block = await callRpc(ARC_ONE_ATTEMPT, "eth_getBlockByNumber", ["latest", false], { url });
  } catch {
    throw unusable("could not be asked for its latest block");
  }
  const stamp = block && typeof block === "object" ? (block as { timestamp?: unknown }).timestamp : null;
  const seconds = typeof stamp === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(stamp) ? Number.parseInt(stamp.slice(2), 16) : Number.NaN;
  if (!Number.isSafeInteger(seconds) || now / 1000 - seconds > HEAD_MAX_AGE_SECONDS) throw unusable("is behind");
  headChecked = now;
}

/** The params of an `eth_call` with the gas it may use, unless the caller set one. Any other call is as it came. */
function withGas(method: string, params: unknown[]): unknown[] {
  const [call, ...rest] = params;
  if (method !== "eth_call" || !call || typeof call !== "object" || Array.isArray(call) || "gas" in call) return params;
  const data = (call as { data?: unknown }).data;
  const gas = typeof data === "string" && data.toLowerCase().startsWith(OWNER_OF_SELECTOR) ? OWNER_OF_GAS : OTHER_CALL_GAS;
  return [{ ...(call as Record<string, unknown>), gas }, ...rest];
}

/**
 * One JSON-RPC call on Arc's node: its result, or the client's own failure (whose text carries no address). Throws, in fixed words,
 * when the node is not configured, is not public, does not answer as Arc or is behind.
 */
export async function callArcRpcOnce(method: string, params: unknown[]): Promise<unknown> {
  const host = arcRpcHost();
  if (host === null) throw new Error("Arc's node is not configured.");
  const url = resolveRpcUrl(ARC_ONE_ATTEMPT, host);
  const now = Date.now();
  await assertNodeIsArc(host, url, now);
  await assertHeadIsFresh(url, now);
  return callRpc(ARC_ONE_ATTEMPT, method, withGas(method, params), { url });
}
