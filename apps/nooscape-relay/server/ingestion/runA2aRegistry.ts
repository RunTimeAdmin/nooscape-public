import { listReviewedAddressesOfOtherSources, persistCatalogObservation } from "../db";
import type { IngestionSource } from "../../drizzle/schema";
import { A2A_REGISTRY_PARSER_VERSION, fetchA2aRegistryCatalog, unitsOfUrls } from "./a2aRegistryCatalog";
import { withIngestionRun } from "./runLifecycle";
import type { CatalogIngestionResult } from "./types";

/**
 * Runs one capped, read-only snapshot of an approved A2A registry's public list. A host that already holds a reviewed record from
 * another source is left out, so the same agent is not shown once for each registry that lists it.
 */
export async function runApprovedA2aRegistrySource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual"
): Promise<CatalogIngestionResult> {
  return withIngestionRun(source, trigger, 1, async runId => {
    const skipUnits = unitsOfUrls(await listReviewedAddressesOfOtherSources(source.id));
    const snapshot = await fetchA2aRegistryCatalog(source, { skipUnits });
    for (const entry of snapshot.observations) {
      await persistCatalogObservation({ source, runId, candidate: entry.candidate, observation: entry.observation, parserVersion: A2A_REGISTRY_PARSER_VERSION });
    }
    // The run page counts everything not taken as rejected, so a run that hit the ceiling looks like any other. This says how many parties qualified.
    console.log(
      JSON.stringify({
        event: "nooscape_a2a_registry_run",
        sourceKey: source.sourceKey,
        discovered: snapshot.discoveredCount,
        qualified: snapshot.qualifiedCount,
        accepted: snapshot.observations.length,
        rejected: snapshot.rejectedCount,
      })
    );
    return {
      requestCount: snapshot.requestCount,
      discoveredCount: snapshot.discoveredCount,
      acceptedCount: snapshot.observations.length,
      rejectedCount: snapshot.rejectedCount,
      nextCursor: null,
    };
  });
}
