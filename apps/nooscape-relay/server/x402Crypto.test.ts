import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { addressOfUncompressedKey } from "./claimsCrypto";
import { digestHex, signerOfTransferAuthorization, transferAuthorizationDigest, usdcDomainSeparator, type TransferAuthorization } from "./x402Crypto";

/**
 * The payment signature maths against values computed by an independent implementation (viem, run once from another project and
 * pasted here: nothing in this repository depends on it), and against signatures made in the test with the same two libraries the code
 * uses. The key is the well-known EIP-712 example key and holds nothing.
 */
const USDC = "0x3600000000000000000000000000000000000000";
const PAYER = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";
const PAY_TO = "0x14791697260e4c9a71f18484c9f997b308e59325";
const NONCE = `0x${"ab".repeat(32)}`;
const authorization: TransferAuthorization = { from: PAYER, to: PAY_TO, value: "5000", validAfter: "0", validBefore: "1792390000", nonce: NONCE };

const REFERENCE = {
  5042: {
    domainSeparator: "0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84",
    digest: "0x246cf37e4aa077de35accf540ac6e112800f4bd3bc14dcf54332d83703fac76b",
    signature: "0x9bc8a9988fc448e1cd9a35e41646527b5e04e34c735dc4ecaa1406e005f69232086dc6152a82cc6c65760b5eee2c55f2575404abf747d132a6e52a0692b8e6601b",
  },
  5042002: {
    domainSeparator: "0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0",
    digest: "0xee426b0716dc36775f369cddd8741777618bc70f9d8e54090b17a6bb87cf098d",
    signature: "0x0392c9c548c5812bd29ebb0c7271db576dfb8a4ec6538b360e62927f0f16b6261d50533d7643be8e4315c7a187fed9ca12e4b0b5ef0a0b3c19dbbc52a61b403c1b",
  },
} as const;

describe("the EIP-712 digest of a USDC transfer authorization", () => {
  for (const chainId of [5042, 5042002] as const) {
    it(`matches the reference implementation on chain ${chainId}`, () => {
      expect(digestHex(usdcDomainSeparator(chainId, USDC)!)).toBe(REFERENCE[chainId].domainSeparator);
      expect(digestHex(transferAuthorizationDigest(chainId, USDC, authorization)!)).toBe(REFERENCE[chainId].digest);
    });

    it(`recovers the payer from the reference implementation's signature on chain ${chainId}`, () => {
      expect(signerOfTransferAuthorization(chainId, USDC, authorization, REFERENCE[chainId].signature)).toBe(PAYER.toLowerCase());
    });
  }

  it("is a different digest on another chain, for another amount, payee, validity or nonce, so a signature binds all of them", () => {
    const base = digestHex(transferAuthorizationDigest(5042, USDC, authorization)!);
    expect(digestHex(transferAuthorizationDigest(5042002, USDC, authorization)!)).not.toBe(base);
    for (const change of [{ value: "5001" }, { to: "0x14791697260e4c9a71f18484c9f997b308e59326" }, { validBefore: "1792390001" }, { validAfter: "1" }, { nonce: `0x${"ac".repeat(32)}` }, { from: "0x2c7536E3605D9C16a7a3D7b1898e529396a65c24" }]) {
      expect(digestHex(transferAuthorizationDigest(5042, USDC, { ...authorization, ...change })!), JSON.stringify(change)).not.toBe(base);
    }
    expect(digestHex(transferAuthorizationDigest(5042, "0x3600000000000000000000000000000000000001", authorization)!)).not.toBe(base);
  });

  it("is the same whatever the case of an address", () => {
    const lower = { ...authorization, from: PAYER.toLowerCase(), to: PAY_TO.toUpperCase().replace("0X", "0x") };
    expect(digestHex(transferAuthorizationDigest(5042, USDC.toUpperCase().replace("0X", "0x"), lower)!)).toBe(REFERENCE[5042].digest);
  });

  it("refuses a transfer whose fields are not what the contract takes, instead of guessing", () => {
    for (const bad of [
      { from: "0x123" },
      { to: "not an address" },
      { value: "-1" },
      { value: "1.5" },
      { value: "" },
      { value: "9".repeat(79) },
      { value: (BigInt(1) << BigInt(256)).toString() },
      { validAfter: "abc" },
      { validBefore: "0x10" },
      { nonce: "0xabcd" },
      { nonce: `0x${"zz".repeat(32)}` },
    ]) {
      expect(transferAuthorizationDigest(5042, USDC, { ...authorization, ...bad }), JSON.stringify(bad)).toBeNull();
    }
    expect(transferAuthorizationDigest(5042, "0x123", authorization)).toBeNull();
    expect(transferAuthorizationDigest(-1, USDC, authorization)).toBeNull();
  });
});

describe("the signer of a transfer authorization", () => {
  const secret = secp256k1.utils.randomSecretKey();
  const signer = addressOfUncompressedKey(secp256k1.getPublicKey(secret, false));
  const sign = (digest: Uint8Array, flip = false) => {
    // noble returns the recovery byte, r and s; a wallet writes r, s and v (27 or 28).
    const recoverable = secp256k1.sign(digest, secret, { prehash: false, format: "recovered" });
    const bytes = new Uint8Array(65);
    bytes.set(recoverable.slice(1, 65), 0);
    bytes[64] = recoverable[0]! + 27;
    if (flip) bytes[64] = bytes[64] === 27 ? 28 : 27;
    return `0x${bytesToHex(bytes)}`;
  };
  const own = { ...authorization, from: signer };

  it("is the address that signed, for a signature made in the test with the same libraries", () => {
    const signature = sign(transferAuthorizationDigest(5042, USDC, own)!);
    expect(signerOfTransferAuthorization(5042, USDC, own, signature)).toBe(signer);
  });

  it("is another address, never the payer's, when anything signed was changed afterwards or the chain differs", () => {
    const signature = sign(transferAuthorizationDigest(5042, USDC, own)!);
    for (const change of [{ value: "9999" }, { to: "0x14791697260e4c9a71f18484c9f997b308e59326" }, { validBefore: "1792399999" }, { nonce: `0x${"cd".repeat(32)}` }]) {
      expect(signerOfTransferAuthorization(5042, USDC, { ...own, ...change }, signature), JSON.stringify(change)).not.toBe(signer);
    }
    expect(signerOfTransferAuthorization(5042002, USDC, own, signature)).not.toBe(signer);
    expect(signerOfTransferAuthorization(5042, USDC, own, sign(transferAuthorizationDigest(5042, USDC, own)!, true))).not.toBe(signer);
  });

  it("is null for a signature that is not a canonical 65-byte one: short, long, a smart-contract wallet's, a high s, a bad recovery byte", () => {
    const good = sign(transferAuthorizationDigest(5042, USDC, own)!);
    expect(signerOfTransferAuthorization(5042, USDC, own, "0x")).toBeNull();
    expect(signerOfTransferAuthorization(5042, USDC, own, good.slice(0, 130))).toBeNull();
    expect(signerOfTransferAuthorization(5042, USDC, own, `${good}00`)).toBeNull();
    expect(signerOfTransferAuthorization(5042, USDC, own, `${good.slice(0, 130)}1f`)).toBeNull();
    const order = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const s = BigInt(`0x${good.slice(66, 130)}`);
    const high = `0x${good.slice(2, 66)}${(order - s).toString(16).padStart(64, "0")}${good.slice(130)}`;
    expect(signerOfTransferAuthorization(5042, USDC, own, high)).toBeNull();
    expect(signerOfTransferAuthorization(5042, USDC, own, `0x${"00".repeat(65)}`)).toBeNull();
  });
});
