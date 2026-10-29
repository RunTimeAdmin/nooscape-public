# Claim this agent, for Arc

The claim flow ([docs/claims-2026-10-18.md](./claims-2026-10-18.md)) opened to the owners of agents on Arc. One new server module, one new switch, and a few lines in the flow and the page. No migration, no new table and no new setting: it uses the three claim tables (migration 0042) and the Arc node the identity pass already reads.

**Status.** Shipped in PR 178 on 2026-10-20, after the watchlist, and on in the live build (`claims_arc` is named in `VITE_FEATURES`, checked 2026-10-28).

**Decided:** 2026-10-20, by the operator, in chat: "Owl's Catch, watchlist, claims are good to add   lets finish the ARC arc so to say", and "do it all in one pr". The operator asked for claims on Arc. That everything lands in one merge is why the claims have a switch of their own: see below.

## The switch

`claims_arc` (`shared/features.ts`). Arc's agents can be claimed only while **`chain_arc` and `claims_arc` are both on**; the panel itself is still `claims`. So a production list that reads `claims,chain_arc` does **not** open claims on Arc when this merges. To open them: add `claims_arc` to `VITE_FEATURES`, build and restart (the page needs the build, the server the restart, and both read the same list). Taking it out again closes them.

Why a switch and not "claims plus Arc": the claim flow asks for a signature, reads a chain to decide who owns an agent, and the Privacy page says what it does. With the whole Arc work in one merge, a switch is how the operator keeps the order: the pages, the lights, the card, the census, the "just arrived" lines, the Owl's Catch and the watchlist go live with the merge, and the claims go live when the operator has read this and decided to.

## What changes

