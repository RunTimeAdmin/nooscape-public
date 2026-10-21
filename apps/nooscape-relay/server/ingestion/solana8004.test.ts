import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { IngestionSource } from "../../drizzle/schema";
import {
  assertApprovedSolana8004ChainSource,
  buildSolana8004ChainLinks,
  buildSolana8004MetadataResolutions,
  classifySolana8004Diff,
  decodeSolana8004AgentAccount,
  decodeSolana8004MetadataAccount,
  extractSolana8004ProgramLogs,
  fetchSolana8004ChainState,
  hashRegistrationUri,
  isPlaceholderSolana8004Name,
  isSolana8004ChainSeedCursor,
  matchSolana8004EventTransaction,
  parseSolana8004MetadataAccounts,
  parseSolana8004ProgramAccounts,
  placeholderSolana8004Name,
  selectSolana8004FetchQueue,
  Solana8004ValidationError,
  SOLANA_8004_ATTRIBUTION_TX_FETCH_CAP,
  SOLANA_8004_CHAIN_MAX_ACCOUNTS,
  SOLANA_8004_CHAIN_MAX_EVENTS_PER_PASS,
  SOLANA_8004_CHAIN_SIGNAL_NOTE,
  SOLANA_8004_CHAIN_SOURCE_KEY,
  SOLANA_8004_FETCH_BUDGET_PER_PASS,
  SOLANA_8004_PROGRAM,
  successfulSignatureList,
} from "./solana8004";
import type {
  Solana8004AgentAccount,
  Solana8004DiffEvent,
  Solana8004MetadataEntry,
  Solana8004PriorEntry,
  Solana8004PriorResolution,
} from "./solana8004";
import { RESOLUTION_FAILED_MAX_ATTEMPTS, RESOLUTION_NO_NAME_MAX_ATTEMPTS } from "./registrationFetch";
import { encodeBase58 } from "./metaplexChain";

// The pacing-verification tests sleep against the real ~1.2s RPC cadence
// without fake timers, which lands within a whisker of Vitest's 5s default
// (review 2026-10-12 saw two near-miss failures in a fresh clone). Give the
// file an explicit ceiling instead of leaving it environment-flaky.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Byte-exact fixtures of the live-verified AgentAccount layout (1,504 of
 * 1,504 accounts decoded 2026-10-11): discriminator, collection, creator,
 * owner [72..104), asset [104..136), bump, atom_enabled, agent_wallet Option,
 * three reputation windows (skipped), parent_asset Option, two lock bytes,
 * then the agent_uri / nft_name / col Strings, with stale Anchor padding
 * residue possible past col.
 */
const DISCRIMINATOR = [0xf1, 0x77, 0x45, 0x8c, 0xe9, 0x09, 0x70, 0x32];
const ZERO32 = new Uint8Array(32);
const ownerBytes = (last: number) => {
  const bytes = new Uint8Array(32);
  bytes[31] = last;
  return bytes;
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const OWNER_A = encodeBase58(ownerBytes(1));
const OWNER_B = encodeBase58(ownerBytes(2));
const OWNER_C = encodeBase58(ownerBytes(3));
const ASSET_1 = encodeBase58(ZERO32);
const ASSET_2 = encodeBase58(ownerBytes(7));
const ASSET_3 = encodeBase58(ownerBytes(8));
const ACCOUNT_PDA = "A".repeat(44);
const SIGNATURE = "5".repeat(88);

type AgentFixtureOptions = {
  owner: Uint8Array;
  asset: Uint8Array;
  uri?: string;
  nftName?: string;
  col?: string;
  wallet?: "none" | "some";
  parent?: "none" | "some";
  feedbackCount?: number;
  residue?: boolean;
};

function agentAccountData(options: AgentFixtureOptions): Uint8Array {
  const uri = options.uri ?? "";
  const nftName = options.nftName ?? "Agent";
  const col = options.col ?? "";
  const uriBytes = Buffer.from(uri, "utf8");
  const nftNameBytes = Buffer.from(nftName, "utf8");
  const colBytes = Buffer.from(col, "utf8");
  const data = new Uint8Array(748);
  data.set(DISCRIMINATOR, 0);
  data.set(options.owner, 72);
  data.set(options.asset, 104);
  data[136] = 255; // bump
  data[137] = 0; // atom_enabled
  let offset = 138;
  if (options.wallet === "some") {
    data[offset] = 1;
    data.set(options.owner, offset + 1);
    offset += 33;
  } else {
    data[offset] = 0;
    offset += 1;
  }
  // Three reputation windows, each a 32-byte digest plus a u64 count. The
  // first window's count is the feedback counter the decode reads (default
  // zero); the digests stay zero.
  const feedback = options.feedbackCount ?? 0;
  new DataView(data.buffer).setUint32(offset + 32, feedback >>> 0, true);
  new DataView(data.buffer).setUint32(offset + 36, Math.floor(feedback / 4294967296), true);
  offset += (32 + 8) * 3;
  if (options.parent === "some") {
    data[offset] = 1;
    data.set(options.asset, offset + 1);
    offset += 33;
  } else {
    data[offset] = 0;
    offset += 1;
  }
  data[offset] = 0; // parent_locked
  data[offset + 1] = 0; // col_locked
  offset += 2;
  const view = new DataView(data.buffer);
  view.setUint32(offset, uriBytes.length, true);
  data.set(uriBytes, offset + 4);
  offset += 4 + uriBytes.length;
  view.setUint32(offset, nftNameBytes.length, true);
  data.set(nftNameBytes, offset + 4);
  offset += 4 + nftNameBytes.length;
  view.setUint32(offset, colBytes.length, true);
  data.set(colBytes, offset + 4);
  offset += 4 + colBytes.length;
  if (options.residue) {
    // Stale Anchor padding residue: in-place rewrites never zero the tail, so
    // bytes past col can carry fragments of prior field values. Counted by the
    // decode, never parsed.
    data.set(Buffer.from("db47581563/raw/vedetta-registration.json", "utf8"), offset);
  }
  return data;
}

const liveAccount = (
  asset: string,
  owner: string,
  displayName = "Alpha",
  locatorHost: string | null = null,
  account = ACCOUNT_PDA,
  uri = "",
  feedbackCount = 0
): Solana8004AgentAccount => ({
  account,
  asset,
  owner,
  displayName,
  locatorHost,
  profileUriHash: hashRegistrationUri(uri),
  uri,
  feedbackCount,
  tailResidue: false,
});

const priorEntry = (overrides: Partial<Solana8004PriorEntry> = {}): Solana8004PriorEntry => ({
  displayName: "Alpha",
  locatorHost: null,
  registrant: OWNER_A,
  // Migration-0026 chain facts: both null until the row's first live pass
  // under the new schema — a null PDA closes unconfirmed, a null hash adopts.
  accountPubkey: null,
  profileUriHash: null,
  closed: false,
  ...overrides,
});

const approvedSource = {
  id: "source-1",
  protocol: "solana_8004",
  sourceKey: SOLANA_8004_CHAIN_SOURCE_KEY,
  state: "active",
  cursor: null,
} as unknown as IngestionSource;

/** Routes mocked JSON-RPC calls by method; every response is a valid envelope. */
function stubRpc(routes: Record<string, (params: unknown[]) => unknown>) {
  const fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const value = routes[body.method](body.params);
    // A route answers with an RPC error by returning { rpcError }.
    const envelope = value !== null && typeof value === "object" && "rpcError" in value ? { error: (value as { rpcError: unknown }).rpcError } : { result: value };
    return {
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, ...envelope }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Floor-safe closure fixtures. Closure detection is absence-based and the pass
 * holds a 98%-of-prior-live enumeration floor, so a closure test needs enough
 * unchanged filler agents that its vanished rows never look like a truncated
 * listing: one closure among fifty live priors and two among a hundred sit
 * exactly on the floor — the boundary the guard must let through. The gPA
 * entries' asset bytes are index-aligned with fillerAssets, so both helpers
 * must receive the same array (or a zero-based prefix of it).
 */
const FILLER_URI = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Alpha" }))}`;
const fillerAssets = (count: number) => Array.from({ length: count }, (_unused, index) => encodeBase58(ownerBytes(index + 10)));
const fillerPrior = (assets: string[]) => {
  const prior = new Map<string, Solana8004PriorEntry>();
  for (const asset of assets) prior.set(asset, priorEntry({ registrant: OWNER_A }));
  return prior;
};
const fillerEntries = (assets: string[]) =>
  assets.map((_asset, index) => ({
    pubkey: "F".repeat(44),
    account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(index + 10), uri: FILLER_URI })), "base64"] },
  }));

/** Byte-exact MetadataEntryPda fixture: 332 bytes, asset [8..40), flag [40], bump [41], borsh key/value Strings. */
const METADATA_DISCRIMINATOR = [0x30, 0x91, 0x0c, 0xf9, 0xb0, 0x8d, 0xc5, 0xbb];
function metadataAccountData(asset: Uint8Array, key: string, value: string): Uint8Array {
  const keyBytes = Buffer.from(key, "utf8");
  const valueBytes = Buffer.from(value, "utf8");
  const data = new Uint8Array(332);
  data.set(METADATA_DISCRIMINATOR, 0);
  data.set(asset, 8);
  data[40] = 0; // flag
  data[41] = 255; // bump
  const view = new DataView(data.buffer);
  view.setUint32(42, keyBytes.length, true);
  data.set(keyBytes, 46);
  view.setUint32(46 + keyBytes.length, valueBytes.length, true);
  data.set(valueBytes, 50 + keyBytes.length);
  return data;
}

const metaEntry = (asset: string, key: string, value: string): Solana8004MetadataEntry => ({
  account: "M".repeat(44),
  asset,
  key,
  value,
});

/** SHA-256 hex of a chain-link value, mirroring the adapter's value hash. */
const valueHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * The log lines of a live mainnet transaction (slot 458702358, 2026-10-19) that registered an agent with the Register instruction and
 * transferred it in the same transaction. The pass could not anchor a registration like it, and failed on it every run from 04:30Z.
 */
