import { createHash } from "node:crypto";
import type { IngestionSource } from "../../drizzle/schema";
import type { DirectoryEntryDraft } from "./types";
import { encodeBase58 } from "./metaplexChain";
import { callSolanaRpc, parseSolanaRpcResult } from "./solanaRpc";

/**
 * On-chain SAID Protocol identity registry reads (docs/said-solana-2026-10-13.md).
 * The SAID program `5dpw…aA8G` holds one AgentIdentity PDA per registered
 * agent, seeded `["agent", owner]`, so the owner wallet is the identity's
 * natural key and the PDA is derivable from it. The program never closes an
 * AgentIdentity (only WalletLink accounts close), so unlike the 8004 and
 * Metaplex passes this pass has no disappearance-based closure: an identity
 * that vanishes from the enumeration is an anomaly (a truncated listing or a
 * program change), counted and never hidden, and a listing below the
 * enumeration floor fails the whole pass.
 *
 * Layout, byte-verified 2026-10-13 against every live account (13,313 of
 * 13,313 decode, zero failures; PDA, URI, and verified flag agree with SAID's
 * own API for all of them). The program was upgraded twice, and Anchor never
 * resizes existing accounts, so three fixed account sizes coexist:
 *   v1 · 263 bytes (registered 2026-02-01 .. 2026-03-03):
 *        owner, metadata_uri, created_at, is_verified, verified_at, bump
 *   v2 · 295 bytes (2026-03-05 .. 2026-04-13): v1 plus `authority` after owner
 *   v3 · 342 bytes (2026-04-13 ..): v2 plus verification_tier, stake_amount,
 *        staked_at, slash_count, last_slashed_at, last_receipt_seq,
 *        last_anchor_index
 * Borsh serializes a String as its u32 length plus only its actual bytes:
 * the 200-byte `max_len` is allocation, not serialization, so every field
 * after metadata_uri sits at a variable offset. Bytes past the last field are
 * stale Anchor residue left when a URI update shortens the string (24 of
 * 10,522 v3 accounts): observed and counted, never parsed.
 *
 * Strict decode, fail-closed: the exact account length selects the layout,
 * and the discriminator, borsh bool and Option tags, string bounds, UTF-8
 * validity, and a sane created_at are all enforced. An identity-discriminated
 * account that fails decode fails the whole pass: layout drift is never
 * guessed past.
 *
 * Posture: chain facts only, recorded as the chain holds them: owner,
 * current authority, the metadata URI's host, the badge flag, and (v3) stake
 * and slash counts. `is_verified` is a SAID badge bought for 0.01 SOL or
 * granted by a sponsor; it is not an identity check and is never shown as
 * one. SAID's computed trust scores, tiers, and EigenTrust values live off
 * chain and are not read; the paid `/api/screen` endpoint is never called.
 * The pass never dereferences a metadata URI. The name step (server/saidNames.ts) reads the card each link names, a few at a time,
 * and the pass lays the names it read over its drafts (docs/approvals/2026-10-18-said-names.md).
 */
export const SAID_PROGRAM = "5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G";
export const SAID_CHAIN_SOURCE_KEY = "solana-said-agent-registry";
/** Anchor discriminator `0b951f1bba4cf148` = sha256("account:AgentIdentity")[..8]. */
export const SAID_IDENTITY_DISCRIMINATOR = [0x0b, 0x95, 0x1f, 0x1b, 0xba, 0x4c, 0xf1, 0x48];
/** Fixed Anchor account sizes of the three live layout versions. */
const LAYOUT_VERSION_BY_BYTES: Record<number, 1 | 2 | 3> = { 263: 1, 295: 2, 342: 3 };
/** 13,313 identities at probe time (~1.8k/month); growth past 40,000 stops the pass loudly. */
export const SAID_CHAIN_MAX_ACCOUNTS = 40_000;
/**
 * The enumeration must hold at least this percentage of the prior pass's live
 * identities, or the pass stops loudly: a provider-side cut-off listing must
 * never pass for a registry that shrank.
 */