- **The chain.** `CLAIM_CHAINS` gains Arc: chain id 5042, the identity registry, label "Arc". `claimChainOf(protocol)` returns it only while the switches are on, so everything that asks "can this be claimed?" (the entry lookup, the message, the page's state, the daily check) answers no for an Arc agent while they are off, with the words it uses for any entry that cannot be claimed.
- **The words for an entry that cannot be claimed** name the registries that can: "Only agents on the Robinhood Chain and BNB Smart Chain registries can." as before, and "Only agents on the Robinhood Chain, BNB Smart Chain and Arc registries can." while Arc's claims are on.
- **The message to sign** is the same sign-in text, with `Chain ID: 5042` and the Arc registry and token as its resource (`eip155:5042:<registry>:<token>`). Nothing else in it changes.
- **The entry.** An Arc agent can be claimed only if the public can see it, as for the others, so a registration the listing rules hold out has no claim. The key must name exactly Arc's registry on Arc's chain.
- **The fleet rule** counts the visible Arc entries of the wallet and of the wallet the entry was registered by, as for the others (`countVisibleEntriesOfRegistrant` takes Arc's protocol). On Arc this rarely bites: the wallets that registered most are held out by the listing rules, so an agent that is listed is from a wallet with few registrations.

## The read of Arc

A claim asks the chain three things and nothing else: who owns the agent now (`ownerOf`), whether a wallet is a contract (`eth_getCode`) and whether a contract wallet accepts a signature (EIP-1271, `eth_call`). For Arc these go to `server/claimsArc.ts`:

- **The node** is the operator's own, reached through `X402_RPC`, as the identity pass and the payment code reach it (`server/arcRpc.ts`). It is read as they read it: trimmed, https only. The address may carry a key. **Nothing here puts it, or any part of it, in an error or a log line**, because the client is the pass's (`callRpc`), whose messages are fixed text and whose provider text is scrubbed of the address, its host, its path and long tokens (a test feeds it the address and the key in the node's error text and checks neither comes out).
- **One attempt, no retry ladder.** The pass retries a busy node three times over seven seconds. A visitor waiting on a claim should not, so the Arc read uses the pass's client with its ladder emptied, as the Robinhood Chain read is one attempt. A read that fails is "try again" to the visitor and never a verdict on a claim.
- **A node that is Arc, public and at the head.** A claim decides who owns an agent from what this node says, and the node's address is also the payment code's setting, so it is held to more than the pass holds it to (the pass has a source row and a run to check it against). Before a read it must (1) resolve to a public address, as the pass requires before every run (`assertPublicHostname`); (2) answer `eth_chainId` as `0x13b2`, because the registry has the same address on every chain it runs on, so a node for another chain, or Arc's testnet, would answer for another chain's token; (3) have a latest block no more than ten minutes old, because a node that is resyncing or was restored from an older copy answers from the past, and a token minted or sold since would read as gone or as its old owner's, which would end a real claim on two readings that come from the same stale node. The first two are kept for ten minutes (and made again for another host), the third for a minute, and a failed check is not kept. Any of them failing is "try again". Each failure is fixed text, so nothing the node says can reach a caller, and none of it can be read as a revert. Since 2026-10-29 a latest block dated more than two minutes ahead of the server's clock is refused too, a check that looks as if it was made in the future (the clock went back) is made again, and the head is kept per host ([the second outside review](./outside-security-review-2026-10-29.md)).
- **A gas limit on what a visitor can make it run.** A visitor chooses one thing the node executes: a contract wallet's `isValidSignature`. An `eth_call` is given 3,000,000 gas, and `ownerOf` on the registry 200,000, so a wallet that burns what it is given costs the node a bounded amount, not whatever its own limit allows. A call that needs more fails as an outage.
- **The same budget as the others.** A visitor's reads of Arc are held to 60 a minute and refused as "try again" past that, without asking the node; the daily check has no such cap. A revert (a token that does not exist, which the node answers in the EVM's own words) is an answer: no owner. A bad key, a missing method, a throttle or a timeout is an outage and can never end a claim, as for the other chains. (Arc's client keeps the node's words and not the JSON-RPC code, so a revert with no words would read as an outage, which fails safe; the real node says "execution reverted".)
- **Checked against the real node,** read-only, with the address read in-process and never printed, again after the checks and the gas limits above were added: the claim flow's own call answered the owner of tokens 1 and 2, a revert for a token that does not exist, "is a contract" for the registry and "is not" for a bare address, in about 0.7 seconds for the lot.

## The daily check

The daily step asks the registry who owns each claimed agent. Two things changed.

- **It selects only claims on a chain whose claims are on.** Before, a claim on a chain it could not ask about would be skipped one at a time, and one that stayed the oldest due would be selected again at every run: with 25 or more of them (the limit of a run) the check would have stopped reaching any other claim. Taking Arc's claims out (the switch off) therefore leaves them alone and does not use up the run; a test holds this. A claim made on Arc while the switch was on is kept, and is checked again from the day the switch returns.
- **A chain that cannot be read no longer stops the check for the others.** The check used to stop at the first claim whose chain could not be read. The claims are taken oldest first across every chain, so with Arc's node down (it is the operator's own, not a hosted endpoint) an Arc claim would stay the oldest due and every run would stop on it, and no Robinhood Chain or BNB Smart Chain claim would be asked about until the node came back. Now the chain is left out for the rest of the run and the next oldest claims on the other chains are taken instead. `unavailable` in the run's result counts the chains that could not be read (it was always 1 or 0), and `stoppedBy` is "chain" when there was one.

## What the pages say

- **Terms.** Unchanged: "the owner of an agent in a public registry" already covers Arc.
- **Privacy.** The sentence that names the chains ("The owner of an agent on the Robinhood Chain or BNB Smart Chain registry can claim it by signing one message with their wallet...") is untouched, and **one sentence is added only while Arc's claims are on in the build**: "The owner of an agent on the Arc registry can claim it in the same way." The page's date reads 20 October 2026 while it is there and 19 October 2026 when it is not, because the text it describes is the text on the page. Nothing else in the section changes: what is kept for a claim is the same for Arc. This is the only legal wording the change touches, and it adds a chain to a list rather than a clause. The operator's review of it is the open point.
- **The panel** says "If you own this agent's registration on Arc, you can claim it", in the other chains' words, on an Arc agent's page while the switch is on, and is not there otherwise. The claim history, the owner's text and the operator's hold work as for the others.

## What does not change

A claim is still the owner's own word and never a tier, a review, a rating or a score. It changes nothing about whether an Arc registration is listed, where it sits, any count, the lights, the census or the Owl's Catch. The flow still cannot write a field it does not own, and the claim code still names no tier, state, listing flag or score (the tests that hold this run over the new module too). Payment has no part in it.

## Held by a test

- `features.test.ts`: the switch list, and `arcClaimsOn` (both named, in any case or order, and each of the two alone is not enough).
- `claimsChain.test.ts`: Arc's chain id, registry and label; Arc claimable only while both switches are on, in any case or order and not for a look-alike name, and the first two always; the list read from the server's switches when none is given; the production call on Arc (the node's client called once, a revert from the node's own words, a timeout or HTTP error or throttle or bad key as an outage, the worker's call with no budget, a visitor's reads held to 60 a minute without asking the node).
- `claimsArc.test.ts`: one request to the address in `X402_RPC`, no redirect followed, one attempt for a status the pass would retry and for a busy node, a revert in the node's words, no address, key or host in anything thrown (including from the node's own error text), a refusal when the node is not configured or is not https, the public-host check made once and again for another host and for none after a failure, the chain id asked first (a node for another chain refused before the call, a failed check not kept, the answer kept for ten minutes), the latest block no more than ten minutes old (refused when older or unreadable, looked at about once a minute), the gas limits on `eth_call`, and every failed check being fixed text that can never be read as a revert.
- `claims.integration.test.ts` (real MySQL, real signatures, a fake chain): an Arc agent cannot be claimed under any partial list, and the refusal names the registries; with both switches on, the message carries Chain ID 5042 and the Arc registry, the claim is written with Arc's protocol, chain, registry and token, every read of the chain is on Arc, and the page is told it can be claimed; a wallet the registry does not record as the owner is refused (and the owner's edit is taken); a held-out registration, a wrong registry and a wrong chain are not claimable; and the daily check ends a claim when Arc shows a new owner, while with the switch off it neither asks Arc nor lets an Arc claim take the place of one it can check; and with Arc's node down the claims on the other chains are still asked about, and Arc's claim is left as it was and found in order when the node is back. `registryFleets.integration.test.ts` and `apiWebhooks.test.ts` hold the two small fixes from the review below (a registration whose host moved to a suppressed domain is not counted in a group, and a watch on a chain that is not served names no registry).
- `claimFlow.test.ts` and `legalPages.test.ts`: the panel names Arc only while both are on in the build, the Privacy sentence for the first two chains is as it was, the new sentence is conditional and its date goes with it, and the claim code and the page ask the same question.
- Each guard was broken once to confirm a test fails: Arc needing only its own switch (five tests fail), the daily check taking claims it cannot ask about (one), the revert handling removed (two), and, after the review below, no chain id check (one), no head check (two), no gas limit (one) and the daily check stopping at the first unreadable chain (one).

