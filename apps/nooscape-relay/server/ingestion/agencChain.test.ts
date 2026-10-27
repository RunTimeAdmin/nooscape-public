import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { IngestionSource } from "../../drizzle/schema";
import { encodeBase58 } from "./metaplexChain";
import {
  AGENC_ACCOUNT_BYTES,
  AGENC_AGENT_DISCRIMINATOR,
  AGENC_CHAIN_MAX_ACCOUNTS,
  AGENC_CHAIN_SOURCE_KEY,
  AGENC_PROGRAM,
  agencSignalNote,
  AgencValidationError,
  buildAgencDirectoryDraft,
  decodeAgencAgent,
  fetchAgencChainState,
  isAgencAgent,
  isAgencChainSeedCursor,
  parseAgencProgramAccounts,
  placeholderAgencName,
  publicHttpsHost,
} from "./agencChain";
import { AGENC_FIXTURES } from "./agencFixtures";

/**
 * The fixtures are REAL mainnet AgentRegistration accounts of the AgenC program, captured 2026-10-26 (agencFixtures.ts). The expected values
 * come from an independent Python decode of the same bytes, not from the code under test, so a shared misreading cannot hide.
 */
const STATUS_NAMES = ["Inactive", "Active", "Busy", "Suspended"];
const bytes = (key: string) => new Uint8Array(Buffer.from(AGENC_FIXTURES[key]!.b64, "base64"));
const pdaOf = (key: string) => AGENC_FIXTURES[key]!.expected.pda;
/** A fixed "now" after every fixture's times so the ceiling is deterministic. */
const NOW_MS = Date.UTC(2026, 9, 27);

const source = {
  id: "00000000-0000-4000-8000-0000000000b1",
  sourceKey: AGENC_CHAIN_SOURCE_KEY,
  protocol: "solana_agenc",
  state: "active",
  executionPolicy: "manual_only",
  cursor: null,
} as unknown as IngestionSource;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the constants", () => {
  it("name the AgentRegistration discriminator by Anchor's own rule, and one fixed account size", () => {
    const derived = createHash("sha256").update("account:AgentRegistration").digest().subarray(0, 8);
    expect(Array.from(derived)).toEqual(AGENC_AGENT_DISCRIMINATOR);
    expect(Buffer.from(AGENC_AGENT_DISCRIMINATOR).toString("hex")).toBe("82356467794d9413");
    expect(AGENC_PROGRAM).toBe("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
    for (const key of Object.keys(AGENC_FIXTURES)) expect(bytes(key).length, key).toBe(AGENC_ACCOUNT_BYTES);
  });
});

describe("decodeAgencAgent: real mainnet accounts", () => {
  for (const key of Object.keys(AGENC_FIXTURES)) {
    it("decodes " + key + " to the independently derived values", () => {
      const { expected } = AGENC_FIXTURES[key]!;
      const agent = decodeAgencAgent(expected.pda, bytes(key), NOW_MS);
      expect(agent.account).toBe(expected.pda);
      expect(agent.authority).toBe(expected.authority);
      expect(agent.status).toBe(STATUS_NAMES[expected.status]);
      expect(agent.endpoint).toBe(expected.endpoint);
      expect(agent.metadataUri).toBe(expected.metadataUri);
      expect(agent.registeredAtSeconds).toBe(expected.registeredAtSeconds);
      expect(agent.lastActiveSeconds).toBe(expected.lastActiveSeconds);
      expect(agent.tasksCompleted.toString()).toBe(expected.tasksCompleted);
      expect(agent.totalEarnedLamports.toString()).toBe(expected.totalEarnedLamports);
      expect(agent.reputation).toBe(expected.reputation);
      expect(agent.stakeLamports.toString()).toBe(expected.stakeLamports);
      expect(agent.tailResidue).toBe(false);
    });
  }

  it("reads an Inactive tombstone as Inactive with no stake, and a registered agent as Active", () => {
    expect(decodeAgencAgent(pdaOf("inactive_tombstone"), bytes("inactive_tombstone"), NOW_MS)).toMatchObject({ status: "Inactive", stakeLamports: BigInt(0) });
    expect(decodeAgencAgent(pdaOf("placeholder"), bytes("placeholder"), NOW_MS).status).toBe("Active");
  });

  it("keeps a wallet that holds the agent apart from the agent's own account", () => {
    const agent = decodeAgencAgent(pdaOf("first_party_top"), bytes("first_party_top"), NOW_MS);
    expect(agent.account).not.toBe(agent.authority);
  });
});

