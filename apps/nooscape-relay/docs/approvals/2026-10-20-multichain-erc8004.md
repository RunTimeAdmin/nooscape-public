# Decision record: Multichain ERC-8004 identity passes (Ethereum, Base, Arc)

**Decided:** 2026-10-20, by the operator, in chat. He attached the brief `CLAUDE_BRIEF_MULTICHAIN_ERC8004.md` (written 2026-10-19): replace the BNB-only importer with one importer that takes a chain, then add Ethereum, Base and Arc, each behind a switch that is off. The brief was checked against the code first, and he answered three questions: drop the private-address exception, skip the payment guard, and deliver in three stops on one branch with one pull request at the end (auto-merge off). After the first stop he said "go", gave the Base provider (an Alchemy endpoint, on the Pay As You Go plan he moved to that day), and asked what the GitHub Actions allowance affects.
**Changes:** the BNB pass becomes one implementation that takes a chain entry (BNB Chain is an entry and behaves as before); three more entries, Ethereum, Base and Arc; `chain_ethereum`, `chain_base` and `chain_arc` in `VITE_FEATURES`; `ETH_RPC_URL` and `BASE_RPC_URL`, and `X402_RPC` read through one shared helper; migration 0046 (manual, not run) appending three protocol values to four tables; staging and run buttons on the operator page, shown only while a chain's switch is on; the scheduled worker's dispatch for the three protocols (reachable only after a later reviewed migration flips a source to the scheduler).
**Does not change:** a record, a score, a tier, an evidence level, the listing, the map, the search, the aggregates, the API, the tabs or any page a visitor sees (stage 3 adds the chain list, the API and the tabs, each behind the same switches). BNB Chain's behaviour, cursor, keys, budget and rules. Payment: `loadX402` reads `X402_RPC` through the shared helper with the same outcomes (a test sets the old rule beside it on 19 inputs), and nothing else in payment code is touched. Payment never affects what a pass records.

## What the operator is asked to approve

