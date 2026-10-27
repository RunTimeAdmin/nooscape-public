import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agentDirectoryRegistryRows, bscFeedbackEvents, bscRaterEvidence, bscReputationState, ingestionSources } from "../drizzle/schema";
import { classifyRater, liveFeedback, rateAgents, raterReport, raterStats, type AgentFacts, type FeedbackEvent, type RaterClass, type RaterReport, type RegistryFacts } from "./bscRaters";
import { getDb, requireDb } from "./db";
import { BSC_CU, bscReadBucket } from "./ingestion/bscBudget";
import { bscExternalKey, planBscWindows, type BscWindow } from "./ingestion/bscChain";
import {
  BSC_REPUTATION_DEPLOY_BLOCK,
  BSC_REPUTATION_IMPL,
  BSC_REPUTATION_IMPL_SLOT,
  BSC_REPUTATION_REGISTRY,
  BSC_REPUTATION_STATE_ID,
  BSC_REPUTATION_TOPIC_FILTER,
  implementationOf,
  parseReputationWindow,
  type LedgerRow,
} from "./ingestion/bscReputation";
import { BscRpcRangeError, callBscRpc } from "./ingestion/bscRpc";
import { OWNER_FLEET_MIN } from "./bscRaters";
import { isMissingTable } from "./driverErrors";

/**
 * The rater step of the worker (docs/bsc-rater-credibility-2026-10-16.md; check F). After the sources, the Owl's Catch and the
 * clustering, it keeps three tables in step with the BNB Chain reputation registry:
 *
 *  1. It reads the registry's NewFeedback and FeedbackRevoked events from where it left off to the finalized block, in windows of
 *     50,000 blocks, paced at 75 CU/s with the clustering's reads (half of the plan's 150), and records each in
 *     `bsc_feedback_events`. It first checks that the registry still sits behind the implementation the layouts were verified
 *     against, and stops if it does not, and it stops at a log that does not decode.
 *  2. Once it has caught up, and when ratings arrived or a day has passed, it works out for each rated agent how many raters it
 *     has, how many are set aside and why, and how many independent ones are left (server/bscRaters.ts), and stores that in
 *     `bsc_rater_evidence`.
 *
 * Internal and best-effort like the clustering: nothing public reads what it writes, it never throws, it asks the database
 * before it asks the chain, and with the tables not there it does nothing and says nothing (migration 0039 is run by hand).
 * It writes only those three tables, and a rating is supporting evidence and never a reason on its own to promote an agent.
 */

export type RatersDeps = {
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  now: () => number;
  /** The step stops starting new windows after this long. */
  budgetMs: number;
  /** The most windows in one run. */
  maxWindows: number;
  /** The ratings are worked out again after this long even with nothing new, because the registry rows they are read against change. */
  reevaluateMs: number;
};

const RATERS_BUDGET_MS = 25_000;
const RATERS_MAX_WINDOWS = 40;
const RATERS_REEVALUATE_MS = 24 * 60 * 60 * 1000;
/** The worker does not start the step when its own tick has already run this long. */
const RATERS_TICK_LIMIT_MS = 90_000;

const defaultDeps = (): RatersDeps => ({
  rpc: async (method, params) => {
    await bscReadBucket.take(BSC_CU[method as keyof typeof BSC_CU] ?? 50);
    return callBscRpc(method, params);
  },
  now: () => Date.now(),
  budgetMs: RATERS_BUDGET_MS,
  maxWindows: RATERS_MAX_WINDOWS,
  reevaluateMs: RATERS_REEVALUATE_MS,
});

type RatersResult =
  | { state: "busy" | "unavailable" | "no_source" | "too_late" }
  | {
      state: "completed";
      windows: number;
      inserted: number;
      caughtUp: boolean;
      stoppedBy: string | null;
      evaluated: boolean;
      report: RaterReport | null;
      ms: number;
    };

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const chunks = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const hex = (value: number) => `0x${value.toString(16)}`;

const logFailure = (message: string) => console.error(JSON.stringify({ event: "nooscape_bsc_raters_failed", message: message.replace(/[\r\n]+/g, " ").slice(0, 400) }));

