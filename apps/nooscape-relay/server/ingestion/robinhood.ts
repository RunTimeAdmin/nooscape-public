import { createHash } from "node:crypto";
import { storagePut } from "../storage";
import { assertPublicHostname } from "./a2a";
import type { IngestionSource } from "../../drizzle/schema";
import type { DirectoryChainActivityEvent, DirectoryEntryDraft, Erc8004RegistryCandidate, RawObservationInput } from "./types";

export const ROBINHOOD_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_CHAIN_ID_HEX = "0x1237";
export const ROBINHOOD_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const ROBINHOOD_REGISTERED_TOPIC = "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a";
/**
 * Canonical ERC-721 `Transfer(address,address,uint256)` topic — the identity
 * registry is an ERC-721 and emits it for every mint and change of hands.
 * Verified live on Robinhood Chain (2026-10-10 burst-window probe).
 */
export const ROBINHOOD_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/**
 * ERC-8004 `URIUpdated(uint256,string,address)` topic, keccak-verified against
 * the published registry ABI. URIUpdated events are real and part of the
 * activity ledger: the 2026-10-10 external audit counted 439 on chain while
 * the walk's coverage then stood at 275 — coverage, not existence, is the gap.
 */
export const ROBINHOOD_URI_UPDATED_TOPIC = "0x3a2c7fffc2cba7582c690e3b82c453ea02a308326a98a3ad7576c606336409fb";
/** The ERC-20/721 zero address: a Transfer whose `from` is this value is a mint. */
export const ROBINHOOD_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/**
 * The chain and registry an ERC-8004 identity log belongs to. The registry is
 * deployed at the same address with the same event shapes on every chain, so
 * the Transfer and URIUpdated decoders take this and default to Robinhood
 * Chain; BNB Smart Chain passes its own so its externalKey carries chain 56.
 */
export type EvmRegistryChain = { chainId: number; registry: string };
export const ROBINHOOD_REGISTRY_CHAIN: EvmRegistryChain = { chainId: 4663, registry: ROBINHOOD_IDENTITY_REGISTRY };
/**
 * Block-proxied hour for hand-out classification: Robinhood Chain runs at
 * ~0.101 s/block (measured 2026-10-10: 8,192 blocks in 827 s), so 36,000
 * blocks ≈ one hour. A secondary Transfer inside this many blocks of minting
 * is a platform hand-out, not a sale — a chain fact about timing only.
 */
export const ROBINHOOD_HANDOUT_BLOCK_WINDOW = 36_000;

const SCAN_WINDOW_BLOCKS = 2_000_000;
const FINALITY_MARGIN_BLOCKS = 256;
const MAX_RECORDS = 24;
const MAX_SCANNED_EVENTS = 256;
/**
 * Backfill event budget for one full 2M-block window. A window denser than
 * this — a mass-registration burst — is narrowed adaptively to its newest
 * fetchable half until the response fits, and the persisted cursor resumes
 * just below the scanned sub-window so no block is ever skipped. Reviewed
 * intake never runs in backfill mode, so the 256-event evidence bound is
 * untouched.
 */
export const ROBINHOOD_MAX_BACKFILL_EVENTS = 2_000;
/**
 * Event bound for a narrowed backfill sub-window, where the 4 MiB transport
 * cap is the hard limit; a full response of minimal events cannot exceed it.
 * Keeps the narrowed scan explicitly bounded like every other adapter limit.
 */
export const ROBINHOOD_MAX_BACKFILL_SUBWINDOW_EVENTS = 10_000;
/** Halvings from a 2M-block window down to a single block (21) plus headroom. */
const MAX_BACKFILL_WINDOW_SPLITS = 24;
/**
 * Forward-walk parameters (docs/forward-cursor-2026-10-10.md): each run
 * advances one bounded window up to this many blocks past the anchored
 * position, never past the chain head minus this finality margin (~1 minute
 * at ≈0.1 s blocks). The margin plus the per-run anchor-hash check is the
 * conservative reorg pair. The window rides the RPC's block-range ceiling
 * for single-value topic filters (the walk fetches one topic per call):
 * the source is manual-only and the chain was measured at ≈141k blocks/h
 * (2026-10-11), so a smaller window would need dozens of clicks per day
 * just to hold position. Adaptive narrowing still guards dense windows.
 */
export const ROBINHOOD_FORWARD_FINALITY_MARGIN_BLOCKS = 600;
export const ROBINHOOD_FORWARD_WINDOW_BLOCKS = 2_000_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_URI_DERIVED_LENGTH = 8_192;
const MAX_ABI_STRING_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * Edge statuses observed to clear on their own after a backoff (the
 * Cloudflare-fronted RPC throttles rapid bursts with 403/429 and
 * intermittently blocks the calling IP for minutes — the 2026-10-10
 * dense-era walk drew sustained 403s that outlasted a 5-second pass).
 */
const TRANSIENT_RPC_HTTP_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
const RPC_RETRY_BACKOFF_MS = [1_500, 3_500, 10_000, 30_000, 60_000];
/**
 * The waits of the scheduled walk: 5 seconds in all, where the manual adapters wait out 105. A tick has 150 seconds in all and its later steps
 * skip a tick that has run 90 to 100, so a throttle that does not clear in a few seconds ends the run, which keeps its cursor, and the next
 * tick tries again from the same place.
 */
export const SCHEDULED_RPC_RETRY_BACKOFF_MS: readonly number[] = [1_500, 3_500];

export class RobinhoodRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RobinhoodRegistryValidationError";
  }
}

/** HTTP-level failure from the RPC edge; carries the status for transient classification. */
export class RobinhoodRegistryHttpError extends RobinhoodRegistryValidationError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RobinhoodRegistryHttpError";
    this.status = status;
  }
}

/**
 * Response above the transport cap or a JSON-RPC window rejection (block-range
 * or result-count cap); walk modes narrow the window and refetch when possible.
 */
export class RobinhoodRegistryResponseTooLargeError extends RobinhoodRegistryValidationError {
  constructor(message: string) {
    super(message);
    this.name = "RobinhoodRegistryResponseTooLargeError";
  }
}

/**
 * The forward walk's stored anchor block no longer hashes to the anchored
 * value — a reorg deeper than the finality margin, or an RPC serving a
 * different fork. Deliberately a loud stop, not an auto-rewind: an automated
 * ledger truncation against a misread anchor is a worse failure mode than a
 * paused walk.
 */
export class RobinhoodRegistryReorgError extends RobinhoodRegistryValidationError {
  constructor(message: string) {
    super(message);
    this.name = "RobinhoodRegistryReorgError";
  }
}

type RawRegisteredLog = Record<string, unknown>;

export type UriKind = "web" | "ipfs" | "inline-json" | "empty" | "other";

export function hexToSafeInteger(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(value)) return null;
  const parsed = Number.parseInt(value.slice(2), 16);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Decodes one ABI-encoded dynamic string argument. Pure; never touches the network. */
export function decodeAbiString(data: unknown): string | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) return null;
  const hex = data.slice(2);
  if (hex.length < 128 || hex.length % 2 !== 0) return null;
  if (Number.parseInt(hex.slice(0, 64), 16) !== 32) return null;
  const byteLength = Number.parseInt(hex.slice(64, 128), 16);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_ABI_STRING_BYTES) return null;
  const stringHex = hex.slice(128, 128 + byteLength * 2);
  if (stringHex.length < byteLength * 2) return null;
  return Buffer.from(stringHex, "hex").toString("utf8");
}

