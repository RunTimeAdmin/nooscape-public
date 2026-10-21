# Live population record — 2026-10-08

> **Historical record with current supersession note:** This document began as the first 12-record catalog population run. The initial facts below are retained for audit. Current production population is **58 source-scoped public records**, following the later fully reviewed 48-record Agenstry expansion and manual Metaplex review. The self-owned Nooscape Observatory record subsequently completed a consented domain-control pilot and projects as **Tier 3**; the remaining 57 records are Tier 2 / unverified.

## Current public result

| Source class | Protocol | Public records | Current status |
|---|---|---:|---|
| Agenstry public federation catalog | `catalog` | 48 | Tier 2 / unverified, source scoped |
| Approved A2A AgentCards | `a2a` | 3 | Tier 2 / unverified, source scoped |
| Metaplex Solana Agent Registry | `solana_registry` | 7 | Tier 2 / unverified, source scoped, manual-only source |
| Agent Economy aggregate census | `census` | 0 agents | Aggregate `/context` only |
| **Total** | — | **58** | **58/58 provenance-ready signed envelopes** |

All 58 public records are retained observations from approved sources. No record is currently publisher-verified or allowlisted. The six UI seed records remain illustrative and are not included in production evidence totals.

## Expanded Agenstry catalog snapshot

The later manual catalog snapshot superseded the initial 12-record projection as the current catalog public set.

| Measurement | Result |
|---|---:|
| Source | Agenstry public federation catalog |
| Feed entries scanned | 3,478 |
| Records accepted | 48 |
| Records rejected | 3,410 |
| Retained observations reviewed | 48 / 48 |
| SHA-256 matches | 48 / 48 |
| Object Lock state | `GOVERNANCE`, 90 days per object |
| Projection | Explicit public Tier 2 / unverified decision |

The catalog adapter made one bounded public-feed request. It did not follow, invoke, authenticate to, pay, or execute any advertised agent endpoint. Catalog owner, signed, domain, and provider signals remained unverified assertions.

## Manual Metaplex registry review

| Measurement | Result |
|---|---:|
| List page boundary | One fixed page, maximum 24 index entries |
| Index entries discovered | 24 |
| Structurally eligible records accepted | 7 |
| Retained objects reviewed | 7 / 7 |
| SHA-256 and governance retention | Passed for all 7 |
| Projection | Explicit public Tier 2 / unverified decision |
| Scheduling | `manual_only`; excluded from worker |

No chain RPC, wallet operation, payment, tool execution, A2A request, or per-record metadata dereference occurred during the run. Registry-reported mint, authority, wallet, and A2A fields are not independently verified.

## Initial historical run

The initial live-population activation moved the Atlas from seed-only display to **15 persisted agent observations**: 12 Agenstry catalog records plus 3 approved A2A records. It also retained the Agent Economy aggregate census as context only.

| Source | Protocol | Initial discovered | Initial accepted | Historical projection |
|---|---|---:|---:|---|
| Agenstry public federation catalog | `catalog` | 473 | 12 | Public Tier 2 / unverified discovery metadata |
| Agent Economy aggregate census | `census` | 1 | 1 | Public attributed aggregate context only |

Those initial facts remain an audit trail; they are not the current total.

## Semantics and continuation

- Tier 2 / unverified means approved-source metadata with retained raw evidence. It does not verify owner, publisher key, safety, current availability, or quality.
- The scheduled worker may process approved A2A, catalog, and census sources under one-source-per-tick and daily cadence controls. It cannot run the Metaplex source.
- The next source must have its own review record, bounded fetch policy, retained-evidence review, and explicit projection decision. No broad re-ingest or crawler expansion is authorized.
