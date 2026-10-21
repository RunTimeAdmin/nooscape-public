import type { IngestionSource } from "../../drizzle/schema";
import type { DirectoryEntryDraft, SolanaChainActivityEvent } from "./types";
import { createHash } from "node:crypto";
import { encodeBase58 } from "./metaplexChain";
import { callSolanaRpc, getTransactionParams, parseSolanaRpcResult, parseTransactionResult, sleepSolana, SOLANA_RPC_PACING_MS } from "./solanaRpc";
import {
  classifyRegistrationUri,
  RESOLUTION_FAILED_MAX_ATTEMPTS,
  RESOLUTION_NO_NAME_MAX_ATTEMPTS,
  createRegistrationNameResolver,
  type RegistrationUriKind,
} from "./registrationFetch";

/**
 * On-chain 8004 Solana agent registry reads (SOLANA_INGEST_SPEC.md §2). The
 * QuantuLabs program `8oo4…QMbQ` — the registry behind solana.com/agent-registry
 * and 8004scan — holds one 748-byte AgentAccount PDA per registered agent
 * carrying the chain facts this adapter acknowledges: the current owner (bytes
 * 72..104), the agent asset pubkey (bytes 104..136 — the key space Robinhood
 * cross-chain registrations resolve, so it is the directory externalKey), and
 * the registration URI, whose inline JSON is decoded locally for a display
 * name. nft_name is "Agent" for every live account (verified 2026-10-11 across
 * all 1,504), so names come from the URI, never the NFT field.
 *
 * Change tracking is a state diff, not an event sweep: each pass re-reads the
 * whole program via getProgramAccounts and diffs it against the source's own
 * directory rows — there is no second read hop, the AgentAccount carries
 * everything inline. A closure is the account's disappearance from the
 * enumeration — never trusted alone: the pass stops loudly if the enumeration
 * falls below 98% of the prior live count (a truncated listing must not
 * masquerade as a wave of closures), and every closure candidate with a known
 * PDA takes one getAccountInfo confirmation read before the row is hidden; a
 * read that still finds a live AgentAccount fails the whole pass. Each diff
 * event is anchored to the transaction whose own
 * instructions made the change: ratings (GiveFeedback, UpdateStats) also
 * touch the AgentAccount, so the newest transaction alone proves nothing
 * about what changed. Live changes walk the AgentAccount PDA's recent
 * transactions newest-first for the matching registry instruction and event
 * line; a closure walks its last-known PDA when the directory row carries one
 * (nothing touches a closed account afterward, so its newest transactions are
 * the closure), else the asset pubkey — the only address that outlives the
 * vanished account — for any registry event line naming it, because
 * closure vocabulary has no live exemplar yet. An unmatched closure
 * stays unanchored: hide-once marker, no ledger row — the ledger only ever
 * records honestly anchored events. The
 * seed pass is a plain inventory: it records current state and emits no
 * events; pre-seed registration history is not backfilled, an honest,
 * documented limitation.
 *
 * Strict decode, fail-closed: the 748-byte length, the AgentAccount
 * discriminator, borsh Option tags, and per-string bounds are all enforced,
 * and an agent-discriminated account that fails decode fails the whole pass —
 * under disappearance-based closure detection a misread layout must never be
 * guessed past, or a live agent would masquerade as closed. Bytes past the col
 * string are stale Anchor padding residue (in-place updates never zero it; 7
 * of 1,504 live accounts carry ASCII fragments of prior field values) —
 * observed and counted, never parsed. Of the reputation windows (digest +
 * u64 count each), the feedback window's COUNT is decoded into the row's
 * feedbackCount — the census-exact ratings number (10,634 across 1,173
 * agents, live-verified 2026-10-12); the three digests stay unread and the
 * per-rating event walk (who rated, when, at what value — GiveFeedback tx
 * decode) remains a later workstream.
 *
 * Posture: chain facts only (owner, asset, registration URI, feedback count).
 * The pass's own reads never dereference a URI; the one bounded exception is
 * the step-3 name fetcher (registrationFetch.ts), which resolves a small
 * per-pass queue of registration links through the safe fetch purely to
 * fill the resolutions table — never the event spine — and never writes
 * reviewed records. The pass feeds directory acks and the Solana activity
 * ledger, exactly like the Metaplex chain pass. Closures are hide-once: the
 * acknowledgment marks the directory
 * row closed (keeping its last name and owner) and every later pass skips the
 * already-closed row without an event.
 */
export const SOLANA_8004_PROGRAM = "8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ";
export const SOLANA_8004_CHAIN_SOURCE_KEY = "solana-8004-agent-registry";
/** Fixed Anchor space: every live AgentAccount is exactly this many bytes. */
const AGENT_ACCOUNT_BYTES = 748;
/** Account discriminator `f177458ce9097032` (AgentAccount), as raw bytes. */
const AGENT_ACCOUNT_DISCRIMINATOR = [0xf1, 0x77, 0x45, 0x8c, 0xe9, 0x09, 0x70, 0x32];
/** collection (8..40) and creator (40..72) precede the owner. */
const OWNER_OFFSET = 72;
/** The agent asset pubkey — the directory externalKey and cross-chain join key. */
const ASSET_OFFSET = 104;
/** bump (136) and atom_enabled (137) precede the agent_wallet Option tag. */
const WALLET_TAG_OFFSET = 138;
/** Bounded scan ceiling: 1,504 AgentAccounts at probe time; growth past 4,000 stops the pass loudly. */
export const SOLANA_8004_CHAIN_MAX_ACCOUNTS = 4_000;
/**
 * Diff events acknowledged per pass, each costing one attribution call. A
 * busier day is processed over consecutive passes: un-processed changed
 * accounts stay un-upserted, so their prior directory state re-diffs next
 * pass. Lossless by construction, bounded by design.
 */
export const SOLANA_8004_CHAIN_MAX_EVENTS_PER_PASS = 25;
/**
 * Signature-scan depth per event-bearing address: one getSignaturesForAddress
 * call per address, shared by every event kind on that address.
 */
export const SOLANA_8004_SIGNATURE_SCAN_LIMIT = 25;
/** The program's instructions that register an agent. A registration made with one this list lacks has no anchor, and the pass fails on it. */
const SOLANA_8004_REGISTER_INSTRUCTIONS = ["RegisterWithOptions", "Register"];
/**
 * Transactions fetched per event while hunting the matching instruction,
 * newest-first (the fetch budget is shared across the pass, so one address's
 * walk feeds every later event on the same signatures). A change is always
 * newer than the prior pass, so a healthy provider finds the match well
 * inside this bound; deeper walks would only burn request budget walking
 * past rating storms. When the budget runs out mid-walk, the whole account
 * defers to the next pass instead of failing it — a feedback storm on one
 * agent or a crowded event window must not wedge every later pass (review
 * 2026-10-12). A walk that judges every recent transaction and still finds
 * no match still fails the pass loudly for live changes — never a guessed
 * anchor.
 */
export const SOLANA_8004_ATTRIBUTION_TX_FETCH_CAP = 10;
/**
 * Truncation floor: a diff pass fails loudly when the enumeration returns
 * fewer live agents than 98% of the prior live count. Closure detection is
 * absence-based, so a cut-off getProgramAccounts response would otherwise
 * hide up to its page size in live agents as closures every pass. The floor
 * compares against the prior LIVE count (open rows only), so acknowledged
 * closures never accumulate against it. Real shrinkage slower than 2% per
 * pass is genuine and passes through; a faster one stops the pass for an
 * operator to read first — the census has never observed a single closure.
 */
