import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * Runner wiring tests: the chain activity pass must be the only writer of an
 * acknowledged row's display name and registrant (the API pilot's directory
 * acknowledgements are insert-only), and a closure acknowledgment must mark
 * the row exactly once (hide-once) so later passes skip it without another
 * event. The adapters themselves are covered in metaplexChain.test.ts; here
 * the db layer is mocked so every write call is asserted exactly.
 */
type MockUpsertInput = {
  entries: Array<{ externalKey: string }>;
  preserveLocatorHost?: boolean;
  insertOnly?: boolean;
  clearAssetClosed?: boolean;
};
type MockMarkInput = { externalKeys: string[] };
type MockPriorEntry = { displayName: string | null; registrant: string | null; closed: boolean };
type MockChainInput = { source: IngestionSource; seed: boolean; prior: Map<string, MockPriorEntry> };
type MockChainSnapshot = {
  slot: number;
  seed: boolean;
  enumeratedCount: number;
  unknownCount: number;
  liveCount: number;
  closedCount: number;
  drafts: Array<{ externalKey: string; displayName: string; locatorHost: string | null; registrant: string | null; sourceSignalNote: string }>;
  events: Array<{ kind: string; externalKey: string; transactionSignature: string; slot: number; fromOwner: string | null; toOwner: string | null }>;
  deferredCount: number;
  closedSkippedCount: number;
  closedAcknowledgedCount: number;
  requestCount: number;
};
type MockRegistrySnapshot = {
  discoveredCount: number;
  rejectedCount: number;
  pagesFetched: number;
  observations: Array<{ candidate: unknown; observation: unknown }>;
  directory: Array<{ externalKey: string; displayName: string; locatorHost: string | null; sourceSignalNote: string }>;
};

const mocks = vi.hoisted(() => ({
  beginIngestionRun: vi.fn(async (_source: unknown, _trigger: string) => "run-1"),
  finishIngestionRun: vi.fn(async (_input: unknown) => {}),
  listAgentDirectoryEntriesForSource: vi.fn(
    async (_sourceId: string) =>
      [] as Array<{ externalKey: string; displayName: string | null; registrant: string | null; assetClosedAt: Date | null }>
  ),
  markAgentDirectoryEntriesClosed: vi.fn(async (_input: { source: unknown; runId: string; externalKeys: string[] }) => 0),
  persistSolanaRegistryObservation: vi.fn(async (_input: unknown) => {}),
  upsertAgentDirectoryEntries: vi.fn(async (_input: unknown) => 0),
  applySolanaActivityWindow: vi.fn(async (_input: { source: unknown; events: unknown[] }) => ({ acknowledgedCount: 0 })),
  fetchMetaplexChainState: vi.fn(async (_input: unknown) => ({})),
  fetchMetaplexRegistry: vi.fn(async (_source: unknown) => ({})),
}));

vi.mock("../db", () => ({
  applySolanaActivityWindow: mocks.applySolanaActivityWindow,
  beginIngestionRun: mocks.beginIngestionRun,
  finishIngestionRun: mocks.finishIngestionRun,
  listAgentDirectoryEntriesForSource: mocks.listAgentDirectoryEntriesForSource,
  markAgentDirectoryEntriesClosed: mocks.markAgentDirectoryEntriesClosed,
  persistSolanaRegistryObservation: mocks.persistSolanaRegistryObservation,
  upsertAgentDirectoryEntries: mocks.upsertAgentDirectoryEntries,
}));

vi.mock("./metaplexChain", () => ({
  METAPLEX_CHAIN_SOURCE_KEY: "metaplex-solana-agent-registry",
  isMetaplexChainSeedCursor: (cursor: string | null) => !(cursor !== null && cursor.startsWith("sync2:")),
  fetchMetaplexChainState: mocks.fetchMetaplexChainState,
}));

vi.mock("./metaplex", () => ({
  fetchMetaplexRegistry: mocks.fetchMetaplexRegistry,
}));

import { runApprovedMetaplexRegistrySource } from "./runMetaplex";

