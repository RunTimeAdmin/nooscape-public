import { applySolanaActivityWindow, listAgentDirectoryEntriesForSource, upsertAgentDirectoryEntries } from "../db";
import { queueSaidNameLinks, readSaidResolvedNames } from "../saidNames";
import { applySaidNames } from "../saidNamesCore";
import type { IngestionSource } from "../../drizzle/schema";
import { withIngestionRun } from "./runLifecycle";
import { isSaidChainSeedCursor, SAID_CHAIN_SOURCE_KEY } from "./saidChain";
import { fetchSaidPass } from "./saidPass";
import type { SaidIngestionResult } from "./types";

/**
 * Runs one approved SAID Protocol identity-registry pass. There is no observe
 * mode: the AgentIdentity account carries every chain fact inline (owner,
 * authority, metadata URI, badge flag, stake), so the on-chain read is the
 * only read. It re-reads every identity via a memcmp-filtered
 * getProgramAccounts, acknowledges the live set into the master directory,
 * and persists the `said:<slot>` cursor only after the whole snapshot
 * succeeds; a failure leaves the cursor untouched so the next pass starts
 * from the same place. The seed pass (no `said:` cursor yet) is a plain
 * inventory with no events. Every later pass also diffs against the source's
 * own directory rows and anchors each registration, authority transfer, and
 * metadata-link change to the transaction that made it (saidActivity.ts).
 * SAID never closes an identity: a vanished identity is counted in the run
 * result and never hidden.
 *
 * The chain carries no name for an identity, so the directory names it "SAID agent
 * <wallet prefix>"; the name step (saidNames.ts) reads the card each identity's
 * link names, and this pass lays the names it read over its drafts before it
 * upserts them, and queues the links of new identities for that step.
 *
 * Write order mirrors the 8004 pass: the activity ledger first, then the
 * directory upsert. The ledger is append-only and idempotent (INSERT-IGNORE on
 * a kind-aware key), so a failure between the two leaves the directory stale,
 * the next pass re-detects the same change, and the re-applied ledger rows are
 * no-ops. Writing the directory first would lose any event whose upsert
 * succeeded: the prior would already match the chain and nothing would
 * re-diff it.
 *
 * Directory-only, like the other chain passes: nothing here writes an agent,
 * a snapshot, or an evidence event, so no run of this source can add a
 * reviewed record and its runs must never be projected. The source is
 * registered manual_only; unattended runs are accepted only from a source an
 * operator has explicitly handed to the scheduler, and replays are rejected
 * outright.
 */
export async function runApprovedSaidSource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual"
): Promise<SaidIngestionResult> {
  if (trigger === "replay") {
    throw new Error("SAID registry replays are rejected outright.");
  }
  if (trigger === "scheduled" && source.executionPolicy !== "scheduled") {
    throw new Error("Scheduled SAID registry runs require the scheduled execution policy.");
  }
  if (source.protocol !== "solana_said" || source.sourceKey !== SAID_CHAIN_SOURCE_KEY) {
    throw new Error("The SAID chain pass is approved for the SAID Solana agent registry only.");
  }

  return withIngestionRun(source, trigger, 2, async runId => {
    const seed = isSaidChainSeedCursor(source.cursor);
    const priorRows = await listAgentDirectoryEntriesForSource(source.id);
    const prior = new Map(priorRows.map(row => [row.externalKey, { registrant: row.registrant, profileUriHash: row.profileUriHash }]));
    const snapshot = await fetchSaidPass({ source, seed, prior });
    await applySolanaActivityWindow({ source, events: snapshot.events });
    // The upsert rewrites every identity's name, and the chain carries none, so the names the name step read from the identities'
    // links are laid over the drafts first (docs/approvals/2026-10-18-said-names.md); without that a name would be gone within the hour.
    const resolvedNames = await readSaidResolvedNames(source.id);
    // Unlike the Metaplex API pilot rows, this pass owns locatorHost (the
    // metadata URI is a chain read), so a URI edit rewrites the host honestly.
    await upsertAgentDirectoryEntries({ source, runId, entries: applySaidNames(snapshot.drafts, resolvedNames) });
    // Queueing links for the name step is best effort: the pass has done its work, and a link missed now is queued by the next pass.
    try {
      await queueSaidNameLinks(source, snapshot.links);
    } catch (error) {
      console.warn(`[SAID] pass ${snapshot.slot}: the links for the name step could not be queued: ${error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 200) : "unknown error"}`);
    }
    if (snapshot.unanchoredCount > 0 || snapshot.deferredCount > 0 || snapshot.vanishedCount > 0) {
      // The run record has no field for these, so the server log carries them.
      // A rising unanchored count after a program upgrade is the signal that
      // the instruction vocabulary changed.
      console.warn(
        `[SAID] pass ${snapshot.slot}: ${snapshot.unanchoredCount} change(s) recorded without a ledger anchor, ${snapshot.deferredCount} identity(ies) deferred to the next pass, ${snapshot.vanishedCount} previously acknowledged identity(ies) missing from the listing.`
      );
    }
    return {
      requestCount: snapshot.requestCount,
      discoveredCount: snapshot.enumeratedCount,
      acceptedCount: snapshot.drafts.length,
      // Exceptions the operator should know about: identities missing from the
      // listing (within the floor) and changes recorded without a ledger anchor.
      rejectedCount: snapshot.vanishedCount + snapshot.unanchoredCount,
      nextCursor: `said:${snapshot.slot}`,
    };
  });
}
