import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FLEET_MIN, LIGHT_CHAIN_ORDER, placementHash } from "@shared/noosphere";
import * as schema from "../drizzle/schema";

/**
 * The Noosphere sample read from a real database, with the entries the public must never see (hidden,
 * closed, on a suppressed host, in a paused source, withdrawn) sitting beside the ones it may. None of
 * them may show up as a light, and a locator listing is never a light at all. The database half skips
 * when none is reachable; the arithmetic is in noosphere.test.ts.
 */
const TEST_DB = "nooscape_noosphere_test";
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

describe.skipIf(!dbReachable)("the Noosphere sample against a real database", () => {
  type Db = typeof import("./db");
  let db: Db;
  let readCache: typeof import("./readCache");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;

  async function source(id: string, protocol: (typeof schema.ingestionSources.$inferInsert)["protocol"], state: "active" | "paused") {
    await writer.insert(schema.ingestionSources).values({
      id,
      sourceKey: `noosphere-${id}`,
      label: id,
      protocol,
      rootUrl: "https://noosphere.example/feed",
      allowedHostname: "noosphere.example",
      state,
      createdByUserId: operatorUserId,
    });
  }

  async function entry(id: string, sourceId: string, protocol: (typeof schema.agentDirectoryEntries.$inferInsert)["protocol"], extra: Partial<typeof schema.agentDirectoryEntries.$inferInsert> = {}) {
    await writer.insert(schema.agentDirectoryEntries).values({ id, sourceId, externalKey: `key-${id}`, displayName: `Entry ${id}`, protocol, ...extra });
  }

  async function reviewed(agentId: string, protocols: string[], sourceId = "src-reviewed", runId = "run-reviewed") {
    const observationId = `obs-${agentId}`;
    await writer.insert(schema.agents).values({ id: agentId, displayName: `Record ${agentId}`, handle: `handle-${agentId}` });
    await writer.insert(schema.sourceObservations).values({
      id: observationId,
      sourceId,
      protocol: "catalog",
      canonicalLocator: `https://noosphere.example/${agentId}`,
      locatorHash: `loc-${agentId}`.padEnd(64, "0").slice(0, 64),
      contentHash: `hash-${agentId}`.padEnd(64, "0").slice(0, 64),
      rawObjectKey: `noosphere/${agentId}`,
      contentType: "application/json",
      parserVersion: "noosphere-test",
      validationStatus: "valid",
      validationFindings: "[]",
      observedAt: new Date(),
    });
    await writer.insert(schema.sourceObservationRuns).values({ runId, observationId });
    await writer.insert(schema.agentPublicSnapshots).values({
      id: `snap-${agentId}`,
      agentId,
      sourceId,
      sourceObservationId: observationId,
      displayName: `Record ${agentId}`,
      displayHandle: `handle-${agentId}`,
      protocols: JSON.stringify(protocols),
    });
  }

  async function approvedSource(sourceId: string, runId: string, state: "active" | "paused") {
    await source(sourceId, "catalog", state);
    await writer.insert(schema.ingestionRuns).values({ id: runId, sourceId, trigger: "manual", status: "completed", startedAt: new Date(), finishedAt: new Date() });
    await writer.insert(schema.sourceProjectionDecisions).values({ sourceId, state: "public", rationale: "noosphere test", decidedByUserId: operatorUserId, approvedRunId: runId });
  }

  /** The hashes of the lights, fresh from the database. */
  async function lights() {
    readCache.invalidateDirectoryReads();
    return (await db.readNoosphereSample()).lights;
  }
  const sampledHash = (id: string) => crc32(id) >>> 0;

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
    readCache = await import("./readCache");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    await writer.insert(schema.users).values({ openId: "noosphere-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "noosphere-operator"));
    operatorUserId = operator.id;

    await source("src-rh", "erc8004", "active");
    await source("src-sol", "solana_registry", "active");
    await source("src-sol8004", "solana_8004", "paused");
    await source("src-catalog", "catalog", "active");

    // Robinhood: visible identities, and one each the public must not see. A fleet of 55 shares one wallet.
    for (const n of [1, 2, 3]) await entry(`rh-${n}`, "src-rh", "erc8004", { registrant: `0xsolo${n}` });
    await entry("rh-hidden", "src-rh", "erc8004", { hidden: true });
    await entry("rh-closed", "src-rh", "erc8004", { assetClosedAt: new Date() });
    await entry("rh-suppressed", "src-rh", "erc8004", { locatorHost: "api.agentrank.info" });
    for (let n = 0; n < FLEET_MIN + 5; n += 1) await entry(`rh-fleet-${n}`, "src-rh", "erc8004", { registrant: "0xfleet", locatorHost: "fleet.example.org" });
    // Solana: two visible, one hidden; and two in a paused registry.
    for (const n of [1, 2]) await entry(`sol-${n}`, "src-sol", "solana_registry", { registrant: `solowner${n}` });
    await entry("sol-hidden", "src-sol", "solana_registry", { hidden: true });
    for (const n of [1, 2]) await entry(`sol8004-${n}`, "src-sol8004", "solana_8004");
    // Locator listings: acknowledged, but a listing is not a registered agent.
    for (const n of [1, 2, 3]) await entry(`catalog-${n}`, "src-catalog", "catalog");

    // Reviewed records: one on Solana, one on no chain, one withdrawn, one from a source that is not active.
    await approvedSource("src-reviewed", "run-reviewed", "active");
    await approvedSource("src-reviewed-paused", "run-reviewed-paused", "paused");
    await reviewed("rec-sol", ["solana_registry"]);
    await reviewed("rec-none", ["a2a"]);
    await reviewed("rec-withdrawn", ["erc8004"]);
    await reviewed("rec-paused", ["erc8004"], "src-reviewed-paused", "run-reviewed-paused");
    await writer.insert(schema.agentRecordWithdrawals).values({ agentId: "rec-withdrawn", action: "withdraw", reason: "noosphere test", decidedByUserId: operatorUserId });
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("draws every registration the public may see, when there are few enough to draw them all", async () => {
    const hashes = (await lights()).filter(light => light[2] === 0).map(light => light[0]);
    for (const id of ["rh-1", "rh-2", "rh-3", "sol-1", "sol-2", "rh-fleet-0", `rh-fleet-${FLEET_MIN + 4}`]) expect(hashes, id).toContain(sampledHash(id));
    expect(hashes).toHaveLength(3 + (FLEET_MIN + 5) + 2);
  });

  it("keeps the registrations when listings outnumber them many times over, because the query only reads registrations", async () => {
    // At 215,000 listings to 25,000 registrations a query that read both and then cut to the cap would drop most registrations.
    const rows = Array.from({ length: 2_500 }, (_, index) => ({ id: `bulk-listing-${index}`, sourceId: "src-catalog", externalKey: `key-bulk-${index}`, displayName: `Listing ${index}`, protocol: "catalog" as const }));
    for (let start = 0; start < rows.length; start += 500) await writer.insert(schema.agentDirectoryEntries).values(rows.slice(start, start + 500));
    try {
      const hashes = (await lights()).filter(light => light[2] === 0).map(light => light[0]);
      expect(hashes).toHaveLength(3 + (FLEET_MIN + 5) + 2);
      for (const id of ["rh-1", "rh-2", "rh-3", "sol-1", "sol-2", "rh-fleet-0", `rh-fleet-${FLEET_MIN + 4}`]) expect(hashes, id).toContain(sampledHash(id));
    } finally {
      await writer.delete(schema.agentDirectoryEntries).where(eq(schema.agentDirectoryEntries.sourceId, "src-catalog"));
      for (const n of [1, 2, 3]) await entry(`catalog-${n}`, "src-catalog", "catalog");
      readCache.invalidateDirectoryReads();
    }
  });

  it("never draws what the public must not see: hidden, closed, suppressed, from a paused source, or a listing", async () => {
    const hashes = (await lights()).map(light => light[0]);
    for (const id of ["rh-hidden", "rh-closed", "rh-suppressed", "sol-hidden", "sol8004-1", "sol8004-2", "catalog-1", "catalog-2", "catalog-3"]) {
      expect(hashes, id).not.toContain(sampledHash(id));
    }
  });

  it("draws the reviewed records as steady lights, and not a withdrawn one or one from a source that is not active", async () => {
    const all = await lights();
    const steady = all.filter(light => light[2] === 1);
    expect(steady.map(light => light[0]).sort()).toEqual([placementHash("rec-none"), placementHash("rec-sol")].sort());
    expect(steady.map(light => LIGHT_CHAIN_ORDER[light[1]]).sort()).toEqual([null, "solana"]);
    const hashes = all.map(light => light[0]);
    expect(hashes).not.toContain(placementHash("rec-withdrawn"));
    expect(hashes).not.toContain(placementHash("rec-paused"));
  });

  it("says what it was drawn from: the on-chain registrations the public may see, not the listings", async () => {
    readCache.invalidateDirectoryReads();
    const sample = await db.readNoosphereSample();
    expect(sample.total).toBe(3 + (FLEET_MIN + 5) + 2);
    expect(sample.sampled).toBe(sample.total);
    expect(sample.steady).toBe(2);
    expect(sample.lights).toHaveLength(sample.sampled + sample.steady);
    expect(Number.isNaN(Date.parse(sample.asOf))).toBe(false);
  });

  it("finds the fleet: the wallet behind the large group, with where its registrations point", async () => {
    readCache.invalidateDirectoryReads();
    const sample = await db.readNoosphereSample();
    expect(sample.fleets).toEqual([{ wallet: "0xfleet", size: FLEET_MIN + 5, chain: "robinhood", host: "fleet.example.org" }]);
    const fleetLights = sample.lights.filter(light => light[3] === 1);
    expect(fleetLights).toHaveLength(FLEET_MIN + 5);
    expect(fleetLights.every(light => light[2] === 0 && LIGHT_CHAIN_ORDER[light[1]] === "robinhood")).toBe(true);
    // A wallet with one registration is not a fleet.
    expect(sample.fleets.map(fleet => fleet.wallet)).not.toContain("0xsolo1");
  });

  it("gives the same lights on every read of the same data", async () => {
    const first = await lights();
    const second = await lights();
    expect(second).toEqual(first);
  });

  it("carries a number for each part of a light and nothing else: no id, no name, no score", async () => {
    const sample = await db.readNoosphereSample();
    for (const light of sample.lights) {
      expect(light).toHaveLength(4);
      for (const part of light) expect(typeof part).toBe("number");
    }
    expect(JSON.stringify(sample)).not.toMatch(/rh-|sol-|rec-|Entry |Record |handle-/);
  });

  it("drops a hidden entry on the very next read, and brings it back when it is unhidden", async () => {
    expect((await lights()).map(light => light[0])).toContain(sampledHash("rh-1"));
    await db.hideDirectoryEntry("rh-1");
    expect((await db.readNoosphereSample()).lights.map(light => light[0])).not.toContain(sampledHash("rh-1"));
    await db.unhideDirectoryEntry("rh-1");
    expect((await db.readNoosphereSample()).lights.map(light => light[0])).toContain(sampledHash("rh-1"));
  });

  it("drops a registry's lights the moment its source is paused", async () => {
    expect((await lights()).map(light => light[0])).toContain(sampledHash("sol-1"));
    await db.decideIngestionSource({ sourceId: "src-sol", decision: "paused", decidedByUserId: operatorUserId, rationale: "noosphere test pause" });
    const after = (await db.readNoosphereSample()).lights.map(light => light[0]);
    expect(after).not.toContain(sampledHash("sol-1"));
    expect(after).not.toContain(sampledHash("sol-2"));
    await db.decideIngestionSource({ sourceId: "src-sol", decision: "active", decidedByUserId: operatorUserId, rationale: "noosphere test resume" });
    expect((await db.readNoosphereSample()).lights.map(light => light[0])).toContain(sampledHash("sol-1"));
  });

  it("drops a reviewed record the moment an operator withdraws it", async () => {
    expect((await lights()).filter(light => light[2] === 1)).toHaveLength(2);
    await writer.insert(schema.agentRecordWithdrawals).values({ agentId: "rec-sol", action: "withdraw", reason: "noosphere test", decidedByUserId: operatorUserId });
    readCache.invalidateDirectoryReads();
    expect((await db.readNoosphereSample()).lights.filter(light => light[2] === 1)).toHaveLength(1);
    await writer.insert(schema.agentRecordWithdrawals).values({ agentId: "rec-sol", action: "reinstate", reason: "noosphere test", decidedByUserId: operatorUserId });
    readCache.invalidateDirectoryReads();
    expect((await db.readNoosphereSample()).lights.filter(light => light[2] === 1)).toHaveLength(2);
  });
});
