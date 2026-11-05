# The first screen of /developers, in plain words (2026-11-04)

> **Status:** Live since 5 November 2026 (PR 265, merged 01:41 UTC, main fab0ca4). From item 1 of the outside list of 4 November 2026 ("plain integrator quickstart and README opening"). Words and one block of style only: no data, no behaviour, no migration.

## What was wrong

An integrator who landed on `/developers` read "Query the evidence graph. Use the public Nooscape transport to retrieve the reviewed agent directory, evidence tiers, publisher-key states, and signed evidence envelopes. Records enter only through approved sources and explicitly reviewed runs, and every tier upgrade is operator-gated and time-boxed." The check, the call worth building on, was eight screens further down, and nothing on the first screen said what the API is for. The repository README opened the same way ("An evidence-first public Atlas for discovering agents through retained observations, visible source boundaries, and verifiable provenance"). The public README was already plain in its "What Nooscape is" and "Try the API" sections, but its bold tagline carried the same words.

## What changed

- **`/developers`, first screen.** The headline is "Check an agent before you rely on it." One paragraph says what Nooscape reads and keeps (dated facts, no score, no verdict), then three numbered calls in the order a newcomer needs them: look an agent up (no key), search (no key), and check before you pay (a 402 that says how to pay, $0.01 in USDC over x402, or a Pro key). A note points at the examples below and at the skill file. The three badges stay.
- **The skill file link moved up** from a paragraph further down into that note. It is still the only link to `/skill.md` on the page, which a test in `server/discovery.test.ts` holds.
- **The README opens** with "Look up any AI agent and see what the evidence shows" and one sentence on what Nooscape does. The public README's tagline, in `README.public.md` of the mirror tooling, is the first sentence of that: it reaches the public repository with the refresh of 5 November.
- **A source guard** (`client/src/pages/developerHero.test.ts`) holds the first screen to the three calls in that order, the price, and the line "There is no score and no verdict", and keeps the old terms (transport, publisher-key, operator-gated, time-boxed, evidence graph) out of it.

## Checked

- The client run locally with its `/api` calls sent to the live site (read-only): the new first screen at desktop width and at 375 px, where nothing scrolls sideways, with three numbered calls and one skill file link.
- The copy, text-size, reply-promise and score guards and the discovery tests pass, and so does the new guard.

## Live

The new client was served about a minute after the merge. Read on the live site at about 01:44 UTC on 5 November: the headline "Check an agent before you rely on it.", the three numbered calls (look up, search, check before you pay, with the 402 and the $0.01 in USDC over x402), the note under them, and exactly one link to `/skill.md`. `verify-live` passed 48 checks with no warning and no failure, and the push run of CI passed. The branch had to be rebased once before the merge, because the first PR of the pair had changed the neighbouring line of `todo.md`; nothing else conflicted.

## Not changed

- The rest of the page still uses the internal terms (evidence tiers, publisher keys, the tier scale). They are for the reader who goes on, and each section explains itself.
- The npm package description and the llms.txt wording, which say what the same things are in their own places.
