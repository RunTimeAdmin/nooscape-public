import { describe, expect, it } from "vitest";
import { chainActivityEventLabel } from "@/lib/evidenceExplain";
import {
  asOfLabel,
  eventKey,
  newerSince,
  newestNotes,
  noteTone,
  NOTES_LIMIT,
  registryFloor,
  robinhoodNote,
  shortHash,
  solanaNote,
  solanaNoteTone,
  solanaTotalsLine,
  type FeedEvent,
  type SolanaFeedEvent,
} from "./fieldNotesModel";

const event = (blockNumber: number, logIndex = 0, kind = "mint", isHandout = false): FeedEvent => ({
  kind,
  blockNumber,
  transactionHash: `0x${blockNumber.toString(16).padStart(8, "0")}${"a".repeat(56)}`,
  logIndex,
  fromAddress: null,
  toAddress: null,
  isHandout,
  entryId: `entry-${blockNumber}-${logIndex}`,
  displayName: `Agent ${blockNumber}`,
});

const solanaEvent = (minutes: number, slot = 1_000, over: Partial<SolanaFeedEvent> = {}): SolanaFeedEvent => ({
  id: `sol-${minutes}-${slot}`,
  kind: "register",
  slot,
  transactionSignature: `sig${"B".repeat(84)}`,
  recordedAt: new Date(Date.UTC(2026, 9, 18, 8, minutes)).toISOString(),
  protocol: "solana_said",
  entryId: `entry-sol-${minutes}`,
  displayName: `Solana ${minutes}`,
  ...over,
});

const robinhood = (...events: FeedEvent[]) => events.map(robinhoodNote);

describe("newestNotes", () => {
  it("puts the newest first, ordering by block and then by log, and trusts nothing about the order it was given", () => {
    const shuffled = robinhood(event(10), event(12, 1), event(12, 3), event(11), event(12, 2));
    expect(newestNotes(shuffled).map(note => note.rank)).toEqual([[12, 3], [12, 2], [12, 1], [11, 0], [10, 0]]);
  });

  it("shows at most the limit, and everything when there are fewer", () => {
    const many = Array.from({ length: 40 }, (_, index) => robinhoodNote(event(index + 1)));
    expect(newestNotes(many)).toHaveLength(NOTES_LIMIT);
    expect(newestNotes(many)[0]!.rank[0]).toBe(40);
    expect(newestNotes(many, 3)).toHaveLength(3);
    expect(newestNotes(robinhood(event(1)))).toHaveLength(1);
    expect(newestNotes([])).toEqual([]);
  });

  it("does not change the feed it was given", () => {
    const feed = robinhood(event(1), event(2));
    newestNotes(feed);
    expect(feed.map(note => note.rank[0])).toEqual([1, 2]);
  });

  it("keeps each registry's newest event in the Solana six when one registry's batch is newer than the rest, and still sorts newest first", () => {
    // One pass recorded eight SAID registrations; the 8004 and Metaplex events are older than all of them.
    const batch = Array.from({ length: 8 }, (_, index) => solanaEvent(50 - index, 1_000 + index));
    const quiet = [solanaEvent(5, 900, { protocol: "solana_8004" }), solanaEvent(3, 800, { protocol: "solana_registry" })];
    const notes = [...quiet, ...batch].map(solanaNote);
    expect(newestNotes(notes, 6, 0).map(note => note.group)).toEqual(Array(6).fill("solana_said"));
    const balanced = newestNotes(notes, 6, registryFloor("solana"));
    expect(balanced.map(note => note.group)).toEqual(["solana_said", "solana_said", "solana_said", "solana_said", "solana_8004", "solana_registry"]);
    expect(balanced.map(note => note.rank[0])).toEqual([...balanced.map(note => note.rank[0])].sort((a, b) => b - a));
    // The newest event overall is always shown, so a paused reader's "newer events waiting" count still starts from it.
    expect(balanced[0]!.key).toBe(solanaNote(batch[0]!).key);
  });

  it("keeps one of every registry first on Solana and nothing first on Robinhood Chain, which has one registry", () => {
    expect(registryFloor("solana")).toBe(1);
    expect(registryFloor("robinhood")).toBe(0);
    expect(robinhoodNote(event(5)).group).toBe("erc8004");
    expect(solanaNote(solanaEvent(1, 1, { protocol: "solana_8004" })).group).toBe("solana_8004");
  });

  it("orders Solana events by when the pass recorded them and then by slot", () => {
    const shuffled = [solanaEvent(5, 10), solanaEvent(7, 3), solanaEvent(7, 9), solanaEvent(6, 99)].map(solanaNote);
    expect(newestNotes(shuffled).map(note => note.key)).toEqual(["sol-7-9", "sol-7-3", "sol-6-99", "sol-5-10"]);
  });
});

describe("newerSince", () => {
  const frozen = robinhood(event(20), event(19), event(18));

  it("counts the events newer than the newest one the reader is looking at", () => {
    expect(newerSince(frozen, robinhood(event(23), event(22), event(21), event(20), event(19)))).toBe(3);
    expect(newerSince(frozen, robinhood(event(20), event(19)))).toBe(0);
  });

  it("counts a later log in the same block as newer", () => {
    expect(newerSince(robinhood(event(20, 1)), robinhood(event(20, 2), event(20, 1)))).toBe(1);
  });

  it("counts everything as new when nothing was showing", () => {
    expect(newerSince([], robinhood(event(1), event(2)))).toBe(2);
    expect(newerSince([], [])).toBe(0);
  });

  it("counts a Solana event recorded later, or in a later slot of the same minute, as newer", () => {
    const shown = [solanaNote(solanaEvent(10, 50))];
    expect(newerSince(shown, [11, 12].map(minutes => solanaNote(solanaEvent(minutes))).concat(shown))).toBe(2);
    expect(newerSince(shown, [solanaNote(solanaEvent(10, 51)), ...shown])).toBe(1);
    expect(newerSince(shown, [solanaNote(solanaEvent(9, 900)), ...shown])).toBe(0);
  });
});

