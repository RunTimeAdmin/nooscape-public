import type { IngestionSource } from "../../drizzle/schema";
import { isA2aRegistrySourceKey } from "./a2aRegistryCatalog";
import { runApprovedA2aRegistrySource } from "./runA2aRegistry";
import { runApprovedAgenstrySource } from "./runAgenstry";
import type { CatalogIngestionResult } from "./types";

/**
 * Every `catalog` source runs through here: the A2A registries by their own key, and the Agenstry feed otherwise (its adapter refuses
 * any source that is not the approved feed, so a source key that is nobody's fails and is never read as Agenstry's).
 */
export function runApprovedCatalogSource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual"
): Promise<CatalogIngestionResult> {
  return isA2aRegistrySourceKey(source.sourceKey)
    ? runApprovedA2aRegistrySource(source, trigger)
    : runApprovedAgenstrySource(source, trigger);
}
