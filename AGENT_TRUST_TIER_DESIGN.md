# Nooscape: Trust-Tiered Design Document

> **Status:** Design draft — October 2026 (updated Oct 7: hybrid monetization model added)
> **Repo:** RunTimeAdmin/nooscape
> **Related:** Sigvara (reputation protocol), agentclear (closed loop over Countersig/Levy/Sigvara/CounterAudit)
> **Operational update — 2026-10-08:** This document is a future trust-graph design. Live Nooscape serves a single versioned scale — **evidence-tier-v1** (evidence levels, not scores): `tier_2` approved-source record, `tier_3` domain-control verified (90-day validity + recheck + card pin), `tier_4` publisher-key allowlisted, with `tier_0`/`tier_1` reserved. It does not yet implement this document's multi-signal Tier 0–3 scoring, payment evidence, or canonical cross-chain merge graph; where the proposed §4.3 tiers and the live scale differ, the live scale governs anything served publicly. See `apps/nooscape-relay/docs/evidence-tier-scale-v1-2026-10-08.md` and `apps/nooscape-relay/docs/AI_HANDOFF_2026-10-08.md` for current constraints.
>
> **Core thesis:** The raw registries are public and anyone can read them. The moat is not the data — it is the cross-referencing, deduplication, spam filtering, and trust scoring that turns six hundred thousand registrations into a curated, machine-readable directory of agents that are actually real.

---

## 1. Problem Statement

As of October 7, 2026, at least **678,162 AI agent identities** are registered on-chain across measured registries:

| Source | Count | Notes |
|---|---|---|---|
| ERC-8004 identity registries | 618,776 | 24 chains; BNB leads with ~360,707 |
| Virtuals Protocol (Base) | 59,386 | 44,061 registered for ACP commerce |
| Solana registries (Metaplex MPL Agent Identity + SATI) | ~3,182 | Upper bound from getProgramAccounts |

**The problem:** 600,000+ registrations is not a directory — it is a phone book full of spam. A portal that mirrors raw counts surfaces junk, and users (human or agent) cannot tell signal from noise. Registration is one cheap transaction; it proves nothing about whether an agent works, is alive, or is trustworthy.

**The product:** A directory where the default view shows only the highest-trust agents, with progressive disclosure — search and filters reach the rest, but the front page is curated by evidence, not by registration order.

---

## 2. Ingest Points (Data Sources)

Multiple independent ingest points, each with its own schema and freshness, cross-referenced against each other.

### 2.1 ERC-8004 Registries (EVM, 24 chains)

- **Identity Registry:** ERC-721 token per agent → `agentId`, owner, `agentURI` (registration file / agent card: name, description, services, endpoints, wallet, trust models).
- **Reputation Registry:** client-submitted feedback (score, tags, optional `feedbackURI`, content hash). Note: feedback is from addresses other than owner/operator.
- **Validation Registry:** independent validator checks (stake-secured re-execution, zkML proofs, TEE attestations) — verdict 0/1 with evidence hash.
- **Chains to index first:** BNB, Base, Ethereum, Abstract, Robinhood Chain, Arbitrum, 0G (largest by registration count).
- **Tooling:** `8004scan.io` (explorer, 30 chains, ~554K agents indexed), `agenteconomy.to` (measured on-chain dataset with per-source provenance), direct RPC reads of registry contracts.

### 2.2 Solana-Native Registries

- **Metaplex MPL Agent Identity** (~1,640 accounts).
- **SATI** (QuantuLabs) — ERC-8004-style port on Solana, ~1,542 accounts. Uses the same registration file JSON format as ERC-8004, with a `registrations` array linking cross-chain identities via CAIP-2 identifiers.
- **Solana Agent Registry** (solana.com/agent-registry) — native identity + reputation + validation, interoperable with ERC-8004. Registration ~0.009 SOL.
- **Read method:** `getProgramAccounts` on public RPC (upper bounds; dedup across programs required).

### 2.3 Virtuals Protocol (Base)

- 59,386 launched agents; 44,061 registered for **ACP** (Agent Commerce Protocol) — the subset that has opted into commerce. ACP registration is a stronger signal than a bare launch.

### 2.4 x402 Payment Activity (Solana-dominant)

