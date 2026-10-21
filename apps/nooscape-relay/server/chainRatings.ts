import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { chainReputationCounts, ingestionSources, type IngestionSource } from "../drizzle/schema";
import { getDb, requireDb } from "./db";
import { assertPublicHostname } from "./ingestion/a2a";
import { ERC8004_CHAINS, erc8004ChainOn, type Erc8004Chain } from "./ingestion/erc8004Chains";
import { Erc8004RpcRangeError, callRpc, createPacer, resolveRpcUrl } from "./ingestion/erc8004Rpc";
import { ROBINHOOD_FEEDBACK_REVOKED_TOPIC, ROBINHOOD_NEW_FEEDBACK_TOPIC } from "./ingestion/robinhoodReputation";
import { invalidateDirectoryReadsSoftly } from "./readCache";
import { stepIntervalGateMs } from "./stepInterval";

/**
 * The ratings step of the worker (docs/extra-chain-ratings-2026-10-21.md). For each chain the identity pass reads beyond BNB Chain whose entry
 * names a reputation registry, it counts the registry's NewFeedback and FeedbackRevoked events and keeps the two counts, and the block it has
 * read to, in `chain_reputation_counts`. The Home tab's and the chain page's "Ratings recorded" figure reads the first count once the read has
 * reached the finalized head; before then the figure says "not measured", never a smaller number.
 *
 * Counts, not events. A platform that rates at scale (Base's registry saw about 3,000 events in 5.6 hours on 2026-10-21) cannot grow the
 * database, and a count of the registry's own events is a fact that the chain can be asked for again. Each window's counts and the move of
 * `nextBlock` past it are one statement conditioned on `nextBlock` still being where the window started, so a window is counted once however
 * often it is read and two runs cannot both count it.
 *
 * Best-effort, after the sources like the other steps: it reads the chain, so it runs only on a tick that claimed sources and is still young,
 * at most once in 30 minutes for a chain, within a time budget; it never throws, and with its table not there it does nothing and says nothing.
 * It reads only a chain whose identity source is active (staged and approved by the operator) and whose switch is on, through the same host.
 */

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export type RatingsDeps = {
  /** The chain's node, opened for the source's host. Tests give a fake one. */
  rpcFor: (chain: Erc8004Chain, source: IngestionSource) => Promise<RpcCall>;
  now: () => number;
  /** The step stops starting new windows after this long, shared evenly by the chains it reads. */
  budgetMs: number;
  /** The most windows in one run, for one chain. */
  maxWindows: number;
  /** The least time between two runs on a chain. */
  intervalMs: number;
  chains: readonly Erc8004Chain[];
};

export const RATINGS_INTERVAL_MS = 30 * 60 * 1000;
export const RATINGS_BUDGET_MS = 30_000;
export const RATINGS_MAX_WINDOWS = 200;
/** The worker does not start the step when its own tick has already run this long. */
export const RATINGS_TICK_LIMIT_MS = 100_000;
/** The narrowest window a result-size refusal may split down to. */
const MIN_SPLIT_WIDTH = 64;

const hex = (value: number) => `0x${value.toString(16)}`;

const defaultDeps = (): RatingsDeps => ({
  rpcFor: async (chain, source) => {
    // The endpoint variable first, as the identity pass does: an unset or mistyped one is the likeliest failure and needs no network.
    const url = resolveRpcUrl(chain, source.allowedHostname);
    await assertPublicHostname(source.allowedHostname);
    const pace = chain.rpc.minGapMs ? createPacer(chain.rpc.minGapMs) : undefined;
    return (method, params) => callRpc(chain, method, params, { url, ...(pace ? { pace } : {}) });
  },
  now: () => Date.now(),
  budgetMs: RATINGS_BUDGET_MS,
  maxWindows: RATINGS_MAX_WINDOWS,
  intervalMs: RATINGS_INTERVAL_MS,
  chains: ERC8004_CHAINS,
});

export type ChainRatingsResult = {
  chainKey: string;
  state: "unavailable" | "no_source" | "waiting" | "busy" | "completed" | "failed";
  windows: number;
  ratings: number;
  revocations: number;
  caughtUp: boolean;
};