/** Fixed base58 owner string; the adapter decodes are covered in metaplexChain.test.ts. */
const OWNER_C = (() => {
  const bytes = new Uint8Array(32);
  bytes[31] = 3;
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
const ASSET_LIVE = "4".repeat(44);
const SIGNATURE = "5".repeat(88);

const scheduledSource = {
  id: "source-1",
  protocol: "solana_registry",
  sourceKey: "metaplex-solana-agent-registry",
  state: "active",
  cursor: "sync2:455825921",
  executionPolicy: "scheduled",
  scheduleMinutes: 15,
} as unknown as IngestionSource;

function chainSnapshot(overrides: Partial<MockChainSnapshot> = {}): MockChainSnapshot {
  return {
    slot: 4242,
    seed: false,
    enumeratedCount: 3,
    unknownCount: 0,
    liveCount: 2,
    closedCount: 1,
    drafts: [
      { externalKey: ASSET_OPEN, displayName: "Open", locatorHost: null, registrant: OWNER_C, sourceSignalNote: "note" },
      { externalKey: ASSET_LIVE, displayName: "Live", locatorHost: null, registrant: OWNER_C, sourceSignalNote: "note" },
    ],
    events: [
      { kind: "transfer", externalKey: ASSET_OPEN, transactionSignature: SIGNATURE, slot: 4242, fromOwner: OWNER_C, toOwner: OWNER_C },
      { kind: "asset_closed", externalKey: ASSET_CLOSED, transactionSignature: SIGNATURE, slot: 4242, fromOwner: OWNER_C, toOwner: null },
    ],
    deferredCount: 0,
    closedSkippedCount: 0,
    closedAcknowledgedCount: 0,
    requestCount: 4,
    ...overrides,
  };
}

describe("runApprovedMetaplexRegistrySource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks exactly the closed assets and upserts live drafts with the chain-only write flags", async () => {
    mocks.listAgentDirectoryEntriesForSource.mockResolvedValue([
      { externalKey: ASSET_OPEN, displayName: "Open", registrant: OWNER_C, assetClosedAt: null },
      { externalKey: ASSET_CLOSED, displayName: "Closed", registrant: OWNER_C, assetClosedAt: null },
      { externalKey: ASSET_LIVE, displayName: "Live", registrant: OWNER_C, assetClosedAt: null },
    ]);
    const snapshot = chainSnapshot();
    mocks.fetchMetaplexChainState.mockResolvedValue(snapshot);

    const result = await runApprovedMetaplexRegistrySource(scheduledSource, "scheduled", "activity");

    expect(mocks.upsertAgentDirectoryEntries).toHaveBeenCalledTimes(1);
    const upsertInput = mocks.upsertAgentDirectoryEntries.mock.calls[0]![0]! as unknown as MockUpsertInput;
    // Live drafts only: the upsert never carries the closed asset, so the
    // closed row keeps its last acknowledged name and owner.
    expect(upsertInput.entries.map(entry => entry.externalKey)).toEqual([ASSET_OPEN, ASSET_LIVE]);
    expect(upsertInput.preserveLocatorHost).toBe(true);
    expect(upsertInput.clearAssetClosed).toBe(true);
    expect(upsertInput.insertOnly).toBeUndefined();

    // Hide-once: only the asset_closed event's key is marked, exactly once.
    expect(mocks.markAgentDirectoryEntriesClosed).toHaveBeenCalledTimes(1);
    const markInput = mocks.markAgentDirectoryEntriesClosed.mock.calls[0]![0]!;
    expect(markInput.source).toBe(scheduledSource);
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
    expect(result.nextCursor).toBe("sync2:4242");
  });

  it("keeps an interrupted pass retryable: the ledger row lands, the marker and cursor do not move", async () => {
    mocks.listAgentDirectoryEntriesForSource.mockResolvedValue([
      { externalKey: ASSET_OPEN, displayName: "Open", registrant: OWNER_C, assetClosedAt: null },
      { externalKey: ASSET_CLOSED, displayName: "Closed", registrant: OWNER_C, assetClosedAt: null },
      { externalKey: ASSET_LIVE, displayName: "Live", registrant: OWNER_C, assetClosedAt: null },
    ]);
    mocks.fetchMetaplexChainState.mockResolvedValue(chainSnapshot());
    // mockRejectedValueOnce: vi.clearAllMocks() clears calls but never
    // implementations, and a persistent rejection would poison every
    // later test's upsert.
    mocks.upsertAgentDirectoryEntries.mockRejectedValueOnce(new Error("db write down"));
    await expect(runApprovedMetaplexRegistrySource(scheduledSource, "scheduled", "activity")).rejects.toThrow(/db write down/);
    // The ledger wrote first, so the event is durably recorded; the upsert,
    // the closure marker and the cursor did not move, so the next pass
    // re-detects the same diff and the ledger's INSERT-IGNORE re-apply is a
    // no-op while the failed writes simply retry.
    expect(mocks.applySolanaActivityWindow).toHaveBeenCalledTimes(1);
    expect(mocks.markAgentDirectoryEntriesClosed).not.toHaveBeenCalled();
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    );
  });

  it("runs the second pass without re-marking or re-eventing an already-acknowledged closure", async () => {
    // Pass two's prior state: the closure marker is set, and the chain pass
    // reports the same closed asset with no new closure event.
    mocks.listAgentDirectoryEntriesForSource.mockResolvedValue([
      { externalKey: ASSET_OPEN, displayName: "Open", registrant: OWNER_C, assetClosedAt: null },
      { externalKey: ASSET_CLOSED, displayName: "Closed", registrant: OWNER_C, assetClosedAt: new Date("2026-10-12T00:00:00Z") },
    ]);
    const passTwo = chainSnapshot({
      liveCount: 1,
      drafts: [{ externalKey: ASSET_OPEN, displayName: "Open", locatorHost: null, registrant: OWNER_C, sourceSignalNote: "note" }],
      events: [{ kind: "transfer", externalKey: ASSET_OPEN, transactionSignature: SIGNATURE, slot: 4242, fromOwner: OWNER_C, toOwner: OWNER_C }],
      closedAcknowledgedCount: 1,
    });
    mocks.fetchMetaplexChainState.mockResolvedValue(passTwo);

    await runApprovedMetaplexRegistrySource(scheduledSource, "scheduled", "activity");

    // The prior map must carry the closure marker into the adapter diff.
    const chainInput = mocks.fetchMetaplexChainState.mock.calls[0]![0]! as unknown as MockChainInput;
    expect(chainInput.prior.get(ASSET_CLOSED)!.closed).toBe(true);
    expect(chainInput.prior.get(ASSET_OPEN)!.closed).toBe(false);
    // No closure event, so nothing to mark: hide-once holds across passes.
    expect(mocks.markAgentDirectoryEntriesClosed).toHaveBeenCalledTimes(1);
    expect(mocks.markAgentDirectoryEntriesClosed.mock.calls[0]![0]!.externalKeys).toEqual([]);
    expect(mocks.applySolanaActivityWindow.mock.calls[0]![0]!.events).toEqual(passTwo.events);
  });

  it("writes API pilot acknowledgements insert-only so the chain pass stays the only name/owner writer", async () => {
    const registry: MockRegistrySnapshot = {
      discoveredCount: 1,
      rejectedCount: 0,
      pagesFetched: 1,
      observations: [{ candidate: { mintAddress: ASSET_OPEN }, observation: { canonicalLocator: "https://api.metaplex.com/x" } }],
      directory: [{ externalKey: ASSET_OPEN, displayName: "API name", locatorHost: "api.metaplex.com", sourceSignalNote: "ack" }],
    };
    mocks.fetchMetaplexRegistry.mockResolvedValue(registry);

    await runApprovedMetaplexRegistrySource(scheduledSource, "manual", "observe");

    expect(mocks.upsertAgentDirectoryEntries).toHaveBeenCalledTimes(1);
    const upsertInput = mocks.upsertAgentDirectoryEntries.mock.calls[0]![0]! as unknown as MockUpsertInput;
    expect(upsertInput.entries.map(entry => entry.externalKey)).toEqual([ASSET_OPEN]);
    expect(upsertInput.insertOnly).toBe(true);
    expect(upsertInput.preserveLocatorHost).toBeUndefined();
    expect(upsertInput.clearAssetClosed).toBeUndefined();
    expect(mocks.persistSolanaRegistryObservation).toHaveBeenCalledTimes(1);
    // The API pilot never advances the chain cursor or touches the ledger.
    expect(mocks.fetchMetaplexChainState).not.toHaveBeenCalled();
    expect(mocks.markAgentDirectoryEntriesClosed).not.toHaveBeenCalled();
    expect(mocks.applySolanaActivityWindow).not.toHaveBeenCalled();
  });

  it("re-persists the chain cursor on the observe pilot so an operator run never wipes it", async () => {
    const registry: MockRegistrySnapshot = {
      discoveredCount: 0,
      rejectedCount: 0,
      pagesFetched: 1,
      observations: [],
      directory: [],
    };
    mocks.fetchMetaplexRegistry.mockResolvedValue(registry);

    const result = await runApprovedMetaplexRegistrySource(scheduledSource, "manual", "observe");

    // The observe pilot shares this source row with the chain activity pass,
    // and finishIngestionRun writes the cursor unconditionally: handing it
    // null would wipe the persisted `sync2:` cursor and force a full re-seed
    // (silent adopt, zero diff events) on the next activity pass.
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", nextCursor: "sync2:455825921" })
    );
    expect(result.nextCursor).toBe("sync2:455825921");
  });

  it("keeps the unattended and replay guards", async () => {
    await expect(runApprovedMetaplexRegistrySource(scheduledSource, "replay", "activity")).rejects.toThrow(/rejected outright/);
    await expect(runApprovedMetaplexRegistrySource(scheduledSource, "scheduled", "observe")).rejects.toThrow(
      /execute the chain activity pass/
    );
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });
});
