# BNB gates G1 and G2, measured (PR-B1)

Measure only. Nothing here promotes an agent, writes to the reviewed census, changes the listing rules or touches the map. The tool reads the chain and a few hundred web addresses, and writes files under a gitignored folder.

Run on 2026-10-16. Chain scan to finalized block 128,020,960 (18:01Z). Registration files read at 18:02Z to 18:18Z. Agent addresses asked once, 18:06Z to 18:09Z.

## Result

| Step | Rule | Measured |
|---|---|---|
| G0 | Listed under the directory rules (docs/bsc-erc8004-2026-10-13.md, section 5), replayed from the chain | **6,842** |
| G1, wallets | Registering wallet with 50 or more registrations (`FLEET_MIN`) | **0** listed entries |
| G1, templates | Two or more listed entries with the same normalized name, description and endpoint host | **150 groups holding 930 entries** |
| G1 | Independent (G0 minus the template groups) | **5,912** |
| G2, read | Independents whose registration file was read | 5,768 |
| G2, complete (D) | Name, description and at least one https agent address | 665 |
| G2, not junk | Complete and no junk flag | 645 |
| G2, live (A) | Not junk, and an address answered once | **264** |
| G2, live, strict | The same, with a 2xx or 3xx answer from at least one address | 213 |

The brief said 6,619 listed. That was an earlier count. Nooscape's own public count was 6,841 when the scan began and 6,842 when it ended, and the replay gives 6,842.

Against the plan's estimates (AUTO_REVIEW_PLAN.md, G1 and G2): independents were estimated at about 4,500 (range 1,600 to 9,700) and measured 5,912. G2 was estimated at 1,500 to 3,000 and measured 264.

### What decides the G2 number

Most independents cannot pass A because they declare nothing to ask. Of the 5,768 read, 5,099 (88%) have no https agent address: 4,971 declare no service with an endpoint at all, 93 only social links, 33 only non-https names (an ENS name, a wallet, plain http), 2 both kinds. A further 320 of the 5,099 give an https address under a field the standard does not use (`url`, `website`), which this run counted and did not ask. If a name and a description were enough, 5,744 independents would pass D.

Two platforms hold half of the complete, non-junk entries (327 of 645):

- **singularry.org**: 257 listed entries on one host (`/agents/<n>/agent-card.json`), 226 of them independent after G1. Its robots.txt answers with a redirect to a login page, which the safe fetch treats as unreadable, so none was asked.
- **api.example-agent.ai**: 102 listed entries (87 wallets) at a name that does not resolve.

Neither shows up in G1 as specified. The listing rule for a shared host (50 or more) reads the host of the registration URI, and these entries are inline JSON, which has no host. The host appears only in the declared endpoint. Section "G1 detail" shows what an endpoint-host rule would remove.

## G0 detail

Replay of the listing rules over every registration, against Nooscape's public registry profile:

| | Replay (head 128,020,960) | Public, 17:47Z | Public, 18:01Z |
|---|---|---|---|
| Recorded | 375,343 | 375,333 | 375,347 |
| Listed | 6,842 | 6,841 | 6,842 |
| Grouped | 346,525 | 346,516 | 346,529 |
| Without profile link | 16,575 | 16,575 | 16,575 |
| Numeric name | 5,401 | 5,401 | 5,401 |

The replay matches exactly on listed, without link and numeric name. The 4 extra rows of the public profile at 18:01Z (recorded and grouped) landed after the scan's head. Grouped splits into 144,632 by shared link, 185,218 by platform host and 16,675 by mass registrant.

The 6,842 by URI kind: 6,466 inline JSON, 234 ipfs, 142 web. By wallet: 6,110 wallets have one listed entry, 205 have two, 49 three, 16 four, 19 five to nine.

## G1 detail

**Wallet fleets.** Across the whole registry, 34 wallets hold 50 or more registrations (23,543 in all; the largest hold 13,419, 3,248, 1,165, 909, 812 and 798). None of their entries is listed, because the listing rule already holds out any wallet with 10 or more. So the wallet half of G1 removes nothing from G0.

**Template groups.** The key is the normalized name, normalized description and the host of the first agent address. Group sizes at several bars:

| Bar (entries per group) | Groups | Entries | Independents left |
|---|---|---|---|
| 2 (used above) | 150 | 930 | 5,912 |
| 3 | 38 | 706 | 6,136 |
| 5 | 15 | 627 | 6,215 |
| 10 | 4 | 550 | 6,292 |
| 50 | 3 | 536 | 6,306 |

