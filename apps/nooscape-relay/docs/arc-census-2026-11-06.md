# Arc registry census: the measurement (2026-11-06)

This is the measurement behind the report at `/field/arc-registry-2026-11-06`, the second census of Arc. It counts the registrations the directory has stored for the ERC-8004 identity registry on Arc (chain id 5042) on 2026-11-06, listed or held out, and the registrations it counted and did not store. It is a set of aggregate counts: no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it. [The first census](./arc-census-2026-10-20.md), of 2026-10-20, is kept as it was.

## How it was done

The operator ran [the queries](./arc-census-queries-2026-11-06.sql) against the production database through hPanel on 2026-11-06, in two sittings after the registry pass that finished at 09:06 UTC: queries 0 to 10, then queries 11 and 12. Query 0 and query 11 both show that pass as the latest, so the figures are one moment. Arc's source is read by a scheduled pass. Every statement is a read-only SELECT. The output below is as it came back.

The queries 0 to 10 count every registration the chain pass has stored for the source (the table `agent_directory_registry_rows`), listed or held out, because the listing rules read exactly those rows: a profile link shared by 2 or more registrations, a host name shared by 50 or more, a wallet that registered 10 or more. Query 0 shows that none is hidden, so the public count of listed entries on 2026-11-06 (480, `GET /api/v1/stats` at 10:01 UTC) is the same as the 480 entries in query 0.

A host name that holds more than 2,000 rows keeps its first 2,000 in chain order (`FLOOD_HOST_ROW_CAP` in `server/ingestion/erc8004Chains.ts`, [the record](./flood-host-cap-2026-10-21.md)) and the rest are counted in `agent_directory_registry_overflow` and not stored. Query 11 reads that count: 1 host name is past the cap and 380,736 registrations were counted and not stored for it, so the directory counts 385,752 registrations on the chain, 5,016 stored and 380,736 counted. That is also the public count of registrations on the chain (`GET /api/v1/stats`, 385,752). Every other figure here counts the 5,016 stored rows, so the 380,736 are in none of them: the host name holds more than query 4 shows, 382,736 in all, and the wallets, profile links, names and dates of those registrations are in no row.

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
- **counted, not stored**: a registration of a host that already held its 2,000 rows. The pass counts it under the host and writes no row for it, so it has no wallet, link, name or day in the directory.

## Results

### Query 0: as of when

The registrations stored, how many are hidden, when a pass first and last saw one, when the source last succeeded, and how many registrations the directory lists (the entries of the source). The first-seen time is when the pass read them, not when anything was registered.

| registrations | hidden_registrations | first_seen_min | last_seen_max | source_last_success | entries_in_the_directory |
|---|---|---|---|---|---|
| 5016 | 0 | 2026-10-20 16:42:50 | 2026-11-06 08:45:06 | 2026-11-06 09:06:33 | 480 |

### Query 1: size and surface

| registrations | distinct_wallets | no_wallet | with_https_host | distinct_hosts | distinct_profile_links | no_uri_set | mint_measured |
|---|---|---|---|---|---|---|---|
| 5016 | 2508 | 0 | 3182 | 54 | 4562 | 43 | 5016 |

### Query 2: how many registrations one wallet made

Wallets and registrations in each size bucket, and the largest in the bucket. The buckets break at 10 (the listing rule), 50 (the minimum of a group on the Arc page) and 100.

| registrations_per_wallet | wallets | registrations | largest_in_bucket |
|---|---|---|---|
| 1 | 2464 | 2464 | 1 |
| 2-9 | 35 | 107 | 9 |
| 10-49 | 2 | 39 | 22 |
| 50-99 | 1 | 56 | 56 |
| 100-999 | 5 | 1350 | 868 |
| 1000+ | 1 | 1000 | 1000 |

### Query 3: the wallets that made 50 or more registrations

