# Arc lights on the home map

Front end and the words around them. No migration, no new table, no worker step and no new read: the lights are the Arc page's own groups (`liveData.registryFleets`, [the Arc world](./chain-worlds-2026-10-20.md), stage C), so the map and the page cannot disagree.

**Status.** Shipped in PR 178 on 2026-10-20, after the Arc page.

**Decided:** 2026-10-20, by the operator, in chat: "do the lights  share card  census etc before base", and "lets finish the ARC arc so to say". The shape of the answer is mine, chosen to follow the BNB Chain, Solana and Robinhood Chain lights ([BNB](./bsc-fleet-lights-2026-10-16.md), [Solana](./solana-lights-2026-10-18.md), [Robinhood](./robinhood-lights-2026-10-19.md)), so the operator can say no to any of it.

## What a visitor sees

BNB Chain appears on the home map as large circles, Solana as diamonds and Robinhood Chain as hexagons. Arc now appears as **large domes**: one for each of the eight largest groups on the Arc page, drawn in Arc's light blue with its count written under it. A group is a registering wallet, a host or a profile link that 50 or more Arc registrations share. Each chain has its own outline, so no chain is told apart from another by colour alone, and the dome is the outline of Arc's tab icon.

| | |
|---|---|
| The shared fact | one registering wallet, one host or one profile link that 50 or more Arc registrations share |
| The wording | "868 registrations on Arc point their profile link at (the host)." The wallet and link sentences are BNB Chain's, with Arc for BNB Chain. |
| What it does not show | BNB Chain's sentences for a wallet, a link and a host: a wallet is the address that sent the registrations, a host can serve many unrelated people, and none of it says who runs the agents or whether any of them works. |

**Why 50 and eight.** The Solana and Robinhood Chain lights use 100. Arc's whole registry is a few thousand registrations, so the Arc page draws groups of 50 or more (the minimum of the lights in the Noosphere, `FLEET_MIN`) and the map shows the eight largest of them, whatever their kind, so Arc does not crowd the 26 lights the other three chains have. The rest are counted: the key says "Arc groups · 8 of 12 drawn" and the line under the map says the same in a sentence.

The card for a dome is the BNB Chain light's card with Arc's words: the fact with its count, what it does not show, that a group is not an agent and is not reviewed (no tier, no evidence, no link to a record), the chain, the registering wallet where there is one, and "Open the Arc page". A dome never opens the evidence read, the Owl is told nothing about one, and a test fails on any grading word.

**Overlap.** A registration can be counted in a wallet's dome and in its host's dome (on 2026-10-20 one wallet and one host were each recorded against 868 registrations), so two domes can be nearly the same size. The card says groups are counted one by one and can overlap (`ARC_OVERLAP_NOTE`).

**No hollow dots.** BNB Chain's map shows groups only (invariant 23) and the map draws no unreviewed entry of Robinhood Chain or Solana either, so Arc's listed entries are not drawn on it. The Arc page draws them as scouts.

## What is read

Home asks `liveData.registryFleets({ chain: "arc" })` only while `chain_arc` is in the build's switch list. The call is not waited for (the hero's status does not depend on it) and not retried, so a failed or empty read leaves the map exactly as it was. It is the same cached read the Arc page makes, and it answers nothing until a walk that reached the finalized head has published.

## How it is drawn

The Arc lights are placed after every other light and every dot, so all of them are exactly where they were (a test), and a dome starts where its id hashes and is pushed away from everything placed before it, as the others are. Its reach is its radius, which grows with the log of its count between 8 and 24 pixels. It is drawn as a half circle on its base, in its colour, with a glow, a small solid dome at its centre and its count under it. Motion, hover, focus, pinning, the keyboard and the screen-reader summary ("Also 8 large domes: each is a group of Arc registrations that share one wallet, host or profile link ...") work as for the other lights. An Arc registry record (there is none yet) is a dot with the dome as its marker, listed in the key after BNB Chain.

## Not here

- **The hero's Noosphere**, the background of about 1,400 sampled lights. Arc's 244 listed entries are about one light in a thousand of the directory there, and a fifth chain code in the sample's encoding would add a branch for one light. It can be added when Arc is a larger share.

A line under the map links the dated census, [the Arc registry census](./arc-census-2026-10-20.md), when there are domes.

## Held by a test

- `constellationModel.test.ts`: an Arc group's record, its protocol and chain, the eight largest in a fixed order with a tie broken by id, the order after the other lights, the placement that leaves every dot and every other light where it was, the scanner line, the screen-reader summary, Arc's marker equal to its tab icon and its colour equal to the design token, and the key's order.
- `mapFleets.test.ts`: the caption's words, a count of one and of none, and no grading word or long dash.
- `landingHero.test.ts`: the read only while the switch is on, not waited for and not retried, the node kind, the outline and its colour, the card's words and link, and the key entry and the caption.

## Checked

On the built server (built with `chain_arc` on, against a scratch database with a registry in the shape Arc showed on 2026-10-20, 2,721 registrations and 12 groups of 50 or more), in headless Chrome at 1440 and 375 pixels: 8 domes drawn with their counts, the key and the line under the map read as above, the canvas's label describes the domes, the card opens on a dome with the fact, what it does not show and the link to the Arc page, and there is no console error. On a build with every switch off, run against the same database, the map has no dome, no key entry, no caption and no Arc link, and makes no Arc read.
