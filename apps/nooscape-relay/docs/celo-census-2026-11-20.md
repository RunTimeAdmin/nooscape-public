# Celo registry census: the measurement (2026-11-20)

This is the measurement behind the report at `/field/celo-registry-2026-11-20`. It counts every registration the directory has stored for the ERC-8004 identity registry on Celo (chain id 42220) on 2026-11-20, listed or held out. It is a set of aggregate counts: no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it.

## How it was done

[The queries](./celo-census-queries-2026-11-20.sql) were run against the production database on 2026-11-20 at 19:44 UTC, after the registry pass that finished at 19:03 UTC. Query 0 shows the last pass that succeeded: it was the last of the 67 runs, started by hand through the operator's admin API, by which the directory read the registry's whole history for the first time ([the record](./celo-erc8004-2026-11-20.md), section 9). Every statement is a read-only SELECT. The output below is as it came back.

The queries count every registration the chain pass has stored for the source (the table `agent_directory_registry_rows`), listed or held out, because the listing rules read exactly those rows: a profile link shared by 2 or more registrations, a host name shared by 50 or more, a wallet that registered 10 or more. Query 0 shows that none is hidden, so the public count of listed entries on 2026-11-20 (517, `GET /api/v1/stats` at 19:54 UTC) is the same as the 517 entries in query 0. The registrations are the ones the directory has read from the registry's event log, from the deploy block to the finalized head.

A host name that holds more than 2,000 rows keeps its first 2,000 in chain order (`FLOOD_HOST_ROW_CAP` in `server/ingestion/erc8004Chains.ts`, [the record](./flood-host-cap-2026-10-21.md)) and the rest are counted in `agent_directory_registry_overflow` and not stored. Query 0b reads that count: no host name is past the cap, no registration was counted and not stored, and the directory counts 10,080 registrations on the chain, all of them stored. Every figure here counts those 10,080.

What each column means:

- **wallet**: the `registrant` the directory records, which is the owner named in the registration event. It is set when the registration is first seen and is not changed when it is transferred, so it says who registered and not who holds it now.
- **host**: the host name of an https registration link (`locatorHost`). A registration whose link is not an https address has no host name.
- **profile link**: the registration link recorded on the chain, kept as a hash (`profileUriHash`). A registration that set no link at all has the hash of the empty text, which the queries count as one value and leave out of the link buckets.
- **placeholder name**: `Agent #<n>`, the name the pass gives a registration that has none. A registry row takes a name only from registration data written into the chain event itself. The directory also reads a name for some listed entries from the file their registration link names (the names step). That name is written to the entry and not to the registry row, so these queries do not count it.
- **transfer after the mint**: a transfer of the registration's token after the mint (`secondary` in the activity ledger).
- **hand-out**: a transfer after the mint that is sent from the wallet the registration was minted to, within about an hour of the mint (3,600 blocks, `handoutBlockWindow` in `server/ingestion/erc8004Chains.ts`). It is a timing fact and says nothing about why.
- **profile-link edit**: an update of the registration's link after the mint (`uri_update`).
- **UTC day and month**: the date of the mint block. Celo's blocks are exactly one second apart, so the date is the time of the registry's first block, 58,396,724 (2026-02-05 13:18:02 UTC), plus the blocks since as seconds. The queries use that one rule for a day and for a month. It was checked against the block timestamps in the registrations' own logs, 20,226 distinct blocks from 58,399,999 to 83,290,998, read on 2026-11-20: no block's time differs from the rule by even a second, so a date is exact.
- **listing state**: what the pass stores for each registration (0 no usable link, 1 listed, 2 held out as shared, 3 waiting to be classified, 4 a name that is only a number). Query 7 reads it and works out which rule reached a held-out registration first, in the order the rules run.

## Results

### Query 0: as of when

The registrations stored, how many are hidden, when a pass first and last saw one, when the source last succeeded, and how many entries the directory holds for the registry. The first-seen time is when the pass read them, not when anything was registered.

| registrations | hidden_registrations | first_seen_min | last_seen_max | source_last_success | entries_in_the_directory |
|---|---|---|---|---|---|
| 10080 | 0 | 2026-11-20 18:27:33 | 2026-11-20 19:03:53 | 2026-11-20 19:03:55 | 517 |

### Query 0b: the flood cap

How many hosts went past the 2,000 rows a host may keep, how many registrations were counted and not stored for them, and the largest host's. The registrations on the chain, as the directory counts them, are query 0's registrations plus the second figure here.

| hosts_past_the_cap | registrations_counted_not_stored | largest_host_overflow |
|---|---|---|
| 0 | 0 | 0 |

### Query 1: size and surface

