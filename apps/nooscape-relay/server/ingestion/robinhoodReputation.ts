import { createHash } from "node:crypto";
import { storagePut } from "../storage";
import { assertPublicHostname } from "./a2a";
import type { IngestionSource } from "../../drizzle/schema";
import {
  callRobinhoodRpc,
  fetchRobinhoodBlockHash,
  hexToSafeInteger,
  parseRobinhoodForwardCursor,
  robinhoodForwardCursorAfter,
  robinhoodForwardWindowBounds,
  ROBINHOOD_CHAIN_ID_HEX,
  ROBINHOOD_FORWARD_FINALITY_MARGIN_BLOCKS,
  ROBINHOOD_MAX_BACKFILL_EVENTS,
  ROBINHOOD_MAX_BACKFILL_SUBWINDOW_EVENTS,
  RobinhoodRegistryReorgError,
  RobinhoodRegistryResponseTooLargeError,
  RobinhoodRegistryValidationError,
  RobinhoodWalkModeRefusedError,
  ROBINHOOD_RPC_URL,
  splitBackfillWindow,
  splitForwardWindow,
} from "./robinhood";
import type { Erc8004ReputationEvent } from "./types";

/**
 * The Robinhood Chain ERC-8004 Reputation Registry (phase 3c-ii). The proxy
 * sits at the standard ERC-8004 reputation address; the ERC-1967
 * implementation slot was read on-chain (2026-10-11) and pins the deployment
 * every layout constant below was verified against
 * (docs/reputation-ingest-2026-10-11.md §1).
 */
export const ROBINHOOD_REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
export const ROBINHOOD_REPUTATION_IMPL = "0x16e0fa7f7c56b9a767e34b192b51f921be31da34";
/** Canonical EIP-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
export const ROBINHOOD_REPUTATION_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
/** keccak("NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,bytes32)") — read from live logs 2026-10-11. */
export const ROBINHOOD_NEW_FEEDBACK_TOPIC = "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc";
/** keccak("FeedbackRevoked(uint256,address,uint64)") — read from live logs 2026-10-11. */
export const ROBINHOOD_FEEDBACK_REVOKED_TOPIC = "0x25156fd3288212246d8b008d5921fde376c71ed14ac2e072a506eb06fde6d09d";
/**
 * keccak("ResponseAppended(uint256,address,uint64,address,string,bytes32)") —
 * the EIP-8004 reply event, hash-verified 2026-10-11 against two independent
 * signature databases (4byte.directory and openchain) against the exact
 * canonical signature the decoder below pins. Never observed live on this
 * registry yet — it is whitelisted before the first occurrence so a reply
 * cannot halt the ratings walk; if the deployed contract deviates from the
 * canonical signature, the unknown-topic tripwire still fires.
 */
export const ROBINHOOD_RESPONSE_APPENDED_TOPIC = "0xb1c6be0b5b8aef6539e2fac0fd131a2faa7b49edf8e505b5eb0ad487d56051d4";
/**
 * Proxy lifecycle topics (ERC-1967 deploy/upgrade noise), verified from the
 * proxy's own transactions: birth at block 12,058,837 (tx 0x76b048b3…36af —
 * Upgraded to first implementation 0xcb7af40c…f067, constructor
 * OwnershipTransferred zero→0x547289…2603, Initialized) and upgrade #1 at
 * block 30,786,790 (tx 0x1ad2c9bd…7c5 — Upgraded to 0xee43505b…ea4e plus a
 * re-Initialized). The address-only window fetch inevitably sweeps these up,
 * so they are recognized and skipped — never ingested, never fatal. A real
 * upgrade still stops the walk before any scan: the implementation-slot
 * check runs first and pins 0x16e0fa7f…da34.
 */
export const ROBINHOOD_REPUTATION_LIFECYCLE_TOPICS: ReadonlySet<string> = new Set([
  "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b", // keccak("Upgraded(address)")
  "0xc7f505b2f371ae2175ee4913f4499e1f2633a7b5936321eed1cdaeb6115181d2", // keccak("Initialized(uint64)")
  "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0", // keccak("OwnershipTransferred(address,address)")
]);

/**
 * Stored-string bound for untrusted dynamic text (operator bound #3): each
 * string is capped at 512 characters with an explicit truncation marker; the
 * full value lives only in the retained raw-log batch. The headroom subtracts
 * the marker so the capped result always fits the varchar(512) ledger column.
 */
export const MAX_REPUTATION_STRING_CHARS = 512;
const REPUTATION_STRING_TRUNCATION_MARKER = "[truncated]";
/** Decode bound for one ABI string argument, matching the identity adapter's 64 KiB view bound. */
const MAX_REPUTATION_ABI_STRING_BYTES = 65_536;

