import { applyAgentDirectoryActivityWindow, persistErc8004RegistryObservation, readAgentDirectoryActivityHighWater, upsertAgentDirectoryEntries } from "../db";
import type { IngestionSource } from "../../drizzle/schema";
import { assertRobinhoodModeFitsCursor, fetchRobinhoodRegistry } from "./robinhood";
import { withIngestionRun } from "./runLifecycle";
import type { Erc8004IngestionResult } from "./types";

/**
 * Runs exactly one approved bounded Robinhood Chain ERC-8004 window when an
 * operator requests it or the scheduled worker advances it. Observe mode scans
 * the newest window for reviewed intake; backfill mode acknowledges one older
 * window of chain history into the master directory only; registrants mode
 * re-walks chain history to fill registering wallets into acknowledged
 * entries; activity mode walks the same history for Transfer and URIUpdated
 * events and acknowledges them into the chain-activity ledger — and once that
 * walk is done, keeps advancing a bounded, reorg-checked forward window per
 * run. No walk mode can add reviewed records, so their runs must never be
 * projected. Unattended runs arrive only as trigger "scheduled" against a
 * source handed to the scheduler (migration 0017) and always run activity.
 */
export async function runApprovedRobinhoodRegistrySource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual",
  mode: "observe" | "backfill" | "registrants" | "activity" = "observe"
): Promise<Erc8004IngestionResult> {
  // Operator clicks stay allowed on any execution policy; unattended runs are
  // accepted only from a source handed to the scheduler (migration 0017 flips
  // it once the walk reaches fw: territory); replays stay rejected outright.
  if (trigger === "replay" || (trigger === "scheduled" && source.executionPolicy !== "scheduled")) {
    throw new Error("Scheduled Robinhood ERC-8004 runs require the scheduled execution policy, and replays are rejected outright.");
  }

  // An operator click whose mode cannot run from the persisted cursor (a
  // backfill after bf:done, a registrant fill on the forward walk) is refused
  // here, before a run row exists: it is an operator mistake, not a fault, and
  // must not record a failed run or raise the source's failure count. Scheduled
  // runs are deliberately not pre-checked. They always run the activity walk
  // from fw: territory, and a stuck scheduler is a real fault the run record
  // has to show.
  if (trigger === "manual") assertRobinhoodModeFitsCursor(source.cursor, mode);

  return withIngestionRun(source, trigger, 3, async runId => {
    const snapshot = await fetchRobinhoodRegistry(source, {
      mode,
      // The forward walk seeds from the ledger high-water so its anchor and
      // the public "as of block N" label are the same fact.
      activityHighWaterBlock: mode === "activity" ? await readAgentDirectoryActivityHighWater(source.id) : null,
      // An unattended run does not wait out a throttle for minutes: its tick has 150 seconds, and the next one starts from the same cursor.
      retry: trigger === "scheduled" ? "short" : "patient",
    });
    for (const entry of snapshot.observations) {
      await persistErc8004RegistryObservation({ source, runId, candidate: entry.candidate, observation: entry.observation });
    }
    await upsertAgentDirectoryEntries({ source, runId, entries: snapshot.directory });
    // Activity windows acknowledge into the chain-activity ledger only: the
    // INSERT-IGNORE key makes re-runs idempotent and the rollup recompute
    // stays a pure function of the ledger.
    if (mode === "activity") {
      await applyAgentDirectoryActivityWindow({ source, activity: snapshot.activity });
    }
    // Observe runs are idempotent re-observations of the newest window; they
    // must not erase a partially (or fully) walked backfill, registrant,
    // activity, or forward position.
    const observeCursor =
      source.cursor && (source.cursor.startsWith("bf:") || source.cursor.startsWith("rb:") || source.cursor.startsWith("ac:") || source.cursor.startsWith("fw:"))
        ? source.cursor
        : null;
    return {
      requestCount: snapshot.requestCount,
      discoveredCount: snapshot.discoveredCount,
      acceptedCount: snapshot.observations.length,
      rejectedCount: snapshot.rejectedCount,
      nextCursor: mode === "observe" ? observeCursor : snapshot.walkCursor,
    };
  });
}
