# Incident record: the site down for about an hour (2026-10-14)

nooscape.si returned a CDN 503 for about an hour, from some time between 11:30Z and 11:45Z until 12:45Z. The operator had upgraded the Hostinger plan (to Cloud Startup: 4 GB RAM, 4 CPU cores, 100 entry processes, LiteSpeed, CDN) at about that time, and reports that the upgrade broke the database access. Two things broke at once, each hiding the other, and neither was a code change. A third showed after the site was back: the scheduled worker ran nothing for another two hours. This is the record of what was seen, what was done, and what to do next time.

## Timeline (UTC)

| Time | What |
| --- | --- |
| 11:21 | `verify-live` 36 passed after the PR 32 deploy. The last good worker ticks follow at 11:30 (BNB and Robinhood identity). |
| 11:45 | First failed probe: every request is a CDN 503. The 11:45 worker tick hits a dead app. |
| 11:53 | The operator redeploys from the panel. The build fails in `vite build`: `spawn .../@esbuild/linux-x64/bin/esbuild EACCES`. |
| 11:58 | The scheduled health check fails (it saw HTTP 403 from the CDN) and opens an issue. |
| 12:08 | PR 36 merged: the build restores esbuild's execute permission before it runs. The next build succeeds and deploys. |
| 12:09 | The runtime log shows the new version restarting in a loop, each boot dying at the migration step: `Access denied for user '<app account>'@'<the app's IPv6 address>'`. |
| 12:32 | PR 37 merged (look hostnames up IPv4 first). The log now names an IPv4 client address, and the login is still refused. |
| 12:45 | The operator fixes the database access in the panel. The site answers 200 at 12:45:28; `verify-live` 36 passed. |
| 12:47 to 12:52 | PR 38 (database target in the failure log) and PR 33 (Home header) deploy cleanly: the app boots and logs in after redeploys. |
| 13:00 to 14:30 | Cron ticks run nothing. No source records a run or a failure, so the only sign is `verify-live` failing once SAID passes its 3-hour limit (at about 13:15). |
| 13:03 to 13:36 | PR 34 (connection breaker), PR 39 (bounded wait for a connection) and PR 40 (soft invalidation) deploy. They are hardening, not part of the fix. |
| 14:10 | The operator runs the tick by hand from a PC and it works: agenstry and Metaplex record runs at 14:11. A first try returned HTTP 400 because the Windows shell stripped the quotes from the JSON body. |
| 14:42 | The cron job's last output (`hosting_cron-jobs_output`) reads `curl: (22) ... error: 400`: the job fires, but the app rejects its body. The job is recreated with the body `{}`. |
| 14:46 | The 14:45 tick runs SAID and the 8004 registry. The scheduled worker is running again. |

## Cause

The plan upgrade is the one change known to have happened, and it lines up with two failures:

1. **The build host's package store lost the execute bit on esbuild's native binary.** pnpm hard-links packages out of one store, so rebuilding `node_modules` brought the loss back, and every build failed for a commit that had built half an hour earlier. pnpm 10 skips esbuild's install script (`Ignored build scripts: esbuild`), and enabling it would not have helped: the script runs the binary and fails if it cannot, so the failure would only have moved from the build to the install. That the upgrade caused the loss is inferred from the timing.
2. **MySQL refused the app's account.** The database saw the app's container IPv6 address first, then an IPv4 address once lookups were made IPv4 first, and refused both. The operator corrected the access in the panel; what exactly was changed was not reported here. The app exits when it cannot apply migrations, so Hostinger restarted it in a loop and the CDN served 503 for every request. The log line `Access denied ... (using password: YES)` could not say which of a wrong password, a wrong server, or an address the account is not allowed from was at fault; PR 38 now writes the target to the log.

