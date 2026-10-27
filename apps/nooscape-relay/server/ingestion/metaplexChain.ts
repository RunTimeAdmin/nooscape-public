/**
 * On-chain Metaplex agent registry reads (SOLANA_INGEST_SPEC.md §1). The
 * identity program `1DREG…B2p` holds one PDA per registered agent keyed to an
 * MPL Core asset; the Core asset itself carries the chain facts this adapter
 * acknowledges: the current owner (bytes 1..33) and the registered name.
 * Reputation and validation programs are declared in source but not deployed
 * on mainnet, so there is nothing else to read yet.
 *
 * Change tracking is a state diff, not an event sweep: URI/plugin edits live
 * on the Core program (whose signatures cover all of Metaplex), so the
 * spec-verified catch is re-reading state and diffing it against the source's
 * own directory rows. Each diff event is attributed the asset's newest
 * successful transaction signature as its evidence anchor. The seed pass is a
 * plain inventory: it records current state and emits no events — pre-seed
 * registration history is not backfilled (firstSeenAt starts at seed date),
 * an honest, documented limitation.
 *
 * Posture: chain facts only (owner, name, existence). The chain pass never
 * fetches off-chain content and never writes reviewed records — it feeds the
 * directory acks and the Solana activity ledger, exactly like the ERC-8004
 * activity walk. Closures are hide-once: the acknowledgment marks the
 * directory row closed (keeping its last name and owner) and every later
 * pass skips the already-closed row without an event.
 */
import type { IngestionSource } from "../../drizzle/schema";
import type { DirectoryEntryDraft, SolanaChainActivityEvent } from "./types";
import { callSolanaRpc, parseSolanaRpcResult, sleepSolana, SOLANA_RPC_PACING_MS } from "./solanaRpc";

const METAPLEX_IDENTITY_PROGRAM = "1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p";
export const METAPLEX_CHAIN_SOURCE_KEY = "metaplex-solana-agent-registry";
/** AgentIdentityV1 account `Key` byte (40-byte layout, 68 accounts at probe time). */
const METAPLEX_IDENTITY_V1_KEY = 1;
/** AgentIdentityV2 account `Key` byte (104-byte layout, the 1,575-account majority). */
const METAPLEX_IDENTITY_V2_KEY = 2;
const IDENTITY_V1_BYTES = 40;
const IDENTITY_V2_BYTES = 104;
/** Below this the Core asset is closed/burned (5 of 40 spec samples); its PDA may outlive it. */
const ASSET_CLOSED_BYTES = 40;
/** key(1) + owner(32) + updateAuthority(1+32); the u32-length name starts here. */
const ASSET_NAME_OFFSET = 66;
/** Bounded scan ceiling: 1,643 PDAs at probe time; growth past 4,000 stops the pass loudly. */
const METAPLEX_CHAIN_MAX_ASSETS = 4_000;
/** getMultipleAccounts batch size — the spec-verified maximum the RPC accepts. */
const METAPLEX_CHAIN_BATCH_SIZE = 100;
/**
 * Diff events acknowledged per pass, each costing one attribution call. A
 * busier day is processed over consecutive passes: un-processed changed
 * assets stay un-upserted, so their prior directory state (old owner/name)
 * re-diffs next pass. Lossless by construction, bounded by design.
 */
export const METAPLEX_CHAIN_MAX_EVENTS_PER_PASS = 25;
/**
 * Stable note for chain-pass rows. Distinct from the API-path notes so an
 * operator can always tell which pass last refreshed a row.
 */
export const METAPLEX_CHAIN_SIGNAL_NOTE =
  "On-chain Metaplex registry pass: identity PDA and Core asset owner/name are chain reads; no off-chain content fetched.";

export class MetaplexChainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaplexChainValidationError";
  }
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type MetaplexIdentityRecord = { pda: string; version: 1 | 2; asset: string };
export type MetaplexAssetState = {
  asset: string;
  owner: string | null;
  name: string | null;
  closed: boolean;
};
export type MetaplexChainPriorEntry = {
  displayName: string | null;
  registrant: string | null;
  /** True once a prior pass already acknowledged this asset closing (assetClosedAt set). */
  closed: boolean;
};
type MetaplexChainDiffEvent = {
  kind: SolanaChainActivityEvent["kind"];
  asset: string;
  fromOwner: string | null;
  toOwner: string | null;
};

