import {
  applySolanaActivityWindow,
  listAgentDirectoryEntriesForSource,
  markAgentDirectoryEntriesClosed,
  persistSolanaRegistryObservation,
  upsertAgentDirectoryEntries,
} from "../db";
import type { IngestionSource } from "../../drizzle/schema";
import { fetchMetaplexChainState, isMetaplexChainSeedCursor, METAPLEX_CHAIN_SOURCE_KEY } from "./metaplexChain";
import { fetchMetaplexRegistry } from "./metaplex";
import { withIngestionRun } from "./runLifecycle";
import type { SolanaRegistryIngestionResult } from "./types";

/**
 * Runs one approved bounded Metaplex Solana registry pass. Observe mode is the
 * original operator-paced API pilot: it re-reads the upstream REST catalog for
 * reviewed intake and never advances a chain cursor. Activity mode is the
 * on-chain pass: it re-reads the identity program and Core assets, diffs state
 * against the source's own directory rows, acknowledges diff events into the
 * Solana ledger, and persists the `sync2:<slot>` cursor only after the whole
 * snapshot succeeds. The seed pass (no `sync2:` cursor yet) is a plain inventory: every
 * live asset is upserted, zero events, so the next pass can diff against real
 * prior state. Unattended runs arrive only as trigger "scheduled" against a
 * source handed to the scheduler (migration 0021) and always run activity.
 */
export async function runApprovedMetaplexRegistrySource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual",
  mode: "observe" | "activity" = "observe"
): Promise<SolanaRegistryIngestionResult> {
  // The API pilot stays operator-paced: scheduled runs always take the chain
  // pass, and replays are rejected outright.
  if (trigger === "replay" || (trigger === "scheduled" && mode !== "activity")) {
    throw new Error("Scheduled Metaplex Solana registry runs execute the chain activity pass, and replays are rejected outright.");
  }
  if (trigger === "scheduled" && source.executionPolicy !== "scheduled") {
    throw new Error("Scheduled Metaplex Solana registry runs require the scheduled execution policy.");
  }
  if (mode === "activity" && (source.protocol !== "solana_registry" || source.sourceKey !== METAPLEX_CHAIN_SOURCE_KEY)) {
    throw new Error("The chain activity pass is approved for the Metaplex Solana agent registry only.");
  }

  return withIngestionRun(source, trigger, 1, async runId => {
    if (mode === "observe") {
      const snapshot = await fetchMetaplexRegistry(source);
      for (const entry of snapshot.observations) {
        await persistSolanaRegistryObservation({ source, runId, candidate: entry.candidate, observation: entry.observation });
      }
      // Insert-only acknowledgements: the API pilot may add directory rows for
      // assets the chain pass has not acknowledged yet, but it can never
      // update an existing row — the chain activity pass is the only writer
      // of a row's display name and registrant, so an operator "Run once"
      // click can no longer overwrite chain names or null chain owners and
      // manufacture fake diff events on the next chain pass.
      await upsertAgentDirectoryEntries({ source, runId, entries: snapshot.directory, insertOnly: true });
      // The observe pilot re-persists the existing cursor verbatim: it shares
      // this source row with the chain activity pass, and finishIngestionRun
      // writes the cursor unconditionally — returning null here would wipe a
      // `sync2:` chain cursor and force a full re-seed (silent adopt, zero
      // diff events) on the next activity pass.
      return {
        requestCount: snapshot.pagesFetched,
        discoveredCount: snapshot.discoveredCount,
        acceptedCount: snapshot.observations.length,
        rejectedCount: snapshot.rejectedCount,
        nextCursor: source.cursor,
      };
    }

    // The seed decision reads the persisted cursor: only a `sync2:` cursor
    // counts as an inventory. The v1 `sync:` cursors were written by the
    // 2026-10-11 build whose getMultipleAccounts parser misread every live
    // asset as closed, so a v1 cursor re-inventories (upserts only, zero
    // events — a re-inventory is always safe).
    const seed = isMetaplexChainSeedCursor(source.cursor);
    const priorRows = await listAgentDirectoryEntriesForSource(source.id);
    const prior = new Map(
      priorRows.map(row => [
        row.externalKey,
        { displayName: row.displayName, registrant: row.registrant, closed: row.assetClosedAt !== null },
      ])
    );
    const snapshot = await fetchMetaplexChainState({ source, seed, prior });
    // The ledger writes first: it is the append-only record, and with the
    // (sourceId, signature, externalKey, kind) key it is idempotent — a
    // failure in the upsert or the closure marker below leaves the prior state
    // stale, so the next pass re-detects the same diff, the INSERT-IGNORE
    // re-apply is a no-op, and the failed write simply retries. Writing it
    // last would lose any event whose upsert succeeded: the prior would
    // already match the chain, nothing would re-diff, and the event would
    // never be recorded.
    await applySolanaActivityWindow({ source, events: snapshot.events });
    // Chain drafts carry no locator host; the upsert must never null the
    // locatorHost the API pilot wrote for a row it already knows. Live
    // acknowledgements clear any prior closure marker so a re-registered
    // asset returns to public reads.
    await upsertAgentDirectoryEntries({
      source,
      runId,
      entries: snapshot.drafts,
      preserveLocatorHost: true,
      clearAssetClosed: true,
    });
    // Hide-once closures: exactly one asset_closed ledger event per closure,
    // then the row is marked (keeping its last name and owner) and every
    // later pass skips it without an event. The events were already accepted
    // under the per-pass cap, so the marker list is bounded by that cap.
    // Writing the marker last keeps an interrupted pass re-detectable: an
    // unmarked row re-emits its closure event, the ledger dedupes, and the
    // marker retries.
    await markAgentDirectoryEntriesClosed({
      source,
      runId,
      externalKeys: snapshot.events.filter(event => event.kind === "asset_closed").map(event => event.externalKey),
    });
    return {
      requestCount: snapshot.requestCount,
      discoveredCount: snapshot.enumeratedCount,
      acceptedCount: snapshot.drafts.length,
      rejectedCount: snapshot.unknownCount,
      nextCursor: `sync2:${snapshot.slot}`,
    };
  });
}
