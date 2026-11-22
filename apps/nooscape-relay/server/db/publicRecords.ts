/** The reviewed records the public sees: snapshots, withdrawals, the live atlas and provenance coverage. Part of server/db.ts, which re-exports every module of this folder. */
import { and, asc, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createHash, randomUUID } from "node:crypto";
import { agentEndpoints, agentPublicSnapshots, agentReadModel, agentRecordWithdrawals, agentRegistrationResolutions, evidenceEvents, ingestionSources, sourceObservationRuns, sourceObservations, sourceProjectionDecisions } from "../../drizzle/schema";
import { nameableRecord, overlayResolvedNames, ROBINHOOD_SOURCE_KEY, type ResolvedName } from "../robinhoodNamesCore";
import { sanitizePrimaryCapability, sanitizePublicText } from "../publicText";
import { OperatorRuleError } from "../operatorRuleError";
import { invalidateDirectoryReads } from "../readCache";
import { getDb, hashValue, requireDb, withInvalidation } from "./core";
import { PublisherKeyState, effectivePublisherKeyState } from "./publisherKeys";

/** Operator withdrawal notices carry reasons and never enter public surfaces. */
export const WITHDRAWAL_EVENT_TYPES = ["RECORD_WITHDRAWN", "RECORD_REINSTATED"] as const;

export type PublicSnapshotRow = {
  agentId: string;
  displayName: string;
  handle: string;
  primaryCapability: string | null;
  summary: string | null;
  protocols: string;
  snapshotPublisherState: string;
  snapshotEvidenceTier: string;
  readModelPublisherState: string | null;
  readModelEvidenceTier: string | null;
  readModelVerificationExpiresAt: Date | null;
  readModelVerifiedCardHash: string | null;
  readModelPublisherExpiresAt: Date | null;
  sourceCount: number;
  lastObservedAt: Date;
};

/** Canonical fingerprint of the public card fields a domain verification pins. */
export function snapshotCardFingerprint(card: {
  displayName: string;
  primaryCapability: string | null;
  summary: string | null;
  protocols: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify([card.displayName, card.primaryCapability ?? "", card.summary ?? "", card.protocols]))
    .digest("hex");
}

/**
 * Read-time publisher-key resolution for the public list path, mirroring the
 * detail path: an allowlisted read-model state whose copied expiry has elapsed
 * resolves to expired without waiting for the next worker tick, so a lapsed
 * key fails closed on the list exactly as it does on validation.
 * `readModelPublisherState` uses the read-model enum (pending maps to
 * "unverified"), which effectivePublisherKeyState treats as pass-through —
 * only "allowlisted" is expiry-sensitive.
 */
function effectivePublisherState(snapshot: PublicSnapshotRow, now: Date) {
  const readModelState = snapshot.readModelPublisherState;
  if (!readModelState) return snapshot.snapshotPublisherState;
  return effectivePublisherKeyState(readModelState as PublisherKeyState, snapshot.readModelPublisherExpiresAt, now);
}

/**
 * Domain-control upgrades are enforced fail-closed at read time: a tier_3
 * read-model overlay projects only while its validity window is open and the
 * card the operator verified (pinned by fingerprint) is still the card being
 * served. Expired, revoked, or changed cards fall back to the snapshot tier
 * (tier_2) until an operator recheck or a new challenge succeeds. Publisher-key
 * upgrades are enforced the same way: a tier_4 overlay projects only while the
 * resolved publisher state is still allowlisted.
 */
function effectiveEvidenceTier(snapshot: PublicSnapshotRow, now: Date, publisherState: string) {
  const readModelTier = snapshot.readModelEvidenceTier;
  if (!readModelTier) return snapshot.snapshotEvidenceTier;
  const domainPinned =
    readModelTier === "tier_3" &&
    (snapshot.readModelVerificationExpiresAt !== null || snapshot.readModelVerifiedCardHash !== null);
  if (domainPinned) {
    const active =
      snapshot.readModelVerificationExpiresAt !== null &&
      snapshot.readModelVerificationExpiresAt > now &&
      snapshot.readModelVerifiedCardHash === snapshotCardFingerprint(snapshot);
    if (!active) return snapshot.snapshotEvidenceTier;
  }
  if (readModelTier === "tier_4" && publisherState !== "allowlisted") return snapshot.snapshotEvidenceTier;
  return readModelTier;
}

