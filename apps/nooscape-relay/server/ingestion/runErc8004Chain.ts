import { applyAgentRegistryUriUpdates, insertAgentRegistryRows, keepStoredTokens, keepWithinHostCap, refreshAgentRegistryListing } from "../agentRegistryRows";
import { applyAgentDirectoryActivityWindow } from "../db";
import { describeFailure } from "../driverErrors";
import type { IngestionSource } from "../../drizzle/schema";
import { assertPublicHostname } from "./a2a";
import {
  ERC8004_IDENTITY_TOPIC_FILTER,
  Erc8004ChainOffError,
  cursorFor,
  directoryDraft,
  hasProfileLink,
  parseCursor,
  parseWindowLogs,
  planWindows,
  uriFacts,
  validationError,
  type ChainWindow,
} from "./erc8004Chain";
import { erc8004ChainOn, type Erc8004Chain, type Erc8004RunBudget } from "./erc8004Chains";
import { Erc8004RpcRangeError, callRpc, createPacer, resolveRpcUrl } from "./erc8004Rpc";
import { withIngestionRun } from "./runLifecycle";
import type { Erc8004IngestionResult } from "./types";

/**
 * Runs one bounded step of the ERC-8004 identity pass on one EVM chain: a forward walk from the registry's deploy block to the
 * FINALIZED head under one cursor (`<prefix>:<next block>`), then the same walk tailing the head. Facts only and no fetching
 * (operator decisions D1 and D2): it decodes the registry's own Registered, Transfer, and URIUpdated events and nothing else,
 * and it never dereferences a URI. The chain is an argument (erc8004Chains.ts); nothing in this file names one.
 *
 * Why finalized: the provider serves the `finalized` tag, so scanning only finalized blocks cannot be reorged. None of the
 * anchor-hash machinery the Robinhood forward walk needs applies here.
 *
 * Each run plans up to `maxWindows` consecutive windows of at most the provider's block-range ceiling, fetches them a few at a
 * time, and applies them STRICTLY IN CHAIN ORDER, however the fetches finish, so a registration is always written before the URI
 * update that follows it. Per window the write order is: registry rows (insert-only, so a re-scan can never regress a URI a
 * later window updated), then the ledger (INSERT-IGNORE, with an incremental rollup onto the registry rows), then the URI facts.
 * Every write is idempotent, so a retry after any failure is safe. The cursor advances only past windows that were fully applied.
 *
 * A window the node refuses as too large (its own limit, or the response cap in erc8004Rpc.ts) goes back to the front of the queue as its
 * two halves, and each half is fetched and applied as a window of its own, so the response cap, the log bound and the cursor all hold per
 * half. A half that is still refused splits again, down to MIN_SPLIT_WIDTH.
 *
 * Registrations go to the registry rows table, not the directory: a registry can hold hundreds of thousands, mostly templates
 * and platform issuers. After the windows, a listing refresh classifies the rows against the published rules and, once the walk
 * has caught up with the finalized head, publishes the listed subset into the directory (agentRegistryRows.ts). A refresh
 * failure is logged and never fails the run: the windows are already applied and the next run refreshes again.
 *
 * A failure after at least one window was applied stops the run early and keeps that progress (the next run retries the failed
 * window first, and a window that cannot make progress fails the run loudly); a failure before any progress fails the run and
 * leaves the cursor untouched.
 *
 * Directory-only like the other chain passes: nothing here can add a reviewed record, so its runs must never be projected. The
 * source is registered manual_only; unattended runs are accepted only from a source an operator has handed to the scheduler,
 * and replays are rejected outright. A chain that has a switch (its `feature`) does not run at all while the switch is off.
 */

type Budget = Erc8004RunBudget;
type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * The narrowest window a result-size rejection may split down to before the run fails. Ten blocks of the densest stretch measured on
 * Base (64 events a block, 22 October 2026) is 640 events, far inside the response cap.
 */
const MIN_SPLIT_WIDTH = 10;

