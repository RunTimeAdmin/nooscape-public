import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentDirectoryEntries, agentRegistrationResolutions, ingestionSources, type IngestionSource } from "../drizzle/schema";
import { getDb, requireDb, upsertAgentRegistrationResolutions } from "./db";
import { createRegistrationNameResolver, RESOLUTION_FAILED_MAX_ATTEMPTS, RESOLUTION_NO_NAME_MAX_ATTEMPTS, type RegistrationNameResult, type RegistrationUriKind } from "./ingestion/registrationFetch";
import { SAID_CHAIN_SOURCE_KEY } from "./ingestion/saidChain";
import { sanitizePublicText } from "./publicText";
import { invalidateDirectoryReadsSoftly } from "./readCache";
import { entryNameNote, NAME_RETRY_AFTER_MS, pickBalanced, SHOWN_NAME_MAX_CHARS, type NameableRecord } from "./robinhoodNamesCore";
import { queuedAt, SAID_PLACEHOLDER_PATTERN, saidLinksToQueue, type SaidNameLink, type SaidResolvedName } from "./saidNamesCore";
import { stepIntervalGateMs } from "./stepInterval";

/**
 * The SAID name step of the worker (docs/approvals/2026-10-18-said-names.md). An identity in the SAID registry on Solana carries no
 * name on the chain, only a metadata link, so its directory entry is called "SAID agent <first 8 of the owner wallet>". The link
 * names a small card (about 300 bytes, with a `name` field) that the registrant publishes, mostly on SAID's own host. The SAID pass
 * puts the link of every identity it reads into `agent_registration_resolutions`, the table the 8004 and Robinhood readers use,
 * newest identity first (`queueSaidNameLinks`), and this step reads them a few at a time through the same safe fetch and manners as
 * those two (https only, the host's robots.txt first, a second between two requests to a host, 5 seconds, 256 KiB, the
 * Nooscape-Checker user agent, an ipfs link asked of the configured IPFS gateway), keeps each try, and writes a name that was read
 * onto the entries that carry the link, only where the name is still the placeholder, with a sentence in the entry's note that says
 * when it was read. A link is tried again no sooner than six hours after its last try and never past the other readers' tries.
 *
 * The SAID pass writes every identity's name every hour, so it lays the names that were read over its drafts before it writes them
 * (`applySaidNames`, saidNamesCore.ts); this step makes a name show at once, the pass makes it stay.
 *
 * The name is the registrant's own claim. The step never throws, asks the database before it asks anyone, and a failure is one log
 * line. It needs no migration and no new source: it reads only addresses the registrations themselves name.
 */

export const SAID_NAMES_BUDGET_MS = 25_000;
/** Cards read in one run. */
export const SAID_NAMES_MAX_PER_RUN = 20;
/** The most of them from any one host in one run. SAID's own card host holds nearly all of them, so this is the run's size. */
export const SAID_NAMES_MAX_PER_HOST = 20;
/** A run at most every 30 minutes. The gate between two runs is a little under this (`stepIntervalGateMs`), so a tick's step starting a minute early is not skipped. */
export const SAID_NAMES_INTERVAL_MS = 30 * 60 * 1000;
/** The worker does not start the step when its own tick has already run this long (the reasons are in robinhoodNames.ts). */
export const SAID_NAMES_TICK_LIMIT_MS = 100_000;

export type SaidNamesDeps = {
  now: () => number;
  /** Reads one card for a name. Tests replace it; by default it is the shared name reader. */
  resolve?: (uri: string, kind: RegistrationUriKind) => Promise<RegistrationNameResult>;
  /** The step stops starting new reads after this long. */
  budgetMs: number;
  maxNames: number;
  maxPerHost: number;
  /** A run does nothing when the last one started less than this long ago. 0 means always. */
  intervalMs: number;
};

type SaidNamesResult =
  | { state: "busy" | "idle" | "unavailable" | "no_source" | "too_late" }
  | { state: "completed"; considered: number; read: number; resolved: number; noName: number; failed: number; entriesNamed: number; stoppedBy: string | null; ms: number };

