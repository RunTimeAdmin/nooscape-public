import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { agentDirectoryEntries, agentRegistrationResolutions, ingestionSources, type IngestionSource } from "../drizzle/schema";
import { agentIdOfKey, NAME_CHAINS, newestKeyFirst, usableName } from "./chainNamesCore";
import { getDb, requireDb, upsertAgentRegistrationResolutions } from "./db";
import { assertPublicHostname } from "./ingestion/a2a";
import { decodeTokenUris, encodeTokenUriMulticall, MULTICALL3, MULTICALL_MAX_READS } from "./ingestion/bscMulticall";
import { erc8004ChainOn, type Erc8004Chain } from "./ingestion/erc8004Chains";
import { callRpc, Erc8004RpcBusyError, Erc8004RpcHttpError, resolveRpcUrl } from "./ingestion/erc8004Rpc";
import {
  createRegistrationNameResolver,
  RESOLUTION_FAILED_MAX_ATTEMPTS,
  RESOLUTION_NO_NAME_MAX_ATTEMPTS,
  type RegistrationNameResult,
  type RegistrationUriKind,
} from "./ingestion/registrationFetch";
import { invalidateDirectoryReadsSoftly } from "./readCache";
import { NAMES_INTERVAL_MS, NAMES_MAX_PER_HOST, NAMES_MAX_PER_RUN, NAMES_TICK_LIMIT_MS } from "./robinhoodNames";
import { ENTRY_PLACEHOLDER_PATTERN, entryNameNote, entryUriFacts, NAME_RETRY_AFTER_MS, pickBalanced } from "./robinhoodNamesCore";
import { stepIntervalGateMs } from "./stepInterval";

/**
 * The Base, Arc and Ethereum name step of the worker (docs/approvals/2026-10-26-base-arc-names.md, extended to Ethereum on 2026-10-27).
 * A registration on these chains whose link is a web address or an ipfs address carries no name on the chain, so its directory
 * entry is called "Agent #<n>". The step finds the name in the file the link names, in the same three parts as the Robinhood entry
 * names (docs/approvals/2026-10-17-robinhood-entry-names.md), and takes one chain a run in turn:
 *
 *  1. Healing. An entry that shows the placeholder, whose link already has a name that was read, gets that name at once, with no
 *     request. The listing publishes an entry again from its registry row when a registration leaves the listing and comes back, and
 *     the row carries the placeholder.
 *  2. Discovery, from the chain. The registry rows keep the SHA-256 of each link and not the link, so for up to `maxDiscover` entries
 *     that show the placeholder and have no row in `agent_registration_resolutions` yet, newest first, it reads `tokenURI` from the
 *     chain's own node in one `eth_call` through Multicall3 at the finalized block (one attempt; a throttled node pauses the chain's
 *     reads for hours). A link counts only when its hash is the one the registry row recorded, so a name comes from the very link the
 *     listing was made from. A web or ipfs link is queued; a link that holds its own JSON with a name in it (the pass names an entry from
 *     the link it was registered with, and not from one set afterwards) gives that name at once; anything else, and a link that is not
 *     the recorded one, is recorded as settled so it is not read from the chain again.
 *  3. Reading. The queued links, through the same safe fetch and manners as the Robinhood and SAID name reads (https only, the host's
 *     robots.txt first, a second between two requests to a host, 5 seconds, 256 KiB, the Nooscape-Checker user agent, an ipfs link
 *     asked of the configured IPFS gateway), at most `NAMES_MAX_PER_RUN` files a run and `NAMES_MAX_PER_HOST` for any one host, newest
 *     first. Each try is kept in `agent_registration_resolutions`, so there is no migration; a link is tried again no sooner than six
 *     hours after its last try and never past the other readers' tries. A name that was read is written to the entry only where
 *     the name is still the placeholder, with a sentence in the entry's note that says when it was read.
 *
 * Nothing but the name is kept from a file. The name is the registrant's own claim. The step never throws, asks the database before it
 * asks anyone, and a failure is one log line.
 */