export const SOLANA_8004_ENUMERATION_FLOOR_PERCENT = 98;
/**
 * Account discriminator `30910cf9b08dc5bb` (MetadataEntryPda), as raw bytes —
 * the second, memcmp-scoped enumeration of step 3. Live-probed 2026-10-12:
 * 36 accounts of exactly 332 bytes (asset [8..40), flag [40], bump [41], then
 * borsh key and value Strings), carrying free-form per-agent metadata whose
 * observed keys include "name", "image", "chain-registrations", and
 * registry-scoped id tags like "erc8004-eth: #25045".
 */
export const SOLANA_8004_METADATA_DISCRIMINATOR = [0x30, 0x91, 0x0c, 0xf9, 0xb0, 0x8d, 0xc5, 0xbb];
/** Exact MetadataEntryPda size at probe time; anything else is not one. */
export const SOLANA_8004_METADATA_ENTRY_BYTES = 332;
/**
 * Growth ceiling for the metadata enumeration, aligned with the agent
 * ceiling's stop-loudly posture.
 */
export const SOLANA_8004_METADATA_MAX_ACCOUNTS = 4_000;
/**
 * Registration-URI name fetches per pass. At the 30-minute cadence this
 * sweeps the ~1,159 fetchable links (755 ipfs + ~404 https) in about a day;
 * resolved and terminal rows are never re-fetched, so steady-state passes
 * spend the budget only on new or retried hashes.
 */
export const SOLANA_8004_FETCH_BUDGET_PER_PASS = 30;
/**
 * Stable note for chain-pass rows. Distinct from the API-path notes so an
 * operator can always tell which pass last refreshed a row.
 */
export const SOLANA_8004_CHAIN_SIGNAL_NOTE =
  "On-chain 8004 Solana registry pass: AgentAccount owner and registration URI are chain reads; inline URI JSON is decoded locally. When that gives no name, the pass may fetch the registration link to read one.";

export class Solana8004ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Solana8004ValidationError";
  }
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type Solana8004AgentAccount = {
  /** The AgentAccount PDA pubkey — the attribution address for live changes. */
  account: string;
  /** The agent asset pubkey — the directory externalKey and cross-chain join key. */
  asset: string;
  /** Current on-chain owner; the directory registrant. */
  owner: string;
  displayName: string;
  locatorHost: string | null;
  /** SHA-256 hex of the full registration URI — the profile-link fingerprint the diff compares. */
  profileUriHash: string;
  /** The full registration URI, retained for the step-3 name fetch queue. */
  uri: string;
  /** The live on-chain feedback counter (first reputation window's u64 count). */
  feedbackCount: number;
  /** Stale bytes past the col string (Anchor never zeroes padding); counted, never parsed. */
  tailResidue: boolean;
};
export type Solana8004PriorEntry = {
  displayName: string | null;
  locatorHost: string | null;
  registrant: string | null;
  /** Last-known AgentAccount PDA (migration 0026+); the closure confirm-read address. */
  accountPubkey: string | null;
  /** SHA-256 hex of the last-acknowledged registration URI; null before the row's first live pass under 0026. */
  profileUriHash: string | null;
  /** True once a prior pass already acknowledged this asset closing (assetClosedAt set). */
  closed: boolean;
};
export type Solana8004DiffEvent = {
  kind: SolanaChainActivityEvent["kind"];
  /**
   * The AgentAccount PDA. For live changes, the enumerated account's own
   * address; for closures, the directory row's last-known PDA — the
   * confirm-read address and the preferred attribution walk — or null when
   * the row predates migration 0026, in which case the closure walks the
   * asset pubkey and closes unconfirmed.
   */
  account: string | null;
  asset: string;
  fromOwner: string | null;
  toOwner: string | null;
};

export type Solana8004ChainSnapshot = {
  slot: number;
  seed: boolean;
  /** Every account the gPA scan returned (agent accounts plus every other program account). */
  enumeratedCount: number;
  /** Decoded AgentAccounts — the live agent set this pass. */
  agentCount: number;
  /** Non-agent accounts (metadata entries, configs); counted, never parsed. */
  unknownCount: number;
  /** AgentAccounts carrying stale bytes past their col string. */
  tailResidueCount: number;
  /** Directory acks to upsert this pass. */
  drafts: DirectoryEntryDraft[];
  /** Diff events, attributed and ready for the ledger; empty on the seed pass. */
  events: SolanaChainActivityEvent[];
  /** Assets this pass acknowledges closing (anchored and unanchored alike) — the runner's hide-once marker list. */
  closedExternalKeys: string[];
  /** Changed accounts left for the next pass by the per-pass event cap. */
  deferredCount: number;
  /** Live-change and closure events left for the next pass because their attribution walk exhausted the shared fetch budget; a deferred closure stays unacknowledged so hide-once never makes a budget verdict permanent. */
  deferredAttributionCount: number;
  /** Closures whose acknowledgment a prior pass already recorded (hide-once skips). */
  closedAcknowledgedCount: number;
  /** Closures with no anchorable transaction: marked closed, not ledgered. */
  unanchoredClosureCount: number;
  /** Closures whose PDA was unknown (pre-0026 rows): closed on enumeration evidence alone, not a direct read. */
  unconfirmedClosureCount: number;
  /** Step-3: resolution rows to upsert this pass — budgeted fetches plus the on-chain "name" metadata. */
  resolutions: Solana8004ResolutionDraft[];
  /** Step-3: upsert-only cross-chain reference rows parsed from the MetadataEntryPda enumeration. */
  chainLinks: Solana8004ChainLinkDraft[];
  /** Step-3: metadata entries decoded this pass, and malformed rows skipped and counted. */
  metadataCount: number;
  metadataSkippedCount: number;
  /** Step-3: name fetches spent and names resolved this pass (never part of requestCount — HTTP, not RPC). */
  fetchAttemptedCount: number;
  fetchResolvedCount: number;
  requestCount: number;
};

function pubkeyFromBytes(bytes: Uint8Array, label: string): string {
  if (bytes.length !== 32) throw new Solana8004ValidationError(`${label} is not a 32-byte pubkey.`);
  return encodeBase58(bytes);
}

/** One u32-length-prefixed borsh String at `offset`; bounds-checked against the account. */
function borshStringAt(data: Uint8Array, offset: number, label: string): { text: string; end: number } {
  if (offset + 4 > data.length) throw new Solana8004ValidationError(`${label} starts past the account end.`);
  const length = new DataView(data.buffer, data.byteOffset).getUint32(offset, true);
  if (length > data.length - offset - 4) {
    throw new Solana8004ValidationError(`${label} claims ${length} bytes, past the account end.`);
  }
  const text = new TextDecoder().decode(data.subarray(offset + 4, offset + 4 + length));
  return { text, end: offset + 4 + length };
}

/** One u64 little-endian as a safe number; the counters stay far below 2^53. */
function readU64LE(data: Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset);
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  return low + high * 4294967296;
}

/**
 * The synthetic fallback name the decode writes when neither the inline URI
 * JSON nor a non-"Agent" nft_name carries a display name. The step-3
 * enrichment replaces exactly this shape, and the diff deliberately ignores
 * it as a change signal — see classifySolana8004Diff.
 */
export function placeholderSolana8004Name(asset: string): string {
  return `8004 agent ${asset.slice(0, 12)}`;
}

export function isPlaceholderSolana8004Name(name: string, asset: string): boolean {
  return name === placeholderSolana8004Name(asset);
}

/**
 * Decodes self-asserted metadata from an inline registration URI — a local
 * decode of bytes already on chain; no network access, no dereference, no
 * execution. Accepts `data:` URIs (base64- or percent-encoded payloads) and
 * the raw JSON object literals some registrants write directly into the field.
 * Mirrors the ERC-8004 rules: name trimmed and capped at 255 characters.
 */
