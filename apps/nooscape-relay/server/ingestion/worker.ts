import { claimDueIngestionSources, expireDuePublisherKeys, finishIngestionWorkerTick } from "../db";
import { runBscClustering } from "../bscClusteringRun";
import { runBscRaters } from "../bscRatersRun";
import { runBscRegistrationFiles } from "../bscRegistrationFiles";
import { runChainNames } from "../chainNames";
import { chainRatingsTooLate, runChainRatings } from "../chainRatings";
import { recheckClaims } from "../claims";
import { runRobinhoodNames } from "../robinhoodNames";
import { runSaidNames } from "../saidNames";
import { selectTodaysCatch } from "../owlsCatch";
import type { IngestionSource } from "../../drizzle/schema";
import { runSource } from "./runSource";

export type WorkerTickResult = {
  state: "paused" | "rate_limited" | "completed" | "failed";
  attemptedSourceIds: string[];
  completedSourceIds: string[];
  failedSourceIds: string[];
  expiredPublisherKeys: number;
};

/** A failure for a log line: on a single line and at most 500 characters (a driver message can carry a statement and its parameters). */
const forTheLog = (error: unknown, unknownMessage: string) => (error instanceof Error ? error.message : unknownMessage).replace(/[\r\n]+/g, " ").slice(0, 500);

/**
 * Runs one best-effort step after the ingestion work. A failure is logged as one JSON line under `failedEvent`, worded by `forTheLog`, and
 * never reaches the tick.
 */
async function bestEffort(failedEvent: string, unknownMessage: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    console.error(JSON.stringify({ event: failedEvent, message: forTheLog(error, unknownMessage) }));
  }
}

/** Best-effort maintenance: an expiry failure must not abort the ingestion tick. */
/**
 * A step a tick did not start because the tick had already run past the step's limit (90 seconds for the two BNB steps, 100 for the
 * rest). The step runs on a later tick, since a skip does not start its interval; this says so in one line, so a skip is read in the
 * log and not inferred from how long ticks take.
 */
function logSkippedStep(step: string, tickStartedAt: number): void {
  console.log(JSON.stringify({ event: "nooscape_step_skipped", step, reason: "too_late", tickMs: Date.now() - tickStartedAt }));
}

/** Logs the skip when a step answered that it was too late to start. */
function skippedIfLate(step: string, result: { state: string }, tickStartedAt: number): void {
  if (result.state === "too_late") logSkippedStep(step, tickStartedAt);
}

async function runPublisherKeyExpiry() {
  try {
    const result = await expireDuePublisherKeys();
    return result.expiredCount;
  } catch (error) {
    console.error(JSON.stringify({ event: "nooscape_publisher_key_expiry_failed", message: forTheLog(error, "Unknown publisher-key expiry error") }));
    return 0;
  }
}

/**
 * Best-effort, like the key expiry: the day's Owl's Catch is chosen once, by the first tick of the UTC day, and
 * every later tick finds it and does nothing. It runs after the ingestion work so it never delays a source, and
 * a failure (the table not there yet, the database busy) is logged and never fails the tick.
 */
const runOwlsCatchSelection = () =>
  bestEffort("nooscape_owls_catch_failed", "Unknown Owl's Catch error", async () => {
    const result = await selectTodaysCatch();
    if (result.status !== "kept") console.log(JSON.stringify({ event: "nooscape_owls_catch", ...result }));
  });

/**
 * Best-effort, after the ingestion work like the Owl's Catch: the BNB fleet and template clustering keeps its two tables in
 * step with the registry rows (docs/bsc-clusters-2026-10-16.md). It reads the chain, so it runs only on a tick that claimed
 * sources: a paused control plane or a tick held back by the global interval fetches nothing, and so does this. It never
 * throws and a failure here never fails the tick, whatever it reports.
 */
const runBscClusteringStep = (tickStartedAt: number) =>
  bestEffort("nooscape_bsc_clusters_failed", "Unknown BNB clustering error", async () => skippedIfLate("bsc_clusters", await runBscClustering({ tickStartedAt }), tickStartedAt));

