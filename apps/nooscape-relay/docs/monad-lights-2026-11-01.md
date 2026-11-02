# Monad lights on the home map

Front end and the words around them. No migration, no new table, no worker step and no new read: the lights are the groups of the Monad page (`liveData.registryFleets`, [the Monad page](./monad-world-2026-11-01.md)), so the map and the page cannot disagree. It is [the Base and Ethereum lights](./base-ethereum-lights-2026-10-28.md) done for one more chain.

**Status.** Built on 2026-11-01 on branch `feature/monad-extras`, after the Monad page. It is live on the home map only once that pull request merges and deploys, behind `chain_monad`.

**Decided:** 2026-11-01, by the operator, in chat: "do these next", on the list of what Monad still lacked ("a chain page, lights, a share card, a census report, claims and ratings"). The shape of the answer is mine, chosen to follow the Base and Ethereum lights, so the operator can say no to any of it.

## What a visitor sees

Monad appears on the home map as **large stars**: one for each of the five largest groups on the Monad page, drawn in the chain's colour with its count written under it. A group is a registering wallet, a host or a profile link that 50 or more registrations on the chain share. The outline is the one on the Monad tab's icon, a four-pointed star (a circle is BNB Chain, a diamond Solana, a hexagon Robinhood Chain, a dome Arc, a cross Base, a pentagon Ethereum), so no chain is told apart from another by colour alone. The colour is `--ns-chain-monad` (#FB7185), and a test holds it to its design token.

| | |
|---|---|
| The shared fact | one registering wallet, one host or one profile link that 50 or more registrations on the chain share |
| The wording | "8,094 registrations on Monad point their profile link at eve-8004.vercel.app." The wallet and link sentences are Arc's, with the chain's name. |
| What it does not show | a wallet is the address that sent the registrations, a host can serve many unrelated people, and none of it says who runs the agents or whether any of them works |

**Why five.** Base and Ethereum draw five each because eight each put 50 lights on the map and crowded it at 375 pixels, where the live map held 42 with those two at five. Monad's five make 47: dense at 375 pixels, but every light is placed and none is lost. The limit is a constant of its own (`MONAD_LIGHTS_LIMIT` in `shared/mapFleets.ts`), so tuning it never moves another chain. On 2026-11-01 Monad had 10 groups (4 of them registering wallets), so the key reads "Monad groups · 5 of 10 drawn", and the line under the map says the same in a sentence. A light's size grows with the log of its count between 8 and 24 pixels.

The card for a star is the Arc dome's card with the chain's words: the fact with its count, what it does not show, that a group is not an agent and is not reviewed (no tier, no evidence, no link to a record), the chain, the registering wallet where there is one, and "Open the Monad page". A light never opens the evidence read and the Owl is told nothing about one. A test fails on any grading word.

**Overlap.** A registration can be counted in a wallet's light and in its host's light, so two lights can be nearly the same size. The card says groups are counted one by one and can overlap (`ARC_OVERLAP_NOTE`).

**No hollow dots.** Only groups are drawn. The Monad page draws groups only, so the home map shows no more of the chain than its page does.

## What is read

Home asks `liveData.registryFleets({ chain: "monad" })` while `chain_monad` is in the build's switch list. The call is not waited for (the hero's status does not depend on it) and is not retried, so a failed or empty read leaves the map exactly as it was. It is the same cached read the page makes and answers nothing until a walk that reached the finalized head has published.

## How it is drawn

The Monad lights are placed after Ethereum's (`lightOrder` 6), so every other light and every dot is exactly where it was (a test), and a light starts where its id hashes and is pushed away from everything placed before it, as the others are. A star has a point at the light's reach on each axis and a notch between each pair, in the proportion of the tab's icon (0.35 to 1.3). Motion, hover, focus, pinning, the keyboard and the screen-reader summary ("Also 5 large stars: each is a group of Monad registrations that share one wallet, host or profile link, with its count. A star is a group, not an agent ...") work as for the other lights.

`recordChain` no longer sets Monad aside, so a record whose protocols name Monad's identity registry is a dot of that chain, listed in the key after Ethereum. There is none today. The map's chain type is now the whole list of listed chains (`MapChainKey` is `ListedChainKey`).

## Not here

- **A census link under the caption.** Monad had no census report when the lights were built. The report followed ([the record](./monad-census-2026-11-01.md)), and the line under the map links it as it links the other chains' dated reports.
- **The hero's Noosphere**, the background of sampled lights, for the reason the Arc lights give.
- **Hollow dots** for the listed entries, as above.

## Held by a test

- `constellationModel.test.ts` (Monad is a third row of the table that holds Base and Ethereum): a group's record, its protocol and chain, the five largest in a fixed order with a tie broken by id, the order after the other lights, the placement that leaves every dot and every other light where it was, the scanner line, the screen-reader summary, the marker equal to the tab icon, the colour equal to the design token, and the key's order.
- `mapFleets.test.ts`: the caption's words, a count of one and of none, and no grading word or long dash.
- `landingHero.test.ts`: the read only while the switch is on, not waited for and not retried, the node kind, the outline, the card's words and link, and the key entry and the caption.
- Planted bugs: fourteen, each caught by a test. Monad's lights placed first, a light on no protocol of its own, a Monad protocol still no chain on the map, eight lights instead of five, a circle in the key, the key leaving Monad out, a summary that says nothing of stars, a map that takes no Monad lights, a canvas with no star outline, a read that follows Ethereum's switch, a caption never written, a caption that says "star" for "stars", a card that calls the wallet a plain wallet, and a star that is not the tab's icon.

## Checked

On a build with `claims,chain_arc,claims_arc,chain_base,chain_ethereum,chain_monad` in `VITE_FEATURES`, served with its API reads forwarded to the live site (GET only), except Monad's groups, which the preview answers from the local build running against a scratch database that holds the real Monad first pass (Monad is not on the live site yet), in the browser pane at 1440 and at 375 pixels:

- Five stars drawn with their counts beside the other chains' lights, the key reading "Monad groups · 5 of 10 drawn", and the caption under the map after Ethereum's.
- Clicking a star pins it: "eve-8004.vercel.app", "1,999 registrations on Monad record exactly the same profile link", the star beside "Monad" and "Open the Monad page".
- At 375 pixels all five stars are placed (47 lights in all), with no horizontal overflow. On a fresh load with both servers up the console held no error.
