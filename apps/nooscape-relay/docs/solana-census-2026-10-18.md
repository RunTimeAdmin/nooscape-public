# Solana registry census: the measurement (2026-10-18)

This is the measurement behind the report at `/field/solana-registries-2026-10-18`. It counts what the directory holds for the three Solana registries (SAID, the 8004 registry and the Metaplex agent registry) on 2026-10-18. It is a set of aggregate counts: no name, no wallet address and no host name was selected, and nothing was fetched from any site for it.

## How it was done

The operator ran [the queries](./solana-census-queries-2026-10-18.sql) against the production database through hPanel on 2026-10-18, after the 8004 pass that finished at 16:00 UTC (the three sources' last successful passes are in query 0). Every statement is a read-only SELECT. The output below is as it came back, with one exception: the display in hPanel cut the note in query 7 short, and the full text is restored from `METAPLEX_CHAIN_SIGNAL_NOTE` in `server/ingestion/metaplexChain.ts`.

The queries count **visible** entries, by the site's own rule (`directoryVisibilityCondition` in `server/db.ts`): the source is active, the entry is not hidden, the chain pass has not seen its asset close, and its locator host is not on the suppressed domain. Each of the three registries is read in full by a pass of its own, so the directory's entries are the registry's entries as that pass last saw them.

What each column means:

- **wallet**: the `registrant` the directory records. It is the owner the registry records for 8004 and Metaplex, and the authority for SAID. A SAID identity is keyed to its owner wallet, so each SAID identity has a wallet of its own.
- **link**: the hash of the registration link on the chain (`profileUriHash`). Two entries with the same hash name the same link. The Metaplex pass does not record a link hash, so Metaplex has no link figures.
- **host**: the host name of an https link (`locatorHost`). A link that is not an https address (ipfs, inline JSON) has no host.
- **placeholder name**: the name the pass gives an entry that has none (`SAID agent <wallet prefix>`, `8004 agent <asset prefix>`, `Metaplex agent <asset prefix>`).

## Results

### Query 0: as of when

Visible entries per registry, when a pass first and last saw one, and when the source last succeeded. The first-seen dates are when the Owl's passes began for each registry, not when anything was registered.

| protocol | visible_entries | first_seen_min | last_seen_max | source_last_success |
|---|---|---|---|---|
| solana_registry | 1596 | 2026-10-09 15:05:23 | 2026-10-18 15:30:56 | 2026-10-18 15:30:56 |
| solana_8004 | 1506 | 2026-10-12 03:04:41 | 2026-10-18 16:00:08 | 2026-10-18 16:00:08 |
| solana_said | 13779 | 2026-10-13 15:38:40 | 2026-10-18 15:30:33 | 2026-10-18 15:30:35 |

### Query 1: size and surface

| protocol | entries | distinct_wallets | no_wallet | with_link | distinct_links | with_https_host | distinct_hosts |
|---|---|---|---|---|---|---|---|
| solana_registry | 1596 | 564 | 0 | 0 | 0 | 73 | 7 |
| solana_8004 | 1506 | 295 | 0 | 1506 | 1089 | 411 | 51 |
| solana_said | 13779 | 13779 | 0 | 13779 | 13776 | 13778 | 21 |

### Query 2: how many entries one wallet holds

Wallets and entries in each size bucket, and the largest holding in the bucket. SAID has one bucket: every identity has its own wallet.

| protocol | entries_per_wallet | wallets | entries | largest_holding_in_bucket |
|---|---|---|---|---|
| solana_registry | 1 | 460 | 460 | 1 |
| solana_registry | 2-9 | 90 | 269 | 8 |
| solana_registry | 10-99 | 11 | 314 | 97 |
| solana_registry | 100-999 | 3 | 553 | 332 |
| solana_8004 | 1 | 212 | 212 | 1 |
| solana_8004 | 2-9 | 65 | 184 | 8 |
| solana_8004 | 10-99 | 15 | 429 | 76 |
| solana_8004 | 100-999 | 3 | 681 | 326 |
| solana_said | 1 | 13779 | 13779 | 1 |

### Query 3: how many entries share one link

Links and entries in each size bucket, and the largest group in the bucket. Metaplex has no rows: it records no link.

| protocol | entries_sharing_a_link | links | entries | largest_group_in_bucket |
|---|---|---|---|---|
| solana_8004 | 1 | 1032 | 1032 | 1 |
| solana_8004 | 2-9 | 52 | 159 | 9 |
| solana_8004 | 10-99 | 3 | 74 | 41 |
| solana_8004 | 100+ | 2 | 241 | 135 |
| solana_said | 1 | 13773 | 13773 | 1 |
| solana_said | 2-9 | 3 | 6 | 2 |

### Query 4: host names by size

The five largest host names of each registry (rank and entries only; no host is named), and, at rank 0, how many host names hold 50 or more entries. A registry with no rank 0 row has no host name that large (Metaplex).

| protocol | host_rank | entries |
|---|---|---|
| solana_8004 | 0 | 2 |
| solana_8004 | 1 | 142 |
| solana_8004 | 2 | 141 |
| solana_8004 | 3 | 40 |
| solana_8004 | 4 | 22 |
| solana_8004 | 5 | 7 |
| solana_registry | 1 | 43 |
| solana_registry | 2 | 16 |
| solana_registry | 3 | 6 |
| solana_registry | 4 | 3 |
| solana_registry | 5 | 2 |
| solana_said | 0 | 2 |
| solana_said | 1 | 13426 |
| solana_said | 2 | 256 |
| solana_said | 3 | 39 |
| solana_said | 4 | 21 |
| solana_said | 5 | 7 |

### Query 5: SAID, what the chain records

Read from the note the SAID pass writes for each identity. The badge is bought for 0.01 SOL or granted by a sponsor, and is not an identity check. Layouts 1 and 2 record no stake and no slash count.

| facet | value | entries |
|---|---|---|
| badge | badge: no | 298 |
| badge | badge: yes | 13481 |
| layout | layout v1 | 1156 |
| layout | layout v2 | 1635 |
| layout | layout v3 | 10988 |
| registered_month | registered 2026-02 | 27 |
| registered_month | registered 2026-03 | 2561 |
| registered_month | registered 2026-04 | 430 |
| registered_month | registered 2026-05 | 1272 |
| registered_month | registered 2026-06 | 1825 |
| registered_month | registered 2026-07 | 686 |
| registered_month | registered 2026-08 | 2913 |
| registered_month | registered 2026-09 | 2357 |
| registered_month | registered 2026-10 | 1708 |
| slashes | (not recorded: layouts 1 and 2) | 2791 |
| slashes | slashes: 0 | 10988 |
| stake | (not recorded: layouts 1 and 2) | 2791 |
| stake | stake: none | 10984 |
| stake | stake: some | 4 |

### Query 6: 8004, the registry's own feedback counters

Agents in each size bucket and the ratings they hold, then the ratings held by the ten agents with the most and by all agents.

| ratings_per_agent | agents | ratings |
|---|---|---|
| 0 | 333 | 0 |
| 1-4 | 875 | 1870 |
| 5-19 | 247 | 2078 |
| 20-99 | 19 | 794 |
| 100+ | 32 | 5954 |

| ratings_of_top_10_agents | ratings_of_all_agents |
|---|---|
| 3410 | 10696 |

### Query 7: Metaplex, which kind of row each entry is

| note_kind | entries |
|---|---|
| On-chain Metaplex registry pass: identity PDA and Core asset owner/name are chain reads; no off-chain content fetched. | 1596 |

### Query 8: names

Entries with the placeholder name, distinct real names, and how many entries share a real name (group sizes only; no name is returned). SAID names are still being read from the cards the links name, a few at a time, so the SAID row is a snapshot of a figure that changes every day.

| protocol | entries | placeholder_names | distinct_real_names | entries_sharing_a_name | entries_in_names_shared_by_10_or_more | largest_name_group |
|---|---|---|---|---|---|---|
| solana_registry | 1596 | 0 | 1320 | 362 | 159 | 71 |
| solana_8004 | 1506 | 614 | 690 | 274 | 76 | 64 |
| solana_said | 13779 | 13619 | 144 | 27 | 0 | 4 |

### Query 9: wallets recorded in more than one registry

| registries_the_wallet_is_in | wallets | entries |
|---|---|---|
| 1 | 14577 | 16793 |
| 2 | 29 | 85 |
| 3 | 1 | 3 |

## Checks the figures pass

`client/src/pages/solanaRegistryReport.test.ts` holds each of these:

- Query 1's entries equal query 0's for each registry, and the three add up to 16,881.
- Query 2's wallets and entries in each registry add up to query 1's. Query 3's links and entries add up to query 1's for 8004 and for SAID.
- Query 5's layouts, registration months, badge values and stake values each add up to SAID's 13,779, and its slash and stake rows for layouts 1 and 2 equal the identities in those two layouts.
- Query 6's agents add up to 8004's 1,506 and its ratings to 10,696.
- Query 9's entries add up to 16,881, and its wallets are the distinct wallets of query 1 less the wallets that appear in more than one registry.

## Figures worked out from these

Each is computed from the rows above in `client/src/lib/solanaRegistryReport.ts`, and the page states no other figure.

- 3 wallets hold 681 of the 1,506 8004 entries (45%), and 18 wallets hold 1,110 (74%). The largest single holding is 326 (22%).
- 3 wallets hold 553 of the 1,596 Metaplex entries (35%). The largest single holding is 332 (21%).
- 474 of the 1,506 8004 entries (31%) share a link with at least one other entry. 5 links are shared by 10 or more entries and hold 315 entries (21%). The largest group is 135.
- 13,426 of the 13,778 SAID entries with an https link (97%) are on one host name, and the second holds 256.
- 283 of the 411 8004 entries with an https link (69%) are on the two largest host names (142 and 141).
- 43 of the 73 Metaplex entries with an https link (59%) are on the largest host name.
- 13,481 of 13,779 SAID identities (98%) carry the badge.
- 32 8004 agents with 100 ratings or more hold 5,954 of the 10,696 ratings (56%). The ten agents with the most hold 3,410 (32%).
- 362 Metaplex entries (23%) share a name with at least one other entry.

## What this measurement cannot say

- **It is not a count of people.** A platform can register many agents under one wallet, and one person can use many wallets. The wallet figures are the wallets the registries record.
- **It says nothing about whether an agent runs.** Nothing was asked of any address.
- **Registration dates exist only for SAID.** The SAID account records the date it was created. The other two registries are counted as they stand on 2026-10-18.
- **Metaplex link figures are not recorded**, which is not the same as zero.
- **A shared link, host name, wallet or name is a recorded fact.** It does not say that one person is behind the entries, or that anything is wrong.
- **The SAID name figure moves.** The step that reads the cards started on 2026-10-18 and takes about two weeks to read them all.
- **Names, links and counters are written by the registrants or the registries** and have not been verified.
- **It is one moment.** The registries change every hour; the report is dated and will be redone and dated again.