export function classifyAgentUri(uri: string | null): UriKind {
  if (!uri) return "empty";
  if (uri.startsWith("data:application/json")) return "inline-json";
  if (uri.startsWith("https://")) return "web";
  if (uri.startsWith("ipfs://")) return "ipfs";
  return "other";
}

/**
 * Decodes self-asserted metadata from an inline `data:application/json` URI.
 * This is a local decode of bytes already present in the retained event; no
 * network access, no dereference, and no execution occurs.
 */
export function extractInlineRegistration(uri: string): { name: string | null; description: string | null; parsed: boolean } | null {
  if (!uri.startsWith("data:application/json")) return null;
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  const parameters = uri.slice("data:".length, comma);
  const payload = uri.slice(comma + 1);
  if (payload.length > MAX_ABI_STRING_BYTES) return null;
  let text: string;
  if (/;base64/i.test(parameters)) {
    text = Buffer.from(payload, "base64").toString("utf8");
  } else {
    try {
      text = decodeURIComponent(payload);
    } catch {
      return { name: null, description: null, parsed: false };
    }
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { name: null, description: null, parsed: false };
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim().slice(0, 255) : null;
    const description = typeof record.description === "string" && record.description.trim().length > 0 ? record.description.trim().slice(0, 8_000) : null;
    return { name, description, parsed: true };
  } catch {
    return { name: null, description: null, parsed: false };
  }
}

function slugFromDisplayName(value: string, fallback: string) {
  const label = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 132);
  return label || fallback;
}

/**
 * Decodes one `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`
 * log into a candidate. Returns null for anything that does not match the approved
 * registry, topic, or bounds; the raw log itself is the retained evidence.
 */
export function decodeRegisteredLog(
  log: unknown,
  bounds: { fromBlock: number; toBlock: number }
): { candidate: Erc8004RegistryCandidate; log: RawRegisteredLog } | null {
  if (!log || typeof log !== "object" || Array.isArray(log)) return null;
  const entry = log as RawRegisteredLog;
  if (entry.removed === true) return null;
  if (typeof entry.address !== "string" || entry.address.toLowerCase() !== ROBINHOOD_IDENTITY_REGISTRY.toLowerCase()) return null;
  const topics = entry.topics;
  if (!Array.isArray(topics) || topics.length !== 3) return null;
  if (typeof topics[0] !== "string" || topics[0].toLowerCase() !== ROBINHOOD_REGISTERED_TOPIC) return null;
  if (typeof topics[1] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topics[1])) return null;
  if (typeof topics[2] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topics[2])) return null;

  let agentId: string;
  try {
    const parsedId = BigInt(topics[1]);
    // ERC-721 token ids are unsigned; 0 is the first valid id (agent #0 was
    // silently dropped by an earlier `<= 0` guard). Only reject negatives.
    if (parsedId < BigInt(0)) return null;
    agentId = parsedId.toString();
  } catch {
    return null;
  }

  // The indexed owner topic is `0x` + 24 zero-padding hex chars + the 20-byte
  // address, so dropping the first 26 characters leaves exactly the 40-char
  // address. (A 24-char slice kept two phantom leading zeros.)
  const owner = `0x${topics[2].slice(26).toLowerCase()}`;
  const blockNumber = hexToSafeInteger(entry.blockNumber);
  const logIndex = hexToSafeInteger(entry.logIndex);
  if (blockNumber === null || blockNumber < bounds.fromBlock || blockNumber > bounds.toBlock) return null;
  if (logIndex === null) return null;
  if (typeof entry.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(entry.transactionHash)) return null;

  const decodedUri = decodeAbiString(entry.data);
  if (decodedUri === null) return null;
  const truncated = decodedUri.length > MAX_URI_DERIVED_LENGTH;
  const agentUri = decodedUri.length === 0 ? null : truncated ? decodedUri.slice(0, MAX_URI_DERIVED_LENGTH) : decodedUri;

  const uriKind = classifyAgentUri(agentUri);
  const inline = agentUri && uriKind === "inline-json" && !truncated ? extractInlineRegistration(agentUri) : null;
  const displayName = inline?.name ?? `Agent #${agentId}`;
  const handle = slugFromDisplayName(displayName, `agent-${agentId}`);

  const uriNote = agentUri
    ? `Registry-recorded URI at registration: ${agentUri}`
    : "No URI was set at registration, so no self-description is available.";
  const descriptionNote = inline?.description ? ` Inline registration JSON self-asserts the description: ${inline.description}` : "";
  const summary = `Registered as agent ${agentId} in the Robinhood Chain ERC-8004 identity registry (eip155:4663, AgentIdentity/AGENT). ${uriNote}${descriptionNote} Nooscape retained the registration event; ownership, URI, and self-asserted metadata remain unverified assertions.`;

  const signals: string[] = [];
  if (uriKind === "web") signals.push("Registry-recorded URI is a web link; Nooscape did not fetch it.");
  if (uriKind === "ipfs") signals.push("Registry-recorded URI is an IPFS reference; Nooscape did not resolve it.");
  if (uriKind === "inline-json") {
    signals.push(
      inline?.parsed
        ? "Registry-recorded URI is inline registration JSON decoded locally without network access; name and description are self-asserted."
        : "Registry-recorded URI is inline JSON that could not be parsed; no metadata was extracted."
    );
  }
  if (uriKind === "empty") signals.push("No URI was set at registration.");
  if (uriKind === "other") signals.push("Registry-recorded URI uses an unrecognized scheme; Nooscape did not resolve it.");
  if (truncated) signals.push("Decoded URI exceeded the 8 KiB derived-view bound and was truncated; the retained event contains the full value.");
  signals.push(`Registry event records owner ${owner}; Nooscape has not verified current ownership or token state.`);

  return {
    candidate: {
      displayName,
      handle,
      summary,
      primaryCapability: "On-chain registry identity",
      specialties: ["Robinhood Chain", "ERC-8004 Identity Registry", uriKind === "empty" ? "No URI set" : "URI recorded"],
      externalId: `eip155:4663:${ROBINHOOD_IDENTITY_REGISTRY}:${agentId}`,
      owner,
      agentUri,
      uriKind,
      blockNumber,
      transactionHash: entry.transactionHash,
      logIndex,
      sourceSignals: signals,
    },
    log: entry,
  };
}

/**
 * Decodes one ERC-721 `Transfer(address indexed from, address indexed to,
 * uint256 indexed tokenId)` log from the identity registry into a chain
 * activity event. A mint (`from` = zero address) anchors the mint block; any
 * other Transfer is a change of hands. Returns null for anything that does not
 * match the approved registry, topic, or bounds.
 */
