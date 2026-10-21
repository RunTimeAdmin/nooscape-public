# New to the Owl (2026-10-17)

The home page's "New to the Owl" section and the line under the hero's figures. They are the part of the front page that moves with the chains: a count of what the directory first saw in the last 24 hours, per chain, and the newest three by name.

## What is counted

`liveData.arrivals` (`readDirectoryArrivals` in `server/db.ts`, the arithmetic in `shared/arrivals.ts`):

- A directory entry counts when its own `firstSeenAt` is inside the last 24 hours. That is when the Owl first saw the entry, not when the agent was made.
- The same visibility rule as every other public count: a hidden entry, one whose asset was closed, one on a suppressed host and one from a source that is not active are never counted or named.
- Only the entries on a chain count. The locator protocols (A2A, the catalog, the census) are on no chain.
- A chain with no active source is "not indexed": no count, no names, never a zero.
- Each chain names its newest three entries. The name is the entry's display name, which for a Robinhood entry is "Agent #n" until the names step has read a name from its registration link (the step takes the newest entries first, see [approvals/2026-10-17-robinhood-entry-names](approvals/2026-10-17-robinhood-entry-names.md)).
- The answer carries the time it was counted, and the page shows it. The page's own clock is never used.

## How it is read

One cached directory read (`cachedDirectoryRead`, the same cache and five minute lifetime as the other directory counts, dropped by the same writes). It is one query over the entries inside the window: each protocol's count and its newest three, by window functions, merged per chain in the server.

The page asks again every minute and when its tab is focused.

## What went wrong at first, and the fix (2026-10-18)

The first version made four passes over `agent_directory_entries` (a count and a list for each chain) with no index on `firstSeenAt`, so every cache miss read the whole table, about 250,000 rows. On the host that took 11 to 15 seconds whenever the cache was cold (after five minutes idle, and after each worker tick's writes), measured live at 14.75, 11.5 and 11.5 seconds. Those scans held database connections the agent pages share, so a click on a name in the section could hang or fail during one, and the server logged nothing for it. On a copy of the table at production size:

| Version | Time for a cold read |
|---|---|
| Four passes, no index (the first version) | 3.6 s |
| One pass, no index | 1.0 s |
| One pass, with the index (migration 0041) | 0.1 s |

The host is three to four times slower than that machine, which is the ratio between 3.6 s locally and the 11 to 15 s seen live. The read is now one pass, and migration 0041 adds `agent_directory_first_seen_idx` so it needs no pass at all.

## Requests of their own (2026-10-18)

The client batches the calls made in the same moment into one request, and a batch answers only when its slowest call has. The home page's first batch carries ten calls (the sample, the chain figures, this read, the records, the coverage, the fleets, the breakdown, the wallet census, the BNB profile and the funnel), so the cold read above held the hero's figures for as long as it ran. Measured live on 2026-10-18 by holding this read for 8 seconds in a browser: the hero's figures appeared after 9.6 seconds.

Two queries now go in a request of their own: this read (the hero can do without its line) and the Noosphere sample (the heaviest read on the page when its cache is cold, and the source of the hero's figures). They are marked with `ownRequest` (`client/src/lib/trpc.ts`), and `client/src/lib/trpcLinks.ts` sends a marked query unbatched with `splitLink`, the rest still batched up to the server's cap. With the same 8 second hold on the new build the hero's figures appeared after 2.4 seconds, and only the line waited. The cost is two more requests per page load and two more a minute for a tab left open, against a limit of 600 requests in 5 minutes for each address; a tab was already making about 19 a minute.

## The migration (0041) is run by hand

The boot runner does not apply it (`MANUAL_MIGRATIONS`). It is one `CREATE INDEX` on `agent_directory_entries`, built online by InnoDB (1.7 seconds on 252,000 rows locally). The code works without it, only slower (one pass, about 3 to 4 seconds cold on the host), and with it afterwards, with no deploy.

**To run it.** Paste `drizzle/0041_agent_directory_first_seen_index.sql` into the host's SQL console, on the production database. Then record it:

```sql
INSERT INTO `nooscape_schema_migrations` (`version`, `name`) VALUES (41, '0041_agent_directory_first_seen_index.sql');
```

**To check.** `SHOW INDEX FROM agent_directory_entries WHERE Key_name = 'agent_directory_first_seen_idx';` shows the index, and `SELECT * FROM nooscape_schema_migrations WHERE version = 41;` shows the record. Running the file twice fails with "Duplicate key name" and changes nothing.

**Rollback.**

```sql
DROP INDEX `agent_directory_first_seen_idx` ON `agent_directory_entries`;
DELETE FROM `nooscape_schema_migrations` WHERE `version` = 41;
```

## Wording

- Hero line: "The Owl first saw N entries in the last 24 hours." and "The Owl saw nothing new in the last 24 hours." It is silent when no chain is measured.
- Section: "A new entry is acknowledged, never reviewed or endorsed." Each name carries "first seen <date, time> UTC".
- The line under the cards: "Counted <date, time> UTC, from each entry's own first-seen time, under the same public rules as every other count."

## Known limits

- A first sight is not a date of birth. A source that is seeded or re-seeded in one go (the 13,313 SAID identities were) would show as one large count for a day. That is true of what the Owl saw, and the section says nothing more.
- The BNB Chain count is the entries the directory lists. The registry holds far more registrations, and the listing rules decide which are published, so the number is not the chain's registration rate.
