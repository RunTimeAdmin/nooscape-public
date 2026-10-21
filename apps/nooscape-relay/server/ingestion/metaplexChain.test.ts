import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";
import {
  assertApprovedMetaplexChainSource,
  classifyMetaplexChainDiff,
  decodeMetaplexCoreAsset,
  decodeMetaplexIdentityPda,
  encodeBase58,
  fetchMetaplexChainState,
  isMetaplexChainSeedCursor,
  MetaplexChainValidationError,
  METAPLEX_CHAIN_MAX_EVENTS_PER_PASS,
  METAPLEX_CHAIN_SIGNAL_NOTE,
  METAPLEX_CHAIN_SOURCE_KEY,
  parseGetMultipleAccountsResponse,
  parseGetProgramAccountsResponse,
  parseNewestSuccessfulSignature,
} from "./metaplexChain";
import type { MetaplexChainPriorEntry, MetaplexAssetState } from "./metaplexChain";

/** 32 zero bytes encode as 32 leading-'1' characters (the system-program shape). */
const ZERO32 = new Uint8Array(32);
const ownerBytes = (last: number) => {
  const bytes = new Uint8Array(32);
  bytes[31] = last;
  return bytes;
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const OWNER_A_BYTES = ownerBytes(1);
const OWNER_A = encodeBase58(OWNER_A_BYTES);
const OWNER_B = encodeBase58(ownerBytes(2));
const OWNER_C = encodeBase58(ownerBytes(3));
const ASSET_2 = encodeBase58(ownerBytes(7));
const ASSET_1 = encodeBase58(ZERO32);
const SIGNATURE = "5".repeat(88);

const identityV2Data = (asset: Uint8Array) => {
  const data = new Uint8Array(104);
  data[0] = 2;
  data.set(asset, 8);
  return data;
};

const coreAssetData = (owner: Uint8Array, name: string) => {
  const nameBytes = Buffer.from(name, "utf8");
  const data = new Uint8Array(70 + nameBytes.length);
  data[0] = 1;
  data.set(owner, 1);
  new DataView(data.buffer).setUint32(66, nameBytes.length, true);
  data.set(nameBytes, 70);
  return data;
};

const chainState = (asset: string, owner: string | null, name: string | null, closed = false): MetaplexAssetState => ({
  asset,
  owner,
  name,
  closed,
});

const approvedSource = {
  id: "source-1",
  protocol: "solana_registry",
  sourceKey: METAPLEX_CHAIN_SOURCE_KEY,
  state: "active",
  cursor: null,
} as unknown as IngestionSource;

/** Routes mocked JSON-RPC calls by method; every response is a valid envelope. */
function stubRpc(routes: Record<string, (params: unknown[]) => unknown>) {
  const fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result: routes[body.method](body.params) }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Metaplex Solana chain adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("encodeBase58", () => {
    it("matches the standard vectors", () => {
      expect(encodeBase58(new Uint8Array(0))).toBe("");
      expect(encodeBase58(new Uint8Array([0]))).toBe("1");
      expect(encodeBase58(new Uint8Array([255]))).toBe("5Q");
      expect(encodeBase58(Buffer.from("hello world", "utf8"))).toBe("StV1DL6CwTryKyV");
      expect(encodeBase58(ZERO32)).toBe("1".repeat(32));
    });
  });

  describe("decodeMetaplexIdentityPda", () => {
    it("reads the asset pubkey from both approved layouts", () => {
      expect(decodeMetaplexIdentityPda("1".repeat(32), ZERO32.subarray(0, 1))).toBeNull();
      const v1 = new Uint8Array(40);
      v1[0] = 1;
      v1.set(ZERO32, 8);
      expect(decodeMetaplexIdentityPda("1".repeat(32), v1)).toEqual({ pda: "1".repeat(32), version: 1, asset: ASSET_1 });
      expect(decodeMetaplexIdentityPda("2".repeat(32), identityV2Data(ZERO32))).toEqual({
        pda: "2".repeat(32),
        version: 2,
        asset: ASSET_1,
      });
    });

    it("returns null for unapproved key bytes and short data", () => {
      const unknownKey = identityV2Data(ZERO32);
      unknownKey[0] = 9;
      expect(decodeMetaplexIdentityPda("2".repeat(32), unknownKey)).toBeNull();
      const shortV2 = identityV2Data(ZERO32).subarray(0, 90);
      expect(decodeMetaplexIdentityPda("2".repeat(32), shortV2)).toBeNull();
    });
  });

  describe("decodeMetaplexCoreAsset", () => {
    it("reads owner and name from a live asset", () => {
      expect(decodeMetaplexCoreAsset(ASSET_1, coreAssetData(OWNER_A_BYTES, "Alpha Agent"))).toEqual({
        asset: ASSET_1,
        owner: OWNER_A,
        name: "Alpha Agent",
        closed: false,
      });
    });

    it("treats null, short, and wrong-key data as closed", () => {
      expect(decodeMetaplexCoreAsset(ASSET_1, null)).toMatchObject({ closed: true, owner: null, name: null });
      expect(decodeMetaplexCoreAsset(ASSET_1, new Uint8Array(39))).toMatchObject({ closed: true });
      const wrongKey = coreAssetData(OWNER_A_BYTES, "Alpha");
      wrongKey[0] = 2;
      expect(decodeMetaplexCoreAsset(ASSET_1, wrongKey)).toMatchObject({ closed: true });
    });

    it("strips trailing NULs and whitespace from names", () => {
      const data = coreAssetData(OWNER_A_BYTES, "Beta");
      const withNuls = new Uint8Array(data.length + 2);
      withNuls.set(data, 0);
      new DataView(withNuls.buffer).setUint32(66, 6, true);
      withNuls.set(Buffer.from("Beta\0\0", "utf8"), 70);
      expect(decodeMetaplexCoreAsset(ASSET_1, withNuls).name).toBe("Beta");
      expect(decodeMetaplexCoreAsset(ASSET_1, coreAssetData(OWNER_A_BYTES, "  Gamma  ")).name).toBe("Gamma");
    });

    it("ignores a name length that overruns the account data", () => {
      const data = coreAssetData(OWNER_A_BYTES, "Delta");
      new DataView(data.buffer).setUint32(66, 500, true);
      const decoded = decodeMetaplexCoreAsset(ASSET_1, data);
      expect(decoded.closed).toBe(false);
      expect(decoded.name).toBeNull();
    });
  });

  describe("parseGetProgramAccountsResponse", () => {
    it("decodes approved PDAs and counts unparseable rows", () => {
      const result = parseGetProgramAccountsResponse([
        { pubkey: "1".repeat(32), account: { data: [b64(identityV2Data(ZERO32)), "base64"] } },
        { pubkey: "2".repeat(32), account: { data: [b64(identityV2Data(ownerBytes(7))), "base64"] } },
        { pubkey: "not-base58!!", account: { data: [b64(identityV2Data(ZERO32)), "base64"] } },
        { pubkey: "3".repeat(32), account: { data: "garbage" } },
      ]);
      expect(result.records).toEqual([
        { pda: "1".repeat(32), version: 2, asset: ASSET_1 },
        { pda: "2".repeat(32), version: 2, asset: ASSET_2 },
      ]);
      expect(result.unknownCount).toBe(2);
    });

    it("rejects a non-array response", () => {
      expect(() => parseGetProgramAccountsResponse({})).toThrow(MetaplexChainValidationError);
    });
  });

  describe("parseGetMultipleAccountsResponse", () => {
    it("decodes flat live entries against the requested key order and reads nulls as closed", () => {
      const requested = [ASSET_1, ASSET_2];
      const states = parseGetMultipleAccountsResponse(
        {
          value: [
            { data: [b64(coreAssetData(OWNER_A_BYTES, "Alpha")), "base64"] },
            null,
          ],
        },
        requested
      );
      expect(states).toEqual([
        { asset: ASSET_1, owner: OWNER_A, name: "Alpha", closed: false },
        { asset: ASSET_2, owner: null, name: null, closed: true },
      ]);
    });

    it("rejects a value array that does not align with the request", () => {
      expect(() => parseGetMultipleAccountsResponse({ value: [] }, [ASSET_1])).toThrow(MetaplexChainValidationError);
    });

    it("fails the pass on a wrapped gPA-style entry instead of decoding it as closed", () => {
      // 2026-10-11 incident pin: getMultipleAccounts returns the account tuple
      // flat on the entry; the wrapped `.account.data` shape is getProgramAccounts'
      // wire format. Reading it here silently classified every live asset as
      // closed in production, so a wrapped entry must fail the pass loudly.
      expect(() =>
        parseGetMultipleAccountsResponse(
          { value: [{ account: { data: [b64(coreAssetData(OWNER_A_BYTES, "Alpha")), "base64"] } }] },
          [ASSET_1]
        )
      ).toThrow(MetaplexChainValidationError);
    });
  });

  describe("parseNewestSuccessfulSignature", () => {
    it("skips failed transactions and short entries", () => {
      const signature = parseNewestSuccessfulSignature(
        [
          { signature: "short", err: null },
          { signature: "4".repeat(88), err: { InstructionError: [0, 1] } },
          { signature: SIGNATURE, err: null },
        ],
        ASSET_1
      );
      expect(signature).toBe(SIGNATURE);
    });

    it("fails the pass loudly when no successful transaction exists", () => {
      expect(() => parseNewestSuccessfulSignature([{ signature: "4".repeat(88), err: { x: 1 } }], ASSET_1)).toThrow(
        MetaplexChainValidationError
      );
    });
  });

  describe("classifyMetaplexChainDiff", () => {
    it("seeds a plain inventory with zero events", () => {
      const diff = classifyMetaplexChainDiff({
        seed: true,
        states: [chainState(ASSET_1, OWNER_A, "Alpha"), chainState(ASSET_2, OWNER_B, "Beta"), chainState("9".repeat(44), null, null, true)],
        prior: new Map(),
      });
      expect(diff.upserts).toHaveLength(2);
      expect(diff.diffEvents).toEqual([]);
      expect(diff.deferredCount).toBe(0);
      expect(diff.closedSkippedCount).toBe(1);
    });

    it("registers unknown live assets and skips never-acknowledged closed ones", () => {
      const diff = classifyMetaplexChainDiff({
        seed: false,
        states: [chainState(ASSET_1, OWNER_A, "Alpha"), chainState(ASSET_2, null, null, true)],
        prior: new Map(),
      });
      expect(diff.diffEvents).toEqual([{ kind: "register", asset: ASSET_1, fromOwner: null, toOwner: OWNER_A }]);
      expect(diff.upserts).toHaveLength(1);
      expect(diff.closedSkippedCount).toBe(1);
    });

    it("detects transfers but adopts an unknown prior owner silently", () => {
      const changed = chainState(ASSET_1, OWNER_A, "Alpha");
      const fromKnown = classifyMetaplexChainDiff({
        seed: false,
        states: [changed],
        prior: new Map([[ASSET_1, { displayName: "Alpha", registrant: OWNER_C, closed: false } as MetaplexChainPriorEntry]]),
      });
      expect(fromKnown.diffEvents).toEqual([{ kind: "transfer", asset: ASSET_1, fromOwner: OWNER_C, toOwner: OWNER_A }]);
      const fromUnknown = classifyMetaplexChainDiff({
        seed: false,
        states: [changed],
        prior: new Map([[ASSET_1, { displayName: "Alpha", registrant: null, closed: false } as MetaplexChainPriorEntry]]),
      });
      expect(fromUnknown.diffEvents).toEqual([]);
      expect(fromUnknown.upserts).toHaveLength(1);
    });

    it("detects profile updates and asset closes", () => {
      const renamed = classifyMetaplexChainDiff({
        seed: false,
        states: [chainState(ASSET_1, OWNER_A, "New name")],
        prior: new Map([[ASSET_1, { displayName: "Old name", registrant: OWNER_A, closed: false } as MetaplexChainPriorEntry]]),
      });
      expect(renamed.diffEvents).toEqual([{ kind: "profile_update", asset: ASSET_1, fromOwner: null, toOwner: OWNER_A }]);
      const closed = classifyMetaplexChainDiff({
        seed: false,
        states: [chainState(ASSET_1, null, null, true)],
        prior: new Map([[ASSET_1, { displayName: "Alpha", registrant: OWNER_C, closed: false } as MetaplexChainPriorEntry]]),
      });
      expect(closed.diffEvents).toEqual([{ kind: "asset_closed", asset: ASSET_1, fromOwner: OWNER_C, toOwner: null }]);
    });

    it("defers whole assets past the per-pass event cap and keeps refreshing unchanged rows", () => {
      const states: MetaplexAssetState[] = [];
      const prior = new Map<string, MetaplexChainPriorEntry>();
      for (let index = 0; index < METAPLEX_CHAIN_MAX_EVENTS_PER_PASS + 1; index += 1) {
        const asset = encodeBase58(ownerBytes(index + 1));
        states.push(chainState(asset, OWNER_A, `Agent ${index}`));
        prior.set(asset, { displayName: `Agent ${index}`, registrant: OWNER_C, closed: false });
      }
      states.push(chainState(ASSET_1, OWNER_A, "Unchanged"));
      prior.set(ASSET_1, { displayName: "Unchanged", registrant: OWNER_A, closed: false });
      const diff = classifyMetaplexChainDiff({ seed: false, states, prior });
      expect(diff.diffEvents).toHaveLength(METAPLEX_CHAIN_MAX_EVENTS_PER_PASS);
      expect(diff.deferredCount).toBe(1);
      // The deferred asset is neither evented nor upserted, so its stale prior
      // state re-diffs on the next pass; the unchanged row still refreshes.
      expect(diff.upserts.some(state => state.asset === ASSET_1)).toBe(true);
      expect(diff.upserts).toHaveLength(METAPLEX_CHAIN_MAX_EVENTS_PER_PASS + 1);
    });

    it("defers a two-event asset that would cross the cap", () => {
      const states: MetaplexAssetState[] = [];
      const prior = new Map<string, MetaplexChainPriorEntry>();
      for (let index = 0; index < METAPLEX_CHAIN_MAX_EVENTS_PER_PASS - 1; index += 1) {
        const asset = encodeBase58(ownerBytes(index + 10));
        states.push(chainState(asset, OWNER_A, `Agent ${index}`));
        prior.set(asset, { displayName: `Agent ${index}`, registrant: OWNER_C, closed: false });
      }
      // Transferred AND renamed: two events on one asset. The diff walks
      // assets in lexicographic order, so this asset sorts after every
      // filler ('z' is the last base58 digit): with MAX-1 events already
      // accepted, accepting both would cross the cap, so the whole asset
      // defers — its stale prior state re-diffs on the next pass.
      const lateAsset = encodeBase58(ownerBytes(57));
      states.push(chainState(lateAsset, OWNER_B, "New name"));
      prior.set(lateAsset, { displayName: "Old name", registrant: OWNER_C, closed: false });
      const diff = classifyMetaplexChainDiff({ seed: false, states, prior });
      expect(diff.diffEvents).toHaveLength(METAPLEX_CHAIN_MAX_EVENTS_PER_PASS - 1);
      expect(diff.deferredCount).toBe(1);
      expect(diff.upserts.some(state => state.asset === lateAsset)).toBe(false);
    });

    it("acknowledges a closure exactly once across two passes and keeps the cap free for real changes", () => {
      // Pass one: an acknowledged live asset is now closed on-chain. Exactly
      // one asset_closed event, and no upsert — the row keeps its last
      // acknowledged name and owner; only the closure marker is written.
      const passOne = classifyMetaplexChainDiff({
        seed: false,
        states: [chainState(ASSET_1, null, null, true)],
        prior: new Map([[ASSET_1, { displayName: "Alpha", registrant: OWNER_C, closed: false } as MetaplexChainPriorEntry]]),
      });
      expect(passOne.diffEvents).toEqual([{ kind: "asset_closed", asset: ASSET_1, fromOwner: OWNER_C, toOwner: null }]);
      expect(passOne.closedAcknowledgedCount).toBe(0);
      expect(passOne.upserts.some(state => state.asset === ASSET_1)).toBe(false);

      // Pass two: the prior row now carries the closure marker. The same
      // closed state must not re-emit an event or consume the per-pass event
      // cap, so a real transfer in the same pass still gets its slot —
      // acknowledged closures can never starve live changes (the failure mode
      // this guards against: 25 re-emitted closures deferring every event).
      const passTwo = classifyMetaplexChainDiff({
        seed: false,
        states: [chainState(ASSET_1, null, null, true), chainState(ASSET_2, OWNER_B, "Beta")],
        prior: new Map([
          [ASSET_1, { displayName: "Alpha", registrant: OWNER_C, closed: true } as MetaplexChainPriorEntry],
          [ASSET_2, { displayName: "Beta", registrant: OWNER_C, closed: false } as MetaplexChainPriorEntry],
        ]),
      });
      expect(passTwo.diffEvents).toEqual([{ kind: "transfer", asset: ASSET_2, fromOwner: OWNER_C, toOwner: OWNER_B }]);
      expect(passTwo.closedAcknowledgedCount).toBe(1);
      expect(passTwo.upserts.some(state => state.asset === ASSET_1)).toBe(false);
      expect(passTwo.upserts.some(state => state.asset === ASSET_2)).toBe(true);
    });

    it("treats an asset registered again after an acknowledged closure as a fresh registration", () => {
      const diff = classifyMetaplexChainDiff({
        seed: false,
        states: [chainState(ASSET_1, OWNER_B, "Reborn")],
        prior: new Map([[ASSET_1, { displayName: "Alpha", registrant: OWNER_C, closed: true } as MetaplexChainPriorEntry]]),
      });
      // Register, not transfer/profile_update: the prior closure ended the
      // earlier acknowledgment. The live upsert clears the closure marker at
      // the persistence layer, returning the row to public reads.
      expect(diff.diffEvents).toEqual([{ kind: "register", asset: ASSET_1, fromOwner: null, toOwner: OWNER_B }]);
      expect(diff.upserts).toHaveLength(1);
    });

    it("adopts a never-chain-acknowledged row silently instead of recording a fake profile update", () => {
      // The API pilot wrote the row (null registrant, API-reported name); the
      // chain pass acknowledges it with chain facts for the first time. An
      // API name is not prior chain state, so the name difference is not a
      // profile_update — and a real transfer can never be masked by the API
      // nulling the registrant, because the API path can no longer update rows.
      const diff = classifyMetaplexChainDiff({
        seed: false,
        states: [chainState(ASSET_1, OWNER_A, "Chain name")],
        prior: new Map([[ASSET_1, { displayName: "API name", registrant: null, closed: false } as MetaplexChainPriorEntry]]),
      });
      expect(diff.diffEvents).toEqual([]);
      expect(diff.upserts).toHaveLength(1);
    });
  });

  describe("assertApprovedMetaplexChainSource", () => {
    it("accepts only the active approved Metaplex source", () => {
      expect(() => assertApprovedMetaplexChainSource(approvedSource)).not.toThrow();
      const wrongKey = { ...approvedSource, sourceKey: "other" } as unknown as IngestionSource;
      expect(() => assertApprovedMetaplexChainSource(wrongKey)).toThrow(MetaplexChainValidationError);
      const wrongProtocol = { ...approvedSource, protocol: "erc8004" } as unknown as IngestionSource;
      expect(() => assertApprovedMetaplexChainSource(wrongProtocol)).toThrow(MetaplexChainValidationError);
      const inactive = { ...approvedSource, state: "review" } as unknown as IngestionSource;
      expect(() => assertApprovedMetaplexChainSource(inactive)).toThrow(MetaplexChainValidationError);
    });
  });

  describe("isMetaplexChainSeedCursor", () => {
    it("counts only a sync2 cursor as a completed inventory", () => {
      expect(isMetaplexChainSeedCursor("sync2:455825921")).toBe(false);
      // V1 `sync:` cursors were written by the build that misread every live
      // asset as closed (2026-10-11): that stored state is not trustworthy, so
      // the next pass re-inventories. Absent, empty, and foreign cursors seed.
      expect(isMetaplexChainSeedCursor("sync:455825920")).toBe(true);
      expect(isMetaplexChainSeedCursor(null)).toBe(true);
      expect(isMetaplexChainSeedCursor("")).toBe(true);
      expect(isMetaplexChainSeedCursor("bf:123")).toBe(true);
    });
  });

  describe("fetchMetaplexChainState", () => {
    it("seeds inventory over the paced RPC path without emitting events", async () => {
      const fetchMock = stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          { pubkey: "1".repeat(32), account: { data: [b64(identityV2Data(ZERO32)), "base64"] } },
          { pubkey: "2".repeat(32), account: { data: [b64(identityV2Data(ownerBytes(7))), "base64"] } },
        ],
        getMultipleAccounts: () => ({
          value: [{ data: [b64(coreAssetData(OWNER_A_BYTES, "Alpha")), "base64"] }, null],
        }),
      });
      const snapshot = await fetchMetaplexChainState({ source: approvedSource, seed: true, prior: new Map(), rpcUrl: "https://rpc.test" });
      expect(snapshot).toMatchObject({
        slot: 4242,
        seed: true,
        enumeratedCount: 2,
        unknownCount: 0,
        liveCount: 1,
        closedCount: 1,
        deferredCount: 0,
        closedSkippedCount: 1,
        closedAcknowledgedCount: 0,
        requestCount: 3,
      });
      expect(snapshot.events).toEqual([]);
      expect(snapshot.drafts).toEqual([
        {
          externalKey: ASSET_1,
          displayName: "Alpha",
          locatorHost: null,
          registrant: OWNER_A,
          sourceSignalNote: METAPLEX_CHAIN_SIGNAL_NOTE,
        },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("attributes a diff event to the asset's newest successful signature", async () => {
      stubRpc({
        getSlot: () => 4242,
        getProgramAccounts: () => [
          { pubkey: "1".repeat(32), account: { data: [b64(identityV2Data(ZERO32)), "base64"] } },
          { pubkey: "2".repeat(32), account: { data: [b64(identityV2Data(ownerBytes(7))), "base64"] } },
        ],
        getMultipleAccounts: () => ({
          value: [{ data: [b64(coreAssetData(OWNER_A_BYTES, "Alpha")), "base64"] }, null],
        }),
        getSignaturesForAddress: () => [{ signature: SIGNATURE, err: null }],
      });
      const prior = new Map([[ASSET_1, { displayName: "Alpha", registrant: OWNER_C, closed: false } as MetaplexChainPriorEntry]]);
      const snapshot = await fetchMetaplexChainState({ source: approvedSource, seed: false, prior, rpcUrl: "https://rpc.test" });
      expect(snapshot.events).toEqual([
        { kind: "transfer", externalKey: ASSET_1, transactionSignature: SIGNATURE, slot: 4242, fromOwner: OWNER_C, toOwner: OWNER_A },
      ]);
      // The never-acknowledged closed asset has nothing to withdraw and no
      // attribution call of its own.
      expect(snapshot.closedSkippedCount).toBe(1);
      expect(snapshot.drafts).toHaveLength(1);
      expect(snapshot.requestCount).toBe(4);
    });
  });
});
