# Live-source validation — 2026-10-08

> **Status update:** The initial A2A pilot, Agenstry catalog, Agent Economy census, and one manual Metaplex registry review have completed. This document preserves the original validation rationale and records the current boundaries. It does not approve any additional source.

## Active reviewed source classes

| Source | Canonical boundary | Current production outcome | Trust meaning |
|---|---|---|---|
| Agenstry | `https://agenstry.com/api/feed/all.jsonl.gz` | 48 public source-scoped catalog records after latest-run review | Tier 2 / unverified discovery metadata |
| Agent Economy | `https://agenteconomy.to/data.json` | Aggregate retained context only | Never agent identity or profile proof |
| Approved A2A AgentCards | One approved HTTPS AgentCard resource per source | 3 public source-scoped records | Tier 2 / unverified discovery metadata |
| Metaplex Agent Registry | `https://api.metaplex.com/v1/agents` fixed-page boundary | 7 public source-scoped records after one manual review | Tier 2 / unverified registry metadata; manual only |

All source classes follow approval → bounded fetch → private immutable retention → hash/retention review → explicit projection. No public source can be added from this document alone.

## Agenstry validation and current policy

- The anonymous gzip NDJSON federation feed is the only Agenstry request surface currently used. No paid intelligence, agent interaction, validation call, HTML crawl, or provider endpoint dereference is allowed.
- The latest expanded snapshot scanned 3,478 feed entries and accepted 48 provider-diverse records under strict response, line, record, and field limits.
- The feed remains point-in-time, source-provenanced measurement. Public score, liveness, signed, domain, and owner fields must not be represented as independent certification.
- Each snapshot is treated as a fresh source observation and deduplicated through immutable source identity and content provenance.

Sources: <https://agenstry.com/docs>, <https://agenstry.com/docs/api>, <https://agenstry.com/openapi.json>, <https://agenstry.com/api/feed/all.jsonl.gz>, <https://agenstry.com/terms>.

## Agent Economy validation and current policy

- The keyless `data.json` feed contains aggregate source/query/protocol/chain context. It cannot create or upgrade individual records.
- Raw census evidence is retained before derived aggregate metrics are shown at `/context`.
- Freshness claims remain conservative until observed operational behavior supports stronger assertions.

Sources: <https://agenteconomy.to/data.json>, <https://agenteconomy.to/openapi.json>, <https://agenteconomy.to/methodology>, <https://agenteconomy.to/about>, <https://github.com/realdora/agenteconomy>.

## Metaplex validation and current policy

- The documented anonymous list endpoint supplied one fixed page of 24 index entries in a dedicated manual review run; seven structurally eligible metadata records were retained and projected only after full evidence review.
- The source remains `manual_only`. It must not be routed through the scheduled worker.
- The list endpoint is an indexed view, not an on-chain scan. Mint, authority, wallet, registration, `verifiedAt`, and optional A2A declarations remain assertions without a separately reviewed DAS/on-chain proof.

See [Metaplex registry validation](./metaplex-solana-registry-validation-2026-10-08.md).

## Deferred sources and gates

| Source | Current status | Required gate before any activation |
|---|---|---|
| SATI | Deferred | Confirm access from an approved/terms-compliant provider, define a bounded metadata boundary, then review evidence/projection behavior. |
| Robinhood direct ERC-8004 RPC | Deferred | Confirm permitted, stable production-host or provider access and begin only with a bounded recent-event range. |
| QuickNode ERC-8004 Explorer | Deferred / payment gated | Explicit user payment authorization and a capped data-use review; never auto-settle. |
| x402scan | Deferred / terms and payment gated | Written data-use permission/license and explicit payment authorization. |
| Arc / Archipelago | Deferred | First-party manifest, event cursor, receipt boundary, and metadata-only test plan. |
| DAS/on-chain Metaplex cross-check | Deferred | Select and validate provider access/terms plus a separate proof-to-identity design. |

## Review rule for every future source

A new source requires a signed-off record covering exact origin or chain coordinates, owner/contact where available, authentication/payment constraints, transport/request caps, parser schema, identity anchor, retention behavior, reviewer identities, public claim wording, and a revocation/pause path. The scheduled worker cannot be used to discover or validate a new source.
