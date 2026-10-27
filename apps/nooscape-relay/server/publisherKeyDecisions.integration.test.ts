import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { OperatorRuleError } from "./operatorRuleError";

/**
 * The operator's decisions on a publisher key, against a real database: approving a key and revoking one change the key, its history and the
 * read model that the public lists are served from, and they change together. The copy in the read model is what shows a record's tier, so a
 * refresh that failed after the commit left a revoked key's tier on the list and nothing would ever correct it (a second revocation returns
 * early). A trigger on the read model makes its refresh fail on demand. Runs on a throwaway schema and skips when no database is reachable.
 */
const TEST_DB = "nooscape_publisher_key_test";
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

describe.skipIf(!dbReachable)("publisher key decisions against a real database", { timeout: 120_000 }, () => {
  let db: typeof import("./db");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let creatorId: number;
  let approverId: number;
  let admin: Awaited<ReturnType<typeof createConnection>>;

  /** A key waiting for approval, bound to one agent whose read model says it has no verified publisher. */
  async function seedKey(n: number) {
    const agentId = `agent-pk-${n}`;
    const observationId = `obs-pk-${n}`;
    await writer.insert(schema.agents).values({ id: agentId, displayName: `Agent ${n}`, handle: `agent-pk-${n}` });
    await writer.insert(schema.sourceObservations).values({
      id: observationId,
      sourceId: "src-pk",
      protocol: "catalog",
      canonicalLocator: `https://pk.example/record-${n}`,
      locatorHash: `loc-${n}`.padEnd(64, "0"),
      contentHash: `hash-${n}`.padEnd(64, "0"),
      rawObjectKey: `pk/${n}`,
      contentType: "application/json",
      parserVersion: "pk-test",
      validationStatus: "valid",
      validationFindings: "[]",
    });
    await writer.insert(schema.agentIdentities).values({
      id: `ident-pk-${n}`,
      agentId,
      identityType: "catalog_record",
      externalId: `pk-${n}`,
      externalIdHash: `ext-${n}`.padEnd(64, "0"),
      sourceObservationId: observationId,
    });
    await writer.insert(schema.publisherKeys).values({
      id: `key-pk-${n}`,
      issuerName: `Issuer ${n}`,
      publicKeyFingerprint: `fingerprint-${n}`,
      permittedDomains: "[]",
      permittedProtocols: "[]",
      state: "pending",
      policyVersion: "test-v1",
      attestationHash: `attest-${n}`.padEnd(64, "0"),
      createdByUserId: creatorId,
    });
    await writer.insert(schema.publisherBindings).values({
      id: `bind-pk-${n}`,
      agentIdentityId: `ident-pk-${n}`,
      publisherKeyId: `key-pk-${n}`,
      validationMethod: "test",
      sourceObservationId: observationId,
    });
    await writer.insert(schema.reviewItems).values({
      id: `rev-pk-${n}`,
      type: "publisher_key",
      subjectType: "publisher_key",
      subjectId: `key-pk-${n}`,
      rationale: "A proposal for the test.",
      createdByUserId: creatorId,
    });
    await writer.insert(schema.agentReadModel).values({
      agentId,
      displayName: `Agent ${n}`,
      handle: `agent-pk-${n}`,
      protocols: "[]",
      publisherState: "unverified",
      evidenceTier: "tier_2",
      sourceCount: 1,
      evidenceSummary: "{}",
    });
    return { keyId: `key-pk-${n}`, agentId, reviewId: `rev-pk-${n}` };
  }

  const keyState = async (keyId: string) => (await writer.select({ state: schema.publisherKeys.state }).from(schema.publisherKeys).where(eq(schema.publisherKeys.id, keyId)))[0]!.state;
  const historyOf = async (keyId: string) => (await writer.select().from(schema.publisherKeyHistory).where(eq(schema.publisherKeyHistory.publisherKeyId, keyId))).map(row => row.state).sort();
  const readModelOf = async (agentId: string) => {
    const [row] = await writer.select().from(schema.agentReadModel).where(eq(schema.agentReadModel.agentId, agentId));
    return { publisherState: row!.publisherState, evidenceTier: row!.evidenceTier };
  };
  const reviewStatus = async (reviewId: string) => (await writer.select({ status: schema.reviewItems.status }).from(schema.reviewItems).where(eq(schema.reviewItems.id, reviewId)))[0]!.status;
  const eventsOf = async (agentId: string) => (await writer.select().from(schema.evidenceEvents).where(eq(schema.evidenceEvents.agentId, agentId))).map(row => row.eventType).sort();
  /** From now on every update of a read model fails, as a lost connection or a deadlock would. */
  const breakRefresh = () => admin.query("CREATE TRIGGER pk_refresh_fails BEFORE UPDATE ON `agent_read_model` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'the refresh failed'");
  const mendRefresh = () => admin.query("DROP TRIGGER IF EXISTS pk_refresh_fails");

  beforeAll(async () => {
    const root = await createConnection(`${BASE_URL}/mysql`);
    await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await root.query(`CREATE DATABASE \`${TEST_DB}\``);
    await root.end();

    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } = await import("./dbMigrations");
    const baselineReplay = await createConnection(process.env.DATABASE_URL);
    for (const file of (await collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baselineReplay.query(statement);
    }
    await baselineReplay.end();
    await applyPendingMigrations(process.env.DATABASE_URL);

    db = await import("./db");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    admin = await createConnection(process.env.DATABASE_URL);

    await writer.insert(schema.users).values([
      { openId: "pk-creator", role: "admin" },
      { openId: "pk-approver", role: "admin" },
    ]);
    const idOf = async (openId: string) => (await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, openId)))[0]!.id;
    creatorId = await idOf("pk-creator");
    approverId = await idOf("pk-approver");
    await writer.insert(schema.ingestionSources).values({
      id: "src-pk",
      sourceKey: "pk-test-source",
      label: "Publisher key test",
      protocol: "catalog",
      rootUrl: "https://pk.example/",
      allowedHostname: "pk.example",
      state: "active",
      createdByUserId: creatorId,
    });
  });

  afterAll(async () => {
    await mendRefresh().catch(() => undefined);
    await admin?.end();
    await closePool?.();
    const root = await createConnection(`${BASE_URL}/mysql`);
    await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await root.end();
  });

  it("approves a key, and the record's read model shows the key's tier from the same commit", async () => {
    const { keyId, agentId, reviewId } = await seedKey(1);
    expect(await db.approvePublisherKeyPolicy({ keyId, decidedByUserId: approverId, rationale: "Checked." })).toEqual({ keyId, state: "allowlisted", agentIds: [agentId] });
    expect(await keyState(keyId)).toBe("allowlisted");
    expect(await historyOf(keyId)).toEqual(["allowlisted"]);
    expect(await reviewStatus(reviewId)).toBe("approved");
    expect(await eventsOf(agentId)).toEqual(["PUBLISHER_KEY_ALLOWLISTED"]);
    expect(await readModelOf(agentId)).toEqual({ publisherState: "allowlisted", evidenceTier: "tier_4" });
  });

  it("undoes an approval whose read model refresh fails, and approves when it is tried again", async () => {
    const { keyId, agentId, reviewId } = await seedKey(2);
    await breakRefresh();
    try {
      await expect(db.approvePublisherKeyPolicy({ keyId, decidedByUserId: approverId, rationale: "Checked." })).rejects.toThrow();
    } finally {
      await mendRefresh();
    }
    // Nothing of the decision stands: the key is still waiting, with no history, no evidence and a pending review.
    expect(await keyState(keyId)).toBe("pending");
    expect(await historyOf(keyId)).toEqual([]);
    expect(await reviewStatus(reviewId)).toBe("pending");
    expect(await eventsOf(agentId)).toEqual([]);
    expect(await readModelOf(agentId)).toEqual({ publisherState: "unverified", evidenceTier: "tier_2" });
    await db.approvePublisherKeyPolicy({ keyId, decidedByUserId: approverId, rationale: "Checked again." });
    expect(await keyState(keyId)).toBe("allowlisted");
    expect(await readModelOf(agentId)).toEqual({ publisherState: "allowlisted", evidenceTier: "tier_4" });
  });

  it("refuses the creator's own approval, a second approval and a key that is not there with the rule's own words, and changes nothing", async () => {
    const { keyId, agentId } = await seedKey(5);
    const refusal = async (run: () => Promise<unknown>) => {
      const reason = await run().then(() => null, (error: unknown) => error);
      expect(reason).toBeInstanceOf(OperatorRuleError);
      return (reason as Error).message;
    };
    expect(await refusal(() => db.approvePublisherKeyPolicy({ keyId, decidedByUserId: creatorId, rationale: "Checked." }))).toBe("Publisher-key approval requires an operator other than the proposal creator.");
    expect(await keyState(keyId)).toBe("pending");
    expect(await historyOf(keyId)).toEqual([]);
    await db.approvePublisherKeyPolicy({ keyId, decidedByUserId: approverId, rationale: "Checked." });
    expect(await refusal(() => db.approvePublisherKeyPolicy({ keyId, decidedByUserId: approverId, rationale: "Checked." }))).toBe("Only pending publisher key proposals can be approved.");
    expect(await refusal(() => db.approvePublisherKeyPolicy({ keyId: "no-such-key", decidedByUserId: approverId, rationale: "Checked." }))).toBe("Publisher key proposal was not found.");
    expect(await refusal(() => db.revokePublisherKeyPolicy({ keyId: "no-such-key", decidedByUserId: approverId, rationale: "Withdrawn." }))).toBe("Publisher key was not found.");
    expect(await historyOf(keyId)).toEqual(["allowlisted"]);
    expect(await readModelOf(agentId)).toEqual({ publisherState: "allowlisted", evidenceTier: "tier_4" });
  });

  it("revokes a key, and the read model returns to the baseline from the same commit", async () => {
    const { keyId, agentId } = await seedKey(3);
    await db.approvePublisherKeyPolicy({ keyId, decidedByUserId: approverId, rationale: "Checked." });
    expect(await readModelOf(agentId)).toEqual({ publisherState: "allowlisted", evidenceTier: "tier_4" });
    expect(await db.revokePublisherKeyPolicy({ keyId, decidedByUserId: approverId, rationale: "Withdrawn." })).toEqual({ keyId, state: "revoked", agentIds: [agentId] });
    expect(await keyState(keyId)).toBe("revoked");
    expect(await historyOf(keyId)).toEqual(["allowlisted", "revoked"]);
    expect(await eventsOf(agentId)).toEqual(["PUBLISHER_KEY_ALLOWLISTED", "PUBLISHER_KEY_REVOKED"]);
    expect(await readModelOf(agentId)).toEqual({ publisherState: "revoked", evidenceTier: "tier_2" });
  });

  it("leaves a key allowlisted when the refresh of its revocation fails, rather than revoked with a record still showing its tier, and revokes when tried again", async () => {
    const { keyId, agentId } = await seedKey(4);
    await db.approvePublisherKeyPolicy({ keyId, decidedByUserId: approverId, rationale: "Checked." });
    await breakRefresh();
    try {
      await expect(db.revokePublisherKeyPolicy({ keyId, decidedByUserId: approverId, rationale: "Withdrawn." })).rejects.toThrow();
    } finally {
      await mendRefresh();
    }
    expect(await keyState(keyId)).toBe("allowlisted");
    expect(await historyOf(keyId)).toEqual(["allowlisted"]);
    expect(await eventsOf(agentId)).toEqual(["PUBLISHER_KEY_ALLOWLISTED"]);
    expect(await readModelOf(agentId)).toEqual({ publisherState: "allowlisted", evidenceTier: "tier_4" });
    await db.revokePublisherKeyPolicy({ keyId, decidedByUserId: approverId, rationale: "Withdrawn." });
    expect(await keyState(keyId)).toBe("revoked");
    expect(await readModelOf(agentId)).toEqual({ publisherState: "revoked", evidenceTier: "tier_2" });
  });
});