/**
 * The two counts in one window's logs. The request asked for those two events only, so a log of any other kind, from another address, outside
 * the window or without the four topics both events carry is a fault in the provider's answer: the window is not counted, and the run stops
 * there with its position kept. A log marked removed is not counted.
 */
export function countRatingLogs(logs: unknown[], registry: string, bounds: { fromBlock: number; toBlock: number }): { ratings: number; revocations: number } {
  let ratings = 0;
  let revocations = 0;
  for (const log of logs) {
    if (!log || typeof log !== "object" || Array.isArray(log)) throw new Error("A reputation log was not an object.");
    const entry = log as Record<string, unknown>;
    if (entry.removed === true) continue;
    if (typeof entry.address !== "string" || entry.address.toLowerCase() !== registry.toLowerCase()) throw new Error("A reputation log came from another address.");
    const block = typeof entry.blockNumber === "string" && /^0x[0-9a-fA-F]{1,16}$/.test(entry.blockNumber) ? Number.parseInt(entry.blockNumber, 16) : Number.NaN;
    if (!(block >= bounds.fromBlock && block <= bounds.toBlock)) throw new Error("A reputation log was outside the window asked for.");
    const topics = entry.topics;
    if (!Array.isArray(topics) || topics.length !== 4 || typeof topics[0] !== "string") throw new Error("A reputation log did not have the four topics of a rating event.");
    const kind = topics[0].toLowerCase();
    if (kind === ROBINHOOD_NEW_FEEDBACK_TOPIC) ratings += 1;
    else if (kind === ROBINHOOD_FEEDBACK_REVOKED_TOPIC) revocations += 1;
    else throw new Error("A reputation log was not a rating or a revocation.");
  }
  return { ratings, revocations };
}

/** One window's raw logs. A result-size refusal halves the window; a block-range refusal is a planner bug and propagates. */
async function fetchWindowLogs(rpc: RpcCall, registry: string, from: number, to: number): Promise<unknown[]> {
  try {
    const logs = await rpc("eth_getLogs", [{ address: registry, fromBlock: hex(from), toBlock: hex(to), topics: [[ROBINHOOD_NEW_FEEDBACK_TOPIC, ROBINHOOD_FEEDBACK_REVOKED_TOPIC]] }]);
    if (!Array.isArray(logs)) throw new Error("A reputation log response must be an array.");
    return logs;
  } catch (error) {
    if (error instanceof Erc8004RpcRangeError && error.reason === "result_size" && to - from + 1 > MIN_SPLIT_WIDTH) {
      const middle = Math.floor((from + to) / 2);
      return (await fetchWindowLogs(rpc, registry, from, middle)).concat(await fetchWindowLogs(rpc, registry, middle + 1, to));
    }
    throw error;
  }
}

function isMissingTable(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; cause instanceof Error && depth < 4; depth += 1) {
    if ("code" in cause && cause.code === "ER_NO_SUCH_TABLE") return true;
    cause = cause.cause;
  }
  return false;
}

const affectedRows = (result: unknown) => Number((result as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);

const logFailure = (chainKey: string, message: string) =>
  console.error(JSON.stringify({ event: "nooscape_chain_ratings_failed", chain: chainKey, message: message.replace(/[\r\n]+/g, " ").slice(0, 400) }));

function finalizedBlock(chain: Erc8004Chain, result: unknown): number {
  const value = result && typeof result === "object" ? (result as { number?: unknown }).number : null;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(value)) throw new Error(`${chain.chainLabel} did not return a finalized block number.`);
  return Number.parseInt(value.slice(2), 16);
}

