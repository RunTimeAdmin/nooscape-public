# Gnosis registry census: the measurement (2026-11-06)

This is the measurement behind the report at `/field/gnosis-registry-2026-11-06`. It counts every registration the directory has stored for the ERC-8004 identity registry on Gnosis (chain id 100) on 2026-11-06, listed or held out. It is a set of aggregate counts: no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it.

## How it was done

[The queries](./gnosis-census-queries-2026-11-06.sql) were run against the production database on 2026-11-06 at about 23:30 UTC, after the registry pass that finished at 21:12 UTC. Query 0 shows the last pass that succeeded, and that pass was started by hand: Gnosis's source has been read by a scheduled pass once a day since the deploy at 23:05 UTC that day ([the record](./gnosis-erc8004-2026-11-06.md), section 10), and the first scheduled pass had not finished when the queries were run. Every statement is a read-only SELECT. The output below is as it came back.

The queries count every registration the chain pass has stored for the source (the table `agent_directory_registry_rows`), listed or held out, because the listing rules read exactly those rows: a profile link shared by 2 or more registrations, a host name shared by 50 or more, a wallet that registered 10 or more. Query 0 shows that none is hidden, so the public count of listed entries on 2026-11-06 (41, `GET /api/v1/stats` at 23:17 UTC) is the same as the 41 entries in query 0. The registrations are the ones the directory has read from the registry's event log, from the deploy block to the finalized head.

A host name that holds more than 2,000 rows keeps its first 2,000 in chain order (`FLOOD_HOST_ROW_CAP` in `server/ingestion/erc8004Chains.ts`, [the record](./flood-host-cap-2026-10-21.md)) and the rest are counted in `agent_directory_registry_overflow` and not stored. Query 0b reads that count: 1 host name is past the cap, 1,851 registrations were counted and not stored for it, and the directory counts 4,179 registrations on the chain, 2,328 stored and 1,851 counted. Every other figure here counts the 2,328 stored rows, so the 1,851 are in none of them: the host name holds more than query 4 shows, 3,851 in all, and the wallets, profile links, names and dates of those registrations are in no row.

What each column means:

- **wallet**: the `registrant` the directory records, which is the owner named in the registration event. It is set when the registration is first seen and is not changed when it is transferred, so it says who registered and not who holds it now.
- **host**: the host name of an https registration link (`locatorHost`). A registration whose link is not an https address has no host name.
- **profile link**: the registration link recorded on the chain, kept as a hash (`profileUriHash`). A registration that set no link at all has the hash of the empty text, which the queries count as one value and leave out of the link buckets.
- **placeholder name**: `Agent #<n>`, the name the pass gives a registration that has none. A registry row takes a name only from registration data written into the chain event itself. The directory also reads a name for some listed entries from the file their registration link names (the names step, which Gnosis joined on 2026-11-06). That name is written to the entry and not to the registry row, so these queries do not count it.
- **transfer after the mint**: a transfer of the registration's token after the mint (`secondary` in the activity ledger).
- **hand-out**: a transfer after the mint that is sent from the wallet the registration was minted to, within about an hour of the mint (708 blocks, `handoutBlockWindow` in `server/ingestion/erc8004Chains.ts`). It is a timing fact and says nothing about why.
- **profile-link edit**: an update of the registration's link after the mint (`uri_update`).
- **UTC day and month**: the date of the mint block, worked out from blocks whose times are known. Gnosis's block time is close to constant, about 5.1 to 5.2 seconds a block, with a slot missed now and then, so one rate would not date a block well, and the dates follow the chain's own block times. A day and a month are both dated through the same 19 stretches of 250,000 blocks, the last one shorter, so there is no separate rate for a day: a block's date is the time of the start of the stretch it falls in, plus that stretch's seconds a block for each block after the start. The first stretch starts at the registry's first block, 44,505,010 (2026-02-04 09:49:00 UTC), the last runs to the finalized block, 49,146,890 (2026-11-06 23:11:40 UTC), and the queries file lists all 19, each with a start block, its time and its seconds a block. Every time is a block header timestamp read from a node on 2026-11-06. A date is within about 148 minutes of the real time at the worst and 1.6 minutes at the median (checked against the block times in the logs of all 4,179 registrations, stored or not), so a registration made that close to midnight, or to the end of a month, can land on the next one.
- **listing state**: what the pass stores for each registration (0 no usable link, 1 listed, 2 held out as shared, 3 waiting to be classified, 4 a name that is only a number). Query 7 reads it and works out which rule reached a held-out registration first, in the order the rules run.

