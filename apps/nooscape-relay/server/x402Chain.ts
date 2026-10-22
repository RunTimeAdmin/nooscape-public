import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { isEvmAddress } from "./claimsCrypto";
import type { Authorization } from "./x402";

/**
 * Asking the chain whether a smart-contract wallet signed a payment (docs/data-access-2026-10-19.md, stage D4b). A wallet that is a contract
 * has no key to recover: its signature is decided by the wallet's own code (ERC-1271), and the USDC contract asks that code when it settles
 * the transfer. So the same transfer is simulated here first, in one eth_call through Multicall3, which also names the chain and the block's
 * time so that a node that is on another chain or behind cannot answer for this one. It moves nothing: a simulation.
 *
 * The ABI is hand-encoded for the three shapes used (the token's transfer with a bytes signature, Multicall3's aggregate3, and an Error(string)
 * revert) and held to values computed by an independent implementation (viem) in server/x402Chain.test.ts. No dependency is added.
 */

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** The most a simulated transfer may spend, a wallet's isValidSignature included. */
export const CHECK_GAS = 500_000;
/** How far behind the real time a node's latest block may be before it is not trusted to say whether an authorization is in its time. */
const MAX_BEHIND_SECONDS = 60;
const MAX_RESPONSE_CHARS = 200_000;

const TEXT = new TextEncoder();
const selector = (signature: string) => keccak_256(TEXT.encode(signature)).slice(0, 4);
const TRANSFER = selector("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)");
const AGGREGATE3 = selector("aggregate3((address,bool,bytes)[])");
const GET_CHAIN_ID = selector("getChainId()");
const GET_BLOCK_TIME = selector("getCurrentBlockTimestamp()");
const ERROR_STRING = hexToBytes("08c379a0");

const word = (value: bigint | number) => hexToBytes(BigInt(value).toString(16).padStart(64, "0"));
const addressWord = (address: string) => hexToBytes(address.toLowerCase().replace(/^0x/, "").padStart(64, "0"));
const padded = (data: Uint8Array) => concatBytes(word(data.length), data, new Uint8Array((32 - (data.length % 32)) % 32));

/** The calldata of the token's transferWithAuthorization with a bytes signature: what the facilitator will submit. */
export function encodeTransferWithAuthorization(z: Authorization, signature: string): Uint8Array {
  return concatBytes(
    TRANSFER,
    addressWord(z.from),
    addressWord(z.to),
    word(BigInt(z.value)),
    word(BigInt(z.validAfter)),
    word(BigInt(z.validBefore)),
    hexToBytes(z.nonce.replace(/^0x/, "")),
    word(7 * 32),
    padded(hexToBytes(signature.replace(/^0x/, "")))
  );
}

export type Call3 = { target: string; allowFailure: boolean; callData: Uint8Array };

export function encodeAggregate3(calls: Call3[]): Uint8Array {
  const tuples = calls.map(call => concatBytes(addressWord(call.target), word(call.allowFailure ? 1 : 0), word(3 * 32), padded(call.callData)));
  const offsets: Uint8Array[] = [];
  let at = calls.length * 32;
  for (const tuple of tuples) {
    offsets.push(word(at));
    at += tuple.length;
  }
  return concatBytes(AGGREGATE3, word(32), word(calls.length), ...offsets, ...tuples);
}

export type CallResult = { success: boolean; returnData: Uint8Array };

const MAX_RESULTS = 16;

/** Multicall3's aggregate3 answer, with every offset and length checked: a node's answer is a stranger's. Throws on anything malformed. */
export function decodeAggregate3(hex: string): CallResult[] {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(hex) || hex.length > MAX_RESPONSE_CHARS) throw new Error("not a call result");
  const data = hexToBytes(hex.slice(2));
  const read = (position: number): bigint => {
    if (position < 0 || position + 32 > data.length) throw new Error("result out of range");
    return BigInt(`0x${bytesToHex(data.slice(position, position + 32))}`);
  };
  const small = (position: number, limit = data.length): number => {
    const value = read(position);
    if (value > BigInt(limit)) throw new Error("result offset out of range");
    return Number(value);
  };
  const array = small(0);
  const count = small(array);
  if (count > MAX_RESULTS) throw new Error("too many results");
  const base = array + 32;
  const results: CallResult[] = [];
  for (let index = 0; index < count; index += 1) {
    const tuple = base + small(base + index * 32);
    const success = read(tuple);
    if (success > BigInt(1)) throw new Error("not a boolean");
    const bytesAt = tuple + small(tuple + 32);
    const length = small(bytesAt);
    if (bytesAt + 32 + length > data.length) throw new Error("bytes out of range");
    results.push({ success: success === BigInt(1), returnData: data.slice(bytesAt + 32, bytesAt + 32 + length) });
  }
  return results;
}

