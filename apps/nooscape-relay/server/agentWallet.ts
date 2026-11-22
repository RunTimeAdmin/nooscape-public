import { callChainForPayTo, ChainUnavailableError, type EvmCall } from "./claimsChain";
import { consumeRateLimit } from "./rateLimit";

/**
 * The one chain read the check's pay_to makes (docs/check-pay-to-2026-11-20.md): `getAgentWallet(agentId)` on the agent's own ERC-8004
 * identity registry. It goes through the paced clients the claims use (server/claimsChain.ts), with a per-minute budget of its own for each
 * chain so a flood of checks cannot use the claims' reads, and a BNB Chain read spends from the worker's compute-unit bucket. One `eth_call` at the latest block: no
 * transaction, no key, and nothing sent to the endpoint an agent registered.
 *
 * The registry answers the zero address for an agent with no wallet (it clears the wallet when an agent changes hands) and for an id that
 * was never registered, and it does not revert for either. So a revert is a contract that cannot answer, and a read that failed is never
 * "none".
 */

/** The selector of `getAgentWallet(uint256)`. */
const GET_AGENT_WALLET = "00339509";
const WORD_LIMIT = BigInt(1) << BigInt(256);

/** What a read that was not made says, in words that carry no address and no URL. */
export const WALLET_NOT_READ = {
  chain: new ChainUnavailableError().message,
  noAnswer: "The registry did not answer that call.",
  badAnswer: "The registry's answer was not an address.",
  badId: "That is not an agent id.",
} as const;

/** What an agent's registry holds for it: a wallet, none, or a read that was not made. `readAt` (ms) is when a kept answer was read; without it, the read is now. */
export type WalletRead = { status: "held"; wallet: string; readAt?: number } | { status: "none"; readAt?: number } | { status: "not_read"; reason: string };

/** The `eth_call` data for `getAgentWallet(agentId)`, or null when the id is not a plain decimal that fits in a word. */
export function encodeGetAgentWallet(tokenId: string): string | null {
  if (!/^(0|[1-9]\d{0,77})$/.test(tokenId)) return null;
  const value = BigInt(tokenId);
  if (value >= WORD_LIMIT) return null;
  return `0x${GET_AGENT_WALLET}${value.toString(16).padStart(64, "0")}`;
}

/** An answer as the wallet in lower case, none (the zero address), or `bad` when it is not one address in a word. An empty answer is bad: it is a node with no code at the address, or a broken one. */
export function decodeAgentWallet(result: unknown): { kind: "wallet"; address: string } | { kind: "none" } | { kind: "bad" } {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) return { kind: "bad" };
  const body = result.slice(2).toLowerCase();
  if (!/^0{24}/.test(body)) return { kind: "bad" };
  const address = `0x${body.slice(24)}`;
  return /^0x0{40}$/.test(address) ? { kind: "none" } : { kind: "wallet", address };
}

/** The wallet the registry holds for the agent now. Never throws: whatever goes wrong is a read that was not made, with a fixed reason. */
export async function readAgentWallet(call: EvmCall, chain: { chainId: number; registry: string }, tokenId: string): Promise<WalletRead> {
  const data = encodeGetAgentWallet(tokenId);
  if (data === null) return { status: "not_read", reason: WALLET_NOT_READ.badId };
  try {
    const answer = await call(chain.chainId, "eth_call", [{ to: chain.registry, data }, "latest"]);
    if (answer.revert) return { status: "not_read", reason: WALLET_NOT_READ.noAnswer };
    const decoded = decodeAgentWallet(answer.result);
    if (decoded.kind === "bad") return { status: "not_read", reason: WALLET_NOT_READ.badAnswer };
    return decoded.kind === "none" ? { status: "none" } : { status: "held", wallet: decoded.address };
  } catch {
    // An outage, a spent budget or anything else the client throws: the cause is not passed on.
    return { status: "not_read", reason: WALLET_NOT_READ.chain };
  }
}

/** How many reads one caller (an API key, or an address with no key) may make in a minute. A read refused here is "not read", which a payment is never charged for. */
export const PAY_TO_READS_PER_CALLER_PER_MINUTE = 20;
/** How long a wallet or a "none" is kept, so repeated checks of one agent cost one read. A read that was not made is not kept. */
export const WALLET_CACHE_MS = 30_000;
const WALLET_CACHE_MAX = 10_000;
const walletCache = new Map<string, WalletRead & { readAt: number }>();

/** For tests. */
export function resetWalletCache() {
  walletCache.clear();
}

/** A read for one caller: a kept answer when there is a fresh one, otherwise one read, held to the caller's budget. Never throws. */
export async function readAgentWalletForCaller(
  call: EvmCall,
  chain: { chainId: number; registry: string },
  tokenId: string,
  caller: string,
  now = Date.now()
): Promise<WalletRead> {
  const key = `${chain.chainId}:${chain.registry.toLowerCase()}:${tokenId}`;
  const kept = walletCache.get(key);
  if (kept && now - kept.readAt < WALLET_CACHE_MS) return kept;
  if (!consumeRateLimit(`pay-to:${caller}`, PAY_TO_READS_PER_CALLER_PER_MINUTE, 60_000, now).allowed) return { status: "not_read", reason: WALLET_NOT_READ.chain };
  const fresh = await readAgentWallet(call, chain, tokenId);
  if (fresh.status === "not_read") return fresh;
  const read = { ...fresh, readAt: now };
  walletCache.delete(key);
  // The oldest entry goes first (a Map keeps the order entries were set in).
  if (walletCache.size >= WALLET_CACHE_MAX) walletCache.delete(walletCache.keys().next().value!);
  walletCache.set(key, read);
  return read;
}

/** The production read, through the claims' paced clients. The router takes it from here, so it imports no claim module (server/apiV1.test.ts holds it to that). A chain with no EVM registry (Solana) has nothing to read. */
export function readAgentWalletOnChain(chain: { chainId: number | null; registry: string | null }, tokenId: string, caller: string): Promise<WalletRead> {
  if (chain.chainId === null || chain.registry === null) return Promise.resolve({ status: "not_read", reason: WALLET_NOT_READ.noAnswer });
  return readAgentWalletForCaller(callChainForPayTo, { chainId: chain.chainId, registry: chain.registry }, tokenId, caller);
}