function extractInlineName(uri: string): string | null {
  let text: string;
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (comma < 0) return null;
    const parameters = uri.slice("data:".length, comma);
    const payload = uri.slice(comma + 1);
    if (/;base64/i.test(parameters)) {
      text = Buffer.from(payload, "base64").toString("utf8");
    } else {
      try {
        text = decodeURIComponent(payload);
      } catch {
        return null;
      }
    }
  } else if (uri.startsWith("{")) {
    text = uri;
  } else {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const name = (parsed as Record<string, unknown>).name;
    if (typeof name !== "string") return null;
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 255) : null;
  } catch {
    return null;
  }
}

function isAgentAccount(data: Uint8Array): boolean {
  if (data.length < AGENT_ACCOUNT_DISCRIMINATOR.length) return false;
  for (let index = 0; index < AGENT_ACCOUNT_DISCRIMINATOR.length; index += 1) {
    if (data[index] !== AGENT_ACCOUNT_DISCRIMINATOR[index]) return false;
  }
  return true;
}

/**
 * SHA-256 hex of the full registration URI — the profile-link fingerprint.
 * Hashing the whole link (not just the host or the inline name) is what makes
 * an IPFS CID swap or a path edit a visible profile_update: 755 of the 1,504
 * live URIs are ipfs:// links whose edits change neither the display name nor
 * any https host. A local hash of bytes already on chain — nothing is
 * dereferenced.
 */
export function hashRegistrationUri(uri: string): string {
  return createHash("sha256").update(uri, "utf8").digest("hex");
}

/**
 * Decodes one AgentAccount per the live-verified layout (1,504 of 1,504
 * accounts, 2026-10-11): discriminator [0..8), collection, creator, owner,
 * asset, bump, atom_enabled, agent_wallet Option, three reputation windows
 * (digest + u64 count, skipped — the ratings surface is a later workstream),
 * parent_asset Option, parent_locked, col_locked, then the agent_uri,
 * nft_name, and col Strings. The bytes past col are stale Anchor padding
 * residue and are measured, never parsed. Anything that does not match fails
 * the pass loudly.
 */
export function decodeSolana8004AgentAccount(account: string, data: Uint8Array): Solana8004AgentAccount {
  if (data.length !== AGENT_ACCOUNT_BYTES) {
    throw new Solana8004ValidationError(
      `AgentAccount ${account} is ${data.length} bytes, not the approved ${AGENT_ACCOUNT_BYTES}-byte layout.`
    );
  }
  if (!isAgentAccount(data)) {
    throw new Solana8004ValidationError(`Account ${account} does not carry the AgentAccount discriminator.`);
  }
  const owner = pubkeyFromBytes(data.subarray(OWNER_OFFSET, OWNER_OFFSET + 32), `AgentAccount ${account} owner`);
  const asset = pubkeyFromBytes(data.subarray(ASSET_OFFSET, ASSET_OFFSET + 32), `AgentAccount ${account} asset`);
  // borsh Option: None is a single 0x00 tag byte, Some is 0x01 plus the value.
  const walletTag = data[WALLET_TAG_OFFSET]!;
  if (walletTag > 1) {
    throw new Solana8004ValidationError(`AgentAccount ${account} carries an invalid agent_wallet tag ${walletTag}.`);
  }
  let offset = walletTag === 1 ? WALLET_TAG_OFFSET + 33 : WALLET_TAG_OFFSET + 1;
  // Three reputation windows, each a 32-byte digest plus a u64 count. The
  // feedback window's count is the live ratings census — 10,634 across 1,173
  // agents (max 1,892), response and revoke decode to zero census-wide
  // (probed 2026-10-12) — decoded free from state the pass already holds.
  // The digests stay unread: the per-rating event walk is a later workstream.
  const feedbackCount = readU64LE(data, offset + 32);
  offset += (32 + 8) * 3;
  const parentTag = data[offset]!;
  if (parentTag > 1) {
    throw new Solana8004ValidationError(`AgentAccount ${account} carries an invalid parent_asset tag ${parentTag}.`);
  }
  offset += parentTag === 1 ? 33 : 1;
  offset += 2; // parent_locked, col_locked
  const uri = borshStringAt(data, offset, `AgentAccount ${account} agent_uri`);
  offset = uri.end;
  const nftName = borshStringAt(data, offset, `AgentAccount ${account} nft_name`);
  offset = nftName.end;
  const col = borshStringAt(data, offset, `AgentAccount ${account} col`);
  offset = col.end;

  let tailResidue = false;
  for (let index = offset; index < data.length; index += 1) {
    if (data[index] !== 0) {
      tailResidue = true;
      break;
    }
  }

  // Display name: the registration URI's inline JSON is the ERC-8004
  // self-description, so it wins; a future non-placeholder nft_name beats the
  // synthetic fallback. Today every live nft_name is "Agent".
  const inlineName = extractInlineName(uri.text);
  const onChainName = nftName.text.trim();
  const displayName =
    inlineName ??
    (onChainName.length > 0 && onChainName !== "Agent" ? onChainName.slice(0, 255) : placeholderSolana8004Name(asset));
  let locatorHost: string | null = null;
  if (uri.text.startsWith("https://")) {
    try {
      locatorHost = new URL(uri.text).hostname.toLowerCase();
    } catch {
      locatorHost = null;
    }
  }
  return {
    account,
    asset,
    owner,
    displayName,
    locatorHost,
    profileUriHash: hashRegistrationUri(uri.text),
    uri: uri.text,
    feedbackCount,
    tailResidue,
  };
}

type RawAccount = { pubkey?: unknown; account?: { data?: unknown } | null };

/**
 * Parses the 8004 program gPA response into agent records. An entry without a
 * pubkey and base64 data tuple is an RPC contract violation and fails the
 * pass — under disappearance-based closure detection, a misread envelope
 * could otherwise hide a live account and masquerade as a closure. Non-agent
 * accounts (metadata entries, configs) are counted, never parsed. An
 * AgentAccount-discriminated row that fails decode fails the pass loudly:
 * layout drift must never be guessed past.
 */
export function parseSolana8004ProgramAccounts(result: unknown): {
  accounts: Solana8004AgentAccount[];
  unknownCount: number;
} {
  if (!Array.isArray(result)) throw new Solana8004ValidationError("8004 getProgramAccounts response must be an array.");
  const accounts: Solana8004AgentAccount[] = [];
  let unknownCount = 0;
  for (const entry of result as RawAccount[]) {
    const pubkey = entry && typeof entry === "object" ? entry.pubkey : undefined;
    const data = entry && typeof entry === "object" ? entry.account?.data : undefined;
    if (typeof pubkey !== "string" || !SOLANA_ADDRESS.test(pubkey) || !Array.isArray(data) || typeof data[0] !== "string") {
      throw new Solana8004ValidationError("8004 getProgramAccounts returned an entry without a pubkey and base64 data tuple.");
    }
    const bytes = Buffer.from(data[0]!, "base64");
    if (!isAgentAccount(bytes)) {
      unknownCount += 1;
      continue;
    }
    accounts.push(decodeSolana8004AgentAccount(pubkey, bytes));
  }
  return { accounts, unknownCount };
}

/** One decoded MetadataEntryPda row: free-form key/value metadata attached to an agent asset. */
export type Solana8004MetadataEntry = {
  /** The MetadataEntryPda pubkey — the record's on-chain locator. */
  account: string;
  /** The agent asset the metadata is attached to (the directory externalKey). */
  asset: string;
  /** The free-form key ("name", "erc8004-eth", "chain-registrations", …). */
  key: string;
  /** The free-form value ("James", "#25045", "5-chains", …). */
  value: string;
};