## Results

### Query 0: as of when

The registrations stored, how many are hidden, when a pass first and last saw one, when the source last succeeded, and how many entries the directory holds for the registry. The first-seen time is when the pass read them, not when anything was registered.

| registrations | hidden_registrations | first_seen_min | last_seen_max | source_last_success | entries_in_the_directory |
|---|---|---|---|---|---|
| 2328 | 0 | 2026-11-06 21:11:32 | 2026-11-06 21:12:30 | 2026-11-06 21:12:38 | 41 |

### Query 0b: the flood cap

How many hosts went past the 2,000 rows a host may keep, how many registrations were counted and not stored for them, and the largest host's. The registrations on the chain, as the directory counts them, are query 0's registrations plus the second figure here.

| hosts_past_the_cap | registrations_counted_not_stored | largest_host_overflow |
|---|---|---|
| 1 | 1851 | 1851 |

### Query 1: size and surface

| registrations | distinct_wallets | no_wallet | with_https_host | distinct_hosts | distinct_profile_links | no_uri_set | mint_measured |
|---|---|---|---|---|---|---|---|
| 2328 | 52 | 0 | 2051 | 8 | 2295 | 8 | 2328 |

### Query 2: how many registrations one wallet made

Wallets and registrations in each size bucket, and the largest in the bucket. The buckets break at 10 (the listing rule), 50, 100 and 1,000. No wallet made 50 to 999, so those two buckets do not come back.

| registrations_per_wallet | wallets | registrations | largest_in_bucket |
|---|---|---|---|
| 1 | 21 | 21 | 1 |
| 2-9 | 5 | 22 | 8 |
| 10-49 | 25 | 285 | 34 |
| 1000+ | 1 | 2000 | 2000 |

### Query 3: the 25 largest wallets that made 50 or more registrations

By rank and never by address: how many each made, how many of those have an https link, how many sit on the wallet's own largest host name, how many host names it uses and how many profile links. Only 1 wallet made 50 or more, so 1 row comes back.

| wallet_rank | registrations | with_https_host | on_its_largest_host | distinct_hosts | distinct_links |
|---|---|---|---|---|---|
| 1 | 2000 | 2000 | 2000 | 1 | 2000 |

### Query 3b: all the wallets that made 50 or more registrations

| wallets_with_50_or_more | registrations_on_them | largest_wallet |
|---|---|---|
| 1 | 2000 | 2000 |

### Query 4: host names by size

The ten largest host names, by rank and never by name. A host past the flood cap is shown at the 2,000 rows it keeps. Only 8 host names exist among the stored registrations, so 8 rows come back and the table holds all of them.

| host_rank | registrations |
|---|---|
| 1 | 2000 |
| 2 | 33 |
| 3 | 11 |
| 4 | 3 |
| 5 | 1 |
| 6 | 1 |
| 7 | 1 |
| 8 | 1 |

### Query 4b: all the host names that hold 50 or more registrations

| hosts_with_50_or_more | registrations_on_them | largest_host |
|---|---|---|
| 1 | 2000 | 2000 |

### Query 5: profile links held by several registrations

Profile links and registrations in each size bucket (a link of its own is the bucket 1), the largest in the bucket, and how many of the registrations in a bucket have an https host. No link and no hash is returned. The empty link (no URI set) is left out of the buckets and counted in query 1. No link is used by 50 or more registrations, so the buckets 50-999 and 1000+ do not come back.

| registrations_per_link | links | registrations | largest_in_bucket | registrations_with_https_host |
|---|---|---|---|---|
| 1 | 2284 | 2284 | 1 | 2015 |
| 2-9 | 9 | 25 | 5 | 25 |
| 10-49 | 1 | 11 | 11 | 11 |