/**
 * A canonical agent may legitimately have multiple visible source snapshots.
 * Rows arrive ordered by observedAt descending; only the newest visible row per
 * agent is returned. Descriptive fields stay source-scoped on that row, while
 * live evidence governance (tier and publisher state) is a per-agent fact that
 * only operator-gated, evidence-backed flows can raise: overlay it so an
 * approved verification is never hidden behind projection-time snapshot
 * defaults. Source-served text is sanitized for presentation and version-like
 * capability values are suppressed; the stored snapshot is never modified.
 * Kept pure so the collapse rule stays unit tested.
 */
export function collapseVisibleSnapshots(rows: PublicSnapshotRow[], now: Date = new Date()) {
  const newestByAgent = new Map<string, PublicSnapshotRow>();
  for (const row of rows) {
    if (!newestByAgent.has(row.agentId)) newestByAgent.set(row.agentId, row);
  }
  return Array.from(newestByAgent.values()).map(snapshot => {
    const publisherState = effectivePublisherState(snapshot, now);
    return {
      agentId: snapshot.agentId,
      displayName: sanitizePublicText(snapshot.displayName, 255) ?? snapshot.displayName,
      handle: snapshot.handle,
      primaryCapability: sanitizePrimaryCapability(snapshot.primaryCapability),
      untrustedSummary: sanitizePublicText(snapshot.summary),
      protocols: snapshot.protocols,
      publisherState,
      evidenceTier: effectiveEvidenceTier(snapshot, now, publisherState),
      sourceCount: snapshot.sourceCount,
      lastObservedAt: snapshot.lastObservedAt,
    };
  });
}

/**
 * Withdrawal resolution is a pure fold over the append-only ledger in event
 * order (oldest first): the newest event per agent decides whether the record
 * is withheld. Kept pure so the rule stays unit tested.
 */
export function resolveWithdrawnAgentIds(
  events: Array<{ agentId: string; action: "withdraw" | "reinstate" }>
) {
  const latestActionByAgent = new Map<string, "withdraw" | "reinstate">();
  for (const event of events) latestActionByAgent.set(event.agentId, event.action);
  const withdrawn: string[] = [];
  latestActionByAgent.forEach((action, agentId) => {
    if (action === "withdraw") withdrawn.push(agentId);
  });
  return withdrawn.sort();
}

/**
 * Resolves the currently withdrawn agentIds from the append-only ledger.
 * Fails closed: if the ledger cannot be read (for example before migration
 * 0010 is applied), the error propagates so the public read refuses to serve
 * rather than risk exposing a record an operator withheld. The empty census
 * during that window is the reviewed deploy signal for the operator bridge.
 */
export async function listActiveWithdrawnAgentIds() {
  const db = requireDb(await getDb());
  const events = await db
    .select({ agentId: agentRecordWithdrawals.agentId, action: agentRecordWithdrawals.action })
    .from(agentRecordWithdrawals)
    .orderBy(asc(agentRecordWithdrawals.id));
  return resolveWithdrawnAgentIds(events);
}

/**
 * Shared join conditions for the reviewed-run visibility gate. A snapshot is
 * visible only when its source is currently `active`, its source decision is
 * "public", AND its observation is linked to the decision's explicitly
 * approved run. Every public read composes these exact conditions
 * (listLiveAtlasRecords, getLiveAtlasProvenanceCoverage,
 * getNewestVisibleSnapshotCard, isAgentPubliclyVisible, and the persisted
 * evidence pull), so visibility logic cannot drift apart.
 */

/** Decision side of the gate: public state bound to an explicitly approved run. */
function publicDecisionJoinCondition() {
  return and(
    eq(sourceProjectionDecisions.sourceId, agentPublicSnapshots.sourceId),
    eq(sourceProjectionDecisions.state, "public"),
    isNotNull(sourceProjectionDecisions.approvedRunId)
  );
}