- Coinbase's x402 protocol: agents pay for resources in USDC per-request. Solana carries ~76% of x402 transactions (23.2M in four weeks ending Sep 22, 2026; ~7x the next chain).
- Batch USDC settlement shipped Oct 2026 (PayAI Network + BlockRunAI).
- **Signal value:** an agent that actually settles USDC micropayments is demonstrably alive and economically active. Payment volume and frequency are high-weight trust inputs.
- **Sources:** x402.org dashboard, Artemis/Solana Compass analytics, PayAI data.

### 2.5 Secondary / Enrichment Sources

- **A2A agent cards** (`.well-known/agent-card.json`) — discoverable service endpoints.
- **MCP server manifests** — agents exposing tools via Model Context Protocol.
- **Existing directories for cross-check:** The Grid (thegrid.id), itinai.com A2A Hub, AgentBazaar, AI Agent Store, Alchemy dapp lists.
- **Your own prior work:** Sigvara reputation scores, Countersig network attestations, MCPShield risk assessments — these become first-class ingest points, not afterthoughts.

---

## 3. The Dedup Problem (Hardest Part)

The same agent can hold identities on Base, BNB, Solana, and elsewhere. Raw counts double- and triple-count. Dedup is the core engineering challenge.

### 3.1 Signals for Matching

1. **`registrations` array in the agent card** — the ERC-8004/SATI registration file format explicitly supports cross-chain linking via CAIP-2 (`eip155:{chainId}:{registry}:{agentId}`, `solana:{genesis}:{program}:{account}`). Sparsely populated today, but it is the canonical link when present.
2. **Wallet / payment address overlap** — same `agentWallet` or receiving address across chains.
3. **Endpoint overlap** — same MCP URL, A2A card URL, or x402 facilitator address.
4. **Name + description similarity** — fuzzy match (Levenshtein / embedding cosine) with conservative thresholds.
5. **Operator address clustering** — one EOA or multisig registering many agents is a Sybil cluster signal (also a spam flag).

### 3.2 Dedup Pipeline

```text
Raw ingest (per source)
   |
   v
Normalize to canonical agent record (name, endpoints, wallets, card hash)
   |
   v
Match candidates (registrations[] links > wallet overlap > endpoint overlap > fuzzy)
   |
   v
Cluster + merge (union-find / connected components)
   |
   v
Emit: canonical agent ID + member identity list + confidence score
```

- Start with exact links (`registrations[]`, shared wallets) — high confidence, cheap.
- Fuzzy matching only within the residual set, with human-review queue for borderline clusters.
- **Never merge on name alone.** False merges destroy trust faster than missed dedup.

---

## 4. Trust Scoring & Tiering

### 4.1 Design Principle

> Registration is table stakes. Trust is earned through **corroborated evidence across independent sources**.

No single signal is sufficient. An agent makes the cut when multiple independent ingest points agree it is real, alive, and performing.

### 4.2 Evidence Dimensions

| Dimension | What it measures | Sources |
|---|---|---|
| **Identity integrity** | Valid card, reachable endpoints, consistent metadata | 8004 identity registry, A2A card fetch, MCP manifest check |
| **Economic activity** | Real USDC settlement, fee volume | x402 data, ACP commerce registration |
| **Reputation** | Third-party feedback (not self-reported) | 8004 Reputation Registry, Sigvara scores |
| **Validation** | Independent verification of work | 8004 Validation Registry, Countersig attestations |
| **Liveness** | Endpoint responds, recent txns | Periodic health checks, RPC activity |
| **Age / persistence** | Registered and still active over time | Registration timestamp vs. last-seen |

### 4.3 Tier Definitions (proposed)

> **Superseded for anything live — 2026-10-08:** the implemented and served scale is **evidence-tier-v1** (see `apps/nooscape-relay/docs/evidence-tier-scale-v1-2026-10-08.md`), an ascending evidence-level scale (`tier_2` → `tier_4`) with no scores. The proposed 0–3 tiering below — including "Tier 3 = Flagged" — is a future-design sketch only and must not be presented to API consumers.

- **Tier 0 — Verified (front page):** Multiple independent corroborations. E.g., 8004 identity + reputation feedback from ≥3 distinct wallets + x402 payment activity + reachable MCP/A2A endpoint + no active flags. Small set. This is what the portal shows by default.
- **Tier 1 — Active:** Identity valid, endpoint live, at least one economic or reputation signal. Searchable, clearly labeled.
- **Tier 2 — Registered:** Identity exists, card parses, but no corroborating activity. Searchable only; excluded from default views and from any "featured" or API-default results.
- **Tier 3 — Flagged / Spam:** Sybil cluster, dead endpoint, contradictory metadata, or validation failure. Hidden from search by default; retained for audit.

