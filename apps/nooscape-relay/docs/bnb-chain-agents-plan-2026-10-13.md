# BNB Chain agent map: plan and review (2026-10-13)

Status: **PLANNED, not started.** Phase 0 (the measurement) is done and independently verified; see the
verification section. The operator decided D1 and D2 on 2026-10-13 (facts only, no worker fetching); D3 (store all rows) and D5 (BNB next)
were decided the same day; D4 (the RPC variable name and budget) is open. No source is staged or approved, and nothing in this repo reads BNB Chain yet.
This records the operator's research plan (`BNB_AGENTS_PLAN.md`, 2026-10-13, which includes a Phase 0
measurement run on an archive RPC) and a review of it against the code and Nooscape's invariants. The plan file
itself lives outside the repo (Downloads); the numbers below are carried here with their provenance so they
survive.

Provenance classes used below: **R** = measured by the research session (archive RPC, raw logs not in this repo);
**C** = re-checked by me on 2026-10-13 against public BSC RPC (read-only `eth_call`, `eth_getCode`,
`eth_getStorageAt`, `eth_getLogs` on a recent window); **C2** = re-derived by me from the research session's raw
logs and a fresh archive pull (see the verification section); **V** = vendor or third-party claim; **?** = unknown.

## What the research found

| Fact | Class |
|---|---|
| The ERC-8004 identity registry on BSC (chain 56) is `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, the same address as our Robinhood constant; the reputation registry is `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, the validation registry `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` | C (code present at all three) |
| 373,567 identities registered, 0 burned, deployed at block 79,027,268 (2026-02-03) | R; head state C (id 373,568 exists, 373,700 and above do not) |
| 29,938 NewFeedback events, 0 revoked, 8 responses; validation registry empty | R (matches the Quicknode explorer) |
| Registrations per month: Feb 7.6k, Mar 48.0k, Apr 24.9k, May 45.2k, Jun 43.4k, Jul 82.2k, Aug 83.5k, Sep 29.9k, Oct to the 13th 8.9k | R |
| 299,120 distinct owners; 269,235 own exactly one; 31 owners hold more than 50 ids; the top owner holds 13,419 | R |
| One byte-identical `data:` URI ("Ave.ai Trading Agent") is 126,300 ids (33.8%); "Debot Trading Agent" is 9,684; 12,753 ids have an empty URI | R; template share C (my 120-id random sample, seed 42: 38% share one byte-identical `data:` URI, 3.3% empty, 46% https, 50% `data:`) |
| In a 500-id sample, 93% of URIs resolve, 241 list an endpoint, 235 point at three platforms, and only 6 (1.2%) are independent profiles with their own endpoint | R (the 6/500 gives a 95% range of roughly 1.6k to 9.7k ids, too wide to size anything) |
| Feedback comes from only 130 distinct clients covering 4,467 agents; 99% of it is Feb to Apr; 54% of events carry the value 70; one owner received 36% of all feedback; 328 agents have 3 or more distinct clients (181 excluding owners with more than 50 agents) | R |
| Block time is 0.450 s | C |
| All three registries are EIP-1967 proxies (implementation slots populated) | C (the plan does not mention it) |
| BAP-578 "Non-Fungible Agents": 128,591 per a BNB Chain blog; the main proxy's `totalSupply` is 55,867 | V against R, unresolved |

Every figure marked R above was re-derived on 2026-10-13 (class C2) from the raw logs and a fresh archive pull,
and reproduced, except the monthly registration counts, which were off by up to 11k because of the plan's bucketing.
The details and corrections follow. (A public node answers 403 for old ranges, so only an archive endpoint can do
this.)

## Phase 0 verification (2026-10-13)

