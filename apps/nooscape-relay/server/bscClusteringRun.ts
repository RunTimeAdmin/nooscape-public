import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { agentDirectoryRegistryRows, bscClusters, bscEndpointHostGroups, bscEntryEvidence, ingestionSources } from "../drizzle/schema";
import { BSC_LISTING_RULES, REGISTRY_LISTING } from "./agentRegistryRows";
import { agentIdOfKey, CLUSTER_MIN, ENDPOINT_HOST_RULE, endpointHostGroups, evidenceFromUri, groupEvidence, templateLabelMember, type ClusterKind, type EndpointHostGroup } from "./bscClusters";
import { getDb, requireDb } from "./db";
import { BSC_READ_CU_PER_SECOND, bscReadBucket } from "./ingestion/bscBudget";
import { MULTICALL3, MULTICALL_MAX_READS, decodeTokenUris, encodeTokenUriMulticall } from "./ingestion/bscMulticall";
import { callBscRpc } from "./ingestion/bscRpc";
import { sanitizePublicText } from "./publicText";

/**
 * The BNB fleet and template clustering step of the worker (docs/bsc-clusters-2026-10-16.md). After the day's sources
 * have run, it keeps `bsc_clusters` and `bsc_entry_evidence` in step with the registry rows. Three parts, each cut short
 * when the step's time is up:
 *
 *  1. Fleets over the whole registry, from recorded facts only: a registering wallet, a profile link and a host with
 *     `CLUSTER_MIN` registrations or more. Index scans over the registry rows, at most every six hours.
 *  2. The registration of each listed entry that has no evidence yet (or whose link changed), read from the chain with
 *     `tokenURI` batched through Multicall3 and paced at 75 CU/s, half of the 150 the plan allows. A link that is inline JSON
 *     is read; a web or ipfs link is not fetched here (the /checker page does not yet say Nooscape reads registrations).
 *  3. Gate G1 over the listed entries, from the evidence: template groups and wallet fleets, stored on each entry. The hosts
 *     that 50 or more listed entries declare as the host of their agent address are stored too, in a table of their own
 *     (`bsc_endpoint_host_groups`, migration 0040, with the rule's version and date on each row). Nothing reads that table.
 *
 * Best-effort like the Owl's Catch: it never throws, it asks the database before it asks the chain, and with the tables not
 * there it does nothing and says nothing (the migration, 0038, is run by hand). It writes only the three tables, and with
 * the third (0040) not made yet it skips that part alone.
 */

export type ClusteringDeps = {
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  now: () => number;
  /** The step stops starting new work after this long. */
  budgetMs: number;
  /** The most multicalls in one run. */
  maxBatches: number;
  /** Fleets over the whole registry are recomputed when the stored ones are older than this. */
  refreshMs: number;
};

export const CLUSTERING_BUDGET_MS = 20_000;
export const CLUSTERING_MAX_BATCHES = 40;
export const CLUSTERING_REFRESH_MS = 6 * 60 * 60 * 1000;
/** The chain budget of this step, in compute units a second: half of the 150 the plan allows. */
export const CLUSTERING_CU_PER_SECOND = BSC_READ_CU_PER_SECOND;
/** NodeReal's price of an eth_call (docs.nodereal.io/docs/compute-units-cus). */
const ETH_CALL_CU = 20;
/** The worker does not start the step when its own tick has already run this long. */
export const CLUSTERING_TICK_LIMIT_MS = 90_000;


const defaultDeps = (): ClusteringDeps => ({
  rpc: async (method, params) => {
    await bscReadBucket.take(ETH_CALL_CU);
    return callBscRpc(method, params);
  },
  now: () => Date.now(),
  budgetMs: CLUSTERING_BUDGET_MS,
  maxBatches: CLUSTERING_MAX_BATCHES,
  refreshMs: CLUSTERING_REFRESH_MS,
});

