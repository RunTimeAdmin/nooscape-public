import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { bscEntryEvidence, ingestionSources } from "../drizzle/schema";
import { agentIdOfKey, evidenceFromFile } from "./bscClusters";
import { groupListed } from "./bscClusteringRun";
import {
  FETCHED,
  FILE_RETRY_AFTER_MS,
  LINK_NOT_READ,
  NOT_FETCHABLE,
  statusAfterFailedTry,
  statusAfterUnparsedTry,
  UNREADABLE,
  WAITING_STATUSES,
} from "./bscRegistrationFilesCore";
import { getDb, requireDb } from "./db";
import { bscReadBucket } from "./ingestion/bscBudget";
import { bscUriFacts } from "./ingestion/bscChain";
import { MULTICALL3, MULTICALL_MAX_READS, decodeTokenUris, encodeTokenUriMulticall } from "./ingestion/bscMulticall";
import { callBscRpc } from "./ingestion/bscRpc";
import { classifyRegistrationUri, createRegistrationFileReader, ipfsLinkHasCid, type RegistrationFileResult, type RegistrationUriKind } from "./ingestion/registrationFetch";
import { pickBalanced } from "./robinhoodNamesCore";
import { stepIntervalGateMs } from "./stepInterval";

/**
 * The BNB registration-file step of the worker (docs/approvals/2026-10-17-bnb-registration-files.md). The clustering step reads the
 * registration of a listed BNB entry from its link when the link is inline JSON, and sets `link_not_read` when it is a web or ipfs
 * link (376 of the 6,842 listed on 2026-10-16). This step reads the file behind such a link, so that the entry's template key and
 * agent-address host, and so gate G1, are known for it too. In each run, cut short when its time or its count is up:
 *
 *  1. The entries waiting (never tried, or tried and not yet at their limit and at least six hours since the last try), never-tried
 *     first and then oldest first.
 *  2. Their `tokenURI` from the chain, in one Multicall3 `eth_call` through the clustering step's own compute-unit bucket. A link
 *     that no longer hashes to the one the evidence recorded is left for the clustering step to read again.
 *  3. The files, through the same safe fetch and manners as the Solana 8004 name reader (https only, the host's robots.txt first, a
 *     second between two requests to a host, 5 seconds, 256 KiB, the Nooscape-Checker user agent, an ipfs link asked of the
 *     configured IPFS gateway), at most `FILES_MAX_PER_RUN` a run and at most `FILES_MAX_PER_HOST` from any one host.
 *  4. What a file gives is the registration's template key and the host of its first agent address, kept on the entry's evidence row
 *     with the date. Nothing else of the file is kept and no agent address is ever asked. When a file was read, gate G1 and the
 *     groups are worked out again.
 *
 * Internal evidence, never a score, a tier or a verdict, and BNB stays directory-only. It never throws, it asks the database before
 * it asks anyone, a failure is one log line, and with the clustering tables missing it does nothing and says nothing.
 */

export const FILES_BUDGET_MS = 20_000;
export const FILES_MAX_PER_RUN = 16;
export const FILES_MAX_PER_HOST = 6;
/** A run at most every 30 minutes. The gate between two runs is a little under this (`stepIntervalGateMs`, server/stepInterval.ts), so a tick's step starting a minute early is not skipped. */
export const FILES_INTERVAL_MS = 30 * 60 * 1000;
/** Chain reads stop for this long after a failed `tokenURI` read. */
export const FILES_CHAIN_BACKOFF_MS = 30 * 60 * 1000;
/** The worker does not start the step when its own tick has already run this long (it can take 20 seconds; see NAMES_TICK_LIMIT_MS for why it is not shorter). */
export const FILES_TICK_LIMIT_MS = 100_000;
/** NodeReal's price of an eth_call (docs.nodereal.io/docs/compute-units-cus), taken from the clustering step's bucket. */
const ETH_CALL_CU = 20;

export type BscRegistrationFilesDeps = {
  now: () => number;
  /** One `eth_call`, through the clustering step's bucket by default. Tests replace it. */
  rpc?: (method: string, params: unknown[]) => Promise<unknown>;
  /** Reads one registration file. Tests replace it; by default it is the shared file reader. */
  readFile?: (uri: string, kind: RegistrationUriKind) => Promise<RegistrationFileResult>;
  budgetMs: number;
  maxFiles: number;
  maxPerHost: number;
  /** A run does nothing when the last one started less than this long ago. 0 means always. */
  intervalMs: number;
};

