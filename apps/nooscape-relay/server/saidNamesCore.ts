import type { DirectoryEntryDraft } from "./ingestion/types";
import { classifyRegistrationUri, ipfsLinkHasCid, type RegistrationUriKind } from "./ingestion/registrationFetch";
import { sanitizePublicText } from "./publicText";
import { entryNameNote, NAME_URI_MAX_CHARS, SHOWN_NAME_MAX_CHARS, uriHashOf } from "./robinhoodNamesCore";

/**
 * The pure rules of the SAID name reads (docs/approvals/2026-10-18-said-names.md). An identity in the SAID registry on Solana
 * carries no name on the chain, only a metadata link, so its directory entry is called "SAID agent <first 8 of the owner
 * wallet>". The link names a small card the registrant publishes (its first field is `name`), and the step reads those cards a few
 * at a time, through the same safe fetch and manners as the other name reads, and keeps each answer in
 * `agent_registration_resolutions`, the table the 8004 and Robinhood readers use.
 *
 * The SAID pass rewrites every entry's name every hour (it upserts every identity), so a name written onto an entry would be gone
 * within the hour. The pass therefore lays the names that were read over its drafts before it writes them (`applySaidNames`), by
 * the hash of the link the entry carries now: an identity that changes its link has no name until the new link is read.
 * Nothing here touches the network or the database.
 */

/** A directory entry's name is still the placeholder when it matches this (MySQL REGEXP and JavaScript alike): `placeholderSaidName` in ingestion/saidChain.ts, whose owner part is base58. */
export const SAID_PLACEHOLDER_PATTERN = "^SAID agent [1-9A-HJ-NP-Za-km-z]{8}$";

/** An identity's link, as the pass reads it from the chain. */
export type SaidNameLink = { externalKey: string; uri: string; createdAtSeconds: number };

/** A link to queue for reading. `rank` is its place in the newest-first order, 0 for the newest. */
type SaidQueueRow = { externalKey: string; uriHash: string; uriKind: RegistrationUriKind; uri: string; rank: number };

/** MySQL's TIMESTAMP starts one second after the epoch. A link queued but not yet tried is dated from there. */
const NOT_TRIED_YET_MS = 1000;

/**
 * When a queued link is dated, so that the newest identities are read first without a column for it: the step reads the links
 * whose last try is oldest first, and a link that was never tried is dated one second after the epoch plus its place in the
 * newest-first order. The newest registrations are the ones the home page shows.
 */
export const queuedAt = (rank: number) => new Date(NOT_TRIED_YET_MS + Math.max(0, rank) * 1000);

/** Whether a link is one the name reader can ask: an https address, or an ipfs address with a CID, that fits the table's column. */
export function readableLink(uri: string): RegistrationUriKind | null {
  if (uri.length === 0 || uri.length > NAME_URI_MAX_CHARS) return null;
  const kind = classifyRegistrationUri(uri);
  if (kind === "web") return uri.startsWith("https://") ? "web" : null;
  if (kind === "ipfs") return ipfsLinkHasCid(uri) ? "ipfs" : null;
  return null;
}

/**
 * The links to queue: those the reader can ask, that no earlier pass queued (`known` holds the hash of each), newest identity first,
 * one for each distinct link (identities that share a link share the name, which is written to each by the hash).
 */
export function saidLinksToQueue(links: readonly SaidNameLink[], known: ReadonlySet<string>): SaidQueueRow[] {
  const newestFirst = [...links].sort((a, b) => b.createdAtSeconds - a.createdAtSeconds || (a.externalKey < b.externalKey ? -1 : a.externalKey > b.externalKey ? 1 : 0));
  const seen = new Set<string>();
  const rows: SaidQueueRow[] = [];
  for (const link of newestFirst) {
    const kind = readableLink(link.uri);
    if (kind === null) continue;
    const uriHash = uriHashOf(link.uri);
    if (known.has(uriHash) || seen.has(uriHash)) continue;
    seen.add(uriHash);
    rows.push({ externalKey: link.externalKey, uriHash, uriKind: kind, uri: link.uri, rank: rows.length });
  }
  return rows;
}

/** A name that was read from a link, and the day it was read (`YYYY-MM-DD`). */
export type SaidResolvedName = { name: string; readOn: string };

/**
 * Lays the names that were read over the placeholders of the pass's drafts, by the hash of each draft's link, and adds the sentence
 * that says where the name came from and when. A draft whose link has no name, or whose name cleans to nothing, is returned as it
 * was. The drafts it is given are not changed.
 */
export function applySaidNames(drafts: readonly DirectoryEntryDraft[], resolved: ReadonlyMap<string, SaidResolvedName>): DirectoryEntryDraft[] {
  if (resolved.size === 0) return drafts.slice();
  return drafts.map(draft => {
    const found = draft.profileUriHash ? resolved.get(draft.profileUriHash) : undefined;
    const name = found ? sanitizePublicText(found.name, SHOWN_NAME_MAX_CHARS) : null;
    if (!found || name === null) return draft;
    return { ...draft, displayName: name, sourceSignalNote: `${draft.sourceSignalNote}${entryNameNote(found.readOn)}`.slice(0, 512) };
  });
}
