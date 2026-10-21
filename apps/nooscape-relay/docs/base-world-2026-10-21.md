# The Base page (Chain Worlds, stage D)

Front end and one server read, from data that already exists. No migration, no new table, no worker step, no change to the listing rules or the gate.

**Status.** Built and tested on the branch `feature/base-world` (off main `84726f2`), in a pull request with auto-merge off. It is behind `chain_base`, which production already has on, so merging it makes the page live.

**Decided:** 2026-10-21, by the operator, in chat: "merge pr 180 and create a page for base similar to bnb i guess". Read as groups only, as BNB Chain's page is (the operator's rule for BNB Chain, [stage A](./chain-worlds-2026-10-20.md)), standing on the platforms of the shared fact.

**Why groups only fits Base.** The directory lists 2.3 percent of the registrations the Base registry holds ([the census](./base-census-2026-10-21.md): 9,022 of 389,902), and one host name holds 73.6 percent of all of them. A sample of listed entries would say little about the chain, and a page of groups says what the registry is.

## What a visitor sees

- **The page.** `/chains/base`, World 05, "The open shore", "A busy registry, read in groups." Blue (`#3B82F6`, the token of its home tab, `--ns-chain-base`) with cyan (`#67E8F9`) for the lines. A group is a stack of three cross-shaped plates, the shape of the Base tab's icon. Each platform has rounded top corners and faint horizontal bands, a shore. The route exists only in a build that has the switch, the server answers 404 for it otherwise (`FLAGGED_CLIENT_ROUTES`), and its head and its place in the sitemap are written only while the switch is on. The home tab row gets "Open the Base page" beside the three pages that were there and Arc's.
- **What it shows.** The three figures every chain has (ratings say "Not measured") and the sentence the Base tab has ("The chain holds N registrations. The published listing rules put M of them in the directory; the rest are held out, not judged."). Then three platforms: same host, same profile link, same registering wallet, in that order because the hosts hold most of the registry (31 hosts at 50 or more hold 99.5 percent of the registrations with an https link, per the census). Each platform draws up to eight groups, the ones that 50 or more registrations share (`FLEET_MIN`), largest first, counted over every registration the registry holds, listed or held out. A group's size grows with the log of its count and says nothing else.
- **A group's card.** It says what the group counts ("N registrations on Base point their profile link at the same host"), what that does not show, that a group is not an agent and is not reviewed, that groups overlap, and it links the census report. A reviewed Base record would stand on a plate of its own after the platforms. There is none yet.
- **No single registration is drawn.** `CHAIN_SHOWS_ACKNOWLEDGED.base` is false, as BNB Chain's is. It is the one constant to change if the operator wants a sample of listed entries as Arc and Robinhood Chain draw. Base would then also need a sample read: `chainSample` accepts Arc only.
- **The events.** Base has no global feed, as BNB Chain has none. The rail says so and points at the census.
- **Not on this page.** The share block (a bar of how much of the registry a few wallets hold) is for Robinhood Chain and Arc, which draw entries. BNB Chain's page has none and neither does Base's.

## What is read

`liveData.chainStats` (the figures and the as-of line), `publicRecords` (the reviewed records, none for Base today) and `liveData.registryFleets`, which Arc's page already used and which now accepts `{ chain: "base" }`. It reads the registry rows the Base pass stores and returns a shared fact, its kind and how many registrations share it, and nothing about any one registration. It answers nothing while `chain_base` is off, while no Base source is active, and until a walk that reached the finalized head has published.

**The read, made cheaper.** `readRegistryGroups` used to count each kind of group twice, once for how many groups meet the rule and once for the largest eight. Base's registry is about 390,000 rows, so the read had to be looked at. On a copy of the registry holding the last ten days of the chain (284,966 registrations) the cold read took 9.8 seconds. It now ranks every group at the rule in one scan and counts them from the same rows (a registry cannot hold more groups at the rule than its rows divided by 50), and the same read takes 4.8 seconds with the same answer. If it scales with the rows, the census size (389,902) would take about 6.6 seconds on a machine as fast as this one.

The answer is held in the directory cache like every aggregate. The page waits for the read only when the cache has gone cold: after a deploy, or when nobody has read it for five minutes. Every other visit is instant, and the reload after a pass runs in the background. The read is not in the warm-up list on purpose: that list runs after every burst of ingestion writes while someone is reading, and a read this size is not worth running for a page few people open. If the first visitor's wait matters, the two options are a longer TTL for this key, or an index that covers the hidden flag and the host (a migration). Neither is in this stage.

