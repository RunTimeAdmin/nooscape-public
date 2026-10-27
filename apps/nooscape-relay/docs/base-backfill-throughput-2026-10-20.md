# Base backfill throughput (2026-10-20)

Two small changes so the Base identity pass can catch up with a chain that grows faster than the pass walks it, and stay level afterwards. Built on `feature/base-backfill-throughput` after the operator chose them ("Build it", options A and B of the Base checklist).

1. **Base takes up to 40,000 events a run** (`BASE_CHAIN.budget.maxEvents` in `server/ingestion/erc8004Chains.ts`, was 5,000).
2. **The worker accepts a tick that arrives up to 30 seconds early** (`CLAIM_EARLY_TOLERANCE_MS` in `server/db.ts`). The 15-minute guard refused about one tick in three, and a refused tick runs nothing.

No migration, no setting, no new switch. The ceiling of two sources a tick is untouched.

## What was found

The operator staged and approved Base on 2026-10-20, ran nine attended runs from `/admin/sources`, then handed the source to the scheduler with SQL pasted by hand (a guarded UPDATE, then a 5-minute cadence). The first scheduled run was at 23:00 UTC. In the next hour Base got a slot at 2 of the 5 ticks that ran, and the pass was clearly not going to catch up. Three things explain it, and each was measured.

### The history is 189 runs, and the chain is surging

The whole history was replayed offline, with the pass's own filter, decoder and budget rules (`parseWindowLogs`, `planWindows`, 200 windows a run, no new window once 5,000 events are accepted) and no database: 11,208 windows of 1,000 blocks from the deploy block (41,663,783) to the finalized head (52,871,772, 21:48 UTC), 11,208 `eth_getLogs` calls and none failed.

- **189 runs**, 1,050,696 events, 372,397 registrations. A registration brings about 2.8 events (the registration, its mint, URI updates).
- All ten runs the operator had made by 23:00 match the replay in every accepted count and every cursor: 5,014, 6,766, 5,709, 5,273, 5,996, 5,065, 4,822, 1,445, 2,260 and 5,048. The cursor after run 9 (`base:42552783`) was exactly the end of run 9.
- The early history is not quiet (a launch burst of 26,000 events on day 4), so most runs end on the event budget after a few windows: 42 runs hit the 200-window cap, 64 take one or two windows, 7 apply 10,000 or more (the largest 11,406), and the mean is 5,559.
- **The surge is accelerating.** About 6,000 events a day ten days ago and 281,000 in the last 24 hours (93,000 registrations), 2.4 times the day before. A window of 1,000 blocks at the head now holds about 6,500 events, more than one run's budget, so at the head a run advances one window while the chain adds 43.2 windows a day.

### A run is cheap

The run table on the production database (ten runs):

| Runs | Windows | Events | Seconds |
|---|---|---|---|
| 3, 4, 5 | 2, 1, 3 | 5,709, 5,273, 5,996 | 2 each |
| 2, 6 | 73, 82 | 6,766, 5,065 | 11, 10 |
| 1 | 128 | 5,014 | 15 |
| 7, 8, 9, 10 | 200, 200, 200, 183 | 4,822, 1,445, 2,260, 5,048 | 21, 19, 17, 20 |

A dense run costs about 0.4 milliseconds an event end to end. A quiet run is limited by the node's answer time, about 0.1 second a window. The cap on events is therefore cheap to raise. What grows later is the fixed cost of a run: the pass classifies the whole table of the source each run.

### The shared worker gave Base about 23 runs a day

The worker ticks every 15 minutes (one account cron job). Each tick takes the due, active, scheduled sources in order of their next run time, oldest first, at most `maxSourcesPerTick` of them: 2, set by migration 0027 when five sources were scheduled. Eleven are scheduled now. A source's next run is its finish time plus `scheduleMinutes`, so in a full queue a short cadence changes nothing: the source waits its turn.

The claim also refused a tick that came less than 15 minutes after the previous claim. The cron fires on the same 15-minute marks, and its request reaches the app a few seconds either side of :05, so a tick that arrived a second before the previous tick's offset was refused and nothing ran. From 21:00 to 23:30 UTC, 3 of the 11 ticks were lost that way. The 23:30 tick is the clear case: the worker's last claim was 23:15:05.

The queue as the operator read it from the database at 23:37 (his paste of `ingestion_sources` and `ingestion_worker_config`):