/** Observation side of the gate: the retained observation belongs to the approved run. */
function approvedRunJoinCondition() {
  return and(
    eq(sourceObservationRuns.runId, sourceProjectionDecisions.approvedRunId),
    eq(sourceObservationRuns.observationId, agentPublicSnapshots.sourceObservationId)
  );
}

/**
 * Source-state side of the gate: a paused or rejected source stops serving its
 * already-public records immediately — the operator's decision about the
 * source outranks the earlier projection decision, with no write-back needed.
 */
function activeSourceJoinCondition() {
  return and(eq(ingestionSources.id, agentPublicSnapshots.sourceId), eq(ingestionSources.state, "active"));
}

function visibilityGateJoins(db: ReturnType<typeof drizzle>) {
  return db
    .select({ agentId: agentPublicSnapshots.agentId })
    .from(agentPublicSnapshots)
    .innerJoin(sourceProjectionDecisions, publicDecisionJoinCondition())
    .innerJoin(sourceObservationRuns, approvedRunJoinCondition())
    .innerJoin(ingestionSources, activeSourceJoinCondition());
}

/**
 * Public records are readable only through the reviewed-run gate: a snapshot is
 * visible when its source is currently `active`, its source decision is
 * `public`, and its retained observation is linked to the decision's explicitly
 * approved run. Snapshots and observations are retained per content hash, so
 * the last approved version stays visible while a newer, unreviewed run is
 * withheld; pausing or rejecting a source hides its records immediately.
 */
export async function listLiveAtlasRecords() {
  const db = requireDb(await getDb());
  const snapshots = await db
    .select({
      agentId: agentPublicSnapshots.agentId,
      displayName: agentPublicSnapshots.displayName,
      handle: agentPublicSnapshots.displayHandle,
      primaryCapability: agentPublicSnapshots.primaryCapability,
      summary: agentPublicSnapshots.untrustedSelfDescription,
      protocols: agentPublicSnapshots.protocols,
      snapshotPublisherState: agentPublicSnapshots.publisherState,
      snapshotEvidenceTier: agentPublicSnapshots.evidenceTier,
      readModelPublisherState: agentReadModel.publisherState,
      readModelEvidenceTier: agentReadModel.evidenceTier,
      readModelVerificationExpiresAt: agentReadModel.verificationExpiresAt,
      readModelVerifiedCardHash: agentReadModel.verifiedCardHash,
      readModelPublisherExpiresAt: agentReadModel.publisherExpiresAt,
      sourceCount: agentPublicSnapshots.sourceCount,
      lastObservedAt: agentPublicSnapshots.observedAt,
    })
    .from(agentPublicSnapshots)
    .innerJoin(sourceProjectionDecisions, publicDecisionJoinCondition())
    .innerJoin(sourceObservationRuns, approvedRunJoinCondition())
    .innerJoin(ingestionSources, activeSourceJoinCondition())
    .leftJoin(agentReadModel, eq(agentReadModel.agentId, agentPublicSnapshots.agentId))
    .orderBy(desc(agentPublicSnapshots.observedAt));

  // Withdrawals apply before the collapse: a record an operator withheld never
  // reaches the served set, and an unreadable ledger fails the whole read
  // rather than risk exposing it.
  const withdrawn = new Set(await listActiveWithdrawnAgentIds());
  return withRobinhoodNames(db, collapseVisibleSnapshots(snapshots.filter(row => !withdrawn.has(row.agentId))));
}

/**
 * Lays the names read from Robinhood registration links over the placeholders ("Agent #8623") of served records
 * (docs/approvals/2026-10-17-robinhood-names.md). Only the display name changes: the retained observation, the evidence packet
 * and the handle do not. A record that gets a name also carries `nameReadAt`, the day it was read, so a page can say where the
 * name came from. It reads the resolutions table only when a served record has a placeholder and a link to read, and it
 * fails open: a read that cannot be made leaves the records as they were, never a record out of the set.
 */
