# Decision record: reading the registration files behind the 376 BNB web and ipfs links, and the limits

**Decided:** 2026-10-17, by the operator, in chat. The 2026-10-17 census record ([2026-10-17-bnb-census-report-and-b5-closed.md](./2026-10-17-bnb-census-report-and-b5-closed.md)) says: "Any later pass has to stay inside whatever limit the record says unless I amend it in writing", and the handoff listed "reading the 376 BNB web and ipfs entries in production" as needing his written approval of the limits. He answered, about this and the Robinhood entry names: "go with this ... Reading the 376 BNB web and ipfs entries in production. This needs your written approval of the limits". The limits are the ones below, and this record is the written amendment.
**Changes:** the BNB pass, which recorded chain data only, now reads the registration file behind the https or ipfs link of a listed entry; the 2026-10-15 limits are amended for that read as the table says; the words on `/checker`, the home page's BNB card, every BNB entry's note and one sentence of the census report change with it.
**Does not change:** D1 (no scoring, no tiers, no quality judgments for the BNB pass), B5 (BNB entries stay acknowledged, never reviewed, and nothing is promoted), the hero number, the listing rules, any entry's tier or place on the map, and the census report's measured numbers and its footnote.

## What it does

A best-effort worker step (`server/bscRegistrationFiles.ts`, pure rules in `server/bscRegistrationFilesCore.ts`), after the Robinhood names, on a tick that claimed sources:

1. **Which entries.** The listed entries whose evidence says `link_not_read`: a web or ipfs link the clustering step recorded and did not read (376 of the 6,842 listed on 2026-10-16: 142 web, 234 ipfs), never-tried first, then oldest first. Entries the directory does not list are never read.
2. **The link.** The clustering step kept only the hash of each link, so the step reads `tokenURI` again for up to 16 entries in one Multicall3 `eth_call` through the clustering step's own compute-unit bucket (20 CU a call, half of the 150 CU/s the plan allows, shared with the other BNB steps), at the finalized block. A link that no longer hashes to the recorded one is left for the clustering step to read again.
3. **The file.** Through the same safe fetch and manners as the Solana 8004 name reader. An `http` address, another scheme, or an ipfs address with no CID is never read.
4. **What is kept.** Only the registration's template key (a short hash of its normalized name, description and the host of its first agent address), the host of that agent address, a status and the date, on the entry's evidence row. The file itself is not kept. Nothing is shown against the entry.
5. **What follows.** Gate G1 and the stored groups are worked out again at once, so an entry whose file gave it a template key joins its template group. That can raise the count of stored groups the map's key reports ("10 of N drawn") by the groups that only these files form, and never draws a light by itself: the map draws the ten largest groups of any kind.

**No agent address is ever asked.** The census asked the first two https agent addresses a complete file listed, and read agent cards. This step does not, and a test holds it.

## The limits (the written amendment)

| | 2026-10-15 record | This step |
|---|---|---|
| Size of a registration file read | 4 KiB for a probe | **256 KiB**, the cap the Solana name reader and the census already used (the census run was accepted as run) |
| Chain | no per-agent calls | One `eth_call` of at most 16 `tokenURI` reads a run through the shared bucket; chain reads pause for 30 minutes after a failure |
| Files | a budget per run | At most 16 a run, at most 6 from one host name (every ipfs link counts as one host, the gateway), at most 1 request a second to a host, one request at a time |
| Each request | https, address checks, no redirect to a private address, 5 seconds, at most 3 redirects, robots.txt first and obeyed, a host that opted out not read | Unchanged |
| User agent | the page it names says what is asked | `Nooscape-Checker/1.0`; `/checker` now describes this read |
| Tries | none for registrations | Five at most for a link that does not answer, two for a file that is not a registration, no sooner than 6 hours after the last try, counted in the evidence's status |
| Time | | Nothing is started after 20 seconds, the step runs at most every 30 minutes, and starts only on a worker tick under 100 seconds old (60 left it behind the Robinhood names step on the first tick: the names step ended 76 seconds in) |
| What is asked of a host | | Its robots.txt, and the registration file. Nothing else |

