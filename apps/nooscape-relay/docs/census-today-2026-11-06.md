# The Today block on the registry census reports

Each registry census report is a measurement of one day: about 15 read-only queries run once, the figures pasted into a data file, the prose written against them and held by tests. That is what makes the reports quotable, and it is also why they go out of date. This adds one block to the top of each report, **Today**: the counts of the report's first table, taken from the directory as it stands now, beside the figures the report measured and the change between. The report below it does not change.

**Status.** Built on 2026-11-06 on branch `feat/census-today`. **No migration, no job and no new setting.** It is a read the directory already knows how to make and cache.

**Decided:** 2026-11-06, by the operator, in chat: "update each chain registry census data page daily". I answered that these pages are dated documents and offered two ways: a Today block on every page with the dated body kept (my recommendation), or fully live pages with the prose generated from the numbers. The operator answered "1". I built the first as a cached read of the directory and not as a stored daily row (see below).

## What it shows

A table with the lines of the report's own first table and three columns after the label: the figure the report measured on its date, the count today, and the change (`+73`, `-5`, or `no change`). Above it, one sentence says the report is a measurement of its date and does not change, and when the registry's pass last finished (UTC, to the minute). Below it, for a registry that keeps its registrations in rows, one sentence says how many are held out of the directory today and in which of four states (no usable profile link; shares a link, host or wallet with many others; a name that is only a number; not yet sorted), and for a chain whose ratings count has read the whole history, how many ratings its reputation registry holds.

A count is what the report's queries count (`docs/monad-census-queries-2026-11-01.sql`, Q0, Q0b and Q1), so a figure and the report's differ only because the registry moved:

| Count | Where it comes from |
|---|---|
| Registrations the directory has stored | the rows of the registry's source |
| Registrations counted past a host's cap and not stored | the overflow counts of the source |
| Registrations the directory counts on the chain | those two added |
| Registrations the directory lists | the entries of the source an operator has not hidden |
| Registering wallets | different registering wallets among the rows |
| Registrations with an https link | rows with a host |
| Host names of those links | different hosts among the rows |
| Different profile links | different profile-link hashes among the rows, leaving out the empty link: a registration that set no link is not counted, as in the reports' tables (update 2026-11-20, below) |

A registry that keeps entries (Robinhood Chain) is counted from its visible entries: listed, wallets, https links and host names. A count the registry does not have is left out of the block, and a line of a report's table the answer has no count for is left out and never shown as zero.

## How current it is

The counts are read through the directory's read cache, which the chain passes' writes (registry rows, directory entries, ratings) mark stale, so a count is as current as the chain's last pass and the time of that pass is on the page. The passes run from hourly (Arc) to daily (Monad, Gnosis), so "daily" is the slowest a Today figure can be. The block is fetched once when the page opens and kept for five minutes.

## Why a read and not a stored daily row

I first offered a daily job that stores a row for each chain. The counts turned out to be five index scans of one source's rows, which the directory already reads and caches for the chain tabs (`readRegistryCounts`, `readAgentRegistryProfile`). Measured on production on 2026-11-06 (read-only, the same statements): for Base, 106,493 rows, the five took 28, 258, 192, 288 and 3 ms; for BNB Chain, 408,740 rows, the four on the rows took 126, 498, 797 and 478 ms. So the read costs the largest registry about two seconds of database time once, and the cache serves it after. A stored row would add a table, a migration and a job to produce a figure that is already current. What a stored row would add is **history**: a series of daily counts. This does not keep one. If the operator wants a trend, it is a small table and a daily step, and the read here is what the step would run.

## Which reports have it

Arc (both reports), Base, Ethereum, Monad, Gnosis, Robinhood Chain, and BNB Chain's registry report, which shows the one count the report and the directory make the same way (the listed entries; the report replayed the chain for its registrations, so its figure is not the directory's stored count). Update 2026-11-20: Celo's report carries it too ([the census](./celo-census-2026-11-20.md)), with `celo` in the block's chain list and its ratings line read from the chain's own count.

Not done:

- **Solana.** The report covers three registries in one table; the block's shape is one column of counts for one registry. It needs its own small design.
- **BNB Chain ratings.** A report about ratings, not a registry census.

## A report measured before the way rows are kept changed

