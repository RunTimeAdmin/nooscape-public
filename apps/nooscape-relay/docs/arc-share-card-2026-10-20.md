# A share card for the Arc page

A static picture and the head the server writes. No migration, no new read, no change to a page and no change to the gate. It follows [the cards of the other three chain pages](./chain-worlds-2026-10-20.md) (stage B3), which are built the same way.

**Status.** Shipped in PR 178 on 2026-10-20, after the Arc census.

**Decided:** 2026-10-20, by the operator, in chat: "do the lights  share card  census etc before base". The picture and its words are mine, chosen to match the other three.

## What a link to the Arc page shows

When the Arc page is linked on X, Telegram, Slack, Facebook or any other place that shows a preview, the preview is a card of its own and not the site's one card. It is a 1200 by 630 PNG, `client/public/nooscape-card-chain-arc.png` (432 KB, under the 600 KB a test allows), in the style of the others: the dot grid, the spaced eyebrow ("World 04 / Arc") with Arc's light blue, the world's title ("The glass harbor") in the site's two typefaces, the page's own line ("A new registry, read in full."), one plain sentence, the site's footer promise and the note "Illustration, not agent activity".

The picture is the page's own structure, drawn with the page's own marks. Four arched platforms, as on the page: same wallet, same host and same profile link hold dome formations (the mark the Arc lights use on the home map), and entries holds small scouts drawn hollow and dashed, as entries the directory lists and Nooscape has not reviewed are drawn everywhere.

## What it does not carry

- **No figure.** A platform keeps a card by its address, so the card holds no count, share or date its page could outgrow. The sizes of the domes follow the page's own scale and are a picture, not a measurement. The numbers are on the page and on [the dated census](./arc-census-2026-10-20.md). A dated card for the census report is a different thing, because a report's figures never change. It is not built.
- **No claim about an agent.** The alt text names Arc, says the scouts are an illustration, carries the site's two promises and holds no figure.

## How the page gets it

`ROUTE_HEADS["/chains/arc"]` now has an `image`, as the three others do, and `injectHead` writes it into `og:image`, `og:image:secure_url`, `twitter:image` and the two alt tags. The shell's type, width and height stay, because every card is a 1200 by 630 PNG.

It stays behind `chain_arc`. The head is written only while the switch is on (the route answers 404 otherwise, and a 404 carries the shell's head and not the page's), so with the switch off no page names the card. The PNG sits in the public folder as any image does, and nothing links to it while the switch is off. The file is named for the picture, so if the picture ever changes it needs a new name: the platforms that show cards keep one by its address.

## How it was made

From the site's own `FormationMark` (with its dome) and `AgentFigure` drawings and the two typefaces (Space Grotesk and DM Mono, from the packages the site already uses), laid out as a page at 1200 by 630, captured in headless Chrome and saved as a lossless PNG. The builder is a scratch script and is not kept in the repository, as with the other cards.

## Held by a test

`server/routeHead.test.ts`: the four chain pages carry a card and no other fixed page does; each is a different 1200 by 630 PNG under 600 KB in the public folder and not the site's card; the alt text of each names its chain, says the scouts are an illustration, carries the site's two promises, holds no figure or long dash and is no longer than 420 characters; and with the Arc switch on the page's five tags carry Arc's card and the same alt text in both alt tags, while with it off the page is the fallback.

## Checked

On the built server (against a scratch database), read the way a link-preview crawler reads a page (`Twitterbot`, `facebookexternalhit`, `Slackbot` and `TelegramBot`):

- **Switch on.** `/chains/arc` names its own card in `og:image`, `og:image:secure_url` and `twitter:image`, with the same alt text in both alt tags, the shell's type, width and height, `summary_large_image` and the page's canonical address. The card is served as `image/png` by GET and by HEAD at 1200 by 630. The other three chain pages keep their own cards and every other page, the Arc census report included, keeps the site's card.
- **Switch off.** `/chains/arc` and the census report answer 404, no page names the card, and the other three keep theirs.
