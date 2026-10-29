# Claim this agent, for Base and Ethereum

The claim flow ([docs/claims-2026-10-18.md](./claims-2026-10-18.md)) opened to the owners of agents on Base and on Ethereum, the way [it was opened to Arc's](./arc-claims-2026-10-20.md). Two new switches, one shared module for reading a chain's node, two chain entries and a few lines in the flow and the page. No migration, no new table and no new setting: it uses the three claim tables (migration 0042) and the endpoints the two identity passes already read (`BASE_RPC_URL` and `ETH_RPC_URL`).

**Status.** Shipped in PR 223 on 2026-10-28, after the Ethereum census, and **off until the operator adds `claims_base` and `claims_ethereum` to `VITE_FEATURES`**, each on its own.

**Decided:** 2026-10-28, by the operator, in chat: "do these next  Base and Ethereum extras: map lights, census, claims and the Base Owl's Catch and watchlist; the AgenC page". The shape of the answer is mine, chosen to follow Arc's claims, so the operator can say no to any of it.

## The switches

`claims_base` and `claims_ethereum` (`shared/features.ts`). Agents on Base can be claimed only while **`chain_base` and `claims_base` are both on**, and agents on Ethereum only while **`chain_ethereum` and `claims_ethereum` are both on**; the panel itself is still `claims`. One chain's switches open no other chain: a list that reads `claims,chain_arc,claims_arc,chain_base,chain_ethereum` (the production list on 2026-10-27) opens claims on Arc and on neither of these. To open one: add its claims switch to `VITE_FEATURES`, build and restart (the page needs the build, the server the restart, and both read the same list). Taking it out again closes them.

The reason for a switch each is Arc's: the flow asks for a signature, reads a chain to decide who owns an agent, and the Privacy page says what it does. Base's pages, lights and census go live with the merge, and its claims go live when the operator has read this and decided to; the same for Ethereum.

## What changes

- **The chains.** `CLAIM_CHAINS` gains Base (chain id 8453, label "Base") and Ethereum (chain id 1, label "Ethereum"), each with the identity registry's address. `claimChainOf(protocol)` returns one only while its two switches are on, so everything that asks "can this be claimed?" (the entry lookup, the message, the page's state, the daily check) answers no for an agent on it while they are off, with the words it uses for any entry that cannot be claimed.
- **The words for an entry that cannot be claimed** name the registries that can, in the order Robinhood Chain, BNB Smart Chain, Arc, Base, Ethereum, each only while its claims are on: "Only agents on the Robinhood Chain, BNB Smart Chain and Base registries can."
- **The message to sign** is the same sign-in text, with `Chain ID: 8453` or `Chain ID: 1` and the chain's registry and token as its resource (`eip155:8453:<registry>:<token>`). Nothing else in it changes.
- **The entry.** An agent can be claimed only if the public can see it, as for the others, so a registration the listing rules hold out has no claim. The key must name exactly the chain's registry on the chain.
- **The fleet rule** counts the visible entries of the wallet, and of the wallet the entry was registered by, on the same protocol, as for the others. Most Base and Ethereum registrations come from wallets that registered 10 or more, and the listing rules hold those out, so an agent that is listed is from a wallet that registered fewer than 10 and the fleet rule (50) will rarely bite.

## The read of each chain

A claim asks the chain three things and nothing else: who owns the agent now (`ownerOf`), whether a wallet is a contract (`eth_getCode`) and whether a contract wallet accepts a signature (EIP-1271, `eth_call`). They go to the endpoint the chain's pass reads, through `server/claimsPinned.ts`:

- **One module for the checks.** Arc's claim node held the checks a claim needs of its node: it answers as the chain (`eth_chainId`), it is at the head (a latest block no more than ten minutes old), one attempt with no retry ladder, and a gas limit on what a visitor can make it run (200,000 for `ownerOf`, 3,000,000 for anything else). They are now in `server/claimsNode.ts`, which Arc, Base and Ethereum each build a node from. Arc's behaviour is unchanged: `claimsArc.test.ts` is untouched and passes as it was.
- **The address** is read as the pass reads it: `BASE_RPC_URL` (Alchemy) and `ETH_RPC_URL` (NodeReal) must be set, an https address with no credentials in it, and the host must be exactly the host the chain's entry pins, so changing a variable can never send a claim's reads to a host nobody approved. The address carries a key. Nothing puts it, or any part of it, in an error or a log line, and an address that is not usable is "not configured" in fixed words. A vendor's host is public and pinned in the code, so, unlike Arc's own node, it is not looked up again.
- **The same budget as the others.** A visitor's reads of a chain are held to 60 a minute and refused as "try again" past that, without asking the node; the daily check has no such cap. A revert (a token that does not exist, which the node answers in the EVM's own words, code 3) is an answer: no owner. A bad key, a missing method, a throttle or a timeout is an outage and can never end a claim.
- **The provider's bill.** A read costs the provider one call, and up to two more when the chain id (asked once in ten minutes) or the head (once a minute) is due. A visitor is held to 60 reads a minute for each chain and the daily check takes at most 25 claims a run. Neither provider plan's limits were looked at against that here, and the Base pass is the heaviest reader of its endpoint.
- **Checked against the real chains,** read-only, through public nodes (the production endpoints' keys are on the host): on both, `eth_chainId` answered `0x1` and `0x2105`, the registry's address holds code, `ownerOf` of an existing token answered one address word, and `ownerOf` of a token that does not exist reverted with code 3 and the words "execution reverted".

## The daily check

Unchanged from Arc's: it selects only claims on a chain whose claims are on, and a chain that cannot be read is left out for the rest of the run so the claims behind it on other chains are still asked about. A claim made on Base or Ethereum while its switch was on is kept when the switch goes off and is checked again from the day it returns.

## What the pages say

- **Terms.** Unchanged: "the owner of an agent in a public registry" already covers both.
- **Privacy.** The sentences that name the chains are untouched, and **one sentence is added for each chain only while its claims are on in the build**: "The owner of an agent on the Base registry can claim it in the same way." and the same for Ethereum. The page's date reads 28 October 2026 while either is there, and otherwise 20 October 2026 (Arc's claims on) or 19 October 2026, because the text it describes is the text on the page. This is the only legal wording the change touches, and it adds chains to a list rather than a clause. The operator's review of it is the open point.
- **The panel** says "If you own this agent's registration on Base, you can claim it", in the other chains' words, on an agent's page while its switches are on, and is not there otherwise.

