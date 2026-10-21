import "dotenv/config";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  agentEndpoints,
  agentPublicSnapshots,
  evidenceEvents,
  identityMergeReviews,
  ingestionSources,
  sourceObservationRuns,
  sourceObservations,
  sourceProjectionDecisions,
} from "../drizzle/schema";
import { getDb, listActiveWithdrawnAgentIds, listLiveAtlasRecords } from "./db";

/**
 * Read-only census audit. Mirrors the reviewed-run gate and the withdrawal
 * ledger that serve the public Atlas, then profiles the census it produces:
 *
 * - composition: which approved sources feed the public records, and how
 *   concentrated the census is on a single source;
 * - provenance (fail-closed): every public record must resolve to a valid
 *   retained observation with a raw-object reference, an active source, and a
 *   persisted evidence event for that exact observation;
 * - review candidates (informational, exact signals only): shared endpoint
 *   hashes, name-only collisions, catalog self-listings, placeholder text.
 *   Candidates are reported for review and are never merged or modified by
 *   this tool;
 * - governance: the append-only withdrawal ledger. Records an operator has
 *   withheld are excluded from the served census and from every profile here,
 *   and the excluded ids are reported so the verdict accounts for them.
 *
 * The audit never writes. A public census that cannot prove its own chain of
 * custody is not a census, so provenance violations fail the run.
 */

const REVIEW_DETAIL_LIMIT = 20;
const CONCENTRATION_THRESHOLD_PERCENT = 75;
const SHORT_SUMMARY_CHARACTERS = 24;
const SHORT_NAME_CHARACTERS = 3;

function fail(message: string): never {
  console.error(JSON.stringify({ event: "nooscape_census_audit_failed", message }));
  process.exit(1);
}

function normalizedHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function hostnameOf(url: string): string | null {
  try {
    return normalizedHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

function normalizedText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function capped<T>(items: T[]) {
  return { count: items.length, details: items.slice(0, REVIEW_DETAIL_LIMIT) };
}

async function main() {
  try {
    const db = await getDb();
    if (!db) {
      fail("DATABASE_URL is not configured. The census audit needs the provenance database (production or a restored copy).");
    }

    const served = await listLiveAtlasRecords();
    if (served.length === 0) {
      fail("The reviewed-run gate returned zero public records. Refusing to audit an empty census.");
    }
    const servedIds = served.map(record => record.agentId).sort();

    // listLiveAtlasRecords applies the withdrawal ledger before collapsing
    // rows, so the mirrored gate applies the same filter; otherwise the
    // replication check below would fail on any withheld record.
    const withdrawnAgentIds = await listActiveWithdrawnAgentIds();
    const withdrawnSet = new Set(withdrawnAgentIds);

    // Replicates the public read path (db.ts listLiveAtlasRecords) while keeping
    // the provenance columns the served payload intentionally omits.
    const gatedRows = await db
      .select({
        agentId: agentPublicSnapshots.agentId,
        displayName: agentPublicSnapshots.displayName,
        untrustedSelfDescription: agentPublicSnapshots.untrustedSelfDescription,
        sourceId: agentPublicSnapshots.sourceId,
        observationId: agentPublicSnapshots.sourceObservationId,
        canonicalLocator: sourceObservations.canonicalLocator,
        rawObjectKey: sourceObservations.rawObjectKey,
        contentHash: sourceObservations.contentHash,
        validationStatus: sourceObservations.validationStatus,
        sourceLabel: ingestionSources.label,
        sourceProtocol: ingestionSources.protocol,
        sourceHostname: ingestionSources.allowedHostname,
        sourceState: ingestionSources.state,
        sourceExecutionPolicy: ingestionSources.executionPolicy,
      })
      .from(agentPublicSnapshots)
      .innerJoin(
        sourceProjectionDecisions,
        and(
          eq(sourceProjectionDecisions.sourceId, agentPublicSnapshots.sourceId),
          eq(sourceProjectionDecisions.state, "public"),
          isNotNull(sourceProjectionDecisions.approvedRunId)
        )
      )
      .innerJoin(
        sourceObservationRuns,
        and(
          eq(sourceObservationRuns.runId, sourceProjectionDecisions.approvedRunId),
          eq(sourceObservationRuns.observationId, agentPublicSnapshots.sourceObservationId)
        )
      )
      .innerJoin(sourceObservations, eq(sourceObservations.id, agentPublicSnapshots.sourceObservationId))
      .innerJoin(ingestionSources, eq(ingestionSources.id, agentPublicSnapshots.sourceId))
      .orderBy(desc(agentPublicSnapshots.observedAt));

    type GatedRow = (typeof gatedRows)[number];
    const newestByAgent = new Map<string, GatedRow>();
    for (const row of gatedRows) {
      if (withdrawnSet.has(row.agentId)) continue;
      if (!newestByAgent.has(row.agentId)) newestByAgent.set(row.agentId, row);
    }
    const gated = Array.from(newestByAgent.values());

    const gatedIds = gated.map(row => row.agentId).sort();
    if (servedIds.join(",") !== gatedIds.join(",")) {
      fail(
        `Read-path replication mismatch: the served list has ${servedIds.length} records but the reviewed-run gate reproduced ${gatedIds.length}. The census audit must mirror the public read path exactly.`
      );
    }

    // -- Provenance checks (fail-closed) -------------------------------------
    const violations: Array<Record<string, unknown>> = [];
    for (const row of gated) {
      if (row.validationStatus !== "valid") {
        violations.push({
          agentId: row.agentId,
          sourceId: row.sourceId,
          kind: "observation_not_valid",
          detail: row.validationStatus,
        });
      }
      if (!row.rawObjectKey.trim() || !row.contentHash.trim()) {
        violations.push({ agentId: row.agentId, sourceId: row.sourceId, kind: "missing_raw_object_reference" });
      }
      if (row.sourceState !== "active") {
        violations.push({ agentId: row.agentId, sourceId: row.sourceId, kind: "source_not_active", detail: row.sourceState });
      }
    }

    const evidenceRows = await db
      .select({ agentId: evidenceEvents.agentId, observationId: evidenceEvents.sourceObservationId })
      .from(evidenceEvents)
      .where(inArray(evidenceEvents.agentId, servedIds));
    const evidenceKeys = new Map<string, boolean>();
    for (const row of evidenceRows) {
      evidenceKeys.set(`${row.agentId}|${row.observationId}`, true);
    }
    for (const row of gated) {
      if (!evidenceKeys.has(`${row.agentId}|${row.observationId}`)) {
        violations.push({ agentId: row.agentId, sourceId: row.sourceId, kind: "missing_evidence_event" });
      }
    }

    // Agents that project from more than one approved source — the census
    // corroboration the dedup pipeline exists to serve.
    const sourcesByAgent = new Map<string, string[]>();
    for (const row of gatedRows) {
      if (withdrawnSet.has(row.agentId)) continue;
      const known = sourcesByAgent.get(row.agentId) ?? [];
      if (!known.includes(row.sourceId)) known.push(row.sourceId);
      sourcesByAgent.set(row.agentId, known);
    }
    const multiSourceAgents: Array<Record<string, unknown>> = [];
    sourcesByAgent.forEach((sourceIds, agentId) => {
      if (sourceIds.length > 1) multiSourceAgents.push({ agentId, sourceIdCount: sourceIds.length });
    });

    // -- Composition ---------------------------------------------------------
    const sourceGroups = new Map<
      string,
      { sourceId: string; label: string; protocol: string; executionPolicy: string; hostname: string; records: number }
    >();
    for (const row of gated) {
      const existing = sourceGroups.get(row.sourceId);
      if (existing) {
        existing.records += 1;
      } else {
        sourceGroups.set(row.sourceId, {
          sourceId: row.sourceId,
          label: row.sourceLabel,
          protocol: row.sourceProtocol,
          executionPolicy: row.sourceExecutionPolicy,
          hostname: row.sourceHostname,
          records: 1,
        });
      }
    }
    const bySource = Array.from(sourceGroups.values()).sort((a, b) => b.records - a.records);
    const maxSourceSharePercent = Math.round(((bySource[0]?.records ?? 0) / gated.length) * 100);

    const protocolGroups = new Map<string, { protocol: string; records: number }>();
    for (const row of gated) {
      const existing = protocolGroups.get(row.sourceProtocol);
      if (existing) existing.records += 1;
      else protocolGroups.set(row.sourceProtocol, { protocol: row.sourceProtocol, records: 1 });
    }
    const byProtocol = Array.from(protocolGroups.values()).sort((a, b) => b.records - a.records);

    const tierMix = new Map<string, number>();
    const publisherMix = new Map<string, number>();
    for (const record of served) {
      tierMix.set(record.evidenceTier, (tierMix.get(record.evidenceTier) ?? 0) + 1);
      publisherMix.set(record.publisherState, (publisherMix.get(record.publisherState) ?? 0) + 1);
    }

    // -- Review candidates (exact signals only; never auto-actioned) ---------
    const endpointRows = await db
      .select({
        agentId: agentEndpoints.agentId,
        endpointUrl: agentEndpoints.endpointUrl,
        endpointHash: agentEndpoints.endpointHash,
      })
      .from(agentEndpoints)
      .where(inArray(agentEndpoints.agentId, servedIds));

    const displayNameByAgent = new Map<string, string>();
    for (const row of gated) displayNameByAgent.set(row.agentId, row.displayName);

    const endpointGroups = new Map<string, { endpointUrls: string[]; agentIds: string[] }>();
    for (const row of endpointRows) {
      const entry = endpointGroups.get(row.endpointHash) ?? { endpointUrls: [], agentIds: [] };
      if (!entry.endpointUrls.includes(row.endpointUrl)) entry.endpointUrls.push(row.endpointUrl);
      if (!entry.agentIds.includes(row.agentId)) entry.agentIds.push(row.agentId);
      endpointGroups.set(row.endpointHash, entry);
    }
    const duplicateEndpoints: Array<Record<string, unknown>> = [];
    endpointGroups.forEach(entry => {
      if (entry.agentIds.length > 1) {
        duplicateEndpoints.push({
          endpointUrls: entry.endpointUrls,
          agents: entry.agentIds.map(agentId => ({ agentId, displayName: displayNameByAgent.get(agentId) ?? null })),
        });
      }
    });

    const nameGroups = new Map<string, { name: string; agentIds: string[] }>();
    for (const row of gated) {
      const key = normalizedText(row.displayName);
      const entry = nameGroups.get(key) ?? { name: row.displayName.trim(), agentIds: [] };
      entry.agentIds.push(row.agentId);
      nameGroups.set(key, entry);
    }
    const duplicateNames: Array<Record<string, unknown>> = [];
    nameGroups.forEach(entry => {
      if (entry.agentIds.length > 1) duplicateNames.push({ name: entry.name, agentIds: entry.agentIds });
    });

    const selfListingCandidates: Array<Record<string, unknown>> = [];
    for (const row of gated) {
      // Mirrors the catalog adapter's own rejection rule: only catalog sources
      // may not serve cards from their own host.
      if (row.sourceProtocol !== "catalog") continue;
      const locatorHost = hostnameOf(row.canonicalLocator);
      if (locatorHost && locatorHost === normalizedHostname(row.sourceHostname)) {
        selfListingCandidates.push({
          agentId: row.agentId,
          displayName: row.displayName,
          sourceLabel: row.sourceLabel,
          locatorHost,
        });
      }
    }

    const qualityReviewCandidates: Array<Record<string, unknown>> = [];
    for (const row of gated) {
      const name = row.displayName.trim();
      const summary = (row.untrustedSelfDescription ?? "").trim();
      if (name.length < SHORT_NAME_CHARACTERS) {
        qualityReviewCandidates.push({ agentId: row.agentId, displayName: row.displayName, kind: "display_name_too_short" });
      }
      if (!summary) {
        qualityReviewCandidates.push({ agentId: row.agentId, displayName: row.displayName, kind: "missing_summary" });
      } else {
        if (normalizedText(summary) === normalizedText(name)) {
          qualityReviewCandidates.push({ agentId: row.agentId, displayName: row.displayName, kind: "summary_equals_display_name" });
        }
        if (summary.length < SHORT_SUMMARY_CHARACTERS) {
          qualityReviewCandidates.push({
            agentId: row.agentId,
            displayName: row.displayName,
            kind: "summary_too_short",
            detail: summary,
          });
        }
      }
    }

    const [pendingMergeRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(identityMergeReviews)
      .where(eq(identityMergeReviews.state, "pending"));
    const pendingIdentityMergeReviews = Number(pendingMergeRow?.count ?? 0);

    // -- Verdict -------------------------------------------------------------
    const ok = violations.length === 0;
    console.log(
      JSON.stringify({
        event: "nooscape_census_audit",
        ok,
        generatedAt: new Date().toISOString(),
        servedRecords: served.length,
        composition: {
          bySource,
          byProtocol,
          maxSourceSharePercent,
          concentrated: maxSourceSharePercent >= CONCENTRATION_THRESHOLD_PERCENT,
          tierMix: Array.from(tierMix, entry => ({ tier: entry[0], records: entry[1] })),
          publisherStateMix: Array.from(publisherMix, entry => ({ state: entry[0], records: entry[1] })),
        },
        provenance: {
          checked: gated.length,
          multiSourceAgents: capped(multiSourceAgents),
          violations: capped(violations),
        },
        governance: {
          withdrawnRecordCount: withdrawnAgentIds.length,
          withdrawnAgentIds: withdrawnAgentIds.slice(0, REVIEW_DETAIL_LIMIT),
        },
        reviewCandidates: {
          duplicateEndpointsByHash: capped(duplicateEndpoints),
          duplicateNamesNameOnly: capped(duplicateNames),
          catalogSelfListings: capped(selfListingCandidates),
          quality: capped(qualityReviewCandidates),
          pendingIdentityMergeReviews,
        },
      })
    );
    process.exit(ok ? 0 : 1);
  } catch (error) {
    fail(`Census audit crashed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

void main();