| registrations | distinct_wallets | no_wallet | with_https_host | distinct_hosts | distinct_profile_links | no_uri_set | mint_measured |
|---|---|---|---|---|---|---|---|
| 10080 | 911 | 0 | 775 | 147 | 9956 | 45 | 10080 |

### Query 2: how many registrations one wallet made

Wallets and registrations in each size bucket, and the largest in the bucket. The buckets break at 10 (the listing rule), 50, 100 and 1,000.

| registrations_per_wallet | wallets | registrations | largest_in_bucket |
|---|---|---|---|
| 1 | 819 | 819 | 1 |
| 2-9 | 76 | 227 | 9 |
| 10-49 | 10 | 170 | 24 |
| 50-99 | 3 | 195 | 73 |
| 100-999 | 1 | 105 | 105 |
| 1000+ | 2 | 8564 | 6934 |

### Query 3: the 25 largest wallets that made 50 or more registrations

By rank and never by address: how many each made, how many of those have an https link, how many sit on the wallet's own largest host name, how many host names it uses and how many profile links. 6 wallets made 50 or more, so 6 rows come back.

| wallet_rank | registrations | with_https_host | on_its_largest_host | distinct_hosts | distinct_links |
|---|---|---|---|---|---|
| 1 | 6934 | 0 | 0 | 0 | 6934 |
| 2 | 1630 | 0 | 0 | 0 | 1630 |
| 3 | 105 | 0 | 0 | 0 | 105 |
| 4 | 73 | 0 | 0 | 0 | 73 |
| 5 | 63 | 55 | 55 | 1 | 63 |
| 6 | 59 | 59 | 56 | 4 | 35 |

### Query 3b: all the wallets that made 50 or more registrations

| wallets_with_50_or_more | registrations_on_them | largest_wallet |
|---|---|---|
| 6 | 8864 | 6934 |

### Query 4: host names by size

The ten largest host names, by rank and never by name. No host is past the flood cap, so each is shown at its true size.

| host_rank | registrations |
|---|---|
| 1 | 260 |
| 2 | 158 |
| 3 | 56 |
| 4 | 55 |
| 5 | 28 |
| 6 | 19 |
| 7 | 11 |
| 8 | 11 |
| 9 | 6 |
| 10 | 5 |

### Query 4b: all the host names that hold 50 or more registrations

| hosts_with_50_or_more | registrations_on_them | largest_host |
|---|---|---|
| 4 | 529 | 260 |

### Query 5: profile links held by several registrations

Profile links and registrations in each size bucket (a link of its own is the bucket 1), the largest in the bucket, and how many of the registrations in a bucket have an https host. No link and no hash is returned. The empty link (no URI set) is left out of the buckets and counted in query 1. No link is used by 50 or more registrations, so the buckets 50-999 and 1000+ do not come back.

| registrations_per_link | links | registrations | largest_in_bucket | registrations_with_https_host |
|---|---|---|---|---|
| 1 | 9916 | 9916 | 1 | 716 |
| 2-9 | 38 | 94 | 6 | 34 |
| 10-49 | 1 | 25 | 25 | 25 |

### Query 6: names

How many registrations still carry the placeholder the pass gives a registration with no name, how many names are distinct, and how many registrations share a name with others. Group sizes only; no name is returned.

| registrations | placeholder_names | distinct_real_names | registrations_sharing_a_name | registrations_in_names_shared_by_10_or_more | largest_name_group |
|---|---|---|---|---|---|
| 10080 | 1138 | 8107 | 1615 | 26 | 26 |

### Query 7: what the listing rules did

The registrations in each state the pass stores, and for the ones held out as shared, which rule reached them first, in the order the rules run. No registration is in state 3 (waiting) or in state 4 (a name that is only a number), so those rows do not come back.

| listing | state | first_rule | registrations |
|---|---|---|---|
| 0 | no usable link | - | 198 |
| 1 | listed | - | 517 |
| 2 | held out as shared | host shared by 50 or more | 502 |
| 2 | held out as shared | profile link shared by 2 or more | 84 |
| 2 | held out as shared | wallet that registered 10 or more | 8779 |

### Query 8: transfers and edits, from the totals kept for each registration

| registrations | mint_measured | covered_by_the_walk | transfers_after_mint | handouts | registrations_that_changed_hands | registrations_handed_out | profile_link_edits | registrations_edited |
|---|---|---|---|---|---|---|---|---|
| 10080 | 10080 | 10080 | 76 | 68 | 76 | 68 | 10092 | 7383 |

### Query 9: the activity ledger

The events of the source by kind, the registrations they belong to, and the oldest and newest block.

