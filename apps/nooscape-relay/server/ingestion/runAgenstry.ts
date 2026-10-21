import { persistCatalogObservation, upsertAgentDirectoryEntries } from "../db";
import type { IngestionSource } from "../../drizzle/schema";
import { fetchAgenstryCatalog } from "./agenstry";
import { withIngestionRun } from "./runLifecycle";
import type { CatalogIngestionResult } from "./types";

/** Runs one capped, read-only catalog snapshot from the explicitly approved feed. */
export async function runApprovedAgenstrySource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual"
): Promise<CatalogIngestionResult> {
  return withIngestionRun(source, trigger, 1, async runId => {
    const snapshot = await fetchAgenstryCatalog(source);
    for (const entry of snapshot.observations) {
      await persistCatalogObservation({ source, runId, candidate: entry.candidate, observation: entry.observation });
    }
    await upsertAgentDirectoryEntries({ source, runId, entries: snapshot.directory });
    return {
      requestCount: 1,
      discoveredCount: snapshot.discoveredCount,
      acceptedCount: snapshot.observations.length,
      rejectedCount: snapshot.rejectedCount,
      nextCursor: null,
    };
  });
}