/** One window's raw logs. A result-size rejection halves the window; a block-range rejection is a planner bug and propagates. */
async function fetchWindowLogs(rpc: RatersDeps["rpc"], window: BscWindow): Promise<unknown[]> {
  try {
    const logs = await rpc("eth_getLogs", [{ address: BSC_REPUTATION_REGISTRY, fromBlock: hex(window.from), toBlock: hex(window.to), topics: BSC_REPUTATION_TOPIC_FILTER }]);
    if (!Array.isArray(logs)) throw new Error("BNB Chain reputation log response must be an array.");
    return logs;
  } catch (error) {
    if (error instanceof BscRpcRangeError && error.reason === "result_size" && window.to - window.from + 1 > 64) {
      const middle = Math.floor((window.from + window.to) / 2);
      return (await fetchWindowLogs(rpc, { from: window.from, to: middle })).concat(await fetchWindowLogs(rpc, { from: middle + 1, to: window.to }));
    }
    throw error;
  }
}

async function insertLedger(db: Db, rows: LedgerRow[]): Promise<void> {
  for (const part of chunks(rows, 500)) {
    await db
      .insert(bscFeedbackEvents)
      .ignore()
      .values(
        part.map(row => ({
          id: randomUUID(),
          transactionHash: row.transactionHash,
          logIndex: row.logIndex,
          kind: row.kind,
          blockNumber: row.blockNumber,
          agentId: row.agentId,
          clientAddress: row.client,
          feedbackIndex: row.feedbackIndex,
          valueRaw: row.valueRaw,
          valueDecimals: row.valueDecimals,
        }))
      );
  }
}

/** Reads the registry from the state's cursor towards the finalized block. Returns what it did. */
async function scan(db: Db, deps: RatersDeps, deadline: number) {
  const out = { windows: 0, inserted: 0, caughtUp: false, stoppedBy: null as string | null };
  let [state] = await db.select().from(bscReputationState).where(eq(bscReputationState.id, BSC_REPUTATION_STATE_ID)).limit(1);
  if (!state) {
    await db.insert(bscReputationState).ignore().values({ id: BSC_REPUTATION_STATE_ID, nextBlock: BSC_REPUTATION_DEPLOY_BLOCK });
    [state] = await db.select().from(bscReputationState).where(eq(bscReputationState.id, BSC_REPUTATION_STATE_ID)).limit(1);
  }
  if (!state) return out;
  try {
    // The layouts decoded below were verified against one implementation. If it has changed, nothing more is read until a person has looked.
    const implementation = implementationOf(await deps.rpc("eth_getStorageAt", [BSC_REPUTATION_REGISTRY, BSC_REPUTATION_IMPL_SLOT, "finalized"]));
    if (implementation !== BSC_REPUTATION_IMPL) {
      await db.update(bscReputationState).set({ implementation }).where(eq(bscReputationState.id, BSC_REPUTATION_STATE_ID));
      logFailure(`the reputation registry now sits behind ${implementation ?? "an address that could not be read"}, not the implementation its layouts were verified against, so it is not read`);
      out.stoppedBy = "implementation";
      return out;
    }
    const block = (await deps.rpc("eth_getBlockByNumber", ["finalized", false])) as { number?: string } | null;
    const finalized = Number.parseInt(block?.number ?? "", 16);
    if (!Number.isSafeInteger(finalized)) throw new Error("The finalized block could not be read.");
    let next = state.nextBlock;
    for (const window of planBscWindows(next, finalized, deps.maxWindows)) {
      if (deps.now() >= deadline) {
        out.stoppedBy = "time";
        break;
      }
      const logs = await fetchWindowLogs(deps.rpc, window);
      const parsed = parseReputationWindow(logs, { fromBlock: window.from, toBlock: window.to });
      if (parsed.rejected > 0) {
        logFailure(`${parsed.rejected} log(s) of the reputation registry in blocks ${window.from} to ${window.to} did not decode, so the read stopped before that window`);
        out.stoppedBy = "decode";
        break;
      }
      await insertLedger(db, parsed.rows);
      next = window.to + 1;
      await db.update(bscReputationState).set({ nextBlock: next, finalizedBlock: finalized }).where(eq(bscReputationState.id, BSC_REPUTATION_STATE_ID));
      out.windows += 1;
      out.inserted += parsed.rows.length;
    }
    out.caughtUp = next > finalized;
  } catch (error) {
    // The chain client's messages never hold the endpoint. What was read stays; the next run carries on.
    logFailure(`the reputation read stopped: ${error instanceof Error ? error.message : "unknown error"}`);
    out.stoppedBy = "chain";
  }
  return out;
}