## What is held by a test

- `client/src/lib/chainExplorerModel.test.ts`, "the Base world": the page is on offer only while `chain_base` is in the build's list, after Arc when both are on; it draws groups and reviewed records only, never an entry a feed or the directory lists, and nothing of another chain; the platforms stand host, link, wallet, with a plate of records after them only when one exists and no empty plate; it has no feed, sets its plates in columns, names its registry and links its census; its colour is the token of Base's tab; its words hold no score, rank or verdict.
- `server/mapFleets.test.ts`: a Base group is a cross, words its fact "on Base", shares Arc's note that groups overlap, and holds no verdict word. Five chains, five shapes.
- `server/clientRoutes.test.ts`, `server/routeHead.test.ts` and `server/sitemap.test.ts`: the page is served, headed and listed only while its switch is on, and after Arc's when both are; five chain pages carry a card and no other fixed page does; each card is a different 1200 by 630 PNG under 600 KB, and its alt text names the chain, says the formations are an illustration, carries the site's two promises and holds no figure.
- `client/src/components/home/chainTabsModel.test.ts`: the page link follows the switch. `client/src/pages/baseRegistryReport.test.ts`: a group's card links the census.
- `server/registryFleets.integration.test.ts`, against a real MySQL: Base's groups come from Base's rows only, nothing is served while the switch is off, and Arc's and Base's never mix. The existing tests of the read pass unchanged after the one-scan change.

## Checked

On the built server (`chain_base` on in the client build and at run time), against two scratch databases: a registry in the shape the census showed at a tenth of its volume (47,241 registrations, with 10 wallets, 8 hosts and 8 links at 50 or more) and the 284,966-row copy above (7 groups, no shared link).

In headless Chrome, at 1440 and 375 pixels on the first database and at 1440 on the second: three platforms on the first and two on the second (a platform with nothing on it is not drawn), 24 and 7 formations, no two overlapping, each inside its plate, no horizontal overflow and no console error. On the first, a formation opens its card with the Base wording, the overlap note and the census link. The arrow keys, Home, End, Enter and Escape move between formations, select and clear, and a search keeps only the matching group. The home tab's link opens the page.

Read the way a link-preview crawler reads a page (four crawler agents), the page names its own card in the three image tags, with the same alt text in both alt tags and the shell's type, width and height, and the card is served as `image/png` at 1200 by 630 by GET and by HEAD. The three other chain pages keep their cards and eight other pages keep the site's. With the switch off the page and the census answer 404, no page names Base's card, and the sitemap lists neither.

## Not in this stage

- **Lights on the home map, "New to the Owl", the Owl's Catch lines, the watchlist and the webhook, claims.** Each is its own stop, as each was for Arc. `fleetShape` already answers "cross" for a Base group, and nothing else for the map is built.
- **A decision for the operator: names.** The page names hosts and shortens wallets, as BNB Chain's and Arc's pages do. The census report names none. A host such as the one that holds 73.6 percent of the registry would be named on the page with its count. The groups are described neutrally on every card ("A host can serve many unrelated people"), and the names are public facts, but it is his call whether Base's page should hold back what the census does.
- **A decision for the operator: the listing rules.** They are still BNB Chain's numbers (a link shared by 2, a host by 50, a wallet by 10). The census says what they did, not whether they are right, and so does this page.

## Files

`client/src/pages/ChainExplorer.tsx` (the page, now reading `registryFleets` for Arc and Base), `client/src/lib/chainExplorerModel.ts` (what is drawn and the words), `client/src/components/chain/FormationMark.tsx` (the cross), `chainWorld.css` (the shore plates), `ChainEventRail.tsx` (the feed note), `client/src/components/home/ChainTabs.tsx` (the link), `client/src/App.tsx`, `server/clientRoutes.ts`, `server/routeHead.ts`, `server/sitemap.ts`, `client/public/nooscape-card-chain-base.png`, `shared/mapFleets.ts`, `server/registryFleets.ts`, `server/routers/liveData.ts`, `readRegistryGroups` in `server/agentRegistryRows.ts`, and the tests above.