Method. I extracted the research archive (`bnb_phase0_raw.tgz`: 749,065 identity-registry logs in 24 shards and
29,953 reputation-registry logs) and recomputed every figure with my own script; the research session's
`analyze.py` was read, not run. Then I pulled fresh from a NodeReal archive endpoint with the operator's key
(read-only `eth_getLogs` and `eth_getBlockByNumber`): the whole reputation registry, 30 random 100,000-block
windows of identity `Registered` logs (6.2% of the range), and, because the raw logs lacked them, every `URIUpdated`
event and every proxy lifecycle event on all three registries. That took about 10,500 `eth_getLogs` calls, because
the provider rejects wide ranges and the calls multiply. The analysis scripts and outputs are kept locally; the raw
archive is held by the operator.

Completeness (the plan's own worry about silently dropped chunks):

- Agent ids run from 0 to 373,566 with no gaps, and there are 373,567 `Registered` events and 373,567 mint
  transfers. The mint recipient equals the registered owner for every id. A dropped chunk would show as a gap.
  There are no duplicate logs, no removed logs, and no undecodable URIs.
- Reputation: all 29,953 logs from my fresh pull are identical to the research session's (block, address, topics,
  and data).
- The 30 sampled identity windows hold 23,028 `Registered` events in both sources, identical in block, log index,
  id, owner, and URI hash in every window. Scaling the sample gives about 371.7k against 373,567 (0.5% low).

Reproduced exactly: 373,567 identities with 0 burned; 299,120 distinct current owners, 269,235 of them holding one
id; 31 owners above 50 ids (23,273 ids) and 6 above 500 (20,351 ids); the top owner at 13,419. URI kinds: https
187,862, inline 166,709, empty 12,753, ipfs 1,052, other 5,191; 215,591 distinct non-empty URIs, with 147,570 ids
sharing one. The Ave.ai template is 126,300 ids (33.8%) and Debot 9,684. Feedback: 29,938 `NewFeedback` (0 revoked,
8 responses) from 130 clients over 4,467 agents, 0 self-feedback, 302 events from clients that own agents, value 70
on 16,026 events (53.5%, 0 decimals), the top owner receiving 10,636 (35.5%), and 328 agents (181 after dropping
owners above 50 ids) with 3 or more distinct clean clients.

Corrections to the plan:

- **Monthly registrations.** With block timestamps from the archive, the exact counts are Feb 7,581, Mar 47,548,
  Apr 23,917, May 44,758, Jun 31,970, Jul 90,797, Aug 77,879, Sep 36,739, and Oct 1 to 13 12,378. The plan's June
  (43.4k), July (82.2k), September (29.9k), and October (8.9k) figures came from 1M-block buckets labelled by start
  date and were off by up to 11k. Over the last 14 full days the rate was 485 to 2,444 a day, mostly 500 to 900.
- **Feedback timing.** "99% in Feb to Apr" is 98.3% (29,438 of 29,938). Two days carry 28%: 2026-03-07 (4,512
  events) and 2026-04-25 (3,903). Twenty-five clients produce 90% of the events.
- **`analyze.py`.** It reads the first data word of `NewFeedback` as the value. In the verified layout that word is
  `feedbackIndex` and the value is the second word. The value figures still reproduce with the correct word, but
  the script should not be reused as written.

Additions the plan did not have:

- **Platforms can be named from chain data alone, with no fetching.** By inline-JSON name or https host, seven
  groups hold 322,124 ids (86.2%): evoevo.ai across three hosts 137,740 (36.9%), Ave.ai 126,300 (33.8%), a termix S3
  bucket 40,698 (10.9%), Debot 9,684, q402.quackai.ai 6,711, MevX 590, and APM 401. Of the https ids, five hosts
  hold 98.6%. The other 51,443 ids (13.8%) are 29,734 other inline, 12,753 empty, 5,191 other schemes, and 2,713
  other https.
- **`URIUpdated` events.** There are 9,628 across 4,290 ids (1.15%), which the plan ignored and the raw logs lacked.
  No template or platform id ever left its group, so the 86.2% is the same under current URIs. Of the 4,290, 2,383
  are platform or template ids editing within their own group (0.7% of those ids) and 1,907 are in the other 13.8%
  (3.7% of it); 1,397 formerly empty ids now point at https or ipfs. The updates are not mainly independent owners, so
  an edit is not a clean signal of an independent profile. The adapter must still ingest `URIUpdated`, as the
  Robinhood one does, so each id's current URI is right.
