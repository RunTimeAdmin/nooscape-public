import { describe, expect, it } from "vitest";
import { ARC_MAINNET, loadX402 } from "./x402";
import { arcRpcHost, arcRpcUrl, readArcRpc } from "./arcRpc";

/** The settings `loadX402` needs to get as far as reading X402_RPC. Every value is made up. */
const BASE_ENV = {
  X402_NETWORK: ARC_MAINNET,
  X402_PAY_TO: "0x1111111111111111111111111111111111111111",
  X402_API_KEY: "LIVE_API_KEY:aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb",
};

/** The rule as `loadX402` applied it inline before the helper existed, kept here word for word to show the two agree. */
function oldRule(value: string | undefined): { rpc: string | null } | { error: string } {
  const rpc = (value ?? "").trim();
  if (rpc) {
    let secure = false;
    try {
      secure = new URL(rpc).protocol === "https:";
    } catch {
      // not an address
    }
    if (!secure) return { error: "X402_RPC must be an https address" };
  }
  return { rpc: rpc || null };
}

const INPUTS: Array<string | undefined> = [
  undefined,
  "",
  " ",
  "\t\n",
  "https://node.example",
  "https://node.example/",
  "  https://node.example/v1/KEYVALUE  ",
  "https://NODE.Example:8443/path?x=1#frag",
  "https://user:pass@node.example/v1/KEYVALUE",
  "http://node.example/v1/KEYVALUE",
  "ftp://node.example/KEYVALUE",
  "wss://node.example/KEYVALUE",
  "node.example/v1/KEYVALUE",
  "https//node.example",
  "https://",
  "https://a b",
  "HTTPS://NODE.EXAMPLE/KEYVALUE",
  "javascript:alert(1)",
  "not a url KEYVALUE",
];

describe("readArcRpc, arcRpcUrl and arcRpcHost", () => {
  it("is unset for a missing, empty or blank value", () => {
    for (const value of [undefined, "", " ", "\t \n"]) {
      expect(readArcRpc({ X402_RPC: value }), JSON.stringify(value)).toEqual({ state: "unset" });
      expect(arcRpcUrl({ X402_RPC: value })).toBeNull();
      expect(arcRpcHost({ X402_RPC: value })).toBeNull();
    }
    expect(readArcRpc({})).toEqual({ state: "unset" });
  });

  it("returns an https address trimmed, and nothing else changed", () => {
    expect(readArcRpc({ X402_RPC: "  https://node.example/v1/KEY  " })).toEqual({ state: "set", url: "https://node.example/v1/KEY" });
    expect(arcRpcUrl({ X402_RPC: "https://node.example/v1/KEY" })).toBe("https://node.example/v1/KEY");
  });

  it("is invalid for anything set that is not an https address", () => {
    for (const value of ["http://node.example", "ftp://node.example", "wss://node.example", "node.example", "https//node.example", "https://", "not a url", "javascript:alert(1)"]) {
      expect(readArcRpc({ X402_RPC: value }), value).toEqual({ state: "invalid" });
      expect(arcRpcUrl({ X402_RPC: value }), value).toBeNull();
      expect(arcRpcHost({ X402_RPC: value }), value).toBeNull();
    }
  });

  it("gives the host name alone: lower case, no port, path, query, fragment or credentials", () => {
    expect(arcRpcHost({ X402_RPC: "https://NODE.Example:8443/v1/KEYVALUE?token=abc#frag" })).toBe("node.example");
    expect(arcRpcHost({ X402_RPC: "https://user:pass@node.example/v1/KEYVALUE" })).toBe("node.example");
    expect(arcRpcHost({ X402_RPC: "https://node.example" })).toBe("node.example");
  });

  it("reads process.env by default", () => {
    const before = process.env.X402_RPC;
    try {
      process.env.X402_RPC = "https://env.example/v1/KEY";
      expect(arcRpcUrl()).toBe("https://env.example/v1/KEY");
      expect(arcRpcHost()).toBe("env.example");
      delete process.env.X402_RPC;
      expect(arcRpcUrl()).toBeNull();
    } finally {
      if (before === undefined) delete process.env.X402_RPC;
      else process.env.X402_RPC = before;
    }
  });
});

describe("loadX402 reads X402_RPC through the helper and behaves as it did", () => {
  it("agrees with the rule it replaced, word for word, on every input", () => {
    for (const value of INPUTS) {
      const expected = oldRule(value);
      let actual: { rpc: string | null } | { error: string };
      try {
        actual = { rpc: loadX402({ ...BASE_ENV, X402_RPC: value })!.rpc };
      } catch (error) {
        actual = { error: (error as Error).message };
      }
      expect(actual, JSON.stringify(value)).toEqual(expected);
    }
  });

  it("puts no part of a refused value in its error", () => {
    for (const value of ["http://secret-node.example/v1/KEYVALUE123", "ftp://secret-node.example/KEYVALUE123", "secret-node.example/KEYVALUE123", "https://secret node/KEYVALUE123"]) {
      let message = "";
      try {
        loadX402({ ...BASE_ENV, X402_RPC: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, value).toBe("X402_RPC must be an https address");
      expect(message).not.toContain("secret");
      expect(message).not.toContain("KEYVALUE");
    }
  });

  it("keeps the feature off when X402_NETWORK is unset, whatever X402_RPC holds", () => {
    expect(loadX402({ X402_RPC: "https://node.example/v1/KEY" })).toBeNull();
    expect(loadX402({ X402_RPC: "http://not-https.example" })).toBeNull();
  });
});
