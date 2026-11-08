# Claim this agent, for Gnosis

The claim flow ([docs/claims-2026-10-18.md](./claims-2026-10-18.md)) opened to the owners of agents on Gnosis, the way it was opened to [Arc's](./arc-claims-2026-10-20.md), [Base's and Ethereum's](./base-ethereum-claims-2026-10-28.md) and [Monad's](./monad-claims-2026-11-01.md). One new switch, one chain entry, one node for the claim reads built from the shared module, and a few lines in the flow and the page. No migration, no new table and no new setting: it uses the three claim tables (migration 0042) and the endpoint the Gnosis identity pass already reads (`GNOSIS_RPC_URL`).

**Status.** Built on 2026-11-06 on branch `feat/gnosis-extras`, and **off until the operator adds `claims_gnosis` to `VITE_FEATURES`**. Merging this turns nothing on. (Production has `claims_arc` on and the claims of Base, Ethereum and Monad off, so Gnosis's stay off with them unless the operator says otherwise.)

**Decided:** 2026-11-06, by the operator, in chat: "merge 301 and do the census report and claims". The shape of the answer is mine, chosen to follow Monad's claims, so the operator can say no to any of it.

## The switch

`claims_gnosis` (`shared/features.ts`). Agents on Gnosis can be claimed only while **`chain_gnosis` and `claims_gnosis` are both on**; the panel itself is still `claims`. No other chain's switches open it, and its switches open no other chain. To open it: add `claims_gnosis` to `VITE_FEATURES` and rebuild and restart. On the server that is the line in the stack's `.env` and `bash deploy.sh $(cat .deployed)`, because the page needs the build and the server the restart, and both read the same list. Taking it out again closes it.

The reason for a switch of its own is Arc's: the flow asks for a signature, reads a chain to decide who owns an agent, and the Privacy page says what it does. Gnosis's page, lights and ratings go live with their merge, and its claims go live when the operator has read this and decided to.

## What changes

- **The chain.** `CLAIM_CHAINS` gains Gnosis (chain id 100, label "Gnosis") with the identity registry's address. `claimChainOf(protocol)` returns it only while its two switches are on, so everything that asks "can this be claimed?" (the entry lookup, the message, the page's state, the daily check) answers no for an agent on it while they are off, with the words it uses for any entry that cannot be claimed.
- **The words for an entry that cannot be claimed** name the registries that can, in the order Robinhood Chain, BNB Smart Chain, Arc, Base, Ethereum, Monad, Gnosis, each only while its claims are on.
- **The message to sign** is the same sign-in text, with `Chain ID: 100` and the registry and token as its resource (`eip155:100:<registry>:<token>`). Nothing else in it changes.
- **The entry.** An agent can be claimed only if the public can see it, as for the others, so a registration the listing rules hold out has no claim. The key must name exactly the chain's registry on the chain.
- **The fleet rule** counts the visible entries of the wallet, and of the wallet the entry was registered by, on the same protocol, as for the others. Gnosis's listing rules hold out a wallet that registered 10 or more, so an agent that is listed is from a wallet that registered fewer than 10 and the fleet rule (50) will rarely bite.
- **The agent's page** gets a colour for Gnosis (`erc8004_gnosis`, the tab's teal) in `DirectoryAgent.tsx`, where it had none.

## The read of the chain

A claim asks the chain three things and nothing else: who owns the agent now (`ownerOf`), whether a wallet is a contract (`eth_getCode`) and whether a contract wallet accepts a signature (EIP-1271, `eth_call`). They go to the endpoint the chain's pass reads, through `server/claimsPinned.ts`, which now builds a fourth node from `server/claimsNode.ts`:

- **The checks** are the shared module's: the node answers as the chain (`eth_chainId`), it is at the head (a latest block no more than ten minutes old, and not dated more than two minutes ahead of the server's clock), one attempt with no retry ladder, and a gas limit on what a visitor can make it run (200,000 for `ownerOf`, 3,000,000 for anything else). A failed check is fixed text that can never be read as a revert.
- **The address** is read as the pass reads it: `GNOSIS_RPC_URL` (Alchemy) must be set, an https address with no credentials in it, and its host must be exactly the host the chain's entry pins (`gnosis-mainnet.g.alchemy.com`), so changing the variable can never send a claim's reads to a host nobody approved. The address carries a key. Nothing puts it, or any part of it, in an error or a log line, and an address that is not usable is "not configured" in fixed words. The host is a vendor's and public, so it is not looked up again.
- **The same budget as the others.** A visitor's reads of a chain are held to 60 a minute and refused as "try again" past that, without asking the node; the daily check has no such cap. A revert (a token that does not exist, answered in the EVM's own words, code 3) is an answer: no owner. A bad key, a missing method, a throttle or a timeout is an outage and can never end a claim.
- **The provider's bill.** A read costs the provider one call, and up to two more when the chain id (asked once in ten minutes) or the head (once a minute) is due. A visitor is held to 60 reads a minute and the daily check takes at most 25 claims a run. The Alchemy plan's limits were not looked at against that here; the endpoint is also read by the identity pass (one run a day) and, for its first hours after the deploy, by the ratings step.
- **Checked against the real chain** on 2026-11-06, read-only, through the keyed endpoint and the flow's own client: the node answered as chain 100 and its latest block passed the head check, `ownerOf` of an existing token (a registration the directory lists) answered one address word that decodes to an address, `ownerOf` of a token that does not exist reverted with "execution reverted", and the same read through the claim flow's chain call came back as an answer.