describe("decodeAgencAgent: fail-closed strictness", () => {
  const account = pdaOf("placeholder");
  const mutate = (key: string, edit: (data: Uint8Array, view: DataView) => void) => {
    const data = bytes(key);
    edit(data, new DataView(data.buffer));
    return data;
  };
  // The status byte, the endpoint length, and (after the endpoint's bytes) the metadata length, in the fixed head of the account.
  const STATUS_AT = 8 + 32 + 32 + 8;
  const ENDPOINT_LENGTH_AT = STATUS_AT + 1;
  const metadataLengthAt = (key: string) => ENDPOINT_LENGTH_AT + 4 + new DataView(bytes(key).buffer).getUint32(ENDPOINT_LENGTH_AT, true);
  /** The offset of registered_at: past both strings. */
  const afterStrings = (key: string) => metadataLengthAt(key) + 4 + new DataView(bytes(key).buffer).getUint32(metadataLengthAt(key), true);

  it("rejects an account whose length is not the approved size", () => {
    expect(() => decodeAgencAgent(account, new Uint8Array(300), NOW_MS)).toThrow(AgencValidationError);
    expect(() => decodeAgencAgent(account, bytes("placeholder").subarray(0, AGENC_ACCOUNT_BYTES - 1), NOW_MS)).toThrow("not the approved 566");
    expect(() => decodeAgencAgent(account, new Uint8Array(AGENC_ACCOUNT_BYTES + 1), NOW_MS)).toThrow("not the approved 566");
  });

  it("rejects the wrong discriminator at the approved size", () => {
    const data = mutate("placeholder", d => {
      d[0] = 0;
    });
    expect(() => decodeAgencAgent(account, data, NOW_MS)).toThrow("discriminator");
  });

  it("rejects a status byte the program has no name for", () => {
    const data = mutate("placeholder", d => {
      d[STATUS_AT] = 4;
    });
    expect(() => decodeAgencAgent(account, data, NOW_MS)).toThrow("invalid status byte 4");
  });

  it("rejects an endpoint length past the program's own 256-byte bound", () => {
    const data = mutate("placeholder", (_d, view) => view.setUint32(ENDPOINT_LENGTH_AT, 257, true));
    expect(() => decodeAgencAgent(account, data, NOW_MS)).toThrow("past its bound");
  });

  it("rejects a metadata_uri length past the program's own 128-byte bound", () => {
    const at = metadataLengthAt("placeholder");
    const data = mutate("placeholder", (_d, view) => view.setUint32(at, 129, true));
    expect(() => decodeAgencAgent(account, data, NOW_MS)).toThrow("past its bound");
  });

  it("rejects an endpoint that is not valid UTF-8", () => {
    const data = mutate("placeholder", d => {
      d[ENDPOINT_LENGTH_AT + 4] = 0xff;
    });
    expect(() => decodeAgencAgent(account, data, NOW_MS)).toThrow("not valid UTF-8");
  });

  it("rejects a registered_at or last_active outside the plausible window (a misread layout)", () => {
    const at = afterStrings("placeholder");
    const early = mutate("placeholder", (_d, view) => view.setBigInt64(at, BigInt(0), true));
    expect(() => decodeAgencAgent(account, early, NOW_MS)).toThrow("plausible window");
    const future = mutate("placeholder", (_d, view) => view.setBigInt64(at, BigInt(Math.floor(NOW_MS / 1000) + 90 * 86_400), true));
    expect(() => decodeAgencAgent(account, future, NOW_MS)).toThrow("plausible window");
    const lastActive = mutate("placeholder", (_d, view) => view.setBigInt64(at + 8, BigInt(0), true));
    expect(() => decodeAgencAgent(account, lastActive, NOW_MS)).toThrow("last_active");
  });

  it("rejects a reputation past the program's own 10,000", () => {
    const at = afterStrings("placeholder") + 32;
    const data = mutate("placeholder", (_d, view) => view.setUint16(at, 10_001, true));
    expect(() => decodeAgencAgent(account, data, NOW_MS)).toThrow("past the program's own bound");
    const edge = mutate("placeholder", (_d, view) => view.setUint16(at, 10_000, true));
    expect(decodeAgencAgent(account, edge, NOW_MS).reputation).toBe(10_000);
  });

  it("measures a byte left over past the last field and does not fail on it", () => {
    const data = mutate("placeholder", d => {
      d[AGENC_ACCOUNT_BYTES - 1] = 1;
    });
    expect(decodeAgencAgent(account, data, NOW_MS).tailResidue).toBe(true);
  });
});

