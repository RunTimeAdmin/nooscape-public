# Celo lights on the home map

Front end and the words around them. No migration, no new table, no worker step and no new read: the lights are the groups of the Celo page (`liveData.registryFleets`, [the Celo page](./celo-world-2026-11-20.md)), so the map and the page cannot disagree. It is [the Gnosis lights](./gnosis-lights-2026-11-06.md) done for one more chain.

**Status.** Built on 2026-11-20 on branch `feat/celo-page`, after the Celo page. It is live on the home map only once that pull request merges and deploys, behind `chain_celo`.

**Decided:** 2026-11-20, by the operator, in chat: "all in order", on my list of what Celo still lacked after it went live (a chain page, lights and a share card came third). The shape of the answer is mine, chosen to follow the Gnosis lights, so the operator can say no to any of it.

## What a visitor sees

Celo appears on the home map as **large arrowheads**: one for each of the five largest groups on the Celo page, drawn in the chain's colour with its count written under it. A group is a registering wallet, a host or a profile link that 50 or more registrations on the chain share. The outline is the one on the Celo tab's icon, an arrowhead pointing up with a notch in its base (a circle is BNB Chain's, a diamond Solana's, a hexagon Robinhood Chain's, a dome Arc's, a cross Base's, a pentagon Ethereum's, a star Monad's, an octagon Gnosis's), so no chain is told apart from another by colour alone. The colour is `--ns-chain-celo` (#35D07F), and a test holds it to its design token.

| | |
|---|---|
| The shared fact | one registering wallet, one host or one profile link that 50 or more registrations on the chain share |
| The wording | "260 registrations on Celo point their profile link at raw.githubusercontent.com." The wallet and link sentences are Arc's, with the chain's name. |
| What it does not show | a wallet is the address that sent the registrations, a host can serve many unrelated people, and none of it says who runs the agents or whether any of them works |

**Why an arrowhead and not a triangle.** The map already draws a record that names no chain as a triangle in grey (`CHAIN_STYLE.none`), and the key's test compared the chains' outlines without that entry, so a Celo triangle would have been told from it by colour alone. The arrowhead has the notch of the tab's icon, so its outline is its own, and a test holds the arrowhead apart from the triangle as well as from the other eight.

**Why five.** Base, Ethereum, Monad and Gnosis draw five each because eight each put 50 lights on the map and crowded it at 375 pixels. The limit is a constant of its own (`CELO_LIGHTS_LIMIT` in `shared/mapFleets.ts`), so tuning it never moves another chain. On 2026-11-20 Celo had 10 groups (six registering wallets and four hosts), so the key reads "Celo groups · 5 of 10 drawn", and the line under the map says the same in a sentence. The five are the wallets of 6,934, 1,630 and 105 registrations and the hosts of 260 and 158. A light's size grows with the log of its count between 8 and 24 pixels.

The card for an arrowhead is the Arc dome's card with the chain's words: the fact with its count, what it does not show, that a group is not an agent and is not reviewed (no tier, no evidence, no link to a record), the chain, the registering wallet where there is one, and "Open the Celo page". A light never opens the evidence read and the Owl is told nothing about one. A test fails on any grading word.

**Overlap.** A registration can be counted in a wallet's light and in its host's light, so two lights can be nearly the same size. The card says groups are counted one by one and can overlap (`ARC_OVERLAP_NOTE`).

**No hollow dots.** Only groups are drawn. The Celo page draws groups only, so the home map shows no more of the chain than its page does.

## What is read

Home asks `liveData.registryFleets({ chain: "celo" })` while `chain_celo` is in the build's switch list. The call is not waited for (the hero's status does not depend on it) and is not retried, so a failed or empty read leaves the map exactly as it was. It is the same cached read the page makes and answers nothing until a walk that reached the finalized head has published.

## How it is drawn

The Celo lights are placed after Gnosis's (`lightOrder` 8), so every other light and every dot is exactly where it was (a test), and a light starts where its id hashes and is pushed away from everything placed before it, as the others are. An arrowhead has its tip a reach above the centre, its two base corners 0.96 of a reach to each side and 0.85 below the centre, and the notch of its base 0.35 below the centre, in the proportion of the tab's icon. Motion, hover, focus, pinning, the keyboard and the screen-reader summary ("Also 5 large arrowheads: each is a group of Celo registrations that share one wallet, host or profile link, with its count. An arrowhead is a group, not an agent ...") work as for the other lights.

`recordChain` no longer sets Celo aside, so a record whose protocols name Celo's identity registry is a dot of that chain, listed in the key after Gnosis. There is none today. The map's chain type is the whole list of listed chains again (`MapChainKey` is `ListedChainKey`, with no exception).

## Not here

- **A census link under the caption.** Celo had no census report when the lights were built. The report followed ([the record](./celo-census-2026-11-20.md)), and the line under the map links it as it links the other chains' dated reports.
- **The hero's Noosphere**, the background of sampled lights, for the reason the Arc lights give.
- **Hollow dots** for the listed entries, as above.

## Held by a test

- `constellationModel.test.ts` (Celo is a fifth row of the table that holds Base, Ethereum, Monad and Gnosis): a group's record, its protocol and chain, the five largest in a fixed order with a tie broken by id, the order after the other lights, the placement that leaves every dot and every other light where it was, the scanner line, the screen-reader summary, the marker equal to the tab icon, the colour equal to the design token, the key's order, that no two chains on the key share an outline and that Celo's is not the triangle of a record with no chain.
- `mapFleets.test.ts`: the caption's words, a count of one and of none, and no grading word or long dash; the nine shapes.
- `landingHero.test.ts`: the read only while the switch is on, not waited for and not retried, the node kind, the outline, the card's words and link, and the key entry and the caption.
- Planted bugs: 30 across the page and the lights, each caught by a test.

## Checked

On the same build and server, in the built-in browser at desktop width:

- The key reads "Celo groups · 5 of 10 drawn" with an arrowhead beside it, the caption under the map reads "Large arrowheads are Celo groups of registrations that share one wallet, host or profile link, 50 or more registrations each: 5 of 10 groups ...", and the map's accessible summary names the five groups (the wallets of 6,934, 1,630 and 105 registrations and the hosts of 260 and 158).
- The five arrowheads are drawn in the chain's green with their counts (6.9k, 1.6k, 260, 158 and 105). A pinned light's card read "158 registrations on Celo point their profile link at poulavbhowmick03.github.io.", with the chain's icon, the words about what a group does not show, and "Open the Celo page". The heading reads "Robinhood, BNB, Solana, Ethereum, Base, Arc, Monad, Gnosis, Celo. Same Owl, nine skies.", and the document had no horizontal overflow and the console held no error.
- Not checked: the map at 375 pixels (the Celo page was checked there; the map is a canvas whose layout the tests hold).
