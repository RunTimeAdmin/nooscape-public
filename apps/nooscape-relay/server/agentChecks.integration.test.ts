import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection, createPool, type Connection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";
import type { SafeFetchResult } from "./safeFetch";

/**
 * The checks against a real database: the migration that creates the table (run as the owner would paste it), and which
 * endpoints are asked. An endpoint is asked only when the approved version of an active A2A source declares it, so a URL
 * from a run nobody approved, one from a source that is not A2A (Metaplex records a route of its own), one from a paused
 * source or a source not yet public, an http one and one of an agent that is not served are all left alone, and what the
 * next approved run no longer declares stops being asked. Also an address two agents share asked once and recorded twice,
 * the latest check deciding what is due next, and a run that cannot read the table asking nobody anything. Also what an
 * agent's page shows of those checks, through the same gate. Skips when no database is reachable. The pure rules are in agentChecks.test.ts.
 */
const TEST_DB = "nooscape_agent_checks_test";
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

const HOUR = 60 * 60 * 1000;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const answered = (status = 200): SafeFetchResult => ({ ok: true, url: "https://x.example.com/", status, headers: {}, body: Buffer.from("hello"), truncated: false, bodySha256: sha("hello"), address: "93.184.216.34", tlsProtocol: "TLSv1.3", redirects: [], latencyMs: 42 });
const SERVED = ["agent-a", "agent-b", "agent-c", "agent-e", "agent-f", "agent-m", "agent-p", "agent-r"];

