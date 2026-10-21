import { persistCensusObservation } from "../db";
import type { IngestionSource } from "../../drizzle/schema";
import { fetchAgentEconomyCensus } from "./agenteconomy";
import { withIngestionRun } from "./runLifecycle";
import type { CensusIngestionResult } from "./types";

/** Runs one read-only aggregate census snapshot without creating agent records. */
export async function runApprovedAgentEconomySource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual"
): Promise<CensusIngestionResult> {
  return withIngestionRun(source, trigger, 1, async runId => {
    const { observation } = await fetchAgentEconomyCensus(source);
    await persistCensusObservation({ source, runId, observation });
    return {
      requestCount: 1,
      discoveredCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      nextCursor: null,
    };
  });
}
