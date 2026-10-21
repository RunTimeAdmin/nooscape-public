# Decision record: a published BNB census report, and B5 stays closed

**Decided:** 2026-10-17, by the operator, in chat, in answer to the questions on PR-B5 and to the review of the first census run. The quotations below are the operator's own words from that exchange. **Sign-off on the quoted wording:** given on 2026-10-17. The operator's legal assistant read the quoted wording and signed off, as the operator reported in chat. These are the words as sent.
**Changes:** adds a published census report to the uses of the informational decision of 2026-10-15; logs a deviation in the 2026-10-16 census run; changes the words BNB entries and the home page use about fetching; records, as decisions that apply only if PR-B5 reopens, the operator's answers on how a promotion would work; and, in answers given later the same day, adopts the endpoint-host rule for later passes, puts the "what we observed" block on hold and settles the consecutive-days point.
**Does not change:** D1 (no scoring, no tiers, no quality judgments for the BNB pass), D2 as the 2026-10-15 record left it (reversed for informational use only), the reviewed-run publication gate, the map rule of the 2026-10-15 record, and the hero number.

## What was decided

1. **PR-B5 stays closed.** The operator: "Decision 1: no. I'm not reversing "informational only" for BNB. B5 stays closed. BNB entries stay acknowledged, not reviewed, and nothing gets promoted into the reviewed census. G3 and G5 don't get built now, and neither does the promotion migration. The hero number stays exactly what it is today. No BNB entry touches it." Nothing in the BNB pass, the clustering, the fleet lights or the report promotes an entry or touches the reviewed counts.

2. **A census report is published under informational use.** The operator: "I still want the site to carry real information, though. B1 found things worth reading, and informational use should cover publishing them." It fits inside the 2026-10-15 record, which allows fetching to record plain facts with their date, shown as facts, never as a score or a verdict, and never changing a tier, visibility, order or place on the map. The report is an aggregate of one dated run about the registry as a whole. It lists no agent, ranks nothing and gives no score. The rules the operator set for it:
   - It is static and dated, at `/field/bnb-registry-2026-10-16`, with the date and the finalized block in its header.
   - "No operator or host names go on the report." It says "two host names" and never "two operators".
   - The "not junk" step is dropped, and the word does not appear on the page: "Drop the "not junk" step from the public report. I'm not amending D1." Figures that depended on the filter were recomputed from the saved output of the run (no new request) and are labelled "recomputed from the saved B1 output, junk filter removed" in the data file. The B1 document got a dated addendum with the old and new values side by side, and its own numbers were not edited.
   - "Take the footnote approach. Publish B1 as measured, with the independence rule as specified." The report carries one labelled line saying that 328 independents sit on two host names that no rule groups together, so the independent count is probably too high.
   - It says why its group count (150 groups holding 930 entries) differs from the one the worker's clustering step counts on the same registry (141 groups holding 908 entries): that step uses only registrations that hold their file inside themselves. (Corrected 2026-10-17: the page first said the fleet lights count the 141 groups. The lights are built from the groups that step stores, but they draw only the ten largest groups of any kind, and the ten drawn were platform hosts, shared links and wallets, so the 141 template groups are not what the map shows.)
   - It has a section, "What this does not show", built from the measurement's own caveats.
   - Every number on it is in `client/src/lib/bnbRegistryReport.ts` with its source, and a test fails if the page and the file, or the file and the documents it names, disagree.

3. **The words about fetching were wrong and were changed.** The line on BNB entries ("Nooscape did not fetch it") and the sentence on the home page's BNB card ("Nooscape did not fetch any profile link") stopped being true for the registrations the run fetched. The operator: "Yes, reword the "Nooscape did not fetch it" line at bscChain.ts:241. B1 fetched 142 web links and 225 ipfs links plus the addresses inside them, so the current line is false for those entries. Reword it to say what happened and why, in neutral words, and use "reason not recorded" when the reason isn't known." The new sentence says the directory pass records chain data only and did not fetch the link, and that a one-off census on 2026-10-16 fetched some registration links, and which ones is not recorded. The reason the pass fetched nothing is known, so "reason not recorded" is not needed on that line. Notes stored before the change are served as the new sentence; no stored row was rewritten.

