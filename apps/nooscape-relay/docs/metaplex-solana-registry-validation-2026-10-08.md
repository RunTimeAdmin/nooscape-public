# Metaplex Solana Agent Registry — Nooscape source validation

**Validated:** 2026-10-08
**Current decision:** One **manual-only, bounded production review** completed. The source is registered with `manual_only` execution policy, has **7 public Tier 2 / unverified records**, and must remain outside the scheduled worker.

## Validated endpoint and source boundary

```text
GET https://api.metaplex.com/v1/agents?pageSize=24&sort=latest&activeOnly=true
```

| Control | Enforced production boundary |
|---|---|
| Source protocol | `solana_registry` |
| Request host | Exactly `api.metaplex.com` over HTTPS |
| Page boundary | One fixed list page; 24 index entries maximum |
| Execution policy | `manual_only` — worker rejects this protocol |
| Read scope | Public list endpoint only; no chain RPC, wallet call, tool execution, transaction, or A2A invocation |
| Raw evidence | Entire bounded JSON response retained privately with SHA-256 and 90-day governance retention |
| Public projection | Explicit operator decision only after retained-evidence review |
| Public trust state | Tier 2 / unverified |

The API is an indexed registry view, not an on-chain scan. A source-provided `a2aCard`, mint, authority, wallet, registration signature, `verifiedAt`, active flag, or metadata URI is an assertion unless a separately approved proof path establishes it.

## Completed manual review

| Measurement | Result |
|---|---:|
| Index entries discovered | 24 |
| Structurally eligible records accepted | 7 |
| Rejected entries | 17 |
| Retained objects checked | 7 / 7 |
| SHA-256 / governance-retention review | Passed for all retained objects |
| Public projection | Explicit public decision after review |
| Public result | 7 source-scoped Solana registry records, Tier 2 / unverified |

The run did not dereference metadata URIs or AgentCards, make Solana RPC calls, invoke tools, access wallets, submit transactions, or create payment activity.

## Upgrade policy

A registry observation can become discoverable after review but cannot become publisher-allowlisted or Tier 4 from the Metaplex index alone.

- **Tier 2:** approved registry metadata with retained raw evidence.
- **Tier 3:** a successful, consented Nooscape domain-control proof.
- **Tier 4 / allowlisted:** publisher-key policy proposal, valid Ed25519 attestation, and independent Nooscape operator approval.

## Deferred cross-check work

An independent DAS/on-chain cross-check of the Core asset and AgentIdentity plugin remains a separate future workstream. Select a provider and validate its access terms, response semantics, quotas, request boundary, evidence retention, identity linkage, and projection rules before using a cross-check for any public claim. It must not silently upgrade the seven current registry records or schedule the source.

## Sources consulted

- [Metaplex List Agents API](https://www.metaplex.com/docs/api/list-agents)
- [Metaplex Read Agent Data](https://www.metaplex.com/docs/agents/read-agent-data)
- [Solana Agent Registry overview](https://solana.com/agent-registry/what-is-agent-registry)
