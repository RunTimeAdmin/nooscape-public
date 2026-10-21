import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { IngestionSource } from "../../drizzle/schema";
import { encodeBase58 } from "./metaplexChain";
import {
  buildSaidDirectoryDraft,
  decodeSaidIdentity,
  fetchSaidChainState,
  formatLamportsAsSol,
  isSaidChainSeedCursor,
  isSaidIdentity,
  parseSaidProgramAccounts,
  placeholderSaidName,
  SAID_CHAIN_MAX_ACCOUNTS,
  SAID_CHAIN_SOURCE_KEY,
  SAID_IDENTITY_DISCRIMINATOR,
  saidSignalNote,
  SaidValidationError,
} from "./saidChain";

/**
 * The fixtures below are REAL mainnet AgentIdentity accounts (SAID program
 * 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G, captured 2026-10-13), one per
 * live layout version plus the edge cases the full-population probe found.
 * The expected values come from an independent Python decode of the same
 * bytes, not from the code under test, so a shared misreading cannot hide.
 */
type Expected = {
  pda: string;
  version: number;
  owner: string;
  authority: string;
  uri: string;
  createdAtSeconds: number;
  isVerified: boolean;
  verifiedAtSeconds: number | null;
  stakeLamports: number | null;
  slashCount: number | null;
  tailResidue: boolean;
};
const FIXTURES: Record<string, { b64: string; expected: Expected }> = {
  v1_unverified: {
    b64: "C5UfG7pM8UgOYkD7dDMHXIWTA3I83onXoUFVabWe1GEzUZ4sc0mhVyUAAABodHRwczovL2FwaS54b25hLWFnZW50LmNvbS9hZ2VudC5qc29ujc+jaQAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    expected: {"pda": "3rSZsgXZCtt7QwnvdWZTYRxe4xrLzBAmPZMeNr6tsvqS", "version": 1, "owner": "y9c2irrRiMybZUZmyWDHdoj6r9aJ2XvxCcjwsxtYTSW", "authority": "y9c2irrRiMybZUZmyWDHdoj6r9aJ2XvxCcjwsxtYTSW", "uri": "https://api.xona-agent.com/agent.json", "createdAtSeconds": 1772343181, "isVerified": false, "verifiedAtSeconds": null, "stakeLamports": null, "slashCount": null, "tailResidue": false},
  },
  v1_verified: {
    b64: "C5UfG7pM8Uh+uBDA9tBv0LJpCIxN2xXm4j3cipS1RCrcXSTA+6XilFgAAABodHRwczovL2FwaS5zYWlkcHJvdG9jb2wuY29tL2FwaS9jYXJkcy85WGZBQmQ2SDhQMlBMRjdVakxrOTVXYVBjZERxVmk2NzE0SFJTMWZzQTZjai5qc29u6F2maQAAAAABAehdpmkAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    expected: {"pda": "1CLmY3Sx4d7Z1qAPfUTMMHBvXtFqJpZHho3RnFZshFW", "version": 1, "owner": "9XfABd6H8P2PLF7UjLk95WaPcdDqVi6714HRS1fsA6cj", "authority": "9XfABd6H8P2PLF7UjLk95WaPcdDqVi6714HRS1fsA6cj", "uri": "https://api.saidprotocol.com/api/cards/9XfABd6H8P2PLF7UjLk95WaPcdDqVi6714HRS1fsA6cj.json", "createdAtSeconds": 1772510696, "isVerified": true, "verifiedAtSeconds": 1772510696, "stakeLamports": null, "slashCount": null, "tailResidue": false},
  },
  v2_verified: {
    b64: "C5UfG7pM8UgzyyViL9t++onfb6nP54qTbibqYALdquvc0t7IEhp9bzPLJWIv2376id9vqc/nipNuJupgAt2q69zS3sgSGn1vWAAAAGh0dHBzOi8vYXBpLnNhaWRwcm90b2NvbC5jb20vYXBpL2NhcmRzLzRWQlRTczR5czE3NkZ1cjhmM3V3Tm11SlExd29RMzZtRGt2dmE1U2NuNDN4Lmpzb25TKKlpAAAAAAEBUyipaQAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    expected: {"pda": "1nhWwCU1MvoVX7xHAoNfDaCfiLyRhKaP7KhBqdPCT1d", "version": 2, "owner": "4VBTSs4ys176Fur8f3uwNmuJQ1woQ36mDkvva5Scn43x", "authority": "4VBTSs4ys176Fur8f3uwNmuJQ1woQ36mDkvva5Scn43x", "uri": "https://api.saidprotocol.com/api/cards/4VBTSs4ys176Fur8f3uwNmuJQ1woQ36mDkvva5Scn43x.json", "createdAtSeconds": 1772693587, "isVerified": true, "verifiedAtSeconds": 1772693587, "stakeLamports": null, "slashCount": null, "tailResidue": false},
  },
  v3_plain: {
    b64: "C5UfG7pM8UgdynEQeH7OqXqWhxokooyO8Az3JXBSPHbDskr63b4Kah3KcRB4fs6pepaHGiSijI7wDPclcFI8dsOySvrdvgpqWAAAAGh0dHBzOi8vYXBpLnNhaWRwcm90b2NvbC5jb20vYXBpL2NhcmRzLzMxSHM2TjU4b2V5MVN4akVtcGdxcFJ0V0FnZXhqenJrMk5RYzlFenZHUU1YLmpzb24A8FNqAAAAAAEBAPBTagAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expected: {"pda": "1T88AfpJrHw1Jy7UAxoMbe5xaFQwmqXWohRmwDLdsMF", "version": 3, "owner": "31Hs6N58oey1SxjEmpgqpRtWAgexjzrk2NQc9EzvGQMX", "authority": "31Hs6N58oey1SxjEmpgqpRtWAgexjzrk2NQc9EzvGQMX", "uri": "https://api.saidprotocol.com/api/cards/31Hs6N58oey1SxjEmpgqpRtWAgexjzrk2NQc9EzvGQMX.json", "createdAtSeconds": 1783885824, "isVerified": true, "verifiedAtSeconds": 1783885824, "stakeLamports": 0, "slashCount": 0, "tailResidue": false},
  },
  v3_staked: {
    b64: "C5UfG7pM8Uh3Goiyga7JbpBtaiTThjSZp7/Q3XUKrxlIldfECIz++HcaiLKBrslukG1qJNOGNJmnv9DddQqvGUiV18QIjP74WAAAAGh0dHBzOi8vYXBpLnNhaWRwcm90b2NvbC5jb20vYXBpL2NhcmRzLzkxdnoxQnVjbkJvZmZXNU1GN1lVdlFDc2l0ZFB5N0NFajRKTVJ1U1J3dHJiLmpzb25Tn+ppAAAAAAEBxanqaQAAAAACAOH1BQAAAAABbdv3aQAAAAAAAAAAADkAAAAAAAAAEgAAAAAAAAD/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expected: {"pda": "83zpmogAAXECpy36nzzhQyebNSo72veVaWUdKZJeZmQx", "version": 3, "owner": "91vz1BucnBoffW5MF7YUvQCsitdPy7CEj4JMRuSRwtrb", "authority": "91vz1BucnBoffW5MF7YUvQCsitdPy7CEj4JMRuSRwtrb", "uri": "https://api.saidprotocol.com/api/cards/91vz1BucnBoffW5MF7YUvQCsitdPy7CEj4JMRuSRwtrb.json", "createdAtSeconds": 1776983891, "isVerified": true, "verifiedAtSeconds": 1776986565, "stakeLamports": 100000000, "slashCount": 0, "tailResidue": false},
  },
  v3_authority_moved: {
    b64: "C5UfG7pM8Uh86Dk0S4AFJCvdAVtT5cmj44uJi0EOxyiCImjbPJJDnNbbr9fzqc74PPMjJi8FKUhVXFuvuN35pQBl/gf2CDvfGAAAAGh0dHBzOi8vc2FpZC5zby9saW5rdGVzdOX5MWoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expected: {"pda": "6Mxud8eRAr56cwdjwVi3iWbsVEdNfNWaUf4VYe4vHE24", "version": 3, "owner": "9QawBPWp7Tt5YDQtrsq8FQDyb5fRicXXNuaiweiCLjrK", "authority": "FTiYHwfAojEg5JBJKEvGitLNYavqgfKSQxBfYBoyY14S", "uri": "https://said.so/linktest", "createdAtSeconds": 1781660133, "isVerified": false, "verifiedAtSeconds": null, "stakeLamports": 0, "slashCount": 0, "tailResidue": false},
  },
  v3_residue: {
    b64: "C5UfG7pM8UizyCBmhllKKjjkWtdfaYl8HxiaOCd9zaHeyFati8PXGLPIIGaGWUoqOORa119piXwfGJo4J33Nod7IVq2Lw9cYUAAAAGh0dHBzOi8vY2xhd3B1bXAudGVjaC9hZ2VudHMvOWU0OGUwZTItMTlkYS00ZGQ2LThkYTUtODcyNGM0MDgxYTY2L3NhaWQtY2FyZC5qc29u5sF6agAAAAABAebBemoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAA/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expected: {"pda": "46bqVKHfkjxMaWDiQ9fxGMBGSMVs5HoEGjgkMw1CoZm9", "version": 3, "owner": "D6nyJvy3R9maLou4PQwzdVGUSaFYWngCbXyYEhgx9Aw9", "authority": "D6nyJvy3R9maLou4PQwzdVGUSaFYWngCbXyYEhgx9Aw9", "uri": "https://clawpump.tech/agents/9e48e0e2-19da-4dd6-8da5-8724c4081a66/said-card.json", "createdAtSeconds": 1786429926, "isVerified": true, "verifiedAtSeconds": 1786429926, "stakeLamports": 0, "slashCount": 0, "tailResidue": true},
  },
  v3_ipfs: {
    b64: "C5UfG7pM8UgMECRAgkGNIOBvxhWZqtMJS1Z01eo98svEEigRUGW62AwQJECCQY0g4G/GFZmq0wlLVnTV6j3yy8QSKBFQZbrYNQAAAGlwZnM6Ly9RbVhZZVZtem5XYzNURjM4Sm5uMWtmeHJKdUJCOXBBVDdBdTk3dUtzU1ZMZVpCOHJ8agAAAAABATlyfGoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expected: {"pda": "AfCwPtx4dtxd7PvsiSMN9NpKHXfTLaosyjFTzAXEb7Q", "version": 3, "owner": "p6AkUCvR5CXoQJVgkSffLNNXNdV8xpP7x3EzMApnxTZ", "authority": "p6AkUCvR5CXoQJVgkSffLNNXNdV8xpP7x3EzMApnxTZ", "uri": "ipfs://QmXYeVmznWc3TF38Jnn1kfxrJuBB9pAT7Au97uKsSVLeZB", "createdAtSeconds": 1786540600, "isVerified": true, "verifiedAtSeconds": 1786540601, "stakeLamports": 0, "slashCount": 0, "tailResidue": false},
  },
};

