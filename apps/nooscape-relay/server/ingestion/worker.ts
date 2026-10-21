import { claimDueIngestionSources, expireDuePublisherKeys, finishIngestionWorkerTick } from "../db";
import { runBscClustering } from "../bscClusteringRun";
import { runBscRaters } from "../bscRatersRun";
import { runBscRegistrationFiles } from "../bscRegistrationFiles";
import { runChainRatings } from "../chainRatings";
import { recheckClaims } from "../claims";
import { runRobinhoodNames } from "../robinhoodNames";
import { runSaidNames } from "../saidNames";
import { selectTodaysCatch } from "../owlsCatch";
import type { IngestionSource } from "../../drizzle/schema";
import { runApprovedA2aSource } from "./runA2a";
import { runApprovedAgenstrySource } from "./runAgenstry";
import { runApprovedAgentEconomySource } from "./runAgentEconomy";
import { runApproved8004SolanaSource } from "./run8004Solana";
import { runApprovedSaidSource } from "./runSaid";
import { runApprovedMetaplexRegistrySource } from "./runMetaplex";
import { runApprovedRobinhoodRegistrySource } from "./runRobinhood";
import { runApprovedBscRegistrySource } from "./runBsc";
import { erc8004ChainOfProtocol } from "./erc8004Chains";
import { runApprovedErc8004ChainSource } from "./runErc8004Chain";

export type WorkerTickResult = {
  state: "paused" | "rate_limited" | "completed" | "failed";
  attemptedSourceIds: string[];
  completedSourceIds: string[];
  failedSourceIds: string[];
  expiredPublisherKeys: number;
};

/** Best-effort maintenance: an expiry failure must not abort the ingestion tick. */
async function runPublisherKeyExpiry() {
  try {
    const result = await expireDuePublisherKeys();
    return result.expiredCount;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown publisher-key expiry error";
    console.error(JSON.stringify({ event: "nooscape_publisher_key_expiry_failed", message }));
    return 0;
  }
}

/**
 * Best-effort, like the key expiry: the day's Owl's Catch is chosen once, by the first tick of the UTC day, and
 * every later tick finds it and does nothing. It runs after the ingestion work so it never delays a source, and
 * a failure (the table not there yet, the database busy) is logged and never fails the tick.
 */
async function runOwlsCatchSelection() {
  try {
    const result = await selectTodaysCatch();
    if (result.status !== "kept") console.log(JSON.stringify({ event: "nooscape_owls_catch", ...result }));
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown Owl's Catch error").replace(/[\r\n]+/g, " ").slice(0, 500);
    console.error(JSON.stringify({ event: "nooscape_owls_catch_failed", message }));
  }
}

/**
 * Best-effort, after the ingestion work like the Owl's Catch: the BNB fleet and template clustering keeps its two tables in
 * step with the registry rows (docs/bsc-clusters-2026-10-16.md). It reads the chain, so it runs only on a tick that claimed
 * sources: a paused control plane or a tick held back by the global interval fetches nothing, and so does this. It never
 * throws and a failure here never fails the tick, whatever it reports.
 */
async function runBscClusteringStep(tickStartedAt: number) {
  try {
    await runBscClustering({ tickStartedAt });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown BNB clustering error").replace(/[\r\n]+/g, " ").slice(0, 500);
    console.error(JSON.stringify({ event: "nooscape_bsc_clusters_failed", message }));
  }
}

/**
 * Best-effort, after the clustering for the same reasons: the BNB reputation read and the rater check keep their three tables in
 * step with the registry's feedback (docs/bsc-rater-credibility-2026-10-16.md). It reads the chain, so it runs only on a tick that
 * claimed sources, and it never throws; a failure here never fails the tick, whatever it reports. What it writes is internal.
 */
async function runBscRatersStep(tickStartedAt: number) {
  try {
    await runBscRaters({ tickStartedAt });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown BNB rater error").replace(/[\r\n]+/g, " ").slice(0, 500);
    console.error(JSON.stringify({ event: "nooscape_bsc_raters_failed", message }));
  }
}