async function readChain(chain: Erc8004Chain, reputation: NonNullable<Erc8004Chain["reputation"]>, deps: RatingsDeps, deadline: number): Promise<ChainRatingsResult> {
  const result: ChainRatingsResult = { chainKey: chain.chainKey, state: "completed", windows: 0, ratings: 0, revocations: 0, caughtUp: false };
  const db = requireDb(await getDb());
  const [source] = await db
    .select()
    .from(ingestionSources)
    .where(and(eq(ingestionSources.sourceKey, chain.sourceKey), eq(ingestionSources.protocol, chain.protocol as IngestionSource["protocol"]), eq(ingestionSources.state, "active")))
    .limit(1);
  if (!source) return { ...result, state: "no_source" };

  await db.insert(chainReputationCounts).ignore().values({ chainKey: chain.chainKey, nextBlock: chain.deployBlock });
  // One run at a time on a chain, and not closer than the interval: the claim is a conditional update of the run time.
  const startedAt = deps.now();
  const claimed = await db
    .update(chainReputationCounts)
    .set({ lastRunAt: new Date(startedAt) })
    .where(and(eq(chainReputationCounts.chainKey, chain.chainKey), or(isNull(chainReputationCounts.lastRunAt), lte(chainReputationCounts.lastRunAt, new Date(startedAt - stepIntervalGateMs(deps.intervalMs))))));
  if (affectedRows(claimed) !== 1) return { ...result, state: "waiting" };
  const [position] = await db.select({ nextBlock: chainReputationCounts.nextBlock }).from(chainReputationCounts).where(eq(chainReputationCounts.chainKey, chain.chainKey)).limit(1);
  if (!position) return { ...result, state: "busy" };

  const rpc = await deps.rpcFor(chain, source);
  const chainId = await rpc("eth_chainId", []);
  if (typeof chainId !== "string" || chainId.toLowerCase() !== chain.chainIdHex) throw new Error(`${chain.chainLabel} RPC did not confirm the approved chain id ${chain.chainId}.`);
  const finalized = finalizedBlock(chain, await rpc("eth_getBlockByNumber", ["finalized", false]));

  let from = Number(position.nextBlock);
  while (from <= finalized && result.windows < deps.maxWindows && deps.now() < deadline) {
    const to = Math.min(from + reputation.window - 1, finalized);
    const counts = countRatingLogs(await fetchWindowLogs(rpc, reputation.registry, from, to), reputation.registry, { fromBlock: from, toBlock: to });
    // The counts and the move past the window are one statement, and only if nothing else has moved the position: exactly once.
    const moved = await db
      .update(chainReputationCounts)
      .set({
        ratings: sql`${chainReputationCounts.ratings} + ${counts.ratings}`,
        revocations: sql`${chainReputationCounts.revocations} + ${counts.revocations}`,
        nextBlock: to + 1,
        ...(to >= finalized ? { caughtUpAt: sql`COALESCE(${chainReputationCounts.caughtUpAt}, NOW())` } : {}),
      })
      .where(and(eq(chainReputationCounts.chainKey, chain.chainKey), eq(chainReputationCounts.nextBlock, from)));
    if (affectedRows(moved) !== 1) return { ...result, state: "busy" };
    result.windows += 1;
    result.ratings += counts.ratings;
    result.revocations += counts.revocations;
    result.caughtUp = to >= finalized;
    from = to + 1;
  }
  if (result.windows > 0) {
    invalidateDirectoryReadsSoftly();
    console.log(JSON.stringify({ event: "nooscape_chain_ratings", chain: chain.chainKey, windows: result.windows, ratings: result.ratings, revocations: result.revocations, nextBlock: from, caughtUp: result.caughtUp, ms: deps.now() - startedAt }));
  }
  return result;
}

/** One run of the step over every chain that has a reputation registry named and is on. Never throws. */
export async function runChainRatings(options: { tickStartedAt: number }, overrides: Partial<RatingsDeps> = {}): Promise<ChainRatingsResult[]> {
  const deps = { ...defaultDeps(), ...overrides };
  if (deps.now() - options.tickStartedAt > RATINGS_TICK_LIMIT_MS) return [];
  const results: ChainRatingsResult[] = [];
  const due = deps.chains.filter(chain => chain.reputation && erc8004ChainOn(chain));
  // The budget is shared out evenly, so a chain with a long history to read cannot keep the others waiting for their turn.
  const share = Math.floor(deps.budgetMs / Math.max(1, due.length));
  for (const chain of due) {
    try {
      results.push(await readChain(chain, chain.reputation!, deps, deps.now() + share));
    } catch (error) {
      if (isMissingTable(error)) {
        results.push({ chainKey: chain.chainKey, state: "unavailable", windows: 0, ratings: 0, revocations: 0, caughtUp: false });
        continue;
      }
      results.push({ chainKey: chain.chainKey, state: "failed", windows: 0, ratings: 0, revocations: 0, caughtUp: false });
      logFailure(chain.chainKey, error instanceof Error ? error.message : "Unknown ratings error");
    }
  }
  return results;
}
