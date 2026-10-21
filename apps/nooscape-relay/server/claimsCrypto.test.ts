import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeOwnerOf,
  encodeIsValidSignature,
  encodeOwnerOf,
  isContractSignature,
  isCounterfactualSignature,
  isEvmAddress,
  isValidSignatureAnswer,
  parseEvmSignature,
  personalMessageHash,
  recoverEvmAddress,
  toChecksumAddress,
} from "./claimsCrypto";
import { testWallet } from "./claimsTestKit";

/** The signature maths behind the claim flow, against values fixed by the standards and by real wallets' behaviour. */
const KEY_ONE = `0x${"0".repeat(63)}1`;
const KEY_ONE_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const wallet = testWallet("0x0123456789012345678901234567890123456789012345678901234567890123");

describe("addresses", () => {
  it("derive from a key the way every wallet does (the address of the key 1 is the well-known one)", () => {
    expect(testWallet(KEY_ONE).address).toBe(KEY_ONE_ADDRESS);
    expect(testWallet(KEY_ONE).checksum).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  });

  it("are spelled the EIP-55 way, with the standard's own examples", () => {
    for (const expected of [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ]) {
      expect(toChecksumAddress(expected.toLowerCase())).toBe(expected);
    }
  });

  it("are recognised by shape", () => {
    expect(isEvmAddress(KEY_ONE_ADDRESS)).toBe(true);
    for (const bad of ["0x1234", "7e5f4552091a69125d5dfcb7b8c2659029395bdf", `${KEY_ONE_ADDRESS}00`, "0xzz5f4552091a69125d5dfcb7b8c2659029395bdf", 7, null]) expect(isEvmAddress(bad)).toBe(false);
  });
});