/** One backward window per run, mirroring the identity backfill cadence. */
const REPUTATION_SCAN_WINDOW_BLOCKS = 2_000_000;
/**
 * The backward seed's distance below head. The reputation walk starts from
 * the newest finality-safe window (nothing has been scanned before it), so
 * unlike the identity backfill — which seeded below an already-scanned newest
 * window — this is the same margin the forward walk keeps.
 */
const REPUTATION_SEED_FINALITY_BLOCKS = ROBINHOOD_FORWARD_FINALITY_MARGIN_BLOCKS;
/** Halvings from a 2M-block window down to a single block (21) plus headroom. */
const MAX_REPUTATION_WINDOW_SPLITS = 24;

const UINT64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const INT128_SIGN_BIT = BigInt(1) << BigInt(127);
const INT128_MODULUS = BigInt(1) << BigInt(128);

/**
 * A log from the approved reputation proxy whose topic0 is neither a
 * wire-verified event hash nor a known proxy-lifecycle topic. Deliberately a
 * loud stop, never a skipped row:
 * at this address an unknown topic is how an upgrade — or an event layout
 * this adapter has not verified — announces itself. The error carries the
 * block and transaction so the exact log can be pulled from a block explorer,
 * the layout verified, and the topic whitelisted deliberately.
 */
export class RobinhoodReputationUnknownEventError extends RobinhoodRegistryValidationError {
  readonly topic0: string;
  readonly blockNumber: number | null;
  readonly transactionHash: string | null;

  constructor(topic0: string, blockNumber: number | null, transactionHash: string | null) {
    super(
      `Reputation registry emitted an unknown event topic ${topic0}` +
        `${blockNumber === null ? "" : ` at block ${blockNumber}`}` +
        `${transactionHash === null ? "" : ` (tx ${transactionHash})`}. ` +
        "This is either an event layout this adapter has not verified (stop; pull the log from a block explorer, verify the layout, then whitelist the verified topic) " +
        "or a proxy upgrade (stop; re-verify every layout before resuming). The run failed closed and the cursor is untouched."
    );
    this.name = "RobinhoodReputationUnknownEventError";
    this.topic0 = topic0;
    this.blockNumber = blockNumber;
    this.transactionHash = transactionHash;
  }
}

type RawRegistryLog = Record<string, unknown>;

function asReputationLog(log: unknown): RawRegistryLog | null {
  if (!log || typeof log !== "object" || Array.isArray(log)) return null;
  return log as RawRegistryLog;
}

function reputationLogAddress(log: RawRegistryLog): string | null {
  return typeof log.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(log.address) ? log.address.toLowerCase() : null;
}

function reputationLogTopics(log: RawRegistryLog): string[] | null {
  const topics = log.topics;
  if (!Array.isArray(topics)) return null;
  for (const topic of topics) {
    if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  }
  return topics as string[];
}

function reputationLogRemoved(log: RawRegistryLog): boolean {
  return log.removed === true;
}

function isApprovedReputationLog(log: RawRegistryLog): boolean {
  return reputationLogAddress(log) === ROBINHOOD_REPUTATION_REGISTRY.toLowerCase();
}

/** Lowercase 20-byte address from one 32-byte indexed topic word. */
function addressFromTopic(topic: string): string {
  return `0x${topic.slice(26).toLowerCase()}`;
}

/**
 * uint256-as-decimal for indexed token ids, bounded to the ledger's BIGINT
 * storage: ids beyond the safe-integer range are rejected at decode (counted,
 * never silently truncated). Ids are small today; the bound keeps a future
 * large id from corrupting the ledger rather than failing a read.
 */