The first look at the live pages, on 2026-11-07, found one comparison that misleads: the Base report was measured on 2026-10-21, before the rows already stored past a host's cap were cleared the same day (`docs/flood-host-cap-2026-10-21.md`). Its stored registrations, wallets, https links and profile links then counted a platform's flood that the directory now counts and does not store, so the block showed 389,902 stored registrations against 106,494 today, and a change of -283,408, although no registration was lost. The block takes an optional **note**, said under the table, and Base's page gives one that says exactly this. The other reports were measured after their caps or are not affected by one: Ethereum, Monad and Gnosis and Arc's second report show the registrations counted past a cap as a line of their own, Arc's first report and Robinhood Chain's changed by growth, and BNB Chain's one count is not capped. A test holds that the note is on Base's page and on no other.

## What it leaves alone

The reports: their figures, their prose and their tests are unchanged, and the report tests still pass as they were (the block renders nothing where there is no query client, which is how those tests render a page). The block holds counts only, so no name, wallet, host or link is on it. It fails closed: a read that has not answered, an answer with no counts, a chain whose switch is off or whose source is not active, or a failed read each leave the report alone.

## Held by tests

- `shared/censusToday.test.ts`: the chains, each extra chain's source and ratings key against the chain table, the switches, the labels of the counts.
- `censusToday.integration.test.ts` (MySQL 8 and MariaDB 10.11): every count against rows, overflow, entries and ratings seeded by hand, including the hidden entry that is not listed, the empty profile link that is not a link, a ratings count that has not read the whole history, a paused source, a chain with no source, counts only in what is returned, and the cache.
- `censusTodayRoute.test.ts`: the public read through the router: a chain whose switch is off, the two that are always on, a chain with no report, a source that is not active, and a failed read.
- `censusTodayModel.test.ts`, `CensusToday.test.ts`: the lines and the change, the words, each case of fails-closed, the request made, and counts only.
- `censusTodayPages.test.ts`: each report carries the block for its own chain right after the lines that say when it was measured, with a line for each line of its first table, and without the block where there is no query client.
- Planted changes: 38, each caught. A count's source, label or definition changed, a switch or a cache key dropped, the change reversed or unsigned, the block asking without a query client or in a batch, each fail-closed case, and the block taken off each report, put on the wrong chain or reading the wrong count.

## Open

- On 2026-11-07, after the deploy, the block was drawn on all eight live reports in headless Chrome (no console error, nothing overflowing, plausible changes), which is how the Base comparison above was found. Before that it was drawn in headless Chrome by a built server against a scratch database in the shape of the real one, at 1440 and 375 pixels: it draws on Robinhood Chain, Base and Arc (Gnosis's page has the same two lines as Monad's and is held by the same test), sits right after the lines that say when the report was measured, overflows nothing and leaves the console quiet; and it is absent, with the report intact, on Ethereum (paused source), Monad and BNB Chain (no source). The first look at the deployed pages is the check above.
- No history is kept, as above.
- Solana, as above.

## Update 2026-11-20: the empty link is not a link

The block counted the registrations that set no link as one link (the hash of the empty text), because it was written to match query 1 of the census, whose `distinct_profile_links` counts that hash. The reports' tables do not: their "Different profile links" is that count less the empty link, as the data files say (`q1[5] - (q1[6] > 0 ? 1 : 0)`). So on a chain where some registrations set no link the block read one more than the table beside it from the first minute, and its change column showed +1 for it. It was found on 2026-11-20 while the Celo census was being checked: 9,956 against 9,955 on Celo (45 registrations set no link), and on the live pages of Gnosis (2,297 against 2,294 while the stored registrations rose by 2) and Monad (2,154 against 2,148 for 5 more).

The block now leaves the empty link out (`profileUriHash <> EMPTY_URI_SHA256`, the constant the pass and the groups already use), so it counts what the table counts. A row with no hash at all was never counted. The reports are dated measurements and do not change; only the block's figure moves, down by one on a chain with registrations that set no link (Arc, Base, Ethereum, Monad and Gnosis have some). The integration test seeds the empty link and a row with none and expects two links, and the figure was also run against Celo's real rows (a read-only dump of public chain facts) and read 9,955, the report's table.
