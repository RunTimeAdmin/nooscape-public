# "New to the Owl" for Arc

Front end, the words around it and one read. No migration, no new table and no worker step. It uses the same read as the other three chains, widened to the extra chains whose switch is on.

**Status.** Shipped in PR 178 on 2026-10-20, after the Arc share card.

**Decided:** 2026-10-20, by the operator, in chat: "do the lights  share card  census etc before base", and "lets finish the ARC arc so to say". The Home page's "New to the Owl" section is the part of "etc" that names each chain, so Arc belongs in it. The wording is the other chains' own.

## What a visitor sees

The section under the hero ("In the last 24 hours, New to the Owl") drew three cards, Robinhood Chain, BNB Chain and Solana. While `chain_arc` is on it draws a fourth, Arc, in Arc's light blue, in the same words as the others: how many entries the directory first saw in the window, the three newest by name (each a link to its entry) and when the Owl first saw each. A chain with no approved, active source still says "Not indexed yet" and not zero.

- **What it counts.** The entries the directory lists, by the Owl's own first-seen time. A registration the listing rules hold out is not an entry and is not counted here, as on the Arc tab and page. The time is when the Owl first saw the entry, not when the agent was made, and the section is worded that way ("Entries the directory saw for the first time").
- **A chain's first pass.** On the day a chain's first pass runs, its count is that pass's entries, as it was for the other three. It falls to the entries first seen since once the window has passed.
- **The hero line.** "The Owl first saw N entries in the last 24 hours" adds Arc's entries once Arc is measured, because they are entries the Owl first saw. With the switch off it is as it was.
- **Layout.** Three across as before; four across on a wide screen when there are four; two across on a tablet; one on a phone.

## Any extra chain that is on

The rule is for the extra chains, not for Arc alone: the section draws each extra chain (Ethereum, Base, Arc) whose switch is on in the build, in that order after the original three, and only when the server sent a row for it. Ethereum and Base are listed and counted like Arc (they have no page of their own), so they would get a card the same way when their switches go on. A switch that is on in the build and off on the server draws nothing for that chain.

## What is read

`readDirectoryArrivals` (`server/db.ts`) is still one windowed query over the entries inside the window, with the same visibility rule as every public count. Its list of protocols is the original three chains' plus the extra chains whose switch is on (`extraChainsOn`), so nothing of a chain whose switch is off is read, and the index on the first-seen time (migration 0041) still finds the window. `buildArrivals` (`shared/arrivals.ts`) gives one row per chain in the order of the original three, then one for each extra chain that is on. The row's chain is a `ListedChainKey`; the three original rows are exactly what they were.

## Held by a test

- `shared/arrivals.test.ts`: a row after the original three for each extra chain that is on and none for one that is not (or when no list is given), the extra chain's count, registry split and newest names, not indexed (never zero) with no active source, and zero when it is indexed and has nothing new.
- `server/directoryArrivals.test.ts`, against a real MySQL: Arc is left out while its switch is off though its entries are in the database, and another extra chain's switch does not bring it in; with the switch on its visible entries inside the window are counted and named newest first, an old, a hidden and a paused-source entry are not, the original three read as they did, and a paused Arc source reports not indexed.
- `justArrivedModel.test.ts`: which cards are drawn (Arc only when the build has the switch and the server sent a row, in any case or order of the list), the grid for three, four and more cards, and Arc in the hero line's total once it is measured.

## Checked

On the built server, against a scratch database with 244 Arc entries and a few for each of the other three chains, in headless Chrome at 1440 and 375 pixels. With `chain_arc` on: four cards (Robinhood Chain, BNB Chain, Solana and Arc, 244 new entries and the three newest by name) in one row at 1440 and in one column at 375, Arc in its light blue, no horizontal overflow, no console error, and the hero line reads 251. With it off, from a build without the switch: three cards and 7 in the hero line, as before.