## What does not change

A claim is still the owner's own word and never a tier, a review, a rating or a score. It changes nothing about whether a Base or Ethereum registration is listed, where it sits, any count, the lights, the census, the Owl's Catch or the watchlist. The flow still cannot write a field it does not own, and the claim code still names no tier, state, listing flag or score: the guard that holds this runs over the two new modules too. Payment has no part in it.

## Held by a test

- `features.test.ts`: the switch list, and `baseClaimsOn` and `ethereumClaimsOn` (each chain and its claims named, in any case or order, each of the two alone not enough, and the other chains' switches opening neither).
- `claimsChain.test.ts` (for each of Base and Ethereum): the chain's id, registry and label; claimable only while both switches are on and no other chain's switches open it; the list read from the server's switches when none is given; the production call (the node's client called once, a revert from the node's own words, a timeout or HTTP error or throttle or bad key as an outage, the worker's call with no budget, a visitor's reads held to 60 a minute without asking the node); and all the chains' claims together in the order the words name them.
- `claimsPinned.test.ts` (for each of Base and Ethereum): one request to the address in the variable, no redirect followed, no look-up of the host, the gas limits, one attempt for a status the pass would retry, a revert in the node's words, no address or key in anything thrown, a refusal when the variable is unset, is not https, carries credentials or names a host nobody approved, the chain id asked first (a node for another chain refused before the call, a failed check not kept, the answer kept for ten minutes), the latest block no more than ten minutes old, the head looked at about once a minute, every failed check being fixed text that can never be read as a revert, and the two nodes keeping their own checks.
- `claims.integration.test.ts` (real MariaDB, real signatures, a fake chain), for each of Base and Ethereum: the agent cannot be claimed under any partial list or another chain's switches, and the refusal names the registries; with both switches on, the message carries the chain id and the registry, the claim is written with the chain's protocol, chain, registry and token, every read is on that chain, and the page is told it can be claimed; a wallet the registry does not record as the owner is refused and the owner's edit is taken; a held-out registration, a wrong registry and a wrong chain's key are not claimable; and the daily check ends a claim when the chain shows a new owner, and with the switch off neither asks the chain nor lets the claim take the place of one it can check.
- `claimFlow.test.ts` and `legalPages.test.ts`: the panel names each chain only while both of its switches are on in the build, the Privacy sentences are conditional and their date goes with them, and the claim code and the page ask the same question. `claimsGuards.test.ts` runs over the two new modules.
- Eight guards were broken once to confirm a test fails: no chain id check (four tests fail), no head check (six), no gas limit (three), the host looked up for a vendor too (two), the host not pinned (three), Base not read (two), Ethereum not read (two) and Base claimable without its own switch (five).

## Not checked, and left as it is

- **No claim was made by a real wallet on Base or Ethereum.** No wallet was connected here, and the production endpoints are on the host, not on this machine. The signature, nonce and ownership logic is the flow's own and is held by the tests above; the contract's behaviour was read from public nodes as above. The first claim after the switch is on is the live check.
- **No independent review of this change.** Arc's had one, and its four findings are in the shared module. What this change adds on the claim path is small (two chain entries, two routes into the shared module, two switch names, the endpoints' address check), but a review of `claimsNode.ts` would cover Arc's claims too.
- **Smart-contract wallets** (a Safe is common on Base) sign through EIP-1271 and are accepted when the wallet answers the magic value on the chain; a counterfactual wallet (not deployed yet) is refused, as for the others. ERC-6492 is not supported.
- The two points Arc's record leaves as they are apply here as well: an operator's hold of a claim's text is still sent to a watching key as an event while the chain's claims are off, and a claim shows as active at once when its switch returns, until the daily check reaches it.

## To turn it on, and off

1. Add `claims_base` and/or `claims_ethereum` to `VITE_FEATURES` on the host (for example `claims,chain_arc,claims_arc,chain_base,chain_ethereum,claims_base,claims_ethereum`), build and restart. Read the Privacy sentences first.
2. Check: an agent's page on the chain shows the panel; `claim.state` for it says it can be claimed; the Privacy page carries the chain's sentence and the new date.
3. To stop: take the switch out, build and restart. Claims already made are kept and are checked again from the day it returns.
