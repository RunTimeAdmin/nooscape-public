# Building the database from nothing (4 November 2026)

**Status.** Built on 2026-11-04 and not yet live; the merge is recorded here when it is done. The path it adds is not taken by any boot on the host, so there is nothing to see live.

**Decided:** 2026-11-04, by the operator, in chat: "next", after "go" and the list I gave after the third outside review ("graceful shutdown plus the bootstrap-from-empty path as the second PR"). The finding was C1 of that review (S6), the same as finding 9's remainder in the [12 October response](./security-review-response-2026-10-12.md), which was queued there as "new to us and unverified".

## What was wrong

On a database with nothing in it, the boot runner stamped versions 0000 to 0014 as applied without running them (that history was applied by hand before the runner existed) and then ran 0015, an `ALTER TABLE` on a table that was not there, and the process exited. It was reproduced on a real empty database on 2026-11-04: `Table '...agent_directory_entries' doesn't exist`. So a fresh environment, a staging copy or a rebuild could not be made by the app.

It hid a second fact. Fourteen migrations (36 to 46, 49, 51 and 53) are manual by design and the runner never applies them, so replaying the baseline alone would not have made a working schema either. The integration tests have always built their databases by replaying 0000 to 0014 and pasting the manual files themselves.

## What it does

- A log with nothing in it, in a database with no table, is an empty database. The runner now refuses it, and the message says what to do: restore a dump into it, or start once with `NOOSCAPE_BOOTSTRAP_EMPTY_DATABASE=1` and then unset it. With that word set, the runner applies every file in version order, from 0000 to the last, the manual ones included, and records each under its file's name.
- It is off unless asked. A `DATABASE_URL` that is mistyped and points at an empty database must stop the start, not build a blank site that looks healthy.
- A database with any table, or with any recorded migration, is untouched by all of this. The same stamping, the same skipping, the same order: a boot on the host takes the path it always took. The word on such a database changes nothing, and the runner says so ("Unset it"), so that it does not stay set.
- A build that fails part-way says which file stopped it and that the database is partly built: drop it, create it again empty and start once more. (The log then holds the files that ran, so the next start would take the rest for a database built by hand.)

## What was checked

- Before any change, all 56 files were applied in order to an empty database on both engines: no failure, and 48 tables built, which is exactly the 48 that `drizzle/schema.ts` declares, none missing and none extra. It took 7.3 seconds on MySQL 8 (on tmpfs) and 1.1 seconds on MariaDB 10.11.
- `server/dbMigrations.test.ts` (the connection is a fake): an empty database is refused with what to do and nothing is written; every file runs in order, the baseline and a manual one included, and each is recorded; a database with tables is not built over even when asked, and says so; a database with a log is left alone and says the word is not needed; and a failure part-way names the file and says the database is partly built. The existing first-boot test gained one query, the count of the tables.
- `server/dbBootstrap.integration.test.ts`, on a real database, on MySQL 8 and on MariaDB 10.11: refusal builds nothing; a build makes exactly the tables the schema declares, with every version recorded under its file's name; the next start applies nothing. It also holds the files and the schema to each other: a table added to one and not the other fails the gate.
- The integration tests that replay the baseline by hand and then call the runner (the way production has always run) pass unchanged on both engines.
- Each guard was failed by a planted bug and caught: the refusal missing, every database taken for empty, the manual migrations skipped in a build, the baseline skipped in a build, the partly-built message missing, and the "word changed nothing" line missing.

## What it does not do

- It builds no data. An empty database has no sources, no records and no keys; the sources must be approved again. Moving the live data is a restore from a dump, which brings its log with it, so the runner sees it as current.
- A database made with `drizzle-kit migrate` (`pnpm db:push`) already has every table and its own log, so the runner takes it for one built by hand and tries to run the files above the baseline again. That is not supported: use this path, or a dump.
- It does not decide for the operator. Without the word an empty database stops the start.
