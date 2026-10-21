import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentDirectoryEntries, agentRegistrationResolutions, ingestionSources, type IngestionSource } from "../drizzle/schema";
import { getDb, listLiveAtlasRecords, requireDb, upsertAgentRegistrationResolutions } from "./db";
import { decodeTokenUris, encodeTokenUriMulticall, MULTICALL3, MULTICALL_MAX_READS } from "./ingestion/bscMulticall";
import {
  createRegistrationNameResolver,
  RESOLUTION_FAILED_MAX_ATTEMPTS,
  RESOLUTION_NO_NAME_MAX_ATTEMPTS,
  type RegistrationNameResult,
  type RegistrationUriKind,
} from "./ingestion/registrationFetch";
import { callRobinhoodRpcOnce, RobinhoodRegistryHttpError, ROBINHOOD_IDENTITY_REGISTRY, ROBINHOOD_RPC_URL } from "./ingestion/robinhood";
import { sanitizePublicText } from "./publicText";
import { invalidateDirectoryReadsSoftly } from "./readCache";
import { stepIntervalGateMs } from "./stepInterval";
import {
  ENTRY_PLACEHOLDER_PATTERN,
  entryNameNote,
  entryUriFacts,
  NAME_RETRY_AFTER_MS,
  nameableRecord,
  namesToRead,
  pickBalanced,
  ROBINHOOD_EXTERNAL_PREFIX,
  ROBINHOOD_SOURCE_KEY,
  SHOWN_NAME_MAX_CHARS,
  type NameableRecord,
  type PriorAttempt,
} from "./robinhoodNamesCore";

/**
 * The Robinhood name step of the worker (docs/approvals/2026-10-17-robinhood-names.md and
 * docs/approvals/2026-10-17-robinhood-entry-names.md). Registrations of the Robinhood Chain ERC-8004 registry that carry no name of
 * their own are called "Agent #<n>". The step finds a name for them in three parts, each cut short when its time or its count is up:
 *
 *  1. Discovery, from the chain. For the directory entries that still have the placeholder and no recorded link, it reads
 *     `tokenURI` for up to `NAMES_MAX_DISCOVER` of them, newest id first (the home page shows the newest registrations and the
 *     Catch's identities, and a lowest-first walk would not reach them for days), in one `eth_call` through Multicall3 (one request, no retry ladder, paused
 *     for hours when the node answers 403 or 429), records the hash of each link on the entry, takes a name from inline JSON where
 *     there is one, and queues a link that is an https address or an ipfs address with a CID.
 *  2. Reading. The queued links and the links the reviewed records name, through the same safe fetch and manners as the Solana
 *     8004 name reader (https only, the host's robots.txt first, a second between two requests to a host, 5 seconds, 256 KiB, the
 *     Nooscape-Checker user agent, an ipfs link asked of the configured IPFS gateway), at most `NAMES_MAX_PER_RUN` files a run and
 *     at most `NAMES_MAX_PER_HOST` for any one host. Each try is kept in `agent_registration_resolutions`, the Solana pass's table,
 *     so there is no migration; a link is tried again no sooner than six hours after its last try and never past the Solana reader's
 *     tries (five for a link that does not answer, two for a file with no name).
 *  3. Naming. A name that was read is written to the directory entries whose link it came from, only where the name is still the
 *     placeholder, with a sentence added to the entry's note that says when it was read. A reviewed record's name is laid over its
 *     placeholder when it is served (`listLiveAtlasRecords`) and its retained observation does not change.
 *
 * The name is the registrant's own claim. It never throws, it asks the database before it asks anyone, and a failure is one log
 * line. It needs no migration.
 */