## The independent review

A read-only security review of the whole Arc change, by an agent that was given the diff and a threat model and not my conclusions, found nothing that lets anyone claim, edit or keep an Arc claim without owning the agent, and nothing that leaks the node's address. It found five things on the claim path that depend on the node or on what a visitor can make it run. Four are fixed in this change, and none of the four could be reached while `claims_arc` is off:

| Finding | What changed |
|---|---|
| The read trusted whatever chain `X402_RPC` served. A node for another chain (the payment code's testnet, or another provider) would answer for another chain's token, since the registry has the same address on every chain. | The node must answer `eth_chainId` as Arc before it is used. |
| A node that is behind (resyncing, or restored from an older copy) gives the same wrong answer on both readings the check takes before ending a claim, so valid claims could be ended, with a permanent public history row. | The node's latest block must be no more than ten minutes old, or the read is "try again". |
| A visitor can name a contract wallet that burns the gas it is given, and the per-minute cap does not bound the cost of each call on a node the operator shares with payments and the pass. | Gas limits on every `eth_call` (200,000 for `ownerOf`, 3,000,000 otherwise). |
| One chain that cannot be read stopped the daily check for every chain, and a self-run node is likelier to be down than a hosted one. | The chain is left out for the rest of the run (above). |

Left as they are, and said here so they are not a surprise:

- While `claims_arc` is off, an operator's hold or removal of an Arc claim's text would still be sent as a `claim.changed` event to a key that watches the agent, though the claim history answers empty for it. There are no Arc claims to hold unless the switch has been on.
- When `claims_arc` returns after being off, Arc claims show as active at once, even if nobody has asked the registry about them for weeks, until the daily check reaches them. The page shows when each was last asked.
- The `claims` switch only hides the panel: the server accepts claims through a direct call to its public procedures whatever `claims` says, as it did for Robinhood Chain and BNB Smart Chain, and with `chain_arc` and `claims_arc` on that now includes Arc.
- A visitor can still make the node do one bounded call per read, up to 60 a minute. A single read in flight at a time for visitors would bound it further and has not been added.

## Checked

On the built server against a scratch database with a registry in Arc's shape and the claim tables pasted, in headless Chrome at 1440 and 375 pixels. With `claims,chain_arc,claims_arc`: an Arc agent's page shows the "Claim this agent" panel with Arc's name and a "Connect a wallet" button, no horizontal overflow and no console error, `claim.state` says it can be claimed, and the Privacy page has the added sentence and the new date. With `claims,chain_arc`: the same page has no panel, `claim.state` says it cannot be claimed, `claim.nonce` is refused with the words naming the two registries, and the Privacy page is as it was. Not done: a claim signed by a real wallet on Arc (no wallet was connected here; the signature, nonce and ownership logic is the flow's own and is held by the tests above).

## To turn it on, and off

1. Add `claims_arc` to `VITE_FEATURES` on the host (`claims,chain_arc,claims_arc`), build and restart.
2. Check: an Arc agent's page shows the panel; `claim.state` for it says it can be claimed; the Privacy page carries the Arc sentence.
3. To stop: take `claims_arc` out, build and restart. Claims already made are kept and are checked again from the day it returns.
