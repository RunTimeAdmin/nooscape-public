# Nooscape production A2A pilot record

**Date:** 2026-10-08
**Status:** Completed successfully
**Scope:** One manually approved fetch of a Nooscape-owned public A2A AgentCard

> **Supersession note (2026-10-08):** the Nooscape Observatory record later completed a consented self-owned domain-control challenge and now projects as **Tier 3** with publisher state still unverified. The `tier_2` statements below describe this pilot run at the time.

## Purpose

This pilot validated the complete provenance path before any external discovery source is enabled:

1. operator authentication;
2. approved-source registration and review;
3. bounded HTTPS AgentCard retrieval;
4. immutable raw-object storage;
5. normalization and evidence persistence; and
6. public read-model projection.

## Approved source boundary

| Field | Value |
|---|---|
| Source label | Nooscape owned A2A AgentCard pilot |
| Protocol | A2A |
| Approved root | `https://nooscape.si` |
| Only fetched resource | `https://nooscape.si/.well-known/agent-card.json` |
| Source state after approval | `active` |
| Scheduling | Disabled. This run was invoked manually. |

The ingestion code did **not** invoke an agent endpoint, execute a tool, send a prompt, or transact.

## Run result

| Measurement | Result |
|---|---:|
| HTTP requests | 1 |
| AgentCards discovered | 1 |
| Accepted records | 1 |
| Rejected records | 0 |
| Normalized handle | `nooscape-observatory` |
| Public evidence tier | `tier_2` |
| Publisher state | `unverified` |

`unverified` is intentional. Discovery of a Nooscape-owned card proves a retained observation, not a publisher-key allowlist or independent identity validation.

## Immutability verification

The raw source response was stored under a content-addressed RustFS object key. The stored object was read back and its SHA-256 digest matched the public AgentCard byte-for-byte.

| Control | Result |
|---|---|
| Bucket | Private `nooscape-evidence` |
| Object Lock | Enabled |
| Retention mode | `GOVERNANCE` |
| Retention duration | 90 days per object |
| Exact-version deletion test | `AccessDenied` without a governance-bypass request |
| Read-back hash | Match |

No access credentials, database URLs, or operator tokens are recorded in this document.

## Public visibility

The public `liveData.publicRecords` endpoint now returns the persisted record. The map surfaces persisted observations as **OBSERVED** and keeps seed records clearly illustrative.

## Signed-envelope verification

The public `atlas.evidence` endpoint now prefers persisted observations and issues a signed envelope from a stable, server-only Ed25519 identity. Independent production verification confirmed all of the following:

| Control | Result |
|---|---|
| Relay key identity | Public envelope key matches the configured production signing identity |
| SHA-256 integrity | Match |
| Ed25519 signature | Valid |
| Evidence class | `persisted-observation` |
| Raw evidence exposure | None; the envelope describes a `private-object-store` boundary only |

The exported envelope includes the digest, observed-document locator, validation state, retention-policy label, public verification key, and signature. It never includes raw object bytes, the RustFS object key, a presigned URL, or a server credential.

## Historical next gate and current status

The gate described after this pilot was completed: external A2A sources were independently reviewed, catalog and aggregate context sources were activated under bounded rules, and a manual-only Metaplex review was completed. The continuing rule is unchanged: every future source needs a written approval record covering the exact boundary, cadence, review evidence, projection decision, and pause/revocation path. See [AI handoff](./AI_HANDOFF_2026-10-08.md) for the current source inventory.