describe("publicHttpsHost", () => {
  it("returns the lowercased host of an https address that names a public service", () => {
    expect(publicHttpsHost("https://axon-agents.com")).toBe("axon-agents.com");
    expect(publicHttpsHost("https://API.Example.COM/Path?q=1")).toBe("api.example.com");
    expect(publicHttpsHost("https://agenc.ag/worker")).toBe("agenc.ag");
    expect(publicHttpsHost("https://example.com:8443/x")).toBe("example.com");
    expect(publicHttpsHost("https://paste.rs/A2S9V")).toBe("paste.rs");
  });

  it("gives the placeholder and every reserved name no host, so a thousand of them would not read as one shared host", () => {
    for (const address of [
      "https://agent.local",
      "https://agent.local/lex",
      "https://swarm.local",
      "https://grok-test-creator.agenc.local",
      "https://example.invalid",
      "https://x.test",
      "https://demo.example",
      "https://box.internal",
      "https://localhost",
      "https://localhost:8443/x",
      "https://intranet/",
    ]) {
      expect(publicHttpsHost(address), address).toBeNull();
    }
  });

  it("gives an address literal no host, in whatever form it was typed", () => {
    for (const address of ["https://127.0.0.1/x", "https://10.0.0.7", "https://2130706433/", "https://0x7f.1/", "https://[::1]/", "https://[2001:db8::1]:8443/"]) {
      expect(publicHttpsHost(address), address).toBeNull();
    }
  });

  it("gives anything that is not an https address no host", () => {
    for (const address of ["http://example.com", "ftp://example.com", "lex-agenc-worker", "", "https://", "example.com"]) {
      expect(publicHttpsHost(address), address).toBeNull();
    }
  });
});