## The daily check

Unchanged from the other chains': it selects only claims on a chain whose claims are on, and a chain that cannot be read is left out for the rest of the run so the claims behind it on other chains are still asked about. A claim made on Gnosis while its switch was on is kept when the switch goes off and is checked again from the day it returns.

## What the pages say

- **Terms.** Unchanged: "the owner of an agent in a public registry" already covers it.
- **Privacy.** The sentences that name the chains are untouched, and **one sentence is added only while Gnosis's claims are on in the build**: "The owner of an agent on the Gnosis registry can claim it in the same way." The page's date reads 6 November 2026 while it is there, and otherwise the older dates, because the text it describes is the text on the page. This is the only legal wording the change touches, and it adds a chain to a list rather than a clause. The operator's review of it is the open point.
- **The panel** says "If you own this agent's registration on Gnosis, you can claim it", in the other chains' words, on an agent's page while its switches are on, and is not there otherwise.

## What does not change

A claim is still the owner's own word and never a tier, a review, a rating or a score. It changes nothing about whether a Gnosis registration is listed, where it sits, any count, the page, the lights or the ratings. The flow still cannot write a field it does not own, and the claim code still names no tier, state, listing flag or score. Payment has no part in it.

## Held by a test

- `features.test.ts`: the switch list, and `gnosisClaimsOn` (the chain and its claims named, in any case or order, each alone not enough, and the other chains' switches opening neither way).
- `claimsChain.test.ts` (Gnosis is a fourth row of the table that holds Base, Ethereum and Monad): the chain's id, registry and label; claimable only while both switches are on and no other chain's switches open it; the production call (the node's client called once, a revert from the node's own words, a timeout or HTTP error or throttle or bad key as an outage, the worker's call with no budget, a visitor's reads held to 60 a minute); and all the chains' claims together in the order the words name them.
- `claimsPinned.test.ts` (Gnosis is a fourth row): one request to the address in the variable, no redirect followed, no look-up of the host, the gas limits, a revert in the node's words, no address or key in anything thrown, a refusal when the variable is unset, is not https, carries credentials or names a host nobody approved, the chain id asked first and the head looked at, every failed check being fixed text, and the nodes keeping their own checks (Monad's being right says nothing of Gnosis's).
- `claims.integration.test.ts` (real MySQL and MariaDB, real signatures, a fake chain; Gnosis is a fourth row, and the test pastes migrations 0051, 0053 and 0057 by hand after 0046, as production has them): the agent cannot be claimed under any partial list or another chain's switches, and the refusal names the registries; with both switches on, the message carries the chain id and the registry, the claim is written with the chain's protocol, chain, registry and token, every read is on that chain, and the page is told it can be claimed; a wallet the registry does not record as the owner is refused and the owner's edit is taken; a held-out registration, a wrong registry and a wrong chain's key are not claimable; and the daily check ends a claim when the chain shows a new owner.
- `claimFlow.test.ts`, `legalPages.test.ts` and `claimClient.test.ts`: the panel names Gnosis only while both of its switches are on in the build, the Privacy sentence is conditional and its date goes with it, the claim code and the page ask the same question, and the switch list is the one the client reads.
- Planted bugs: twelve, each caught by a test. Gnosis missing from the claimable list, its claims opened by Monad's switch or by the chain's switch alone, its chain id read from Monad, its read sent to Monad's node, its node pinned to Monad's entry or named Monad, a flow that names Gnosis "Monad", a Privacy page without the sentence or with the old date, a switch missing from the list, and a claim allowed with its claims off.

## Not checked, and left as it is

- **No claim was made by a real wallet on Gnosis.** No wallet was connected here, and the production endpoint's key is on the host. The signature, nonce and ownership logic is the flow's own and is held by the tests above; the contract's behaviour was read from the real chain as above. The first claim after the switch is on is the live check.
- **No independent review of this change.** What it adds on the claim path is small (one chain entry, one route into the shared module, one switch name, the endpoint's address check), but a review of `claimsNode.ts` would cover every chain's claims.
- **Smart-contract wallets** (a Safe) sign through EIP-1271 and are accepted when the wallet answers the magic value on the chain; a counterfactual wallet (not deployed yet) is refused, as for the others. ERC-6492 is not supported.
- The two points the other chains' records leave as they are apply here as well: an operator's hold of a claim's text is still sent to a watching key as an event while the chain's claims are off, and a claim shows as active at once when its switch returns, until the daily check reaches it.

## To turn it on, and off

1. Add `claims_gnosis` to `VITE_FEATURES` in the stack's `.env` on the server (it reads `claims,chain_arc,claims_arc,chain_base,chain_ethereum,chain_monad,chain_gnosis` today, so the line becomes `...,chain_gnosis,claims_gnosis`) and run `bash deploy.sh $(cat .deployed)`. Read the Privacy sentence first.
2. Check: an agent's page on Gnosis shows the panel; `claim.state` for it says it can be claimed; the Privacy page carries Gnosis's sentence and the new date.
3. To stop: take the switch out and run the same deploy. Claims already made are kept and are checked again from the day it returns.
