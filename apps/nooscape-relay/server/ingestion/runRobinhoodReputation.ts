import { applyAgentDirectoryReputationWindow, readAgentDirectoryReputationHighWater } from "../db";
import type { IngestionSource } from "../../drizzle/schema";
import { assertReputationModeFitsCursor, fetchRobinhoodReputationRegistry } from "./robinhoodReputation";
import { withIngestionRun } from "./runLifecycle";
import type { Erc8004ReputationIngestionResult } from "./types";

/**
 * Runs exactly one approved bounded Robinhood Chain ERC-8004 reputation
 * window when an operator requests it. Backfill mode acknowledges one older
 * window of NewFeedback / FeedbackRevoked events into the ratings ledger;
 * once the backward walk reaches genesis (rb:done), activity mode keeps
 * advancing a bounded, reorg-checked forward window per run. Nothing here can
 * add reviewed records — the ledger rows themselves are the chain facts — so
 * no run is ever projected. The source is manual_only at birth; unattended
 * runs are accepted only from a source an operator has explicitly handed to
 * the scheduler (the same policy flip the activity walk earned), and replays
 * are rejected outright.
 */
export async function runApprovedRobinhoodReputationSource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual",
  mode: "backfill" | "activity" = "backfill"
): Promise<Erc8004ReputationIngestionResult> {
  // Operator clicks stay allowed on any execution policy; unattended runs are
  // accepted only from a source handed to the scheduler; replays stay rejected.
  if (trigger === "replay" || (trigger === "scheduled" && source.executionPolicy !== "scheduled")) {
    throw new Error("Scheduled reputation runs require the scheduled execution policy, and replays are rejected outright.");
  }

  // A mode that cannot run from the persisted cursor (a backfill click after
  // rb:done, or a ratings fill before the backfill reaches genesis) is refused
  // here, before a run row exists: it is an operator mistake, not a fault, and
  // must not record a failed run or raise the source's failure count.
  assertReputationModeFitsCursor(source.cursor, mode);

  // Failure-path request count of 4: chain id, head, implementation slot, and
  // the first (failed) window attempt, the walk's minimum honest call count.
  return withIngestionRun(source, trigger, 4, async runId => {
    const snapshot = await fetchRobinhoodReputationRegistry(source, {
      mode,
      // The forward walk seeds from the ledger high-water so its anchor and
      // the public "measured through" label are the same fact.
      reputationHighWaterBlock: mode === "activity" ? await readAgentDirectoryReputationHighWater(source.id) : null,
    });
    // Every mode acknowledges into the ratings ledger only: the INSERT-IGNORE
    // key makes re-runs idempotent and the pair-ordinal recompute stays a
    // pure function of the ledger.
    await applyAgentDirectoryReputationWindow({ source, events: snapshot.events });
    return {
      requestCount: snapshot.requestCount,
      discoveredCount: snapshot.discoveredCount,
      acceptedCount: snapshot.events.length,
      rejectedCount: snapshot.rejectedCount,
      nextCursor: snapshot.walkCursor,
    };
  });
}
