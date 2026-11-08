# Gnosis lights on the home map

Front end and the words around them. No migration, no new table, no worker step and no new read: the lights are the groups of the Gnosis page (`liveData.registryFleets`, [the Gnosis page](./gnosis-world-2026-11-06.md)), so the map and the page cannot disagree. It is [the Monad lights](./monad-lights-2026-11-01.md) done for one more chain.

**Status.** Built on 2026-11-06 on branch `feat/gnosis-extras`, after the Gnosis page. It is live on the home map only once that pull request merges and deploys, behind `chain_gnosis`.

**Decided:** 2026-11-06, by the operator, in chat: "lets go fully live with gnosos once you have all you need to do it", on the list of what Gnosis still lacked (a chain page, lights, a share card, a census report, claims). The shape of the answer is mine, chosen to follow the Monad lights, so the operator can say no to any of it.

## What a visitor sees

Gnosis appears on the home map as **large octagons**: one for each of the five largest groups on the Gnosis page, drawn in the chain's colour with its count written under it. A group is a registering wallet, a host or a profile link that 50 or more registrations on the chain share. The outline is the one on the Gnosis tab's icon, a regular octagon (a circle is BNB Chain's, a diamond Solana's, a hexagon Robinhood Chain's, a dome Arc's, a cross Base's, a pentagon Ethereum's, a star Monad's), so no chain is told apart from another by colour alone. The colour is `--ns-chain-gnosis` (#2DD4BF), and a test holds it to its design token.

| | |
|---|---|
| The shared fact | one registering wallet, one host or one profile link that 50 or more registrations on the chain share |
| The wording | "3,851 registrations on Gnosis point their profile link at marketplace.olas.network." The wallet and link sentences are Arc's, with the chain's name. |
| What it does not show | a wallet is the address that sent the registrations, a host can serve many unrelated people, and none of it says who runs the agents or whether any of them works |

**Why an octagon and not the hexagon the tab had.** Robinhood Chain's lights are hexagons (`fleetShape`), so a Gnosis hexagon would have been told from them by colour alone. The Gnosis tab's icon, its lights and its page plates are an octagon instead, and a test holds the shapes of every chain on the map's key apart.

**Why five.** Base, Ethereum and Monad draw five each because eight each put 50 lights on the map and crowded it at 375 pixels. The limit is a constant of its own (`GNOSIS_LIGHTS_LIMIT` in `shared/mapFleets.ts`), so tuning it never moves another chain. On 2026-11-06 Gnosis had 2 groups (the host and one registering wallet), so the key reads "Gnosis groups · 2 of 2 drawn", and the line under the map says the same in a sentence. A light's size grows with the log of its count between 8 and 24 pixels.

The card for an octagon is the Arc dome's card with the chain's words: the fact with its count, what it does not show, that a group is not an agent and is not reviewed (no tier, no evidence, no link to a record), the chain, the registering wallet where there is one, and "Open the Gnosis page". A light never opens the evidence read and the Owl is told nothing about one. A test fails on any grading word.

**Overlap.** A registration can be counted in a wallet's light and in its host's light, so two lights can be nearly the same size. The card says groups are counted one by one and can overlap (`ARC_OVERLAP_NOTE`).

**No hollow dots.** Only groups are drawn. The Gnosis page draws groups only, so the home map shows no more of the chain than its page does.

## What is read

Home asks `liveData.registryFleets({ chain: "gnosis" })` while `chain_gnosis` is in the build's switch list. The call is not waited for (the hero's status does not depend on it) and is not retried, so a failed or empty read leaves the map exactly as it was. It is the same cached read the page makes and answers nothing until a walk that reached the finalized head has published.

## How it is drawn

The Gnosis lights are placed after Monad's (`lightOrder` 7), so every other light and every dot is exactly where it was (a test), and a light starts where its id hashes and is pushed away from everything placed before it, as the others are. An octagon has a corner at the light's reach at each eighth of a turn, flat sides at the top, bottom, left and right, in the proportion of the tab's icon. Motion, hover, focus, pinning, the keyboard and the screen-reader summary ("Also 2 large octagons: each is a group of Gnosis registrations that share one wallet, host or profile link, with its count. An octagon is a group, not an agent ...") work as for the other lights.

`recordChain` no longer sets Gnosis aside, so a record whose protocols name Gnosis's identity registry is a dot of that chain, listed in the key after Monad. There is none today. The map's chain type is now the whole list of listed chains (`MapChainKey` is `ListedChainKey`, with no exception).

## Not here

- **A census link under the caption.** Gnosis had no census report when the lights were built. The report followed ([the record](./gnosis-census-2026-11-06.md)), and the line under the map links it as it links the other chains' dated reports.
- **The hero's Noosphere**, the background of sampled lights, for the reason the Arc lights give.
- **Hollow dots** for the listed entries, as above.

## Held by a test

- `constellationModel.test.ts` (Gnosis is a fourth row of the table that holds Base, Ethereum and Monad): a group's record, its protocol and chain, the five largest in a fixed order with a tie broken by id, the order after the other lights, the placement that leaves every dot and every other light where it was, the scanner line, the screen-reader summary, the marker equal to the tab icon, the colour equal to the design token, the key's order, and that no two chains on the key share an outline.
- `mapFleets.test.ts`: the caption's words, a count of one and of none, and no grading word or long dash; the eight shapes.
- `landingHero.test.ts`: the read only while the switch is on, not waited for and not retried, the node kind, the outline, the card's words and link, and the key entry and the caption.
- Planted bugs: 26 across the page and the lights, each caught by a test, listed in [the Gnosis page's record](./gnosis-world-2026-11-06.md).

## Checked

On a client build with production's switch list and `chain_gnosis`, served by a preview rig that forwards the live site's data (GET only) and answers Gnosis's groups with the real ones, in the built-in browser:

- The key reads "Gnosis groups · 2 of 2 drawn" with an octagon beside the other chains', the caption under the map reads "Large octagons are Gnosis groups of registrations that share one wallet, host or profile link, 50 or more registrations each: 2 of 2 groups ...", and the map's accessible summary has the sentence about two large octagons.
- The map's canvas holds teal pixels where the two octagons are (992 of them), and the heading reads "Robinhood, BNB, Solana, Ethereum, Base, Arc, Monad, Gnosis. Same Owl, eight skies." with eight tabs and the link "Open the Gnosis page". The document had no horizontal overflow and the console held no error.
- Not checked: a clicked light's card in the browser (the pane would not paint the map after a scroll); its words are held by the landing hero test.
