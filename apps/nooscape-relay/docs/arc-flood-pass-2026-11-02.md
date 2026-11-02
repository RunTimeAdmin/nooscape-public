# The Arc pass in a flood (2 November 2026)

A change of constants, a cadence flip (migration 0055) and their tests. No new code path: Arc gets the window and the run budget Base has had since its own flood, and runs every hour.

**Status.** Merged as PR 249 on 2026-11-02 at 12:35:31Z (branch `fix/arc-flood-pass`, main b539632) and live at 12:36:51 GMT. "Checked" below says what the tests and the planted regressions showed, and "Live" what was seen after the deploy.

**Decided:** 2026-11-02, by the operator, in chat. He ran the Arc pass by hand and asked "i ran a chain pass on arc and the number just keeps going up why is that and why are we so far behind". He was shown the cause and a fix in three parts (carry the window width that fit through a run, a bigger run, hourly instead of daily) and said "build it". The first part was built as the window Base already uses, 1,000 blocks, which does the same job (a read that fits the first time) without a new path through code five chains share.

## What happened

- **A flood.** One platform, Central City (centralcity.ai), the one that flooded Base from 11 October ([the host cap](./flood-host-cap-2026-10-21.md)), began registering an agent on Arc for each agent created on its site. A trickle from about 08:00 UTC on 1 November (agent id 2,918), then 600 to 715 registrations per 1,000 blocks from that evening: about 1.2 a second, 100,000 a day. Every registration has its own owner (a 61-byte smart account), its own link (`https://centralcity.ai/a/<random>`) and its own transaction, sent by two bundler wallets through the ERC-4337 entry point (`0x5ff1…2789`). The newest agent id was 89,210 at block 29,151,011 (11:30 UTC on 2 November).

  | Block | Time (UTC) | Registrations per 1,000 blocks | Events |
  |---:|---|---:|---:|
  | 28,846,000 | 31 Oct 16:33 | 0 | 0 |
  | 28,964,123 | 1 Nov 09:11 | 15 | 49 |
  | 29,000,000 | 1 Nov 14:14 | 83 | 249 |
  | 29,050,000 | 1 Nov 21:17 | 629 | 1,887 |
  | 29,100,000 | 2 Nov 04:19 | 597 | 1,761 |
  | 29,149,549 | 2 Nov 11:18 | 715 | 2,154 |

  One `eth_getLogs` of 1,000 blocks each, through the operator's node, on 2 November. Six more windows near the head held 1,902 to 2,138 events and 1.23 to 1.39 MiB (680 bytes an event), each answered in about 0.6 second.
- **The count.** `registrations_on_chain` for Arc on the stats API: 2,908 (1 Nov 00:44), 3,277 (1 Nov 19:21), 43,724 (2 Nov 11:23). The listed count stayed 418: the host rule holds the platform out, and the host cap stores 2,000 of its rows and only counts the rest.
- **The pass.** The cursor was `arc:28964123` (1 Nov 09:11, 26 hours and 186,000 blocks behind the head) when the operator began. A run planned 100,000-block windows, and in the flood the first was far over the 2 MiB response cap, so each run split it five or six times (`[ARC] blocks A to B were too large for one read and are read in halves.`), read one piece of 1,200 to 1,560 blocks, which held over 3,000 events, and stopped there: the ceiling was 1,000 events. That is 12 minutes of chain and about 850 registrations a run. The operator's 48 runs between 11:04:34 and 11:19:06 moved the cursor to about block 29,074,000 and the count from 3,277 to 43,724. About 77,000 blocks (11 hours, 45,000 registrations) were still unread.
- **Why a day could not keep up.** The source ran once a day and a run read 12 minutes of chain, so the walk fell about 24 hours further behind each day while the flood lasted. A run also sets the next one to its finish plus the cadence (`finishIngestionRun`), a manual run included, so the operator's last run moved the scheduled one to 3 November 11:19 UTC. [The worker record](./worker-operations.md) had said "if Arc ever registers more than 1,000 agents a day the cadence has to shorten". Nothing watched for it, and the live check asks only whether a run succeeded lately, which a pass that is a day behind passes.

## What changed

