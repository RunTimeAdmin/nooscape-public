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
