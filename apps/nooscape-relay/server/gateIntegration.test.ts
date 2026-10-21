import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";

/**
 * Database-backed tests for the reviewed-run visibility gate's three review
 * gaps: a paused/rejected source must stop serving already-public records, the
 * persisted evidence pull must bind events to the approved run (and never
 * carry operator withdrawal reasons), and a lapsed publisher key must fail
 * closed on the public list path without waiting for a worker tick. These run
 * against a throwaway local MySQL schema (Docker) built with the project's own
 * boot-time migration runner; the whole file skips when no database is
 * reachable so the standard no-DB gate stays green.
 */

const TEST_DB = "nooscape_gate_gap_test";
const BASE_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";

const dbReachable = await (async () => {
  try {
    const probe = await createConnection(`${BASE_URL}/mysql`);
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbReachable)("public gate gaps against a real database", () => {
  type Db = typeof import("./db");
  let db: Db;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;

  const pastDate = () => new Date(Date.now() - 60_000);
  const futureDate = () => new Date(Date.now() + 3_600_000);

  async function seedSource(input: {
    sourceId: string;
    agentId: string;
    state: "active" | "paused" | "rejected";
    approvedRunId: string;
    extraRunId?: string;
  }) {
    const now = new Date();
    await writer.insert(schema.agents).values({
      id: input.agentId,
      displayName: `Agent ${input.agentId}`,
      handle: `handle-${input.agentId}`,
    });
    await writer.insert(schema.ingestionSources).values({
      id: input.sourceId,
      sourceKey: `gate-test-${input.sourceId}`,
      label: `Gate test ${input.sourceId}`,
      protocol: "catalog",
      rootUrl: `https://gate-test.example/${input.sourceId}`,
      allowedHostname: "gate-test.example",
      state: input.state,
      createdByUserId: operatorUserId,
    });
    const runs = [input.approvedRunId, ...(input.extraRunId ? [input.extraRunId] : [])];
    for (const [index, runId] of runs.entries()) {
      await writer.insert(schema.ingestionRuns).values({
        id: runId,
        sourceId: input.sourceId,
        trigger: "manual",
        status: "completed",
        startedAt: now,
        finishedAt: now,
      });
      const observationId = `${input.sourceId}-obs-${index}`;
      await writer.insert(schema.sourceObservations).values({
        id: observationId,
        sourceId: input.sourceId,
        protocol: "catalog",
        canonicalLocator: `https://gate-test.example/${input.sourceId}/record-${index}`,
        locatorHash: `loc-${observationId}`.padEnd(64, "0").slice(0, 64),
        contentHash: `hash-${observationId}`.padEnd(64, "0").slice(0, 64),
        rawObjectKey: `gate-test/${observationId}`,
        contentType: "application/json",
        parserVersion: "gate-test",
        validationStatus: "valid",
        validationFindings: "[]",
        observedAt: now,
      });
      await writer.insert(schema.sourceObservationRuns).values({ runId, observationId });
      if (index === 0) {
        await writer.insert(schema.agentPublicSnapshots).values({
          id: `${input.sourceId}-snapshot`,
          agentId: input.agentId,
          sourceId: input.sourceId,
          sourceObservationId: observationId,
          displayName: `Agent ${input.agentId}`,
          displayHandle: `handle-${input.agentId}`,
          protocols: "[]",
        });
        await writer.insert(schema.evidenceEvents).values({
          id: `${input.sourceId}-event-approved`,
          agentId: input.agentId,
          sourceObservationId: observationId,
          eventType: "OBSERVED",
          description: "Approved-run observation event.",
        });
      }
      if (index === 1) {
        await writer.insert(schema.evidenceEvents).values({
          id: `${input.sourceId}-event-unapproved`,
          agentId: input.agentId,
          sourceObservationId: `${input.sourceId}-obs-1`,
          eventType: "OBSERVED",
          description: "Unapproved-run observation event.",
        });
      }
    }
    await writer.insert(schema.sourceProjectionDecisions).values({
      sourceId: input.sourceId,
      state: "public",
      rationale: "gate-test projection",
      decidedByUserId: operatorUserId,
      approvedRunId: input.approvedRunId,
    });
  }

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    // The boot runner stamps baseline versions 0000-0014 without executing
    // them (they predate the runner on the live database), so a fresh schema
    // must replay those files by hand before asking the runner for the rest.
    const baselineReplay = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      const content = await readFile(file.file, "utf8");
      for (const statement of splitMigrationStatements(content)) {
        await baselineReplay.query(statement);
      }
    }
    await baselineReplay.end();
    const applied = await applyPendingMigrations(process.env.DATABASE_URL);
    // Baseline 0000-0014 is stamped, 0015-0029 apply on a fresh schema.
    expect(applied.length).toBeGreaterThanOrEqual(15);

    db = await import("./db");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "gate-test-operator", role: "admin" });
    const [operatorRows] = await writer
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.openId, "gate-test-operator"));
    operatorUserId = operatorRows.id;

    // (a) Source-state gate: same decision shape, different source states.
    await seedSource({ sourceId: "src-active", agentId: "agent-active", state: "active", approvedRunId: "run-active" });
    await seedSource({ sourceId: "src-paused", agentId: "agent-paused", state: "paused", approvedRunId: "run-paused" });
    await seedSource({ sourceId: "src-rejected", agentId: "agent-rejected", state: "rejected", approvedRunId: "run-rejected" });
    // (b) Envelope binding: a second, unapproved run plus a withdrawal notice.
    await seedSource({
      sourceId: "src-ev",
      agentId: "agent-ev",
      state: "active",
      approvedRunId: "run-ev-1",
      extraRunId: "run-ev-2",
    });
    await writer.insert(schema.evidenceEvents).values({
      id: "event-withdrawal",
      agentId: "agent-ev",
      sourceObservationId: "src-ev-obs-0",
      eventType: "RECORD_WITHDRAWN",
      description: "Record withdrawn from the public census by an operator: SECRET-WITHDRAWAL-REASON",
    });
    // (c) Publisher expiry copy: stale allowlisted read models with past/future expiry.
    await writer.insert(schema.agents).values([
      { id: "agent-key-exp", displayName: "Key expired", handle: "handle-key-exp" },
      { id: "agent-key-fut", displayName: "Key current", handle: "handle-key-fut" },
    ]);
    // Dedicated observations for the (c) cards: the snapshot unique index is
    // per sourceObservationId, and src-active-obs-0 already carries a card.
    await writer.insert(schema.sourceObservations).values([
      {
        id: "obs-key-exp",
        sourceId: "src-active",
        protocol: "catalog",
        canonicalLocator: "https://gate-test.example/record-key-exp",
        locatorHash: "loc-obs-key-exp".padEnd(64, "0").slice(0, 64),
        contentHash: "hash-obs-key-exp".padEnd(64, "0").slice(0, 64),
        rawObjectKey: "gate-test/obs-key-exp",
        contentType: "application/json",
        parserVersion: "gate-test",
        validationStatus: "valid",
        validationFindings: "[]",
      },
      {
        id: "obs-key-fut",
        sourceId: "src-active",
        protocol: "catalog",
        canonicalLocator: "https://gate-test.example/record-key-fut",
        locatorHash: "loc-obs-key-fut".padEnd(64, "0").slice(0, 64),
        contentHash: "hash-obs-key-fut".padEnd(64, "0").slice(0, 64),
        rawObjectKey: "gate-test/obs-key-fut",
        contentType: "application/json",
        parserVersion: "gate-test",
        validationStatus: "valid",
        validationFindings: "[]",
      },
    ]);
    await writer.insert(schema.sourceObservationRuns).values([
      { runId: "run-active", observationId: "obs-key-exp" },
      { runId: "run-active", observationId: "obs-key-fut" },
    ]);
    await writer.insert(schema.agentPublicSnapshots).values([
      {
        id: "snapshot-key-exp",
        agentId: "agent-key-exp",
        sourceId: "src-active",
        sourceObservationId: "obs-key-exp",
        displayName: "Key expired",
        displayHandle: "handle-key-exp",
        protocols: "[]",
      },
      {
        id: "snapshot-key-fut",
        agentId: "agent-key-fut",
        sourceId: "src-active",
        sourceObservationId: "obs-key-fut",
        displayName: "Key current",
        displayHandle: "handle-key-fut",
        protocols: "[]",
      },
    ]);
    await writer.insert(schema.agentReadModel).values([
      {
        agentId: "agent-key-exp",
        displayName: "Key expired",
        handle: "handle-key-exp",
        protocols: "[]",
        publisherState: "allowlisted",
        evidenceTier: "tier_4",
        sourceCount: 1,
        evidenceSummary: "{}",
        publisherExpiresAt: pastDate(),
      },
      {
        agentId: "agent-key-fut",
        displayName: "Key current",
        handle: "handle-key-fut",
        protocols: "[]",
        publisherState: "allowlisted",
        evidenceTier: "tier_4",
        sourceCount: 1,
        evidenceSummary: "{}",
        publisherExpiresAt: futureDate(),
      },
    ]);
  }, 180_000);

  afterAll(async () => {
    if (closePool) await closePool();
  }, 30_000);

  it("(a) pauses and rejects stop already-public records, and reactivating restores them", async () => {
    const served = await db.listLiveAtlasRecords();
    const servedIds = served.map(record => record.agentId);
    expect(servedIds).toContain("agent-active");
    expect(servedIds).not.toContain("agent-paused");
    expect(servedIds).not.toContain("agent-rejected");
    expect(await db.isAgentPubliclyVisible("agent-active")).toBe(true);
    expect(await db.isAgentPubliclyVisible("agent-paused")).toBe(false);

    await writer
      .update(schema.ingestionSources)
      .set({ state: "paused" })
      .where(eq(schema.ingestionSources.id, "src-active"));
    expect((await db.listLiveAtlasRecords()).map(record => record.agentId)).not.toContain("agent-active");
    expect(await db.isAgentPubliclyVisible("agent-active")).toBe(false);

    await writer
      .update(schema.ingestionSources)
      .set({ state: "active" })
      .where(eq(schema.ingestionSources.id, "src-active"));
    expect((await db.listLiveAtlasRecords()).map(record => record.agentId)).toContain("agent-active");
  }, 120_000);

  it("(b) binds envelope evidence to the approved run and excludes operator withdrawal reasons", async () => {
    const entries = await db.listPersistedEvidenceEntries("agent-ev");
    expect(entries.map(entry => entry.id)).toEqual(["src-ev-event-approved"]);
    const allDetail = entries.map(entry => entry.detail).join("\n");
    expect(allDetail).not.toContain("SECRET-WITHDRAWAL-REASON");
    expect(allDetail).not.toContain("Unapproved-run observation event.");

    const { createPersistedEvidenceEnvelope } = await import("./evidence");
    const envelope = await createPersistedEvidenceEnvelope("agent-ev", {
      status: "unverified",
      publisherName: null,
      publicKeyFingerprint: null,
      verifiedAt: null,
      statusChangedAt: null,
    });
    expect(envelope).toBeDefined();
    expect(envelope?.entries.map(entry => entry.id)).toEqual(["src-ev-event-approved"]);
    expect(JSON.stringify(envelope)).not.toContain("SECRET-WITHDRAWAL-REASON");
  }, 120_000);

  it("(c) resolves a lapsed publisher key fail-closed on the list path", async () => {
    const served = await db.listLiveAtlasRecords();
    const byId = new Map(served.map(record => [record.agentId, record]));
    expect(byId.get("agent-key-exp")).toMatchObject({ publisherState: "expired", evidenceTier: "tier_2" });
    expect(byId.get("agent-key-fut")).toMatchObject({ publisherState: "allowlisted", evidenceTier: "tier_4" });
  }, 120_000);

  it("(d) gates the public evidence timeline like the envelope: approved-run events only, no operator withdrawal reasons", async () => {
    // The agent-ev fixture carries all three leak shapes: an approved-run
    // OBSERVED event, an unapproved-run OBSERVED event, and a withdrawal
    // notice whose description embeds the operator's reason. The timeline
    // must show exactly the first — the same gate listPersistedEvidenceEntries
    // applies to envelopes, now applied to the profile timeline.
    const timeline = await db.listAgentEvidenceTimeline("agent-ev");
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ eventType: "OBSERVED", description: "Approved-run observation event." });
    const allDescriptions = timeline.map(event => event.description).join("\n");
    expect(allDescriptions).not.toContain("SECRET-WITHDRAWAL-REASON");
    expect(allDescriptions).not.toContain("Unapproved-run observation event.");
  }, 120_000);
});