3. **The cron job's request body lost its quotes.** The job posted `-d '{"json":null}'`, which worked on the old plan. On the new plan Hostinger's cron runner strips the double quotes from a command, so the app received `{json:null}` and answered every tick with HTTP 400 (Express's plain "Bad Request" page, reproduced without a token). Nothing was recorded, because the request never reached the worker. That the runner changed with the plan move is inferred from the timing. The failure was silent from the app's side and visible only in the job's own output.

Not the cause: the 500-an-hour connection cap (the error was 1045, not 1226), a deploy of ours (the last merge before the outage was PR 32 at 11:17, and it ran fine for half an hour), or a push to a branch (the repository has no webhooks or deploy keys, and no branch push has ever redeployed).

## What was changed

- **PR 36**: `pnpm run build` starts with `scripts/ensure-esbuild-executable.mjs`, which adds the execute bit to any esbuild platform binary under `node_modules/.pnpm` that lacks it (and to the directories on the way). It does nothing on a healthy host and never fails the build itself. Checked on Linux as a non-root user against the exact failure, and confirmed on the real host (`[build] restored the execute permission on 1 esbuild path`). See "Build host" in [worker-operations.md](./worker-operations.md).
- **PR 37**: hostnames are looked up IPv4 first. The database host has both an A and an AAAA record and the container has its own IPv6 address. It did not fix this outage, but it makes the app's address to the database one a panel allowlist can hold.
- **PR 38**: when migrations fail, the log carries the host, the address it resolves to, the port, the database, the user, and whether a password was set, never the password.
- **The cron job** (hPanel, not code): recreated with the body `{}`, which has no quotes to lose, and `--max-time 150` instead of 30. Its output is now `curl: (22) ... error: 504`: the CDN gives up on a request after about a minute, and a tick takes up to about 100 seconds. The tick finishes on the server regardless (the 14:45 tick recorded both of its runs after that). See "Hostinger cron boundary" in [worker-operations.md](./worker-operations.md).
- **Hardening that followed the outage:** PR 34 stops the app from redialling a database that is refusing connections (the pressure test's cap replay went from 590 attempts in 30 seconds to 2), and PR 39 makes a request give up after 30 seconds waiting for a pooled connection.

## What to do next time the site is a 503

1. Read the **runtime log** in the Hostinger panel before anything else. The last lines say whether the app is dying at boot (and why) or running and unreachable.
2. If the log says `Access denied`, the line after it (PR 38) names what the app tried. Check the database user and password, and the Remote MySQL allowlist for the address in the message.
3. If a build fails with `EACCES`, look at the path in the error from the panel's terminal (`ls -l`). PR 36 repairs a missing execute bit; a read-only or `noexec` filesystem, or a file the build user does not own, needs the host.
4. After any plan, server, or account change, expect both of the above, and run `node scripts/verify-live.mjs` once the panel says it is done.
5. Do not merge or deploy while the site is down unless the merge is the fix. Every merge to `main` redeploys.
6. Once the site is back, check that the scheduled worker is running: `updatedAt` on the sources in `liveData.sourceStatuses` should advance every 15 to 30 minutes, and the cron job's last output (hPanel, or `hosting_cron-jobs_output`) says why when it does not. A site that answers 200 can still have a dead schedule; this one did for two hours.

## Open

- **The app refuses to serve when migrations cannot run**, which is right for a schema mismatch but turned a credentials problem into a total outage. Starting in a degraded state when the database cannot be reached or refuses the login (a static shell, the API answering 503 with Retry-After, retrying in the background, restarting once the database answers) would show visitors our page instead of the CDN's, and would stop the restart loop from hammering the database. It changes the "refuse to serve" rule, so it needs the operator's decision.
- **Which host the app uses for the database.** The Hostinger API notes say a deployed Node app should connect to `127.0.0.1:3306`, and that the `srvNNNN.hstgr.io` host is only for connections from outside Hostinger. If `DATABASE_URL` uses the external host, that would fit the refusals after the move. Not confirmed, and not changed here.
- **The cron request is still reported as a failure.** The 504 above is benign but shows in the job's output every 15 minutes. A fire-and-forget tick (answer at once, run in the background) or dropping `-f` from the job would quiet it; neither has been done.
- **The new plan's limits are unknown** to this repository: the database's connections per hour and its maximum connections, and the Node app's memory limit. The 500-an-hour figure in [worker-operations.md](./worker-operations.md) is the old plan's.
- **The cause of the exec-bit loss on the host was inferred, not seen**: the plan move is the only change known to have happened. If it recurs without a plan change, ask the host.
