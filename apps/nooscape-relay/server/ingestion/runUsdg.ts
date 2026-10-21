import { applyUsdgSettlementWindow } from "../db";
import type { IngestionSource } from "../../drizzle/schema";
import { withIngestionRun } from "./runLifecycle";
import { fetchUsdgSettlements } from "./usdg";
import type { UsdgSettlementIngestionResult } from "./types";

/**
 * Runs exactly one approved bounded USDG settlement window when an operator
 * requests it. Settlement runs are ledger acknowledgements only: no
 * observation is retained through the reviewed-evidence pipeline and no
 * directory draft is produced — the ledger rows themselves are the retained
 * chain facts, so no run can ever add reviewed records and run results must
 * never be projected.
 */
export async function runApprovedUsdgSettlementSource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual"
): Promise<UsdgSettlementIngestionResult> {
  if (trigger !== "manual" || source.executionPolicy !== "manual_only") {
    throw new Error("The Robinhood Chain USDG settlement ledger is manual-only and cannot be scheduled or replayed automatically.");
  }

  return withIngestionRun(source, trigger, 4, async runId => {
    const snapshot = await fetchUsdgSettlements(source);
    // The INSERT-IGNORE key makes re-runs idempotent and public totals stay a
    // pure function of the ledger.
    await applyUsdgSettlementWindow({ source, settlements: snapshot.settlements });
    return {
      requestCount: snapshot.requestCount,
      discoveredCount: snapshot.settlements.length + snapshot.rejectedCount,
      acceptedCount: snapshot.settlements.length,
      rejectedCount: snapshot.rejectedCount,
      nextCursor: snapshot.walkCursor,
    };
  });
}
