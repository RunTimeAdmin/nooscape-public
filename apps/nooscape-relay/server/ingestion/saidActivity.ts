import type { SolanaChainActivityEvent } from "./types";
import type { SaidIdentity } from "./saidChain";
import { buildSaidDirectoryDraft, SAID_PROGRAM } from "./saidChain";
import { getTransactionParams } from "./solanaRpc";

/**
 * Activity attribution for the SAID identity pass: which identities were
 * registered, changed authority, or changed their metadata link since the last
 * pass, and the transaction that did it. Each such change is acknowledged into
 * the Solana activity ledger (`agent_solana_activity`) anchored to the
 * transaction whose own instruction made it. The ledger only ever records
 * honestly anchored events.
 *
 * Detection is a state diff against the source's own directory rows, exactly
 * like the 8004 and Metaplex passes. Attribution walks the identity's PDA
 * signatures newest-first and anchors to the first transaction whose
 * program-scoped instruction names match the change (live-verified 2026-10-13
 * against mainnet: `RegisterAgent`, `UpdateAgent`, `TransferAuthority`; the
 * program emits Anchor events as binary `Program data:` lines, so the
 * instruction name is the only text vocabulary). Other instructions also touch
 * the PDA (`SubmitAnchor`, `Stake`, `LinkWallet`, `GetVerified`, feedback), so
 * the newest transaction alone proves nothing.
 *
 * Failure modes are bounded by design, because anyone can touch an identity's
 * PDA and bury a real change under their own transactions:
 * - An identity's walk stops after `SAID_IDENTITY_TX_FETCH_CAP` transaction
 *   reads. A change it could not anchor within that bound is ADOPTED without a
 *   ledger row and counted, never failed: one spammed identity can neither wedge
 *   the pass nor starve the identities after it.
 * - The pass as a whole stops at `SAID_PASS_TX_FETCH_BUDGET` reads. An identity
 *   the budget did not reach is DEFERRED (no upsert, no event), so its prior
 *   directory state stays stale and the next pass re-detects the same change.
 *   Every pass completes at least the identities it reached, so deferral
 *   cannot repeat forever.
 * - More than `SAID_CHAIN_MAX_EVENTS_PER_PASS` events in one pass defer the
 *   rest the same way.
 *
 * Changes to the verification badge, stake, or slash count refresh the
 * directory note but fire no event: the ledger has no kind for them.
 */
export const SAID_CHAIN_MAX_EVENTS_PER_PASS = 25;
/** Signatures scanned per identity: one getSignaturesForAddress call, shared by that identity's events. */
export const SAID_SIGNATURE_SCAN_LIMIT = 25;
/** Transaction reads per identity before an unmatched change is adopted unanchored. */
export const SAID_IDENTITY_TX_FETCH_CAP = 8;
/** Transaction reads per pass before the remaining identities defer to the next pass. */
export const SAID_PASS_TX_FETCH_BUDGET = 40;

type SaidEventKind = "register" | "transfer" | "profile_update";

export type SaidPriorEntry = {
  /** The authority the directory last acknowledged (the row's registrant); null if never chain-acknowledged. */
  registrant: string | null;
  /** SHA-256 of the full metadata URI as last acknowledged; null before the row's first live pass. */
  profileUriHash: string | null;
};

type SaidDiffEvent = {
  kind: SaidEventKind;
  fromOwner: string | null;
  toOwner: string;
};

export type SaidClassification = {
  /** Identities to upsert with no event (unchanged, silently adopted, or seeded). */
  plain: SaidIdentity[];
  /** Identities with at least one event to attribute, in owner order. */
  eventful: Array<{ identity: SaidIdentity; events: SaidDiffEvent[] }>;
  /** Eventful identities past the per-pass event cap: neither upserted nor evented. */
  deferredByCap: number;
};

function profileUriHashOf(identity: SaidIdentity): string {
  return buildSaidDirectoryDraft(identity).profileUriHash ?? "";
}

