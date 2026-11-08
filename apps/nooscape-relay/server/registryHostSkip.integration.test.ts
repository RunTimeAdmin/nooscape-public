import { eq, inArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";

/**
 * Database-backed test of the lookup an A2A registry run makes before it picks records: the addresses of the records that are public today
 * from sources other than its own. A record of a direct source gives its endpoint row; a catalog record has none, on purpose, and gives the
 * host its card is served from, kept on its snapshot (migration 0059). The lookup composes the reviewed-run gate every public read uses, so
 * a record counts only while its source is active, its decision is public, its observation belongs to the approved run, and an operator has
 * not withdrawn it. The first version of this file seeded endpoint rows for catalog sources, which production never writes, and so passed
 * while the rule saw nothing between catalog sources (docs/catalog-party-rule-2026-11-07.md). It runs against a throwaway local schema built
 * with the project's own migration runner; the file skips when no database is reachable.
 */

const TEST_DB = "nooscape_registry_skip_test";
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

describe.skipIf(!dbReachable)("reviewed addresses of other sources, against a real database", () => {
  type Db = typeof import("./db");
  let db: Db;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;

  async function seed(input: {
    key: string;
    /** A direct source's record has an endpoint row. */
    endpoint?: string;
    /** A catalog record has none, and the host of its card on its snapshot. */
    partyHost?: string;
    /** The parser that read the record, and the catalog identity it was given, for the migration's backfill. */
    parserVersion?: string;
    identityExternalId?: string;
    sourceState?: "active" | "paused";
    decision?: "public" | "review";
    observationInApprovedRun?: boolean;
    withdrawn?: boolean;
  }) {
    const sourceId = `src-${input.key}`;
    const agentId = `agent-${input.key}`;
    const runId = `run-${input.key}`;
    const observationId = `obs-${input.key}`;
    const pad = (value: string) => value.padEnd(64, "0").slice(0, 64);
    await writer.insert(schema.agents).values({ id: agentId, displayName: `Agent ${input.key}`, handle: `handle-${input.key}` });
    await writer.insert(schema.ingestionSources).values({
      id: sourceId,
      sourceKey: `skip-test-${input.key}`,
      label: `Skip test ${input.key}`,
      protocol: "catalog",
      rootUrl: `https://skip-test.example/${input.key}`,
      allowedHostname: "skip-test.example",
      state: input.sourceState ?? "active",
      createdByUserId: operatorUserId,
    });
    await writer.insert(schema.ingestionRuns).values({ id: runId, sourceId, trigger: "manual", status: "completed", startedAt: new Date(), finishedAt: new Date() });
    await writer.insert(schema.sourceObservations).values({
      id: observationId,
      sourceId,
      protocol: "catalog",
      canonicalLocator: `https://skip-test.example/${input.key}#1`,
      locatorHash: pad(`loc-${input.key}`),
      contentHash: pad(`hash-${input.key}`),
      rawObjectKey: `skip-test/${input.key}`,
      contentType: "application/json",
      parserVersion: input.parserVersion ?? "skip-test",
      validationStatus: "valid",
      validationFindings: "[]",
      observedAt: new Date(),
    });
    if (input.observationInApprovedRun !== false) await writer.insert(schema.sourceObservationRuns).values({ runId, observationId });
    if (input.identityExternalId) {
      await writer.insert(schema.agentIdentities).values({
        id: `identity-${input.key}`,
        agentId,
        identityType: "catalog_record",
        externalId: input.identityExternalId,
        externalIdHash: pad(`identity-${input.key}`),
        sourceObservationId: observationId,
      });
    }
    if (input.endpoint) {
      await writer.insert(schema.agentEndpoints).values({
        id: `ep-${input.key}`,
        agentId,
        protocol: "a2a",
        endpointUrl: input.endpoint,
        endpointHash: pad(`endpoint-${input.key}`),
        sourceObservationId: observationId,
      });
    }
    await writer.insert(schema.agentPublicSnapshots).values({
      id: `snapshot-${input.key}`,
      agentId,
      sourceId,
      sourceObservationId: observationId,
      displayName: `Agent ${input.key}`,
      displayHandle: `handle-${input.key}`,
      protocols: "[]",
      partyHost: input.partyHost ?? null,
    });
    await writer.insert(schema.sourceProjectionDecisions).values({
      sourceId,
      state: input.decision ?? "public",
      rationale: "skip test projection",
      decidedByUserId: operatorUserId,
      approvedRunId: input.decision === "review" ? null : runId,
    });
    if (input.withdrawn) {
      await writer.insert(schema.agentRecordWithdrawals).values({ agentId, action: "withdraw", reason: "skip test withdrawal", decidedByUserId: operatorUserId });
    }
  }

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    // The boot runner stamps baseline versions 0000-0014 without executing them, so a fresh schema replays those files by hand first.
    const baselineReplay = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      const content = await readFile(file.file, "utf8");
      for (const statement of splitMigrationStatements(content)) {
        await baselineReplay.query(statement);
      }
    }
    await baselineReplay.end();
    await applyPendingMigrations(process.env.DATABASE_URL);

    db = await import("./db");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "skip-test-operator", role: "admin" });
    const [operatorRow] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "skip-test-operator"));
    operatorUserId = operatorRow.id;

    // A direct source's record: an endpoint row and no host on its snapshot.
    await seed({ key: "held", endpoint: "https://www.held.example/" });
    // A catalog record: no endpoint row, the host of its card on its snapshot.
    await seed({ key: "catheld", partyHost: "cat-held.example" });
    await seed({ key: "mine", endpoint: "https://mine.example/", partyHost: "mine-host.example" });
    // The conditions that keep a record out hold for both ways of saying where it is.
    await seed({ key: "withdrawn", endpoint: "https://withdrawn.example/", partyHost: "withdrawn-host.example", withdrawn: true });
    await seed({ key: "paused", endpoint: "https://paused.example/", partyHost: "paused-host.example", sourceState: "paused" });
    await seed({ key: "unlinked", endpoint: "https://unreviewed.example/", partyHost: "unreviewed-host.example", observationInApprovedRun: false });
    await seed({ key: "undecided", endpoint: "https://undecided.example/", partyHost: "undecided-host.example", decision: "review" });
  }, 120_000);

  afterAll(async () => {
    if (closePool) await closePool();
  }, 30_000);

  it("returns the addresses of the public records of other sources, an endpoint row's or a catalog record's host, and only those", async () => {
    expect((await db.listReviewedAddressesOfOtherSources("src-mine")).sort()).toEqual(["https://cat-held.example/", "https://www.held.example/"]);
  });

  it("leaves out the asking source's own records, and returns another source's to it", async () => {
    expect((await db.listReviewedAddressesOfOtherSources("src-held")).sort()).toEqual(["https://cat-held.example/", "https://mine-host.example/", "https://mine.example/"]);
  });

  it("leaves a catalog record out for its own source and returns its host to another", async () => {
    expect(await db.listReviewedAddressesOfOtherSources("src-catheld")).not.toContain("https://cat-held.example/");
    expect(await db.listReviewedAddressesOfOtherSources("src-held")).toContain("https://cat-held.example/");
  });

  it("returns nothing for the records an operator withdrew, a paused source, an observation outside the approved run or a decision that is not public, by either address", async () => {
    const urls = await db.listReviewedAddressesOfOtherSources("src-unrelated");
    for (const gone of ["withdrawn", "paused", "unreviewed", "undecided"]) {
      expect(urls).not.toContain(`https://${gone}.example/`);
      expect(urls).not.toContain(`https://${gone}-host.example/`);
    }
    expect(urls.sort()).toEqual(["https://cat-held.example/", "https://mine-host.example/", "https://mine.example/", "https://www.held.example/"]);
  });

  it("returns a record again once the operator reinstates it", async () => {
    await writer.insert(schema.agentRecordWithdrawals).values({ agentId: "agent-withdrawn", action: "reinstate", reason: "skip test reinstatement", decidedByUserId: operatorUserId });

    const urls = await db.listReviewedAddressesOfOtherSources("src-unrelated");
    expect(urls).toContain("https://withdrawn.example/");
    expect(urls).toContain("https://withdrawn-host.example/");
  });

  it("holds the host of a catalog record written by the persist path, with no endpoint row, once its run is public", async () => {
    const sourceId = "src-persisted";
    await writer.insert(schema.ingestionSources).values({
      id: sourceId,
      sourceKey: "skip-test-persisted",
      label: "Skip test persisted",
      protocol: "catalog",
      rootUrl: "https://skip-test.example/persisted",
      allowedHostname: "skip-test.example",
      state: "active",
      createdByUserId: operatorUserId,
    });
    await writer.insert(schema.ingestionRuns).values({ id: "run-persisted", sourceId, trigger: "manual", status: "completed", startedAt: new Date(), finishedAt: new Date() });
    const [source] = await writer.select().from(schema.ingestionSources).where(eq(schema.ingestionSources.id, sourceId));
    const candidate = {
      displayName: "Persisted Agent",
      handle: "persisted-agent",
      summary: "A test agent.",
      primaryCapability: "testing",
      specialties: [],
      agentCardUrl: "https://Agent.Persisted.EXAMPLE:8443/.well-known/agent-card.json",
      endpointUrl: "https://service.persisted.example/a2a",
      authentication: null,
      externalRecordId: "persisted-1",
      catalogSignals: [],
    };
    const observation = {
      canonicalLocator: "https://skip-test.example/persisted#1",
      contentHash: "c".repeat(64),
      rawObjectKey: "skip-test/persisted",
      contentType: "application/json",
      httpStatus: 200,
      validationStatus: "valid" as const,
      validationFindings: [],
      observedAt: new Date(),
    };

    // A second record whose card address names no host: the host of its service address stands in.
    const second = {
      candidate: { ...candidate, displayName: "Second Agent", handle: "second-agent", externalRecordId: "persisted-2", agentCardUrl: "not a url", endpointUrl: "https://service2.persisted.example/a2a" },
      observation: { ...observation, canonicalLocator: "https://skip-test.example/persisted#2", contentHash: "d".repeat(64), rawObjectKey: "skip-test/persisted-2" },
    };

    await db.persistCatalogObservation({ source: source!, runId: "run-persisted", candidate, observation });
    // A row written before the column has no host; seeing the record again gives it one.
    await writer.update(schema.agentPublicSnapshots).set({ partyHost: null }).where(eq(schema.agentPublicSnapshots.sourceId, sourceId));
    await db.persistCatalogObservation({ source: source!, runId: "run-persisted", candidate, observation });
    await db.persistCatalogObservation({ source: source!, runId: "run-persisted", ...second });

    const snapshots = await writer.select().from(schema.agentPublicSnapshots).where(eq(schema.agentPublicSnapshots.sourceId, sourceId));
    expect(snapshots).toHaveLength(2);
    const hostOf = (name: string) => snapshots.find(snapshot => snapshot.displayName === name)?.partyHost;
    expect(hostOf("Persisted Agent")).toBe("agent.persisted.example");
    expect(hostOf("Second Agent")).toBe("service2.persisted.example");
    expect(await writer.select().from(schema.agentEndpoints).where(inArray(schema.agentEndpoints.agentId, snapshots.map(snapshot => snapshot.agentId)))).toEqual([]);
    // Not public yet: no decision binds the run.
    expect(await db.listReviewedAddressesOfOtherSources("src-asker")).not.toContain("https://agent.persisted.example/");

    await writer.insert(schema.sourceProjectionDecisions).values({ sourceId, state: "public", rationale: "persist test projection", decidedByUserId: operatorUserId, approvedRunId: "run-persisted" });

    const held = await db.listReviewedAddressesOfOtherSources("src-asker");
    expect(held).toContain("https://agent.persisted.example/");
    expect(held).toContain("https://service2.persisted.example/");
    expect(await db.listReviewedAddressesOfOtherSources(sourceId)).not.toContain("https://agent.persisted.example/");
  });

  it("fills the host of the Agenstry feed's snapshots from their identity in migration 0059, and leaves the registries' and any host already there alone", async () => {
    const { collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    const file = (await collectMigrationFiles(path.resolve(process.cwd(), "drizzle"))).find(entry => entry.version === 59)!;
    const statements = splitMigrationStatements(await readFile(file.file, "utf8"));
    expect(statements).toHaveLength(2);
    await seed({ key: "agenstryish", parserVersion: "agenstry-catalog-v2-source-scoped", identityExternalId: "src-agenstryish:Backfill.Example" });
    await seed({ key: "agenstrykept", parserVersion: "agenstry-catalog-v1-source-scoped", identityExternalId: "src-agenstrykept:other.example", partyHost: "kept.example" });
    await seed({ key: "registryish", parserVersion: "a2a-registry-catalog-v1-source-scoped", identityExternalId: "src-registryish:5f3c9a10-0000-4000-8000-000000000000" });

    const connection = await createConnection(process.env.DATABASE_URL!);
    try {
      await connection.query(statements[1]!);
    } finally {
      await connection.end();
    }

    const hostOf = async (key: string) => (await writer.select().from(schema.agentPublicSnapshots).where(eq(schema.agentPublicSnapshots.id, `snapshot-${key}`)))[0]!.partyHost;
    expect(await hostOf("agenstryish")).toBe("backfill.example");
    expect(await hostOf("agenstrykept")).toBe("kept.example");
    expect(await hostOf("registryish")).toBeNull();
  });
});
