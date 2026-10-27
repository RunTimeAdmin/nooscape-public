# The Ethereum page (Chain Worlds, stage E)

Front end and one server read, from data that already exists. No migration, no new table, no worker step, no change to the listing rules or the gate.

**Status.** Merged as PR 216 on 2026-10-27 at 14:32Z (branch `feat/ethereum-page`) and live at 14:33Z, behind `chain_ethereum`, which production has on since that day ([the go-live record](./ethereum-go-live-2026-10-27.md)). "Live" below says what was seen.

**Decided:** 2026-10-27, by the operator, in chat: "we need an Ethereum page if we dont have one". Read as the page the other chains have, and as groups only, the way BNB Chain's page is (the operator's rule for BNB Chain, [stage A](./chain-worlds-2026-10-20.md)) and Base's is ("similar to bnb", [stage D](./base-world-2026-10-21.md)), standing on the platforms of the shared fact.

**Why groups only fits Ethereum.** The directory lists 9.4 percent of the registrations the registry holds (5,186 of 55,442), and a few platforms hold much of the rest: one host name holds 18 percent of all of them (10,000), and two wallets hold 18 and 13 percent. A quarter of the listed entries still showed a number for a name when the first pass finished (1,308 of 5,186), and the names step reads a few files an hour. A sample of listed entries would say little about the chain, and a page of groups says what the registry is.

## What a visitor sees

- **The page.** `/chains/ethereum`, World 06, "The pale spire", "A long ledger, read in groups." Sky blue (`#7DD3FC`, the token of its home tab, `--ns-chain-ethereum`) with lavender (`#C4B5FD`) for the lines. A group is a stack of three pentagon plates, the shape of the Ethereum tab's icon. Each platform has small rounded top corners, deeper rounded bottom corners and faint vertical bands. The route exists only in a build that has the switch, the server answers 404 for it otherwise (`FLAGGED_CLIENT_ROUTES`), and its head and its place in the sitemap are written only while the switch is on. The home tab row gets "Open the Ethereum page" after Arc's and Base's.
- **What it shows.** The three figures every chain has (ratings say "Not measured") and the sentence the Ethereum tab has ("The chain holds N registrations. The published listing rules put M of them in the directory; the rest are held out, not judged."). Then three platforms: same host, same profile link, same registering wallet, in the order BNB Chain's and Base's pages use. Each platform draws up to eight groups, the ones that 50 or more registrations share (`FLEET_MIN`), largest first, counted over every registration the registry holds, listed or held out, including those past a host's row cap (`docs/flood-host-cap-2026-10-21.md`). A group's size grows with the log of its count and says nothing else.
- **A group's card.** It says what the group counts ("10,000 registrations on Ethereum point their profile link at agents.exquisite.land"), what that does not show, that a group is not an agent and is not reviewed, and that groups overlap. Ethereum has no census report, so the card links none.
- **No single registration is drawn.** `CHAIN_SHOWS_ACKNOWLEDGED.ethereum` is false, as BNB Chain's and Base's are. It is the one constant to change if the operator wants a sample of listed entries as Arc and Robinhood Chain draw. Ethereum would then also need a sample read: `chainSample` accepts Arc only.
- **The events.** Ethereum has no global feed. The rail says so, and, unlike BNB Chain's and Base's note, points at no census, because there is none.
- **Not on this page.** The share block (a bar of how much of the registry a few wallets hold) is for Robinhood Chain and Arc, which draw entries.

## What is read

`liveData.chainStats` (the figures and the as-of line), `publicRecords` (the reviewed records, none for Ethereum today) and `liveData.registryFleets`, which now accepts `{ chain: "ethereum" }` as it accepts Arc and Base. It reads the registry rows the Ethereum pass stores and returns a shared fact, its kind and how many registrations share it, and nothing about any one registration. It answers nothing while `chain_ethereum` is off, while no Ethereum source is active, and until a walk that reached the finalized head has published. The registry is 47,420 stored rows beside the counts past the host cap, so the read is small, and the answer is held in the directory cache like every aggregate.

## What is held by a test

