/**
 * Builds a throwaway database that looks like production in the ways a load test
 * cares about: the same schema (the boot-time migration runner builds it), a
 * directory of about 240k acknowledged entries spread across the same protocols,
 * a BNB Chain registry table with the registrations held out of the directory,
 * and the 82-record reviewed census behind the visibility gate.
 *
 *   pnpm exec tsx scripts/loadtest/seed.ts [database] [registry rows] [census-only]
 *
 * It refuses any server that is not on this machine, and it drops the named
 * database first (unless "census-only" adds just the census to one already
 * built), so it can never touch a real one.
 */
import { drizzle } from "drizzle-orm/mysql2";
import { createConnection, createPool } from "mysql2/promise";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as schema from "../../drizzle/schema";
import { applyPendingMigrations, collectMigrationFiles, splitMigrationStatements } from "../../server/dbMigrations";

const BASE_URL = process.env.LOADTEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";
const DATABASE = process.argv[2] ?? "nooscape_load";
const REGISTRY_ROWS = Number(process.argv[3] ?? 373_567);
const CENSUS_ONLY = process.argv[4] === "census-only";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

if (!/@(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(BASE_URL)) throw new Error("The load-test seed only runs against a database on this machine.");
if (!/^[a-z0-9_]+$/.test(DATABASE)) throw new Error("Use a plain database name.");

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const wordList = WORDS.map(word => `'${word}'`).join(", ");

/** Rows per protocol, as the live directory held them on 2026-10-14. */
const DIRECTORY = [
  { sourceId: "src-catalog", protocol: "catalog", rows: 214_975, chain: false },
  { sourceId: "src-said", protocol: "solana_said", rows: 13_361, chain: true },
  { sourceId: "src-robinhood", protocol: "erc8004", rows: 8_788, chain: true },
  { sourceId: "src-metaplex", protocol: "solana_registry", rows: 1_549, chain: true },
  { sourceId: "src-8004", protocol: "solana_8004", rows: 1_505, chain: true },
] as const;

const url = `${BASE_URL}/${DATABASE}`;

/** The schema, the operator, the sources, the directory, and the BNB Chain registry rows. */
async function buildBulk() {
  const admin = await createConnection(`${BASE_URL}/mysql`);
  await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
  await admin.query(`CREATE DATABASE \`${DATABASE}\``);
  await admin.end();

  const conn = await createConnection(url);
  // Versions 0000-0014 predate the boot runner on the live database; replay them as the gate tests do.
  const files = await collectMigrationFiles("drizzle");
  for (const file of files.filter(f => f.version <= 14)) {
    for (const statement of splitMigrationStatements(await readFile(file.file, "utf8"))) await conn.query(statement);
  }
  const applied = await applyPendingMigrations(url, "drizzle");
  console.log(`schema built: ${applied.length} migrations applied by the runner`);

  const pool = createPool(url);
  const db = drizzle(pool);
  await db.insert(schema.users).values({ openId: "nooscape-production-operator", name: "operator", role: "admin" });
  const [operator] = await db.select({ id: schema.users.id }).from(schema.users);

  const sources = [
    ...DIRECTORY.map(entry => ({ id: entry.sourceId, protocol: entry.protocol })),
    { id: "src-bsc", protocol: "erc8004_bsc" as const },
    { id: "src-census", protocol: "catalog" as const },
  ];
  for (const source of sources) {
    await db.insert(schema.ingestionSources).values({
      id: source.id,
      sourceKey: `load-${source.id}`,
      label: `Load test ${source.id}`,
      protocol: source.protocol,
      rootUrl: `https://${source.id}.example`,
      allowedHostname: `${source.id}.example`,
      state: "active",
      createdByUserId: operator.id,
    });
  }
  await pool.end();

  await conn.query("SET SESSION cte_max_recursion_depth = 2000000");
  for (const entry of DIRECTORY) {
    const started = Date.now();
    await conn.query(
      `INSERT INTO agent_directory_entries (id, sourceId, externalKey, displayName, locatorHost, protocol, registrant, mintBlock, hidden)
       WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${entry.rows})
       SELECT UUID(), '${entry.sourceId}', CONCAT('${entry.protocol}-', n),
              CONCAT('Agent ', n, ' ', ELT(1 + n % 8, ${wordList})),
              CONCAT('h', n % 5000, '.example.net'), '${entry.protocol}',
              ${entry.chain ? "CONCAT('0x', LPAD(HEX(n % 3000), 40, '0'))" : "NULL"},
              ${entry.chain ? "1000000 + n * 10" : "NULL"}, 0
       FROM seq`
    );
    console.log(`directory ${entry.protocol}: ${entry.rows} rows in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }

  // The BNB Chain registry: every registration, held out of the directory. A small share is listed and published.
  const started = Date.now();
  await conn.query(
    `INSERT INTO agent_directory_registry_rows (id, sourceId, externalKey, displayName, locatorHost, protocol, registrant, mintBlock, profileUriHash, uriUpdateCount, secondaryTransferCount, hidden, listing)
     WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${REGISTRY_ROWS})
     SELECT UUID(), 'src-bsc', CONCAT('eip155:56:0xREG:', n), CONCAT('Agent #', n),
            CONCAT('b', n % 900, '.example.org'), 'erc8004_bsc',
            CONCAT('0x', LPAD(HEX(n % 40000), 40, '0')), 40000000 + n * 100,
            SHA2(CONCAT('uri-', n % 120000), 256), n % 3, n % 5, 0,
            IF(n % 56 = 0, 1, IF(n % 7 = 0, 2, 3))
     FROM seq`
  );
  console.log(`bnb registry rows: ${REGISTRY_ROWS} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await conn.query(
    `INSERT INTO agent_directory_entries (id, sourceId, externalKey, displayName, locatorHost, protocol, registrant, mintBlock, hidden)
     SELECT UUID(), sourceId, externalKey, displayName, locatorHost, protocol, registrant, mintBlock, 0
     FROM agent_directory_registry_rows WHERE sourceId = 'src-bsc' AND listing = 1`
  );
  await conn.query("ANALYZE TABLE agent_directory_entries, agent_directory_registry_rows");
  await conn.end();
}

/** The reviewed census: 82 records behind the visibility gate, one approved run. */
async function seedCensus() {
  const pool = createPool(url);
  const db = drizzle(pool);
  const [operator] = await db.select({ id: schema.users.id }).from(schema.users);
  const now = new Date();
  await db.insert(schema.ingestionRuns).values({ id: "run-census", sourceId: "src-census", trigger: "manual", status: "completed", startedAt: now, finishedAt: now });
  for (let i = 1; i <= 82; i += 1) {
    const agentId = `agent-census-${i}`;
    const observationId = `obs-census-${i}`;
    await db.insert(schema.agents).values({ id: agentId, displayName: `Reviewed agent ${i}`, handle: `reviewed-${i}` });
    await db.insert(schema.sourceObservations).values({
      id: observationId,
      sourceId: "src-census",
      protocol: "catalog",
      canonicalLocator: `https://census.example/record-${i}`,
      locatorHash: sha(`locator-${i}`),
      contentHash: sha(`content-${i}`),
      rawObjectKey: `load/${observationId}`,
      contentType: "application/json",
      parserVersion: "load",
      validationStatus: "valid",
      validationFindings: "[]",
      observedAt: now,
    });
    await db.insert(schema.sourceObservationRuns).values({ runId: "run-census", observationId });
    await db.insert(schema.agentPublicSnapshots).values({
      id: `snap-census-${i}`,
      agentId,
      sourceId: "src-census",
      sourceObservationId: observationId,
      displayName: `Reviewed agent ${i}`,
      displayHandle: `reviewed-${i}`,
      primaryCapability: "Research",
      untrustedSelfDescription: `A reviewed record used by the load test. ${"Lorem ipsum dolor sit amet. ".repeat(6)}`,
      protocols: '["a2a"]',
    });
  }
  await db.insert(schema.sourceProjectionDecisions).values({ sourceId: "src-census", state: "public", rationale: "load test", decidedByUserId: operator.id, approvedRunId: "run-census" });
  await pool.end();
}

async function main() {
  if (!CENSUS_ONLY) await buildBulk();
  await seedCensus();
  const conn = await createConnection(url);
  const [counts] = (await conn.query(
    "SELECT (SELECT COUNT(*) FROM agent_directory_entries) AS directory, (SELECT COUNT(*) FROM agent_directory_registry_rows) AS registry, (SELECT COUNT(*) FROM agent_public_snapshots) AS census"
  )) as unknown as [Array<{ directory: number; registry: number; census: number }>];
  console.log("seeded:", JSON.stringify(counts[0]));
  await conn.end();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