const bytes = (key: string) => new Uint8Array(Buffer.from(FIXTURES[key]!.b64, "base64"));
/** A fixed "now" after every fixture's created_at so the ceiling is deterministic. */
const NOW_MS = Date.UTC(2026, 9, 13);

const source = {
  id: "00000000-0000-4000-8000-0000000000a1",
  sourceKey: SAID_CHAIN_SOURCE_KEY,
  protocol: "solana_said",
  state: "active",
  executionPolicy: "manual_only",
  cursor: null,
} as unknown as IngestionSource;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decodeSaidIdentity: real mainnet accounts, all three layouts", () => {
  for (const key of Object.keys(FIXTURES)) {
    it(`decodes ${key} to the independently derived values`, () => {
      const { expected } = FIXTURES[key]!;
      const identity = decodeSaidIdentity(expected.pda, bytes(key), NOW_MS);
      expect(identity.layoutVersion).toBe(expected.version);
      expect(identity.owner).toBe(expected.owner);
      expect(identity.authority).toBe(expected.authority);
      expect(identity.uri).toBe(expected.uri);
      expect(identity.createdAtSeconds).toBe(expected.createdAtSeconds);
      expect(identity.isVerified).toBe(expected.isVerified);
      expect(identity.verifiedAtSeconds).toBe(expected.verifiedAtSeconds);
      expect(identity.stakeLamports === null ? null : Number(identity.stakeLamports)).toBe(expected.stakeLamports);
      expect(identity.slashCount).toBe(expected.slashCount);
      expect(identity.tailResidue).toBe(expected.tailResidue);
    });
  }

  it("records no authority on v1 (it equals the owner) and no stake facts before v3", () => {
    const v1 = decodeSaidIdentity(FIXTURES.v1_unverified!.expected.pda, bytes("v1_unverified"), NOW_MS);
    expect(v1.authority).toBe(v1.owner);
    expect(v1.stakeLamports).toBeNull();
    expect(v1.slashCount).toBeNull();
    const v2 = decodeSaidIdentity(FIXTURES.v2_verified!.expected.pda, bytes("v2_verified"), NOW_MS);
    expect(v2.stakeLamports).toBeNull();
  });

  it("keeps an authority that moved away from the owner (the transfer_authority fact)", () => {
    const moved = decodeSaidIdentity(FIXTURES.v3_authority_moved!.expected.pda, bytes("v3_authority_moved"), NOW_MS);
    expect(moved.authority).not.toBe(moved.owner);
  });
});

