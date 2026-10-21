import { balancedNewest } from "@shared/balancedNewest";
import { chainActivityEventLabel, formatRecordedAt, solanaActivityEventLabel, solanaRegistries, solanaRegistryLabel } from "@/lib/evidenceExplain";

/**
 * The arithmetic behind the Field Notes feed: which events show, which are newer than
 * the ones a paused reader is looking at, and the small labels around them. Pure, so
 * none of it needs a browser to test. The events are the ones `directoryActivityFeed`
 * returns (the ERC-8004 identity registry's measured mints, hand-outs, later changes
 * of hands and profile-link edits) or `directorySolanaActivity` returns (the three Solana
 * registries' registrations, owner or authority changes and profile edits), and nothing
 * else is ever added to the list.
 */
export type FeedEvent = {
  kind: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  fromAddress: string | null;
  toAddress: string | null;
  isHandout: boolean;
  entryId: string;
  displayName: string;
};

/** An event the Solana activity feed returns. The time is when the Owl's pass recorded it, a bound on when it happened. */
export type SolanaFeedEvent = {
  id: string;
  kind: string;
  slot: number;
  transactionSignature: string;
  recordedAt: string | Date;
  protocol: string;
  entryId: string;
  displayName: string;
};

/** How many registry events of a kind each Solana registry has recorded; a registry or kind with none is absent. */
export type SolanaTotal = { protocol: string; kind: string; count: number };

/** The chains the Field Reports can show. */
export type ReportChain = "robinhood" | "solana";

/** How many of the newest events the section shows. */
export const NOTES_LIMIT = 6;

/**
 * How many of each registry's newest events the Solana reports keep whatever else is newer: one, so that a pass that records
 * a hundred SAID registrations at once does not leave the 8004 and Metaplex registries out of the six lines. Robinhood Chain
 * has one registry, so nothing is kept first there.
 */
export function registryFloor(chain: ReportChain): number {
  return chain === "solana" ? 1 : 0;
}

/** One line of the Field Reports, whichever chain it came from. */
export type ReportNote = {
  key: string;
  /** The registry the event is from (its protocol), which is what the newest-first rule keeps one of each of. */
  group: string;
  /** What the registry recorded, in plain words. */
  label: string;
  tone: string;
  entryId: string;
  displayName: string;
  /** The line under the name: where the event is anchored. */
  meta: string;
  /** Where the event falls on its own chain, newest greatest: the block and log on Robinhood Chain, the recorded time and slot on Solana. */
  rank: readonly [number, number];
};

export const eventKey = (event: Pick<FeedEvent, "transactionHash" | "logIndex">) => `${event.transactionHash}:${event.logIndex}`;

/** The dot colour for an event: the same colours the What changed page gives the same events. */
export function noteTone(kind: string, isHandout: boolean): string {
  if (kind === "mint") return "#BFFF76";
  if (kind === "secondary") return isHandout ? "#66E8FF" : "#C3A6FF";
  return "#E8D8A0";
}

/** The dot colour for a Solana registry event, the same as the What changed page gives it. */
export function solanaNoteTone(kind: string): string {
  return kind === "register" ? "#BFFF76" : kind === "transfer" ? "#C3A6FF" : "#E8D8A0";
}

/** A transaction hash shortened for a line of text. */
export function shortHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 10)}…${hash.slice(-4)}`;
}

export function robinhoodNote(event: FeedEvent): ReportNote {
  return {
    key: eventKey(event),
    group: "erc8004",
    label: chainActivityEventLabel(event.kind, event.isHandout),
    tone: noteTone(event.kind, event.isHandout),
    entryId: event.entryId,
    displayName: event.displayName,
    meta: `block ${event.blockNumber.toLocaleString()} · ${shortHash(event.transactionHash)}`,
    rank: [event.blockNumber, event.logIndex],
  };
}

export function solanaNote(event: SolanaFeedEvent): ReportNote {
  const recordedAt = new Date(event.recordedAt).getTime();
  return {
    key: event.id,
    group: event.protocol,
    label: solanaActivityEventLabel(event.kind, event.protocol),
    tone: solanaNoteTone(event.kind),
    entryId: event.entryId,
    displayName: event.displayName,
    meta: `${solanaRegistryLabel(event.protocol)} · recorded ${formatRecordedAt(event.recordedAt)} · slot ${event.slot.toLocaleString()} · ${shortHash(event.transactionSignature)}`,
    rank: [Number.isNaN(recordedAt) ? 0 : recordedAt, event.slot],
  };
}

/** Whether `a` came after `b` on its chain: a later block (or time), or the same one and a later log (or slot). */
const isNewer = (a: ReportNote, b: ReportNote) => a.rank[0] > b.rank[0] || (a.rank[0] === b.rank[0] && a.rank[1] > b.rank[1]);

/**
 * The newest events, newest first, at most `limit`, with each registry's newest `floor` events in whatever else is newer. The
 * feed arrives in that order; this does not trust it.
 */
export function newestNotes(feed: readonly ReportNote[], limit = NOTES_LIMIT, floor = 0): ReportNote[] {
  return balancedNewest(feed, { limit, floor, group: note => note.group, compare: (a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0) });
}

/** How many events in the live feed are newer than the newest one a paused reader is looking at. With nothing frozen, all of them. */
export function newerSince(frozen: readonly ReportNote[], live: readonly ReportNote[]): number {
  const top = newestNotes(frozen, 1)[0];
  if (!top) return live.length;
  return live.filter(event => isNewer(event, top)).length;
}

/** The stamp on the feed: the ledger's high-water block, or an honest "not measured yet". */
export function asOfLabel(block: number | null): string {
  return block === null ? "not measured yet" : `as of block ${block.toLocaleString()}`;
}

/** How many events each Solana registry has recorded, as one line, or null when the totals have not been read. A registry with none says so, never a zero. */
export function solanaTotalsLine(totals: readonly SolanaTotal[] | undefined): string | null {
  if (!totals) return null;
  const counts = solanaRegistries.map(registry => {
    const count = totals.filter(total => total.protocol === registry.protocol).reduce((sum, total) => sum + total.count, 0);
    return `${registry.label} ${count > 0 ? count.toLocaleString("en-US") : "none yet"}`;
  });
  return `Events recorded so far: ${counts.join(" · ")}.`;
}