export function decodeTransferActivityLog(
  log: unknown,
  bounds: { fromBlock: number; toBlock: number },
  chain: EvmRegistryChain = ROBINHOOD_REGISTRY_CHAIN
): DirectoryChainActivityEvent | null {
  if (!log || typeof log !== "object" || Array.isArray(log)) return null;
  const entry = log as RawRegisteredLog;
  if (entry.removed === true) return null;
  if (typeof entry.address !== "string" || entry.address.toLowerCase() !== chain.registry.toLowerCase()) return null;
  const topics = entry.topics;
  if (!Array.isArray(topics) || topics.length !== 4) return null;
  if (typeof topics[0] !== "string" || topics[0].toLowerCase() !== ROBINHOOD_TRANSFER_TOPIC) return null;
  for (const topic of [topics[1], topics[2], topics[3]]) {
    if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  }

  let tokenId: string;
  try {
    const parsedId = BigInt(topics[3]!);
    // ERC-721 token ids are unsigned; 0 is the first valid id (agent #0 was
    // silently dropped by an earlier `<= 0` guard). Only reject negatives.
    if (parsedId < BigInt(0)) return null;
    tokenId = parsedId.toString();
  } catch {
    return null;
  }

  const fromAddress = `0x${topics[1]!.slice(26).toLowerCase()}`;
  const toAddress = `0x${topics[2]!.slice(26).toLowerCase()}`;
  const blockNumber = hexToSafeInteger(entry.blockNumber);
  const logIndex = hexToSafeInteger(entry.logIndex);
  if (blockNumber === null || blockNumber < bounds.fromBlock || blockNumber > bounds.toBlock) return null;
  if (logIndex === null) return null;
  if (typeof entry.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(entry.transactionHash)) return null;

  return {
    kind: fromAddress === ROBINHOOD_ZERO_ADDRESS ? "mint" : "secondary",
    externalKey: `eip155:${chain.chainId}:${chain.registry}:${tokenId}`,
    blockNumber,
    transactionHash: entry.transactionHash,
    logIndex,
    fromAddress,
    toAddress,
  };
}

/**
 * Decodes one ERC-8004 `URIUpdated(uint256 indexed agentId, string newURI,
 * address indexed updatedBy)` log into a counted profile-change event. The
 * newURI string stays in the retained chain log; the ledger keeps only the
 * count-able fact that the profile changed. Returns null for anything that
 * does not match the approved registry, topic, or bounds.
 */
export function decodeUriUpdatedActivityLog(
  log: unknown,
  bounds: { fromBlock: number; toBlock: number },
  chain: EvmRegistryChain = ROBINHOOD_REGISTRY_CHAIN
): DirectoryChainActivityEvent | null {
  if (!log || typeof log !== "object" || Array.isArray(log)) return null;
  const entry = log as RawRegisteredLog;
  if (entry.removed === true) return null;
  if (typeof entry.address !== "string" || entry.address.toLowerCase() !== chain.registry.toLowerCase()) return null;
  const topics = entry.topics;
  if (!Array.isArray(topics) || topics.length !== 3) return null;
  if (typeof topics[0] !== "string" || topics[0].toLowerCase() !== ROBINHOOD_URI_UPDATED_TOPIC) return null;
  for (const topic of [topics[1], topics[2]]) {
    if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  }

  let agentId: string;
  try {
    const parsedId = BigInt(topics[1]!);
    // ERC-721 token ids are unsigned; 0 is the first valid id (agent #0 was
    // silently dropped by an earlier `<= 0` guard). Only reject negatives.
    if (parsedId < BigInt(0)) return null;
    agentId = parsedId.toString();
  } catch {
    return null;
  }

  const blockNumber = hexToSafeInteger(entry.blockNumber);
  const logIndex = hexToSafeInteger(entry.logIndex);
  if (blockNumber === null || blockNumber < bounds.fromBlock || blockNumber > bounds.toBlock) return null;
  if (logIndex === null) return null;
  if (typeof entry.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(entry.transactionHash)) return null;

  return {
    kind: "uri_update",
    externalKey: `eip155:${chain.chainId}:${chain.registry}:${agentId}`,
    blockNumber,
    transactionHash: entry.transactionHash,
    logIndex,
    fromAddress: null,
    toAddress: null,
  };
}

/**
 * Parses one bounded activity-window `eth_getLogs` response. Activity mode is
 * walk-only: every decodable Transfer and URIUpdated event is acknowledged
 * into the ledger and nothing enters the reviewed evidence pipeline.
 */
export function parseRobinhoodActivityLogs(
  logs: unknown,
  bounds: { fromBlock: number; toBlock: number },
  options: { activityEventLimit?: number } = {}
) {
  if (!Array.isArray(logs)) throw new RobinhoodRegistryValidationError("Registry activity log response must be an array.");
  const scanLimit = options.activityEventLimit ?? ROBINHOOD_MAX_BACKFILL_EVENTS;
  if (logs.length > scanLimit) {
    throw new RobinhoodRegistryValidationError(
      `Registry activity response exceeds the approved bounded scan of ${scanLimit} events.`
    );
  }
  const activity: DirectoryChainActivityEvent[] = [];
  for (const log of logs) {
    const event = decodeTransferActivityLog(log, bounds) ?? decodeUriUpdatedActivityLog(log, bounds);
    if (event) activity.push(event);
  }
  return {
    discoveredCount: logs.length,
    rejectedCount: logs.length - activity.length,
    activity,
  };
}

function directoryDraftFromCandidate(candidate: Erc8004RegistryCandidate, note: string): DirectoryEntryDraft {
  let locatorHost: string | null = null;
  if (candidate.agentUri && candidate.agentUri.startsWith("https://")) {
    try {
      locatorHost = new URL(candidate.agentUri).hostname.toLowerCase();
    } catch {
      locatorHost = null;
    }
  }
  return {
    externalKey: candidate.externalId,
    displayName: candidate.displayName,
    locatorHost,
    registrant: candidate.owner,
    sourceSignalNote: note,
  };
}

/**
 * Parses one bounded `eth_getLogs` response. In observe mode the scan is
 * capped, the newest events win, and everything else is rejected and counted;
 * nothing is padded. Every decoded registration outside the accepted newest
 * window becomes a master-directory acknowledgement: the registration is "out
 * there", nothing more. In walk mode (backfill or registrants) the whole
 * bounded window is directory-only: every decodable registration is
 * acknowledged and nothing enters the reviewed evidence pipeline.
 */
