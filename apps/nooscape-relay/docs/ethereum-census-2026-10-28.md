# Ethereum registry census: the measurement (2026-10-28)

This is the measurement behind the report at `/field/ethereum-registry-2026-10-28`. It counts every registration the directory has stored for the ERC-8004 identity registry on Ethereum (chain id 1) on 2026-10-28, listed or held out. It is a set of aggregate counts: no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it.

## How it was done

The operator ran [the queries](./ethereum-census-queries-2026-10-28.sql) against the production database through hPanel on 2026-10-28, after the registry pass that finished at 05:00 UTC (query 0 shows that pass as the latest). Ethereum's source is read by a scheduled pass, once a day since [migration 0052](./ethereum-go-live-2026-10-27.md). Every statement is a read-only SELECT. The output below is as it came back.

The queries count every registration the chain pass has stored for the source (the table `agent_directory_registry_rows`), listed or held out, because the listing rules read exactly those rows: a profile link shared by 2 or more registrations, a host name shared by 50 or more, a wallet that registered 10 or more. Query 0 shows that one is hidden. A hidden registration is excluded from every public read, and the public count of listed entries on 2026-10-28 was 5,186 (`GET /api/v1/stats` at 17:24 UTC), one fewer than the 5,187 entries in query 0. The census counts the hidden registration, as it counts every stored row. The registrations are the ones the directory has read from the registry's event log, from the deploy block to the finalized head.

A host name that holds more than 2,000 rows keeps 2,000 of them (`FLOOD_HOST_ROW_CAP` in `server/ingestion/erc8004Chains.ts`, [the record](./flood-host-cap-2026-10-21.md)) and the rest are counted in `agent_directory_registry_overflow` and not stored. Query 0b reads that count: 2 host names are past the cap, 8,022 registrations were counted and not stored for them, and the directory counts 55,456 registrations on the chain, 47,434 stored and 8,022 counted. Every other figure here counts the 47,434 stored rows, so the 8,022 are in none of them: the two host names hold more than query 4 shows, 10,000 and 2,022 in all, and the wallets and profile links of those registrations are in no row.

What each column means:

