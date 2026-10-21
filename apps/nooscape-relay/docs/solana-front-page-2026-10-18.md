# Solana on the front page (2026-10-18)

Solana holds about half of the directory's on-chain entries (about 16,900 of roughly 32,500: SAID 13,764, Metaplex 1,596 and 8004 1,506 at the last read), and the front page treated it as one lump. The Field Reports covered Robinhood Chain only, the Solana region tab said "not measured here" for ratings, and "New to the Owl" gave Solana one number. The operator asked how to show more of the Solana side and chose the first two of five options. This record is what was built, what each figure counts, and what was left for later.

## What changed

| Where | Before | Now |
|---|---|---|
| Field Reports | The ERC-8004 registry on Robinhood Chain only | A switch, Robinhood Chain or Solana. Solana shows the newest six registrations, owner or authority changes and profile edits across SAID, 8004 and Metaplex, each with its registry, the time the Owl's pass recorded it and the slot. A line above them counts the events recorded so far per registry |
| Regions, Solana tab | Ratings recorded: "not measured here" | Ratings recorded is the 8004 registry's own feedback counters, summed, with a note that SAID and Metaplex keep no ratings Nooscape reads. Under the figures, "By registry: SAID 13,764 · Metaplex 1,596 · 8004 1,506." |
| New to the Owl | One count for Solana | The same count, with "By registry: SAID n · Metaplex n · 8004 n." under it |

Robinhood Chain and BNB Chain have one registry each, which the chain's name already says, so neither gets a registry line. Pause works on either chain, and switching chains clears a pause.

## What each figure counts

- **Solana ratings.** `countSolana8004Feedback` in `server/db.ts` sums `feedbackCount` over the visible `solana_8004` entries of active sources. That column is the live feedback counter of each AgentAccount, decoded by every 8004 pass (see `server/ingestion/solana8004.ts`). It is read through the directory read cache and the ordinary visibility rule, so a hidden, closed or paused-source account never counts, and a hide shows on the next read. It is null while no 8004 source is active or no account's counter has been read, so "not read" is never shown as zero. A counted zero stays zero. The sum covers 8004 only, and the note on the card says so, so the figure is never read as all of Solana.
- **Registry split.** `ChainStat.registries` and `ChainArrivals.registries` list the protocols behind a chain and their counts, largest first. They are built from the counts the page already reads (the directory breakdown and the arrivals window), so each split adds up to its chain's figure and no new scan was added. Only Solana's three registries are named on the page.
- **Event times.** On Solana the time is when the Owl's pass recorded the event, which bounds when it happened and is not the chain's own timestamp. The slot is the one the pass observed. The lead sentence says so, and an owner change is never read as a sale.

## Requests

The Solana feed is asked for only when the reader switches to it (`enabled: chain === "solana"`), so the front page makes no extra request on load and the first batch is unchanged. The server already keeps that read warm. `chainStats` and `arrivals` gained one field each and no request.

## A registry's batch no longer crowds out the others (the same day, after it went live)

On the live page all six Solana lines were SAID registrations from one pass (08:45 UTC, one slot). The time is when the Owl's pass recorded an event, so a pass that finds 133 new SAID identities records them all at one moment, and the feed, which was the newest 40 overall, held nothing else.

- **Server.** `readSolanaActivityFeed` still returns up to 40 events, newest first, but each registry's newest five are always in (`SOLANA_FEED_FLOOR_PER_REGISTRY`; fewer when the limit is small), and the rest is the newest of what is left. `/changes` gets the same feed, and its header now says how many are shown instead of "newest".
- **Front page.** Field Reports on Solana keeps each registry's newest event in its six lines, then fills with the newest left, and the list is still sorted newest first, so an older 8004 or Metaplex line sits below the newer SAID ones and shows its own recorded time. The lead sentence says "The latest events from each of the SAID, 8004 and Metaplex registries, newest first".
- **One rule.** `shared/balancedNewest.ts` holds it for both sides.
- **A test gap closed.** `vitest.config.ts` listed only `server/` and `client/src/`, so `shared/arrivals.test.ts` (the registry split in New to the Owl) never ran in `pnpm test` or in CI. `shared/` is now included, and that test passes.

## Not in this change

- A dated census report of the Solana registries, like the BNB ones.
- Real names for SAID entries (needs the operator's decision on how large a response may be read).
- Solana fleets on the map (needs a decision on what a Solana light means).

## What was checked

Unit tests for both shared builders and the client models, the ratings sum against a real database (visible accounts only, a hidden account's counter out, an unread counter is not zero, the sum follows a hide and an unhide), and the whole suite. A browser run against a built server with a seeded database, at 1440 and 375 pixels: the Solana tab's figure and note, both registry lines, the switch, six Solana events newest first with the three registries, a pause, the switch back, no Solana request before the switch, 12 pixel text or more, no horizontal overflow and no console error.