function boundedUint256Decimal(topic: string): string | null {
  try {
    const parsed = BigInt(topic);
    if (parsed < BigInt(0) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * uint64-as-number for the per-pair feedback counter (emitted by every event
 * kind), bounded the same way: a counter beyond the safe-integer range cannot
 * be stored exactly and is rejected at decode.
 */
function boundedUint64Number(word: bigint): number | null {
  if (word < BigInt(0) || word > UINT64_MAX) return null;
  const value = Number(word);
  return Number.isSafeInteger(value) ? value : null;
}

/** Exact decimal string of one int128 data word (two's complement). Never a float. */
function int128Decimal(word: bigint): string {
  return (word >= INT128_SIGN_BIT ? word - INT128_MODULUS : word).toString();
}

function capReputationString(value: string): string {
  return value.length > MAX_REPUTATION_STRING_CHARS
    ? value.slice(0, MAX_REPUTATION_STRING_CHARS - REPUTATION_STRING_TRUNCATION_MARKER.length) + REPUTATION_STRING_TRUNCATION_MARKER
    : value;
}

/** Shared wire fields every reputation event carries in its topics: agent, client, position. */
function decodedReputationLogHeader(
  entry: RawRegistryLog,
  topics: string[],
  bounds: { fromBlock: number; toBlock: number }
): { agentId: string; clientAddress: string; blockNumber: number; logIndex: number; transactionHash: string } | null {
  const agentId = boundedUint256Decimal(topics[1]!);
  if (agentId === null) return null;
  const blockNumber = hexToSafeInteger(entry.blockNumber);
  const logIndex = hexToSafeInteger(entry.logIndex);
  if (blockNumber === null || blockNumber < bounds.fromBlock || blockNumber > bounds.toBlock) return null;
  if (logIndex === null) return null;
  if (typeof entry.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(entry.transactionHash)) return null;
  return {
    agentId,
    clientAddress: addressFromTopic(topics[2]!),
    blockNumber,
    logIndex,
    transactionHash: entry.transactionHash,
  };
}

/** Splits raw event data into 32-byte words; null unless whole words are present. */
function dataWords(data: string): string[] | null {
  if (!/^0x[0-9a-fA-F]*$/.test(data)) return null;
  const hex = data.slice(2);
  if (hex.length === 0 || hex.length % 64 !== 0) return null;
  const words: string[] = [];
  for (let offset = 0; offset < hex.length; offset += 64) words.push(hex.slice(offset, offset + 64).toLowerCase());
  return words;
}

/** One ABI dynamic string at a byte offset inside the data blob; null when the layout is impossible. */
function abiStringAt(hex: string, byteOffset: number): string | null {
  const at = byteOffset * 2;
  const lengthHex = hex.slice(at, at + 64);
  if (lengthHex.length !== 64) return null;
  const byteLength = Number(BigInt(`0x${lengthHex}`));
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_REPUTATION_ABI_STRING_BYTES) return null;
  const valueHex = hex.slice(at + 64, at + 64 + byteLength * 2);
  if (valueHex.length < byteLength * 2) return null;
  return Buffer.from(valueHex, "hex").toString("utf8");
}

/**
 * Decodes one `NewFeedback(uint256 indexed agentId, address indexed
 * clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals,
 * string indexed indexedTag1, string tag1, string tag2, string endpoint,
 * string feedbackURI, bytes32 feedbackHash)` log — the wire-verified
 * deployed layout (2026-10-11 live sample: head words
 * `[index=1, value=0, decimals=6, offsets 256/320/384/416, hash]`, matching
 * the rater's own inline proof). The indexed tag hash (topics[3]) is the
 * keccak of tag1; the tag text itself is read from the data strings. Returns
 * null for anything that does not match the approved registry, topic, or
 * bounds; the raw log remains in the retained window batch.
 */
export function decodeNewFeedbackLog(
  log: unknown,
  bounds: { fromBlock: number; toBlock: number }
): Erc8004ReputationEvent | null {
  const entry = asReputationLog(log);
  if (!entry || reputationLogRemoved(entry)) return null;
  if (!isApprovedReputationLog(entry)) return null;
  const topics = reputationLogTopics(entry);
  if (!topics || topics.length !== 4) return null;
  if (topics[0]!.toLowerCase() !== ROBINHOOD_NEW_FEEDBACK_TOPIC) return null;
  const header = decodedReputationLogHeader(entry, topics, bounds);
  if (!header) return null;

  if (typeof entry.data !== "string") return null;
  const words = dataWords(entry.data);
  // Head: feedbackIndex, value, valueDecimals, four string offsets, feedbackHash.
  if (!words || words.length < 8) return null;

  const feedbackIndex = boundedUint64Number(BigInt(`0x${words[0]}`));
  if (feedbackIndex === null) return null;
  const valueRaw = int128Decimal(BigInt(`0x${words[1]}`));
  const decimalsValue = BigInt(`0x${words[2]}`);
  if (decimalsValue < BigInt(0) || decimalsValue > BigInt(255)) return null;
  const valueDecimals = Number(decimalsValue);

  const hex = entry.data.slice(2);
  const dataBytes = hex.length / 2;
  const headWords = 8;
  const offsets: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const raw = BigInt(`0x${words[3 + index]}`);
    if (raw % BigInt(32) !== BigInt(0)) return null;
    const offset = Number(raw);
    if (!Number.isSafeInteger(offset) || offset < headWords * 32 || offset > dataBytes - 32) return null;
    offsets.push(offset);
  }
  if (offsets[0]! >= offsets[1]! || offsets[1]! >= offsets[2]! || offsets[2]! >= offsets[3]!) return null;

  const strings: string[] = [];
  for (const offset of offsets) {
    const decoded = abiStringAt(hex, offset);
    if (decoded === null) return null;
    strings.push(capReputationString(decoded));
  }

  return {
    kind: "new_feedback",
    agentId: header.agentId,
    clientAddress: header.clientAddress,
    blockNumber: header.blockNumber,
    transactionHash: header.transactionHash,
    logIndex: header.logIndex,
    feedbackIndex,
    valueRaw,
    valueDecimals,
    tag1: strings[0]!,
    tag2: strings[1]!,
    endpoint: strings[2]!,
    feedbackUri: strings[3]!,
    feedbackHash: `0x${words[7]}`,
    responderAddress: null,
  };
}

/**
 * Decodes one `FeedbackRevoked(uint256 indexed agentId, address indexed
 * clientAddress, uint64 indexed feedbackIndex)` log (wire-verified 2026-10-11:
 * agent 462, client 0x6138…0a73, index 1, empty data). The revocation joins
 * the exact rating it names via (agentId, clientAddress, feedbackIndex); the
 * rating row itself is never deleted. Returns null for anything that does not
 * match the approved registry, topic, or bounds.
 */
export function decodeFeedbackRevokedLog(
  log: unknown,
  bounds: { fromBlock: number; toBlock: number }
): Erc8004ReputationEvent | null {
  const entry = asReputationLog(log);
  if (!entry || reputationLogRemoved(entry)) return null;
  if (!isApprovedReputationLog(entry)) return null;
  const topics = reputationLogTopics(entry);
  if (!topics || topics.length !== 4) return null;
  if (topics[0]!.toLowerCase() !== ROBINHOOD_FEEDBACK_REVOKED_TOPIC) return null;
  const header = decodedReputationLogHeader(entry, topics, bounds);
  if (!header) return null;
  const feedbackIndex = boundedUint64Number(BigInt(topics[3]!));
  if (feedbackIndex === null) return null;
  return {
    kind: "feedback_revoked",
    agentId: header.agentId,
    clientAddress: header.clientAddress,
    blockNumber: header.blockNumber,
    transactionHash: header.transactionHash,
    logIndex: header.logIndex,
    feedbackIndex,
    valueRaw: null,
    valueDecimals: null,
    tag1: null,
    tag2: null,
    endpoint: null,
    feedbackUri: null,
    feedbackHash: null,
    responderAddress: null,
  };
}

/**
 * Decodes one `ResponseAppended(uint256 indexed agentId, address indexed
 * clientAddress, uint64 indexed feedbackIndex, address indexed responder,
 * string responseURI, bytes32 responseHash)` log per the EIP-8004 text. The
 * event has never been observed on this registry; its topic0 is whitelisted
 * ahead of the first occurrence (signature verified against two independent
 * databases) so a reply cannot halt the ratings walk. responseURI/responseHash
 * have no ledger columns — the retained raw batch is their record.
 */
export function decodeResponseAppendedLog(
  log: unknown,
  bounds: { fromBlock: number; toBlock: number }
): Erc8004ReputationEvent | null {
  const entry = asReputationLog(log);
  if (!entry || reputationLogRemoved(entry)) return null;
  if (!isApprovedReputationLog(entry)) return null;
  const topics = reputationLogTopics(entry);
  // Signature plus four indexed parameters.
  if (!topics || topics.length !== 5) return null;
  const header = decodedReputationLogHeader(entry, topics, bounds);
  if (!header) return null;
  const feedbackIndex = boundedUint64Number(BigInt(topics[3]!));
  if (feedbackIndex === null) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(topics[4]!)) return null;
  return {
    kind: "response_appended",
    agentId: header.agentId,
    clientAddress: header.clientAddress,
    blockNumber: header.blockNumber,
    transactionHash: header.transactionHash,
    logIndex: header.logIndex,
    feedbackIndex,
    valueRaw: null,
    valueDecimals: null,
    tag1: null,
    tag2: null,
    endpoint: null,
    feedbackUri: null,
    feedbackHash: null,
    responderAddress: addressFromTopic(topics[4]!),
  };
}

