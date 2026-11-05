# Incident record: the site down for about 16 minutes (2026-11-01)

nooscape.si answered 503 on every page from 03:00 until 03:17 UTC. The application could not start because the database refused its account: the account's table privileges were gone, and the application stops when it cannot prepare its tables. The operator restored the access in the hosting panel and redeployed, and the site answered again at 03:17. What removed the privileges was not established.

## Timeline (UTC)

| Time | What |
| --- | --- |
| 02:47 and 02:54 | The operator redeploys main twice, the same commit, during the go-live steps of a new chain (migration scripts run by hand in the panel's phpMyAdmin, a setting and a flag). The app boots at 02:55 both times and logs `Schema is current; nothing to apply`. |
| 03:00 | The first failed boot: `CREATE command denied to user '<app account>'@'127.0.0.1' for table 'nooscape_schema_migrations'`, the first statement of the migration step. The process exits and the host starts it again, about ten times a minute. Every request is a 503. |
| 03:10 | Still down. The operator runs `SHOW GRANTS` for the app's account in phpMyAdmin. It lists usage on the server and two privileges on the database that the panel does not manage (`DELETE HISTORY` and `SHOW CREATE ROUTINE`), and no `SELECT`, `INSERT` or `CREATE`. |
| about 03:15 | The operator adds the database's remote access entry for the host's own address in the panel. A second `SHOW GRANTS` lists the full privileges again. |
| 03:17 | The operator redeploys. The app boots at 03:17:11, logs `Schema is current; nothing to apply`, and `/`, `/api/v1` and `/api/v1/stats` answer 200. `verify-live` passes (46 checks, no warning, no failure). |
| 03:20 | A pull request that was waiting is merged and deploys cleanly. Its automatic merge had been switched off during the outage, because a deploy while the site is down only adds to the loop. |

## Cause

Not established. The account had lost its privileges for connections from the host itself (the loopback address), and nothing in the code explains that: the same commit had booted twice at 02:55, no merge happened between, the database was at 3,484 of 6,144 MB (not over its limit), and the host's status page showed no incident. The operator made no change he knows of except running the migration scripts in phpMyAdmin. The theory is that opening or saving something in the panel's database pages re-synced the account's grants and dropped the loopback entry. That was not confirmed.

It is the same family as the incident of 14 October ([record](./incident-2026-10-14-outage.md)): a database account's privileges are granted per connecting address, and a change in the panel can drop one.

## What it cost

- About 16 minutes of 503 on every path. It changed no data: the app was down, so nothing was written.
- The failed boots opened about 170 of the hour's 500 new database connections, so the host's connection cap was not reached and no lockout followed. At ten a minute the cap would have been gone near 03:50 and the site could not have come back until the hour turned over, even with the access fixed.

## What was changed and what to do next time

- No code changed because of it. A start that only created its bookkeeping table when it was missing would not have helped: `SELECT` was gone too. (On 2026-11-05 a follow-up spaced the failed starts, which bounds the connections a loop like this spends: [the record](./boot-spacing-and-build-timing-2026-11-05.md).)
- When a migration is run by hand in the panel, have `SHOW GRANTS FOR CURRENT_USER();` and the remote access page open, and read the runtime log for `CREATE denied` straight afterwards. A second `SHOW GRANTS` that lists the full set means the access is back.
- A deploy during an outage is held until the site answers.
