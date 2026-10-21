# The head of every routed page (2026-10-18)

The site is a single page app, so a crawler that runs no script (the one behind a post on X, a chat's link preview, a search engine) sees only the head of the shell, `client/index.html`. Until this change that head went out for every address: the homepage's title, and a canonical link and `og:url` that said the page was the homepage. Found by an outside visual audit and checked against the live site on 2026-10-18:

- `/field/bnb-registry-2026-10-16`, `/field/bnb-ratings-2026-10-16`, `/checker` and every `/agents/<id>` answered 200 with the homepage's title, card and canonical address. A shared link to a report previewed as the homepage.
- The sitemap lists eleven pages. Each said it was a copy of the first, so a search engine had reason to index none of them.
- Only `/catch` and `/catch/:date` had their own head (`server/catchPage.ts`).

## What the server writes now

`server/routeHead.ts` is a router mounted in `serveStatic` after the static files and the Catch routes, and before the fallback. It writes the page's own title, description, card text, canonical address and robots rule into the shell with the same `injectHead` the Catch pages use. Nothing else changes: the card image stays the site's, no script is touched, so the policy hashes derived from the shell still match (tested).

| Address | Head |
|---|---|
| `/` | The shell's own, which is right for it. |
| `/catch`, `/catch/:date` | `catchPages`, unchanged. |
| The fixed pages (`ROUTE_HEADS`) | A title, a description and the page's own address. Indexed, except `/admin/sources` (`noindex, nofollow`) and `/404` (`noindex, follow`). |
| `/agents/:id` | The agent's name. A reviewed record is indexed. An acknowledged entry, and an address with no agent behind it, are `noindex, follow`. |
| Any other path | The fallback's, with its real 404. |

A test fails when a route is added to `server/clientRoutes.ts` without a line in `ROUTE_HEADS`, so a new page cannot go out with the homepage's head again.

## The agent pages

`/agents/:id` reads the agent's name from the database (a directory entry by its key first, then the reviewed records), through a cache that holds each id, and an unknown id, for a minute and at most 1,000 ids, so a crawler that fetches many ids cannot make it a read per request. If the read fails the ordinary shell is sent and the log says so once (nothing when the database breaker has already said it).

**One decision to confirm: acknowledged entries are `noindex`.** There are about a quarter of a million of them, each a thin page that says what a source listed and that Nooscape has not reviewed it. Their canonical address used to point at the homepage, so none was indexed in effect, and the sitemap has never listed them. `noindex, follow` keeps that, now said plainly. A reviewed record has its evidence, so it may be indexed. Changing either is one line in `agentMeta`.

## What this does not do

- The card image is still the one image for every page. A card per report, record or fleet is a separate piece of work (an `image` on `PageMeta`, and a way to make the images).
- It does not change the status an unknown agent address gets: the client route answers 200 and the page says "No agent found", as before.
- The shell's own title and card text, for the homepage, still contain a long dash. That is `client/index.html` and was not touched.
