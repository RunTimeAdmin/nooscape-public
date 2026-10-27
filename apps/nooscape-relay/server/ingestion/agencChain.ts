import { createHash } from "node:crypto";
import type { IngestionSource } from "../../drizzle/schema";
import type { DirectoryEntryDraft } from "./types";
import { encodeBase58 } from "./metaplexChain";
import { formatLamportsAsSol } from "./saidChain";
import { callSolanaRpc, parseSolanaRpcResult } from "./solanaRpc";

/**
 * On-chain AgenC agent registry reads (docs/agenc-solana-2026-10-26.md). The AgenC program `HJsZ…w1xK` (an Anchor program, upgradeable by a
 * Squads multisig) holds one AgentRegistration PDA per registered agent. Several agents can share one authority wallet (one holds ten), so the
 * agent's own PDA is its key, and the wallet that controls it is the directory's registrant. Deregistering leaves a permanent Inactive
 * tombstone owned by the program (the instruction was read, and the six Inactive accounts on chain all hold no stake), so like the SAID pass
 * this pass has no disappearance-based closure: an agent that vanishes from the enumeration is an anomaly (a truncated listing or a program
 * change), counted and never hidden, and a listing below the enumeration floor fails the whole pass.
 *
 * Layout, byte-verified 2026-10-26 against every live account (256 of 256 decode, and none has a byte left over past the last field). The
 * account is a fixed 566 bytes: 182 of fields and length prefixes, plus two strings allocated at their maximums. After the 8-byte discriminator:
 *   agent_id [u8; 32] · authority pubkey · capabilities u64 · status u8 (0 Inactive, 1 Active, 2 Busy, 3 Suspended) ·
 *   endpoint string (up to 256 bytes) · metadata_uri string (up to 128) · registered_at i64 · last_active i64 · tasks_completed u64 ·
 *   total_earned u64 · reputation u16 (0 to 10,000, 3,000 at registration) · active_tasks u16 · stake u64 ·
 *   then 49 bytes of bookkeeping the pass reads for bounds only (bump, rate-limit windows and counters, reserved).
 * Borsh serializes a String as its u32 length plus only its actual bytes, so every field after the first string sits at a variable offset.
 *
 * Strict decode, fail-closed: the exact account length (the program's layout is one fixed size), the discriminator, the status byte, the string
 * bounds, UTF-8 validity, the reputation bound and plausible times are all enforced. A registration-discriminated account that fails decode
 * fails the whole pass: layout drift is never guessed past.
 *
 * Posture: chain facts only, recorded as the chain holds them. The program's own counters (tasks completed, total earned, the reputation
 * number) are shown as recorded and never used to order, weight or blend (invariant 14); the reputation number is a counter the AgenC program
 * keeps, not a Nooscape score. The `endpoint` is required by the program and nothing in its task flow uses it (140 of the 256 registered
 * agents hold the placeholder https://agent.local), so it is not a service address: it is never fetched, never checked, and a name that is not
 * public is kept out of the locator. The metadata link is stored as a hash and never dereferenced.
 */
export const AGENC_PROGRAM = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
export const AGENC_CHAIN_SOURCE_KEY = "solana-agenc-agent-registry";
/** Anchor discriminator `82356467794d9413` = sha256("account:AgentRegistration")[..8]. */
export const AGENC_AGENT_DISCRIMINATOR = [0x82, 0x35, 0x64, 0x67, 0x79, 0x4d, 0x94, 0x13];
/** The one fixed account size of the live layout. */
export const AGENC_ACCOUNT_BYTES = 566;
/** The program's own bounds on the two strings. */
const ENDPOINT_MAX_BYTES = 256;
const METADATA_URI_MAX_BYTES = 128;
/** Bytes after `stake`: bump, rate-limit and dispute bookkeeping, and the reserved tail. */
const BOOKKEEPING_BYTES = 49;
/** 256 agents at probe time (about 10 a month lately); growth past 5,000 stops the pass loudly. */
export const AGENC_CHAIN_MAX_ACCOUNTS = 5_000;
/**
 * The enumeration must hold at least this percentage of the prior pass's agents, or the pass stops loudly: a provider-side cut-off listing
 * must never pass for a registry that shrank.
 */