describe("directory draft and signal note", () => {
  const draftOf = (key: string) => buildAgencDirectoryDraft(decodeAgencAgent(pdaOf(key), bytes(key), NOW_MS));
  const noteOf = (key: string) => agencSignalNote(decodeAgencAgent(pdaOf(key), bytes(key), NOW_MS));

  it("keys the entry on the agent's own account and records the controlling wallet as registrant", () => {
    const draft = draftOf("first_party_top");
    expect(draft.externalKey).toBe(pdaOf("first_party_top"));
    expect(draft.accountPubkey).toBe(pdaOf("first_party_top"));
    expect(draft.registrant).toBe(AGENC_FIXTURES.first_party_top!.expected.authority);
    expect(draft.displayName).toBe(placeholderAgencName(pdaOf("first_party_top")));
    expect(draft.displayName).toBe("AgenC agent 3cZeUpRd");
    expect(draft.feedbackCount).toBeUndefined();
    expect(draft.listing).toBeUndefined();
  });

  it("takes the locator host from a public endpoint first, then from the profile link, and from neither when both are placeholders", () => {
    expect(draftOf("third_party_host").locatorHost).toBe("axon-agents.com");
    expect(draftOf("first_party_top").locatorHost).toBe("agenc.ag");
    // The endpoint is on AgenC's own domain and the profile link is a third party's: the endpoint is read first.
    expect(draftOf("own_domain_third_party_profile").locatorHost).toBe("agenc.ag");
    expect(draftOf("third_party_profile").locatorHost).toBe("api.xona-agent.com");
    expect(draftOf("placeholder").locatorHost).toBeNull();
    expect(draftOf("placeholder_with_path").locatorHost).toBeNull();
    // A profile link that is no address at all, and a placeholder endpoint: no host.
    expect(draftOf("non_url_metadata").locatorHost).toBeNull();
  });

  it("falls back to the profile link's host when the endpoint is a placeholder", () => {
    const agent = { ...decodeAgencAgent(pdaOf("placeholder"), bytes("placeholder"), NOW_MS), metadataUri: "https://visionaire.live/api/discovery" };
    expect(buildAgencDirectoryDraft(agent).locatorHost).toBe("visionaire.live");
  });

  it("fingerprints the whole profile link, and records none when there is none", () => {
    expect(draftOf("placeholder").profileUriHash).toBeNull();
    const meta = AGENC_FIXTURES.third_party_profile!.expected.metadataUri;
    expect(draftOf("third_party_profile").profileUriHash).toBe(createHash("sha256").update(meta, "utf8").digest("hex"));
    // Text that is no link is fingerprinted the same way: it is stored as a hash and never read as an address.
    expect(draftOf("non_url_metadata").profileUriHash).toBe(createHash("sha256").update("lex-agenc-worker", "utf8").digest("hex"));
  });

  it("reports the program's counters exactly as recorded and says whose counter the reputation is", () => {
    const note = noteOf("first_party_top");
    expect(note).toContain("registered 2026-07-02, last active 2026-10-12");
    expect(note).toContain("status: Active");
    expect(note).toContain("tasks completed: 378");
    expect(note).toContain("earned: 1.270223 SOL (the program's own lifetime counter)");
    expect(note).toContain("stake: 0.01 SOL");
    expect(note).toContain("reputation: 10000 of 10000 (a counter the AgenC program keeps, not a Nooscape score)");
    expect(note).toContain("chain facts as recorded, not scored");
    // This endpoint is a public name, so the note has nothing to say about it.
    expect(note).not.toContain("endpoint:");
    expect(note.length).toBeLessThanOrEqual(512);
  });

  it("says plainly that a placeholder endpoint is not a service address, and gives an agent with no stake no stake line of zeros", () => {
    expect(noteOf("placeholder")).toContain("endpoint: a placeholder or reserved name, not a service address");
    expect(noteOf("placeholder")).toContain("tasks completed: 0");
    expect(noteOf("placeholder")).toContain("earned: 0 SOL");
    const tombstone = noteOf("inactive_tombstone");
    expect(tombstone).toContain("status: Inactive");
    expect(tombstone).toContain("stake: none");
    expect(tombstone).not.toContain("0 SOL stake");
    expect(noteOf("large_stake")).toContain("stake: 0.1 SOL");
    expect(noteOf("non_url_metadata")).toContain("earned: 0.0095 SOL");
  });

  it("never scores, ranks or grades, and fits the column", () => {
    for (const key of Object.keys(AGENC_FIXTURES)) {
      const note = noteOf(key);
      expect(note.length, key).toBeLessThanOrEqual(512);
      expect(note, key).not.toMatch(/(trusted|verified|reliable|safe|good|best|top)/i);
    }
  });

  it("is deterministic: an unchanged agent rewrites an identical note and draft", () => {
    expect(noteOf("third_party_profile")).toBe(noteOf("third_party_profile"));
    expect(draftOf("own_domain_third_party_profile")).toEqual(draftOf("own_domain_third_party_profile"));
  });
});

