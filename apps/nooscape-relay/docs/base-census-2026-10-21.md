# Base registry census: the measurement (2026-10-21)

This is the measurement behind the report at `/field/base-registry-2026-10-21`. It counts every registration the directory has stored for the ERC-8004 identity registry on Base (chain id 8453) on 2026-10-21, listed or held out. It is a set of aggregate counts: no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it.

## How it was done

The operator ran [the queries](./base-census-queries-2026-10-21.sql) against the production database through hPanel on 2026-10-21, after the registry pass that finished at 01:12 UTC (query 0 shows that pass as the latest). That pass was the first to read the registry up to the finalized head of the chain, so it was the first to publish the listing. Base's source is read by a scheduled pass. Every statement is a read-only SELECT. The output below is as it came back.

The queries count every registration the chain pass has stored for the source (the table `agent_directory_registry_rows`), listed or held out, because the listing rules read exactly those rows: a profile link shared by 2 or more registrations, a host name shared by 50 or more, a wallet that registered 10 or more. Query 0 shows that none is hidden, so the rule that every public read keeps (a hidden registration is not counted) removes nothing here. The registrations are the ones the directory has read from the registry's event log, from the deploy block to the finalized head.

What each column means:

- **wallet**: the `registrant` the directory records, which is the owner named in the registration event. It is set when the registration is first seen and is not changed when it is transferred, so it says who registered and not who holds it now.
- **host**: the host name of an https registration link (`locatorHost`). A registration whose link is not an https address has no host name.
- **profile link**: the registration link recorded on the chain, kept as a hash (`profileUriHash`). A registration that set no link at all has the hash of the empty text, which the queries count as one value and leave out of the link buckets.
- **placeholder name**: `Agent #<n>`, the name the pass gives a registration that has none. For Base a name comes only from registration data written into the chain event itself.
- **transfer after the mint**: a transfer of the registration's token after the mint (`secondary` in the activity ledger).
- **hand-out**: a transfer after the mint that is sent from the wallet the registration was minted to, within about an hour of the mint (1,800 blocks, `handoutBlockWindow` in `server/ingestion/erc8004Chains.ts`). It is a timing fact and says nothing about why.
- **profile-link edit**: an update of the registration's link after the mint (`uri_update`).
- **UTC day and month**: the date of the mint block, worked out as 2026-02-03 11:08:33 UTC (block 41,663,783, the registry's first) plus 2 seconds for each block after it. A Base block takes 2 seconds.
- **listing state**: what the pass stores for each registration (0 no usable link, 1 listed, 2 held out as shared, 3 waiting to be classified, 4 a name that is only a number). Query 7 reads it and works out which rule reached a held-out registration first, in the order the rules run.

## Results

### Query 0: as of when

The registrations stored, how many are hidden, when a pass first and last saw one, when the source last succeeded, and how many registrations the directory lists (the entries of the source). The first-seen time is when the pass read them, not when anything was registered.

| registrations | hidden_registrations | first_seen_min | last_seen_max | source_last_success | entries_in_the_directory |
|---|---|---|---|---|---|
| 389902 | 0 | 2026-10-20 22:02:41 | 2026-10-21 01:12:34 | 2026-10-21 01:12:50 | 9022 |

### Query 1: size and surface

| registrations | distinct_wallets | no_wallet | with_https_host | distinct_hosts | distinct_profile_links | no_uri_set | mint_measured |
|---|---|---|---|---|---|---|---|
| 389902 | 320751 | 0 | 344922 | 697 | 360379 | 23303 | 389902 |

### Query 2: how many registrations one wallet made

Wallets and registrations in each size bucket, and the largest in the bucket. The buckets break at 10 (the listing rule), 50 and 100.

| registrations_per_wallet | wallets | registrations | largest_in_bucket |
|---|---|---|---|
| 1 | 307107 | 307107 | 1 |
| 2-9 | 13261 | 31285 | 9 |
| 10-49 | 306 | 5395 | 47 |
| 50-99 | 32 | 2129 | 99 |
| 100-999 | 35 | 9162 | 780 |
| 1000+ | 10 | 34824 | 10272 |

### Query 3: the 25 largest wallets that made 50 or more registrations

By size and never by address. The wallet rank is only the order of the registrations column. Each row is one wallet: its registrations, how many of them have an https link, how many are on the host name the wallet uses most, how many host names it uses and how many different profile links.

| wallet_rank | registrations | with_https_host | on_its_largest_host | distinct_hosts | distinct_links |
|---|---|---|---|---|---|
| 1 | 10272 | 10271 | 9716 | 2 | 10272 |
| 2 | 8592 | 8481 | 7775 | 12 | 8555 |
| 3 | 3408 | 0 | 0 | 0 | 1 |
| 4 | 2293 | 0 | 0 | 0 | 2293 |
| 5 | 2125 | 2095 | 2095 | 1 | 2125 |
| 6 | 1944 | 1944 | 1931 | 3 | 1943 |
| 7 | 1931 | 0 | 0 | 0 | 1 |
| 8 | 1683 | 0 | 0 | 0 | 1 |
| 9 | 1331 | 4 | 2 | 3 | 1301 |
| 10 | 1245 | 0 | 0 | 0 | 1245 |
| 11 | 780 | 0 | 0 | 0 | 2 |
| 12 | 774 | 774 | 774 | 1 | 774 |
| 13 | 697 | 0 | 0 | 0 | 1 |
| 14 | 625 | 0 | 0 | 0 | 1 |
| 15 | 558 | 512 | 437 | 29 | 319 |
| 16 | 502 | 0 | 0 | 0 | 265 |
| 17 | 500 | 500 | 500 | 1 | 1 |
| 18 | 320 | 0 | 0 | 0 | 320 |
| 19 | 313 | 0 | 0 | 0 | 250 |
| 20 | 284 | 0 | 0 | 0 | 1 |
| 21 | 270 | 0 | 0 | 0 | 1 |
| 22 | 255 | 235 | 235 | 1 | 3 |
| 23 | 243 | 243 | 243 | 1 | 243 |
| 24 | 237 | 0 | 0 | 0 | 233 |
| 25 | 233 | 158 | 154 | 2 | 227 |

### Query 3b: all the wallets that made 50 or more registrations

In one row: how many wallets, how many registrations they made between them, and the largest wallet's.

| wallets_with_50_or_more | registrations_on_them | largest_wallet |
|---|---|---|
| 77 | 46115 | 10272 |

### Query 4: host names by size

The ten largest host names (rank and registrations only; no host is named).

| host_rank | registrations |
|---|---|
| 1 | 286832 |
| 2 | 27726 |
| 3 | 9721 |
| 4 | 7827 |
| 5 | 2584 |
| 6 | 2095 |
| 7 | 1252 |
| 8 | 774 |
| 9 | 644 |
| 10 | 506 |

### Query 4b: all the host names that hold 50 or more registrations

In one row: how many host names, how many registrations they hold between them, and the largest host name's.

| hosts_with_50_or_more | registrations_on_them | largest_host |
|---|---|---|
| 31 | 343229 | 286832 |

### Query 5: profile links held by several registrations

Profile links and registrations in each size bucket (a link of its own is the bucket 1), the largest in the bucket, and how many of the registrations in a bucket have an https host. No link and no hash is returned. The registrations that set no link are left out of the buckets and counted in query 1.

| registrations_per_link | links | registrations | largest_in_bucket | registrations_with_https_host |
|---|---|---|---|---|
| 1 | 358951 | 358951 | 1 | 341040 |
| 2-9 | 1359 | 3595 | 9 | 1180 |
| 10-49 | 56 | 1099 | 46 | 443 |
| 50-999 | 11 | 1703 | 500 | 1008 |
| 1000+ | 1 | 1251 | 1251 | 1251 |

### Query 6: names

Registrations with the placeholder name, distinct real names, and how many registrations share a real name (group sizes only; no name is returned). Base fetches no registration link, so this figure changes only as new registrations are made.

| registrations | placeholder_names | distinct_real_names | registrations_sharing_a_name | registrations_in_names_shared_by_10_or_more | largest_name_group |
|---|---|---|---|---|---|
| 389902 | 379466 | 7042 | 4517 | 1366 | 100 |

### Query 7: what the listing rules did

The registrations in each state the pass stores, and for the ones held out as shared, which rule reached them first, in the order the rules run (a shared profile link, then a host shared by 50 or more, then a wallet that registered 10 or more). A rule that reaches a registration first is not the only one that would have.

| listing | state | first_rule | registrations |
|---|---|---|---|
| 0 | no usable link | - | 25308 |
| 1 | listed | - | 9022 |
| 2 | held out as shared | host shared by 50 or more | 339767 |
| 2 | held out as shared | profile link shared by 2 or more | 7139 |
| 2 | held out as shared | wallet that registered 10 or more | 8639 |
| 4 | name is only a number | - | 27 |

### Query 8: transfers and edits, from the totals kept for each registration

A registration the activity walk has not covered yet has no totals and is left out of a sum. `covered_by_the_walk` shows the walk has covered every registration.

| registrations | mint_measured | covered_by_the_walk | transfers_after_mint | handouts | registrations_that_changed_hands | registrations_handed_out | profile_link_edits | registrations_edited |
|---|---|---|---|---|---|---|---|---|
| 389902 | 389902 | 389902 | 303475 | 291526 | 303349 | 291525 | 20016 | 11435 |

### Query 9: the activity ledger

The events of the identity registry by kind, the registrations they belong to, and the oldest and newest block. A block number is a position in the chain's history and not a date.

| kind | events | registrations | oldest_block | newest_block |
|---|---|---|---|---|
| mint | 389902 | 389902 | 41673162 | 52877361 |
| secondary | 303475 | 303349 | 41673308 | 52877361 |
| uri_update | 20016 | 11435 | 41679043 | 52873188 |

### Query 10a: when the registrations were made, by UTC day

The registrations in each of the last 21 UTC days that has one, dated from the mint block as described above. The last day is part of a day: the pass finished at 01:12 UTC.

| utc_day | registrations |
|---|---|
| 2026-10-01 | 58 |
| 2026-10-02 | 340 |
| 2026-10-03 | 334 |
| 2026-10-04 | 243 |
| 2026-10-05 | 210 |
| 2026-10-06 | 316 |
| 2026-10-07 | 338 |
| 2026-10-08 | 300 |
| 2026-10-09 | 278 |
| 2026-10-10 | 241 |
| 2026-10-11 | 971 |
| 2026-10-12 | 7282 |
| 2026-10-13 | 7897 |
| 2026-10-14 | 12081 |
| 2026-10-15 | 23106 |
| 2026-10-16 | 15541 |
| 2026-10-17 | 34779 |
| 2026-10-18 | 42914 |
| 2026-10-19 | 37900 |
| 2026-10-20 | 103386 |
| 2026-10-21 | 4750 |

### Query 10b: when the registrations were made, by UTC month

| utc_month | registrations |
|---|---|
| 2026-02 | 21641 |
| 2026-03 | 16683 |
| 2026-04 | 7903 |
| 2026-05 | 7818 |
| 2026-06 | 3774 |
| 2026-07 | 2497 |
| 2026-08 | 20308 |
| 2026-09 | 16013 |
| 2026-10 | 293265 |

## Checks the figures pass

`client/src/pages/baseRegistryReport.test.ts` holds each of these:

- Query 1's registrations equal query 0's, query 6's, query 8's and the mints in query 9, and query 0's listed count equals query 7's listed row.
- Query 2's wallets add up to query 1's 320,751 and its registrations to 389,902. Query 3b's wallets and registrations are the sums of query 2's three largest buckets, and query 3 is those wallets' 25 largest, in order, the first being the largest wallet.
- Query 4 is in order and its host names are parts of the registrations with an https link. Query 4b's host names hold the threshold or more, so they hold at least as many registrations as the ten in query 4 that reach it, and no more than the registrations with an https link.
- Query 5's links add up to query 1's different links (not counting the registrations that set none), and its registrations plus the ones that set none add up to 389,902.
- Query 7's states add up to 389,902. Query 8's transfers, hand-outs and edits agree with query 9's events and registrations. Query 10b's months add up to 389,902, and query 10a's days add up to the month they are in.
- The days before 2026-10-11 each have fewer registrations than any day from it on.

## Figures worked out from these

Each is computed from the rows above in `client/src/lib/baseRegistryReport.ts`, and the page states no other figure. A share is given to one decimal place and rounded to the nearest.

- 9,022 of the 389,902 registrations (2.3%) are listed. 25,308 (6.5%) have no usable profile link. 355,545 (91.2%) are held out as shared: 7,139 reached first by a shared profile link, 339,767 by a shared host name and 8,639 by a wallet that registered 10 or more. 27 carry a name that is only a number.
- 383 wallets made 51,510 of the 389,902 registrations (13.2%), and 77 wallets made 46,115 (11.8%). The largest single wallet made 10,272 (2.6%).
- 307,107 of the 320,751 wallets (95.7%) registered one each, and together they made 307,107 registrations (78.8%). The 10 wallets in the largest bucket made 34,824 registrations (8.9%).
- The 25 largest wallets made 41,415 registrations between them (10.6%). 3 of them have every registration on one host name, and 14 have no https host name for any registration. 7 gave every registration a profile link of its own. 8 used one link for every registration they made, 9,398 registrations between them. The other 10 are in between.
- 344,922 of the 389,902 registrations (88.5%) have an https link, on 697 host names. The largest host name holds 286,832 of them (83.2%), which is 73.6% of all the registrations. The next holds 27,726 (8.0%) and the third holds 9,721. The two largest together hold 314,558 (91.2%). 31 host names hold 50 or more registrations, 343,229 between them (99.5% of those with an https link and 88.0% of all).
- 358,951 of the 360,378 different profile links (99.6%) are used by one registration each. 1,427 are used by more than one, by 7,648 registrations (2.0%). 12 links are used by 50 or more registrations, 2,954 in all (0.8%). The largest is used by 1,251 (0.3%), all with an https host name. 23,303 registrations set no profile link.
- 379,466 of the 389,902 registrations (97.3%) carry the placeholder name. The other 10,436 carry 7,042 distinct names, and 4,517 registrations (1.2%) share a name with at least one other. 1,366 registrations are in names shared by 10 or more, and the largest group is 100.
- 303,475 transfers after the mint are recorded, on 303,349 registrations (77.8%). 86,553 registrations (22.2%) have had none. 291,526 hand-outs are recorded, on 291,525 registrations (74.8%), and the other 11,949 transfers came later than the first hour or from another wallet.
- 20,016 profile-link edits are recorded, on 11,435 registrations (2.9%).
- 293,265 of the registrations (75.2%) were made in 2026-10, more than in the 8 months before it together. In the 10 days before 2026-10-11 a UTC day had between 58 and 340 registrations, 2,658 in all. From 2026-10-11 every day has had more than any day before it: 971 on 2026-10-11, rising to 103,386 on 2026-10-20, which is 26.5% of all the registrations in one UTC day. The 11 days from 2026-10-11 to 2026-10-21 hold 290,607 registrations (74.5%), and 2026-10-21 is part of a day with 4,750.

## What this measurement cannot say

- **It is not a count of people.** A platform can register many agents under one wallet, and one person can use many wallets. The wallet figures are the registering wallets the directory records.
- **The registering wallet is not the holder.** It is the address named in the registration event and is not changed when the registration is transferred. 291,525 registrations were handed out within about an hour of the mint, so for those the wallet figures say who registered and not who holds.
- **It says nothing about whether an agent runs.** Nothing was asked of any address.
- **A hand-out is a timing fact.** It is a transfer out of the wallet a registration was minted to, within about an hour of the mint. It does not say why the registration was sent on or who received it.
- **A shared link, host name, wallet or name is a recorded fact.** It does not say that one person is behind the registrations, or that anything is wrong. A registration the directory holds out is held out as shared, and is not called fake.
- **It counts the registrations the directory holds.** Query 9 has a mint for each of them, and the oldest is at block 41673162. This census does not compare that count with a total from the registry itself.
- **There are no ratings.** Nooscape reads no reputation registry for Base, so nothing here measures ratings.
- **Names and links are written by the registrants** and have not been verified.
- **It is one moment.** Base is read by a scheduled pass and the chain is still adding registrations, so the figures are as of the pass named in the header of the report. The report is dated and will be redone and dated again.
- **The listing rules were not changed.** They are the numbers written for the BNB Chain registry. This census says what they did on Base and does not say whether they are right for it.