By size and never by address. The wallet rank is only the order of the registrations column. Each row is one wallet: its registrations, how many of them have an https link, how many are on the host name the wallet uses most, how many host names it uses and how many different profile links.

| wallet_rank | registrations | with_https_host | on_its_largest_host | distinct_hosts | distinct_links |
|---|---|---|---|---|---|
| 1 | 1000 | 0 | 0 | 0 | 1000 |
| 2 | 868 | 868 | 868 | 1 | 868 |
| 3 | 144 | 0 | 0 | 0 | 1 |
| 4 | 136 | 0 | 0 | 0 | 1 |
| 5 | 102 | 0 | 0 | 0 | 1 |
| 6 | 100 | 100 | 100 | 1 | 100 |
| 7 | 56 | 56 | 56 | 1 | 56 |

### Query 4: host names by size

The five largest host names (rank and registrations only; no host is named), and, at rank 0, how many host names hold 50 or more registrations. A host past the cap is shown at the 2,000 rows it keeps.

| host_rank | registrations |
|---|---|
| 0 | 4 |
| 1 | 2000 |
| 2 | 868 |
| 3 | 115 |
| 4 | 56 |
| 5 | 23 |

### Query 5: profile links held by several registrations

Profile links and registrations in each size bucket (a link of its own is the bucket 1), the largest in the bucket, and how many of the registrations in a bucket have an https host. No link and no hash is returned. The registrations that set no link are left out of the buckets and counted in query 1.

| registrations_per_link | links | registrations | largest_in_bucket | registrations_with_https_host |
|---|---|---|---|---|
| 1 | 4548 | 4548 | 1 | 3154 |
| 2-9 | 11 | 25 | 5 | 12 |
| 10-49 | 1 | 16 | 16 | 16 |
| 50+ | 1 | 384 | 384 | 0 |

### Query 6: names

Registrations with the placeholder name, distinct real names, and how many registrations share a real name (group sizes only; no name is returned). Arc fetches no registration link, so this figure changes only as new registrations are made.

| registrations | placeholder_names | distinct_real_names | registrations_sharing_a_name | registrations_in_names_shared_by_10_or_more | largest_name_group |
|---|---|---|---|---|---|
| 5016 | 3948 | 1065 | 6 | 0 | 2 |

### Query 7: what the listing rules did

The registrations in each state the pass stores, and for the ones held out as shared, which rule reached them first, in the order the rules run (a shared profile link, then a host shared by 50 or more, then a wallet that registered 10 or more). A rule that reaches a registration first is not the only one that would have.

| listing | state | first_rule | registrations |
|---|---|---|---|
| 0 | no usable link | - | 49 |
| 1 | listed | - | 480 |
| 2 | held out as shared | host shared by 50 or more | 3023 |
| 2 | held out as shared | profile link shared by 2 or more | 425 |
| 2 | held out as shared | wallet that registered 10 or more | 1039 |

### Query 8: transfers and edits, from the totals kept for each registration

A registration the activity walk has not covered yet has no totals and is left out of a sum. `covered_by_the_walk` shows the walk has covered every registration.

| registrations | mint_measured | covered_by_the_walk | transfers_after_mint | handouts | registrations_that_changed_hands | registrations_handed_out | profile_link_edits | registrations_edited |
|---|---|---|---|---|---|---|---|---|
| 5016 | 5016 | 5016 | 2900 | 2791 | 2900 | 2791 | 346 | 339 |

### Query 9: the activity ledger

The events of the identity registry by kind, the registrations they belong to, and the oldest and newest block. A block number is a position in the chain's history and not a date. The ledger holds events only for the stored registrations: the pass writes none for a registration it counted and did not store.

