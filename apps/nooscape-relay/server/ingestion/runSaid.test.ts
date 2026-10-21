import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestionSource } from "../../drizzle/schema";

/**
 * Runner wiring tests for the SAID identity pass: the unattended/identity
 * guards fire before any run row is written, the activity ledger is written
 * BEFORE the directory upsert (so a failure between them re-detects instead of
 * losing an event), the `said:` cursor persists only after the whole snapshot
 * succeeds, the pass owns locatorHost (the metadata URI is a chain read), and a
 * failure leaves the cursor and the directory untouched. The adapter and pass
 * logic are covered in saidChain.test.ts, saidActivity.test.ts and
 * saidPass.test.ts; here the db layer and the pass are mocked so every write
 * call is asserted exactly.
 */
const order: string[] = [];

const mocks = vi.hoisted(() => ({
  beginIngestionRun: vi.fn(async (_source: unknown, _trigger: string) => "run-1"),
  finishIngestionRun: vi.fn(async (_input: unknown) => {}),
  listAgentDirectoryEntriesForSource: vi.fn(async (_sourceId: string): Promise<Array<{ externalKey: string; registrant: string | null; profileUriHash: string | null }>> => []),
  upsertAgentDirectoryEntries: vi.fn(async (_input: unknown) => 0),
  applySolanaActivityWindow: vi.fn(async (_input: unknown) => ({ acknowledgedCount: 0 })),
  fetchSaidPass: vi.fn(async (_input: unknown) => ({})),
  readSaidResolvedNames: vi.fn(async (_sourceId: string): Promise<Map<string, { name: string; readOn: string }>> => new Map()),
  queueSaidNameLinks: vi.fn(async (_source: unknown, _links: unknown) => 0),
}));

vi.mock("../db", () => ({
  beginIngestionRun: mocks.beginIngestionRun,
  finishIngestionRun: mocks.finishIngestionRun,
  listAgentDirectoryEntriesForSource: mocks.listAgentDirectoryEntriesForSource,
  upsertAgentDirectoryEntries: mocks.upsertAgentDirectoryEntries,
  applySolanaActivityWindow: mocks.applySolanaActivityWindow,
}));

vi.mock("./saidChain", () => ({
  SAID_CHAIN_SOURCE_KEY: "solana-said-agent-registry",
  isSaidChainSeedCursor: (cursor: string | null) => !(cursor !== null && cursor.startsWith("said:")),
}));

vi.mock("./saidPass", () => ({ fetchSaidPass: mocks.fetchSaidPass }));

// The name step's database reads and writes; the rule that lays names over drafts (../saidNamesCore) is the real one.
vi.mock("../saidNames", () => ({ readSaidResolvedNames: mocks.readSaidResolvedNames, queueSaidNameLinks: mocks.queueSaidNameLinks }));

import { runApprovedSaidSource } from "./runSaid";

const OWNER_A = "A".repeat(44);
const OWNER_B = "B".repeat(44);

const baseSource = {
  id: "source-said",
  protocol: "solana_said",
  sourceKey: "solana-said-agent-registry",
  state: "active",
  cursor: null as string | null,
  executionPolicy: "manual_only",
  scheduleMinutes: 60,
};
const source = (overrides: Record<string, unknown> = {}) => ({ ...baseSource, ...overrides }) as unknown as IngestionSource;

const draft = (externalKey: string) => ({
  externalKey,
  displayName: `SAID agent ${externalKey.slice(0, 8)}`,
  locatorHost: "api.saidprotocol.com",
  registrant: externalKey,
  accountPubkey: "P".repeat(44),
  profileUriHash: "h",
  sourceSignalNote: "note",
});

const event = (externalKey: string) => ({ kind: "register" as const, externalKey, transactionSignature: "s".repeat(88), slot: 4242, fromOwner: null, toOwner: externalKey });

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    slot: 4242,
    requestCount: 2,
    enumeratedCount: 2,
    drafts: [draft(OWNER_A), draft(OWNER_B)],
    links: [
      { externalKey: OWNER_A, uri: `https://api.saidprotocol.com/api/cards/${OWNER_A}.json`, createdAtSeconds: 1_780_000_000 },
      { externalKey: OWNER_B, uri: `https://api.saidprotocol.com/api/cards/${OWNER_B}.json`, createdAtSeconds: 1_780_000_100 },
    ],
    events: [],
    layoutCounts: { v1: 0, v2: 0, v3: 2 },
    tailResidueCount: 0,
    vanishedCount: 0,
    unanchoredCount: 0,
    deferredCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  mocks.listAgentDirectoryEntriesForSource.mockResolvedValue([]);
  mocks.readSaidResolvedNames.mockResolvedValue(new Map());
  mocks.queueSaidNameLinks.mockResolvedValue(0);
  mocks.fetchSaidPass.mockResolvedValue(snapshot());
  mocks.applySolanaActivityWindow.mockImplementation(async () => {
    order.push("ledger");
    return { acknowledgedCount: 0 };
  });
  mocks.upsertAgentDirectoryEntries.mockImplementation(async () => {
    order.push("directory");
    return 0;
  });
});

