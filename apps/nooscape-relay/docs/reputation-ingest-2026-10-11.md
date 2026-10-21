# Reputation Registry ingestion — design (2026-10-11)

Status: **IMPLEMENTED AND COMPLETE** — adapter, ledger applier, runner, preset and operator controls shipped
2026-10-11; migration 0018 awaits the operator's phpMyAdmin apply, then the backward walk.
§2 and §3.1 were corrected the same day after a second live probe settled the deployed
`NewFeedback` layout (the initial decode in this document had shifted the data head by one word).
Operator recon supplied by the operator (Blockscout + on-chain reads); every load-bearing fact
re-probed independently via the owned keyless RPC unless marked otherwise.

> **Addendum 2026-10-12 — the rollout below is finished through step 6.** The backward walk reached
> `rb:done` (2026-10-11 19:58:30Z), the §6.3 reconciliation PASSED (642 NewFeedback + 137
> FeedbackRevoked = the chain re-scan exactly; chain-order rank == feedbackIndex on all 505 pairs;
> 310 agents, 8 rater addresses), the anchored forward walk (`fw:`) carries the live tail, and the
> public per-rating surface shipped in `5fc6be8` (2026-10-12): `server/ratingsSurface.ts` (pure
> parser/formatter/revocation-join helpers), a `ratings` block on `liveData.directoryEntry` for
> erc8004 entries (one active `erc8004_reputation` source, chain-ordered rows, `measuredThroughBlock`
> high-water), and the agent-page "Registry ratings" section + active-ratings chip. A revoked rating
> stays visible and marked; values render by exact string math beside their own rater context; the
> ledger is never scored, weighted, or blended. Live reconcile: agent #462 (priors.trade) 3 ratings /
> 1 revoked / 2 active; unrated erc8004 agents render an honest zero; solana_8004 entries keep
> `ratings: null`. Step 7 (the 0017-style scheduled-policy flip) remains a deliberate operator
> decision after a full unattended-clean forward-walk day.

## 1. Registry facts (verified 2026-10-11)

| Fact | Value | Verified how |
| --- | --- | --- |
| Reputation Registry (proxy) | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | log address on live getLogs |
| ERC-1967 implementation slot | `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` | `eth_getStorageAt` of the standard slot — matches operator recon exactly |
| version() | `2.0.0` (operator recon) | bare `0x54fd4d50` selector returned empty on the public RPC; accepted from operator recon, not re-verified |
| NewFeedback topic0 | `0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc` | full hash read from live logs |
| FeedbackRevoked topic0 | `0x25156fd3288212246d8b008d5921fde376c71ed14ac2e072a506eb06fde6d09d` | full hash read from live logs |
| ResponseAppended topic0 | `0xb1c6be0b5b8aef6539e2fac0fd131a2faa7b49edf8e505b5eb0ad487d56051d4` | keccak of the canonical signature, confirmed 2026-10-11 against two independent signature databases (4byte.directory + openchain); whitelisted before its first on-chain occurrence |

Counts at recon time (operator, via Blockscout — **reconciliation target**, not RPC-verified):
634 NewFeedback + 137 FeedbackRevoked through block 86,021,735; 114 new + 1 revoked in the prior
~24h. RPC-side density spot checks agree in shape: 147 NewFeedback + 1 revoke in [84.0M–86.0M],
50 NewFeedback in [70.0M–72.0M] (first 71,069,849), 1 at 67,244,831, 2 at 59,343,863.

