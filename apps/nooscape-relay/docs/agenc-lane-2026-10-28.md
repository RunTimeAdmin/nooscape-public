# AgenC's lane on the Solana world page

Front end, one read and the words around them. No migration, no new table, no worker step and no new setting. It is the "page" [the AgenC record](./agenc-solana-2026-10-26.md) left unbuilt (section 10, item 8): a fourth lane on `/chains/solana` that holds a fixed sample of AgenC's entries, read as [Arc's page](./chain-worlds-2026-10-20.md) reads its own.

**Status.** Shipped on 2026-10-28 with the rest of the Base and Ethereum extras (PR 223). The subtitle, the search description and the share card were left open at first and changed the same day in PR 224 (see "The subtitle, the description and the share card").

**Decided:** 2026-10-28, by the operator, in chat: "do these next  Base and Ethereum extras: map lights, census, claims and the Base Owl's Catch and watchlist; the AgenC page". The shape of the answer is mine, chosen to follow Arc's entries zone, so the operator can say no to any of it.

## What a visitor sees

Solana's page had three lanes, one for each registry that records events or has groups: the Metaplex agent registry, the 8004 registry and SAID. It now has a fourth, **AgenC agent registry**, set after SAID's. The lane is labelled "256 listed · no recorded events: a fixed sample of its entries", and it holds small scouts drawn hollow and dashed, as every entry the directory lists and Nooscape has not reviewed is drawn. Selecting one opens its page, and a search on the page that matches an AgenC entry puts that entry in the lane as it does for the other registries. A lane is left out while it has nothing to show, so the page is as it was while AgenC has no sample.

The header gains one sentence while the chain's own count includes AgenC: "AgenC, a fourth registry, records no events, so its lane holds a fixed sample of its entries and nothing in it moves." It replaces the one that said AgenC was counted and not drawn. The registry label under the title reads "Metaplex · 8004 · SAID · AgenC".

## Why a sample and not events or groups

AgenC's pass lists its agents and records no registration, ownership change or profile edit, and it has no group to draw. So no formation, no replay and no activity comes from it. What can be drawn without inventing anything is the entries themselves, and the page already has a rule for that: the fixed sample Arc's page draws, the entries whose ids hash lowest, a rule that ignores quality, 30 of them, the same ones every time while the set is the same. They are acknowledged entries and never reviewed records: no tier, no evidence, no score.

## What is read

`liveData.chainSample({ chain: "agenc" })`, the procedure Arc's page already calls with `{ chain: "arc" }`, cached on the page for ten minutes and on the server by the directory's read cache, and failing closed to an empty sample. Arc's follows Arc's switch. AgenC's has none, because Solana's page has none: nothing holds it back but the source's own state, so a source that is not active lists nothing, as for every public read. The page asks for it only on Solana's page.

## What changed in the code

- `server/routers/liveData.ts` and `server/db.ts`: `chainSample` takes `arc` or `agenc`, and `listMapAcknowledgedSample` takes AgenC's protocol.
- `client/src/lib/chainExplorerModel.ts`: `solana_agenc` is one of the protocols Solana's page accepts, the fourth entry of `SOLANA_LANES`, a lane sublabel, the protocol's name, the registry label, and `sampledRegistryNote` in place of `undrawnRegistryNote` (the lane makes "not drawn" untrue).
- `client/src/pages/ChainExplorer.tsx`: the sample is read on Solana's page and stands with the search matches, and the page waits for it as it waits for Arc's.

## The subtitle, the description and the share card

PR 223 left the page's subtitle at "Three registries. One living field." beside a header sentence about a fourth registry, and the search description and the share card of `/chains/solana` said three as well. The operator asked for them to change on 2026-10-28, in chat: "change the solana subtitle and the three claim issue". I read the second half as every place that still said three of the registries Solana's page maps. What changed:

- **The subtitle** reads "Four registries. One living field." (`CHAIN_WORLDS.solana` in `client/src/lib/chainExplorerModel.ts`). The header sentence about AgenC keeps its words.
- **The search description** (`server/routeHead.ts`), also the text of a link preview: "Explore identity records across Solana's four mapped registries, and the anchored registration events that three of them record. Events are not conversations." It does not say that all four record events, because AgenC records none.
- **The share card** is a new picture with four lanes, METAPLEX, 8004, SAID and AGENC, and the words "Four registries. One living field." The AgenC lane holds acknowledged scouts only, as its lane on the page does. It is `client/public/nooscape-card-chain-solana-four.png` (1200 by 630, lossless, 358,109 bytes). The old `nooscape-card-chain-solana.png` is removed, and the new file has a new name because the platforms that show cards keep one by its address. The alt text names four lanes and AgenC. The builder is still a scratch script outside the repository (`build_cards.mjs`, scene `solanaScene`), and Windows reserves the harness's default debugging port on this PC, so it now takes one from `CDP_PORT` and defaults to 9450.
- **The home page's Solana tab** said "A dated count of what the three registries hold" under a split that now lists four. It names SAID, 8004 and Metaplex, the registries the census of 2026-10-18 counted.

Left as they are: the census of 2026-10-18 and its page, which count the three registries they were written for, the activity feed and its notes, which are the events of SAID, 8004 and Metaplex (AgenC records none), and the older records, which say what was true when they were written.

## Held by a test

- `chainExplorerModel.test.ts`: AgenC's entries stand in a fourth lane after SAID's, with its own label and sublabel, no group, and acknowledged figures with no tier; the lane is left out while there is no sample and the other lanes are as they were; another chain's page does not take AgenC's entries; the protocol's name; and the header sentence, only while the count includes AgenC, with no grading word and no long dash.
- `registryFleets.integration.test.ts` (real MariaDB, with migration 0051 pasted): the sample for AgenC is the 30 entries whose ids hash lowest, in that order, with the number listed, whatever the chain switches say, and nothing while its source is not active; Arc's sample is untouched by it.
- `chainExplorerModel.test.ts`: the number of registries the subtitle counts is the number the registry line under the title names, so a fourth lane cannot sit under "Three".
- `routeHead.test.ts`: each chain card's alt text quotes its page's title and subtitle, so a card cannot keep words the page has dropped; Solana's description, alt text and card file say four, with no "three registries" left in them; the card file name may carry one more word (`-four`).

## Checked

On a build with every chain switch on, in the browser pane at 1440 and 375 pixels, against the live site's API. The live site does not have the new read yet, so the preview server answered `chainSample` for AgenC from real AgenC entries that the live directory search returns and forwarded everything else: the fourth lane reads "AgenC agent registry · 256 listed · no recorded events: a fixed sample of its entries" with its scouts, the header carries the new sentence, a scout's label reads "Acknowledged · not reviewed, in AgenC agent registry", there is no horizontal overflow at 375 pixels and no console error.

The subtitle and the card, on a later build of a second branch, against the live site's API: the new card was rendered at 1200 by 630 and looked at full size (four lanes, the new words, the footer and the tag as on the other cards), Solana's page reads "Four registries. One living field." and then the AgenC sentence with no "Three registries" left on it, the home page's Solana tab reads "A dated count of what SAID, 8004 and Metaplex hold" under the split "SAID, Metaplex, 8004, AgenC", and the page has no console error and no horizontal overflow.