let running = false;
let lastStartedAt = 0;

/** Forgets when the step last ran (tests). */
export function resetSaidNamesClock() {
  lastStartedAt = 0;
}

const logFailure = (message: string) => console.error(JSON.stringify({ event: "nooscape_said_names_failed", message: message.replace(/[\r\n]+/g, " ").slice(0, 400) }));

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** The names that were read for a source's links, by the hash of each link, with the day each was read. The pass lays these over its drafts. */
export async function readSaidResolvedNames(sourceId: string): Promise<Map<string, SaidResolvedName>> {
  const db = requireDb(await getDb());
  const rows = await db
    .select({ uriHash: agentRegistrationResolutions.uriHash, resolvedName: agentRegistrationResolutions.resolvedName, fetchedAt: agentRegistrationResolutions.fetchedAt, lastAttemptAt: agentRegistrationResolutions.lastAttemptAt })
    .from(agentRegistrationResolutions)
    .where(and(eq(agentRegistrationResolutions.sourceId, sourceId), eq(agentRegistrationResolutions.status, "resolved")));
  const names = new Map<string, SaidResolvedName>();
  for (const row of rows) if (row.resolvedName) names.set(row.uriHash, { name: row.resolvedName, readOn: (row.fetchedAt ?? row.lastAttemptAt).toISOString().slice(0, 10) });
  return names;
}

/**
 * Queues the links of the identities the pass just read that no earlier pass queued, newest identity first. A queued link is a row
 * nobody has tried yet, due at once, dated by its place in the newest-first order. It never replaces a row that exists. Returns
 * how many links it queued.
 */
export async function queueSaidNameLinks(source: IngestionSource, links: readonly SaidNameLink[]): Promise<number> {
  if (links.length === 0) return 0;
  const db = requireDb(await getDb());
  const rows = await db.select({ uriHash: agentRegistrationResolutions.uriHash }).from(agentRegistrationResolutions).where(eq(agentRegistrationResolutions.sourceId, source.id));
  const queue = saidLinksToQueue(links, new Set(rows.map(row => row.uriHash)));
  const chunkSize = 2_000;
  for (let index = 0; index < queue.length; index += chunkSize) {
    await db
      .insert(agentRegistrationResolutions)
      .ignore()
      .values(
        queue.slice(index, index + chunkSize).map(row => ({
          id: randomUUID(),
          sourceId: source.id,
          externalKey: row.externalKey,
          uriHash: row.uriHash,
          uriKind: row.uriKind,
          uri: row.uri,
          status: "failed" as const,
          failReason: "not read yet",
          resolvedName: null,
          attempts: 0,
          lastAttemptAt: queuedAt(row.rank),
        }))
      );
  }
  return queue.length;
}

/** Writes a name onto the entries that carry this link and still have the placeholder, and says when it was read. Returns how many entries it named. */
async function nameEntries(db: Db, sourceId: string, uriHash: string, rawName: string, day: string): Promise<number> {
  const name = sanitizePublicText(rawName, SHOWN_NAME_MAX_CHARS);
  if (name === null) return 0;
  const [header] = await db
    .update(agentDirectoryEntries)
    .set({ displayName: name, sourceSignalNote: sql`LEFT(CONCAT(COALESCE(${agentDirectoryEntries.sourceSignalNote}, ''), ${entryNameNote(day)}), 512)` })
    .where(and(eq(agentDirectoryEntries.sourceId, sourceId), eq(agentDirectoryEntries.profileUriHash, uriHash), sql`${agentDirectoryEntries.displayName} REGEXP ${SAID_PLACEHOLDER_PATTERN}`));
  return Number((header as unknown as { affectedRows?: number }).affectedRows ?? 0);
}