type MetaplexChainSnapshot = {
  slot: number;
  seed: boolean;
  /** Identity PDAs enumerated (every account returned by the gPA scan). */
  enumeratedCount: number;
  /** PDAs whose Key byte or length matched no approved layout. */
  unknownCount: number;
  liveCount: number;
  closedCount: number;
  /** Directory acks to upsert this pass (live, processed assets only). */
  drafts: DirectoryEntryDraft[];
  /** Diff events, attributed and ready for the ledger; empty on the seed pass. */
  events: SolanaChainActivityEvent[];
  /** Changed assets left for the next pass by the per-pass event cap. */
  deferredCount: number;
  /** Closed assets never acknowledged (no prior row), so there was nothing to withdraw. */
  closedSkippedCount: number;
  /** Closed assets whose closure a prior pass already acknowledged (hide-once skips). */
  closedAcknowledgedCount: number;
  requestCount: number;
};

/** RFC-4648-missing base58 (Bitcoin alphabet) for the 32-byte pubkeys we read from account data. */
export function encodeBase58(bytes: Uint8Array): string {
  // The repo's ES5 tsc target forbids BigInt literals and iterating typed
  // arrays, so this uses the BigInt constructor and indexed loops.
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const radix = BigInt(58);
  const shift = BigInt(8);
  const zero = BigInt(0);
  let value = zero;
  for (let index = 0; index < bytes.length; index += 1) {
    value = (value << shift) | BigInt(bytes[index]!);
  }
  let encoded = "";
  while (value > zero) {
    encoded = alphabet[Number(value % radix)] + encoded;
    value /= radix;
  }
  // Leading zero bytes encode as leading '1's.
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

function pubkeyFromBytes(bytes: Uint8Array, label: string): string {
  if (bytes.length !== 32) throw new MetaplexChainValidationError(`${label} is not a 32-byte pubkey.`);
  return encodeBase58(bytes);
}

/**
 * Decodes one identity PDA per the spec-verified layout: byte 0 is the
 * account `Key` (1 = V1, 40 bytes; 2 = V2, 104 bytes), the MPL Core asset
 * pubkey sits at bytes 8..40 in both versions. Anything else is unparseable
 * and only ever counted.
 */
export function decodeMetaplexIdentityPda(pda: string, data: Uint8Array): MetaplexIdentityRecord | null {
  if (data.length < 1) return null;
  const key = data[0]!;
  if (key === METAPLEX_IDENTITY_V1_KEY && data.length >= IDENTITY_V1_BYTES) {
    return { pda, version: 1, asset: pubkeyFromBytes(data.slice(8, 40), "V1 asset") };
  }
  if (key === METAPLEX_IDENTITY_V2_KEY && data.length >= IDENTITY_V2_BYTES) {
    return { pda, version: 2, asset: pubkeyFromBytes(data.slice(8, 40), "V2 asset") };
  }
  return null;
}

/**
 * Decodes one MPL Core AssetV1: key byte 1, owner at 1..33, update authority
 * header to 66, then a u32-length UTF-8 name. A null account or data below 40
 * bytes is a closed/burned asset (the identity PDA outlives it) — treated as
 * withdrawn, never as missing evidence.
 */
export function decodeMetaplexCoreAsset(asset: string, data: Uint8Array | null): MetaplexAssetState {
  if (!data || data.length < ASSET_CLOSED_BYTES || data[0] !== 1) {
    return { asset, owner: null, name: null, closed: true };
  }
  const owner = pubkeyFromBytes(data.slice(1, 33), "Core asset owner");
  let name: string | null = null;
  if (data.length >= ASSET_NAME_OFFSET + 4) {
    const claimed = Number(new DataView(data.buffer, data.byteOffset).getUint32(ASSET_NAME_OFFSET, true));
    if (claimed <= data.length - ASSET_NAME_OFFSET - 4 && claimed > 0) {
      const raw = new TextDecoder().decode(data.slice(ASSET_NAME_OFFSET + 4, ASSET_NAME_OFFSET + 4 + claimed));
      const trimmed = raw.replace(/\0+$/g, "").trim();
      name = trimmed.length > 0 ? trimmed.slice(0, 255) : null;
    }
  }
  return { asset, owner, name, closed: false };
}

type RawAccount = { pubkey?: unknown; account?: { data?: unknown } | null };

/** Parses the identity-program gPA response into records; unparseable rows are counted, never fatal. */
export function parseGetProgramAccountsResponse(result: unknown): {
  records: MetaplexIdentityRecord[];
  unknownCount: number;
} {
  if (!Array.isArray(result)) throw new MetaplexChainValidationError("Identity gPA response must be an array.");
  const records: MetaplexIdentityRecord[] = [];
  let unknownCount = 0;
  for (const entry of result as RawAccount[]) {
    const pubkey = entry && typeof entry === "object" ? entry.pubkey : undefined;
    const data = entry && typeof entry === "object" ? entry.account?.data : undefined;
    if (typeof pubkey !== "string" || !SOLANA_ADDRESS.test(pubkey) || !Array.isArray(data) || typeof data[0] !== "string") {
      unknownCount += 1;
      continue;
    }
    const bytes = Buffer.from(data[0]!, "base64");
    const record = decodeMetaplexIdentityPda(pubkey, bytes);
    if (record) records.push(record);
    else unknownCount += 1;
  }
  return { records, unknownCount };
}

/**
 * Parses one getMultipleAccounts response against its requested key order.
 * `value[i]` is null for a non-existent account — a closed asset. A live
 * entry carries its data tuple flat on the entry (the RpcAccount shape:
 * data/executable/lamports/owner/rentEpoch/space), NOT wrapped under an
 * `account` key the way getProgramAccounts entries are — live-verified
 * against both the public endpoint and Helius on 2026-10-11, after the
 * wrapped read had silently classified every live asset as closed. A
 * non-null entry without a decodable base64 data tuple is a contract
 * violation and fails the pass loudly instead of inventing closures.
 */
export function parseGetMultipleAccountsResponse(result: unknown, requested: string[]): MetaplexAssetState[] {
  if (!result || typeof result !== "object" || !Array.isArray((result as { value?: unknown }).value)) {
    throw new MetaplexChainValidationError("getMultipleAccounts response carries no value array.");
  }
  const value = (result as { value: unknown[] }).value;
  if (value.length !== requested.length) {
    throw new MetaplexChainValidationError("getMultipleAccounts response does not align with the requested keys.");
  }
  return value.map((entry, index) => {
    if (entry === null) {
      return { asset: requested[index]!, owner: null, name: null, closed: true };
    }
    const data = entry && typeof entry === "object" ? (entry as { data?: unknown }).data : undefined;
    if (!Array.isArray(data) || typeof data[0] !== "string") {
      throw new MetaplexChainValidationError("getMultipleAccounts returned a live account without a base64 data tuple.");
    }
    return decodeMetaplexCoreAsset(requested[index]!, Buffer.from(data[0]!, "base64"));
  });
}

/**
 * The newest successful transaction for one asset — the diff event's evidence
 * anchor. Failed transactions cannot have moved state, so they are skipped;
 * an asset with no successful signature at all fails the pass loudly (nothing
 * has been persisted yet, so the next pass re-detects the same change).
 */
export function parseNewestSuccessfulSignature(result: unknown, asset: string): string {
  if (!Array.isArray(result)) throw new MetaplexChainValidationError(`Signature scan for ${asset} did not return a list.`);
  for (const entry of result as Array<{ signature?: unknown; err?: unknown } | null>) {
    if (!entry || typeof entry.signature !== "string" || entry.signature.length < 32) continue;
    if (entry.err === null || entry.err === undefined) return entry.signature;
  }
  throw new MetaplexChainValidationError(`No successful transaction found to attribute the observed change on ${asset}.`);
}

/**
 * Pure diff between one chain pass and the source's prior directory state.
 * Seed = inventory: every live asset becomes an upsert, zero events. A diff
 * pass classifies register/transfer/profile_update/asset_closed per asset:
 * - a closed asset with an open prior row emits asset_closed exactly once —
 *   the acknowledgment marks the row (assetClosedAt) and never rewrites its
 *   name or owner, so no placeholder churn and no repeated events;
 * - a closed asset whose closure a prior pass already acknowledged is skipped
 *   without an event (hide-once: acknowledged closures can never consume the
 *   per-pass event cap, so they can never starve real changes);
 * - a live asset re-registered after an acknowledged closure is a fresh first
 *   chain acknowledgment (register), and its live upsert clears the marker;
 * - an owner previously unknown (null registrant, the API pilot's shape) is
 *   adopted silently together with the name — "never chain-acknowledged" is
 *   neither a transfer nor a profile change.
 * Assets whose events exceed the per-pass cap are deferred wholesale (neither
 * events nor upserts), so their stale prior state re-diffs next pass.
 */
export function classifyMetaplexChainDiff(input: {
  seed: boolean;
  states: MetaplexAssetState[];
  prior: Map<string, MetaplexChainPriorEntry>;
}): {
  upserts: MetaplexAssetState[];
  diffEvents: MetaplexChainDiffEvent[];
  deferredCount: number;
  closedSkippedCount: number;
  closedAcknowledgedCount: number;
} {
  if (input.seed) {
    const live = input.states.filter(state => !state.closed);
    return {
      upserts: live,
      diffEvents: [],
      deferredCount: 0,
      closedSkippedCount: input.states.length - live.length,
      closedAcknowledgedCount: 0,
    };
  }
  const candidates: Array<{ asset: string; events: MetaplexChainDiffEvent[]; state: MetaplexAssetState }> = [];
  let closedSkippedCount = 0;
  let closedAcknowledgedCount = 0;
  for (const state of [...input.states].sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0))) {
    const before = input.prior.get(state.asset);
    if (!before) {
      if (state.closed) {
        // Closed before first acknowledgment: nothing was ever acknowledged, nothing to withdraw.
        closedSkippedCount += 1;
        continue;
      }
      candidates.push({
        asset: state.asset,
        state,
        events: [{ kind: "register", asset: state.asset, fromOwner: null, toOwner: state.owner }],
      });
      continue;
    }
    if (state.closed) {
      if (before.closed) {
        // Hide-once: the closure was already acknowledged (assetClosedAt set
        // on the prior row). Skip silently — no event, no upsert, so the row
        // keeps its last acknowledged name and owner and the per-pass event
        // cap stays available for real changes.
        closedAcknowledgedCount += 1;
        continue;
      }
      candidates.push({
        asset: state.asset,
        state,
        events: [{ kind: "asset_closed", asset: state.asset, fromOwner: before.registrant, toOwner: null }],
      });
      continue;
    }
    if (before.closed) {
      // Live again after an acknowledged closure: a fresh registration of the
      // same asset. Register (not transfer/profile_update) and let the live
      // upsert clear the closure marker, returning the row to public reads.
      candidates.push({
        asset: state.asset,
        state,
        events: [{ kind: "register", asset: state.asset, fromOwner: null, toOwner: state.owner }],
      });
      continue;
    }
    if (before.registrant === null) {
      // Never chain-acknowledged (the API pilot's shape): adopt the full
      // chain state silently. A null-registrant prior is not chain state, so
      // neither an owner nor a name difference is a chain event.
      candidates.push({ asset: state.asset, state, events: [] });
      continue;
    }
    const events: MetaplexChainDiffEvent[] = [];
    if (state.owner !== null && before.registrant !== state.owner) {
      events.push({ kind: "transfer", asset: state.asset, fromOwner: before.registrant, toOwner: state.owner });
    }
    if (before.displayName !== null && state.name !== null && before.displayName !== state.name) {
      events.push({ kind: "profile_update", asset: state.asset, fromOwner: null, toOwner: state.owner });
    }
    candidates.push({ asset: state.asset, state, events });
  }
  const upserts: MetaplexAssetState[] = [];
  const diffEvents: MetaplexChainDiffEvent[] = [];
  let deferredCount = 0;
  for (const candidate of candidates) {
    if (candidate.events.length === 0) {
      // Unchanged: refresh the ack (lastSeenAt/lastRunId) without an event.
      upserts.push(candidate.state);
      continue;
    }
    if (diffEvents.length + candidate.events.length > METAPLEX_CHAIN_MAX_EVENTS_PER_PASS) {
      deferredCount += 1;
      continue;
    }
    if (candidate.state.closed) {
      // A closure acknowledgment never upserts: the row keeps its last
      // acknowledged name and owner, and the runner marks it closed by key.
      // A deferred closure stays unmarked too, so the next pass re-detects it.
      diffEvents.push(...candidate.events);
      continue;
    }
    upserts.push(candidate.state);
    diffEvents.push(...candidate.events);
  }
  return { upserts, diffEvents, deferredCount, closedSkippedCount, closedAcknowledgedCount };
}