| kind | events | registrations | oldest_block | newest_block |
|---|---|---|---|---|
| mint | 5016 | 5016 | 21156191 | 29806856 |
| secondary | 2900 | 2900 | 22313910 | 29173360 |
| uri_update | 346 | 339 | 21214757 | 29628832 |

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
| 34 | 35 |
| 35 | 46 |
| 36 | 26 |
| 37 | 15 |
| 38 | 34 |
| 39 | 36 |
| 40 | 11 |
| 41 | 44 |
| 42 | 33 |
| 43 | 8 |
| 44 | 9 |
| 45 | 765 |
| 46 | 1304 |
| 47 | 10 |
| 48 | 10 |
| 49 | 30 |
| 50 | 16 |

### Query 11: the host cap

How many hosts went past the 2,000 rows a host may keep, how many registrations were counted and not stored for them, and when the source last succeeded (it is the time query 0 gives). The registrations on the chain, as the directory counts them, are query 1's registrations plus the second figure here.

| hosts_over_the_cap | counted_not_stored | source_last_success |
|---|---|---|
| 1 | 380736 | 2026-11-06 09:06:33 |

### Query 12: the largest host names with the cap added back

The five largest host names by what they hold in all, by rank and never by name: the rows stored, the registrations counted past the cap, and both together.

| host_rank | stored | counted | registrations |
|---|---|---|---|
| 1 | 2000 | 380736 | 382736 |
| 2 | 868 | 0 | 868 |
| 3 | 115 | 0 | 115 |
| 4 | 56 | 0 | 56 |
| 5 | 23 | 0 | 23 |

## Checks the figures pass

`client/src/pages/arcRegistryReport20261106.test.ts` holds each of these:

- Query 1's registrations equal query 0's, query 6's, query 8's and the mints in query 9, and query 0's listed count equals query 7's listed row and the public count of listed entries. Query 11's counted registrations and query 1's registrations make the 385,752 the directory counts on the chain, which is also the public count. Query 11's time of the last success is query 0's.
- Query 2's wallets add up to query 1's 2,508 and its registrations to 5,016. Query 3's wallets are the wallets in query 2's three largest buckets, with the same registrations.
- Query 5's links add up to query 1's different links (not counting the registrations that set none), and its registrations plus the ones that set none add up to 5,016. The registrations in the links used more than once equal the registrations query 7 says the link rule reached first.
- Query 7's states add up to 5,016. Query 8's transfers, hand-outs and edits agree with query 9's events and registrations. Query 10's chain-days add up to 5,016.
- Query 4's largest host name holds exactly the 2,000 rows a host may keep, and query 11 counts one host past the cap. Query 12's stored rows are query 4's host sizes, rank by rank, and its largest host holds query 11's whole count besides its 2,000.
- Only one profile link is shared by 50 or more registrations (query 5) and each of three wallets has 50 or more registrations on a single link (query 3), so those wallets' registrations are all on that one link.

## Figures worked out from these

Each is computed from the rows above in `client/src/lib/arcRegistryReport20261106.ts`, and the page states no other figure. A share is given to one decimal place and rounded to the nearest.