### Query 6: names

How many registrations still carry the placeholder the pass gives a registration with no name, how many names are distinct, and how many registrations share a name with others. Group sizes only; no name is returned.

| registrations | placeholder_names | distinct_real_names | registrations_sharing_a_name | registrations_in_names_shared_by_10_or_more | largest_name_group |
|---|---|---|---|---|---|
| 2328 | 2064 | 244 | 40 | 0 | 2 |

### Query 7: what the listing rules did

The registrations in each state the pass stores, and for the ones held out as shared, which rule reached them first, in the order the rules run. No registration is in state 3 (waiting), so that row does not come back. One registration is in state 4 (a name that is only a number): it is not listed and is not counted under any of the three rules.

| listing | state | first_rule | registrations |
|---|---|---|---|
| 0 | no usable link | - | 9 |
| 1 | listed | - | 41 |
| 2 | held out as shared | host shared by 50 or more | 2000 |
| 2 | held out as shared | profile link shared by 2 or more | 36 |
| 2 | held out as shared | wallet that registered 10 or more | 241 |
| 4 | name is only a number | - | 1 |

### Query 8: transfers and edits, from the totals kept for each registration

| registrations | mint_measured | covered_by_the_walk | transfers_after_mint | handouts | registrations_that_changed_hands | registrations_handed_out | profile_link_edits | registrations_edited |
|---|---|---|---|---|---|---|---|---|
| 2328 | 2328 | 2328 | 5 | 4 | 5 | 4 | 49 | 24 |

### Query 9: the activity ledger

The events of the source by kind, the registrations they belong to, and the oldest and newest block.

| kind | events | registrations | oldest_block | newest_block |
|---|---|---|---|---|
| mint | 2328 | 2328 | 44506402 | 48805644 |
| secondary | 5 | 5 | 45119618 | 45211076 |
| uri_update | 49 | 24 | 44720956 | 47894843 |

### Query 10a: when the registrations were made, by UTC day

The days that have a registration among the 21 days that end on the day of the newest registration, dated through the 19 stretches of query 10b. A day with none is not shown. The newest registration is dated 2026-10-17, 20 days before the day of the pass (2026-11-06), so the window ends there and not on the day of the pass.

| utc_day | registrations |
|---|---|
| 2026-10-09 | 1 |
| 2026-10-17 | 1 |

### Query 10b: when the registrations were made, by UTC month

Counted forward from the registry's first block, 44,505,010 (2026-02-04 09:49:00 UTC), through 19 stretches of blocks. The registry began on 2026-02-04, so 2026-02 is not a whole month of it. A month with no stored registration does not come back: 2026-05, 2026-07 and 2026-09 are not in the table, and neither is 2026-11, the month of the pass.

| utc_month | registrations |
|---|---|
| 2026-02 | 2015 |
| 2026-03 | 273 |
| 2026-04 | 23 |
| 2026-06 | 14 |
| 2026-08 | 1 |
| 2026-10 | 2 |

## Checks the figures pass

`client/src/pages/gnosisRegistryReport.test.ts` holds each of these:

- Query 1's registrations equal query 0's, query 6's, query 8's and the mints in query 9, and query 0's entries equal query 7's listed row. Query 0b's counted registrations and query 0's registrations make the 4,179 the directory counts on the chain, which is also the public count.
- Query 2's wallets add up to query 1's 52 and its registrations to 2,328. Query 3b's wallet and registrations are the largest bucket of query 2 (1000+), the only one that reaches 50, and query 3 is that one wallet.
- Query 4 is in order, its 8 host names are the 8 query 1 counts, and they add up to the 2,051 registrations with an https link. Its largest holds the 2,000 rows a host may keep, and query 0b counts one host past the cap. Query 4b's one host name holds the same 2,000, and the wallet of query 3 has its 2,000 registrations on one host name, so they are that host name's.
- Query 5's links add up to query 1's different links (not counting the registrations that set none), and its registrations plus the ones that set none add up to 2,328.
- Query 7's states add up to 2,328. Query 8's transfers, hand-outs and edits agree with query 9's events and registrations. Query 10b's months add up to 2,328, and query 10a's days add up to no more than the months they fall in.
- The 19 stretches in the queries file run in order from the registry's first block to the finalized block, meet end to end, and are the same for the days and the months. The oldest and the newest mint block of query 9 are dated, through them, in the first month of query 10b and on the last day of query 10a.

