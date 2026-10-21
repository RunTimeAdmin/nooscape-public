# Decision record: counting the ratings of Ethereum, Base and Arc

**Decided:** 2026-10-21, by the operator, in chat. He pasted the Arc tile ("Ratings recorded: not measured here") and asked why, then said "lets start reading
the registry for reputation, why are we not doing it". The reason, given to him: the multichain stages listed reputation and feedback for the new chains as
not in them (identity first, facts only), as BNB Chain's ratings came after its identity pass and stayed internal. No technical limit.
**Changes:** one more step of the worker (`server/chainRatings.ts`) that counts the NewFeedback and FeedbackRevoked events of the ERC-8004 reputation registry on
Ethereum, Base and Arc; one small table, `chain_reputation_counts` (migration 0048, applied at boot); a `reputation` field on those three chain entries; the
"Ratings recorded" figure of those chains' tabs and pages, which shows the count once the read has reached the finalized head.
**Does not change:** a record, a score, a tier, an evidence level, the listing, the map, the search, the API, BNB Chain's tab (still "not measured"), Robinhood
Chain's and Solana's figures, or any entry page. Nothing is stored per event or per agent.

## What the operator is asked to approve

1. **Reading each chain's reputation registry** through the host its identity source already uses (Alchemy for Base, his node for Arc, NodeReal for Ethereum),
   read only, `eth_getLogs` for two events, from the identity registry's deploy block to the finalized head. For Arc that is one request at a time with the
   chain's 250 ms gap; the whole history is 138 windows.
2. **Counting and keeping nothing else.** The figure is a count of the registry's own events; the registry can be asked again.
3. **The figure's meaning.** NewFeedback events, revoked ones included (the note under the figure already says so). The revocation count is kept and shown nowhere.
4. **The figure appears when a chain has caught up**, not before: a partial count is never shown.

## What I chose, so he can say no

1. **Counts, not a ledger.** BNB Chain's rater work keeps every event (29,995) and works out which raters count. Base's registry gains about 13,000 events a day, and a
   platform that rates at scale could grow a ledger as Central City grew the registry rows on 21 October. A count cannot. The cost: no per-agent ratings on entry pages
   and no rater check for these chains until he asks for that, and then it would need a cap like the host cap.
2. **Base and Ethereum are in, not only Arc.** The code is the same and the entries are three lines each. Ethereum's switch is off, so it reads nothing. Base reads
   through his Alchemy plan: about 224 windows of 50,000 blocks for the sparse years plus halvings in the dense days, a few hundred calls once.
3. **BNB Chain's tab is not changed.** Its ledger exists, and showing its count would be a one-line change, but B4 made those ratings internal and that is his to
   reverse.
4. **The window sizes**: Ethereum 50,000 (NodeReal's ceiling), Base 50,000 (Alchemy answers any range of 10,000 logs or fewer, and a result-size refusal halves the window),
   Arc 100,000 (the identity pass's own window on the same node).
5. **At most once in 30 minutes for a chain, 30 seconds for the step, split evenly**, so the long first read of Base cannot keep Arc waiting.
6. **A provider answer that is not what was asked for stops the window** and keeps the position, instead of being counted or skipped, because a figure that is wrong by
   one is worse than one that waits.

## What stays for later, and for the operator

- Per-agent ratings on entry pages, a rater check and the ResponseAppended replies for these chains; BNB Chain's figure; the ValidationRegistry.
- Nothing to paste: the boot runner creates the table. If production's migration log held a 48 the table would not be created and the figure would stay "not
  measured" (the host cap's 0047 met this on 21 October); `SELECT version, name FROM nooscape_schema_migrations ORDER BY version DESC LIMIT 5;` shows it.

## Outcome

See `docs/extra-chain-ratings-2026-10-21.md`.
