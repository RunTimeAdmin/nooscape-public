import type { IngestionSource } from "../../drizzle/schema";
import { erc8004ChainOfProtocol } from "./erc8004Chains";
import { runApproved8004SolanaSource } from "./run8004Solana";
import { runApprovedA2aSource } from "./runA2a";
import { runApprovedAgencSource } from "./runAgenc";
import { runApprovedAgentEconomySource } from "./runAgentEconomy";
import { runApprovedBscRegistrySource } from "./runBsc";
import { runApprovedCatalogSource } from "./runCatalog";
import { runApprovedErc8004ChainSource } from "./runErc8004Chain";
import { runApprovedMetaplexRegistrySource } from "./runMetaplex";
import { runApprovedRobinhoodRegistrySource } from "./runRobinhood";
import { runApprovedRobinhoodReputationSource } from "./runRobinhoodReputation";
import { runApprovedSaidSource } from "./runSaid";
import { runApprovedUsdgSettlementSource } from "./runUsdg";

/**
 * The one place a source is sent to its adapter, for the scheduled worker (worker.ts) and for an operator's run (routers/liveData.ts
 * `runSource`). Each adapter still decides for itself whether it may run: a scheduled trigger is refused unless the source holds the
 * scheduled policy, and an identity pass does not start while its chain's switch is off.
 *
 * The scheduled worker runs every source in the `activity` mode, the one unattended-safe mode of the adapters that have modes: the
 * Metaplex chain pass, the Robinhood Chain activity walk and the chain passes. So the mode checks below refuse only an operator's choice.
 */

export type RunTrigger = "manual" | "scheduled";
export type RunMode = "observe" | "backfill" | "registrants" | "activity";

/** A mode the source's adapter does not have. The words are fixed and name the kind of source, never a value. */
export class SourceModeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceModeRefusedError";
  }
}

/** A source the scheduled worker never runs, because its adapter is paced by an operator. */
export class ManualOnlySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualOnlySourceError";
  }
}

/** A protocol with no adapter: a new value is never run by accident. */
export class NoSourceAdapterError extends Error {
  constructor(protocol: string, trigger: RunTrigger) {
    super(trigger === "scheduled" ? `No scheduled adapter is available for protocol ${protocol}.` : `No bounded adapter is available for ${protocol}.`);
    this.name = "NoSourceAdapterError";
  }
}

const activityOnly = (what: string) => (mode: RunMode) => (mode === "activity" ? null : `The ${what} supports the chain activity pass only.`);

/**
 * The adapters by protocol. `refuse` says why a mode cannot be run (null when it can), `manualOnly` is the refusal the scheduled worker
 * gives, and `run` runs the adapter. The chain passes of the extra chains are not listed: they are found by protocol in ERC8004_CHAINS.
 */