## Figures worked out from these

Each is computed from the rows above in `client/src/lib/gnosisRegistryReport.ts`, and the page states no other figure. A share is given to one decimal place and rounded to the nearest.

- 41 of the 2,328 registrations (1.8%) are listed, which is 1.0% of the 4,179 the directory counts on the chain. 9 (0.4%) have no usable profile link. 2,277 (97.8%) are held out as shared: 36 reached first by a shared profile link, 2,000 by a shared host name and 241 by a wallet that registered 10 or more. 1 carries a name that is only a number, and is not listed.
- 26 wallets made 2,285 of the 2,328 registrations (98.2%), and 1 wallet made 2,000 (85.9%).
- 21 of the 52 wallets (40.4%) registered one each, and together they made 21 registrations (0.9%). The largest bucket, 1000+, holds one wallet. No other wallet made more than 34.
- The one wallet that registered 50 or more made 2,000 registrations. All 2,000 are on one host name, and it gave each of them a profile link of its own. That host name is the largest, and every registration stored for it was made by this wallet.
- 2,051 of the 2,328 registrations (88.1%) have an https link, on 8 host names. The largest host name holds 2,000 of them (97.5%), which is 85.9% of all the registrations. The next holds 33 (1.6%) and the third holds 11. The two largest together hold 2,033 (99.1%). One host name holds 50 or more registrations, 2,000 of them (97.5% of those with an https link and 85.9% of all).
- The largest host name is at the 2,000 rows a host may keep. Query 0b counts 1,851 more registrations for it, so it holds 3,851 in all, 92.2% of the 4,179. The 1,851 are 44.3% of the 4,179.
- 2,284 of the 2,294 different profile links (99.6%) are used by one registration each. 10 are used by more than one, by 36 registrations (1.5%). No profile link is used by 50 or more registrations, and the most any one link has is 11 (0.5% of all the registrations). 8 registrations set no profile link.
- 2,064 of the 2,328 registrations (88.7%) carry the placeholder name. The other 264 carry 244 distinct names, and 40 registrations (1.7%) share a name with at least one other. No name is shared by 10 or more, and the largest group is 2.
- 5 transfers after the mint are recorded, on 5 registrations (0.2%). 2,323 registrations (99.8%) have had none. 4 hand-outs are recorded, on 4 registrations (0.2%), and the other transfer came later than the first hour or from another wallet.
- 49 profile-link edits are recorded, on 24 registrations (1.0%).
- 2,015 of the registrations (86.6%) were made in 2026-02, the registry's first month. Of the 8 whole months after it, 5 have a registration, between 1 and 273 each and 313 in all (13.4%), and 3 have none: 2026-05, 2026-07 and 2026-09. 2026-11, the month of the pass, has none so far. The 2 days from 2026-10-09 to 2026-10-17 that have a registration hold 2 registrations (0.1%), one each, and the other 19 of the 21 days that end on 2026-10-17 had none. The newest stored registration is dated 2026-10-17, 20 days before the day of the pass, 2026-11-06.

## Figures that are not from the queries

- 41, the public count of listed entries, and 4,179, the public count of registrations on the chain, read from `GET /api/v1/stats` on 2026-11-06 at 23:17 UTC. No registration is hidden, so the first is the same as query 0's 41 entries, and the second is query 1's 2,328 stored registrations plus query 0b's 1,851 counted.
- The two block times (44,505,010 at 2026-02-04 09:49:00 UTC and 49,146,890 at 2026-11-06 23:11:40 UTC), read from a node's block headers on 2026-11-06. The first is also in the comment of `GNOSIS_CHAIN` in `server/ingestion/erc8004Chains.ts`. The start block, start time and seconds a block of each of the 19 stretches in query 10a and query 10b were read the same way and are in [the queries](./gnosis-census-queries-2026-11-06.sql).
- 148 minutes and 1.6 minutes, the worst and the median distance of a date from the real block time, over the 4,179 registrations whose logs carry one (the registrations on the chain, stored or not), measured on 2026-11-06 against the stretches in the queries file.

