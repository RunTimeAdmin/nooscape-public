# Source approval — Agent Economy public aggregate census

**Reviewed:** 2026-10-08
**Source key:** `agent-economy-public-census`
**Protocol:** `census`
**Canonical endpoint:** `https://agenteconomy.to/data.json`
**Allowed hostname:** `agenteconomy.to`

## Approval scope

Approve a **single bounded, read-only aggregate-census snapshot** and a once-daily scheduled read after the first payload is reviewed. This source provides chain/protocol context only.

The adapter may read the canonical JSON document above. It must not discover, create, update, or project individual agent profiles. It does not fetch chain RPC, documentation, contract, wallet, payment, registry, or other URLs mentioned by the payload.

## Bounds

| Control | Value |
|---|---:|
| Feed requests | 1 per manual run; 1/day scheduled |
| Payload cap | 256 KiB |
| Request timeout | 12 seconds |
| Accepted output | One retained aggregate observation |
| Evidence retention | 90-day governance Object Lock |

## Evidence interpretation

The dataset's figures—including coverage for Solana registry accounts or Robinhood Chain ERC-8004 entries—are **aggregate third-party metrics**. They are not identity proof, agent behavior proof, a Nooscape trust score input, or a license to create agent profiles.

## Projection rule

No agent projection is allowed. Publication is limited to an attributed aggregate-context surface after the raw payload hash and retention state are reviewed.

## Outcome

- [x] Registered in production: `6900b9ce-4b70-4cc5-a18e-46ccf9453b9b`
- [x] Approved active by an operator
- [x] First bounded snapshot completed: 1 request, 1 accepted aggregate observation
- [x] Retained raw payload passed independent SHA-256 recomputation and 90-day governance-retention checks
- [x] Source-level projection approved for a future attributed aggregate-context surface only; no agent profile was created and no identity claim is published