const hex = (value: number) => `0x${value.toString(16)}`;

function parseBlockNumber(chain: Erc8004Chain, result: unknown, label: string): number {
  const value = result && typeof result === "object" ? (result as { number?: unknown }).number : null;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(value)) {
    throw validationError(chain, `${chain.chainLabel} ${label} did not return a block number.`);
  }
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed)) throw validationError(chain, `${chain.chainLabel} ${label} returned an out-of-range block number.`);
  return parsed;
}

/** One window's raw logs. */
async function fetchWindowLogs(chain: Erc8004Chain, rpc: RpcCall, window: ChainWindow): Promise<unknown[]> {
  const logs = await rpc("eth_getLogs", [
    { address: chain.identityRegistry, fromBlock: hex(window.from), toBlock: hex(window.to), topics: ERC8004_IDENTITY_TOPIC_FILTER },
  ]);
  if (!Array.isArray(logs)) throw validationError(chain, `${chain.chainLabel} identity log response must be an array.`);
  return logs;
}

/** A result-size refusal of a window wide enough to halve. A block-range refusal is a planner bug and is not split. */
const refusedAsTooLarge = (reason: unknown, window: ChainWindow) =>
  reason instanceof Erc8004RpcRangeError && reason.reason === "result_size" && window.to - window.from + 1 > MIN_SPLIT_WIDTH;