describe("decodeSaidIdentity: fail-closed strictness", () => {
  const pda = FIXTURES.v3_plain!.expected.pda;
  const mutate = (key: string, edit: (data: Uint8Array) => void) => {
    const data = bytes(key);
    edit(data);
    return data;
  };
  /** Offset of the byte after the metadata_uri string on a v2/v3 fixture. */
  const afterUri = (key: string) => {
    const data = bytes(key);
    const length = new DataView(data.buffer).getUint32(8 + 64, true);
    return 8 + 64 + 4 + length;
  };

  it("rejects an account whose length is not an approved layout size", () => {
    expect(() => decodeSaidIdentity(pda, new Uint8Array(300), NOW_MS)).toThrow(SaidValidationError);
    expect(() => decodeSaidIdentity(pda, bytes("v3_plain").subarray(0, 341), NOW_MS)).toThrow(/not one of the approved layout sizes/);
  });

  it("rejects the wrong discriminator at an approved size", () => {
    const data = mutate("v3_plain", d => {
      d[0] = 0;
    });
    expect(() => decodeSaidIdentity(pda, data, NOW_MS)).toThrow(/discriminator/);
  });

  it("rejects an invalid borsh bool byte in is_verified", () => {
    const data = mutate("v3_plain", d => {
      d[afterUri("v3_plain") + 8] = 2;
    });
    expect(() => decodeSaidIdentity(pda, data, NOW_MS)).toThrow(/invalid bool byte/);
  });

  it("rejects an invalid Option tag in verified_at", () => {
    const data = mutate("v3_plain", d => {
      d[afterUri("v3_plain") + 9] = 7;
    });
    expect(() => decodeSaidIdentity(pda, data, NOW_MS)).toThrow(/invalid Option tag/);
  });

  it("rejects a metadata_uri length past the program's own 200-byte bound", () => {
    const data = mutate("v3_plain", d => {
      new DataView(d.buffer).setUint32(8 + 64, 201, true);
    });
    expect(() => decodeSaidIdentity(pda, data, NOW_MS)).toThrow(/past its bound/);
  });

  it("rejects a metadata_uri that is not valid UTF-8", () => {
    const data = mutate("v3_plain", d => {
      d[8 + 64 + 4] = 0xff;
    });
    expect(() => decodeSaidIdentity(pda, data, NOW_MS)).toThrow(/not valid UTF-8/);
  });

  it("rejects a created_at outside the plausible window (a misread layout)", () => {
    const early = mutate("v3_plain", d => {
      new DataView(d.buffer).setBigInt64(afterUri("v3_plain"), BigInt(0), true);
    });
    expect(() => decodeSaidIdentity(pda, early, NOW_MS)).toThrow(/plausible window/);
    const future = mutate("v3_plain", d => {
      new DataView(d.buffer).setBigInt64(afterUri("v3_plain"), BigInt(Math.floor(NOW_MS / 1000) + 90 * 86_400), true);
    });
    expect(() => decodeSaidIdentity(pda, future, NOW_MS)).toThrow(/plausible window/);
  });
});