## Running it again

The report is a snapshot, so a later census is a new dated report and this one stays at its address.

- Run the 15 statements of the queries file in one sitting against the production database, in a read-only session, so the figures are one moment. Keep each result grid as it came back. None returns a name, a wallet, a host or a link.
- Query 10a and query 10b date the mint blocks through the 19 stretches in the file. Past the finalized block of this census the last stretch carries on at its own rate, so a registration made after it is dated by extrapolation and the error grows with the distance. For a later census, read the finalized block and the time of the block at every 250,000th block from the registry's first block from a node, write the stretches the way the file does (a start block, its time and the seconds a block to the next start), and check the dates against the block times in the logs of the registrations again.
- Put each returned row into `MEASURED` in `client/src/lib/gnosisRegistryReport.ts`, the public counts into `PUBLIC` and the block facts into `CHAIN`. `client/src/pages/gnosisRegistryReport.test.ts` then holds the page and this document to the data. Several sentences of the report are written for this data (one wallet, one host past the cap, one transfer, two days, months with none), and the test fails when the data stops being that, so the words have to be checked against the new figures.

## What this measurement cannot say

- **It is not a count of people.** A platform can register many agents under one wallet, and one person can use many wallets. The wallet figures are the registering wallets the directory records.
- **The registering wallet is not the holder.** It is the address named in the registration event and is not changed when the registration is transferred. 4 registrations were handed out within about an hour of the mint, so for those the wallet figures say who registered and not who holds.
- **It says nothing about whether an agent runs.** Nothing was asked of any address.
- **A hand-out is a timing fact.** It is a transfer out of the wallet a registration was minted to, within about an hour of the mint. It does not say why the registration was sent on or who received it.
- **A shared link, host name, wallet or name is a recorded fact.** It does not say that one person is behind the registrations, or that anything is wrong. A registration the directory holds out is held out as shared, and is not called fake.
- **It counts the registrations the directory has stored.** That is 2,328 of the 4,179 the directory counts on the chain. The other 1,851 were counted past a host's cap and are in no figure but query 0b's, so the host name, wallet and link figures are for the stored rows. Query 9 has a mint for each stored registration, and the oldest is at block 44506402. This census does not compare the count with a total from the registry itself.
- **The stored registrations are not a sample of the chain.** A host name past the cap keeps its first registrations in chain order, so the figures for hosts, wallets, links, months and days describe the stored rows and not all 4,179. The registrations counted and not stored have no wallet, link, month or day in this census. Most of the stored rows, 2,000 of 2,328, are the first 2,000 of one host name, all made by one wallet.
- **The months and days are the most affected.** The registrations counted and not stored were made after the 2,000 their host kept, so the registry's own history is longer than the table shows, and the months after the first look thinner here than they were on the chain: [the chain record](./gnosis-erc8004-2026-11-06.md) (section 2) counts the chain's months from all 4,179 registrations, with the dates interpolated from block times, and each of its months is larger than the same month here.
- **Ratings are not measured here.** The directory also reads the reputation registry for a count of ratings, which the Gnosis tab and the API show once it has read the registry's whole history, and this census does not use it.
- **Names and links are written by the registrants** and have not been verified.
- **It is one moment.** Gnosis is read by a scheduled pass once a day and the chain is still adding registrations, so the figures are as of the pass named in the header of the report. The report is dated and will be redone and dated again.
- **The dates are worked out.** A registration's day and month come from its mint block and block times read from the chain, within the margins above, and not from a clock the chain keeps for the registration.
- **The listing rules were not changed.** They are the numbers written for the BNB Chain registry. This census says what they did on Gnosis and does not say whether they are right for it.
