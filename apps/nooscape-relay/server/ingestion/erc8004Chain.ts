import { createHash } from "node:crypto";
import {
  classifyAgentUri,
  decodeAbiString,
  decodeTransferActivityLog,
  decodeUriUpdatedActivityLog,
  extractInlineRegistration,
  hexToSafeInteger,
  MAX_URI_DERIVED_LENGTH,
  ROBINHOOD_REGISTERED_TOPIC,
  ROBINHOOD_TRANSFER_TOPIC,
  ROBINHOOD_URI_UPDATED_TOPIC,
  type EvmRegistryChain,
  type UriKind,
} from "./robinhood";
import type { Erc8004Chain } from "./erc8004Chains";
import type { DirectoryChainActivityEvent, DirectoryEntryDraft } from "./types";

/**
 * Pure decoding and planning for the ERC-8004 identity pass on one EVM chain (docs/bnb-chain-agents-plan-2026-10-13.md,
 * decisions D1 to D3, which every chain keeps). Nothing here touches the network or the database. The chain is an argument:
 * its registry address, deploy block, log range, cursor prefix and the words of its messages come from erc8004Chains.ts, and
 * nothing in this file names a chain.
 *
 * Posture, fixed by the operator's decisions: chain facts only, no scores and no tiers (D1), and the pass never fetches an
 * agent URI (D2). A URI is read as bytes the chain already holds: its kind, its https host, its SHA-256, and, for inline `data:`
 * JSON, a name decoded locally.
 *
 * The registry is the same contract at the same address as on Robinhood Chain, with the same event shapes, so the topic hashes
 * and the Transfer and URIUpdated decoders are shared; only the chain differs.
 */

export const ERC8004_REGISTERED_TOPIC = ROBINHOOD_REGISTERED_TOPIC;
export const ERC8004_TRANSFER_TOPIC = ROBINHOOD_TRANSFER_TOPIC;
export const ERC8004_URI_UPDATED_TOPIC = ROBINHOOD_URI_UPDATED_TOPIC;
/** One `eth_getLogs` filter for all three event kinds: topic0 is an OR list at position zero. */
export const ERC8004_IDENTITY_TOPIC_FILTER: string[][] = [[ERC8004_REGISTERED_TOPIC, ERC8004_TRANSFER_TOPIC, ERC8004_URI_UPDATED_TOPIC]];

/** A failure of the pass's own rules (a corrupt cursor, a response it will not trust). The name says which chain it was. */
export class Erc8004ValidationError extends Error {
  constructor(message: string, name = "Erc8004ValidationError") {
    super(message);
    this.name = name;
  }
}

/** The error for a rule of this chain's pass, named for the chain (for example BscRegistryValidationError). */
export const validationError = (chain: Erc8004Chain, message: string) => new Erc8004ValidationError(message, `${chain.errorPrefix}RegistryValidationError`);

/**
 * The chain's switch is off, so its pass, or the staging of its source, does not start. Not a fault of the node or of the pass's
 * rules, so it has its own class: the operator's page can say that it is switched off instead of that live data is unavailable.
 */
export class Erc8004ChainOffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Erc8004ChainOffError";
  }
}

/** The chain and registry the shared Transfer and URIUpdated decoders are asked about. */
export const registryChainOf = (chain: Erc8004Chain): EvmRegistryChain => ({ chainId: chain.chainId, registry: chain.identityRegistry });

// ---------------------------------------------------------------- cursor and windows

/**
 * The persisted position: `<prefix>:<next block>` means every block below it is done. A fresh source starts at the deploy block.
 * Anything else fails closed, so a corrupted cursor can never silently rescan or skip history.
 */
export function parseCursor(chain: Erc8004Chain, cursor: string | null): { nextBlock: number } {
  const trimmed = (cursor ?? "").trim();
  if (trimmed === "") return { nextBlock: chain.deployBlock };
  const match = new RegExp(`^${chain.cursorPrefix}:([0-9]+)$`).exec(trimmed);
  if (!match) throw validationError(chain, `Stored ${chain.chainLabel} cursor is not an approved walk position.`);
  const nextBlock = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(nextBlock) || nextBlock < chain.deployBlock) {
    throw validationError(chain, `Stored ${chain.chainLabel} walk position is out of bounds.`);
  }
  return { nextBlock };
}

export function cursorFor(chain: Erc8004Chain, nextBlock: number): string {
  return `${chain.cursorPrefix}:${nextBlock}`;
}

export type ChainWindow = { from: number; to: number };

/**
 * Consecutive ascending windows of at most the provider's range ceiling, from the cursor up to the finalized block, capped at
 * `maxWindows`. Empty when the walk is caught up. Pure.
 */
