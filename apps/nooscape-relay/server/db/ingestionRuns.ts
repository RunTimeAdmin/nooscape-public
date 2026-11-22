/** Source decisions and ingestion runs, and the observations each kind of source persists. Part of server/db.ts, which re-exports every module of this folder. */
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentEndpoints, agentIdentities, agentPublicSnapshots, agentReadModel, agents, evidenceEvents, ingestionRuns, ingestionSources, IngestionSource, reviewItems, sourceObservationRuns, sourceObservations, sourceProjectionDecisions } from "../../drizzle/schema";
import { type A2aNormalizedCandidate, type CatalogNormalizedCandidate, type Erc8004RegistryCandidate, type RawObservationInput, type SolanaRegistryCandidate } from "../ingestion/types";
import { partyHostOf } from "../partyHost";
import { invalidateDirectoryReads } from "../readCache";
import { getDb, hashValue, mapPositionFromHandle, requireDb, safeErrorSummary, withInvalidation } from "./core";

export const decideIngestionSource = withInvalidation(decideIngestionSourceImpl, invalidateDirectoryReads);

async function decideIngestionSourceImpl(input: {
  sourceId: string;
  decision: "active" | "rejected" | "paused";
  decidedByUserId: number;
  rationale: string;
}) {
  const db = requireDb(await getDb());
  const now = new Date();
  const nextRunAt = input.decision === "active" ? now : null;

  await db.transaction(async tx => {
    await tx
      .update(ingestionSources)
      .set({ state: input.decision, nextRunAt })
      .where(eq(ingestionSources.id, input.sourceId));
    await tx
      .update(reviewItems)
      .set({
        status: input.decision === "active" ? "approved" : "rejected",
        rationale: input.rationale,
        decidedByUserId: input.decidedByUserId,
        decidedAt: now,
      })
      .where(
        and(
          eq(reviewItems.subjectType, "ingestion_source"),
          eq(reviewItems.subjectId, input.sourceId),
          eq(reviewItems.status, "pending")
        )
      );
  });
}

/**
 * Records a deliberate review-to-public (or revocation) presentation decision.
 * A `public` decision must name the reviewed completed run (`approvedRunId`)
 * that becomes the visible set; revocation clears the binding.
 */
export const decideSourceProjection = withInvalidation(decideSourceProjectionImpl, invalidateDirectoryReads);

async function decideSourceProjectionImpl(input: {
  sourceId: string;
  state: "public" | "revoked";
  rationale: string;
  decidedByUserId: number;
  approvedRunId: string | null;
}) {
  const db = requireDb(await getDb());
  const now = new Date();
  await db
    .insert(sourceProjectionDecisions)
    .values({ ...input, decidedAt: now })
    .onDuplicateKeyUpdate({
      set: {
        state: input.state,
        rationale: input.rationale,
        decidedByUserId: input.decidedByUserId,
        decidedAt: now,
        approvedRunId: input.approvedRunId,
      },
    });
}

/** The newest completed run for a source; the only run a public decision may bind to. */
export async function getLatestCompletedRunForSource(sourceId: string) {
  const db = requireDb(await getDb());
  const [run] = await db
    .select({
      id: ingestionRuns.id,
      trigger: ingestionRuns.trigger,
      discoveredCount: ingestionRuns.discoveredCount,
      acceptedCount: ingestionRuns.acceptedCount,
      rejectedCount: ingestionRuns.rejectedCount,
      finishedAt: ingestionRuns.finishedAt,
    })
    .from(ingestionRuns)
    .where(
      and(
        eq(ingestionRuns.sourceId, sourceId),
        eq(ingestionRuns.status, "completed"),
        isNotNull(ingestionRuns.finishedAt)
      )
    )
    .orderBy(desc(ingestionRuns.finishedAt), desc(ingestionRuns.startedAt))
    .limit(1);
  return run;
}

/** Validates a caller-supplied run before it may be bound to a public decision. */
export async function getCompletedRunForSource(sourceId: string, runId: string) {
  const db = requireDb(await getDb());
  const [run] = await db
    .select({
      id: ingestionRuns.id,
      trigger: ingestionRuns.trigger,
      discoveredCount: ingestionRuns.discoveredCount,
      acceptedCount: ingestionRuns.acceptedCount,
      rejectedCount: ingestionRuns.rejectedCount,
      finishedAt: ingestionRuns.finishedAt,
    })
    .from(ingestionRuns)
    .where(
      and(
        eq(ingestionRuns.id, runId),
        eq(ingestionRuns.sourceId, sourceId),
        eq(ingestionRuns.status, "completed"),
        isNotNull(ingestionRuns.finishedAt)
      )
    )
    .limit(1);
  return run;
}

