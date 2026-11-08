# The Agenstry feed limits, raised

The Agenstry catalog adapter ([the approval](./approvals/2026-10-08-agenstry-catalog.md)) reads the provider's public feed under a handful of bounds. On 2026-11-06 the feed was at or near every one of them, and four of the five that matter drop records without a failure, so nothing would have said the feed had outgrown them. This change raises the five, with room for about three months at the growth seen, and holds each of the four quiet ones with a test. It changes no rule about which records are taken, and it publishes nothing.

**Status.** Built on 2026-11-06 on branch `feat/agenstry-limits`. It takes effect at the first daily Agenstry run after the deploy. No migration and no new setting.

**Decided:** 2026-11-06, by the operator, in chat: "merge 302 and build the limits pr". The numbers are mine, set from the measurements below, so the operator can name others.

## What the feed was on 2026-11-06

One request for the feed (generated 2026-11-06 23:08 UTC, a copy kept outside the repository), read with the adapter's own rules:

- 299,073 lines, 22.35 MiB compressed (23,431,777 bytes) and 127.2 MiB expanded, 5.7 times. The longest line is 237.6 KiB.
- 3,454 `a2a_agent` records, the first at line 10 and the last at line 11,375. 177 carry a source-reported signal and 175 of those are valid. They sit on 99 different provider hosts, so 99 qualify under the rule of one record per host.
- 230,827 different records of the kinds the directory acknowledges (`mcp`, `paid_api`, `a2a_agent`).

The same figures on 2026-10-09, from the comments the bounds carried, were 262,024 lines, 17.9 MiB, 2,846 `a2a_agent` records inside the first 10,000 lines, about 213.7k acknowledged records and 80 qualifying hosts. In the 28 days between, the compressed size grew about 25 percent, the lines 14, the acknowledged records 8, the `a2a_agent` records 21 and the qualifying hosts 24. Two points are all there are, so the months below are a guide and not a forecast.

## The bounds

| Bound | Was | The feed on 2026-11-06 | Now | Left at the growth seen |
|---|---:|---:|---:|---|
| Compressed body (fails the run) | 24 MiB | 22.35 MiB (93%) | 48 MiB | about 3 months |
| Line walk stops (quiet) | 300,000 lines | 299,073 (99.7%) | 450,000 | about 3 months |
| Evidence window (quiet) | 12,000 lines | last `a2a_agent` at 11,375 (95%) | 24,000 | 3 months or more |
| Intake cap (quiet) | 96 records | 99 qualify | 128 | 5 to 6 weeks |
| Directory ceiling (quiet) | 240,000 records | 230,827 (96%) | 300,000 | about 3 months |
| Expanded body (fails the run) | 512 MiB | 127.2 MiB (25%) | 512 MiB | unchanged |
| Request timeout (fails the run) | 120 seconds | 51 seconds from the production server | 120 seconds | unchanged, the next to watch |

A bound that fails the run shows as a failed run on the operator's surfaces. A quiet one ends the read or leaves records out and the run shows as a success. The daily run on 2026-11-06 accepted 96 records, the cap, and 99 qualify in the copy of the feed above; no failure said so.

## Why these numbers

- **Compressed, 48 MiB.** Twice today's size. The bound exists to stop a hostile or broken feed, not to size the feed, and the connection is cut when the body crosses it. A first sketch of 32 MiB would have lasted about six weeks.
- **Walk, 450,000 lines.** One and a half times today's. A first sketch of 400,000 would have lasted about two months.
- **Evidence window, 24,000 lines.** The window only has to hold the `a2a_agent` block, which ends at line 11,375 and grows. A record past the window is not read for the reviewed intake and nothing fails. 24,000 is twice the block's end.
- **Intake cap, 128.** It takes all 99 with room, and sits inside what the review tooling lists in one run (`MAX_RUN_REVIEW_OBSERVATIONS`, 256), so every record a run keeps can be checked before it is published. The count grew about a quarter in four weeks, so 128 will bind again in five or six weeks. Each record is one more to check before it is shown, so raising it again is the operator's decision.
- **Directory ceiling, 300,000.** One and three tenths times today's.