/**
 * Best-effort, after the clustering for the same reasons: the BNB reputation read and the rater check keep their three tables in
 * step with the registry's feedback (docs/bsc-rater-credibility-2026-10-16.md). It reads the chain, so it runs only on a tick that
 * claimed sources, and it never throws; a failure here never fails the tick, whatever it reports. What it writes is internal.
 */
const runBscRatersStep = (tickStartedAt: number) =>
  bestEffort("nooscape_bsc_raters_failed", "Unknown BNB rater error", async () => skippedIfLate("bsc_raters", await runBscRaters({ tickStartedAt }), tickStartedAt));

/**
 * Best-effort, after the BNB steps for the same reasons: the Robinhood name step reads the registration link of a reviewed
 * Robinhood record that has no name of its own, through the safe fetch, and keeps the answer beside the record
 * (docs/approvals/2026-10-17-robinhood-names.md). It asks other people's hosts, so it runs only on a tick that claimed sources, a
 * paused control plane or a tick held back by the global interval asks nothing, and it never throws. A failure here never fails the
 * tick, whatever it reports.
 */
const runRobinhoodNamesStep = (tickStartedAt: number) =>
  bestEffort("nooscape_robinhood_names_failed", "Unknown Robinhood names error", async () => skippedIfLate("robinhood_names", await runRobinhoodNames({ tickStartedAt }), tickStartedAt));

/**
 * Best-effort, after the Robinhood names for the same reasons: the BNB registration-file step reads the file behind the web or ipfs
 * link of a listed BNB entry, through the safe fetch, so that the entry's template key is known for gate G1
 * (docs/approvals/2026-10-17-bnb-registration-files.md). It asks other people's hosts, so it runs only on a tick that claimed
 * sources, and it never throws; a failure here never fails the tick, whatever it reports. What it writes is internal.
 */
const runBscRegistrationFilesStep = (tickStartedAt: number) =>
  bestEffort("nooscape_bsc_files_failed", "Unknown BNB registration file error", async () => skippedIfLate("bsc_files", await runBscRegistrationFiles({ tickStartedAt }), tickStartedAt));

/**
 * Best-effort, after the two steps above for the same reasons: the SAID name step reads the card that the metadata link of a SAID
 * identity names, through the safe fetch, so that the directory shows the name its registrant gave instead of "SAID agent <wallet
 * prefix>" (docs/approvals/2026-10-18-said-names.md). It asks other people's hosts, so it runs only on a tick that claimed sources,
 * and it never throws; a failure here never fails the tick, whatever it reports.
 */
const runSaidNamesStep = (tickStartedAt: number) =>
  bestEffort("nooscape_said_names_failed", "Unknown SAID names error", async () => skippedIfLate("said_names", await runSaidNames({ tickStartedAt }), tickStartedAt));

/**
 * Best-effort, after the SAID names for the same reasons: the Base, Arc, Ethereum, Monad, Gnosis and Celo name step reads the registration link of a
 * directory entry on any of the six chains that is still called "Agent #n", through the safe fetch, and lays the name it finds over the placeholder
 * (docs/approvals/2026-10-26-base-arc-names.md). It reads the chain's own node and asks other people's hosts, so it runs only on a tick
 * that claimed sources, it takes one chain a run in turn, and it never throws; a failure here never fails the tick, whatever it reports.
 */
const runChainNamesStep = (tickStartedAt: number) =>
  bestEffort("nooscape_chain_names_failed", "Unknown chain names error", async () => skippedIfLate("chain_names", await runChainNames({ tickStartedAt }), tickStartedAt));

/**
 * Best-effort, after the SAID names for the same reasons: the ratings step counts the NewFeedback and FeedbackRevoked events of the reputation
 * registry of each chain the identity pass reads beyond BNB Chain, so that the chain's "Ratings recorded" figure is a count and not "not
 * measured" (docs/extra-chain-ratings-2026-10-21.md). It reads the chain, so it runs only on a tick that claimed sources, at most once in 30
 * minutes for a chain, and it never throws; with its table not there it does nothing and says nothing. A failure here never fails the tick.
 */