The three largest groups hold 536 entries, each with a different wallet: 300 ("CryptoMaster Agent #N", 300 wallets), 173 ("dijin0001", 173 wallets) and 63 ("hodlclawAgent", 62 wallets). Their registrations are equal once digits, case and punctuation are ignored, and each has a link of its own, so the listing rules did not group them. The next largest groups have 14, 9, 8, 8, 8, 8 and 7 entries. Name and description alone (any host) give 156 groups and 956 entries.

**An endpoint-host rule (not in G1 as specified).** Listed entries that declare an agent address on a host shared with other listed entries:

| Shared with at least | Independents on such a host | G2 passers on such a host | G2 passers left |
|---|---|---|---|
| 2 entries | 509 | 144 | 120 |
| 5 | 416 | 67 | 197 |
| 10 | 351 | 9 | 255 |
| 25 | 328 | 0 | 264 |
| 50 | 328 | 0 | 264 |

Largest endpoint hosts among listed entries: singularry.org 257, api.example-agent.ai 102, claw.cybermolt.world 14, www.8004scan.io 11, api.orbit-agents.com 8. The 8004scan.io address is an explorer page for the agent, not the agent's own service, and 9 of its entries pass A because the explorer answers.

## G2 detail

### Why independents fail

First reason in the order a reader would meet it (each independent counted once):

| First reason | Entries |
|---|---|
| No https agent address | 5,079 |
| Address not asked: robots.txt unreadable | 236 (225 on singularry.org) |
| Address does not resolve | 121 (102 on api.example-agent.ai) |
| Registration file: HTTP 400 from the gateway (ipfs link that is not a valid CID) | 47 |
| Registration file: no answer in time (29 of them through the gateway) | 30 |
| Registration file: HTTP 404 (web links) | 28 |
| No name or no description | 24 |
| Address: no answer in time | 17 |
| Junk | 20 |
| Registration file: no CID in the link | 9 |
| Registration file: not JSON | 8 |
| Address: TLS failed 4, connection failed 1, robots.txt disallows 1, port not allowed 1 | 7 |
| Registration file: other (connection failed 5, robots.txt 5, unresolvable 4, HTTP 504 3, TLS 2, 403, 410, 429) | 22 |

Reasons are not exclusive: an entry can have several. The CSV has one column per fact, so a different order is a spreadsheet filter.

### The address check (A)

One pass, every complete independent with an address (658 entries, 629 distinct addresses, at most two per entry; the file also holds 3 addresses from the first registration read that the second no longer named). Outcome per entry: answered 273, did not answer 145, not asked because of a rule 240. Answers were 2xx for 209, 4xx for 59 and 5xx for 5 (first answer). Median answer time 445 ms.

Of the 645 complete, non-junk entries: 264 answered, 238 were skipped by a rule, 143 did not answer (resolve 121, timeout 17, TLS 4, connection 1).

A complete HTTP answer counts, as in the liveness check. Hosting platforms answer 404 for an app that is gone (vercel.app, railway.app, onrender.com, workers.dev), so a 404 is a weak sign of life. Of the 339 distinct addresses that answered, 52 are on vercel.app, 30 on workers.dev, 20 on onrender.com and 15 on railway.app. The strict row counts a 2xx or 3xx.

I resolved 12 randomly chosen "does not resolve" hosts through 1.1.1.1 as a second opinion. All 12 had no record.

### The agent card (C, on addresses the registration names)

Of the 264 that passed, 134 declare an A2A service and were asked for its card: 100 returned a valid card (name, description and an address), 14 answered 404, 10 had no address in the card, 5 had no name, 2 answered 401, 2 answered 405 and 1 was not JSON. 130 declare none. C is reported separately and is not required for the G2 count above.

### Completeness (D) and junk

Of the 6,698 listed entries whose registration was read, 733 are complete and 701 of those are not junk. Among independents, 665 are complete and 20 of those carry a junk flag. Flag counts among all read independents (an entry can carry several): description under 10 characters 131, description only repeats the name 70, stock placeholder name 22, only example or private addresses 11, name under 2 characters 7, stock placeholder description 6. Among the 665 complete: placeholder address 11, short description 6, description repeats name 4, placeholder name 2, short name 2.

64 of the 264 that passed also have an image, the standard's `type` and a `registrations` entry pointing back at this registry and agent id.

## Method