/**
 * Decodes one MetadataEntryPda per the live-probed 332-byte layout: asset
 * [8..40), flag [40] (observed 0, and 1 on the single chain-registrations
 * row — semantics unknown, recorded in probes but deliberately not
 * interpreted), bump [41], then borsh key and value Strings. Returns null for
 * anything else — unlike the agent decode this is a soft skip, because the
 * metadata surface feeds enrichment and linkage only and can hide nothing
 * from the disappearance-based closure detection.
 */
export function decodeSolana8004MetadataAccount(account: string, data: Uint8Array): Solana8004MetadataEntry | null {
  if (data.length !== SOLANA_8004_METADATA_ENTRY_BYTES) return null;
  for (let index = 0; index < SOLANA_8004_METADATA_DISCRIMINATOR.length; index += 1) {
    if (data[index] !== SOLANA_8004_METADATA_DISCRIMINATOR[index]) return null;
  }
  try {
    const asset = pubkeyFromBytes(data.subarray(8, 40), `metadata ${account} asset`);
    const key = borshStringAt(data, 42, `metadata ${account} key`);
    const value = borshStringAt(data, key.end, `metadata ${account} value`);
    return { account, asset, key: key.text, value: value.text };
  } catch {
    return null;
  }
}

/**
 * Parses the metadata gPA response. Envelope-wide violations (a non-array
 * response) still fail the pass — that is an RPC contract breach — but an
 * individual malformed row is skipped and counted, never fatal.
 */
export function parseSolana8004MetadataAccounts(result: unknown): {
  entries: Solana8004MetadataEntry[];
  skippedCount: number;
} {
  if (!Array.isArray(result)) {
    throw new Solana8004ValidationError("8004 metadata getProgramAccounts response must be an array.");
  }
  const entries: Solana8004MetadataEntry[] = [];
  let skippedCount = 0;
  for (const entry of result as RawAccount[]) {
    const pubkey = entry && typeof entry === "object" ? entry.pubkey : undefined;
    const data = entry && typeof entry === "object" ? entry.account?.data : undefined;
    if (typeof pubkey !== "string" || !SOLANA_ADDRESS.test(pubkey) || !Array.isArray(data) || typeof data[0] !== "string") {
      skippedCount += 1;
      continue;
    }
    const decoded = decodeSolana8004MetadataAccount(pubkey, Buffer.from(data[0]!, "base64"));
    if (decoded === null) skippedCount += 1;
    else entries.push(decoded);
  }
  return { entries, skippedCount };
}

/** A cross-chain reference row for agent_directory_chain_links, before persistence. */
export type Solana8004ChainLinkDraft = {
  externalKey: string;
  metadataKey: string;
  linkedProtocol: "a2a" | "anp" | "agntcy" | "erc8004" | "erc8004_reputation" | "catalog" | "census" | "solana_registry" | "solana_8004" | "usdg_settlement" | "other";
  linkedExternalKey: string;
  metadataValueHash: string;
};

/**
 * The live metadata vocabulary stores chain references two ways, both probed
 * 2026-10-12: registry-scoped ids ("erc8004-eth: #25045",
 * "acp-virtuals: #17681") and CAIP-2-ish chain strings ("x402: eip155:8453").
 * The "chain-registrations" tag itself holds a summary string ("5-chains") —
 * stored uninterpreted for the record. Prose keys (name, description, image,
 * twitter, …) are never links.
 */
