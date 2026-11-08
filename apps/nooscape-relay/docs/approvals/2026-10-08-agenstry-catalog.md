# Source approval — Agenstry public federation catalog

**Reviewed:** 2026-10-08
**Source key:** `agenstry-public-catalog`
**Protocol:** `catalog`
**Canonical endpoint:** `https://agenstry.com/api/feed/all.jsonl.gz`
**Allowed hostname:** `agenstry.com`

## Approval scope

Approve a **single bounded, read-only snapshot** of the documented public gzip NDJSON federation feed, followed by a once-daily scheduled read only after the first retained payload is reviewed.

The adapter may read the feed endpoint above. It must not follow or invoke any URL found inside a record: no AgentCard retrieval, provider call, MCP/tool call, payment action, authentication, JavaScript execution, redirect, or browser interaction.

## Bounds

| Control | Value |
|---|---:|
| Feed requests | 1 per manual run; 1/day scheduled |
| Scan limit | 5,000 NDJSON records |
| Accepted records | At most 12 |
| Candidate selection | `kind=a2a_agent`, no sanction flag, at least one source-reported signal, one record per provider hostname |
| Compressed payload cap | 4 MiB |
| Line cap | 32 KiB |
| Request timeout | 20 seconds |
| Evidence retention | 90-day governance Object Lock |

## Evidence interpretation

A retained record is **catalog discovery metadata**, not an assertion that Nooscape independently verified the provider, owner, domain, signature, availability, safety, or quality. Any catalog-reported `signed`, `domain_verified`, or `verified_owner` value is preserved as an upstream assertion and may not change the Nooscape publisher state or exceed Tier 2.

## Projection rule

After the first run, an operator must recompute the stored-object SHA-256 and confirm governance retention. Each agent profile requires an explicit source-projection decision. The default is **not projected**.

## Outcome

- [x] Registered in production: `8e768b55-2508-470f-a10a-af9c519e1a76`
- [x] Approved active by an operator
- [x] First bounded snapshot completed: 1 request, 473 discovered records, 12 accepted, 456 rejected
- [x] All 12 retained raw objects passed independent SHA-256 recomputation and 90-day governance-retention checks
- [x] Source-level projection approved; all 12 are publicly visible as Tier 2 / unverified catalog discovery metadata

## Addendum (2026-11-06): the bounds as they stand

The bounds table above is the approval of 2026-10-08. The adapter's bounds have been raised since, and the code holds the values below ([the record of the latest change](../agenstry-limits-2026-11-06.md)). The scope of the approval is unchanged: one read-only request for the same endpoint, nothing inside a record is followed, and a record is taken only if it is `kind=a2a_agent`, carries no sanction flag, reports at least one signal and is the only one taken for its provider hostname.

| Control | 2026-10-08 (above) | 2026-10-09 | 2026-11-06 |
|---|---:|---:|---:|
| Accepted records | 12 (48 later the same day) | 96 | 128 |
| Lines scanned for accepted records | 5,000 | 12,000 | 24,000 |
| Compressed payload cap | 4 MiB | 24 MiB | 48 MiB |
| Expanded payload cap, and the longest line being assembled | none | 512 MiB and 1 MiB (from 2026-10-12) | unchanged |
| Line cap | 32 KiB | 32 KiB | 32 KiB |
| Whole-feed walk for the directory | none | 300,000 lines, 240,000 records | 450,000 lines, 300,000 records |
| Request timeout | 20 seconds | 120 seconds | 120 seconds |

The 2026-10-09 values were set in commit `041646b` and the expanded and line caps in `158747f`, and this approval was not updated then; this addendum is the record. The order for the 2026-11-06 change is the operator's, in chat: "merge 302 and build the limits pr". The evidence interpretation, the projection rule and the outcome above stand. Raising the accepted-records bound publishes nothing: the public reviewed set is the operator's last published run, which is still the 48 records of the manual run of 2026-10-09.
