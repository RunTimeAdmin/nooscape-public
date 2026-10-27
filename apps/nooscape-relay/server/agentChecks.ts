import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, like, max } from "drizzle-orm";
import { agentChecks, agentEndpoints, ingestionSources, sourceObservationRuns, sourceObservations, sourceProjectionDecisions } from "../drizzle/schema";
import { getDb, listLiveAtlasRecords, requireDb } from "./db";
import { isCircuitOpenError } from "./dbBreaker";
import { isMissingTable } from "./driverErrors";
import { createPoliteFetcher } from "./politeFetch";
import type { SafeFetchReason, SafeFetchResult } from "./safeFetch";

/**
 * Liveness checks (docs/agent-checks-2026-10-16.md). Nooscape-Checker asks the endpoints that reviewed agents declare
 * whether they answer, and records the fact with its date: that an answer came, its status, how long it took and a
 * fingerprint of the first 4 KiB. A check never changes a tier, whether an agent is listed, its order or its place on the
 * map, and what it finds is never a verdict (docs/approvals/2026-10-15-informational-use-and-bnb-map.md).
 *
 * Which endpoints: those of the agents in the served reviewed set (the set the public reads serve, withdrawals included)
 * that the approved version of a reviewed A2A source declares. An endpoint row is asked only when its own observation
 * belongs to the run the operator approved for its source, the source's decision is public and the source is active, which
 * is the gate the public reads use, and only when its source is one of CHECKABLE_SOURCE_PROTOCOLS. A URL that an unreviewed
 * run introduced is not asked until that run is approved, and one the approved version no longer declares stops being asked
 * when the next run is. Only https ones are asked. An address that several endpoints share is asked once and recorded for each.
 * How often: an address is due when it has never been checked or the latest check of any endpoint that declares it is a day
 * old. The cron job that calls this can run as often as the owner likes; it only changes how soon a due address is reached.
 * How much: at most 40 addresses a run, none started after 20 seconds, five at a time, through the polite fetcher (robots.txt
 * first, a second between two requests to a host, a budget).
 *
 * Nothing here asks a host anything unless the result can be recorded: which addresses are due is read from the checks table,
 * so a run that cannot read it ("unavailable") sends nothing, and a row that cannot be written stops the run. This process
 * also remembers what it asked, so if writes keep failing the same address is not asked again within a day. It never throws,
 * and a failure is logged with its reason and never an address.
 *
 * What the agent's page shows (readPublicChecks): the latest check of each endpoint the run would ask for that agent, through
 * the same gate, so a check of an endpoint the approved version no longer declares, of a paused source or of a run nobody
 * approved is not shown. A line is the host (not the address), the date, and whether it answered, with its status and time.
 * An ask that a rule stopped is not shown, nor are the reason and the fingerprint, and if the latest ask of an endpoint was
 * stopped by a rule (a site that has since put Nooscape-Checker in its robots.txt) an older answer is not shown in its place.
 * A line also says whether the last three asks of that endpoint, in a row, got no answer (`failing`). That is the one place a
 * miss is more than a single fact with a date, and an answer, or an ask a rule stopped, in between starts the count again.
 */

export const CHECK_KIND = "liveness";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHECKS_PER_RUN = 40;
/**
 * No address is started after this long into a run. One address can take about 25 seconds from its start (a redirect through
 * new hosts reads each host's robots.txt, each with its own 5 seconds), and a write can wait for a connection, so the window
 * is well short of the CDN's minute.
 */
export const CHECKS_START_WINDOW_MS = 20_000;
/**
 * The sources whose endpoints are asked. An A2A agent card declares the service address of the agent that publishes it,
 * at a host the operator approved. Another source can record an endpoint too (the Metaplex pass records a route on
 * api.metaplex.com for its agents), and that is not an address the agent declared: it is not asked.
 */
