# Solana owner-wallet lights on the home map

Front end, one read and the words around them. No migration, no new table, no worker step, no change to the listing rules or the gate.

**Status.** Shipped in PR 145 on 2026-10-18.

**Decided:** 2026-10-18, by the operator, in chat, choosing "Owner wallets, 100+ entries" from three options (the other two were the same plus the two 8004 profile links that 100 or more entries share, and no Solana lights).

## What a visitor sees

BNB Chain appears on the home map as large circles, one for each of its ten largest groups of registrations that share one fact (docs/bsc-fleet-lights-2026-10-16.md). Solana now appears beside them as **large diamonds**: one for each owner wallet that the 8004 registry or the Metaplex agent registry records as holding 100 or more registrations, with its count written under it. The diamond is the shape the map already gives Solana's dots, and it is drawn in Solana's colour, so a circle is BNB Chain and a diamond is Solana, and neither is told apart by colour alone.

On 2026-10-18 that is six lights: three in the 8004 registry (326, 195 and 160 registrations) and three in the Metaplex registry (332, 115 and 106). At most eight are drawn, apart from BNB Chain's ten; the rest would be counted, not drawn.

| | |
|---|---|
| The shared fact | one wallet, which a registry records as the owner of 100 or more registrations in that registry |
| The wording | "326 registrations in the 8004 registry on Solana record the same owner wallet today." |
| What it does not show | "An owner wallet is the address the registry records as holding the registrations today. A registration can be transferred, so it does not say who registered them, who runs the agents, or whether any of them works." |

**Why "owner wallet" and not "registering wallet".** For the 8004 and Metaplex registries the directory records the owner the registry shows today, which can be a later holder. The BNB Chain lights are the wallet that sent the registrations, a fact the chain fixes. Calling a Solana wallet the registering wallet would say more than the data does, so the card says "Same owner wallet", names the row "Owner wallet", and says what a transfer changes.

**Why SAID has no light.** Every SAID identity is keyed to a wallet of its own, so no SAID wallet holds more than one entry: nothing to group (the census measured 13,779 entries on 13,779 wallets). The caption says so. SAID's other shared fact, one host that 97 percent of its links name, is the registry's own card host and says nothing about who registered them, so it is not drawn either.

**A wallet in both registries** has a light in each registry it holds 100 or more in, and the card says so. A wallet's holdings in two registries are not added.

The card for a diamond is the BNB Chain light's card with the Solana words: the fact with its count, what it does not show, that a group is not an agent and is not reviewed (no tier, no evidence, no link to a record), the chain and the owner wallet. A diamond never opens the evidence read, the Owl is told nothing about one, and a test fails on any grading word.

A line under the map says how many diamonds are drawn of how many wallets meet the rule, as the directory held them at its last read, and links the Solana registry census (`/field/solana-registries-2026-10-18`). The map's key has its own entry, "Solana owner wallets · 6 of 6 drawn".

## What is read

`liveData.mapFleets` (public, no input, cached with the other directory reads and warmed with them) returns the BNB Chain answer it always did, and a new field beside it:

```
{ fleets, groups, registrations, asOf,                      // BNB Chain, unchanged except that each light now carries chain: "bnb" and registry: null
  solana: { fleets: [{ id, kind: "wallet", chain: "solana", name: null, wallet, registry: "8004" | "metaplex", count, wallets: null }],
            groups: number (all wallets that meet the rule), asOf: string | null } }
```

The Solana lights are a separate field on purpose: a page loaded before this change reads `fleets` and `groups` as it did and ignores `solana`, so it can never draw a Solana wallet as a BNB Chain group. The page reads the new field defensively, so an answer without it draws what it did.

