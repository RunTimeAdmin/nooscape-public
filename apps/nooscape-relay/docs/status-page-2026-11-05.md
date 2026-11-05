# The status page (2026-11-05)

> **Status:** Live since 2026-11-05 04:24 UTC (PR 270). From item 10 of the outside list of 4 November 2026 ("public status page: cheap credibility for a data service"). No migration, no setting and no new read: it uses two reads the site already serves.

## What was missing

`/sources` shows each source's lifecycle and its last accepted read, and a workflow on GitHub runs the live checks against the site every six hours, but a reader had no one place that said whether Nooscape was working, how late a source may be before it counts as late, or what had gone wrong before.

## What `/status` shows

- **Right now.** One line (`Everything checked is on schedule.`, `One scheduled source is late.`, `Pay per call needs attention.`, or that part of it could not be read) and three rows: the site and API, the scheduled sources (how many read inside their limit, and each late one with the age of its last read and its limit), and pay per call (off, on with nothing waiting, or how many payments have waited over an hour). It refreshes every minute.
- **What it cannot tell you.** It is served by the app it describes, so when the app is down the page is down with it. It can show a source that is late, not an outage as it happens.
- **When a source counts as late.** The limits are 3, 12 or 36 hours by source, taken from the table the live check holds the same sources to. A source is late when its last successful read is older than its limit, or it has never succeeded. A source that is paused, waiting for review or run by hand is not judged.
- **The check from outside.** The Live health workflow, every six hours, outside Nooscape's hosting, with its public history linked. A failed check opens an issue.
- **Past incidents.** Two, newest first, each a plain account taken from a record in these docs ([2026-11-01](./incident-2026-11-01-outage.md) and [2026-10-14](./incident-2026-10-14-outage.md)).
- **Not here yet.** An uptime percentage. Nothing outside the host measures the site every minute, and a figure from the app's own records could not show the times it was down.

It claims only what it read. A part that could not be read is never counted as fine, and the top line says so. With no scheduled source judged it does not say fine either.

## How it is built

- `client/src/lib/statusModel.ts`: the limits table, `summarizeSources`, `paymentsState`, `overall` and `ageText`, all pure.
- `client/src/lib/incidents.ts`: the list of incidents.
- `client/src/pages/Status.tsx`: the page, on the plain-page frame. It reads `liveData.sourceStatuses` (the answer `/sources` shows) and `GET /api/v1` (for `payments_unresolved_over_hour`) once a minute.
- The route is in `App.tsx`, `server/clientRoutes.ts`, `server/routeHead.ts` and `client/public/sitemap.xml`, and the home page's footer links it.

## Adding an incident

Write the record in these docs first (timeline, cause, cost), then add the entry to `incidents.ts`, newest first. The test checks that the record exists and that every clock time the entry names is in it. An entry is for a time the site was down or a scheduled read stopped for long enough to matter. A source that shows as late is not an incident until the operator writes it up.

## Checked

- Run locally with the client's `/api` calls sent to the live site (read-only): the page read 14 of 14 scheduled sources inside their limit, pay per call on with nothing waiting, the incidents and the links; at 375 px nothing scrolls sideways. To see the late state, the clock was moved ten hours forward in the browser: six sources showed late, with the amber line and each age and limit.
- Tests: the limits equal the live check's table; late, on time at the limit, never succeeded, not judged (paused, review, run by hand, no limit), recorded failures, dates as text; the payments states; every top line, including the part that could not be read and the case where nothing was judged; the age wording. The page test holds the wiring, the two reads and nothing else, the six-hourly schedule and the workflow's name and issue behaviour, that the limits are derived and not typed, the limits and uptime statements, and that each incident has a record whose times match. Six planted bugs (a wrong limit, a read at the limit called late, fine said for nothing judged, "three hours", a time that is not in the record, a third read) were each caught.
- The route, head, sitemap, copy, text-size, no-score and legal page guards pass, and so does the type check.

## Not done, and what comes next

- **An uptime history.** It needs a monitor outside the host that the operator signs up for (one account), watching `/` and `/api/v1/stats` every minute or five. Its public page, or its badge, would be linked from this page, and the "Not here yet" section would go.

## Addendum 2026-11-05: the room the database has

Finding R3 of the outside audit of 2026-11-05 (a registry row cap keyed on one exact https host), on the owner's call of the same day: an alarm now, and ceilings on what the passes store after the move to a server with room. The host stops every write once a database passes the plan's limit (6 GB on Cloud Startup), and the registry rows and the activity ledgers grow with what registrants write on chain. Nothing in the app looked at the size.

The API index (`/api/v1`) now carries `database_room`: `ok`, `low` from 70 percent of the limit, `critical` from 85, or null when the size could not be read. It is one word and never a figure, because the index is public and the limit is a fact about the hosting. The size is the information schema's data and index length of the app's own database, asked at most once in ten minutes (once a minute after a failed ask, and a failed ask is null, never ok). hPanel's figure runs about 180 MB above it, which the bars leave room for. While the room is low or critical the size goes to the runtime log, in megabytes, at most once an hour: `[Database] room is low: 4500 MB of 6144 MB`. `NOOSCAPE_DATABASE_LIMIT_MB` replaces the limit after a change of plan or host.

The status page prints it as "Database room" (room to grow, getting full, nearly full, or not read just now), and its headline says the database is getting full or nearly full, after a late source, a failing one and a waiting payment. The live check reads the same word: low is a warning and critical fails, which opens the health issue; a server that does not report it, or cannot read it, is a warning. The code is `server/databaseRoom.ts`; the tests are `databaseRoom.test.ts`, `databaseRoom.integration.test.ts` (the size query against MySQL 8.4 and MariaDB 10.11), `apiV1.test.ts`, `statusModel.test.ts` and `status.test.ts`.

When it fires, read the biggest tables in phpMyAdmin, naming the schema (there `DATABASE()` can point at the information schema): `SELECT table_name, ROUND((data_length + index_length) / 1048576) AS mb FROM information_schema.tables WHERE table_schema = 'the app database' ORDER BY mb DESC LIMIT 8`. The clean-up of 21 October 2026 (docs/flood-host-cap-2026-10-21.md) is the precedent. Not done: the ceilings on what the passes store, which are a policy choice (a ceiling stops storing new registrations) and wait for the move.