/** A refresh failure never fails a run whose windows are already applied; the next run refreshes again. */
async function refreshListing(chain: Erc8004Chain, source: IngestionSource, options: { classify: boolean; publish: boolean }) {
  try {
    // The chain's own rules, when it has any; otherwise the registry rows module's defaults.
    const { published } = await refreshAgentRegistryListing(source, chain.listingRules ? { ...options, rules: chain.listingRules } : options);
    if (published && (published.inserted > 0 || published.refreshed > 0 || published.removed > 0)) {
      console.log(`[${chain.logTag}] listing published: ${published.inserted} added, ${published.refreshed} refreshed, ${published.removed} removed`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 300) : "unknown error";
    console.warn(`[${chain.logTag}] listing refresh failed and will be retried by the next run: ${message}`);
  }
}

export async function runApprovedErc8004ChainSource(
  chain: Erc8004Chain,
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual",
  mode: "observe" | "backfill" | "registrants" | "activity" = "activity",
  deps: { rpc?: RpcCall; now?: () => number; budget?: Partial<Budget>; sleep?: (ms: number) => Promise<void>; random?: () => number } = {}
): Promise<Erc8004IngestionResult> {
  const label = chain.chainLabel;
  if (trigger === "replay") {
    throw new Error(`${label} identity registry replays are rejected outright.`);
  }
  if (trigger === "scheduled" && source.executionPolicy !== "scheduled") {
    throw new Error(`Scheduled ${label} identity registry runs require the scheduled execution policy.`);
  }
  if (source.protocol !== chain.protocol || source.sourceKey !== chain.sourceKey) {
    throw new Error(`The ${label} identity pass is approved for the ${label} ERC-8004 identity registry only.`);
  }
  if (mode !== "activity") {
    throw new Error(`The ${label} identity registry has one surface, the chain pass; observe and the walk modes have no meaning here.`);
  }
  if (!erc8004ChainOn(chain)) {
    // Said in the log as well as thrown, so a run that never starts is not mistaken for one that failed.
    console.warn(`[${chain.logTag}] the ${chain.chainLabel} identity pass was refused: its switch (${chain.feature}) is off.`);
    throw new Erc8004ChainOffError(`The ${label} identity pass is switched off.`);
  }

  const budget: Budget = { ...chain.budget, ...deps.budget };
  const now = deps.now ?? Date.now;

  // Failure-path request count of 3: chain id, finalized block, and the first
  // (failed) window attempt, the walk's minimum honest call count.
  return withIngestionRun(source, trigger, 3, async runId => {
    if (source.state !== "active") throw validationError(chain, "Only active sources may be fetched.");
    // A pinned chain's row must record the chain's own origin and host. A derived chain's row records the operator's host, so it
    // must only agree with itself here; that the endpoint variable still points at that host is checked below, with the variable.
    const policyMatches =
      chain.provider.kind === "pinned"
        ? source.rootUrl === chain.provider.rootUrl && source.allowedHostname === chain.provider.allowedHostname
        : source.rootUrl === `https://${source.allowedHostname}`;
    if (!policyMatches) {
      throw validationError(chain, `Stored ${label} source policy does not match the approved RPC host.`);
    }
    let requestCount = 0;
    let rpc: RpcCall;
    if (deps.rpc) {
      rpc = deps.rpc;
    } else {
      // The endpoint variable is checked first: an unset or mistyped variable is the likeliest first failure,
      // and answering it needs no network.
      const url = resolveRpcUrl(chain, source.allowedHostname);
      try {
        await assertPublicHostname(source.allowedHostname);
      } catch (error) {
        // The shared check speaks of an "A2A hostname"; say what was being checked here.
        throw validationError(chain, `The ${label} RPC host failed the public-network check: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      // A chain on a node shared with something else keeps a gap between its calls; the others make theirs as they always have.
      // `now`, `sleep` and `random` are injected by tests; a run in production passes none of them.
      const pace = chain.rpc.minGapMs ? createPacer(chain.rpc.minGapMs, { ...(deps.now ? { now: deps.now } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) }) : undefined;
      rpc = (method, params) =>
        callRpc(chain, method, params, {
          url,
          countAttempt: () => (requestCount += 1),
          ...(pace ? { pace } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          ...(deps.random ? { random: deps.random } : {}),
        });
    }
    const startedAt = now();

    const chainId = await rpc("eth_chainId", []);
    if (typeof chainId !== "string" || chainId.toLowerCase() !== chain.chainIdHex) {
      throw validationError(chain, `${label} RPC did not confirm the approved chain id ${chain.chainId}.`);
    }
    const finalizedBlock = parseBlockNumber(chain, await rpc("eth_getBlockByNumber", ["finalized", false]), "finalized block");

    const cursor = parseCursor(chain, source.cursor);
    const windows = planWindows(chain, cursor.nextBlock, finalizedBlock, budget.maxWindows);
    const caughtUpCursor = source.cursor ?? cursorFor(chain, cursor.nextBlock);
    if (windows.length === 0) {
      // Nothing finalized past the cursor yet: a quiet, successful run. The walk is caught up, so a refresh
      // still publishes anything a previous run classified but could not publish.
      await refreshListing(chain, source, { classify: false, publish: true });
      return { requestCount, discoveredCount: 0, acceptedCount: 0, rejectedCount: 0, nextCursor: caughtUpCursor };
    }

    let discoveredCount = 0;
    let acceptedCount = 0;
    let rejectedCount = 0;
    let appliedWindows = 0;
    let changedRows = 0;
    let nextBlock = cursor.nextBlock;
    let stopReason: Error | null = null;
    const bounds = (window: ChainWindow) => ({ fromBlock: window.from, toBlock: window.to });

    outer: while (windows.length > 0) {
      if (now() - startedAt > budget.maxElapsedMs || acceptedCount >= budget.maxEvents) break;
      const batch = windows.splice(0, budget.concurrency);
      const fetched = await Promise.allSettled(batch.map(window => fetchWindowLogs(chain, rpc, window)));
      for (let offset = 0; offset < batch.length; offset += 1) {
        const window = batch[offset]!;
        const outcome = fetched[offset]!;
        if (outcome.status === "rejected") {
          if (refusedAsTooLarge(outcome.reason, window)) {
            // Its two halves go back ahead of the windows fetched after it, which are read again, so the order stays the chain's.
            console.warn(`[${chain.logTag}] blocks ${window.from} to ${window.to} were too large for one read and are read in halves.`);
            const middle = Math.floor((window.from + window.to) / 2);
            windows.unshift({ from: window.from, to: middle }, { from: middle + 1, to: window.to }, ...batch.slice(offset + 1));
            continue outer;
          }
          stopReason = outcome.reason instanceof Error ? outcome.reason : new Error(`${label} window fetch failed.`);
          break outer;
        }
        if (now() - startedAt > budget.maxElapsedMs || acceptedCount >= budget.maxEvents) break outer;

        try {
          const parsed = parseWindowLogs(chain, outcome.value, bounds(window));
          let drafts = parsed.registrations.map(registration => ({ draft: directoryDraft(chain, registration), blockNumber: registration.blockNumber }));
          // A chain with a host cap stores no more than the cap of rows for one host: the rest are counted (agentRegistryRows.ts).
          if (chain.hostRowCap !== undefined && drafts.length > 0) {
            const { kept } = await keepWithinHostCap(
              source,
              drafts.map(({ draft, blockNumber }) => ({ draft, blockNumber, host: draft.locatorHost, externalKey: draft.externalKey })),
              chain.hostRowCap
            );
            drafts = kept;
          }
          if (drafts.length > 0) {
            await insertAgentRegistryRows({ source, runId, drafts: drafts.map(({ draft }) => draft) });
          }
          // The events of a token that was counted and not stored have no row to roll up onto, so they are dropped with it.
          let activity = parsed.activity;
          let uriUpdates = parsed.uriUpdates;
          if (chain.hostRowCap !== undefined) {
            activity = await keepStoredTokens(source.id, activity);
            const stored = new Set(activity.map(event => event.externalKey));
            uriUpdates = uriUpdates.filter(update => stored.has(update.externalKey));
          }
          if (activity.length > 0) {
            await applyAgentDirectoryActivityWindow({
              source,
              activity,
              handoutBlockWindow: chain.handoutBlockWindow,
              incrementalRollup: true,
              rollupTarget: "registry",
            });
          }
          const updates = uriUpdates.flatMap(update => {
            if (update.uri === null) return [];
            const facts = uriFacts(update.uri);
            return [
              {
                externalKey: update.externalKey,
                locatorHost: facts.locatorHost,
                profileUriHash: facts.profileUriHash,
                hasProfileLink: hasProfileLink(facts),
              },
            ];
          });
          // The URI-update step re-evaluates the groups a changed link leaves, so it counts them against the chain's own rules.
          if (updates.length > 0) await applyAgentRegistryUriUpdates({ source, runId, updates, ...(chain.listingRules ? { rules: chain.listingRules } : {}) });
          changedRows += drafts.length + updates.length;

          discoveredCount += parsed.discoveredCount;
          acceptedCount += parsed.registrations.length + parsed.activity.length;
          rejectedCount += parsed.rejectedCount;
          appliedWindows += 1;
          nextBlock = window.to + 1;
        } catch (error) {
          // A window that cannot be parsed or applied (a provider fault in its answer, a database error) ends the run at the windows before it, which
          // are kept, and the next run starts at it: every write is idempotent, so what was written of it is written again. With no window applied
          // there is nothing to keep, and the run fails with the cursor where it was.
          if (appliedWindows === 0) throw error;
          stopReason = new Error(describeFailure(error));
          break outer;
        }
      }
    }

    if (stopReason && appliedWindows === 0) throw stopReason;
    if (stopReason) {
      // Progress is kept; the next run retries the failed window first. The
      // message is URL-free by construction (see erc8004Rpc.ts).
      console.warn(`[${chain.logTag}] pass stopped early at block ${nextBlock} after ${appliedWindows} window(s): ${stopReason.message}`);
    }
    // Classify whatever this run wrote; publish only when every finalized block has been read.
    await refreshListing(chain, source, { classify: changedRows > 0, publish: nextBlock > finalizedBlock });
    return { requestCount, discoveredCount, acceptedCount, rejectedCount, nextCursor: appliedWindows > 0 ? cursorFor(chain, nextBlock) : caughtUpCursor };
  });
}