export const CHECKABLE_SOURCE_PROTOCOLS = ["a2a"] as const;
const CONCURRENCY = 5;
/** A page, its robots.txt and a redirect or two for each address, with room to spare. */
const REQUESTS_PER_ADDRESS = 3;

export type CheckOutcome = "answered" | "no_answer" | "skipped";
type CheckFacts = { outcome: CheckOutcome; reason: SafeFetchReason | null; statusCode: number | null; latencyMs: number | null; bodySha256: string | null };
export type CheckRow = CheckFacts & { id: string; agentId: string; endpointId: string; kind: string; checkedAt: Date };
export type CheckableEndpoint = { endpointId: string; agentId: string; url: string; lastCheckedAt: Date | null };
/** One address and the endpoint rows that declare it. `lastCheckedAt` is the latest check of any of them. */
type AddressGroup = { url: string; host: string; endpoints: CheckableEndpoint[]; lastCheckedAt: Date | null };

/**
 * What an agent's page shows of one check: the host and not the address, with no reason and no fingerprint. `failing` is true
 * when the last PUBLIC_CHECKS_FAILING_AFTER asks of the endpoint, in a row, got no answer.
 */
export type PublicCheck = { host: string; checkedAt: Date; outcome: "answered" | "no_answer"; statusCode: number | null; latencyMs: number | null; failing: boolean };
/** One check of an endpoint, as the page reads it. The read gives the newest few of each endpoint. */
export type LatestCheck = { endpointId: string; outcome: string; statusCode: number | null; latencyMs: number | null; checkedAt: Date };
export type PublicChecksDeps = {
  endpointsOf: ChecksDeps["endpointsOf"];
  latestRows: (endpointIds: string[]) => Promise<LatestCheck[]>;
};
/** At most this many endpoints of one agent are read, and this many lines shown. */
export const PUBLIC_CHECKS_MAX = 10;
/** A line says failing when this many asks of an endpoint, the newest ones in a row, got no answer. The read takes this many checks of each endpoint. */
export const PUBLIC_CHECKS_FAILING_AFTER = 3;

/** The ways a host can be asked and not answer in full. Everything else that stops an ask is a rule, not the host. */
const NO_ANSWER: ReadonlySet<SafeFetchReason> = new Set<SafeFetchReason>(["timeout", "connection_failed", "tls_failed", "response_invalid", "unresolvable"]);

/**
 * What a result says, as the facts to store. An answer is any complete HTTP answer: a 404 or a 500 is one, and is a fact,
 * not a verdict. "no_answer" is a host that was asked and did not answer in full. "skipped" is an ask that was not made or
 * was stopped by a rule (robots.txt, the address, the URL, the redirects). null: the ask was not made because the run's
 * budget was spent, so there is nothing to record and the address stays due.
 */
export function factsOf(result: SafeFetchResult): CheckFacts | null {
  if (result.ok) return { outcome: "answered", reason: null, statusCode: result.status, latencyMs: result.latencyMs, bodySha256: result.bodySha256 };
  if (result.reason === "budget_exhausted") return null;
  return { outcome: NO_ANSWER.has(result.reason) ? "no_answer" : "skipped", reason: result.reason, statusCode: null, latencyMs: null, bodySha256: null };
}

export function isDue(lastCheckedAt: Date | null, now: Date): boolean {
  return lastCheckedAt === null || now.getTime() - lastCheckedAt.getTime() >= CHECK_INTERVAL_MS;
}

/**
 * The addresses to ask in this run: those not checked within a day (by any endpoint that declares them), the one checked
 * longest ago first (an address never checked first of all), then dealt out across hosts one at a time so a host with many
 * endpoints cannot hold up the rest, and cut at `limit`. `skip` holds an address back (one this process asked within the
 * day): it is left out of the run, and counted in `heldBack` only if the database still says it is due, which means the row of
 * its last ask was lost. `totalDue` counts every due address that was not held back, whatever the limit.
 */
