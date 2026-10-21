import "dotenv/config";

import { desc, isNotNull, sql } from "drizzle-orm";

import {
  agentPublicSnapshots,
  agentReadModel,
  agents,
  domainVerificationChallenges,
  evidenceEvents,
  ingestionSources,
  publisherKeys,
  sourceObservations,
} from "../drizzle/schema";
import { getDb } from "./db";
import { getProductionStorageConfig, verifyStoredObject } from "./storage";

// Read-only durability audit for stored evidence (see
// docs/evidence-durability-2026-10-08.md).
//
// Loads every expected object/hash pair from the provenance database, re-reads
// each object from the evidence bucket, and classifies it as matched,
// mismatched, missing, or unreadable. Prints retention state plus a per-table
// row inventory that doubles as the restore fingerprint.
//
// Point DATABASE_URL and the NOOSCAPE_S3_* variables at production to audit
// the live pair, at a restored database copy to prove a restore is complete,
// or at the offsite bucket copy to prove the offsite copy is intact. This tool
// never writes to the database or the object store.

const PROBLEM_DETAIL_LIMIT = 20;
const MISSING_OBJECT_CODES = ["NoSuchKey", "NotFound", "NoSuchBucket"];

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

type EvidenceSource = "source_observations" | "domain_verification_challenges" | "publisher_keys";

interface EvidenceExpectation {
  source: EvidenceSource;
  recordId: string;
  objectKey: string;
  expectedSha256: string;
}

interface ObjectProblem {
  source: EvidenceSource;
  recordId: string;
  objectKey: string;
  expectedSha256?: string;
  actualSha256?: string;
  message?: string;
}

interface AuditOutcome {
  matched: number;
  mismatch: ObjectProblem[];
  missing: ObjectProblem[];
  errors: ObjectProblem[];
  retention: {
    modeCounts: { GOVERNANCE: number; COMPLIANCE: number; none: number };
    lapsed: number;
    earliestRetainUntil: string | null;
  };
}

function fail(message: string): never {
  console.error(JSON.stringify({ event: "nooscape_durability_audit_failed", message }));
  process.exit(1);
}

function parseSampleSize(argv: string[]): number | null {
  const candidate = argv.find(arg => arg.trim() !== "");
  if (candidate === undefined) return null;

  const parsed = Number(candidate);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`Sample size must be a positive integer, received "${candidate}".`);
  }
  return parsed;
}

function isMissingObjectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { Code?: string }).Code;
  return MISSING_OBJECT_CODES.includes(error.name) || (typeof code === "string" && MISSING_OBJECT_CODES.includes(code));
}

async function loadExpectations(db: Db, sampleSize: number | null): Promise<EvidenceExpectation[]> {
  const expectations: EvidenceExpectation[] = [];

  const observationQuery = db
    .select({
      recordId: sourceObservations.id,
      objectKey: sourceObservations.rawObjectKey,
      expectedSha256: sourceObservations.contentHash,
    })
    .from(sourceObservations)
    .orderBy(desc(sourceObservations.createdAt));
  const observations = sampleSize === null ? await observationQuery : await observationQuery.limit(sampleSize);
  for (const row of observations) {
    expectations.push({ source: "source_observations", ...row });
  }

  const challengeQuery = db
    .select({
      recordId: domainVerificationChallenges.id,
      objectKey: domainVerificationChallenges.proofObjectKey,
      expectedSha256: domainVerificationChallenges.proofHash,
    })
    .from(domainVerificationChallenges)
    .where(isNotNull(domainVerificationChallenges.proofObjectKey))
    .orderBy(desc(domainVerificationChallenges.createdAt));
  const challenges = sampleSize === null ? await challengeQuery : await challengeQuery.limit(sampleSize);
  for (const row of challenges) {
    if (!row.objectKey || !row.expectedSha256) continue;
    expectations.push({
      source: "domain_verification_challenges",
      recordId: row.recordId,
      objectKey: row.objectKey,
      expectedSha256: row.expectedSha256,
    });
  }

  const publisherKeyQuery = db
    .select({
      recordId: publisherKeys.id,
      objectKey: publisherKeys.attestationObjectKey,
      expectedSha256: publisherKeys.attestationHash,
    })
    .from(publisherKeys)
    .where(isNotNull(publisherKeys.attestationObjectKey))
    .orderBy(desc(publisherKeys.createdAt));
  const publisherKeyRows = sampleSize === null ? await publisherKeyQuery : await publisherKeyQuery.limit(sampleSize);
  for (const row of publisherKeyRows) {
    if (!row.objectKey || !row.expectedSha256) continue;
    expectations.push({
      source: "publisher_keys",
      recordId: row.recordId,
      objectKey: row.objectKey,
      expectedSha256: row.expectedSha256,
    });
  }

  return expectations;
}