/** The ratings in the ledger, as the check reads them. */
async function readLedger(db: Db): Promise<FeedbackEvent[]> {
  const rows = await db
    .select({
      kind: bscFeedbackEvents.kind,
      agentId: bscFeedbackEvents.agentId,
      client: bscFeedbackEvents.clientAddress,
      feedbackIndex: bscFeedbackEvents.feedbackIndex,
      valueRaw: bscFeedbackEvents.valueRaw,
      valueDecimals: bscFeedbackEvents.valueDecimals,
      blockNumber: bscFeedbackEvents.blockNumber,
      logIndex: bscFeedbackEvents.logIndex,
    })
    .from(bscFeedbackEvents);
  return rows.map(row => ({
    kind: row.kind === "revoked" ? "revoked" : "feedback",
    agentId: Number(row.agentId),
    client: row.client,
    feedbackIndex: row.feedbackIndex === null ? null : Number(row.feedbackIndex),
    valueRaw: row.valueRaw,
    valueDecimals: row.valueDecimals,
    blockNumber: row.blockNumber,
    logIndex: row.logIndex,
  }));
}

const ROWS = agentDirectoryRegistryRows;

/** What the registry rows hold about the rated agents, their owners and the raters. */
async function readRegistryFacts(db: Db, sourceId: string, agentIds: number[], raters: string[]): Promise<RegistryFacts> {
  const agents = new Map<number, AgentFacts>();
  for (const part of chunks(agentIds, 500)) {
    const rows = await db
      .select({ externalKey: ROWS.externalKey, registrant: ROWS.registrant, host: ROWS.locatorHost, linkHash: ROWS.profileUriHash })
      .from(ROWS)
      .where(and(eq(ROWS.sourceId, sourceId), inArray(ROWS.externalKey, part.map(id => bscExternalKey(`${id}`)))));
    for (const row of rows) {
      const id = Number(row.externalKey.split(":").pop());
      if (Number.isSafeInteger(id)) agents.set(id, { registrant: row.registrant, host: row.host, linkHash: row.linkHash });
    }
  }
  const wallets = Array.from(new Set([...raters, ...Array.from(agents.values()).flatMap(agent => (agent.registrant ? [agent.registrant] : []))]));
  const registrations = new Map<string, number>();
  for (const part of chunks(wallets, 500)) {
    const rows = await db
      .select({ registrant: ROWS.registrant, total: sql<number>`count(*)` })
      .from(ROWS)
      .where(and(eq(ROWS.sourceId, sourceId), inArray(ROWS.registrant, part)))
      .groupBy(ROWS.registrant);
    for (const row of rows) if (row.registrant) registrations.set(row.registrant, Number(row.total));
  }
  // The links a rater registered, for the raters that are not fleet wallets already (a fleet wallet is set aside by its size).
  const registeredLinks = new Map<string, { hosts: Set<string>; hashes: Set<string> }>();
  const small = raters.filter(rater => (registrations.get(rater) ?? 0) > 0 && (registrations.get(rater) ?? 0) < OWNER_FLEET_MIN);
  for (const part of chunks(small, 500)) {
    const rows = await db
      .select({ registrant: ROWS.registrant, host: ROWS.locatorHost, linkHash: ROWS.profileUriHash })
      .from(ROWS)
      .where(and(eq(ROWS.sourceId, sourceId), inArray(ROWS.registrant, part)));
    for (const row of rows) {
      if (!row.registrant) continue;
      const entry = registeredLinks.get(row.registrant) ?? { hosts: new Set<string>(), hashes: new Set<string>() };
      if (row.host) entry.hosts.add(row.host);
      if (row.linkHash) entry.hashes.add(row.linkHash);
      registeredLinks.set(row.registrant, entry);
    }
  }
  return { agents, registrations, registeredLinks };
}

