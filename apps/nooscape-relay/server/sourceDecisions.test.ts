import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceDecision, SourceState } from "@shared/sourceTransitions";
import * as schema from "../drizzle/schema";

/**
 * An operator's decision about a source, against a real database: a move SOURCE_TRANSITIONS allows is made and settles the source's pending
 * review item, and any other leaves the source and its review items as they were. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_source_decisions_test";
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

describe.skipIf(!dbReachable)("source decisions against a real database", { timeout: 120_000 }, () => {
  let db: typeof import("./db");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;
  let made = 0;

  /** A new source in a state, with one pending review item. Returns its id. */
  async function source(state: SourceState): Promise<string> {
    made += 1;
    const id = `00000000-0000-4000-8000-${String(made).padStart(12, "0")}`;
    await writer.insert(schema.ingestionSources).values({ id, sourceKey: `decisions-${made}`, label: `source ${made}`, protocol: "a2a", rootUrl: "https://decisions.example/", allowedHostname: "decisions.example", state, createdByUserId: operatorUserId });
    await writer.insert(schema.reviewItems).values({ id: `10000000-0000-4000-8000-${String(made).padStart(12, "0")}`, type: "source", subjectType: "ingestion_source", subjectId: id, rationale: "staged", createdByUserId: operatorUserId });
    return id;
  }

  const decide = (sourceId: string, decision: SourceDecision) => db.decideIngestionSource({ sourceId, decision, decidedByUserId: operatorUserId, rationale: `test ${decision}` });

  async function stateOf(sourceId: string) {
    const [row] = await writer.select({ state: schema.ingestionSources.state }).from(schema.ingestionSources).where(eq(schema.ingestionSources.id, sourceId));
    const [item] = await writer.select({ status: schema.reviewItems.status }).from(schema.reviewItems).where(eq(schema.reviewItems.subjectId, sourceId));
    return { state: row?.state, review: item?.status };
  }

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();

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
    await writer.insert(schema.users).values({ openId: "decisions-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "decisions-operator"));
    operatorUserId = operator!.id;
  }, 240_000);

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("makes the moves the table allows, and settles the pending review item", async () => {
    const approved = await source("review");
    expect(await decide(approved, "active")).toEqual({ moved: true, from: "review" });
    expect(await stateOf(approved)).toEqual({ state: "active", review: "approved" });
    expect(await decide(approved, "paused")).toEqual({ moved: true, from: "active" });
    expect(await decide(approved, "active")).toEqual({ moved: true, from: "paused" });
    expect((await stateOf(approved)).state).toBe("active");

    const rejected = await source("review");
    expect(await decide(rejected, "rejected")).toEqual({ moved: true, from: "review" });
    expect(await stateOf(rejected)).toEqual({ state: "rejected", review: "rejected" });
  });

  it("refuses every other move and changes nothing: a rejected source stays rejected, and a source in review keeps its pending item", async () => {
    const rejected = await source("rejected");
    for (const decision of ["active", "paused", "rejected"] as const) expect(await decide(rejected, decision)).toEqual({ moved: false, from: "rejected" });
    expect(await stateOf(rejected)).toEqual({ state: "rejected", review: "pending" });

    const inReview = await source("review");
    expect(await decide(inReview, "paused")).toEqual({ moved: false, from: "review" });
    expect(await stateOf(inReview)).toEqual({ state: "review", review: "pending" });

    const active = await source("active");
    for (const decision of ["active", "rejected"] as const) expect(await decide(active, decision)).toEqual({ moved: false, from: "active" });
    const paused = await source("paused");
    for (const decision of ["paused", "rejected"] as const) expect(await decide(paused, decision)).toEqual({ moved: false, from: "paused" });
    expect([(await stateOf(active)).state, (await stateOf(paused)).state]).toEqual(["active", "paused"]);

    expect(await decide("00000000-0000-4000-8000-999999999999", "active")).toEqual({ moved: false, from: null });
  });

  it("lets only one of two decisions sent at the same moment through", async () => {
    const id = await source("review");
    const results = await Promise.all([decide(id, "active"), decide(id, "rejected")]);
    expect(results.filter(result => result.moved)).toHaveLength(1);
    const { state, review } = await stateOf(id);
    expect(state === "active" ? review === "approved" : state === "rejected" && review === "rejected").toBe(true);
  });
});
