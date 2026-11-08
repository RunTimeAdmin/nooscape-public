# Ratings for Gnosis

One line of configuration. The ratings step counts the ratings a chain's ERC-8004 reputation registry records; Gnosis's entry now names that registry, so the step counts Gnosis's too ([the step's record](./extra-chain-ratings-2026-10-21.md), and [Monad's](./monad-ratings-2026-11-01.md), which this follows). No migration, no new table, no setting and no change to what the site says a rating is.

**Status.** Built on 2026-11-06 on branch `feat/gnosis-self-maintaining`. It takes effect once that pull request merges and deploys, behind `chain_gnosis`, which production has on.

**Decided:** 2026-11-06, by the operator, in chat: "lets go fully live with gnosos once you have all you need to do it", on the list of what Gnosis still lacked (ratings among them, [section 7 of its record](./gnosis-erc8004-2026-11-06.md)). The registry is the other chains' and the window is the one the identity pass already uses on this plan, so the operator can say no to any of it.

## What changes

`GNOSIS_CHAIN` in `server/ingestion/erc8004Chains.ts` gets `reputation: { registry: ERC8004_REPUTATION_REGISTRY, window: 10_000 }`. The step reads a chain's history from its identity registry's deploy block, one window at a time, and counts the two events the registry writes for a rating (`NewFeedback`) and for taking one back (`FeedbackRevoked`). Nothing else in the step knows about chains by name: the tab's figure is looked up by chain key, so Gnosis needs no other code.

## Measured on 2026-11-06

- **The registry exists on Gnosis.** The canonical reputation registry (`0x8004BAa1...9b63`, the same address as on Ethereum, Base, Arc and Monad) is deployed there as a proxy, as the identity registry is.
- **What it holds.** A walk of every window from the identity registry's deploy block (44,505,010) to the head, 465 windows of 10,000 blocks, through the keyed Alchemy endpoint found 4,346 events: 4,341 ratings, no revocation and 5 events of proxy administration that the step ignores. The first was at block 44,505,016 and the last at 45,211,168, within the first month; the registry has recorded none in the 30 days to 2026-11-06. 23 of the 465 windows hold an event, and the busiest holds 580.
- **Why the window is 10,000 blocks.** The first attempt asked for 50,000, which this plan refuses (the identity pass records the same limit). 10,000 is the widest range it answers, and the entry's `maxLogRange` says so.
- **What the step counts.** The step itself, run against a scratch database and the real chain at the share of the budget it gets in production (6 seconds: 30 seconds over the five chains that name a reputation registry), caught up in 14 runs and 465 windows, 83 seconds of runs in all, and counted 4,341 ratings and no revocation, the same as the walk. A run read between 19 and 39 windows, 25 in the slowest.

## What a visitor sees

The Gnosis tab says "4,341 ratings recorded" where it now says "Not measured". The figure appears only once the step has read the whole history (it is shown when `caughtUpAt` is set), so a half-read count is never shown. At one run every 30 minutes the catch-up takes about 14 runs, so about seven hours after the deploy, and the stats API's `ratings_recorded` for Gnosis moves from null to the count with it. The step runs on a tick that claimed sources, so a busy tick can make it later.

## Cost

During the catch-up a run adds up to 6 seconds to a tick that runs it, and the step does not start when its tick has already run 100 seconds. About 465 `eth_getLogs` calls are made in all on the keyed Alchemy plan. After it the step reads one window a run, three requests. A fifth chain lowers each chain's share of the 30-second budget from 7.5 to 6 seconds; the other four have caught up and read a window or two a run, so it costs them nothing.

## Held by a test

- `server/ingestion/erc8004Chains.test.ts` and `server/chainRatings.integration.test.ts`: the registry is named on Ethereum, Base, Arc, Monad and Gnosis, Gnosis's window is 10,000 blocks and no wider than the provider answers (`maxLogRange`), and the entries are sound (`validateErc8004Chains`). The integration test runs on MySQL 8.4 and on MariaDB 10.11.
- Planted bugs: three, each caught. A window of 50,000 blocks, the identity registry's address in place of the reputation registry's, and no registry named.
