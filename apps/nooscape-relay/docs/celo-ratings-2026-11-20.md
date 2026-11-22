# Ratings for Celo

One line of configuration. The ratings step counts the ratings a chain's ERC-8004 reputation registry records; Celo's entry now names that registry, so the step counts Celo's too ([the step's record](./extra-chain-ratings-2026-10-21.md), and [Gnosis's](./gnosis-ratings-2026-11-06.md), which this follows). No migration, no new table, no setting and no change to what the site says a rating is.

**Status.** Built on 2026-11-20 on branch `feat/celo-names-ratings`. It takes effect once that pull request merges and deploys, behind `chain_celo`, which production has on. The figure appears on the Celo tab eight to ten days later, or about two days later once the separate faster-ratings change is deployed too (see "What a visitor sees" and the last section).

**Decided:** 2026-11-20, by the operator, in chat: "all in order", on my list of what Celo still lacked after it went live, where names and ratings came second ([section 7 of its record](./celo-erc8004-2026-11-20.md)). The registry is the other chains' and the window is the most the official node answers, so the operator can say no to any of it.

## What changes

`CELO_CHAIN` in `server/ingestion/erc8004Chains.ts` gets `reputation: { registry: ERC8004_REPUTATION_REGISTRY, window: 5_000 }`. The step reads a chain's history from its identity registry's deploy block, one window at a time, and counts the two events the registry writes for a rating (`NewFeedback`) and for taking one back (`FeedbackRevoked`). Nothing else in the step knows about chains by name: the tab's figure is looked up by chain key, so Celo needs no other code.

## Measured on 2026-11-20

- **The registry exists on Celo.** The canonical reputation registry (`0x8004BAa1...9b63`, the same address as on Ethereum, Base, Arc, Monad and Gnosis) is deployed there as a proxy, as the identity registry is. It was deployed six blocks after the identity registry: there is no code at block 58,396,724 and 130 bytes at 58,396,730.
- **What it holds.** A walk of every window from the identity registry's deploy block (58,396,724) to the head (83,300,373), 4,981 windows of 5,000 blocks, through the public Tenderly gateway, found 30,162 events, all of them ratings: no revocation, on 7,798 agents. By month: February 459, March 11,635, April 5,418, May 286, June 7,783, July 1,962, August 175, September 439, October 1,473 and November 532 (to the 20th). 1,879 of the 4,981 windows hold an event, and the busiest holds 653 (1,085,787 bytes as JSON), well inside the entry's response cap of 8 MiB. All of them together are 55 MB.
- **Why the window is 5,000 blocks.** The official node refuses a wider range with an HTTP 400, as the identity pass records. 5,000 is the widest range it answers, and the entry's `maxLogRange` says so.
- **What the step counts.** The step itself, run against a scratch database and the real chain through the official node at the share of the budget it gets in production (5 seconds: 30 seconds over the six chains that name a reputation registry), caught up in 406 runs and 4,981 windows, 37 minutes of runs in all, and counted 30,162 ratings and 0 revocations, the same as the walk. A run read between 3 and 24 windows, 12 in the middle. The windows that hold events take the node longer, so the runs through the busy months read fewer.
- **What it costs on the server.** Forty windows spread evenly over the history (every 124th of the 4,981) were asked of the official node from the production server, twice, timed without the connection and TLS set-up, which a running step does not repeat. They took 384 ms and 492 ms on average (from 0.12 to 1.8 seconds a window, the slowest as often an empty window as a full one), so the whole history is 32 to 41 minutes of requests, and a run's 5 seconds, which first pay for two small requests, read 10 to 12 windows.

## What a visitor sees

The Celo tab says "30,162 ratings recorded" where it now says "not measured here". The figure appears only once the step has read the whole history (it is shown when `caughtUpAt` is set), so a half-read count is never shown. A run reads 10 to 12 windows on the server (12 in the middle on this PC) and the step runs at most every 30 minutes, 48 runs a day, so the catch-up takes 400 to 500 runs, which is eight to ten days after the deploy, and the stats API's `ratings_recorded` for Celo moves from null to the count with it. That is longer than Gnosis's seven hours for two reasons: Celo's history is 4,981 windows against Gnosis's 465, and the official node answers 5,000 blocks a request where Gnosis's plan answered 10,000. The step runs on a tick that claimed sources, so a busy tick can make it later.

## Cost

During the catch-up a run adds up to 5 seconds to a tick that runs it, and the step does not start when its tick has already run 100 seconds. About 4,981 `eth_getLogs` calls are made in all on the official node, which takes no key, one at a time. After it the step reads one window a run, three requests. A sixth chain lowers each chain's share of the 30-second budget from 6 to 5 seconds; the other five have caught up and read a window or two a run, so it costs them nothing.

## The faster catch-up, in a separate pull request

The budget was shared evenly, so Celo had 5 seconds a run while the five chains that have caught up spend a fraction of theirs, and most of the 30 seconds went unused during the catch-up. The operator said "faster ratings": a chain that is behind now takes what the chains before it left, about 24 seconds a run instead of 5, which brings the catch-up from eight to ten days to about two (measured on the real node: four runs at 24 seconds read 408 windows). That is a change to the shared step, a few lines in `runChainRatings`, so it is its own pull request, described in [the ratings record](./extra-chain-ratings-2026-10-21.md) (update 2026-11-20). This change does not depend on it: without it the figure appears in eight to ten days.

## Held by a test

- `server/ingestion/erc8004Chains.test.ts` and `server/chainRatings.integration.test.ts`: the registry is named on Ethereum, Base, Arc, Monad, Gnosis and Celo, Celo's window is 5,000 blocks and no wider than the node answers (`maxLogRange`), and the entries are sound (`validateErc8004Chains`). The integration test runs on MySQL 8.4 and on MariaDB 10.11.
- Planted bugs: three, each caught by three tests. A window of 50,000 blocks, the identity registry's address in place of the reputation registry's, and no registry named.
