# Robinhood Chain registering-wallet lights on the home map

Front end, one read and the words around them. No migration, no new table, no worker step, no change to the listing rules or the gate.

**Status.** Built and tested on a local branch (`visual/robinhood-lights`). Not shipped.

**Decided:** 2026-10-19, by the operator, in chat: "we need to deliver visual results at the very least". The shape of the answer is mine, chosen to follow the BNB Chain and Solana lights exactly, so the operator can say no to any of it (see "What I chose").

## What a visitor sees

BNB Chain appears on the home map as large circles (docs/bsc-fleet-lights-2026-10-16.md) and Solana as large diamonds (docs/solana-lights-2026-10-18.md). Robinhood Chain now appears as **large hexagons**: one for each registering wallet that the directory records against 100 or more Robinhood Chain registrations, drawn in the chain's lime, with its count written under it. Each chain has its own outline, so no chain is told apart from another by colour alone.

On 2026-10-19 the directory's wallet census showed five such wallets, recorded against 5,593, 1,091, 902, 133 and 100 registrations. Together they hold 7,819 of the 8,873 Robinhood Chain entries the directory lists, which is 88 percent. The map did not show that before.

| | |
|---|---|
| The shared fact | one wallet that the directory records as the registrant of 100 or more Robinhood Chain registrations |
| The wording | "5,593 registrations on Robinhood Chain name the same registering wallet." |
| What it does not show | "A registering wallet is the address that registered these identities. A platform can register many and hand them to other people, so it does not say who holds them now, who runs the agents, or whether any of them works." |

**Why "registering wallet".** The directory's `registrant` for a Robinhood Chain entry is the owner named in the registration event, which is the address that registered it. It is not updated when the identity is later transferred (the chain activity ledger counts 6,574 hand-outs within an hour of minting). So the light says "registering wallet", as the BNB Chain light does, and says on the card that holding and running are different facts. This is not the wording the Solana lights use, where the directory records the current owner.

**Why a hexagon.** A circle is already the BNB Chain light and a diamond the Solana light. A square is the BNB Chain dot, and a triangle the dot with no chain. A hexagon, pointed at the top, is not used for anything on the map. The Robinhood Chain dot is a circle, and its lights are a different shape from it, as the BNB Chain lights are from the BNB Chain dots.

The card for a hexagon is the BNB Chain light's card with the Robinhood words: the fact with its count, what it does not show, that a group is not an agent and is not reviewed (no tier, no evidence, no link to a record), the chain and the registering wallet. A hexagon never opens the evidence read, the Owl is told nothing about one, and a test fails on any grading word. A registration has one registering wallet, so the card says each registration is counted in at most one light, which is simpler than the BNB Chain and Solana notes about overlap.

A line under the map says how many hexagons are drawn of how many wallets meet the rule, as the directory held them at its last read. The map's key has its own entry, "Robinhood Chain registering wallets · 5 of 5 drawn". There is no census report to link yet, so the line links nothing.

## What is read

`liveData.mapFleets` (public, no input, cached with the other directory reads and warmed with them) gains a field beside the BNB Chain lights and `solana`:

```
{ fleets, groups, registrations, asOf,                      // BNB Chain, unchanged
  solana: { ... },                                          // unchanged
  robinhood: { fleets: [{ id, kind: "wallet", chain: "robinhood", name: null, wallet, registry: null, count, wallets: null }],
               groups: number (all wallets that meet the rule), asOf: string | null,
               listed: number | null (the Robinhood Chain entries the directory lists, counted in the same read) } }
```

`listed` was added on 2026-10-20 (docs/chain-worlds-2026-10-20.md, stage B1) so a share of the entries the wallets are recorded against is one figure from one moment. It is the count of visible `erc8004` entries under the same visibility rule, and it is null when the count could not be read: the wallets are still drawn and no share is said.

It is a separate field on purpose, as `solana` was: a page loaded before this change reads the fields it knew and ignores `robinhood`, and the page reads the new field defensively, so an answer without it draws what it did.