export function dueAddresses(endpoints: CheckableEndpoint[], now: Date, limit: number, skip: (url: string) => boolean = () => false): { run: AddressGroup[]; totalDue: number; heldBack: number } {
  const byUrl = new Map<string, AddressGroup>();
  for (const endpoint of endpoints) {
    let host: string;
    try {
      host = new URL(endpoint.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    const group = byUrl.get(endpoint.url) ?? { url: endpoint.url, host, endpoints: [], lastCheckedAt: null };
    group.endpoints.push(endpoint);
    if (endpoint.lastCheckedAt !== null && (group.lastCheckedAt === null || endpoint.lastCheckedAt > group.lastCheckedAt)) group.lastCheckedAt = endpoint.lastCheckedAt;
    byUrl.set(endpoint.url, group);
  }
  const dueByDatabase = Array.from(byUrl.values()).filter(group => isDue(group.lastCheckedAt, now));
  const due = dueByDatabase
    .filter(group => !skip(group.url))
    .sort((a, b) => (a.lastCheckedAt?.getTime() ?? -Infinity) - (b.lastCheckedAt?.getTime() ?? -Infinity) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const queues = new Map<string, AddressGroup[]>();
  for (const group of due) {
    const queue = queues.get(group.host);
    if (queue) queue.push(group);
    else queues.set(group.host, [group]);
  }
  const run: AddressGroup[] = [];
  while (run.length < limit && Array.from(queues.values()).some(queue => queue.length > 0)) {
    for (const queue of Array.from(queues.values())) {
      const group = queue.shift();
      if (group && run.length < limit) run.push(group);
    }
  }
  return { run, totalDue: due.length, heldBack: dueByDatabase.length - due.length };
}

type ChecksRunResult =
  | { state: "unavailable" }
  | { state: "busy" }
  | {
      state: "completed";
      /** Addresses due when the run began, and how many of them this run took. */
      due: number;
      taken: number;
      /**
       * Addresses the database says are due that this process held back because it asked them within the day. Above zero it
       * means rows were lost (writes failing), and it is what tells that from "nothing is due".
       */
      heldBack: number;
      asked: number;
      answered: number;
      noAnswer: number;
      skipped: number;
      /** Taken but not asked: the start window or the budget ran out. They stay due. */
      notReached: number;
      /** Rows written, and rows that could not be. */
      recorded: number;
      failedToRecord: number;
      ms: number;
    };

type PoliteFetcher = ReturnType<typeof createPoliteFetcher>;

/** What a run leans on. The database ones are the defaults below; tests replace them. */
export type ChecksDeps = {
  /** Throws when the checks table cannot be read. */
  probe: () => Promise<void>;
  servedAgentIds: () => Promise<string[]>;
  endpointsOf: (agentIds: string[]) => Promise<Array<{ endpointId: string; agentId: string; url: string }>>;
  latestChecks: (endpointIds: string[]) => Promise<Map<string, Date>>;
  record: (rows: CheckRow[]) => Promise<void>;
  fetcher: () => PoliteFetcher;
  now: () => Date;
  /** A clock that cannot be set back, in milliseconds. */
  clock: () => number;
  id: () => string;
  /** When this process last asked each address, by the clock above. Kept whether or not the row could be written. */
  askedAt: Map<string, number>;
  limit: number;
  startWindowMs: number;
};

const chunk = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const databaseDeps: Pick<ChecksDeps, "probe" | "servedAgentIds" | "endpointsOf" | "latestChecks" | "record"> = {
  async probe() {
    const db = requireDb(await getDb());
    await db.select({ id: agentChecks.id }).from(agentChecks).limit(1);
  },
  async servedAgentIds() {
    return (await listLiveAtlasRecords()).map(record => record.agentId);
  },
  async endpointsOf(agentIds) {
    const db = requireDb(await getDb());
    const found = new Map<string, { endpointId: string; agentId: string; url: string }>();
    for (const ids of chunk(agentIds, 500)) {
      // The gate the public reads use, applied to the endpoint's own observation: the source is active, its decision is
      // public, and the observation belongs to the run the operator approved. Then the source has to be one that is asked.
      const rows = await db
        .select({ endpointId: agentEndpoints.id, agentId: agentEndpoints.agentId, url: agentEndpoints.endpointUrl })
        .from(agentEndpoints)
        .innerJoin(sourceObservations, eq(sourceObservations.id, agentEndpoints.sourceObservationId))
        .innerJoin(sourceProjectionDecisions, and(eq(sourceProjectionDecisions.sourceId, sourceObservations.sourceId), eq(sourceProjectionDecisions.state, "public"), isNotNull(sourceProjectionDecisions.approvedRunId)))
        .innerJoin(sourceObservationRuns, and(eq(sourceObservationRuns.runId, sourceProjectionDecisions.approvedRunId), eq(sourceObservationRuns.observationId, agentEndpoints.sourceObservationId)))
        .innerJoin(ingestionSources, and(eq(ingestionSources.id, sourceObservations.sourceId), eq(ingestionSources.state, "active"), inArray(ingestionSources.protocol, [...CHECKABLE_SOURCE_PROTOCOLS])))
        .where(and(inArray(agentEndpoints.agentId, ids), like(agentEndpoints.endpointUrl, "https://%")));
      for (const row of rows) found.set(row.endpointId, row);
    }
    return Array.from(found.values());
  },
  async latestChecks(endpointIds) {
    const db = requireDb(await getDb());
    const latest = new Map<string, Date>();
    for (const ids of chunk(endpointIds, 500)) {
      const rows = await db
        .select({ endpointId: agentChecks.endpointId, last: max(agentChecks.checkedAt) })
        .from(agentChecks)
        .where(and(eq(agentChecks.kind, CHECK_KIND), inArray(agentChecks.endpointId, ids)))
        .groupBy(agentChecks.endpointId);
      for (const row of rows) if (row.last) latest.set(row.endpointId, new Date(row.last));
    }
    return latest;
  },
  async record(rows) {
    const db = requireDb(await getDb());
    await db.insert(agentChecks).values(rows);
  },
};

const databasePublicDeps: PublicChecksDeps = {
  endpointsOf: databaseDeps.endpointsOf,
  async latestRows(endpointIds) {
    const db = requireDb(await getDb());
    const found: LatestCheck[] = [];
    // One read of the endpoint index for each, the newest few and no more, so no history is read: an agent has an endpoint or two.
    for (const endpointId of endpointIds) {
      const rows = await db
        .select({ endpointId: agentChecks.endpointId, outcome: agentChecks.outcome, statusCode: agentChecks.statusCode, latencyMs: agentChecks.latencyMs, checkedAt: agentChecks.checkedAt })
        .from(agentChecks)
        .where(and(eq(agentChecks.kind, CHECK_KIND), eq(agentChecks.endpointId, endpointId)))
        .orderBy(desc(agentChecks.checkedAt), desc(agentChecks.id))
        .limit(PUBLIC_CHECKS_FAILING_AFTER);
      found.push(...rows);
    }
    return found;
  },
};

/** What this process asked, and when. It is what keeps a failing database from having the same addresses asked every run. */
const askedInThisProcess = new Map<string, number>();

const defaultDeps: ChecksDeps = {
  ...databaseDeps,
  fetcher: () => createPoliteFetcher({ concurrency: CONCURRENCY, budget: CHECKS_PER_RUN * REQUESTS_PER_ADDRESS }),
  now: () => new Date(),
  clock: () => performance.now(),
  id: () => randomUUID(),
  askedAt: askedInThisProcess,
  limit: CHECKS_PER_RUN,
  startWindowMs: CHECKS_START_WINDOW_MS,
};

/** A run at a time in this process. A second call while one is going answers "busy" and does nothing. */
let running = false;

const withoutParameters = (message: string) => message.split("\nparams:")[0]!;

/**
 * The reason for a failure, from the driver's own error. The ORM wraps it as "Failed query: <sql>\nparams: <values>" and
 * keeps the driver's in `cause`, so the query is cut short, the parameters are dropped, and the causes (with their codes) lead.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const causes: string[] = [];
  let cause: unknown = error.cause;
  for (let depth = 0; cause instanceof Error && depth < 3; depth += 1) {
    const code = "code" in cause && typeof cause.code === "string" ? ` (${cause.code})` : "";
    causes.push(`${withoutParameters(cause.message)}${code}`);
    cause = cause.cause;
  }
  const own = withoutParameters(error.message);
  return causes.length > 0 ? `${causes.join(" :: ")} [${own.slice(0, 80)}]` : own;
}

const logFailure = (message: string) => console.error(JSON.stringify({ event: "nooscape_checks_failed", message: message.replace(/[\r\n]+/g, " ").slice(0, 400) }));

/** Asks the addresses that are due and records what came back. Never throws. */
export async function runLivenessChecks(overrides: Partial<ChecksDeps> = {}): Promise<ChecksRunResult> {
  if (running) return { state: "busy" };
  running = true;
  const deps: ChecksDeps = { ...defaultDeps, ...overrides };
  const started = deps.clock();
  try {
    let plan: { run: AddressGroup[]; totalDue: number; heldBack: number };
    try {
      // The probe is first on purpose: with no table, nothing can be recorded and nobody is asked.
      await deps.probe();
      const served = await deps.servedAgentIds();
      const endpoints = served.length > 0 ? await deps.endpointsOf(served) : [];
      const latest = endpoints.length > 0 ? await deps.latestChecks(endpoints.map(endpoint => endpoint.endpointId)) : new Map<string, Date>();
      for (const [url, at] of Array.from(deps.askedAt.entries())) if (started - at >= CHECK_INTERVAL_MS) deps.askedAt.delete(url);
      plan = dueAddresses(
        endpoints.map(endpoint => ({ ...endpoint, lastCheckedAt: latest.get(endpoint.endpointId) ?? null })),
        deps.now(),
        deps.limit,
        url => deps.askedAt.has(url)
      );
    } catch (error) {
      logFailure(describeFailure(error));
      return { state: "unavailable" };
    }

    const counts = { asked: 0, answered: 0, noAnswer: 0, skipped: 0, recorded: 0, failedToRecord: 0 };
    if (plan.run.length > 0) {
      const fetcher = deps.fetcher();
      let next = 0;
      let stop = false;
      let loggedRecordFailure = false;
      const work = async () => {
        while (!stop) {
          if (deps.clock() - started > deps.startWindowMs) return;
          const group = plan.run[next++];
          if (!group) return;
          const facts = factsOf(await fetcher.fetch(group.url));
          if (!facts) {
            stop = true;
            return;
          }
          deps.askedAt.set(group.url, deps.clock());
          counts.asked += 1;
          if (facts.outcome === "answered") counts.answered += 1;
          else if (facts.outcome === "no_answer") counts.noAnswer += 1;
          else counts.skipped += 1;
          const checkedAt = deps.now();
          const rows: CheckRow[] = group.endpoints.map(endpoint => ({ id: deps.id(), agentId: endpoint.agentId, endpointId: endpoint.endpointId, kind: CHECK_KIND, checkedAt, ...facts }));
          try {
            await deps.record(rows);
            counts.recorded += rows.length;
          } catch (error) {
            // Nothing more is asked that may not be recorded: an address whose answer is lost is not asked again for a day.
            counts.failedToRecord += rows.length;
            stop = true;
            if (!loggedRecordFailure) {
              loggedRecordFailure = true;
              logFailure(`a check could not be recorded: ${describeFailure(error)}`);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, work));
    }

    const result: ChecksRunResult = {
      state: "completed",
      due: plan.totalDue,
      taken: plan.run.length,
      heldBack: plan.heldBack,
      asked: counts.asked,
      answered: counts.answered,
      noAnswer: counts.noAnswer,
      skipped: counts.skipped,
      notReached: plan.run.length - counts.asked,
      recorded: counts.recorded,
      failedToRecord: counts.failedToRecord,
      ms: Math.round(deps.clock() - started),
    };
    if (result.taken > 0 || result.heldBack > 0) console.log(JSON.stringify({ event: "nooscape_checks", ...result }));
    return result;
  } catch (error) {
    logFailure(describeFailure(error));
    return { state: "unavailable" };
  } finally {
    running = false;
  }
}

/** The host of an address as the page shows it: lower case, without the trailing dot that the fetch also strips. */
const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
};

/** True when the newest asks of one endpoint, as many as the page waits for, all got no answer. An answer, or an ask a rule stopped, in between breaks it. */
const missedInARow = (newestFirst: LatestCheck[]): boolean =>
  newestFirst.length >= PUBLIC_CHECKS_FAILING_AFTER && newestFirst.slice(0, PUBLIC_CHECKS_FAILING_AFTER).every(row => row.outcome === "no_answer");

/**
 * The checks an agent's page shows, newest first, one line for a host. The caller has to have found the agent in the served
 * reviewed set (this does not look that up again). Never throws: if the table is not there or the database is unreachable the
 * answer is an empty list, so a failing read cannot take the record down with it.
 */
export async function readPublicChecks(agentId: string, overrides: Partial<PublicChecksDeps> = {}): Promise<PublicCheck[]> {
  const deps: PublicChecksDeps = { ...databasePublicDeps, ...overrides };
  try {
    const endpoints = [...(await deps.endpointsOf([agentId]))].sort((a, b) => (a.endpointId < b.endpointId ? -1 : a.endpointId > b.endpointId ? 1 : 0)).slice(0, PUBLIC_CHECKS_MAX);
    // An agent with nothing to ask has no checks, and the checks table is not read for it.
    if (endpoints.length === 0) return [];
    // Each endpoint's newest few checks. The newest decides the line, and the few decide whether it says failing.
    const rowsOf = new Map<string, LatestCheck[]>();
    for (const row of await deps.latestRows(endpoints.map(endpoint => endpoint.endpointId))) rowsOf.set(row.endpointId, [...(rowsOf.get(row.endpointId) ?? []), row]);
    // A host is shown by its newest check, whichever of its endpoints that was for. If that check was stopped by a rule (robots.txt
    // covers the whole host) or is of an outcome this does not know, the host is not shown at all, and no older answer stands in.
    const newest = new Map<string, { at: number; shown: PublicCheck | null }>();
    for (const endpoint of endpoints) {
      const rows = (rowsOf.get(endpoint.endpointId) ?? []).sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
      const row = rows[0];
      const host = hostOf(endpoint.url);
      if (!row || !host) continue;
      const at = row.checkedAt.getTime();
      const seen = newest.get(host);
      if (seen && seen.at >= at) continue;
      let shown: PublicCheck | null = null;
      if (row.outcome === "answered") shown = { host, checkedAt: row.checkedAt, outcome: "answered", statusCode: row.statusCode, latencyMs: row.latencyMs, failing: false };
      else if (row.outcome === "no_answer") shown = { host, checkedAt: row.checkedAt, outcome: "no_answer", statusCode: null, latencyMs: null, failing: missedInARow(rows) };
      newest.set(host, { at, shown });
    }
    const lines: PublicCheck[] = [];
    for (const { shown } of Array.from(newest.values())) if (shown) lines.push(shown);
    return lines.sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime() || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  } catch (error) {
    if (!isMissingTable(error) && !isCircuitOpenError(error)) console.warn("[LiveData] agent checks read failed:", describeFailure(error));
    return [];
  }
}
