import {
  applySolanaActivityWindow,
  listAgentDirectoryEntriesForSource,
  listAgentRegistrationResolutions,
  markAgentDirectoryEntriesClosed,
  upsertAgentDirectoryChainLinks,
  upsertAgentDirectoryEntries,
  upsertAgentRegistrationResolutions,
} from "../db";
import type { IngestionSource } from "../../drizzle/schema";
import {
  fetchSolana8004ChainState,
  isSolana8004ChainSeedCursor,
  SOLANA_8004_CHAIN_SOURCE_KEY,
  type Solana8004PriorResolution,
} from "./solana8004";
import { withIngestionRun } from "./runLifecycle";
import type { Solana8004IngestionResult } from "./types";

/**
 * Runs one approved 8004 Solana agent registry pass. There is no observe mode:
 * the AgentAccount carries every chain fact inline (owner, asset, registration
 * URI), so the on-chain pass is the only read. It re-reads the whole program
 * via getProgramAccounts, diffs state against the source's own directory rows,
 * acknowledges diff events into the Solana ledger, and persists the
 * `s8004:<slot>` cursor only after the whole snapshot — including every
 * attribution — succeeds; a failure leaves the cursor untouched so the next
 * pass re-detects the same changes. The seed pass (no `s8004:` cursor yet) is
 * a plain inventory: every live account is upserted, zero events, so the next
 * pass can diff against real prior state.
 *
 * Unattended runs arrive only as trigger "scheduled" against a source the
 * operator flipped to the scheduled execution policy — the preset registers
 * the source manual_only at birth, so nothing runs until an operator drives
 * the seed pass from /admin/sources. Replays are rejected outright.
 */
export async function runApproved8004SolanaSource(
  source: IngestionSource,
  trigger: "manual" | "scheduled" | "replay" = "manual"
): Promise<Solana8004IngestionResult> {
  if (trigger === "replay") {
    throw new Error("8004 Solana registry replays are rejected outright.");
  }
  if (trigger === "scheduled" && source.executionPolicy !== "scheduled") {
    throw new Error("Scheduled 8004 Solana registry runs require the scheduled execution policy.");
  }
  if (source.protocol !== "solana_8004" || source.sourceKey !== SOLANA_8004_CHAIN_SOURCE_KEY) {
    throw new Error("The 8004 chain pass is approved for the 8004 Solana agent registry only.");
  }

  return withIngestionRun(source, trigger, 1, async runId => {
    // Only an `s8004:` cursor counts as a completed inventory: absent, empty,
    // and foreign cursors all seed, and a re-inventory is always safe (upserts
    // only, zero events).
    const seed = isSolana8004ChainSeedCursor(source.cursor);
    const priorRows = await listAgentDirectoryEntriesForSource(source.id);
    const prior = new Map(
      priorRows.map(row => [
        row.externalKey,
        {
          displayName: row.displayName,
          locatorHost: row.locatorHost,
          registrant: row.registrant,
          // 8004 chain-facts columns (migration 0026): both null until the
          // row's first live pass under this schema — a closure whose PDA is
          // still unknown closes unconfirmed, and a null prior URI hash
          // adopts the chain state silently (the backfill rule).
          accountPubkey: row.accountPubkey,
          profileUriHash: row.profileUriHash,
          closed: row.assetClosedAt !== null,
        },
      ])
    );
    // Step-3 prior resolutions (migration 0028), keyed by uriHash — the
    // fetch queue's idempotency key: a hash that already resolved or went
    // terminal is never refetched, a failed one retries up to its cap.
    const priorResolutionRows = await listAgentRegistrationResolutions(source.id);
    const priorResolutions = new Map<string, Solana8004PriorResolution>(
      priorResolutionRows.map(row => [
        row.uriHash,
        {
          externalKey: row.externalKey,
          uriHash: row.uriHash,
          status: row.status,
          resolvedName: row.resolvedName,
          attempts: row.attempts,
        },
      ])
    );
    const snapshot = await fetchSolana8004ChainState({ source, seed, prior, priorResolutions });
    // The ledger writes first: it is the append-only record, and with the
    // (sourceId, signature, externalKey, kind) key plus instruction-matched
    // anchors it is idempotent — a failure in the upsert or the closure marker
    // below leaves the prior state stale, so the next pass re-detects the same
    // diff, the INSERT-IGNORE re-apply is a no-op, and the failed write simply
    // retries. Writing it last would lose any event whose upsert succeeded:
    // the prior would already match the chain, nothing would re-diff, and the
    // event would never be recorded.
    await applySolanaActivityWindow({ source, events: snapshot.events });
    // Unlike the Metaplex API pilot rows, this pass owns locatorHost — the
    // registration URI is a chain read — so no preserveLocatorHost: a URI
    // edit rewrites the host honestly. Live acknowledgements clear any prior
    // closure marker so a re-registered asset returns to public reads.
    await upsertAgentDirectoryEntries({
      source,
      runId,
      entries: snapshot.drafts,
      clearAssetClosed: true,
    });
    // Hide-once closures: the adapter's marker list covers anchored and
    // unanchored closures alike (an unanchored closure is still a real
    // disappearance), is bounded by the per-pass event cap, and deferred
    // closures stay unmarked so the next pass re-detects them. Writing the
    // marker last keeps an interrupted pass re-detectable: an unmarked row
    // re-emits its closure event, the ledger dedupes, and the marker retries.
    await markAgentDirectoryEntriesClosed({
      source,
      runId,
      externalKeys: snapshot.closedExternalKeys,
    });
    // Step-3 auxiliary records (migration 0028), after the closure marker so
    // an interrupted pass retries from the ledger-first order above. Both are
    // idempotent upserts keyed by (sourceId, uriHash) / the link unique key:
    // meta-name resolution rows re-upsert every pass, fetch-failure rows
    // record their retry state, and chain links are upsert-only — no
    // un-linking in v1. Per-fetch failures are recorded statuses inside
    // snapshot.resolutions, never pass failures; a failure in these writes is
    // a database failure and fails the pass like any other write.
    await upsertAgentRegistrationResolutions({ source, drafts: snapshot.resolutions });
    await upsertAgentDirectoryChainLinks({ source, drafts: snapshot.chainLinks });
    return {
      requestCount: snapshot.requestCount,
      discoveredCount: snapshot.enumeratedCount,
      acceptedCount: snapshot.drafts.length,
      rejectedCount: snapshot.unknownCount,
      nextCursor: `s8004:${snapshot.slot}`,
    };
  });
}
