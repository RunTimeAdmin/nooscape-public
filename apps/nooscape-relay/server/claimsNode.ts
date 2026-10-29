import { assertPublicHostname } from "./ingestion/a2a";
import type { Erc8004Chain } from "./ingestion/erc8004Chains";
import { callRpc } from "./ingestion/erc8004Rpc";

/**
 * One read on an EVM chain's node for the claim flow (docs/arc-claims-2026-10-20.md, docs/base-ethereum-claims-2026-10-28.md): the same
 * node the chain's identity pass reads, called once with no retry ladder, held to what a claim needs of it, given a gas limit for what a
 * visitor can make it run, and never named in what is thrown. Arc, Base and Ethereum each have one of these (claimsArc.ts and
 * claimsPinned.ts say how each finds its address).
 *
 * The pass retries a busy node three times over seconds. A visitor waiting on a claim should not, so a node here is the pass's client
 * with its ladder emptied: a read that fails is "try again" to the visitor and never a verdict on a claim.
 *
 * A claim decides who owns an agent from what this node says, so the node is held to more than the pass holds it to, where the pass has
 * a source row and a run to check it against:
 *  - when it is the operator's own, it must resolve to a public address, as the pass requires before every run (a vendor's host is
 *    pinned in the code and needs no such check);
 *  - it must answer as the chain (`eth_chainId`), because the registry has the same address on every chain it runs on, so a node for
 *    another chain would answer for another chain's token;
 *  - it must be at the chain's head, because a node that is resyncing or was restored from an older copy answers from the past, and a
 *    token that was minted or sold since would read as gone or as its old owner's. How old the head is comes from this server's clock, so
 *    a latest block dated well ahead of it is refused too: one of the two clocks is wrong and the age cannot be told. And a check is
 *    remembered by that clock, so one that appears to have been made in the future, because the clock has gone back, does not count.
 * Any of these failing is an outage ("try again"), never an answer. Each check's failure is a fixed text, so nothing the node says can
 * reach a caller and none of it can be read as a revert.
 *
 * The address may carry a key. Nothing here puts it, or any part of it, in an error or a log line.
 */
export type ClaimNodeOptions = {
  /** The chain's entry in server/ingestion/erc8004Chains.ts. Its retry ladder is emptied here. */
  chain: Erc8004Chain;
  /** What the node is called in a message: "Arc", "Base", "Ethereum". */
  name: string;
  /** The node's host and address, or null when it is not configured. The address is secret: it may carry a key. */
  locate: () => { host: string; url: string } | null;
  /** Whether the host is checked to be public before it is used: true for an operator's own node, false for a vendor's pinned one. */
  checkHostIsPublic: boolean;
};

/** How long it is remembered that the node is public and answers as the chain, and that it is at the head. */
const NODE_CHECKED_FOR_MS = 10 * 60_000;
const HEAD_CHECKED_FOR_MS = 60_000;
/** A node whose latest block is older than this is behind. The chains read here make a block every 12 seconds at the slowest and are final within minutes. */
const HEAD_MAX_AGE_SECONDS = 10 * 60;
/** A latest block dated more than this ahead of this server's clock is not believed. A real block is a second or two ahead at most; two minutes cover a clock that is a little slow. */
const HEAD_MAX_AHEAD_SECONDS = 2 * 60;

/**
 * Whether a check made at `at` still stands at `now`. One made later than now, because the clock has gone back since, stands for nothing:
 * how long ago it was cannot be told, so it is made again (and is remembered from the new time).
 */
const stillStands = (at: number, now: number, forMs: number) => now >= at && now - at < forMs;

/**
 * The most gas an `eth_call` may use. The only thing a visitor chooses to run is a contract wallet's `isValidSignature` (EIP-1271), and a
 * wallet that burns what it is given would otherwise use all the node allows; `ownerOf` on the registry needs far less.
 */
const OWNER_OF_SELECTOR = "0x6352211e";
const OWNER_OF_GAS = "0x30d40";
const OTHER_CALL_GAS = "0x2dc6c0";

/** The params of an `eth_call` with the gas it may use, unless the caller set one. Any other call is as it came. */
function withGas(method: string, params: unknown[]): unknown[] {
  const [call, ...rest] = params;
  if (method !== "eth_call" || !call || typeof call !== "object" || Array.isArray(call) || "gas" in call) return params;
  const data = (call as { data?: unknown }).data;
  const gas = typeof data === "string" && data.toLowerCase().startsWith(OWNER_OF_SELECTOR) ? OWNER_OF_GAS : OTHER_CALL_GAS;
  return [{ ...(call as Record<string, unknown>), gas }, ...rest];
}

export function makeClaimNode(options: ClaimNodeOptions): { call: (method: string, params: unknown[]) => Promise<unknown>; forget: () => void } {
  const { name, locate, checkHostIsPublic } = options;
  const chain: Erc8004Chain = { ...options.chain, rpc: { ...options.chain.rpc, backoffMs: [] as readonly number[] } };
  let nodeChecked: { host: string; at: number } | null = null;
  let headChecked: { host: string; at: number } | null = null;

  const unusable = (why: string) => new Error(`${name}'s node ${why}.`);

  async function assertNodeIsTheChain(host: string, url: string, now: number): Promise<void> {
    if (nodeChecked && nodeChecked.host === host && stillStands(nodeChecked.at, now, NODE_CHECKED_FOR_MS)) return;
    if (checkHostIsPublic) await assertPublicHostname(host);
    let id: unknown;
    try {
      id = await callRpc(chain, "eth_chainId", [], { url });
    } catch {
      throw unusable("could not be asked for its chain id");
    }
    if (typeof id !== "string" || id.toLowerCase() !== chain.chainIdHex) throw unusable(`did not answer as ${name}`);
    nodeChecked = { host, at: now };
  }

  async function assertHeadIsFresh(host: string, url: string, now: number): Promise<void> {
    if (headChecked && headChecked.host === host && stillStands(headChecked.at, now, HEAD_CHECKED_FOR_MS)) return;
    let block: unknown;
    try {
      block = await callRpc(chain, "eth_getBlockByNumber", ["latest", false], { url });
    } catch {
      throw unusable("could not be asked for its latest block");
    }
    const stamp = block && typeof block === "object" ? (block as { timestamp?: unknown }).timestamp : null;
    const seconds = typeof stamp === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(stamp) ? Number.parseInt(stamp.slice(2), 16) : Number.NaN;
    if (!Number.isSafeInteger(seconds) || now / 1000 - seconds > HEAD_MAX_AGE_SECONDS) throw unusable("is behind");
    if (seconds - now / 1000 > HEAD_MAX_AHEAD_SECONDS) throw unusable("has a latest block dated ahead of this server's clock");
    headChecked = { host, at: now };
  }

  return {
    /**
     * One JSON-RPC call on the node: its result, or the client's own failure (whose text carries no address). Throws, in fixed words,
     * when the node is not configured, is not public, does not answer as the chain or is behind.
     */
    async call(method, params) {
      const node = locate();
      if (node === null) throw new Error(`${name}'s node is not configured.`);
      const now = Date.now();
      await assertNodeIsTheChain(node.host, node.url, now);
      await assertHeadIsFresh(node.host, node.url, now);
      return callRpc(chain, method, withGas(method, params), { url: node.url });
    },
    /** Forgets what was checked, for a test. */
    forget() {
      nodeChecked = null;
      headChecked = null;
    },
  };
}