async function withRobinhoodNames<T extends { agentId: string; displayName: string; untrustedSummary: string | null }>(db: ReturnType<typeof drizzle>, records: T[]): Promise<Array<T & { nameReadAt?: string }>> {
  if (!records.some(record => nameableRecord(record) !== null)) return records;
  try {
    const rows = await db
      .select({ uriHash: agentRegistrationResolutions.uriHash, resolvedName: agentRegistrationResolutions.resolvedName, fetchedAt: agentRegistrationResolutions.fetchedAt })
      .from(agentRegistrationResolutions)
      .innerJoin(ingestionSources, eq(ingestionSources.id, agentRegistrationResolutions.sourceId))
      .where(and(eq(ingestionSources.sourceKey, ROBINHOOD_SOURCE_KEY), eq(agentRegistrationResolutions.status, "resolved")));
    const resolved = new Map<string, ResolvedName>();
    for (const row of rows) if (row.resolvedName) resolved.set(row.uriHash, { name: row.resolvedName, readAt: row.fetchedAt ? row.fetchedAt.toISOString() : null });
    return overlayResolvedNames(records, resolved);
  } catch {
    return records;
  }
}

/**
 * Single-record visibility check using the same rule as listLiveAtlasRecords:
 * visible when the agent has at least one snapshot from a public source linked
 * to that source's approved run AND the agent is not withdrawn. This predicate
 * uses the shared visibilityGateJoins helper so the rules cannot drift apart.
 */
export async function isAgentPubliclyVisible(agentId: string): Promise<boolean> {
  const db = requireDb(await getDb());

  const [snapshot] = await visibilityGateJoins(db)
    .where(eq(agentPublicSnapshots.agentId, agentId))
    .limit(1);

  if (!snapshot) return false;

  // The snapshot above was found under the column's collation, where case and a trailing space do not matter, so the withdrawal is matched the
  // same way (outside audit of 2026-11-05, lead N6).
  const key = agentId.trimEnd().toLowerCase();
  const withdrawn = await listActiveWithdrawnAgentIds();
  return !withdrawn.some(id => id.trimEnd().toLowerCase() === key);
}

/**
 * The addresses the records that are public today from sources other than `sourceId` are held at, by the same gate as every public read
 * (an active source, a public decision, the approved run) and without the records an operator withdrew. A record with an endpoint row gives
 * that address. A catalog record has none, on purpose, so it gives the host its card is served from (its snapshot's `partyHost`) as
 * `https://host/`. A registry adapter reads this before it picks records, so a party that already holds a reviewed record from another
 * source is not taken a second time. Read from the endpoint rows alone, the rule saw nothing between catalog sources
 * (docs/catalog-party-rule-2026-11-07.md).
 */
export async function listReviewedAddressesOfOtherSources(sourceId: string): Promise<string[]> {
  const db = requireDb(await getDb());
  const rows = await db
    .select({ agentId: agentPublicSnapshots.agentId, endpointUrl: agentEndpoints.endpointUrl, partyHost: agentPublicSnapshots.partyHost })
    .from(agentPublicSnapshots)
    .innerJoin(sourceProjectionDecisions, publicDecisionJoinCondition())
    .innerJoin(sourceObservationRuns, approvedRunJoinCondition())
    .innerJoin(ingestionSources, activeSourceJoinCondition())
    .leftJoin(agentEndpoints, eq(agentEndpoints.agentId, agentPublicSnapshots.agentId))
    .where(notInArray(agentPublicSnapshots.sourceId, [sourceId]));
  const withdrawn = new Set((await listActiveWithdrawnAgentIds()).map(id => id.trimEnd().toLowerCase()));
  const addresses = new Set<string>();
  for (const row of rows) {
    if (withdrawn.has(row.agentId.trimEnd().toLowerCase())) continue;
    if (row.endpointUrl) addresses.add(row.endpointUrl);
    if (row.partyHost) addresses.add(`https://${row.partyHost}/`);
  }
  return Array.from(addresses);
}

/** Append-only withdrawal ledger in event order (oldest first). */
export async function listRecordWithdrawalEvents() {
  const db = requireDb(await getDb());
  return db
    .select({
      agentId: agentRecordWithdrawals.agentId,
      action: agentRecordWithdrawals.action,
      reason: agentRecordWithdrawals.reason,
      decidedAt: agentRecordWithdrawals.decidedAt,
    })
    .from(agentRecordWithdrawals)
    .orderBy(asc(agentRecordWithdrawals.id));
}