| Source | Cadence (minutes) | Next run due | Due at 23:37 |
|---|---:|---|---|
| Solana-8004 | 30 | 23:00:08 | yes |
| Base | 5 | 23:05:46 | yes |
| Metaplex | 15 | 23:15:26 | yes |
| Robinhood | 15 | 23:30:06 | yes |
| BNB Chain | 15 | 23:30:08 | yes |
| Solana SAID | 60 | 23:45:10 | no |
| five daily sources | 1,440 | next day | no |

Five of the eleven were overdue. The worker took Solana-8004 and Base at 23:45, the two oldest, as the queue predicts. A simulation of the worker from this queue (300 trials of the next 3 days, claim time 5 seconds after the mark with 1.5 seconds of jitter) gave Base 23 runs a day, which is what was observed, and put the other registries at about half their configured rate before Base joined them (BNB Chain 20 a day of a nominal 48):

| Setup | Base (96 if every tick) | Solana-8004 (48) | Metaplex (48) | Robinhood (48) | BNB Chain (48) | Solana SAID (24) |
|---|---|---|---|---|---|---|
| As it was: 2 slots, 15 minute guard | 23 | 18 | 21 | 21 | 20 | 13 |
| **This change: tick accepted up to 30 seconds early** | **41** | 26 | 34 | 34 | 34 | 17 |
| 3 slots | 40 | 25 | 31 | 30 | 30 | 16 |
| 3 slots and the early-tick fix | 68 | 32 | 47 | 47 | 47 | 18 |
| A lane of its own for Base | 288 | 22 | 26 | 26 | 26 | 14 |

## Why these two changes

At 23 runs a day and 5,000 events a run Base reads 115,000 events a day against 281,000 arriving. It never catches up, and after a catch-up by hand it would fall behind again. Days until the pass reaches the finalized head and publishes, from the cursor after run 10, if the chain's growth stays at half / the same as / double the last day's rate (the quiet history alone needs about 50 runs, because a run reads at most 200 windows):

| Runs a day | Cap 5,000 | Cap 20,000 | Cap 40,000 | Cap 60,000 |
|---|---|---|---|---|
| 23 (as it was) | never | 5.0 / 6.9 / 59 | 3.4 / 4.0 / 5.5 | 3.0 / 3.3 / 4.3 |
| 41 (this change) | 9.2 / never / never | 2.4 / 2.8 / 4.3 | **1.8 / 2.0 / 2.2** | 1.6 / 1.7 / 1.9 |
| 68 (3 slots and the fix) | 3.9 / 7.2 / 7.2 | | 1.1 / 1.1 / 1.2 | |
| 288 (a lane of its own) | 0.7 / 0.7 / 0.7 | 0.3 / 0.3 / 0.3 | | |

The early-tick tolerance is a defect fix, not a Base fix: it returns a third of the worker's capacity to every source, which is 60 to 70 percent more runs for the 15-minute registries.

### Not done

- **A third slot per tick.** It raises the ceiling the code calls reviewed (`configureWorker` allows 1 or 2, and there is no worker screen), needs a manual migration like 0027, and makes ticks longer. The worker's follow-on steps (clustering, raters, names, registration files, SAID names) skip a tick that has already run 90 to 100 seconds. It is the next lever if the pace measured after the deploy is not enough.
- **A lane of its own for Base** (an operator endpoint and a second cron job, like the checks and webhook lanes). The fastest, and the most code, and the operator would create the cron job.
- **A larger cap than 40,000.** Above about 60,000 the gain is small. The cap is checked between windows, so a run can pass it by one window (a window holds up to 40,000 events, the provider-fault bound).

## Benchmark of the real pass

The real pass (`runApprovedErc8004ChainSource`, with the budget in the code), a throwaway local MySQL 8 (Docker, in memory) and the real chain over the operator's Alchemy key, read from window 10,776 (the last ten days, about 812,000 events) to the finalized head in 21 runs, then one run that found nothing to do. Nothing was written to production.

| Runs | Seconds a run | Events a run | Registry rows after | Peak memory |
|---|---|---|---|---|
| 1 to 3 | 31, 28, 20 | 28,467, 40,743, 42,534 | 10,113 to 38,374 | RSS 151 MB |
| 4 to 20 | 13.7 to 22.0 | 40,082 to 47,572 | 52,284 to 279,625 | RSS 333 MB, heap 184 MB |
| 21 (reached the head, published) | 6.6 | 16,012 | 284,966 | |

