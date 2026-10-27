import { BSC_IDENTITY_REGISTRY } from "./bscChain";
import { decodeAbiString } from "./robinhood";

/**
 * Reading many `tokenURI(agentId)` values of the BNB Chain identity registry in one `eth_call` through Multicall3
 * (`aggregate3`), which costs one call's compute units however many reads it holds (AUTO_REVIEW_PLAN.md: any new BNB read
 * is batched). Pure encoding and decoding by hand: the project carries no ABI library. Nothing here touches the network.
 */

/** Multicall3, deployed at the same address on BNB Smart Chain and most other chains. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const AGGREGATE3_SELECTOR = "82ad56cb";
const TOKEN_URI_SELECTOR = "c87b56dd";
const WORD = 64;

/** Most reads in one call. Each answer is a URI of up to 64 KiB, and the whole response is held to 8 MiB by the client. */
export const MULTICALL_MAX_READS = 20;

const word = (value: bigint | number): string => BigInt(value).toString(16).padStart(WORD, "0");

/**
 * The calldata of `aggregate3` for `tokenURI(id)` on an identity registry, one read for each id, each allowed to fail alone. The
 * registry is the BNB Chain one unless another is named (the Robinhood Chain registry sits at the same address, and Multicall3 is
 * deployed there too).
 */
export function encodeTokenUriMulticall(agentIds: string[], registry: string = BSC_IDENTITY_REGISTRY): string {
  if (agentIds.length === 0 || agentIds.length > MULTICALL_MAX_READS) throw new Error(`A multicall holds 1 to ${MULTICALL_MAX_READS} reads.`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry)) throw new Error("A registry is an address.");
  const target = registry.slice(2).toLowerCase().padStart(WORD, "0");
  // One element is: target, allowFailure, the offset of the bytes (3 words), the bytes' length (36), the bytes padded to 2 words.
  const elements = agentIds.map(id => {
    if (!/^[0-9]{1,78}$/.test(id)) throw new Error("An agent id is a decimal number.");
    const callData = `${TOKEN_URI_SELECTOR}${word(BigInt(id))}`.padEnd(WORD * 2, "0");
    return `${target}${word(1)}${word(0x60)}${word(36)}${callData}`;
  });
  const elementBytes = elements[0]!.length / 2;
  // Offsets are counted from the start of the elements area, which comes after the array length and the offsets themselves.
  const offsets = elements.map((_, index) => word(agentIds.length * 32 + index * elementBytes)).join("");
  return `0x${AGGREGATE3_SELECTOR}${word(0x20)}${word(agentIds.length)}${offsets}${elements.join("")}`;
}

type MulticallResult = { success: boolean; returnData: string };

const readWord = (hex: string, byteOffset: number): bigint | null => {
  const start = byteOffset * 2;
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || start + WORD > hex.length) return null;
  return BigInt(`0x${hex.slice(start, start + WORD)}`);
};

/** Reads the `(bool success, bytes returnData)[]` that `aggregate3` returns. Null when it does not have the expected shape. */
export function decodeAggregate3(resultHex: unknown, expected: number): MulticallResult[] | null {
  if (typeof resultHex !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(resultHex)) return null;
  const hex = resultHex.slice(2);
  const arrayAt = readWord(hex, 0);
  if (arrayAt === null || arrayAt !== BigInt(32)) return null;
  const count = readWord(hex, 32);
  if (count === null || count !== BigInt(expected)) return null;
  const areaStart = 64;
  const results: MulticallResult[] = [];
  for (let index = 0; index < expected; index += 1) {
    const offset = readWord(hex, areaStart + index * 32);
    if (offset === null || offset > BigInt(hex.length / 2)) return null;
    const elementStart = areaStart + Number(offset);
    const success = readWord(hex, elementStart);
    const bytesAt = readWord(hex, elementStart + 32);
    if (success === null || bytesAt === null || (success !== BigInt(0) && success !== BigInt(1)) || bytesAt > BigInt(hex.length / 2)) return null;
    const lengthAt = elementStart + Number(bytesAt);
    const length = readWord(hex, lengthAt);
    if (length === null || length > BigInt(hex.length / 2)) return null;
    const dataStart = (lengthAt + 32) * 2;
    const data = hex.slice(dataStart, dataStart + Number(length) * 2);
    if (data.length < Number(length) * 2) return null;
    results.push({ success: success === BigInt(1), returnData: `0x${data}` });
  }
  return results;
}

/** The URI each read returned, in order: the string, or null where the read failed or did not decode as one string. */
export function decodeTokenUris(resultHex: unknown, expected: number): Array<string | null> | null {
  const results = decodeAggregate3(resultHex, expected);
  if (results === null) return null;
  return results.map(result => (result.success ? decodeAbiString(result.returnData) : null));
}
