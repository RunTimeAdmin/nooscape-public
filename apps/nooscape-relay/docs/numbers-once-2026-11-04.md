# One count of what is listed, and a page that says what each number counts (2026-11-04)

> **Status:** Live since 5 November 2026 (PR 264, merged 01:20 UTC, main 6937799). From item 6 of the outside list of 4 November 2026 ("reconcile and explain counts on one page"). No migration, no setting, no new read.

## What was wrong

The home page said **46,038 registered agents indexed** under a sentence that names seven chains. The figure counted only the three chains the map draws (Robinhood Chain, Solana, BNB Chain): the Noosphere sample's total is a sum over `NOOSPHERE_PROTOCOLS` (`server/db.ts`, `readNoosphereSampleUncached`). The chain tabs below it, and `/api/v1/stats`, add up to **61,282** across all seven. The README gave 60,257 on 3 November. One site, three totals for what a reader takes to be the same thing, and nothing said why.

Two other counts a reader meets, the 76 reviewed records and a chain's registrations on chain (405,612 on BNB Chain against 6,969 listed), were never set side by side in one place.

## What changed

- **The first hero figure is the agents listed on every chain**, from the chain stats the page already reads (`listedTotal` in `heroModel.ts`). That answer carries the three chains and the extra chains apart (`chains` and `extras`); the first version of the sum took only `chains` and showed 46,294, which a check against the live data caught. `listedTotal` now takes the whole answer, so a chain cannot be left out by the caller. The label is "agents listed from the registries".
- **If the chain stats are not there,** the figure is the map's own count and says so: "registered agents on the map". The figures wait for the chain stats before they show, so the number never changes under the reader.
- **The caption under the map** says "Sample of 770 of 46,038 registered agents on the map", so the map's smaller total is the map's.
- **`/about` has a section, "Reading the numbers"**, with the five counts and what each one is: listed (also called acknowledged, the API's word), reviewed, registered on chain, new in the last day, and on the map. Two carry today's figure (61,282 and 76), read the same way as the hero; the others carry none, because Nooscape holds no site-wide figure for them. The words are in `client/src/lib/readingNumbers.ts`. The map's sentence names the chains from `LIGHT_CHAIN_ORDER`, the list the map is drawn from, so it changes with the map.

## Checked

- **Against the live data**, with the client run locally and its `/api` calls sent to the live site (read-only): the hero read **61,282** (the API's total), the caption read the map's 46,038, and `/about` showed 61,282 and 76. At 375 px wide neither page scrolls sideways.
- Tests: `listedTotal` (the chains and the extras add up to the API's 61,282 from its own per-chain figures; a chain that is not read is skipped, a chain read at zero counts, nothing read is null), the hero figures with and without the total, the caption, and the new words (five terms in order, a figure only beside two, null kept as null, the map's chains held to the map's list, no long dash). The guards for copy and text size, the reply promise and the score ban pass: "24 hours" is written "the last day", because the reply-promise test bars it from the client.
- `pnpm check` is clean and the whole suite passes.

## Live

The new client was served about a minute after the merge. Read on the live site at about 01:25 UTC on 5 November: the hero showed **61,288 agents listed from the registries**, equal to `totals.acknowledged` of `/api/v1/stats` and to the sum of its chain rows (the total had moved from 61,282 as the sources kept reading), and `/about` showed "Reading the numbers" with its five terms, 61,288 beside listed and 76 beside reviewed. `verify-live` passed 48 checks with no warning and no failure, and the push run of CI passed. The section's heading is set in capitals by the stylesheet, so a text search for it has to ignore case.

## Not changed

- The map still draws three chains. Drawing the other four is a piece of work of its own.
- The second hero figure (reviewed, 76) is the sample's own count and equals the public records on `/about`.
- "Listed" and "acknowledged" are both still in use: the hero and the README say listed, the API and the glossary say acknowledged. The first card on `/about` names both.
- The README's dated figures are dated on purpose and are not touched here.
