# The Monad page (Chain Worlds, stage F)

Front end and one server read, from data that already exists. No migration, no new table, no worker step, no change to the listing rules or the gate.

**Status.** Built on 2026-11-01 on branch `feature/monad-extras`, with the Monad lights, ratings and claims that follow it in the same pull request. It is live only once that pull request merges and deploys, behind `chain_monad`, which production has on since the Monad go-live ([the record](./monad-erc8004-2026-11-01.md)). "Checked" below says what was seen on a built server.

**Decided:** 2026-11-01, by the operator, in chat: "do these next", on the list of what Monad still lacked ("a chain page, lights, a share card, a census report, claims and ratings"; `/chains/monad` answered 404). Read as the page the other chains have, and as groups only, the way BNB Chain's, Base's and Ethereum's pages are ([stage A](./chain-worlds-2026-10-20.md), [stage D](./base-world-2026-10-21.md), [stage E](./ethereum-world-2026-10-27.md)), standing on the platforms of the shared fact.

**Why groups only fits Monad.** The directory lists 1.4 percent of the registrations the registry holds (144 of 10,421), and one host name holds most of the rest: eve-8004.vercel.app has 8,094 of them (78 percent), 2,000 stored and 6,094 counted past the host cap ([the flood cap](./flood-host-cap-2026-10-21.md)). Many of the listed entries still show a number for a name while the names step reads the files their links name. A sample of listed entries would say little about the chain, and a page of groups says what the registry is.

## What a visitor sees

- **The page.** `/chains/monad`, World 07, "The coral loom", "A young registry, read in groups." Rose (`#FB7185`, the token of its home tab, `--ns-chain-monad`) with indigo (`#A5B4FC`) for the lines. A group is a stack of three plates in the shape of the Monad tab's icon, a four-pointed star. Each platform has even rounded corners and a faint woven lattice. The route exists only in a build that has the switch, the server answers 404 for it otherwise (`FLAGGED_CLIENT_ROUTES`), and its head and its place in the sitemap are written only while the switch is on. The home tab row gets "Open the Monad page" after Ethereum's.
- **What it shows.** The three figures every chain has (ratings say "Not measured" until the ratings step reads Monad) and the sentence the Monad tab has ("The chain holds N registrations. The published listing rules put M of them in the directory; the rest are held out, not judged."). Then three platforms: same host, same profile link, same registering wallet, in the order the other group pages use. Each platform draws up to eight groups, the ones that 50 or more registrations share (`FLEET_MIN`), largest first, counted over every registration the registry holds, listed or held out, including those past a host's row cap. A group's size grows with the log of its count and says nothing else.
- **A group's card.** It says what the group counts ("8,094 registrations on Monad point their profile link at eve-8004.vercel.app"), what that does not show, that a group is not an agent and is not reviewed, and that groups overlap. The census report followed ([the record](./monad-census-2026-11-01.md)), and the inspector of a group links it.
- **No single registration is drawn.** `CHAIN_SHOWS_ACKNOWLEDGED.monad` is false, as BNB Chain's, Base's and Ethereum's are. It is the one constant to change if the operator wants a sample of listed entries; Monad would then also need a sample read, and `chainSample` accepts Arc and AgenC only.
- **The events.** Monad has no global feed. The rail says so and points at no census, as Ethereum's does.
- **Not on this page.** The share block (a bar of how much of the registry a few wallets hold) is for Robinhood Chain and Arc, which draw entries.

## What is read

`liveData.chainStats` (the figures and the as-of line), `publicRecords` (the reviewed records, none for Monad today) and `liveData.registryFleets`, which now accepts `{ chain: "monad" }` as it accepts Arc, Base and Ethereum. It reads the registry rows the Monad pass stores and returns a shared fact, its kind and how many registrations share it, and nothing about any one registration. It answers nothing while `chain_monad` is off, while no Monad source is active, and until a walk that reached the finalized head has published. The read is small, and the answer is held in the directory cache like every aggregate.

## What is held by a test