export function assertApprovedMetaplexChainSource(source: IngestionSource) {
  if (source.protocol !== "solana_registry" || source.sourceKey !== METAPLEX_CHAIN_SOURCE_KEY) {
    throw new MetaplexChainValidationError("Source is not the approved Metaplex Solana registry.");
  }
  if (source.state !== "active") throw new MetaplexChainValidationError("Only active sources may be fetched.");
}

/**
 * Seed decision for the chain pass, read from the persisted source cursor.
 * Only a `sync2:` cursor counts as a completed inventory. The v1 `sync:`
 * cursors were written by the 2026-10-11 build whose getMultipleAccounts
 * parser misread every live asset as closed, so a v1 cursor means the stored
 * state is not trustworthy and the pass re-inventories — upserts only, zero
 * events, always safe. Absent, empty, and foreign cursors seed as well.
 */
export function isMetaplexChainSeedCursor(cursor: string | null): boolean {
  return !(cursor !== null && cursor.startsWith("sync2:"));
}

/**
 * One paced on-chain pass: slot, identity enumeration, asset state reads,
 * diff, and per-event signature attribution. Makes no database or API calls —
 * prior state and seed decision are injected by the runner, and persistence
 * happens only after the whole snapshot (including every attribution)
 * succeeds, so a failure anywhere leaves prior directory state intact and the
 * next pass re-detects the same changes.
 */