The read is one grouped query over the directory (`listRobinhoodRegistrantHoldings` in `server/db.ts`): the entries of the `erc8004` protocol (Robinhood Chain only; BNB Chain is `erc8004_bsc`) with a recorded wallet, under the same visibility rule as every public directory read (active source, not hidden, not closed, not on a suppressed host), grouped by wallet and kept where the count is 100 or more. It returns a wallet and a count and nothing about any one entry. The id of a light is derived from the wallet and the protocol, and is not the wallet. A failed read is logged and answers no hexagons, so it never takes the other chains' lights with it.

## How it is drawn

The lights are placed after the dots, the BNB Chain lights first, the Solana lights next and the Robinhood Chain lights last, so every dot and every other light is exactly where it was (a test). A hexagon starts where its id hashes and is pushed away from everything placed before it, as the others are. Its reach is its radius, which grows with the log of its count between 8 and 24 pixels, so the 100 wallet is the smallest hexagon and the 5,593 wallet the largest. It is drawn pointed at the top and the bottom, in its colour, with a glow and a small solid hexagon at its centre, and its count under it. Motion, hover, focus, pinning and the keyboard list work as for the other lights.

## What is held by a test

- `server/mapFleets.test.ts`: the rule (100 is a light, 99 is not), the order and the limit, an id that is derived and never the address, no light for a row with no wallet, the shape for each chain, the words, the caption, no grading word and no long dash anywhere in them.
- `server/mapFleets.integration.test.ts`, against a real database: wallets with 150, 99 and 100 entries, hidden and closed entries taken out before the count, a source an operator has not approved and another chain's protocol counting for nothing, no entry or key in the answer, the other chains' lights unchanged, and the lights following the directory once the cache is dropped. Mutation checked: dropping the protocol filter, or the visibility rule, each fails the test.
- `client/src/components/home/constellationModel.test.ts`: a hexagon's record, its protocol and chain, the order after the other lights, the placement that leaves every dot and every other light where it was, the scanner line and the screen-reader summary.
- `client/src/pages/home/landingHero.test.ts`: the wiring, the outline and its colour, the card's words and the caption.

## Checked

In headless Chrome against the real built server and the real endpoint, on a scratch database seeded with the five wallet sizes above, a wallet of 99 that must not be drawn, the six Solana wallets of 2026-10-18 and ten BNB Chain groups, with every other read answered from the live site: the endpoint returned exactly five hexagons, six diamonds and ten circles, and the map drew all of them with the records. At 1440 and 375 pixels: the key and the three captions read as above, the canvas label describes the hexagons apart from the circles, the diamonds and the records, the card opens on a reviewed record and never on a light, scanning and pinning the largest hexagon shows its card with the right words and no link, the Solana and BNB Chain cards are still their own, there is no horizontal overflow and no console error.

## What I chose

1. **The minimum is 100.** The same bucket as the Solana lights. It is `ROBINHOOD_LIGHT_MIN` in `shared/mapFleets.ts`, and the caption states it from there.
2. **At most eight are drawn.** There are five today. The rest would be counted, not drawn.
3. **A hexagon,** in the chain's existing lime.
4. **Robinhood Chain only,** by protocol. Entries a registering wallet holds on another chain are not added to it.
5. **The word is "registering wallet",** for the reason above.

## Not decided and not built

- **A census report for Robinhood Chain,** dated and published as the BNB Chain and Solana ones are, with the concentration figure (88 percent in five wallets) and a link from the caption. It would be a static page with a data file whose figures each carry their source. Built since, as stage B2 of Chain Worlds ([the record](./chain-worlds-2026-10-20.md)).
- **A page for each chain,** where the map, the funnel, the largest wallets, the activity and the reports of that chain are shown together. Proposed to the operator, who was open to it. Built since, as Chain Worlds ([the record](./chain-worlds-2026-10-20.md)).
- **Lights for the catalog.** Its 220,000 entries come from several sources and have no wallet to group by. A host group would be a different kind of fact and needs its own decision.

## Files

`server/mapFleets.ts` (read and shaping), `server/db.ts` (`listRobinhoodRegistrantHoldings`), `shared/mapFleets.ts` (shapes, the rule, the words, `fleetShape`), `client/src/components/home/constellationModel.ts` (the node, the order, the summary), `AgentConstellation.tsx` (drawing), `CheckCard.tsx` (the card), `client/src/pages/home/LandingHero.tsx` (the key and the caption), and the tests above.