(The gate between two runs is 28 minutes, not 30: the worker's ticks are 30 minutes apart by its claim rule, but a step starts at a different time in each tick, and a gate of exactly 30 skipped every other tick once the rater fill ended on 2026-10-18, so the step ran about once an hour. The runs are still one a tick, on ticks at least 30 minutes apart, so no two start closer than 28 minutes.) At a run every 30 minutes that is at most 768 files a day, 288 from one host and 288 from the gateway. The 376 links take about a day at that pace, the ipfs ones setting it (234 at 6 a run), and longer if worker ticks come less often. After that only a newly listed entry's link, or one whose link changed, is read.

## A run from the operator's machine

The step itself was run once from the operator's machine against a scratch database holding 10 listed entries (8 web links on different hosts and 2 ipfs links, taken from the saved census output), capped at 10 files. It used the node endpoint from the operator's local file, which is never printed or kept: two `eth_call`s of 20 compute units each, one to read the links and one for the step. It then read the 10 files through the real reader, robots.txt first. 3 files were registrations and gave a template key (one also gave a host), 4 were not registrations or were not served, and 3 did not answer: the 2 ipfs links, because that machine has no Nooscape gateway, and one web link. That is the same mix B1 saw (144 of 5,768 files unreadable), and a link that does not answer is tried again, which is what the tries are for. It took 17 seconds for 10 files, inside the 20 second budget. It was a check of the code on real data and not a pass of the production system, and nothing was kept.

## Wording that had to change, and what each now says

- **`/checker`:** "does three things" (it now names the BNB file read), what it asks for and what it records for a BNB Chain registration, the pace, that the census asked more than the regular read does, and that the regular read asks no agent address. `server/checkerPage.test.ts` holds each sentence to the code.
- **The home page's BNB card:** "the directory pass reads the registration file behind the https or ipfs link of a listed entry, to group look-alike entries, and a one-off census on 2026-10-16 read some earlier".
- **Every BNB entry's note** (`BNB_FETCH_SENTENCE`): it says the pass reads chain data and, for a listed entry's https or ipfs link, the file behind it, keeps only a grouping key and a host, and that the census had read some links earlier. Notes stored with either older sentence are served as the new one; no stored row is rewritten.
- **The source status explanation** now says the 8004 registries allow reading an entry's registration link.
- **The census report:** one sentence, which said the worker's clustering step "reads only registrations that hold their file inside themselves". It would have been false. It now says that on the day of the census it read only those, and that the worker now reads the files too, so its count moves toward the report's. The report's numbers and its footnote are as they were.

## The endpoint-host rule counts these entries too

The rule `endpoint-host/1` (adopted 2026-10-17: a host that 50 or more listed entries declare as the host of their first agent address) was stored for inline registrations only, because those were the ones read. A registration read from its file declares a host just the same, so the rule now counts both kinds, with the version and date unchanged. The two stored groups may grow by the entries whose files name those hosts. **If the operator wants the rule inline-only, say so and it changes to a new version.**

## Not decided and not built

- **Nothing about a BNB entry is shown from a file.** No name, description or agent address is read into an entry. A "what we observed" block stays on hold.
- **Agent addresses stay unasked.** Asking them would need their own decision and their own words on `/checker`.
- **Entries the directory does not list** (the 368,000 or so held-out registrations) are not read.

## Outcome

- [x] The step, the chain read, the file reads, the regrouping and their tests, against a real database.
- [x] The words on `/checker`, the home card, the entry note, the source status page and the census report, and the tests that hold them.
- [x] Deployed (#127, 2026-10-17 20:39Z), and the first entries read. The first live reads were at 01:16Z on 2026-10-18: 16 waiting, 9 fetched, 2 failed, 2 not fetchable, stopped by the 20 second budget. By about 01:24Z, 53 of the 376 had been tried: 35 fetched, 11 failed once, 5 not a registration once, 2 not fetchable, and 323 not yet read. The step skipped every other tick until #131 (2026-10-18 02:57Z), so the 376 take about a day from there.