export function parseRobinhoodRegisteredLogs(
  logs: unknown,
  bounds: { fromBlock: number; toBlock: number },
  options: { backfill?: boolean; backfillEventLimit?: number } = {}
) {
  if (!Array.isArray(logs)) throw new RobinhoodRegistryValidationError("Registry log response must be an array.");
  const scanLimit = options.backfill ? options.backfillEventLimit ?? ROBINHOOD_MAX_BACKFILL_EVENTS : MAX_SCANNED_EVENTS;
  if (logs.length > scanLimit) {
    throw new RobinhoodRegistryValidationError(
      options.backfill
        ? `Registry backfill response exceeds the approved bounded scan of ${scanLimit} events.`
        : "Registry log response exceeds the approved bounded scan of 256 events."
    );
  }
  const decoded: Array<{ candidate: Erc8004RegistryCandidate; log: RawRegisteredLog }> = [];
  for (const log of logs) {
    const entry = decodeRegisteredLog(log, bounds);
    if (entry) decoded.push(entry);
  }
  if (options.backfill) {
    const seen = new Map<string, DirectoryEntryDraft>();
    for (const { candidate } of decoded) {
      const draft = directoryDraftFromCandidate(
        candidate,
        candidate.uriKind === "inline-json"
          ? "Historical registration recorded with inline metadata; backfilled acknowledgement, not reviewed."
          : "Historical registration backfilled from chain history; acknowledged only."
      );
      if (!seen.has(draft.externalKey)) seen.set(draft.externalKey, draft);
    }
    return {
      discoveredCount: logs.length,
      rejectedCount: logs.length - decoded.length,
      entries: [] as Array<{ candidate: Erc8004RegistryCandidate; log: RawRegisteredLog }>,
      directory: Array.from(seen.values()),
    };
  }
  decoded.sort((left, right) =>
    right.candidate.blockNumber - left.candidate.blockNumber || right.candidate.logIndex - left.candidate.logIndex
  );
  const entries = decoded.slice(0, MAX_RECORDS);
  const acceptedIds = new Set(entries.map(entry => entry.candidate.externalId));
  const directory: DirectoryEntryDraft[] = [];
  for (const { candidate } of decoded) {
    if (acceptedIds.has(candidate.externalId)) continue;
    directory.push(
      directoryDraftFromCandidate(
        candidate,
        candidate.uriKind === "inline-json"
          ? "Registration recorded with inline metadata; acknowledged outside the reviewed window."
          : "Registration observed outside the accepted newest window; acknowledged only."
      )
    );
  }
  return {
    discoveredCount: logs.length,
    rejectedCount: logs.length - entries.length,
    entries,
    directory,
  };
}

type RobinhoodBackfillCursor = { mode: "seed" } | { mode: "walk"; toBlock: number } | { mode: "done" };

/**
 * Parses the persisted ERC-8004 backfill position: `null` seeds the walk just
 * below the observed newest window, `bf:<block>` resumes at that block, and
 * `bf:done` marks the walk complete. Pure; never touches the network.
 */
export function parseRobinhoodBackfillCursor(cursor: string | null): RobinhoodBackfillCursor {
  if (cursor === "bf:done") return { mode: "done" };
  if (cursor === null || cursor.trim() === "") return { mode: "seed" };
  const match = /^bf:(\d+)$/.exec(cursor.trim());
  if (!match) throw new RobinhoodRegistryValidationError("Stored Robinhood cursor is not an approved backfill position.");
  const toBlock = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(toBlock) || toBlock < 1) {
    throw new RobinhoodRegistryValidationError("Stored Robinhood backfill position is out of bounds.");
  }
  return { mode: "walk", toBlock };
}

/** Next persisted backfill position after scanning a window that starts at fromBlock. */
export function robinhoodBackfillCursorAfter(fromBlock: number): string {
  return fromBlock > 1 ? `bf:${fromBlock - 1}` : "bf:done";
}

type RobinhoodRegistrantCursor = { mode: "seed" } | { mode: "walk"; toBlock: number } | { mode: "done" };

/**
 * Parses the persisted ERC-8004 registrant-walk position: `null` or a finished
 * backfill position (`bf:done`) seed the walk at the current head, `rb:<block>`
 * resumes at that block, and `rb:done` marks the walk complete. Any other
 * cursor fails closed — both walks share one persisted position, so neither
 * can silently overwrite the other's progress. Pure; never touches the network.
 */
export function parseRobinhoodRegistrantCursor(cursor: string | null): RobinhoodRegistrantCursor {
  if (cursor === "rb:done") return { mode: "done" };
  if (cursor === null || cursor.trim() === "" || cursor === "bf:done") return { mode: "seed" };
  const match = /^rb:(\d+)$/.exec(cursor.trim());
  if (!match) throw new RobinhoodRegistryValidationError("Stored Robinhood cursor is not an approved registrant-walk position.");
  const toBlock = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(toBlock) || toBlock < 1) {
    throw new RobinhoodRegistryValidationError("Stored Robinhood registrant-walk position is out of bounds.");
  }
  return { mode: "walk", toBlock };
}

/** Next persisted registrant-walk position after scanning a window that starts at fromBlock. */
export function robinhoodRegistrantCursorAfter(fromBlock: number): string {
  return fromBlock > 1 ? `rb:${fromBlock - 1}` : "rb:done";
}

type RobinhoodActivityCursor = { mode: "seed" } | { mode: "walk"; toBlock: number } | { mode: "done" };

/**
 * Parses the persisted ERC-8004 activity-walk position: `ac:done` marks the
 * walk complete, `ac:<block>` resumes at that block, and only a finished
 * registrant walk (`rb:done`) may seed it — the walks share one persisted
 * position, so the activity walk can never jump ahead of the registrant walk
 * it depends on. Any other cursor fails closed. Pure; never touches the
 * network.
 */
export function parseRobinhoodActivityCursor(cursor: string | null): RobinhoodActivityCursor {
  if (cursor === "ac:done") return { mode: "done" };
  if (cursor === "rb:done") return { mode: "seed" };
  const match = /^ac:(\d+)$/.exec((cursor ?? "").trim());
  if (!match) {
    throw new RobinhoodRegistryValidationError(
      "The activity walk starts only after the registrant walk completes; the stored cursor is not an approved activity-walk position."
    );
  }
  const toBlock = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(toBlock) || toBlock < 1) {
    throw new RobinhoodRegistryValidationError("Stored Robinhood activity-walk position is out of bounds.");
  }
  return { mode: "walk", toBlock };
}

/** Next persisted activity-walk position after scanning a window that starts at fromBlock. */
export function robinhoodActivityCursorAfter(fromBlock: number): string {
  return fromBlock > 1 ? `ac:${fromBlock - 1}` : "ac:done";
}

type RobinhoodForwardCursor = { mode: "seed" } | { mode: "anchor"; block: number; blockHash: string };

/**
 * Parses the persisted forward-walk position: `ac:done` seeds the walk at the
 * activity ledger's high-water block (the adapter resolves that block's hash
 * in the same run), and `fw:<block>#<hash>` resumes from that anchored
 * position. Any other cursor throws, so a forward position is reachable only
 * through a finished activity walk — the ordered-progression discipline of
 * the backward walks. Pure; never touches the network.
 */
export function parseRobinhoodForwardCursor(cursor: string | null): RobinhoodForwardCursor {
  if (cursor === "ac:done") return { mode: "seed" };
  const match = /^fw:(\d+)#(0x[0-9a-fA-F]{64})$/.exec((cursor ?? "").trim());
  if (!match) {
    throw new RobinhoodRegistryValidationError("Stored Robinhood cursor is not an approved forward-walk position.");
  }
  const block = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(block) || block < 1) {
    throw new RobinhoodRegistryValidationError("Stored Robinhood forward-walk position is out of bounds.");
  }
  return { mode: "anchor", block, blockHash: match[2]!.toLowerCase() };
}

/** Next persisted forward-walk position after scanning a window that ends at toBlock. */
export function robinhoodForwardCursorAfter(block: number, blockHash: string): string {
  return `fw:${block}#${blockHash.toLowerCase()}`;
}

/**
 * Resolves the forward cursor without throwing, so the activity mode can fall
 * back to its backward-walk parse (`rb:done` seed, `ac:<block>` resume) for
 * every position that is not forward territory. Pure; never touches the
 * network.
 */