const CHAIN_LINK_VALUE_PATTERN = /^(?:#\d+|(?:eip155|solana):\S+)$/;

function linkedProtocolFor(metadataKey: string): Solana8004ChainLinkDraft["linkedProtocol"] {
  return metadataKey.startsWith("erc8004") ? "erc8004" : "other";
}

/** Builds the upsert-only link rows from one pass's metadata entries, deduplicated per (asset, key, value). */
export function buildSolana8004ChainLinks(entries: Solana8004MetadataEntry[]): Solana8004ChainLinkDraft[] {
  const links = new Map<string, Solana8004ChainLinkDraft>();
  for (const entry of entries) {
    const key = entry.key.trim();
    const value = entry.value.trim();
    if (key.length === 0 || value.length === 0) continue;
    if (key !== "chain-registrations" && !CHAIN_LINK_VALUE_PATTERN.test(value)) continue;
    if (value.length > 128 || key.length > 64) continue;
    const dedupeKey = `${entry.asset}\u0000${key}\u0000${value}`;
    if (!links.has(dedupeKey)) {
      links.set(dedupeKey, {
        externalKey: entry.asset,
        metadataKey: key,
        linkedProtocol: linkedProtocolFor(key),
        linkedExternalKey: value,
        metadataValueHash: createHash("sha256").update(value, "utf8").digest("hex"),
      });
    }
  }
  return Array.from(links.values());
}

/** A registration-name resolution row for agent_registration_resolutions, before persistence. */
export type Solana8004ResolutionDraft = {
  externalKey: string;
  uriHash: string;
  uriKind: string;
  uri: string;
  status: "resolved" | "no_name" | "failed";
  failReason: string | null;
  resolvedName: string | null;
  attempts: number;
};

/** The prior resolution state the runner injects, keyed by uriHash (the queue's idempotency key). */
export type Solana8004PriorResolution = {
  externalKey: string;
  uriHash: string;
  status: "resolved" | "no_name" | "failed";
  resolvedName: string | null;
  attempts: number;
};

/**
 * Turns the pass's on-chain "name" metadata into resolution rows (uriKind
 * "meta", located by the metadata account pubkey — a chain fact, never a
 * fetch) plus the per-asset name map the enrichment applies. The first
 * non-empty "name" per asset wins.
 */
export function buildSolana8004MetadataResolutions(entries: Solana8004MetadataEntry[]): {
  drafts: Solana8004ResolutionDraft[];
  namesByAsset: Map<string, string>;
} {
  const drafts = new Map<string, Solana8004ResolutionDraft>();
  const namesByAsset = new Map<string, string>();
  for (const entry of entries) {
    if (entry.key !== "name") continue;
    const trimmed = entry.value.trim();
    if (trimmed.length === 0) continue;
    if (!namesByAsset.has(entry.asset)) {
      const name = trimmed.slice(0, 200);
      namesByAsset.set(entry.asset, name);
      drafts.set(entry.asset, {
        externalKey: entry.asset,
        uriHash: hashRegistrationUri(`meta:${entry.asset}`),
        uriKind: "meta",
        uri: entry.account,
        status: "resolved",
        failReason: null,
        resolvedName: name,
        attempts: 0,
      });
    }
  }
  return { drafts: Array.from(drafts.values()), namesByAsset };
}

type FetchQueueItem = { account: Solana8004AgentAccount; kind: RegistrationUriKind };

/** True when a prior resolution forbids spending this pass's budget on the hash again. */
function resolutionIsSpendable(prior: Solana8004PriorResolution | undefined): boolean {
  if (prior === undefined) return true;
  if (prior.status === "resolved") return false;
  if (prior.status === "no_name") return prior.attempts < RESOLUTION_NO_NAME_MAX_ATTEMPTS;
  return prior.attempts < RESOLUTION_FAILED_MAX_ATTEMPTS;
}

/**
 * Selects the pass's name-fetch queue: live accounts whose registration URI is
 * a fetchable web/ipfs link and whose hash has no terminal resolution,
 * newest-hash first (accounts whose URI changed since the prior pass precede
 * the unchanged backlog), deterministically asset-ordered inside each group,
 * capped at the per-pass budget. Pure — the fetches happen in the caller.
 */
export function selectSolana8004FetchQueue(input: {
  accounts: Solana8004AgentAccount[];
  prior: Map<string, Solana8004PriorEntry>;
  priorResolutions: Map<string, Solana8004PriorResolution>;
}): FetchQueueItem[] {
  const fresh: FetchQueueItem[] = [];
  const rest: FetchQueueItem[] = [];
  for (const account of input.accounts) {
    const kind = classifyRegistrationUri(account.uri);
    if (kind === null) continue;
    if (!resolutionIsSpendable(input.priorResolutions.get(account.profileUriHash))) continue;
    const item: FetchQueueItem = { account, kind };
    const before = input.prior.get(account.asset);
    if (before === undefined || before.profileUriHash === null || before.profileUriHash !== account.profileUriHash) {
      fresh.push(item);
    } else {
      rest.push(item);
    }
  }
  const byAsset = (left: FetchQueueItem, right: FetchQueueItem) =>
    left.account.asset < right.account.asset ? -1 : left.account.asset > right.account.asset ? 1 : 0;
  fresh.sort(byAsset);
  rest.sort(byAsset);
  return fresh.concat(rest).slice(0, SOLANA_8004_FETCH_BUDGET_PER_PASS);
}

/**
 * Successful signatures from one getSignaturesForAddress scan, newest-first.
 * Failed transactions cannot have moved state, so they are skipped, as are
 * malformed entries — the scan is evidence, not a parse contract.
 */
export function successfulSignatureList(result: unknown): string[] {
  if (!Array.isArray(result)) throw new Solana8004ValidationError("Signature scan did not return a list.");
  const signatures: string[] = [];
  for (const entry of result as Array<{ signature?: unknown; err?: unknown } | null>) {
    if (!entry || typeof entry.signature !== "string" || entry.signature.length < 32) continue;
    if (entry.err === null || entry.err === undefined) signatures.push(entry.signature);
  }
  return signatures;
}

/**
 * Extracts the registry program's own instruction names and event log lines
 * from one transaction's log messages. Scoping follows the runtime program
 * stack: "Program <id> invoke [depth]" pushes at that depth and
 * "Program <id> success" pops, so lines logged after a CPI returns attribute
 * to the caller again — a flat last-invoke tracker would scope the registry's
 * post-CPI event lines to the callee (the Metaplex Core CPI inside
 * SetAgentUri/TransferAgent/RegisterWithOptions). The older "<id>: invoke"
 * frame pushes without a depth. Live-verified 2026-10-12: instructions print
 * Anchor's "Program log: Instruction: <Name>" and the program also emits
 * human-readable event lines naming pubkeys; Anchor source-path lines
 * ("programs/…:Approve") are not events and are excluded.
 */
export function extractSolana8004ProgramLogs(logs: unknown): { instructions: string[]; eventLines: string[] } {
  if (!Array.isArray(logs)) return { instructions: [], eventLines: [] };
  const instructions: string[] = [];
  const eventLines: string[] = [];
  const stack: string[] = [];
  const top = () => (stack.length > 0 ? stack[stack.length - 1]! : null);
  for (const line of logs as Array<unknown>) {
    if (typeof line !== "string") continue;
    let match = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(line);
    if (match !== null) {
      const depth = Number(match[2]);
      stack.length = depth > 1 ? depth - 1 : 0;
      stack.push(match[1]!);
      continue;
    }
    if (/^Program [1-9A-HJ-NP-Za-km-z]{32,44} success$/.test(line)) {
      if (stack.length > 0) stack.pop();
      continue;
    }
    match = /^([1-9A-HJ-NP-Za-km-z]{32,44}): invoke$/.exec(line);
    if (match !== null) {
      stack.push(match[1]!);
      continue;
    }
    if (top() !== SOLANA_8004_PROGRAM) continue;
    match = /^Program log: Instruction: (\S+)/.exec(line);
    if (match !== null) {
      instructions.push(match[1]!);
      continue;
    }
    match = /^Program log: (.+)$/.exec(line);
    if (match !== null && !match[1]!.startsWith("programs/")) {
      eventLines.push(match[1]!);
    }
  }
  return { instructions, eventLines };
}

/**
 * Live-verified event matchers (2026-10-12 probes): the registry logs
 * - RegisterWithOptions or Register with "Agent registered: <asset> in collection <col>". Register was first seen on mainnet on
 *   2026-10-19, in a transaction that also ran SetMetadataPda, InitializeStats and TransferAgent for the new agent; it logs the same
 *   event line, so the line naming the asset is the evidence and the instruction only says it came from a registration;
 * - SetAgentUri with "Agent URI updated for asset <asset>" (line-end anchored);
 * - TransferAgent with "Agent transferred: <fromOwner> -> <toOwner>" — both
 *   probe pubkeys resolve to system-owned wallets, so the line names the
 *   WALLETS, never the asset. The exact observed owner pair wins; a multi-hop
 *   move between passes (A->B->C diffs as A->C) falls back to the hop whose
 *   destination is the current owner, anchoring the latest real move while
 *   the ledger's from/to keep recording the directory's observed arc.
 * - asset_closed has no live exemplar yet — the census found zero closures
 *   ever — so the closure matcher accepts any registry event line naming the
 *   asset that is none of the known live-kind lines (feedback, register, uri,
 *   transfer); an unmatched closure stays unanchored: marked closed, never
 *   ledgered.
 */
export function matchSolana8004EventTransaction(input: {
  instructions: string[];
  eventLines: string[];
  event: Solana8004DiffEvent;
}): boolean {
  const { kind, asset, fromOwner, toOwner } = input.event;
  if (kind === "register") {
    if (!input.instructions.some(name => SOLANA_8004_REGISTER_INSTRUCTIONS.includes(name))) return false;
    return input.eventLines.some(line => line.includes(`Agent registered: ${asset} in collection`));
  }
  if (kind === "profile_update") {
    if (input.instructions.indexOf("SetAgentUri") === -1) return false;
    return input.eventLines.some(line => line.endsWith(`Agent URI updated for asset ${asset}`));
  }
  if (kind === "transfer") {
    if (input.instructions.indexOf("TransferAgent") === -1) return false;
    if (fromOwner !== null && toOwner !== null) {
      const exact = `Agent transferred: ${fromOwner} -> ${toOwner}`;
      if (input.eventLines.some(line => line.endsWith(exact))) return true;
    }
    if (toOwner === null) return false;
    return input.eventLines.some(line => line.includes("Agent transferred:") && line.endsWith(`-> ${toOwner}`));
  }
  // asset_closed: any registry event line naming the asset that is not a
  // known live-kind line — the closure vocabulary the program may grow.
  return input.eventLines.some(
    line =>
      line.includes(asset) &&
      !line.includes("Agent registered:") &&
      !line.includes("Agent URI updated for asset") &&
      !line.includes("Agent transferred:") &&
      !line.startsWith("Feedback #")
  );
}

/**
 * Pure diff between one chain pass and the source's prior directory state.
 * Seed = inventory: every live account becomes an upsert, zero events. A diff
 * pass classifies register/transfer/profile_update/asset_closed per asset:
 * - an account whose asset has no prior row registers (first chain
 *   acknowledgment);
 * - a live account reappearing after an acknowledged closure is a fresh
 *   register, and its live upsert clears the marker;
 * - a prior row with a null registrant was never chain-acknowledged, so the
 *   full chain state is adopted silently — neither a transfer nor a profile
 *   change;
 * - an owner change is a transfer; a profile_update fires on a display-name
 *   change, a locator-host change, or a registration-URI hash change (the
 *   full-link fingerprint catches IPFS CID swaps and path edits that touch
 *   neither name nor host). A null prior hash adopts the new hash silently —
 *   the migration-0026 backfill rule, the same posture as a null prior
 *   registrant;
 * - a prior row whose asset is absent from this pass's enumeration is a
 *   closure — unless a prior pass already acknowledged it (hide-once: skipped
 *   without an event, so acknowledged closures can never consume the per-pass
 *   event cap and starve real changes). The closure event carries the row's
 *   last-known PDA for the fetch-time confirmation read.
 * Candidates whose events exceed the per-pass cap are deferred wholesale
 * (neither events nor upserts), so their stale prior state re-diffs next pass.
 */
export function classifySolana8004Diff(input: {
  seed: boolean;
  accounts: Solana8004AgentAccount[];
  prior: Map<string, Solana8004PriorEntry>;
}): {
  upserts: Solana8004AgentAccount[];
  diffEvents: Solana8004DiffEvent[];
  deferredCount: number;
  closedAcknowledgedCount: number;
} {
  if (input.seed) {
    return { upserts: input.accounts, diffEvents: [], deferredCount: 0, closedAcknowledgedCount: 0 };
  }
  const currentAssets = new Set<string>();
  for (const account of input.accounts) currentAssets.add(account.asset);
  const candidates: Array<{ account: Solana8004AgentAccount | null; asset: string; events: Solana8004DiffEvent[] }> = [];
  let closedAcknowledgedCount = 0;
  for (const account of [...input.accounts].sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0))) {
    const before = input.prior.get(account.asset);
    if (!before) {
      candidates.push({
        account,
        asset: account.asset,
        events: [{ kind: "register", account: account.account, asset: account.asset, fromOwner: null, toOwner: account.owner }],
      });
      continue;
    }
    if (before.closed) {
      // Live again after an acknowledged closure: a fresh registration of the
      // same asset. Register (not transfer/profile_update) and let the live
      // upsert clear the closure marker, returning the row to public reads.
      candidates.push({
        account,
        asset: account.asset,
        events: [{ kind: "register", account: account.account, asset: account.asset, fromOwner: null, toOwner: account.owner }],
      });
      continue;
    }
    if (before.registrant === null) {
      // Never chain-acknowledged: adopt the full chain state silently. A
      // null-registrant prior is not chain state, so neither an owner nor a
      // name difference is a chain event.
      candidates.push({ account, asset: account.asset, events: [] });
      continue;
    }
    const events: Solana8004DiffEvent[] = [];
    if (account.owner !== before.registrant) {
      events.push({ kind: "transfer", account: account.account, asset: account.asset, fromOwner: before.registrant, toOwner: account.owner });
    }
    if (
      (before.displayName !== null &&
        before.displayName !== account.displayName &&
        // A chain-decoded placeholder is not a name the chain asserts: the
        // step-3 enrichment may have replaced the stored placeholder with a
        // fetched or metadata name, and that display-only difference must
        // never manufacture a profile_update — there is no SetAgentUri
        // transaction to anchor it, so the pass would fail loudly forever
        // after. A real rename always arrives with a new URI (the hash
        // comparison below still catches it), and a non-placeholder new name
        // still fires here.
        !isPlaceholderSolana8004Name(account.displayName, account.asset)) ||
      before.locatorHost !== account.locatorHost ||
      (before.profileUriHash !== null && before.profileUriHash !== account.profileUriHash)
    ) {
      events.push({ kind: "profile_update", account: account.account, asset: account.asset, fromOwner: null, toOwner: account.owner });
    }
    candidates.push({ account, asset: account.asset, events });
  }
  // Vanished accounts: prior rows whose asset is absent from this pass's
  // enumeration. Deterministic order, same as the live loop.
  const vanished = Array.from(input.prior.entries())
    .filter(([asset]) => !currentAssets.has(asset))
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  for (const [asset, before] of vanished) {
    if (before.closed) {
      // Hide-once: the closure was already acknowledged (assetClosedAt set on
      // the prior row). Skip silently — no event, no upsert, so the row keeps
      // its last acknowledged name and owner and the per-pass event cap stays
      // available for real changes.
      closedAcknowledgedCount += 1;
      continue;
    }
    candidates.push({
      account: null,
      asset,
      events: [
        {
          kind: "asset_closed",
          // The row's last-known PDA: the confirm-read address and the
          // preferred attribution walk. Null only for rows that closed before
          // their first live pass under migration 0026 — those close
          // unconfirmed and walk the asset pubkey.
          account: before.accountPubkey,
          asset,
          fromOwner: before.registrant,
          toOwner: null,
        },
      ],
    });
  }
  const upserts: Solana8004AgentAccount[] = [];
  const diffEvents: Solana8004DiffEvent[] = [];
  let deferredCount = 0;
  for (const candidate of candidates) {
    if (candidate.events.length === 0) {
      // Unchanged: refresh the ack (lastSeenAt/lastRunId) without an event.
      upserts.push(candidate.account!);
      continue;
    }
    if (diffEvents.length + candidate.events.length > SOLANA_8004_CHAIN_MAX_EVENTS_PER_PASS) {
      deferredCount += 1;
      continue;
    }
    if (candidate.account === null) {
      // A closure acknowledgment never upserts: the row keeps its last
      // acknowledged name and owner, and the runner marks it closed by key.
      // A deferred closure stays unmarked too, so the next pass re-detects it.
      diffEvents.push(...candidate.events);
      continue;
    }
    upserts.push(candidate.account);
    diffEvents.push(...candidate.events);
  }
  return { upserts, diffEvents, deferredCount, closedAcknowledgedCount };
}