/**
 * Parses one bounded reputation-window `eth_getLogs` response. Every decodable
 * event is acknowledged into the ratings ledger and nothing enters the
 * reviewed evidence pipeline. Proxy lifecycle topics (deploy/upgrade noise)
 * are recognized and skipped; a proxy log whose topic0 is not one of the
 * three verified event hashes or a known lifecycle topic throws the
 * unknown-event tripwire — a genuinely new event kind announces itself
 * exactly there and may never be silently skipped.
 */
export function parseRobinhoodReputationLogs(
  logs: unknown,
  bounds: { fromBlock: number; toBlock: number },
  options: { eventLimit?: number } = {}
) {
  if (!Array.isArray(logs)) throw new RobinhoodRegistryValidationError("Reputation log response must be an array.");
  const scanLimit = options.eventLimit ?? ROBINHOOD_MAX_BACKFILL_EVENTS;
  if (logs.length > scanLimit) {
    throw new RobinhoodRegistryValidationError(
      `Reputation window response exceeds the approved bounded scan of ${scanLimit} events.`
    );
  }
  const events: Erc8004ReputationEvent[] = [];
  let rejectedCount = 0;
  for (const log of logs) {
    const entry = asReputationLog(log);
    const topic0 = entry ? reputationLogTopics(entry)?.[0]?.toLowerCase() ?? null : null;
    if (entry && topic0 === ROBINHOOD_NEW_FEEDBACK_TOPIC) {
      const event = decodeNewFeedbackLog(entry, bounds);
      if (event) events.push(event);
      else rejectedCount += 1;
      continue;
    }
    if (entry && topic0 === ROBINHOOD_FEEDBACK_REVOKED_TOPIC) {
      const event = decodeFeedbackRevokedLog(entry, bounds);
      if (event) events.push(event);
      else rejectedCount += 1;
      continue;
    }
    if (entry && topic0 === ROBINHOOD_RESPONSE_APPENDED_TOPIC) {
      const event = decodeResponseAppendedLog(entry, bounds);
      if (event) events.push(event);
      else rejectedCount += 1;
      continue;
    }
    if (entry && topic0 !== null && ROBINHOOD_REPUTATION_LIFECYCLE_TOPICS.has(topic0)) {
      // Proxy deploy/upgrade noise swept up by the address-only fetch:
      // recognized, counted, never ingested (see the constant's note).
      rejectedCount += 1;
      continue;
    }
    if (entry && reputationLogRemoved(entry)) {
      // A reorged-out row is neither an event nor a tripwire; counted only.
      rejectedCount += 1;
      continue;
    }
    throw new RobinhoodReputationUnknownEventError(
      topic0 ?? "0x?",
      entry ? hexToSafeInteger(entry.blockNumber) : null,
      entry && typeof entry.transactionHash === "string" ? entry.transactionHash : null
    );
  }
  return { discoveredCount: logs.length, rejectedCount, events };
}

