# The Owl's Catch: one factual finding a day (2026-10-15)

Status: storage, the daily choice, the public reads, the card on the home page, the pages at `/catch`, and the head for link previews are built. A per-day share image is not built (see Open points).

The Owl's Catch is one finding about the directory per day. A fixed rule picks it from the directory's own counts, it is stored with the values its words are made from, and it can be shown again exactly as it was found. It says what a count is. It never says what a count means.

## The rules

The rules and the words live in `shared/owlsCatch.ts`. They are pure, so the server that stores a catch and the page that shows it agree, and the tests need no database. The rules run in this order, and the first that applies is the day's catch.

1. **A round number a chain has just passed.** A chain's reviewed or acknowledged count that has reached 10, 25, 50, 100, 250, 500, 1,000 and so on (one, two and a half or five times a power of ten), is still under 1.25 times that number, and has not been featured for that chain and metric before. A chain that is not indexed has no milestone. Headline form: "<Chain> has passed <round number> reviewed records."
2. **The largest fleet not featured this month.** The registering wallet with the most visible identities, at least `FLEET_MIN` (50), that was not featured in the last 30 days. Ties go to the wallet that sorts first. Headline form: "One registering wallet is recorded against <count> identities."
3. **Nothing.** The day is stored with the rule `none` and the page says "No catch today". Deciding a day once means a quiet day stays quiet.

The detail line for a fleet says that a registering wallet shows who registered, not who holds or runs the agents. Every figure in a headline is a stored value. No words are added by hand.

There is no rule for revoked feedback. The brief asked for one, but no gated per-agent read of feedback exists, and a rule that needed one would have to invent it. It stays out until that read does.

## What is stored

One row per UTC date in `owls_catch`:

| Column | Holds |
|---|---|
| `catchDate` | `YYYY-MM-DD`, unique. |
| `rule` | `fleet`, `milestone` or `none`. |
| `facts` | JSON text: the wallet, count and most common locator host for a fleet; the chain, metric, round number, count and last successful read time for a milestone. Checked on every read. |
| `sourceQuery` | A plain description of the read the facts came from, shown under "how we know". |
| `agentIds` | JSON text: up to 20 directory entry ids of the fleet, oldest first, for the links. `[]` for a milestone. |
| `selectedAt` | When the row was written. |

## When it is chosen

The worker's first tick of the UTC day, after the ingestion work, chooses and stores the catch (`selectTodaysCatch` in `server/owlsCatch.ts`). Every later tick finds the row and does nothing. The insert is `INSERT IGNORE` on the unique date, so a second process choosing the same day is ignored and the first stands.

It is best effort, like the publisher key expiry. A failure (the table missing, the database busy) is logged as `nooscape_owls_catch_failed` and never fails the tick or changes what the tick reports. Public reads never choose anything.

A fleet is only stored with something to link to: a wallet none of whose entries is visible any more is passed over for the next.

The choice reads the directory's wallet grouping once, which is the Fleet sightings scan asking for 40 wallets instead of 12, and the per-chain counts. The pressure test measured scans like that at 4 to 8 seconds of database work at 240,000 entries. It happens once a day, on the first tick, and every other tick of the day does one lookup on the date.

## What the public reads

Three read-only tRPC queries on `liveData`, no sign-in:

- `owlsCatch`: today's status (`selected`, `none`, `pending` before the day's first tick, or `unavailable`), today's catch if there is one, and the newest catch that was found.
- `owlsCatchArchive`: the catches that were found, newest first, `limit` 1 to 100 (default 30). Days with no catch are not listed.
- `owlsCatchByDate`: one day's catch by `YYYY-MM-DD`, or none. A value that is not a real date is rejected.

Each fails closed. If the table cannot be read, the answer is "no catch" (`unavailable`, an empty list, or none) and the failed read never reaches the visitor as an error.

Each catch is served with the entries it links to as `agents`, each an `id` and the `name` it is recorded under, in the order they were stored. The page shows the first five.

**Visibility is checked when a catch is read, not only when it is chosen.** The stored entry ids are asked against the same rule as every public directory read, and the names come from that same read. An entry hidden, closed or suppressed after the catch was chosen is no longer linked. A fleet with none left is not shown at all, and its day reads as "none". The headline keeps the count that was found that day, because a catch is a dated finding and is shown as it was found.

The reads are not put in the read cache, on purpose. A hide has to show on the very next read, as for the reviewed census, and a read costs one lookup on the unique date and one check of at most 20 entries by primary key, nothing like the directory's full-table counts the cache exists for.

## The card and the pages

- **The card** (`client/src/components/home/OwlsCatch.tsx`) sits beside Field Reports on the home page, after them, in a row that gives both the same height. It shows the day, the headline, the detail line, up to five of the fleet's identities by name (each a link to its page), a "How we know" disclosure that starts closed, a link that starts a post on X, and a link to every catch. The words are the server's, shown as they are.
- **No catch today.** When the day has none the card says "No catch today", and the newest catch that was found, with its date, in a smaller box. Before the day's first check it says "Today's catch is not chosen yet". When the read fails it says "The catch cannot be read right now" and shows nothing in its place. It never shows an example.
- **Sharing** is a plain link to `https://x.com/intent/post` with the day and the headline as the text and the day's page as the link. No script and no SDK, and it opens in a new tab without handing over the opener.
- **`/catch`** lists the catches that were found, the newest 30 and then up to 100 on request, newest first. **`/catch/:date`** is one day's catch, or a plain statement that the day has none. A path that is not a date says so and does not ask the server.
- The two routes are one lazy page, so going from the list to a day does not flash the skeleton. The route table the server answers statuses from (`server/clientRoutes.ts`) lists both, and a test requires it to match `client/src/App.tsx`.
- The card is still: nothing in it animates, so reduced motion changes nothing. The header menu links to `/catch`, and the sitemap lists it.

