# Forward cursor for the Robinhood walks — design (2026-10-10)

Status: implemented (2026-10-11). The forward walk rides mode "activity":
after `ac:done` the next activity run seeds `fw:<hw>#<hash>` from the ledger
high-water (`readAgentDirectoryActivityHighWater`) and each later run
re-checks that anchor against the chain before scanning one bounded window
(`ROBINHOOD_FORWARD_FINALITY_MARGIN_BLOCKS` = 600,
`ROBINHOOD_FORWARD_WINDOW_BLOCKS` = 2,000,000, in
`server/ingestion/robinhood.ts`). A reorg stops the run as
`RobinhoodRegistryReorgError` with the cursor untouched; the rewind is §3
below. Since 2026-10-11 the walk is automated: once the cursor reaches `fw:`
territory, migration `0017_erc8004_scheduled_walk.sql` hands the source to
the scheduled worker (15-minute due cadence), whose erc8004 case runs
activity mode unattended — the runner accepts trigger `scheduled` only
against a `scheduled` policy, and operator clicks stay allowed on any policy.

The design was triggered by RECHECK3 §4.2 ("live counts that are frozen"):
the `bf:`/`rb:`/`ac:` walks are backward-only.
Once a walk reaches `done`, nothing new is recorded except Registered events in
the observe window. As of the recheck the public activity totals were frozen
at an Oct 8 morning cutoff — 275 URI updates shown against a chain truth of
439, 134 mints unmeasured — while the panel still said "live counts".

The interim fix shipped with this document: every activity count is now
labelled "as of block N" (`readAgentDirectoryActivityTotals` →
`measuredThroughBlock`, the ledger's `MAX(blockNumber)`), and the census
heading says "registering", not "running". This document designs the real fix:
a forward, reorg-safe cursor so the walks keep up with the chain head.

## Current mechanics (what exists today)

- One persisted position per source: `ingestion_sources.cursor`, snapshotted
  into `ingestion_runs.cursorBefore` and written transactionally as
  `cursorAfter`/`nextCursor` by `finishIngestionRun`.
- The ERC-8004 walks share that one position with an ordered, fail-closed
  progression: `bf:<block>` → `bf:done` → `rb:<block>` → `rb:done` →
  `ac:<block>` → `ac:done` (`parseRobinhoodBackfillCursor`,
  `parseRobinhoodRegistrantCursor`, `parseRobinhoodActivityCursor` in
  `server/ingestion/robinhood.ts`). Every parser rejects unknown shapes.
- All three walks move **backward** (head → genesis); `done` is terminal.
- Observe mode (the scheduled "newest window" scan) covers **Registered only**,
  in a capped 2M-block window; Transfer and URIUpdated are never re-scanned
  after the activity walk finishes.
- Appliers are idempotent: the activity ledger is keyed
  `(sourceId, transactionHash, logIndex)` with INSERT IGNORE, and the rollups
  are recomputed from the whole ledger, so replaying any window converges.

## Design

### 1. Cursor extension: `fw:` positions

After `ac:done`, the next activity-walk run transitions the cursor to a
forward position:

- `fw:<block>#<blockHash>` — the last safely processed block and its hash.
- `ac:done` remains valid: a run seeing `ac:done` seeds the forward walk at the
  ledger's current high-water block (`MAX(blockNumber)`, the same fact the
  public label uses) and rewrites the cursor to `fw:<hw>#<hash>` in the same
  run.
- `parseRobinhoodForwardCursor` fails closed on anything else, matching the
  existing parser discipline. The ordered-progression rule is preserved:
  a `fw:` position is reachable only through `ac:done`.

### 2. Forward window per run

One scheduled run advances one bounded window:

- `fromBlock = fwBlock + 1`
- `toBlock = min(chainHead − FINALITY_MARGIN, fwBlock + FORWARD_WINDOW_BLOCKS)`
- Fetch Transfer and URIUpdated logs for the window (the existing
  `fetchActivityLogs` two-single-topic calls, unchanged) plus Registered logs
  (closing the ack/mint tail gap the recheck measured: 35 missing entries,
  134 unmeasured mints).
- Apply through the existing window appliers (INSERT IGNORE + rollup
  recompute). Idempotency makes a replayed window safe.
- Persist `fw:<toBlock>#<getBlockHash(toBlock)>`.

Parameters (initial values, tune after observing live runs):

- `FINALITY_MARGIN`: 600 blocks (~1 minute at ≈0.1 s blocks). Robinhood Chain
  reorgs are not characterized yet; the margin plus the hash check below is
  the conservative pair.
- `FORWARD_WINDOW_BLOCKS`: 2,000,000 per run — the RPC's block-range ceiling
  for single-value topic filters (the walk fetches one topic per call). Raised
  from 100,000 after measuring the chain at ≈141k blocks/h on 2026-10-11: a
  manual-only source at the old budget would have needed dozens of clicks per
  day just to hold position. Adaptive narrowing still guards dense windows.

### 3. Reorg handling

Each run starts by re-checking the stored anchor:

1. `eth_getBlockByNumber(fwBlock)` → compare the returned hash with the stored
   `#<hash>` half.
