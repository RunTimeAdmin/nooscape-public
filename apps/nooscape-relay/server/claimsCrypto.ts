import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/**
 * The wallet-signature maths behind "Claim this agent" (docs/claims-2026-10-18.md), kept to the little that is needed and written
 * on two small audited libraries (@noble/curves for secp256k1, @noble/hashes for keccak-256): the hash a wallet signs for a
 * `personal_sign` message (EIP-191), recovering the address that signed it, the EIP-55 spelling of an address, and the two calls a
 * claim makes to a chain (`ownerOf` and, for a contract wallet, EIP-1271 `isValidSignature`). Pure: it touches no network.
 *
 * It accepts only a canonical signature: 65 bytes, a recovery value of 27, 28, 0 or 1, and the lower half of the curve for `s`, so a
 * signature has one form and cannot be re-written into another that also verifies.
 */

/** Half the order of the secp256k1 group: a canonical `s` is at or below it. */
const HALF_ORDER = BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");
const ZERO = BigInt(0);
/** The largest token id a word holds, plus one. */
const WORD_LIMIT = BigInt(1) << BigInt(256);

type EvmSignature = { r: Uint8Array; s: Uint8Array; recovery: 0 | 1 };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const isEvmAddress = (value: unknown): value is string => typeof value === "string" && ADDRESS.test(value);

/** What a wallet hashes before signing a message: the EIP-191 prefix, the message's length in bytes, and the message. */
export function personalMessageHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const whole = new Uint8Array(prefix.length + body.length);
  whole.set(prefix, 0);
  whole.set(body, prefix.length);
  return keccak_256(whole);
}

/** The signature in its three parts, or null when it is not a canonical 65-byte one. */
export function parseEvmSignature(hex: string): EvmSignature | null {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(hex)) return null;
  const bytes = hexToBytes(hex.slice(2));
  const v = bytes[64]!;
  const recovery = v === 27 || v === 0 ? 0 : v === 28 || v === 1 ? 1 : null;
  if (recovery === null) return null;
  const r = bytes.slice(0, 32);
  const s = bytes.slice(32, 64);
  const sValue = BigInt(`0x${bytesToHex(s)}`);
  if (sValue === ZERO || sValue > HALF_ORDER || BigInt(`0x${bytesToHex(r)}`) === ZERO) return null;
  return { r, s, recovery };
}

/** The address as the lower-case text of its 20 bytes, from an uncompressed public key. */
function addressOfPublicKey(uncompressed: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(12))}`;
}

/** The lower-case address that signed this hash, or null when the signature does not recover to a key. */
export function recoverEvmAddress(hash: Uint8Array, signatureHex: string): string | null {
  const signature = parseEvmSignature(signatureHex);
  if (!signature) return null;
  try {
    // noble writes a recoverable signature as the recovery byte, then r and s.
    const recoverable = new Uint8Array(65);
    recoverable[0] = signature.recovery;
    recoverable.set(signature.r, 1);
    recoverable.set(signature.s, 33);
    const compressed = secp256k1.recoverPublicKey(recoverable, hash, { prehash: false });
    return addressOfPublicKey(secp256k1.Point.fromBytes(compressed).toBytes(false));
  } catch {
    return null;
  }
}

/** The address in its EIP-55 spelling (mixed case, a checksum in the capitals). */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  const digest = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let index = 0; index < lower.length; index += 1) out += parseInt(digest[index]!, 16) >= 8 ? lower[index]!.toUpperCase() : lower[index]!;
  return out;
}

/** The lower-case address of a public key given as its 65 uncompressed bytes. Exported for the test kit, which holds the only keys. */
export const addressOfUncompressedKey = addressOfPublicKey;

/** A counterfactual (EIP-6492) signature ends with this value. Claims from such a wallet are not supported yet. */
const ERC_6492_SUFFIX = "6492649264926492649264926492649264926492649264926492649264926492";
export const isCounterfactualSignature = (signatureHex: string): boolean => typeof signatureHex === "string" && signatureHex.toLowerCase().endsWith(ERC_6492_SUFFIX);

/** A signature for a contract wallet is any bytes (EIP-1271), not only 65: a hex string of whole bytes, 4,096 at most. */
export function isContractSignature(signatureHex: string): boolean {
  return typeof signatureHex === "string" && /^0x([0-9a-fA-F]{2})+$/.test(signatureHex) && signatureHex.length <= 2 + 4096 * 2;
}

// ---------------------------------------------------------------- the two calls a claim makes

const OWNER_OF = "6352211e";
const IS_VALID_SIGNATURE = "1626ba7e";
/** What a contract wallet answers when it accepts the signature (the selector of `isValidSignature`, left-aligned in a word). */
const EIP_1271_MAGIC = `0x${IS_VALID_SIGNATURE}${"0".repeat(56)}`;

const word = (hex: string) => hex.padStart(64, "0");

/** The `eth_call` data for `ownerOf(tokenId)` on an ERC-721, or null when the token id is not a plain decimal that fits in a word. */
export function encodeOwnerOf(tokenId: string): string | null {
  if (!/^(0|[1-9]\d{0,77})$/.test(tokenId)) return null;
  const value = BigInt(tokenId);
  if (value >= WORD_LIMIT) return null;
  return `0x${OWNER_OF}${word(value.toString(16))}`;
}

/** The lower-case owner an `ownerOf` call answered, or null when the answer is not one address in a word (or is the zero address). */
export function decodeOwnerOf(result: unknown): string | null {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) return null;
  const body = result.slice(2).toLowerCase();
  if (!/^0{24}/.test(body)) return null;
  const owner = `0x${body.slice(24)}`;
  return /^0x0{40}$/.test(owner) ? null : owner;
}

/** The `eth_call` data for `isValidSignature(hash, signature)` on a contract wallet (EIP-1271). */
export function encodeIsValidSignature(hash: Uint8Array, signatureHex: string): string {
  const signature = signatureHex.slice(2).toLowerCase();
  const length = signature.length / 2;
  const padded = signature + "0".repeat((64 - (signature.length % 64)) % 64);
  return `0x${IS_VALID_SIGNATURE}${bytesToHex(hash)}${word("40")}${word(length.toString(16))}${padded}`;
}

/** True when a contract wallet's answer to `isValidSignature` is the EIP-1271 magic value. */
export const isValidSignatureAnswer = (result: unknown): boolean => typeof result === "string" && result.toLowerCase() === EIP_1271_MAGIC;