const CHAIN_NAMES_BUDGET_MS = 20_000;
/** Entries whose link is read from the chain in one run: one multicall. */
const CHAIN_NAMES_MAX_DISCOVER = 16;
/** Names laid over placeholders from links that were already read, in one run. */
const CHAIN_NAMES_MAX_HEAL = 50;
/** Chain reads stop for this long after the node says it is limiting its callers (403, 429 or a busy answer), and for the shorter one after any other failure. */
const CHAIN_BACKOFF_MS = 2 * 60 * 60 * 1000;
const CHAIN_SHORT_BACKOFF_MS = 30 * 60 * 1000;
/** MySQL's TIMESTAMP starts one second after the epoch. A link queued but not yet tried carries this date so it is due at once. */
const NOT_TRIED_YET = new Date(1000);

export type ChainNamesDeps = {
  now: () => number;
  /** Reads one registration link for a name. Tests replace it; by default it is the shared name reader. */
  resolve?: (uri: string, kind: RegistrationUriKind) => Promise<RegistrationNameResult>;
  /** Reads the `tokenURI` of each agent id from the chain: a string, or null where the read failed, in order. Tests replace it. */
  readUris?: (chain: Erc8004Chain, source: IngestionSource, ids: string[]) => Promise<Array<string | null> | null>;
  /** The chains to take turns over. Tests narrow it. */
  chains: readonly Erc8004Chain[];
  /** The value of VITE_FEATURES that says which chains are on. Absent: the environment's. Tests replace it. */
  features?: string;
  /** The step stops starting new reads after this long. */
  budgetMs: number;
  maxNames: number;
  maxPerHost: number;
  maxDiscover: number;
  /** A run does nothing when the last one started less than this long ago. 0 means always. */
  intervalMs: number;
};

type Tally = {
  healed: number;
  discovered: number;
  queued: number;
  settled: number;
  read: number;
  resolved: number;
  noName: number;
  failed: number;
  entriesNamed: number;
  stoppedBy: string | null;
  /** What the chain read did: read, paused, throttled, failed, or skipped (the stored source is not the approved node). Null when none was needed. */
  chainRead: string | null;
};

type ChainNamesResult =
  | { state: "busy" | "idle" | "unavailable" | "no_source" | "too_late" }
  | ({ state: "completed"; chain: string | null; ms: number } & Tally);

let running = false;
let lastStartedAt = 0;
let turn = 0;
const chainPausedUntil = new Map<string, number>();

/** Forgets when the step last ran, whose turn it is and any pause of the chain reads (tests). */
export function resetChainNamesClock() {
  lastStartedAt = 0;
  turn = 0;
  chainPausedUntil.clear();
}

const logFailure = (message: string) => console.error(JSON.stringify({ event: "nooscape_chain_names_failed", message: message.slice(0, 400) }));

const emptyTally = (): Tally => ({ healed: 0, discovered: 0, queued: 0, settled: 0, read: 0, resolved: 0, noName: 0, failed: 0, entriesNamed: 0, stoppedBy: null, chainRead: null });

/**
 * One `eth_call` through Multicall3 for the `tokenURI` of each id, on this chain's own node, at the finalized block (the pass reads
 * finalized blocks only, so this is the state its rows were made from). One attempt: a throttle is waited out between runs, not
 * inside one. The endpoint is the pass's, checked as the pass checks it (the variable's host is the source row's host, and the host
 * is a public one), and is never logged. `call` is replaceable for tests.
 */