- **Not a marketplace.** There are 1,931 secondary transfers (0.5%) and 1,848 ids whose current owner differs from
  the registrant.
- **Proxy history.** All three registries emitted the same sequence: initialization, an ownership transfer, and an
  upgrade at deployment; a second upgrade 4,402 blocks (about 33 minutes) later; and ownership transfers within about
  two days. Nothing since. All 29,938 `NewFeedback` events decode strictly under the current layout, so there is no
  layout drift. The contracts remain upgradeable, so the implementation-slot tripwire is still needed.

## Provider limits and build sequence (measured 2026-10-13)

NodeReal limits, measured with the operator's key (these set the adapter's shape):

- `eth_getLogs` is capped at **50,000 blocks per call** (error `-32602`, "exceed maximum block range: 50000"). From the
  deploy block (79,027,268) to a head near 127.48M that is at least 970 calls (48,451,249 blocks at 50,000 per call). A dense 50,000-block window (blocks
  84.0M to 84.05M, three event topics) returned 1,882 logs and 1.9 MB in 3.4 s.
- `eth_getBlockByNumber("finalized")` works and sat 3 blocks behind `latest`. The pass can therefore scan only
  finalized blocks, which cannot reorg, and needs none of the anchor-hash reorg machinery the Robinhood forward
  walk carries.
- Blocks average 0.450 s, so the hand-out "mint hour" is 8,000 blocks (Robinhood's is 36,000).

What this means for the design: a forward walk from the deploy block to the finalized head under one cursor
(`bsc:<next block>`), windows of at most 50,000 blocks fetched a few at a time within a per-run budget, written
window by window (registrations insert-only, ledger rows INSERT-IGNORE), so a retry is idempotent and a re-scan can
never regress a URI that a later window updated. The backfill was measured at about 36 runs of the pass (see the
design record), and the same walk then tails the head.

Build sequence, one pull request each, nothing public until the last:

1. **Ground work (migration `0033`).** Adds the `erc8004_bsc` protocol value (enum-only). The EVM activity ledger,
   its entry rollups, and the public readers (totals, as-of block, feed, block-day series) were written for Robinhood
   alone and were not scoped by source, so a second chain's rows would have blended into Robinhood's numbers and
   dated BSC events by Robinhood's block cadence. They are now scoped to the Robinhood protocol, the hand-out hour
   is per chain (`server/ingestion/evmIdentityChains.ts`), and the rollup can run incrementally for only the entries a
   window named (a full-source recompute per window is quadratic at 373k entries).
2. **The pass.** The BSC adapter and orchestrator, the keyed RPC client (the URL carries the key and lives only in
   the environment), the staged source, and the operator console, with fixtures taken from the verified raw logs.
   Manual-only.
3. **Public surfaces.** Folding by URI hash and platform host as recorded facts, the headline (registrations beside
   distinct profile URIs), search that collapses identical registrations, labels, and the indexes the folds need.
   This ships before the source is seeded, because the seed makes the rows public.
4. The operator stages and seeds the source; a reviewed migration flips it to scheduled once the backfill and a
   few tail runs are clean.

## What holds up

- The identity registry address and event shapes match what the Robinhood adapter already decodes, so the decode
  work carries over.
- The central finding is real and independently reproduced: the BSC registry is mostly a few templates and
  platform issuers, not 373k independent agents. Dedupe by URI hash first is the right instinct.
- "Measure before building" and "do not ingest 373k rows into the map by default" are right.
- Feedback is small and strongly patterned, so reputation matters more than volume. Showing it as recorded fits
  invariant 14.

## Conflicts with Nooscape's rules (resolve before Phase 1)

1. **Scoring and tiers.** The plan scores each agent into tiers A, B, C, adds a "client-quality score", discounts
   "clients funded by the owner", and checks tokens for honeypots. Invariant 14 says chain records are shown as
   recorded and never scored, weighted, or judged, the evidence scale is "levels, not scores", and the mission says
   Nooscape is not a reputation oracle. The letters also collide with the served `tier_2` to `tier_4` names. The
   same information can be shown as recorded facts: byte-identical-URI group size, the owner's id count, distinct
   non-owner feedback clients, the feedback value distribution (that 54% of events carry the value 70 is itself a
   recorded fact), and registration age. Default ordering and collapsing by those facts is acceptable (it is how
   look-alike folds work) if the rules are published and the full set stays counted and searchable. The token-risk
   overlay and funding-graph discounts are judgments about third parties and are out of mission unless the operator
   decides otherwise.
2. **Fetching.** The plan resolves each `agentURI` with an SSRF-guarded fetch to classify agents. Today the Robinhood
   pass never dereferences a URI: it stores the URI, hashes it, decodes inline JSON, and takes the host of an
   `https://` URI as a locator. The only fetcher (`server/ingestion/registrationFetch.ts`, for 8004 Solana names)
   is guarded and sized for about 1.2k links, with a documented DNS-rebinding window, and the guardrail is that
   every fetch needs an approved hostname boundary. Hundreds of thousands of arbitrary hosts breaks that. Most of
   the plan's noise findings need no fetch (URI hash, inline decode which is 50% of my sample, owner and mint
   counts, empties). Resolution classification should stay an operator-run offline measurement, not a worker
   dependency, unless a separate approval defines a host allowlist and a budget.
