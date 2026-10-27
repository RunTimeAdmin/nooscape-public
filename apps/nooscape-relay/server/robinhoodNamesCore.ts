import { createHash } from "node:crypto";
import { sanitizePublicText } from "./publicText";
import { classifyRegistrationUri, ipfsLinkHasCid, type RegistrationUriKind } from "./ingestion/registrationFetch";
import { classifyAgentUri, extractInlineRegistration } from "./ingestion/robinhood";

/**
 * The pure rules of the Robinhood name reads (docs/approvals/2026-10-17-robinhood-names.md). A reviewed record of the
 * Robinhood Chain ERC-8004 registry that carries no name of its own is called "Agent #<n>", and its public summary says which
 * registration link was recorded for it. This finds those records, says which link to read, and lays a name that was read from
 * the link over the placeholder when the record is served. Nothing here touches the network or the database.
 *
 * The retained observation, the evidence packet and the record's handle are not changed: a read name is a self-asserted fact
 * about where the registrant says the agent is, kept beside the record with its date, and shown only where the record has
 * nothing but a number.
 */

export const ROBINHOOD_SOURCE_KEY = "robinhood-erc8004-identity-registry";
/** The externalKey of a Robinhood registration: chain, registry and agent id (`ROBINHOOD_IDENTITY_REGISTRY` in ingestion/robinhood.ts, which a test holds this to). */
export const ROBINHOOD_EXTERNAL_PREFIX = "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:";
/** The registration links the resolutions table can hold (its `uri` column is 512 characters). */
export const NAME_URI_MAX_CHARS = 512;
/** A name that was read is cleaned and cut to this before it is shown. */
export const SHOWN_NAME_MAX_CHARS = 120;

const PLACEHOLDER_NAME = /^Agent #(\d{1,9})$/;
const REGISTERED_SENTENCE = /^Registered as agent (\d{1,9}) in the Robinhood Chain ERC-8004 identity registry/;
const LINK_SENTENCE = /Registry-recorded URI at registration: (\S+)/;

export type NameableRecord = {
  agentId: string;
  /** The registration's key in the directory and in the resolutions table. */
  externalKey: string;
  uri: string;
  kind: RegistrationUriKind;
  /** SHA-256 hex of the full link: the resolutions table's key, as the Solana pass makes it. */
  uriHash: string;
};

export const uriHashOf = (uri: string) => createHash("sha256").update(uri).digest("hex");

/**
 * The link to read for a served record, or null when there is nothing to read: the record has a name of its own, is not a
 * Robinhood registration, has no recorded link, or the link is not an https address or an ipfs address with a CID in it.
 */
export function nameableRecord(record: { agentId: string; displayName: string; untrustedSummary: string | null }): NameableRecord | null {
  if (!record.untrustedSummary) return null;
  const placeholder = PLACEHOLDER_NAME.exec(record.displayName);
  if (!placeholder) return null;
  const registered = REGISTERED_SENTENCE.exec(record.untrustedSummary);
  // The number in the placeholder is the agent id the summary names, so a record cannot borrow another's link.
  if (!registered || registered[1] !== placeholder[1]) return null;
  const link = LINK_SENTENCE.exec(record.untrustedSummary);
  if (!link) return null;
  const uri = link[1]!;
  if (uri.length > NAME_URI_MAX_CHARS) return null;
  const kind = classifyRegistrationUri(uri);
  if (kind === null) return null;
  if (kind === "web" && !uri.startsWith("https://")) return null;
  if (kind === "ipfs" && !ipfsLinkHasCid(uri)) return null;
  return { agentId: record.agentId, externalKey: `${ROBINHOOD_EXTERNAL_PREFIX}${registered[1]}`, uri, kind, uriHash: uriHashOf(uri) };
}

/** What a stored attempt says, for choosing the next ones. */
export type PriorAttempt = { status: "resolved" | "no_name" | "failed"; attempts: number; lastAttemptAt: Date };

/** A failed or empty read is tried again no sooner than this after the last try, so five tries span a day and a bad hour is not a verdict. */
export const NAME_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

type NameAttemptLimits = { failed: number; noName: number };

/**
 * The records to read this run, in agent order and at most `limit`: those never tried, and those whose last try is old enough
 * and whose tries are not used up. A resolved link is never read again.
 */
