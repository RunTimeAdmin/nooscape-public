import { listAgentDirectoryEntriesForSource, upsertAgentDirectoryEntries } from "../db";
import type { IngestionSource } from "../../drizzle/schema";
import { AGENC_CHAIN_SOURCE_KEY, fetchAgencChainState, isAgencChainSeedCursor } from "./agencChain";
import { withIngestionRun } from "./runLifecycle";
import type { AgencIngestionResult } from "./types";

/**
 * Runs one approved AgenC agent-registry pass (docs/agenc-solana-2026-10-26.md). There is no observe mode: the AgentRegistration account
 * carries every chain fact inline (authority, endpoint, profile link, counters, stake), so the on-chain read is the only read. It re-reads
 * every agent via a memcmp-filtered getProgramAccounts, acknowledges the live set into the master directory, and persists the
 * `agenc:<slot>` cursor only after the whole snapshot succeeds; a failure leaves the cursor untouched so the next pass starts from the same
 * place. The first pass (no `agenc:` cursor yet) is a plain inventory. AgenC never closes an agent (deregistering leaves an Inactive
 * tombstone): a vanished agent is counted in the run result and never hidden.
 *
 * Directory-only, like the other chain passes: nothing here writes an agent, a snapshot, an evidence event or a ledger row, so no run of
 * this source can add a reviewed record and its runs must never be projected. The source is registered manual_only; unattended runs are
 * accepted only from a source an operator has explicitly handed to the scheduler, and replays are rejected outright.
 */
export async function runApprovedAgencSource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual"
): Promise<AgencIngestionResult> {
  if (trigger === "replay") {
    throw new Error("AgenC registry replays are rejected outright.");
  }
  if (trigger === "scheduled" && source.executionPolicy !== "scheduled") {
    throw new Error("Scheduled AgenC registry runs require the scheduled execution policy.");
  }
  if (source.protocol !== "solana_agenc" || source.sourceKey !== AGENC_CHAIN_SOURCE_KEY) {
    throw new Error("The AgenC chain pass is approved for the AgenC Solana agent registry only.");
  }

  return withIngestionRun(source, trigger, 2, async runId => {
    const seed = isAgencChainSeedCursor(source.cursor);
    const priorRows = await listAgentDirectoryEntriesForSource(source.id);
    const snapshot = await fetchAgencChainState({ source, seed, priorKeys: new Set(priorRows.map(row => row.externalKey)) });
    // This pass owns locatorHost (the endpoint and the profile link are chain reads), so an edit rewrites the host honestly.
    await upsertAgentDirectoryEntries({ source, runId, entries: snapshot.drafts });
    if (snapshot.vanishedCount > 0 || snapshot.tailResidueCount > 0) {
      // The run record has no field for these, so the server log carries them. A rising residue count after a program upgrade is the
      // signal that the account layout changed.
      console.warn(
        `[AGENC] pass ${snapshot.slot}: ${snapshot.vanishedCount} previously acknowledged agent(s) missing from the listing, ${snapshot.tailResidueCount} account(s) with bytes past the last field.`
      );
    }
    return {
      requestCount: snapshot.requestCount,
      discoveredCount: snapshot.enumeratedCount,
      acceptedCount: snapshot.drafts.length,
      // The exception the operator should know about: agents missing from the listing (within the floor).
      rejectedCount: snapshot.vanishedCount,
      nextCursor: `agenc:${snapshot.slot}`,
    };
  });
}
