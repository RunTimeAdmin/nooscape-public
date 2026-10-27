import type { IngestionSource } from "../../drizzle/schema";
import { BSC_CHAIN, type Erc8004RunBudget } from "./erc8004Chains";
import { runApprovedErc8004ChainSource } from "./runErc8004Chain";
import type { Erc8004IngestionResult } from "./types";

/**
 * The BNB Smart Chain view of the ERC-8004 identity pass: a forward walk from the registry's deploy block to the FINALIZED head
 * under one cursor (`bsc:<next block>`), then the same walk tailing the head. Facts only and no fetching (operator decisions
 * D1 and D2).
 *
 * The walk is one implementation for every chain (runErc8004Chain.ts), driven by the chain's entry in erc8004Chains.ts, and its
 * long description (strict chain order, a cursor that advances only past windows fully applied, progress kept after a later
 * failure, the listing refresh, the manual_only source) is there. This file gives the BNB Chain's entry its long-standing
 * names, and its behaviour is the one the pass had before the importer was made generic; the BNB tests hold that unchanged.
 */
type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export function runApprovedBscRegistrySource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual",
  mode: "observe" | "backfill" | "registrants" | "activity" = "activity",
  deps: { rpc?: RpcCall; now?: () => number; budget?: Partial<Erc8004RunBudget> } = {}
): Promise<Erc8004IngestionResult> {
  return runApprovedErc8004ChainSource(BSC_CHAIN, source, trigger, mode, deps);
}