/** Per-source projection decisions for the operator control plane. */
export async function listSourceProjectionDecisions() {
  const db = requireDb(await getDb());
  return db.select().from(sourceProjectionDecisions);
}

/** Distinct agents whose retained snapshot was observed in one run. */
export async function countRunLinkedPublicSnapshots(runId: string) {
  const db = requireDb(await getDb());
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${agentPublicSnapshots.agentId})` })
    .from(agentPublicSnapshots)
    .innerJoin(
      sourceObservationRuns,
      and(
        eq(sourceObservationRuns.runId, runId),
        eq(sourceObservationRuns.observationId, agentPublicSnapshots.sourceObservationId)
      )
    );
  return Number(row?.count ?? 0);
}

export async function beginIngestionRun(source: IngestionSource, trigger: "manual" | "scheduled" | "replay") {
  const db = requireDb(await getDb());
  const runId = randomUUID();
  await db.insert(ingestionRuns).values({
    id: runId,
    sourceId: source.id,
    trigger,
    status: "running",
    cursorBefore: source.cursor,
  });
  return runId;
}

export async function finishIngestionRun(input: {
  runId: string;
  source: IngestionSource;
  status: "completed" | "failed" | "skipped";
  counts: { requestCount: number; discoveredCount: number; acceptedCount: number; rejectedCount: number };
  nextCursor: string | null;
  error?: unknown;
}) {
  const db = requireDb(await getDb());
  const now = new Date();
  const errorSummary = input.error ? safeErrorSummary(input.error) : null;
  const nextRunAt = new Date(now.getTime() + input.source.scheduleMinutes * 60_000);

  await db.transaction(async tx => {
    await tx
      .update(ingestionRuns)
      .set({
        status: input.status,
        cursorAfter: input.nextCursor,
        ...input.counts,
        errorSummary,
        finishedAt: now,
      })
      .where(eq(ingestionRuns.id, input.runId));

    await tx
      .update(ingestionSources)
      .set({
        cursor: input.nextCursor,
        nextRunAt,
        lastSuccessfulAt: input.status === "completed" ? now : input.source.lastSuccessfulAt,
        failureCount: input.status === "failed" ? input.source.failureCount + 1 : 0,
        lastError: errorSummary,
      })
      .where(eq(ingestionSources.id, input.source.id));
  });
}

export async function persistA2aObservation(input: {
  source: IngestionSource;
  runId: string;
  observation: RawObservationInput;
  candidate: A2aNormalizedCandidate;
}) {
  return persistSourceScopedAgentObservation({
    source: input.source,
    runId: input.runId,
    protocol: "a2a",
    parserVersion: "a2a-agent-card-v2-strong-identity",
    observation: input.observation,
    candidate: {
      displayName: input.candidate.displayName,
      displayHandle: input.candidate.handle,
      summary: input.candidate.summary,
      primaryCapability: input.candidate.primaryCapability,
      identityType: "a2a_url",
      externalId: input.candidate.agentCardUrl,
      protocols: ["a2a"],
      endpointUrl: input.candidate.endpointUrl,
      authentication: input.candidate.authentication,
      eventType: "A2A_AGENT_CARD_OBSERVED",
      eventDescription: `A2A AgentCard observed from approved source ${input.source.label}; identity resolves by AgentCard URL, not display name.`,
    },
  });
}

/**
 * Persists catalog-provided discovery metadata. It deliberately does not invoke
 * the advertised AgentCard or provider endpoint, and it does not inherit the
 * catalog's owner/domain/signed claims as Nooscape verification state.
 */
export async function persistCatalogObservation(input: {
  source: IngestionSource;
  runId: string;
  observation: RawObservationInput;
  candidate: CatalogNormalizedCandidate;
  /** The parser that read the record; the Agenstry feed's unless the caller names its own. */
  parserVersion?: string;
}) {
  return persistSourceScopedAgentObservation({
    source: input.source,
    runId: input.runId,
    protocol: "catalog",
    parserVersion: input.parserVersion ?? "agenstry-catalog-v2-source-scoped",
    observation: input.observation,
    candidate: {
      displayName: input.candidate.displayName,
      displayHandle: input.candidate.handle,
      summary: input.candidate.summary,
      primaryCapability: input.candidate.primaryCapability,
      // A catalog entry receives a catalog-scoped identity. An advertised A2A URL
      // can support a future merge review but never takes over a direct identity.
      identityType: "catalog_record",
      externalId: `${input.source.id}:${input.candidate.externalRecordId}`,
      // No endpoint row, on purpose; the host of the card is kept on the snapshot for the cross-source rule of the registry runs.
      partyHost: partyHostOf(input.candidate.agentCardUrl) ?? partyHostOf(input.candidate.endpointUrl),
      protocols: ["catalog"],
      eventType: "CATALOG_AGENT_METADATA_OBSERVED",
      eventDescription: `Agent metadata observed in approved catalog ${input.source.label}; catalog verification signals remain assertions.`,
    },
  });
}

/**
 * Persists one public Metaplex registry record. The Solana mint is an asserted
 * identity anchor only: no chain RPC, authority proof, or advertised A2A service
 * is invoked by this path.
 */
export async function persistSolanaRegistryObservation(input: {
  source: IngestionSource;
  runId: string;
  observation: RawObservationInput;
  candidate: SolanaRegistryCandidate;
}) {
  return persistSourceScopedAgentObservation({
    source: input.source,
    runId: input.runId,
    protocol: "solana_registry",
    parserVersion: "metaplex-solana-registry-v2-source-scoped",
    observation: input.observation,
    candidate: {
      displayName: input.candidate.displayName,
      displayHandle: input.candidate.handle,
      summary: input.candidate.summary,
      primaryCapability: input.candidate.primaryCapability,
      identityType: "solana_mint",
      externalId: input.candidate.mintAddress,
      protocols: ["solana_registry", ...(input.candidate.agentCardUrl ? ["a2a"] : [])],
      endpointUrl: input.candidate.agentCardUrl,
      eventType: "SOLANA_REGISTRY_AGENT_METADATA_OBSERVED",
      eventDescription: `Solana agent metadata observed in approved Metaplex registry ${input.source.label}; mint, authority, wallet, and A2A declarations remain unverified assertions.`,
    },
  });
}

/**
 * Persists one ERC-8004 identity registration observed on the Robinhood Chain
 * registry. The owner and URI are registry-recorded assertions at registration
 * time: this path never dereferences a URI or queries current token state.
 */
export async function persistErc8004RegistryObservation(input: {
  source: IngestionSource;
  runId: string;
  observation: RawObservationInput;
  candidate: Erc8004RegistryCandidate;
}) {
  return persistSourceScopedAgentObservation({
    source: input.source,
    runId: input.runId,
    protocol: "erc8004",
    parserVersion: "robinhood-erc8004-identity-v1-source-scoped",
    observation: input.observation,
    candidate: {
      displayName: input.candidate.displayName,
      displayHandle: input.candidate.handle,
      summary: input.candidate.summary,
      primaryCapability: input.candidate.primaryCapability,
      identityType: "erc8004",
      externalId: input.candidate.externalId,
      protocols: ["erc8004"],
      eventType: "ERC8004_AGENT_REGISTERED",
      eventDescription:
        "ERC-8004 agent registration observed on the approved Robinhood Chain identity registry; owner, URI, and self-asserted metadata remain unverified assertions.",
    },
  });
}

/** Persists aggregate context only; this deliberately creates no agent profile. */
export async function persistCensusObservation(input: {
  source: IngestionSource;
  runId: string;
  observation: RawObservationInput;
}) {
  const db = requireDb(await getDb());
  const observationId = randomUUID();
  const locatorHash = hashValue(input.observation.canonicalLocator);
  const [existingObservation] = await db
    .select({ id: sourceObservations.id })
    .from(sourceObservations)
    .where(
      and(
        eq(sourceObservations.sourceId, input.source.id),
        eq(sourceObservations.locatorHash, locatorHash),
        eq(sourceObservations.contentHash, input.observation.contentHash)
      )
    )
    .limit(1);
  const persistedObservationId = existingObservation?.id ?? observationId;
  await db.transaction(async tx => {
    if (!existingObservation) {
      await tx.insert(sourceObservations).values({
        id: observationId,
        sourceId: input.source.id,
        protocol: "census",
        canonicalLocator: input.observation.canonicalLocator,
        locatorHash,
        contentHash: input.observation.contentHash,
        rawObjectKey: input.observation.rawObjectKey,
        contentType: input.observation.contentType,
        httpStatus: input.observation.httpStatus,
        parserVersion: "agent-economy-census-v1",
        validationStatus: input.observation.validationStatus,
        validationFindings: JSON.stringify(input.observation.validationFindings),
        observedAt: input.observation.observedAt,
      });
    }
    await tx
      .insert(sourceObservationRuns)
      .values({ runId: input.runId, observationId: persistedObservationId })
      .onDuplicateKeyUpdate({ set: { linkedAt: input.observation.observedAt } });
  });
  return { observationId: persistedObservationId };
}

type SourceScopedCandidate = {
  displayName: string;
  displayHandle: string;
  summary: string | null;
  primaryCapability: string | null;
  identityType: "a2a_url" | "catalog_record" | "solana_mint" | "erc8004";
  externalId: string;
  protocols: string[];
  endpointUrl?: string | null;
  authentication?: string | null;
  /** The host a catalog entry's card is served from; see `agentPublicSnapshots.partyHost`. */
  partyHost?: string | null;
  eventType: string;
  eventDescription: string;
};

export function displayHandleFromStrongIdentity(value: string, strongIdentity: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 132);
  return `${normalized || "agent"}-${hashValue(strongIdentity).slice(0, 10)}`;
}

/**
 * Writes a source-scoped observation and projection snapshot without merging on a
 * display name. The strong identity is immutable: an existing identity resolves
 * to its agent, and it is never re-pointed to a different record.
 */
export async function persistSourceScopedAgentObservation(input: {
  source: IngestionSource;
  runId: string;
  protocol: "a2a" | "catalog" | "solana_registry" | "erc8004";
  parserVersion: string;
  observation: RawObservationInput;
  candidate: SourceScopedCandidate;
}) {
  const db = requireDb(await getDb());
  const observationId = randomUUID();
  const locatorHash = hashValue(input.observation.canonicalLocator);
  const identityHash = hashValue(input.candidate.externalId);
  const [existingObservation] = await db
    .select({ id: sourceObservations.id })
    .from(sourceObservations)
    .where(
      and(
        eq(sourceObservations.sourceId, input.source.id),
        eq(sourceObservations.locatorHash, locatorHash),
        eq(sourceObservations.contentHash, input.observation.contentHash)
      )
    )
    .limit(1);
  const persistedObservationId = existingObservation?.id ?? observationId;

  await db.transaction(async tx => {
    if (!existingObservation) {
      await tx.insert(sourceObservations).values({
        id: observationId,
        sourceId: input.source.id,
        protocol: input.protocol,
        canonicalLocator: input.observation.canonicalLocator,
        locatorHash,
        contentHash: input.observation.contentHash,
        rawObjectKey: input.observation.rawObjectKey,
        contentType: input.observation.contentType,
        httpStatus: input.observation.httpStatus,
        parserVersion: input.parserVersion,
        validationStatus: input.observation.validationStatus,
        validationFindings: JSON.stringify(input.observation.validationFindings),
        observedAt: input.observation.observedAt,
      });
    }
    await tx
      .insert(sourceObservationRuns)
      .values({ runId: input.runId, observationId: persistedObservationId })
      .onDuplicateKeyUpdate({ set: { linkedAt: input.observation.observedAt } });

    const [knownIdentity] = await tx
      .select({ id: agentIdentities.id, agentId: agentIdentities.agentId })
      .from(agentIdentities)
      .where(and(eq(agentIdentities.identityType, input.candidate.identityType), eq(agentIdentities.externalIdHash, identityHash)))
      .limit(1);

    let agentId = knownIdentity?.agentId;
    if (!agentId) {
      agentId = randomUUID();
      const handle = displayHandleFromStrongIdentity(input.candidate.displayHandle, `${input.candidate.identityType}:${input.candidate.externalId}`);
      const position = mapPositionFromHandle(handle);
      await tx.insert(agents).values({
        id: agentId,
        displayName: input.candidate.displayName,
        handle,
        primaryCapability: input.candidate.primaryCapability,
        summary: input.candidate.summary,
        lifecycle: "unknown",
        mapX: position.x,
        mapY: position.y,
        firstSeenAt: input.observation.observedAt,
        lastSeenAt: input.observation.observedAt,
      });
      await tx.insert(agentIdentities).values({
        id: randomUUID(),
        agentId,
        identityType: input.candidate.identityType,
        externalId: input.candidate.externalId,
        externalIdHash: identityHash,
        sourceObservationId: persistedObservationId,
        verificationState: "asserted",
      });
      await tx.insert(agentReadModel).values({
        agentId,
        displayName: input.candidate.displayName,
        handle,
        primaryCapability: input.candidate.primaryCapability,
        summary: input.candidate.summary,
        protocols: JSON.stringify(input.candidate.protocols),
        publisherState: "unverified",
        evidenceTier: "tier_2",
        sourceCount: 1,
        lastObservedAt: input.observation.observedAt,
        evidenceSummary: JSON.stringify({ status: "source_scoped_metadata_observed", observationId: persistedObservationId }),
      });
    } else {
      // The public fields stay on the observation snapshot; an unreviewed source
      // cannot rewrite the canonical profile of a known strong identity.
      await tx.update(agents).set({ lastSeenAt: input.observation.observedAt }).where(eq(agents.id, agentId));
    }

    if (input.candidate.endpointUrl) {
      await tx
        .insert(agentEndpoints)
        .values({
          id: randomUUID(),
          agentId,
          protocol: "a2a",
          endpointUrl: input.candidate.endpointUrl,
          endpointHash: hashValue(input.candidate.endpointUrl),
          authentication: input.candidate.authentication ?? null,
          domainVerification: "unverified",
          lastHealth: "unknown",
          sourceObservationId: persistedObservationId,
          lastObservedAt: input.observation.observedAt,
        })
        .onDuplicateKeyUpdate({
          set: {
            sourceObservationId: persistedObservationId,
            authentication: input.candidate.authentication ?? null,
            lastObservedAt: input.observation.observedAt,
          },
        });
    }

    await tx
      .insert(agentPublicSnapshots)
      .values({
        id: randomUUID(),
        agentId,
        sourceId: input.source.id,
        sourceObservationId: persistedObservationId,
        displayName: input.candidate.displayName,
        displayHandle: displayHandleFromStrongIdentity(input.candidate.displayHandle, `${input.candidate.identityType}:${input.candidate.externalId}`),
        primaryCapability: input.candidate.primaryCapability,
        untrustedSelfDescription: input.candidate.summary,
        protocols: JSON.stringify(input.candidate.protocols),
        publisherState: "unverified",
        evidenceTier: "tier_2",
        sourceCount: 1,
        observedAt: input.observation.observedAt,
        partyHost: input.candidate.partyHost ?? null,
      })
      .onDuplicateKeyUpdate({
        set: {
          displayName: input.candidate.displayName,
          primaryCapability: input.candidate.primaryCapability,
          untrustedSelfDescription: input.candidate.summary,
          protocols: JSON.stringify(input.candidate.protocols),
          observedAt: input.observation.observedAt,
          // A record seen again gets its host if it had none; a candidate that names none leaves what is there.
          ...(input.candidate.partyHost ? { partyHost: input.candidate.partyHost } : {}),
        },
      });

    // A replay can legitimately resolve to an observation retained before the
    // source-scoped projection schema existed. Ensure that both fresh and
    // replayed observations have exactly one persisted evidence event, so a
    // public snapshot can always produce a signed provenance envelope.
    const [existingEvidenceEvent] = await tx
      .select({ id: evidenceEvents.id })
      .from(evidenceEvents)
      .where(
        and(
          eq(evidenceEvents.agentId, agentId),
          eq(evidenceEvents.sourceObservationId, persistedObservationId),
          eq(evidenceEvents.eventType, input.candidate.eventType)
        )
      )
      .limit(1);
    if (!existingEvidenceEvent) {
      await tx.insert(evidenceEvents).values({
        id: randomUUID(),
        agentId,
        sourceObservationId: persistedObservationId,
        eventType: input.candidate.eventType,
        description: input.candidate.eventDescription,
        proofReference: input.observation.canonicalLocator,
        payloadHash: input.observation.contentHash,
        observedAt: input.observation.observedAt,
      });
    }
  });
  return { observationId: persistedObservationId };
}