const SAID_ENUMERATION_FLOOR_PERCENT = 98;
/** The program's own metadata_uri bound (`validate_uri`: 10..=200 bytes). */
const METADATA_URI_MAX_BYTES = 200;
/** SAID launched in early 2026; a created_at before this is a misread layout, not a registration. */
const CREATED_AT_FLOOR_SECONDS = Date.UTC(2025, 0, 1) / 1000;
/** Clock skew allowance for the upper bound of created_at. */
const CREATED_AT_SKEW_SECONDS = 24 * 60 * 60;
const LAMPORTS_PER_SOL = 1_000_000_000;

export class SaidValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaidValidationError";
  }
}

export type SaidIdentity = {
  /** The AgentIdentity PDA (seeds `["agent", owner]`). */
  account: string;
  /** The wallet the identity was registered under; the directory externalKey. */
  owner: string;
  /** The wallet currently controlling the identity (equals owner on v1, which records none). */
  authority: string;
  layoutVersion: 1 | 2 | 3;
  uri: string;
  createdAtSeconds: number;
  isVerified: boolean;
  verifiedAtSeconds: number | null;
  /** v3 only; null on layouts that do not record them. */
  stakeLamports: bigint | null;
  slashCount: number | null;
  /** Bytes past the last field were non-zero (stale Anchor residue): measured, never parsed. */
  tailResidue: boolean;
};

type SaidChainSnapshot = {
  slot: number;
  requestCount: number;
  enumeratedCount: number;
  /** The decoded identities, in owner order: the input to the activity diff. */
  identities: SaidIdentity[];
  drafts: DirectoryEntryDraft[];
  /** Identities per layout version, for the operator's run note. */
  layoutCounts: { v1: number; v2: number; v3: number };
  tailResidueCount: number;
  /** Prior-acknowledged identities missing from this enumeration (within the floor): counted, never hidden. */
  vanishedCount: number;
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function pubkeyAt(data: Uint8Array, offset: number, label: string): string {
  if (offset + 32 > data.length) throw new SaidValidationError(`${label} runs past the account end.`);
  return encodeBase58(data.subarray(offset, offset + 32));
}

function boolAt(data: Uint8Array, offset: number, label: string): boolean {
  if (offset >= data.length) throw new SaidValidationError(`${label} runs past the account end.`);
  const byte = data[offset]!;
  if (byte > 1) throw new SaidValidationError(`${label} carries an invalid bool byte ${byte}.`);
  return byte === 1;
}

/** borsh Option<i64>: None is one 0x00 tag byte, Some is 0x01 plus eight bytes. */
function optionI64At(view: DataView, data: Uint8Array, offset: number, label: string): { value: number | null; end: number } {
  if (offset >= data.length) throw new SaidValidationError(`${label} runs past the account end.`);
  const tag = data[offset]!;
  if (tag === 0) return { value: null, end: offset + 1 };
  if (tag !== 1) throw new SaidValidationError(`${label} carries an invalid Option tag ${tag}.`);
  if (offset + 9 > data.length) throw new SaidValidationError(`${label} runs past the account end.`);
  return { value: safeSeconds(view.getBigInt64(offset + 1, true), label), end: offset + 9 };
}

function safeSeconds(raw: bigint, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new SaidValidationError(`${label} is not a usable timestamp.`);
  return value;
}

/** The synthetic fallback name: the chain carries no display name, only a metadata URI. */
export function placeholderSaidName(owner: string): string {
  return `SAID agent ${owner.slice(0, 8)}`;
}

/** 1_000_000_000 lamports per SOL, rendered exactly (no float) with trailing zeros trimmed. */
export function formatLamportsAsSol(lamports: bigint): string {
  const per = BigInt(LAMPORTS_PER_SOL);
  const whole = lamports / per;
  const frac = (lamports % per).toString();
  const padded = "000000000".slice(frac.length) + frac;
  const trimmed = padded.replace(/0+$/, "");
  return trimmed.length > 0 ? `${whole.toString()}.${trimmed}` : whole.toString();
}

export function isSaidIdentity(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let index = 0; index < 8; index += 1) {
    if (data[index] !== SAID_IDENTITY_DISCRIMINATOR[index]) return false;
  }
  return true;
}