- `client/src/lib/chainExplorerModel.test.ts`, "the Ethereum world": the page is on offer only while `chain_ethereum` is in the build's list, last when all three extra chains are on; it draws groups and reviewed records only, never an entry a feed or the directory lists, and nothing of another chain; the platforms stand host, link, wallet, with a plate of records after them only when one exists and no empty plate; it has no feed, sets its plates in columns, names its registry and has no census report to link; its colour is the token of Ethereum's tab; its words hold no score, rank or verdict. The worlds are numbered one to six.
- `server/mapFleets.test.ts`: an Ethereum group is a pentagon, words its fact "on Ethereum", shares Arc's note that groups overlap and holds no verdict word. Six chains, six shapes.
- `server/clientRoutes.test.ts`, `server/routeHead.test.ts` and `server/sitemap.test.ts`: the page is served, headed and listed only while its switch is on, and no other chain's switch opens it; six chain pages carry a card and no other fixed page does; each card is a different 1200 by 630 PNG under 600 KB, and its alt text names the chain, says the formations are an illustration, carries the site's two promises and holds no figure.
- `client/src/components/home/chainTabsModel.test.ts`: the page link follows the switch.
- `server/registryFleets.integration.test.ts`, against a real MySQL: Ethereum's groups come from Ethereum's rows only, nothing is served while the switch is off, and Arc's, Base's and Ethereum's never mix.

## Checked

On the built server (`chain_ethereum` on in the client build and at run time), against a scratch MariaDB 10.11 that holds the first Ethereum pass run again with the pass's own code (55,442 recorded, 5,186 listed, the figures production has), in the built-in browser at desktop width and at 375 pixels:

- The page shows three platforms and 21 formations (8 hosts, 5 profile links, 8 wallets), all pentagons, no two overlapping, no horizontal overflow and no console error. The read answered 21 groups drawn of 63 that meet the rule (41 of them wallets) and 55,442 recorded.
- A formation opens its card: "10,000 registrations on Ethereum point their profile link at agents.exquisite.land", the "does not show" note and the overlap note, and no link to a census. The events rail says no global Ethereum feed is published.
- The head carries the page's title and its own card (1200 by 630, 414,376 bytes, served as `image/png`), the page is in the sitemap, and the home row's link opens it.
- With the switch off, the same server answered 404 for the page, left it out of the sitemap, served three chains in the API and answered an empty `registryFleets`.

## Live

All times are UTC on 2026-10-27. The pull request was PR 216, rebase-merged at 14:32Z (main `3a8c520`, the gate green, the merged files identical to the tested branch's) and deployed at 14:33:32Z.

- `/chains/ethereum` answers 200 with the title "Ethereum registry groups | Nooscape", its canonical address and an indexing rule, and its own card in the image tags (served as `image/png`, 391,012 bytes after the CDN re-encodes the 414,376-byte file). The sitemap lists six chain pages, and `verify-live` passed 45 of 45.
- In the built-in browser, at desktop width and at 375 pixels: 21 pentagon formations, no two overlapping, no horizontal overflow and no console error. The worlds row lists six pages, and the home row's "Open the Ethereum page" link opens it.
- The figures on it: 5,185 acknowledged entries, 0 reviewed records, 34,831 ratings recorded (the ratings step has read the chain since 13:45Z; before that the tab said "not measured here"), and "The chain holds 55,442 registrations. The published listing rules put 5,186 of them in the directory; the rest are held out, not judged."

## Not in this stage

- **Lights on the home map, a census report and claims for Ethereum.** Each is its own stop, as each was for Arc. `fleetShape` answers "pentagon" for an Ethereum group and nothing else for the map is built. The Ethereum listing is already in "just arrived", the Owl's Catch's round numbers and the watchlist and webhook, as every extra chain that is on.
- **A decision for the operator: names.** The page names hosts and shortens wallets, as BNB Chain's, Arc's and Base's pages do. On Ethereum that is agents.exquisite.land (10,000), api.normies.art (2,022), ag0.xyz and others, and a profile link that its members name "test". The groups are described neutrally on every card, and the names are public facts, but it is his call whether Ethereum's page should hold back what a census would.
- **A decision for the operator: the title and the words.** "The pale spire" and "A long ledger, read in groups." are the page's name and line, chosen here in the manner of the other worlds. They are one constant each (`CHAIN_WORLDS.ethereum`) and the card carries them.
- **The listing rules** are still BNB Chain's numbers (a link shared by 2, a host by 50, a wallet by 10).

## Files

`client/src/pages/ChainExplorer.tsx` (the page, now reading `registryFleets` for Arc, Base and Ethereum), `client/src/lib/chainExplorerModel.ts` (what is drawn and the words), `client/src/components/chain/FormationMark.tsx` (the pentagon), `chainWorld.css` (the plates), `ChainEventRail.tsx` (the feed note), `client/src/components/home/ChainTabs.tsx` (the link), `client/src/App.tsx`, `server/clientRoutes.ts`, `server/routeHead.ts`, `server/sitemap.ts`, `client/public/nooscape-card-chain-ethereum.png`, `shared/mapFleets.ts`, `server/registryFleets.ts`, `server/routers/liveData.ts`, and the tests above.
