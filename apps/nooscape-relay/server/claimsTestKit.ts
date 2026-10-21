import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { addressOfUncompressedKey, personalMessageHash, toChecksumAddress } from "./claimsCrypto";

/**
 * A wallet for tests: it signs the way a wallet does, so the claim code is tested against real signatures and not against fakes
 * of its own checks. Tests only. The server never holds a key and never signs, and `claimsTestKit.test.ts` fails if any file
 * outside the tests imports this one.
 */
export type TestWallet = {
  secretKey: Uint8Array;
  /** The lower-case address. */
  address: string;
  /** The EIP-55 spelling, which a sign-in message carries. */
  checksum: string;
  /** What a wallet writes for `personal_sign(message)`: r, s and 27 or 28, as 0x hex. */
  sign: (message: string) => string;
  /** The same over a hash that is already made, for a contract wallet that signs for another. */
  signHash: (hash: Uint8Array) => string;
};

export function testWallet(secretKeyHex: string): TestWallet {
  const secretKey = hexToBytes(secretKeyHex.replace(/^0x/, ""));
  const address = addressOfUncompressedKey(secp256k1.getPublicKey(secretKey, false));
  const signHash = (hash: Uint8Array) => {
    const recoverable = secp256k1.sign(hash, secretKey, { prehash: false, format: "recovered" });
    const out = new Uint8Array(65);
    out.set(recoverable.slice(1, 65), 0);
    out[64] = 27 + recoverable[0]!;
    return `0x${bytesToHex(out)}`;
  };
  return { secretKey, address, checksum: toChecksumAddress(address), sign: message => signHash(personalMessageHash(message)), signHash };
}