2. On match: proceed normally.
3. On mismatch (reorg deeper than the finality margin, or an RPC serving a
   different fork): **fail the run loudly** — set the run status `failed` with
   a reorg-specific error summary and leave the cursor untouched. Do not
   auto-truncate: an automated `DELETE FROM agent_directory_chain_activity
   WHERE blockNumber > ?` against a misread anchor is a worse failure mode
   than a paused walk. The operator runbook then walks back to the common
   ancestor (block explorer), sets `fw:<ancestor>#<hash>` via the console, and
   the next run replays the window idempotently.

This is deliberately minimal: v1 treats a reorg as an operator-visible stop,
not a self-healing event. Reorg auto-rewind can layer on later once the
anchor-check telemetry shows what the chain actually does.

### 4. What each stream gains

| Stream | Today after `ac:done` | With `fw:` |
|---|---|---|
| Registered | observe window only (2M blocks, capped) | every window, unbounded tail |
| Transfer | frozen at walk point | every window |
| URIUpdated | frozen at walk point (275 vs 439 true at recheck) | every window |
| MetadataSet / MetadataUpdate | not ingested at all | out of scope here; needs its own decoder pass (17,878 + 8,994 events) |

### 5. Public-surface consequences

- The "as of block N" chip starts moving forward on its own; the catch-up
  sentence ("the walk is still catching up to the chain head") becomes
  accurate only during genuine catch-up.
- `measuredThroughBlock` needs no API change — it derives from the ledger.
- Current-owner tracking (RECHECK3 §4.3, "minsters presented as runners")
  becomes buildable from the now-current Transfer ledger: maintain
  `current_owner` per external key in the same applier pass, then group the
  census by it with "registered by" as the secondary line.

## Implementation order

1. `parseRobinhoodForwardCursor` + cursor-format tests (pure, fails closed).
2. Anchor re-check helper (`getBlockHash` compare) + tests.
3. Forward window runner in the robinhood ingestion path + applier reuse.
4. Console/operator surface: cursor display already shows the raw string;
   add the reorg rewind step to the runbook.
5. Ship behind the existing source schedule; watch run summaries for
   `ResponseTooLarge` narrowing and reorg stops.

## Addendum 2026-10-13: which console button can run from which position

The identity registry's four walks share one persisted position that only moves forward:

| Position | Walk that can run | Console button |
| --- | --- | --- |
| none (fresh source) | backfill, or the registrant walk | Backfill window, Fill registrants |
| `bf:<block>` | backfill | Backfill window |
| `bf:done`, `rb:<block>` | registrant walk | Fill registrants |
| `rb:done`, `ac:<block>`, `ac:done`, `fw:<block>#<hash>` | activity walk (forward from `ac:done`) | Fill activity |

"Run once" (observe) fits every position and keeps the walk position intact. The console used to offer all
four buttons everywhere, so on the forward walk (where the scheduled source sits) a click on Backfill window or Fill registrants was a
guaranteed refusal. The adapter refused it with a validation error, but only after a run row existed and two
RPC calls were spent, so each mistaken click was recorded as a failed run and raised the source's failure count,
the same false failure the reputation source had (see the reputation addendum of the same date).

Fixed the same way, plus one change to what the operator sees:

1. **Refuse before a run exists.** `assertRobinhoodModeFitsCursor` (in `robinhood.ts`) is called by
   `runApprovedRobinhoodRegistrySource` for operator clicks before `withIngestionRun`. It derives the rule from
   the adapter's own cursor parsers (`robinhoodWalkModesForCursor`), so the guard cannot drift from what the
   adapter accepts, and the adapter keeps its checks as a second line of defense. A refused click writes no run
   row, spends no RPC call, and never touches the failure count. **Scheduled runs are deliberately not
   pre-checked:** they always run the activity walk from `fw:` territory, and a stuck scheduler is a real fault
   the run record has to show.
2. **Offer only the button that can work.** `identityWalkOffered` in `client/src/lib/walkModes.ts` mirrors the
   table above; an unrecognized cursor shows every button and leaves the decision to the server. A parity test
   (`robinhoodWalkModes.test.ts`) runs both implementations over the same cursors, so the console and the server
   cannot disagree.
3. **Show the operator the reason.** `liveData.admin.runSource` turned every non-tRPC error into the generic
   "Live data is temporarily unavailable.", so a refused click looked like an outage. A refusal is now a distinct
   error class (`RobinhoodWalkModeRefusedError`) mapped to a `BAD_REQUEST` that carries the message, for example
   "Backfill window cannot run from the current position, forward walk (fw:85000000). Fill activity can run from
   here." The reputation guard uses the same class, so its refusals read the same way. Every other fault keeps
   the generic message and still records a failed run.

No data reset is needed here: the identity source read 0 recorded failures when this was checked, so there is
no false failure to clear (the reputation source needed migration `0032` for that).

Tests: `robinhoodWalkModes.test.ts` (the position table, unrecognized cursors, parity with the console, exact
messages), `runRobinhood.test.ts` (refusal before any run row for each mismatched click, normal runs for each
fitting one, observe from every position, scheduled runs not pre-checked, real faults still recorded), and
`runSourceRefusal.test.ts` (through the real router: a refused click is a `BAD_REQUEST` with its message and no
run row, and an adapter fault keeps the generic message and a failed run). Removing the runner guard, widening it
to scheduled runs, dropping the router mapping, letting a finished walk count as runnable, dropping `fw:` from the
console, and reverting the reputation guard's class each fail a test.