export async function fetchMetaplexChainState(input: {
  source: IngestionSource;
  seed: boolean;
  prior: Map<string, MetaplexChainPriorEntry>;
  rpcUrl?: string;
}): Promise<MetaplexChainSnapshot> {
  assertApprovedMetaplexChainSource(input.source);
  let requestCount = 0;
  const count = () => {
    requestCount += 1;
  };
  const pacedCall = async <T>(work: () => Promise<T>, isFirst: boolean): Promise<T> => {
    if (!isFirst) await sleepSolana(SOLANA_RPC_PACING_MS);
    return work();
  };

  const slotResult = parseSolanaRpcResult(
    await callSolanaRpc("getSlot", [], { countAttempt: count, rpcUrl: input.rpcUrl }),
    "getSlot"
  );
  if (typeof slotResult !== "number" || !Number.isSafeInteger(slotResult) || slotResult < 1) {
    throw new MetaplexChainValidationError("Solana getSlot returned no usable slot.");
  }

  const accountsResult = parseSolanaRpcResult(
    await callSolanaRpc(
      "getProgramAccounts",
      [METAPLEX_IDENTITY_PROGRAM, { encoding: "base64" }],
      { countAttempt: count, rpcUrl: input.rpcUrl }
    ),
    "identity getProgramAccounts"
  );
  const { records, unknownCount } = parseGetProgramAccountsResponse(accountsResult);
  if (records.length > METAPLEX_CHAIN_MAX_ASSETS) {
    throw new MetaplexChainValidationError(
      `Identity enumeration returned ${records.length} PDAs, past the approved ${METAPLEX_CHAIN_MAX_ASSETS}-asset ceiling.`
    );
  }
  // PDA derivation makes duplicate assets impossible; the dedupe is defensive.
  const assets = Array.from(new Set(records.map(record => record.asset)));
  const states: MetaplexAssetState[] = [];
  for (let index = 0; index < assets.length; index += METAPLEX_CHAIN_BATCH_SIZE) {
    const batch = assets.slice(index, index + METAPLEX_CHAIN_BATCH_SIZE);
    const batchResult = parseSolanaRpcResult(
      await pacedCall(
        () =>
          callSolanaRpc("getMultipleAccounts", [batch, { encoding: "base64" }], {
            countAttempt: count,
            rpcUrl: input.rpcUrl,
          }),
        index === 0
      ),
      "getMultipleAccounts"
    );
    states.push(...parseGetMultipleAccountsResponse(batchResult, batch));
  }

  const { upserts, diffEvents, deferredCount, closedSkippedCount, closedAcknowledgedCount } = classifyMetaplexChainDiff({
    seed: input.seed,
    states,
    prior: input.prior,
  });

  // Attribution after classification, before any persistence: one signature
  // scan per event-bearing asset, in the same deterministic order as the diff.
  const signatures = new Map<string, string>();
  for (const event of diffEvents) {
    if (signatures.has(event.asset)) continue;
    const scan = parseSolanaRpcResult(
      await pacedCall(
        () =>
          callSolanaRpc("getSignaturesForAddress", [event.asset, { limit: 5 }], {
            countAttempt: count,
            rpcUrl: input.rpcUrl,
          }),
        false
      ),
      "getSignaturesForAddress"
    );
    signatures.set(event.asset, parseNewestSuccessfulSignature(scan, event.asset));
  }

  const events: SolanaChainActivityEvent[] = diffEvents.map(event => ({
    kind: event.kind,
    externalKey: event.asset,
    transactionSignature: signatures.get(event.asset)!,
    slot: slotResult,
    fromOwner: event.fromOwner,
    toOwner: event.toOwner,
  }));

  const drafts: DirectoryEntryDraft[] = upserts.map(state => ({
    externalKey: state.asset,
    displayName: state.name ?? `Metaplex agent ${state.asset.slice(0, 12)}`,
    locatorHost: null,
    registrant: state.owner,
    sourceSignalNote: METAPLEX_CHAIN_SIGNAL_NOTE,
  }));

  const liveCount = states.filter(state => !state.closed).length;
  return {
    slot: slotResult,
    seed: input.seed,
    enumeratedCount: records.length,
    unknownCount,
    liveCount,
    closedCount: states.length - liveCount,
    drafts,
    events,
    deferredCount,
    closedSkippedCount,
    closedAcknowledgedCount,
    requestCount,
  };
}