### 4.4 Anti-Spam Rules (hard filters before scoring)

- Operator with >N agents in a short window → cluster review.
- Identical or near-identical cards across many IDs → spam cluster.
- Endpoint returns 404/timeout on health check → downgrade.
- Feedback from wallets that also own the agent → excluded (self-feedback is not evidence).
- Zero economic activity after 30 days → Tier 2 minimum.

---

## 5. Architecture Sketch

```text
+------------------+   +------------------+   +------------------+
| ERC-8004 indexers|   | Solana indexers  |   | x402 / ACP feeds |
| (per-chain RPC)  |   | (getProgramAccts)|   | (analytics APIs) |
+--------+---------+   +--------+---------+   +--------+
         |                      |                      |
         +-----------+----------+-----------+----------+
                     v
          +---------------------+     +----------------------+
          |  Normalization +    |---->|  Dedup / clustering  |
          |  canonical records  |     |  (union-find graph)  |
          +---------------------+     +----------------------+
                     |
                     v
          +---------------------+     +----------------------+
          |  Trust scoring      |---->|  Tier assignment      |
          |  (multi-signal)     |     |  (0/1/2/3)           |
          +---------------------+     +----------------------+
                     |
                     v
          +-------------------------------------------------+
          |  Serving layer                                    |
          |  - Web portal (default = Tier 0, progressive      |
          |    disclosure for Tiers 1-2)                     |
          |  - REST/GraphQL API (agent-readable)             |
          |  - MCP server (agents query directly)            |
          |  - x402-gated premium queries (pay per lookup)   |
          +-------------------------------------------------+
```

### 5.1 Serving Layer Notes

- **MCP server is not optional** — agents are the primary users of a directory like this. An agent should be able to ask "find me a Solana trading agent with Tier-0 trust and x402 support" and get a structured answer.
- **x402 gating** on heavy queries (bulk export, historical reputation) monetizes the machine-readable layer without frictioning the free tier.
- **API-first:** the portal is a view on the API, not the product.

---

## 6. Phased Build Plan

### Phase 1 — Index + Dedup (foundation)
- Index 8004 identity + reputation events on BNB, Base, Ethereum (largest counts, most signal).
- Index Solana Metaplex + SATI via RPC.
- Build normalization + union-find dedup with `registrations[]` and wallet matching.
- Output: canonical agent graph with member identities. No UI yet.

### Phase 2 — Scoring + Tiers
- Add x402 activity feed and ACP commerce flags.
- Implement evidence dimensions and tier assignment.
- Hard anti-spam filters.
- Internal dashboard: Tier 0/1/2/3 breakdown, spam cluster review queue.

### Phase 3 — Serving
- REST/GraphQL API + MCP server.
- Web portal with Tier-0 default view.
- x402-gated premium endpoints.
- Public methodology page (trust is only as good as its auditability).

### Phase 4 — Enrichment
- A2A/MCP endpoint health monitoring (continuous liveness).
- Integration with Sigvara scores and Countersig attestations as first-class signals.
- Validation Registry indexing (highest-assurance tier).
- Cross-directory reconciliation (The Grid, itinai, AgentBazaar) for coverage gaps.

---

## 7. Monetization (updated Oct 7, 2026 — hybrid model)

> **Reference models:**
> - **Agent Arena** (agentarena.site) — pure x402 micropayments. Search $0.001, registration $0.05, review $0.001. Profile lookups and buyer-reputation endpoints free. Two-sided reputation: sellers scored via 8004, buyers scored via verified payment history with tiered discounts (Verified 5%, Trusted 10%, Premium 20%). No subscription.
> - **Agent Index** (theagentindex.app) — subscription-based. Free to list; $15/mo Verified, $49/mo Featured, $99/mo Enterprise. Paid via USDC on Base.

### 7.1 The hybrid model (proposed)

Combine both: free discovery, per-query x402 for agents, monthly API tier for heavy consumers.

| Layer | Model | Price | Who pays |
|---|---|---|---|
| **Free tier** | Free | $0 | Humans browsing; agents doing profile lookups |
| **Per-query (x402)** | Micropayment | $0.001/search, $0.01–$0.10 bulk/historical | Agents and scripts making occasional queries |
| **Monthly API** | Subscription | TBD ($50–$500/mo) | High-volume agent consumers, protocols, dApps integrating the directory |

