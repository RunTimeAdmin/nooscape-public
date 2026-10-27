import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import express from "express";
import { createConnection, createPool } from "mysql2/promise";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { problems, schemaOf } from "./apiV1Testing";

/**
 * API keys against a real database (docs/data-access-2026-10-19.md, stage D2): the tables are a manual migration, so the API first
 * runs without them (a keyed request is told keys are not available, an anonymous one is unaffected) and then with the file pasted
 * as the owner would paste it, twice. A key is shown once and only its hash is stored; no network address is kept; the caps on live
 * keys and on sign-ups hold; a revoke and a change of tier take effect at once; and the count of a key's day survives in the table
 * and is read back. Skips when no database is reachable.
 */
const TEST_DB = "nooscape_apikeys_test";
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

describe.skipIf(!dbReachable)("API keys against a real database", { timeout: 120_000 }, () => {
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let server: Server;
  let base = "";
  let keys: typeof import("./apiKeys");
  let rateLimit: typeof import("./rateLimit");
  let appRouter: typeof import("./routers").appRouter;
  let splitMigrationStatements: typeof import("./dbMigrations").splitMigrationStatements;

  const get = (path: string, key?: string) => fetch(`${base}${path}`, key ? { headers: { authorization: `Bearer ${key}` } } : undefined);
  const caller = (ip = "198.51.100.7") => appRouter.createCaller({ req: { headers: {}, ip }, res: {}, user: null } as never);
  const rowsOf = async (table: string) => (await writer.execute(sql.raw(`SELECT * FROM \`${table}\``)))[0] as unknown as Array<Record<string, unknown>>;

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    const migrations = await import("./dbMigrations");
    splitMigrationStatements = migrations.splitMigrationStatements;
    const baseline = await createConnection(process.env.DATABASE_URL);
    for (const file of (await migrations.collectMigrationFiles("drizzle")).filter(f => f.version <= 14)) {
      for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await baseline.query(statement);
    }
    await baseline.end();
    await migrations.applyPendingMigrations(process.env.DATABASE_URL);
    keys = await import("./apiKeys");
    rateLimit = await import("./rateLimit");
    appRouter = (await import("./routers")).appRouter;
    const { registerApiV1 } = await import("./apiV1");
    writer = drizzle(createPool(process.env.DATABASE_URL));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    const app = express();
    registerApiV1(app);
    await new Promise<void>(done => {
      server = app.listen(0, "127.0.0.1", () => done());
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  beforeEach(() => {
    rateLimit.resetRateLimits();
    keys.clearKeyCache();
  });

  afterAll(async () => {
    keys?.apiMeter.stop();
    await new Promise<void>(done => (server ? server.close(() => done()) : done()));
    await closePool?.();
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  });

  // ---------------------------------------------------------------- before the migration

  it("runs without the tables: a keyed request is told keys are not available, a sign-up says the same, an anonymous request is unaffected, and a boot made no table", async () => {
    const [found] = (await writer.execute(sql`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ${TEST_DB} AND table_name IN ('api_keys', 'api_usage')`)) as unknown as [Array<{ n: number }>];
    expect(Number(found[0]!.n)).toBe(0);

    const keyed = await get("/api/v1/usage", `nsk_${"a".repeat(40)}`);
    expect(keyed.status).toBe(503);
    expect(keyed.headers.get("retry-after")).toBe("60");
    const answer = (await keyed.json()) as { error: { code: string; message: string } };
    expect(answer.error).toEqual({ code: "unavailable", message: "API keys are not available right now." });
    expect((await get("/api/v1")).status).toBe(200);

    await expect(keys.createApiKey({ email: "dev@example.com", clientKey: "203.0.113.1" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(caller().apiKeys.create({ email: "dev@example.com" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "API keys are not available right now." });
  });

  // ---------------------------------------------------------------- the migration file

  it("applies as the owner would paste it, and again without harm, and makes two tables with no network address in either", async () => {
    for (let round = 0; round < 2; round += 1) {
      const paste = await createConnection(process.env.DATABASE_URL!);
      for (const statement of splitMigrationStatements(await readFile("drizzle/0043_api_keys.sql", "utf8"))) await paste.query(statement);
      await paste.end();
    }
    const [columns] = (await writer.execute(sql`SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = ${TEST_DB} AND table_name IN ('api_keys', 'api_usage') ORDER BY table_name, ordinal_position`)) as unknown as [Array<{ t: string; c: string }>];
    const byTable = (name: string) => columns.filter(column => column.t === name).map(column => column.c);
    expect(byTable("api_keys")).toEqual(["id", "keyHash", "keyPrefix", "ownerEmail", "tier", "createdAt", "revokedAt", "lastUsedAt"]);
    expect(byTable("api_usage")).toEqual(["keyId", "day", "endpoint", "count"]);
    expect(columns.map(column => column.c.toLowerCase()).filter(name => /ip|addr|agent|host|user/.test(name))).toEqual([]);
  });

  // ---------------------------------------------------------------- a key's life

  it("makes a key that is shown once, stores only its hash, and finds it again", async () => {
    const made = await keys.createApiKey({ email: "  Dev@Example.COM ", clientKey: "203.0.113.50" });
    expect(made.key).toMatch(keys.KEY_PATTERN);
    expect(made.tier).toBe("free");
    const stored = await rowsOf("api_keys");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: made.id, keyHash: keys.hashApiKey(made.key), keyPrefix: made.key.slice(0, 10), ownerEmail: "dev@example.com", tier: "free", revokedAt: null, lastUsedAt: null });
    const everything = JSON.stringify([...(await rowsOf("api_keys")), ...(await rowsOf("api_usage"))]);
    expect(everything).not.toContain(made.key);
    expect(everything).not.toContain(made.key.slice(4));
    expect(everything).not.toContain("203.0.113.50");

    expect(await keys.resolveApiKey(made.key)).toEqual({ id: made.id, tier: "free", prefix: made.key.slice(0, 10) });
    expect(await keys.resolveApiKey(`nsk_${"q".repeat(40)}`)).toBeNull();
    expect(await keys.resolveApiKey("not a key")).toBeNull();
    // What was just read is held, an unknown key too, for 30 seconds. A key nobody read, and text that is not a key, is not.
    expect(keys.keyIsCached(made.key)).toBe(true);
    expect(keys.keyIsCached(`nsk_${"q".repeat(40)}`)).toBe(true);
    expect(keys.keyIsCached(`nsk_${"r".repeat(40)}`)).toBe(false);
    expect(keys.keyIsCached("not a key")).toBe(false);
    expect(keys.keyIsCached(made.key, () => Date.now() + 31_000)).toBe(false);

    const usage = await get("/api/v1/usage", made.key);
    expect(usage.status).toBe(200);
    const answer = (await usage.json()) as Record<string, any>;
    expect(problems(schemaOf("UsageResponse"), answer)).toEqual([]);
    expect(answer.data.key).toEqual({ prefix: made.key.slice(0, 10), tier: "free" });
    expect(JSON.stringify(answer)).not.toContain(made.key);
  });

  it("ends a key at once for whoever holds it, keeps its row, and says so for a key it does not know", async () => {
    const made = await keys.createApiKey({ email: "revoke@example.com", clientKey: "203.0.113.51" });
    expect((await get("/api/v1/usage", made.key)).status).toBe(200);
    await expect(keys.revokeApiKey(made.key)).resolves.toEqual({ prefix: made.key.slice(0, 10) });
    const refused = await get("/api/v1/usage", made.key);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("invalid_key");
    const stored = (await rowsOf("api_keys")).find(row => row.id === made.id)!;
    expect(stored.revokedAt).not.toBeNull();
    await expect(keys.revokeApiKey(made.key)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(keys.revokeApiKey(`nsk_${"q".repeat(40)}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(keys.revokeApiKey("short")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("holds an email to three live keys whatever its case, and lets it make another once one is revoked", async () => {
    const made = [];
    for (const [index, email] of ["cap@example.com", "CAP@example.com", " Cap@Example.com"].entries()) made.push(await keys.createApiKey({ email, clientKey: `203.0.113.${60 + index}` }));
    await expect(keys.createApiKey({ email: "cap@EXAMPLE.com", clientKey: "203.0.113.70" })).rejects.toMatchObject({ code: "TOO_MANY_KEYS" });
    await keys.revokeApiKey(made[0]!.key);
    await expect(keys.createApiKey({ email: "cap@example.com", clientKey: "203.0.113.71" })).resolves.toMatchObject({ tier: "free" });
    // Someone else's email is not touched by this one's cap.
    await expect(keys.createApiKey({ email: "other@example.com", clientKey: "203.0.113.72" })).resolves.toMatchObject({ tier: "free" });
  });

  it("limits sign-ups from one address to three a day, does not count an email that is not one, and does not store the address", async () => {
    for (let index = 0; index < 5; index += 1) await expect(keys.createApiKey({ email: "not an email", clientKey: "203.0.113.80" })).rejects.toMatchObject({ code: "BAD_EMAIL" });
    for (let index = 0; index < 3; index += 1) await keys.createApiKey({ email: `signup${index}@example.com`, clientKey: "203.0.113.80" });
    await expect(keys.createApiKey({ email: "signup3@example.com", clientKey: "203.0.113.80" })).rejects.toMatchObject({ code: "TOO_MANY_SIGNUPS" });
    await expect(keys.createApiKey({ email: "signup3@example.com", clientKey: "203.0.113.81" })).resolves.toMatchObject({ tier: "free" });
    expect(JSON.stringify(await rowsOf("api_keys"))).not.toContain("203.0.113.80");
  });

  it("moves a key to a tier the moment the operator sets it, with that tier's limits, and refuses a tier or a key it does not know", async () => {
    const made = await keys.createApiKey({ email: "tier@example.com", clientKey: "203.0.113.90" });
    const before = await get("/api/v1/agents/robinhood/7", made.key);
    expect(before.headers.get("x-api-tier")).toBe("free");
    expect(before.headers.get("x-ratelimit-limit")).toBe("60");
    await expect(keys.setKeyTier(made.id, "pro")).resolves.toEqual({ id: made.id, tier: "pro" });
    const after = await get("/api/v1/agents/robinhood/7", made.key);
    expect(after.headers.get("x-api-tier")).toBe("pro");
    expect(after.headers.get("x-ratelimit-limit")).toBe(String(keys.API_TIERS.pro.perMinute));
    expect(after.headers.get("x-quota-limit")).toBe("500000");
    await expect(keys.setKeyTier(made.id, "enterprise")).rejects.toMatchObject({ code: "BAD_TIER" });
    await expect(keys.setKeyTier("00000000-0000-4000-8000-000000000000", "pro")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(keys.revokeKeyById("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await keys.revokeKeyById(made.id);
    expect((await get("/api/v1/usage", made.key)).status).toBe(401);
  });

  it("lets the operator list keys, newest first, by email or all, with the start of each key and never the key", async () => {
    const all = await keys.listKeysForOperator();
    expect(all.length).toBeGreaterThan(3);
    expect(all.length).toBeLessThanOrEqual(50);
    for (let index = 1; index < all.length; index += 1) expect(all[index - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(all[index]!.createdAt.getTime());
    const one = await keys.listKeysForOperator("  CAP@example.com ");
    expect(one.length).toBeGreaterThan(0);
    expect(one.every(row => row.ownerEmail === "cap@example.com")).toBe(true);
    expect(JSON.stringify(all)).not.toMatch(/keyHash|nsk_[A-Za-z0-9_-]{40}/);
    await expect(keys.listKeysForOperator("nope")).rejects.toMatchObject({ code: "BAD_EMAIL" });
  });

  // ---------------------------------------------------------------- the count

  it("counts what a key asks for, writes it to the table, shows it back, and refuses the request past the day's total without counting it", async () => {
    const made = await keys.createApiKey({ email: "count@example.com", clientKey: "203.0.113.100" });
    for (let index = 0; index < 3; index += 1) expect([200, 404]).toContain((await get("/api/v1/agents/robinhood/7", made.key)).status);
    const usage = await get("/api/v1/usage", made.key);
    const answer = (await usage.json()) as Record<string, any>;
    expect(problems(schemaOf("UsageResponse"), answer)).toEqual([]);
    expect(answer.data.today.used).toBe(4);
    expect(answer.data.days[0].by_endpoint).toEqual({ agent: 3, usage: 1 });
    const rows = (await rowsOf("api_usage")).filter(row => row.keyId === made.id);
    expect(rows.map(row => [row.endpoint, Number(row.count)]).sort()).toEqual([["agent", 3], ["usage", 1]]);
    const used = (await rowsOf("api_keys")).find(row => row.id === made.id)!;
    expect(used.lastUsedAt).not.toBeNull();

    // A key one request short of its day: the next is the last, and the one after is refused and not counted.
    const near = await keys.createApiKey({ email: "near@example.com", clientKey: "203.0.113.101" });
    const today = keys.utcDay(new Date());
    await writer.insert(schema.apiUsage).values({ keyId: near.id, day: today, endpoint: "agent", count: keys.API_TIERS.free.perDay - 1 });
    const last = await get("/api/v1/agents/robinhood/7", near.key);
    expect(last.headers.get("x-quota-remaining")).toBe("0");
    const refused = await get("/api/v1/agents/robinhood/7", near.key);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("quota_exceeded");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    await keys.apiMeter.flush();
    const [total] = (await writer.execute(sql`SELECT SUM(count) AS n FROM api_usage WHERE keyId = ${near.id}`)) as unknown as [Array<{ n: string }>];
    expect(Number(total[0]!.n)).toBe(keys.API_TIERS.free.perDay);
  });

  it("gives back a day's count from the table for a meter that starts fresh, as a restart does", async () => {
    const made = await keys.createApiKey({ email: "restart@example.com", clientKey: "203.0.113.110" });
    await get("/api/v1/agents/robinhood/7", made.key);
    await get("/api/v1/agents/robinhood/7", made.key);
    await keys.apiMeter.flush();
    const fresh = new keys.ApiMeter(keys.dbUsageStore);
    const result = await fresh.consume(made.id, 10, "agent");
    expect(result.used).toBe(3);
  });

  // ---------------------------------------------------------------- the router

  it("makes a free key through the sign-up and never lets the caller choose a tier, and ends a key through the router", async () => {
    const made = await caller("198.51.100.20").apiKeys.create({ email: "router@example.com" });
    expect(made).toMatchObject({ tier: "free" });
    expect(made.key).toMatch(keys.KEY_PATTERN);
    await expect(caller("198.51.100.21").apiKeys.create({ email: "router2@example.com", tier: "pro" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller("198.51.100.21").apiKeys.create({ email: "nope" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "That is not an email address." });
    await expect(caller().apiKeys.revoke({ key: "short" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().apiKeys.revoke({ key: made.key })).resolves.toEqual({ prefix: made.key.slice(0, 10) });
    await expect(caller().apiKeys.revoke({ key: made.key })).rejects.toMatchObject({ code: "NOT_FOUND", message: "That key is not in use." });
    const warned = await Promise.allSettled([1, 2, 3, 4].map(index => caller("198.51.100.30").apiKeys.create({ email: `burst${index}@example.com` })));
    expect(warned.filter(result => result.status === "fulfilled")).toHaveLength(3);
    expect(warned.filter(result => result.status === "rejected")).toHaveLength(1);
  });

  it("keeps the operator's calls to the operator: listing, setting a tier and ending a key by id refuse a caller with no operator token", async () => {
    const stranger = caller();
    await expect(stranger.apiKeys.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(stranger.apiKeys.setTier({ id: "x", tier: "pro" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(stranger.apiKeys.revokeById({ id: "x" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
