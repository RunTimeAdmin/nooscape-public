# Ethereum: turning the chain on

**Status:** Ethereum was built, tested and merged on 2026-10-20 with the other extra chains (PR 174, [the multichain record](./multichain-erc8004-2026-10-20.md)) and has been switched off since. The operator chose it as the last stage of "1 then 2 then 5" on 2026-10-27 ("5 is ethereum"). This record holds what was measured on the real chain that day, a rehearsal of the whole first pass, the steps that turn it on, and what to read afterwards. The operator switched it on at about 12:00Z that day, and section 7 says what happened live.

## 1. What is needed, and what is not

The chain's entry (`ETHEREUM_CHAIN` in `server/ingestion/erc8004Chains.ts`), its switch (`chain_ethereum`), the migration (0046), the pass, the tab, the API and the search were all in PR 174. Turning it on is two settings on the host and a series of button presses; no code has to be merged for it. What this record adds is the numbers to expect, the names step for the chain (section 6) and the words that name the chain.

## 2. The registry on 2026-10-27

Read through the operator's NodeReal account at 11:02Z, with the pass's own topic filter and parser, one `eth_getLogs` per window of 2,000 blocks from the deploy block (24,339,871) to the finalized head (26,283,618): 972 windows, none failed, 21 seconds in all.

| | |
|---|---|
| Registrations | 55,442 (54,333 on 2026-10-20) |
| Events the pass accepts (registrations, mints, transfers, link updates) | 130,845 |
| Launch burst (first 5 windows, 10,000 blocks) | 45,518 events, 19,698 registrations; the densest window 19,200 events |
| Since then | about 130 registrations a day over 30 days, 158 a day over the last 7, 23 over the last day |
| Windows over 5,000 events | 7; over 10,000: 2; empty: 71 |

It is a quiet registry now. There is no flood like Base's, and the host cap (2,000 stored rows for one host, `docs/flood-host-cap-2026-10-21.md`) is in the entry anyway.

## 3. The rehearsal

The pass was run for real, with the budget in the code (100 windows, 3 at once, 5,000 events, 30 seconds), against a throwaway MariaDB 10.11 (the production engine) and the real chain, from the deploy block, as the operator's "Run chain pass" button runs it: `runApprovedErc8004ChainSource`, source staged as `manual_only`, one run after another until the cursor stopped moving.

- **20 runs, then one that did nothing.** Together they took 181 seconds. The longest took 24.9 seconds (9,927 events, 71 windows), the shortest 1.7. Peak memory 358 MB.
- **They matched an offline count exactly.** From the per-window counts the 20 runs are 19,200, 12,800, 13,518, 5,864, 5,367, 5,029, 5,002, 9,927, 817, 5,037, 3,329, 3,773, 7,313, 5,817, 7,703, 5,738, 3,174, 2,852, 5,451 and 3,134 accepted events, which is what the real runs accepted.
- **The cursor ended at block 26,283,651.** The last run published the listing.

What the walk left behind:

