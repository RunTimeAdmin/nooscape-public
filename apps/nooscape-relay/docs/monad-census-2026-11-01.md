# Monad registry census: the measurement (2026-11-01)

This is the measurement behind the report at `/field/monad-registry-2026-11-01`. It counts every registration the directory has stored for the ERC-8004 identity registry on Monad (chain id 143) on 2026-11-01, listed or held out. It is a set of aggregate counts: no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it.

## How it was done

The operator ran [the queries](./monad-census-queries-2026-11-01.sql) against the production database through phpMyAdmin in hPanel on 2026-11-01, after the registry pass that finished at 17:15 UTC (query 0 shows that pass as the latest, and it was the first scheduled one: Monad's source is read once a day since [migration 0054](./monad-erc8004-2026-11-01.md)). Every statement is a read-only SELECT. The output below is as it came back.

The queries count every registration the chain pass has stored for the source (the table `agent_directory_registry_rows`), listed or held out, because the listing rules read exactly those rows: a profile link shared by 2 or more registrations, a host name shared by 50 or more, a wallet that registered 10 or more. Query 0 shows that none is hidden, so the public count of listed entries on 2026-11-01 (144, `GET /api/v1/stats` at 19:21 UTC) is the same as the 144 entries in query 0. The registrations are the ones the directory has read from the registry's event log, from the deploy block to the finalized head.

A host name that holds more than 2,000 rows keeps its first 2,000 in chain order (`FLOOD_HOST_ROW_CAP` in `server/ingestion/erc8004Chains.ts`, [the record](./flood-host-cap-2026-10-21.md)) and the rest are counted in `agent_directory_registry_overflow` and not stored. Query 0b reads that count: 1 host name is past the cap, 6,094 registrations were counted and not stored for it, and the directory counts 10,421 registrations on the chain, 4,327 stored and 6,094 counted. Every other figure here counts the 4,327 stored rows, so the 6,094 are in none of them: the host name holds more than query 4 shows, 8,094 in all, and the wallets, profile links, names and dates of those registrations are in no row.

What each column means:

- **wallet**: the `registrant` the directory records, which is the owner named in the registration event. It is set when the registration is first seen and is not changed when it is transferred, so it says who registered and not who holds it now.
- **host**: the host name of an https registration link (`locatorHost`). A registration whose link is not an https address has no host name.
- **profile link**: the registration link recorded on the chain, kept as a hash (`profileUriHash`). A registration that set no link at all has the hash of the empty text, which the queries count as one value and leave out of the link buckets.
- **placeholder name**: `Agent #<n>`, the name the pass gives a registration that has none. A registry row takes a name only from registration data written into the chain event itself. The directory also reads a name for some listed entries from the file their registration link names (the names step, which took Monad's turn from 2026-11-01). That name is written to the entry and not to the registry row, so these queries do not count it.
- **transfer after the mint**: a transfer of the registration's token after the mint (`secondary` in the activity ledger).
- **hand-out**: a transfer after the mint that is sent from the wallet the registration was minted to, within about an hour of the mint (11,918 blocks, `handoutBlockWindow` in `server/ingestion/erc8004Chains.ts`). It is a timing fact and says nothing about why.
- **profile-link edit**: an update of the registration's link after the mint (`uri_update`).
- **UTC day and month**: the date of the mint block, worked out from blocks whose times are known. Monad's block time was not constant: about 0.4 seconds a block from the registry's first block to block 89,652,790, and about 0.3 since. For a day it is 2026-11-01 18:47:03 UTC (block 118,545,151, the finalized block when the queries were written) less 0.30268 seconds for each block before it, the average over the last 200,000 blocks. For a month it follows 29 stretches of blocks: the time of the start of the stretch a block falls in, plus that stretch's seconds a block for each block after it. The first stretch starts at the registry's first block, 52,952,790 (2026-02-03 11:36:02 UTC), and the queries file lists all 29, each with a start block, its time and its seconds a block. Every time is a block header timestamp read from a public node on 2026-11-01. A day is within about 30 minutes of the real time and a month within about 40 at the worst (the worst of 400 random blocks, with a median of about 2.5 minutes), so a registration made that close to midnight, or to the end of a month, can land on the next one.
- **listing state**: what the pass stores for each registration (0 no usable link, 1 listed, 2 held out as shared, 3 waiting to be classified, 4 a name that is only a number). Query 7 reads it and works out which rule reached a held-out registration first, in the order the rules run.

## Results

### Query 0: as of when

The registrations stored, how many are hidden, when a pass first and last saw one, when the source last succeeded, and how many entries the directory holds for the registry. The first-seen time is when the pass read them, not when anything was registered.

| registrations | hidden_registrations | first_seen_min | last_seen_max | source_last_success | entries_in_the_directory |
|---|---|---|---|---|---|
| 4327 | 0 | 2026-11-01 03:24:06 | 2026-11-01 17:15:08 | 2026-11-01 17:15:08 | 144 |

### Query 0b: the flood cap

How many hosts went past the 2,000 rows a host may keep, how many registrations were counted and not stored for them, and the largest host's. The registrations on the chain, as the directory counts them, are query 0's registrations plus the second figure here.

| hosts_past_the_cap | registrations_counted_not_stored | largest_host_overflow |
|---|---|---|
| 1 | 6094 | 6094 |

### Query 1: size and surface

| registrations | distinct_wallets | no_wallet | with_https_host | distinct_hosts | distinct_profile_links | no_uri_set | mint_measured |
|---|---|---|---|---|---|---|---|
| 4327 | 2592 | 0 | 4037 | 43 | 2149 | 67 | 4327 |

### Query 2: how many registrations one wallet made

Wallets and registrations in each size bucket, and the largest in the bucket. The buckets break at 10 (the listing rule), 50 and 100. No wallet made 1,000 or more, so that bucket does not come back.

| registrations_per_wallet | wallets | registrations | largest_in_bucket |
|---|---|---|---|
| 1 | 2400 | 2400 | 1 |
| 2-9 | 184 | 442 | 8 |
| 10-49 | 4 | 81 | 45 |
| 50-99 | 2 | 128 | 75 |
| 100-999 | 2 | 1276 | 762 |

### Query 3: the 25 largest wallets that made 50 or more registrations

By rank and never by address: how many each made, how many of those have an https link, how many sit on the wallet's own largest host name, how many host names it uses and how many profile links. Only 4 wallets made 50 or more, so 4 rows come back.

| wallet_rank | registrations | with_https_host | on_its_largest_host | distinct_hosts | distinct_links |
|---|---|---|---|---|---|
| 1 | 762 | 762 | 762 | 1 | 762 |
| 2 | 514 | 514 | 514 | 1 | 514 |
| 3 | 75 | 0 | 0 | 0 | 75 |
| 4 | 53 | 53 | 51 | 3 | 29 |

### Query 3b: all the wallets that made 50 or more registrations

| wallets_with_50_or_more | registrations_on_them | largest_wallet |
|---|---|---|
| 4 | 1404 | 762 |

### Query 4: host names by size

The ten largest host names, by rank and never by name. A host past the flood cap is shown at the 2,000 rows it keeps.

| host_rank | registrations |
|---|---|
| 1 | 2000 |
| 2 | 762 |
| 3 | 528 |
| 4 | 483 |
| 5 | 51 |
| 6 | 39 |
| 7 | 36 |
| 8 | 34 |
| 9 | 14 |
| 10 | 11 |

### Query 4b: all the host names that hold 50 or more registrations

| hosts_with_50_or_more | registrations_on_them | largest_host |
|---|---|---|
| 5 | 3824 | 2000 |

### Query 5: profile links held by several registrations

Profile links and registrations in each size bucket (a link of its own is the bucket 1), the largest in the bucket, and how many of the registrations in a bucket have an https host. No link and no hash is returned. The empty link (no URI set) is left out of the buckets and counted in query 1. No link is used by 50 to 999 registrations, so that bucket does not come back.

| registrations_per_link | links | registrations | largest_in_bucket | registrations_with_https_host |
|---|---|---|---|---|
| 1 | 2117 | 2117 | 1 | 1915 |
| 2-9 | 27 | 80 | 8 | 59 |
| 10-49 | 3 | 64 | 29 | 64 |
| 1000+ | 1 | 1999 | 1999 | 1999 |

### Query 6: names

How many registrations still carry the placeholder the pass gives a registration with no name, how many names are distinct, and how many registrations share a name with others. Group sizes only; no name is returned.

| registrations | placeholder_names | distinct_real_names | registrations_sharing_a_name | registrations_in_names_shared_by_10_or_more | largest_name_group |
|---|---|---|---|---|---|
| 4327 | 4239 | 77 | 15 | 0 | 9 |

### Query 7: what the listing rules did

The registrations in each state the pass stores, and for the ones held out as shared, which rule reached them first, in the order the rules run. No registration is in state 3 (waiting) or 4 (a name that is only a number), so those rows do not come back.

| listing | state | first_rule | registrations |
|---|---|---|---|
| 0 | no usable link | - | 169 |
| 1 | listed | - | 144 |
| 2 | held out as shared | host shared by 50 or more | 1796 |
| 2 | held out as shared | profile link shared by 2 or more | 2135 |
| 2 | held out as shared | wallet that registered 10 or more | 83 |

### Query 8: transfers and edits, from the totals kept for each registration

| registrations | mint_measured | covered_by_the_walk | transfers_after_mint | handouts | registrations_that_changed_hands | registrations_handed_out | profile_link_edits | registrations_edited |
|---|---|---|---|---|---|---|---|---|
| 4327 | 4327 | 4327 | 87 | 75 | 86 | 75 | 121 | 64 |

### Query 9: the activity ledger

The events of the source by kind, the registrations they belong to, and the oldest and newest block.

| kind | events | registrations | oldest_block | newest_block |
|---|---|---|---|---|
| mint | 4327 | 4327 | 53006722 | 118390856 |
| secondary | 87 | 86 | 54167560 | 118390878 |
| uri_update | 121 | 64 | 53698090 | 117855509 |

### Query 10a: when the registrations were made, by UTC day

The days that have a registration among the 21 days that end on the day of the newest registration, counted back from the finalized block 118,545,151 (2026-11-01 18:47:03 UTC). A day with none is not shown.

| utc_day | registrations |
|---|---|
| 2026-10-12 | 10 |
| 2026-10-13 | 23 |
| 2026-10-14 | 2 |
| 2026-10-15 | 1 |
| 2026-10-19 | 3 |
| 2026-10-20 | 1 |
| 2026-10-23 | 1 |
| 2026-10-25 | 1 |
| 2026-10-28 | 1 |
| 2026-11-01 | 1 |

### Query 10b: when the registrations were made, by UTC month

Counted forward from the registry's first block, 52,952,790 (2026-02-03 11:36:02 UTC), through 29 stretches of blocks. The registry began on 2026-02-03, so 2026-02 is not a whole month of it, and 2026-11 holds only the day of the pass.

| utc_month | registrations |
|---|---|
| 2026-02 | 2265 |
| 2026-03 | 11 |
| 2026-04 | 6 |
| 2026-05 | 19 |
| 2026-06 | 542 |
| 2026-07 | 1250 |
| 2026-08 | 46 |
| 2026-09 | 42 |
| 2026-10 | 145 |
| 2026-11 | 1 |

## Checks the figures pass

`client/src/pages/monadRegistryReport.test.ts` holds each of these:

- Query 1's registrations equal query 0's, query 6's, query 8's and the mints in query 9, and query 0's entries equal query 7's listed row. Query 0b's counted registrations and query 0's registrations make the 10,421 the directory counts on the chain, which is also the public count.
- Query 2's wallets add up to query 1's 2,592 and its registrations to 4,327. Query 3b's wallets and registrations are the sums of query 2's two largest buckets that reach 50, and query 3 is those 4 wallets, in order, the first being the largest wallet.
- Query 4 is in order and its host names are parts of the registrations with an https link. Its largest holds the 2,000 rows a host may keep, and query 0b counts one host past the cap. Query 4b's host names hold the threshold or more, so they hold at least as many registrations as the ones in query 4 that reach it, and no more than the registrations with an https link.
- Query 5's links add up to query 1's different links (not counting the registrations that set none), and its registrations plus the ones that set none add up to 4,327.
- Query 7's states add up to 4,327. Query 8's transfers, hand-outs and edits agree with query 9's events and registrations. Query 10b's months add up to 4,327, and query 10a's days add up to no more than the last two months.

## Figures worked out from these

Each is computed from the rows above in `client/src/lib/monadRegistryReport.ts`, and the page states no other figure. A share is given to one decimal place and rounded to the nearest.

- 144 of the 4,327 registrations (3.3%) are listed, which is 1.4% of the 10,421 the directory counts on the chain. 169 (3.9%) have no usable profile link. 4,014 (92.8%) are held out as shared: 2,135 reached first by a shared profile link, 1,796 by a shared host name and 83 by a wallet that registered 10 or more. None carries a name that is only a number.
- 8 wallets made 1,485 of the 4,327 registrations (34.3%), and 4 wallets made 1,404 (32.4%). The largest single wallet made 762 (17.6%).
- 2,400 of the 2,592 wallets (92.6%) registered one each, and together they made 2,400 registrations (55.5%). The 2 wallets in the largest bucket, 100-999, made 1,276 registrations (29.5%).
- The 4 wallets that registered 50 or more made 1,404 registrations between them (32.4%). 2 of them have every registration on one host name, and 1 has no https host name for any registration. 3 gave every registration a profile link of its own. None used one link for every registration it made. The other 1 is in between.
- 4,037 of the 4,327 registrations (93.3%) have an https link, on 43 host names. The largest host name holds 2,000 of them (49.5%), which is 46.2% of all the registrations. The next holds 762 (18.9%) and the third holds 528. The two largest together hold 2,762 (68.4%). 5 host names hold 50 or more registrations, 3,824 between them (94.7% of those with an https link and 88.4% of all).
- The largest host name is at the 2,000 rows a host may keep. Query 0b counts 6,094 more registrations for it, so it holds 8,094 in all, 77.7% of the 10,421. The 6,094 are 58.5% of the 10,421.
- 2,117 of the 2,148 different profile links (98.6%) are used by one registration each. 31 are used by more than one, by 2,143 registrations (49.5%). One link is used by 1,999 registrations (46.2% of all of them), and all of them have an https host name. No other link is used by more than 29. 67 registrations set no profile link.
- 4,239 of the 4,327 registrations (98.0%) carry the placeholder name. The other 88 carry 77 distinct names, and 15 registrations (0.3%) share a name with at least one other. No name is shared by 10 or more, and the largest group is 9.
- 87 transfers after the mint are recorded, on 86 registrations (2.0%). 4,241 registrations (98.0%) have had none. 75 hand-outs are recorded, on 75 registrations (1.7%), and the other 12 transfers came later than the first hour or from another wallet.
- 121 profile-link edits are recorded, on 64 registrations (1.5%).
- 2,265 of the registrations (52.3%) were made in 2026-02, the registry's first month. In each of the 8 whole months after it a month had between 6 and 1,250 registrations, 2,061 in all (47.6%). 2026-11, the month of the pass, has 1. The 10 days from 2026-10-12 to 2026-11-01 that have a registration hold 44 registrations (1.0%), and the other 11 of the 21 days had none. The busiest, 2026-10-13, has 23 (0.5% of all the registrations) and the next, 2026-10-12, has 10. The other 8 days had between 1 and 3.

## Figures that are not from the queries

- 144, the public count of listed entries, and 10,421, the public count of registrations on the chain, read from `GET /api/v1/stats` on 2026-11-01 at 19:21 UTC. No registration is hidden, so the first is the same as query 0's 144 entries, and the second is query 1's 4,327 stored registrations plus query 0b's 6,094 counted.
- The two block times (52,952,790 at 2026-02-03 11:36:02 UTC and 118,545,151 at 2026-11-01 18:47:03 UTC), read from a public node's block headers on 2026-11-01. The first is also in the comment of `MONAD_CHAIN` in `server/ingestion/erc8004Chains.ts`. The start block, start time and seconds a block of each of the 29 stretches in query 10b were read the same way and are in [the queries](./monad-census-queries-2026-11-01.sql).

## What this measurement cannot say

- **It is not a count of people.** A platform can register many agents under one wallet, and one person can use many wallets. The wallet figures are the registering wallets the directory records.
- **The registering wallet is not the holder.** It is the address named in the registration event and is not changed when the registration is transferred. 75 registrations were handed out within about an hour of the mint, so for those the wallet figures say who registered and not who holds.
- **It says nothing about whether an agent runs.** Nothing was asked of any address.
- **A hand-out is a timing fact.** It is a transfer out of the wallet a registration was minted to, within about an hour of the mint. It does not say why the registration was sent on or who received it.
- **A shared link, host name, wallet or name is a recorded fact.** It does not say that one person is behind the registrations, or that anything is wrong. A registration the directory holds out is held out as shared, and is not called fake.
- **It counts the registrations the directory has stored.** That is 4,327 of the 10,421 the directory counts on the chain. The other 6,094 were counted past a host's cap and are in no figure but query 0b's, so the host name, wallet and link figures are for the stored rows. Query 9 has a mint for each stored registration, and the oldest is at block 53006722. This census does not compare the count with a total from the registry itself.
- **The stored registrations are not a sample of the chain.** A host name past the cap keeps its first registrations in chain order, so the figures for hosts, wallets, links, months and days describe the stored rows and not all 10,421. The registrations counted and not stored have no wallet, link, month or day in this census.
- **Ratings are not measured here.** The directory also reads the reputation registry for a count of ratings, which the Monad tab and the API show once it has read the registry's whole history, and this census does not use it.
- **Names and links are written by the registrants** and have not been verified.
- **It is one moment.** Monad is read by a scheduled pass once a day and the chain is still adding registrations, so the figures are as of the pass named in the header of the report. The report is dated and will be redone and dated again.
- **The dates are worked out.** A registration's day and month come from its mint block and block times read from the chain, within the margins above, and not from a clock the chain keeps for the registration.
- **The listing rules were not changed.** They are the numbers written for the BNB Chain registry. This census says what they did on Monad and does not say whether they are right for it.
