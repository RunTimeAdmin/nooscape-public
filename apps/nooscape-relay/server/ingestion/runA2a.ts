import { persistA2aObservation } from "../db";
import type { IngestionSource } from "../../drizzle/schema";
import { fetchA2aAgentCard } from "./a2a";
import { withIngestionRun } from "./runLifecycle";
import type { A2aIngestionResult } from "./types";

/**
 * Executes exactly one source run. Scheduling stays outside this function so the
 * web process never owns an in-memory polling loop; the database is the source of
 * truth for runs, cursors, source state, and future due-time coordination.
 */
export async function runApprovedA2aSource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual"
): Promise<A2aIngestionResult> {
  return withIngestionRun(source, trigger, 1, async runId => {
    const { candidate, observation } = await fetchA2aAgentCard(source);
    await persistA2aObservation({ source, runId, candidate, observation });
    return {
      requestCount: 1,
      discoveredCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      nextCursor: source.cursor,
    };
  });
}