type RobinhoodReputationCursor =
  | { mode: "backward-seed" }
  | { mode: "backward"; toBlock: number }
  | { mode: "forward-seed" }
  | { mode: "forward"; block: number; blockHash: string };

/**
 * Parses the persisted reputation-walk position: `null` seeds the backward
 * walk at the newest finality-safe window, `rb:<block>` resumes backward,
 * `rb:done` hands the walk to the forward mode (seeded from the ratings
 * ledger's high-water block), and `fw:<block>#<hash>` resumes the anchored
 * forward walk — the same cursor shape the identity walk persists, so both
 * share one parser and one operator mental model. Any other cursor fails
 * closed. Pure; never touches the network.
 */
export function parseRobinhoodReputationCursor(cursor: string | null): RobinhoodReputationCursor {
  const trimmed = (cursor ?? "").trim();
  if (trimmed === "") return { mode: "backward-seed" };
  if (trimmed === "rb:done") return { mode: "forward-seed" };
  const backward = /^rb:(\d+)$/.exec(trimmed);
  if (backward) {
    const toBlock = Number.parseInt(backward[1]!, 10);
    if (!Number.isSafeInteger(toBlock) || toBlock < 1) {
      throw new RobinhoodRegistryValidationError("Stored Robinhood reputation-walk position is out of bounds.");
    }
    return { mode: "backward", toBlock };
  }
  try {
    const forward = parseRobinhoodForwardCursor(trimmed);
    if (forward.mode === "anchor") return { mode: "forward", block: forward.block, blockHash: forward.blockHash };
  } catch {
    // Fall through to the rejection below — only rb:/fw: positions are approved here.
  }
  throw new RobinhoodRegistryValidationError("Stored Robinhood cursor is not an approved reputation-walk position.");
}

const REPUTATION_STILL_BACKWARD_MESSAGE =
  "The reputation walk is still backward (rb:); the ratings fill runs only after the backfill reaches genesis (rb:done).";
const REPUTATION_ALREADY_FORWARD_MESSAGE =
  "The reputation backfill already reached genesis (rb:done); continue with the ratings fill (activity) mode.";

/**
 * Throws when the requested mode cannot run from the persisted cursor: a
 * backward position (`null`, `rb:<block>`) runs only the backfill, and a
 * forward position (`rb:done`, `fw:<block>#<hash>`) runs only the ratings
 * fill. The orchestrator calls this before it opens a run, so a click in the
 * wrong mode is refused outright instead of recording a failed run (and a
 * failure count) for something that was never a fault. The adapter keeps its
 * own checks as a second line of defense. Pure; never touches the network.
 */