/**
 * Decodes one AgentIdentity per the live-verified layouts (see the module
 * header). `nowMs` is injectable so the created_at ceiling is testable.
 */
export function decodeSaidIdentity(account: string, data: Uint8Array, nowMs: number = Date.now()): SaidIdentity {
  const layoutVersion = LAYOUT_VERSION_BY_BYTES[data.length];
  if (layoutVersion === undefined) {
    throw new SaidValidationError(`AgentIdentity ${account} is ${data.length} bytes, not one of the approved layout sizes (263, 295, 342).`);
  }
  if (!isSaidIdentity(data)) {
    throw new SaidValidationError(`Account ${account} does not carry the AgentIdentity discriminator.`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  const owner = pubkeyAt(data, offset, `AgentIdentity ${account} owner`);
  offset += 32;
  let authority = owner;
  if (layoutVersion >= 2) {
    authority = pubkeyAt(data, offset, `AgentIdentity ${account} authority`);
    offset += 32;
  }
  if (offset + 4 > data.length) throw new SaidValidationError(`AgentIdentity ${account} metadata_uri starts past the account end.`);
  const uriLength = view.getUint32(offset, true);
  offset += 4;
  if (uriLength > METADATA_URI_MAX_BYTES || uriLength > data.length - offset) {
    throw new SaidValidationError(`AgentIdentity ${account} metadata_uri claims ${uriLength} bytes, past its bound.`);
  }
  let uri: string;
  try {
    uri = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset, offset + uriLength));
  } catch {
    throw new SaidValidationError(`AgentIdentity ${account} metadata_uri is not valid UTF-8.`);
  }
  offset += uriLength;
  if (offset + 8 > data.length) throw new SaidValidationError(`AgentIdentity ${account} created_at runs past the account end.`);
  const createdAtSeconds = safeSeconds(view.getBigInt64(offset, true), `AgentIdentity ${account} created_at`);
  offset += 8;
  if (createdAtSeconds < CREATED_AT_FLOOR_SECONDS || createdAtSeconds > nowMs / 1000 + CREATED_AT_SKEW_SECONDS) {
    throw new SaidValidationError(`AgentIdentity ${account} created_at ${createdAtSeconds} is outside the plausible window (a misread layout, not a registration).`);
  }
  const isVerified = boolAt(data, offset, `AgentIdentity ${account} is_verified`);
  offset += 1;
  const verifiedAt = optionI64At(view, data, offset, `AgentIdentity ${account} verified_at`);
  offset = verifiedAt.end;

  let stakeLamports: bigint | null = null;
  let slashCount: number | null = null;
  if (layoutVersion === 3) {
    // verification_tier (u8) is read for bounds only: the tier vocabulary is
    // SAID's own and is not carried into the directory.
    if (offset + 1 > data.length) throw new SaidValidationError(`AgentIdentity ${account} verification_tier runs past the account end.`);
    offset += 1;
    if (offset + 8 > data.length) throw new SaidValidationError(`AgentIdentity ${account} stake_amount runs past the account end.`);
    stakeLamports = view.getBigUint64(offset, true);
    offset += 8;
    const stakedAt = optionI64At(view, data, offset, `AgentIdentity ${account} staked_at`);
    offset = stakedAt.end;
    if (offset + 4 > data.length) throw new SaidValidationError(`AgentIdentity ${account} slash_count runs past the account end.`);
    slashCount = view.getUint32(offset, true);
    offset += 4;
    const lastSlashed = optionI64At(view, data, offset, `AgentIdentity ${account} last_slashed_at`);
    offset = lastSlashed.end;
    // last_receipt_seq and last_anchor_index (two u64) close the v3 body.
    offset += 16;
  }
  // bump
  offset += 1;
  if (offset > data.length) throw new SaidValidationError(`AgentIdentity ${account} fields run past the account end.`);

  let tailResidue = false;
  for (let index = offset; index < data.length; index += 1) {
    if (data[index] !== 0) {
      tailResidue = true;
      break;
    }
  }
  return {
    account,
    owner,
    authority,
    layoutVersion,
    uri,
    createdAtSeconds,
    isVerified,
    verifiedAtSeconds: verifiedAt.value,
    stakeLamports,
    slashCount,
    tailResidue,
  };
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
type RawAccount = { pubkey?: unknown; account?: { data?: unknown } | null };

/**
 * Parses the filtered getProgramAccounts response into identities. An entry
 * without a pubkey and base64 data tuple is an RPC contract violation and
 * fails the pass; an entry the memcmp filter should have excluded counts as
 * unknown and is never parsed. An identity-discriminated entry that fails
 * decode fails the pass.
 */
export function parseSaidProgramAccounts(result: unknown, nowMs: number = Date.now()): {
  identities: SaidIdentity[];
  unknownCount: number;
} {
  if (!Array.isArray(result)) throw new SaidValidationError("SAID getProgramAccounts response must be an array.");
  const identities: SaidIdentity[] = [];
  let unknownCount = 0;
  for (const entry of result as RawAccount[]) {
    const pubkey = entry && typeof entry === "object" ? entry.pubkey : undefined;
    const data = entry && typeof entry === "object" ? entry.account?.data : undefined;
    if (typeof pubkey !== "string" || !SOLANA_ADDRESS.test(pubkey) || !Array.isArray(data) || typeof data[0] !== "string") {
      throw new SaidValidationError("SAID getProgramAccounts returned an entry without a pubkey and base64 data tuple.");
    }
    const bytes = Buffer.from(data[0]!, "base64");
    if (!isSaidIdentity(bytes)) {
      unknownCount += 1;
      continue;
    }
    identities.push(decodeSaidIdentity(pubkey, bytes, nowMs));
  }
  return { identities, unknownCount };
}

function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * The directory note: every fact is recorded chain state, and the badge is
 * labelled for what it is. Deterministic from the account, so an unchanged
 * identity rewrites an identical note.
 */
export function saidSignalNote(identity: SaidIdentity): string {
  const parts = [
    `SAID registry account (layout v${identity.layoutVersion}, registered ${utcDate(identity.createdAtSeconds)})`,
    `badge: ${identity.isVerified ? "yes (paid or sponsored, not an identity check)" : "no"}`,
  ];
  if (identity.stakeLamports !== null && identity.slashCount !== null) {
    parts.push(identity.stakeLamports === BigInt(0) ? "stake: none" : `stake: ${formatLamportsAsSol(identity.stakeLamports)} SOL`);
    parts.push(`slashes: ${identity.slashCount}`);
  }
  parts.push("chain facts as recorded, not scored");
  return parts.join(" · ");
}

export function buildSaidDirectoryDraft(identity: SaidIdentity): DirectoryEntryDraft {
  let locatorHost: string | null = null;
  if (identity.uri.startsWith("https://")) {
    try {
      locatorHost = new URL(identity.uri).hostname.toLowerCase();
    } catch {
      locatorHost = null;
    }
  }
  return {
    externalKey: identity.owner,
    displayName: placeholderSaidName(identity.owner),
    locatorHost,
    // The directory's "registrant" is the wallet currently recorded on-chain
    // for the identity: SAID's authority, which transfer_authority can move.
    registrant: identity.authority,
    accountPubkey: identity.account,
    profileUriHash: sha256Hex(identity.uri),
    sourceSignalNote: saidSignalNote(identity),
  };
}

function assertApprovedSaidChainSource(source: IngestionSource) {
  if (source.protocol !== "solana_said" || source.sourceKey !== SAID_CHAIN_SOURCE_KEY) {
    throw new SaidValidationError("Source is not the approved SAID Solana agent registry.");
  }
  if (source.state !== "active") throw new SaidValidationError("Only active sources may be fetched.");
}

/**
 * Seed decision, read from the persisted source cursor: only a `said:` cursor
 * counts as a completed inventory. Absent, empty, and foreign cursors seed,
 * and a re-inventory is always safe (upserts only).
 */
export function isSaidChainSeedCursor(cursor: string | null): boolean {
  return !(cursor !== null && cursor.startsWith("said:"));
}

/**
 * One on-chain pass: slot, filtered program enumeration, strict decode, and
 * the enumeration floor. Makes no database or API calls: prior state is
 * passed in, and the runner persists the drafts.
 */
export async function fetchSaidChainState(input: {
  source: IngestionSource;
  seed: boolean;
  /** externalKeys (owner wallets) the source already acknowledged; empty on a fresh deployment. */
  priorKeys: Set<string>;
  rpcUrl?: string;
  nowMs?: number;
}): Promise<SaidChainSnapshot> {
  assertApprovedSaidChainSource(input.source);
  let requestCount = 0;
  const count = () => {
    requestCount += 1;
  };

  const slotResult = parseSolanaRpcResult(await callSolanaRpc("getSlot", [], { countAttempt: count, rpcUrl: input.rpcUrl }), "getSlot");
  if (typeof slotResult !== "number" || !Number.isSafeInteger(slotResult) || slotResult < 1) {
    throw new SaidValidationError("Solana getSlot returned no usable slot.");
  }

  // The memcmp filter keeps the response to AgentIdentity accounts (the
  // ReceiptAnchor, WalletLink, stake, and reputation families are not read).
  const accountsResult = parseSolanaRpcResult(
    await callSolanaRpc(
      "getProgramAccounts",
      [
        SAID_PROGRAM,
        {
          encoding: "base64",
          filters: [{ memcmp: { offset: 0, bytes: encodeBase58(new Uint8Array(SAID_IDENTITY_DISCRIMINATOR)) } }],
        },
      ],
      { countAttempt: count, rpcUrl: input.rpcUrl }
    ),
    "SAID getProgramAccounts"
  );
  const { identities } = parseSaidProgramAccounts(accountsResult, input.nowMs);
  if (identities.length > SAID_CHAIN_MAX_ACCOUNTS) {
    throw new SaidValidationError(
      `SAID enumeration returned ${identities.length} identities, past the approved ${SAID_CHAIN_MAX_ACCOUNTS}-account ceiling.`
    );
  }

  const owners = new Set<string>();
  for (const identity of identities) {
    // PDA seeds make a duplicate owner impossible on a faithful read.
    if (owners.has(identity.owner)) {
      throw new SaidValidationError(`SAID enumeration returned owner ${identity.owner} twice, a corrupt listing.`);
    }
    owners.add(identity.owner);
  }

  let vanishedCount = 0;
  if (!input.seed) {
    const priorLiveCount = input.priorKeys.size;
    if (priorLiveCount > 0 && identities.length * 100 < priorLiveCount * SAID_ENUMERATION_FLOOR_PERCENT) {
      throw new SaidValidationError(
        `SAID enumeration returned ${identities.length} identities, under the ${SAID_ENUMERATION_FLOOR_PERCENT}% floor of the ${priorLiveCount} the prior pass acknowledged; a truncated listing must never be read as a shrinking registry.`
      );
    }
    input.priorKeys.forEach(key => {
      if (!owners.has(key)) vanishedCount += 1;
    });
  }

  const layoutCounts = { v1: 0, v2: 0, v3: 0 };
  let tailResidueCount = 0;
  const drafts: DirectoryEntryDraft[] = [];
  const ordered = [...identities].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  for (const identity of ordered) {
    layoutCounts[`v${identity.layoutVersion}` as "v1" | "v2" | "v3"] += 1;
    if (identity.tailResidue) tailResidueCount += 1;
    drafts.push(buildSaidDirectoryDraft(identity));
  }
  return { slot: slotResult, requestCount, enumeratedCount: identities.length, identities: ordered, drafts, layoutCounts, tailResidueCount, vanishedCount };
}