- `client/src/lib/chainExplorerModel.test.ts`, "the Monad world": the page is on offer only while `chain_monad` is in the build's list, last when all four extra chains are on; it draws groups and reviewed records only, never an entry a feed or the directory lists, and nothing of another chain; the platforms stand host, link, wallet, with a plate of records after them only when one exists and no empty plate; it has no feed, sets its plates in columns, names its registry and has no census report to link; its colour is the token of Monad's tab; its words hold no score, rank or verdict. The worlds are numbered one to seven.
- `server/mapFleets.test.ts`: a Monad group is a star, words its fact "on Monad", shares Arc's note that groups overlap and holds no verdict word. Seven chains, seven shapes.
- `server/clientRoutes.test.ts`, `server/routeHead.test.ts` and `server/sitemap.test.ts`: the page is served, headed and listed only while its switch is on, and no other chain's switch opens it; seven chain pages carry a card and no other fixed page does; each card is a different 1200 by 630 PNG under 600 KB, and its alt text names the chain, says the formations are an illustration, carries the site's two promises and holds no figure.
- `client/src/components/home/chainTabsModel.test.ts` and `client/src/components/chain/chainComponents.test.ts`: the page link follows the switch, and the event rail words Monad's missing feed as Monad's.
- `server/registryFleets.integration.test.ts`, against a real MySQL and MariaDB: Monad's groups come from Monad's rows only, nothing is served while the switch is off, and Arc's, Base's, Ethereum's and Monad's never mix. The test pastes migration 0053 by hand, as production has it, because the boot runner skips it.

## Checked

On the built server (`chain_monad` on in the client build and at run time), against a scratch MariaDB 10.11 that holds the real first pass run again with the pass's own code (21,050 events accepted, 10,421 registrations recorded, 144 listed), in the built-in browser at desktop width and at 375 pixels:

- The page shows three platforms and 10 formations (5 hosts, 1 profile link, 4 wallets), all stars, no two overlapping, no horizontal overflow at 375 pixels and no console error. The figures read 144 acknowledged entries, 0 reviewed records and "Not measured" ratings, and the sentence "The chain holds 10,421 registrations. The published listing rules put 144 of them in the directory; the rest are held out, not judged."
- The head carries the page's title and its own card (1200 by 630, 416,126 bytes, served as `image/png`), a canonical address and an indexing rule, and the page is in the sitemap. The stats API lists Monad beside the three original chains.
- Planted bugs: twelve, each caught by a test. A world left out of the build's list, a page that may draw single listed entries, a group filtered under Ethereum's protocol, an unnamed registry, a group drawn as a pentagon, a group worded as BNB Chain's, a page the server does not serve behind its switch, a sitemap line left out, Ethereum's card file, a home link to nowhere, a groups read that refuses Monad, and a rail with no note of its own.
- Not run on a real server: the switch-off case (no page, no sitemap line, no head). The route, head, sitemap and fleets tests hold it.

## Not in this stage

- **Lights on the home map, ratings, claims and a census report.** Each is its own commit on the branch, and the census report followed the operator's counts ([the record](./monad-census-2026-11-01.md)).
- **A decision for the operator: names.** The page names hosts and shortens wallets, as the other group pages do. On Monad that is eve-8004.vercel.app (8,094), agent-arcade-steel.vercel.app (762), api.monadmogs.xyz (528), dashboard.dev.fun (483) and execution.market (51), and wallets such as 0x6fc3...e536 (762). The groups are described neutrally on every card, and the names are public facts, but it is his call whether Monad's page should hold back what a census would.
- **A decision for the operator: the title, the words and the colours.** "The coral loom" and "A young registry, read in groups." are the page's name and line, chosen here in the manner of the other worlds. The rose is the tab's own token, and the indigo and the lattice are choices made here. They are one constant each (`CHAIN_WORLDS.monad`, `chainWorld.css`) and the card carries them.
- **The listing rules** are Monad's own (`MONAD_LISTING_RULES`), set when the chain was added.

## Files

`client/src/pages/ChainExplorer.tsx` (the page, now reading `registryFleets` for Arc, Base, Ethereum and Monad), `client/src/lib/chainExplorerModel.ts` (what is drawn and the words), `client/src/components/chain/FormationMark.tsx` (the star), `chainWorld.css` (the plates), `ChainEventRail.tsx` (the feed note), `client/src/components/home/ChainTabs.tsx` (the link), `client/src/App.tsx`, `server/clientRoutes.ts`, `server/routeHead.ts`, `server/sitemap.ts`, `client/public/nooscape-card-chain-monad.png`, `shared/mapFleets.ts`, `server/registryFleets.ts`, `server/routers/liveData.ts`, and the tests above.