export type BscRegistrationFilesResult =
  | { state: "busy" | "idle" | "unavailable" | "no_source" | "too_late" }
  | {
      state: "completed";
      waiting: number;
      chain: string | null;
      fetched: number;
      unparsed: number;
      failed: number;
      notFetchable: number;
      unreadable: number;
      stale: number;
      stoppedBy: string | null;
      ms: number;
    };

let running = false;
let lastStartedAt = 0;
let chainPausedUntil = 0;

/** Forgets when the step last ran and any pause of the chain reads (tests). */
export function resetBscRegistrationFilesClock() {
  lastStartedAt = 0;
  chainPausedUntil = 0;
}

const logFailure = (message: string) => console.error(JSON.stringify({ event: "nooscape_bsc_files_failed", message: message.replace(/[\r\n]+/g, " ").slice(0, 400) }));

/** True when the driver says a table is not there: migration 0038 has not been run. Expected, and not worth a log line. */
function isMissingTable(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; cause instanceof Error && depth < 4; depth += 1) {
    if ("code" in cause && cause.code === "ER_NO_SUCH_TABLE") return true;
    cause = cause.cause;
  }
  return false;
}

/** Runs the registration-file step once. Never throws. */
export async function runBscRegistrationFiles(overrides: Partial<BscRegistrationFilesDeps> & { tickStartedAt?: number } = {}): Promise<BscRegistrationFilesResult> {
  if (running) return { state: "busy" };
  const deps: BscRegistrationFilesDeps = { now: () => Date.now(), budgetMs: FILES_BUDGET_MS, maxFiles: FILES_MAX_PER_RUN, maxPerHost: FILES_MAX_PER_HOST, intervalMs: FILES_INTERVAL_MS, ...overrides };
  const started = deps.now();
  if (overrides.tickStartedAt !== undefined && started - overrides.tickStartedAt > FILES_TICK_LIMIT_MS) return { state: "too_late" };
  if (deps.intervalMs > 0 && lastStartedAt !== 0 && started - lastStartedAt < stepIntervalGateMs(deps.intervalMs)) return { state: "idle" };
  running = true;
  try {
    const database = await getDb();
    if (!database) return { state: "unavailable" };
    const db = requireDb(database);
    try {
      await db.select({ id: bscEntryEvidence.id }).from(bscEntryEvidence).limit(1);
    } catch (error) {
      if (!isMissingTable(error)) logFailure(`the evidence table could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
      return { state: "unavailable" };
    }
    const [source] = await db
      .select({ id: ingestionSources.id })
      .from(ingestionSources)
      .where(and(eq(ingestionSources.protocol, "erc8004_bsc"), eq(ingestionSources.state, "active")))
      .limit(1);
    if (!source) return { state: "no_source" };
    lastStartedAt = started;

    const tally = { chain: null as string | null, fetched: 0, unparsed: 0, failed: 0, notFetchable: 0, unreadable: 0, stale: 0, stoppedBy: null as string | null };
    const finish = (waiting: number): BscRegistrationFilesResult => {
      const result: BscRegistrationFilesResult = { state: "completed", waiting, ...tally, ms: deps.now() - started };
      const changed = tally.fetched + tally.unparsed + tally.failed + tally.notFetchable + tally.unreadable;
      if (changed > 0 || (tally.chain !== null && tally.chain !== "read")) console.log(JSON.stringify({ event: "nooscape_bsc_files", ...result }));
      return result;
    };

    const waiting = await db
      .select({ externalKey: bscEntryEvidence.externalKey, profileUriHash: bscEntryEvidence.profileUriHash, readStatus: bscEntryEvidence.readStatus })
      .from(bscEntryEvidence)
      .where(
        and(
          eq(bscEntryEvidence.sourceId, source.id),
          or(
            // Never tried: due at once, however new the evidence is.
            eq(bscEntryEvidence.readStatus, LINK_NOT_READ),
            // Tried and not at its limit: due when the last try is old enough.
            and(inArray(bscEntryEvidence.readStatus, WAITING_STATUSES.filter(status => status !== LINK_NOT_READ)), lte(bscEntryEvidence.readAt, new Date(started - FILE_RETRY_AFTER_MS)))
          )
        )
      )
      .orderBy(sql`CASE WHEN ${bscEntryEvidence.readStatus} = ${LINK_NOT_READ} THEN 0 ELSE 1 END`, asc(bscEntryEvidence.readAt), asc(bscEntryEvidence.externalKey))
      .limit(Math.min(deps.maxFiles, MULTICALL_MAX_READS));
    const entries = waiting.flatMap(row => {
      const agentId = agentIdOfKey(row.externalKey);
      return agentId === null ? [] : [{ ...row, agentId }];
    });
    if (entries.length === 0) return finish(0);
    if (chainPausedUntil > started) {
      tally.chain = "paused";
      return finish(entries.length);
    }

    let uris: Array<string | null> | null;
    try {
      const rpc =
        deps.rpc ??
        (async (method: string, params: unknown[]) => {
          await bscReadBucket.take(ETH_CALL_CU);
          return callBscRpc(method, params);
        });
      const answer = await rpc("eth_call", [{ to: MULTICALL3, data: encodeTokenUriMulticall(entries.map(entry => entry.agentId)) }, "finalized"]);
      uris = decodeTokenUris(answer, entries.length);
    } catch (error) {
      // The chain client's messages never hold the endpoint.
      chainPausedUntil = started + FILES_CHAIN_BACKOFF_MS;
      tally.chain = "failed";
      logFailure(`the tokenURI read could not be made: ${error instanceof Error ? error.message : "unknown error"}; chain reads are paused for 0.5 hours`);
      return finish(entries.length);
    }
    if (uris === null) {
      chainPausedUntil = started + FILES_CHAIN_BACKOFF_MS;
      tally.chain = "failed";
      logFailure("the tokenURI answer had an unexpected shape; chain reads are paused for 0.5 hours");
      return finish(entries.length);
    }
    tally.chain = "read";

    const keep = async (entry: (typeof entries)[number], readStatus: string, templateKey: string | null = null, endpointHost: string | null = null) => {
      await db
        .update(bscEntryEvidence)
        .set({ readStatus, templateKey, endpointHost, readAt: new Date() })
        .where(and(eq(bscEntryEvidence.sourceId, source.id), eq(bscEntryEvidence.externalKey, entry.externalKey), eq(bscEntryEvidence.profileUriHash, entry.profileUriHash)));
    };

    const candidates: Array<{ entry: (typeof entries)[number]; uri: string; kind: RegistrationUriKind }> = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const uri = uris[index] ?? null;
      if (uri === null) {
        // A read that failed for this id alone (a token that reverts) is settled, as the clustering step settles it for an inline link.
        await keep(entry, UNREADABLE);
        tally.unreadable += 1;
        continue;
      }
      if (bscUriFacts(uri).profileUriHash !== entry.profileUriHash) {
        // The chain has moved on past the evidence: the clustering step reads the entry again, and this one is tried after it.
        tally.stale += 1;
        continue;
      }
      const kind = classifyRegistrationUri(uri);
      if (kind === null || (kind === "web" && !uri.startsWith("https://")) || (kind === "ipfs" && !ipfsLinkHasCid(uri))) {
        await keep(entry, NOT_FETCHABLE);
        tally.notFetchable += 1;
        continue;
      }
      candidates.push({ entry, uri, kind });
    }

    const batch = pickBalanced(candidates, deps.maxFiles, deps.maxPerHost);
    if (batch.length > 0) {
      const readFile = deps.readFile ?? createRegistrationFileReader(batch.length);
      const deadline = started + deps.budgetMs;
      for (const { entry, uri, kind } of batch) {
        if (deps.now() >= deadline) {
          tally.stoppedBy = "time";
          break;
        }
        const file = await readFile(uri, kind);
        if (file.status === "ok") {
          const evidence = evidenceFromFile(file.text, entry.agentId, entry.profileUriHash);
          if (evidence.readStatus === "fetched") {
            await keep(entry, FETCHED, evidence.templateKey, evidence.endpointHost);
            tally.fetched += 1;
          } else {
            await keep(entry, statusAfterUnparsedTry(entry.readStatus));
            tally.unparsed += 1;
          }
        } else if (file.status === "gone") {
          await keep(entry, statusAfterUnparsedTry(entry.readStatus));
          tally.unparsed += 1;
        } else {
          await keep(entry, statusAfterFailedTry(entry.readStatus));
          tally.failed += 1;
        }
      }
    }
    // A file that gave an entry its template key counts in gate G1 and the groups at once, not at the next refresh.
    if (tally.fetched > 0) await groupListed(db, source.id, new Date());
    return finish(entries.length);
  } catch (error) {
    if (!isMissingTable(error)) logFailure(error instanceof Error ? error.message : "unknown error");
    return { state: "unavailable" };
  } finally {
    running = false;
  }
}