async function auditExpectations(expectations: EvidenceExpectation[]): Promise<AuditOutcome> {
  const outcome: AuditOutcome = {
    matched: 0,
    mismatch: [],
    missing: [],
    errors: [],
    retention: { modeCounts: { GOVERNANCE: 0, COMPLIANCE: 0, none: 0 }, lapsed: 0, earliestRetainUntil: null },
  };

  for (const expectation of expectations) {
    try {
      const result = await verifyStoredObject(expectation.objectKey, expectation.expectedSha256);

      if (result.retentionMode === "GOVERNANCE") outcome.retention.modeCounts.GOVERNANCE += 1;
      else if (result.retentionMode === "COMPLIANCE") outcome.retention.modeCounts.COMPLIANCE += 1;
      else outcome.retention.modeCounts.none += 1;

      if (result.retainUntil) {
        const until = result.retainUntil.toISOString();
        if (!outcome.retention.earliestRetainUntil || until < outcome.retention.earliestRetainUntil) {
          outcome.retention.earliestRetainUntil = until;
        }
        if (result.retainUntil.getTime() < Date.now()) outcome.retention.lapsed += 1;
      }

      if (result.hashMatches) {
        outcome.matched += 1;
      } else {
        outcome.mismatch.push({ ...expectation, actualSha256: result.actualSha256 });
      }
    } catch (error) {
      const problem: ObjectProblem = {
        source: expectation.source,
        recordId: expectation.recordId,
        objectKey: expectation.objectKey,
      };
      if (isMissingObjectError(error)) outcome.missing.push(problem);
      else outcome.errors.push({ ...problem, message: error instanceof Error ? error.message : "Unknown storage read error" });
    }
  }

  return outcome;
}

async function tableInventory(db: Db): Promise<Record<string, number>> {
  const rows = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(ingestionSources),
    db.select({ count: sql<number>`count(*)` }).from(sourceObservations),
    db.select({ count: sql<number>`count(*)` }).from(agents),
    db.select({ count: sql<number>`count(*)` }).from(agentPublicSnapshots),
    db.select({ count: sql<number>`count(*)` }).from(agentReadModel),
    db.select({ count: sql<number>`count(*)` }).from(evidenceEvents),
    db.select({ count: sql<number>`count(*)` }).from(domainVerificationChallenges),
    db.select({ count: sql<number>`count(*)` }).from(publisherKeys),
  ]);

  return {
    ingestion_sources: Number(rows[0][0]?.count ?? 0),
    source_observations: Number(rows[1][0]?.count ?? 0),
    agents: Number(rows[2][0]?.count ?? 0),
    agent_public_snapshots: Number(rows[3][0]?.count ?? 0),
    agent_read_model: Number(rows[4][0]?.count ?? 0),
    evidence_events: Number(rows[5][0]?.count ?? 0),
    domain_verification_challenges: Number(rows[6][0]?.count ?? 0),
    publisher_keys: Number(rows[7][0]?.count ?? 0),
  };
}

function countBySource(expectations: EvidenceExpectation[]): Record<EvidenceSource, number> {
  const counts: Record<EvidenceSource, number> = {
    source_observations: 0,
    domain_verification_challenges: 0,
    publisher_keys: 0,
  };
  for (const expectation of expectations) counts[expectation.source] += 1;
  return counts;
}

function summarizeProblems(problems: ObjectProblem[]) {
  return { count: problems.length, details: problems.slice(0, PROBLEM_DETAIL_LIMIT) };
}

async function main() {
  try {
    const sampleSize = parseSampleSize(process.argv.slice(2));

    const db = await getDb();
    if (!db) {
      fail("DATABASE_URL is not configured. The durability audit needs a provenance database (production or a restored copy).");
    }

    let production: ReturnType<typeof getProductionStorageConfig> = null;
    try {
      production = getProductionStorageConfig();
    } catch (error) {
      fail(error instanceof Error ? error.message : "Evidence storage configuration is invalid.");
    }
    if (!production) {
      fail("NOOSCAPE_S3_* is not configured. The durability audit needs the evidence bucket (or the offsite copy).");
    }

    const expectations = await loadExpectations(db, sampleSize);
    if (expectations.length === 0) {
      fail("No stored-evidence expectations were found. Refusing to report a clean audit against an empty database.");
    }

    const outcome = await auditExpectations(expectations);
    const inventory = await tableInventory(db);
    const ok = outcome.mismatch.length === 0 && outcome.missing.length === 0 && outcome.errors.length === 0;

    console.log(
      JSON.stringify({
        event: "nooscape_durability_audit",
        ok,
        bucket: production.bucket,
        sampleSize,
        checked: expectations.length,
        matched: outcome.matched,
        bySource: countBySource(expectations),
        mismatch: summarizeProblems(outcome.mismatch),
        missing: summarizeProblems(outcome.missing),
        errors: summarizeProblems(outcome.errors),
        retention: outcome.retention,
        inventory,
      })
    );
    process.exit(ok ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown durability audit error";
    console.error(JSON.stringify({ event: "nooscape_durability_audit_failed", message }));
    process.exit(1);
  }
}

void main();