describe("formatLamportsAsSol", () => {
  it("renders exact decimals with no float rounding", () => {
    expect(formatLamportsAsSol(BigInt(0))).toBe("0");
    expect(formatLamportsAsSol(BigInt(100_000_000))).toBe("0.1");
    expect(formatLamportsAsSol(BigInt(1))).toBe("0.000000001");
    expect(formatLamportsAsSol(BigInt(1_500_000_000))).toBe("1.5");
    expect(formatLamportsAsSol(BigInt("18446744073709551615"))).toBe("18446744073.709551615");
  });
});

describe("directory draft and signal note", () => {
  it("keys the entry on the owner wallet and records the current authority as registrant", () => {
    const identity = decodeSaidIdentity(FIXTURES.v3_authority_moved!.expected.pda, bytes("v3_authority_moved"), NOW_MS);
    const draft = buildSaidDirectoryDraft(identity);
    expect(draft.externalKey).toBe(identity.owner);
    expect(draft.registrant).toBe(identity.authority);
    expect(draft.accountPubkey).toBe(identity.account);
    expect(draft.displayName).toBe(placeholderSaidName(identity.owner));
    expect(draft.locatorHost).toBe("said.so");
    expect(draft.profileUriHash).toBe(createHash("sha256").update(identity.uri, "utf8").digest("hex"));
    expect(draft.feedbackCount).toBeUndefined();
  });

  it("gives an ipfs:// metadata URI no locator host", () => {
    const identity = decodeSaidIdentity(FIXTURES.v3_ipfs!.expected.pda, bytes("v3_ipfs"), NOW_MS);
    expect(buildSaidDirectoryDraft(identity).locatorHost).toBeNull();
  });

  it("labels the badge for what it is and reports v3 stake exactly, never scores", () => {
    const staked = decodeSaidIdentity(FIXTURES.v3_staked!.expected.pda, bytes("v3_staked"), NOW_MS);
    const note = saidSignalNote(staked);
    expect(note).toContain("layout v3");
    expect(note).toContain("badge: yes (paid or sponsored, not an identity check)");
    expect(note).toContain("stake: 0.1 SOL");
    expect(note).toContain("slashes: 0");
    expect(note).toContain("not scored");
    expect(note.length).toBeLessThanOrEqual(512);
    const plain = decodeSaidIdentity(FIXTURES.v3_plain!.expected.pda, bytes("v3_plain"), NOW_MS);
    expect(saidSignalNote(plain)).toContain("stake: none");
    expect(saidSignalNote(plain)).not.toContain("0 SOL");
    const v1 = decodeSaidIdentity(FIXTURES.v1_unverified!.expected.pda, bytes("v1_unverified"), NOW_MS);
    const v1Note = saidSignalNote(v1);
    expect(v1Note).toContain("badge: no");
    expect(v1Note).not.toContain("stake");
  });

  it("is deterministic: an unchanged identity rewrites an identical note", () => {
    const a = decodeSaidIdentity(FIXTURES.v2_verified!.expected.pda, bytes("v2_verified"), NOW_MS);
    const b = decodeSaidIdentity(FIXTURES.v2_verified!.expected.pda, bytes("v2_verified"), NOW_MS);
    expect(saidSignalNote(a)).toBe(saidSignalNote(b));
  });
});