const RUNNERS = {
  a2a: { run: (source: IngestionSource, trigger: RunTrigger) => runApprovedA2aSource(source, trigger) },
  catalog: { run: (source: IngestionSource, trigger: RunTrigger) => runApprovedCatalogSource(source, trigger) },
  census: { run: (source: IngestionSource, trigger: RunTrigger) => runApprovedAgentEconomySource(source, trigger) },
  // The Metaplex API pilot (observe) and the on-chain chain pass (activity) are its only surfaces; the walk modes have no meaning. The
  // chain pass is the one unattended-safe mode: chain-facts-only reads, INSERT-IGNORE ledger writes, a snapshot persisted only after
  // every attribution succeeds, so a failure leaves the cursor untouched.
  solana_registry: {
    refuse: (mode: RunMode) => (mode === "backfill" || mode === "registrants" ? "The Metaplex Solana registry supports the observe and activity modes only." : null),
    run: (source: IngestionSource, trigger: RunTrigger, mode: RunMode) => runApprovedMetaplexRegistrySource(source, trigger, mode === "activity" ? "activity" : "observe"),
  },
  // The 8004, SAID and AgenC registries have one surface each, the on-chain pass (an inventory until a cursor exists, then diff or
  // refresh passes), earned their scheduled flips by migration after an operator's seed run, and refuse a scheduled trigger themselves
  // unless the source holds the scheduled policy.
  solana_8004: { refuse: activityOnly("8004 Solana registry"), run: (source: IngestionSource, trigger: RunTrigger) => runApproved8004SolanaSource(source, trigger) },
  solana_said: { refuse: activityOnly("SAID Solana registry"), run: (source: IngestionSource, trigger: RunTrigger) => runApprovedSaidSource(source, trigger) },
  solana_agenc: { refuse: activityOnly("AgenC Solana registry"), run: (source: IngestionSource, trigger: RunTrigger) => runApprovedAgencSource(source, trigger) },
  // The BNB Chain pass keeps its own entry point (runBsc.ts): the same chain pass as the extra chains', on BSC_CHAIN.
  erc8004_bsc: { refuse: activityOnly("BNB Chain identity registry"), run: (source: IngestionSource, trigger: RunTrigger) => runApprovedBscRegistrySource(source, trigger) },
  // Robinhood Chain's identity registry: the forward, reorg-checked activity walk is its unattended-safe mode; an operator also has the
  // observe, backfill and registrants walks, and the adapter refuses a mode the saved position cannot honor.
  erc8004: { run: (source: IngestionSource, trigger: RunTrigger, mode: RunMode) => runApprovedRobinhoodRegistrySource(source, trigger, mode) },
  // The ratings walk stays operator-paced until it earns a scheduled flip: the backward leg is a human-paced throttle defense, and the
  // node blocks unattended rapid ticks. It has only the backward backfill window and the forward ratings fill.
  erc8004_reputation: {
    manualOnly: "Robinhood ERC-8004 reputation sources are manual-only and cannot run in the scheduled worker.",
    run: (source: IngestionSource, trigger: RunTrigger, mode: RunMode) => runApprovedRobinhoodReputationSource(source, trigger, mode === "activity" ? "activity" : "backfill"),
  },
  usdg_settlement: {
    manualOnly: "USDG settlement sources are manual-only and cannot run in the scheduled worker.",
    run: (source: IngestionSource, trigger: RunTrigger) => runApprovedUsdgSettlementSource(source, trigger),
  },
};

type Runner = { refuse?: (mode: RunMode) => string | null; manualOnly?: string; run: (source: IngestionSource, trigger: RunTrigger, mode: RunMode) => Promise<unknown> };

/** What a run answers: the result of whichever adapter ran. */
export type RunSourceResult = Awaited<ReturnType<(typeof RUNNERS)[keyof typeof RUNNERS]["run"]>> | Awaited<ReturnType<typeof runApprovedErc8004ChainSource>>;

/** Runs a source with its adapter. Throws SourceModeRefusedError, ManualOnlySourceError or NoSourceAdapterError before any adapter runs. */
export async function runSource(source: IngestionSource, trigger: RunTrigger, mode: RunMode = "activity"): Promise<RunSourceResult> {
  const runner: Runner | undefined = (RUNNERS as Record<string, Runner>)[source.protocol];
  if (runner) {
    if (trigger === "scheduled" && runner.manualOnly) throw new ManualOnlySourceError(runner.manualOnly);
    const refused = runner.refuse?.(mode) ?? null;
    if (refused) throw new SourceModeRefusedError(refused);
    return (await runner.run(source, trigger, mode)) as RunSourceResult;
  }
  // Each extra chain's identity pass is the BNB Chain pass on another chain (erc8004Chains.ts), staged manual_only and handed to the
  // scheduler only by a later reviewed migration. The pass refuses a scheduled trigger unless the source holds the scheduled policy, and
  // does not start while the chain's switch is off, so an unflipped source, or a chain that is switched off, can never run unattended.
  const chain = erc8004ChainOfProtocol(source.protocol);
  if (chain) {
    const refused = activityOnly(`${chain.chainLabel} identity registry`)(mode);
    if (refused) throw new SourceModeRefusedError(refused);
    return await runApprovedErc8004ChainSource(chain, source, trigger);
  }
  throw new NoSourceAdapterError(source.protocol, trigger);
}
