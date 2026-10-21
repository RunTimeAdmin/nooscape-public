# Decision record: names for the SAID registry entries, read from the cards their links name

**Decided:** 2026-10-18, by the operator, in chat, asked for with: "do Real names for SAID entries (option 4, which needs your decision on response size)." He left the decision on size and pace to the assistant. The limits below are that decision, set out so the operator can read and change them before the change merges.
**Changes:** adds a best-effort step to the worker that reads the card each SAID identity's link names, through the same reader as the other name reads; makes the SAID pass queue the links it reads and lay the names that were read over its drafts; changes the wording on `/checker` and on the sources page. It is the first time Nooscape contacts the SAID project's host: the 2026-10-13 approval said it "does not contact the project: it reads public chain state only".
**Does not change:** D1 (no scoring, no tiers, no quality judgments), the SAID pass's own reads (two requests to the Solana node, the strict decode, the 98 percent floor, the activity ledger), which entries are listed, any count, the reviewed records and their evidence.

## The problem

13,764 SAID entries on the home page and in the directory are called "SAID agent <first 8 characters of the owner wallet>", because the identity account on the chain carries a link and no name. The newest registrations are the ones the home page shows (the new-entries section and the Solana field reports), and all of them read "SAID agent 7Heyt772" and the like.

## What was chosen, and what was not

**Chosen: read the card each identity's link names.** The link is on the chain already (the pass reads it every hour), and the card behind it is a small JSON file with a `name` field. Of 13,313 identities, 12,962 named SAID's own card host at the 2026-10-13 count (`https://api.saidprotocol.com/api/cards/<owner>.json`), and the rest name other hosts. The size question goes away: a card is about 300 bytes (the one checked was 293), and the reader's cap of 256 KiB does not change.

**Not chosen: SAID's list API** (`/api/agents`, which the 2026-10-13 record said would be its own source approval). It would give every name in a few minutes, but:

- It is an address no registration names, a new kind of address for the guardrail that the name reads ask only addresses the registrations themselves name.
- Its order follows SAID's own trust score, which was the same for every record on the page that was checked, so the order among them is not defined, and a walk by offset over some 14,000 records can skip or repeat records between requests. Nothing in the documented parameters asks for the newest.
- Each record carries SAID's computed scores and tiers, which D1 and invariant 14 keep out. They would be read and thrown away.
- A full listing is about 19 MB against the shared client's 16 MiB cap. Pages of 100 are about 140 KB and would fit, so size alone did not decide it.

## What it does

1. **The pass queues the links.** `server/ingestion/runSaid.ts` gets each identity's link from the pass (`SaidPassSnapshot.links`) and, after it has written the directory, adds the links the reader can ask (an https address, or an ipfs address with a CID, up to 512 characters) to `agent_registration_resolutions`, the table the 8004 and Robinhood readers use. A link already there is left alone. The newest identity is dated first, so the oldest-first order the step reads in is newest identity first, without a column for it. Queueing is best effort: a failure is one log line and never fails the pass.
2. **The step reads them** (`server/saidNames.ts`), last in the worker's steps, on a tick that claimed sources and is under 100 seconds old. It reads a link only while an entry still carries it and is still called by the placeholder, so a card an identity has moved away from, or one named another way, is not read. Each try is kept as soon as it is made.
3. **The name is written** to the entries that carry the link, only where the name is still the placeholder, cleaned and cut at 120 characters, with a sentence in the entry's note: "Its name was read from its registration link on <date>; it is the registrant's own claim."
4. **The pass keeps it there.** The pass upserts every identity every hour and sets the name each time, so a name written onto an entry would be gone within the hour (a test shows exactly this). Before it writes, the pass lays the names that were read over its drafts by the hash of the link each identity carries now. An identity that changes its link has no name until the new link is read.

## The limits the operator is asked to approve

| | Limit |
|---|---|
| Cards | At most 20 a run, at most 20 from one host (nearly all are on one host, so that is the run's size), a run at most every 30 minutes (the gate between two runs is 28 minutes, as for the other steps). At most 960 cards a day. |
| Time | Nothing is started after 25 seconds. At one request a second to a host, 20 cards take about 20 seconds. The step starts only on a worker tick that is under 100 seconds old, so it comes last and skips a long tick. |
| Each request | https only, the host's robots.txt first and obeyed, 5 seconds, 256 KiB, 3 redirects with the same checks, the `Nooscape-Checker` user agent, at most 1 request a second to a host and 5 at a time in all. An ipfs link is asked of the configured IPFS gateway. |
| Tries | Five at most for a link that does not answer, two for a card with no name in it, and no sooner than 6 hours after the last try. A card that was read is never read again. |

At that pace the backlog takes about 14 days (13,764 cards at 960 a day), newest identity first, so the names the home page shows come first, and a day's new registrations (about 130 on 2026-10-18) are named within a day of the step reaching them. The constants are in `server/saidNames.ts`, and `/checker` states the pace in words, held to them by a test. To go faster, the per-run count goes up and the same sentence on the page moves with it; the one host's share at one request a second is the real limit, not the page.

## A run against the real host

The real step, with the real reader, was run once from the operator's machine against a scratch database holding five real SAID identities (taken from SAID's public list for this check only): 5 of 5 cards answered, 5 names were written, in 5.5 seconds, and each name was the one SAID's own list shows ("Rusty", "Woofy4", "Snoot", "frank", "elundog"). The host has no robots.txt (a 404, which the reader takes as no restriction). It was a check of the code on real data and not a pass of the production system. Nothing was kept from it.

## What this says and does not say

- **The name is the registrant's own claim.** The card is published by whoever controls the identity, and SAID lets the owner change it without a chain transaction, so a name is a snapshot with the date it was read. A card that was read is not read again, so a later rename shows only when the identity changes its link. This is the same trade the Robinhood and 8004 names make.
- **Some cards have no name.** In a sample of 100 SAID records, 96 had one. A card without one is tried twice and then left as "SAID agent <prefix>".
- **Links the reader cannot ask are left alone:** an `http` address, another scheme, an ipfs address with no CID, or a link over 512 characters. Those entries keep the placeholder.
- **Nothing else of the card is kept or shown:** not the description, the website, the skills or the endpoints.

## Wording

`/checker` now says that Nooscape-Checker also reads the registration link of an agent in the SAID registry, that it reads the link from the chain, that most of those links name a small card on SAID's own host (`api.saidprotocol.com`), and how many cards a run reads and how often. The sources page names the SAID registry among those whose entries' registration links may be read. `server/checkerPage.test.ts` holds each number and sentence to the code.

## Not decided and not built

- **Reading a card again after it was read.** A rename would show only when the link changes.
- **SAID's list API, scores and tiers.** Not read, as before.
- **A faster pace.** The operator can ask for one; the host's share at one request a second is what limits it.

## Outcome

- [x] The operator has read the limits above and accepts them (2026-10-18, in chat, after the change had merged and deployed: "limis accepted").
- [x] Merged and deployed, and the first SAID names seen live (PR 140 merged 2026-10-18 10:47Z; at 15:33Z all 33 SAID events in the Solana feed carried a real name, for example "Lamport Robotics" and "Circuit and Chip", and verify-live passed 38 of 38 with the SAID pass running normally).
- [ ] The backlog read (about 14 days after the step first runs).
