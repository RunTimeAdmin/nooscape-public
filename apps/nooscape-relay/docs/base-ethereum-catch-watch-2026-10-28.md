# The Owl's Catch, the watchlist and the webhook on Base and Ethereum

Tests, no code change. The operator's brief of 2026-10-28 ("do these next  Base and Ethereum extras: map lights, census, claims and the Base Owl's Catch and watchlist; the AgenC page") listed the Base Owl's Catch and watchlist among what was left, and the to-do list said so (items 128 and 143: "not built"). Reading the code showed they were not missing. Only nothing held them.

**Status.** Tests only. Shipped in PR 223 on 2026-10-28. No migration, no setting and no change to any behaviour.

## What was already there

- **The Owl's Catch.** A round number a chain has just passed is a candidate for the day's catch for the original three chains and for every extra chain whose switch is on (`MILESTONE_CHAINS` in `shared/owlsCatch.ts`, the extras read by `server/owlsCatch.ts` while `extraChainsOn(VITE_FEATURES)` lists them). A catch about a chain is shown only while that chain's switch is on.
- **The watchlist and the webhook.** They cover every chain the API serves (`servedChains()` in `server/apiChains.ts`), which is the original three and each extra chain while its switch is on. [The Arc record](./arc-watch-2026-10-20.md) says so ("Ethereum and Base come with it"), and so does the comment in `shared/chains.ts`. The events an agent on one of them causes (`ownership.changed`, `claim.changed`, `listing.removed`, `listing.restored`) are told in the chain's own name, and a hand-out is judged by the chain's own mint hour (`handoutBlockWindow` in `server/ingestion/erc8004Chains.ts`: 1,800 blocks on Base, 299 on Ethereum).
- **"New to the Owl".** The same: every extra chain that is on is in it.

## What was missing: tests

Arc had tests for the Catch, the watchlist and the webhook and Base and Ethereum had none, so nothing would have failed had either been left out. ("New to the Owl" is left as it is: its arithmetic takes the extra chains as a list, `shared/arrivals.ts`.) Added, for each of the two:

- `owlsCatch.test.ts`: the round numbers its row has just passed, said after the original three's and in the order Ethereum, Base, Arc; nothing for a chain with no row, one that is not indexed or one whose count is not measured; a round number not said twice and the next one said; another chain's does not count; the words in the chain's own name; and a catch about it shown only while its own switch is on, with no other chain's switch showing it.
- `owlsCatch.integration.test.ts` (real MariaDB): with 252 visible entries on the chain, the day's catch is "<chain> has passed 250 acknowledged entries." only while its switch is on, said once, and read back by its day, in the archive, as today's catch and through the public procedures only while the switch is on.
- `apiWebhooks.test.ts`: a listing watched only while the chain's switch is on and no other chain's switch opens it, each refusal's words with the list of chains it names, the answer held to the document with the chain in it, the list naming the chain while it is on and no chain once it is off, and the watch still removable.
- `webhookPass.test.ts`: a listing's ownership and claim events in the chain's name, nothing with the switch off and no record of a change of view, and `listing.removed` and `listing.restored` while it is on.
- `webhookStore.integration.test.ts` (real MariaDB): the hand-out flag by the chain's own hour, a transfer 1,500 blocks after a Base mint a hand-out and 2,000 not, one 250 blocks after an Ethereum mint a hand-out and 400 not (Robinhood Chain's 36,000 would call all four hand-outs).

Two guards were broken once to confirm a test fails: the Catch leaving Base and Ethereum out of its chains (13 tests fail) and the hand-out hour not being the chain's own (2).

## What the tests found

Nothing wrong: they passed on the first run, so the code needed no change. The to-do list's "not built" for these (items 128 and 143) was out of date, and item 148 says so.
