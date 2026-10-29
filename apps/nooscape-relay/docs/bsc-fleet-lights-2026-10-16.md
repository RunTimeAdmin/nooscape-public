# BNB fleet lights on the home map (PR-B3)

Front end and one read endpoint. No migration, no agent promotion, no change to the listing rules or the gate.

**Status.** Shipped in PR 77 on 2026-10-16. It changed what the home map draws for BNB Chain, and the points under "Decisions needed" were the questions put to the operator when it was built.

## What a visitor sees

The scan map on the home page draws the reviewed records as dots, as before. BNB Chain now appears on it only as **groups**: each of the ten largest groups of registrations that share one fact is one large circle with its count written under it, sized by the log of the count (8 to 24 pixels). No individual BNB Chain registration is drawn.

| Light | The shared fact |
|---|---|
| Same registering wallet | one wallet registered the group |
| Same profile link | the group records exactly one link (the name they record is the title) |
| Same host | the group's profile links point at one host |
| Same registration template | listed entries with the same name, description and endpoint host, digits aside (from PR-B2's groups) |

The card for a light says the fact with its count, what the fact does not show, that a group is not an agent and is not reviewed (no tier, no evidence, no link to a record), and that lights overlap. A line under the map says how many groups are drawn of how many are stored, and that no individual registration is drawn. A light never opens the evidence read, the Owl is told nothing about one, and a test fails on any grading word (scam, fraud, fake, spam, sybil, malicious, suspicious, trust, score, rank).

With the migration not run, or the BNB Chain source not approved, there are no lights and the map has no BNB Chain on it.

## What is read

`liveData.mapFleets`, public, no input, cached with the other directory reads and warmed with them (3 ms warm, 1.4 KB). It reads `bsc_clusters` (PR-B2) and returns:

```
{ fleets: [{ id, kind, name, wallet, count, wallets }] (at most 10, largest first),
  groups: number (all stored groups of the four kinds), registrations: number | null, asOf: string | null }
```

A light's `id` is derived from the shared fact; the stored key of a link or a template is never returned, and no registration, entry or agent is. A wallet light carries the wallet, a chain fact the Home wallet cards already show. It answers an empty list when the table is missing, the source is not approved, or the read fails, and the page treats that as "no lights".

## How it is drawn

The lights are placed after the dots and never move them: the dots are exactly where they were with or without lights (a test). Each light starts where its id hashes and is pushed away from the dots and the lights placed before it, leaving room for its count, trying up to 24 starting places and keeping the one with the least overlap. The same ids give the same places on every visit. The faint links join the dots only.

The map waits for the read in the same batch as the records, so the page below does not shift when the lights arrive, and the read is not retried.

## Checked

In headless Chrome against the real built server and the real endpoint, on a database seeded with the registry's measured groups (every other read answered from the live site): ten lights, 76 records, the key ("BNB Chain groups · 10 of 226 drawn"), the caption, the card for a scanned and a pinned light and for a wallet light, at 1440 and 375 wide, no console errors, no horizontal overflow, and no individual BNB Chain registration in the keyboard list or the key. Frame time with the lights is the same as without (mean 19.2 against 19.3 ms at 1440, 16.7 against 16.7 ms at 375, no frame over 50 ms). Unit tests cover the shaping, the words, the placement and the wiring; the endpoint is tested against a real database, before and after the migration.

## Decisions needed

1. **The hollow sample is gone from the map (the last commit).** The 2026-10-15 decision put 30 individual BNB Chain registrations on the map as hollow squares (docs/approvals/2026-10-15-informational-use-and-bnb-map.md). The B3 brief says no individual BNB Chain agent is drawn, so the page no longer asks for them and the two public sentences that said acknowledged entries appear on the map as a hollow sample (the tier explanation and the glossary) now say only that an acknowledged entry never appears as a reviewed record. `liveData.mapAcknowledged`, its test and the hero's way of drawing a sample are left in place, so dropping that commit brings the hollow squares back beside the lights.
2. **Order of shipping.** Until migration 0038 is run and the clustering has filled `bsc_clusters` (about three hours of worker ticks), there are no lights. If the last commit ships first, the map has no BNB Chain on it for that time. Running the migration first avoids it.
3. **The hero backdrop is unchanged.** The field of lights behind the home headline is a sample of registrations of every chain, drawn unnamed and unselectable, and BNB Chain's listed registrations are in it. It is not the scan map and nothing there can be read or opened, so it is left alone; folding BNB Chain out of it would be a separate change.
4. **Ten lights, overlapping.** The ten largest groups of any kind are drawn. Groups overlap (a platform's registrations can share a host and a wallet), so the map does not add them up, and the card says so. One platform can have more than one light (evoevo.ai has two hosts). A wider cut, or one light for each kind, is a choice for the operator.
5. **Titles are names the registrations record.** "Ave.ai Trading Agent" is the name 126,839 registrations record, not a statement about who runs them; the card says "the name they record" under the title and the fact sentence names only the shared link.

## Files

`server/mapFleets.ts` (read), `shared/mapFleets.ts` (shapes, titles, the sentences), `server/routers/liveData.ts` and `server/warmReads.ts` (the procedure and its warm-up), `client/src/components/home/constellationModel.ts` (the fleet node, its placement, the legend, the summary), `AgentConstellation.tsx` (drawing), `CheckCard.tsx` (the card), `client/src/pages/home/LandingHero.tsx` and `client/src/pages/Home.tsx` (wiring).
