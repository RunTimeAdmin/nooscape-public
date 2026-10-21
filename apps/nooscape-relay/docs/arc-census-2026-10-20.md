# Arc registry census: the measurement (2026-10-20)

This is the measurement behind the report at `/field/arc-registry-2026-10-20`. It counts every registration the directory has stored for the ERC-8004 identity registry on Arc (chain id 5042) on 2026-10-20, listed or held out. It is a set of aggregate counts: no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it.

## How it was done

The operator ran [the queries](./arc-census-queries-2026-10-20.sql) against the production database through hPanel on 2026-10-20, after the registry pass that finished at 16:45 UTC (query 0 shows that pass as the latest). Arc's source is read only when a pass is started by hand. Every statement is a read-only SELECT. The output below is as it came back.

The queries count every registration the chain pass has stored for the source (the table `agent_directory_registry_rows`), listed or held out, because the listing rules read exactly those rows: a profile link shared by 2 or more registrations, a host name shared by 50 or more, a wallet that registered 10 or more. Query 0 shows that none is hidden, so the rule that every public read keeps (a hidden registration is not counted) removes nothing here. The registrations are the ones the directory has read from the registry's event log, from the deploy block to the finalized head.

What each column means:

- **wallet**: the `registrant` the directory records, which is the owner named in the registration event. It is set when the registration is first seen and is not changed when it is transferred, so it says who registered and not who holds it now.
- **host**: the host name of an https registration link (`locatorHost`). A registration whose link is not an https address has no host name.
- **profile link**: the registration link recorded on the chain, kept as a hash (`profileUriHash`). A registration that set no link at all has the hash of the empty text, which the queries count as one value and leave out of the link buckets.
- **placeholder name**: `Agent #<n>`, the name the pass gives a registration that has none. For Arc a name comes only from registration data written into the chain event itself.
- **transfer after the mint**: a transfer of the registration's token after the mint (`secondary` in the activity ledger).
- **hand-out**: a transfer after the mint that is sent from the wallet the registration was minted to, within about an hour of the mint (7,080 blocks, `handoutBlockWindow` in `server/ingestion/erc8004Chains.ts`). It is a timing fact and says nothing about why.
- **profile-link edit**: an update of the registration's link after the mint (`uri_update`).
- **chain-day**: 169,920 blocks counted from the first mint block measured, about a day at Arc's block time. The dates are not stored.
- **listing state**: what the pass stores for each registration (0 no usable link, 1 listed, 2 held out as shared, 3 waiting to be classified, 4 a name that is only a number). Query 7 reads it and works out which rule reached a held-out registration first, in the order the rules run.

## Results

### Query 0: as of when

The registrations stored, how many are hidden, when a pass first and last saw one, when the source last succeeded, and how many registrations the directory lists (the entries of the source). The first-seen time is when the pass read them, not when anything was registered.

| registrations | hidden_registrations | first_seen_min | last_seen_max | source_last_success | entries_in_the_directory |
|---|---|---|---|---|---|
| 2587 | 0 | 2026-10-20 16:42:50 | 2026-10-20 16:43:56 | 2026-10-20 16:45:40 | 246 |

### Query 1: size and surface

| registrations | distinct_wallets | no_wallet | with_https_host | distinct_hosts | distinct_profile_links | no_uri_set | mint_measured |
|---|---|---|---|---|---|---|---|
| 2587 | 257 | 0 | 1139 | 44 | 2305 | 18 | 2587 |

### Query 2: how many registrations one wallet made

Wallets and registrations in each size bucket, and the largest in the bucket. The buckets break at 10 (the listing rule), 50 (the minimum of a group on the Arc page) and 100.

| registrations_per_wallet | wallets | registrations | largest_in_bucket |
|---|---|---|---|
| 1 | 225 | 225 | 1 |
| 2-9 | 24 | 72 | 6 |
| 10-49 | 1 | 22 | 22 |
| 50-99 | 4 | 300 | 98 |
| 100-999 | 2 | 968 | 868 |
| 1000+ | 1 | 1000 | 1000 |

### Query 3: the wallets that made 50 or more registrations

By size and never by address. The wallet rank is only the order of the registrations column. Each row is one wallet: its registrations, how many of them have an https link, how many are on the host name the wallet uses most, how many host names it uses and how many different profile links.

