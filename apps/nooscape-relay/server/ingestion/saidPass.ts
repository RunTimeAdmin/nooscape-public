import type { IngestionSource } from "../../drizzle/schema";
import type { SaidNameLink } from "../saidNamesCore";
import type { DirectoryEntryDraft, SolanaChainActivityEvent } from "./types";
import { attributeSaidEvents, classifySaidDiff, type SaidPriorEntry } from "./saidActivity";
import { buildSaidDirectoryDraft, fetchSaidChainState } from "./saidChain";
import { callSolanaRpc, parseSolanaRpcResult, parseTransactionResult, sleepSolana, SOLANA_RPC_PACING_MS } from "./solanaRpc";

export type SaidPassSnapshot = {
  slot: number;
  requestCount: number;
  enumeratedCount: number;
  /** Directory rows to upsert this pass: every identity except the ones that deferred. */
  drafts: DirectoryEntryDraft[];
  /** The metadata link of each of those identities, for the name step's queue (the draft keeps only its hash). */
  links: SaidNameLink[];
  /** Anchored ledger events. Written before the upsert, never invented. */
  events: SolanaChainActivityEvent[];
  layoutCounts: { v1: number; v2: number; v3: number };
  tailResidueCount: number;
  /** Prior identities missing from the listing (inside the floor): counted, never hidden. */
  vanishedCount: number;
  /** Changes adopted into the directory with no ledger row (the walk could not anchor them). */
  unanchoredCount: number;
  /** Identities left stale for the next pass: past the event cap or the pass fetch budget. */
  deferredCount: number;
};

/**
 * One complete SAID pass: the on-chain enumeration, the diff against the
 * source's own directory rows, and the attribution of each change to the
 * transaction that made it. Makes no database calls: prior state comes in and
 * the runner persists the result (ledger events first, then the directory).
 * The seed pass is a plain inventory with no events.
 */
export async function fetchSaidPass(input: {
  source: IngestionSource;
  seed: boolean;
  prior: Map<string, SaidPriorEntry>;
  rpcUrl?: string;
  nowMs?: number;
  /** Delay before each attribution call; defaults to the shared paced-client interval. */
  pacingMs?: number;
}): Promise<SaidPassSnapshot> {
  const chain = await fetchSaidChainState({
    source: input.source,
    seed: input.seed,
    priorKeys: new Set(input.prior.keys()),
    rpcUrl: input.rpcUrl,
    nowMs: input.nowMs,
  });

  const classification = classifySaidDiff({ seed: input.seed, identities: chain.identities, prior: input.prior });

  let attributionRequests = 0;
  const pacingMs = input.pacingMs ?? SOLANA_RPC_PACING_MS;
  const attribution = await attributeSaidEvents({
    eventful: classification.eventful,
    slot: chain.slot,
    call: async (method, params) => {
      if (pacingMs > 0) await sleepSolana(pacingMs);
      const response = await callSolanaRpc(method, params, { countAttempt: () => (attributionRequests += 1), rpcUrl: input.rpcUrl });
      // A transaction this client cannot read (a version newer than it asked for) is skipped like a pruned one.
      return method === "getTransaction" ? parseTransactionResult(response) : parseSolanaRpcResult(response, method);
    },
  });

  const upserted = [...classification.plain, ...attribution.upserts].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  return {
    slot: chain.slot,
    requestCount: chain.requestCount + attributionRequests,
    enumeratedCount: chain.enumeratedCount,
    drafts: upserted.map(buildSaidDirectoryDraft),
    links: upserted.map(identity => ({ externalKey: identity.owner, uri: identity.uri, createdAtSeconds: identity.createdAtSeconds })),
    events: attribution.events,
    layoutCounts: chain.layoutCounts,
    tailResidueCount: chain.tailResidueCount,
    vanishedCount: chain.vanishedCount,
    unanchoredCount: attribution.unanchoredCount,
    deferredCount: classification.deferredByCap + attribution.deferredByBudgetCount,
  };
}