/**
 * Newest reviewed-run snapshot summary per requested agent. Used by the
 * operator control plane: withdrawn records no longer appear in the served
 * set, so this lookup resolves their display identity from the retained
 * snapshot instead.
 */
export async function listNewestGatedSnapshotSummaries(agentIds: string[]) {
  if (agentIds.length === 0) return [];
  const db = requireDb(await getDb());
  const rows = await db
    .select({
      agentId: agentPublicSnapshots.agentId,
      displayName: agentPublicSnapshots.displayName,
      handle: agentPublicSnapshots.displayHandle,
      observedAt: agentPublicSnapshots.observedAt,
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
    .where(inArray(agentPublicSnapshots.agentId, agentIds))
    .orderBy(desc(agentPublicSnapshots.observedAt));
  const newestByAgent = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!newestByAgent.has(row.agentId)) newestByAgent.set(row.agentId, row);
  }
  return Array.from(newestByAgent.values());
}

/**
 * Append-only withdrawal decision: records the operator's reason in the ledger
 * and persists a matching evidence event against the record's newest
 * reviewed-run observation. The source, its approved run, and all retained
 * evidence remain untouched; the read path re-resolves visibility from the
 * newest ledger event, so a reinstate restores the record.
 */
export const decideRecordWithdrawal = withInvalidation(decideRecordWithdrawalImpl, invalidateDirectoryReads);

async function decideRecordWithdrawalImpl(input: {
  agentId: string;
  action: "withdraw" | "reinstate";
  reason: string;
  decidedByUserId: number;
}) {
  const db = requireDb(await getDb());
  const now = new Date();
  return db.transaction(async tx => {
    const [newest] = await tx
      .select({ observationId: agentPublicSnapshots.sourceObservationId })
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
      .where(eq(agentPublicSnapshots.agentId, input.agentId))
      .orderBy(desc(agentPublicSnapshots.observedAt))
      .limit(1);
    if (!newest) {
      throw new OperatorRuleError("No reviewed-run observation exists for this record; withdrawal applies only to records under the served gate.");
    }
    await tx.insert(agentRecordWithdrawals).values({
      agentId: input.agentId,
      action: input.action,
      reason: input.reason,
      decidedByUserId: input.decidedByUserId,
      decidedAt: now,
    });
    await tx.insert(evidenceEvents).values({
      id: randomUUID(),
      agentId: input.agentId,
      sourceObservationId: newest.observationId,
      eventType: input.action === "withdraw" ? "RECORD_WITHDRAWN" : "RECORD_REINSTATED",
      description:
        input.action === "withdraw"
          ? `Record withdrawn from the public census by an operator: ${input.reason} The source, its approved run, and retained evidence are unchanged.`
          : `Record reinstated to the public census by an operator: ${input.reason} Visibility re-resolves through the reviewed-run gate.`,
      proofReference: "nooscape-census-governance",
      payloadHash: hashValue(`${input.agentId}\n${input.action}\n${input.reason}`),
      observedAt: now,
    });
    return { agentId: input.agentId, action: input.action } as const;
  });
}

/**
 * Newest card among rows visible under the reviewed-run gate — the exact card
 * domain verification pins: what an operator can see is what gets verified,
 * and a later approved card change breaks the pin until the operator rechecks.
 */
export async function getNewestVisibleSnapshotCard(agentId: string) {
  const db = requireDb(await getDb());
  const [card] = await db
    .select({
      displayName: agentPublicSnapshots.displayName,
      primaryCapability: agentPublicSnapshots.primaryCapability,
      summary: agentPublicSnapshots.untrustedSelfDescription,
      protocols: agentPublicSnapshots.protocols,
    })
    .from(agentPublicSnapshots)
    .innerJoin(sourceProjectionDecisions, publicDecisionJoinCondition())
    .innerJoin(sourceObservationRuns, approvedRunJoinCondition())
    .innerJoin(ingestionSources, activeSourceJoinCondition())
    .where(eq(agentPublicSnapshots.agentId, agentId))
    .orderBy(desc(agentPublicSnapshots.observedAt))
    .limit(1);
  return card ?? null;
}

