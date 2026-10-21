# Decision record: Saying plainly that Nooscape has issued no token

**Decided:** 2026-10-19, by the operator, in chat, after he found that others had launched tokens named NOOSCAPE: "yes" to a short notice, then the wording he asked for ("not connected to any token using its name" and "nothing on the site is an offer to sell or a place to buy one") and "do the pr", "merge".
**Changes:** one sentence of the same meaning in three places: the home footer, the "What Nooscape is not" page (`/about`), and the Terms ("What it is not"). `legalPages.test.ts` pins the three sentences, and fails if code appears that deploys, mints or sells a token (`deployContract`, `createToken`, `launchToken`, `bondingCurve`).
**Does not change:** any record, score, tier, evidence level or API answer. Nothing was sold or offered before, and the page already said in a note about Noos Network that Nooscape does not issue a token; this makes it plain where a visitor will see it.

## Why

On 19 Oct 2026, at about 17:41 UTC and within seconds of each other, three tokens named NOOSCAPE appeared on Robinhood Chain and on Base (two through one launchpad eight seconds apart, a third as a pool on another venue). The operator reported tokens on Solana and BNB Chain as well; none was found there with the public indexes available, and he asked that they not be chased. Nooscape has issued no token on any chain and has no link to any of them.

## What was and was not done

- The notice was written, tested, shown in the browser and merged (PR 163, 18:38 UTC, live within about two minutes; the live health check passed).
- A short post for X was drafted. **The operator posted nothing.**
- No report was made to any launchpad or platform, and no token address is recorded here. Doing so is the operator's call.

## What the wording must not become

It must not say anything that the site's pay per call contradicts. The API takes payment in USDC for calls, and USDC is not a Nooscape token, so the sentences speak of selling or buying "a token" and of tokens "that use its name", not of payments. A change that issued a token, or made a page an offer to sell one, would have to change these pages first.

## Outcome

- [x] Wording approved by the operator and merged (PR 163, 2026-10-19).
- [x] Live and verified (verify-live 39 passed, 0 failed).
- [ ] Any report to the platforms, and any public post, if the operator wants one.