| | Before | After |
|---|---|---|
| Window | 100,000 blocks | 1,000 blocks (Base's) |
| Windows planned a run | 10 | 200, more than the clock reaches |
| Time a run may take | 20 seconds | 30 seconds |
| Events that end a run | 1,000 | 1,000,000, a ceiling the clock does not reach |
| Cadence | once a day | every hour (migration 0055) |

The clock ends a run, as it does on Base ([why a count cannot size a run](./base-backfill-throughput-2026-10-20.md)): a window that only counts applies 17,000 to 29,000 events a second and one that stores a row for each registration 2,500 to 5,000. A window of 1,000 blocks is 1.4 MiB of the flood, so a read fits the first time and nothing is split. Not changed: the 2 MiB response cap (it leaves 1.4 times the densest window measured, and a read past it is still split in halves, where a larger cap is a heavier call on a node the payments share), the event bound of 30,000 a window, one request at a time with a 250 ms gap, the host cap, the ratings window and the listing rules.

**The cadence** is migration 0055, a guarded UPDATE in the shape of 0050: the approved source key, an active source on the scheduler that is still on 1,440 minutes, and an `arc:` cursor; it sets 60 minutes and the next run to now, so the pass starts on the backlog at the next tick after the deploy, and it does not name the protocol (no SQL run at boot may). The operator's `nooscape_schema_migrations` held 54 as its newest on 2 November (read from phpMyAdmin), so 55 was free. The live check's limit for the Arc pass goes from 36 hours to 12: a night of trouble on the operator's own node does not raise an alarm, a day and a half no longer passes unseen.

**What to expect (an estimate; the first scheduled run is read under Live).** A read takes 0.6 second from a PC and about 0.7 on the host (the refused reads in the log came 0.9 to 1.0 second apart, 250 ms of it the gap); with the gap and the apply, a window is a little over a second, so a run reads about 25 windows: 25,000 blocks, three and a half hours of chain. An hour of Arc is 7,080 blocks, so an hourly pass has about 3.5 times the room, and the 77,000-block backlog clears in about four runs. The first scheduled run read a window in 0.54 second, about twice as fast as this guess.

## What is held by a test

- `server/ingestion/erc8004Chains.test.ts`: the Arc entry (window, run budget), the clock reaches fewer windows than are planned, the event ceiling is Base's, and the response cap and the event bound sit above the densest window measured in the flood (the cap by 1.4 times).
- `server/ingestion/runErc8004ChainArc.test.ts`, through the real RPC client against a fake node: a run reads windows of 1,000 blocks until its 30 seconds are spent, not ten; it reads 40 windows holding 48,000 events in one run; against a node that refuses a read of more than 1,443 blocks (what the cap fits of the flood), every window is read whole with none split, and the old 100,000-block window is refused seven times before a read fits (the control, so the check can fail).
- `server/arcHourlyFlip.test.ts`, on MySQL 8.4 and MariaDB 10.11: the change moves an active, scheduled, daily Arc source to hourly and due now (in any session time zone), is a no-op the second time, leaves a source on another cadence, a manual-only, paused, rejected or in-review source, a source with no cursor or another chain's, and any other source key alone, and touches no other chain's daily source; and the live check expects 12 hours for the Arc pass.
- `server/arcRunBudget.integration.test.ts`, on MySQL 8.4 and MariaDB 10.11: with Arc's own budget and 40 windows from one host, the run goes through all of them while they only count (2,000 rows stored, the rest counted), and with a clock that takes a second a read it stops after 30 windows.

## Checked

Four planted regressions each failed a test: the window back to 100,000 blocks (four tests), the event ceiling back to 1,000 (three, and both budget cases on a real database, which end at `arc:13345062`, the cursor after the first window), the time back to 20 seconds (two), and ten windows again (five). Five more in the migration: each of its four guards dropped in turn (the daily cadence: two tests; the scheduler: one; the cursor: one; the source key: one) and the live check's limit back to 36 (one).

## Live

All times are UTC on 2026-11-02. PR 249 was rebase-merged at 12:35:31 (main b539632, the gate green, the merged tree the same as the tested branch's) and deployed at 12:36:51 GMT. It carried two commits: the window and the run budget, and the cadence.

- The first new process applied `0055_arc_hourly_cadence.sql` at boot (12:37:18) and the second found the schema current (12:37:23). `verify-live` passed 48 of 48, with the Arc pass's allowance at 12 hours. The operator's migration log had read 54 as its newest before the deploy.
- Runs of the Arc source finished at 12:38:12, 12:38:49 and 12:39:25. The worker's next tick was 12:45, so they were started by hand. The one at 12:38:49 reached the head and published 29 entries (`[ARC] listing published: 29 added, 0 refreshed, 0 removed`): the listed count went from 418 to 447, agents that registered while the walk was behind. The walk was at the head 91 seconds after the first new process started. No read has been split since the deploy (no "too large for one read" line in the log).
- The count on the stats API read 81,324 at 12:38:37 and 94,712 at 12:39:47 (the read is kept up to five minutes). The chain's newest agent id was 94,768 at 12:39:01 and 94,853 at 12:40:05, so the walk was about a minute behind the chain, where it had been 26 hours behind.
- The first scheduled hourly run finished at 14:15:13, on the 14:15 tick. The worker's ticks at 13:45 and 14:00 did not take Arc (it takes the two sources that fell due first), so the run came 96 minutes after the one at 12:39:25. Its lag line, the first in production: `windows` 12, `events` 23,229, `nextBlock` 29,170,497, `finalized` 29,170,496, `behind` 0, `caughtUp` true, `ms` 6,503. Twelve windows with their apply took 6.5 seconds, 0.54 second a window, so a run of the 30 seconds can read about 55 windows: 55,000 blocks, 7.8 hours of chain, against the 7,080 blocks of an hour of Arc. The stats count read 102,543 at 14:16:31 and the chain's newest agent id at block 29,170,496 was 102,542: the walk was at the head. The 96-minute gap is the queue, not a fault: Arc has room to wait through two or three ticks, and the live check allows 12 hours.

## The lag line

The lag showed nowhere: the cursor is in the source row, `liveData.sourceStatuses` and the stats API do not show it, and the live check asks only whether a run succeeded lately, which a pass a day behind passes. The operator asked for a line, and it was added the same day, after the fix.

Every run of the ERC-8004 chain pass that finishes writes one `nooscape_chain_pass` line (`logPass` in `server/ingestion/runErc8004Chain.ts`, so BNB Chain, Ethereum, Base, Arc and Monad all write it):

```
{"event":"nooscape_chain_pass","chain":"arc","windows":25,"events":53000,"nextBlock":29184000,"finalized":29189999,"behind":6000,"caughtUp":false,"ms":29000}
```

(An illustration of the shape, not a reading.) `nextBlock` is the cursor after the run, `finalized` the head the run saw, `behind` the finalized blocks still unread, `windows` and `events` what the run applied and `ms` how long it took. A run that applied nothing because its budget was spent, and a quiet run already at the head, write it too (`windows` 0); a run that fails before it applies a window writes none, and the run's own record says why. The line holds the chain's key and numbers, so nothing of the endpoint can be in it. It is in the runtime log only, which starts again at each deploy, and it gave the pace of the first scheduled hourly run (under Live).

## Open

- **If the flood thickens** past 1.4 times, a 1,000-block window is over the cap and is split: every window costs about two reads and a run covers about half. Then the cap, the window or the cadence is the lever.
- **If the flood ends,** a window of 1,000 blocks costs seven reads an hour on a quiet chain and nothing else changes.
- **The worker is at capacity** ([worker-operations.md](./worker-operations.md)): two sources a tick, eight runs an hour. An hourly Arc takes one of them and stretches the other cadences a little.

## Files

`server/ingestion/erc8004Chains.ts` (the Arc entry and its comment), `drizzle/0055_arc_hourly_cadence.sql` with its journal entry and `0055_snapshot.json`, `scripts/verify-live.mjs` (the limit), the tests above (the check of the limit moved from `arcScheduledFlip.test.ts` to `arcHourlyFlip.test.ts`), `server/ingestion/runErc8004Chain.ts` and its test (the lag line, added after the fix), `docs/worker-operations.md`, `docs/multichain-erc8004-2026-10-20.md`, `docs/README.md`, `todo.md` item 162.