/**
 * Pure diff between one on-chain pass and the source's own directory rows.
 * Seed = inventory: every identity is a plain upsert and no event fires.
 * - an identity with no prior row registers;
 * - a prior row with a null registrant was never chain-acknowledged, so the
 *   chain state is adopted silently;
 * - an authority different from the prior registrant is a transfer;
 * - a metadata URI whose hash differs from the prior hash is a profile_update
 *   (a null prior hash adopts silently: the first live pass under this schema).
 * Candidates past the per-pass event cap defer wholesale.
 */
export function classifySaidDiff(input: {
  seed: boolean;
  identities: SaidIdentity[];
  prior: Map<string, SaidPriorEntry>;
}): SaidClassification {
  if (input.seed) return { plain: input.identities, eventful: [], deferredByCap: 0 };
  const plain: SaidIdentity[] = [];
  const eventful: SaidClassification["eventful"] = [];
  let eventTotal = 0;
  let deferredByCap = 0;
  for (const identity of [...input.identities].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))) {
    const before = input.prior.get(identity.owner);
    const events: SaidDiffEvent[] = [];
    if (!before) {
      events.push({ kind: "register", fromOwner: null, toOwner: identity.authority });
    } else if (before.registrant !== null) {
      if (identity.authority !== before.registrant) {
        events.push({ kind: "transfer", fromOwner: before.registrant, toOwner: identity.authority });
      }
      if (before.profileUriHash !== null && before.profileUriHash !== profileUriHashOf(identity)) {
        events.push({ kind: "profile_update", fromOwner: null, toOwner: identity.authority });
      }
    }
    if (events.length === 0) {
      plain.push(identity);
      continue;
    }
    if (eventTotal + events.length > SAID_CHAIN_MAX_EVENTS_PER_PASS) {
      deferredByCap += 1;
      continue;
    }
    eventTotal += events.length;
    eventful.push({ identity, events });
  }
  return { plain, eventful, deferredByCap };
}

/**
 * The SAID program's own instruction names from one transaction's log
 * messages. Scoping follows the runtime program stack ("Program <id> invoke
 * [depth]" pushes, "Program <id> success" pops), so an instruction another
 * program logs, or one the SAID program invokes at depth through a CPI, is
 * never mistaken for a top-level SAID instruction. Anchor prints
 * "Program log: Instruction: <Name>" for each handler.
 */
export function extractSaidInstructions(logs: unknown): string[] {
  if (!Array.isArray(logs)) return [];
  const instructions: string[] = [];
  const stack: string[] = [];
  for (const line of logs as Array<unknown>) {
    if (typeof line !== "string") continue;
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(line);
    if (invoke !== null) {
      const depth = Number(invoke[2]);
      stack.length = depth > 1 ? depth - 1 : 0;
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program [1-9A-HJ-NP-Za-km-z]{32,44} success$/.test(line)) {
      if (stack.length > 0) stack.pop();
      continue;
    }
    if (stack[stack.length - 1] !== SAID_PROGRAM) continue;
    const named = /^Program log: Instruction: (\S+)$/.exec(line);
    if (named !== null) instructions.push(named[1]!);
  }
  return instructions;
}

const MATCHING_INSTRUCTIONS: Record<SaidEventKind, readonly string[]> = {
  register: ["RegisterAgent", "RegisterAndStake", "SponsorRegister"],
  profile_update: ["UpdateAgent"],
  transfer: ["TransferAuthority"],
};

/** Whether a transaction's SAID instructions include the one that makes this kind of change. */
export function saidInstructionsMatch(kind: SaidEventKind, instructions: string[]): boolean {
  return instructions.some(name => MATCHING_INSTRUCTIONS[kind].includes(name));
}

