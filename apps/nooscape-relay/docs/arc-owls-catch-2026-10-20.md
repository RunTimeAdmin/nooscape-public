# The Owl's Catch for Arc

Rules, words and the reads that serve them. No migration, no new table and no new worker step: the daily choice and the stored row are the ones [the Owl's Catch](./owls-catch-2026-10-15.md) already has.

**Status.** Built and tested on a local branch (`feature/arc-catch`), after the arrivals. Not shipped.

**Decided:** 2026-10-20, by the operator, in chat: "Owl's Catch, watchlist, claims are good to add   lets finish the ARC arc so to say". The shape of the answer is mine.

## What changes

The Owl's Catch has two rules: a round number a chain has just passed, and the registering wallet with the most visible identities. Only the first can say anything about Arc, so only the first is extended.

- **A round number Arc has just passed.** While `chain_arc` is on, the day's choice looks at Arc's counts as it does at the other chains': its acknowledged entries (the entries the directory lists) and its reviewed records (none yet), against 10, 25, 50, 100, 250, 500, 1,000 and so on, under the same rules (still under 1.25 times the number, never said before for that chain and metric, nothing lower than one already said). The headline is "Arc has passed 250 acknowledged entries." and the detail is "The count is 252 under the public rules." The words are the other chains' own.
- **Nothing is said for a number Arc passed before the switch was on.** Arc listed 246 entries on its first pass, so it has passed 100 long ago and has not reached 250. The first Arc catch is for 250, on a day when the count stands at 250 or a little over it (under 312, which is 1.25 times 250), and not before or after. A count that jumps past two round numbers at once is said once, for the higher.
- **Ethereum and Base come with it.** The rule is for the extra chains, not for Arc alone: each extra chain whose switch is on is read, so Ethereum and Base can have a catch the same way once their switches are on.

## What does not change

- **The fleet rule.** It reads the registering wallets with 50 or more visible identities, and stores up to 20 of the fleet's entries to link to. On Arc the wallets that registered most are held out by the listing rules, so none of their registrations is a visible entry, and a fleet with nothing to link to is never stored (the Owl's Catch passes it over). Arc therefore has no fleet catch, and its largest groups are on the Arc page and in [the census](./arc-census-2026-10-20.md) instead. A catch about a group that has no entries to link to would be a new rule with its own words and its own page, and a decision about naming a wallet whose registrations the rules hold out. It is not built.
- **What a catch never does.** It is still a count that says what it is, never what it means. No score, no rank, no ordering of chains.

## While the switch is off

Nothing of Arc is chosen and nothing of Arc is shown.

- **Choosing.** The worker's daily read of the chains' counts (`defaultCatchDeps.readChains`) adds the extra chains whose switch is on and no others, so with `chain_arc` off Arc is not a candidate.
- **Reading.** A stored catch about an extra chain is served only while that chain's switch is on (`viewOf(row, features)` in `shared/owlsCatch.ts`). With it off, the day reads as one with no catch: the home card's "latest", the archive at `/catch`, the day's page (404 with the head of a day with none) and the three public procedures all leave it out, as for a fleet whose entries have been hidden. The row is kept, so the day is not lost: it comes back when the switch is turned on again.
- **Parsing.** The facts a catch is stored with accept the extra chains' names as well as the original three, and nothing else.

## Held by a test

- `server/owlsCatch.test.ts`, with no database: Arc's round numbers (found after the original three's, none when the caller gives no row for the chain, skipped when not indexed or not measured or under ten, not repeated, the next one said, another chain's not counted), the candidate with its read ahead of a fleet, the words in the chain's own name, and `viewOf` showing an extra chain's milestone only while its switch is on in the list given (in any case or order, and not for `chain_arcade`) while the original three always show.
- `server/owlsCatch.integration.test.ts`, against a real MySQL: with 252 visible Arc entries, no catch is chosen while the switch is off and the day is stored as none; with it on, the first call stores a milestone with the facts and no entries to link to, a second day says nothing new; and the stored day is read back by its date, in the archive, as today's catch and through the public procedures only while the switch is on, and `/catch/<date>` is sent as 200 with it on and 404 with it off. Each of the guards was broken once to confirm a test fails.

## Checked

Against a real MySQL (the tests above) and by breaking each guard in turn: with the switch check in `viewOf` removed three tests fail, and with the server's read of the extra chains removed two fail.