| | |
|---|---|
| Recorded registrations | 55,442 (47,420 rows stored, 8,022 more counted past a host's cap) |
| **Listed** | **5,186 (9.4%)** |
| Held out, grouped (a link, host or wallet shared with many others) | 19,909 |
| Held out, no usable profile link | 22,260 |
| Held out, a name that is only a number | 65 |
| Hosts past the cap | agents.exquisite.land (10,000 registrations, 2,000 stored) and api.normies.art (2,022) |
| Largest wallets | 9,989 and 7,239 registrations |
| Listed entries named from JSON in their link | 3,878; 1,308 show "Agent #n" |
| Ledger rows kept | 67,381 (47,420 mints, 18,387 later transfers, 1,574 link updates) |
| Database size | registry rows 78 MB, ledger 64 MB, entries a few more (about 0.2 GB with production's wider rows), against a 6 GB limit |

The chain's sentence on its tab will read "The chain holds N registrations. The published listing rules put M of them in the directory; the rest are held out, not judged." with N and M a little above 55,442 and 5,186 by the day it is run. The listing rules are BNB Chain's numbers, provisional until a census.

## 4. Why the budget stays

At the starting budget the walk is 20 runs, about 3 minutes of running and 20 button presses. A wider budget would shorten it: from the same per-window counts, 250 windows and 100,000 events a run would be 4 runs, and 250 and 50,000 would be 5. A change to the entry, a pull request and a deploy cost more than sixteen presses, and the runs are not slow, so the budget in the code is kept. The scheduled flip, which is a later decision, runs the pass every cadence anyway.

## 5. Turning it on

1. On the host, add `ETH_RPC_URL`: the NodeReal address for Ethereum, which is the operator's BNB Chain address with `bsc-mainnet` changed to `eth-mainnet` (same account key). The pass accepts only the host `eth-mainnet.nodereal.io`.
2. Add `chain_ethereum` to `VITE_FEATURES` (on 2026-10-27 the live value was `claims,chain_arc,claims_arc,chain_base`). Type it exactly: the list is baked into the client at build time.
3. Redeploy once, so the client is rebuilt and the server restarted.
4. On `/admin/sources`: "Stage Ethereum ERC-8004 registry · manual only", approve it, press "Run chain pass" until it stops moving.
5. Do not ask for the scheduled flip yet. That is a later, reviewed migration, after the first pass has been read.

Rollback: remove `chain_ethereum` from `VITE_FEATURES` and redeploy. The tab, the API value and the search results go; the source row and the migration stay and are harmless.

## 6. Names

The names step (`server/chainNames.ts`) takes Ethereum as its third chain, after Base and Arc: [the 2026-10-26 decision record](./approvals/2026-10-26-base-arc-names.md) has the addendum, with a live check of the step's chain read on Ethereum (17 of 17 links equal to a plain `tokenURI` call) and the pace. The words on `/checker`, on the sources page, in the page descriptions and in the hero now name six chains, and `docs/naming-2026-10-18.md` says so. That change is merged after the chain is on, because those sentences say what Nooscape reads.

## 7. What happened live

All times are UTC on 2026-10-27.

- **11:59:45, the redeploy landed** (the home page's `Last-Modified`), with `ETH_RPC_URL` set and the live script reading `VITE_FEATURES` as `claims,chain_arc,claims_arc,chain_base,chain_ethereum`. The API index then listed six chains, `ethereum` after `solana`, with `indexed: false` and no counts, and `verify-live` passed 45 of 45.
- **12:01 to 12:04, the pass.** The operator staged and approved the source (active, `manual_only`) and pressed Run chain pass. The first successful run was at 12:01:28 and the last at 12:04:23, three minutes for the whole walk, as the rehearsal said. No run failed (`failureCount` 0), so `ETH_RPC_URL` worked at the first press.
- **The figures, against section 3.** The stats row for Ethereum: 5,185 acknowledged, 55,442 registrations on the chain, 5,185 first seen in the last day, last read 12:04:23, registry `erc8004_eth` at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. The rehearsal said 55,442 recorded and 5,186 listed: the same, and the tab counts 5,185 as acknowledged because one listed entry is hidden. `live_stats_compare.py` (every figure of `/api/v1/stats` against the site's own procedures) found 0 differences across all six chains, and `verify-live` passed 45 of 45 with no warning.
- **The home page,** at desktop width and at 375 px (the built-in browser): the heading reads "Robinhood, BNB, Solana, Ethereum, Base, Arc. Same Owl, six skies."; the Ethereum tab shows 5,185 acknowledged, 0 reviewed records, "not measured here" for ratings, and "The chain holds 55,442 registrations. The published listing rules put 5,186 of them in the directory; the rest are held out, not judged." with its last read; no console error and no horizontal scroll. The tab has no page link (Arc and Base have one).
- **The API.** `/api/v1/agents/search?q=agent&chain=ethereum` answers, `/api/v1/agents/ethereum/55441` answers with the entry, the entry's page is titled "Agent #55441 | Nooscape", and the OpenAPI document and `/llms.txt` name Ethereum.
- **Reading the stats row.** `indexed` is true as soon as the source has run once, so it does not mean the listing is published: that is `acknowledged` above 0 and, a minute or two later (the soft cache), `registrations_on_chain` set.
- **The merge.** PR 215 (the names, the six-chain wording and this record) was rebase-merged at 13:03Z and deployed at 13:03:55Z. `verify-live` passed 45 of 45, the page shell names six chains in all four places, and the live `/checker` has the five new Ethereum sentences and none of the old ones, with no console error and no horizontal scroll.
- **`nooscape-mcp` 0.4.0.** The package's chain list was fixed to five, so `get_agent`, `get_agent_history` and `check` refused "ethereum" (`get_stats` already showed the row). Version 0.4.0 adds it: public repository PR 3, squash commit `113ca07` at 13:25Z, then published by the operator to npm at 13:33:25 (shasum `e3ac1c681c5fa5d1669be5d5af7e6d1e153036c6` and integrity both equal to the dry run's) and to the registry at 13:33:40. Run from npm with `live-check.mjs --npx nooscape-mcp@0.4.0` from an empty folder it passes all 14 checks, among them an Ethereum search and an Ethereum agent read ("Ethereum agent 55441"). [The MCP record](./mcp-server-2026-10-19.md) has the release.
- **Later the same day.** The ratings step read the chain from 13:45Z, so the tab says 34,831 ratings recorded and no longer "not measured here". The names step took Ethereum's turn at 14:31Z (Base at 13:30 and Arc at 14:00 came first) and named 12 of the 16 entries it looked at; it takes a turn about every 90 minutes. [The Ethereum page](./ethereum-world-2026-10-27.md) went live at 14:33Z.
- **Not yet.** The rest of the 1,308 listed entries that show "Agent #n" wait for their turns, and the source is `manual_only`, so nothing reads the registry's new registrations (about 130 a day) until the scheduled flip.

## 8. Open

- **The scheduled flip** (a manual migration of the 0047 and 0050 kind), which is the next step: until it is made the chain's figures stay as of 12:04Z on 2026-10-27. Arc's flip made its pass daily (migration 0050) and the same cadence fits a registry that gains about 130 registrations a day; Arc's allowance in `scripts/verify-live.mjs` (`erc8004_arc: 36`) would get an Ethereum twin. The migration number comes from the production migration log, which the operator has to read first.
- **A census of the Ethereum registry** and a decision on its listing rules: the rules are BNB Chain's and 40% of the registrations have no link at all.
- **Map lights, a census report and claims** for Ethereum are not built; its page is [the Ethereum page](./ethereum-world-2026-10-27.md).