describe.skipIf(!dbReachable)("agent checks against a real database", { timeout: 60_000 }, () => {
  let checks: typeof import("./agentChecks");
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let seed: Connection;
  let pasteMigration: () => Promise<void>;

  const fakeFetcher = (asked: string[], answer: (url: string) => SafeFetchResult = () => answered()) => () =>
    ({ fetch: async (url: string) => (asked.push(url), answer(url)), remainingBudget: () => 100, spent: () => asked.length }) as unknown as ReturnType<import("./agentChecks").ChecksDeps["fetcher"]>;
  /** A run with the served set given, a fresh memory of what was asked (the process's own would carry one test's asks into the next), and the fetcher. */
  const run = (asked: string[], over: Partial<import("./agentChecks").ChecksDeps> = {}) =>
    checks.runLivenessChecks({ servedAgentIds: async () => SERVED, askedAt: new Map(), fetcher: fakeFetcher(asked), ...over });
  const rows = async () => writer.select().from(schema.agentChecks);
  const clearChecks = async () => void (await writer.delete(schema.agentChecks));
  const sorted = (items: string[]) => items.slice().sort();

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
    // The table is a manual migration, so a boot does not make it: run the file as the owner would paste it.
    pasteMigration = async () => {
      const paste = await createConnection(process.env.DATABASE_URL!);
      for (const statement of splitMigrationStatements(await readFile("drizzle/0037_agent_checks.sql", "utf8"))) await paste.query(statement);
      await paste.end();
    };
    await pasteMigration();

    checks = await import("./agentChecks");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };

    // The reviewed-run machinery the public reads use, seeded on one connection with the foreign keys off.
    seed = await createConnection(process.env.DATABASE_URL);
    await seed.query("SET FOREIGN_KEY_CHECKS = 0");
    const source = (id: string, protocol: string, state: string) => seed.query("INSERT INTO ingestion_sources (id, sourceKey, label, protocol, rootUrl, allowedHostname, state, createdByUserId) VALUES (?, ?, ?, ?, 'https://src.example/feed', 'src.example', ?, 1)", [id, `key-${id}`, id, protocol, state]);
    const ingestionRun = (id: string, sourceId: string) => seed.query("INSERT INTO ingestion_runs (id, sourceId, `trigger`, status) VALUES (?, ?, 'scheduled', 'completed')", [id, sourceId]);
    const observation = (id: string, sourceId: string, protocol: string) =>
      seed.query("INSERT INTO source_observations (id, sourceId, protocol, canonicalLocator, locatorHash, contentHash, rawObjectKey, contentType, parserVersion, validationStatus, validationFindings) VALUES (?, ?, ?, ?, ?, ?, 'raw/key', 'application/json', 'test-1', 'valid', '[]')", [id, sourceId, protocol, `https://src.example/${id}`, sha(`locator-${id}`), sha(`content-${id}`)]);
    const link = (runId: string, observationId: string) => seed.query("INSERT INTO source_observation_runs (runId, observationId) VALUES (?, ?)", [runId, observationId]);
    const decision = (sourceId: string, state: string, approvedRunId: string) => seed.query("INSERT INTO source_projection_decisions (sourceId, state, rationale, decidedByUserId, approvedRunId) VALUES (?, ?, 'test', 1, ?)", [sourceId, state, approvedRunId]);
    const endpoint = (id: string, agentId: string, url: string, observationId: string) =>
      seed.query("INSERT INTO agent_endpoints (id, agentId, protocol, endpointUrl, endpointHash, sourceObservationId) VALUES (?, ?, 'a2a', ?, ?, ?)", [id, agentId, url, sha(url), observationId]);

    await source("src-a2a", "a2a", "active");
    await source("src-mx", "solana_registry", "active");
    await source("src-paused", "a2a", "paused");
    await source("src-review", "a2a", "active");
    for (const [id, sourceId] of [["run-ok", "src-a2a"], ["run-new", "src-a2a"], ["run-mx", "src-mx"], ["run-paused", "src-paused"], ["run-review", "src-review"]] as const) await ingestionRun(id, sourceId);
    await observation("obs-ok", "src-a2a", "a2a");
    await observation("obs-new", "src-a2a", "a2a");
    await observation("obs-old", "src-a2a", "a2a");
    await observation("obs-mx", "src-mx", "solana_registry");
    await observation("obs-paused", "src-paused", "a2a");
    await observation("obs-review", "src-review", "a2a");
    // obs-ok is content both runs saw; obs-new only the newer run (not approved); obs-old only the approved one.
    for (const [runId, observationId] of [["run-ok", "obs-ok"], ["run-new", "obs-ok"], ["run-new", "obs-new"], ["run-ok", "obs-old"], ["run-mx", "obs-mx"], ["run-paused", "obs-paused"], ["run-review", "obs-review"]] as const) await link(runId, observationId);
    await decision("src-a2a", "public", "run-ok");
    await decision("src-mx", "public", "run-mx");
    await decision("src-paused", "public", "run-paused");
    await decision("src-review", "review", "run-review");

    await endpoint("ep-a-card", "agent-a", "https://a.example.com/card", "obs-ok");
    await endpoint("ep-a-shared", "agent-a", "https://shared.example.com/", "obs-ok");
    await endpoint("ep-b-shared", "agent-b", "https://shared.example.com/", "obs-ok");
    await endpoint("ep-c-http", "agent-c", "http://insecure.example.com/", "obs-ok");
    await endpoint("ep-d-unserved", "agent-d", "https://d.example.com/", "obs-ok");
    await endpoint("ep-e-new", "agent-e", "https://new-card.example.com/", "obs-new");
    await endpoint("ep-f-old", "agent-f", "https://old-card.example.com/", "obs-old");
    await endpoint("ep-m-metaplex", "agent-m", "https://api.metaplex.com/v1/agents/x/a2a", "obs-mx");
    await endpoint("ep-p-paused", "agent-p", "https://paused.example.com/", "obs-paused");
    await endpoint("ep-r-review", "agent-r", "https://review.example.com/", "obs-review");
  });

  afterAll(async () => {
    await seed?.end();
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  describe("the migration", () => {
    it("makes the table the code relies on: its columns, which may be empty, and the two indexes with the kind in them", async () => {
      const probe = await createConnection(process.env.DATABASE_URL!);
      const [columns] = (await probe.query("SHOW COLUMNS FROM `agent_checks`")) as [Array<{ Field: string; Null: string }>, unknown];
      const [indexes] = (await probe.query("SHOW INDEX FROM `agent_checks`")) as [Array<{ Key_name: string; Column_name: string; Seq_in_index: number }>, unknown];
      await probe.end();
      expect(columns.map(column => column.Field)).toEqual(["id", "agentId", "endpointId", "kind", "checkedAt", "outcome", "reason", "statusCode", "latencyMs", "bodySha256"]);
      expect(Object.fromEntries(columns.map(column => [column.Field, column.Null]))).toEqual({ id: "NO", agentId: "NO", endpointId: "NO", kind: "NO", checkedAt: "NO", outcome: "NO", reason: "YES", statusCode: "YES", latencyMs: "YES", bodySha256: "YES" });
      const indexOf = (name: string) => indexes.filter(index => index.Key_name === name).sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(index => index.Column_name);
      expect(indexOf("agent_checks_endpoint_idx")).toEqual(["endpointId", "kind", "checkedAt"]);
      expect(indexOf("agent_checks_agent_idx")).toEqual(["agentId", "kind", "checkedAt"]);
    });

    it("refers to nothing and is referred to by nothing, so it can be dropped alone", async () => {
      const probe = await createConnection(process.env.DATABASE_URL!);
      const [found] = (await probe.query(
        "SELECT TABLE_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND (TABLE_NAME = 'agent_checks' OR REFERENCED_TABLE_NAME = 'agent_checks') AND REFERENCED_TABLE_NAME IS NOT NULL",
        [TEST_DB]
      )) as [unknown[], unknown];
      await probe.end();
      expect(found).toEqual([]);
    });

    it("can be run again by hand without error and without touching a row", async () => {
      await writer.insert(schema.agentChecks).values({ id: "kept-row", agentId: "agent-a", endpointId: "ep-a-card", kind: "liveness", outcome: "answered", statusCode: 200, latencyMs: 5, bodySha256: sha("kept") });
      await pasteMigration();
      expect((await rows()).map(row => row.id)).toEqual(["kept-row"]);
      await clearChecks();
    });
  });

  describe("which endpoints are asked", () => {
    it("asks what the approved run of an active A2A source declares, for a served agent, over https, and nothing else", async () => {
      const asked: string[] = [];
      const result = await run(asked);
      // Not agent-d (not served), the http endpoint, the URL of a run nobody approved, Metaplex's route, a paused source's, or a source not yet public.
      expect(sorted(asked)).toEqual(["https://a.example.com/card", "https://old-card.example.com/", "https://shared.example.com/"]);
      expect(result).toMatchObject({ state: "completed", due: 3, taken: 3, asked: 3, answered: 3, recorded: 4, failedToRecord: 0 });
      expect(sorted((await rows()).map(row => row.endpointId))).toEqual(["ep-a-card", "ep-a-shared", "ep-b-shared", "ep-f-old"]);
    });

    it("records a row for each endpoint that declares an address two agents share, asked once", async () => {
      const written = await rows();
      for (const row of written) {
        expect(row).toMatchObject({ kind: "liveness", outcome: "answered", reason: null, statusCode: 200, latencyMs: 42, bodySha256: sha("hello") });
        expect(Math.abs(row.checkedAt.getTime() - Date.now())).toBeLessThan(60_000);
      }
      expect(written.find(row => row.endpointId === "ep-a-shared")!.agentId).toBe("agent-a");
      expect(written.find(row => row.endpointId === "ep-b-shared")!.agentId).toBe("agent-b");
      await clearChecks();
    });

    it("leaves out what the next approved run no longer declares, and asks what it declares, once that run is approved", async () => {
      // The operator approves the newer run: obs-ok is content it also saw, obs-new is new, obs-old is gone from it.
      await seed.query("UPDATE source_projection_decisions SET approvedRunId = 'run-new' WHERE sourceId = 'src-a2a'");
      try {
        const asked: string[] = [];
        await run(asked);
        expect(sorted(asked)).toEqual(["https://a.example.com/card", "https://new-card.example.com/", "https://shared.example.com/"]);
        expect(asked).not.toContain("https://old-card.example.com/");
      } finally {
        await seed.query("UPDATE source_projection_decisions SET approvedRunId = 'run-ok' WHERE sourceId = 'src-a2a'");
        await clearChecks();
      }
    });

    it("stops asking a source the operator pauses or whose public decision is revoked, at once", async () => {
      await seed.query("UPDATE ingestion_sources SET state = 'paused' WHERE id = 'src-a2a'");
      try {
        const asked: string[] = [];
        expect(await run(asked)).toMatchObject({ state: "completed", due: 0, taken: 0 });
        expect(asked).toEqual([]);
      } finally {
        await seed.query("UPDATE ingestion_sources SET state = 'active' WHERE id = 'src-a2a'");
      }
      await seed.query("UPDATE source_projection_decisions SET state = 'revoked' WHERE sourceId = 'src-a2a'");
      try {
        const asked: string[] = [];
        expect(await run(asked)).toMatchObject({ due: 0, taken: 0 });
        expect(asked).toEqual([]);
      } finally {
        await seed.query("UPDATE source_projection_decisions SET state = 'public' WHERE sourceId = 'src-a2a'");
      }
    });

    it("asks a source's endpoints only if its protocol is on the list: an A2A source today, nothing else", async () => {
      expect([...checks.CHECKABLE_SOURCE_PROTOCOLS]).toEqual(["a2a"]);
      // The Metaplex source is active and public, and its observation is in its approved run; it is still not asked.
      const asked: string[] = [];
      await run(asked, { servedAgentIds: async () => ["agent-m"] });
      expect(asked).toEqual([]);
    });
  });

  describe("how often", () => {
    it("finds nothing due straight after a run, and finds an address due again when its latest check is a day old", async () => {
      const first: string[] = [];
      await run(first);
      expect(first).toHaveLength(3);
      const again: string[] = [];
      expect(await run(again)).toMatchObject({ state: "completed", due: 0, taken: 0 });
      expect(again).toEqual([]);
      // Age the checks of one address by 25 hours, through the same writer the run uses.
      await writer.update(schema.agentChecks).set({ checkedAt: new Date(Date.now() - 25 * HOUR) }).where(eq(schema.agentChecks.endpointId, "ep-a-card"));
      const later: string[] = [];
      expect(await run(later)).toMatchObject({ due: 1, taken: 1, recorded: 1 });
      expect(later).toEqual(["https://a.example.com/card"]);
      // The latest check of that endpoint is the new one: it is not due again.
      expect(await run([])).toMatchObject({ due: 0 });
      expect(await writer.select().from(schema.agentChecks).where(eq(schema.agentChecks.endpointId, "ep-a-card"))).toHaveLength(2);
      await clearChecks();
    });

    it("does not ask an address again because a new endpoint row declares it, when it was asked within the day", async () => {
      await run([]);
      await seed.query("INSERT INTO agent_endpoints (id, agentId, protocol, endpointUrl, endpointHash, sourceObservationId) VALUES ('ep-b-card2', 'agent-b', 'a2a', 'https://a.example.com/card', ?, 'obs-ok')", [sha("https://a.example.com/card")]);
      try {
        const asked: string[] = [];
        expect(await run(asked)).toMatchObject({ due: 0 });
        expect(asked).toEqual([]);
      } finally {
        await seed.query("DELETE FROM agent_endpoints WHERE id = 'ep-b-card2'");
        await clearChecks();
      }
    });

    it("counts only liveness checks: a recent check of another kind does not make an address not due", async () => {
      await writer.insert(schema.agentChecks).values({ id: "other-kind", agentId: "agent-a", endpointId: "ep-a-card", kind: "metadata", outcome: "answered", statusCode: 200, latencyMs: 5, bodySha256: sha("m") });
      const asked: string[] = [];
      await run(asked);
      expect(asked).toContain("https://a.example.com/card");
      await clearChecks();
    });
  });

  describe("what is recorded and what fails", () => {
    it("records a host that did not answer and an ask a rule stopped, with their reasons and no status", async () => {
      const result = await run([], {
        fetcher: fakeFetcher([], url => (url.includes("shared") ? { ok: false, reason: "robots_disallowed", detail: "d", url, redirects: [], latencyMs: 1 } : { ok: false, reason: "timeout", detail: "d", url, redirects: [], latencyMs: 5000 })),
      });
      expect(result).toMatchObject({ state: "completed", noAnswer: 2, skipped: 1, answered: 0, recorded: 4 });
      const byEndpoint = Object.fromEntries((await rows()).map(row => [row.endpointId, row]));
      expect(byEndpoint["ep-a-card"]).toMatchObject({ outcome: "no_answer", reason: "timeout", statusCode: null, latencyMs: null, bodySha256: null });
      expect(byEndpoint["ep-a-shared"]).toMatchObject({ outcome: "skipped", reason: "robots_disallowed", statusCode: null });
      await clearChecks();
    });

    it("works with the real served set too: with no reviewed record in this database nothing is due and nobody is asked", async () => {
      const asked: string[] = [];
      expect(await checks.runLivenessChecks({ askedAt: new Map(), fetcher: fakeFetcher(asked) })).toMatchObject({ state: "completed", due: 0, taken: 0 });
      expect(asked).toEqual([]);
    });

    it("is unavailable and asks nobody anything when the checks table is not there, and works again when it is", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const probe = await createConnection(process.env.DATABASE_URL!);
      await probe.query("RENAME TABLE `agent_checks` TO `agent_checks_away`");
      try {
        const asked: string[] = [];
        expect(await run(asked)).toEqual({ state: "unavailable" });
        expect(asked).toEqual([]);
        // The reason is in the log: the driver's error and its code, not the query's parameters.
        const line = JSON.parse(String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])) as { message: string };
        expect(line.message).toContain("ER_NO_SUCH_TABLE");
        expect(line.message).not.toContain("params");
      } finally {
        await probe.query("RENAME TABLE `agent_checks_away` TO `agent_checks`");
        await probe.end();
        vi.restoreAllMocks();
      }
      expect(await run([])).toMatchObject({ state: "completed", asked: 3 });
      await clearChecks();
    });

    it("keeps no check for an endpoint it was not asked to record: every row names an endpoint of its own agent", async () => {
      await run([]);
      const probe = await createConnection(process.env.DATABASE_URL!);
      const [mismatched] = (await probe.query("SELECT COUNT(*) AS n FROM agent_checks c LEFT JOIN agent_endpoints e ON e.id = c.endpointId AND e.agentId = c.agentId WHERE e.id IS NULL")) as [Array<{ n: number }>, unknown];
      await probe.end();
      expect(Number(mismatched[0]!.n)).toBe(0);
      await clearChecks();
    });

    it("keeps the latest-check read on the index: the query for it plans on the endpoint index and reads no table rows", async () => {
      await writer.insert(schema.agentChecks).values(Array.from({ length: 200 }, (_, index) => ({ id: `bulk-${index}`, agentId: "agent-a", endpointId: `ep-${index % 20}`, kind: "liveness", outcome: "answered", statusCode: 200, latencyMs: 5, bodySha256: sha("b") })));
      const probe = await createConnection(process.env.DATABASE_URL!);
      const [plan] = (await probe.query("EXPLAIN SELECT endpointId, MAX(checkedAt) FROM agent_checks WHERE kind = 'liveness' AND endpointId IN ('ep-1','ep-2','ep-3') GROUP BY endpointId")) as [Array<{ key: string | null; Extra: string | null }>, unknown];
      await probe.end();
      expect(plan[0]!.key).toBe("agent_checks_endpoint_idx");
      expect(String(plan[0]!.Extra)).toContain("Using index");
      await clearChecks();
    });
  });

  describe("what an agent's page shows", () => {
    const hosts = async (agentId: string) => (await checks.readPublicChecks(agentId)).map(check => check.host);
    const insertCheck = (id: string, agentId: string, endpointId: string, over: Partial<typeof schema.agentChecks.$inferInsert> = {}) =>
      writer.insert(schema.agentChecks).values({ id, agentId, endpointId, kind: "liveness", outcome: "answered", statusCode: 200, latencyMs: 5, bodySha256: sha(id), ...over });
    const noAnswer = { outcome: "no_answer", reason: "timeout", statusCode: null, latencyMs: null, bodySha256: null } as const;
    const stopped = { outcome: "skipped", reason: "robots_disallowed", statusCode: null, latencyMs: null, bodySha256: null } as const;

    it("shows the latest check of the endpoints the approved run declares, for the agent that declares them", async () => {
      await run([]);
      expect(sorted(await hosts("agent-a"))).toEqual(["a.example.com", "shared.example.com"]);
      expect(await hosts("agent-b")).toEqual(["shared.example.com"]);
      expect(await hosts("agent-f")).toEqual(["old-card.example.com"]);
      expect((await checks.readPublicChecks("agent-b"))[0]).toEqual({ host: "shared.example.com", checkedAt: expect.any(Date), outcome: "answered", statusCode: 200, latencyMs: 42, failing: false });
      await clearChecks();
    });

    it("shows nothing for what the gate keeps out, even when a row for it exists", async () => {
      // Rows as an older gate might have left them: the checks table has no say in which endpoints are eligible.
      const stray = [["agent-m", "ep-m-metaplex"], ["agent-e", "ep-e-new"], ["agent-p", "ep-p-paused"], ["agent-r", "ep-r-review"], ["agent-c", "ep-c-http"]] as const;
      for (const [agentId, endpointId] of stray) await insertCheck(`stray-${endpointId}`, agentId, endpointId);
      for (const [agentId] of stray) expect(await hosts(agentId), agentId).toEqual([]);
      await clearChecks();
    });

    it("stops showing a check at once when its endpoint leaves the approved version, or its source is paused or revoked", async () => {
      await insertCheck("old-1", "agent-f", "ep-f-old");
      expect(await hosts("agent-f")).toEqual(["old-card.example.com"]);
      await seed.query("UPDATE source_projection_decisions SET approvedRunId = 'run-new' WHERE sourceId = 'src-a2a'");
      try {
        expect(await hosts("agent-f")).toEqual([]);
      } finally {
        await seed.query("UPDATE source_projection_decisions SET approvedRunId = 'run-ok' WHERE sourceId = 'src-a2a'");
      }
      await seed.query("UPDATE ingestion_sources SET state = 'paused' WHERE id = 'src-a2a'");
      try {
        expect(await hosts("agent-f")).toEqual([]);
      } finally {
        await seed.query("UPDATE ingestion_sources SET state = 'active' WHERE id = 'src-a2a'");
      }
      await seed.query("UPDATE source_projection_decisions SET state = 'revoked' WHERE sourceId = 'src-a2a'");
      try {
        expect(await hosts("agent-f")).toEqual([]);
      } finally {
        await seed.query("UPDATE source_projection_decisions SET state = 'public' WHERE sourceId = 'src-a2a'");
      }
      expect(await hosts("agent-f")).toEqual(["old-card.example.com"]);
      await clearChecks();
    });

    it("shows the latest check: a host that has stopped answering shows that, and an ask a rule stopped shows nothing", async () => {
      await insertCheck("a-1", "agent-a", "ep-a-card", { checkedAt: new Date(Date.now() - 3 * HOUR) });
      expect((await checks.readPublicChecks("agent-a"))[0]).toMatchObject({ host: "a.example.com", outcome: "answered", statusCode: 200 });
      await insertCheck("a-2", "agent-a", "ep-a-card", { checkedAt: new Date(Date.now() - 2 * HOUR), ...noAnswer });
      expect((await checks.readPublicChecks("agent-a"))[0]).toMatchObject({ host: "a.example.com", outcome: "no_answer", statusCode: null, latencyMs: null });
      // robots.txt now disallows the checker: the older answers are not shown in its place.
      await insertCheck("a-3", "agent-a", "ep-a-card", { checkedAt: new Date(Date.now() - 1 * HOUR), ...stopped });
      expect(await hosts("agent-a")).toEqual([]);
      await clearChecks();
    });

    it("says failing when the last three asks of an endpoint, in a row, got no answer: two do not, an answer after them ends it, and a stopped ask in between breaks it", async () => {
      const at = (hours: number) => new Date(Date.now() - hours * HOUR);
      const line = async () => (await checks.readPublicChecks("agent-a")).find(check => check.host === "a.example.com")!;
      await insertCheck("f-1", "agent-a", "ep-a-card", { checkedAt: at(50), ...noAnswer });
      await insertCheck("f-2", "agent-a", "ep-a-card", { checkedAt: at(26), ...noAnswer });
      expect(await line()).toMatchObject({ outcome: "no_answer", failing: false });
      await insertCheck("f-3", "agent-a", "ep-a-card", { checkedAt: at(2), ...noAnswer });
      expect(await line()).toMatchObject({ outcome: "no_answer", failing: true });
      await insertCheck("f-4", "agent-a", "ep-a-card", { checkedAt: at(1) });
      expect(await line()).toMatchObject({ outcome: "answered", failing: false });
      await insertCheck("f-5", "agent-a", "ep-a-card", { checkedAt: at(0.5), ...noAnswer });
      expect(await line()).toMatchObject({ outcome: "no_answer", failing: false });
      await clearChecks();
      await insertCheck("g-1", "agent-a", "ep-a-card", { checkedAt: at(49), ...noAnswer });
      await insertCheck("g-2", "agent-a", "ep-a-card", { checkedAt: at(25), ...stopped });
      await insertCheck("g-3", "agent-a", "ep-a-card", { checkedAt: at(1), ...noAnswer });
      expect(await line()).toMatchObject({ outcome: "no_answer", failing: false });
      await clearChecks();
    });

    it("reads only the newest three asks of an endpoint, so a long run of old answers does not hide three recent misses, and old misses do not make an answer failing", async () => {
      const at = (hours: number) => new Date(Date.now() - hours * HOUR);
      const line = async () => (await checks.readPublicChecks("agent-a")).find(check => check.host === "a.example.com")!;
      for (let day = 4; day <= 40; day += 1) await insertCheck(`h-old-${day}`, "agent-a", "ep-a-card", { checkedAt: at(day * 24) });
      for (const [id, hours] of [["h-1", 49], ["h-2", 25], ["h-3", 1]] as const) await insertCheck(id, "agent-a", "ep-a-card", { checkedAt: at(hours), ...noAnswer });
      expect(await line()).toMatchObject({ outcome: "no_answer", failing: true });
      await clearChecks();
      for (let day = 4; day <= 40; day += 1) await insertCheck(`i-old-${day}`, "agent-a", "ep-a-card", { checkedAt: at(day * 24), ...noAnswer });
      await insertCheck("i-new", "agent-a", "ep-a-card", { checkedAt: at(1) });
      expect(await line()).toMatchObject({ outcome: "answered", failing: false });
      await clearChecks();
    });

    it("counts only liveness checks: a newer check of another kind does not change what is shown", async () => {
      await insertCheck("a-1", "agent-a", "ep-a-card", { checkedAt: new Date(Date.now() - 3 * HOUR) });
      await insertCheck("a-meta", "agent-a", "ep-a-card", { checkedAt: new Date(Date.now() - 1 * HOUR), kind: "metadata", ...noAnswer });
      expect((await checks.readPublicChecks("agent-a"))[0]).toMatchObject({ host: "a.example.com", outcome: "answered" });
      await clearChecks();
    });

    it("shows nothing for an agent that declares nothing, and for one that is not in the database at all", async () => {
      expect(await hosts("agent-without-endpoints")).toEqual([]);
      expect(await hosts("")).toEqual([]);
    });

    it("is empty, and says nothing in the log, while the checks table is not there, and shows the check again when it is", async () => {
      await insertCheck("a-1", "agent-a", "ep-a-card");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const probe = await createConnection(process.env.DATABASE_URL!);
      await probe.query("RENAME TABLE `agent_checks` TO `agent_checks_away`");
      try {
        expect(await checks.readPublicChecks("agent-a")).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        await probe.query("RENAME TABLE `agent_checks_away` TO `agent_checks`");
        await probe.end();
        vi.restoreAllMocks();
      }
      expect(await hosts("agent-a")).toEqual(["a.example.com"]);
      await clearChecks();
    });

    it("reads the newest few checks of an endpoint from the endpoint index, in order, without a sort of its own", async () => {
      await writer.insert(schema.agentChecks).values(Array.from({ length: 200 }, (_, index) => ({ id: `bulk-${index}`, agentId: "agent-a", endpointId: `ep-${index % 20}`, kind: "liveness", outcome: "answered", statusCode: 200, latencyMs: 5, bodySha256: sha("b") })));
      const probe = await createConnection(process.env.DATABASE_URL!);
      // The statement the page's read sends, written out.
      const [plan] = (await probe.query("EXPLAIN SELECT endpointId, outcome, statusCode, latencyMs, checkedAt FROM agent_checks WHERE kind = 'liveness' AND endpointId = 'ep-1' ORDER BY checkedAt DESC, id DESC LIMIT 3")) as [Array<{ key: string | null; Extra: string | null; rows: number }>, unknown];
      await probe.end();
      expect(plan[0]!.key).toBe("agent_checks_endpoint_idx");
      expect(String(plan[0]!.Extra)).not.toContain("filesort");
      await clearChecks();
    });

    describe("through the real router", () => {
      const profile = async (id: string) => {
        const { appRouter } = await import("./routers");
        const context = { user: null, req: { protocol: "https", headers: {} }, res: {} } as unknown as import("./_core/context").TrpcContext;
        return appRouter.createCaller(context).liveData.agentProfile({ id });
      };

      beforeAll(async () => {
        // The served set the page is gated by: a catalog source whose approved run holds a snapshot of agent-a (served), of agent-w
        // (withdrawn by the operator) and of agent-h (its only snapshot is behind a paused source), and an acknowledged entry. Each
        // of the three that must show nothing also has an endpoint that passes the checks' own gate, and a check.
        await seed.query("INSERT INTO ingestion_sources (id, sourceKey, label, protocol, rootUrl, allowedHostname, state, createdByUserId) VALUES ('src-snap', 'key-src-snap', 'src-snap', 'catalog', 'https://src.example/feed', 'src.example', 'active', 1), ('src-snap-paused', 'key-src-snap-paused', 'src-snap-paused', 'catalog', 'https://src.example/feed', 'src.example', 'paused', 1)");
        await seed.query("INSERT INTO ingestion_runs (id, sourceId, `trigger`, status) VALUES ('run-snap', 'src-snap', 'scheduled', 'completed'), ('run-snap-paused', 'src-snap-paused', 'scheduled', 'completed')");
        await seed.query("INSERT INTO source_projection_decisions (sourceId, state, rationale, decidedByUserId, approvedRunId) VALUES ('src-snap', 'public', 'test', 1, 'run-snap'), ('src-snap-paused', 'public', 'test', 1, 'run-snap-paused')");
        for (const [agentId, sourceId, runId] of [["agent-a", "src-snap", "run-snap"], ["agent-w", "src-snap", "run-snap"], ["agent-h", "src-snap-paused", "run-snap-paused"]] as const) {
          const observationId = `obs-snap-${agentId}`;
          await seed.query("INSERT INTO agents (id, displayName, handle) VALUES (?, ?, ?)", [agentId, `Agent ${agentId}`, `h-${agentId}`]);
          await seed.query("INSERT INTO source_observations (id, sourceId, protocol, canonicalLocator, locatorHash, contentHash, rawObjectKey, contentType, parserVersion, validationStatus, validationFindings) VALUES (?, ?, 'catalog', ?, ?, ?, 'raw/key', 'application/json', 'test-1', 'valid', '[]')", [observationId, sourceId, `https://src.example/${observationId}`, sha(`l-${observationId}`), sha(`c-${observationId}`)]);
          await seed.query("INSERT INTO source_observation_runs (runId, observationId) VALUES (?, ?)", [runId, observationId]);
          await seed.query("INSERT INTO agent_public_snapshots (id, agentId, sourceId, sourceObservationId, displayName, displayHandle, protocols) VALUES (?, ?, ?, ?, ?, ?, ?)", [`snap-${agentId}`, agentId, sourceId, observationId, `Agent ${agentId}`, `h-${agentId}`, JSON.stringify(["a2a"])]);
        }
        await seed.query("INSERT INTO agent_record_withdrawals (agentId, action, reason, decidedByUserId) VALUES ('agent-w', 'withdraw', 'a reason that must not leak', 1)");
        await seed.query("INSERT INTO agent_directory_entries (id, sourceId, externalKey, displayName, protocol) VALUES ('entry-ack', 'src-snap', 'ext-ack', 'Acknowledged entry', 'catalog')");
        for (const [endpointId, agentId, url] of [["ep-w", "agent-w", "https://withdrawn.example.com/"], ["ep-h", "agent-h", "https://hidden.example.com/"], ["ep-ack", "entry-ack", "https://ack.example.com/"]] as const) {
          await seed.query("INSERT INTO agent_endpoints (id, agentId, protocol, endpointUrl, endpointHash, sourceObservationId) VALUES (?, ?, 'a2a', ?, ?, 'obs-ok')", [endpointId, agentId, url, sha(url)]);
          await insertCheck(`router-${endpointId}`, agentId, endpointId);
        }
        await insertCheck("router-a", "agent-a", "ep-a-card");
      });

      it("carries the checks of a served reviewed record, and only the six fields", async () => {
        const served = await profile("agent-a");
        expect(served.kind).toBe("reviewed");
        expect(served.checks.map(check => check.host)).toEqual(["a.example.com"]);
        expect(Object.keys(served.checks[0]!).sort()).toEqual(["checkedAt", "failing", "host", "latencyMs", "outcome", "statusCode"]);
      });

      it("carries none for a record the operator withdrew, one that is not served and an acknowledged entry, each with a gated endpoint and a check", async () => {
        const withdrawn = await profile("agent-w");
        const hidden = await profile("agent-h");
        const acknowledged = await profile("entry-ack");
        expect([withdrawn.kind, withdrawn.checks]).toEqual(["none", []]);
        expect([hidden.kind, hidden.checks]).toEqual(["none", []]);
        expect([acknowledged.kind, acknowledged.checks]).toEqual(["acknowledged", []]);
        expect(JSON.stringify(withdrawn)).not.toContain("must not leak");
        // The read on its own would show a withdrawn record's check: it is the served set in the router that keeps it out.
        expect(await hosts("agent-w")).toEqual(["withdrawn.example.com"]);
      });
    });
  });

  describe("an endpoint read from a card that has not changed", () => {
    it("is recorded on the observation the approved run already holds, so the gate admits it although the run that found it was never approved", async () => {
      const { persistA2aObservation } = await import("./db");
      const source = { id: "src-iface", label: "Interface card" } as unknown as typeof schema.ingestionSources.$inferSelect;
      await seed.query("INSERT INTO ingestion_sources (id, sourceKey, label, protocol, rootUrl, allowedHostname, state, createdByUserId) VALUES ('src-iface', 'key-src-iface', 'Interface card', 'a2a', 'https://iface.example', 'iface.example', 'active', 1)");
      await seed.query("INSERT INTO ingestion_runs (id, sourceId, `trigger`, status) VALUES ('run-iface-1', 'src-iface', 'scheduled', 'completed'), ('run-iface-2', 'src-iface', 'scheduled', 'completed')");
      const observation = { canonicalLocator: "https://iface.example/.well-known/agent-card.json", contentHash: sha("the card, byte for byte"), rawObjectKey: "raw/key", contentType: "application/json", httpStatus: 200, validationStatus: "valid" as const, validationFindings: [], observedAt: new Date() };
      const candidate = (endpointUrl: string | null) => ({ displayName: "Interface Agent", handle: "interface-agent", summary: null, primaryCapability: null, specialties: [], agentCardUrl: observation.canonicalLocator, endpointUrl, authentication: null });
      try {
        // The first run reads the card as the adapter did before it looked at interfaces: no address. The operator approves that run.
        const first = await persistA2aObservation({ source, runId: "run-iface-1", observation, candidate: candidate(null) });
        await seed.query("INSERT INTO source_projection_decisions (sourceId, state, rationale, decidedByUserId, approvedRunId) VALUES ('src-iface', 'public', 'test', 1, 'run-iface-1')");
        // A later run reads the same card, byte for byte, and now finds the address of its interface. Nobody approves this run.
        const second = await persistA2aObservation({ source, runId: "run-iface-2", observation, candidate: candidate("https://api.iface.example/a2a") });

        expect(second.observationId).toBe(first.observationId);
        const [identity] = await writer.select().from(schema.agentIdentities).where(eq(schema.agentIdentities.sourceObservationId, first.observationId));
        const endpoints = await writer.select().from(schema.agentEndpoints).where(eq(schema.agentEndpoints.agentId, identity!.agentId));
        expect(endpoints.map(row => [row.endpointUrl, row.sourceObservationId])).toEqual([["https://api.iface.example/a2a", first.observationId]]);
        // The approved run holds that observation, so the gate admits the address and the next run of the checks asks it.
        const asked: string[] = [];
        await run(asked, { servedAgentIds: async () => [identity!.agentId] });
        expect(asked).toEqual(["https://api.iface.example/a2a"]);
      } finally {
        await seed.query("DELETE FROM source_projection_decisions WHERE sourceId = 'src-iface'");
        await clearChecks();
      }
    });
  });
});