const LIVE_REGISTER_TX_ASSET = "7P4yoGVyHMrws4QpKQB7E4vLoG6d59JjcMNAsxsApDDc";
const LIVE_REGISTER_TX_LOGS = [
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ invoke [1]",
  "Program log: Instruction: Register",
  "Program 11111111111111111111111111111111 invoke [2]",
  "Program 11111111111111111111111111111111 success",
  "Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d invoke [2]",
  "Program log: Instruction: CreateV2",
  "Program 11111111111111111111111111111111 invoke [3]",
  "Program 11111111111111111111111111111111 success",
  "Program log: programs/mpl-core/src/state/collection.rs:139:Approve",
  "Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d consumed 10742 of 972293 compute units",
  "Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d success",
  "Program data: v07ZNuhkvVVezWYTaUHctiAPnz1YTXKInaPmJemD5Q818zJsIVXUc7sydwYA8G3Dg7tcYRz3ZGvu0Y1fc38D0iwbOgosIZij0ZCEY7jvjxnCptWkC+Ul4EVadp/wv7rqdmY9MHb93sABSgAAAGh0dHBzOi8vYXNzYXktMjA3OTA4NDQ5NjMwLnVzLWNlbnRyYWwxLnJ1bi5hcHAvLndlbGwta25vd24vYWdlbnQtY2FyZC5qc29u",
  "Program log: Agent registered: 7P4yoGVyHMrws4QpKQB7E4vLoG6d59JjcMNAsxsApDDc in collection DbjsWo7iUs7QZyJxLgNyVxvAAjQZCXroJHoGok8h8Umg",
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ consumed 47391 of 1000000 compute units",
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ success",
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ invoke [1]",
  "Program log: Instruction: SetMetadataPda",
  "Program 11111111111111111111111111111111 invoke [2]",
  "Program 11111111111111111111111111111111 success",
  "Program data: vn1Hdw4fGsVezWYTaUHctiAPnz1YTXKInaPmJemD5Q818zJsIVXUcwAEAAAAbmFtZRUAAABBc3NheSBBMkEgT2JzZXJ2YXRvcnk=",
  "Program log: Metadata 'name' set for asset 7P4yoGVyHMrws4QpKQB7E4vLoG6d59JjcMNAsxsApDDc (immutable: false)",
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ consumed 23953 of 952609 compute units",
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ success",
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ invoke [1]",
  "Program log: Instruction: SetMetadataPda",
  "Program 11111111111111111111111111111111 invoke [2]",
  "Program 11111111111111111111111111111111 success",
  "Program data: vn1Hdw4fGsVezWYTaUHctiAPnz1YTXKInaPmJemD5Q818zJsIVXUcwALAAAAeDQwMlN1cHBvcnQEAAAAdHJ1ZQ==",
  "Program log: Metadata 'x402Support' set for asset 7P4yoGVyHMrws4QpKQB7E4vLoG6d59JjcMNAsxsApDDc (immutable: false)",
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ consumed 27096 of 928656 compute units",
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ success",
  "Program AToMw53aiPQ8j7iHVb4fGt6nzUNxUhcPc3tbPBZuzVVb invoke [1]",
  "Program log: Instruction: InitializeStats",
  "Program 11111111111111111111111111111111 invoke [2]",
  "Program 11111111111111111111111111111111 success",
  "Program data: XXpooWnYgz1ezWYTaUHctiAPnz1YTXKInaPmJemD5Q818zJsIVXUc7sydwYA8G3Dg7tcYRz3ZGvu0Y1fc38D0iwbOgosIZij",
  "Program AToMw53aiPQ8j7iHVb4fGt6nzUNxUhcPc3tbPBZuzVVb consumed 29447 of 901560 compute units",
  "Program AToMw53aiPQ8j7iHVb4fGt6nzUNxUhcPc3tbPBZuzVVb success",
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ invoke [1]",
  "Program log: Instruction: TransferAgent",
  "Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d invoke [2]",
  "Program log: Instruction: Transfer",
  "Program log: programs/mpl-core/src/state/asset.rs:293:Approve",
  "Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d consumed 5380 of 858751 compute units",
  "Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d success",
  "Program data: ZeS4/BS5RvlezWYTaUHctiAPnz1YTXKInaPmJemD5Q818zJsIVXUc9GQhGO4748ZwqbVpAvlJeBFWnaf8L+66nZmPTB2/d7AAgPNT+BdhY6VzwP+dgtXPEGaNI9Biz/4a7Z8TVZsl8I=",
  "Program log: Agent transferred: F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq -> 8sBKU91gXbpKexboXAeYwoGFLK9LaT4SJAefdJN2tC1",
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ consumed 27033 of 872113 compute units",
  "Program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ success"
];