3. **Counts and headline.** The homepage "on-chain identities" figure is the sum of the registry protocols
   (25,156 today). Adding 373,567 BSC registrations would make it about 399k, and a third of that is one template.
   Decide what the number means (registrations, distinct profile URIs, distinct owners) and show more than one.
   The plan stores only about 5k rows but also says the rest is "counted"; that needs an aggregate counter table,
   or storing all rows (the directory would grow from 240k to about 614k).
4. **Directory scale.** Look-alike counts group by wallet, name, and host. `displayName`, `registrant`, and
   `locatorHost` are indexed (migration `0020` added the host index); `profileUriHash` was not, and a 126k-row name
   group is new. Run `EXPLAIN` on the real schema before deciding to store all rows. (Measured later the same day:
   storing all 373,567 rows in the directory table roughly doubles every aggregate and search, so the registrations
   live in their own table and only a rule-selected subset is published; see the design record.)

## Corrections to the plan's engineering claims

- **"Zero new code" and "reuse the Robinhood code with a chain column" understate it.** `robinhood.ts` hard-codes
  the RPC URL, chain id, registry, source key, and allowed host, and the `erc8004` protocol routes to the Robinhood
  runner by protocol alone (worker and operator router). A BSC source needs a new protocol value (a migration that
  appends to three enums, like `0030`), a source approval record, and either a parameterized adapter or a separate
  one. The live scheduled Robinhood walk should not be destabilized to share code; prefer a separate adapter first.
  Phase 1 is M to L, not M.
- **Chain constants need re-deriving.** BSC blocks are 0.450 s against about 0.1 s on Robinhood, so the finality
  margins (256 and 600 blocks), the 36,000-block "mint-hour" hand-out window (about 8,000 blocks on BSC), and the
  2,000,000-block scan window all change. BSC also has its own reorg and finality behavior.
- **The backfill is large.** From block 79.0M to 127.5M is about 48.4M blocks. Our walks advance one window per
  run. Whether that is about 25 runs or hundreds depends on the provider's `eth_getLogs` range cap, and the public
  node allows about 5k blocks (about 9,700 runs). Plan an auto-advancing backfill within a per-run budget, or an
  offline backfill that writes only aggregates and the kept rows. The Robinhood walk needed three backward passes
  (`bf:`, `rb:`, `ac:`), which grew in stages. The `Registered` event already carries the owner and the URI (the
  adapter reads `owner` from it), so a design with one backward pass over the registration, transfer, and
  URI-update events plus a forward cursor is worth costing first.
- **Worker capacity is already tight.** The control allows two sources per tick, and a source's real cadence is
  looser than `scheduleMinutes` (see the 2026-10-13 handoff). Another scheduled chain source worsens that.