/** Works out the ratings from the ledger and the registry rows, and makes `bsc_rater_evidence` agree with them. */
async function evaluate(db: Db, sourceId: string, computedAt: Date): Promise<RaterReport> {
  const events = await readLedger(db);
  const feedback = liveFeedback(events);
  const stats = raterStats(feedback);
  const classes = new Map<string, RaterClass>(Array.from(stats, ([client, entry]) => [client, classifyRater(entry)] as const));
  const agentIds = Array.from(new Set(feedback.map(event => event.agentId)));
  const facts = await readRegistryFacts(db, sourceId, agentIds, Array.from(stats.keys()));
  const results = rateAgents(feedback, facts, classes);
  const all = Array.from(results.values());
  for (const part of chunks(all, 200)) {
    await db
      .insert(bscRaterEvidence)
      .values(part.map(result => ({ id: randomUUID(), sourceId, externalKey: bscExternalKey(`${result.agentId}`), ...result, computedAt })))
      .onDuplicateKeyUpdate({
        set: {
          rawEvents: sql.raw("values(`rawEvents`)"),
          rawRaters: sql.raw("values(`rawRaters`)"),
          concentratedRaters: sql.raw("values(`concentratedRaters`)"),
          uniformRaters: sql.raw("values(`uniformRaters`)"),
          linkedRaters: sql.raw("values(`linkedRaters`)"),
          independentRaters: sql.raw("values(`independentRaters`)"),
          weightedEvents: sql.raw("values(`weightedEvents`)"),
          ownerRegistrations: sql.raw("values(`ownerRegistrations`)"),
          ownerFleet: sql.raw("values(`ownerFleet`)"),
          qualifies: sql.raw("values(`qualifies`)"),
          computedAt: sql.raw("values(`computedAt`)"),
        },
      });
  }
  // An agent whose ratings were all revoked has no evidence any more.
  const keep = all.map(result => bscExternalKey(`${result.agentId}`));
  if (keep.length === 0) await db.delete(bscRaterEvidence).where(eq(bscRaterEvidence.sourceId, sourceId));
  else {
    const stored = await db.select({ id: bscRaterEvidence.id, externalKey: bscRaterEvidence.externalKey }).from(bscRaterEvidence).where(eq(bscRaterEvidence.sourceId, sourceId));
    const wanted = new Set(keep);
    const gone = stored.filter(row => !wanted.has(row.externalKey)).map(row => row.id);
    for (const part of chunks(gone, 200)) await db.delete(bscRaterEvidence).where(inArray(bscRaterEvidence.id, part));
  }
  await db.update(bscReputationState).set({ evaluatedAt: computedAt }).where(eq(bscReputationState.id, BSC_REPUTATION_STATE_ID));
  return raterReport(feedback, stats, classes, results);
}

let running = false;

/** Runs the rater step once. Never throws. */
export async function runBscRaters(overrides: Partial<RatersDeps> & { tickStartedAt?: number } = {}): Promise<RatersResult> {
  if (running) return { state: "busy" };
  const deps: RatersDeps = { ...defaultDeps(), ...overrides };
  const started = deps.now();
  if (overrides.tickStartedAt !== undefined && started - overrides.tickStartedAt > RATERS_TICK_LIMIT_MS) return { state: "too_late" };
  running = true;
  try {
    const database = await getDb();
    if (!database) return { state: "unavailable" };
    const db = requireDb(database);
    try {
      // The tables first: with them missing nothing is read from the chain and nothing is written.
      await db.select({ id: bscFeedbackEvents.id }).from(bscFeedbackEvents).limit(1);
      await db.select({ id: bscRaterEvidence.id }).from(bscRaterEvidence).limit(1);
      await db.select({ id: bscReputationState.id }).from(bscReputationState).limit(1);
    } catch (error) {
      if (!isMissingTable(error)) logFailure(`the rater tables could not be read: ${error instanceof Error ? error.message : "unknown error"}`);
      return { state: "unavailable" };
    }
    const [source] = await db
      .select({ id: ingestionSources.id })
      .from(ingestionSources)
      .where(and(eq(ingestionSources.protocol, "erc8004_bsc"), eq(ingestionSources.state, "active")))
      .limit(1);
    if (!source) return { state: "no_source" };

    const done = await scan(db, deps, started + deps.budgetMs);
    const [state] = await db.select({ evaluatedAt: bscReputationState.evaluatedAt }).from(bscReputationState).where(eq(bscReputationState.id, BSC_REPUTATION_STATE_ID)).limit(1);
    // MySQL rounds a timestamp to the second, which can put it just ahead of now, so "always" is its own answer.
    const due = deps.reevaluateMs <= 0 || !state?.evaluatedAt || Date.now() - new Date(state.evaluatedAt).getTime() >= deps.reevaluateMs;
    // The ratings are worked out only on a ledger that has caught up with the chain, so a half-read ledger is never described.
    const evaluate_ = done.caughtUp && (done.inserted > 0 || due);
    const report = evaluate_ ? await evaluate(db, source.id, new Date()) : null;
    const result: RatersResult = { state: "completed", windows: done.windows, inserted: done.inserted, caughtUp: done.caughtUp, stoppedBy: done.stoppedBy, evaluated: evaluate_, report, ms: deps.now() - started };
    if (done.windows > 0 || evaluate_ || done.stoppedBy !== null) console.log(JSON.stringify({ event: "nooscape_bsc_raters", ...result }));
    return result;
  } catch (error) {
    if (!isMissingTable(error)) logFailure(error instanceof Error ? error.message : "unknown error");
    return { state: "unavailable" };
  } finally {
    running = false;
  }
}