**Why hybrid:**

- **Free tier is the discovery hook.** Mirrors Agent Arena — profile lookups and buyer-reputation endpoints free drives adoption without friction.
- **Per-query x402 is the agent-native rail.** Agents pay per lookup with no account, no API key, no subscription commitment. Every paid query also proves the x402 infrastructure works — the directory monetizes the same rail it indexes.
- **Monthly API is the revenue floor.** Per-query micropayments alone cannot cover indexing costs (RPC, Substreams, storage). A monthly tier gives predictable revenue; subscribers get higher rate limits, bulk export, historical reputation, and priority support.
- **Sybil resistance is built in.** Only agents that actually paid can submit reviews — payment proof is the anti-spam mechanism (Agent Arena pattern).

### 7.2 Proposed pricing (draft)

| Action | Price (USDC) | Rationale |
|---|---|---|
| Agent profile lookup | Free | Discovery hook; mirrors Agent Arena |
| Search query | $0.001 | Matches Agent Arena; cheap enough for agents |
| Bulk export / historical reputation | $0.01–$0.10 | Heavy queries; price by data volume |
| Agent registration (optional) | $0.05 | Optional — registration is already free on-chain; charging here is a signal filter, not a revenue driver |
| Monthly API — Starter | $50/mo | ~50K queries included; for small agent consumers |
| Monthly API — Pro | $200/mo | ~500K queries included; analytics dashboard |
| Monthly API — Enterprise | $500+/mo | Unlimited; SLA, dedicated support, custom ingest feeds |

### 7.3 Revenue reality check

- **Agent Arena's actual revenue is unknown** — no public stats endpoint, no published totals. Their `/api/stats` returns 404.
- **Ecosystem context:** x402stats (Oct 2026) reports ~$715K organic volume across ~94 sellers in 30 days; median seller earned $0.01. Only 91 wallets cleared the "actually earning" bar (≥$100 revenue, ≥3 buyers). The top 10 wallets hold 76% of volume.
- **Bitquery (Aug 2026):** one payment processor charging 1% on Base earned ~$59K in a month — but that includes non-agent volume.
- **TRM Labs:** after filtering self-payments and anomalies, only 0.6–7.5% of x402 commerce by value appears to come from AI agents.
- **Bottom line:** at Agent Arena's pricing, even generous assumptions (thousands of daily agent queries) yield tens of dollars a day. Micropayment-per-query is a validation and anti-spam mechanism more than a business. The monthly API tier is where real revenue lives.

### 7.4 Open monetization questions

1. What monthly price points convert for agent consumers vs. human developers?
2. Should registration be free (discovery-first) or paid (signal filter)?
3. Does the buyer-reputation/discount model (Agent Arena's two-sided scoring) belong in v1, or is it Phase 4+?
4. What is the minimum viable revenue to sustain indexing infrastructure costs (RPC, Substreams, storage)?
5. Should monthly subscribers also get x402 credits, or are the two rails fully separate?

---

## 8. Open Questions

1. **Dedup confidence threshold:** at what match score do we auto-merge vs. queue for review?
2. **Tier 0 minimum bar:** how many independent corroborations, and must one be economic (x402/ACP)?
3. **Spam definition:** is a 10,000-agent Sybil cluster on BNB "spam" or "legitimate bulk deployment"? Policy call.
4. **Freshness SLA:** how stale can an agent's last-seen be before downgrade?
5. **Token / monetization:** directory as pure utility, or protocol with query fees feeding back into trust signals (à la Sigvara's oracle yield)? — *Partially addressed in Section 7; hybrid model adopted, price points still open.*

---

## 9. Why This Wins

- **The data is free; the judgment is not.** Every registry above is publicly readable. The value is in the graph that connects them and the filter that separates the real from the registered.
- **Machine-native from day one.** MCP + x402 means agents consume the directory directly — the actual growth vector of this ecosystem.
- **It compounds with your existing stack.** Sigvara scores, Countersig attestations, and MCPShield assessments slot in as ingest points, making the directory the discovery layer on top of infrastructure you already built.
- **Trust is the scarce resource.** As agent-to-agent commerce scales (x402 has settled ≈$41.9M across 12 chains with 190.9M cumulative transactions as of 2026-10-08 — `INGEST_POINTS.md` §1.4, agenteconomy.to), the bottleneck shifts from "can agents pay each other" to "can agents trust each other." A directory that answers the second question is infrastructure, not a feature.