| kind | events | registrations | oldest_block | newest_block |
|---|---|---|---|---|
| mint | 10080 | 10080 | 58399999 | 83297819 |
| secondary | 76 | 76 | 59714766 | 82459491 |
| uri_update | 10092 | 7383 | 58487151 | 83297822 |

### Query 10a: when the registrations were made, by UTC day

The days that have a registration among the 21 days that end on the day of the newest registration, dated by the one-second rule of query 10b. A day with none is not shown. The newest registration is dated 2026-11-20, the day of the pass.

| utc_day | registrations |
|---|---|
| 2026-10-31 | 2 |
| 2026-11-01 | 5 |
| 2026-11-02 | 9 |
| 2026-11-03 | 9 |
| 2026-11-04 | 2 |
| 2026-11-05 | 5 |
| 2026-11-06 | 5 |
| 2026-11-07 | 6 |
| 2026-11-08 | 5 |
| 2026-11-09 | 11 |
| 2026-11-17 | 2 |
| 2026-11-18 | 3 |
| 2026-11-20 | 6 |

### Query 10b: when the registrations were made, by UTC month

Counted forward from the registry's first block, 58,396,724 (2026-02-05 13:18:02 UTC), at one second a block. The registry began on 2026-02-05, so 2026-02 is not a whole month of it, and 2026-11, the month of the pass, is not complete. Every whole month between them has a registration.

| utc_month | registrations |
|---|---|
| 2026-02 | 333 |
| 2026-03 | 5847 |
| 2026-04 | 2867 |
| 2026-05 | 149 |
| 2026-06 | 461 |
| 2026-07 | 94 |
| 2026-08 | 50 |
| 2026-09 | 70 |
| 2026-10 | 141 |
| 2026-11 | 68 |

## Checks the figures pass

`client/src/pages/celoRegistryReport.test.ts` holds each of these:

- Query 1's registrations equal query 0's, query 6's, query 8's and the mints in query 9, and query 0's entries equal query 7's listed row. Query 0b counts none past a host's cap, so the 10,080 registrations stored are the 10,080 the directory counts on the chain, which is also the public count.
- Query 2's wallets add up to query 1's 911 and its registrations to 10,080. Query 3b's wallets and registrations are the buckets of query 2 that reach 50 (50-99, 100-999 and 1000+), and query 3 is all of those wallets, in order.
- Query 4's ten host names are in order, are parts of the 775 registrations with an https link, and the 4 that hold 50 or more are the 4 of query 4b. Query 1's 147 host names are more than the ten shown.
- Query 5's links add up to query 1's different links (not counting the registrations that set none), and its registrations plus the ones that set none add up to 10,080.
- Query 7's states add up to 10,080. Query 8's transfers, hand-outs and edits agree with query 9's events and registrations. Query 10b's months add up to 10,080, and query 10a's days add up to no more than the months they fall in.
- The oldest and the newest mint block of query 9 are dated, by the one-second rule, in the first month of query 10b and on the last day of query 10a.

## Figures worked out from these

Each is computed from the rows above in `client/src/lib/celoRegistryReport.ts`, and the page states no other figure. A share is given to one decimal place and rounded to the nearest.

- 517 of the 10,080 registrations (5.1%) are listed, which is 5.1% of the 10,080 the directory counts on the chain. 198 (2.0%) have no usable profile link. 9,365 (92.9%) are held out as shared: 84 reached first by a shared profile link, 502 by a shared host name and 8,779 by a wallet that registered 10 or more. None carries a name that is only a number.
- 16 wallets made 9,034 of the 10,080 registrations (89.6%), and 6 wallets made 8,864 (87.9%).
- 819 of the 911 wallets (89.9%) registered one each, and together they made 819 registrations (8.1%). The largest bucket, 1000+, holds two wallets, which made 8,564 registrations (85.0%): the largest 6,934 (68.8%) and the other 1,630. The other 4 wallets that made 50 or more made 300 between them, and no wallet outside the largest bucket made more than 105.
- 4 of the 6 wallets that made 50 or more made no registration with an https link, and made 8,742 between them. 5 of the 6 gave every registration a profile link of its own. The 6 made 114 registrations with an https link, and 111 of them are on the host name that is the largest for the wallet that made them.
- 775 of the 10,080 registrations (7.7%) have an https link, on 147 host names. The largest host name holds 260 of them (33.5%), which is 2.6% of all the registrations. The next holds 158 (20.4%), the third 56 and the fourth 55. 4 host names hold 50 or more registrations, 529 between them (68.3% of those with an https link and 5.2% of all). No host name is past the cap.
- 9,916 of the 9,955 different profile links (99.6%) are used by one registration each. 39 are used by more than one, by 119 registrations (1.2%). No profile link is used by 50 or more registrations, and the most any one link has is 25 (0.2% of all the registrations). 45 registrations set no profile link.
- 1,138 of the 10,080 registrations (11.3%) carry the placeholder name. The other 8,942 carry 8,107 distinct names, and 1,615 registrations (16.0%) share a name with at least one other. One name is shared by 26 registrations, and no other name is shared by 10 or more.
- 76 transfers after the mint are recorded, on 76 registrations (0.8%). 10,004 registrations (99.2%) have had none. 68 hand-outs are recorded, on 68 registrations (0.7%), and the other 8 transfers came later than the first hour or from another wallet.
- 10,092 profile-link edits are recorded, on 7,383 registrations (73.2%).
- 333 of the registrations (3.3%) were made in 2026-02, the registry's first month, and 5,847 (58.0%) in 2026-03, the busiest. The 8 whole months after the first all have a registration, between 50 and 5,847 each and 9,679 in all (96.0%). 2026-11, the month of the pass, has 68 so far. The 13 days that have a registration among the 21 days that end on 2026-11-20 hold 70 registrations (0.7%), between 2 and 11 each, and the other 8 of the 21 days had none. The newest stored registration is dated 2026-11-20, the day of the pass.