export type ClusteringResult =
  | { state: "busy" | "unavailable" | "no_source" | "too_late" }
  | {
      state: "completed";
      fleetsRefreshed: boolean;
      read: number;
      unreadable: number;
      stale: number;
      pendingAfter: number;
      stoppedBy: string | null;
      clusters: Record<Exclude<ClusterKind, "registry">, number>;
      entries: Record<string, number>;
      /** Endpoint-host groups stored; null when grouping did not run this time, or while migration 0040 has not been run. */
      endpointHostGroups: number | null;
      ms: number;
    };

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const ROWS = agentDirectoryRegistryRows;
const EMPTY_URI_SHA256 = createHash("sha256").update("").digest("hex");
const chunks = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/** True when the driver says a table is not there: migration 0038 has not been run yet. Expected, and not worth a log line. */
function isMissingTable(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; cause instanceof Error && depth < 4; depth += 1) {
    if ("code" in cause && cause.code === "ER_NO_SUCH_TABLE") return true;
    cause = cause.cause;
  }
  return false;
}

const logFailure = (message: string) => console.error(JSON.stringify({ event: "nooscape_bsc_clusters_failed", message: message.replace(/[\r\n]+/g, " ").slice(0, 400) }));

/** A recorded name that names the group and not one member: not the placeholder, and cleaned like every public name. */
function publicLabel(host: string | null, name: string | null): string | null {
  if (host) return host;
  if (name && !/^Agent #\d+$/.test(name)) return sanitizePublicText(name, 80) || null;
  return null;
}

/** The key of the one summary row of the registry. Its date is when the fleets were last recomputed. */
const REGISTRY_MARKER = "all";

type ClusterRow = { clusterKey: string; label: string | null; memberCount: number; listedCount: number; walletCount: number | null };

/** Makes the stored rows of one kind exactly `wanted`: new ones added, changed ones updated, ones no longer wanted removed. */
async function replaceClusters(db: Db, sourceId: string, kind: ClusterKind, wanted: ClusterRow[], computedAt: Date) {
  for (const part of chunks(wanted, 200)) {
    await db
      .insert(bscClusters)
      .values(part.map(row => ({ id: randomUUID(), sourceId, kind, ...row, computedAt })))
      .onDuplicateKeyUpdate({
        set: {
          label: sql.raw("values(`label`)"),
          memberCount: sql.raw("values(`memberCount`)"),
          listedCount: sql.raw("values(`listedCount`)"),
          walletCount: sql.raw("values(`walletCount`)"),
          computedAt: sql.raw("values(`computedAt`)"),
        },
      });
  }
  const keep = new Set(wanted.map(row => row.clusterKey));
  const stored = await db.select({ id: bscClusters.id, clusterKey: bscClusters.clusterKey }).from(bscClusters).where(and(eq(bscClusters.sourceId, sourceId), eq(bscClusters.kind, kind)));
  const gone = stored.filter(row => !keep.has(row.clusterKey)).map(row => row.id);
  for (const part of chunks(gone, 200)) await db.delete(bscClusters).where(inArray(bscClusters.id, part));
}

/** Part 1: the fleets over the whole registry. */
async function refreshFleets(db: Db, sourceId: string, computedAt: Date) {
  const wallets = await db
    .select({ key: ROWS.registrant, total: sql<number>`count(*)` })
    .from(ROWS)
    .where(and(eq(ROWS.sourceId, sourceId), isNotNull(ROWS.registrant)))
    .groupBy(ROWS.registrant)
    .having(sql`count(*) >= ${CLUSTER_MIN}`);
  await replaceClusters(
    db,
    sourceId,
    "wallet",
    wallets.map(row => ({ clusterKey: row.key!, label: null, memberCount: Number(row.total), listedCount: 0, walletCount: 1 })),
    computedAt
  );

  const hosts = await db
    .select({ key: ROWS.locatorHost, total: sql<number>`count(*)` })
    .from(ROWS)
    .where(and(eq(ROWS.sourceId, sourceId), isNotNull(ROWS.locatorHost)))
    .groupBy(ROWS.locatorHost)
    .having(sql`count(*) >= ${BSC_LISTING_RULES.sharedHostFrom}`);
  await replaceClusters(
    db,
    sourceId,
    "platform_host",
    hosts.map(row => ({ clusterKey: row.key!, label: row.key, memberCount: Number(row.total), listedCount: 0, walletCount: null })),
    computedAt
  );

  const links = await db
    .select({ key: ROWS.profileUriHash, total: sql<number>`count(*)` })
    .from(ROWS)
    .where(and(eq(ROWS.sourceId, sourceId), isNotNull(ROWS.profileUriHash), sql`${ROWS.profileUriHash} <> ${EMPTY_URI_SHA256}`))
    .groupBy(ROWS.profileUriHash)
    .having(sql`count(*) >= ${CLUSTER_MIN}`);
  const linkRows: ClusterRow[] = [];
  for (const link of links) {
    const [member] = await db
      .select({ host: ROWS.locatorHost, name: ROWS.displayName })
      .from(ROWS)
      .where(and(eq(ROWS.sourceId, sourceId), eq(ROWS.profileUriHash, link.key!)))
      .orderBy(ROWS.id)
      .limit(1);
    linkRows.push({ clusterKey: link.key!, label: publicLabel(member?.host ?? null, member?.name ?? null), memberCount: Number(link.total), listedCount: 0, walletCount: null });
  }
  await replaceClusters(db, sourceId, "shared_link", linkRows, computedAt);
  // How many registrations the registry holds and how many the directory lists, dated by this refresh. Written last: a refresh that stops half way is not dated, and the next run does it again.
  const states = await db
    .select({ listing: ROWS.listing, total: sql<number>`count(*)` })
    .from(ROWS)
    .where(eq(ROWS.sourceId, sourceId))
    .groupBy(ROWS.listing);
  const recorded = states.reduce((sum, row) => sum + Number(row.total), 0);
  const listed = Number(states.find(row => row.listing === REGISTRY_LISTING.LISTED)?.total ?? 0);
  await replaceClusters(db, sourceId, "registry", [{ clusterKey: REGISTRY_MARKER, label: null, memberCount: recorded, listedCount: listed, walletCount: null }], computedAt);
}

/** Part 2: read the registration of the listed entries that have no evidence, or evidence for a link they no longer have. */
async function readRegistrations(db: Db, sourceId: string, deps: ClusteringDeps, deadline: number) {
  const counts = { read: 0, unreadable: 0, stale: 0, stoppedBy: null as string | null, pendingAfter: 0 };
  const pending = await db
    .select({ externalKey: ROWS.externalKey, profileUriHash: ROWS.profileUriHash })
    .from(ROWS)
    .leftJoin(bscEntryEvidence, and(eq(bscEntryEvidence.sourceId, ROWS.sourceId), eq(bscEntryEvidence.externalKey, ROWS.externalKey)))
    .where(and(eq(ROWS.sourceId, sourceId), eq(ROWS.listing, REGISTRY_LISTING.LISTED), isNotNull(ROWS.profileUriHash), sql`(${bscEntryEvidence.id} IS NULL OR ${bscEntryEvidence.profileUriHash} <> ${ROWS.profileUriHash})`))
    .limit(deps.maxBatches * MULTICALL_MAX_READS);
  counts.pendingAfter = pending.length;
  const work = pending.flatMap(row => {
    const agentId = agentIdOfKey(row.externalKey);
    return agentId === null ? [] : [{ externalKey: row.externalKey, agentId, profileUriHash: row.profileUriHash! }];
  });
  for (const batch of chunks(work, MULTICALL_MAX_READS)) {
    if (deps.now() >= deadline) {
      counts.stoppedBy = "time";
      break;
    }
    let uris: Array<string | null> | null;
    try {
      const answer = await deps.rpc("eth_call", [{ to: MULTICALL3, data: encodeTokenUriMulticall(batch.map(item => item.agentId)) }, "finalized"]);
      uris = decodeTokenUris(answer, batch.length);
    } catch (error) {
      // The chain client's messages never hold the endpoint. What was read stays; the next run carries on.
      logFailure(`tokenURI batch could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
      counts.stoppedBy = "chain";
      break;
    }
    if (uris === null) {
      logFailure("tokenURI batch answer had an unexpected shape");
      counts.stoppedBy = "chain";
      break;
    }
    const readAt = new Date();
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index]!;
      const uri = uris[index] ?? null;
      let facts = uri === null ? null : evidenceFromUri(uri, item.agentId);
      if (facts !== null && facts.profileUriHash !== item.profileUriHash) {
        // The chain has moved on past the registry rows: the next pass updates the row, and this one is read again after it.
        counts.stale += 1;
        continue;
      }
      // A read that failed for this id alone (a token that reverts, a URI over 64 KiB) is settled for this link, not retried every run.
      if (facts === null) facts = { readStatus: "unreadable", templateKey: null, endpointHost: null, profileUriHash: item.profileUriHash };
      if (facts.readStatus === "unreadable") counts.unreadable += 1;
      await db
        .insert(bscEntryEvidence)
        .values({
          id: randomUUID(),
          sourceId,
          externalKey: item.externalKey,
          profileUriHash: facts.profileUriHash,
          readStatus: facts.readStatus,
          templateKey: facts.templateKey,
          endpointHost: facts.endpointHost,
          g1: "unread",
          templateSize: 1,
          walletRegistrations: 0,
          readAt,
          computedAt: readAt,
        })
        .onDuplicateKeyUpdate({
          set: { profileUriHash: facts.profileUriHash, readStatus: facts.readStatus, templateKey: facts.templateKey, endpointHost: facts.endpointHost, readAt },
        });
      counts.read += 1;
    }
  }
  counts.pendingAfter = Math.max(0, pending.length - counts.read - counts.stale);
  return counts;
}

/**
 * The endpoint-host groups, made exactly `wanted`: new ones added, changed ones updated, ones no longer wanted removed. Each row
 * carries the version and the date of the rule that found it. Returns how many are stored, or null when the table is not there
 * (migration 0040 not run yet), which is expected and not worth a log line.
 */
async function storeEndpointHostGroups(db: Db, sourceId: string, wanted: EndpointHostGroup[], computedAt: Date): Promise<number | null> {
  try {
    const stored = await db.select({ id: bscEndpointHostGroups.id, host: bscEndpointHostGroups.host }).from(bscEndpointHostGroups).where(eq(bscEndpointHostGroups.sourceId, sourceId));
    for (const part of chunks(wanted, 200)) {
      await db
        .insert(bscEndpointHostGroups)
        .values(part.map(group => ({ id: randomUUID(), sourceId, ...group, ruleVersion: ENDPOINT_HOST_RULE.version, ruleDate: ENDPOINT_HOST_RULE.date, computedAt })))
        .onDuplicateKeyUpdate({
          set: {
            listedCount: sql.raw("values(`listedCount`)"),
            walletCount: sql.raw("values(`walletCount`)"),
            ruleVersion: sql.raw("values(`ruleVersion`)"),
            ruleDate: sql.raw("values(`ruleDate`)"),
            computedAt: sql.raw("values(`computedAt`)"),
          },
        });
    }
    const keep = new Set(wanted.map(group => group.host));
    const gone = stored.filter(row => !keep.has(row.host)).map(row => row.id);
    for (const part of chunks(gone, 200)) await db.delete(bscEndpointHostGroups).where(inArray(bscEndpointHostGroups.id, part));
    return wanted.length;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

/**
 * Part 3: gate G1 over the listed entries that have evidence, written on each entry and as template groups. The registration-file step
 * (bscRegistrationFiles.ts) runs it again after it has read files, so a file that gave an entry its template key counts at once.
 */
export async function groupListed(db: Db, sourceId: string, computedAt: Date) {
  // Evidence for an entry the directory no longer lists goes.
  await db.execute(sql`
    DELETE e FROM bsc_entry_evidence AS e
    LEFT JOIN agent_directory_registry_rows AS r ON r.sourceId = e.sourceId AND r.externalKey = e.externalKey AND r.listing = ${REGISTRY_LISTING.LISTED}
    WHERE e.sourceId = ${sourceId} AND r.id IS NULL
  `);
  const evidence = await db
    .select({
      externalKey: bscEntryEvidence.externalKey,
      readStatus: bscEntryEvidence.readStatus,
      templateKey: bscEntryEvidence.templateKey,
      endpointHost: bscEntryEvidence.endpointHost,
      g1: bscEntryEvidence.g1,
      templateSize: bscEntryEvidence.templateSize,
      walletRegistrations: bscEntryEvidence.walletRegistrations,
      registrant: ROWS.registrant,
      displayName: ROWS.displayName,
    })
    .from(bscEntryEvidence)
    .innerJoin(ROWS, and(eq(ROWS.sourceId, bscEntryEvidence.sourceId), eq(ROWS.externalKey, bscEntryEvidence.externalKey)))
    .where(and(eq(bscEntryEvidence.sourceId, sourceId), eq(ROWS.listing, REGISTRY_LISTING.LISTED)));

  // The registry's own count for each wallet, as the fleet bar reads it.
  const walletSize = new Map<string, number>();
  const wallets = Array.from(new Set(evidence.flatMap(row => (row.registrant ? [row.registrant] : []))));
  for (const part of chunks(wallets, 500)) {
    const sizes = await db
      .select({ registrant: ROWS.registrant, total: sql<number>`count(*)` })
      .from(ROWS)
      .where(and(eq(ROWS.sourceId, sourceId), inArray(ROWS.registrant, part)))
      .groupBy(ROWS.registrant);
    for (const size of sizes) walletSize.set(size.registrant!, Number(size.total));
  }

  const grouped = groupEvidence(
    evidence.map(row => ({ externalKey: row.externalKey, registrant: row.registrant ?? "", readStatus: row.readStatus, templateKey: row.templateKey })),
    walletSize
  );

  // Write what changed, one statement for the entries that share a result.
  const changed = new Map<string, string[]>();
  const tally: Record<string, number> = {};
  for (const row of evidence) {
    const result = grouped.byKey.get(row.externalKey)!;
    tally[result.g1] = (tally[result.g1] ?? 0) + 1;
    if (result.g1 === row.g1 && result.templateSize === row.templateSize && result.walletRegistrations === row.walletRegistrations) continue;
    const shape = JSON.stringify([result.g1, result.templateSize, result.walletRegistrations]);
    const list = changed.get(shape);
    if (list) list.push(row.externalKey);
    else changed.set(shape, [row.externalKey]);
  }
  for (const [shape, keys] of Array.from(changed)) {
    const [g1, templateSize, walletRegistrations] = JSON.parse(shape) as [string, number, number];
    for (const part of chunks(keys, 500)) {
      await db
        .update(bscEntryEvidence)
        .set({ g1, templateSize, walletRegistrations, computedAt })
        .where(and(eq(bscEntryEvidence.sourceId, sourceId), inArray(bscEntryEvidence.externalKey, part)));
    }
  }

  const byKey = new Map(evidence.map(row => [row.externalKey, row]));
  const templates: ClusterRow[] = grouped.templates.map(group => {
    const members = group.members.map(key => byKey.get(key)!);
    const named = templateLabelMember(members);
    return {
      clusterKey: group.key,
      label: publicLabel(null, named?.displayName ?? null),
      memberCount: members.length,
      listedCount: members.length,
      walletCount: new Set(members.map(member => member.registrant)).size,
    };
  });
  await replaceClusters(db, sourceId, "template", templates, computedAt);
  // The endpoint-host groups: stored with the rule's version and date, and nothing else changes because of them.
  const hostGroups = await storeEndpointHostGroups(
    db,
    sourceId,
    endpointHostGroups(evidence.map(row => ({ registrant: row.registrant ?? "", readStatus: row.readStatus, endpointHost: row.endpointHost }))),
    computedAt
  );
  return { entries: tally, templates: templates.length, endpointHostGroups: hostGroups };
}

let running = false;

/** Runs the clustering step once. Never throws. */
export async function runBscClustering(overrides: Partial<ClusteringDeps> & { tickStartedAt?: number } = {}): Promise<ClusteringResult> {
  if (running) return { state: "busy" };
  const deps: ClusteringDeps = { ...defaultDeps(), ...overrides };
  const started = deps.now();
  if (overrides.tickStartedAt !== undefined && started - overrides.tickStartedAt > CLUSTERING_TICK_LIMIT_MS) return { state: "too_late" };
  running = true;
  try {
    const database = await getDb();
    if (!database) return { state: "unavailable" };
    const db = requireDb(database);
    try {
      // The tables first: with them missing nothing is read from the chain and nothing is written.
      await db.select({ id: bscClusters.id }).from(bscClusters).limit(1);
      await db.select({ id: bscEntryEvidence.id }).from(bscEntryEvidence).limit(1);
    } catch (error) {
      if (!isMissingTable(error)) logFailure(`the cluster tables could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
      return { state: "unavailable" };
    }
    const [source] = await db
      .select({ id: ingestionSources.id })
      .from(ingestionSources)
      .where(and(eq(ingestionSources.protocol, "erc8004_bsc"), eq(ingestionSources.state, "active")))
      .limit(1);
    if (!source) return { state: "no_source" };

    const deadline = started + deps.budgetMs;
    const computedAt = new Date();
    let fleetsRefreshed = false;
    // The last refresh is dated on a summary row of its own, so a registry with no fleet at all is not recomputed every tick.
    const [marker] = await db
      .select({ at: bscClusters.computedAt })
      .from(bscClusters)
      .where(and(eq(bscClusters.sourceId, source.id), eq(bscClusters.kind, "registry"), eq(bscClusters.clusterKey, REGISTRY_MARKER)))
      .limit(1);
    const lastAt = marker ? marker.at.getTime() : 0;
    // MySQL rounds a timestamp to the second, which can put the marker just ahead of now, so "always" is its own answer.
    if (deps.refreshMs <= 0 || Date.now() - lastAt >= deps.refreshMs) {
      await refreshFleets(db, source.id, computedAt);
      fleetsRefreshed = true;
    }
    const read = deps.now() < deadline ? await readRegistrations(db, source.id, deps, deadline) : { read: 0, unreadable: 0, stale: 0, stoppedBy: "time" as string | null, pendingAfter: 0 };
    // Grouping is cheap and reads only the database, so it runs whenever something it depends on changed.
    const needsGrouping = fleetsRefreshed || read.read > 0;
    const grouped = needsGrouping ? await groupListed(db, source.id, computedAt) : null;
    const clusterCounts = await db
      .select({ kind: bscClusters.kind, total: sql<number>`count(*)` })
      .from(bscClusters)
      .where(eq(bscClusters.sourceId, source.id))
      .groupBy(bscClusters.kind);
    const clusters: Record<Exclude<ClusterKind, "registry">, number> = { wallet: 0, shared_link: 0, platform_host: 0, template: 0 };
    for (const row of clusterCounts) if (row.kind in clusters) clusters[row.kind as keyof typeof clusters] = Number(row.total);
    const result: ClusteringResult = {
      state: "completed",
      fleetsRefreshed,
      read: read.read,
      unreadable: read.unreadable,
      stale: read.stale,
      pendingAfter: read.pendingAfter,
      stoppedBy: read.stoppedBy,
      clusters,
      entries: grouped?.entries ?? {},
      endpointHostGroups: grouped?.endpointHostGroups ?? null,
      ms: deps.now() - started,
    };
    if (fleetsRefreshed || read.read > 0 || read.stale > 0 || read.stoppedBy !== null) console.log(JSON.stringify({ event: "nooscape_bsc_clusters", ...result }));
    return result;
  } catch (error) {
    if (!isMissingTable(error)) logFailure(error instanceof Error ? error.message : "unknown error");
    return { state: "unavailable" };
  } finally {
    running = false;
  }
}