export async function readTokenUrisFromChain(chain: Erc8004Chain, source: IngestionSource, ids: string[], call: typeof callRpc = callRpc): Promise<Array<string | null> | null> {
  const url = resolveRpcUrl(chain, source.allowedHostname);
  try {
    await assertPublicHostname(source.allowedHostname);
  } catch (error) {
    // The shared check speaks of an "A2A hostname"; say what was being checked here.
    throw new Error(`The ${chain.chainLabel} RPC host failed the public-network check: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const oneAttempt: Erc8004Chain = { ...chain, rpc: { ...chain.rpc, backoffMs: [] } };
  const answer = await call(oneAttempt, "eth_call", [{ to: MULTICALL3, data: encodeTokenUriMulticall(ids, chain.identityRegistry) }, "finalized"], { url });
  return decodeTokenUris(answer, ids.length);
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const placeholderSql = () => sql`${agentDirectoryEntries.displayName} REGEXP ${ENTRY_PLACEHOLDER_PATTERN}`;

/** Writes a name onto the entries that carry this link and still have the placeholder, and says when it was read. Returns how many entries it named. */
async function nameEntries(db: Db, sourceId: string, uriHash: string, rawName: string, day: string): Promise<number> {
  const name = usableName(rawName);
  if (name === null) return 0;
  const [header] = await db
    .update(agentDirectoryEntries)
    .set({ displayName: name, sourceSignalNote: sql`LEFT(CONCAT(COALESCE(${agentDirectoryEntries.sourceSignalNote}, ''), ${entryNameNote(day)}), 512)` })
    .where(and(eq(agentDirectoryEntries.sourceId, sourceId), eq(agentDirectoryEntries.profileUriHash, uriHash), placeholderSql()));
  return Number((header as unknown as { affectedRows?: number }).affectedRows ?? 0);
}

/** Part 1: lays the names that were read over the placeholders of entries whose link already has one. No request. */
async function heal(db: Db, source: IngestionSource, tally: Tally, day: string) {
  const rows = await db
    .select({ uriHash: agentRegistrationResolutions.uriHash, resolvedName: agentRegistrationResolutions.resolvedName })
    .from(agentDirectoryEntries)
    .innerJoin(
      agentRegistrationResolutions,
      and(
        eq(agentRegistrationResolutions.sourceId, agentDirectoryEntries.sourceId),
        eq(agentRegistrationResolutions.uriHash, agentDirectoryEntries.profileUriHash),
        eq(agentRegistrationResolutions.status, "resolved")
      )
    )
    .where(and(eq(agentDirectoryEntries.sourceId, source.id), eq(agentDirectoryEntries.hidden, false), placeholderSql(), isNotNull(agentRegistrationResolutions.resolvedName)))
    .limit(CHAIN_NAMES_MAX_HEAL);
  for (const row of rows) {
    const named = await nameEntries(db, source.id, row.uriHash, row.resolvedName!, day);
    tally.healed += named;
    tally.entriesNamed += named;
  }
}

/** The source row records the node the chain's own entry approves (the same test the pass makes before it reads). */
function sourceMatchesChain(chain: Erc8004Chain, source: IngestionSource): boolean {
  return source.protocol === chain.protocol && (chain.provider.kind === "pinned" ? source.rootUrl === chain.provider.rootUrl && source.allowedHostname === chain.provider.allowedHostname : source.rootUrl === `https://${source.allowedHostname}`);
}

/** Part 2: reads the links of entries that have none recorded, and records what each is. */
async function discover(db: Db, chain: Erc8004Chain, source: IngestionSource, deps: ChainNamesDeps, started: number, tally: Tally, day: string) {
  if (!sourceMatchesChain(chain, source)) {
    tally.chainRead = "skipped";
    return;
  }
  if ((chainPausedUntil.get(chain.chainKey) ?? 0) > started) {
    tally.chainRead = "paused";
    return;
  }
  const waiting = await db
    .select({ externalKey: agentDirectoryEntries.externalKey, profileUriHash: agentDirectoryEntries.profileUriHash })
    .from(agentDirectoryEntries)
    .leftJoin(
      agentRegistrationResolutions,
      and(eq(agentRegistrationResolutions.sourceId, agentDirectoryEntries.sourceId), eq(agentRegistrationResolutions.uriHash, agentDirectoryEntries.profileUriHash))
    )
    .where(and(eq(agentDirectoryEntries.sourceId, source.id), eq(agentDirectoryEntries.hidden, false), isNotNull(agentDirectoryEntries.profileUriHash), isNull(agentRegistrationResolutions.id), placeholderSql()))
    .orderBy(sql`CAST(SUBSTRING_INDEX(${agentDirectoryEntries.externalKey}, ':', -1) AS UNSIGNED) DESC`)
    .limit(Math.min(deps.maxDiscover, MULTICALL_MAX_READS));
  if (waiting.length === 0) return;

  const entries = waiting.map(row => ({ externalKey: row.externalKey, uriHash: row.profileUriHash!, id: agentIdOfKey(chain, row.externalKey) }));
  const readable = entries.filter((entry): entry is typeof entry & { id: string } => entry.id !== null);
  let uris: Array<string | null> = [];
  if (readable.length > 0) {
    let answer: Array<string | null> | null;
    try {
      answer = await (deps.readUris ?? readTokenUrisFromChain)(chain, source, readable.map(entry => entry.id));
    } catch (error) {
      const limiting = error instanceof Erc8004RpcBusyError || (error instanceof Erc8004RpcHttpError && (error.status === 403 || error.status === 429));
      chainPausedUntil.set(chain.chainKey, started + (limiting ? CHAIN_BACKOFF_MS : CHAIN_SHORT_BACKOFF_MS));
      tally.chainRead = limiting ? "throttled" : "failed";
      logFailure(`the ${chain.chainLabel} tokenURI read could not be made: ${error instanceof Error ? error.message : "unknown error"}; chain reads are paused for ${limiting ? 2 : 0.5} hours`);
      return;
    }
    if (answer === null) {
      chainPausedUntil.set(chain.chainKey, started + CHAIN_SHORT_BACKOFF_MS);
      tally.chainRead = "failed";
      logFailure(`the ${chain.chainLabel} tokenURI answer had an unexpected shape; chain reads are paused for 0.5 hours`);
      return;
    }
    uris = answer;
    tally.chainRead = "read";
  }

  // A row for every entry looked at, so none is read from the chain twice: a queued link for the ones to read, and a settled row
  // (never due, whatever its status) for the rest.
  const settledRow = (entry: { externalKey: string; uriHash: string }, status: "resolved" | "no_name" | "failed", failReason: string | null) => ({
    id: randomUUID(),
    sourceId: source.id,
    externalKey: entry.externalKey,
    uriHash: entry.uriHash,
    uriKind: "other",
    uri: "",
    status,
    failReason,
    resolvedName: null as string | null,
    attempts: status === "failed" ? RESOLUTION_FAILED_MAX_ATTEMPTS : status === "no_name" ? RESOLUTION_NO_NAME_MAX_ATTEMPTS : 1,
    lastAttemptAt: new Date(started),
    fetchedAt: (status === "resolved" ? new Date(started) : null) as Date | null,
  });
  const rows: Array<ReturnType<typeof settledRow>> = [];
  const inlineNames: Array<{ uriHash: string; name: string }> = [];
  for (const entry of entries.filter(item => item.id === null)) rows.push(settledRow(entry, "failed", "the key is not an agent id"));
  readable.forEach((entry, index) => {
    const read = uris[index] ?? null;
    const link = entryUriFacts(read);
    if (read === null) rows.push(settledRow(entry, "failed", "the chain gave no link"));
    else if (link.uriHash !== entry.uriHash) rows.push(settledRow(entry, "failed", "the link on the chain is not the one recorded"));
    else if (link.kind === "web" || link.kind === "ipfs") {
      tally.queued += 1;
      rows.push({ ...settledRow(entry, "failed", "not read yet"), uriKind: link.kind, uri: link.uri, attempts: 0, lastAttemptAt: NOT_TRIED_YET });
    } else if (link.kind === "inline" && link.name !== null && usableName(link.name) !== null) {
      // A link that holds its own JSON, set after the registration, with a name in it: the name is on the chain already, so it takes no request.
      const name = usableName(link.name)!;
      inlineNames.push({ uriHash: entry.uriHash, name });
      rows.push({ ...settledRow(entry, "resolved", null), uriKind: "inline", resolvedName: name });
    } else rows.push(settledRow(entry, "no_name", null));
  });
  tally.discovered += entries.length;
  tally.settled += rows.length - tally.queued;
  await db.insert(agentRegistrationResolutions).ignore().values(rows);
  for (const item of inlineNames) tally.entriesNamed += await nameEntries(db, source.id, item.uriHash, item.name, day);
}

/** Part 3: reads the queued links that are due, newest registration first, and names the entries they belong to. */
async function readLinks(db: Db, source: IngestionSource, deps: ChainNamesDeps, started: number, tally: Tally, day: string) {
  const due = await db
    .select({
      uriHash: agentRegistrationResolutions.uriHash,
      uriKind: agentRegistrationResolutions.uriKind,
      uri: agentRegistrationResolutions.uri,
      attempts: agentRegistrationResolutions.attempts,
    })
    .from(agentRegistrationResolutions)
    .where(
      and(
        eq(agentRegistrationResolutions.sourceId, source.id),
        or(
          and(eq(agentRegistrationResolutions.status, "failed"), lt(agentRegistrationResolutions.attempts, RESOLUTION_FAILED_MAX_ATTEMPTS)),
          and(eq(agentRegistrationResolutions.status, "no_name"), lt(agentRegistrationResolutions.attempts, RESOLUTION_NO_NAME_MAX_ATTEMPTS))
        ),
        lte(agentRegistrationResolutions.lastAttemptAt, new Date(started - NAME_RETRY_AFTER_MS)),
        inArray(agentRegistrationResolutions.uriKind, ["web", "ipfs"])
      )
    )
    .orderBy(asc(agentRegistrationResolutions.attempts), asc(agentRegistrationResolutions.lastAttemptAt))
    .limit(400);
  if (due.length === 0) return;
  // Only the links of entries that still show the placeholder are read: an entry that left the listing, was hidden or has a name needs none.
  const waiting = await db
    .select({ externalKey: agentDirectoryEntries.externalKey, profileUriHash: agentDirectoryEntries.profileUriHash })
    .from(agentDirectoryEntries)
    .where(and(eq(agentDirectoryEntries.sourceId, source.id), eq(agentDirectoryEntries.hidden, false), inArray(agentDirectoryEntries.profileUriHash, due.map(row => row.uriHash)), placeholderSql()));
  const keyOfHash = new Map(waiting.map(row => [row.profileUriHash!, row.externalKey]));
  const targets = due
    .filter(row => keyOfHash.has(row.uriHash))
    .map(row => ({ externalKey: keyOfHash.get(row.uriHash)!, uriHash: row.uriHash, uri: row.uri, kind: row.uriKind as RegistrationUriKind, attempts: row.attempts }))
    .sort((a, b) => newestKeyFirst(a.externalKey, b.externalKey));
  const batch = pickBalanced(targets, deps.maxNames, deps.maxPerHost);
  if (batch.length === 0) return;

  const resolve = deps.resolve ?? createRegistrationNameResolver(batch.length);
  const deadline = started + deps.budgetMs;
  for (const target of batch) {
    if (deps.now() >= deadline) {
      tally.stoppedBy = "time";
      break;
    }
    const result = await resolve(target.uri, target.kind);
    // A name that cleans to nothing, is only a number or reads "Agent #n" is a file with no name in it.
    const name = result.status === "resolved" ? usableName(result.name) : null;
    const status = result.status === "resolved" && name === null ? "no_name" : result.status;
    // Each try is kept as soon as it is made, so a run cut short keeps what it read.
    await upsertAgentRegistrationResolutions({
      source,
      drafts: [
        {
          externalKey: target.externalKey,
          uriHash: target.uriHash,
          uriKind: target.kind,
          uri: target.uri,
          status,
          failReason: result.status === "failed" ? result.reason : null,
          resolvedName: status === "resolved" ? name : null,
          attempts: target.attempts + 1,
        },
      ],
    });
    tally.read += 1;
    if (status === "resolved") {
      tally.resolved += 1;
      tally.entriesNamed += await nameEntries(db, source.id, target.uriHash, name!, day);
    } else if (status === "no_name") tally.noName += 1;
    else tally.failed += 1;
  }
}

/** Runs the name step once. Never throws. */
export async function runChainNames(overrides: Partial<ChainNamesDeps> & { tickStartedAt?: number } = {}): Promise<ChainNamesResult> {
  if (running) return { state: "busy" };
  const deps: ChainNamesDeps = {
    now: () => Date.now(),
    chains: NAME_CHAINS,
    budgetMs: CHAIN_NAMES_BUDGET_MS,
    maxNames: NAMES_MAX_PER_RUN,
    maxPerHost: NAMES_MAX_PER_HOST,
    maxDiscover: CHAIN_NAMES_MAX_DISCOVER,
    intervalMs: NAMES_INTERVAL_MS,
    ...overrides,
  };
  const started = deps.now();
  if (overrides.tickStartedAt !== undefined && started - overrides.tickStartedAt > NAMES_TICK_LIMIT_MS) return { state: "too_late" };
  if (deps.intervalMs > 0 && lastStartedAt !== 0 && started - lastStartedAt < stepIntervalGateMs(deps.intervalMs)) return { state: "idle" };
  running = true;
  try {
    const database = await getDb();
    if (!database) return { state: "unavailable" };
    const db = requireDb(database);
    const day = new Date(started).toISOString().slice(0, 10);
    const total = emptyTally();
    let chainSpent: string | null = null;
    let sawSource = false;
    // Take the chains in turn, starting with the one whose turn it is. A chain that asked the node or a host spends the run; one that
    // had nothing to ask (or whose node is paused) leaves the run to the next.
    for (let offset = 0; offset < deps.chains.length; offset += 1) {
      const index = (turn + offset) % deps.chains.length;
      const chain = deps.chains[index]!;
      if (!erc8004ChainOn(chain, deps.features)) continue;
      const [source] = await db
        .select()
        .from(ingestionSources)
        .where(and(eq(ingestionSources.sourceKey, chain.sourceKey), eq(ingestionSources.state, "active")))
        .limit(1);
      if (!source) continue;
      sawSource = true;
      lastStartedAt = started;
      const tally = emptyTally();
      await heal(db, source, tally, day);
      await discover(db, chain, source, deps, started, tally, day);
      await readLinks(db, source, deps, started, tally, day);
      for (const key of ["healed", "discovered", "queued", "settled", "read", "resolved", "noName", "failed", "entriesNamed"] as const) total[key] += tally[key];
      total.stoppedBy = total.stoppedBy ?? tally.stoppedBy;
      total.chainRead = total.chainRead ?? tally.chainRead;
      if (tally.chainRead === "read" || tally.read > 0) {
        chainSpent = chain.chainKey;
        turn = (index + 1) % deps.chains.length;
        break;
      }
    }
    if (!sawSource) return { state: "no_source" };
    if (total.entriesNamed > 0) invalidateDirectoryReadsSoftly();
    const result: ChainNamesResult = { state: "completed", chain: chainSpent, ...total, ms: deps.now() - started };
    if (total.read > 0 || total.discovered > 0 || total.healed > 0 || (total.chainRead !== null && total.chainRead !== "read")) console.log(JSON.stringify({ event: "nooscape_chain_names", ...result }));
    return result;
  } catch (error) {
    logFailure(error instanceof Error ? error.message : "unknown error");
    return { state: "unavailable" };
  } finally {
    running = false;
  }
}