**Which entries (G0).** The registry rows store a hash of each URI, not the URI, so the tool reads the chain: `eth_getLogs` on the identity registry for the Registered and URIUpdated events from block 79,027,268 to the finalized head (980 windows of 50,000 blocks), 375,343 registrations and 9,654 link updates. It then applies the production listing rules in memory: first Registered event of an agent wins, link updates replace the link in chain order, no usable link, then a name that is only digits, then a link recorded twice, a host recorded 50 times, a wallet that registered 10. The thresholds are copied from `BSC_LISTING_RULES`, and a test pins the copy. The exact match in the table above is the check that the replay is the listing.

**Chain budget.** 982 requests (980 `eth_getLogs`, one `eth_chainId`, one finalized-block read), 49,020 compute units (NodeReal's published costs: 50, 5 and 15) in 838 seconds, 58.5 CU/s on average. Every call went through `callBscRpc` in `bscRpc.ts` behind a token bucket set to 75 CU/s, half of the 150 allowed. The bucket spaces calls, so the limit holds over any stretch and not only on average. The endpoint key was read from the environment and never written to a file or a log.

**Registration files.** 6,466 listed entries are inline JSON and were decoded locally. The other 376 were read through the safe fetch behind the polite fetcher (5 at a time for web links and 2 for the gateway, a second between two requests to one host, robots.txt first, 5 second deadline, 256 KiB cap): 142 web links and 225 ipfs links, and 9 ipfs links with no CID that were asked of no one. The public gateways ipfs.io, w3s.link, dweb.link and nftstorage.link answer 429 to this user agent and gateway.pinata.cloud took 7 seconds, so ipfs links went through `https://ipfs.filebase.io/ipfs/`. This run read the files twice. 33 of the 367 fetched files changed outcome between the two passes (timeouts in both directions, 10 ok to timeout, 7 timeout to ok), so the ipfs read has about that much noise. The numbers above are the second pass.

**What D reads.** A registration is complete when it is a JSON object with a non-empty `name`, a non-empty `description` and at least one https `endpoint` in `services` (or the older `endpoints`) that is neither a social profile (by service name or host) nor a non-https name. The CSV also holds image, `type`, the back reference and the counts of social, other and non-standard addresses, so stricter or looser definitions can be recut.

**What A asks.** A plain GET of the first two agent addresses of each independent complete entry, through the same polite fetcher, with the production body default raised to 64 KiB so an A2A card can be read from the same response. Placeholder hosts (example.*, localhost, private ranges) and the suppressed domain are not asked. Outcomes follow `factsOf` in `agentChecks.ts` (a test pins the two): answered is any complete HTTP answer, did not answer is no answer in full, skipped is a rule.

**Junk.** A heuristic on the text and the addresses: stock placeholder names and descriptions, a name under 2 characters, a description under 10, a description that only repeats the name, and an agent whose every address is an example or private host. The lists are in `server/bscB1.ts`.

**Template key.** NFKC, lower case, each run of digits turned into `0`, anything else that is not a letter turned into a space, applied to name and description, plus the lower-case host of the first agent address, then hashed. The URI hash is not in the key: a link recorded twice is already held out by the listing rules, so every listed entry has its own.

## What this does not prove

- **Not 2 of 3 daily probes.** One pass, 18:06Z to 18:09Z on one day. The plan's rule needs three passes on different days. A single pass loses agents that were down for an hour and keeps ones that happen to be up. The 17 timeouts and 4 TLS failures are the likeliest to flip.
- **Not liveness of the agent.** A 404 from a hosting platform, an explorer page and a marketing site all answer. 59 of the 264 passers answered 4xx and 5 answered 5xx. Only a probe that speaks the agent's protocol shows an agent works, and Nooscape sends only GET.
- **Not a count of independent people.** G1 groups by wallet and by a text template. One person with many wallets and a different text per agent is not found. Listed wallets with two to nine entries (289 wallets) are kept as independent, as the 50-entry bar says.
- **The endpoint-host gap.** 328 independents sit on two hosts (singularry.org and example-agent.ai) that G1 does not group. They are counted as independent above.
- **The 144 unread entries** (registration files that failed) cannot be grouped, so G1 counts them as independent. They are 2.4% of the independents.
- **Not C as the plan states it.** The plan's check C asks the asserted domain for `/.well-known/agent-card.json`. This run did not ask any address a registration does not name (see below). C here is the A2A card at an address the registration names.
- **320 independents** give an https address under `url` or `website` and were not asked. If the standard's field name is not required, up to 320 more entries could take part in A.
- **1.1.1.1 spot check** covers 12 of 121 unresolved hosts. The rest were not checked a second way.
- **Junk flags are judgement.** Counts are given per flag so one can be dropped. A real agent with a short description is flagged.
- **Self-asserted text.** Names, descriptions and endpoints come from the registrant and are unverified.
- **The suppressed domain and `hidden`.** The directory's hidden flag is not modelled. No listed entry used the suppressed domain.

## Things to decide

1. **The /checker page does not describe this.** It tells hosts what the checker asks: the addresses an agent declares. This run also sent GETs to registration files named by BNB registrations (142 web, 225 ipfs through a public gateway) and to the agent addresses in them (579 requests for 632 addresses, robots.txt reads included), under the user agent `Nooscape-Checker/1.0 (+https://nooscape.si/checker)`, which the safe fetch fixes. A production version of any of this (PR-B2 onward) needs the page to say it first.
2. **Check C as written would probe `/.well-known/` on hosts a registration does not name.** I left it out. The page would need new wording before Nooscape-Checker does that.
3. **G1 needs an endpoint-host rule** to catch singularry.org and similar platforms, the way the listing's host rule catches registration-link hosts. The table above gives the effect at each bar. *Update 2026-10-17: the operator adopted the rule for later passes, at the bar of 50, and the production clustering stores the two hosts as groups. It draws no light and changes no entry's result. The numbers in this document are as measured and did not change ([bsc-clusters-2026-10-16.md](./bsc-clusters-2026-10-16.md), "Endpoint-host groups").*
4. **What G2 requires.** If an address is needed, the ceiling is the 665 entries that declare one and the measured pass is 264. If a name and a description are enough, it is 5,744 before junk.
5. **The ipfs read** should go through Nooscape's own gateway (docs/ipfs-gateway-2026-10-16.md) for any production use. The public gateway used here is rate limited and slow.

## Files and how to repeat

`server/bscB1.ts` (pure rules, 35 tests in `server/bscB1.test.ts`) and `server/bscB1Measure.ts` (the reading). Output goes to `bsc-b1-output/`, which is gitignored: `chain.jsonl` (the decoded registrations and link updates), `scan.json`, `registrations.jsonl`, `registrations.first-pass.jsonl`, `probes.jsonl`, `entries.csv` (one row per listed entry, 6,842 rows, the columns are `ENTRY_COLUMNS` in `bscB1.ts`), `summary.json`.

```
BSC_RPC_URL=<NodeReal endpoint> pnpm exec tsx server/bscB1Measure.ts scan
pnpm exec tsx server/bscB1Measure.ts replay
NOOSCAPE_IPFS_GATEWAY=https://ipfs.filebase.io/ipfs/ pnpm exec tsx server/bscB1Measure.ts fetch
pnpm exec tsx server/bscB1Measure.ts probe
pnpm exec tsx server/bscB1Measure.ts report
```

`scan` resumes from `scan.json` and, run again later, carries on from the last block. Every phase skips what it has already done.

## Addendum, 2026-10-17: figures recomputed for the public census report

Nothing above was changed. The public report ([/field/bnb-registry-2026-10-16](../client/src/pages/BnbRegistryReport.tsx)) does not use the junk filter, because the decision record for the BNB pass (D1) allows no quality judgments, and the report is not to carry one. Every figure above that depends on the filter was recomputed over the 665 complete entries instead of the 645 without a flag. The recomputation reads the saved output of this run (`entries.csv` and `registrations.jsonl`). No request was sent, so it is not a new measurement. The check that the recomputation is sound is that it reproduces the published figures when the filter is put back: 645, 264, 213, 134 and 100, 327.

| Figure | Published above (645 complete entries without a junk flag) | Recomputed (665 complete entries) |
|---|---|---|
| Answered a request (G2, live) | 264 | 269 |
| Answered with a 2xx or 3xx status | 213 | 218 |
| Did not answer | 143 | 145 |
| Not asked: a rule stopped the request, or the address is a placeholder | 238 | 251 (240 by a rule, 11 with a placeholder address) |
| Declared an A2A service and were asked for the card, among those that answered | 134 of 264 | 136 of 269 |
| Valid A2A cards among them | 100 | 101 |
| Complete entries on the two host names (the two hosts named in the G2 section) | 327 of 645 | 328 of 665 |

The 327 and the 328 are the same entries. All 328 independents on the two host names are complete, and one of them carries a junk flag. The 645 leaves it out, so the published figure is 327. Neither host name answered a request: 0 of the 328.

Figures that do not move, because the filter is not part of them: 6,842 listed, 5,912 independent, 5,768 read, 144 unread, 665 complete, 5,099 of 5,768 (88%) with no https agent address, 320 of the 5,099 that give an address under `url` or `website`, 150 template groups holding 930 entries, 328 independents on two host names, and 33 of 367 fetched files that changed outcome between the two passes. The report does not use the 645 at all.
