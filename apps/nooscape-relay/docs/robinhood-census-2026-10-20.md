# Robinhood Chain registry census: the measurement (2026-10-20)

This is the measurement behind the report at `/field/robinhood-registry-2026-10-20`. It counts what the directory holds for the ERC-8004 identity registry on Robinhood Chain on 2026-10-20. It is a set of aggregate counts: no name, no wallet address and no host name was selected, and nothing was fetched from any site for it.

## How it was done

The operator ran [the queries](./robinhood-census-queries-2026-10-20.sql) against the production database through hPanel on 2026-10-20, between the registry pass that finished at 02:15 UTC and the next one (query 0 shows that pass as the latest). Every statement is a read-only SELECT. The output below is as it came back.

The queries on the entries count **visible** entries, by the site's own rule (`directoryVisibilityCondition` in `server/db.ts`): the source is active, the entry is not hidden, the chain pass has not seen its asset close, and its locator host is not on the suppressed domain. The entries are the registrations the directory has read from the registry's event log. Queries 7 and 8 read the two event ledgers directly and not the entries, so they hold every event the walks have recorded, including events about an entry the directory does not show.

What each column means:

- **wallet**: the `registrant` the directory records, which is the owner named in the registration event. It is set when the entry is first seen and is not changed when the entry is transferred, so it says who registered an entry and not who holds it now.
- **host**: the host name of an https registration link (`locatorHost`). An entry whose link is not an https address has no host name.
- **placeholder name**: `Agent #<n>`, the name the pass gives an entry that has none. The step that reads names from registration links replaces it when the file the link names has a name.
- **transfer after the mint**: a transfer of the entry's token after the mint (`secondary` in the activity ledger).
- **hand-out**: a transfer after the mint that is sent from the wallet the entry was minted to, within about an hour of the mint (36,000 blocks, `ROBINHOOD_HANDOUT_BLOCK_WINDOW` in `server/ingestion/robinhood.ts`). It is a timing fact and says nothing about why.
- **profile-link edit**: an update of the entry's registration link after the mint (`uri_update`).
- **rating**: a `new_feedback` event in the registry's reputation ledger, and a **revocation** is a `feedback_revoked` event. A revoked rating is still a row of its own.

## Results

### Query 0: as of when

Visible entries, when a pass first and last saw one, and when the registry's source last succeeded. The first-seen date is when the Owl's passes began for this registry, not when anything was registered.

| visible_entries | first_seen_min | last_seen_max | source_last_success |
|---|---|---|---|
| 9191 | 2026-10-09 15:06:10 | 2026-10-20 02:15:27 | 2026-10-20 02:15:27 |

### Query 1: size and surface

| entries | distinct_wallets | no_wallet | with_https_host | distinct_hosts | mint_measured |
|---|---|---|---|---|---|
| 9191 | 771 | 0 | 8679 | 40 | 9191 |

### Query 2: how many entries one wallet holds

Wallets and entries in each size bucket, and the largest holding in the bucket.

| entries_per_wallet | wallets | entries | largest_holding_in_bucket |
|---|---|---|---|
| 1 | 645 | 645 | 1 |
| 2-9 | 107 | 254 | 9 |
| 10-99 | 13 | 155 | 19 |
| 100-999 | 4 | 1453 | 902 |
| 1000+ | 2 | 6684 | 5593 |

### Query 3: the wallets that hold 100 or more entries

By size and never by address. The wallet rank is only the order of the entries column. Each row is one wallet: its entries, how many of them have an https link, how many are on the host name the wallet uses most, and how many host names it uses.

| wallet_rank | entries | with_https_host | on_its_largest_host | distinct_hosts |
|---|---|---|---|---|
| 1 | 5593 | 5593 | 5593 | 1 |
| 2 | 1091 | 1087 | 1004 | 3 |
| 3 | 902 | 902 | 902 | 1 |
| 4 | 318 | 318 | 318 | 1 |
| 5 | 133 | 133 | 133 | 1 |
| 6 | 100 | 100 | 100 | 1 |

### Query 4: host names by size

The five largest host names (rank and entries only; no host is named), and, at rank 0, how many host names hold 50 or more entries.

| host_rank | entries |
|---|---|
| 0 | 10 |
| 1 | 5593 |
| 2 | 1008 |
| 3 | 904 |
| 4 | 318 |
| 5 | 166 |

### Query 5: names

Entries with the placeholder name, distinct real names, and how many entries share a real name (group sizes only; no name is returned). The step that reads names runs every half hour and reads a few links a run, so this is a snapshot of a figure that falls every day.

| entries | placeholder_names | distinct_real_names | entries_sharing_a_name | entries_in_names_shared_by_10_or_more | largest_name_group |
|---|---|---|---|---|---|
| 9191 | 8064 | 1053 | 118 | 0 | 8 |

### Query 6: transfers and edits, from the totals kept for each entry

An entry the activity walk has not covered yet has no totals and is left out of a sum. `covered_by_the_walk` shows the walk has covered every entry.

| entries | mint_measured | covered_by_the_walk | transfers_after_mint | handouts | entries_that_changed_hands | entries_handed_out | profile_link_edits | entries_edited |
|---|---|---|---|---|---|---|---|---|
| 9191 | 9191 | 9191 | 6906 | 6892 | 6901 | 6892 | 462 | 401 |

### Query 6b: entries by transfers after the mint and by edits

| what | per_entry | entries |
|---|---|---|
| edits | 0 | 8790 |
| edits | 1 | 350 |
| edits | 2-4 | 50 |
| edits | 5+ | 1 |
| transfers | 0 | 2290 |
| transfers | 1 | 6897 |
| transfers | 2-4 | 4 |