4. **The endpoint-host rule is not part of this.** The operator: "Do not add the endpoint-host rule to production clustering as part of this work. It would add two lights to the map ... That changes the map, so it needs its own decision from me." It stays a separate decision. What it would change: a new kind of group for listed entries that declare an agent address on a host shared by 50 or more listed entries, which today is two host names (the two the measurement names) and nothing else; 328 independents would move into those groups (5,912 to 5,584); the report's numbers would not change under the footnote approach. **Correction to the premise recorded above:** the map would not gain two lights. It draws only the ten largest stored groups (`MAP_FLEETS_LIMIT` in `shared/mapFleets.ts`), and by the 2026-10-16 measurement (docs/bsc-clusters-2026-10-16.md) the tenth largest holds 1,165 registrations, so groups of 257 and 102 entries would be stored and counted in the key's total of groups ("10 of 226 drawn" would read "10 of 228") and would not be drawn. The decision to leave the rule out of this work stands. (The operator then decided the rule itself later the same day: see "Answers given later on 2026-10-17".)

## Deviation: what the 2026-10-16 run did that the 2026-10-15 record did not allow

The operator: "I accept the 2026-10-16 pass as it was run. Any later pass has to stay inside whatever limit the record says unless I amend it in writing." The run was a one-off measurement (docs/bsc-b1-measurement-2026-10-16.md), made with the shared safe fetch.

| Bound in the 2026-10-15 record | What the run did |
|---|---|
| A 4 KiB body cap for a probe | **Not held.** Agent addresses were read up to 64 KiB, so that an A2A agent card could be read from the same response. Registration files were read up to 256 KiB, which is the cap the Solana 8004 name reader already uses. |
| The page the user agent names says what is asked | **Not held at the time.** `/checker` did not describe BNB registration files or the agent addresses in them until 2026-10-17. The measurement flagged this, the page now says it, and the report ships with that page and not before it. |
| "The BNB pass still fetches nothing", and the public copy that says Nooscape did not fetch any profile link stays until the first check runs | The pass still fetches nothing. The run was a separate tool, and it did fetch registration links. The copy was untrue for those entries from 2026-10-16 and was corrected on 2026-10-17 (decision 3). |
| https only, host resolved and every address checked, connection made to the address checked, at most three redirects with the same checks, a 5 second timeout, a refusal for a host that has opted out | Held. The shared safe fetch enforces them. |
| At most 5 fetches at once, 1 a second per host, a budget per run | Held: 5 at once (2 for the IPFS gateway), one second between two requests to a host, a request budget set, robots.txt read first. |

Also true of the run and not a bound in the record: the ipfs files were read through a third-party public gateway (`ipfs.filebase.io`), because the other public gateways answered 429 to the user agent, and not through Nooscape's own gateway (docs/ipfs-gateway-2026-10-16.md). `/checker` now says so.

**Consequence for any later pass.** The record's 4 KiB probe cap would stop a later pass from reading an A2A card, and a later registration-file read would need the 256 KiB cap the page states. Either needs the operator's written amendment first.

## Decisions that apply only if PR-B5 reopens

The operator, in answer to decisions 2 to 5: "Decisions 2 to 5 only matter if B5 reopens. I'm answering them now so they're on record." **None of these applies today. Nothing is built for any of them, and no code reads them.**

1. **Who promotes.** "Promotion would go through a human queue. I approve each entry myself. No automatic rule promotes anything."
2. **G3 is required.** "G3 control proof would be required. No G3, no promotion."
3. **What a promoted entry gets.** "A promoted entry would get Tier 3 and nothing new. The page would list which proofs passed and when, and what they don't prove."
4. **Demotion.** "Demotion would be automatic and would only ever remove light. It would take 3 failed daily checks on 3 different days. Restoring would take 3 passes in a row. That protects entries from one bad day on someone's server." **Made exact on 2026-10-17:** "Three failed daily checks means consecutive days. Restoring takes three consecutive passes. A day when the checker didn't run counts as neither." So demotion needs a failed check on each of three consecutive days, and restoring needs a passed check on each of three consecutive days. A day with no check run is not a failed day and not a passed day, so it cannot be one of the three, and a run of failures or of passes does not carry across it. This still applies only if PR-B5 reopens.
5. **Before it reopens.** "Before B5 reopens, the daily BNB endpoint job has to exist and run for at least a week. I want the flap rate it shows before I commit to a number."

The display rule of 2026-10-16 (a miss is called "not answering" only after the last three asks in a row got no answer) is a different rule from the demotion above and stays as it is.

## Answers given later on 2026-10-17

The operator, on the three points the record left open. The quotations are his words.