describe("parseAgencProgramAccounts", () => {
  const entry = (key: string) => ({ pubkey: pdaOf(key), account: { data: [AGENC_FIXTURES[key]!.b64, "base64"] } });

  it("decodes registration-discriminated entries and counts others as unknown, never parsed", () => {
    const other = Buffer.alloc(40);
    other.writeUInt8(1, 0);
    const { agents, unknownCount } = parseAgencProgramAccounts(
      [entry("first_party_top"), entry("placeholder"), { pubkey: "F".repeat(44), account: { data: [other.toString("base64"), "base64"] } }],
      NOW_MS
    );
    expect(agents.map(agent => agent.status)).toEqual(["Active", "Active"]);
    expect(unknownCount).toBe(1);
  });

  it("fails the pass on an envelope violation or a decode failure under the registration discriminator", () => {
    expect(() => parseAgencProgramAccounts({ not: "an array" }, NOW_MS)).toThrow("must be an array");
    expect(() => parseAgencProgramAccounts([{ pubkey: "F".repeat(44) }], NOW_MS)).toThrow("without a pubkey and base64 data tuple");
    const truncated = Buffer.concat([Buffer.from(AGENC_AGENT_DISCRIMINATOR), Buffer.alloc(100)]);
    expect(() => parseAgencProgramAccounts([{ pubkey: "F".repeat(44), account: { data: [truncated.toString("base64"), "base64"] } }], NOW_MS)).toThrow("not the approved 566");
  });

  it("recognizes the discriminator only", () => {
    expect(isAgencAgent(bytes("placeholder"))).toBe(true);
    expect(isAgencAgent(new Uint8Array(8))).toBe(false);
    expect(isAgencAgent(new Uint8Array(3))).toBe(false);
  });
});

