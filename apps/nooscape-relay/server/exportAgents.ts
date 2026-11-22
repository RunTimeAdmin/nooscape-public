import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { and, asc, eq, gt, inArray, max } from "drizzle-orm";
import { agentDirectoryEntries, agentDirectoryListingPins, bscEntryEvidence, ingestionSources } from "../drizzle/schema";
import { API_CHAINS, agentIdOfKey, apiChainOfProtocol, servedChains, type ApiChain } from "./apiChains";
import { API_LICENSE } from "./apiLicense";
import { ACKNOWLEDGED_STATEMENT, PAGE_ORIGIN } from "./apiV1";
import { registrationReadOf } from "./bscRegistrationRead";
import { directoryVisibilityCondition, getDb, requireDb, sanitizeDirectoryEntry } from "./db";
import { sealEvidencePayload } from "./evidence";
import { AGENTS_DATASET, agentsExportFiles } from "./exportRetention";

/**
 * The daily export of the directory (stage D6 of docs/data-access-2026-10-19.md; the operator's choices of 2026-11-22: free, these
 * fields, kept 30 days). One gzip file of JSON lines, one line for each agent the directory lists on a chain the API serves, and beside
 * it a manifest signed with the key the site publishes at /.well-known/nooscape-keys.json. This module writes the two files; serving
 * them, the daily run and the 30-day cleanup are later stages.
 *
 * A line holds the facts the agent's own API answer gives about it, worked out by the same rules: the chain and the agent's id on it, the
 * name as the site shows it, the registering wallet and the endpoint host, the dates, why it is listed and, on BNB Smart Chain, whether
 * its registration was read. Only what every directory read may show is read (directoryVisibilityCondition: an active source, not
 * hidden, not closed, not on a suppressed host, its chain switched on), so a registration the listing rules hold out is never in it.
 * No timeline is: no activity events and no ratings, only the count of ratings.
 */

export const EXPORT_FORMAT = "nooscape-export-v1";
export { AGENTS_DATASET, agentsExportFiles };

/** The fields of a line, in the order they are written. */
export const AGENTS_EXPORT_FIELDS = [
  "chain",
  "agent_id",
  "registry",
  "nooscape_id",
  "page_url",
  "name",
  "registrant",
  "locator_host",
  "first_seen_at",
  "last_seen_at",
  "listed_because",
  "evidence_level",
  "feedback_count",
] as const;

export type AgentsExportRow = {
  chain: ApiChain;
  agent_id: string;
  registry: string;
  nooscape_id: string;
  page_url: string;
  name: string;
  registrant: string | null;
  locator_host: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  listed_because: "rules" | "operator_pin";
  evidence_level: "checked_unproven" | "not_checked" | null;
  feedback_count: number | null;
};