/**
 * Computes a public-safe coverage summary without exposing raw-object keys or
 * evidence payloads. A record is provenance-ready only when its approved
 * source-scoped snapshot has at least one persisted evidence event for the
 * exact retained observation.
 */
export async function getLiveAtlasProvenanceCoverage() {
  const db = requireDb(await getDb());
  const rows = await db
    .select({
      agentId: agentPublicSnapshots.agentId,
      evidenceEventId: evidenceEvents.id,
    })
    .from(agentPublicSnapshots)
    .innerJoin(sourceProjectionDecisions, publicDecisionJoinCondition())
    .innerJoin(sourceObservationRuns, approvedRunJoinCondition())
    .innerJoin(ingestionSources, activeSourceJoinCondition())
    .leftJoin(
      evidenceEvents,
      and(
        eq(evidenceEvents.agentId, agentPublicSnapshots.agentId),
        eq(evidenceEvents.sourceObservationId, agentPublicSnapshots.sourceObservationId)
      )
    );

  // Coverage mirrors the served set: withdrawn records are excluded exactly as
  // in listLiveAtlasRecords so the public counts stay reconciled.
  const withdrawn = new Set(await listActiveWithdrawnAgentIds());
  const coverageByAgent = new Map<string, boolean>();
  for (const row of rows) {
    if (withdrawn.has(row.agentId)) continue;
    coverageByAgent.set(row.agentId, Boolean(coverageByAgent.get(row.agentId) || row.evidenceEventId));
  }
  const publicRecordCount = coverageByAgent.size;
  const provenanceReadyCount = Array.from(coverageByAgent.values()).filter(Boolean).length;
  return {
    publicRecordCount,
    provenanceReadyCount,
    coveragePercent: publicRecordCount === 0 ? 0 : Math.round((provenanceReadyCount / publicRecordCount) * 100),
  } as const;
}

/**
 * Returns public provenance references for a persisted record. Raw object bytes
 * remain private in RustFS; callers receive only their stable digest and locator.
 * Entries bind to the reviewed-run gate — only events whose observation belongs
 * to an approved run of a currently-active source with a public projection
 * decision are pulled, and operator withdrawal notices are excluded, so an
 * envelope never carries unapproved-run events or operator reasons.
 */
export async function listPersistedEvidenceEntries(agentId: string) {
  const db = requireDb(await getDb());
  return db
    .select({
      id: evidenceEvents.id,
      observedAt: evidenceEvents.observedAt,
      event: evidenceEvents.eventType,
      detail: evidenceEvents.description,
      proofReference: evidenceEvents.proofReference,
      payloadHash: evidenceEvents.payloadHash,
      observationId: sourceObservations.id,
      contentHash: sourceObservations.contentHash,
      canonicalLocator: sourceObservations.canonicalLocator,
      protocol: sourceObservations.protocol,
      validationStatus: sourceObservations.validationStatus,
      sourceLabel: ingestionSources.label,
      sourceRoot: ingestionSources.rootUrl,
    })
    .from(evidenceEvents)
    .innerJoin(sourceObservations, eq(evidenceEvents.sourceObservationId, sourceObservations.id))
    .innerJoin(ingestionSources, and(eq(sourceObservations.sourceId, ingestionSources.id), eq(ingestionSources.state, "active")))
    .innerJoin(
      sourceProjectionDecisions,
      and(
        eq(sourceProjectionDecisions.sourceId, sourceObservations.sourceId),
        eq(sourceProjectionDecisions.state, "public"),
        isNotNull(sourceProjectionDecisions.approvedRunId)
      )
    )
    .innerJoin(
      sourceObservationRuns,
      and(
        eq(sourceObservationRuns.runId, sourceProjectionDecisions.approvedRunId),
        eq(sourceObservationRuns.observationId, evidenceEvents.sourceObservationId)
      )
    )
    .where(and(eq(evidenceEvents.agentId, agentId), notInArray(evidenceEvents.eventType, [...WITHDRAWAL_EVENT_TYPES])))
    .orderBy(desc(evidenceEvents.observedAt));
}