describe("parseSaidProgramAccounts", () => {
  const entry = (key: string) => ({ pubkey: FIXTURES[key]!.expected.pda, account: { data: [FIXTURES[key]!.b64, "base64"] } });

  it("decodes identity-discriminated entries and counts others as unknown, never parsed", () => {
    const other = Buffer.alloc(40);
    other.writeUInt8(1, 0);
    const { identities, unknownCount } = parseSaidProgramAccounts(
      [entry("v1_verified"), entry("v3_plain"), { pubkey: "F".repeat(44), account: { data: [other.toString("base64"), "base64"] } }],
      NOW_MS
    );
    expect(identities.map(i => i.layoutVersion)).toEqual([1, 3]);
    expect(unknownCount).toBe(1);
  });

  it("fails the pass on an envelope violation or a decode failure under the identity discriminator", () => {
    expect(() => parseSaidProgramAccounts({ not: "an array" }, NOW_MS)).toThrow(/must be an array/);
    expect(() => parseSaidProgramAccounts([{ pubkey: "F".repeat(44) }], NOW_MS)).toThrow(/without a pubkey and base64 data tuple/);
    const truncated = Buffer.concat([Buffer.from(SAID_IDENTITY_DISCRIMINATOR), Buffer.alloc(100)]);
    expect(() =>
      parseSaidProgramAccounts([{ pubkey: "F".repeat(44), account: { data: [truncated.toString("base64"), "base64"] } }], NOW_MS)
    ).toThrow(/approved layout sizes/);
  });

  it("recognizes the discriminator only", () => {
    expect(isSaidIdentity(bytes("v3_plain"))).toBe(true);
    expect(isSaidIdentity(new Uint8Array(8))).toBe(false);
    expect(isSaidIdentity(new Uint8Array(3))).toBe(false);
  });
});