export const NAMES_BUDGET_MS = 20_000;
/** Registration files read in one run. */
export const NAMES_MAX_PER_RUN = 16;
/** The most of them from any one host in one run. */
export const NAMES_MAX_PER_HOST = 6;
/** Entries whose link is read from the chain in one run: one multicall. */
export const NAMES_MAX_DISCOVER = 16;
/** A run at most every 30 minutes. The gate between two runs is a little under this (`stepIntervalGateMs`, server/stepInterval.ts), so a tick's step starting a minute early is not skipped. */
export const NAMES_INTERVAL_MS = 30 * 60 * 1000;
/** Chain reads stop for this long after the node answers 403 or 429 (the edge throttles bursts and has blocked an address for minutes), and for the shorter one after any other failure. */
export const NAMES_CHAIN_BACKOFF_MS = 2 * 60 * 60 * 1000;
export const NAMES_CHAIN_SHORT_BACKOFF_MS = 30 * 60 * 1000;
/**
 * The worker does not start the step when its own tick has already run this long. The step can take 20 seconds. A tick's sources
 * take 25 to 70 seconds and the BNB rater step takes about 25 more while its ledger is filling, so a limit of 40 seconds skipped
 * the step on every tick for the first hour it was live (the runtime logs showed no run), and a limit of 60 seconds left the file
 * step behind it with no run at all (the names step ended 76 seconds into the first tick). 100 seconds keeps the steps off a tick
 * that is already long (the worst case is 70 seconds of sources, 25 of raters and 20 for each of the two steps, about 135, under
 * the cron's 150 second limit), and a skipped tick does not start the step's interval, so the next one tries.
 */
export const NAMES_TICK_LIMIT_MS = 100_000;
const ROBINHOOD_RPC_HOSTNAME = "rpc.mainnet.chain.robinhood.com";
/** MySQL's TIMESTAMP starts one second after the epoch. A link queued but not yet tried carries this date so it is due at once. */
const NOT_TRIED_YET = new Date(1000);

export type RobinhoodNamesDeps = {
  now: () => number;
  /** Reads one registration link for a name. Tests replace it; by default it is the shared name reader. */
  resolve?: (uri: string, kind: RegistrationUriKind) => Promise<RegistrationNameResult>;
  /** Reads the `tokenURI` of each agent id from the chain: a string, or null where the read failed, in order. Tests replace it. */
  readUris?: (ids: string[]) => Promise<Array<string | null> | null>;
  /** The step stops starting new reads after this long. */
  budgetMs: number;
  maxNames: number;
  maxPerHost: number;
  maxDiscover: number;
  /** A run does nothing when the last one started less than this long ago. 0 means always. */
  intervalMs: number;
};

export type RobinhoodNamesResult =
  | { state: "busy" | "idle" | "unavailable" | "no_source" | "too_late" }
  | {
      state: "completed";
      considered: number;
      discovered: number;
      read: number;
      resolved: number;
      noName: number;
      failed: number;
      entriesNamed: number;
      stoppedBy: string | null;
      chain: string | null;
      ms: number;
    };

let running = false;
let lastStartedAt = 0;
let chainPausedUntil = 0;

/** Forgets when the step last ran and any pause of the chain reads (tests). */
export function resetRobinhoodNamesClock() {
  lastStartedAt = 0;
  chainPausedUntil = 0;
}

const logFailure = (message: string) => console.error(JSON.stringify({ event: "nooscape_robinhood_names_failed", message: message.replace(/[\r\n]+/g, " ").slice(0, 400) }));