const AGENC_ENUMERATION_FLOOR_PERCENT = 98;
/** The program went live in 2026; a time before this is a misread layout, not a registration. */
const TIME_FLOOR_SECONDS = Date.UTC(2025, 0, 1) / 1000;
/** Clock skew allowance for the upper bound of a time. */
const TIME_SKEW_SECONDS = 24 * 60 * 60;
const MAX_REPUTATION = 10_000;
const STATUS_BY_BYTE = ["Inactive", "Active", "Busy", "Suspended"] as const;
/** Top-level names reserved for private use or documentation (RFC 2606 and RFC 6761, and mDNS): never a public service address. */
const RESERVED_TOP_LEVEL_NAMES = new Set(["local", "localhost", "invalid", "test", "example", "internal"]);

export class AgencValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgencValidationError";
  }
}

export type AgencAgentStatus = (typeof STATUS_BY_BYTE)[number];

export type AgencAgent = {
  /** The AgentRegistration PDA: the directory externalKey. */
  account: string;
  /** The wallet that controls the agent: the directory's registrant. */
  authority: string;
  status: AgencAgentStatus;
  /** What the registrant typed. Untrusted text: never fetched, and not stored as it is. */
  endpoint: string;
  /** An off-chain profile link, or whatever text the registrant typed (empty when none). Untrusted: hashed, never fetched. */
  metadataUri: string;
  registeredAtSeconds: number;
  lastActiveSeconds: number;
  tasksCompleted: bigint;
  totalEarnedLamports: bigint;
  /** The program's own counter, 0 to 10,000. */
  reputation: number;
  stakeLamports: bigint;
  /** Bytes past the last field were non-zero: measured, never parsed. */
  tailResidue: boolean;
};

type AgencChainSnapshot = {
  slot: number;
  requestCount: number;
  enumeratedCount: number;
  drafts: DirectoryEntryDraft[];
  /** Agents whose account had bytes left over past the last field. A rise after a program upgrade is the signal that the layout changed. */
  tailResidueCount: number;
  /** Prior-acknowledged agents missing from this enumeration (within the floor): counted, never hidden. */
  vanishedCount: number;
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function pubkeyAt(data: Uint8Array, offset: number, label: string): string {
  if (offset + 32 > data.length) throw new AgencValidationError(label + " runs past the account end.");
  return encodeBase58(data.subarray(offset, offset + 32));
}

/** A borsh String: its u32 length, then that many bytes of UTF-8, within the program's own bound. */
function stringAt(view: DataView, data: Uint8Array, offset: number, maxBytes: number, label: string): { value: string; end: number } {
  if (offset + 4 > data.length) throw new AgencValidationError(label + " starts past the account end.");
  const length = view.getUint32(offset, true);
  const start = offset + 4;
  if (length > maxBytes || length > data.length - start) throw new AgencValidationError(label + " claims " + length + " bytes, past its bound.");
  try {
    return { value: new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(start, start + length)), end: start + length };
  } catch {
    throw new AgencValidationError(label + " is not valid UTF-8.");
  }
}

function plausibleSeconds(raw: bigint, label: string, nowMs: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < TIME_FLOOR_SECONDS || value > nowMs / 1000 + TIME_SKEW_SECONDS) {
    throw new AgencValidationError(label + " " + raw + " is outside the plausible window (a misread layout, not a registration).");
  }
  return value;
}

/** The synthetic fallback name: the chain carries no display name for an agent. */
export function placeholderAgencName(account: string): string {
  return "AgenC agent " + account.slice(0, 8);
}

export function isAgencAgent(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let index = 0; index < 8; index += 1) {
    if (data[index] !== AGENC_AGENT_DISCRIMINATOR[index]) return false;
  }
  return true;
}