/** The successful signatures from a getSignaturesForAddress result, newest first. */
export function successfulSaidSignatures(result: unknown): string[] {
  if (!Array.isArray(result)) throw new Error("SAID signature scan did not return a list.");
  const signatures: string[] = [];
  for (const entry of result as Array<{ signature?: unknown; err?: unknown } | null>) {
    if (!entry || typeof entry.signature !== "string" || entry.signature.length < 32) continue;
    if (entry.err === null || entry.err === undefined) signatures.push(entry.signature);
  }
  return signatures;
}

type SaidAttribution = {
  /** Ledger events, each anchored to a matching transaction. */
  events: SolanaChainActivityEvent[];
  /** Identities to upsert: the plain ones' complements that were anchored or adopted unanchored. */
  upserts: SaidIdentity[];
  /** Changes adopted into the directory with no ledger row (the walk could not anchor them). */
  unanchoredCount: number;
  /** Eventful identities the pass budget did not reach: not upserted, re-detected next pass. */
  deferredByBudgetCount: number;
};

/**
 * Anchors each eventful identity's changes. `call` is one paced, parsed
 * JSON-RPC call (the caller owns pacing, retry, and request counting), so this
 * is testable without a network. Makes no database calls.
 */
export async function attributeSaidEvents(input: {
  eventful: SaidClassification["eventful"];
  slot: number;
  call: (method: string, params: unknown[]) => Promise<unknown>;
}): Promise<SaidAttribution> {
  const events: SolanaChainActivityEvent[] = [];
  const upserts: SaidIdentity[] = [];
  let unanchoredCount = 0;
  let deferredByBudgetCount = 0;
  let passFetches = 0;
  const instructionsBySignature = new Map<string, string[] | null>();

  for (const { identity, events: changes } of input.eventful) {
    // Pass budget exhausted before this identity could be examined at all.
    if (passFetches >= SAID_PASS_TX_FETCH_BUDGET) {
      deferredByBudgetCount += 1;
      continue;
    }
    const scanned = successfulSaidSignatures(
      await input.call("getSignaturesForAddress", [identity.account, { limit: SAID_SIGNATURE_SCAN_LIMIT }])
    );
    let identityFetches = 0;
    let budgetLimited = false;
    const anchored: SolanaChainActivityEvent[] = [];
    let unanchored = 0;

    for (const change of changes) {
      let anchor: string | null = null;
      for (const signature of scanned) {
        let instructions = instructionsBySignature.get(signature);
        if (instructions === undefined) {
          if (identityFetches >= SAID_IDENTITY_TX_FETCH_CAP) break;
          if (passFetches >= SAID_PASS_TX_FETCH_BUDGET) {
            budgetLimited = true;
            break;
          }
          identityFetches += 1;
          passFetches += 1;
          const transaction = await input.call("getTransaction", getTransactionParams(signature));
          // A pruned or unavailable transaction (null on providers with bounded
          // history) is skipped, not fatal: the walk keeps going.
          const meta =
            transaction !== null && typeof transaction === "object"
              ? (transaction as { meta?: { logMessages?: unknown } | null }).meta
              : null;
          instructions = meta === null || meta === undefined ? null : extractSaidInstructions(meta.logMessages);
          instructionsBySignature.set(signature, instructions);
        }
        if (instructions !== null && saidInstructionsMatch(change.kind, instructions)) {
          anchor = signature;
          break;
        }
      }
      if (budgetLimited) break;
      if (anchor === null) {
        unanchored += 1;
        continue;
      }
      anchored.push({
        kind: change.kind,
        externalKey: identity.owner,
        transactionSignature: anchor,
        slot: input.slot,
        fromOwner: change.fromOwner,
        toOwner: change.toOwner,
      });
    }

    if (budgetLimited) {
      // A budget verdict is not an evidence verdict: defer the whole identity
      // so the next pass re-detects every change on it under a fresh budget.
      deferredByBudgetCount += 1;
      continue;
    }
    events.push(...anchored);
    unanchoredCount += unanchored;
    upserts.push(identity);
  }
  return { events, upserts, unanchoredCount, deferredByBudgetCount };
}