describe("a Robinhood note", () => {
  it("words the event as the ledger recorded it, anchored by block and transaction", () => {
    const note = robinhoodNote(event(5, 2, "secondary", true));
    expect(note.label).toBe(chainActivityEventLabel("secondary", true));
    expect(note.label).not.toBe(chainActivityEventLabel("secondary", false));
    expect(note.tone).toBe("#66E8FF");
    expect(note.meta).toBe("block 5 · 0x00000005…aaaa");
    expect(note.entryId).toBe("entry-5-2");
    expect(note.displayName).toBe("Agent 5");
  });

  it("keys an event by its transaction and log, so a repeat poll is the same event", () => {
    expect(robinhoodNote(event(5, 2)).key).toBe(robinhoodNote({ ...event(5, 2), displayName: "renamed" }).key);
    expect(robinhoodNote(event(5, 2)).key).not.toBe(robinhoodNote(event(5, 3)).key);
  });
});

describe("a Solana note", () => {
  it("words the event as the registry recorded it, naming the registry and the pass's time and slot", () => {
    const note = solanaNote(solanaEvent(5, 321_000, { kind: "transfer", protocol: "solana_said" }));
    expect(note.label).toBe("Authority handed to another wallet");
    expect(note.tone).toBe("#C3A6FF");
    expect(note.meta).toBe("SAID · recorded 2026-10-18 08:05 UTC · slot 321,000 · sigBBBBBBB…BBBB");
    expect(note.entryId).toBe("entry-sol-5");
    expect(note.displayName).toBe("Solana 5");
    expect(note.key).toBe("sol-5-321000");
  });

  it("calls a transfer on the other registries a change of owner, never a sale", () => {
    expect(solanaNote(solanaEvent(1, 1, { kind: "transfer", protocol: "solana_8004" })).label).toBe("Changed owner");
    expect(solanaNote(solanaEvent(1, 1, { kind: "transfer", protocol: "solana_registry" })).label).toBe("Changed owner");
    expect(solanaNote(solanaEvent(1, 1, { kind: "profile_update" })).label).toBe("Profile edited");
  });

  it("takes a time the browser cannot read as the oldest, without throwing", () => {
    const note = solanaNote(solanaEvent(1, 7, { recordedAt: "not a time" }));
    expect(note.rank).toEqual([0, 7]);
    expect(note.meta).toContain("time unavailable");
  });

  it("accepts the time as a Date, which is what the server's transport hands over", () => {
    expect(solanaNote(solanaEvent(3, 1, { recordedAt: new Date(Date.UTC(2026, 9, 18, 8, 3)) })).meta).toContain("recorded 2026-10-18 08:03 UTC");
  });

  it("colours the kinds as the What changed page does, and a kind it does not know in the neutral colour", () => {
    expect(solanaNoteTone("register")).toBe("#BFFF76");
    expect(solanaNoteTone("transfer")).toBe("#C3A6FF");
    expect(solanaNoteTone("profile_update")).toBe("#E8D8A0");
    expect(solanaNoteTone("something new")).toBe("#E8D8A0");
  });
});

describe("the Solana totals line", () => {
  it("counts each registry's events over every kind, and says none yet where a registry has none", () => {
    const totals = [
      { protocol: "solana_said", kind: "register", count: 1_200 },
      { protocol: "solana_said", kind: "transfer", count: 34 },
      { protocol: "solana_8004", kind: "register", count: 7 },
    ];
    expect(solanaTotalsLine(totals)).toBe("Events recorded so far: SAID 1,234 · 8004 7 · Metaplex none yet.");
  });

  it("says nothing before the totals have been read, and names every registry when none has an event", () => {
    expect(solanaTotalsLine(undefined)).toBeNull();
    expect(solanaTotalsLine([])).toBe("Events recorded so far: SAID none yet · 8004 none yet · Metaplex none yet.");
  });
});

describe("labels", () => {
  it("colours each kind as the What changed page does, and a hand-out differently from a later change of hands", () => {
    expect(noteTone("mint", false)).toBe("#BFFF76");
    expect(noteTone("secondary", true)).toBe("#66E8FF");
    expect(noteTone("secondary", false)).toBe("#C3A6FF");
    expect(noteTone("uri_update", false)).toBe("#E8D8A0");
    expect(noteTone("something new", false)).toBe("#E8D8A0");
  });

  it("keys an event by its transaction and log", () => {
    expect(eventKey(event(5, 2))).toBe(`${event(5, 2).transactionHash}:2`);
  });

  it("shortens a hash and leaves a short one alone", () => {
    expect(shortHash(`0x${"1".repeat(64)}`)).toBe("0x11111111…1111");
    expect(shortHash("0xabc")).toBe("0xabc");
  });

  it("stamps the feed with its block, or says it is not measured, and never a made-up block", () => {
    expect(asOfLabel(12_345_678)).toBe("as of block 12,345,678");
    expect(asOfLabel(null)).toBe("not measured yet");
  });
});