describe("isAgencChainSeedCursor", () => {
  it("treats only an agenc: cursor as a completed inventory", () => {
    expect(isAgencChainSeedCursor(null)).toBe(true);
    expect(isAgencChainSeedCursor("")).toBe(true);
    expect(isAgencChainSeedCursor("said:123")).toBe(true);
    expect(isAgencChainSeedCursor("s8004:123")).toBe(true);
    expect(isAgencChainSeedCursor("agenc:461650417")).toBe(false);
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

/** A syntactically valid account at a synthetic address, cloned from a real one: the address is the agent's identity, the bytes need not differ. */
function synthetic(index: number, key = "placeholder") {
  const pubkey = encodeBase58(new Uint8Array(32).map((_v, i) => (i === 0 ? 200 : i === 1 ? index & 0xff : i === 2 ? index >> 8 : 5)));
  return { pubkey, entry: { pubkey, account: { data: [AGENC_FIXTURES[key]!.b64, "base64"] } } };
}

describe("fetchAgencChainState", () => {
  const rpcUrl = "https://rpc.test";

  it("reads the slot then one memcmp-filtered getProgramAccounts and builds a sorted draft per agent", async () => {
    const fetchMock = stubRpc({
      getSlot: () => 461650417,
      getProgramAccounts: () => ["third_party_profile", "first_party_top", "placeholder"].map(key => ({ pubkey: pdaOf(key), account: { data: [AGENC_FIXTURES[key]!.b64, "base64"] } })),
    });
    const snapshot = await fetchAgencChainState({ source, seed: true, priorKeys: new Set(), rpcUrl, nowMs: NOW_MS });
    expect(snapshot.slot).toBe(461650417);
    expect(snapshot.requestCount).toBe(2);
    expect(snapshot.enumeratedCount).toBe(3);
    expect(snapshot.tailResidueCount).toBe(0);
    expect(snapshot.vanishedCount).toBe(0);
    const keys = snapshot.drafts.map(d => d.externalKey);
    expect([...keys].sort()).toEqual(keys);
    const gpaCall = JSON.parse((fetchMock.mock.calls[1] as unknown as [unknown, { body: string }])[1].body);
    expect(gpaCall.method).toBe("getProgramAccounts");
    expect(gpaCall.params[0]).toBe("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
    // Independent base58 of discriminator 82356467794d9413 (computed outside this codebase). No size filter: an account at another size must fail loudly, not vanish.
    expect(gpaCall.params[1].filters).toEqual([{ memcmp: { offset: 0, bytes: "NnBoGyMErrE" } }]);
    expect(gpaCall.params[1].encoding).toBe("base64");
  });

  it("refuses a source that is not the approved AgenC registry or is not active", async () => {
    await expect(fetchAgencChainState({ source: { ...source, sourceKey: "other" } as IngestionSource, seed: true, priorKeys: new Set(), rpcUrl })).rejects.toThrow("not the approved AgenC");
    await expect(fetchAgencChainState({ source: { ...source, protocol: "solana_said" } as IngestionSource, seed: true, priorKeys: new Set(), rpcUrl })).rejects.toThrow("not the approved AgenC");
    await expect(fetchAgencChainState({ source: { ...source, state: "paused" } as IngestionSource, seed: true, priorKeys: new Set(), rpcUrl })).rejects.toThrow("Only active sources");
  });

  it("fails loudly when a truncated listing falls under the 98% floor of the prior pass", async () => {
    const live = Array.from({ length: 100 }, (_v, i) => synthetic(i));
    stubRpc({ getSlot: () => 7, getProgramAccounts: () => live.slice(0, 90).map(x => x.entry) });
    await expect(fetchAgencChainState({ source, seed: false, priorKeys: new Set(live.map(x => x.pubkey)), rpcUrl, nowMs: NOW_MS })).rejects.toThrow("under the 98% floor");
  });

  it("counts, and never hides, a prior agent missing from a listing that is inside the floor", async () => {
    const live = Array.from({ length: 100 }, (_v, i) => synthetic(i));
    stubRpc({ getSlot: () => 7, getProgramAccounts: () => live.slice(0, 99).map(x => x.entry) });
    const snapshot = await fetchAgencChainState({ source, seed: false, priorKeys: new Set(live.map(x => x.pubkey)), rpcUrl, nowMs: NOW_MS });
    expect(snapshot.enumeratedCount).toBe(99);
    expect(snapshot.vanishedCount).toBe(1);
    expect(snapshot.drafts).toHaveLength(99);
  });

  it("exempts the seed pass from the floor (it has no prior count to trust)", async () => {
    const live = Array.from({ length: 5 }, (_v, i) => synthetic(i));
    stubRpc({ getSlot: () => 7, getProgramAccounts: () => live.map(x => x.entry) });
    const snapshot = await fetchAgencChainState({ source, seed: true, priorKeys: new Set(["x".repeat(44)]), rpcUrl, nowMs: NOW_MS });
    expect(snapshot.vanishedCount).toBe(0);
  });

  it("fails on a duplicate account, which one address makes impossible on a faithful read", async () => {
    const one = synthetic(1);
    stubRpc({ getSlot: () => 7, getProgramAccounts: () => [one.entry, one.entry] });
    await expect(fetchAgencChainState({ source, seed: true, priorKeys: new Set(), rpcUrl, nowMs: NOW_MS })).rejects.toThrow("twice");
  });

  it("counts an account with bytes past the last field, and still builds its draft", async () => {
    const residue = Buffer.from(AGENC_FIXTURES.placeholder!.b64, "base64");
    residue[AGENC_ACCOUNT_BYTES - 1] = 1;
    stubRpc({ getSlot: () => 7, getProgramAccounts: () => [{ pubkey: pdaOf("placeholder"), account: { data: [residue.toString("base64"), "base64"] } }] });
    const snapshot = await fetchAgencChainState({ source, seed: true, priorKeys: new Set(), rpcUrl, nowMs: NOW_MS });
    expect(snapshot.tailResidueCount).toBe(1);
    expect(snapshot.drafts).toHaveLength(1);
  });

  it("stops loudly on a registration it cannot decode, past the account ceiling, and on an unusable slot", async () => {
    const wrongSize = Buffer.concat([Buffer.from(AGENC_AGENT_DISCRIMINATOR), Buffer.alloc(100)]);
    stubRpc({ getSlot: () => 7, getProgramAccounts: () => [{ pubkey: pdaOf("placeholder"), account: { data: [wrongSize.toString("base64"), "base64"] } }] });
    await expect(fetchAgencChainState({ source, seed: true, priorKeys: new Set(), rpcUrl, nowMs: NOW_MS })).rejects.toThrow("not the approved 566");
    stubRpc({ getSlot: () => 0, getProgramAccounts: () => [] });
    await expect(fetchAgencChainState({ source, seed: true, priorKeys: new Set(), rpcUrl })).rejects.toThrow("no usable slot");
    expect(AGENC_CHAIN_MAX_ACCOUNTS).toBe(5_000);
  });
});