/**
 * Decodes one AgentRegistration per the live-verified layout (see the module header). `nowMs` is injectable so the time ceiling is testable.
 */
export function decodeAgencAgent(account: string, data: Uint8Array, nowMs: number = Date.now()): AgencAgent {
  const name = "AgentRegistration " + account;
  if (data.length !== AGENC_ACCOUNT_BYTES) {
    throw new AgencValidationError(name + " is " + data.length + " bytes, not the approved " + AGENC_ACCOUNT_BYTES + ".");
  }
  if (!isAgencAgent(data)) throw new AgencValidationError("Account " + account + " does not carry the AgentRegistration discriminator.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Past the discriminator and the 32-byte agent_id.
  let offset = 8 + 32;
  const authority = pubkeyAt(data, offset, name + " authority");
  offset += 32;
  // capabilities (u64) is a bitmask whose vocabulary is the program's own and is not carried into the directory.
  offset += 8;
  const statusByte = data[offset]!;
  const status = STATUS_BY_BYTE[statusByte];
  if (status === undefined) throw new AgencValidationError(name + " carries an invalid status byte " + statusByte + ".");
  offset += 1;
  const endpoint = stringAt(view, data, offset, ENDPOINT_MAX_BYTES, name + " endpoint");
  const metadata = stringAt(view, data, endpoint.end, METADATA_URI_MAX_BYTES, name + " metadata_uri");
  offset = metadata.end;
  // registered_at, last_active, tasks_completed, total_earned (four 8-byte fields), reputation and active_tasks (two u16), stake (u64).
  if (offset + 32 + 4 + 8 + BOOKKEEPING_BYTES > data.length) throw new AgencValidationError(name + " fields run past the account end.");
  const registeredAtSeconds = plausibleSeconds(view.getBigInt64(offset, true), name + " registered_at", nowMs);
  const lastActiveSeconds = plausibleSeconds(view.getBigInt64(offset + 8, true), name + " last_active", nowMs);
  const tasksCompleted = view.getBigUint64(offset + 16, true);
  const totalEarnedLamports = view.getBigUint64(offset + 24, true);
  offset += 32;
  const reputation = view.getUint16(offset, true);
  if (reputation > MAX_REPUTATION) throw new AgencValidationError(name + " reputation " + reputation + " is past the program's own bound.");
  // active_tasks (u16) is read for bounds only.
  offset += 4;
  const stakeLamports = view.getBigUint64(offset, true);
  offset += 8 + BOOKKEEPING_BYTES;

  let tailResidue = false;
  for (let index = offset; index < data.length; index += 1) {
    if (data[index] !== 0) {
      tailResidue = true;
      break;
    }
  }
  return {
    account,
    authority,
    status,
    endpoint: endpoint.value,
    metadataUri: metadata.value,
    registeredAtSeconds,
    lastActiveSeconds,
    tasksCompleted,
    totalEarnedLamports,
    reputation,
    stakeLamports,
    tailResidue,
  };
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
type RawAccount = { pubkey?: unknown; account?: { data?: unknown } | null };

/**
 * Parses the filtered getProgramAccounts response into agents. An entry without a pubkey and base64 data tuple is an RPC contract violation
 * and fails the pass; an entry the memcmp filter should have excluded counts as unknown and is never parsed. A registration-discriminated
 * entry that fails decode fails the pass.
 */
export function parseAgencProgramAccounts(result: unknown, nowMs: number = Date.now()): { agents: AgencAgent[]; unknownCount: number } {
  if (!Array.isArray(result)) throw new AgencValidationError("AgenC getProgramAccounts response must be an array.");
  const agents: AgencAgent[] = [];
  let unknownCount = 0;
  for (const entry of result as RawAccount[]) {
    const pubkey = entry && typeof entry === "object" ? entry.pubkey : undefined;
    const data = entry && typeof entry === "object" ? entry.account?.data : undefined;
    if (typeof pubkey !== "string" || !SOLANA_ADDRESS.test(pubkey) || !Array.isArray(data) || typeof data[0] !== "string") {
      throw new AgencValidationError("AgenC getProgramAccounts returned an entry without a pubkey and base64 data tuple.");
    }
    const bytes = Buffer.from(data[0]!, "base64");
    if (!isAgencAgent(bytes)) {
      unknownCount += 1;
      continue;
    }
    agents.push(decodeAgencAgent(pubkey, bytes, nowMs));
  }
  return { agents, unknownCount };
}

/**
 * The host of an https address that names a public service, or null. A registrant can type anything into the required endpoint: 140 of
 * the first 256 typed the placeholder `agent.local`. A host with no dot, a name under a reserved top-level name (`.local`, `.invalid`,
 * `.test`, `.example`, `.internal`, `.localhost`) and an address literal are not public names, so they are no locator and a thousand of
 * them would not read as one shared host.
 */
export function publicHttpsHost(address: string): string | null {
  if (!address.startsWith("https://")) return null;
  let hostname: string;
  try {
    hostname = new URL(address).hostname.toLowerCase();
  } catch {
    return null;
  }
  // An IPv6 literal keeps its brackets in `hostname`.
  if (hostname === "" || hostname.includes(":") || hostname.startsWith("[")) return null;
  const labels = hostname.split(".");
  // The URL parser writes an IPv4 literal, in whatever form it was typed, as four decimal numbers.
  if (labels.length === 4 && labels.every(label => /^[0-9]{1,3}$/.test(label))) return null;
  if (labels.length < 2 || labels.some(label => label === "")) return null;
  if (RESERVED_TOP_LEVEL_NAMES.has(labels[labels.length - 1]!)) return null;
  return hostname;
}

function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * The directory note: every fact is recorded chain state, and the program's own counters are labelled for what they are. Deterministic from
 * the account, so an unchanged agent rewrites an identical note.
 */
export function agencSignalNote(agent: AgencAgent): string {
  const parts = [
    "AgenC registry account (registered " + utcDate(agent.registeredAtSeconds) + ", last active " + utcDate(agent.lastActiveSeconds) + ")",
    "status: " + agent.status,
    "tasks completed: " + agent.tasksCompleted.toString(),
    "earned: " + formatLamportsAsSol(agent.totalEarnedLamports) + " SOL (the program's own lifetime counter)",
    agent.stakeLamports === BigInt(0) ? "stake: none" : "stake: " + formatLamportsAsSol(agent.stakeLamports) + " SOL",
    "reputation: " + agent.reputation + " of " + MAX_REPUTATION + " (a counter the AgenC program keeps, not a Nooscape score)",
  ];
  if (publicHttpsHost(agent.endpoint) === null) parts.push("endpoint: a placeholder or reserved name, not a service address");
  parts.push("chain facts as recorded, not scored");
  return parts.join(" · ");
}

export function buildAgencDirectoryDraft(agent: AgencAgent): DirectoryEntryDraft {
  return {
    externalKey: agent.account,
    displayName: placeholderAgencName(agent.account),
    // The endpoint's host when it is a public name, else the profile link's. Nothing is fetched from either.
    locatorHost: publicHttpsHost(agent.endpoint) ?? publicHttpsHost(agent.metadataUri),
    registrant: agent.authority,
    accountPubkey: agent.account,
    profileUriHash: agent.metadataUri === "" ? null : sha256Hex(agent.metadataUri),
    sourceSignalNote: agencSignalNote(agent),
  };
}

function assertApprovedAgencChainSource(source: IngestionSource) {
  if (source.protocol !== "solana_agenc" || source.sourceKey !== AGENC_CHAIN_SOURCE_KEY) {
    throw new AgencValidationError("Source is not the approved AgenC Solana agent registry.");
  }
  if (source.state !== "active") throw new AgencValidationError("Only active sources may be fetched.");
}

/**
 * Seed decision, read from the persisted source cursor: only an `agenc:` cursor counts as a completed inventory. Absent, empty and foreign
 * cursors seed, and a re-inventory is always safe (upserts only).
 */
export function isAgencChainSeedCursor(cursor: string | null): boolean {
  return !(cursor !== null && cursor.startsWith("agenc:"));
}

/**
 * One on-chain pass: slot, filtered program enumeration, strict decode, and the enumeration floor. Makes no database or API calls: prior
 * state is passed in, and the runner persists the drafts.
 */
export async function fetchAgencChainState(input: {
  source: IngestionSource;
  seed: boolean;
  /** externalKeys (agent PDAs) the source already acknowledged; empty on a fresh deployment. */
  priorKeys: Set<string>;
  rpcUrl?: string;
  nowMs?: number;
}): Promise<AgencChainSnapshot> {
  assertApprovedAgencChainSource(input.source);
  let requestCount = 0;
  const count = () => {
    requestCount += 1;
  };

  const slotResult = parseSolanaRpcResult(await callSolanaRpc("getSlot", [], { countAttempt: count, rpcUrl: input.rpcUrl }), "getSlot");
  if (typeof slotResult !== "number" || !Number.isSafeInteger(slotResult) || slotResult < 1) {
    throw new AgencValidationError("Solana getSlot returned no usable slot.");
  }

  // The memcmp filter keeps the response to AgentRegistration accounts: the program's other 40-odd account families (tasks, escrows, listings,
  // moderation records and the rest, about 2,750 accounts) are not read. There is no size filter, so a registration at an unapproved size
  // fails the decode loudly instead of being left out.
  const accountsResult = parseSolanaRpcResult(
    await callSolanaRpc(
      "getProgramAccounts",
      [
        AGENC_PROGRAM,
        {
          encoding: "base64",
          filters: [{ memcmp: { offset: 0, bytes: encodeBase58(new Uint8Array(AGENC_AGENT_DISCRIMINATOR)) } }],
        },
      ],
      { countAttempt: count, rpcUrl: input.rpcUrl }
    ),
    "AgenC getProgramAccounts"
  );
  const { agents } = parseAgencProgramAccounts(accountsResult, input.nowMs);
  if (agents.length > AGENC_CHAIN_MAX_ACCOUNTS) {
    throw new AgencValidationError(
      "AgenC enumeration returned " + agents.length + " agents, past the approved " + AGENC_CHAIN_MAX_ACCOUNTS + "-account ceiling."
    );
  }

  const accounts = new Set<string>();
  for (const agent of agents) {
    // A PDA is one account: a duplicate is impossible on a faithful read.
    if (accounts.has(agent.account)) throw new AgencValidationError("AgenC enumeration returned account " + agent.account + " twice, a corrupt listing.");
    accounts.add(agent.account);
  }

  let vanishedCount = 0;
  if (!input.seed) {
    const priorLiveCount = input.priorKeys.size;
    if (priorLiveCount > 0 && agents.length * 100 < priorLiveCount * AGENC_ENUMERATION_FLOOR_PERCENT) {
      throw new AgencValidationError(
        "AgenC enumeration returned " + agents.length + " agents, under the " + AGENC_ENUMERATION_FLOOR_PERCENT + "% floor of the " + priorLiveCount + " the prior pass acknowledged; a truncated listing must never be read as a shrinking registry."
      );
    }
    input.priorKeys.forEach(key => {
      if (!accounts.has(key)) vanishedCount += 1;
    });
  }

  let tailResidueCount = 0;
  const drafts: DirectoryEntryDraft[] = [];
  const ordered = [...agents].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  for (const agent of ordered) {
    if (agent.tailResidue) tailResidueCount += 1;
    drafts.push(buildAgencDirectoryDraft(agent));
  }
  return { slot: slotResult, requestCount, enumeratedCount: agents.length, drafts, tailResidueCount, vanishedCount };
}