1. **The endpoint-host rule is adopted for later passes.** "Endpoint-host rule: yes to storing the two groups, with the rule's date and version recorded on each stored group. The B1 report keeps its measured numbers and the footnote. The rule governs future passes only. No new map lights without a separate decision from me." Built as a table of its own, `bsc_endpoint_host_groups` (migration 0040, run by hand), with the rule's version (`endpoint-host/1`) and its date (2026-10-17) on every row ([docs/bsc-clusters-2026-10-16.md](../bsc-clusters-2026-10-16.md), "Endpoint-host groups"). What it does and does not do:
   - It stores a host that 50 or more listed entries declare as the host of their first agent address. The measurement found two.
   - It draws no light. The map and the key's total read `bsc_clusters` only, and a test fails if another file reads the new table. This also corrects the remark in decision 4 that the stored groups would be counted in the key's total: in a table of their own they are not.
   - It changes no entry's G1 result. The decision 4 premise that 328 independents "would move into those groups" does not happen in the stored entries: the groups sit beside them, and no figure on the site or in the report moves.
   - The report keeps its measured numbers and its footnote. The rule was not part of the 2026-10-16 measurement.
   - A light for these groups, or any use of them to relabel an entry, needs a separate decision.

2. **The "what we observed" block is on hold.** The operator: "What we observed" block: hold. Build nothing until the report has been live and I've shown the draft to a few outsiders. Leave the wording in the approval record as a draft. The wording under "Not decided and not built" stays a draft. Nothing is built for it and no code reads it.

3. **Consecutive days.** "Three failed daily checks means consecutive days. Restoring takes three consecutive passes. A day when the checker didn't run counts as neither. Write that into the approval record, still marked “applies only if B5 reopens”." It is written into item 4 of "Decisions that apply only if PR-B5 reopens", above. It still applies only if PR-B5 reopens, and nothing is built for it.

## Not decided and not built

- **A "what we observed" block on each BNB entry page: on hold, and this paragraph is a draft.** The operator asked for a paragraph on how it would avoid reading as a verdict, and on 2026-10-17 put it on hold until the report has been live and he has shown the draft to a few outsiders. Nothing is built. The wording may change after they have read it. It would be a dated log and nothing else. Each line would be one fact in plain past tense with its date and source, such as "Registered on 2026-03-14, block 83,115,402", "Registration file read on 2026-10-16: it had a name, a description and one https address", or "The address answered a plain GET on 2026-10-16 with status 200". There would be no badge, no colour for good or bad, no status word (live, healthy, active, failing), no count or total across lines, and no ordering by how much was found. A fact that was not observed would have no line and would not be shown as a gap, and one fixed sentence under the block would say what it does not show: that an answer says nothing about whether the agent works, and that no line means nothing was asked or recorded, not that something failed. Dates would be absolute. A request with no answer would follow the display rules of 2026-10-16: one miss is shown as a dated fact, "not answering" only after three asks in a row, and a 404 or 405 to a plain GET worded as "a plain GET is not served there". The block would look the same on every entry and read only from the checks table, never from the census, so no report figure becomes a line on an entry. Today a BNB entry has only chain facts, because no BNB check runs, so the block would hold registration facts until a recurring BNB check is approved. The one risk is selection: if the block appeared only on entries that answered, it would work as a badge by omission, so it would appear on every BNB entry and say plainly when there is nothing to list.
- **Migrations 0038, 0039 and 0040.** The operator runs them by hand (docs/bsc-clusters-2026-10-16.md, docs/bsc-rater-credibility-2026-10-16.md). The report does not depend on them. The fleet lights depend on 0038. 0040 is the endpoint-host table; nothing reads it.

## Outcome

- [x] `/checker` describes the one-off census of 2026-10-16: dated, not a recurring BNB check, the real read sizes, the gateway, the hours.
- [x] The BNB entry note, the home page's BNB card sentence and the guard test that holds them say what happened.
- [x] The report page, its data file and its test; the dated addendum to the B1 document.
- [x] [bsc-erc8004-2026-10-13.md](../bsc-erc8004-2026-10-13.md) says PR-B5 is still closed and that a census report is published under informational use.
- [x] Deployed and checked live (the report page #117 at 2026-10-17 16:30Z, the home links to both reports #118 at 17:07Z).
- [x] The endpoint-host rule, built as a table of its own with the rule's version and date on each row; no light, no changed count.
- [x] Migration 0040 run by the operator (2026-10-17; `bsc_endpoint_host_groups` holds two rows).
- [x] Sign-off on the quoted wording above (2026-10-17: the operator's legal assistant read it and signed off, as the operator reported in chat).