describe("8004 Solana chain adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("decodeSolana8004AgentAccount", () => {
    it("decodes the live-verified layout with None wallet and parent Options", () => {
      const decoded = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) })
      );
      expect(decoded).toEqual({
        account: ACCOUNT_PDA,
        asset: ASSET_2,
        owner: OWNER_A,
        displayName: `8004 agent ${ASSET_2.slice(0, 12)}`,
        locatorHost: null,
        profileUriHash: hashRegistrationUri(""),
        uri: "",
        feedbackCount: 0,
        tailResidue: false,
      });
    });

    it("walks Some Option tags without misreading the string section", () => {
      // The borsh Option arithmetic is the heart of the layout: Some adds 32
      // bytes past the tag, None adds none. Both shapes must land the strings
      // at the same place the live probe verified.
      const none = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), uri: "https://agent.example.org/card.json" })
      );
      const some = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({
          owner: ownerBytes(1),
          asset: ownerBytes(7),
          uri: "https://agent.example.org/card.json",
          wallet: "some",
          parent: "some",
        })
      );
      expect(some.locatorHost).toBe("agent.example.org");
      expect(some.displayName).toBe(none.displayName);
    });

    it("takes the display name from inline data: and raw-JSON registration URIs", () => {
      const percent = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({
          owner: ownerBytes(1),
          asset: ownerBytes(7),
          uri: `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Pct Name" }))}`,
        })
      );
      expect(percent.displayName).toBe("Pct Name");
      const base64 = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({
          owner: ownerBytes(1),
          asset: ownerBytes(7),
          uri: `data:application/json;base64,${Buffer.from(JSON.stringify({ name: "Base Name" }), "utf8").toString("base64")}`,
        })
      );
      expect(base64.displayName).toBe("Base Name");
      const raw = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({
          owner: ownerBytes(1),
          asset: ownerBytes(7),
          uri: JSON.stringify({ name: "Raw Name", version: 1 }),
        })
      );
      expect(raw.displayName).toBe("Raw Name");
    });

    it("reads the locator host from an https URI only", () => {
      const https = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), uri: "https://Agent.Example.ORG/card.json" })
      );
      expect(https.locatorHost).toBe("agent.example.org");
      const ipfs = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), uri: "ipfs://bafyexample" })
      );
      expect(ipfs.locatorHost).toBeNull();
      const inline = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({
          owner: ownerBytes(1),
          asset: ownerBytes(7),
          uri: `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Inline" }))}`,
        })
      );
      expect(inline.locatorHost).toBeNull();
      const empty = decodeSolana8004AgentAccount(ACCOUNT_PDA, agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) }));
      expect(empty.locatorHost).toBeNull();
    });

    it("prefers a future real nft_name over the synthetic fallback but never over the inline name", () => {
      const realName = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), nftName: "Future Name", uri: "ipfs://bafyexample" })
      );
      expect(realName.displayName).toBe("Future Name");
      const inlineWins = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({
          owner: ownerBytes(1),
          asset: ownerBytes(7),
          nftName: "Future Name",
          uri: `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Inline" }))}`,
        })
      );
      expect(inlineWins.displayName).toBe("Inline");
    });

    it("counts non-zero bytes past col as tail residue without parsing them", () => {
      const clean = decodeSolana8004AgentAccount(ACCOUNT_PDA, agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) }));
      expect(clean.tailResidue).toBe(false);
      const stale = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), residue: true })
      );
      expect(stale.tailResidue).toBe(true);
      // The residue never breaks the decode: every chain fact still reads.
      expect(stale.owner).toBe(OWNER_A);
      expect(stale.asset).toBe(ASSET_2);
    });

    it("decodes the live feedback counter from the first reputation window", () => {
      // The census-exact ratings number: the top agent carries 1,892.
      const counted = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), feedbackCount: 1892 })
      );
      expect(counted.feedbackCount).toBe(1892);
      // The u64 crosses the 32-bit word boundary: 2^32 + 5.
      const wide = decodeSolana8004AgentAccount(
        ACCOUNT_PDA,
        agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), feedbackCount: 4294967301 })
      );
      expect(wide.feedbackCount).toBe(4294967301);
      const zero = decodeSolana8004AgentAccount(ACCOUNT_PDA, agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) }));
      expect(zero.feedbackCount).toBe(0);
    });

    it("fails closed on length, discriminator, and Option-tag violations", () => {
      const short = agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) }).subarray(0, 747);
      expect(() => decodeSolana8004AgentAccount(ACCOUNT_PDA, short)).toThrow(/748-byte layout/);
      const wrongKey = agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) });
      wrongKey[0] = 0x30;
      expect(() => decodeSolana8004AgentAccount(ACCOUNT_PDA, wrongKey)).toThrow(/discriminator/);
      const badWallet = agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) });
      badWallet[138] = 2;
      expect(() => decodeSolana8004AgentAccount(ACCOUNT_PDA, badWallet)).toThrow(/agent_wallet tag 2/);
      const badParent = agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) });
      badParent[259] = 2;
      expect(() => decodeSolana8004AgentAccount(ACCOUNT_PDA, badParent)).toThrow(/parent_asset tag 2/);
    });

    it("fails closed on a string length that overruns the account", () => {
      const overrun = agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) });
      new DataView(overrun.buffer).setUint32(262, 700, true);
      expect(() => decodeSolana8004AgentAccount(ACCOUNT_PDA, overrun)).toThrow(/past the account end/);
    });
  });

  describe("parseSolana8004ProgramAccounts", () => {
    it("decodes agent accounts and counts non-agent program accounts", () => {
      const result = parseSolana8004ProgramAccounts([
        { pubkey: ACCOUNT_PDA, account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) })), "base64"] } },
        { pubkey: "B".repeat(44), account: { data: [b64(agentAccountData({ owner: ownerBytes(2), asset: ownerBytes(8) })), "base64"] } },
        // MetadataEntryPda-shaped program account: counted, never parsed.
        { pubkey: "M".repeat(44), account: { data: [b64(new Uint8Array(64)), "base64"] } },
      ]);
      expect(result.accounts).toHaveLength(2);
      expect(result.accounts[0]).toMatchObject({ account: ACCOUNT_PDA, asset: ASSET_2, owner: OWNER_A });
      expect(result.unknownCount).toBe(1);
    });

    it("fails the pass on a malformed gPA envelope entry", () => {
      // Deliberate divergence from the Metaplex parser: under disappearance-
      // based closure detection, an entry the envelope misreads could hide a
      // live account and masquerade as a closure, so envelope violations are
      // fatal, not counted.
      expect(() =>
        parseSolana8004ProgramAccounts([{ pubkey: "not-base58!!", account: { data: [b64(new Uint8Array(64)), "base64"] } }])
      ).toThrow(Solana8004ValidationError);
      expect(() => parseSolana8004ProgramAccounts([{ pubkey: ACCOUNT_PDA, account: { data: "garbage" } }])).toThrow(
        Solana8004ValidationError
      );
      expect(() => parseSolana8004ProgramAccounts({})).toThrow(Solana8004ValidationError);
    });

    it("fails the pass on an agent-discriminated row that fails decode", () => {
      const drifted = agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) }).subarray(0, 740);
      expect(() =>
        parseSolana8004ProgramAccounts([{ pubkey: ACCOUNT_PDA, account: { data: [b64(drifted), "base64"] } }])
      ).toThrow(/748-byte layout/);
    });
  });

  describe("successfulSignatureList", () => {
    it("keeps successful signatures newest-first and skips failed and malformed entries", () => {
      expect(
        successfulSignatureList([
          { signature: "short", err: null },
          { signature: "4".repeat(88), err: { InstructionError: [0, 1] } },
          { signature: SIGNATURE, err: null },
        ])
      ).toEqual([SIGNATURE]);
    });

    it("returns an empty list when the address has no successful transaction", () => {
      // Closures proceed unanchored (marked closed, never ledgered); a live
      // change with no anchor fails the pass — asserted in the fetch tests.
      expect(successfulSignatureList([{ signature: "4".repeat(88), err: { x: 1 } }])).toEqual([]);
      expect(successfulSignatureList([])).toEqual([]);
    });
  });

  describe("extractSolana8004ProgramLogs", () => {
    it("scopes instructions and event lines to the registry program across a live CPI shape", () => {
      // Byte-faithful to the live SetAgentUri transaction probed 2026-10-12:
      // the registry invokes, prints its instruction, CPIs Metaplex Core
      // (whose Update instruction and source-path line must stay out), then
      // prints its own event line naming the asset.
      const extracted = extractSolana8004ProgramLogs([
        `Program ${SOLANA_8004_PROGRAM} invoke [1]`,
        "Program log: Instruction: SetAgentUri",
        "Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d invoke [2]",
        "Program log: Instruction: Update",
        "Program log: programs/mpl-core/src/state/collection.rs:267:Approve",
        "Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d consumed 6576 of 183425 compute units",
        "Program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d success",
        `Program log: Agent URI updated for asset ${ASSET_1}`,
        `Program ${SOLANA_8004_PROGRAM} consumed 29277 of 200000 compute units`,
        `Program ${SOLANA_8004_PROGRAM} success`,
      ]);
      expect(extracted.instructions).toEqual(["SetAgentUri"]);
      expect(extracted.eventLines).toEqual([`Agent URI updated for asset ${ASSET_1}`]);
    });

    it("recognizes the older '<id>: invoke' frame and tolerates missing logs", () => {
      const extracted = extractSolana8004ProgramLogs([
        `${SOLANA_8004_PROGRAM}: invoke`,
        "Program log: Instruction: GiveFeedback",
        `Program log: Feedback #3 created: asset=${ASSET_1}, client=${OWNER_A}, score=Some(70), atom_enabled=true, tier=0`,
      ]);
      expect(extracted.instructions).toEqual(["GiveFeedback"]);
      expect(extracted.eventLines).toHaveLength(1);
      expect(extracted.eventLines[0]).toContain(`asset=${ASSET_1}`);
      expect(extractSolana8004ProgramLogs(null)).toEqual({ instructions: [], eventLines: [] });
    });
  });

  describe("matchSolana8004EventTransaction", () => {
    const matchWith = (
      kind: "register" | "transfer" | "profile_update" | "asset_closed",
      instructions: string[],
      eventLines: string[],
      event: Partial<Solana8004DiffEvent> = {}
    ) =>
      matchSolana8004EventTransaction({
        instructions,
        eventLines,
        event: {
          kind,
          account: ACCOUNT_PDA,
          asset: ASSET_1,
          fromOwner: OWNER_C,
          toOwner: OWNER_A,
          ...event,
        } as Solana8004DiffEvent,
      });

    it("matches a register only on a register instruction (RegisterWithOptions or Register) and the asset-naming line", () => {
      for (const instruction of ["RegisterWithOptions", "Register"]) {
        expect(
          matchWith("register", [instruction], [`Agent registered: ${ASSET_1} in collection ${"C".repeat(44)}`]),
          instruction
        ).toBe(true);
      }
      // An instruction that is not a registration never anchors one, whatever line it logs.
      for (const instruction of ["SetAgentUri", "TransferAgent", "GiveFeedback", "RegisterSomethingElse", "register"]) {
        expect(matchWith("register", [instruction], [`Agent registered: ${ASSET_1} in collection ${"C".repeat(44)}`]), instruction).toBe(false);
      }
      // A different asset in the same line shape never matches.
      expect(
        matchWith("register", ["RegisterWithOptions"], [`Agent registered: ${ASSET_2} in collection ${"C".repeat(44)}`])
      ).toBe(false);
      // The event line without the instruction is not an anchor.
      expect(matchWith("register", [], [`Agent registered: ${ASSET_1} in collection ${"C".repeat(44)}`])).toBe(false);
    });

    it("matches the live transaction that registered an agent with Register and transferred it in the same transaction, as the register and as the transfer", () => {
      const extracted = extractSolana8004ProgramLogs(LIVE_REGISTER_TX_LOGS);
      // Only the registry program's own instructions are read: the system, Metaplex Core and stats programs' lines are not.
      expect(extracted.instructions).toEqual(["Register", "SetMetadataPda", "SetMetadataPda", "TransferAgent"]);
      const register = { instructions: extracted.instructions, eventLines: extracted.eventLines };
      expect(
        matchSolana8004EventTransaction({ ...register, event: { kind: "register", account: ACCOUNT_PDA, asset: LIVE_REGISTER_TX_ASSET, fromOwner: null, toOwner: "8sBKU91gXbpKexboXAeYwoGFLK9LaT4SJAefdJN2tC1" } as Solana8004DiffEvent })
      ).toBe(true);
      expect(
        matchSolana8004EventTransaction({ ...register, event: { kind: "transfer", account: ACCOUNT_PDA, asset: LIVE_REGISTER_TX_ASSET, fromOwner: "F742C4VfFLQ9zRQyithoj5229ZgtX2WqKCSFKgH2EThq", toOwner: "8sBKU91gXbpKexboXAeYwoGFLK9LaT4SJAefdJN2tC1" } as Solana8004DiffEvent })
      ).toBe(true);
      // A registration of some other asset is not this transaction.
      expect(
        matchSolana8004EventTransaction({ ...register, event: { kind: "register", account: ACCOUNT_PDA, asset: ASSET_2, fromOwner: null, toOwner: OWNER_A } as Solana8004DiffEvent })
      ).toBe(false);
    });

    it("matches a profile update on the line-end-anchored asset name", () => {
      expect(matchWith("profile_update", ["SetAgentUri"], [`Agent URI updated for asset ${ASSET_1}`])).toBe(true);
      // A prefix-sibling asset never matches: the line must end with the asset.
      const sibling = ASSET_1.slice(0, ASSET_1.length - 1);
      expect(
        matchWith("profile_update", ["SetAgentUri"], [`Agent URI updated for asset ${sibling}`], { asset: sibling.slice(0, sibling.length - 1) })
      ).toBe(false);
    });

    it("matches a transfer on the exact observed owner pair and falls back to the current-destination hop", () => {
      expect(matchWith("transfer", ["TransferAgent"], [`Agent transferred: ${OWNER_C} -> ${OWNER_A}`])).toBe(true);
      // Multi-hop between passes: the diff observes C -> A, the chain moved
      // B -> A most recently — the destination hop is the honest anchor.
      expect(matchWith("transfer", ["TransferAgent"], [`Agent transferred: ${OWNER_B} -> ${OWNER_A}`])).toBe(true);
      // A hop ending somewhere else never matches.
      expect(matchWith("transfer", ["TransferAgent"], [`Agent transferred: ${OWNER_C} -> ${OWNER_B}`])).toBe(false);
      // The line without the instruction is not an anchor.
      expect(matchWith("transfer", [], [`Agent transferred: ${OWNER_C} -> ${OWNER_A}`])).toBe(false);
    });

    it("matches a closure only on an unknown registry line naming the asset", () => {
      // The closure vocabulary has no live exemplar, so any registry event
      // line naming the asset that is not a known live-kind line matches.
      expect(matchWith("asset_closed", ["CloseAgentAccount"], [`Agent account closed: ${ASSET_1}`])).toBe(true);
      // Known live-kind lines naming the asset are not closures.
      expect(
        matchWith("asset_closed", ["GiveFeedback"], [`Feedback #3 created: asset=${ASSET_1}, client=${OWNER_A}, score=Some(70), atom_enabled=true, tier=0`])
      ).toBe(false);
      expect(matchWith("asset_closed", ["SetAgentUri"], [`Agent URI updated for asset ${ASSET_1}`])).toBe(false);
      expect(matchWith("asset_closed", ["RegisterWithOptions"], [`Agent registered: ${ASSET_1} in collection ${"C".repeat(44)}`])).toBe(false);
      // A line naming a different asset never matches.
      expect(matchWith("asset_closed", [], [`Agent account closed: ${ASSET_2}`])).toBe(false);
    });
  });

  describe("classifySolana8004Diff", () => {
    it("seeds a plain inventory with zero events", () => {
      const diff = classifySolana8004Diff({
        seed: true,
        accounts: [liveAccount(ASSET_1, OWNER_A), liveAccount(ASSET_2, OWNER_B)],
        prior: new Map(),
      });
      expect(diff.upserts).toHaveLength(2);
      expect(diff.diffEvents).toEqual([]);
      expect(diff.deferredCount).toBe(0);
      expect(diff.closedAcknowledgedCount).toBe(0);
    });

    it("registers unknown assets and assets live again after an acknowledged closure", () => {
      const fresh = classifySolana8004Diff({ seed: false, accounts: [liveAccount(ASSET_1, OWNER_A)], prior: new Map() });
      expect(fresh.diffEvents).toEqual([
        { kind: "register", account: ACCOUNT_PDA, asset: ASSET_1, fromOwner: null, toOwner: OWNER_A },
      ]);
      expect(fresh.upserts).toHaveLength(1);
      const reborn = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_1, OWNER_B, "Reborn")],
        prior: new Map([[ASSET_1, priorEntry({ displayName: "Old", registrant: OWNER_C, closed: true })]]),
      });
      // Register, not transfer: the acknowledged closure ended the earlier
      // acknowledgment, and the live upsert clears the closure marker.
      expect(reborn.diffEvents).toEqual([
        { kind: "register", account: ACCOUNT_PDA, asset: ASSET_1, fromOwner: null, toOwner: OWNER_B },
      ]);
      expect(reborn.upserts).toHaveLength(1);
    });

    it("adopts a never-chain-acknowledged row silently", () => {
      const diff = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_1, OWNER_A, "Chain name", "chain.example.org")],
        prior: new Map([[ASSET_1, priorEntry({ displayName: "API name", registrant: null, locatorHost: "api.example.org" })]]),
      });
      expect(diff.diffEvents).toEqual([]);
      expect(diff.upserts).toHaveLength(1);
    });

    it("detects transfers and emits transfer plus profile_update for one changed account", () => {
      const transferOnly = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_1, OWNER_A)],
        prior: new Map([[ASSET_1, priorEntry({ registrant: OWNER_C })]]),
      });
      expect(transferOnly.diffEvents).toEqual([
        { kind: "transfer", account: ACCOUNT_PDA, asset: ASSET_1, fromOwner: OWNER_C, toOwner: OWNER_A },
      ]);
      const transferAndRename = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_1, OWNER_A, "New name")],
        prior: new Map([[ASSET_1, priorEntry({ registrant: OWNER_C })]]),
      });
      expect(transferAndRename.diffEvents).toEqual([
        { kind: "transfer", account: ACCOUNT_PDA, asset: ASSET_1, fromOwner: OWNER_C, toOwner: OWNER_A },
        { kind: "profile_update", account: ACCOUNT_PDA, asset: ASSET_1, fromOwner: null, toOwner: OWNER_A },
      ]);
    });

    it("detects a profile update from a locator-host change with an unchanged name", () => {
      const hostChange = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_1, OWNER_A, "Alpha", "new.example.org")],
        prior: new Map([[ASSET_1, priorEntry({ locatorHost: "old.example.org" })]]),
      });
      expect(hostChange.diffEvents).toEqual([
        { kind: "profile_update", account: ACCOUNT_PDA, asset: ASSET_1, fromOwner: null, toOwner: OWNER_A },
      ]);
      // A null prior display name is not chain state: the name difference
      // alone never manufactures a profile_update.
      const nullName = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_1, OWNER_A, "Whatever")],
        prior: new Map([[ASSET_1, priorEntry({ displayName: null })]]),
      });
      expect(nullName.diffEvents).toEqual([]);
    });

    it("detects a profile update from a registration-URI hash change alone and adopts a null prior hash silently", () => {
      // An IPFS CID swap: same inline name, no https host, a different link —
      // invisible to the name-and-host comparison, visible to the full-link
      // hash (755 of the 1,504 live URIs are ipfs:// links).
      const hashChange = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_1, OWNER_A, "Alpha", null, ACCOUNT_PDA, "ipfs://bafyexample-newcid")],
        prior: new Map([[ASSET_1, priorEntry({ registrant: OWNER_A, profileUriHash: hashRegistrationUri("ipfs://bafyexample-oldcid") })]]),
      });
      expect(hashChange.diffEvents).toEqual([
        { kind: "profile_update", account: ACCOUNT_PDA, asset: ASSET_1, fromOwner: null, toOwner: OWNER_A },
      ]);
      // The changed account still upserts: the ack persists the new hash, so
      // the next pass does not re-fire the event.
      expect(hashChange.upserts).toHaveLength(1);
      // A null prior hash — the row predates migration 0026 — adopts the
      // chain state silently, the same posture as a null prior registrant.
      const adopts = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_1, OWNER_A, "Alpha", null, ACCOUNT_PDA, "ipfs://bafyexample-newcid")],
        prior: new Map([[ASSET_1, priorEntry({ registrant: OWNER_A })]]),
      });
      expect(adopts.diffEvents).toEqual([]);
      expect(adopts.upserts).toHaveLength(1);
    });

    it("carries the prior row's last-known PDA on a closure for the confirm read", () => {
      const closure = classifySolana8004Diff({
        seed: false,
        accounts: [],
        prior: new Map([[ASSET_1, priorEntry({ registrant: OWNER_C, accountPubkey: "D".repeat(44) })]]),
      });
      // The closure event's account is the directory row's stored PDA — the
      // fetch-time confirmation-read address and the preferred attribution
      // walk — not null and never the asset pubkey.
      expect(closure.diffEvents).toEqual([
        { kind: "asset_closed", account: "D".repeat(44), asset: ASSET_1, fromOwner: OWNER_C, toOwner: null },
      ]);
      expect(closure.upserts).toEqual([]);
    });

    it("treats a vanished asset as a closure exactly once and never upserts it", () => {
      const passOne = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_2, OWNER_A)],
        prior: new Map([
          [ASSET_1, priorEntry({ registrant: OWNER_C })],
          [ASSET_3, priorEntry({ registrant: OWNER_C, closed: true })],
        ]),
      });
      expect(passOne.diffEvents).toEqual([
        // The live account has no prior row, so it registers — deterministic
        // order walks live accounts (sorted by asset) before vanished ones.
        { kind: "register", account: ACCOUNT_PDA, asset: ASSET_2, fromOwner: null, toOwner: OWNER_A },
        { kind: "asset_closed", account: null, asset: ASSET_1, fromOwner: OWNER_C, toOwner: null },
      ]);
      expect(passOne.closedAcknowledgedCount).toBe(1);
      expect(passOne.upserts.some(account => account.asset === ASSET_1)).toBe(false);
      // Pass two: the marker is set, so the vanished asset is skipped without
      // an event — hide-once holds and the cap stays free for real changes.
      const passTwo = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_2, OWNER_B)],
        prior: new Map([
          [ASSET_1, priorEntry({ registrant: OWNER_C, closed: true })],
          [ASSET_2, priorEntry({ registrant: OWNER_C })],
        ]),
      });
      expect(passTwo.diffEvents).toEqual([
        { kind: "transfer", account: ACCOUNT_PDA, asset: ASSET_2, fromOwner: OWNER_C, toOwner: OWNER_B },
      ]);
      expect(passTwo.closedAcknowledgedCount).toBe(1);
    });

    it("defers a multi-event asset that would cross the per-pass cap and keeps refreshing unchanged rows", () => {
      const accounts: Solana8004AgentAccount[] = [];
      const prior = new Map<string, Solana8004PriorEntry>();
      for (let index = 0; index < SOLANA_8004_CHAIN_MAX_EVENTS_PER_PASS - 1; index += 1) {
        const asset = encodeBase58(ownerBytes(index + 1));
        accounts.push(liveAccount(asset, OWNER_A, `Agent ${index}`));
        prior.set(asset, priorEntry({ displayName: `Agent ${index}`, registrant: OWNER_C }));
      }
      // Transferred AND renamed — two events on one account. The diff walks
      // accounts in lexicographic asset order, and 'z' is the last base58
      // digit, so this account sorts after every filler: accepting both
      // events would cross the cap and the whole account defers.
      const lateAsset = encodeBase58(ownerBytes(57));
      accounts.push(liveAccount(lateAsset, OWNER_B, "New name"));
      prior.set(lateAsset, priorEntry({ displayName: "Old name", registrant: OWNER_C }));
      accounts.push(liveAccount(ASSET_1, OWNER_A, "Unchanged"));
      prior.set(ASSET_1, priorEntry({ displayName: "Unchanged", registrant: OWNER_A }));
      const diff = classifySolana8004Diff({ seed: false, accounts, prior });
      expect(diff.diffEvents).toHaveLength(SOLANA_8004_CHAIN_MAX_EVENTS_PER_PASS - 1);
      expect(diff.deferredCount).toBe(1);
      expect(diff.upserts.some(account => account.asset === lateAsset)).toBe(false);
      expect(diff.upserts.some(account => account.asset === ASSET_1)).toBe(true);
    });
  });

  describe("decodeSolana8004MetadataAccount", () => {
    it("decodes the live-probed 332-byte layout", () => {
      const decoded = decodeSolana8004MetadataAccount("M".repeat(44), metadataAccountData(ownerBytes(7), "name", "James"));
      expect(decoded).toEqual({ account: "M".repeat(44), asset: ASSET_2, key: "name", value: "James" });
    });

    it("soft-skips wrong sizes and discriminators — metadata can hide nothing", () => {
      expect(decodeSolana8004MetadataAccount("M".repeat(44), new Uint8Array(331))).toBeNull();
      const wrongDisc = metadataAccountData(ownerBytes(7), "name", "James");
      wrongDisc[0] = 0xf1;
      expect(decodeSolana8004MetadataAccount("M".repeat(44), wrongDisc)).toBeNull();
    });

    it("parses entries, counts skipped rows, and fails only on a non-array envelope", () => {
      const parsed = parseSolana8004MetadataAccounts([
        { pubkey: "M".repeat(44), account: { data: [b64(metadataAccountData(ownerBytes(7), "erc8004-eth", "#25045")), "base64"] } },
        { pubkey: "not base58!!", account: { data: [b64(new Uint8Array(332)), "base64"] } },
        { pubkey: "N".repeat(44), account: { data: [b64(new Uint8Array(64)), "base64"] } },
      ]);
      expect(parsed.entries).toEqual([{ account: "M".repeat(44), asset: ASSET_2, key: "erc8004-eth", value: "#25045" }]);
      expect(parsed.skippedCount).toBe(2);
      expect(() => parseSolana8004MetadataAccounts({})).toThrow(Solana8004ValidationError);
    });
  });

  describe("buildSolana8004ChainLinks", () => {
    it("stores registry-scoped ids, chain strings, and the chain-registrations tag; never prose", () => {
      // The live vocabulary probed 2026-10-12: ids under ad-hoc keys, a
      // CAIP-ish chain string, and the one chain-registrations summary row.
      const links = buildSolana8004ChainLinks([
        metaEntry(ASSET_1, "erc8004-eth", "#25045"),
        metaEntry(ASSET_1, "x402", "eip155:8453"),
        metaEntry(ASSET_1, "chain-registrations", "5-chains"),
        metaEntry(ASSET_1, "description", "https://spam.example.org"),
        metaEntry(ASSET_1, "name", "James"),
      ]);
      expect(links).toEqual([
        { externalKey: ASSET_1, metadataKey: "erc8004-eth", linkedProtocol: "erc8004", linkedExternalKey: "#25045", metadataValueHash: valueHash("#25045") },
        { externalKey: ASSET_1, metadataKey: "x402", linkedProtocol: "other", linkedExternalKey: "eip155:8453", metadataValueHash: valueHash("eip155:8453") },
        { externalKey: ASSET_1, metadataKey: "chain-registrations", linkedProtocol: "other", linkedExternalKey: "5-chains", metadataValueHash: valueHash("5-chains") },
      ]);
    });

    it("deduplicates repeated rows and drops oversized keys or values", () => {
      const links = buildSolana8004ChainLinks([
        metaEntry(ASSET_1, "erc8004-eth", "#25045"),
        metaEntry(ASSET_1, "erc8004-eth", "#25045"),
        metaEntry(ASSET_1, "big-value", `#${"9".repeat(128)}`),
        metaEntry(ASSET_1, "k".repeat(65), "#12345"),
      ]);
      expect(links).toEqual([
        { externalKey: ASSET_1, metadataKey: "erc8004-eth", linkedProtocol: "erc8004", linkedExternalKey: "#25045", metadataValueHash: valueHash("#25045") },
      ]);
    });
  });

  describe("buildSolana8004MetadataResolutions", () => {
    it("turns the first non-empty name per asset into a resolved meta row keyed by the meta hash", () => {
      const { drafts, namesByAsset } = buildSolana8004MetadataResolutions([
        metaEntry(ASSET_1, "name", "First"),
        metaEntry(ASSET_1, "name", "Second"),
        metaEntry(ASSET_2, "name", "   "),
        metaEntry(ASSET_3, "image", "https://img.example.org/a.png"),
      ]);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toEqual({
        externalKey: ASSET_1,
        uriHash: hashRegistrationUri(`meta:${ASSET_1}`),
        uriKind: "meta",
        uri: "M".repeat(44),
        status: "resolved",
        failReason: null,
        resolvedName: "First",
        attempts: 0,
      });
      expect(namesByAsset.get(ASSET_1)).toBe("First");
      expect(namesByAsset.has(ASSET_2)).toBe(false);
    });
  });

  describe("selectSolana8004FetchQueue", () => {
    const resolution = (overrides: Partial<Solana8004PriorResolution>): Solana8004PriorResolution => ({
      externalKey: ASSET_1,
      uriHash: "h",
      status: "failed",
      resolvedName: null,
      attempts: 1,
      ...overrides,
    });

    it("queues only fetchable, spendable hashes; fresh hashes precede the backlog", () => {
      const accounts = [
        // Not fetchable (inline data: link) — never queued.
        liveAccount(
          encodeBase58(ownerBytes(50)),
          OWNER_A,
          "Alpha",
          null,
          ACCOUNT_PDA,
          `data:application/json,${encodeURIComponent(JSON.stringify({ name: "x" }))}`
        ),
        // Fresh hash: the prior row's hash differs — a URI edit jumps the queue.
        liveAccount(ASSET_2, OWNER_A, "Alpha", null, ACCOUNT_PDA, "ipfs://changed-cid"),
        // Fresh hash: no prior row at all.
        liveAccount(ASSET_3, OWNER_A, "Alpha", null, ACCOUNT_PDA, "ipfs://brand-new-cid"),
        // Backlog: unchanged hash, never resolved.
        liveAccount(encodeBase58(ownerBytes(40)), OWNER_A, "Alpha", null, ACCOUNT_PDA, "ipfs://backlog-cid"),
        // Terminal: no_name confirmed twice, failed five times — dropped.
        liveAccount(encodeBase58(ownerBytes(41)), OWNER_A, "Alpha", null, ACCOUNT_PDA, "ipfs://terminal-cid"),
        liveAccount(encodeBase58(ownerBytes(42)), OWNER_A, "Alpha", null, ACCOUNT_PDA, "ipfs://maxfailed-cid"),
        // Still spendable: no_name once, failed four times — retried.
        liveAccount(encodeBase58(ownerBytes(43)), OWNER_A, "Alpha", null, ACCOUNT_PDA, "ipfs://retry-nn-cid"),
        liveAccount(encodeBase58(ownerBytes(44)), OWNER_A, "Alpha", null, ACCOUNT_PDA, "ipfs://retry-f-cid"),
        // Resolved: never re-fetched.
        liveAccount(encodeBase58(ownerBytes(45)), OWNER_A, "Alpha", null, ACCOUNT_PDA, "ipfs://settled-cid"),
      ];
      const prior = new Map<string, Solana8004PriorEntry>([
        // Unchanged hashes: these accounts sit in the backlog group.
        [encodeBase58(ownerBytes(40)), priorEntry({ profileUriHash: hashRegistrationUri("ipfs://backlog-cid") })],
        [encodeBase58(ownerBytes(41)), priorEntry({ profileUriHash: hashRegistrationUri("ipfs://terminal-cid") })],
        [encodeBase58(ownerBytes(42)), priorEntry({ profileUriHash: hashRegistrationUri("ipfs://maxfailed-cid") })],
        [encodeBase58(ownerBytes(43)), priorEntry({ profileUriHash: hashRegistrationUri("ipfs://retry-nn-cid") })],
        [encodeBase58(ownerBytes(44)), priorEntry({ profileUriHash: hashRegistrationUri("ipfs://retry-f-cid") })],
        [encodeBase58(ownerBytes(45)), priorEntry({ profileUriHash: hashRegistrationUri("ipfs://settled-cid") })],
        // A URI edit: the prior hash differs, so ASSET_2 jumps the queue.
        [ASSET_2, priorEntry({ profileUriHash: hashRegistrationUri("ipfs://old-cid") })],
      ]);
      const priorResolutions = new Map<string, Solana8004PriorResolution>([
        [hashRegistrationUri("ipfs://settled-cid"), resolution({ uriHash: hashRegistrationUri("ipfs://settled-cid"), status: "resolved", resolvedName: "Settled", attempts: 1 })],
        [hashRegistrationUri("ipfs://terminal-cid"), resolution({ uriHash: hashRegistrationUri("ipfs://terminal-cid"), status: "no_name", attempts: RESOLUTION_NO_NAME_MAX_ATTEMPTS })],
        [hashRegistrationUri("ipfs://maxfailed-cid"), resolution({ uriHash: hashRegistrationUri("ipfs://maxfailed-cid"), status: "failed", attempts: RESOLUTION_FAILED_MAX_ATTEMPTS })],
        [hashRegistrationUri("ipfs://retry-nn-cid"), resolution({ uriHash: hashRegistrationUri("ipfs://retry-nn-cid"), status: "no_name", attempts: 1 })],
        [hashRegistrationUri("ipfs://retry-f-cid"), resolution({ uriHash: hashRegistrationUri("ipfs://retry-f-cid"), status: "failed", attempts: RESOLUTION_FAILED_MAX_ATTEMPTS - 1 })],
      ]);
      const queue = selectSolana8004FetchQueue({ accounts, prior, priorResolutions });
      // Fresh group first (asset-ordered), then the backlog group (asset-ordered).
      expect(queue.map(item => item.account.profileUriHash)).toEqual([
        hashRegistrationUri("ipfs://changed-cid"),
        hashRegistrationUri("ipfs://brand-new-cid"),
        hashRegistrationUri("ipfs://backlog-cid"),
        hashRegistrationUri("ipfs://retry-nn-cid"),
        hashRegistrationUri("ipfs://retry-f-cid"),
      ]);
    });

    it("caps the queue at the per-pass budget", () => {
      const accounts = Array.from({ length: SOLANA_8004_FETCH_BUDGET_PER_PASS + 5 }, (_unused, index) =>
        liveAccount(encodeBase58(ownerBytes(index + 10)), OWNER_A, "Alpha", null, ACCOUNT_PDA, `ipfs://cid-${index}`)
      );
      const queue = selectSolana8004FetchQueue({ accounts, prior: new Map(), priorResolutions: new Map() });
      expect(queue).toHaveLength(SOLANA_8004_FETCH_BUDGET_PER_PASS);
    });
  });

  describe("classifySolana8004Diff placeholder names", () => {
    it("ignores placeholder-vs-enriched name differences; real names still fire", () => {
      // The enrichment replaced the stored placeholder with a fetched name;
      // the chain still decodes the placeholder — that difference must never
      // manufacture an un-anchorable profile_update.
      const placeholder = placeholderSolana8004Name(ASSET_1);
      const enrichedPrior = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_1, OWNER_A, placeholder)],
        prior: new Map([[ASSET_1, priorEntry({ displayName: "Fetched Name", registrant: OWNER_A })]]),
      });
      expect(enrichedPrior.diffEvents).toEqual([]);
      // The reverse direction is a real chain-side rename: it fires.
      const realRename = classifySolana8004Diff({
        seed: false,
        accounts: [liveAccount(ASSET_1, OWNER_A, "Real New Name")],
        prior: new Map([[ASSET_1, priorEntry({ displayName: placeholder, registrant: OWNER_A })]]),
      });
      expect(realRename.diffEvents).toEqual([
        { kind: "profile_update", account: ACCOUNT_PDA, asset: ASSET_1, fromOwner: null, toOwner: OWNER_A },
      ]);
    });
  });

  describe("assertApprovedSolana8004ChainSource", () => {
    it("accepts only the active approved 8004 source", () => {
      expect(() => assertApprovedSolana8004ChainSource(approvedSource)).not.toThrow();
      const wrongKey = { ...approvedSource, sourceKey: "other" } as unknown as IngestionSource;
      expect(() => assertApprovedSolana8004ChainSource(wrongKey)).toThrow(Solana8004ValidationError);
      const wrongProtocol = { ...approvedSource, protocol: "solana_registry" } as unknown as IngestionSource;
      expect(() => assertApprovedSolana8004ChainSource(wrongProtocol)).toThrow(Solana8004ValidationError);
      const inactive = { ...approvedSource, state: "review" } as unknown as IngestionSource;
      expect(() => assertApprovedSolana8004ChainSource(inactive)).toThrow(Solana8004ValidationError);
    });
  });

  describe("isSolana8004ChainSeedCursor", () => {
    it("counts only an s8004 cursor as a completed inventory", () => {
      expect(isSolana8004ChainSeedCursor("s8004:455872585")).toBe(false);
      expect(isSolana8004ChainSeedCursor(null)).toBe(true);
      expect(isSolana8004ChainSeedCursor("")).toBe(true);
      expect(isSolana8004ChainSeedCursor("sync2:455825921")).toBe(true);
      expect(isSolana8004ChainSeedCursor("bf:123")).toBe(true);
    });
  });

  describe("fetchSolana8004ChainState", () => {
    it("seeds inventory over the mocked RPC path without emitting events", async () => {
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          {
            pubkey: ACCOUNT_PDA,
            account: {
              data: [
                b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), uri: "https://agent.example.org/card.json" })),
                "base64",
              ],
            },
          },
          {
            pubkey: "B".repeat(44),
            account: { data: [b64(agentAccountData({ owner: ownerBytes(2), asset: ownerBytes(8), residue: true })), "base64"] },
          },
          { pubkey: "M".repeat(44), account: { data: [b64(new Uint8Array(64)), "base64"] } },
        ],
      });
      const snapshot = await fetchSolana8004ChainState({
        source: approvedSource,
        seed: true,
        prior: new Map(),
        rpcUrl: "https://rpc.test",
        // The https registration link joins the step-3 fetch queue; the test
        // keeps the answer deterministic and off the network.
        fetchName: async () => ({ status: "no_name" }),
      });
      expect(snapshot).toMatchObject({
        slot: 4242,
        seed: true,
        enumeratedCount: 3,
        agentCount: 2,
        unknownCount: 1,
        tailResidueCount: 1,
        deferredCount: 0,
        closedAcknowledgedCount: 0,
        unanchoredClosureCount: 0,
        metadataCount: 0,
        // The metadata enumeration re-serves the agent gPA response here; all
        // three entries are skipped as non-metadata rows.
        metadataSkippedCount: 3,
        fetchAttemptedCount: 1,
        fetchResolvedCount: 0,
        // getSlot + agent gPA + metadata gPA.
        requestCount: 3,
      });
      expect(snapshot.events).toEqual([]);
      // The one fetchable registration link spent the budget and recorded a
      // no_name — never a pass failure.
      expect(snapshot.resolutions).toEqual([
        {
          externalKey: ASSET_2,
          uriHash: hashRegistrationUri("https://agent.example.org/card.json"),
          uriKind: "web",
          uri: "https://agent.example.org/card.json",
          status: "no_name",
          failReason: null,
          resolvedName: null,
          attempts: 1,
        },
      ]);
      expect(snapshot.drafts).toEqual([
        {
          externalKey: ASSET_2,
          displayName: `8004 agent ${ASSET_2.slice(0, 12)}`,
          locatorHost: "agent.example.org",
          registrant: OWNER_A,
          accountPubkey: ACCOUNT_PDA,
          profileUriHash: hashRegistrationUri("https://agent.example.org/card.json"),
          feedbackCount: 0,
          sourceSignalNote: SOLANA_8004_CHAIN_SIGNAL_NOTE,
        },
        {
          externalKey: ASSET_3,
          displayName: `8004 agent ${ASSET_3.slice(0, 12)}`,
          locatorHost: null,
          registrant: OWNER_B,
          accountPubkey: "B".repeat(44),
          profileUriHash: hashRegistrationUri(""),
          feedbackCount: 0,
          sourceSignalNote: SOLANA_8004_CHAIN_SIGNAL_NOTE,
        },
      ]);
    });

    it("anchors a live change to the transaction whose instructions made it, walking past newer ratings", async () => {
      const attributionAddresses: string[] = [];
      const inlineAlpha = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Alpha" }))}`;
      const RATING_SIGNATURE = "6".repeat(88);
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          {
            pubkey: ACCOUNT_PDA,
            account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), uri: inlineAlpha })), "base64"] },
          },
        ],
        getSignaturesForAddress: params => {
          attributionAddresses.push(params[0] as string);
          // Newest-first: a rating landed AFTER the transfer. The pre-fix
          // pass anchored the transfer to the rating transaction — for the
          // most-rated agents the newest touch is almost always a rating.
          return [
            { signature: RATING_SIGNATURE, err: null },
            { signature: SIGNATURE, err: null },
          ];
        },
        getTransaction: params => {
          if (params[0] === RATING_SIGNATURE) {
            return {
              meta: {
                logMessages: [
                  `Program ${SOLANA_8004_PROGRAM} invoke [1]`,
                  "Program log: Instruction: GiveFeedback",
                  `Program log: Feedback #3 created: asset=${ASSET_2}, client=${OWNER_A}, score=Some(70), atom_enabled=true, tier=0`,
                  `Program ${SOLANA_8004_PROGRAM} success`,
                ],
              },
            };
          }
          return {
            meta: {
              logMessages: [
                `Program ${SOLANA_8004_PROGRAM} invoke [1]`,
                "Program log: Instruction: TransferAgent",
                `Program log: Agent transferred: ${OWNER_C} -> ${OWNER_A}`,
                `Program ${SOLANA_8004_PROGRAM} success`,
              ],
            },
          };
        },
      });
      const prior = new Map([[ASSET_2, priorEntry({ registrant: OWNER_C })]]);
      const snapshot = await fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" });
      expect(snapshot.events).toEqual([
        { kind: "transfer", externalKey: ASSET_2, transactionSignature: SIGNATURE, slot: 4242, fromOwner: OWNER_C, toOwner: OWNER_A },
      ]);
      // The transaction that moved the owner touched the AgentAccount PDA —
      // that is the walk address, never the asset.
      expect(attributionAddresses).toEqual([ACCOUNT_PDA]);
      // getSlot + gPA + metadata gPA + one shared scan + two transaction fetches.
      expect(snapshot.requestCount).toBe(6);
    });

    it("asks for transactions up to version 1, and skips one this client cannot read instead of failing the pass", async () => {
      // Solana mainnet carries version 1 transactions, and a request that names version 0 is answered with error -32015 for
      // each of them. That error failed the whole pass on 2026-10-16 (two runs in a row), with every other agent behind it.
      const inlineAlpha = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Alpha" }))}`;
      const NEWER_SIGNATURE = "7".repeat(88);
      const fetchMock = stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          {
            pubkey: ACCOUNT_PDA,
            account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), uri: inlineAlpha })), "base64"] },
          },
        ],
        getSignaturesForAddress: () => [
          { signature: NEWER_SIGNATURE, err: null },
          { signature: SIGNATURE, err: null },
        ],
        getTransaction: params => {
          if (params[0] === NEWER_SIGNATURE) {
            return { rpcError: { code: -32015, message: 'Transaction version (2) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 2' } };
          }
          return {
            meta: {
              logMessages: [
                `Program ${SOLANA_8004_PROGRAM} invoke [1]`,
                "Program log: Instruction: TransferAgent",
                `Program log: Agent transferred: ${OWNER_C} -> ${OWNER_A}`,
                `Program ${SOLANA_8004_PROGRAM} success`,
              ],
            },
          };
        },
      });
      const prior = new Map([[ASSET_2, priorEntry({ registrant: OWNER_C })]]);
      const snapshot = await fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" });
      expect(snapshot.events).toEqual([
        { kind: "transfer", externalKey: ASSET_2, transactionSignature: SIGNATURE, slot: 4242, fromOwner: OWNER_C, toOwner: OWNER_A },
      ]);
      const transactionRequests = fetchMock.mock.calls
        .map(call => JSON.parse((call[1] as { body: string }).body) as { method: string; params: unknown[] })
        .filter(request => request.method === "getTransaction");
      expect(transactionRequests.length).toBe(2);
      for (const request of transactionRequests) expect(request.params[1]).toEqual({ encoding: "json", maxSupportedTransactionVersion: 1 });
    });

    it("still fails the pass on any other error from getTransaction", async () => {
      const inlineAlpha = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Alpha" }))}`;
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          {
            pubkey: ACCOUNT_PDA,
            account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), uri: inlineAlpha })), "base64"] },
          },
        ],
        getSignaturesForAddress: () => [{ signature: SIGNATURE, err: null }],
        getTransaction: () => ({ rpcError: { code: -32005, message: "Node is behind by 5 slots" } }),
      });
      const prior = new Map([[ASSET_2, priorEntry({ registrant: OWNER_C })]]);
      await expect(fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" })).rejects.toThrow(/getTransaction failed at the RPC layer: Node is behind by 5 slots/);
    });

    it("anchors a transfer and a rename made in one transaction to the same signature — both kinds recorded", async () => {
      const inlineAlpha = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Alpha" }))}`;
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          {
            pubkey: ACCOUNT_PDA,
            account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), uri: inlineAlpha })), "base64"] },
          },
        ],
        getSignaturesForAddress: () => [{ signature: SIGNATURE, err: null }],
        getTransaction: () => ({
          meta: {
            logMessages: [
              `Program ${SOLANA_8004_PROGRAM} invoke [1]`,
              "Program log: Instruction: TransferAgent",
              "Program log: Instruction: SetAgentUri",
              `Program log: Agent transferred: ${OWNER_C} -> ${OWNER_A}`,
              `Program log: Agent URI updated for asset ${ASSET_2}`,
              `Program ${SOLANA_8004_PROGRAM} success`,
            ],
          },
        }),
      });
      const prior = new Map([[ASSET_2, priorEntry({ displayName: "Old name", registrant: OWNER_C })]]);
      const snapshot = await fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" });
      // One transaction, two kinds, one shared walk — the ledger's
      // kind-aware uniqueness key keeps both events instead of silently
      // dropping the second.
      expect(snapshot.events).toEqual([
        { kind: "transfer", externalKey: ASSET_2, transactionSignature: SIGNATURE, slot: 4242, fromOwner: OWNER_C, toOwner: OWNER_A },
        { kind: "profile_update", externalKey: ASSET_2, transactionSignature: SIGNATURE, slot: 4242, fromOwner: null, toOwner: OWNER_A },
      ]);
      // getSlot + gPA + metadata gPA + one scan + one transaction fetch — the
      // walk is shared.
      expect(snapshot.requestCount).toBe(5);
    });

    it("anchors a registration made with the Register instruction, which transferred the new agent in the same transaction, and does not fail the pass", async () => {
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          {
            pubkey: ACCOUNT_PDA,
            account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) })), "base64"] },
          },
        ],
        getSignaturesForAddress: () => [{ signature: SIGNATURE, err: null }],
        // The live transaction's lines, naming the asset this pass sees.
        getTransaction: () => ({ meta: { logMessages: LIVE_REGISTER_TX_LOGS.map(line => line.split(LIVE_REGISTER_TX_ASSET).join(ASSET_2)) } }),
      });
      const snapshot = await fetchSolana8004ChainState({ source: approvedSource, seed: false, prior: new Map(), rpcUrl: "https://rpc.test" });
      expect(snapshot.events).toEqual([{ kind: "register", externalKey: ASSET_2, transactionSignature: SIGNATURE, slot: 4242, fromOwner: null, toOwner: OWNER_A }]);
    });

    it("fails the pass when a live change has no successful transaction to anchor it", async () => {
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          {
            pubkey: ACCOUNT_PDA,
            account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) })), "base64"] },
          },
        ],
        getSignaturesForAddress: () => [{ signature: "4".repeat(88), err: { InstructionError: [0, 1] } }],
      });
      const prior = new Map([[ASSET_2, priorEntry({ registrant: OWNER_C })]]);
      await expect(
        fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" })
      ).rejects.toThrow(/No transaction matching the observed transfer/);
    });

    it("fails the pass when no walked transaction matches the observed change", async () => {
      // Every transaction on the account is a rating — the observed transfer
      // must fail loudly rather than anchor to a rating or guess.
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          {
            pubkey: ACCOUNT_PDA,
            account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) })), "base64"] },
          },
        ],
        getSignaturesForAddress: () => [{ signature: SIGNATURE, err: null }],
        getTransaction: () => ({
          meta: {
            logMessages: [
              `Program ${SOLANA_8004_PROGRAM} invoke [1]`,
              "Program log: Instruction: GiveFeedback",
              `Program log: Feedback #3 created: asset=${ASSET_2}, client=${OWNER_A}, score=Some(70), atom_enabled=true, tier=0`,
              `Program ${SOLANA_8004_PROGRAM} success`,
            ],
          },
        }),
      });
      const prior = new Map([[ASSET_2, priorEntry({ registrant: OWNER_C })]]);
      await expect(
        fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" })
      ).rejects.toThrow(/No transaction matching the observed transfer/);
    });

    it("defers a live change whose walk exhausted the shared fetch budget instead of failing the pass", async () => {
      // A stormy account (twelve ratings newer than its transfer) shares the
      // per-pass fetch budget with a healthy account: the pass must keep the
      // healthy anchor, defer the stormy one, and leave its row stale so the
      // next pass re-detects the diff — one busy account must not wedge the
      // source. A walk that examined every scanned transaction and still
      // found no match keeps failing loudly (the tests above); running out
      // of budget is a different verdict.
      const healthyPda = "B".repeat(44);
      const healthySignature = "7".repeat(88);
      // Distinct rating signatures that never collide with the anchored
      // fixture signatures ("5"/"7" repeated): a colliding stub route would
      // hand the stormy walk the transfer transaction itself.
      const ratingSignatures = Array.from({ length: 12 }, (_, i) => `c${i + 1}`.repeat(44));
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          // Asset order decides attribution order (diff events sort by
          // asset): the healthy account sorts first, so its walk spends one
          // fetch and anchors before the stormy account drains what is left
          // of the shared budget.
          {
            pubkey: healthyPda,
            account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) })), "base64"] },
          },
          {
            pubkey: ACCOUNT_PDA,
            account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(8) })), "base64"] },
          },
        ],
        getSignaturesForAddress: params => {
          const address = params[0] as string;
          if (address === ACCOUNT_PDA) {
            // Newest-first: twelve ratings landed after the transfer — more
            // than the walk may fetch in one pass.
            return ratingSignatures.map(signature => ({ signature, err: null }));
          }
          return [{ signature: healthySignature, err: null }];
        },
        getTransaction: params => {
          if (params[0] === healthySignature) {
            return {
              meta: {
                logMessages: [
                  `Program ${SOLANA_8004_PROGRAM} invoke [1]`,
                  "Program log: Instruction: TransferAgent",
                  `Program log: Agent transferred: ${OWNER_C} -> ${OWNER_A}`,
                  `Program ${SOLANA_8004_PROGRAM} success`,
                ],
              },
            };
          }
          // Every stormy-signature fetch is a rating: examined, never a
          // match, until the budget stops the walk with signatures left
          // unexamined.
          return {
            meta: {
              logMessages: [
                `Program ${SOLANA_8004_PROGRAM} invoke [1]`,
                "Program log: Instruction: GiveFeedback",
                `Program log: Feedback #3 created: asset=${ASSET_3}, client=${OWNER_A}, score=Some(70), atom_enabled=true, tier=0`,
                `Program ${SOLANA_8004_PROGRAM} success`,
              ],
            },
          };
        },
      });
      const prior = new Map([
        [ASSET_2, priorEntry({ registrant: OWNER_C })],
        [ASSET_3, priorEntry({ registrant: OWNER_C })],
      ]);
      const snapshot = await fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" });
      // The pass resolves: the healthy transfer is anchored, the stormy one
      // is deferred — nothing is guessed.
      expect(snapshot.events).toEqual([
        { kind: "transfer", externalKey: ASSET_2, transactionSignature: healthySignature, slot: 4242, fromOwner: OWNER_C, toOwner: OWNER_A },
      ]);
      expect(snapshot.deferredAttributionCount).toBe(1);
      // The deferred account's draft is dropped: its directory row keeps the
      // prior registrant and the next pass re-detects the same transfer.
      expect(snapshot.drafts.map(draft => draft.externalKey)).toEqual([ASSET_2]);
      // getSlot + gPA + metadata gPA + two scans + ten fetches — one healthy
      // match plus nine examined ratings before the budget stopped the
      // stormy walk with its last three signatures unexamined.
      expect(snapshot.requestCount).toBe(15);
    });

    it("defers a closure whose walk starts with the shared fetch budget already spent", async () => {
      // The deferral contract the runner documents: budget-starved closures
      // stay unmarked, because the hide-once marker is permanent — a closure
      // acknowledged on a budget verdict would hide the row with no ledger
      // anchor and never be re-detected. Live accounts sort before closures
      // in the diff, so a stormy transfer drains the shared budget first and
      // the closure's walk starts with nothing left to spend: its scan finds
      // a candidate anchor, but the fetch loop breaks at the cap before
      // examining a single signature.
      const assets = fillerAssets(49);
      // Distinct rating signatures (the "d" prefix never collides with the
      // closure fixture's SIGNATURE or with each other).
      const ratingSignatures = Array.from({ length: 12 }, (_, i) => `d${i + 1}`.repeat(44));
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          ...fillerEntries(assets),
          {
            pubkey: ACCOUNT_PDA,
            account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) })), "base64"] },
          },
        ],
        getSignaturesForAddress: params => {
          const address = params[0] as string;
          if (address === ACCOUNT_PDA) {
            // Twelve ratings after the transfer — more than the walk may
            // fetch in one pass, so the stormy transfer defers and the
            // budget is spent when the closure's walk begins.
            return ratingSignatures.map(signature => ({ signature, err: null }));
          }
          // The closure address has a candidate anchor waiting; the walk
          // just never gets to fetch it.
          return [{ signature: SIGNATURE, err: null }];
        },
        getTransaction: () => ({
          meta: {
            logMessages: [
              `Program ${SOLANA_8004_PROGRAM} invoke [1]`,
              "Program log: Instruction: GiveFeedback",
              `Program log: Feedback #3 created: asset=${ASSET_2}, client=${OWNER_A}, score=Some(70), atom_enabled=true, tier=0`,
              `Program ${SOLANA_8004_PROGRAM} success`,
            ],
          },
        }),
      });
      const prior = fillerPrior(assets);
      prior.set(ASSET_2, priorEntry({ registrant: OWNER_C }));
      prior.set(ASSET_3, priorEntry({ registrant: OWNER_C }));
      const snapshot = await fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" });
      // The stormy transfer and the closure both deferred: nothing anchored,
      // nothing acknowledged, nothing ledgered — and the next pass
      // re-detects both.
      expect(snapshot.events).toEqual([]);
      expect(snapshot.deferredAttributionCount).toBe(2);
      // The regression pin: the budget-starved closure must NOT be marked
      // closed. Hide-once would make the budget verdict permanent and the
      // row would vanish from public reads with no closure event anywhere.
      expect(snapshot.closedExternalKeys).toEqual([]);
      expect(snapshot.unanchoredClosureCount).toBe(0);
      expect(snapshot.unconfirmedClosureCount).toBe(0);
      // The stormy account's draft is dropped with the deferral; the
      // unchanged fillers' refresh through.
      expect(snapshot.drafts).toHaveLength(49);
      expect(snapshot.drafts.some(draft => draft.externalKey === ASSET_2)).toBe(false);
      // getSlot + gPA + metadata gPA + two scans (stormy PDA, closure
      // asset) + ten stormy fetches — the closure walk fetched nothing.
      expect(snapshot.requestCount).toBe(15);
    });

    it("anchors closures to a registry line naming the asset and leaves unmatched closures unanchored", async () => {
      // Two closures among a hundred live priors — exactly on the 98% floor,
      // the boundary the truncation guard must let through. Both rows predate
      // migration 0026 (no stored PDA), so both close unconfirmed and the
      // attribution walk falls back to the asset pubkey, the only address
      // that outlives a vanished account.
      const assets = fillerAssets(98);
      const attributionAddresses: string[] = [];
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => fillerEntries(assets),
        getSignaturesForAddress: params => {
          const address = params[0] as string;
          attributionAddresses.push(address);
          // The first vanished asset (lexicographic order) has a closure
          // transaction; the second never appeared in a successful one.
          return address === ASSET_2 ? [{ signature: SIGNATURE, err: null }] : [];
        },
        getTransaction: () => ({
          meta: {
            logMessages: [
              `Program ${SOLANA_8004_PROGRAM} invoke [1]`,
              "Program log: Instruction: CloseAgentAccount",
              `Program log: Agent account closed: ${ASSET_2}`,
              `Program ${SOLANA_8004_PROGRAM} success`,
            ],
          },
        }),
      });
      const prior = fillerPrior(assets);
      prior.set(ASSET_2, priorEntry({ registrant: OWNER_C }));
      prior.set(ASSET_3, priorEntry({ registrant: OWNER_C }));
      const snapshot = await fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" });
      // No stored PDA, so the walk address is the asset pubkey — and only a
      // registry line naming the asset can anchor the closure.
      expect(attributionAddresses).toEqual([ASSET_2, ASSET_3]);
      expect(snapshot.events).toEqual([
        { kind: "asset_closed", externalKey: ASSET_2, transactionSignature: SIGNATURE, slot: 4242, fromOwner: OWNER_C, toOwner: null },
      ]);
      // Both closures are acknowledged on the directory (hide-once marker),
      // but only the anchored one reaches the ledger.
      expect(snapshot.closedExternalKeys).toEqual([ASSET_2, ASSET_3]);
      expect(snapshot.unanchoredClosureCount).toBe(1);
      // No stored PDA means no confirmation read: both acknowledgments rest
      // on the enumeration evidence alone, counted on the snapshot for the
      // operator to read.
      expect(snapshot.unconfirmedClosureCount).toBe(2);
      expect(snapshot.drafts).toHaveLength(98);
      expect(snapshot.drafts.some(draft => draft.externalKey === ASSET_2 || draft.externalKey === ASSET_3)).toBe(false);
      // The fillers' drafts carry the migration-0026 chain facts through.
      expect(snapshot.drafts[0]).toMatchObject({
        accountPubkey: "F".repeat(44),
        profileUriHash: hashRegistrationUri(FILLER_URI),
      });
      // getSlot + gPA + metadata gPA + two signature scans + one transaction
      // fetch — and no getAccountInfo confirm reads.
      expect(snapshot.requestCount).toBe(6);
    });

    it("refuses a closure whose last-known PDA still holds a live AgentAccount", async () => {
      const assets = fillerAssets(49);
      const confirmAddresses: string[] = [];
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => fillerEntries(assets),
        getAccountInfo: params => {
          confirmAddresses.push(params[0] as string);
          // The enumeration missed it, but the chain still holds the
          // AgentAccount at the PDA — absence alone must never hide it.
          return { value: { data: [b64(agentAccountData({ owner: ownerBytes(3), asset: ownerBytes(7) })), "base64"] } };
        },
      });
      const prior = fillerPrior(assets);
      prior.set(ASSET_2, priorEntry({ registrant: OWNER_C, accountPubkey: "D".repeat(44) }));
      await expect(
        fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" })
      ).rejects.toThrow(/still live on chain/);
      // One direct read of the stored PDA, before any attribution walk.
      expect(confirmAddresses).toEqual(["D".repeat(44)]);
    });

    it("confirms a closure by direct read and walks the last-known PDA to its closing transaction", async () => {
      const assets = fillerAssets(49);
      const confirmAddresses: string[] = [];
      const attributionAddresses: string[] = [];
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => fillerEntries(assets),
        getAccountInfo: params => {
          confirmAddresses.push(params[0] as string);
          return { value: null }; // the account is gone: the close is confirmed
        },
        getSignaturesForAddress: params => {
          attributionAddresses.push(params[0] as string);
          return [{ signature: SIGNATURE, err: null }];
        },
        getTransaction: () => ({
          meta: {
            logMessages: [
              `Program ${SOLANA_8004_PROGRAM} invoke [1]`,
              "Program log: Instruction: CloseAgentAccount",
              `Program log: Agent account closed: ${ASSET_2}`,
              `Program ${SOLANA_8004_PROGRAM} success`,
            ],
          },
        }),
      });
      const prior = fillerPrior(assets);
      prior.set(ASSET_2, priorEntry({ registrant: OWNER_C, accountPubkey: "D".repeat(44) }));
      const snapshot = await fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" });
      expect(confirmAddresses).toEqual(["D".repeat(44)]);
      // The walk prefers the row's stored PDA — nothing touches a closed
      // account afterward, so its own newest transactions are the closure —
      // never the asset pubkey.
      expect(attributionAddresses).toEqual(["D".repeat(44)]);
      expect(snapshot.events).toEqual([
        { kind: "asset_closed", externalKey: ASSET_2, transactionSignature: SIGNATURE, slot: 4242, fromOwner: OWNER_C, toOwner: null },
      ]);
      expect(snapshot.unconfirmedClosureCount).toBe(0);
      expect(snapshot.closedExternalKeys).toEqual([ASSET_2]);
      // getSlot + gPA + metadata gPA + one paced confirm read + one scan +
      // one fetch.
      expect(snapshot.requestCount).toBe(6);
    });

    it("treats non-agent data at the last-known PDA as a confirmed close", async () => {
      const assets = fillerAssets(49);
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => fillerEntries(assets),
        // The PDA no longer carries the AgentAccount discriminator — whatever
        // the read finds there, it is not a live agent.
        getAccountInfo: () => ({ value: { data: [b64(new Uint8Array(64)), "base64"] } }),
        getSignaturesForAddress: () => [],
      });
      const prior = fillerPrior(assets);
      prior.set(ASSET_2, priorEntry({ registrant: OWNER_C, accountPubkey: "D".repeat(44) }));
      const snapshot = await fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" });
      // Confirmed but unanchorable: the row still hides (hide-once marker),
      // and the ledger only ever records honestly anchored events.
      expect(snapshot.unconfirmedClosureCount).toBe(0);
      expect(snapshot.unanchoredClosureCount).toBe(1);
      expect(snapshot.closedExternalKeys).toEqual([ASSET_2]);
      expect(snapshot.events).toEqual([]);
    });

    it("stops a diff pass whose enumeration falls under the 98% floor of the prior live count", async () => {
      const assets = fillerAssets(50);
      stubRpc({
        getSlot: () => 4242,
        // Ten of the fifty live priors missing from the listing: a cut-off
        // getProgramAccounts response must never be read as ten closures.
        getProgramAccounts: () => fillerEntries(assets.slice(0, 40)),
      });
      await expect(
        fetchSolana8004ChainState({ source: approvedSource, seed: false, prior: fillerPrior(assets), rpcUrl: "https://rpc.test" })
      ).rejects.toThrow(/98% floor/);
    });

    it("never applies the floor to a seed and never counts acknowledged closures against it", async () => {
      const assets = fillerAssets(49);
      const prior = fillerPrior(assets);
      prior.set(ASSET_2, priorEntry({ registrant: OWNER_C, closed: true }));
      prior.set(ASSET_3, priorEntry({ registrant: OWNER_C, closed: true }));
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => fillerEntries(assets),
      });
      // A seed has no prior live count to trust, so no floor applies to it.
      const seeded = await fetchSolana8004ChainState({ source: approvedSource, seed: true, prior, rpcUrl: "https://rpc.test" });
      expect(seeded.drafts).toHaveLength(49);
      // The diff pass: forty-nine enumerated against forty-nine live priors —
      // the two already-closed rows do not count. Had acknowledged closures
      // accumulated against the floor, a stable registry would eventually
      // fail its own passes.
      const diffed = await fetchSolana8004ChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" });
      expect(diffed.closedAcknowledgedCount).toBe(2);
      expect(diffed.events).toEqual([]);
      expect(diffed.drafts).toHaveLength(49);
    });

    it("stops loudly past the approved account ceiling", async () => {
      const shared = b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7) }));
      const entries = Array.from({ length: SOLANA_8004_CHAIN_MAX_ACCOUNTS + 1 }, () => ({
        pubkey: ACCOUNT_PDA,
        account: { data: [shared, "base64"] },
      }));
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => entries,
      });
      await expect(
        fetchSolana8004ChainState({ source: approvedSource, seed: true, prior: new Map(), rpcUrl: "https://rpc.test" })
      ).rejects.toThrow(/ceiling/);
    });

    it("decodes metadata, enriches only placeholders, builds chain links, and emits no events", async () => {
      // The stub's getProgramAccounts route is method-keyed, so the call
      // count separates the agent enumeration (first) from the
      // memcmp-scoped metadata enumeration (second).
      let gpaCalls = 0;
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => {
          gpaCalls += 1;
          if (gpaCalls === 1) {
            return [
              // Placeholder target: no inline name — enrichment may rename it.
              { pubkey: ACCOUNT_PDA, account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), uri: "ipfs://bafy-placeholder" })), "base64"] } },
              // Inline name: the chain decode wins; nothing enriches it.
              { pubkey: "B".repeat(44), account: { data: [b64(agentAccountData({ owner: ownerBytes(2), asset: ownerBytes(8), uri: `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Inline" }))}` })), "base64"] } },
            ];
          }
          return [
            { pubkey: "M".repeat(44), account: { data: [b64(metadataAccountData(ownerBytes(7), "name", "James")), "base64"] } },
            { pubkey: "N".repeat(44), account: { data: [b64(metadataAccountData(ownerBytes(7), "erc8004-eth", "#25045")), "base64"] } },
            { pubkey: "P".repeat(44), account: { data: [b64(metadataAccountData(ownerBytes(8), "description", "prose never links")), "base64"] } },
          ];
        },
      });
      const fetchedUris: string[] = [];
      const snapshot = await fetchSolana8004ChainState({
        source: approvedSource,
        seed: true,
        prior: new Map(),
        rpcUrl: "https://rpc.test",
        fetchName: async uri => {
          fetchedUris.push(uri);
          return { status: "resolved", name: "Fetched Name" };
        },
      });
      // Enrichment and linkage are directory facts: the event spine stays empty.
      expect(snapshot.events).toEqual([]);
      const byAsset = new Map(snapshot.drafts.map(draft => [draft.externalKey, draft]));
      // The on-chain metadata name outranks the fetched one; the inline name beats both.
      expect(byAsset.get(ASSET_2)).toMatchObject({ displayName: "James", feedbackCount: 0 });
      expect(byAsset.get(ASSET_3)).toMatchObject({ displayName: "Inline" });
      // Only the placeholder account's link was worth a fetch; the inline one was not queued.
      expect(fetchedUris).toEqual(["ipfs://bafy-placeholder"]);
      // The erc8004 id row is a chain link; the prose row never is.
      expect(snapshot.chainLinks).toEqual([
        { externalKey: ASSET_2, metadataKey: "erc8004-eth", linkedProtocol: "erc8004", linkedExternalKey: "#25045", metadataValueHash: valueHash("#25045") },
      ]);
      expect(snapshot.metadataCount).toBe(3);
      expect(snapshot.metadataSkippedCount).toBe(0);
      // One fetch spent; the resolution rows carry both the fetched name and
      // the on-chain meta name (which outranked it in the drafts).
      expect(snapshot.fetchAttemptedCount).toBe(1);
      expect(snapshot.fetchResolvedCount).toBe(1);
      expect(snapshot.resolutions).toEqual([
        {
          externalKey: ASSET_2,
          uriHash: hashRegistrationUri("ipfs://bafy-placeholder"),
          uriKind: "ipfs",
          uri: "ipfs://bafy-placeholder",
          status: "resolved",
          failReason: null,
          resolvedName: "Fetched Name",
          attempts: 1,
        },
        {
          externalKey: ASSET_2,
          uriHash: hashRegistrationUri(`meta:${ASSET_2}`),
          uriKind: "meta",
          uri: "M".repeat(44),
          status: "resolved",
          failReason: null,
          resolvedName: "James",
          attempts: 0,
        },
      ]);
      // getSlot + agent gPA + metadata gPA; the HTTP fetch is not an RPC request.
      expect(snapshot.requestCount).toBe(3);
    });

    it("spends no budget on settled hashes and records fetch failures without failing the pass", async () => {
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          { pubkey: ACCOUNT_PDA, account: { data: [b64(agentAccountData({ owner: ownerBytes(1), asset: ownerBytes(7), uri: "ipfs://bafy-settled" })), "base64"] } },
          { pubkey: "B".repeat(44), account: { data: [b64(agentAccountData({ owner: ownerBytes(2), asset: ownerBytes(8), uri: "ipfs://bafy-fresh" })), "base64"] } },
        ],
      });
      const settledHash = hashRegistrationUri("ipfs://bafy-settled");
      const fetchName = vi.fn(async (_uri: string, _kind: "web" | "ipfs") => ({ status: "failed" as const, reason: "HTTP 503" }));
      const snapshot = await fetchSolana8004ChainState({
        source: approvedSource,
        seed: true,
        prior: new Map(),
        priorResolutions: new Map([
          [settledHash, { externalKey: ASSET_2, uriHash: settledHash, status: "resolved", resolvedName: "Settled", attempts: 1 }],
        ]),
        rpcUrl: "https://rpc.test",
        fetchName,
      });
      // The settled hash is never re-fetched; only the fresh one spends budget.
      expect(fetchName).toHaveBeenCalledTimes(1);
      expect(fetchName.mock.calls[0]![0]).toBe("ipfs://bafy-fresh");
      // The failure is a recorded status: the pass completes, and the retry
      // state rides the resolution row. The settled hash's prior resolved
      // name re-applies to its placeholder every pass — that is how the
      // enrichment persists without re-fetching — while the fresh failed
      // account keeps its placeholder.
      expect(snapshot.events).toEqual([]);
      expect(snapshot.drafts.map(draft => draft.displayName)).toEqual([
        "Settled",
        `8004 agent ${ASSET_3.slice(0, 12)}`,
      ]);
      expect(snapshot.resolutions).toEqual([
        {
          externalKey: ASSET_3,
          uriHash: hashRegistrationUri("ipfs://bafy-fresh"),
          uriKind: "ipfs",
          uri: "ipfs://bafy-fresh",
          status: "failed",
          failReason: "HTTP 503",
          resolvedName: null,
          attempts: 1,
        },
      ]);
      expect(snapshot.fetchAttemptedCount).toBe(1);
      expect(snapshot.fetchResolvedCount).toBe(0);
    });
  });
});
