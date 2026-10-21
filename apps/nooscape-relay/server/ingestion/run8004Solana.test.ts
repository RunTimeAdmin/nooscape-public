import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * Runner wiring tests for the 8004 chain pass: the pass owns locatorHost (no
 * preserveLocatorHost — the registration URI is a chain read), the adapter's
 * closure marker list covers anchored and unanchored closures alike, the
 * `s8004:` cursor persists only after the whole snapshot succeeds, and the
 * unattended/identity guards fire before any run row is written. The adapter
 * itself is covered in solana8004.test.ts; here the db layer is mocked so
 * every write call is asserted exactly.
 */
type MockUpsertInput = {
  entries: Array<{ externalKey: string; accountPubkey?: string | null; profileUriHash?: string | null }>;
  preserveLocatorHost?: boolean;
  insertOnly?: boolean;
  clearAssetClosed?: boolean;
};
type MockPriorRow = {
  externalKey: string;
  displayName: string | null;
  locatorHost: string | null;
  registrant: string | null;
  accountPubkey: string | null;
  profileUriHash: string | null;
  assetClosedAt: Date | null;
};
type MockChainInput = {
  source: IngestionSource;
  seed: boolean;
  prior: Map<
    string,
    {
      displayName: string | null;
      locatorHost: string | null;
      registrant: string | null;
      accountPubkey: string | null;
      profileUriHash: string | null;
      closed: boolean;
    }
  >;
  priorResolutions?: Map<
    string,
    { externalKey: string; uriHash: string; status: "resolved" | "no_name" | "failed"; resolvedName: string | null; attempts: number }
  >;
};
type MockResolutionDraft = {
  externalKey: string;
  uriHash: string;
  uriKind: string;
  uri: string;
  status: "resolved" | "no_name" | "failed";
  failReason: string | null;
  resolvedName: string | null;
  attempts: number;
};
type MockChainLinkDraft = {
  externalKey: string;
  metadataKey: string;
  linkedProtocol: string;
  linkedExternalKey: string;
  metadataValueHash: string;
};
type MockChainSnapshot = {
  slot: number;
  seed: boolean;
  enumeratedCount: number;
  agentCount: number;
  unknownCount: number;
  tailResidueCount: number;
  drafts: Array<{
    externalKey: string;
    displayName: string;
    locatorHost: string | null;
    registrant: string | null;
    accountPubkey?: string | null;
    profileUriHash?: string | null;
    feedbackCount?: number | null;
    sourceSignalNote: string;
  }>;
  events: Array<{ kind: string; externalKey: string; transactionSignature: string; slot: number; fromOwner: string | null; toOwner: string | null }>;
  closedExternalKeys: string[];
  deferredCount: number;
  closedAcknowledgedCount: number;
  unanchoredClosureCount: number;
  resolutions: MockResolutionDraft[];
  chainLinks: MockChainLinkDraft[];
  requestCount: number;
};

const mocks = vi.hoisted(() => ({
  beginIngestionRun: vi.fn(async (_source: unknown, _trigger: string) => "run-1"),
  finishIngestionRun: vi.fn(async (_input: unknown) => {}),
  listAgentDirectoryEntriesForSource: vi.fn(async (_sourceId: string): Promise<MockPriorRow[]> => []),
  listAgentRegistrationResolutions: vi.fn(
    async (_sourceId: string): Promise<Array<{ externalKey: string; uriHash: string; status: "resolved" | "no_name" | "failed"; resolvedName: string | null; attempts: number }>> => []
  ),
  markAgentDirectoryEntriesClosed: vi.fn(async (_input: { source: unknown; runId: string; externalKeys: string[] }) => 0),
  upsertAgentDirectoryEntries: vi.fn(async (_input: unknown) => 0),
  upsertAgentRegistrationResolutions: vi.fn(async (_input: unknown) => 0),
  upsertAgentDirectoryChainLinks: vi.fn(async (_input: unknown) => 0),
  applySolanaActivityWindow: vi.fn(async (_input: { source: unknown; events: unknown[] }) => ({ acknowledgedCount: 0 })),
  fetchSolana8004ChainState: vi.fn(async (_input: unknown) => ({})),
}));

vi.mock("../db", () => ({
  applySolanaActivityWindow: mocks.applySolanaActivityWindow,
  beginIngestionRun: mocks.beginIngestionRun,
  finishIngestionRun: mocks.finishIngestionRun,
  listAgentDirectoryEntriesForSource: mocks.listAgentDirectoryEntriesForSource,
  listAgentRegistrationResolutions: mocks.listAgentRegistrationResolutions,
  markAgentDirectoryEntriesClosed: mocks.markAgentDirectoryEntriesClosed,
  upsertAgentDirectoryEntries: mocks.upsertAgentDirectoryEntries,
  upsertAgentRegistrationResolutions: mocks.upsertAgentRegistrationResolutions,
  upsertAgentDirectoryChainLinks: mocks.upsertAgentDirectoryChainLinks,
}));