/** Runs the name step once. Never throws. */
export async function runSaidNames(overrides: Partial<SaidNamesDeps> & { tickStartedAt?: number } = {}): Promise<SaidNamesResult> {
  if (running) return { state: "busy" };
  const deps: SaidNamesDeps = { now: () => Date.now(), budgetMs: SAID_NAMES_BUDGET_MS, maxNames: SAID_NAMES_MAX_PER_RUN, maxPerHost: SAID_NAMES_MAX_PER_HOST, intervalMs: SAID_NAMES_INTERVAL_MS, ...overrides };
  const started = deps.now();
  if (overrides.tickStartedAt !== undefined && started - overrides.tickStartedAt > SAID_NAMES_TICK_LIMIT_MS) return { state: "too_late" };
  if (deps.intervalMs > 0 && lastStartedAt !== 0 && started - lastStartedAt < stepIntervalGateMs(deps.intervalMs)) return { state: "idle" };
  running = true;
  try {
    const database = await getDb();
    if (!database) return { state: "unavailable" };
    const db = requireDb(database);
    const [source] = await db
      .select()
      .from(ingestionSources)
      .where(and(eq(ingestionSources.sourceKey, SAID_CHAIN_SOURCE_KEY), eq(ingestionSources.protocol, "solana_said"), eq(ingestionSources.state, "active")))
      .limit(1);
    if (!source) return { state: "no_source" };
    lastStartedAt = started;
    const day = new Date(started).toISOString().slice(0, 10);

    // The links never tried come first (oldest date first, which is newest identity first), then those due for another try. A link
    // counts only while an entry still carries it and is still called by the placeholder, so a card that an identity has since moved
    // away from, or that was named another way, is not read.
    const due = await db
      .select({
        externalKey: agentRegistrationResolutions.externalKey,
        uriHash: agentRegistrationResolutions.uriHash,
        uriKind: agentRegistrationResolutions.uriKind,
        uri: agentRegistrationResolutions.uri,
        status: agentRegistrationResolutions.status,
        attempts: agentRegistrationResolutions.attempts,
      })
      .from(agentRegistrationResolutions)
      .innerJoin(
        agentDirectoryEntries,
        and(eq(agentDirectoryEntries.sourceId, agentRegistrationResolutions.sourceId), eq(agentDirectoryEntries.externalKey, agentRegistrationResolutions.externalKey), eq(agentDirectoryEntries.profileUriHash, agentRegistrationResolutions.uriHash))
      )
      .where(
        and(
          eq(agentRegistrationResolutions.sourceId, source.id),
          or(
            and(eq(agentRegistrationResolutions.status, "failed"), lt(agentRegistrationResolutions.attempts, RESOLUTION_FAILED_MAX_ATTEMPTS)),
            and(eq(agentRegistrationResolutions.status, "no_name"), lt(agentRegistrationResolutions.attempts, RESOLUTION_NO_NAME_MAX_ATTEMPTS))
          ),
          lte(agentRegistrationResolutions.lastAttemptAt, new Date(started - NAME_RETRY_AFTER_MS)),
          inArray(agentRegistrationResolutions.uriKind, ["web", "ipfs"]),
          sql`${agentDirectoryEntries.displayName} REGEXP ${SAID_PLACEHOLDER_PATTERN}`
        )
      )
      .orderBy(asc(agentRegistrationResolutions.attempts), asc(agentRegistrationResolutions.lastAttemptAt))
      .limit(400);
    const candidates: NameableRecord[] = due.map(row => ({ agentId: row.externalKey, externalKey: row.externalKey, uri: row.uri, kind: row.uriKind as RegistrationUriKind, uriHash: row.uriHash }));
    const attemptsOf = new Map(due.map(row => [row.uriHash, row.attempts]));
    const batch = pickBalanced(candidates, deps.maxNames, deps.maxPerHost);

    const tally = { read: 0, resolved: 0, noName: 0, failed: 0, entriesNamed: 0, stoppedBy: null as string | null };
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
              attempts: (attemptsOf.get(target.uriHash) ?? 0) + 1,
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
    const result: SaidNamesResult = { state: "completed", considered: candidates.length, ...tally, ms: deps.now() - started };
    if (tally.read > 0) console.log(JSON.stringify({ event: "nooscape_said_names", ...result }));
    return result;
  } catch (error) {
    logFailure(error instanceof Error ? error.message : "unknown error");
    return { state: "unavailable" };
  } finally {
    running = false;
  }
}