export function planWindows(chain: Erc8004Chain, nextBlock: number, finalizedBlock: number, maxWindows: number): ChainWindow[] {
  const windows: ChainWindow[] = [];
  for (let from = nextBlock; from <= finalizedBlock && windows.length < maxWindows; from += chain.maxLogRange) {
    windows.push({ from, to: Math.min(from + chain.maxLogRange - 1, finalizedBlock) });
  }
  return windows;
}

// ---------------------------------------------------------------- URI facts

export type UriFacts = {
  uriKind: UriKind;
  /** Lowercased host of an https URI, as recorded; never fetched. */
  locatorHost: string | null;
  /** SHA-256 hex of the full URI: the fold key for byte-identical registrations. */
  profileUriHash: string;
  /** Name decoded locally from inline registration JSON; self-asserted. */
  inlineName: string | null;
  inlineParsed: boolean;
  truncated: boolean;
};

/** What the registry-recorded URI says, derived from its bytes alone. Pure. */
export function uriFacts(uri: string): UriFacts {
  const truncated = uri.length > MAX_URI_DERIVED_LENGTH;
  const derived = uri.length === 0 ? null : truncated ? uri.slice(0, MAX_URI_DERIVED_LENGTH) : uri;
  const uriKind = classifyAgentUri(derived);
  const inline = derived && uriKind === "inline-json" && !truncated ? extractInlineRegistration(derived) : null;
  let locatorHost: string | null = null;
  if (derived && derived.startsWith("https://")) {
    try {
      const host = new URL(derived).hostname.toLowerCase();
      locatorHost = host.length > 0 && host.length <= 255 ? host : null;
    } catch {
      locatorHost = null;
    }
  }
  return {
    uriKind,
    locatorHost,
    profileUriHash: createHash("sha256").update(uri, "utf8").digest("hex"),
    inlineName: inline?.name ?? null,
    inlineParsed: inline?.parsed ?? false,
    truncated,
  };
}

/**
 * Whether the recorded URI is a usable profile link: a web link, an IPFS reference, or inline JSON that parsed. An empty URI, an
 * unrecognized scheme, and inline JSON that did not parse (or exceeded the derived-view bound) give the listing rules nothing to
 * compare, so such a registration is held out of the directory listing. Decided from the URI's bytes alone; never fetched.
 */
export function hasProfileLink(facts: UriFacts): boolean {
  return facts.uriKind === "web" || facts.uriKind === "ipfs" || (facts.uriKind === "inline-json" && facts.inlineParsed);
}

// ---------------------------------------------------------------- Registered

export type Registration = {
  /** The ERC-721 token id as a decimal string (agent ids start at 0). */
  agentId: string;
  /** The `owner` the Registered event records (lowercase); a chain fact, not a verified operator. */
  owner: string;
  uri: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
};

/** The directory key every identity on this chain is stored under: `eip155:<chain id>:<registry>:<agent id>`. */
export function externalKey(chain: Erc8004Chain, agentId: string): string {
  return `eip155:${chain.chainId}:${chain.identityRegistry}:${agentId}`;
}

const HEX_WORD = /^0x[0-9a-fA-F]{64}$/;

type Bounds = { fromBlock: number; toBlock: number };

function asLog(chain: Erc8004Chain, log: unknown): Record<string, unknown> | null {
  if (!log || typeof log !== "object" || Array.isArray(log)) return null;
  const entry = log as Record<string, unknown>;
  if (entry.removed === true) return null;
  if (typeof entry.address !== "string" || entry.address.toLowerCase() !== chain.identityRegistry.toLowerCase()) return null;
  return entry;
}

/**
 * Decodes one `Registered(uint256 indexed agentId, string agentURI, address indexed owner)` log. Returns null for anything that
 * is not that event from the approved registry inside the window, or whose URI does not decode as one bounded ABI string; the
 * caller counts it as rejected.
 */
export function decodeRegisteredLog(chain: Erc8004Chain, log: unknown, bounds: Bounds): Registration | null {
  const entry = asLog(chain, log);
  if (!entry) return null;
  const topics = entry.topics;
  if (!Array.isArray(topics) || topics.length !== 3) return null;
  if (typeof topics[0] !== "string" || topics[0].toLowerCase() !== ERC8004_REGISTERED_TOPIC) return null;
  if (typeof topics[1] !== "string" || !HEX_WORD.test(topics[1])) return null;
  if (typeof topics[2] !== "string" || !HEX_WORD.test(topics[2])) return null;
  const blockNumber = hexToSafeInteger(entry.blockNumber);
  const logIndex = hexToSafeInteger(entry.logIndex);
  if (blockNumber === null || blockNumber < bounds.fromBlock || blockNumber > bounds.toBlock) return null;
  if (logIndex === null) return null;
  if (typeof entry.transactionHash !== "string" || !HEX_WORD.test(entry.transactionHash)) return null;
  const uri = decodeAbiString(entry.data);
  if (uri === null) return null;
  return {
    agentId: BigInt(topics[1]).toString(),
    owner: `0x${topics[2].slice(26).toLowerCase()}`,
    uri,
    blockNumber,
    transactionHash: entry.transactionHash,
    logIndex,
  };
}