vi.mock("./solana8004", () => ({
  SOLANA_8004_CHAIN_SOURCE_KEY: "solana-8004-agent-registry",
  isSolana8004ChainSeedCursor: (cursor: string | null) => !(cursor !== null && cursor.startsWith("s8004:")),
  fetchSolana8004ChainState: mocks.fetchSolana8004ChainState,
}));

import { runApproved8004SolanaSource } from "./run8004Solana";

/** Fixed base58 owner string; the adapter decodes are covered in solana8004.test.ts. */
const OWNER_A = (() => {
  const bytes = new Uint8Array(32);
  bytes[31] = 1;
  let value = 0n;
  for (let index = 0; index < bytes.length; index += 1) value = (value << 8n) | BigInt(bytes[index]!);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
})();

const ASSET_OPEN = "2".repeat(44);
const ASSET_CLOSED = "3".repeat(44);
const SIGNATURE = "5".repeat(88);

const activeSource = {
  id: "source-1",
  protocol: "solana_8004",
  sourceKey: "solana-8004-agent-registry",
  state: "active",
  cursor: "s8004:455872585",
  executionPolicy: "manual_only",
  scheduleMinutes: 1_440,
} as unknown as IngestionSource;

function chainSnapshot(overrides: Partial<MockChainSnapshot> = {}): MockChainSnapshot {
  return {
    slot: 4242,
    seed: false,
    enumeratedCount: 3,
    agentCount: 2,
    unknownCount: 1,
    tailResidueCount: 0,
    drafts: [
      { externalKey: ASSET_OPEN, displayName: "Open", locatorHost: "open.example.org", registrant: OWNER_A, accountPubkey: "A".repeat(44), profileUriHash: "hash-open", sourceSignalNote: "note" },
    ],
    events: [
      { kind: "transfer", externalKey: ASSET_OPEN, transactionSignature: SIGNATURE, slot: 4242, fromOwner: OWNER_A, toOwner: OWNER_A },
    ],
    closedExternalKeys: [ASSET_CLOSED],
    deferredCount: 0,
    closedAcknowledgedCount: 0,
    unanchoredClosureCount: 1,
    resolutions: [
      {
        externalKey: ASSET_OPEN,
        uriHash: "hash-open",
        uriKind: "ipfs",
        uri: "ipfs://bafyexample",
        status: "resolved",
        failReason: null,
        resolvedName: "Resolved Name",
        attempts: 1,
      },
    ],
    chainLinks: [
      {
        externalKey: ASSET_OPEN,
        metadataKey: "erc8004-eth",
        linkedProtocol: "erc8004",
        linkedExternalKey: "#25045",
        metadataValueHash: "link-value-hash",
      },
    ],
    requestCount: 3,
    ...overrides,
  };
}

