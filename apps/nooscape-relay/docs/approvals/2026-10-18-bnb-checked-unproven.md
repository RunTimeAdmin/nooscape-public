# Decision record: "Checked, unproven" on BNB Chain entries

**Decided:** 2026-10-18, by the operator, in chat. His words: "for BNB allow \"checked, unproven\"". He then chose, from options set out below, what the label is and what "checked" means.
**Changes:** adds one line to the page of every listed BNB Chain entry, "Registration read", in one of two forms ("Checked, unproven" with the date of the read, or "Not checked"), read from the evidence the clustering and registration-file steps already keep. Adds one field to the public entry read.
**Does not change:** that BNB entries are acknowledged and never reviewed (invariant 23, B5 stays closed), any entry's tier, whether it is listed, its order or its place on the map, the hero number, any count, what is fetched or how often, `/checker`, the fleet lights, the census report, or the "what we observed" block, which stays on hold.

## What was asked, and what was found

The operator's message was one line and named no place and no meaning. Two questions fixed both:

1. **Where.** Options: a label on BNB entries; an allowed phrase in the copy rules only; or something from another document. He chose the label on BNB entries.
2. **What "checked" means.** Reading the code before building showed that the first answer rested on a premise that was not true: no check runs on a BNB entry. The entry checks of 2026-10-16 cover A2A endpoints only (`CHECKABLE_SOURCE_PROTOCOLS` in `server/agentChecks.ts` is `["a2a"]`), a BNB entry has only chain facts, and the only thing Nooscape reads about a BNB entry is its registration (the clustering step decodes an inline registration, and the registration-file step fetches the file behind a web or ipfs link), kept as a grouping key with a date and never shown against an entry (invariant 30). Options: a dated registration read (every BNB entry says either checked or not checked); only a fetched file counts (376 of 6,842 on 2026-10-16); or wait for the daily endpoint check that the 2026-10-17 record requires before B5 could reopen. He chose a dated registration read.

The 2026-10-17 draft of the "what we observed" block warned that a line shown only on entries that passed would work as a badge by omission, and said such a block would appear on every BNB entry. That rule is applied here: the line is on every listed BNB entry, in one of two forms.

## What a visitor sees

On the page of a BNB Chain entry, in the "Registry entry" section after the source note, under the heading "Registration read":

| | Title | Text |
|---|---|---|
| A read is on record | Checked, unproven | Nooscape read this entry's registration on Oct 16 at 7:00 AM CT. Nothing in that read proves the agent works or that its registrant controls it. Nooscape has not asked this agent's own address whether it answers. This entry is not reviewed and has no tier. |
| No read | Not checked | Nooscape has not read this entry's registration. That says nothing about the entry. Nooscape has not asked this agent's own address whether it answers. This entry is not reviewed and has no tier. |

It has no colour, no pill, no count and no ordering, and it shows nothing from the registration. The date is in the viewer's own time zone, as the dates in the Checks section of a reviewed record are. An entry of any other protocol has no such line.

## What counts as a read

An entry is "checked" only when its evidence row (`bsc_entry_evidence`, which the clustering step writes and the registration-file step updates) records a read, and the row was made from the link the entry carries now:

- status `inline`: the registration was decoded from the link itself and parsed as a registration for this agent, or
- status `fetched`: the file behind the entry's https or ipfs link was fetched and parsed.

The date is that row's `readAt`. Everything else is "not checked": a link not read yet, a try that got no answer, a file that is not a registration, a link the step does not read (an http address, another scheme, an ipfs address with no CID), an inline registration that does not parse, no evidence row at all, a row made from an older link, and an entry with no stored link hash. A listed entry whose registration file the step has not reached yet is therefore "not checked", and becomes "checked" with a date when the step reads it (the step reads 16 files a run, a run every 30 minutes).

## How it is read

`liveData.agentProfile` and `liveData.directoryEntry` return `registrationRead` on a BNB entry: `{ checked: true, readAt }` or `{ checked: false, readAt: null }`. `server/db.ts` (`getAgentDirectoryEntry`) reads one row of `bsc_entry_evidence` by the entry's source and key, and the rule is `registrationReadOf` in `server/bscRegistrationRead.ts`. With the evidence table missing (migration 0038 not run), nothing has been read, so the answer is "not checked". Any other failure of that read answers `null`, and the page then shows no line at all, so a failed read never says a read happened or did not. The source, the key and the link hash are used inside the read and are not in the answer. No new fetch, no new table, no migration, no worker step.

## What this says and does not say

- **"Checked" means one thing:** Nooscape read the entry's registration, and the date is on record. It is not a check of the agent's own address, and the line says so. That sentence is held to the code: a test fails if the BNB Chain registry is ever added to `CHECKABLE_SOURCE_PROTOCOLS` without the sentence changing first, which is invariant 22 applied to this line.
- **"Unproven" says what the read does not show,** in the same line: it does not prove the agent works or that its registrant controls it. The label is the operator's wording. It is a status word, which the 2026-10-17 draft of the observed block avoided ("no status word (live, healthy, active, failing)"), so it is recorded here as a choice he made and not an inference.
- **It is a dated fact and not a verdict (invariant 21):** it never changes a tier, whether an entry is listed, its order or its place on the map, and it is not a score (invariant 24).
- **Nothing from the file is shown (invariant 30):** only that a read happened and when.
- **The entry stays acknowledged (invariant 23):** the line says it is not reviewed and has no tier, and a test fails on a colour, a count or a badge in the part.
- **Invariant 28:** its "a relabelled entry needs the operator's separate decision" is this decision, for this label only. The endpoint-host groups still draw no light and relabel nothing.

## Held by tests

`server/bscRegistrationRead.test.ts` (the rule for every status, an older link, no hash and no row; the address sentence held to `CHECKABLE_SOURCE_PROTOCOLS`), `server/bscRegistrationRead.integration.test.ts` (against a real database: before the migration, a read from the link and from a file, every status that is not a read, no row, an older link, no stored hash, no field on another protocol's entry, nothing internal in the answer, the entry unchanged, and a failed read answering `null`), and `client/src/lib/registrationReadText.test.ts` (the words in both forms, no verdict, grade or score word and no long dash, and the page wiring: after the source note, no colour, no pill, no count).

Checked on a built server on a scratch database, in headless Chrome at 1440 and 375 wide: an entry read inline, one read from a file, one whose link is not read, one with no evidence and an entry of another protocol; no overflow and no console error.

## Not decided and not built

- **The search results and any other list of BNB entries** do not carry the line. It is on the entry page only.
- **The daily endpoint check.** If it is built, "checked" would have a second meaning, and the line has to say which before the code changes (the test on `CHECKABLE_SOURCE_PROTOCOLS` fails first).
- **The "what we observed" block** stays on hold. This line is smaller and is not that block, but the block's draft should be read alongside it when it is taken up.
- **Whether the wording goes to the operator's legal assistant** is his call. No legal page changed.

## Outcome

- [x] Built, tested against a real database, and checked on a built server (2026-10-18).
- [ ] The operator has read the line as it shows on a page and accepts the wording.
- [ ] Merged and deployed, and checked live on a BNB entry that has been read and one that has not.
