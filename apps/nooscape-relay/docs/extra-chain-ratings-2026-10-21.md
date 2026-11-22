# Ratings on Ethereum, Base and Arc (21 October 2026)

Update 2026-11-01: Monad's reputation registry is read by the same step ([the record](./monad-ratings-2026-11-01.md)).

Status: built, with the tests below. A step of the worker counts the NewFeedback and FeedbackRevoked events of the ERC-8004 reputation registry on
each chain the identity pass reads beyond BNB Chain, and the chain's "Ratings recorded" figure shows the count instead of "not measured" once the
read has reached the finalized head. The decision is in `docs/approvals/2026-10-21-extra-chain-ratings.md`.

## Why it was not there

The multichain stages (`docs/multichain-erc8004-2026-10-20.md`) read the identity registries only. Their list of what was left out names "the
ValidationRegistry, reputation and feedback for the new chains", as BNB Chain's ratings came after its identity pass, as a stage of their own
(`docs/bsc-rater-credibility-2026-10-16.md`), and stayed internal. Nothing technical stood in the way: the reputation registry is a contract at the
same address on every chain, and the pass already knew how to read a registry's events.

The operator looked at the Arc page on 2026-10-21, where "Ratings recorded" said "not measured", and asked for the registry to be read. Arc's
registry holds 603 NewFeedback and 6 FeedbackRevoked events (counted by hand through the operator's node, from block 20,817,594 to 27,000,664).
Base's holds a great deal more: about 3,000 events in one 10,000-block window (5.6 hours) on the same day. Ethereum's explorer lists 3,134
transactions to it.

## What it does

`server/chainRatings.ts`, run by the worker after the SAID names, on a tick that claimed sources and is under 100 seconds old, at most once in 30
minutes for a chain, within a shared budget of 30 seconds (an even share for each chain, so a long history on one cannot starve another, and a chain also gets the time
the chains before it left unspent: see the update of 2026-11-20 at the end):

1. For each chain whose entry in `server/ingestion/erc8004Chains.ts` has a `reputation` (registry address and window), whose switch is on and whose
   identity source is active, it opens the chain's node through the same host as the identity pass, checks the chain id, and reads the finalized block.
2. From the block it has read to (the identity registry's deploy block on the first run), it reads `eth_getLogs` for the two events in windows of the
   chain's size, and halves a window the provider calls too large. A log of any other kind, from another address, outside the window or without the
   four topics both events carry stops the window: it is not counted and the position is kept.
3. It adds each window's two counts to `chain_reputation_counts` and moves `nextBlock` past the window in **one statement conditioned on
   `nextBlock` still being where the window started**. A window is therefore counted once however often it is read, and two runs cannot both count it.
4. The first time a window reaches the finalized head it sets `caughtUpAt`. Until then the figure is "not measured", not a smaller number.

Nothing is kept per event. A platform that rates at scale cannot grow the table, which is three rows long. The registry is the source of truth and a
count can be made again from it. The table has no ledger, so nothing says who rated whom: that is for a later stage if it is wanted.

The figure is the count of NewFeedback events. A rating that was later revoked is still one of them, which is what the note under the figure says
("Ratings written on-chain, revoked ones included. Not a score."). The count of revocations is kept beside it and shown nowhere yet.

`liveData.chainStats` reads the counts (`readChainRatings` in `server/db.ts`, cached like the other aggregates) into `chainFeedback`, and the shared
builder gives each chain its own. The Home tab and the chain page needed no change: they print the number when the server sends one.

## What it does not do

- It reads no ratings per agent, so an Arc entry page says nothing about ratings yet. It checks no rater (BNB Chain's rater check is internal and
  stays so), and it reads neither the ValidationRegistry nor the ResponseAppended replies.
- BNB Chain's tab still says "not measured". Its own ledger holds 29,995 events, but the decision that made them internal (B4) is the operator's to
  change. Showing that count is a one-line change in the same place.
- It does not change a score, a tier or the listing; there are none.

## Files

- `drizzle/0048_chain_reputation_counts.sql`: one `CREATE TABLE IF NOT EXISTS`. Not in `MANUAL_MIGRATIONS`, so the boot runner applies it. Production's
  migration log held 43 to 47 when this was written, so 48 is free (the host cap's 0047 was skipped because the log already had a 47; see
  `docs/flood-host-cap-2026-10-21.md`). The step also survives the table's absence: it does nothing and says nothing, and the figure stays "not measured".
- `server/chainRatings.ts` (the step and `countRatingLogs`), `server/ingestion/worker.ts` (one more step), `server/ingestion/erc8004Chains.ts`
  (`reputation` on Ethereum, Base and Arc, and its check), `server/db.ts` (`readChainRatings`), `shared/chains.ts` (`chainFeedback`).
- Tests: `server/chainRatings.integration.test.ts` (a real database, also run on MariaDB 10.11), `server/chainRatings.test.ts`,
  `server/extraChains.test.ts`, `server/ingestion/erc8004Chains.test.ts`.

## What was checked

- The step against the real Arc node, into a scratch database (read only, through the operator's node, one request at a time with the chain's gap):
  138 windows of 100,000 blocks in 70 seconds, **603 ratings and 6 revocations**, caught up at block 27,115,621. That is the same as the hand count.
- The real-database test: each event counted once across windows and runs; nothing shown before the head is reached; the gap between runs; a lost race
  counts a window once; a result-size refusal halves a window and the count stays exact; four kinds of fault stop the window with the position kept;
  a wrong chain id; Base and Arc read on their own positions; a chain whose switch is off or whose source is paused is not opened; a tick that has run
  too long; the time budget; the figure reaching the chain stats; the table missing.

## How long the first read takes, and what to look at

The history is read once. Arc is 138 windows (about 70 seconds of reading, so two or three runs of the step). Base is about 224 windows of 50,000 blocks
in the sparse years and more in the dense recent days; the budget gives each chain half of 30 seconds, so allow several hours. Ethereum is not on.
Until a chain catches up its figure says "not measured". After that it moves up with each run.

`liveData.sourceStatuses` does not show this step. It logs one line when it counts (`nooscape_chain_ratings`: chain, windows, ratings, revocations,
`nextBlock`, `caughtUp`) and one when it fails (`nooscape_chain_ratings_failed`). To read the state:

```sql
SELECT chainKey, ratings, revocations, nextBlock, caughtUpAt, lastRunAt FROM chain_reputation_counts;
```

If Base's node refuses the window with something that is not a result-size answer, the run fails, the position is kept and the figure stays "not
measured"; the failure line has the reason.

## Update 2026-11-20: a chain that is behind gets the time the chains before it left unspent

The budget gave every chain a fixed share, whatever the others used. A chain that has caught up needs about a second (the chain id, the finalized block and a window), and one that is waiting for its 30-minute interval needs none, so most of the 30 seconds went unspent while a chain with a long history read for its share alone. Celo showed it: the history of its reputation registry is 4,981 windows of 5,000 blocks (the most its node answers), and at an even share of six chains (5 seconds a run, about 12 windows) the first read would take eight to ten days. The operator said "faster ratings".

A chain now gets its even share and, besides, what the chains before it left unspent: its allowance is the larger of its share and the time left in the budget divided by the number of chains still to read (`runChainRatings` in `server/chainRatings.ts`). The chains are read in the order of the list in `server/ingestion/erc8004Chains.ts`, the newest last, so a chain added later, which is the one that is behind, comes after the chains that have caught up and reads for most of the budget. When every chain has a long way to go the split is even, as it was. No chain gets less than its share, so a chain that overran does not cost a later one what it had before. The budget is still 30 seconds a run and a chain still reads at most once in 30 minutes, so the step as a whole reads for no longer than before. Only the chain that is behind reads more, and only until it has caught up: for Celo's public node that is about 24 seconds of requests in 30 minutes instead of 5, for about two days.

Measured on 2026-11-20 against the real Celo node (read only, from the operator's PC, into a scratch database): four runs at a 24-second budget, which is what Celo gets when the five chains before it need about 6 seconds between them, read 408 windows, between 76 and 114 a run. The first windows of the history are nearly empty, so that is above the history's average, which was about 12 windows in 5 seconds in the full read of the same day (4,981 windows in 406 runs). At that average, about 2.5 windows a second, a 24-second run reads about 60 windows and the 4,981 take about 84 runs: 42 hours at one run in 30 minutes, a little under two days, against eight to ten. If the five chains before it need 15 seconds, it is under three days.

Held by three tests in `server/chainRatings.integration.test.ts` (a fake clock, real MySQL and MariaDB): a chain after one that is at its head reads for the whole minute (six windows where an even share gives three); a chain still gets its even share when the one before it used more than its own; and two chains that both have far to go split the time evenly. Eight planted changes (an even share only, no floor, a floor that is a ceiling, the left-over divided by every chain or taken whole by the first, a budget that ends a share after it starts, a share worked out over one chain too many, and every deadline set to the end of the budget) were each caught.