describe("runApproved8004SolanaSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts drafts without preserveLocatorHost, marks the adapter's closure list, and persists the s8004 cursor", async () => {
    mocks.listAgentDirectoryEntriesForSource.mockResolvedValue([
      { externalKey: ASSET_OPEN, displayName: "Open", locatorHost: "old.example.org", registrant: OWNER_A, accountPubkey: "A".repeat(44), profileUriHash: "hash-open", assetClosedAt: null },
      { externalKey: ASSET_CLOSED, displayName: "Closed", locatorHost: null, registrant: OWNER_A, accountPubkey: "B".repeat(44), profileUriHash: null, assetClosedAt: null },
    ]);
    // Step-3 prior resolutions: the fetch queue's idempotency state, keyed by
    // uriHash in the adapter.
    mocks.listAgentRegistrationResolutions.mockResolvedValue([
      { externalKey: ASSET_OPEN, uriHash: "hash-open", status: "resolved", resolvedName: "Resolved Name", attempts: 1 },
    ]);
    const snapshot = chainSnapshot();
    mocks.fetchSolana8004ChainState.mockResolvedValue(snapshot);

    const result = await runApproved8004SolanaSource(activeSource, "manual");

    // The prior map must carry locatorHost and the migration-0026 chain facts
    // into the adapter diff: a URI edit is a profile_update only against the
    // prior host and hash, and a closure confirmation read needs the stored PDA.
    const chainInput = mocks.fetchSolana8004ChainState.mock.calls[0]![0]! as unknown as MockChainInput;
    expect(chainInput.source).toBe(activeSource);
    expect(chainInput.seed).toBe(false);
    expect(chainInput.prior.get(ASSET_OPEN)).toEqual({
      displayName: "Open",
      locatorHost: "old.example.org",
      registrant: OWNER_A,
      accountPubkey: "A".repeat(44),
      profileUriHash: "hash-open",
      closed: false,
    });
    // The prior resolutions ride in keyed by uriHash.
    expect(chainInput.priorResolutions!.get("hash-open")).toEqual({
      externalKey: ASSET_OPEN,
      uriHash: "hash-open",
      status: "resolved",
      resolvedName: "Resolved Name",
      attempts: 1,
    });

    expect(mocks.upsertAgentDirectoryEntries).toHaveBeenCalledTimes(1);
    const upsertInput = mocks.upsertAgentDirectoryEntries.mock.calls[0]![0]! as unknown as MockUpsertInput;
    expect(upsertInput.entries.map(entry => entry.externalKey)).toEqual([ASSET_OPEN]);
    // The drafts carry the 0026 chain facts into the upsert: the stored PDA
    // and URI hash are what the next pass's confirm read and link diff use.
    expect(upsertInput.entries[0]).toMatchObject({ accountPubkey: "A".repeat(44), profileUriHash: "hash-open" });
    // The 8004 pass owns locatorHost — unlike the Metaplex API pilot rows,
    // there is no preserveLocatorHost: a URI edit rewrites the host honestly.
    expect(upsertInput.preserveLocatorHost).toBeUndefined();
    expect(upsertInput.clearAssetClosed).toBe(true);
    expect(upsertInput.insertOnly).toBeUndefined();

    // The marker list is the adapter's closedExternalKeys (anchored and
    // unanchored closures alike), not a re-derivation from ledger events.
    expect(mocks.markAgentDirectoryEntriesClosed).toHaveBeenCalledTimes(1);
    const markInput = mocks.markAgentDirectoryEntriesClosed.mock.calls[0]![0]!;
    expect(markInput.source).toBe(activeSource);
    expect(markInput.externalKeys).toEqual([ASSET_CLOSED]);
    expect(mocks.applySolanaActivityWindow).toHaveBeenCalledTimes(1);
    expect(mocks.applySolanaActivityWindow.mock.calls[0]![0]!.events).toEqual(snapshot.events);
    // The ledger writes first: an interrupted pass leaves the prior state
    // stale, the next pass re-detects the same diff, and the INSERT-IGNORE
    // ledger re-apply is a no-op — so a failed upsert or marker write can
    // never permanently lose an event.
    const ledgerOrder = mocks.applySolanaActivityWindow.mock.invocationCallOrder[0]!;
    const upsertOrder = mocks.upsertAgentDirectoryEntries.mock.invocationCallOrder[0]!;
    const markOrder = mocks.markAgentDirectoryEntriesClosed.mock.invocationCallOrder[0]!;
    expect(ledgerOrder).toBeLessThan(upsertOrder);
    expect(upsertOrder).toBeLessThan(markOrder);

    // Step-3 auxiliary records land after the marker: the snapshot's
    // resolution rows (budgeted fetches + on-chain meta names) and upsert-only
    // chain links persist as their own idempotent upserts, after every write
    // the retry order depends on.
    expect(mocks.upsertAgentRegistrationResolutions).toHaveBeenCalledTimes(1);
    const resolutionInput = mocks.upsertAgentRegistrationResolutions.mock.calls[0]![0]! as unknown as {
      source: IngestionSource;
      drafts: MockResolutionDraft[];
    };
    expect(resolutionInput.source).toBe(activeSource);
    expect(resolutionInput.drafts).toEqual(snapshot.resolutions);
    expect(mocks.upsertAgentDirectoryChainLinks).toHaveBeenCalledTimes(1);
    const linkInput = mocks.upsertAgentDirectoryChainLinks.mock.calls[0]![0]! as unknown as {
      source: IngestionSource;
      drafts: MockChainLinkDraft[];
    };
    expect(linkInput.source).toBe(activeSource);
    expect(linkInput.drafts).toEqual(snapshot.chainLinks);
    const resolutionOrder = mocks.upsertAgentRegistrationResolutions.mock.invocationCallOrder[0]!;
    const linkOrder = mocks.upsertAgentDirectoryChainLinks.mock.invocationCallOrder[0]!;
    expect(markOrder).toBeLessThan(resolutionOrder);
    expect(resolutionOrder).toBeLessThan(linkOrder);

    expect(result).toEqual({
      requestCount: 3,
      discoveredCount: 3,
      acceptedCount: 1,
      rejectedCount: 1,
      nextCursor: "s8004:4242",
    });
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", nextCursor: "s8004:4242" })
    );
  });

  it("seeds when the source has no s8004 inventory position yet", async () => {
    mocks.fetchSolana8004ChainState.mockResolvedValue(chainSnapshot({ seed: true, events: [], closedExternalKeys: [] }));
    const unseeded = { ...activeSource, cursor: null } as unknown as IngestionSource;
    await runApproved8004SolanaSource(unseeded, "manual");
    const chainInput = mocks.fetchSolana8004ChainState.mock.calls[0]![0]! as unknown as MockChainInput;
    expect(chainInput.seed).toBe(true);
    // A seed pass emits no events, so nothing reaches the closure marker or
    // the ledger; the first s8004 cursor is what makes the next pass a diff.
    expect(mocks.markAgentDirectoryEntriesClosed).toHaveBeenCalledTimes(1);
    expect(mocks.markAgentDirectoryEntriesClosed.mock.calls[0]![0]!.externalKeys).toEqual([]);
    expect(mocks.applySolanaActivityWindow.mock.calls[0]![0]!.events).toEqual([]);
  });

  it("keeps an interrupted pass retryable: the ledger row lands, the marker and cursor do not move", async () => {
    mocks.listAgentDirectoryEntriesForSource.mockResolvedValue([
      { externalKey: ASSET_OPEN, displayName: "Open", locatorHost: "old.example.org", registrant: OWNER_A, accountPubkey: "A".repeat(44), profileUriHash: "hash-open", assetClosedAt: null },
      { externalKey: ASSET_CLOSED, displayName: "Closed", locatorHost: null, registrant: OWNER_A, accountPubkey: "B".repeat(44), profileUriHash: null, assetClosedAt: null },
    ]);
    mocks.fetchSolana8004ChainState.mockResolvedValue(chainSnapshot());
    // mockRejectedValueOnce: vi.clearAllMocks() clears calls but never
    // implementations, and a persistent rejection would poison every
    // later test's upsert.
    mocks.upsertAgentDirectoryEntries.mockRejectedValueOnce(new Error("db write down"));
    await expect(runApproved8004SolanaSource(activeSource, "manual")).rejects.toThrow(/db write down/);
    // The ledger wrote first, so the event is durably recorded; the upsert,
    // the closure marker and the cursor did not move, so the next pass
    // re-detects the same diff and the ledger's INSERT-IGNORE re-apply is a
    // no-op while the failed writes simply retry.
    expect(mocks.applySolanaActivityWindow).toHaveBeenCalledTimes(1);
    expect(mocks.markAgentDirectoryEntriesClosed).not.toHaveBeenCalled();
    // The step-3 auxiliary records sit after the marker in the write order,
    // so they did not move either: the retry starts from the ledger-first
    // order with the same prior state.
    expect(mocks.upsertAgentRegistrationResolutions).not.toHaveBeenCalled();
    expect(mocks.upsertAgentDirectoryChainLinks).not.toHaveBeenCalled();
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", nextCursor: "s8004:455872585" })
    );
  });

  it("keeps the failure path non-destructive: cursor untouched, no writes, run marked failed", async () => {
    // mockRejectedValueOnce for the same reason: a persistent fetch rejection
    // would outlive clearAllMocks into any later test that expects a healthy fetch.
    mocks.fetchSolana8004ChainState.mockRejectedValueOnce(new Error("rpc down"));
    await expect(runApproved8004SolanaSource(activeSource, "manual")).rejects.toThrow(/rpc down/);
    expect(mocks.upsertAgentDirectoryEntries).not.toHaveBeenCalled();
    expect(mocks.markAgentDirectoryEntriesClosed).not.toHaveBeenCalled();
    expect(mocks.applySolanaActivityWindow).not.toHaveBeenCalled();
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        nextCursor: "s8004:455872585",
      })
    );
  });

  it("keeps the unattended and identity guards", async () => {
    await expect(runApproved8004SolanaSource(activeSource, "replay")).rejects.toThrow(/rejected outright/);
    await expect(runApproved8004SolanaSource(activeSource, "scheduled")).rejects.toThrow(/scheduled execution policy/);
    const wrongSource = { ...activeSource, protocol: "solana_registry", sourceKey: "metaplex-solana-agent-registry" } as unknown as IngestionSource;
    await expect(runApproved8004SolanaSource(wrongSource, "manual")).rejects.toThrow(/8004 Solana agent registry only/);
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });
});
