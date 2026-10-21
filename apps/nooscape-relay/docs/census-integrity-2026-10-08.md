# Census integrity — live profile, audit, and count reconciliations (2026-10-08)

> **Status:** The read-only census audit (`pnpm census:audit`, `7028cd2`), the live census profile, the first count reconciliations, and the verified retirement mechanics are recorded here. The operator-gated per-record withdrawal capability (see [record withdrawal](./record-withdrawal-2026-10-08.md)) **shipped 2026-10-08 (`0278a94`) and migration `0010` was applied in production the same day through the one-time operator bridge (removed immediately after; the route returns HTTP 404)**, so candidate retirement is executable one record at a time; a first independent Tier 3 record remains the open step. Nothing in this record writes to production; the audit never merges and never writes.

## The gap

- The Atlas is a trust surface, and its credibility is exactly its census. 58 records is a seed, not an atlas: **48 of 58 records come from one catalog** (83% single-source concentration) and `sourceCount` is **1 on every record** — the identity-dedup pipeline has never been exercised on live data.
- No whole-census operation existed before this record: composition, concentration, provenance readiness, and duplicate/placeholder signals were only visible record-by-record through operator review.
- Three count questions stayed open from source validation: the SATI total (a recorded 1,542 vs SATI's own 153), the USDG payer-attribution question on x402 facilitators, and the Robinhood chain-4663 agent count (recorded ≈8,600 / 8,589 vs 14,993 live). Unreconciled numbers must not ship.

## Live census profile (2026-10-08)

Observation class: public served records through the read path (`liveData.publicRecords`), read-only, no auth. Profiled twice — at analysis time and again at commit time — with identical results:

| Metric | Value |
|---|---|
| Public records | **58** |
| By protocol / source class | 48 catalog · 7 Solana registry (+a2a) · 3 A2A |
| Evidence tiers | **57 tier_2 + 1 tier_3** (self-owned Nooscape Observatory pilot) |
| Publisher state | **58 unverified** (0 publisher-verified) |
| `sourceCount` | **1 on all 58** |
| Single-source concentration | **83%** (Agenstry catalog; informational concentration flag at ≥ 75%) |

## Live review candidates (flagged — never merged)

The audit's deterministic rules plus a manual quality read flag these served records. They are review candidates for the operator, not automatic removals; retirement is operator-gated, evidence-recorded, and reversible (mechanics verified below) — never by direct database edits.

| Record | Handle | Signal | Reading |
|---|---|---|---|
| Agenstry (#16) | `agenstry-48555b12fc-1277b40b29` | catalog self-listing (record locator host = source allowed hostname) | The catalog operator listing itself; the adapter now rejects feed self-host records (`2152919`), so this stored snapshot retires at the next reviewed catalog re-run |
| R1 (#49) | `r1-3e2po3udre-8236508099` | placeholder: name < 3 chars; summary is "R1" | Solana registry record with no content |
| stella (#51) | `stella-ap7scxsqcs-27ffe77b63` | placeholder text: "give a utility to this Token" | Solana registry record registered as a token-utility request |
| A2G commons test agent (#18) | `a2g-commons-test-agent-6e27afa1a9-10a1addfd3` | dev-stack capture ("Internal test agent … dev stack") | Human review: a test fixture, not an operating agent |
| AAA A2A Gateway (#33) | `aaa-a2a-gateway-8c1f3254b0-cec8db745f` | borderline ("DISPLAY_ONLY … Never executes") | Human review: a real listing with display-only semantics |
| allagents (#34) | `allagents-3296c47f02-33777f4214` | borderline (competing directory self-listing) | Human review: a directory record, not an agent |
| agents.txt Reference Agent (#57) | `agents-txt-reference-agent-e179991ff0` | borderline (spec reference artifact) | Human review: a documentation agent for the agents.txt standard |

The audit's exact-signal rules (self-listing, short/placeholder text, duplicate endpoints, name-only collisions) catch the deterministic cases; the borderline rows above require operator judgment and are listed here so no future pass has to rediscover them.

### Retirement mechanics (verified against server code, 2026-10-08)

At audit time, retirement had exactly two paths, both **source-wide**:

1. **Automatic:** a record retires when a later approved run does not re-observe it (it fails the `sourceObservationRuns` join in the reviewed-run gate). This requires the adapter to reject it or the upstream source to drop it.
2. **Source revoke:** the operator revokes a source's public projection — which removes **every** record from that source, not just the candidate.

Per-candidate verification:

| Candidate | Retires today? | Why |
|---|---|---|
| Agenstry (#16) | **Yes — automatically** on the next approved catalog run | The adapter's self-listing rejection (`2152919`) stops re-observing it |
| A2G commons test agent (#18), AAA A2A Gateway (#33), allagents (#34) | No | Re-observed unchanged; revoking the catalog would remove all 48 records |
| R1 (#49), stella (#51) | No | Re-observed unchanged from the manual Solana registry; revoking would remove all 7 |
| agents.txt Reference Agent (#57) | No | Re-observed unchanged; revoking the a2a source would also retire the Tier 3 Observatory record |

There is no per-record withdrawal at the time of the audit (`7028cd2`): the evidence-review endpoints (`verifySourceEvidence{,Batch}`) were read-only inspection, `Publish reviewed run` approves the entire run, and no schema field or UI action could exclude a single record. That gap is now closed: the operator-gated, evidence-recorded, reversible per-record withdrawal capability shipped 2026-10-08 (`0278a94` — append-only `agent_record_withdrawals` ledger, fail-closed read-path filter, `RECORD_WITHDRAWN`/`RECORD_REINSTATED` evidence events, operator UI, and a census-audit mirror), and migration `0010` was applied in production the same day through the one-time operator bridge, which was removed immediately after. See [record withdrawal](./record-withdrawal-2026-10-08.md).

## The census audit (shipped `7028cd2`)

`pnpm census:audit` — `server/censusAudit.ts`, read-only, never writes.

- Replicates the reviewed-run read gate and **fails closed on any divergence from the served set** (exact sorted-agentId equality with `listLiveAtlasRecords`).
- Provenance checks per served record (fail-closed): observation validity, raw-object key + content hash present, source active, evidence event present.
- Composition and concentration: by source, by protocol, tier mix, publisher-state mix, maximum single-source share (75% threshold).
- Exact-signal review candidates: duplicate endpoint hashes across agents, name-only collisions (never merged), catalog self-listings, placeholder/short text. Up to 20 details per class, plus the pending identity-merge review count.
- One JSON line; exit 0 only when the served set matches exactly and zero provenance violations exist.

Run matrix — same tool, two proofs:

| `DATABASE_URL` | What it proves |
|---|---|
| production | live served census ↔ provenance integrity |
| restored copy | the census re-derives identically from a restored database (pairs with the durability restore drill) |

## Count reconciliations (2026-10-08)

| Claim | Live reading (2026-10-08) | Status |
|---|---|---|
| SATI total agents | **153** (SATI `/api/stats`, stable across probes) vs **1,542** recorded earlier | **Unreconciled.** The 1,542 reading is no longer re-derivable from the current SATI surface; neither number is publishable until the methodology is reconciled with SATI |
| Robinhood (chain 4663) agents | **14,993** (agenteconomy.to `data.json`, erc8004Registry asOf 2026-10-07T03:15Z) vs 8,589 recorded vs ≈8,600 in SCOPE | **Drifted.** The shape (bulk-mint steps in the daily series) is consistent with programmatic registration, not measurement error; ground truth must be a direct `Registered`-event count over the Robinhood RPC when that source is approved |
| ERC-8004 total (context) | 618,776 agents across 24 tracked chains (same source/asOf) | Context only — never presented as Nooscape census |

The current `data.json` no longer carries the 8,589 / 1,542 / 3,182 / 1,640 strings (verified absent) and has no Metaplex/SATI sections — historical readings must be quoted with source + date, never re-derived silently.

**USDG payer attribution (open; rail measured 2026-10-10).** Five facilitators (Hoodx402, Aeron, Solvador, Payless, rhx402) settle USDG via EIP-3009. Acceptance criterion before any attribution claim: a bounded event scan must resolve both payer and recipient addresses to registry identities with unambiguous roles; if event-level scanning cannot, facilitator APIs are required. No number ships until one of the two passes. **Event-level scanning has now been tried and cannot:** the 2026-10-10 bounded probe (fresh 300k-block window at head 85,302,597; 368 payers, sampled payees and relayers) found zero overlap with the top-12 registering wallets. The rail itself is measured and public (migration `0014`, the `usdg_settlement` ledger, shipped 3ae48f4/b4761a1): settlement counts, exact median, micropayment share, participant counts, block coverage — rail facts only. Attribution stays an explicit known-unknown on the homepage until a facilitator's data resolves it; probe details in [INGEST_POINTS §1.7](../../INGEST_POINTS.md).

## Operating rules

- No public census number without a reconciliation record — source + timestamp + method, in this file.
- The audit flags; it never merges and never writes. Identity merges remain reviewable, consented acts (never merge on name alone).
- Single-catalog majority is a standing concentration risk; each new independent reviewed source reduces it.

## Operator checklist (pending)

1. Run `pnpm census:audit` against production (or a restored copy) and archive the JSON line with the date.
2. Retire the review candidates: #16 retires automatically on the next approved catalog run; the other six are withdrawn through the live operator action — migration `0010` is applied — each with a written reason (see retirement mechanics above and [record withdrawal](./record-withdrawal-2026-10-08.md)).
3. Pursue a first independent (non-self-owned) Tier 3 record — the strongest antidote to concentration.
4. Re-run the audit after every source-scope or projection change; re-attempt the SATI / Robinhood reconciliations when their access gates open.

## Drill log

- 2026-10-08 — audit shipped (`7028cd2`); fail-closed smoke without `DATABASE_URL` (exit 1, config-required JSON); `pnpm check` / `pnpm build` clean; suite unchanged (18 files / 71 tests, 70 pass locally). Live profile verified twice through the public read path (identical results); reconciliation probes recorded above. Candidate retirement: **not executed**. Production audit run: **not executed**.
- 2026-10-08 (retirement verification) — reviewed the gate end-to-end (schema, routers, UI, tests): only automatic non-re-observation and source-wide revoke exist; no per-record or per-observation exclusion exists anywhere. #16 retires automatically on the next approved catalog run; the other six candidates cannot be retired with current tooling. Recorded above.
- 2026-10-08 (per-record withdrawal build) — implemented the operator-gated withdrawal capability: append-only `agent_record_withdrawals` ledger + reviewed migration `0010`, fail-closed read-path filter (`listLiveAtlasRecords`, coverage query), `RECORD_WITHDRAWN`/`RECORD_REINSTATED` evidence events, operator withdraw/reinstate UI, and the census-audit ledger mirror with a `governance` block. `pnpm check` / `pnpm build` clean; suite 18 files / 76 tests (75 pass locally; the 5 new resolution cases pass). Production apply: **not executed at build time** — operator bridge pending (applied later the same day; see the next entry).
- 2026-10-08 (withdrawal production apply) — pushed `0278a94`; the fail-closed window was observed live (public census served **0** records, root HTTP 200). The operator applied migration `0010` through the one-time bridge, which was removed by the follow-up commit (route → tRPC `NOT_FOUND` / HTTP 404). Post-apply public verification: census restored to **58 records** (57 tier_2 + 1 tier_3). Candidate retirement is now executable per record; none withdrawn yet.
- 2026-10-10 (USDG settlement rail build + apply) — shipped migration `0014` and the manual-only `usdg_settlement` ledger (`3ae48f4`): the bounded EIP-3009 walk adapter (each settlement = `AuthorizationUsed` paired with the ERC-20 `Transfer` on the canonical Global Dollar; 200-settlement receipt budget, 700 ms pacing, backward `us:` cursor), the fail-closed public read, and the rail-facts-only homepage money panel. Gates: `pnpm check` clean; suite 119/120 (the one known environmental MySQL crawler failure); `pnpm build` green. The first bridge apply failed on the 65-char FK constraint name (MySQL error 1059; the table was created, FK/enums/index were not) — hotfixed to a 53-char name with a resumable per-item bridge (`b4761a1`); the production re-apply completed exactly the 5 missing items and a second call returned `already-applied`. First bounded run: **101 settlements** (27 payers, 7 payees, 6 relayers; 60 micropayments ≤ $0.01; exact median raw 1000 = $0.001) across blocks 85,288,315–85,319,293, cursor persisted at `us:85288228`. The dense-era walk then drew sustained edge 403s on the production IP (the runs' back-to-back narrowing getLogs bursts outlasted the 5-second backoff pass), so the follow-up commit paces every log scan at the measured-safe 700 ms and deepens the shared transient ladder to ~2 minutes — manual-only adapters only, so the scheduled worker is unaffected. The money panel is verified live on the homepage with the first-run totals. Attribution probe: zero overlap between the 368 sampled payers and the top-12 registering wallets — event-level scanning cannot attribute, so the panel ships rail facts only and attribution stays an explicit known-unknown (paragraph above; [INGEST_POINTS §1.7](../../INGEST_POINTS.md)).
- 2026-10-11 (dense-era settlement walk completed) — the paced operator walk tiled the full dense head era in 63 runs with zero retries: **7,417 settlements** across blocks 83,273,422–85,319,293 (~2.05M blocks; cursor parked at `us:83272548`, resumable for the sparser pre-dense era), **1,898 payers, 28 payees, 26 relayers, 4,007 micropayments (54%), exact median $0.006714** — within 1.4% of the probe's 7,315-event estimate for the era. The homepage money panel serves these totals live; rail facts only, attribution unchanged (known-unknown).

## Rollback

Delete `server/censusAudit.ts` and the `census:audit` package script. Nothing in production is affected — the tool is wired into no request path and writes nothing.

The record-withdrawal capability has its own rollback path — see [record withdrawal](./record-withdrawal-2026-10-08.md#rollback).