### Query 7: the activity ledger

The events of the identity registry by kind, the entries they belong to, and the oldest and newest block. A block number is a position in the chain's history and not a date.

| kind | events | entries | oldest_block | newest_block |
|---|---|---|---|---|
| mint | 9191 | 9191 | 34617968 | 93089592 |
| secondary | 6906 | 6901 | 57613251 | 93090785 |
| uri_update | 462 | 401 | 45060417 | 92894075 |

### Query 8: the reputation ledger

The events of the reputation registry beside the identity registry, by kind, with the agents they are about and the wallets that wrote them.

| kind | events | agents | wallets | oldest_block | newest_block |
|---|---|---|---|---|---|
| new_feedback | 642 | 310 | 8 | 38854662 | 86073111 |
| feedback_revoked | 137 | 135 | 1 | 79647610 | 85203168 |

### Query 9: who rated and who was rated

The ratings each agent holds and each rating wallet wrote, in size buckets, with the largest in the bucket. Counts only: no agent id and no address is returned.

| side | ratings_each | members | ratings | largest_in_bucket |
|---|---|---|---|---|
| agents | 1 | 114 | 114 | 1 |
| agents | 2-4 | 196 | 528 | 4 |
| wallets | 1 | 3 | 3 | 1 |
| wallets | 2-4 | 2 | 5 | 3 |
| wallets | 20-99 | 1 | 50 | 50 |
| wallets | 100+ | 2 | 584 | 336 |

## Checks the figures pass

`client/src/pages/robinhoodRegistryReport.test.ts` holds each of these:

- Query 1's entries equal query 0's, query 5's, query 6's and the mints in query 7.
- Query 2's wallets add up to query 1's 771 and its entries to 9,191. Query 3's wallets are the wallets in query 2's two largest buckets, with the same entries.
- Query 6b's entries add up to 9,191 for transfers and for edits. Its transfers and edits agree with query 6, and query 7's events and entries agree with query 6's totals.
- Query 9's agents add up to query 8's 310 and its ratings to 642, and its wallets add up to query 8's 8 and its ratings to 642.
- The largest wallet's entries are the whole of the largest host name: its 5,593 entries all have an https link on one host name, so that host name holds at least that many, and query 4's largest host name holds exactly that many and the next holds fewer.

## Figures worked out from these

Each is computed from the rows above in `client/src/lib/robinhoodRegistryReport.ts`, and the page states no other figure. A share is given to one decimal place and rounded to the nearest.

- 6 wallets hold 8,137 of the 9,191 entries (88.5%), and 19 wallets hold 8,292 (90.2%). The largest single holding is 5,593 (60.9%).
- 645 of the 771 wallets (83.7%) hold one entry each, and together they hold 645 entries (7.0%).
- 5 of the 6 wallets that hold 100 or more entries have every entry on one host name. The other uses 3, with 1,004 of its 1,087 entries that have an https link on the largest.
- The largest wallet's 5,593 entries are on one host name. The largest host name holds 5,593 entries and the next holds 1,008, so the largest wallet's entries are the whole of the largest host name.
- 8,679 of the 9,191 entries (94.4%) have an https link, on 40 host names. The largest host name holds 5,593 of them (64.4%) and the next holds 1,008. The two together hold 6,601 (76.1%). 10 host names hold 50 or more entries.
- 8,064 of the 9,191 entries (87.7%) carry the placeholder name. The other 1,127 carry 1,053 distinct names, and 118 entries (1.3%) share a name with at least one other. No name is shared by 10 or more entries, and the largest group is 8.
- 6,906 transfers after the mint are recorded, on 6,901 entries (75.1%). 2,290 entries (24.9%) have had none.
- 6,892 entries (75.0%) were handed out, each once. The other 14 transfers came later than the first hour or from another wallet.
- 462 profile-link edits are recorded, on 401 entries (4.4%): 350 entries were edited once, 50 two to four times and 1 five times or more.
- 642 ratings were written about 310 agents, by 8 wallets. 137 revocations were recorded, about 135 agents, by 1 wallet.
- The 2 wallets in the largest rating bucket wrote 584 of the 642 ratings (91.0%). The largest wrote 336 (52.3%). No agent holds more than 4 ratings.

## What this measurement cannot say

- **It is not a count of people.** A platform can register many agents under one wallet, and one person can use many wallets. The wallet figures are the registering wallets the directory records.
- **The registering wallet is not the holder.** It is the address named in the registration event and is not changed when the entry is transferred. 6,892 entries were handed out within about an hour of the mint, so for most entries the wallet figures say who registered an entry and not who holds it.
- **It says nothing about whether an agent runs.** Nothing was asked of any address.
- **A hand-out is a timing fact.** It is a transfer out of the wallet an entry was minted to, within about an hour of the mint. It does not say why the entry was sent on or who received it.
- **A shared link, host name, wallet or name is a recorded fact.** It does not say that one person is behind the entries, or that anything is wrong.
- **The name figure moves.** The step that reads the names began on 2026-10-17 and reads a few links a run, so the placeholder count falls every day.
- **It counts the registrations the directory holds.** Query 7 has a mint for each of them, and the oldest is at block 34617968. This census does not compare that count with a total from the registry itself.
- **The ratings are the ledger's, whole.** Queries 8 and 9 read every rating event the directory has recorded, including a rating of an entry the directory does not show. The public ratings figure on the home page counts only ratings of the entries it shows. When it was checked after the run it read 641, one lower than query 8's 642, and the difference was not traced.
- **Names, links and ratings are written by the registrants or by the wallets that used the registry** and have not been verified.
- **It is one moment.** The passes run about every half hour and the figures move with them. The report is dated and will be redone and dated again.