1. **The three chain entries and the numbers behind them**, each measured on 2026-10-20 and recorded with its method in `docs/multichain-erc8004-2026-10-20.md`: the registry's deploy block on each chain, the provider's limits, the window and the response cap, the hand-out hour.
2. **The starting budgets** (windows a run, windows at once, events, seconds), which are smaller than BNB Chain's and are his to raise after the first runs.
3. **The listing rules**, which are BNB Chain's numbers for each chain and are provisional until each chain has had a census.
4. **How Arc uses his node.** One request at a time, 250 ms after one ends, a 6 second timeout (a payment check's is 8), waits of 1, 2 and 4 seconds with jitter and then a stop that keeps the cursor, and nothing of `X402_RPC` ever in an error, a log line or a record. There is no payment-first guard (his decision).
5. **The migration and the order of steps** in the doc: 0046 by hand with its record, then an endpoint variable, then the switch, then stage, approve and run from `/admin/sources`.
6. **What a switch does to the pages and the API** (stage 3). While a chain is on: a tab and a line in the totals, its entries in search and on entry pages, its source on the status page, and its place in the API's chain list, lookups, search and check. While it is off: none of that, and the site and the API answer as they did before these chains existed. The doc's stage 3 section lists each surface.

## What the operator did not decide and I chose, so he can say no

1. **Deploy blocks on Base and Arc come from the first log, not from `eth_getCode`.** Neither endpoint serves state that far back. The method was checked on Ethereum first, where it gave exactly the block the code search and the explorers gave.
2. **Four tables, not three.** The registry rows table (0034) carries the protocol list too, and the pass writes every registration to it first. A real-database test shows the new values refused before 0046 and accepted after, and 0046 pasted twice a no-op.
3. **Base is pinned to Alchemy's host and Arc's host is derived.** A vendor host is the same for every account, so it is named in the code. Arc's node is his own, so its host is read from `X402_RPC` when he stages the source and recorded in the row, and each run compares the variable with the row. To move Arc, he changes the variable and the row's two columns together (the doc says how).
4. **Windows and caps.** Ethereum 2,000 blocks and a 24 MiB cap (the densest window measured is 12.4 MiB, and BNB Chain's 8 MiB would stall the walk there); Base 1,000 blocks and a 24 MiB cap; Arc 100,000 blocks and a 2 MiB cap.
5. **The note sentence for a link.** A registration on the new chains says "Nooscape did not fetch it when it recorded this registration." It states what happened at the recording, so it stays true if a later pass reads files (BNB Chain's note once said it did not fetch and had to be rewritten when its pass began to).
6. **One existing sentence is kept on every chain.** Each registration note ends "current ownership is not verified", the house wording for Robinhood Chain and BNB Chain. It says the opposite of a claim, and BNB Chain's notes must stay as they are, so the guard on the words "verified", "safe", "trusted" and "guaranteed" allows exactly that sentence. He may want it worded differently for the new chains.
7. **A chain that is off cannot be staged or run.** The brief says the importer refuses to run; staging is refused too, and the operator page shows no button, so an off chain leaves no source behind.
8. **An answer that says "Log response size exceeded" is a result-size rejection on every chain**, though it also mentions a block range (Alchemy's wording). No BNB answer can contain it, and a differential check against the old code still found nothing different.
9. **Base's first pass should wait on a decision of his.** Its registry is in a surge: 321,929 registrations to the head, 69% of them in the last 10 days, 54,227 in the latest 24 hours (it was a few hundred a day before), and 82,477 events in the latest 10,000 blocks. The pass can keep pace, but the registry rows table and the classification have not been tried at that size, and the pass walks the whole history from the deploy block.
10. **The extra chains are kept out of `ChainKey`.** A chain in that list gets a light on the map, a page of its own, a share card and a place in the Owl's Catch. He asked for the tabs, the badges, the chain list and the API, with counts, so these chains have none of the others. Giving them a page is a later and larger change, and it is his to ask for.
11. **The watchlist and the webhook stay on the original three chains.** The brief puts events for the new chains out of scope, so a watch on a listing of one of them is refused as an unknown chain.
12. **The check, the batch lookup and the history serve a chain that is on, as they serve BNB Chain.** Where Nooscape holds no ledger for the chain, a flag says it is not measured. Claims, ratings and the "Checked, unproven" registration read stay for Robinhood Chain and BNB Chain.
13. **The tabs' answer gains an `extras` list only while a chain is on.** With every switch off `liveData.chainStats` is exactly what it was, so nothing that reads it (the hero, the sweep, the Owl's Catch) can meet a chain it has no name for.
14. **The chain's tab says what the chain holds against what the directory lists**, in BNB Chain's sentence, from two counts over the registry rows (cached, and absent until a pass that reached the finalized head has published). A million-row registry costs the page a count and no grouping.
15. **The Ethereum, Base and Arc colours and icons** on the tabs are mine: sky blue, blue and pink, with a pentagon, a cross and a dome. They have no light on the map, so they are not the map key's shapes.

## What stays for later stages, and for the operator

- A scheduled flip for each source, as a later reviewed migration, after a first successful manual run on that chain.
- Running 0046 and recording it, setting `ETH_RPC_URL` and `BASE_RPC_URL`, turning a switch on, and running the first pass. All of these are his.
- Whether Base starts at its deploy block, and when.

## Outcome

- [x] Stage 1 built and tested on a local branch (2026-10-20): the pass takes a chain; BNB Chain unchanged.
- [x] Stage 2 built and tested on the same branch (2026-10-20): Ethereum, Base and Arc behind switches, off.
- [x] Stage 3 built and tested on the same branch (2026-10-20): the tabs, the totals, search, the entry pages, the source list and the API follow each chain's switch.
- [ ] One pull request, auto-merge off, reviewed and merged by the operator.
- [ ] Migration 0046 run on production, and its record row inserted.
- [ ] `ETH_RPC_URL` and `BASE_RPC_URL` set on the host.
- [ ] A switch turned on, and a first manual pass run and read for one chain.
- [ ] The scheduled flip, as a later migration.