| wallet_rank | registrations | with_https_host | on_its_largest_host | distinct_hosts | distinct_links |
|---|---|---|---|---|---|
| 1 | 1000 | 0 | 0 | 0 | 1000 |
| 2 | 868 | 868 | 868 | 1 | 868 |
| 3 | 100 | 100 | 100 | 1 | 100 |
| 4 | 98 | 0 | 0 | 0 | 1 |
| 5 | 91 | 0 | 0 | 0 | 1 |
| 6 | 56 | 56 | 56 | 1 | 56 |
| 7 | 55 | 0 | 0 | 0 | 1 |

### Query 4: host names by size

The five largest host names (rank and registrations only; no host is named), and, at rank 0, how many host names hold 50 or more registrations.

| host_rank | registrations |
|---|---|
| 0 | 3 |
| 1 | 868 |
| 2 | 115 |
| 3 | 56 |
| 4 | 23 |
| 5 | 14 |

### Query 5: profile links held by several registrations

Profile links and registrations in each size bucket (a link of its own is the bucket 1), the largest in the bucket, and how many of the registrations in a bucket have an https host. No link and no hash is returned. The registrations that set no link are left out of the buckets and counted in query 1.

| registrations_per_link | links | registrations | largest_in_bucket | registrations_with_https_host |
|---|---|---|---|---|
| 1 | 2296 | 2296 | 1 | 1115 |
| 2-9 | 6 | 12 | 2 | 8 |
| 10-49 | 1 | 16 | 16 | 16 |
| 50+ | 1 | 245 | 245 | 0 |

### Query 6: names

Registrations with the placeholder name, distinct real names, and how many registrations share a real name (group sizes only; no name is returned). Arc fetches no registration link, so this figure changes only as new registrations are made.

| registrations | placeholder_names | distinct_real_names | registrations_sharing_a_name | registrations_in_names_shared_by_10_or_more | largest_name_group |
|---|---|---|---|---|---|
| 2587 | 1536 | 1049 | 4 | 0 | 2 |

### Query 7: what the listing rules did

The registrations in each state the pass stores, and for the ones held out as shared, which rule reached them first, in the order the rules run (a shared profile link, then a host shared by 50 or more, then a wallet that registered 10 or more). A rule that reaches a registration first is not the only one that would have.

| listing | state | first_rule | registrations |
|---|---|---|---|
| 0 | no usable link | - | 23 |
| 1 | listed | - | 246 |
| 2 | held out as shared | host shared by 50 or more | 1023 |
| 2 | held out as shared | profile link shared by 2 or more | 273 |
| 2 | held out as shared | wallet that registered 10 or more | 1022 |

### Query 8: transfers and edits, from the totals kept for each registration

A registration the activity walk has not covered yet has no totals and is left out of a sum. `covered_by_the_walk` shows the walk has covered every registration.

| registrations | mint_measured | covered_by_the_walk | transfers_after_mint | handouts | registrations_that_changed_hands | registrations_handed_out | profile_link_edits | registrations_edited |
|---|---|---|---|---|---|---|---|---|
| 2587 | 2587 | 2587 | 897 | 897 | 897 | 897 | 148 | 141 |

### Query 9: the activity ledger

The events of the identity registry by kind, the registrations they belong to, and the oldest and newest block. A block number is a position in the chain's history and not a date.

| kind | events | registrations | oldest_block | newest_block |
|---|---|---|---|---|
| mint | 2587 | 2587 | 21156191 | 26966416 |
| secondary | 897 | 897 | 22313910 | 26717515 |
| uri_update | 148 | 141 | 21214757 | 26786119 |

### Query 10: when the registrations were made

The registrations in each chain-day since the first mint block measured. The day number is counted from the first registration, and the date is not stored.

| day_since_first_registration | registrations |
|---|---|
| 0 | 131 |
| 1 | 11 |
| 2 | 10 |
| 3 | 7 |
| 4 | 8 |
| 5 | 5 |
| 6 | 14 |
| 7 | 13 |
| 8 | 23 |
| 9 | 69 |
| 10 | 11 |
| 11 | 22 |
| 12 | 12 |
| 13 | 14 |
| 14 | 1014 |
| 15 | 12 |
| 16 | 12 |
| 17 | 10 |
| 18 | 18 |
| 19 | 878 |
| 20 | 10 |
| 21 | 6 |
| 22 | 6 |
| 23 | 10 |
| 24 | 34 |
| 25 | 14 |
| 26 | 15 |
| 27 | 36 |
| 28 | 45 |
| 29 | 8 |
| 30 | 35 |
| 31 | 17 |
| 32 | 13 |
| 33 | 41 |
| 34 | 3 |

## Checks the figures pass

`client/src/pages/arcRegistryReport.test.ts` holds each of these:

