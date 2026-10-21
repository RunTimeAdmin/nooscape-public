import { eq, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";
import type { RegistrationNameResult } from "./ingestion/registrationFetch";
import { ROBINHOOD_EXTERNAL_PREFIX, ROBINHOOD_SOURCE_KEY, SHOWN_NAME_MAX_CHARS, uriHashOf } from "./robinhoodNamesCore";

/**
 * The Robinhood name step against a real database (docs/approvals/2026-10-17-robinhood-names.md): the placeholders served until a
 * name has been read, the links read and only those, what is recorded for each try, the names laid over the placeholders when
 * the records are served and nothing else changed, the tries and the pace, and a step that never throws. The fetch is a function
 * that answers per link; the real reader is in ingestion/registrationFetch.test.ts. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_rh_names_test";
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

const CID = "QmcsZip4oMCkS8UhrXDmG2Bo1WMaJzbQa35RX2h5QRn1xx";
const summary = (id: number, uri: string | null) =>
  `Registered as agent ${id} in the Robinhood Chain ERC-8004 identity registry (eip155:4663, AgentIdentity/AGENT). ${
    uri === null ? "No URI was set at registration, so no self-description is available." : `Registry-recorded URI at registration: ${uri}`
  } Nooscape retained the registration event; ownership, URI, and self-asserted metadata remain unverified assertions.`;
const linkOf = (id: number) => `https://registrations.example/robinhood/${id}.json`;

describe.skipIf(!dbReachable)("the Robinhood name step against a real database", { timeout: 60_000 }, () => {
  let db: typeof import("./db");
  let names: typeof import("./robinhoodNames");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let sourceId: string;
  let decided = false;

  /** What the fake fetch answers for a link, and every link it was asked. */
  const answers = new Map<string, RegistrationNameResult>();
  const asked: Array<[string, string]> = [];
  const resolve = async (uri: string, kind: string): Promise<RegistrationNameResult> => {
    asked.push([uri, kind]);
    return answers.get(uri) ?? { status: "failed", reason: "no answer was set" };
  };
  const run = (over: Partial<import("./robinhoodNames").RobinhoodNamesDeps> & { tickStartedAt?: number } = {}) => names.runRobinhoodNames({ resolve, intervalMs: 0, ...over });
  const byAgent = async () => new Map((await db.listLiveAtlasRecords()).map(record => [record.agentId, record]));
  const resolutions = async () => (await writer.select().from(schema.agentRegistrationResolutions)).sort((a, b) => a.externalKey.localeCompare(b.externalKey, "en", { numeric: true }));
  const rowFor = async (id: number) => (await resolutions()).find(row => row.externalKey === `${ROBINHOOD_EXTERNAL_PREFIX}${id}`);

  async function seedRecord(id: number, displayName: string, uri: string | null, extraSummary?: string) {
    const agentId = `rh-agent-${id}`;
    const observationId = `rh-obs-${id}`;
    await writer.insert(schema.agents).values({ id: agentId, displayName, handle: `handle-${id}` });
    await writer.insert(schema.sourceObservations).values({
      id: observationId,
      sourceId,
      protocol: "erc8004",
      canonicalLocator: `eip155:4663:${id}`,
      locatorHash: `loc-${observationId}`.padEnd(64, "0").slice(0, 64),
      contentHash: `hash-${observationId}`.padEnd(64, "0").slice(0, 64),
      rawObjectKey: `rh-test/${observationId}`,
      contentType: "application/json",
      parserVersion: "rh-test",
      validationStatus: "valid",
      validationFindings: "[]",
      observedAt: new Date(),
    });
    await writer.insert(schema.sourceObservationRuns).values({ runId: "rh-run", observationId });
    await writer.insert(schema.agentPublicSnapshots).values({
      id: `rh-snapshot-${id}`,
      agentId,
      sourceId,
      sourceObservationId: observationId,
      displayName,
      displayHandle: `handle-${id}`,
      untrustedSelfDescription: extraSummary ?? summary(id, uri),
      protocols: "[]",
    });
    if (!decided) {
      await writer.insert(schema.sourceProjectionDecisions).values({ sourceId, state: "public", rationale: "rh-test", decidedByUserId: operatorId, approvedRunId: "rh-run" });
      decided = true;
    }
  }
  let operatorId: number;

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
    names = await import("./robinhoodNames");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "rh-names-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "rh-names-operator"));
    operatorId = operator!.id;
    sourceId = "src-robinhood";
    await writer.insert(schema.ingestionSources).values({
      id: sourceId,
      sourceKey: ROBINHOOD_SOURCE_KEY,
      label: "Robinhood test",
      protocol: "erc8004",
      rootUrl: "https://rpc.mainnet.chain.robinhood.com",
      allowedHostname: "rpc.mainnet.chain.robinhood.com",
      state: "active",
      createdByUserId: operatorId,
    });
    await writer.insert(schema.ingestionRuns).values({ id: "rh-run", sourceId, trigger: "manual", status: "completed", startedAt: new Date(), finishedAt: new Date() });

    // Reviewed Robinhood records: two with a web link, one with an ipfs link, one with no link at all, and one with a name of its own.
    await seedRecord(8631, "Agent #8631", linkOf(8631));
    await seedRecord(8632, "Agent #8632", linkOf(8632));
    await seedRecord(8627, "Agent #8627", `ipfs://${CID}`);
    await seedRecord(8700, "Agent #8700", null);
    await seedRecord(5, "Mark", linkOf(5));
  });

  afterAll(async () => {
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  it("serves the placeholders until a name has been read", async () => {
    const records = await byAgent();
    expect(records.get("rh-agent-8631")!.displayName).toBe("Agent #8631");
    expect(records.get("rh-agent-5")!.displayName).toBe("Mark");
    expect(await resolutions()).toEqual([]);
  });

  it("reads the links the placeholders name, in agent order, and only those, and records each try", async () => {
    answers.set(linkOf(8631), { status: "resolved", name: "Gelato · muse #98" });
    answers.set(`ipfs://${CID}`, { status: "resolved", name: "Passkeys" });
    answers.set(linkOf(8632), { status: "failed", reason: "HTTP 503" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const outcome = await run();
      expect(outcome).toMatchObject({ state: "completed", considered: 3, read: 3, resolved: 2, noName: 0, failed: 1, stoppedBy: null });
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
    // 8627 (ipfs), 8631, 8632: no record with no link and none with a name of its own.
    expect(asked).toEqual([[`ipfs://${CID}`, "ipfs"], [linkOf(8631), "web"], [linkOf(8632), "web"]]);
    const rows = await resolutions();
    expect(rows.map(row => [row.externalKey, row.uriKind, row.status, row.attempts, row.resolvedName, row.failReason])).toEqual([
      [`${ROBINHOOD_EXTERNAL_PREFIX}8627`, "ipfs", "resolved", 1, "Passkeys", null],
      [`${ROBINHOOD_EXTERNAL_PREFIX}8631`, "web", "resolved", 1, "Gelato · muse #98", null],
      [`${ROBINHOOD_EXTERNAL_PREFIX}8632`, "web", "failed", 1, null, "HTTP 503"],
    ]);
    expect(rows[0]!.uriHash).toBe(uriHashOf(`ipfs://${CID}`));
    expect(rows[0]!.fetchedAt).not.toBeNull();
    expect(rows[2]!.fetchedAt).toBeNull();
    expect(rows.every(row => row.sourceId === sourceId)).toBe(true);
  });

  it("serves the read names, and only the display name changes: the record, its handle and its summary stay as they were", async () => {
    const records = await byAgent();
    expect(records.get("rh-agent-8631")).toMatchObject({ displayName: "Gelato · muse #98", handle: "handle-8631", untrustedSummary: summary(8631, linkOf(8631)) });
    expect(records.get("rh-agent-8627")).toMatchObject({ displayName: "Passkeys", handle: "handle-8627" });
    // A record that got a name says the day it was read, and one that did not has no such field.
    const read = (await resolutions()).find(row => row.externalKey === `${ROBINHOOD_EXTERNAL_PREFIX}8631`)!.fetchedAt!;
    expect((records.get("rh-agent-8631") as { nameReadAt?: string }).nameReadAt).toBe(read.toISOString());
    for (const id of ["rh-agent-8632", "rh-agent-8700", "rh-agent-5"]) expect("nameReadAt" in records.get(id)!).toBe(false);
    // A link that did not answer, a registration with no link and a record with a name of its own are as they were.
    expect(records.get("rh-agent-8632")!.displayName).toBe("Agent #8632");
    expect(records.get("rh-agent-8700")!.displayName).toBe("Agent #8700");
    expect(records.get("rh-agent-5")!.displayName).toBe("Mark");
    expect(records.size).toBe(5);
    // The retained snapshot is untouched.
    const snapshots = await writer.select().from(schema.agentPublicSnapshots);
    expect(snapshots.map(row => row.displayName).sort()).toEqual(["Agent #8627", "Agent #8631", "Agent #8632", "Agent #8700", "Mark"]);
  });

  it("does not read a resolved link again, nor a link that did not answer within six hours", async () => {
    asked.length = 0;
    expect(await run()).toMatchObject({ state: "completed", considered: 1, read: 0 });
    expect(asked).toEqual([]);
  });

  it("tries a link that did not answer again after six hours, and records the new try", async () => {
    await writer.update(schema.agentRegistrationResolutions).set({ lastAttemptAt: new Date(Date.now() - 7 * 3_600_000) }).where(eq(schema.agentRegistrationResolutions.externalKey, `${ROBINHOOD_EXTERNAL_PREFIX}8632`));
    answers.set(linkOf(8632), { status: "resolved", name: "Spark · muse #97" });
    asked.length = 0;
    expect(await run()).toMatchObject({ state: "completed", read: 1, resolved: 1 });
    expect(asked).toEqual([[linkOf(8632), "web"]]);
    const row = await rowFor(8632);
    expect(row).toMatchObject({ status: "resolved", attempts: 2, resolvedName: "Spark · muse #97", failReason: null });
    expect((await byAgent()).get("rh-agent-8632")!.displayName).toBe("Spark · muse #97");
  });

  it("confirms a file with no name once more and then stops asking", async () => {
    await seedRecord(8640, "Agent #8640", linkOf(8640));
    answers.set(linkOf(8640), { status: "no_name" });
    const old = () => writer.update(schema.agentRegistrationResolutions).set({ lastAttemptAt: new Date(Date.now() - 7 * 3_600_000) }).where(eq(schema.agentRegistrationResolutions.externalKey, `${ROBINHOOD_EXTERNAL_PREFIX}8640`));
    expect(await run()).toMatchObject({ read: 1, noName: 1 });
    expect((await rowFor(8640))).toMatchObject({ status: "no_name", attempts: 1, resolvedName: null });
    await old();
    expect(await run()).toMatchObject({ read: 1, noName: 1 });
    expect((await rowFor(8640))).toMatchObject({ attempts: 2 });
    await old();
    asked.length = 0;
    expect(await run()).toMatchObject({ read: 0 });
    expect(asked).toEqual([]);
    expect((await byAgent()).get("rh-agent-8640")!.displayName).toBe("Agent #8640");
  });

  it("reads at most the limit in a run, in agent order, and carries on in the next", async () => {
    for (const id of [8650, 8651, 8652]) {
      await seedRecord(id, `Agent #${id}`, linkOf(id));
      answers.set(linkOf(id), { status: "resolved", name: `Muse ${id}` });
    }
    asked.length = 0;
    expect(await run({ maxNames: 2 })).toMatchObject({ read: 2 });
    expect(asked.map(([uri]) => uri)).toEqual([linkOf(8650), linkOf(8651)]);
    asked.length = 0;
    expect(await run({ maxNames: 2 })).toMatchObject({ read: 1 });
    expect(asked.map(([uri]) => uri)).toEqual([linkOf(8652)]);
  });

  it("stops starting reads when its time is up, and says so", async () => {
    for (const id of [8660, 8661, 8662]) {
      await seedRecord(id, `Agent #${id}`, linkOf(id));
      answers.set(linkOf(id), { status: "resolved", name: `Muse ${id}` });
    }
    let clock = Date.now();
    const outcome = await run({
      now: () => {
        const value = clock;
        clock += 10_000;
        return value;
      },
      budgetMs: 15_000,
    });
    expect(outcome).toMatchObject({ state: "completed", read: 1, stoppedBy: "time" });
    // What it read was kept, and the next run carries on.
    expect(await rowFor(8660)).toMatchObject({ status: "resolved" });
    expect(await run()).toMatchObject({ read: 2 });
  });

  it("runs on the next 30 minute tick even when its step starts a minute early, and not ten minutes after the last run", async () => {
    names.resetRobinhoodNamesClock();
    const base = Date.now();
    const minutes = (count: number) => count * 60_000;
    expect(await run({ intervalMs: minutes(30), now: () => base })).toMatchObject({ state: "completed" });
    expect(await run({ intervalMs: minutes(30), now: () => base + minutes(10) })).toEqual({ state: "idle" });
    expect(await run({ intervalMs: minutes(30), now: () => base + minutes(29) })).toMatchObject({ state: "completed" });
    names.resetRobinhoodNamesClock();
  });

  it("does nothing within its interval, with a tick that has run long, and without an active source", async () => {
    names.resetRobinhoodNamesClock();
    expect(await run({ intervalMs: 60_000 })).toMatchObject({ state: "completed" });
    expect(await run({ intervalMs: 60_000 })).toEqual({ state: "idle" });
    names.resetRobinhoodNamesClock();
    expect(await run({ tickStartedAt: Date.now() - 120_000 })).toEqual({ state: "too_late" });
    // The limit is 100 seconds: a tick 90 seconds old still gets the step (at 60 the BNB file step was skipped on the first tick).
    expect(await run({ tickStartedAt: Date.now() - 90_000 })).toMatchObject({ state: "completed" });
    names.resetRobinhoodNamesClock();
    await writer.update(schema.ingestionSources).set({ state: "paused" }).where(eq(schema.ingestionSources.id, sourceId));
    expect(await run()).toEqual({ state: "no_source" });
    await writer.update(schema.ingestionSources).set({ state: "active" }).where(eq(schema.ingestionSources.id, sourceId));
  });

  it("never throws: a read that blows up is one log line and an unavailable result, and the next run works", async () => {
    await seedRecord(8670, "Agent #8670", linkOf(8670));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcome = await run({ resolve: async () => { throw new Error("boom\nsecond line"); } });
      expect(outcome).toEqual({ state: "unavailable" });
      expect(error).toHaveBeenCalledOnce();
      expect(JSON.parse(String(error.mock.calls[0]![0]))).toEqual({ event: "nooscape_robinhood_names_failed", message: "boom second line" });
    } finally {
      error.mockRestore();
    }
    answers.set(linkOf(8670), { status: "resolved", name: "Muse 8670" });
    expect(await run()).toMatchObject({ state: "completed", read: 1, resolved: 1 });
  });

  it("cleans a name and cuts it at the shown length when the records are served", async () => {
    await writer.update(schema.agentRegistrationResolutions).set({ resolvedName: `  Tin​sel\u0007   ${"x".repeat(180)}` }).where(eq(schema.agentRegistrationResolutions.externalKey, `${ROBINHOOD_EXTERNAL_PREFIX}8631`));
    const shown = (await byAgent()).get("rh-agent-8631")!.displayName;
    expect(shown.length).toBeLessThanOrEqual(SHOWN_NAME_MAX_CHARS);
    expect(shown.startsWith("Tinsel xxx")).toBe(true);
  });

  it("serves every record as it was when the resolutions cannot be read, and never loses one", async () => {
    const before = (await byAgent()).size;
    await writer.execute(sql.raw("RENAME TABLE `agent_registration_resolutions` TO `agent_registration_resolutions_away`"));
    try {
      const records = await byAgent();
      expect(records.size).toBe(before);
      expect(records.get("rh-agent-8627")!.displayName).toBe("Agent #8627");
    } finally {
      await writer.execute(sql.raw("RENAME TABLE `agent_registration_resolutions_away` TO `agent_registration_resolutions`"));
    }
    expect((await byAgent()).get("rh-agent-8627")!.displayName).toBe("Passkeys");
  });
});