const SOURCE_NOTE_BY_KIND: Record<UriKind, string> = {
  web: "a web link",
  ipfs: "an IPFS reference",
  "inline-json": "inline registration JSON",
  empty: "none",
  other: "an unrecognized scheme",
};

/**
 * One registry row for a registration. Everything on it is a chain fact or a locally decoded self-assertion: the name only when
 * the URI is inline JSON that carries one, the host only for an https URI, and never a fetch. It is written to the registry rows
 * table, not the directory: the listing rules decide which registrations are published (see agentRegistryRows.ts).
 */
export function directoryDraft(chain: Erc8004Chain, registration: Registration): DirectoryEntryDraft {
  const facts = uriFacts(registration.uri);
  const displayName = facts.inlineName ? facts.inlineName.slice(0, 255) : `Agent #${registration.agentId}`;
  const uriSentence =
    facts.uriKind === "empty"
      ? "No URI was set at registration."
      : facts.uriKind === "inline-json"
        ? facts.inlineParsed
          ? facts.inlineName
            ? "The registry-recorded URI is inline registration JSON, decoded locally; the name is self-asserted."
            : "The registry-recorded URI is inline registration JSON, decoded locally; it carries no name."
          : "The registry-recorded URI is inline JSON that could not be parsed, so no metadata was extracted."
        : `The registry-recorded URI is ${SOURCE_NOTE_BY_KIND[facts.uriKind]}. ${chain.fetchSentence}`;
  const truncatedSentence = facts.truncated ? " The URI exceeded the 8 KiB derived-view bound." : "";
  return {
    externalKey: externalKey(chain, registration.agentId),
    displayName,
    locatorHost: facts.locatorHost,
    registrant: registration.owner,
    profileUriHash: facts.profileUriHash,
    listing: hasProfileLink(facts) ? 3 : 0,
    sourceSignalNote: `${chain.label} ERC-8004 registration. ${uriSentence}${truncatedSentence} The event records owner ${registration.owner}; current ownership is not verified.`,
  };
}

// ---------------------------------------------------------------- URIUpdated

export type UriUpdate = {
  externalKey: string;
  blockNumber: number;
  logIndex: number;
  /** The new URI, or null when the event's string did not decode (the change is still counted in the ledger). */
  uri: string | null;
  /** The ledger row for this event, built by the shared decoder. */
  event: DirectoryChainActivityEvent;
};

export function decodeUriUpdatedLog(chain: Erc8004Chain, log: unknown, bounds: Bounds): UriUpdate | null {
  const event = decodeUriUpdatedActivityLog(log, bounds, registryChainOf(chain));
  if (!event) return null;
  const uri = decodeAbiString((log as Record<string, unknown>).data);
  return { externalKey: event.externalKey, blockNumber: event.blockNumber, logIndex: event.logIndex, uri, event };
}

// ---------------------------------------------------------------- one window

export type WindowParse = {
  registrations: Registration[];
  activity: DirectoryChainActivityEvent[];
  uriUpdates: UriUpdate[];
  discoveredCount: number;
  rejectedCount: number;
};

/**
 * Decodes one window's `eth_getLogs` response. Registrations become directory rows, mints and transfers and URI updates become
 * ledger rows, and anything else from the registry is counted as rejected and never stored. Events are returned in (block, log
 * index) order so a registration is always applied before the URI update that follows it.
 */
export function parseWindowLogs(chain: Erc8004Chain, logs: unknown, bounds: Bounds): WindowParse {
  if (!Array.isArray(logs)) throw validationError(chain, `${chain.chainLabel} identity log response must be an array.`);
  if (logs.length > chain.maxWindowLogs) {
    throw validationError(chain, `${chain.chainLabel} identity log response exceeds the approved bound of ${chain.maxWindowLogs} events.`);
  }
  const registrations: Registration[] = [];
  const activity: DirectoryChainActivityEvent[] = [];
  const uriUpdates: UriUpdate[] = [];
  for (const log of logs) {
    const registration = decodeRegisteredLog(chain, log, bounds);
    if (registration) {
      registrations.push(registration);
      continue;
    }
    const transfer = decodeTransferActivityLog(log, bounds, registryChainOf(chain));
    if (transfer) {
      activity.push(transfer);
      continue;
    }
    const update = decodeUriUpdatedLog(chain, log, bounds);
    if (update) {
      activity.push(update.event);
      uriUpdates.push(update);
    }
  }
  const order = (a: { blockNumber: number; logIndex: number }, b: { blockNumber: number; logIndex: number }) =>
    a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
  registrations.sort(order);
  activity.sort(order);
  uriUpdates.sort(order);
  return {
    registrations,
    activity,
    uriUpdates,
    discoveredCount: logs.length,
    rejectedCount: logs.length - registrations.length - activity.length,
  };
}