- **RPC provider.** Phase 0 used a paid NodeReal archive key. The operator added a NodeReal key to the Hostinger
  environment fields on 2026-10-13; nothing reads it yet. Production needs its own key,
  held in the environment (like `SOLANA_RPC_URL`), never in the database, plus a cost decision.
- **Proxy risk.** All three registries are upgradeable proxies. The reputation adapter already has an
  implementation-slot tripwire and fails closed on unknown events; BSC needs the same and a re-verification of the
  event layouts on this chain's implementation.
- **Loose numbers.** The plan compares against Nooscape's "registry-backed total of about 11.8k"; today
  `withRegistrant` is 25,156 (SAID joined), so BSC is about 15x that, and about 42x Robinhood's 8,785. The BAP-578
  count is unresolved (128,591 against 55,867), so treat that standard as unverified.

## Revised phases

| Phase | Work | Size | Needs |
|---|---|---|---|
| 0 | **Done 2026-10-13:** the Phase 0 numbers were re-derived from the raw logs and a fresh archive pull and reproduced (see the verification section). Remaining: decide D1 to D5 | S | operator: decisions |
| 1 | Provision a production archive RPC (`BSC_RPC_URL` in the environment), write the source approval record from `external-source-approval-template.md`, add the `erc8004_bsc` protocol (migration) | S to M | operator: provider and budget |
| 2 | Chain-facts-only BSC identity pass: one backward pass plus a reorg-checked forward cursor, URI hash and inline decode, per-source directory rows, proxy tripwire; storage per D3 | M to L | phase 1 |
| 3 | Fold by URI hash and platform host as recorded facts (a new look-alike key, with indexes), publish the rules, settle the headline semantics. Chain data alone names 86% of ids, so no fetching is needed | M | phase 2 |
| 4 | BSC reputation, manual-only first: distinct clients and value distribution as recorded facts, never a quality score | M | phase 2 |
| 5 | Cross-chain twins by identical `agentURI` and owner across Robinhood, Base, and BSC (reuse the `0028` twin-link design) | M | phase 3 |
| Later | ERC-8183 escrow, Virtuals ACP, x402 on BSC, BAP-578 NFAs (verify the contracts first), each its own source approval | L | see todo 71 |

## Decisions for the operator

- **D1. Facts, not tiers. DECIDED 2026-10-13: facts only.** The BSC build shows recorded facts and folds. There
  are no A, B, C letters, no client-quality score, no funding-graph discount, and no token-risk overlay. The default
  view may still order and collapse by published rules over recorded facts, and the full set stays counted and
  searchable.
- **D2. Fetching. DECIDED 2026-10-13: no URI fetching in the worker.** The pass decodes chain data and inline `data:`
  URIs only, and names a platform from the inline name or the https host. Whether a URI resolves or lists an endpoint
  can be measured offline by the operator, but is never a worker dependency. Changing that would need its own
  approval with a host allowlist and a budget.
- **D3. Counting and storage. DECIDED 2026-10-13: store all rows.** Every registration is kept and searchable. The
  headline shows registrations beside distinct profile URIs rather than one blended figure; that default is confirmed
  when the public surfaces are built (step 3 of the build sequence).
  *Refined later the same day:* the operator asked for the default view to be about 5,000 real registrations, not
  370k. Every registration is still stored (in its own table, `agent_directory_registry_rows`), but the directory
  lists only those that pass published rules, and the Home page shows the registrations on-chain beside the listed
  and held-out counts. Nothing is fetched, so the rules count shared records and cannot say which are real. See
  [bsc-erc8004-2026-10-13.md](./bsc-erc8004-2026-10-13.md), sections 4 to 6.
- **D4. RPC.** The provider is NodeReal and a key is in the Hostinger environment. Still open: the variable name the
  adapter will read, whether it is a separate production key, and the budget (the verification pull used about 10,500
  `eth_getLogs` calls).
- **D5. Priority. DECIDED 2026-10-13: BNB next**, ahead of the SAID response split, the reputation scheduled flip,
  real SAID names, and the analytics measurement window.