function tryParseRobinhoodForwardCursor(cursor: string | null): RobinhoodForwardCursor | null {
  try {
    return parseRobinhoodForwardCursor(cursor);
  } catch {
    return null;
  }
}

export type RobinhoodWalkMode = "backfill" | "registrants" | "activity";

/**
 * A walk click that cannot run from the persisted cursor: an operator mistake,
 * never a fault. A distinct class so the operator API can show the message
 * instead of the generic storage failure, and so the orchestrator's refusal is
 * distinguishable from a real adapter fault in tests.
 */
export class RobinhoodWalkModeRefusedError extends RobinhoodRegistryValidationError {
  constructor(message: string) {
    super(message);
    this.name = "RobinhoodWalkModeRefusedError";
  }
}

/**
 * The walk modes that can run from a persisted cursor, derived from the same
 * parsers the adapter uses, so this can never drift from what the adapter
 * accepts. The four walks share one persisted position that moves strictly
 * forward through `bf:` (backfill), `rb:` (registrants), `ac:` (activity),
 * then `fw:` (the forward walk), so exactly one walk can run from any
 * recognized position; a fresh source may start either backward walk. A
 * finished walk (`bf:done`, `rb:done`) hands over to the next one. An
 * unrecognized cursor allows none. Observe mode runs from any cursor and is
 * not listed. Pure; never touches the network.
 */
export function robinhoodWalkModesForCursor(cursor: string | null): RobinhoodWalkMode[] {
  const fits = (parse: (value: string | null) => { mode: string }) => {
    try {
      return parse(cursor).mode !== "done";
    } catch {
      return false;
    }
  };
  const modes: RobinhoodWalkMode[] = [];
  if (fits(parseRobinhoodBackfillCursor)) modes.push("backfill");
  if (fits(parseRobinhoodRegistrantCursor)) modes.push("registrants");
  // `ac:done` and `fw:` positions run the forward walk, which the adapter
  // resolves before the backward activity parse.
  if (tryParseRobinhoodForwardCursor(cursor) || fits(parseRobinhoodActivityCursor)) modes.push("activity");
  return modes;
}

const WALK_BUTTON_LABEL: Record<RobinhoodWalkMode, string> = {
  backfill: "Backfill window",
  registrants: "Fill registrants",
  activity: "Fill activity",
};

/** The persisted position in plain words, for the refusal message. */
function describeRobinhoodPosition(cursor: string | null): string {
  const trimmed = (cursor ?? "").trim();
  if (trimmed === "") return "not started";
  const shown = trimmed.split("#")[0]!;
  if (trimmed.startsWith("bf:")) return trimmed === "bf:done" ? `backfill complete (${shown})` : `backfill in progress (${shown})`;
  if (trimmed.startsWith("rb:")) return trimmed === "rb:done" ? `registrant walk complete (${shown})` : `registrant walk in progress (${shown})`;
  if (trimmed.startsWith("ac:")) return trimmed === "ac:done" ? `activity walk complete (${shown})` : `activity walk in progress (${shown})`;
  if (trimmed.startsWith("fw:")) return `forward walk (${shown})`;
  return `not an approved walk position (${shown})`;
}

/**
 * Throws when a walk mode cannot run from the persisted cursor. The
 * orchestrator calls it for operator clicks before it opens a run, so a click
 * the position cannot honor (a backfill after `bf:done`, a registrant fill on
 * the forward walk) is refused outright instead of recording a failed run and
 * raising the source's failure count for something that was never a fault.
 * The adapter keeps its own parse as a second line of defense. Observe mode
 * always fits. Pure; never touches the network.
 */
export function assertRobinhoodModeFitsCursor(cursor: string | null, mode: "observe" | RobinhoodWalkMode): void {
  if (mode === "observe") return;
  const runnable = robinhoodWalkModesForCursor(cursor);
  if (runnable.includes(mode)) return;
  const position = describeRobinhoodPosition(cursor);
  throw new RobinhoodWalkModeRefusedError(
    runnable.length === 0
      ? `${WALK_BUTTON_LABEL[mode]} cannot run: the stored cursor is ${position}, so no walk can run from it.`
      : `${WALK_BUTTON_LABEL[mode]} cannot run from the current position, ${position}. ${runnable.map(item => WALK_BUTTON_LABEL[item]).join(" or ")} can run from here.`
  );
}

/**
 * The one bounded window a forward run may scan: one block past the anchor up
 * to the per-run budget, never past the chain head minus the finality margin.
 * A `toBlock` below `fromBlock` means the walk is caught up. Pure; never
 * touches the network.
 */
export function robinhoodForwardWindowBounds(anchorBlock: number, headBlock: number): { fromBlock: number; toBlock: number } {
  if (!Number.isSafeInteger(anchorBlock) || anchorBlock < 1 || !Number.isSafeInteger(headBlock) || headBlock < anchorBlock) {
    throw new RobinhoodRegistryValidationError("Forward-walk window bounds are not chain-consistent.");
  }
  return {
    fromBlock: anchorBlock + 1,
    toBlock: Math.min(headBlock - ROBINHOOD_FORWARD_FINALITY_MARGIN_BLOCKS, anchorBlock + ROBINHOOD_FORWARD_WINDOW_BLOCKS),
  };
}

/**
 * Narrows a too-dense forward window to its oldest half — the mirror of the
 * backward split, so the run scans the fetchable oldest range and the anchor
 * advances to its top: the next run resumes exactly where this one stopped
 * and no block is ever skipped. Pure; never touches the network.
 */
export function splitForwardWindow(fromBlock: number, toBlock: number): { fromBlock: number; toBlock: number } {
  if (toBlock <= fromBlock) {
    throw new RobinhoodRegistryValidationError("A single-block forward window cannot be narrowed further.");
  }
  const half = fromBlock + Math.floor((toBlock - fromBlock + 1) / 2);
  return { fromBlock, toBlock: half - 1 };
}

/**
 * Narrows a too-dense backfill window to its newest half. The run scans only
 * the narrowed range and the persisted cursor resumes just below it, so the
 * next window re-tiles the skipped older half — no block of chain history is
 * ever jumped over. Pure; never touches the network.
 */
export function splitBackfillWindow(fromBlock: number, toBlock: number): { fromBlock: number; toBlock: number } {
  if (toBlock <= fromBlock) {
    throw new RobinhoodRegistryValidationError("A single-block backfill window cannot be narrowed further.");
  }
  const half = fromBlock + Math.floor((toBlock - fromBlock + 1) / 2);
  return { fromBlock: half, toBlock };
}

type JsonRpcResponse = { result?: unknown; error?: { code?: unknown; message?: unknown } };

export async function callRobinhoodRpc(
  body: Record<string, unknown>,
  countAttempt?: () => void,
  backoffMs: readonly number[] = RPC_RETRY_BACKOFF_MS
): Promise<JsonRpcResponse> {
  // The Cloudflare-fronted edge throttles rapid bursts with transient 403/429
  // and intermittently blocks the calling IP for minutes, so the bounded
  // ladder waits a block out (~2 minutes across five steps) before the run
  // fails. That is for the manual Robinhood adapters, which have no tick to
  // hold up; the scheduled walk passes SCHEDULED_RPC_RETRY_BACKOFF_MS, so a
  // block that outlasts a few seconds ends its run and the next tick tries
  // again. Every wire attempt is reported back so the run's request count
  // stays honest.
  for (let attempt = 0; ; attempt += 1) {
    countAttempt?.();
    try {
      return await callRobinhoodRpcOnce(body);
    } catch (error) {
      if (
        attempt >= backoffMs.length ||
        !(error instanceof RobinhoodRegistryHttpError) ||
        !TRANSIENT_RPC_HTTP_STATUSES.has(error.status)
      ) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, backoffMs[attempt]));
    }
  }
}