## What did not change

- **The expanded cap, 512 MiB.** It guards against a gzip bomb. A feed at the new compressed bound that expands the same 5.7 times is about 270 MiB, inside it.
- **The request timeout, 120 seconds.** A pull from the production server on the evening of 2026-11-06 took 51 seconds for the 22.35 MiB, about 450 KB a second. At that rate a feed at the new compressed bound takes about 110 seconds, so the size bound and the timeout will bind at about the same time. Raising the timeout also holds the worker longer on a stalled body, so it is left for the operator to decide, and it is the next one to look at.
- **Which records are taken.** `kind=a2a_agent`, no sanction flag, at least one source-reported signal, one record per provider hostname; the 32 KiB record cap and the 1 MiB line cap; no URL inside a record is followed.

## What the change costs

- **Memory.** The directory walk keeps its drafts in a map until the run ends. Measured with the adapter's own draft function on the real feed, the map holds about 58 MiB of heap for today's 230,800 or so drafts (262 bytes each). That is about 60 MiB at the old ceiling and about 75 MiB at the new one, so the ceiling adds up to 15 MiB at its peak and nothing at today's size.
- **The run's rejected count.** The window now looks at lines 12,001 to 24,000, which are not `a2a_agent` records, and counts them as rejected, so the Agenstry run's rejected figure rises by about 12,000. The operator's run page shows that figure and no rule reads it. What is taken, and what the directory acknowledges, does not change by it.
- **Download time.** None added by this change. The pull is what it was.

## Checked on the real feed

The adapter's own entry point (`fetchAgenstryCatalog`), with the download and the storage replaced and the 2026-11-06 copy of the feed as the body, read 299,073 lines to the end under the new bounds, took 99 records (the old cap took 96), made 99 storage writes, kept 230,827 directory entries and counted 23,828 lines as rejected, in 3.8 seconds of parsing. This ran once, locally, and is not a test in the tree because the feed copy is not.

## Held by tests

- `catalogAdapters.test.ts`: the five raised bounds are exported and pinned, the compressed bound, the walk stop and the window each above what the 2026-11-06 feed used, the window shorter than the walk, the intake cap inside `MAX_RUN_REVIEW_OBSERVATIONS`, and the directory ceiling.
- `agenstryFeed.test.ts`:
  - the connection is cut at the compressed bound: the body is cancelled, and no more than a few pieces are read past the bound (the check after the read would give the same verdict once the whole body had been downloaded, so the cancel is what pins the cut);
  - the window's last line, from both sides: a record with a signal at line 24,000 is read, one at line 24,001 is not, though the directory still acknowledges it;
  - the intake cap: 131 qualifying records give 128 taken, none rejected and 128 storage writes;
  - the walk stop and the directory ceiling: a feed of 450,005 lines is read to line 450,000, the directory holds exactly 300,000 and drops the five past the ceiling, with no failure.
- Planted changes: twelve, each caught. Each constant put back to its old value, the intake cap taken one too far, the cap placed above what the review tooling lists, the window one line short and one line long, the walk one line too long, the directory one entry too long, and the cut at the compressed bound removed.

## Not checked, and left as it is

- **No run in production yet.** The first scheduled Agenstry run after the deploy is the live check: it should succeed and accept at least 96 records (99 qualify today). A failure reading "exceeded the compressed response limit" would mean the new bound did not deploy.
- **The growth is two points apart.** The months above come from 2026-10-09 and 2026-11-06 only.
- **The timeout stays at 120 seconds**, as above.

## What this does not do

It does not change what the public sees. The public reviewed set for Agenstry is the operator's last published run, which is still the manual run of 2026-10-09 with 48 records. The daily runs since then took 91 to 96 records each and are not shown until the operator publishes one on `/admin/sources` after the evidence check the approval describes (the stored objects' SHA-256 recomputed, their retention confirmed). Raising the limits keeps the daily run from failing and from dropping records, so that the run the operator publishes holds all of them.