describe("a signed message", () => {
  const message = "nooscape.si wants you to sign in with your Ethereum account:\nHello";

  it("recovers to the address that signed it, and to a different one for a different message", () => {
    const signature = wallet.sign(message);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(recoverEvmAddress(personalMessageHash(message), signature)).toBe(wallet.address);
    expect(recoverEvmAddress(personalMessageHash(`${message}!`), signature)).not.toBe(wallet.address);
  });

  it("hashes a message to the value every wallet and library gives: the well-known hash of the message hello world", () => {
    // Fixed outside this code: the EIP-191 hash of "hello world", as ethers, viem and MetaMask all produce it.
    expect(Buffer.from(personalMessageHash("hello world")).toString("hex")).toBe("d9eba16ed0ecae432b71fe008c98cc872bb4cc214d3220a36f365326cf807d68");
  });

  it("hashes with the EIP-191 prefix and the length in bytes, not characters", () => {
    // A two-byte character: the length in the prefix is 2 bytes, and a signature over the character-count form would not recover.
    const text = "é";
    expect(recoverEvmAddress(personalMessageHash(text), wallet.sign(text))).toBe(wallet.address);
    expect(personalMessageHash("a")).not.toEqual(personalMessageHash("b"));
  });

  it("is accepted with a recovery value of 27, 28, 0 or 1, and in either hex case", () => {
    const signature = wallet.sign(message);
    const v = parseInt(signature.slice(130), 16);
    const as0or1 = `${signature.slice(0, 130)}${(v - 27).toString(16).padStart(2, "0")}`;
    expect(recoverEvmAddress(personalMessageHash(message), as0or1)).toBe(wallet.address);
    expect(recoverEvmAddress(personalMessageHash(message), `0x${signature.slice(2).toUpperCase()}`)).toBe(wallet.address);
  });

  it("is refused when it is not a canonical 65-byte signature", () => {
    const hash = personalMessageHash(message);
    const good = wallet.sign(message);
    const r = good.slice(2, 66);
    const s = good.slice(66, 130);
    const v = good.slice(130);
    expect(parseEvmSignature(good)).not.toBeNull();
    // Too short, too long, not hex, no prefix.
    for (const bad of [good.slice(0, -2), `${good}00`, `0x${"zz".repeat(65)}`, good.slice(2), "", "0x"]) expect(recoverEvmAddress(hash, bad), bad).toBeNull();
    // A recovery value that is not 27, 28, 0 or 1.
    expect(recoverEvmAddress(hash, `0x${r}${s}1f`)).toBeNull();
    // A zero r or s.
    expect(recoverEvmAddress(hash, `0x${"0".repeat(64)}${s}${v}`)).toBeNull();
    expect(recoverEvmAddress(hash, `0x${r}${"0".repeat(64)}${v}`)).toBeNull();
  });

  it("is refused in its high-s form, the one other signature that verifies for the same message", () => {
    const hash = personalMessageHash(message);
    const good = wallet.sign(message);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${good.slice(66, 130)}`);
    const flippedS = (n - s).toString(16).padStart(64, "0");
    const flippedV = (parseInt(good.slice(130), 16) === 27 ? 28 : 27).toString(16);
    const malleable = `0x${good.slice(2, 66)}${flippedS}${flippedV}`;
    expect(recoverEvmAddress(hash, good)).toBe(wallet.address);
    expect(recoverEvmAddress(hash, malleable)).toBeNull();
  });
});

describe("the two calls a claim makes", () => {
  it("asks ownerOf(tokenId) with the selector and the id in a word, and refuses an id that is not a plain number", () => {
    expect(encodeOwnerOf("1")).toBe(`0x6352211e${"0".repeat(63)}1`);
    expect(encodeOwnerOf("255")).toBe(`0x6352211e${"0".repeat(62)}ff`);
    expect(encodeOwnerOf("0")).toBe(`0x6352211e${"0".repeat(64)}`);
    for (const bad of ["", "-1", "01", "1.5", "0x10", "abc", "1".repeat(80), `${2n ** 256n}`]) expect(encodeOwnerOf(bad), bad).toBeNull();
  });

  it("reads the owner out of the answer, and nothing from an answer that is not one address in a word", () => {
    expect(decodeOwnerOf(`0x${"0".repeat(24)}7E5F4552091A69125d5DfCb7b8C2659029395Bdf`)).toBe(KEY_ONE_ADDRESS);
    for (const bad of [null, 7, "0x", `0x${"0".repeat(64)}`, `0x${"1".repeat(64)}`, `0x${"0".repeat(24)}${"a".repeat(39)}`, `0x${"0".repeat(24)}${"a".repeat(41)}`]) expect(decodeOwnerOf(bad), String(bad)).toBeNull();
  });

  it("asks a contract wallet isValidSignature(hash, signature) with the arguments laid out as the standard says", () => {
    const hash = personalMessageHash("x");
    const data = encodeIsValidSignature(hash, wallet.sign("x"));
    // selector, the hash, the offset to the bytes (0x40), their length (65), then the 65 bytes padded to three words.
    expect(data.slice(0, 10)).toBe("0x1626ba7e");
    expect(data.slice(10, 74)).toBe(Buffer.from(hash).toString("hex"));
    expect(data.slice(74, 138)).toBe("0".repeat(62) + "40");
    expect(data.slice(138, 202)).toBe("0".repeat(62) + "41");
    expect((data.length - 202) / 64).toBe(3);
    expect(isValidSignatureAnswer(`0x1626ba7e${"0".repeat(56)}`)).toBe(true);
    for (const bad of [null, "0x", `0x${"0".repeat(64)}`, "0x1626ba7e", `0x1626ba7f${"0".repeat(56)}`]) expect(isValidSignatureAnswer(bad), String(bad)).toBe(false);
  });

  it("tells a counterfactual (EIP-6492) signature, and what a contract wallet may send", () => {
    expect(isCounterfactualSignature(`0x${"ab".repeat(10)}${"6492".repeat(16)}`)).toBe(true);
    expect(isCounterfactualSignature(wallet.sign("x"))).toBe(false);
    expect(isContractSignature("0x" + "ab".repeat(130))).toBe(true);
    for (const bad of ["0x", "0xabc", "ab", `0x${"ab".repeat(4097)}`]) expect(isContractSignature(bad), bad).toBe(false);
  });
});

describe("the test kit", () => {
  it("is imported by tests only: the server never holds a key and never signs", () => {
    const server = fileURLToPath(new URL(".", import.meta.url));
    const walk = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
        return /\.tsx?$/.test(entry.name) ? [path] : [];
      });
    const importers = walk(server)
      .filter(path => /claimsTestKit/.test(readFileSync(path, "utf8")) && !/claimsTestKit\.ts$/.test(path))
      .map(path => relative(server, path).replaceAll("\\", "/"));
    expect(importers.filter(path => !/\.test\.ts$/.test(path))).toEqual([]);
  });
});