## The head for link previews

The site is a single page app, so a crawler that runs no script (the one behind a post on X, a chat preview, a search engine) reads only the shell's head. `server/catchPage.ts` writes a page's own title, description, preview text, address and robots rule into the shell for `/catch` and `/catch/:date` before sending it. Only the title, the description, the card text and the canonical address change. The image stays the site's card, and no script is touched, so the policy hashes the server derives from the shell still match (a test compares the two policies).

| Path | Status | Head |
|---|---|---|
| `/catch` | 200 | The archive's own. |
| `/catch/:date`, a day with a catch | 200 | The day's title, and the headline with a fixed sign-off as the description. |
| `/catch/:date`, a date with no catch (or whose fleet is no longer visible) | 404, same page | "No catch on <date>", kept out of search. |
| `/catch/<not a date>` | 404, same page | "That is not a date", kept out of search. |
| Either, when the catch cannot be read | 200, the ordinary shell | The site's own head, because the server cannot tell which it is. |

Pages are sent with `Cache-Control: public, max-age=60`. A trailing slash is not the route, as for every other route in the table.

## What it never does

- It is not a score, a rank or a verdict. There is no "top" and no "best".
- Nothing is placed or paid for. Nothing is picked by hand.
- It reads no token or balance, and no token has any part in which catch is chosen.
- It only reads the directory. It never writes to a directory table, and the only table it writes is its own.

## The migration (0036) is run by hand

The boot runner does not apply this migration. It applies every other migration before the server accepts traffic, but `0036_owls_catch.sql` is on its skip list (`MANUAL_MIGRATIONS` in `server/dbMigrations.ts`), so no deploy, restart or worker tick creates the table. The owner runs it, when they choose. The file stays in `drizzle/`, in the journal and in the snapshot chain, so drizzle-kit's picture of the schema stays whole.

What it does:

- One new table and nothing else. No `ALTER` of a live table, no index added to an existing one, no data written, nothing rebuilt. It cannot slow or lock the tables the public reads scan.
- `CREATE TABLE IF NOT EXISTS`, so running the file again changes nothing.
- Nothing refers to the table and it refers to nothing.

**Order.** Run it before the code that reads it is deployed; code that predates this change ignores the table. If the code goes out first nothing breaks: until the table exists the public reads answer "no catch", the card on the home page reads "The catch cannot be read right now", the archive reads "No catch has been chosen yet", the worker logs one `nooscape_owls_catch_failed` line a tick, and each read of the Catch (a home page view, a `/catch/<date>` page) logs a warning with the failed query. Once the table exists, the card reads "Today's catch is not chosen yet" until the next worker tick chooses the day's catch.

**To run it.** Paste `drizzle/0036_owls_catch.sql` into the host's SQL console, on the production database, and run it. Then record it, so the bookkeeping matches:

```sql
INSERT INTO `nooscape_schema_migrations` (`version`, `name`) VALUES (36, '0036_owls_catch.sql');
```

**To check.** `SHOW CREATE TABLE owls_catch;` shows the table, and `SELECT * FROM nooscape_schema_migrations WHERE version = 36;` shows the record.

**Rollback.** Nothing else was changed, so these two statements undo it:

```sql
DROP TABLE IF EXISTS `owls_catch`;
DELETE FROM `nooscape_schema_migrations` WHERE `version` = 36;
```

After that the public reads fail closed to "no catch", the worker's step is logged and skipped, and no other code path changes. The stored catches go with the table, and a past day is not rebuilt, because it was chosen from that day's counts. The record is deleted so that the bookkeeping matches the table again.

**Tests.** `server/dbMigrations.test.ts` covers the skip list: a boot never runs or records version 36, including from the real `drizzle/` folder. `server/owlsCatch.integration.test.ts` makes the table by running the file as pasted, against a real MySQL 8.

## Tests

- `server/owlsCatch.test.ts` covers the pure rules and words, and needs no database. It covers the ladder, the recency window, the 30 day novelty, ordering, ties, every way a stored row can be malformed, and the words.
- `server/owlsCatch.integration.test.ts` runs against a real database (skipped when none is reachable): the migration, which fleets may be featured, a day decided once, two workers choosing the same day, a fleet featured one day and not again for a month, milestones, an entry hidden after its catch was chosen, and every public read failing closed with the table renamed away.
- `server/ingestion/worker.test.ts` covers the worker step: after the ingestion work on every kind of tick, and never failing the tick.
- `server/catchPage.test.ts` covers the head: what changes in the shell and what must not (every other tag, every script, the derived policy), escaping, each status, a failed read, and where the routes are mounted. The integration file also sends the pages with the real read.
- `client/src/components/home/owlsCatchModel.test.ts` covers the card's states and the share link. `owlsCatchCard.test.ts` reads the card's and the pages' source for the rules the briefs make of them, and `server/clientRoutes.test.ts` keeps the route table in step with `App.tsx`.

## Open points

- A partly hidden fleet keeps its stored count in the headline. Recomputing it would let a catch change after its day, which the stored-facts design rules out.
- There is no per-day share image. The preview of a day's link has its own title and description and the site's card as the image. A rendered image needs satori and a PNG renderer; resvg ships a native binary, and this host has already refused to run esbuild's once, so the choice is left to the owner.
