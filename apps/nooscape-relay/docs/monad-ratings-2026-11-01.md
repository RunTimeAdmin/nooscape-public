# Ratings for Monad

One line of configuration. The ratings step counts the ratings a chain's ERC-8004 reputation registry records; Monad's entry now names that registry, so the step counts Monad's too ([the step's record](./extra-chain-ratings-2026-10-21.md)). No migration, no new table, no setting and no change to what the site says a rating is.

**Status.** Built on 2026-11-01 on branch `feature/monad-extras`. It takes effect once that pull request merges and deploys, behind `chain_monad`, which production has on.

**Decided:** 2026-11-01, by the operator, in chat: "do these next", on the list of what Monad still lacked (ratings among them). The registry and the window are the other three chains', so the operator can say no to any of it.

## What changes

`MONAD_CHAIN` in `server/ingestion/erc8004Chains.ts` gets `reputation: { registry: ERC8004_REPUTATION_REGISTRY, window: 50_000 }`. The step reads a chain's history from its identity registry's deploy block, one window at a time, and counts the two events the registry writes for a rating (`NewFeedback`) and for taking one back (`FeedbackRevoked`). Nothing else in the step knows about chains by name: the tab's figure is looked up by chain key, so Monad needs no other code.

## Measured on 2026-11-01

- **The registry exists on Monad.** The canonical reputation registry (`0x8004BAa1...9b63`, the same address as on Ethereum, Base and Arc) has the same 130-byte proxy code there as Monad's identity registry.
- **What it holds.** A walk of every window from the identity registry's deploy block (52,952,790) to the head, 1,312 windows of 50,000 blocks, through the keyed Alchemy endpoint found 9,439 events: 9,432 ratings, 2 revocations and 5 events of proxy administration that the step ignores. The first was at block 52,952,794 and the last at 117,603,725.
- **What the step counts.** The step itself, run against a scratch database and the real chain at the share of the budget it gets in production (7.5 seconds: 30 seconds over four chains), caught up in 14 runs and 1,312 windows and counted 9,432 ratings and 2 revocations, the same as the walk. A run read between 64 and 116 windows.

## What a visitor sees

The Monad tab and page say "N ratings recorded" where they now say "Not measured". The figure appears only once the step has read the whole history (it is shown when `caughtUpAt` is set), so a half-read count is never shown. At one run every 30 minutes the catch-up takes about 14 runs, so about seven hours after the deploy, and the stats API's `ratings_recorded` for Monad moves from null to the count with it (9,432 at the time of the walk). The step runs on a tick that claimed sources, so a busy tick can make it later.

## Cost

During the catch-up a run adds up to 7.5 seconds to a tick that runs it, and the step does not start when its tick has already run 100 seconds. About 1,312 `eth_getLogs` calls are made in all on the keyed Alchemy plan. After it the step reads one window a run, three requests.

## Held by a test

- `server/chainRatings.integration.test.ts`: the registry is named on Ethereum, Base, Arc and Monad, Monad's window is 50,000 blocks and no wider than the provider answers (`maxLogRange`), and the entries are sound (`validateErc8004Chains`). It runs on MySQL 8.4 and on MariaDB 10.11.
- Planted bugs: three, each caught. No registry named, a window of 100,000 blocks, and the identity registry's address in place of the reputation registry's.
