import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { oldestKeptDay, utcDay } from "./exportRetention";

/**
 * The daily export job as the server runs it (dist/exportAgentsDaily.js, here from its source): it writes today's export to the folder,
 * removes the days older than 30 and a stale part file, and prints one line. With no rows it publishes nothing and exits 1, so the newest
 * good day stays the latest. It runs against a throwaway schema, and skips when no database is reachable.
 */
const TEST_DB = "nooscape_export_daily_test";
const BASE_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";
const app = fileURLToPath(new URL("..", import.meta.url));

const dbReachable = await (async () => {
  try {
    const probe = await createConnection(`${BASE_URL}/mysql`);
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

const daysBefore = (day: string, n: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - n);
  return utcDay(date);
};

describe.skipIf(!dbReachable)("the daily export job", () => {
  let dir: string;
  const databaseUrl = `${BASE_URL}/${TEST_DB}`;

  const runJob = async (features: string, extraEnv: Record<string, string> = {}) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "server/exportAgentsDaily.ts"], {
        cwd: app,
        env: { ...process.env, DATABASE_URL: databaseUrl, NOOSCAPE_EXPORT_DIR: dir, VITE_FEATURES: features, ...extraEnv },
        timeout: 120_000,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  };

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    const { applyPendingMigrations } = await import("./dbMigrations");
    await applyPendingMigrations(databaseUrl, undefined, undefined, { bootstrapEmpty: true });

    const pool = createPool(databaseUrl);
    const writer = drizzle(pool);
    await writer.insert(schema.users).values({ openId: "export-daily-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "export-daily-operator"));
    await writer.insert(schema.ingestionSources).values({
      id: "src-celo",
      sourceKey: "export-daily-celo",
      label: "Export daily Celo",
      protocol: "erc8004_celo",
      rootUrl: "https://export.example/celo",
      allowedHostname: "export.example",
      state: "active",
      lastSuccessfulAt: new Date("2026-11-21T22:00:00Z"),
      createdByUserId: operator.id,
    });
    const key = (n: number) => `eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:${n}`;
    await writer.insert(schema.agentDirectoryEntries).values(
      [1, 2].map(n => ({ id: `c${n}000000-0000-0000-0000-000000000000`, sourceId: "src-celo", externalKey: key(n), displayName: `Agent ${n}`, protocol: "erc8004_celo" as const }))
    );
    await pool.end();
    dir = await mkdtemp(join(tmpdir(), "nooscape-export-daily-"));
  }, 180_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 30_000);

  it("writes today's export, removes the days older than 30 and a stale part file, and prints one line", async () => {
    const today = utcDay(new Date());
    const kept = oldestKeptDay(today);
    const expired = daysBefore(kept, 1);
    const files = [
      `agents-${expired}.jsonl.gz`,
      `agents-${expired}.manifest.json`,
      `agents-${kept}.jsonl.gz`,
      `agents-${kept}.manifest.json`,
      `agents-${daysBefore(today, 3)}.jsonl.gz.part`,
      "notes.txt",
    ];
    for (const name of files) await writeFile(join(dir, name), "{}");

    const result = await runJob("chain_celo");
    expect(result.code, result.stderr).toBe(0);
    const line = JSON.parse(result.stdout.trim());
    expect(line).toMatchObject({ event: "nooscape_agents_export", date: today, rows: 2, rows_by_chain: { celo: 2 } });
    expect(line.removed).toEqual([`agents-${expired}.manifest.json`, `agents-${expired}.jsonl.gz`, `agents-${daysBefore(today, 3)}.jsonl.gz.part`]);
    expect((await readdir(dir)).sort()).toEqual(
      [`agents-${kept}.jsonl.gz`, `agents-${kept}.manifest.json`, `agents-${today}.jsonl.gz`, `agents-${today}.manifest.json`, "notes.txt"].sort()
    );
  }, 150_000);

  it("publishes nothing when it reads no rows, keeps the days it had, and exits 1", async () => {
    const before = (await readdir(dir)).sort();
    await rm(join(dir, `agents-${utcDay(new Date())}.manifest.json`));
    await rm(join(dir, `agents-${utcDay(new Date())}.jsonl.gz`));
    // Celo switched off: the directory read finds nothing to export.
    const result = await runJob("chain_monad");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nooscape_agents_export_failed");
    expect(result.stderr).toContain("read no rows");
    expect((await readdir(dir)).sort()).toEqual(before.filter(name => !name.startsWith(`agents-${utcDay(new Date())}`)));
  }, 150_000);

  it("leaves neither the day's file nor a part file when it cannot sign the manifest", async () => {
    const before = (await readdir(dir)).sort();
    const result = await runJob("chain_celo", { NODE_ENV: "production", NOOSCAPE_EVIDENCE_SIGNING_PRIVATE_KEY: "" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NOOSCAPE_EVIDENCE_SIGNING_PRIVATE_KEY is required in production.");
    expect((await readdir(dir)).sort()).toEqual(before);
    expect(before.some(name => name.startsWith(`agents-${utcDay(new Date())}`))).toBe(false);
  }, 150_000);

  it("refuses to run with no folder set", async () => {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "server/exportAgentsDaily.ts"], {
      cwd: app,
      env: { ...process.env, DATABASE_URL: databaseUrl, NOOSCAPE_EXPORT_DIR: "" },
      timeout: 120_000,
    }).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code?: number; stderr?: string }) => ({ code: error.code ?? -1, stderr: error.stderr ?? "" })
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NOOSCAPE_EXPORT_DIR is not set.");
  }, 150_000);
});