**First-event block discrepancy (reconciliation obligation #1):** operator recon says the first
event is at block 30,786,790. The public RPC returns a *clean empty* `eth_getLogs` result for
[30M–32M] — twice, paced, while block 30,786,678 exists (ts `0x6a76c4a9` ≈ 2026-08-10). Events are
provable at 59.3M+, so either the operator's number comes from Blockscout's deeper index or the
public RPC silently returns empty below some depth. The walk must not trust either answer; see §6.

## 2. Event layouts (decoded from live logs — authoritative over EIP text)

`NewFeedback` topics: `[sig, uint256 agentId, address clientAddress, bytes32 indexedTagHash]`.
Per EIP-8004 the third indexed parameter is `string indexed indexedTag1` — **not** the feedback
index. topics[3] on-chain (`0x5c6b6f86…`) is keccak of the tag string (`credit.statement` in the
sample). The operator's recon transcribed this slot as `uint64 index`; chain data rules that out
(a uint64 would be right-aligned-small, like the revocation sample's `index=2`).

`NewFeedback` data (v2.0.0 deployed layout — re-verified live 2026-10-11, matching the current
EIP-8004 text exactly; the five-string no-index decode first written here was wrong by one word):
head `[uint64 feedbackIndex, int128 value, uint8 valueDecimals, four string offsets (base-0
canonical: 256/320/384/416), bytes32 feedbackHash]` followed by the four string bodies.
Live sample (agentId 8653, client `0x03af…7ac7`, block 85,182,162): feedbackIndex=1, value=0,
decimals=6 — confirmed by the rater's own inline proof payload (`"value":"0","valueDecimals":6`).
The four strings are `tag1` (`credit.statement`), `tag2` (`unsecured`), `endpoint` (empty in the
sample) and `feedbackURI` (the automated rater's `data:application/json;base64,…` proof payload;
feedbackHash is keccak of that content). `feedbackIndex` is emitted by every event kind, so a
revocation names its exact rating — no ordinal reconstruction is needed (§3.1).

`FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)`
— verified live: agentId 7,622, client `0x6138…0a73`, index 2, empty data (a second sample:
agentId 462, client `0x6138…0a73`, index 1, block 80,992,193).

`ResponseAppended(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex, address indexed responder, string responseURI, bytes32 responseHash)` — four topics; none on-chain yet. Topic0 whitelisted ahead of the first occurrence (§5) so the first reply cannot halt the walk; the decoder is shape-pinned and tested, and responseURI/responseHash have no ledger columns (the retained raw batch is their record).

## 3. Operator bounds and how the design satisfies them

1. **Key each rating by agent, client and index; a revocation removes exactly what it matches.**
   The corrected §2 layout settles this outright: `feedbackIndex` is emitted by *every* event kind
   (NewFeedback data word 0, FeedbackRevoked topics[3]), so a revocation joins the exact rating it
   names on `(agentId, clientAddress, feedbackIndex)` — exact by construction, not by inference.
   The row is never deleted; the join simply stops matching once the revocation row exists.
   `pairOrdinal` (the row's chain-order rank within its pair, recomputed at apply time) is kept as
   a **completeness tripwire**: on a complete ledger, rank == emitted feedbackIndex for every
   `new` row, so any divergence is a mechanical deep-history gap detector (the §6 reconciliation
   reads exactly this).
2. **Read `value` with `decimals`; no shared scale.** Both stored raw (`DECIMAL(39,0)` for int128,
   `TINYINT` for decimals). No cross-rater aggregation in the ledger. Any public display shows
   each rating beside its own rater context, never a blended score; `getSummary`'s Sybil warning
   in the EIP is the documented reason.
3. **Strings are untrusted text.** Cap each stored string at 512 bytes with an explicit truncation
   marker; render as plain text only. URIs (including inline `data:` payloads) are never fetched
   or decoded — stored raw, displayed as "chain proof present" + feedbackHash hex only.
4. **Chunked reads with a (block, logIndex) cursor.** Confirmed: single giant range fails, and the
   RPC rate-limits hard when called in rapid succession (repeated HTTP failures during
   verification even at 5–9s spacing — Cloudflare escalation, same pattern as the identity
   backfill incident). The walk therefore advances **one 2M-block window per run** (one operator
   click / one worker tick), exactly the identity cadence, with the existing transient-retry
   ladder and adaptive narrowing reused verbatim.
5. **Show who rated before what the score is.** The ledger is per-rating rows keyed by client
   address; the future read model lists rater short-form first, score second. Aggregate surfaces
   (if ever) count distinct raters only — no blended averages.

## 4. Ledger (migration 0018, alongside the enum extension)

New table `agent_reputation_events` (append-only, INSERT-IGNORE idempotent on
`UNIQUE(sourceId, txHash, logIndex)`), new protocol enum value `erc8004_reputation`:

- identity: `sourceId`, `kind` (`new` | `revoked` | `response`), `agentId` `BIGINT UNSIGNED`
  (chain ids are small today; comment the uint256 caveat), `clientAddress` `CHAR(42)`
- position index (emitted by every kind): `feedbackIndex` `BIGINT UNSIGNED` — the exact
  revocation-join key and the completeness-tripwire comparator (§3.1)
- rating payload (kind `new`): `value` `DECIMAL(39,0)`, `valueDecimals` `TINYINT`,
  `tag1/tag2/endpoint/feedbackUri` `VARCHAR(512)` capped, `feedbackHash` `CHAR(66)` hex
- chain position: `blockNumber`, `logIndex`, `txHash` `CHAR(66)`, `blockHash`, `observedAt`
- derived (recomputed per apply over the source's `new` rows): `pairOrdinal` — the row's
  chain-order rank within `(sourceId, agentId, clientAddress)` among kind=`new` rows only

Indexes: `(sourceId, agentId)`, `(sourceId, agentId, clientAddress, blockNumber, logIndex)`,
`(sourceId, agentId, clientAddress, feedbackIndex)` (the revocation join + tripwire read),
unique `(sourceId, txHash, logIndex)`. Raw log JSON retained content-addressed like the
identity/activity ledgers (the ledger's 512-char caps mean full `feedbackURI` payloads live
only in the retained batch). Zero reviewed-record impact — this is the acknowledged chain-fact
layer, same governance posture as the activity ledger.

## 5. Walk & cursor design

Second source row: protocol `erc8004_reputation`, preset
`robinhood-erc8004-reputation-registry`, `manual_only` at birth, `scheduleMinutes` 15. Separate
cursor space on that row (the identity row's cursor is untouched):

- No cursor → seed: backward window `[head−600−2M+1 … head−600]`, cursor `rb:<fromBlock−1>`
- `rb:<block>` → continue backward until `fromBlock ≤ 1` → `rb:done` (genesis reached, same as the
  identity bf: walk; empty deep windows are tolerated but see §6)
- `rb:done` → forward seed from the ledger high-water (MAX blockNumber), cursor `fw:<block>#<hash>`
  — the identity forward machinery (`parseRobinhoodForwardCursor`,
  `robinhoodForwardWindowBounds`, anchor re-check, `RobinhoodRegistryReorgError`) is
  cursor-shape-generic and is reused as-is; `fw:` keeps its prefix so the parser stays shared.

Each window is one **address-only** `eth_getLogs` call (wire-proven at 2M-block spans) — no topic
filter, so every event kind is captured in one round trip and merged by nothing. ResponseAppended
is whitelisted ahead of its first occurrence (operator direction, 2026-10-11: the first reply to
any rating must not stop the import — "add it before one shows up"): the canonical signature's
keccak was confirmed against two independent signature databases, and an unobserved-but-canonical
event is strictly safer than a walk-halting surprise. If the deployed contract ever deviates from
the canonical signature, the unknown-topic tripwire still fires on the real event.
Reorg safety: anchor hash re-check per forward window via the existing `fetchRobinhoodBlockHash`;
loud failed run, cursor untouched. **Upgrade tripwire:** any log from the proxy address whose
topic0 is neither of the three verified event topics fails the run loudly (that is how `Upgraded`
— or any genuinely new event kind — announces itself at this address), and the implementation slot is
re-read each run, failing if it ever differs from `0x16e0fa7f…da34` — one is event-level, the
other state-level, either alone is sufficient.

**Lifecycle topics — observed and whitelisted (2026-10-11, backward runs 1–2):** the tripwire
fired twice, exactly as designed, and mapped the proxy's full lifecycle:

- **Birth — block 12,058,837**, tx `0x76b048b37514932c9db2de6aa07de4019458fbb12ca0414db4a0367ef02b36af`:
  `Upgraded(address)` to first implementation `0xcb7af40c…f067`, constructor
  `OwnershipTransferred(address,address)` (zero → `0x547289…2603`), `Initialized(uint64)`.
- **Upgrade #1 — block 30,786,790** (the operator's recon "first event"), tx
  `0x1ad2c9bd95521b6c146062604b8d93d0041d28c5a8e1a77a2e2bb614e9b027c5`:
  `Upgraded(address)` to `0xee43505b…ea4e` plus a re-`Initialized`.

All three hashes were verified against the receipts and the signature database, then whitelisted
as recognized-and-skipped (`ROBINHOOD_REPUTATION_LIFECYCLE_TOPICS`); they are counted, never
ingested. Since the slot currently reads `0x16e0fa7f…da34`, at least one more `Upgraded` sits
between 30.7M and head and is skipped silently — the state-level slot tripwire remains the
actual upgrade guard. Below block 12,058,837 the address had no code, so the remaining descent
to `rb:done` is provably empty windows.

## 6. Reconciliation obligations (block "done" claims)

1. First-event block: **RESOLVED 2026-10-11** — the operator's 30,786,790 is the proxy's
   *upgrade #1* transaction, not feedback, and not even the birth: the proxy was deployed at
   block 12,058,837 (see §5's lifecycle table). The public RPC never hid history — the earlier
   [30M–32M] probes were topic-filtered NewFeedback queries and were honestly empty. Feedback
   history's true start is whatever the descending walk last observes — currently provable to
   59,343,863. After `rb:done`, still compare ledger totals against the operator's 634/137 and
   scan the §3.1 completeness tripwire (pairOrdinal vs feedbackIndex); label the ledger
   "measured since <oldest observed block>", never "complete".
2. Per-pair integrity spot check after `rb:done` (optional, cheap): for a few pairs,
   chain-order count vs contract state if a readable getter is confirmed by then.
3. **Reconciliation PASSED 2026-10-11 (`rb:done` reached 19:58:30Z + independent chain-side
   re-scan):** a paced full-history RPC re-scan (single-topic 2M windows, birth→head 86,100,634)
   counted NewFeedback 642 = Blockscout 634 + 8 post-recon drift (recon was through 86,021,735)
   and FeedbackRevoked 137 = Blockscout 137 exactly; chain-order rank == feedbackIndex held for
   all 505 (agent, client) pairs with zero mismatches — mathematically excluding any missing
   event before each pair's oldest captured rating. 310 distinct agents rated by only 8 rater
   addresses; revocation indices observed: 1–2. The ratings ledger may be labeled **complete
   from the proxy's birth (block 12,058,837)**; the "measured since oldest observed" caveat is
   dropped. Optional DB-side hardening: one phpMyAdmin line comparing stored `pairOrdinal` to
   `feedbackIndex` (guards against insert-time corruption the chain scan cannot see).

## 7. Rollout sequence

1. ✅ Migration `0018_erc8004_reputation.sql` (enum value + table) — shipped in the repo;
   awaits the operator's phpMyAdmin apply (inside the database context, like 0017).
2. ✅ Adapter + run wiring + tests (decoders, cursor, narrowing reuse, both tripwires,
   15-test suite).
3. ✅ Preset + operator buttons on /admin/sources — **Backfill window** and **Fill ratings**,
   manual_only; the generic "Run once" control is deliberately hidden for this protocol so no
   stray click can fire a real window.
4. ✅ Operator drove the backward walk (**Backfill window**, one click per window, human pacing
   defeats the throttle) — `rb:done` reached 2026-10-11 19:58:30Z.
5. ✅ `rb:done` reconciliation against §6 — PASSED (§6.3).
6. ✅ Public surface (per-rating list under each agent) — shipped 2026-10-12 (`5fc6be8`; see the
   status addendum above).
7. [ ] Automation (0017-style policy flip) only after the forward walk has run unattended-clean for a
   full day — the ratings ledger earns scheduling the same way the activity walk did.

## Addendum 2026-10-13: the "fail=2" was operator-mistake refusals, not faults

The reputation source read `failureCount` 2 and `lastError` "The reputation backfill already reached genesis
(rb:done); continue with the ratings fill (activity) mode." Its cursor was `rb:done`: the backfill had reached
genesis cleanly. The two failed runs (2026-10-11 19:58Z and 2026-10-13 11:05Z) were manual runs started in
backfill mode from the console's "Backfill window" button, which was still offered at that position. The adapter
refused each with its own guard message, but only after a run row existed and RPC calls were spent, so each
refusal was recorded as a failed run. The result was a standing warning on the public status and in the live
health check, for something that was never a fault.

Fixed three ways:

1. **Refuse before a run exists.** `assertReputationModeFitsCursor` (in `robinhoodReputation.ts`) applies the
   rule (a backward position, `null` or `rb:<block>`, runs only the backfill; a forward position, `rb:done` or
   `fw:`, runs only the ratings fill) and is called by `runApprovedRobinhoodReputationSource` before
   `withIngestionRun`. A wrong-mode click is now refused with no run row, no RPC call, and no failure count. The
   adapter keeps its own checks, now sharing the same two message constants.
2. **Offer only the button that can work.** The console shows "Backfill window" only while the walk is backward
   and "Fill ratings" only once it is forward (`client/src/lib/walkModes.ts`); an unrecognized cursor shows both
   and leaves the decision to the server.
3. **Clear the existing false failures** (migration `0032`). A guarded `UPDATE` resets `failureCount` and
   `lastError` only when every condition holds: the reputation source, a cursor of exactly `rb:done`, a recorded
   failure, and a `lastError` that is the guard message. Any other error (an RPC failure, a reorg, a tripwire) is
   never cleared. The failed `ingestion_runs` rows keep their history. `reputationFalseFailureReset.test.ts` runs
   it on a real MySQL and fails if any guard is removed.

The scheduled-flip decision for this source (todo item 54) is unchanged: it still wants a clean attended
**Fill ratings** run first, which the operator can now start without the console also offering the wrong button.