- 480 of the 5,016 stored registrations (9.6%) are listed, which is 0.1% of the 385,752 the directory counts on the chain. 49 (1.0%) have no usable profile link. 4,487 (89.5%) are held out as shared: 425 reached first by a shared profile link, 3,023 by a shared host name and 1,039 by a wallet that registered 10 or more.
- 9 wallets made 2,445 of the 5,016 stored registrations (48.7%), and 7 wallets made 2,406 (48.0%). The largest single wallet made 1,000 (19.9%).
- Against all 385,752 registrations the directory counts on the chain, the 7 wallets that made 50 or more are recorded against 2,406 (0.6%). Of the other 383,346, 2,610 are stored against wallets with fewer than 50 each, and 380,736 were counted by host name and not stored, so no wallet is recorded for them.
- 2,464 of the 2,508 wallets (98.2%) registered one each, and together they made 2,464 registrations (49.1%).
- 3 of the 7 wallets that made 50 or more have every registration on one host name, and 4 have no https host name for any registration. 4 gave every registration a profile link of its own. The other 3 used one link for every registration they made, 382 registrations between them.
- 3,182 of the 5,016 stored registrations (63.4%) have an https link, on 54 host names. The largest host name holds 2,000 of them (62.9%), the next holds 868 and the third holds 115. The two largest together hold 2,868 (90.1%). 4 host names hold 50 or more registrations.
- The largest host name is at the 2,000 rows a host may keep. Query 11 counts 380,736 more registrations for it, so it holds 382,736 in all, 99.2% of the 385,752. The 380,736 are 98.7% of the 385,752, and none of them is listed.
- 4,548 of the 4,561 different profile links (99.7%) are used by one registration each. 13 are used by more than one, by 425 registrations. One link is used by 384 registrations (7.7%), and none of them has an https host name. 43 registrations set no profile link.
- 3,948 of the 5,016 registrations (78.7%) carry the placeholder name. The other 1,068 carry 1,065 distinct names, and 6 registrations (0.1%) share a name with at least one other. No name is shared by 10 or more registrations, and the largest group is 2.
- 2,900 transfers after the mint are recorded, on 2,900 registrations (57.8%). 2,116 registrations (42.2%) have had none. 2,791 registrations (55.6%) were handed out, each once, and the other 109 transfers came later than the first hour or from another wallet.
- 346 profile-link edits are recorded, on 339 registrations (6.8%).
- The registrations were made over 51 chain-days. 2,318 of them (46.2%) were made on two days, one with 1,304 and one with 1,014. No other chain-day has more than 878. 2 chain-days had 1,000 or more, 3 had 100 to 999, 38 had 10 to 99 and 8 had 1 to 9. The 380,736 registrations counted and not stored have no chain-day here.

## Figures that are not from the queries

- 480, the public count of listed entries, and 385,752, the public count of registrations on the chain, read from `GET /api/v1/stats` on 2026-11-06 at 10:01 UTC. The same read gave 09:06:33 UTC as the last read of the chain, the time queries 0 and 11 give. No registration is hidden, so the first is the same as query 0's 480 entries, and the second is query 1's 5,016 stored registrations plus query 11's 380,736 counted.

## What this measurement cannot say

- **It is not a count of people.** A platform can register many agents under one wallet, and one person can use many wallets. The wallet figures are the registering wallets the directory records.
- **The registering wallet is not the holder.** It is the address named in the registration event and is not changed when the registration is transferred. 2,791 registrations were handed out within about an hour of the mint, so for those the wallet figures say who registered and not who holds.
- **It says nothing about whether an agent runs.** Nothing was asked of any address.
- **A hand-out is a timing fact.** It is a transfer out of the wallet a registration was minted to, within about an hour of the mint. It does not say why the registration was sent on or who received it.
- **A shared link, host name, wallet or name is a recorded fact.** It does not say that one person is behind the registrations, or that anything is wrong. A registration the directory holds out is held out as shared, and is not called fake.
- **It counts the registrations the directory has stored.** That is 5,016 of the 385,752 the directory counts on the chain. The other 380,736 were counted past a host's cap and are in no figure but query 11's, so the host name, wallet and link figures are for the stored rows. Query 9 has a mint for each stored registration, and the oldest is at block 21156191. This census does not compare either count with a total from the registry itself.
- **The stored registrations are not a sample of the chain.** A host name past the cap keeps its first registrations in chain order, so the figures for hosts, wallets, links and chain-days describe the stored rows and not all 385,752. The registrations counted and not stored have no wallet, link or chain-day in this census.
- **Ratings are not measured here.** The directory also reads the reputation registry for a count of ratings, which the Arc tab and the API show. This census does not use it.
- **Names and links are written by the registrants** and have not been verified.
- **It is one moment.** Arc is read by a scheduled pass and the chain is still adding registrations, so the figures are as of the pass named above. The report is dated and will be redone and dated again.
- **The listing rules were not changed.** They are the numbers written for the BNB Chain registry. This census says what they did on Arc and does not say whether they are right for it.