/**
 * Best-effort, after the BNB steps for the same reasons: the Robinhood name step reads the registration link of a reviewed
 * Robinhood record that has no name of its own, through the safe fetch, and keeps the answer beside the record
 * (docs/approvals/2026-10-17-robinhood-names.md). It asks other people's hosts, so it runs only on a tick that claimed sources, a
 * paused control plane or a tick held back by the global interval asks nothing, and it never throws. A failure here never fails the
 * tick, whatever it reports.
 */
async function runRobinhoodNamesStep(tickStartedAt: number) {
  try {
    await runRobinhoodNames({ tickStartedAt });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown Robinhood names error").replace(/[\r\n]+/g, " ").slice(0, 500);
    console.error(JSON.stringify({ event: "nooscape_robinhood_names_failed", message }));
  }
}

/**
 * Best-effort, after the Robinhood names for the same reasons: the BNB registration-file step reads the file behind the web or ipfs
 * link of a listed BNB entry, through the safe fetch, so that the entry's template key is known for gate G1
 * (docs/approvals/2026-10-17-bnb-registration-files.md). It asks other people's hosts, so it runs only on a tick that claimed
 * sources, and it never throws; a failure here never fails the tick, whatever it reports. What it writes is internal.
 */
async function runBscRegistrationFilesStep(tickStartedAt: number) {
  try {
    await runBscRegistrationFiles({ tickStartedAt });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown BNB registration file error").replace(/[\r\n]+/g, " ").slice(0, 500);
    console.error(JSON.stringify({ event: "nooscape_bsc_files_failed", message }));
  }
}

/**
 * Best-effort, after the two steps above for the same reasons: the SAID name step reads the card that the metadata link of a SAID
 * identity names, through the safe fetch, so that the directory shows the name its registrant gave instead of "SAID agent <wallet
 * prefix>" (docs/approvals/2026-10-18-said-names.md). It asks other people's hosts, so it runs only on a tick that claimed sources,
 * and it never throws; a failure here never fails the tick, whatever it reports.
 */
async function runSaidNamesStep(tickStartedAt: number) {
  try {
    await runSaidNames({ tickStartedAt });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown SAID names error").replace(/[\r\n]+/g, " ").slice(0, 500);
    console.error(JSON.stringify({ event: "nooscape_said_names_failed", message }));
  }
}

/**
 * Best-effort, after the SAID names for the same reasons: the ratings step counts the NewFeedback and FeedbackRevoked events of the reputation
 * registry of each chain the identity pass reads beyond BNB Chain, so that the chain's "Ratings recorded" figure is a count and not "not
 * measured" (docs/extra-chain-ratings-2026-10-21.md). It reads the chain, so it runs only on a tick that claimed sources, at most once in 30
 * minutes for a chain, and it never throws; with its table not there it does nothing and says nothing. A failure here never fails the tick.
 */
async function runChainRatingsStep(tickStartedAt: number) {
  try {
    await runChainRatings({ tickStartedAt });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown ratings error").replace(/[\r\n]+/g, " ").slice(0, 500);
    console.error(JSON.stringify({ event: "nooscape_chain_ratings_failed", message }));
  }
}

/**
 * Best-effort, last, for the same reasons: the daily check of claimed agents asks the registry who owns each claim's agent that has
 * not been asked in 23 hours (at most 25 a run) and revokes a claim whose agent has changed hands (docs/claims-2026-10-18.md). It
 * reads the chain, so it runs only on a tick that claimed sources, it never throws, and with the claim tables missing it does nothing
 * and says nothing. A failure here never fails the tick.
 */
async function runClaimRecheckStep() {
  try {
    const result = await recheckClaims();
    if (result.checked > 0 || result.unavailable > 0) console.log(JSON.stringify({ event: "nooscape_claim_recheck", ...result }));
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown claim check error").replace(/[\r\n]+/g, " ").slice(0, 500);
    console.error(JSON.stringify({ event: "nooscape_claim_recheck_failed", message }));
  }
}