- **wallet**: the `registrant` the directory records, which is the owner named in the registration event. It is set when the registration is first seen and is not changed when it is transferred, so it says who registered and not who holds it now.
- **host**: the host name of an https registration link (`locatorHost`). A registration whose link is not an https address has no host name.
- **profile link**: the registration link recorded on the chain, kept as a hash (`profileUriHash`). A registration that set no link at all has the hash of the empty text, which the queries count as one value and leave out of the link buckets.
- **placeholder name**: `Agent #<n>`, the name the pass gives a registration that has none. A registry row takes a name only from registration data written into the chain event itself. The directory also reads a name for some listed entries from the file their registration link names (the names step, which took Ethereum's turn on 2026-10-27). That name is written to the entry and not to the registry row, so these queries do not count it.
- **transfer after the mint**: a transfer of the registration's token after the mint (`secondary` in the activity ledger).
- **hand-out**: a transfer after the mint that is sent from the wallet the registration was minted to, within about an hour of the mint (299 blocks, `handoutBlockWindow` in `server/ingestion/erc8004Chains.ts`). It is a timing fact and says nothing about why.
- **profile-link edit**: an update of the registration's link after the mint (`uri_update`).
- **UTC day and month**: the date of the mint block, worked out from a block whose time is known. For a day it is 2026-10-28 17:20:23 UTC (block 26,292,686, the finalized block of the day) less 12.038 seconds for each block before it, the rate over the last 200,000 blocks. For a month it is 2026-01-29 10:20:23 UTC (block 24,339,871, the registry's first) plus 12.04722 seconds for each block after it, the average to the finalized block. An Ethereum block takes 12 seconds when no slot is missed and a little more when one is. Both times are block header timestamps read from a public node on 2026-10-28. A day is within about 5 minutes of the real time and a month within about 80, so a registration made that close to midnight, or to the end of a month, can land on the next one.
- **listing state**: what the pass stores for each registration (0 no usable link, 1 listed, 2 held out as shared, 3 waiting to be classified, 4 a name that is only a number). Query 7 reads it and works out which rule reached a held-out registration first, in the order the rules run.

## Results

### Query 0: as of when

The registrations stored, how many are hidden, when a pass first and last saw one, when the source last succeeded, and how many entries the directory holds for the registry. The first-seen time is when the pass read them, not when anything was registered.

| registrations | hidden_registrations | first_seen_min | last_seen_max | source_last_success | entries_in_the_directory |
|---|---|---|---|---|---|
| 47434 | 1 | 2026-10-27 12:01:09 | 2026-10-28 05:00:07 | 2026-10-28 05:00:08 | 5187 |

### Query 0b: the flood cap

How many hosts went past the 2,000 rows a host may keep, how many registrations were counted and not stored for them, and the largest host's. The registrations on the chain, as the directory counts them, are query 0's registrations plus the second figure here.

| hosts_past_the_cap | registrations_counted_not_stored | largest_host_overflow |
|---|---|---|
| 2 | 8022 | 8000 |

### Query 1: size and surface

| registrations | distinct_wallets | no_wallet | with_https_host | distinct_hosts | distinct_profile_links | no_uri_set | mint_measured |
|---|---|---|---|---|---|---|---|
| 47434 | 10877 | 0 | 13970 | 200 | 21553 | 19579 | 47434 |

### Query 2: how many registrations one wallet made

Wallets and registrations in each size bucket, and the largest in the bucket. The buckets break at 10 (the listing rule), 50 and 100.

| registrations_per_wallet | wallets | registrations | largest_in_bucket |
|---|---|---|---|
| 1 | 9163 | 9163 | 1 |
| 2-9 | 1405 | 5687 | 9 |
| 10-49 | 268 | 3549 | 46 |
| 50-99 | 14 | 851 | 81 |
| 100-999 | 23 | 8072 | 779 |
| 1000+ | 4 | 20112 | 9989 |

### Query 3: the 25 largest wallets that made 50 or more registrations

By rank and never by address: how many each made, how many of those have an https link, how many sit on the wallet's own largest host name, how many host names it uses and how many profile links.

| wallet_rank | registrations | with_https_host | on_its_largest_host | distinct_hosts | distinct_links |
|---|---|---|---|---|---|
| 1 | 9989 | 0 | 0 | 0 | 3 |
| 2 | 7252 | 6974 | 2000 | 15 | 7060 |
| 3 | 1615 | 1615 | 1615 | 1 | 1615 |
| 4 | 1256 | 1256 | 1256 | 1 | 1256 |
| 5 | 779 | 0 | 0 | 0 | 1 |
| 6 | 639 | 0 | 0 | 0 | 1 |
| 7 | 616 | 0 | 0 | 0 | 1 |
| 8 | 569 | 0 | 0 | 0 | 1 |
| 9 | 501 | 0 | 0 | 0 | 501 |
| 10 | 495 | 0 | 0 | 0 | 1 |
| 11 | 430 | 0 | 0 | 0 | 1 |
| 12 | 422 | 0 | 0 | 0 | 1 |
| 13 | 410 | 0 | 0 | 0 | 1 |
| 14 | 396 | 0 | 0 | 0 | 1 |
| 15 | 384 | 0 | 0 | 0 | 1 |
| 16 | 345 | 0 | 0 | 0 | 1 |
| 17 | 289 | 289 | 289 | 1 | 289 |
| 18 | 270 | 0 | 0 | 0 | 1 |
| 19 | 254 | 0 | 0 | 0 | 1 |
| 20 | 254 | 0 | 0 | 0 | 1 |
| 21 | 213 | 0 | 0 | 0 | 1 |
| 22 | 204 | 0 | 0 | 0 | 1 |
| 23 | 182 | 182 | 182 | 1 | 182 |
| 24 | 110 | 0 | 0 | 0 | 1 |
| 25 | 108 | 108 | 108 | 1 | 108 |

### Query 3b: all the wallets that made 50 or more registrations

| wallets_with_50_or_more | registrations_on_them | largest_wallet |
|---|---|---|
| 41 | 29035 | 9989 |

### Query 4: host names by size

The ten largest host names, by rank and never by name. A host past the flood cap is shown at the 2,000 rows it keeps.

| host_rank | registrations |
|---|---|
| 1 | 2000 |
| 2 | 2000 |
| 3 | 1983 |
| 4 | 1615 |
| 5 | 1547 |
| 6 | 1184 |
| 7 | 1118 |
| 8 | 974 |
| 9 | 226 |
| 10 | 182 |

### Query 4b: all the host names that hold 50 or more registrations

| hosts_with_50_or_more | registrations_on_them | largest_host |
|---|---|---|
| 17 | 13398 | 2000 |

### Query 5: profile links held by several registrations

Profile links and registrations in each size bucket (a link of its own is the bucket 1), the largest in the bucket, and how many of the registrations in a bucket have an https host. No link and no hash is returned. The empty link (no URI set) is left out of the buckets and counted in query 1.

| registrations_per_link | links | registrations | largest_in_bucket | registrations_with_https_host |
|---|---|---|---|---|
| 1 | 20731 | 20731 | 1 | 10569 |
| 2-9 | 810 | 1926 | 8 | 1398 |
| 10-49 | 6 | 77 | 17 | 20 |
| 50-999 | 3 | 1095 | 731 | 0 |
| 1000+ | 2 | 4026 | 2043 | 1983 |

### Query 6: names

How many registrations still carry the placeholder the pass gives a registration with no name, how many names are distinct, and how many registrations share a name with others. Group sizes only; no name is returned.

| registrations | placeholder_names | distinct_real_names | registrations_sharing_a_name | registrations_in_names_shared_by_10_or_more | largest_name_group |
|---|---|---|---|---|---|
| 47434 | 37537 | 6443 | 3881 | 2957 | 2046 |

### Query 7: what the listing rules did

The registrations in each state the pass stores, and for the ones held out as shared, which rule reached them first, in the order the rules run.

| listing | state | first_rule | registrations |
|---|---|---|---|
| 0 | no usable link | - | 22260 |
| 1 | listed | - | 5187 |
| 2 | held out as shared | host shared by 50 or more | 10073 |
| 2 | held out as shared | profile link shared by 2 or more | 6703 |
| 2 | held out as shared | wallet that registered 10 or more | 3146 |
| 4 | name is only a number | - | 65 |

### Query 8: transfers and edits, from the totals kept for each registration

| registrations | mint_measured | covered_by_the_walk | transfers_after_mint | handouts | registrations_that_changed_hands | registrations_handed_out | profile_link_edits | registrations_edited |
|---|---|---|---|---|---|---|---|---|
| 47434 | 47434 | 47434 | 18387 | 13728 | 14831 | 13727 | 1580 | 623 |

### Query 9: the activity ledger

The events of the source by kind, the registrations they belong to, and the oldest and newest block.

| kind | events | registrations | oldest_block | newest_block |
|---|---|---|---|---|
| mint | 47434 | 47434 | 24339925 | 26284921 |
| secondary | 18387 | 14831 | 24340998 | 26271450 |
| uri_update | 1580 | 623 | 24341020 | 26287829 |

### Query 10a: when the registrations were made, by UTC day

The last 21 days that have a registration, counted back from the finalized block 26,292,686 (2026-10-28 17:20:23 UTC).

| utc_day | registrations |
|---|---|
| 2026-10-07 | 87 |
| 2026-10-08 | 91 |
| 2026-10-09 | 68 |
| 2026-10-10 | 2 |
| 2026-10-11 | 90 |
| 2026-10-12 | 71 |
| 2026-10-13 | 1221 |
| 2026-10-14 | 204 |
| 2026-10-15 | 16 |
| 2026-10-16 | 65 |
| 2026-10-17 | 8 |
| 2026-10-18 | 46 |
| 2026-10-19 | 27 |
| 2026-10-20 | 30 |
| 2026-10-21 | 876 |
| 2026-10-22 | 44 |
| 2026-10-23 | 50 |
| 2026-10-24 | 43 |
| 2026-10-25 | 54 |
| 2026-10-26 | 15 |
| 2026-10-27 | 16 |

### Query 10b: when the registrations were made, by UTC month

Counted forward from the registry's first block, 24,339,871 (2026-01-29 10:20:23 UTC). 2026-01 holds the first three days of the registry.

| utc_month | registrations |
|---|---|
| 2026-01 | 22695 |
| 2026-02 | 5228 |
| 2026-03 | 3854 |
| 2026-04 | 270 |
| 2026-05 | 2036 |
| 2026-06 | 1841 |
| 2026-07 | 3025 |
| 2026-08 | 3708 |
| 2026-09 | 1326 |
| 2026-10 | 3451 |

## Checks the figures pass

`client/src/pages/ethereumRegistryReport.test.ts` holds each of these:

- Query 1's registrations equal query 0's, query 6's, query 8's and the mints in query 9, and query 0's entries equal query 7's listed row. Query 0b's counted registrations and query 0's registrations make the 55,456 the directory counts on the chain.
- Query 2's wallets add up to query 1's 10,877 and its registrations to 47,434. Query 3b's wallets and registrations are the sums of query 2's three largest buckets, and query 3 is those wallets' 25 largest, in order, the first being the largest wallet.
- Query 4 is in order and its host names are parts of the registrations with an https link. Its two largest each hold the 2,000 rows a host may keep, and query 0b counts two hosts past the cap. Query 4b's host names hold the threshold or more, so they hold at least as many registrations as the ten in query 4 that reach it, and no more than the registrations with an https link.
- Query 5's links add up to query 1's different links (not counting the registrations that set none), and its registrations plus the ones that set none add up to 47,434.
- Query 7's states add up to 47,434. Query 8's transfers, hand-outs and edits agree with query 9's events and registrations. Query 10b's months add up to 47,434, and query 10a's days all fall in the last month and add up to no more than it.

## Figures worked out from these

Each is computed from the rows above in `client/src/lib/ethereumRegistryReport.ts`, and the page states no other figure. A share is given to one decimal place and rounded to the nearest.

- 5,187 of the 47,434 registrations (10.9%) are listed, which is 9.4% of the 55,456 the directory counts on the chain. 22,260 (46.9%) have no usable profile link. 19,922 (42.0%) are held out as shared: 6,703 reached first by a shared profile link, 10,073 by a shared host name and 3,146 by a wallet that registered 10 or more. 65 carry a name that is only a number.
- 309 wallets made 32,584 of the 47,434 registrations (68.7%), and 41 wallets made 29,035 (61.2%). The largest single wallet made 9,989 (21.1%).
- 9,163 of the 10,877 wallets (84.2%) registered one each, and together they made 9,163 registrations (19.3%). The 4 wallets in the largest bucket made 20,112 registrations (42.4%).
- The 25 largest wallets made 27,982 registrations between them (59.0%). 5 of them have every registration on one host name, and 19 have no https host name for any registration. 6 gave every registration a profile link of its own. 17 used one link for every registration they made, 6,790 registrations between them. The other 2 are in between.
- 13,970 of the 47,434 registrations (29.5%) have an https link, on 200 host names. The largest host name holds 2,000 of them (14.3%), which is 4.2% of all the registrations. The next holds 2,000 (14.3%) and the third holds 1,983. The two largest together hold 4,000 (28.6%). 17 host names hold 50 or more registrations, 13,398 between them (95.9% of those with an https link and 28.2% of all).
- The two largest host names are at the 2,000 rows a host may keep. Query 0b counts 8,000 more registrations for the first and 22 more for the second, so they hold 10,000 and 2,022 in all. The 8,022 are 14.5% of the 55,456.
- 20,731 of the 21,552 different profile links (96.2%) are used by one registration each. 821 are used by more than one, by 7,124 registrations (15.0%). 5 links are used by 50 or more registrations, 5,121 in all (10.8%). 2 of them are used by 1,000 or more. The largest is used by 2,043 (4.3%), and 1,983 of them have an https host name. 19,579 registrations set no profile link.
- 37,537 of the 47,434 registrations (79.1%) carry the placeholder name. The other 9,897 carry 6,443 distinct names, and 3,881 registrations (8.2%) share a name with at least one other. 2,957 registrations are in names shared by 10 or more, and the largest group is 2,046.
- 18,387 transfers after the mint are recorded, on 14,831 registrations (31.3%). 32,603 registrations (68.7%) have had none. 13,728 hand-outs are recorded, on 13,727 registrations (28.9%), and the other 4,659 transfers came later than the first hour or from another wallet.
- 1,580 profile-link edits are recorded, on 623 registrations (1.3%).
- 22,695 of the registrations (47.8%) were made in 2026-01, in the first three days of the registry. In each of the 9 months after it a month had between 270 and 5,228 registrations, 24,739 in all (52.2%). The 21 days from 2026-10-07 to 2026-10-27 hold 3,124 registrations (6.6%). The busiest, 2026-10-13, has 1,221 (2.6% of all the registrations) and the next, 2026-10-21, has 876. The other 19 days had between 2 and 204. No registration is dated 2026-10-28, the day of the pass.

## Figures that are not from the queries

- 5,186, the public count of listed entries, read from `GET /api/v1/stats` on 2026-10-28 at 17:24 UTC. It is one fewer than query 0's 5,187 entries because one registration is hidden.
- The two block times (24,339,871 at 2026-01-29 10:20:23 UTC and 26,292,686 at 2026-10-28 17:20:23 UTC), read from a public node's block headers on 2026-10-28. The first is also in the comment of `ETHEREUM_CHAIN` in `server/ingestion/erc8004Chains.ts`.

## What this measurement cannot say

- **It is not a count of people.** A platform can register many agents under one wallet, and one person can use many wallets. The wallet figures are the registering wallets the directory records.
- **The registering wallet is not the holder.** It is the address named in the registration event and is not changed when the registration is transferred. 13,727 registrations were handed out within about an hour of the mint, so for those the wallet figures say who registered and not who holds.
- **It says nothing about whether an agent runs.** Nothing was asked of any address.
- **A hand-out is a timing fact.** It is a transfer out of the wallet a registration was minted to, within about an hour of the mint. It does not say why the registration was sent on or who received it.
- **A shared link, host name, wallet or name is a recorded fact.** It does not say that one person is behind the registrations, or that anything is wrong. A registration the directory holds out is held out as shared, and is not called fake.
- **It counts the registrations the directory has stored.** That is 47,434 of the 55,456 the directory counts on the chain. The other 8,022 were counted past a host's cap and are in no figure but query 0b's, so the host name, wallet and link figures are for the stored rows. Query 9 has a mint for each stored registration, and the oldest is at block 24339925. This census does not compare the count with a total from the registry itself.
- **Ratings are not measured here.** The directory keeps a count of the ratings in the reputation registry, shown on the Ethereum tab and in the API, and this census does not use it.
- **Names and links are written by the registrants** and have not been verified.
- **It is one moment.** Ethereum is read by a scheduled pass once a day and the chain is still adding registrations, so the figures are as of the pass named in the header of the report. The report is dated and will be redone and dated again.
- **The dates are worked out.** A registration's day and month come from its mint block and a block time, within the margins above, and not from a clock the chain keeps for the registration.
- **The listing rules were not changed.** They are the numbers written for the BNB Chain registry. This census says what they did on Ethereum and does not say whether they are right for it.