export function assertReputationModeFitsCursor(cursor: string | null, mode: "backfill" | "activity"): void {
  const position = parseRobinhoodReputationCursor(cursor);
  const backward = position.mode === "backward-seed" || position.mode === "backward";
  if (backward && mode !== "backfill") throw new RobinhoodWalkModeRefusedError(REPUTATION_STILL_BACKWARD_MESSAGE);
  if (!backward && mode !== "activity") throw new RobinhoodWalkModeRefusedError(REPUTATION_ALREADY_FORWARD_MESSAGE);
}

/** Next persisted backward-walk position after scanning a window that starts at fromBlock. */
export function robinhoodReputationBackwardCursorAfter(fromBlock: number): string {
  return fromBlock > 1 ? `rb:${fromBlock - 1}` : "rb:done";
}

type RobinhoodReputationFetchResult = {
  discoveredCount: number;
  rejectedCount: number;
  events: Erc8004ReputationEvent[];
  requestCount: number;
  walkCursor: string;
  /** Content-addressed raw window batch (every non-empty window is auditable); null for empty windows. */
  retainedBatch: { objectKey: string; contentHash: string } | null;
};

/**
 * Reads exactly one bounded block window of Reputation Registry events from
 * the approved Robinhood Chain proxy: chain check, head, implementation-slot
 * tripwire, one address-only `eth_getLogs`. It never calls read methods on
 * the registry, dereferences a feedback URI, or submits a transaction.
 *
 * Backfill mode walks one older window per run under the `rb:` cursor and
 * acknowledges every decodable event into the ratings ledger; once it reaches
 * genesis (`rb:done`) the same surface continues in activity mode as a
 * bounded, reorg-checked forward walk under the `fw:` cursor, seeded from the
 * ledger's high-water block. A window denser than its bounds is narrowed —
 * newest half backward, oldest half forward — until the response fits, so no
 * block of chain history is ever skipped.
 */