/** A directory row as the export reads it: the entry, whether an operator pinned it, and its BNB evidence row if it has one. */
export type ExportSourceRow = {
  id: string;
  externalKey: string;
  protocol: string;
  displayName: string;
  registrant: string | null;
  locatorHost: string | null;
  profileUriHash: string | null;
  feedbackCount: number | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  pinnedAt: Date | null;
  evidence: { readStatus: string; readAt: Date; profileUriHash: string } | null;
};

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** One line of the export, or null for a row on a chain the API does not serve under these switches. Pure. */
export function exportRowOf(row: ExportSourceRow, served: readonly ApiChain[]): AgentsExportRow | null {
  const chain = apiChainOfProtocol(row.protocol, served);
  if (!chain) return null;
  // Read as the agent's API answer reads it: only BNB Smart Chain has a registration read, and an entry without one there is not checked.
  const evidenceLevel = row.protocol === "erc8004_bsc" ? (registrationReadOf(row.evidence, row.profileUriHash).checked ? "checked_unproven" : "not_checked") : null;
  return {
    chain,
    agent_id: agentIdOfKey(chain, row.externalKey),
    registry: row.protocol,
    nooscape_id: row.id,
    page_url: `${PAGE_ORIGIN}/agents/${row.id}`,
    name: sanitizeDirectoryEntry({ displayName: row.displayName, externalKey: row.externalKey }).displayName,
    registrant: row.registrant,
    locator_host: row.locatorHost,
    first_seen_at: iso(row.firstSeenAt),
    last_seen_at: iso(row.lastSeenAt),
    listed_because: row.pinnedAt ? "operator_pin" : "rules",
    evidence_level: evidenceLevel,
    feedback_count: row.feedbackCount,
  };
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** The rows, in order of their Nooscape id, a batch at a time, so the whole directory is never held at once. */
async function* readExportRows(db: Db, served: readonly ApiChain[], batchSize: number): AsyncGenerator<ExportSourceRow> {
  const entries = agentDirectoryEntries;
  const protocols = served.flatMap(chain => [...API_CHAINS[chain].protocols]);
  let after = "";
  for (;;) {
    const batch = await db
      .select({
        id: entries.id,
        externalKey: entries.externalKey,
        protocol: entries.protocol,
        displayName: entries.displayName,
        registrant: entries.registrant,
        locatorHost: entries.locatorHost,
        profileUriHash: entries.profileUriHash,
        feedbackCount: entries.feedbackCount,
        firstSeenAt: entries.firstSeenAt,
        lastSeenAt: entries.lastSeenAt,
        pinnedAt: agentDirectoryListingPins.pinnedAt,
        readStatus: bscEntryEvidence.readStatus,
        readAt: bscEntryEvidence.readAt,
        evidenceUriHash: bscEntryEvidence.profileUriHash,
      })
      .from(entries)
      .innerJoin(ingestionSources, eq(entries.sourceId, ingestionSources.id))
      .leftJoin(agentDirectoryListingPins, and(eq(agentDirectoryListingPins.sourceId, entries.sourceId), eq(agentDirectoryListingPins.externalKey, entries.externalKey)))
      .leftJoin(bscEntryEvidence, and(eq(bscEntryEvidence.sourceId, entries.sourceId), eq(bscEntryEvidence.externalKey, entries.externalKey)))
      .where(and(directoryVisibilityCondition(), inArray(entries.protocol, protocols as (typeof entries.protocol._.data)[]), gt(entries.id, after)))
      .orderBy(asc(entries.id))
      .limit(batchSize);
    for (const row of batch) {
      yield {
        id: row.id,
        externalKey: row.externalKey,
        protocol: row.protocol,
        displayName: row.displayName,
        registrant: row.registrant,
        locatorHost: row.locatorHost,
        profileUriHash: row.profileUriHash,
        feedbackCount: row.feedbackCount,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        pinnedAt: row.pinnedAt,
        evidence: row.readStatus !== null && row.readAt !== null && row.evidenceUriHash !== null ? { readStatus: row.readStatus, readAt: row.readAt, profileUriHash: row.evidenceUriHash } : null,
      };
    }
    if (batch.length < batchSize) return;
    after = batch[batch.length - 1]!.id;
  }
}

/** When each served chain's sources last finished a pass: the newest of its active sources, or null when none has. */
async function chainsLastPass(db: Db, served: readonly ApiChain[]): Promise<Record<string, string | null>> {
  const rows = await db
    .select({ protocol: ingestionSources.protocol, last: max(ingestionSources.lastSuccessfulAt) })
    .from(ingestionSources)
    .where(eq(ingestionSources.state, "active"))
    .groupBy(ingestionSources.protocol);
  const out: Record<string, string | null> = {};
  for (const chain of served) {
    const times = rows.filter(row => API_CHAINS[chain].protocols.includes(row.protocol) && row.last).map(row => new Date(row.last as unknown as string).getTime());
    out[chain] = times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
  }
  return out;
}

/** What the manifest says, and what is signed: the signature covers `signed_payload`, the exact text of `payload`. */
export type AgentsExportManifest = {
  format: typeof EXPORT_FORMAT;
  payload: {
    format: typeof EXPORT_FORMAT;
    dataset: typeof AGENTS_DATASET;
    date: string;
    generated_at: string;
    file: { name: string; bytes: number; sha256: string };
    rows: number;
    rows_by_chain: Record<string, number>;
    chains_last_pass: Record<string, string | null>;
    fields: readonly string[];
    statement: string;
    license: typeof API_LICENSE;
  };
  signed_payload: string;
  signature: { algorithm: "Ed25519"; value: string; payload_sha256: string; key_id: string; public_key_pem: string; key_list: string };
};

/**
 * Writes a day's export to `dir`: the data file, then its manifest. The data goes to a temporary name and is renamed when complete, and
 * the manifest is written last, so a reader that finds the manifest finds the whole file it describes. `date` is the UTC day it is for.
 */
export async function writeAgentsExport(options: { dir: string; date: string; now?: () => Date; batchSize?: number }): Promise<AgentsExportManifest> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error("The export date must be YYYY-MM-DD.");
  const now = options.now ?? (() => new Date());
  const db = requireDb(await getDb());
  // The same switch list the visibility rule reads (chainSwitchCondition), so the two cannot disagree.
  const served = servedChains(process.env.VITE_FEATURES);
  const names = agentsExportFiles(options.date);
  await mkdir(options.dir, { recursive: true });
  const dataPath = join(options.dir, names.data);
  const partPath = `${dataPath}.part`;

  const rowsByChain: Record<string, number> = Object.fromEntries(served.map(chain => [chain, 0]));
  let rows = 0;
  const hash = createHash("sha256");
  let bytes = 0;
  const lines = new PassThrough();
  const gzip = createGzip();
  // The compressed bytes are hashed and counted on their way to the file, so the manifest names exactly the file written.
  gzip.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  const written = pipeline(lines, gzip, createWriteStream(partPath));
  try {
    for await (const source of readExportRows(db, served, options.batchSize ?? 5_000)) {
      const line = exportRowOf(source, served);
      if (!line) continue;
      rows += 1;
      rowsByChain[line.chain] = (rowsByChain[line.chain] ?? 0) + 1;
      if (!lines.write(`${JSON.stringify(line)}\n`)) await new Promise(resolve => lines.once("drain", resolve));
    }
    lines.end();
    await written;
  } catch (error) {
    lines.destroy();
    await written.catch(() => undefined);
    await rm(partPath, { force: true });
    throw error;
  }

  const payload: AgentsExportManifest["payload"] = {
    format: EXPORT_FORMAT,
    dataset: AGENTS_DATASET,
    date: options.date,
    generated_at: now().toISOString(),
    file: { name: names.data, bytes, sha256: hash.digest("hex") },
    rows,
    rows_by_chain: rowsByChain,
    chains_last_pass: {},
    fields: AGENTS_EXPORT_FIELDS,
    statement: ACKNOWLEDGED_STATEMENT,
    license: API_LICENSE,
  };
  // The file takes its name only once the manifest is signed: a run that fails here leaves a part file, which the daily cleanup removes,
  // and never a whole file with no manifest.
  let sealed: ReturnType<typeof sealEvidencePayload>;
  try {
    payload.chains_last_pass = await chainsLastPass(db, served);
    sealed = sealEvidencePayload(payload as unknown as Record<string, unknown>);
  } catch (error) {
    await rm(partPath, { force: true });
    throw error;
  }
  const manifest: AgentsExportManifest = {
    format: EXPORT_FORMAT,
    payload,
    signed_payload: sealed.canonicalPayload,
    signature: {
      algorithm: "Ed25519",
      value: sealed.signature,
      payload_sha256: sealed.integrityHash,
      key_id: sealed.relayKeyId,
      public_key_pem: sealed.relayPublicKeyPem,
      key_list: `${PAGE_ORIGIN}/.well-known/nooscape-keys.json`,
    },
  };
  await rename(partPath, dataPath);
  await writeFile(join(options.dir, names.manifest),`${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