export function assertApprovedSolana8004ChainSource(source: IngestionSource) {
  if (source.protocol !== "solana_8004" || source.sourceKey !== SOLANA_8004_CHAIN_SOURCE_KEY) {
    throw new Solana8004ValidationError("Source is not the approved 8004 Solana agent registry.");
  }
  if (source.state !== "active") throw new Solana8004ValidationError("Only active sources may be fetched.");
}

/**
 * Seed decision for the chain pass, read from the persisted source cursor.
 * Only an `s8004:` cursor counts as a completed inventory. Absent, empty, and
 * foreign cursors seed — the seed pass is a plain inventory (upserts only,
 * zero events), which is always safe to repeat.
 */
export function isSolana8004ChainSeedCursor(cursor: string | null): boolean {
  return !(cursor !== null && cursor.startsWith("s8004:"));
}

/**
 * One paced on-chain pass: slot, program enumeration, decode, diff, and
 * per-event signature attribution. Makes no database or API calls — prior
 * state and the seed decision are injected by the runner, and persistence
 * happens only after the whole snapshot (including every attribution)
 * succeeds, so a failure anywhere leaves prior directory state intact and the
 * next pass re-detects the same changes.
 */
export async function fetchSolana8004ChainState(input: {
  source: IngestionSource;
  seed: boolean;
  prior: Map<string, Solana8004PriorEntry>;
  /** Prior name resolutions keyed by uriHash (step 3); empty on a fresh deployment. */
  priorResolutions?: Map<string, Solana8004PriorResolution>;
  /** Injectable name fetcher (tests); defaults to the safe fetch behind registrationFetch (pinned connections, robots.txt, a second between requests to a host). */
  fetchName?: (uri: string, kind: RegistrationUriKind) => Promise<
    | { status: "resolved"; name: string }
    | { status: "no_name" }
    | { status: "failed"; reason: string }
  >;
  rpcUrl?: string;
}): Promise<Solana8004ChainSnapshot> {
  assertApprovedSolana8004ChainSource(input.source);
  let requestCount = 0;
  const count = () => {
    requestCount += 1;
  };
  const pacedCall = async <T>(work: () => Promise<T>): Promise<T> => {
    await sleepSolana(SOLANA_RPC_PACING_MS);
    return work();
  };

  const slotResult = parseSolanaRpcResult(
    await callSolanaRpc("getSlot", [], { countAttempt: count, rpcUrl: input.rpcUrl }),
    "getSlot"
  );
  if (typeof slotResult !== "number" || !Number.isSafeInteger(slotResult) || slotResult < 1) {
    throw new Solana8004ValidationError("Solana getSlot returned no usable slot.");
  }

  const accountsResult = parseSolanaRpcResult(
    await callSolanaRpc(
      "getProgramAccounts",
      [SOLANA_8004_PROGRAM, { encoding: "base64" }],
      { countAttempt: count, rpcUrl: input.rpcUrl }
    ),
    "8004 getProgramAccounts"
  );
  const { accounts, unknownCount } = parseSolana8004ProgramAccounts(accountsResult);
  if (accounts.length > SOLANA_8004_CHAIN_MAX_ACCOUNTS) {
    throw new Solana8004ValidationError(
      `8004 enumeration returned ${accounts.length} AgentAccounts, past the approved ${SOLANA_8004_CHAIN_MAX_ACCOUNTS}-account ceiling.`
    );
  }
  // Truncation floor (seed exempt — a seed has no prior count to trust): the
  // enumeration must hold at least SOLANA_8004_ENUMERATION_FLOOR_PERCENT of
  // the prior live count or the pass stops here, before any closure is
  // classified, let alone marked. A provider-side cut-off response would
  // otherwise turn every missing page into hide-once closures.
  if (!input.seed) {
    let priorLiveCount = 0;
    input.prior.forEach(entry => {
      if (!entry.closed) priorLiveCount += 1;
    });
    if (priorLiveCount > 0 && accounts.length * 100 < priorLiveCount * SOLANA_8004_ENUMERATION_FLOOR_PERCENT) {
      throw new Solana8004ValidationError(
        `8004 enumeration returned ${accounts.length} AgentAccounts, under the ${SOLANA_8004_ENUMERATION_FLOOR_PERCENT}% floor of the ${priorLiveCount} live agents the prior pass acknowledged — a truncated listing must never be read as closures.`
      );
    }
  }

  const { upserts, diffEvents, deferredCount, closedAcknowledgedCount } = classifySolana8004Diff({
    seed: input.seed,
    accounts,
    prior: input.prior,
  });

  // Instruction-matched attribution after classification, before any
  // persistence. Ratings (GiveFeedback, UpdateStats) also touch the
  // AgentAccount, so the newest transaction alone proves nothing about what
  // changed: each event walks its address's recent transactions newest-first
  // and anchors to the first whose registry-scoped instructions and event
  // lines match the observed change. Live changes walk the AgentAccount PDA;
  // closures walk the asset pubkey, the only address that outlives the
  // vanished account. Signature scans are shared per address and fetched
  // transactions are shared per signature, so a transfer and a rename on one
  // account cost one scan and one walk — and both events can anchor to the
  // same transaction, which the kind-aware ledger key then records as two
  // rows.
  const anchors = new Map<string, { anchor: string | null; budgetLimited: boolean }>();
  const signatureScans = new Map<string, string[]>();
  const transactionLogs = new Map<string, { instructions: string[]; eventLines: string[] } | null>();
  let transactionFetches = 0;
  const anchorFor = async (
    event: Solana8004DiffEvent
  ): Promise<{ anchor: string | null; budgetLimited: boolean }> => {
    const address = event.account ?? event.asset;
    const cacheKey = `${event.kind}:${address}`;
    const cached = anchors.get(cacheKey);
    if (cached) return cached;
    let scanned = signatureScans.get(address);
    if (scanned === undefined) {
      const scan = parseSolanaRpcResult(
        await pacedCall(() =>
          callSolanaRpc("getSignaturesForAddress", [address, { limit: SOLANA_8004_SIGNATURE_SCAN_LIMIT }], {
            countAttempt: count,
            rpcUrl: input.rpcUrl,
          })
        ),
        "getSignaturesForAddress"
      );
      scanned = successfulSignatureList(scan);
      signatureScans.set(address, scanned);
    }
    let anchor: string | null = null;
    let examined = 0;
    for (const signature of scanned) {
      if (anchor !== null || transactionFetches >= SOLANA_8004_ATTRIBUTION_TX_FETCH_CAP) break;
      examined += 1;
      let logs = transactionLogs.get(signature);
      if (logs === undefined) {
        transactionFetches += 1;
        const transaction = parseTransactionResult(
          await pacedCall(() =>
            callSolanaRpc("getTransaction", getTransactionParams(signature), {
              countAttempt: count,
              rpcUrl: input.rpcUrl,
            })
          )
        );
        // A pruned or unavailable transaction (result null on providers with
        // bounded history, or a version newer than the one asked for) is
        // skipped, not fatal — the walk keeps going.
        const meta =
          transaction !== null && typeof transaction === "object"
            ? (transaction as { meta?: { logMessages?: unknown } | null }).meta
            : null;
        logs = extractSolana8004ProgramLogs(meta === null || meta === undefined ? null : meta.logMessages);
        transactionLogs.set(signature, logs);
      }
      if (logs === null) continue;
      if (matchSolana8004EventTransaction({ instructions: logs.instructions, eventLines: logs.eventLines, event })) {
        anchor = signature;
      }
    }
    // The walk stopped early with no match only when the shared fetch budget
    // ran out; that is a budget verdict, not a evidence verdict, so the event
    // defers instead of failing the pass. A walk that examined every scanned
    // transaction and still found no match is the loud case.
    const budgetLimited = anchor === null && examined < scanned.length;
    if (anchor === null && event.kind !== "asset_closed" && !budgetLimited) {
      throw new Solana8004ValidationError(
        `No transaction matching the observed ${event.kind} was found to attribute the change on ${address}.`
      );
    }
    const outcome = { anchor, budgetLimited };
    anchors.set(cacheKey, outcome);
    return outcome;
  };

  const events: SolanaChainActivityEvent[] = [];
  const closedExternalKeys: string[] = [];
  let unanchoredClosureCount = 0;
  let unconfirmedClosureCount = 0;
  const confirmations = new Map<string, true>();
  // Events whose walk ran out of attribution budget defer their whole
  // account: live-change drafts are dropped so the row stays stale and the
  // next pass re-detects the diff, and closures stay unmarked for the same
  // reason — one stormy account must not wedge the pass, and a closure
  // acknowledged on a budget verdict would hide the row (hide-once) with no
  // ledger anchor and never be re-detected.
  const deferredAttributionAssets = new Set<string>();
  let deferredAttributionCount = 0;
  // Hide-once acknowledgment shared by anchored and unanchored closures:
  // the row hides and keeps its last acknowledged name and owner either way.
  const acknowledgeClosure = (closure: Solana8004DiffEvent) => {
    closedExternalKeys.push(closure.asset);
    if (closure.account === null) {
      // The row predates migration 0026 and never recorded its PDA: the
      // transition-window case. The closure still stands on the enumeration
      // evidence (hide-once), but it is counted as unconfirmed so the pass
      // snapshot shows which acknowledgments rested on absence alone.
      unconfirmedClosureCount += 1;
    }
  };
  for (const event of diffEvents) {
    if (event.kind === "asset_closed" && event.account !== null && !confirmations.has(event.account)) {
      const infoResult = parseSolanaRpcResult(
        await pacedCall(() =>
          callSolanaRpc("getAccountInfo", [event.account, { encoding: "base64" }], {
            countAttempt: count,
            rpcUrl: input.rpcUrl,
          })
        ),
        "getAccountInfo"
      );
      // getAccountInfo answers { value: null } for a gone account; a value
      // whose data still carries the AgentAccount discriminator is a live
      // agent the enumeration missed — the one reading that must fail the
      // pass rather than hide a row. Non-agent data at the PDA means the
      // account no longer holds an AgentAccount, which confirms the close.
      const value =
        infoResult !== null && typeof infoResult === "object"
          ? (infoResult as { value?: { data?: unknown } | null }).value
          : null;
      const dataTuple = value !== null && typeof value === "object" ? (value as { data?: unknown }).data : null;
      if (Array.isArray(dataTuple) && typeof dataTuple[0] === "string") {
        if (isAgentAccount(Buffer.from(dataTuple[0], "base64"))) {
          throw new Solana8004ValidationError(
            `AgentAccount ${event.account} for asset ${event.asset} is still live on chain but missing from the enumeration — refusing to acknowledge the closure.`
          );
        }
      }
      confirmations.set(event.account, true);
    }
    const outcome = await anchorFor(event);
    if (outcome.anchor === null && outcome.budgetLimited) {
      // The walk stopped on the shared fetch budget, not on evidence: defer
      // both live changes and closures so the next pass re-walks them with
      // a fresh budget. Acknowledgment is hide-once permanent, so a closure
      // whose verdict is a budget number must never be acknowledged.
      deferredAttributionAssets.add(event.asset);
      deferredAttributionCount += 1;
      continue;
    }
    if (outcome.anchor === null) {
      // A full walk that examined every scanned transaction and found no
      // match. A live change already threw inside anchorFor; a closure has
      // no honest anchor (the program's closure vocabulary has no live
      // exemplar), so the row is acknowledged closed without a ledger event.
      acknowledgeClosure(event);
      unanchoredClosureCount += 1;
      continue;
    }
    if (event.kind === "asset_closed") acknowledgeClosure(event);
    events.push({
      kind: event.kind,
      externalKey: event.asset,
      transactionSignature: outcome.anchor,
      slot: slotResult,
      fromOwner: event.fromOwner,
      toOwner: event.toOwner,
    });
  }

  // ---- Step-3 surfaces: metadata entries, twin links, budgeted name fetches ----
  // A second, memcmp-scoped enumeration after the attribution loop: these
  // surfaces feed enrichment and linkage only — never closures — so spending
  // their cost before an attribution failure could throw would be waste, and
  // their results are idempotent upserts that simply retry next pass.
  const metadataResult = parseSolanaRpcResult(
    await pacedCall(() =>
      callSolanaRpc(
        "getProgramAccounts",
        [
          SOLANA_8004_PROGRAM,
          {
            encoding: "base64",
            filters: [{ memcmp: { offset: 0, bytes: encodeBase58(new Uint8Array(SOLANA_8004_METADATA_DISCRIMINATOR)) } }],
          },
        ],
        { countAttempt: count, rpcUrl: input.rpcUrl }
      )
    ),
    "8004 metadata getProgramAccounts"
  );
  const metadata = parseSolana8004MetadataAccounts(metadataResult);
  if (metadata.entries.length > SOLANA_8004_METADATA_MAX_ACCOUNTS) {
    throw new Solana8004ValidationError(
      `8004 metadata enumeration returned ${metadata.entries.length} entries, past the approved ${SOLANA_8004_METADATA_MAX_ACCOUNTS}-account ceiling.`
    );
  }
  const chainLinks = buildSolana8004ChainLinks(metadata.entries);
  const metaResolutions = buildSolana8004MetadataResolutions(metadata.entries);

  const priorResolutions = input.priorResolutions ?? new Map<string, Solana8004PriorResolution>();
  const fetchName = input.fetchName ?? createRegistrationNameResolver(SOLANA_8004_FETCH_BUDGET_PER_PASS);
  const queue = selectSolana8004FetchQueue({ accounts, prior: input.prior, priorResolutions });
  const resolutionDrafts: Solana8004ResolutionDraft[] = [];
  const namesByUriHash = new Map<string, string>();
  priorResolutions.forEach((resolution, hash) => {
    if (resolution.status === "resolved" && resolution.resolvedName !== null) {
      namesByUriHash.set(hash, resolution.resolvedName);
    }
  });
  let fetchAttemptedCount = 0;
  let fetchResolvedCount = 0;
  for (const item of queue) {
    fetchAttemptedCount += 1;
    const prior = priorResolutions.get(item.account.profileUriHash);
    const attempts = (prior?.attempts ?? 0) + 1;
    const result = await fetchName(item.account.uri, item.kind);
    if (result.status === "resolved") {
      fetchResolvedCount += 1;
      namesByUriHash.set(item.account.profileUriHash, result.name);
    }
    resolutionDrafts.push({
      externalKey: item.account.asset,
      uriHash: item.account.profileUriHash,
      uriKind: item.kind,
      uri: item.account.uri.slice(0, 512),
      status: result.status,
      failReason: result.status === "failed" ? result.reason : null,
      resolvedName: result.status === "resolved" ? result.name : null,
      attempts,
    });
  }
  for (const draft of metaResolutions.drafts) resolutionDrafts.push(draft);

  const drafts: DirectoryEntryDraft[] = upserts
    // An account deferred for attribution stays out of the upserts, so its
    // directory row keeps the prior state and the next pass re-detects the
    // same diff — the ledger-first re-detect contract applied to deferrals.
    .filter(account => !deferredAttributionAssets.has(account.asset))
    .map(account => {
    // Enrichment replaces ONLY the synthetic placeholder, and a chain-stored
    // metadata name outranks a fetched one (both are self-asserted locator
    // facts; the on-chain record is the more canonical of the two, and a
    // decoded inline name already beat both inside the decode itself). The
    // upsert writes the enriched name, the diff ignores
    // placeholder-vs-enriched differences, and nothing here reaches the
    // ledger — the resolution rows above are the record.
    let displayName = account.displayName;
    if (isPlaceholderSolana8004Name(displayName, account.asset)) {
      const metaName = metaResolutions.namesByAsset.get(account.asset);
      const fetched = namesByUriHash.get(account.profileUriHash);
      if (metaName !== undefined) displayName = metaName;
      else if (fetched !== undefined) displayName = fetched;
    }
    return {
      externalKey: account.asset,
      displayName,
      locatorHost: account.locatorHost,
      registrant: account.owner,
      accountPubkey: account.account,
      profileUriHash: account.profileUriHash,
      feedbackCount: account.feedbackCount,
      sourceSignalNote: SOLANA_8004_CHAIN_SIGNAL_NOTE,
    };
  });

  return {
    slot: slotResult,
    seed: input.seed,
    enumeratedCount: accounts.length + unknownCount,
    agentCount: accounts.length,
    unknownCount,
    tailResidueCount: accounts.filter(account => account.tailResidue).length,
    drafts,
    events,
    closedExternalKeys,
    deferredCount,
    deferredAttributionCount,
    closedAcknowledgedCount,
    unanchoredClosureCount,
    unconfirmedClosureCount,
    resolutions: resolutionDrafts,
    chainLinks,
    metadataCount: metadata.entries.length,
    metadataSkippedCount: metadata.skippedCount,
    fetchAttemptedCount,
    fetchResolvedCount,
    requestCount,
  };
}
