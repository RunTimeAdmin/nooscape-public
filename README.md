# Nooscape

An evidence-first public Atlas for discovering agents through retained observations, visible source boundaries, and verifiable provenance.

## About this repository

This is the public home of Nooscape's source code, started from a snapshot taken on 21 October 2026. Earlier history lives in a private archive, so the pull request and commit numbers that the docs and code comments mention (for example "PR 174") refer to that archive, and a few records are withheld from this tree and replaced with a short note. The code is MIT licensed (see `LICENSE`). The Nooscape name and logo are not part of that license. Issues and pull requests are welcome: see `CONTRIBUTING.md`.

## Canonical domain

**https://nooscape.si** — the live public Nooscape Atlas. The canonical source repository is [`RunTimeAdmin/nooscape`](https://github.com/RunTimeAdmin/nooscape).

> **Naming boundary:** Nooscape is independent from [Noos Network](https://noosnet.ai/). Nooscape is an evidence-first discovery Atlas; Noos describes an economic and settlement layer for agent skills.

## Current production status (2026-10-17)

Nooscape is operating as a bounded, evidence-first public discovery Atlas. It has **76 source-scoped public records** (48 catalog, 18 Robinhood Chain ERC-8004 registration observations, 7 Solana registry, and 3 A2A), each with retained evidence and a persisted signed envelope; 75 are **Tier 2 / unverified** and 1 is a self-owned Tier 3 domain-control pilot, and no public publisher-key verification has been granted. Beneath the reviewed layer, the acknowledged directory layer holds **249,323 entries** from catalogs and chains, and the chain ledgers (registrations with registrants, mint and transfer activity, ratings, and USDG x402 settlements) are recorded facts, never scored, weighted, or blended. BNB Chain registrations are acknowledged and not reviewed, and are never promoted into the reviewed census; a dated census of that registry is published at `/field/bnb-registry-2026-10-16`. Nooscape-Checker (`https://nooscape.si/checker`) asks the endpoints that reviewed agents declare, at most once a day, and the agent page shows each check with its date, never as a verdict. Security posture: HSTS with `includeSubDomains`, honest SPA 404s, fail-closed tRPC reads, per-client rate limits, a published `security.txt`, and signed evidence whose key can be rotated and revoked. The current operating documentation and AI continuation brief are in [`apps/nooscape-relay/docs/`](apps/nooscape-relay/docs/README.md), beginning with [`AI_HANDOFF_2026-10-17.md`](apps/nooscape-relay/docs/AI_HANDOFF_2026-10-17.md).

## Docs

| File | What it covers |
|---|---|
| `apps/nooscape-relay/docs/README.md` | The documentation index for the application: handoffs, source passes, decision records, incidents, and the consulting review |
| `packages/nooscape-mcp/` and `apps/nooscape-relay/docs/mcp-server-2026-10-19.md` | The MCP server for Nooscape's public API: the package (its public home is `RunTimeAdmin/nooscape-mcp`) and the record of what it does, what was verified and where publishing stands |
| `SECURITY.md` | How to report a vulnerability, what is in scope, and what to leave out |
| `AGENT_TRUST_TIER_DESIGN.md` | Core thesis, dedup pipeline, trust tiers (0–3), architecture, phased build plan, hybrid monetization |
| `INGEST_POINTS.md` | Named ingest sources: URLs, APIs, rate limits, signals contributed, v1 priority |
| `SCOPE.md` | v1 chain coverage decision: Solana + Robinhood Chain + Arc; Base deferred; no-token-at-launch decision |
| `ARC_INGEST_RESEARCH.md` | Arc-specific research: first-party evidence, source requirements, and priority criteria |
| `ARCHIPELAGO_X402.md` | Archipelago DEX x402 marketplace application — first-party ingest + distribution signal |
| `ARCHIPELAGO_INGEST.md` | Archipelago as dedicated ingest source: x402 settlement data, token-intel API, rug checks, distribution flywheel |
| `ARC_MARKETPLACE_LISTING.md` | Arc marketplace/discovery-source requirements for Archipelago x402 evidence |
| `CRAWLNET_DATA_POINT.md` | Crawlnet (CRAWL) on Solana — tokenized crawler/LLM project as cautionary data point for the no-token decision |

## v1 scope (decided Oct 7, 2026)

> This is a strategic research scope, not an activated-source list. Production activation still requires its own source approval, bounded adapter, retained-evidence review, and explicit projection decision.

- **Solana** — primary: ~76% of x402 volume, Metaplex + SATI + Solana Agent Registry
- **Robinhood Chain** (4663) — primary: agent-native L2, ERC-8004 registry live, 5 x402 facilitators, QuickNode indexing
- **Arc** (Circle, 5042) — P1: first-party Archipelago x402 evidence and prospective machine-readable marketplace/directory sources (see `ARC_INGEST_RESEARCH.md`)
- **Base** — deferred to Phase 2+ despite ACP/Virtuals presence

## First-party assets

- **Archipelago** (Arc, 5042) — DEX accepting x402 payments for coin lookups; a first-party source that will be ingested only through attributable, machine-readable records. See `ARCHIPELAGO_X402.md`, `ARCHIPELAGO_INGEST.md`, and `ARC_MARKETPLACE_LISTING.md`.
- **Sigvara / Countersig / MCPShield / agentclear** — differentiated trust-signal research candidates; no adapter is active without its own reviewed source boundary.

## Notable comparison points

- **Agent Arena** (agentarena.site) — 22K+ agents across 17 chains, two-sided reputation (sellers + buyers). Not a v1 ingest; studied for trust-tier design. See `INGEST_POINTS.md` Section 5.7.
- **Crawlnet / CRAWL** (Solana, Pump.fun) — tokenized crawler + LLM project; circular fee economics, anonymous team, unproven product. See `CRAWLNET_DATA_POINT.md`.

See `SCOPE.md` for rationale and revisit triggers.

## Application source

The current Nooscape Atlas implementation lives in [`apps/nooscape-relay/`](apps/nooscape-relay/). It contains the interactive Deep Space map, publisher-key lifecycle states, signed evidence export and verification, comparison tooling, and the accompanying live-ingestion architecture documents. Runtime dependencies, build output, and local logs are intentionally excluded from this repository.

## Contact

Disputes, corrections and privacy questions go to `trust@nooscape.si`, with a reply promised within one business day. A security problem goes to `security@nooscape.si` (see `SECURITY.md`). The site's own pages for these are `/disputes`, `/privacy`, `/terms` and `/contact`.

## License

The code in this repository is released under the [MIT License](LICENSE).