export async function fetchRobinhoodReputationRegistry(
  source: IngestionSource,
  options: {
    mode: "backfill" | "activity";
    /** The ratings ledger's high-water block — the forward walk's seed anchor. */
    reputationHighWaterBlock?: number | null;
  }
): Promise<RobinhoodReputationFetchResult> {
  if (source.protocol !== "erc8004_reputation" || source.sourceKey !== "robinhood-erc8004-reputation-registry") {
    throw new RobinhoodRegistryValidationError("Source is not the approved Robinhood ERC-8004 reputation registry.");
  }
  if (source.state !== "active") throw new RobinhoodRegistryValidationError("Only active sources may be fetched.");
  if (source.rootUrl !== ROBINHOOD_RPC_URL || source.allowedHostname !== "rpc.mainnet.chain.robinhood.com") {
    throw new RobinhoodRegistryValidationError("Stored Robinhood reputation source policy does not match the approved RPC endpoint.");
  }
  await assertPublicHostname(source.allowedHostname);

  let requestCount = 0;
  const countRpcAttempt = () => {
    requestCount += 1;
  };

  const chain = await callRobinhoodRpc({ method: "eth_chainId", params: [] }, countRpcAttempt);
  if (chain.error || chain.result !== ROBINHOOD_CHAIN_ID_HEX) {
    throw new RobinhoodRegistryValidationError("Robinhood Chain RPC did not confirm the approved chain id 4663.");
  }

  const headResponse = await callRobinhoodRpc({ method: "eth_blockNumber", params: [] }, countRpcAttempt);
  const headBlock = typeof headResponse.result === "string" ? Number.parseInt(headResponse.result.slice(2), 16) : Number.NaN;
  if (!Number.isSafeInteger(headBlock)) throw new RobinhoodRegistryValidationError("Robinhood Chain RPC did not return a valid head block.");

  // State-level upgrade tripwire: the proxy's implementation slot must still
  // read the deployment every layout constant in this file was verified
  // against. A different value stops the walk before a single event is
  // decoded — the event-level tripwire (unknown topic0) can only fire once
  // the upgraded contract emits something, and this check must not wait for
  // that.
  const implResponse = await callRobinhoodRpc(
    { method: "eth_getStorageAt", params: [ROBINHOOD_REPUTATION_REGISTRY, ROBINHOOD_REPUTATION_IMPL_SLOT, "latest"] },
    countRpcAttempt
  );
  if (implResponse.error || typeof implResponse.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(implResponse.result)) {
    throw new RobinhoodRegistryValidationError("Robinhood Chain RPC did not return a readable reputation implementation slot.");
  }
  const implAddress = `0x${implResponse.result.slice(26).toLowerCase()}`;
  if (implAddress !== ROBINHOOD_REPUTATION_IMPL) {
    throw new RobinhoodRegistryValidationError(
      `Reputation registry implementation changed: the ERC-1967 slot now reads ${implAddress}, not the approved ${ROBINHOOD_REPUTATION_IMPL}. ` +
        "The walk is paused and the cursor is untouched; re-verify every event layout against the new deployment before resuming."
    );
  }

  const cursor = parseRobinhoodReputationCursor(source.cursor);

  // One bounded address-only getLogs per attempt. No topic filter: the
  // response arrives as one call (wire-proven at the full 2M window), every
  // event kind the proxy emits is captured — including a first
  // ResponseAppended — and any unknown topic0 fails the run loudly instead of
  // being filtered into silence.
  const fetchReputationLogs = async (scanFrom: number, scanTo: number) => {
    const logsResponse = await callRobinhoodRpc(
      {
        method: "eth_getLogs",
        params: [
          {
            address: ROBINHOOD_REPUTATION_REGISTRY,
            fromBlock: `0x${scanFrom.toString(16)}`,
            toBlock: `0x${scanTo.toString(16)}`,
          },
        ],
      },
      countRpcAttempt
    );
    if (logsResponse.error) {
      // The public node enforces its own window caps as JSON-RPC errors;
      // exactly like the 4 MiB transport cap, those are narrowable windows,
      // never hard walk failures.
      const detail = typeof logsResponse.error.message === "string" ? ` ${logsResponse.error.message}` : "";
      throw new RobinhoodRegistryResponseTooLargeError(`Robinhood Chain RPC rejected the bounded reputation log window.${detail}`);
    }
    return logsResponse.result;
  };

  // Retains the window's raw logs content-addressed before returning: the
  // ledger caps untrusted strings at 512 characters, so the full feedbackURI
  // values (2,785 bytes on the wire-verified sample) and any evidence an
  // unknown-topic tripwire ever needs live only here.
  const retainWindowBatch = async (scannedFrom: number, scannedTo: number, scannedLogs: unknown) => {
    if (!Array.isArray(scannedLogs) || scannedLogs.length === 0) return null;
    const retainedText = JSON.stringify({
      chainId: 4663,
      registryAddress: ROBINHOOD_REPUTATION_REGISTRY,
      window: { fromBlock: scannedFrom, toBlock: scannedTo, headBlock },
      logs: scannedLogs,
    });
    const contentHash = createHash("sha256").update(retainedText).digest("hex");
    const stored = await storagePut(`nooscape/raw/erc8004-reputation/${source.id}/${contentHash}.json`, retainedText, "application/json");
    return { objectKey: stored.key, contentHash };
  };

  if (cursor.mode === "backward-seed" || cursor.mode === "backward") {
    if (options.mode !== "backfill") {
      throw new RobinhoodRegistryValidationError(REPUTATION_STILL_BACKWARD_MESSAGE);
    }
    // Seed the newest finality-safe window so the walk tiles from the top;
    // resume from the persisted position otherwise.
    const toBlock =
      cursor.mode === "backward-seed" ? headBlock - REPUTATION_SEED_FINALITY_BLOCKS : cursor.toBlock;
    if (toBlock < 1) {
      throw new RobinhoodRegistryValidationError("Chain head is below the reputation walk's finality margin; nothing to scan yet.");
    }
    const fromBlock = Math.max(1, toBlock - REPUTATION_SCAN_WINDOW_BLOCKS + 1);

    let scannedFrom = fromBlock;
    let scannedTo = toBlock;
    let scannedLogs: unknown;
    let eventLimit = ROBINHOOD_MAX_BACKFILL_EVENTS;
    for (let splits = 0; ; splits += 1) {
      if (splits > MAX_REPUTATION_WINDOW_SPLITS) {
        throw new RobinhoodRegistryValidationError(
          `Reputation backfill could not narrow block window ${fromBlock}-${toBlock} to a fetchable sub-window within ${MAX_REPUTATION_WINDOW_SPLITS} splits.`
        );
      }
      try {
        scannedLogs = await fetchReputationLogs(scannedFrom, scannedTo);
      } catch (error) {
        if (!(error instanceof RobinhoodRegistryResponseTooLargeError)) throw error;
        if (scannedTo - scannedFrom < 1) {
          throw new RobinhoodRegistryValidationError(
            `Robinhood Chain block ${scannedTo} alone cannot be fetched within the RPC's response limits; the public RPC cannot serve this reputation window.`
          );
        }
        // Dense burst: narrow to the newest fetchable half; the cursor
        // resumes just below the scanned sub-window so the next window
        // re-tiles the skipped older half.
        scannedFrom = splitBackfillWindow(scannedFrom, scannedTo).fromBlock;
        continue;
      }
      eventLimit =
        scannedFrom === fromBlock && scannedTo === toBlock ? ROBINHOOD_MAX_BACKFILL_EVENTS : ROBINHOOD_MAX_BACKFILL_SUBWINDOW_EVENTS;
      if (Array.isArray(scannedLogs) && scannedLogs.length > eventLimit && scannedTo - scannedFrom >= 1) {
        scannedFrom = splitBackfillWindow(scannedFrom, scannedTo).fromBlock;
        continue;
      }
      break;
    }

    const parsed = parseRobinhoodReputationLogs(scannedLogs, { fromBlock: scannedFrom, toBlock: scannedTo }, { eventLimit });
    const retainedBatch = await retainWindowBatch(scannedFrom, scannedTo, scannedLogs);
    return {
      discoveredCount: parsed.discoveredCount,
      rejectedCount: parsed.rejectedCount,
      events: parsed.events,
      requestCount,
      walkCursor: robinhoodReputationBackwardCursorAfter(scannedFrom),
      retainedBatch,
    };
  }

  // Forward territory.
  if (options.mode !== "activity") {
    throw new RobinhoodRegistryValidationError(REPUTATION_ALREADY_FORWARD_MESSAGE);
  }

  let anchorBlock: number;
  let anchorHash: string;
  if (cursor.mode === "forward-seed") {
    const highWater = options.reputationHighWaterBlock;
    if (!highWater) {
      throw new RobinhoodRegistryValidationError(
        "The reputation forward walk seeds from the ratings ledger's high-water block, but no measured block exists for this source."
      );
    }
    anchorBlock = highWater;
    anchorHash = await fetchRobinhoodBlockHash(anchorBlock, countRpcAttempt);
  } else {
    anchorBlock = cursor.block;
    anchorHash = cursor.blockHash;
    const liveHash = await fetchRobinhoodBlockHash(anchorBlock, countRpcAttempt);
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
      events: [],
      requestCount,
      walkCursor: robinhoodForwardCursorAfter(anchorBlock, anchorHash),
      retainedBatch: null,
    };
  }

  // One bounded window per run; density narrows the scan to the oldest
  // fetchable half — the mirror of the backward split — so the anchor always
  // advances to the top of what this run truly scanned and no block is ever
  // skipped. The forward budget rides ROBINHOOD_FORWARD_WINDOW_BLOCKS via
  // robinhoodForwardWindowBounds.
  let scannedFrom = bounds.fromBlock;
  let scannedTo = bounds.toBlock;
  let scannedLogs: unknown;
  let eventLimit = ROBINHOOD_MAX_BACKFILL_EVENTS;
  for (let splits = 0; ; splits += 1) {
    if (splits > MAX_REPUTATION_WINDOW_SPLITS) {
      throw new RobinhoodRegistryValidationError(
        `Reputation forward walk could not narrow block window ${scannedFrom}-${scannedTo} to a fetchable sub-window within ${MAX_REPUTATION_WINDOW_SPLITS} splits.`
      );
    }
    try {
      scannedLogs = await fetchReputationLogs(scannedFrom, scannedTo);
    } catch (error) {
      if (!(error instanceof RobinhoodRegistryResponseTooLargeError)) throw error;
      if (scannedTo - scannedFrom < 1) {
        throw new RobinhoodRegistryValidationError(
          `Robinhood Chain block ${scannedTo} alone cannot be fetched within the RPC's response limits; the public RPC cannot serve this reputation window.`
        );
      }
      scannedTo = splitForwardWindow(scannedFrom, scannedTo).toBlock;
      continue;
    }
    eventLimit =
      scannedFrom === bounds.fromBlock && scannedTo === bounds.toBlock ? ROBINHOOD_MAX_BACKFILL_EVENTS : ROBINHOOD_MAX_BACKFILL_SUBWINDOW_EVENTS;
    if (Array.isArray(scannedLogs) && scannedLogs.length > eventLimit && scannedTo - scannedFrom >= 1) {
      scannedTo = splitForwardWindow(scannedFrom, scannedTo).toBlock;
      continue;
    }
    break;
  }

  const parsed = parseRobinhoodReputationLogs(scannedLogs, { fromBlock: scannedFrom, toBlock: scannedTo }, { eventLimit });
  const retainedBatch = await retainWindowBatch(scannedFrom, scannedTo, scannedLogs);
  const topHash = await fetchRobinhoodBlockHash(scannedTo, countRpcAttempt);
  return {
    discoveredCount: parsed.discoveredCount,
    rejectedCount: parsed.rejectedCount,
    events: parsed.events,
    requestCount,
    walkCursor: robinhoodForwardCursorAfter(scannedTo, topHash),
    retainedBatch,
  };
}