/** One `eth_call` through Multicall3 for the `tokenURI` of each id, at the latest block. No retry: a throttle is waited out between runs, not inside one. */
async function readTokenUrisFromChain(ids: string[]): Promise<Array<string | null> | null> {
  const answer = await callRobinhoodRpcOnce({ method: "eth_call", params: [{ to: MULTICALL3, data: encodeTokenUriMulticall(ids, ROBINHOOD_IDENTITY_REGISTRY) }, "latest"] });
  if (answer.error) throw new Error("Robinhood Chain RPC answered the tokenURI read with an error.");
  return decodeTokenUris(answer.result, ids.length);
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Tally = { discovered: number; read: number; resolved: number; noName: number; failed: number; entriesNamed: number; stoppedBy: string | null; chain: string | null };

/** Writes a name onto the entries that carry this link and still have the placeholder, and says when it was read. Returns how many entries it named. */
async function nameEntries(db: Db, sourceId: string, uriHash: string, rawName: string, day: string): Promise<number> {
  const name = sanitizePublicText(rawName, SHOWN_NAME_MAX_CHARS);
  if (name === null) return 0;
  const [header] = await db
    .update(agentDirectoryEntries)
    .set({ displayName: name, sourceSignalNote: sql`LEFT(CONCAT(COALESCE(${agentDirectoryEntries.sourceSignalNote}, ''), ${entryNameNote(day)}), 512)` })
    .where(and(eq(agentDirectoryEntries.sourceId, sourceId), eq(agentDirectoryEntries.profileUriHash, uriHash), sql`${agentDirectoryEntries.displayName} REGEXP ${ENTRY_PLACEHOLDER_PATTERN}`));
  return Number((header as unknown as { affectedRows?: number }).affectedRows ?? 0);
}

/** Part 1: read the links of entries that have none recorded, and record them. */
async function discover(db: Db, source: IngestionSource, deps: RobinhoodNamesDeps, started: number, tally: Tally, day: string) {
  if (source.rootUrl !== ROBINHOOD_RPC_URL || source.allowedHostname !== ROBINHOOD_RPC_HOSTNAME) {
    tally.chain = "skipped";
    return;
  }
  if (chainPausedUntil > started) {
    tally.chain = "paused";
    return;
  }
  const waiting = await db
    .select({ externalKey: agentDirectoryEntries.externalKey })
    .from(agentDirectoryEntries)
    .where(and(eq(agentDirectoryEntries.sourceId, source.id), isNull(agentDirectoryEntries.profileUriHash), sql`${agentDirectoryEntries.displayName} REGEXP ${ENTRY_PLACEHOLDER_PATTERN}`))
    .orderBy(sql`CAST(SUBSTRING_INDEX(${agentDirectoryEntries.externalKey}, ':', -1) AS UNSIGNED) DESC`)
    .limit(Math.min(deps.maxDiscover, MULTICALL_MAX_READS));
  const entries = waiting.flatMap(row => {
    const id = row.externalKey.startsWith(ROBINHOOD_EXTERNAL_PREFIX) ? row.externalKey.slice(ROBINHOOD_EXTERNAL_PREFIX.length) : "";
    return /^[0-9]{1,18}$/.test(id) ? [{ externalKey: row.externalKey, id }] : [];
  });
  if (entries.length === 0) return;

  let uris: Array<string | null> | null;
  try {
    uris = await (deps.readUris ?? readTokenUrisFromChain)(entries.map(entry => entry.id));
  } catch (error) {
    const throttled = error instanceof RobinhoodRegistryHttpError && (error.status === 403 || error.status === 429);
    chainPausedUntil = started + (throttled ? NAMES_CHAIN_BACKOFF_MS : NAMES_CHAIN_SHORT_BACKOFF_MS);
    tally.chain = throttled ? "throttled" : "failed";
    logFailure(`the tokenURI read could not be made: ${error instanceof Error ? error.message : "unknown error"}; chain reads are paused for ${throttled ? 2 : 0.5} hours`);
    return;
  }
  if (uris === null) {
    chainPausedUntil = started + NAMES_CHAIN_SHORT_BACKOFF_MS;
    tally.chain = "failed";
    logFailure("the tokenURI answer had an unexpected shape; chain reads are paused for 0.5 hours");
    return;
  }
  tally.chain = "read";

  const facts = entries.map((entry, index) => ({ entry, link: entryUriFacts(uris![index] ?? null) }));
  // Links an earlier read of the same file already settled are named at once, with no request.
  const hashes = facts.flatMap(item => (item.link.kind === "web" || item.link.kind === "ipfs" ? [item.link.uriHash] : []));
  const settled = new Map<string, string | null>();
  if (hashes.length > 0) {
    const rows = await db
      .select({ uriHash: agentRegistrationResolutions.uriHash, status: agentRegistrationResolutions.status, resolvedName: agentRegistrationResolutions.resolvedName })
      .from(agentRegistrationResolutions)
      .where(and(eq(agentRegistrationResolutions.sourceId, source.id), inArray(agentRegistrationResolutions.uriHash, hashes)));
    for (const row of rows) if (row.status === "resolved") settled.set(row.uriHash, row.resolvedName);
  }

  for (const { entry, link } of facts) {
    // The hash goes on the entry first, so a link that cannot be named is not read from the chain again.
    await db.update(agentDirectoryEntries).set({ profileUriHash: link.uriHash }).where(and(eq(agentDirectoryEntries.sourceId, source.id), eq(agentDirectoryEntries.externalKey, entry.externalKey)));
    tally.discovered += 1;
    if (link.kind === "inline" && link.name) {
      tally.entriesNamed += await nameEntries(db, source.id, link.uriHash, link.name, day);
    } else if (link.kind === "web" || link.kind === "ipfs") {
      const known = settled.get(link.uriHash);
      if (known) {
        tally.entriesNamed += await nameEntries(db, source.id, link.uriHash, known, day);
      } else {
        // Queued: a row nobody has tried yet, due at once. It never replaces a row that exists.
        await db
          .insert(agentRegistrationResolutions)
          .ignore()
          .values({ id: randomUUID(), sourceId: source.id, externalKey: entry.externalKey, uriHash: link.uriHash, uriKind: link.kind, uri: link.uri, status: "failed", failReason: "not read yet", resolvedName: null, attempts: 0, lastAttemptAt: NOT_TRIED_YET });
      }
    }
  }
}

/** Runs the name step once. Never throws. */
export async function runRobinhoodNames(overrides: Partial<RobinhoodNamesDeps> & { tickStartedAt?: number } = {}): Promise<RobinhoodNamesResult> {
  if (running) return { state: "busy" };
  const deps: RobinhoodNamesDeps = { now: () => Date.now(), budgetMs: NAMES_BUDGET_MS, maxNames: NAMES_MAX_PER_RUN, maxPerHost: NAMES_MAX_PER_HOST, maxDiscover: NAMES_MAX_DISCOVER, intervalMs: NAMES_INTERVAL_MS, ...overrides };
  const started = deps.now();
  if (overrides.tickStartedAt !== undefined && started - overrides.tickStartedAt > NAMES_TICK_LIMIT_MS) return { state: "too_late" };
  if (deps.intervalMs > 0 && lastStartedAt !== 0 && started - lastStartedAt < stepIntervalGateMs(deps.intervalMs)) return { state: "idle" };
  running = true;
  try {
    const database = await getDb();
    if (!database) return { state: "unavailable" };
    const db = requireDb(database);
    const [source] = await db
      .select()
      .from(ingestionSources)
      .where(and(eq(ingestionSources.sourceKey, ROBINHOOD_SOURCE_KEY), eq(ingestionSources.state, "active")))
      .limit(1);
    if (!source) return { state: "no_source" };
    lastStartedAt = started;
    const day = new Date(started).toISOString().slice(0, 10);
    const tally: Tally = { discovered: 0, read: 0, resolved: 0, noName: 0, failed: 0, entriesNamed: 0, stoppedBy: null, chain: null };

    await discover(db, source, deps, started, tally, day);

    // The reviewed records come first (they are on the map), then the links that were queued or are due for another try.
    const reviewed = (await listLiveAtlasRecords()).flatMap(record => {
      const target = nameableRecord(record);
      return target ? [target] : [];
    });
    const limits = { failed: RESOLUTION_FAILED_MAX_ATTEMPTS, noName: RESOLUTION_NO_NAME_MAX_ATTEMPTS };
    const priors = new Map<string, PriorAttempt>();
    if (reviewed.length > 0) {
      const rows = await db
        .select({ uriHash: agentRegistrationResolutions.uriHash, status: agentRegistrationResolutions.status, attempts: agentRegistrationResolutions.attempts, lastAttemptAt: agentRegistrationResolutions.lastAttemptAt })
        .from(agentRegistrationResolutions)
        .where(and(eq(agentRegistrationResolutions.sourceId, source.id), inArray(agentRegistrationResolutions.uriHash, reviewed.map(target => target.uriHash))));
      for (const row of rows) priors.set(row.uriHash, { status: row.status, attempts: row.attempts, lastAttemptAt: row.lastAttemptAt });
    }
    const due = await db
      .select({
        externalKey: agentRegistrationResolutions.externalKey,
        uriHash: agentRegistrationResolutions.uriHash,
        uriKind: agentRegistrationResolutions.uriKind,
        uri: agentRegistrationResolutions.uri,
        status: agentRegistrationResolutions.status,
        attempts: agentRegistrationResolutions.attempts,
        lastAttemptAt: agentRegistrationResolutions.lastAttemptAt,
      })
      .from(agentRegistrationResolutions)
      .where(
        and(
          eq(agentRegistrationResolutions.sourceId, source.id),
          or(
            and(eq(agentRegistrationResolutions.status, "failed"), lt(agentRegistrationResolutions.attempts, limits.failed)),
            and(eq(agentRegistrationResolutions.status, "no_name"), lt(agentRegistrationResolutions.attempts, limits.noName))
          ),
          lte(agentRegistrationResolutions.lastAttemptAt, new Date(started - NAME_RETRY_AFTER_MS)),
          inArray(agentRegistrationResolutions.uriKind, ["web", "ipfs"])
        )
      )
      .orderBy(asc(agentRegistrationResolutions.attempts), asc(agentRegistrationResolutions.lastAttemptAt))
      .limit(400);
    const queued: NameableRecord[] = due.map(row => ({ agentId: row.externalKey, externalKey: row.externalKey, uri: row.uri, kind: row.uriKind as RegistrationUriKind, uriHash: row.uriHash }));
    for (const row of due) priors.set(row.uriHash, { status: row.status, attempts: row.attempts, lastAttemptAt: row.lastAttemptAt });

    const seen = new Set<string>();
    const ordered = [...namesToRead(reviewed, priors, started, Number.MAX_SAFE_INTEGER, limits), ...namesToRead(queued, priors, started, Number.MAX_SAFE_INTEGER, limits)].filter(target => {
      if (seen.has(target.uriHash)) return false;
      seen.add(target.uriHash);
      return true;
    });
    const batch = pickBalanced(ordered, deps.maxNames, deps.maxPerHost);

    if (batch.length > 0) {
      const resolve = deps.resolve ?? createRegistrationNameResolver(batch.length);
      const deadline = started + deps.budgetMs;
      for (const target of batch) {
        if (deps.now() >= deadline) {
          tally.stoppedBy = "time";
          break;
        }
        const result = await resolve(target.uri, target.kind);
        // Each try is kept as soon as it is made, so a run cut short keeps what it read.
        await upsertAgentRegistrationResolutions({
          source,
          drafts: [
            {
              externalKey: target.externalKey,
              uriHash: target.uriHash,
              uriKind: target.kind,
              uri: target.uri,
              status: result.status,
              failReason: result.status === "failed" ? result.reason : null,
              resolvedName: result.status === "resolved" ? result.name : null,
              attempts: (priors.get(target.uriHash)?.attempts ?? 0) + 1,
            },
          ],
        });
        tally.read += 1;
        if (result.status === "resolved") {
          tally.resolved += 1;
          tally.entriesNamed += await nameEntries(db, source.id, target.uriHash, result.name, day);
        } else if (result.status === "no_name") tally.noName += 1;
        else tally.failed += 1;
      }
    }
    if (tally.entriesNamed > 0) invalidateDirectoryReadsSoftly();
    const result: RobinhoodNamesResult = { state: "completed", considered: reviewed.length + queued.length, ...tally, ms: deps.now() - started };
    if (tally.read > 0 || tally.discovered > 0 || (tally.chain !== null && tally.chain !== "read")) console.log(JSON.stringify({ event: "nooscape_robinhood_names", ...result }));
    return result;
  } catch (error) {
    logFailure(error instanceof Error ? error.message : "unknown error");
    return { state: "unavailable" };
  } finally {
    running = false;
  }
}