describe("isSaidChainSeedCursor", () => {
  it("treats only a said: cursor as a completed inventory", () => {
    expect(isSaidChainSeedCursor(null)).toBe(true);
    expect(isSaidChainSeedCursor("")).toBe(true);
    expect(isSaidChainSeedCursor("s8004:123")).toBe(true);
    expect(isSaidChainSeedCursor("said:420000000")).toBe(false);
  });
});

/** Routes mocked JSON-RPC calls by method; every response is a valid envelope. */
function stubRpc(routes: Record<string, (params: unknown[]) => unknown>) {
  const fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: routes[body.method]!(body.params) }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A syntactically valid v3 account for a synthetic owner, cloned from a real one. */
function syntheticV3(index: number) {
  const data = new Uint8Array(Buffer.from(FIXTURES.v3_plain!.b64, "base64"));
  const ownerBytes = new Uint8Array(32);
  ownerBytes[0] = (index >> 8) + 1;
  ownerBytes[1] = index & 0xff;
  ownerBytes[31] = 9;
  data.set(ownerBytes, 8);
  data.set(ownerBytes, 40);
  return {
    owner: encodeBase58(ownerBytes),
    entry: {
      pubkey: encodeBase58(new Uint8Array(32).fill(0).map((_v, i) => (i === 0 ? 200 : i === 1 ? index & 0xff : i === 2 ? index >> 8 : 5))),
      account: { data: [Buffer.from(data).toString("base64"), "base64"] },
    },
  };
}