- A run of about 40,000 events takes 14 to 22 seconds, about 0.35 milliseconds an event with the reads included, and **does not grow with the table**: 14 seconds at 280,000 rows. The first three runs are slower because they read 34 to 102 windows from the thin start of the surge, where the node's answer time dominates, and the first stopped at the 30-second budget with 28,467 events (the budget ends a run early and keeps its progress).
- The run that reached the head classified the whole table and published in 6.6 seconds, so the first publication will not be a long run.
- Of the 284,966 registry rows from the last ten days, the listing published 101. BNB Chain's rules (a shared profile link from 2, a shared host from 50, a shared wallet from 10) hold out nearly all of them. That is the last ten days only, and it is a question for the census, not for this change.
- Caveats: the database was local and in memory, and the path to the node differs from the host's. The production run table (0.4 milliseconds an event) is the same order, so the two are used together.

## After the deploy

- Base's last success on the public status page (`liveData.sourceStatuses`): a slot at about every second tick, 40 runs a day, where it was 23.
- The 15-minute registries (BNB Chain, Robinhood, Metaplex): every other tick, 34 a day, where it was 20 to 21.
- The operator's `0047_progress.sql` cursor moving by up to 40,000 events a run. Each press of **Run chain pass** now does up to 8 times the work: about 68 presses instead of 178 to reach the head of 21:48.
- Rollback is the two constants. Nothing is stored that depends on them.

## Tests

- `server/ingestion/erc8004Chains.test.ts` pins Base's budget.
- `server/workerClaim.integration.test.ts` (real MySQL, skips without one): the first tick, a tick on the mark, a tick 15 seconds early (taken), a tick 45 seconds early (refused, the last claim kept), a manual tick or a second instance 1 second, 2 and 10 minutes after the last (refused), a 60-minute interval (the tolerance is 30 seconds, not a share), a paused worker, and what a claimed tick takes (due, active, scheduled sources, oldest first, no more than the limit; a newcomer waits behind the sources that have waited longer). Each guard was removed once to see its test fail.

## Update, 23 October 2026: a time budget in place of the event count

The host cap (21 October) changed what a window costs. A window of one flood host past its cap only counts, which is one grouped count and a few upserts: 17,000 to 29,000 events a second in this review's measurements, against 2,500 to 5,000 for a window that stores a row for each registration. The cap of 40,000 events ended a run after about 3 seconds of the 30 allowed, in a flood that adds 20 to 32 events a second.

`BASE_CHAIN.budget` is now 20 seconds (`maxElapsedMs`) with an event ceiling of 1,000,000 (`maxEvents`) that the clock normally reaches first. Rollback is the two constants. Ethereum (5,000 events) and Arc (1,000) keep their caps: neither has a scheduled source, and Arc's keeps its node free for payment checks.

One run of the real pass on a database seeded to production size (MariaDB 10.11 in memory), windows of 14,000 events, 400 ms for each read, two runs of each:

| Windows | Budget | Windows applied | Events | Seconds | Rows stored |
|---|---|---|---|---|---|
| One host (only counts) | before (40,000, 30 s) | 3 and 3 | 42,000 | 3.0 and 2.8 | 2,000 |
| One host (only counts) | now (20 s) | 40 and 38 | 560,000 and 532,000 | 19.4 and 20.4 | 2,000 |
| A host each (stores) | before | 3 and 3 | 42,000 | 8.2 and 8.9 | 14,635 |
| A host each (stores) | now | 8 and 7 | 112,000 and 98,000 | 21.8 and 22.3 | 39,026 and 34,139 |

A run that only counts applies about 13 times more events. A run that stores a row for each registration applies 2.3 to 2.7 times more and takes about as many times longer (8 or 9 seconds became 22); 40,000 events took 14 to 22 seconds in the benchmark of 20 October (a local database and the real node), so a run that stores rows should take about 20 to 25 seconds on the host. The event loop's longest wait is about the same in every run (p99 90 to 140 ms, longest 170 to 215 ms): it is the cost of one window, and a longer run has more of them. The worker's follow-on steps skip a tick that has already run 90 to 100 seconds, and a Base run is now up to about 25 seconds.

`server/baseRunBudget.integration.test.ts` (real MySQL, skips without one) runs the pass with Base's own budget: a flood of 56,000 events goes to the end of its windows in one run, and a run whose reads take 6 seconds each stops after two windows.