const runChainRatingsStep = (tickStartedAt: number) =>
  bestEffort("nooscape_chain_ratings_failed", "Unknown ratings error", async () => {
    // The step answers an empty list both when nothing was due and when it was too late, so its own rule tells the two apart.
    const results = await runChainRatings({ tickStartedAt });
    if (results.length === 0 && chainRatingsTooLate(tickStartedAt, Date.now())) logSkippedStep("chain_ratings", tickStartedAt);
  });

/**
 * Best-effort, last, for the same reasons: the daily check of claimed agents asks the registry who owns each claim's agent that has
 * not been asked in 23 hours (at most 25 a run) and revokes a claim whose agent has changed hands (docs/claims-2026-10-18.md). It
 * reads the chain, so it runs only on a tick that claimed sources, it never throws, and with the claim tables missing it does nothing
 * and says nothing. A failure here never fails the tick.
 */
const runClaimRecheckStep = () =>
  bestEffort("nooscape_claim_recheck_failed", "Unknown claim check error", async () => {
    const result = await recheckClaims();
    if (result.checked > 0 || result.unavailable > 0) console.log(JSON.stringify({ event: "nooscape_claim_recheck", ...result }));
  });

/** A due source, run by its adapter as a scheduled trigger (runSource.ts, which the operator's runs share). */
function runApprovedSource(source: IngestionSource) {
  return runSource(source, "scheduled");
}

/**
 * Runs at most the database-controlled number of due sources. The atomic claim
 * prevents overlapping cron/container instances from bypassing the global
 * interval. Source-specific `scheduleMinutes` remain enforced by `nextRunAt`.
 * Publisher-key expiry runs first on every tick — including paused and
 * rate-limited ones — so an allowlisted key cannot outlive its configured
 * window while ingestion idles; it needs no external fetch, so it does not
 * bypass the interval.
 */
export async function runRateLimitedIngestionTick(): Promise<WorkerTickResult> {
  const tickStartedAt = Date.now();
  const result = await runIngestionTick();
  await runOwlsCatchSelection();
  if (result.state === "completed" || result.state === "failed") {
    await runBscClusteringStep(tickStartedAt);
    await runBscRatersStep(tickStartedAt);
    await runRobinhoodNamesStep(tickStartedAt);
    await runBscRegistrationFilesStep(tickStartedAt);
    await runSaidNamesStep(tickStartedAt);
    await runChainNamesStep(tickStartedAt);
    await runChainRatingsStep(tickStartedAt);
    await runClaimRecheckStep();
  }
  return result;
}

async function runIngestionTick(): Promise<WorkerTickResult> {
  const expiredPublisherKeys = await runPublisherKeyExpiry();
  const claim = await claimDueIngestionSources();
  if (claim.reason === "paused") {
    return { state: "paused", attemptedSourceIds: [], completedSourceIds: [], failedSourceIds: [], expiredPublisherKeys };
  }
  if (claim.reason === "rate_limited") {
    return { state: "rate_limited", attemptedSourceIds: [], completedSourceIds: [], failedSourceIds: [], expiredPublisherKeys };
  }

  const attemptedSourceIds = claim.sources.map(source => source.id);
  const completedSourceIds: string[] = [];
  const failedSourceIds: string[] = [];
  let lastError: unknown;
  for (const source of claim.sources) {
    try {
      await runApprovedSource(source);
      completedSourceIds.push(source.id);
    } catch (error) {
      failedSourceIds.push(source.id);
      lastError = error;
      // With more than one source per tick, a failing source must not starve
      // the others: each run owns its own run row, cursor, and error, so the
      // loop keeps going and the tick reports every failure. The global
      // interval still paces the tick as a whole.
    }
  }
  await finishIngestionWorkerTick(lastError);
  return {
    state: failedSourceIds.length > 0 ? "failed" : "completed",
    attemptedSourceIds,
    completedSourceIds,
    failedSourceIds,
    expiredPublisherKeys,
  };
}