async function runApprovedSource(source: IngestionSource) {
  switch (source.protocol) {
    case "a2a":
      return runApprovedA2aSource(source, "scheduled");
    case "catalog":
      return runApprovedAgenstrySource(source, "scheduled");
    case "census":
      return runApprovedAgentEconomySource(source, "scheduled");
    case "solana_registry":
      // The Metaplex chain pass is the one unattended-safe mode: chain-facts-
      // only reads through the shared paced Solana RPC client, INSERT-IGNORE
      // ledger writes, and a snapshot persisted only after every attribution
      // succeeds — a failure leaves the cursor untouched so the next pass
      // re-detects the same changes.
      return runApprovedMetaplexRegistrySource(source, "scheduled", "activity");
    case "erc8004":
      // The forward, reorg-checked activity walk is the one unattended-safe
      // mode: it adds no reviewed records, the ledger writes are INSERT-IGNORE
      // idempotent, and a reorg fails the run loudly with the cursor untouched.
      return runApprovedRobinhoodRegistrySource(source, "scheduled", "activity");
    case "erc8004_reputation":
      // The ratings walk stays operator-paced until it has earned the same
      // scheduled flip the activity walk did (design §7): the backward leg is
      // a human-paced throttle defense, and the Cloudflare-fronted RPC blocks
      // unattended rapid ticks.
      throw new Error("Robinhood ERC-8004 reputation sources are manual-only and cannot run in the scheduled worker.");
    case "solana_8004":
      // The 8004 chain pass earned its scheduled flip (migration 0027) the
      // same way the Metaplex chain pass did (0021): the seed inventory was
      // staged, reviewed, and run by an operator (1,504 agents, an exact
      // chain match, zero events), and the diff pass is chain-facts-only with
      // INSERT-IGNORE ledger writes, a 98%-of-prior-live enumeration floor,
      // and per-closure confirmation reads — a failure leaves the cursor
      // untouched so the next pass re-detects the same changes.
      return runApproved8004SolanaSource(source, "scheduled");
    case "usdg_settlement":
      throw new Error("USDG settlement sources are manual-only and cannot run in the scheduled worker.");
    case "erc8004_bsc":
      // The BNB Chain identity pass is staged manual_only and may be flipped to
      // the scheduler by a reviewed migration once an operator has seeded it.
      // It is directory-only chain facts from FINALIZED blocks (no reorg risk),
      // INSERT-IGNORE and insert-only writes, and no URI fetching. A failure
      // leaves the cursor untouched; a partial run keeps the windows it
      // applied. runApprovedBscRegistrySource itself rejects a scheduled
      // trigger unless the source holds the scheduled policy.
      return runApprovedBscRegistrySource(source, "scheduled");
    case "erc8004_eth":
    case "erc8004_base":
    case "erc8004_arc": {
      // The Ethereum, Base and Arc identity passes are the BNB Chain pass on another chain (erc8004Chains.ts), staged manual_only and
      // handed to the scheduler only by a later reviewed migration, after an operator has run and checked a first pass. The pass
      // itself rejects a scheduled trigger unless the source holds the scheduled policy, and does not start while the chain's
      // switch is off, so an unflipped source, or a chain that is switched off, can never run unattended.
      const chain = erc8004ChainOfProtocol(source.protocol);
      if (!chain) throw new Error(`No scheduled adapter is available for protocol ${source.protocol}.`);
      return runApprovedErc8004ChainSource(chain, source, "scheduled");
    }
    case "solana_said":
      // The SAID identity pass is staged manual_only and earned its scheduled
      // flip from migration 0031 once an operator had seeded it (13,313
      // identities, an exact chain match). It is the reviewed directory-only
      // posture: one memcmp-filtered read, strict fail-closed decode, a
      // 98%-of-prior floor, and an upsert that adds no reviewed record. A
      // failure leaves the cursor untouched. runApprovedSaidSource itself
      // rejects a scheduled trigger unless the source holds the scheduled
      // policy, so an unflipped source can never run unattended.
      return runApprovedSaidSource(source, "scheduled");
    default:
      throw new Error(`No scheduled adapter is available for protocol ${source.protocol}.`);
  }
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
