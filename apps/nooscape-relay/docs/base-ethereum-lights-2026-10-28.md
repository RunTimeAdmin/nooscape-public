# Base and Ethereum lights on the home map

Front end and the words around them. No migration, no new table, no worker step and no new read: the lights are the groups of the Base page and of the Ethereum page (`liveData.registryFleets`, [Base](./base-world-2026-10-21.md) and [Ethereum](./ethereum-world-2026-10-27.md)), so the map and the pages cannot disagree. It is [the Arc lights](./arc-lights-2026-10-20.md) done for two more chains.

**Status.** Shipped in PR 223 on 2026-10-28, after the Ethereum census queries, and live on the home map.

**Decided:** 2026-10-28, by the operator, in chat: "do these next  Base and Ethereum extras: map lights, census, claims and the Base Owl's Catch and watchlist; the AgenC page". The shape of the answer is mine, chosen to follow the Arc lights, so the operator can say no to any of it.

## What a visitor sees

Base appears on the home map as **large crosses** and Ethereum as **large pentagons**: one for each of the five largest groups on the chain's own page, drawn in the chain's colour with its count written under it. A group is a registering wallet, a host or a profile link that 50 or more registrations on the chain share. Each chain has its own outline, so no chain is told apart from another by colour alone, and each outline is the one on the chain's tab icon (a circle is BNB Chain, a diamond Solana, a hexagon Robinhood Chain, a dome Arc, a cross Base, a pentagon Ethereum). Base's colour is `--ns-chain-base` (#3B82F6) and Ethereum's `--ns-chain-ethereum` (#7DD3FC); a test holds each to its design token.

| | |
|---|---|
| The shared fact | one registering wallet, one host or one profile link that 50 or more registrations on the chain share |
| The wording | "1,035,774 registrations on Base point their profile link at (the host)." The wallet and link sentences are Arc's, with the chain's name. |
| What it does not show | a wallet is the address that sent the registrations, a host can serve many unrelated people, and none of it says who runs the agents or whether any of them works |

**Why five.** Arc draws eight. With eight each for Base and Ethereum the map held 50 lights and was crowded at 375 pixels, where the live map already holds 32. Five each makes 42. Each chain has a constant of its own (`BASE_LIGHTS_LIMIT`, `ETHEREUM_LIGHTS_LIMIT` in `shared/mapFleets.ts`), so tuning one never moves another. On 2026-10-28 Base had 121 groups (77 of them registering wallets) and Ethereum 63, so the key reads "Base groups · 5 of 121 drawn" and "Ethereum groups · 5 of 63 drawn", and the line under the map says the same in a sentence. A light's size grows with the log of its count between 8 and 24 pixels, so a group of 100,000 registrations or more, such as Base's largest (one host with about a million), is drawn at the top size of 24 pixels.

The card for a cross or a pentagon is the Arc dome's card with the chain's words: the fact with its count, what it does not show, that a group is not an agent and is not reviewed (no tier, no evidence, no link to a record), the chain, the registering wallet where there is one, and "Open the Base page" or "Open the Ethereum page". A light never opens the evidence read and the Owl is told nothing about one. A test fails on any grading word.

**Overlap.** A registration can be counted in a wallet's light and in its host's light, so two lights can be nearly the same size. The card says groups are counted one by one and can overlap (`ARC_OVERLAP_NOTE`).

**No hollow dots.** Only groups are drawn. The Base and Ethereum pages draw groups only, as BNB Chain's page does, so the home map shows no more of either chain than its page does.

## What is read

Home asks `liveData.registryFleets({ chain: "base" })` while `chain_base` is in the build's switch list, and `({ chain: "ethereum" })` while `chain_ethereum` is. Neither call is waited for (the hero's status does not depend on them) and neither is retried, so a failed or empty read leaves the map exactly as it was. They are the same cached reads the pages make and answer nothing until a walk that reached the finalized head has published.

## How it is drawn

The Base lights are placed after Arc's and the Ethereum lights after Base's (`lightOrder` 4 and 5), so every other light and every dot is exactly where it was (a test, for Base and for Ethereum), and a light starts where its id hashes and is pushed away from everything placed before it, as the others are. A cross is a plus sign whose four arms end at the light's reach and are a third as wide; a pentagon has a corner at its reach, pointed up. Motion, hover, focus, pinning, the keyboard and the screen-reader summary ("Also 5 large crosses: each is a group of Base registrations that share one wallet, host or profile link, with its count. A cross is a group, not an agent ...") work as for the other lights.

`recordChain` now asks `listedChainOf` (`shared/chains.ts`), so a record whose protocols name Base's or Ethereum's identity registry is a dot of that chain, listed in the key after Arc. There is none today: the 76 reviewed records are on the a2a, catalog, Solana and Robinhood Chain protocols. The test that said "the other extra chains have no place on the map" is changed to say they have one.

A line under the map links the dated census, which is [the Base registry census](./base-census-2026-10-21.md) for Base. Ethereum's link comes with its census report.

## Not here

- **The hero's Noosphere**, the background of sampled lights, for the reason Arc's record gives: a share of one light in a thousand does not earn a new code in the sample's encoding.
- **Hollow dots** for the listed entries, as above: the pages draw none.

## Held by a test

- `constellationModel.test.ts` (for each of Base and Ethereum): a group's record, its protocol and chain, the five largest in a fixed order with a tie broken by id, the order after the other lights (BNB Chain, Arc, Base, Ethereum), the placement that leaves every dot and every other light where it was, the scanner line, the screen-reader summary, the marker equal to the tab icon, the colour equal to the design token, and the key's order.
- `mapFleets.test.ts`: the captions' words, a count of one and of none, and no grading word or long dash.
- `landingHero.test.ts`: the read only while the switch is on, not waited for and not retried, the node kind, the outline, the card's words and link, the key entry and the caption, and the Base census link.
- Three guards were broken once to confirm a test fails: dropping the Ethereum lights from the map's records (six tests fail), placing Base's lights with Arc's order (one), and giving an Ethereum light BNB Chain's protocol (three).

## Checked

On a build with `claims,chain_arc,claims_arc,chain_base,chain_ethereum` in `VITE_FEATURES`, served with its API reads forwarded to the live site (GET only), in the browser pane at 1440 and at 375 pixels: five crosses and five pentagons drawn with their counts beside the other chains' lights, the key reading "Base groups · 5 of 121 drawn" and "Ethereum groups · 5 of 63 drawn", the captions and the Base census link under the map, the canvas's label describing the crosses and the pentagons, no horizontal overflow at 375 pixels and no console error. The first try, with eight lights for each chain, is why the limit is five.