/** One attempt, no retry ladder: for a caller that must not wait out a throttle (the worker's name step). */
export async function callRobinhoodRpcOnce(body: Record<string, unknown>): Promise<JsonRpcResponse> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(ROBINHOOD_RPC_URL, {
      method: "POST",
      redirect: "error",
      signal: timeout.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Nooscape-Source-Indexer/0.3 (+https://nooscape.si)",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    });
    if (!response.ok) throw new RobinhoodRegistryHttpError(response.status, `Robinhood Chain RPC returned HTTP ${response.status}.`);
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new RobinhoodRegistryValidationError("Robinhood Chain RPC did not declare a JSON response.");
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new RobinhoodRegistryResponseTooLargeError("Robinhood Chain RPC response exceeds the 4 MiB response limit.");
    }
    // The body read stays under the armed timer: a stalled body aborts exactly
    // like the header phase, so a node that answers headers and then trickles
    // bytes cannot hang a walk step.
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new RobinhoodRegistryResponseTooLargeError("Robinhood Chain RPC response exceeds the 4 MiB response limit.");
    }
    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new RobinhoodRegistryValidationError("Robinhood Chain RPC response was not valid JSON.");
    }
  } catch (error) {
    // All three domain errors extend RobinhoodRegistryValidationError; one
    // instanceof pass preserves the specific verdict.
    if (error instanceof RobinhoodRegistryValidationError) throw error;
    if (timeout.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new RobinhoodRegistryValidationError("Robinhood Chain RPC request timed out.");
    }
    throw new RobinhoodRegistryValidationError("Robinhood Chain RPC request failed without following redirects.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads one block's hash for the forward walk's anchor: a seed resolves the
 * ledger high-water's hash, every later run re-checks the stored anchor
 * before scanning (the reorg stop), and the new position's hash is read after
 * a successful window. Hash case is normalized so comparisons are exact.
 * Shared with the reputation adapter's forward walk.
 */
export async function fetchRobinhoodBlockHash(blockNumber: number, countAttempt?: () => void, backoffMs?: readonly number[]): Promise<string> {
  const response = await callRobinhoodRpc(
    { method: "eth_getBlockByNumber", params: [`0x${blockNumber.toString(16)}`, false] },
    countAttempt,
    backoffMs
  );
  if (response.error || typeof response.result !== "object" || response.result === null) {
    throw new RobinhoodRegistryValidationError(`Robinhood Chain RPC did not return block ${blockNumber} for the forward-walk anchor.`);
  }
  const hash = (response.result as { hash?: unknown }).hash;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new RobinhoodRegistryValidationError(`Robinhood Chain RPC returned no usable hash for forward-walk anchor block ${blockNumber}.`);
  }
  return hash.toLowerCase();
}

/**
 * Reads exactly one bounded block window of `Registered` events from the approved
 * Robinhood Chain ERC-8004 identity registry: chain check, head, filtered
 * `eth_getLogs`. It never calls per-agent methods, dereferences an agent URI,
 * queries wallet state, or submits a transaction. Observe mode scans the
 * newest window for reviewed intake; backfill mode walks one older window per
 * run, resuming from the persisted `bf:` cursor, and produces directory
 * acknowledgements only — a backfill run can never feed the reviewed spine.
 * Registrants mode repeats the same backward walk under the `rb:` cursor to
 * fill registering wallets into already-acknowledged entries; it is equally
 * directory-only. Activity mode walks one older window of Transfer and
 * URIUpdated events per run under the `ac:` cursor (seeded only from a
 * finished registrant walk), acknowledging ownership changes into the
 * activity ledger — counts of hand-outs and changes of hands, never operator
 * identity. Once that walk completes (`ac:done`), the same mode continues as
 * a bounded, reorg-checked forward walk under the `fw:` cursor — one window
 * per run up to the finality margin, also scanning Registered so agents
 * registering in the tail are acknowledged and measured in the same pass.
 * A walk window denser than its bounds (a mass-registration
 * burst) is narrowed to its newest fetchable half until the response fits;
 * the extra `eth_getLogs` calls stay inside the same read-only scope.
 */
export async function fetchRobinhoodRegistry(
  source: IngestionSource,
  options: {
    mode?: "observe" | "backfill" | "registrants" | "activity";
    /** The activity ledger's high-water block — the forward walk's seed anchor. */
    activityHighWaterBlock?: number | null;
    /** How long a throttled call is waited out: "patient" (the default) for an operator's run, "short" for the scheduled walk. */
    retry?: "patient" | "short";
  } = {}
) {
  if (source.protocol !== "erc8004" || source.sourceKey !== "robinhood-erc8004-identity-registry") {
    throw new RobinhoodRegistryValidationError("Source is not the approved Robinhood ERC-8004 identity registry.");
  }
  if (source.state !== "active") throw new RobinhoodRegistryValidationError("Only active sources may be fetched.");
  if (source.rootUrl !== ROBINHOOD_RPC_URL || source.allowedHostname !== "rpc.mainnet.chain.robinhood.com") {
    throw new RobinhoodRegistryValidationError("Stored Robinhood source policy does not match the approved RPC endpoint.");
  }
  await assertPublicHostname(source.allowedHostname);

  const mode = options.mode ?? "observe";
  let requestCount = 0;
  const countRpcAttempt = () => {
    requestCount += 1;
  };
  const backoffMs = options.retry === "short" ? SCHEDULED_RPC_RETRY_BACKOFF_MS : RPC_RETRY_BACKOFF_MS;
  const chain = await callRobinhoodRpc({ method: "eth_chainId", params: [] }, countRpcAttempt, backoffMs);
  if (chain.error || chain.result !== ROBINHOOD_CHAIN_ID_HEX) {
    throw new RobinhoodRegistryValidationError("Robinhood Chain RPC did not confirm the approved chain id 4663.");
  }

  const headResponse = await callRobinhoodRpc({ method: "eth_blockNumber", params: [] }, countRpcAttempt, backoffMs);
  const headBlock = typeof headResponse.result === "string" ? Number.parseInt(headResponse.result.slice(2), 16) : Number.NaN;
  if (!Number.isSafeInteger(headBlock)) throw new RobinhoodRegistryValidationError("Robinhood Chain RPC did not return a valid head block.");

  let toBlock: number;
  let fromBlock: number;
  let walkCursor: string | null = null;
  // Forward territory resolves before the backward parses: `ac:done` and
  // `fw:` positions continue the activity walk forward (the flow after the
  // fetch helpers below), so the ordered progression stays intact while the
  // operator surface — one activity run button — stays unchanged.
  const forwardCursor = mode === "activity" ? tryParseRobinhoodForwardCursor(source.cursor) : null;
  if ((mode === "backfill" || mode === "registrants" || mode === "activity") && !forwardCursor) {
    const cursor =
      mode === "backfill"
        ? parseRobinhoodBackfillCursor(source.cursor)
        : mode === "registrants"
          ? parseRobinhoodRegistrantCursor(source.cursor)
          : parseRobinhoodActivityCursor(source.cursor);
    if (cursor.mode === "done") {
      throw new RobinhoodRegistryValidationError(
        mode === "backfill"
          ? "The Robinhood registry backfill already reached genesis; no older window remains."
          : mode === "registrants"
            ? "The Robinhood registry registrant walk already reached genesis; no older window remains."
            : "The Robinhood registry activity walk already reached genesis; no older window remains."
      );
    }
    // Seed exactly one block below the observed newest window so the walk tiles
    // backward with no overlap; resume from the persisted position otherwise.
    toBlock = cursor.mode === "seed" ? headBlock - FINALITY_MARGIN_BLOCKS - SCAN_WINDOW_BLOCKS - 1 : cursor.toBlock;
    fromBlock = Math.max(1, toBlock - SCAN_WINDOW_BLOCKS);
  } else {
    toBlock = headBlock - FINALITY_MARGIN_BLOCKS;
    fromBlock = toBlock - SCAN_WINDOW_BLOCKS;
  }

  const fetchRegistryLogs = async (scanFrom: number, scanTo: number, topics: string[] | string[][]) => {
    const logsResponse = await callRobinhoodRpc(
      {
        method: "eth_getLogs",
        params: [
          {
            address: ROBINHOOD_IDENTITY_REGISTRY,
            fromBlock: `0x${scanFrom.toString(16)}`,
            toBlock: `0x${scanTo.toString(16)}`,
            topics,
          },
        ],
      },
      countRpcAttempt,
      backoffMs
    );
    if (logsResponse.error) {
      // The public node enforces its own window caps (block range per filter
      // shape, result counts) as JSON-RPC errors, e.g. "only 100000 blocks are
      // allowed for this request". Walk modes treat those exactly like the
      // 4 MiB transport cap: a narrowable window, never a hard walk failure.
      const detail = typeof logsResponse.error.message === "string" ? ` ${logsResponse.error.message}` : "";
      throw new RobinhoodRegistryResponseTooLargeError(`Robinhood Chain RPC rejected the bounded log window.${detail}`);
    }
    return logsResponse.result;
  };
  const fetchRegisteredLogs = async (scanFrom: number, scanTo: number) => fetchRegistryLogs(scanFrom, scanTo, [ROBINHOOD_REGISTERED_TOPIC]);
  // Activity windows watch both event kinds, but the public node grants its
  // wide block range only to single-value topic filters ("send one value per
  // position"; the 2026-10-10 walk proved the OR filter is capped at 100k
  // blocks), so the two kinds ride two bounded calls and merge before parsing.
  const fetchActivityLogs = async (scanFrom: number, scanTo: number) => {
    const transfers = await fetchRegistryLogs(scanFrom, scanTo, [ROBINHOOD_TRANSFER_TOPIC]);
    const uriUpdates = await fetchRegistryLogs(scanFrom, scanTo, [ROBINHOOD_URI_UPDATED_TOPIC]);
    if (!Array.isArray(transfers) || !Array.isArray(uriUpdates)) {
      throw new RobinhoodRegistryValidationError("Robinhood Chain RPC activity response was not a log array.");
    }
    return transfers.concat(uriUpdates);
  };

  if (forwardCursor) {
    // Resolve the anchor before scanning: a seed reads the ledger high-water's
    // hash so `fw:<hw>#<hash>` is persisted in this same run, and a stored
    // anchor must still hash to the stored value on the live chain — otherwise
    // the walk stops loudly instead of building on reorganized history
    // (docs/forward-cursor-2026-10-10.md §3).
    let anchorBlock: number;
    let anchorHash: string;
    if (forwardCursor.mode === "seed") {
      const highWater = options.activityHighWaterBlock;
      if (!highWater) {
        throw new RobinhoodRegistryValidationError(
          "The forward walk seeds from the activity ledger's high-water block, but no measured block exists for this source."
        );
      }
      anchorBlock = highWater;
      anchorHash = await fetchRobinhoodBlockHash(anchorBlock, countRpcAttempt, backoffMs);
    } else {
      anchorBlock = forwardCursor.block;
      anchorHash = forwardCursor.blockHash;
      const liveHash = await fetchRobinhoodBlockHash(anchorBlock, countRpcAttempt, backoffMs);
      if (liveHash !== anchorHash) {
        throw new RobinhoodRegistryReorgError(
          `Forward-walk anchor reorg: block ${anchorBlock} now hashes to ${liveHash}, not the anchored ${anchorHash}. ` +
            "The walk is paused and the cursor is untouched; rewind to the common ancestor per the runbook, set fw:<ancestor>#<hash>, " +
            "and the next run replays the window idempotently."
        );
      }
    }

    const bounds = robinhoodForwardWindowBounds(anchorBlock, headBlock);
    if (bounds.toBlock < bounds.fromBlock) {
      // Caught up to the finality margin: an honest zero-event run that keeps
      // the anchor instead of pretending to advance.
      return {
        discoveredCount: 0,
        rejectedCount: 0,
        entries: [] as Array<{ candidate: Erc8004RegistryCandidate; log: RawRegisteredLog }>,
        directory: [] as DirectoryEntryDraft[],
        activity: [] as DirectoryChainActivityEvent[],
        observations: [] as Array<{ candidate: Erc8004RegistryCandidate; observation: RawObservationInput }>,
        requestCount,
        walkCursor: robinhoodForwardCursorAfter(anchorBlock, anchorHash),
      };
    }

    // One bounded window per run: Registered closes the ack/mint tail while
    // Transfer and URIUpdated keep the ledger current. Density narrows the
    // scan to the oldest fetchable half — the mirror of the backward walk —
    // so the anchor always advances to the top of what this run truly scanned
    // and no block is ever skipped.
    let scannedFrom = bounds.fromBlock;
    let scannedTo = bounds.toBlock;
    let registeredLogs: unknown;
    let activityLogs: unknown;
    let eventLimit = ROBINHOOD_MAX_BACKFILL_EVENTS;
    for (let splits = 0; ; splits += 1) {
      if (splits > MAX_BACKFILL_WINDOW_SPLITS) {
        throw new RobinhoodRegistryValidationError(
          `Forward walk could not narrow block window ${scannedFrom}-${scannedTo} to a fetchable sub-window within ${MAX_BACKFILL_WINDOW_SPLITS} splits.`
        );
      }
      try {
        registeredLogs = await fetchRegisteredLogs(scannedFrom, scannedTo);
        activityLogs = await fetchActivityLogs(scannedFrom, scannedTo);
      } catch (error) {
        if (!(error instanceof RobinhoodRegistryResponseTooLargeError)) throw error;
        if (scannedTo - scannedFrom < 1) {
          throw new RobinhoodRegistryValidationError(
            `Robinhood Chain block ${scannedTo} alone cannot be fetched within the RPC's response limits; the public RPC cannot serve this forward window.`
          );
        }
        scannedTo = splitForwardWindow(scannedFrom, scannedTo).toBlock;
        continue;
      }
      eventLimit =
        scannedFrom === bounds.fromBlock && scannedTo === bounds.toBlock ? ROBINHOOD_MAX_BACKFILL_EVENTS : ROBINHOOD_MAX_BACKFILL_SUBWINDOW_EVENTS;
      const totalEvents =
        (Array.isArray(registeredLogs) ? registeredLogs.length : 0) + (Array.isArray(activityLogs) ? activityLogs.length : 0);
      if (totalEvents > eventLimit && scannedTo - scannedFrom >= 1) {
        scannedTo = splitForwardWindow(scannedFrom, scannedTo).toBlock;
        continue;
      }
      break;
    }

    const scannedWindow = { fromBlock: scannedFrom, toBlock: scannedTo };
    const registeredSnapshot = parseRobinhoodRegisteredLogs(registeredLogs, scannedWindow, {
      backfill: true,
      backfillEventLimit: eventLimit,
    });
    const activitySnapshot = parseRobinhoodActivityLogs(activityLogs, scannedWindow, { activityEventLimit: eventLimit });
    const topHash = await fetchRobinhoodBlockHash(scannedTo, countRpcAttempt, backoffMs);
    return {
      discoveredCount: registeredSnapshot.discoveredCount + activitySnapshot.discoveredCount,
      rejectedCount: registeredSnapshot.rejectedCount + activitySnapshot.rejectedCount,
      entries: [] as Array<{ candidate: Erc8004RegistryCandidate; log: RawRegisteredLog }>,
      directory: registeredSnapshot.directory,
      activity: activitySnapshot.activity,
      observations: [] as Array<{ candidate: Erc8004RegistryCandidate; observation: RawObservationInput }>,
      requestCount,
      walkCursor: robinhoodForwardCursorAfter(scannedTo, topHash),
    };
  }

  let scannedFrom = fromBlock;
  let scannedTo = toBlock;
  let scannedLogs: unknown;
  let backfillEventLimit = ROBINHOOD_MAX_BACKFILL_EVENTS;
  if (mode === "backfill" || mode === "registrants" || mode === "activity") {
    // A mass-registration burst can pack a 2M-block window past the 4 MiB
    // transport cap, the node's own range/result caps, and the 2,000-event
    // full-window budget (the 2026-10-09 walk stalled on a 5,725-event /
    // 4.33 MB window). Narrow the window to its newest fetchable half
    // whenever any limit trips; the cursor resumes just below the scanned
    // sub-window, so the walk crosses the burst over a few runs without
    // skipping a single block.
    for (let splits = 0; ; splits += 1) {
      if (splits > MAX_BACKFILL_WINDOW_SPLITS) {
        throw new RobinhoodRegistryValidationError(
          `Registry backfill could not narrow block window ${fromBlock}-${toBlock} to a fetchable sub-window within ${MAX_BACKFILL_WINDOW_SPLITS} splits.`
        );
      }
      try {
        scannedLogs = await (mode === "activity" ? fetchActivityLogs(scannedFrom, scannedTo) : fetchRegisteredLogs(scannedFrom, scannedTo));
      } catch (error) {
        if (!(error instanceof RobinhoodRegistryResponseTooLargeError)) throw error;
        if (scannedTo - scannedFrom < 1) {
          throw new RobinhoodRegistryValidationError(
            `Robinhood Chain block ${scannedTo} alone cannot be fetched within the RPC's response limits; the public RPC cannot serve this burst window.`
          );
        }
        scannedFrom = splitBackfillWindow(scannedFrom, scannedTo).fromBlock;
        continue;
      }
      backfillEventLimit =
        scannedFrom === fromBlock && scannedTo === toBlock ? ROBINHOOD_MAX_BACKFILL_EVENTS : ROBINHOOD_MAX_BACKFILL_SUBWINDOW_EVENTS;
      if (Array.isArray(scannedLogs) && scannedLogs.length > backfillEventLimit && scannedTo - scannedFrom >= 1) {
        scannedFrom = splitBackfillWindow(scannedFrom, scannedTo).fromBlock;
        continue;
      }
      break;
    }
    walkCursor =
      mode === "registrants"
        ? robinhoodRegistrantCursorAfter(scannedFrom)
        : mode === "activity"
          ? robinhoodActivityCursorAfter(scannedFrom)
          : robinhoodBackfillCursorAfter(scannedFrom);
  } else {
    scannedLogs = await fetchRegisteredLogs(fromBlock, toBlock);
  }

  if (mode === "activity") {
    const activitySnapshot = parseRobinhoodActivityLogs(
      scannedLogs,
      { fromBlock: scannedFrom, toBlock: scannedTo },
      { activityEventLimit: backfillEventLimit }
    );
    // Activity runs are ledger acknowledgements: no observation is retained
    // through the reviewed-evidence pipeline and no directory draft is
    // produced — the ledger rows themselves are the retained chain facts.
    return {
      discoveredCount: activitySnapshot.discoveredCount,
      rejectedCount: activitySnapshot.rejectedCount,
      entries: [] as Array<{ candidate: Erc8004RegistryCandidate; log: RawRegisteredLog }>,
      directory: [] as DirectoryEntryDraft[],
      activity: activitySnapshot.activity,
      observations: [] as Array<{ candidate: Erc8004RegistryCandidate; observation: RawObservationInput }>,
      requestCount,
      walkCursor,
    };
  }

  const snapshot = parseRobinhoodRegisteredLogs(
    scannedLogs,
    { fromBlock: scannedFrom, toBlock: scannedTo },
    mode === "backfill" || mode === "registrants" ? { backfill: true, backfillEventLimit } : {}
  );
  const observedAt = new Date();
  const observations: Array<{ candidate: Erc8004RegistryCandidate; observation: RawObservationInput }> = [];
  for (const entry of snapshot.entries) {
    const retainedText = JSON.stringify({
      chainId: 4663,
      registryAddress: ROBINHOOD_IDENTITY_REGISTRY,
      window: { fromBlock: scannedFrom, toBlock: scannedTo, headBlock },
      log: entry.log,
    });
    const contentHash = createHash("sha256").update(retainedText).digest("hex");
    const stored = await storagePut(`nooscape/raw/erc8004/${source.id}/${contentHash}.json`, retainedText, "application/json");
    observations.push({
      candidate: entry.candidate,
      observation: {
        canonicalLocator: `eip155:4663:${ROBINHOOD_IDENTITY_REGISTRY}/tx/${entry.candidate.transactionHash}/log/${entry.candidate.logIndex}`,
        contentHash,
        rawObjectKey: stored.key,
        contentType: "application/json",
        httpStatus: 200,
        validationStatus: "valid",
        validationFindings: [
          `Bounded Robinhood Chain ERC-8004 Registered event retained from the ${SCAN_WINDOW_BLOCKS.toLocaleString("en-US")} block window ${scannedFrom}-${scannedTo} (head ${headBlock}).`,
          "Nooscape did not dereference the agent URI, call ownerOf or tokenURI, access a wallet, or submit a transaction.",
          ...entry.candidate.sourceSignals,
        ],
        observedAt,
      },
    });
  }
  return { ...snapshot, activity: [] as DirectoryChainActivityEvent[], observations, requestCount, walkCursor };
}