## Figures that are not from the queries

- 517, the public count of listed entries, and 10,080, the public count of registrations on the chain, read from `GET /api/v1/stats` on 2026-11-20 at 19:54 UTC. No registration is hidden, so the first is the same as query 0's 517 entries, and none was counted past a host's cap, so the second is query 1's 10,080 stored registrations.
- The first block's time (58,396,724 at 2026-02-05 13:18:02 UTC), read from a node's block header on 2026-11-20. It is also in the comment of `CELO_CHAIN` in `server/ingestion/erc8004Chains.ts`.
- 20,226 distinct blocks, from 58,399,999 to 83,290,998, whose timestamps in the registrations' own logs were compared on 2026-11-20 with the one-second rule: the largest difference was 0 seconds.

## Running it again

The report is a snapshot, so a later census is a new dated report and this one stays at its address.

- Run the 15 statements of the queries file in one sitting against the production database, in a read-only session, so the figures are one moment. Keep each result grid as it came back. None returns a name, a wallet, a host or a link.
- Query 10a and query 10b date the mint blocks at one second a block from the registry's first block. That holds as long as Celo's blocks stay one second apart. For a later census, check it again against the block times in the logs of the registrations before trusting the dates.
- Put each returned row into `MEASURED` in `client/src/lib/celoRegistryReport.ts`, the public counts into `PUBLIC` and the block facts into `CHAIN`. `client/src/pages/celoRegistryReport.test.ts` then holds the page and this document to the data. Several sentences of the report are written for this data (two wallets in the largest bucket, six large wallets, no host past the cap, no month with none, edits on most registrations), and the test fails when the data stops being that, so the words have to be checked against the new figures.

## What this measurement cannot say

- **It is not a count of people.** A platform can register many agents under one wallet, and one person can use many wallets. The wallet figures are the registering wallets the directory records.
- **The registering wallet is not the holder.** It is the address named in the registration event and is not changed when the registration is transferred. 68 registrations were handed out within about an hour of the mint, so for those the wallet figures say who registered and not who holds.
- **It says nothing about whether an agent runs.** Nothing was asked of any address.
- **A hand-out is a timing fact.** It is a transfer out of the wallet a registration was minted to, within about an hour of the mint. It does not say why the registration was sent on or who received it.
- **A shared link, host name, wallet or name is a recorded fact.** It does not say that one person is behind the registrations, or that anything is wrong. A registration the directory holds out is held out as shared, and is not called fake.
- **It counts the registrations the directory has stored.** That is all 10,080 it counts on the chain. This census does not compare the count with a total from the registry's own contract.
- **An edit of a profile link is a recorded change and nothing more.** The link a registration shows now can differ from the one it was minted with, and the link and host figures are for the links as the directory last read them. 7,383 registrations were edited at least once.
- **Ratings are not measured here.** The directory also reads the reputation registry for a count of ratings, which the Celo tab and the API show once it has read the registry's whole history, and this census does not use it.
- **Names and links are written by the registrants** and have not been verified.
- **It is one moment.** The chain is still adding registrations, so the figures are as of the pass named in the header of the report. The report is dated and will be redone and dated again.
- **The dates are worked out.** A registration's day and month come from its mint block and the one-second rule, and not from a clock the chain keeps for the registration.
- **The listing rules were not changed.** They are the numbers written for the BNB Chain registry. This census says what they did on Celo and does not say whether they are right for it.