describe("fetchSaidChainState", () => {
  const rpcUrl = "https://rpc.test";

  it("reads the slot then one memcmp-filtered getProgramAccounts and builds a sorted draft per identity", async () => {
    const fetchMock = stubRpc({
      getSlot: () => 424242,
      getProgramAccounts: () => ["v3_plain", "v1_verified", "v2_verified"].map(key => ({ pubkey: FIXTURES[key]!.expected.pda, account: { data: [FIXTURES[key]!.b64, "base64"] } })),
    });
    const snapshot = await fetchSaidChainState({ source, seed: true, priorKeys: new Set(), rpcUrl, nowMs: NOW_MS });
    expect(snapshot.slot).toBe(424242);
    expect(snapshot.requestCount).toBe(2);
    expect(snapshot.enumeratedCount).toBe(3);
    expect(snapshot.layoutCounts).toEqual({ v1: 1, v2: 1, v3: 1 });
    const owners = snapshot.drafts.map(d => d.externalKey);
    expect([...owners].sort()).toEqual(owners);
    const gpaCall = JSON.parse((fetchMock.mock.calls[1] as unknown as [unknown, { body: string }])[1].body);
    expect(gpaCall.method).toBe("getProgramAccounts");
    expect(gpaCall.params[0]).toBe("5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G");
    // Independent base58 of discriminator 0b951f1bba4cf148 (computed outside this codebase).
    expect(gpaCall.params[1].filters).toEqual([{ memcmp: { offset: 0, bytes: "2wNAF3KUSPq" } }]);
    expect(gpaCall.params[1].encoding).toBe("base64");
  });

  it("refuses a source that is not the approved SAID registry or is not active", async () => {
    await expect(fetchSaidChainState({ source: { ...source, sourceKey: "other" } as IngestionSource, seed: true, priorKeys: new Set(), rpcUrl })).rejects.toThrow(/not the approved SAID/);
    await expect(fetchSaidChainState({ source: { ...source, state: "paused" } as IngestionSource, seed: true, priorKeys: new Set(), rpcUrl })).rejects.toThrow(/Only active sources/);
  });

  it("fails loudly when a truncated listing falls under the 98% floor of the prior pass", async () => {
    const live = Array.from({ length: 100 }, (_v, i) => syntheticV3(i));
    stubRpc({ getSlot: () => 7, getProgramAccounts: () => live.slice(0, 90).map(x => x.entry) });
    await expect(
      fetchSaidChainState({ source, seed: false, priorKeys: new Set(live.map(x => x.owner)), rpcUrl, nowMs: NOW_MS })
    ).rejects.toThrow(/under the 98% floor/);
  });

  it("counts, and never hides, a prior identity missing from a listing that is inside the floor", async () => {
    const live = Array.from({ length: 100 }, (_v, i) => syntheticV3(i));
    stubRpc({ getSlot: () => 7, getProgramAccounts: () => live.slice(0, 99).map(x => x.entry) });
    const snapshot = await fetchSaidChainState({ source, seed: false, priorKeys: new Set(live.map(x => x.owner)), rpcUrl, nowMs: NOW_MS });
    expect(snapshot.enumeratedCount).toBe(99);
    expect(snapshot.vanishedCount).toBe(1);
    expect(snapshot.drafts).toHaveLength(99);
  });

  it("exempts the seed pass from the floor (it has no prior count to trust)", async () => {
    const live = Array.from({ length: 5 }, (_v, i) => syntheticV3(i));
    stubRpc({ getSlot: () => 7, getProgramAccounts: () => live.map(x => x.entry) });
    const snapshot = await fetchSaidChainState({ source, seed: true, priorKeys: new Set(["x".repeat(44)]), rpcUrl, nowMs: NOW_MS });
    expect(snapshot.vanishedCount).toBe(0);
  });

  it("fails on a duplicate owner, which PDA seeds make impossible on a faithful read", async () => {
    const one = syntheticV3(1);
    stubRpc({ getSlot: () => 7, getProgramAccounts: () => [one.entry, { ...one.entry, pubkey: "G".repeat(44) }] });
    await expect(fetchSaidChainState({ source, seed: true, priorKeys: new Set(), rpcUrl, nowMs: NOW_MS })).rejects.toThrow(/twice/);
  });

  it("stops loudly past the account ceiling and on an unusable slot", async () => {
    stubRpc({ getSlot: () => 0, getProgramAccounts: () => [] });
    await expect(fetchSaidChainState({ source, seed: true, priorKeys: new Set(), rpcUrl })).rejects.toThrow(/no usable slot/);
    expect(SAID_CHAIN_MAX_ACCOUNTS).toBe(40_000);
  });
});