- Query 1's registrations equal query 0's, query 6's, query 8's and the mints in query 9, and query 0's listed count equals query 7's listed row.
- Query 2's wallets add up to query 1's 257 and its registrations to 2,587. Query 3's wallets are the wallets in query 2's three largest buckets, with the same registrations.
- Query 5's links add up to query 1's different links (not counting the registrations that set none), and its registrations plus the ones that set none add up to 2,587. The registrations in the links used more than once equal the registrations query 7 says the link rule reached first.
- Query 7's states add up to 2,587. Query 8's transfers, hand-outs and edits agree with query 9's events and registrations. Query 10's chain-days add up to 2,587.
- One wallet's 868 registrations are the whole of the largest host name: they all have an https link on one host name, so that host name holds at least that many, query 4's largest host name holds exactly that many and the next holds fewer.
- Only one profile link is shared by 50 or more registrations (query 5) and each of three wallets has 50 or more registrations on a single link (query 3), so those wallets' registrations are all on that one link.

## Figures worked out from these

Each is computed from the rows above in `client/src/lib/arcRegistryReport.ts`, and the page states no other figure. A share is given to one decimal place and rounded to the nearest.

- 246 of the 2,587 registrations (9.5%) are listed. 23 (0.9%) have no usable profile link. 2,318 (89.6%) are held out as shared: 273 reached first by a shared profile link, 1,023 by a shared host name and 1,022 by a wallet that registered 10 or more.
- 8 wallets made 2,290 of the 2,587 registrations (88.5%), and 7 wallets made 2,268 (87.7%). The largest single wallet made 1,000 (38.7%).
- 225 of the 257 wallets (87.5%) registered one each, and together they made 225 registrations (8.7%).
- 3 of the 7 wallets that made 50 or more have every registration on one host name, and 4 have no https host name for any registration. 4 gave every registration a profile link of its own. The other 3 used one link for every registration they made, 244 registrations between them.
- One wallet's 868 registrations are all on one host name. The largest host name holds 868 registrations and the next holds 115, so that wallet's registrations are the whole of the largest host name.
- 1,139 of the 2,587 registrations (44.0%) have an https link, on 44 host names. The largest host name holds 868 of them (76.2%), the next holds 115 and the third holds 56. The two largest together hold 983 (86.3%). 3 host names hold 50 or more registrations.
- 2,296 of the 2,304 different profile links (99.7%) are used by one registration each. 8 are used by more than one, by 273 registrations. One link is used by 245 registrations (9.5%), and none of them has an https host name. 18 registrations set no profile link.
- 1,536 of the 2,587 registrations (59.4%) carry the placeholder name. The other 1,051 carry 1,049 distinct names, and 4 registrations (0.2%) share a name with at least one other. No name is shared by 10 or more registrations, and the largest group is 2.
- 897 transfers after the mint are recorded, on 897 registrations (34.7%). 1,690 registrations (65.3%) have had none. 897 registrations (34.7%) were handed out, each once, and every transfer after a mint was a hand-out.
- 148 profile-link edits are recorded, on 141 registrations (5.5%).
- The registrations were made over 35 chain-days. 1,892 of them (73.1%) were made on two days, one with 1,014 and one with 878. No other chain-day has more than 131. 1 chain-day had 1,000 or more, 2 had 100 to 999, 25 had 10 to 99 and 7 had 1 to 9.

## What this measurement cannot say

- **It is not a count of people.** A platform can register many agents under one wallet, and one person can use many wallets. The wallet figures are the registering wallets the directory records.
- **The registering wallet is not the holder.** It is the address named in the registration event and is not changed when the registration is transferred. 897 registrations were handed out within about an hour of the mint, so for those the wallet figures say who registered and not who holds.
- **It says nothing about whether an agent runs.** Nothing was asked of any address.
- **A hand-out is a timing fact.** It is a transfer out of the wallet a registration was minted to, within about an hour of the mint. It does not say why the registration was sent on or who received it.
- **A shared link, host name, wallet or name is a recorded fact.** It does not say that one person is behind the registrations, or that anything is wrong. A registration the directory holds out is held out as shared, and is not called fake.
- **It counts the registrations the directory holds.** Query 9 has a mint for each of them, and the oldest is at block 21156191. This census does not compare that count with a total from the registry itself.
- **There are no ratings.** Nooscape reads no reputation registry for Arc, so nothing here measures ratings.
- **Names and links are written by the registrants** and have not been verified.
- **It is one moment.** Arc is read only when a pass is started by hand, so the figures move only when one is. The report is dated and will be redone and dated again.
- **The listing rules were not changed.** They are the numbers written for the BNB Chain registry. This census says what they did on Arc and does not say whether they are right for it.
