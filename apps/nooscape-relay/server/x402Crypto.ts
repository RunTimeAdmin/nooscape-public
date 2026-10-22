import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { isEvmAddress, recoverEvmAddress } from "./claimsCrypto";

/**
 * The signature maths behind accepting a payment (docs/data-access-2026-10-19.md, stage D4): the EIP-712 digest of a USDC
 * `TransferWithAuthorization` (EIP-3009), and the address that signed it. A buyer signs that transfer to us and the facilitator
 * submits it; checking the signature here first means a forged one never reaches the facilitator. Pure: no network. Written on the
 * same two small audited libraries as the claim flow's wallet maths (@noble/curves, @noble/hashes), and held to values computed by
 * an independent implementation (viem) in server/x402Crypto.test.ts.
 *
 * Only a regular wallet's own signature (65 bytes, canonical) can be checked here. A smart-contract wallet's is decided by the
 * chain, so it is not accepted (see docs/data-access-2026-10-19.md).
 */

const TEXT = new TextEncoder();
const keccakText = (text: string) => keccak_256(TEXT.encode(text));

const DOMAIN_TYPE = keccakText("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
const TRANSFER_TYPE = keccakText("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
const UINT256_LIMIT = BigInt(1) << BigInt(256);

/** A 256-bit big-endian word from a whole number, or null when it does not fit. */
function uintWord(value: bigint): Uint8Array | null {
  if (value < BigInt(0) || value >= UINT256_LIMIT) return null;
  return hexToBytes(value.toString(16).padStart(64, "0"));
}

/** A decimal string of at most 78 digits as a number, or null. */
function decimal(text: string): bigint | null {
  return /^\d{1,78}$/.test(text) ? BigInt(text) : null;
}

const addressWord = (address: string) => hexToBytes(address.toLowerCase().replace(/^0x/, "").padStart(64, "0"));

/** The EIP-712 domain separator of a USDC contract on one chain. Arc's USDC names itself "USDC", version "2". */
export function usdcDomainSeparator(chainId: number, verifyingContract: string, name = "USDC", version = "2"): Uint8Array | null {
  const chain = uintWord(BigInt(chainId));
  if (!chain || !isEvmAddress(verifyingContract)) return null;
  return keccak_256(concatBytes(DOMAIN_TYPE, keccakText(name), keccakText(version), chain, addressWord(verifyingContract)));
}

export type TransferAuthorization = { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };

/** The name and version a USDC contract signs under. Arc's is "USDC" and "2"; Base's is "USD Coin" and "2" (read from its DOMAIN_SEPARATOR). */
export type UsdcDomain = { name: string; version: string };
const ARC_DOMAIN: UsdcDomain = { name: "USDC", version: "2" };

/** The digest a wallet signs for this transfer, or null when any field is not what the contract takes. */
export function transferAuthorizationDigest(chainId: number, verifyingContract: string, authorization: TransferAuthorization, domain: UsdcDomain = ARC_DOMAIN): Uint8Array | null {
  const separator = usdcDomainSeparator(chainId, verifyingContract, domain.name, domain.version);
  const value = decimal(authorization.value);
  const validAfter = decimal(authorization.validAfter);
  const validBefore = decimal(authorization.validBefore);
  const words = [value, validAfter, validBefore].map(item => (item === null ? null : uintWord(item)));
  if (!separator || !isEvmAddress(authorization.from) || !isEvmAddress(authorization.to) || words.some(word => word === null)) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)) return null;
  const struct = keccak_256(
    concatBytes(TRANSFER_TYPE, addressWord(authorization.from), addressWord(authorization.to), words[0]!, words[1]!, words[2]!, hexToBytes(authorization.nonce.slice(2)))
  );
  return keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), separator, struct));
}

/** The lower-case address that signed this transfer, or null for a signature that is not a canonical 65-byte one or a transfer that is malformed. */
export function signerOfTransferAuthorization(chainId: number, verifyingContract: string, authorization: TransferAuthorization, signature: string, domain: UsdcDomain = ARC_DOMAIN): string | null {
  const digest = transferAuthorizationDigest(chainId, verifyingContract, authorization, domain);
  return digest ? recoverEvmAddress(digest, signature) : null;
}

export const digestHex = (digest: Uint8Array) => `0x${bytesToHex(digest)}`;
