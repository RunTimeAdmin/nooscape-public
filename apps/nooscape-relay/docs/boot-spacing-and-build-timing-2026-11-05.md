# Failed starts are spaced, and aggregate builds are timed (2026-11-05)

> **Status:** Built 2026-11-05, after the second outside architecture review of that day. No migration and no setting. A normal start is unchanged: it finds nothing to wait for.

## Why

Two findings of that review were true when tried against the code.

1. **Nothing bounds a start that fails on the database.** `server/_core/index.ts` ends the process when the schema step throws, and the host starts it again at once. The [outage of 2026-11-01](./incident-2026-11-01-outage.md) ran that loop at about ten starts a minute for about 17 minutes and spent about 170 of the hour's 500 new database connections, roughly one per start. At that pace the allowance would have been gone near 03:50, and the site could not have come back until the hour turned over, even with the grant restored. The record said, correctly, that no code change would have helped the cause. This one helps the cost.
2. **Nothing records what an aggregate build costs.** The figure in `server/readCache.ts` (4 to 8 seconds at 500 to 700 percent of one core, at 240,000 rows) is from the pressure test of 2026-10-14 on a shared four-core machine. The directory holds about 289,000 entries now, and no line in the runtime log says what the production database does. A counters table for the public totals (two to three weeks of work, with a job to keep it honest) is a decision that should rest on those numbers.

## Failed starts

- A start that fails on the database writes a note, `nooscape-boot-failure.json`, in the temporary directory, next to the lifecycle trail. It holds the number of failures in a row and the time of the last.
- The next start reads it and waits before it opens any connection: 15 seconds after the first failure, doubling with each failure in a row, five minutes at most. It writes one line to the runtime log: `[Boot] 3 starts in a row failed on the database; waiting 41 s before the next try, ...`.
- A start that gets through the schema step removes the note, so a normal start finds none. A failure more than 30 minutes old no longer counts as one in a row.
- The note is on the machine and not in the process, so it holds however many processes the host starts and however fast it restarts them. It applies in production only, as the lifecycle log does.

What that buys, from `server/bootBackoff.test.ts`, which runs an hour of failing starts against a clock the test moves: attempts at 0, 16, 47, 108, 229 and 470 seconds and then every five minutes, 16 in the hour, where ten a minute would be 600. At about one connection a start, that is 16 an hour for each process, where ten starts a minute spent the allowance.

What it does not do:

- It does not touch the cause. The site is still down while the grant is missing. It comes back within five minutes of the grant, because the longest wait is five minutes.
- A start that fails for another reason after the schema step (a busy port, an error while serving) is not spaced, and each such start still opens its one connection for the schema step.
- If the note cannot be written, the start behaves as it did before this change.

To skip a wait after a fix, delete `/tmp/nooscape-boot-failure.json` in the host's terminal. Waiting out the five minutes does no harm.

## Aggregate build times

- `createReadCache` takes an optional `onLoaded(key, ms)`, called after each load that finished without an error, from a visitor's read, the warm-up or a reload behind a value that is still served.
- The directory cache uses it to write `[ReadCache] built <key> in <ms> ms` for a build of 200 ms or more. A faster build writes nothing, so a key that never appears took under 200 ms.
- Read it in the runtime log after a deploy (the log starts again at each deploy) and again after a day. If no build stays over a second at about 289,000 entries, the aggregates are not what to fix. If several are over five seconds, the rollup rows come first (the worker writes the counts, the page reads them), which is about three days of work (an estimate) and not the delta counters of the review.

## Checked

- `bootBackoff.test.ts`: the delay table and its cap; the count and its restart after a quiet half hour; the wait, its message, and a clock that moved backwards; notes that cannot be read; clearing; the hour of failing starts; and the order of the three calls in the entrypoint (the wait before the first connection, the clear after the schema step, the note before the exit).
- `readCache.test.ts`: the key and time reported for each finished load (a failed one reports none), a reload behind a served value, a callback that throws, the threshold at exactly 200 ms, and the directory cache created with the logger.
- Sixteen planted bugs, each caught: the delay not doubling or not capped, the count never restarting or never rising, a good start leaving the note, a clock that moved back holding a start for an hour, a wait that does not sleep, the entrypoint leaving no note, the wait after the connection, never clearing, spacing outside production, and the cache never reporting, failing on a throwing callback, with an exclusive threshold, logging every build or without the logger.

## Rolling back

Delete the three calls in `server/_core/index.ts` and the `onLoaded` line in `server/readCache.ts`. The note is a file in the temporary directory and nothing reads it afterwards.