describe("runApprovedSaidSource guards", () => {
  it("rejects replays outright, before any run row is written", async () => {
    await expect(runApprovedSaidSource(source(), "replay")).rejects.toThrow(/replays are rejected outright/);
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });

  it("rejects an unattended run from a source not handed to the scheduler", async () => {
    await expect(runApprovedSaidSource(source({ executionPolicy: "manual_only" }), "scheduled")).rejects.toThrow(/require the scheduled execution policy/);
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });

  it("accepts an unattended run once the source holds the scheduled policy", async () => {
    await runApprovedSaidSource(source({ executionPolicy: "scheduled", cursor: "said:1" }), "scheduled");
    expect(mocks.beginIngestionRun).toHaveBeenCalledWith(expect.anything(), "scheduled");
  });

  it("refuses any source that is not the approved SAID registry", async () => {
    await expect(runApprovedSaidSource(source({ sourceKey: "something-else" }), "manual")).rejects.toThrow(/approved for the SAID Solana agent registry only/);
    await expect(runApprovedSaidSource(source({ protocol: "solana_8004" }), "manual")).rejects.toThrow(/approved for the SAID Solana agent registry only/);
    expect(mocks.beginIngestionRun).not.toHaveBeenCalled();
  });
});

describe("runApprovedSaidSource run", () => {
  it("seeds when no said: cursor exists and persists said:<slot>", async () => {
    const result = await runApprovedSaidSource(source({ cursor: null }), "manual");
    const input = mocks.fetchSaidPass.mock.calls[0]![0] as { seed: boolean; prior: Map<string, unknown> };
    expect(input.seed).toBe(true);
    expect(input.prior.size).toBe(0);
    const upsert = mocks.upsertAgentDirectoryEntries.mock.calls[0]![0] as { runId: string; entries: Array<{ externalKey: string }>; preserveLocatorHost?: boolean; insertOnly?: boolean };
    expect(upsert.runId).toBe("run-1");
    expect(upsert.entries.map(entry => entry.externalKey)).toEqual([OWNER_A, OWNER_B]);
    // This pass owns locatorHost and refreshes existing rows.
    expect(upsert.preserveLocatorHost).toBeUndefined();
    expect(upsert.insertOnly).toBeUndefined();
    expect(result).toEqual({ requestCount: 2, discoveredCount: 2, acceptedCount: 2, rejectedCount: 0, nextCursor: "said:4242" });
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", nextCursor: "said:4242" }));
  });

  it("hands the pass each prior row's registrant and metadata hash once a said: cursor exists", async () => {
    mocks.listAgentDirectoryEntriesForSource.mockResolvedValue([
      { externalKey: OWNER_A, registrant: OWNER_A, profileUriHash: "hash-a" },
      { externalKey: OWNER_B, registrant: null, profileUriHash: null },
    ]);
    await runApprovedSaidSource(source({ cursor: "said:100" }), "manual");
    const input = mocks.fetchSaidPass.mock.calls[0]![0] as { seed: boolean; prior: Map<string, { registrant: string | null; profileUriHash: string | null }> };
    expect(input.seed).toBe(false);
    expect(input.prior.get(OWNER_A)).toEqual({ registrant: OWNER_A, profileUriHash: "hash-a" });
    expect(input.prior.get(OWNER_B)).toEqual({ registrant: null, profileUriHash: null });
  });

  it("writes the activity ledger BEFORE the directory upsert, and acknowledges the pass's events", async () => {
    mocks.fetchSaidPass.mockResolvedValue(snapshot({ events: [event(OWNER_A)] }));
    await runApprovedSaidSource(source({ cursor: "said:100" }), "manual");
    expect(order).toEqual(["ledger", "directory"]);
    const ledger = mocks.applySolanaActivityWindow.mock.calls[0]![0] as { events: Array<{ externalKey: string; kind: string }> };
    expect(ledger.events).toEqual([expect.objectContaining({ externalKey: OWNER_A, kind: "register" })]);
  });

  it("reports missing and unanchored identities as exceptions in rejectedCount, and logs the breakdown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.fetchSaidPass.mockResolvedValue(snapshot({ vanishedCount: 1, unanchoredCount: 2, deferredCount: 3 }));
    const result = await runApprovedSaidSource(source({ cursor: "said:100" }), "manual");
    expect(result.rejectedCount).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/2 change\(s\) recorded without a ledger anchor, 3 identity\(ies\) deferred.*1 previously acknowledged/);
    warn.mockRestore();
  });

  it("stays quiet when there is nothing to report", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runApprovedSaidSource(source({ cursor: "said:100" }), "manual");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("writes nothing and leaves the cursor untouched when the pass fails", async () => {
    mocks.fetchSaidPass.mockRejectedValue(new Error("enumeration under the floor"));
    await expect(runApprovedSaidSource(source({ cursor: "said:100" }), "manual")).rejects.toThrow(/under the floor/);
    expect(mocks.applySolanaActivityWindow).not.toHaveBeenCalled();
    expect(mocks.upsertAgentDirectoryEntries).not.toHaveBeenCalled();
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", nextCursor: "said:100", counts: expect.objectContaining({ requestCount: 2, rejectedCount: 1 }) })
    );
  });

  it("lays the names the name step read over the drafts before it upserts them, so the hourly rewrite does not undo them", async () => {
    mocks.readSaidResolvedNames.mockResolvedValue(new Map([["h", { name: "Kirby", readOn: "2026-10-18" }]]));
    await runApprovedSaidSource(source({ cursor: "said:100" }), "manual");
    expect(mocks.readSaidResolvedNames).toHaveBeenCalledWith("source-said");
    const upsert = mocks.upsertAgentDirectoryEntries.mock.calls[0]![0] as { entries: Array<{ externalKey: string; displayName: string; sourceSignalNote: string; profileUriHash: string }> };
    // Both drafts carry the hash "h", so both are named from it; everything else of the draft is the pass's.
    expect(upsert.entries.map(entry => entry.displayName)).toEqual(["Kirby", "Kirby"]);
    expect(upsert.entries[0]!.sourceSignalNote).toBe("note Its name was read from its registration link on 2026-10-18; it is the registrant's own claim.");
    expect(upsert.entries.map(entry => entry.externalKey)).toEqual([OWNER_A, OWNER_B]);
  });

  it("upserts the drafts as the pass built them when no name has been read", async () => {
    await runApprovedSaidSource(source({ cursor: "said:100" }), "manual");
    const upsert = mocks.upsertAgentDirectoryEntries.mock.calls[0]![0] as { entries: Array<{ displayName: string; sourceSignalNote: string }> };
    expect(upsert.entries.map(entry => entry.displayName)).toEqual([`SAID agent ${OWNER_A.slice(0, 8)}`, `SAID agent ${OWNER_B.slice(0, 8)}`]);
    expect(upsert.entries.every(entry => entry.sourceSignalNote === "note")).toBe(true);
  });

  it("queues the links of the identities it read for the name step, after the directory write", async () => {
    mocks.queueSaidNameLinks.mockImplementation(async () => {
      order.push("queue");
      return 2;
    });
    await runApprovedSaidSource(source({ cursor: "said:100" }), "manual");
    expect(order).toEqual(["ledger", "directory", "queue"]);
    expect(mocks.queueSaidNameLinks).toHaveBeenCalledWith(expect.objectContaining({ id: "source-said" }), snapshot().links);
  });

  it("does not fail the pass when its links cannot be queued: the directory is written and the cursor persists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.queueSaidNameLinks.mockRejectedValueOnce(new Error("queue down\nsecond line"));
    const result = await runApprovedSaidSource(source({ cursor: "said:100" }), "manual");
    expect(result.nextCursor).toBe("said:4242");
    expect(mocks.upsertAgentDirectoryEntries).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("the links for the name step could not be queued: queue down second line");
    warn.mockRestore();
  });

  it("writes no directory row and keeps the cursor when the names cannot be read, rather than reset every name to the placeholder", async () => {
    mocks.readSaidResolvedNames.mockRejectedValueOnce(new Error("db down"));
    await expect(runApprovedSaidSource(source({ cursor: "said:100" }), "manual")).rejects.toThrow(/db down/);
    expect(mocks.upsertAgentDirectoryEntries).not.toHaveBeenCalled();
    expect(mocks.queueSaidNameLinks).not.toHaveBeenCalled();
    expect(mocks.finishIngestionRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", nextCursor: "said:100" }));
  });

  it("records a failed run with the prior cursor when the directory write fails after the ledger write, so the next pass re-detects", async () => {
    mocks.fetchSaidPass.mockResolvedValue(snapshot({ events: [event(OWNER_A)] }));
    mocks.upsertAgentDirectoryEntries.mockRejectedValueOnce(new Error("db down"));
    await expect(runApprovedSaidSource(source({ cursor: "said:100" }), "manual")).rejects.toThrow(/db down/);
    expect(mocks.applySolanaActivityWindow).toHaveBeenCalledTimes(1);
    const finish = mocks.finishIngestionRun.mock.calls[0]![0] as { status: string; nextCursor: string | null };
    expect(finish.status).toBe("failed");
    expect(finish.nextCursor).toBe("said:100");
  });
});
