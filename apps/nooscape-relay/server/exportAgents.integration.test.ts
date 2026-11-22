import { createPublicKey, createHash, verify } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createConnection, createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../drizzle/schema";
import { problems, schemaOf } from "./apiV1Testing";

/**
 * The daily export written from a real database: which rows go in (only what every directory read may show, on a chain the API serves
 * under the switches), in what order, read a batch at a time, and that the manifest names exactly the file written and is signed with
 * the site's key over the exact text it carries. It runs against a throwaway schema built by the project's own migration runner, and
 * skips when no database is reachable.
 */
const TEST_DB = "nooscape_export_agents_test";
const BASE_URL = process.env.GATE_TEST_DATABASE_URL ?? "mysql://root:nooscape@127.0.0.1:3307";
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const dbReachable = await (async () => {
  try {
    const probe = await createConnection(`${BASE_URL}/mysql`);
    await probe.end();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbReachable)("the agents export, against a real database", () => {
  type Writer = typeof import("./exportAgents");
  let exporter: Writer;
  let writer: MySql2Database;
  let closePool: () => Promise<void>;
  let operatorUserId: number;
  let dir: string;
  const previousFeatures = process.env.VITE_FEATURES;

  async function source(key: string, protocol: schema.IngestionSource["protocol"], state: "active" | "paused", lastSuccessfulAt: Date | null) {
    await writer.insert(schema.ingestionSources).values({
      id: `src-${key}`,
      sourceKey: `export-${key}`,
      label: `Export ${key}`,
      protocol,
      rootUrl: `https://export.example/${key}`,
      allowedHostname: "export.example",
      state,
      lastSuccessfulAt,
      createdByUserId: operatorUserId,
    });
    return `src-${key}`;
  }

  const entry = (
    sourceId: string,
    id: string,
    protocol: (typeof schema.agentDirectoryEntries.$inferInsert)["protocol"],
    externalKey: string,
    values: { hidden?: boolean; closedAt?: Date; host?: string | null; link?: string | null; registrant?: string | null } = {}
  ) => ({
    id,
    sourceId,
    externalKey,
    displayName: `Agent ${id.slice(0, 4)}`,
    protocol,
    registrant: values.registrant === undefined ? "0xabcdef0123456789abcdef0123456789abcdef01" : values.registrant,
    locatorHost: values.host === undefined ? "agent.example" : values.host,
    profileUriHash: values.link ?? null,
    assetClosedAt: values.closedAt ?? null,
    hidden: values.hidden ?? false,
    feedbackCount: 2,
    firstSeenAt: new Date("2026-11-20T00:00:00Z"),
    lastSeenAt: new Date("2026-11-21T00:00:00Z"),
  });

  beforeAll(async () => {
    const admin = await createConnection(`${BASE_URL}/mysql`);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.query(`CREATE DATABASE \`${TEST_DB}\``);
    await admin.end();
    process.env.DATABASE_URL = `${BASE_URL}/${TEST_DB}`;
    // Celo and Monad switched on, Ethereum off: the switch list the visibility rule and the export both read.
    process.env.VITE_FEATURES = "chain_celo,chain_monad";
    // An empty database is built from every migration file, the manual ones included (0038 makes the BNB evidence table).
    const { applyPendingMigrations } = await import("./dbMigrations");
    await applyPendingMigrations(process.env.DATABASE_URL, undefined, undefined, { bootstrapEmpty: true });

    exporter = await import("./exportAgents");
    writer = drizzle(createPool(process.env.DATABASE_URL!));
    closePool = async () => {
      const client = (writer as unknown as { $client: { end(): Promise<void> } }).$client;
      await client.end();
    };
    await writer.insert(schema.users).values({ openId: "export-operator", role: "admin" });
    const [operator] = await writer.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.openId, "export-operator"));
    operatorUserId = operator.id;

    // Celo: four listed (one pinned) and three no directory read shows: hidden, closed, on the retired host.
    const celo = await source("celo", "erc8004_celo", "active", new Date("2026-11-21T22:00:00Z"));
    const celoKey = (n: number) => `eip155:42220:${REGISTRY}:${n}`;
    await writer.insert(schema.agentDirectoryEntries).values([
      entry(celo, "c1000000-0000-0000-0000-000000000000", "erc8004_celo", celoKey(1)),
      entry(celo, "c2000000-0000-0000-0000-000000000000", "erc8004_celo", celoKey(2)),
      entry(celo, "c3000000-0000-0000-0000-000000000000", "erc8004_celo", celoKey(3), { registrant: null, host: null }),
      entry(celo, "c4000000-0000-0000-0000-000000000000", "erc8004_celo", celoKey(4)),
      entry(celo, "c5000000-0000-0000-0000-000000000000", "erc8004_celo", celoKey(5), { hidden: true }),
      entry(celo, "c6000000-0000-0000-0000-000000000000", "erc8004_celo", celoKey(6), { closedAt: new Date("2026-11-01T00:00:00Z") }),
      entry(celo, "c7000000-0000-0000-0000-000000000000", "erc8004_celo", celoKey(7), { host: "api.agentrank.info" }),
    ]);
    await writer.insert(schema.agentDirectoryListingPins).values({ sourceId: celo, externalKey: celoKey(2), note: "pinned for the test" });

    // BNB Smart Chain: one read from the link it carries, one whose read was of an older link.
    const bnb = await source("bnb", "erc8004_bsc", "active", new Date("2026-11-21T21:00:00Z"));
    const bnbKey = (n: number) => `eip155:56:${REGISTRY}:${n}`;
    await writer.insert(schema.agentDirectoryEntries).values([
      entry(bnb, "b1000000-0000-0000-0000-000000000000", "erc8004_bsc", bnbKey(10), { link: "a".repeat(64) }),
      entry(bnb, "b2000000-0000-0000-0000-000000000000", "erc8004_bsc", bnbKey(11), { link: "b".repeat(64) }),
    ]);
    const evidence = (id: string, key: string, link: string) => ({ id, sourceId: bnb, externalKey: key, profileUriHash: link, readStatus: "inline", g1: "independent", templateSize: 1, walletRegistrations: 1, readAt: new Date("2026-11-15T00:00:00Z") });
    await writer.insert(schema.bscEntryEvidence).values([evidence("ev-1", bnbKey(10), "a".repeat(64)), evidence("ev-2", bnbKey(11), "c".repeat(64))]);

    // Ethereum is switched off in this export's switch list, and Monad's source is paused: neither is in it. A catalog entry is on no chain.
    const ethereum = await source("ethereum", "erc8004_eth", "active", new Date("2026-11-21T20:00:00Z"));
    await writer.insert(schema.agentDirectoryEntries).values(entry(ethereum, "e1000000-0000-0000-0000-000000000000", "erc8004_eth", `eip155:1:${REGISTRY}:5`));
    const monad = await source("monad", "erc8004_monad", "paused", new Date("2026-11-21T20:00:00Z"));
    await writer.insert(schema.agentDirectoryEntries).values(entry(monad, "d1000000-0000-0000-0000-000000000000", "erc8004_monad", `eip155:143:${REGISTRY}:5`));
    const catalog = await source("catalog", "catalog", "active", new Date("2026-11-21T20:00:00Z"));
    await writer.insert(schema.agentDirectoryEntries).values(entry(catalog, "a1000000-0000-0000-0000-000000000000", "catalog", "cat-1"));

    dir = await mkdtemp(join(tmpdir(), "nooscape-export-"));
  }, 180_000);

  afterAll(async () => {
    if (closePool) await closePool();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (previousFeatures === undefined) delete process.env.VITE_FEATURES;
    else process.env.VITE_FEATURES = previousFeatures;
  }, 30_000);

  const readLines = async (name: string) =>
    gunzipSync(await readFile(join(dir, name)))
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);

  it("writes only what every directory read may show, on a served chain, in order of id, read a batch at a time", async () => {
    // A batch of two makes the read go round several times.
    const manifest = await exporter.writeAgentsExport({ dir, date: "2026-11-22", now: () => new Date("2026-11-22T02:00:00Z"), batchSize: 2 });
    const lines = await readLines("agents-2026-11-22.jsonl.gz");

    expect(lines.map(line => line.nooscape_id)).toEqual([
      "b1000000-0000-0000-0000-000000000000",
      "b2000000-0000-0000-0000-000000000000",
      "c1000000-0000-0000-0000-000000000000",
      "c2000000-0000-0000-0000-000000000000",
      "c3000000-0000-0000-0000-000000000000",
      "c4000000-0000-0000-0000-000000000000",
    ]);
    expect(lines.map(line => [line.chain, line.agent_id])).toEqual([["bnb", "10"], ["bnb", "11"], ["celo", "1"], ["celo", "2"], ["celo", "3"], ["celo", "4"]]);
    expect(lines.find(line => line.agent_id === "2" && line.chain === "celo")!.listed_because).toBe("operator_pin");
    expect(lines.find(line => line.agent_id === "10")!.evidence_level).toBe("checked_unproven");
    expect(lines.find(line => line.agent_id === "11")!.evidence_level).toBe("not_checked");
    expect(lines.find(line => line.agent_id === "3" && line.chain === "celo")).toMatchObject({ registrant: null, locator_host: null, evidence_level: null });
    for (const line of lines) expect(Object.keys(line)).toEqual([...exporter.AGENTS_EXPORT_FIELDS]);

    expect(manifest.payload.rows).toBe(6);
    expect(manifest.payload.rows_by_chain).toEqual({ robinhood: 0, bnb: 2, solana: 0, monad: 0, celo: 4 });
    expect(manifest.payload.chains_last_pass).toMatchObject({ bnb: "2026-11-21T21:00:00.000Z", celo: "2026-11-21T22:00:00.000Z", monad: null, robinhood: null });
    expect(manifest.payload.generated_at).toBe("2026-11-22T02:00:00.000Z");
  });

  it("names in its manifest exactly the file it wrote, and leaves no part file behind", async () => {
    const manifest = JSON.parse(await readFile(join(dir, "agents-2026-11-22.manifest.json"), "utf8"));
    const bytes = await readFile(join(dir, "agents-2026-11-22.jsonl.gz"));
    expect(manifest.payload.file).toEqual({ name: "agents-2026-11-22.jsonl.gz", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    expect((await readdir(dir)).sort()).toEqual(["agents-2026-11-22.jsonl.gz", "agents-2026-11-22.manifest.json"]);
  });

  it("is signed with Ed25519 over the exact text it carries, and that text is its payload", async () => {
    const manifest = JSON.parse(await readFile(join(dir, "agents-2026-11-22.manifest.json"), "utf8"));
    const key = createPublicKey(manifest.signature.public_key_pem);
    expect(verify(null, Buffer.from(manifest.signed_payload), key, Buffer.from(manifest.signature.value, "base64"))).toBe(true);
    expect(createHash("sha256").update(manifest.signed_payload).digest("hex")).toBe(manifest.signature.payload_sha256);
    expect(JSON.parse(manifest.signed_payload)).toEqual(manifest.payload);
    expect(manifest.signature.key_list).toBe("https://nooscape.si/.well-known/nooscape-keys.json");
    // A changed payload no longer verifies.
    const altered = manifest.signed_payload.replace('"rows":6', '"rows":7');
    expect(altered).not.toBe(manifest.signed_payload);
    expect(verify(null, Buffer.from(altered), key, Buffer.from(manifest.signature.value, "base64"))).toBe(false);
    expect(manifest.payload.license.name).toBe("CC BY 4.0");
    // What the API serves for download is what its document describes.
    expect(problems(schemaOf("ExportManifest"), manifest)).toEqual([]);
  });

  it("refuses a date that is not a day", async () => {
    await expect(exporter.writeAgentsExport({ dir, date: "22-11-2026" })).rejects.toThrow("YYYY-MM-DD");
  });
});