The read is one grouped query over the directory (`listSolanaOwnerHoldings` in `server/db.ts`): the entries of the two registries' protocols with a recorded wallet, under the same visibility rule as every public directory read (active source, not hidden, not closed, not on a suppressed host), grouped by registry and wallet, kept where the count is 100 or more. It returns a wallet and a count and nothing about any one entry. A light's `id` is derived from the registry and the wallet, never the wallet itself. The query runs on the shared cache, so it costs one read in the cache's lifetime, in the same pass as the BNB Chain read. A failed read of it is logged and answers no Solana lights; it never takes the BNB Chain lights with it, and it needs no table, so there is nothing to migrate.

## How it is drawn

The lights are placed after the dots, and the Solana lights after every BNB Chain light, so every dot and every BNB Chain light is exactly where it was (a test). Each Solana light starts where its id hashes and is pushed away from everything placed before it, with a diamond's points counted a fifth further than a circle's radius, trying up to 24 starting places and keeping the one with the least overlap. The same ids give the same places on every visit, whatever order they arrive in. The faint links join the dots only.

## What is held by a test

- `server/mapFleets.test.ts`: the rule (100 is a light, 99 is not), the order and the limit, no light for SAID or any other protocol (including a protocol named like an object's own property), one light for a wallet in each registry, no light for a row with no wallet, the words, the caption, no grading word and no long dash anywhere in them, and the census's own figures: three wallets of 100 or more in each registry on 2026-10-18, and one entry for every SAID wallet.
- `server/mapFleets.integration.test.ts`, against a real database: a wallet with 150, 99 and 100 entries, the same wallet in both registries, hidden and closed entries taken out before the count, SAID and a source an operator has not approved counting for nothing, no entry or key in the answer, the BNB Chain half unchanged and still empty while its source is not approved, and the lights following a hide and a pause once the cache is dropped.
- `client/src/components/home/constellationModel.test.ts`: a Solana light's record, its protocol and chain, the reach, the placement that leaves every dot and every BNB Chain light where it was, the scanner line and the screen-reader summary.
- `client/src/pages/home/landingHero.test.ts`: the wiring, the diamond and its colour, the card's words and the caption's link.

## Checked

In headless Chrome against the real built server and the real endpoint, on a scratch database seeded with the census's wallet sizes (the 8004 registry's 326, 195 and 160 and Metaplex's 332, 115 and 106, a wallet of 97 and one of 76 that must not be drawn, and the BNB Chain groups of the earlier check), with every other read answered from the live site: the endpoint returned exactly six Solana lights and ten BNB Chain ones; the map drew 16 lights over 76 records; the key ("BNB Chain groups · 10 of 12 drawn", "Solana owner wallets · 6 of 6 drawn"), both captions, the census link, the screen-reader label, the card for a scanned and a pinned Solana light and for a BNB Chain wallet light (which still says "the address that sent the registrations"), at 1440 and 375 wide, no console error and no horizontal overflow. The placement leaves every pair of lights the room it wants, at a phone's shape and a desktop's (measured, 0 of 120 pairs short). Every dot and every BNB Chain light is where it was before the Solana lights (a test).

## Not decided and not built

- **The two 8004 profile links that 100 or more entries share** (the largest 135 on 2026-10-18) as a second kind of light. It was the second option and was not chosen. It would be a "same profile link" light for Solana with its own wording.
- **A different minimum.** 100 is the bucket the census used, so the report and the map agree on what a large holding is. It is `SOLANA_LIGHT_MIN` in `shared/mapFleets.ts`, and the caption states it from there.
- **A dated count.** The BNB Chain lights are dated by the clustering run. These are read from the directory when the cache is filled, and say so ("as the directory held them at its last read").

## Files

`server/mapFleets.ts` (read and shaping), `server/db.ts` (`listSolanaOwnerHoldings`), `shared/mapFleets.ts` (shapes, the rule, the words), `client/src/components/home/constellationModel.ts` (the node, the reach, the placement, the scanner line and the summary), `AgentConstellation.tsx` (drawing), `CheckCard.tsx` (the card), `client/src/pages/home/LandingHero.tsx` (the key, the caption and the link).