/** The text of an Error(string) revert, made printable and short, or "" when there is none. */
export function revertReason(data: Uint8Array): string {
  if (data.length < 4 + 64 || bytesToHex(data.slice(0, 4)) !== bytesToHex(ERROR_STRING)) return "";
  try {
    const offset = Number(BigInt(`0x${bytesToHex(data.slice(4, 36))}`));
    const length = Number(BigInt(`0x${bytesToHex(data.slice(4 + offset, 4 + offset + 32))}`));
    if (offset > data.length || length > 512 || 4 + offset + 32 + length > data.length) return "";
    return new TextDecoder().decode(data.slice(4 + offset + 32, 4 + offset + 32 + length)).replace(/[^ -~]/g, "?").slice(0, 120);
  } catch {
    return "";
  }
}

/** A JSON-RPC node: one call, with a time limit and a cap on the size of the answer. */
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export function rpcClient(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8_000): Rpc {
  return async (method, params) => {
    const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    if (!response.ok || text.length > MAX_RESPONSE_CHARS) throw new Error("the node did not answer");
    const parsed = JSON.parse(text) as { result?: unknown; error?: unknown };
    if (parsed.error !== undefined || parsed.result === undefined) throw new Error("the node refused the call");
    return parsed.result;
  };
}

/**
 * USDC's refusal of the simulated transfer, in our words. USDC checks the signature before it moves money, so "the balance is below the
 * price" means the signature was good and the wallet is not funded: a payment from it could not settle either way, and is refused.
 */
export function refusalWords(reason: string): string {
  if (/invalid signature/i.test(reason)) return "the signature is not one this wallet's own code accepts (ERC-1271) for this payment";
  if (/used or canceled/i.test(reason)) return "this authorization was already used or cancelled";
  if (/not yet valid/i.test(reason)) return "the authorization is not valid yet";
  if (/expired/i.test(reason)) return "the authorization has expired";
  if (/exceeds balance|insufficient/i.test(reason)) return "the wallet's USDC balance is below the price";
  if (/blacklist/i.test(reason)) return "USDC refuses this payer";
  return "USDC would not accept this authorization";
}

/** ok: the wallet's code accepted the signature and the transfer would settle. ok false: it would not, with why. null: the chain cannot say. */
export type ContractVerdict = { ok: true } | { ok: false; why: string } | null;

export async function checkContractSignature(rpc: Rpc, input: { chainId: number; usdc: string; authorization: Authorization; signature: string; nowSeconds: number }): Promise<ContractVerdict> {
  try {
    if (!isEvmAddress(input.authorization.from) || !isEvmAddress(input.usdc)) return null;
    const calls: Call3[] = [
      { target: MULTICALL3, allowFailure: false, callData: GET_CHAIN_ID },
      { target: MULTICALL3, allowFailure: false, callData: GET_BLOCK_TIME },
      { target: input.usdc, allowFailure: true, callData: encodeTransferWithAuthorization(input.authorization, input.signature) },
    ];
    const answer = await rpc("eth_call", [{ to: MULTICALL3, data: `0x${bytesToHex(encodeAggregate3(calls))}`, gas: `0x${CHECK_GAS.toString(16)}` }, "latest"]);
    if (typeof answer !== "string") return null;
    const out = decodeAggregate3(answer);
    if (out.length !== 3) return null;
    const uint = (data: Uint8Array) => (data.length === 32 ? BigInt(`0x${bytesToHex(data)}`) : BigInt(-1));
    if (!out[0]!.success || uint(out[0]!.returnData) !== BigInt(input.chainId)) return null; // another chain's state says nothing about ours
    const blockTime = uint(out[1]!.returnData);
    if (!out[1]!.success || blockTime < BigInt(input.nowSeconds - MAX_BEHIND_SECONDS)) return null; // a node that is behind cannot say what is in time
    if (out[2]!.success) return { ok: true };
    return { ok: false, why: refusalWords(revertReason(out[2]!.returnData)) };
  } catch {
    return null;
  }
}

const BALANCE_OF = selector("balanceOf(address)");

/**
 * How much USDC a wallet holds, in base units, from one plain eth_call of the token's balanceOf. It is asked before a new payment is sent on to
 * a facilitator, so that a wallet with nothing in it is turned away here: a signed authorization costs its maker nothing, and each one that
 * reached the facilitator took a place in the shared budget. Null when the node cannot say (it failed, or its answer is not one 32-byte number),
 * and then the facilitator decides, as it did before. The node is not trusted to settle anything: it only lets an empty wallet be turned away early.
 */
export async function usdcBalance(rpc: Rpc, usdc: string, holder: string): Promise<bigint | null> {
  try {
    if (!isEvmAddress(holder) || !isEvmAddress(usdc)) return null;
    const answer = await rpc("eth_call", [{ to: usdc, data: `0x${bytesToHex(concatBytes(BALANCE_OF, addressWord(holder)))}` }, "latest"]);
    if (typeof answer !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(answer)) return null;
    return BigInt(answer);
  } catch {
    return null;
  }
}