export function namesToRead(
  candidates: readonly NameableRecord[],
  priors: ReadonlyMap<string, PriorAttempt>,
  now: number,
  limit: number,
  limits: NameAttemptLimits
): NameableRecord[] {
  const byAgent = (a: NameableRecord, b: NameableRecord) => {
    const x = a.externalKey.split(":").pop() ?? "";
    const y = b.externalKey.split(":").pop() ?? "";
    return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
  };
  return candidates
    .filter(candidate => {
      const prior = priors.get(candidate.uriHash);
      if (!prior) return true;
      if (prior.status === "resolved") return false;
      const cap = prior.status === "failed" ? limits.failed : limits.noName;
      return prior.attempts < cap && now - prior.lastAttemptAt.getTime() >= NAME_RETRY_AFTER_MS;
    })
    .sort(byAgent)
    .slice(0, Math.max(0, limit));
}

/** A name that was read, and when (an ISO date; null when the time was not recorded). */
export type ResolvedName = { name: string; readAt: string | null };

/**
 * Lays the names that were read over the placeholders of served records, by the hash of each record's link. A record that has a
 * name of its own, a link with no resolved name, or a name that cleans to nothing is returned as it was. A record that gets a name
 * also gets `nameReadAt`, the day it was read, so a page can say where the name came from; no other record has the field.
 */
export function overlayResolvedNames<T extends { agentId: string; displayName: string; untrustedSummary: string | null }>(
  records: readonly T[],
  resolved: ReadonlyMap<string, ResolvedName>
): Array<T & { nameReadAt?: string }> {
  if (resolved.size === 0) return records.slice();
  return records.map(record => {
    const target = nameableRecord(record);
    const found = target ? resolved.get(target.uriHash) : undefined;
    const name = found ? sanitizePublicText(found.name, SHOWN_NAME_MAX_CHARS) : null;
    if (found === undefined || name === null || name === record.displayName) return record;
    return { ...record, displayName: name, ...(found.readAt ? { nameReadAt: found.readAt } : {}) };
  });
}

/** A directory entry's name is still the placeholder when it matches this (MySQL REGEXP and JavaScript alike). */
export const ENTRY_PLACEHOLDER_PATTERN = "^Agent #[0-9]+$";
/** The sentence added to a directory entry's note when its name was read from its registration link. */
export const entryNameNote = (day: string) => ` Its name was read from its registration link on ${day}; it is the registrant's own claim.`;

/** What a registration link read from the chain is, for the entries step. */
type EntryUriFacts =
  | { kind: "empty" | "other"; uriHash: string }
  | { kind: "inline"; uriHash: string; name: string | null }
  | { kind: "web" | "ipfs"; uriHash: string; uri: string };

/**
 * Classifies the `tokenURI` of one directory entry. `null` is a read that failed or did not decode (a token that reverts), and is
 * the same as no link. Inline JSON is decoded in place and needs no request. An https address, or an ipfs address with a CID, is
 * a link to read. Anything else (an `http` address, another scheme, a link too long for the table) is left alone.
 */
export function entryUriFacts(uri: string | null): EntryUriFacts {
  if (uri === null || uri.length === 0) return { kind: "empty", uriHash: uriHashOf("") };
  const uriHash = uriHashOf(uri);
  const kind = classifyAgentUri(uri);
  if (kind === "inline-json") {
    const inline = extractInlineRegistration(uri);
    return { kind: "inline", uriHash, name: inline?.parsed ? inline.name : null };
  }
  if (uri.length > NAME_URI_MAX_CHARS) return { kind: "other", uriHash };
  if (kind === "web") return { kind: "web", uriHash, uri };
  if (kind === "ipfs" && ipfsLinkHasCid(uri)) return { kind: "ipfs", uriHash, uri };
  return { kind: kind === "empty" ? "empty" : "other", uriHash };
}

/** The host a read is addressed to, for pacing: the web host, or "ipfs" for every link asked of the gateway. */
export function linkHost(uri: string, kind: RegistrationUriKind): string {
  if (kind === "ipfs") return "ipfs";
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The links to read in one run, in the order given, at most `limit`, and at most `perHost` for any one host, so a single
 * platform that registered thousands of agents is asked a few files at a time and the other hosts are not starved behind it.
 */
export function pickBalanced<T extends { uri: string; kind: RegistrationUriKind }>(candidates: readonly T[], limit: number, perHost: number): T[] {
  const taken: T[] = [];
  const perHostCount = new Map<string, number>();
  for (const candidate of candidates) {
    if (taken.length >= limit) break;
    const host = linkHost(candidate.uri, candidate.kind);
    const count = perHostCount.get(host) ?? 0;
    if (count >= perHost) continue;
    perHostCount.set(host, count + 1);
    taken.push(candidate);
  }
  return taken;
}
