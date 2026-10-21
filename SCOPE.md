# Nooscape scope: Chain Coverage (v1)

> **Status:** Decision — October 2026
> **Companion to:** `AGENT_TRUST_TIER_DESIGN.md`, `INGEST_POINTS.md`
> **Decision date:** October 7, 2026 (corrected: Arc, Circle’s chain 5042, is the P1 source; canonical domain added)
> **Operational update — 2026-10-08:** `nooscape.si` is live with bounded A2A, catalog, aggregate census, and manual-only Metaplex registry intake. This file remains a strategic chain-coverage research decision; it does not authorize any listed source. See `apps/nooscape-relay/docs/AI_HANDOFF_2026-10-08.md` for current production boundaries.

---

## 0. Canonical Domain

**https://nooscape.si** — the live public Nooscape Atlas. The canonical repository is `RunTimeAdmin/nooscape`. Nooscape is independent from Noos Network (`noosnet.ai`): Nooscape is an evidence-first discovery Atlas, while Noos describes an economic and settlement layer for agent skills.

---

## 1. The Decision

**v1 covers three chains:**

| Chain | Role | Why |
|---|---|---|
| **Solana** | Primary | ~76% of all x402 transactions; Metaplex + SATI + Solana Agent Registry; batch USDC settlement shipped Oct 2026; sub-second blocks. The agent economy is transacting here. |
| **Robinhood Chain** (Arbitrum Orbit L2, chain ID 4663) | Primary | Agent-native from day one: Virtuals ACP integration, ERC-8004 Identity Registry live, ~8,600 registered agent IDs, $77M agent volume in week one. Multiple independent x402 facilitators settling USDG (Hoodx402, Aeron, Solvador, Payless, rhx402). QuickNode's ERC-8004 explorer already indexes it. |
| **Arc** (Circle, 5042) | P1 | Archipelago is a first-party x402 service. Ingest only attributable service metadata and settlement observations; any external marketplace or directory must have a verified, machine-readable catalog before it is enabled. See `ARC_INGEST_RESEARCH.md`. |

**Base is explicitly deferred** to a later phase, despite being the third-largest ERC-8004 chain (~86K identities) and hosting Virtuals ACP. Rationale: v1 scope discipline — three chains is enough to prove the dedup + trust-tier pipeline. Base's ACP commerce agents and 8004 registrations are the natural Phase 2 expansion once the core graph works.

---

## 2. What This Means for the Build

### 2.1 Phase 1 ingest set (revised)

| Priority | Ingest | Chain |
|---|---|---|
| P0 | SATI SDK + Metaplex DAS API | Solana |
| P0 | Solana Agent Registry (solana.com) via RPC/DAS | Solana |
| P0 | x402-solana-pulse (self-hosted Substreams) | Solana |
| P0 | QuickNode ERC-8004 Explorer API (`?network=robinhood-mainnet`) | Robinhood Chain |
| P0 | Direct RPC reads of Identity Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | Robinhood Chain |
| P0 | USDG TransferWithAuthorization event indexing (x402 settlements) | Robinhood Chain |
| P1 | Arc service/discovery catalog (crawl/API) | Arc |
| P1 | Arc settlement and public identity research | Arc |
| P1 | x402scan + x402stats (macro only; neither covers Robinhood yet) | Cross-chain |
| P1 | Agenstry (liveness) | Cross-chain |
| P2 | agenteconomy.to data.json (census cross-check) | Cross-chain |
| P2 | ACP SDK `browseAgents` | Base — **deferred**; keep SDK familiarity, don't index |
| P3 | 8004scan, 8004.fyi, Glama/PulseMCP, ARD | Cross-chain / later |

### 2.2 What is NOT in v1

- No Base indexing (8004scan Base slice, ACP registry, Virtuals Base agents).
- No BNB Chain indexing (largest raw count, but dominated by bulk-mint spam — revisit only if a specific high-trust BNB agent surfaces via cross-chain dedup).
- No Ethereum mainnet 8004 indexing beyond what cross-chain links require.
- No broad Arc registry indexing until a public identity standard and source contract are confirmed. Arc first-party evidence remains P1 and is disclosed as affiliated.

### 2.3 Dedup implications

With only three chains, the dedup graph is smaller but the cross-chain link problem is sharper: Solana↔Robinhood links will rely almost entirely on the `registrations[]` CAIP-2 array and wallet overlap, since endpoint overlap across Solana (Ed25519) and EVM (secp256k1) is structurally different. Fuzzy name matching becomes relatively more important — and therefore the "never merge on name alone" rule matters more, not less. Arc adds first-party service and settlement records that can link to Solana/RH identities only through explicit endpoints or declared payment addresses.

---

## 3. Arc status (corrected Oct 7, 2026)

**Resolved:** Archipelago is an x402 service on Arc, Circle’s chain 5042. This supports Arc as a P1 first-party evidence source, not as an independently verified marketplace or broad agent-registry source.

**Still open:**
1. Whether Arc offers a public agent identity registry that is useful beyond service-level metadata.
2. Which Arc directory or marketplace catalogs are machine-readable, permitted for indexing, and source-stable.
3. Whether prospective Arc listings include network metadata, pricing, facilitator, and payment-address information.
4. Which Arc RPC and receipt semantics are required to attribute x402 settlement activity safely.

If an Arc directory catalog proves machine-readable and permitted, it becomes an additional P1 ingest. If an independent Arc identity and validation surface also becomes available, Arc can be reconsidered for a broader source role.

---

## 4. Revisit Triggers

Add Base (or any deferred chain) when any of these hold:

- The v1 dedup + scoring pipeline is stable and the Tier 0 set is producing useful results.
- A specific high-trust agent cluster is discovered that lives primarily on Base.
- ACP commerce volume or 8004 feedback density on Base exceeds Solana or Robinhood Chain on a per-agent basis.
- User or partner demand specifically names Base coverage.

---

## 5. Open Questions (updated)

1. **Arc directory crawlability** — blocking for an external Arc catalog ingest. Is there a permitted API or manifest?
2. **Robinhood x402 per-agent attribution** — five independent facilitators means five settlement streams to index; is USDG TransferWithAuthorization event scanning sufficient, or do facilitator-specific APIs add signal?
3. **Solana x402 attribution completeness** — x402-solana-pulse covers exact + upto schemes; are there other settlement patterns (batch, channels) it misses?
4. **Tier 0 minimum bar** — unchanged from design doc; does the three-chain scope change the corroboration math?
5. **Arc agent registry** — does a public, useful identity surface exist on-chain?

---

## 6. No Token at Launch (decision)

**Nooscape launches without a token.** Revenue is x402 micropayments and monthly API subscriptions in USDC — crypto-native without a token. The monetization model is defined in `AGENT_TRUST_TIER_DESIGN.md` §7 (free discovery, per-query x402 for agents, monthly API tier for heavy consumers); the cautionary comparable is preserved in `CRAWLNET_DATA_POINT.md` (circular fee economics, unproven product, anonymous team). A token would tie the project's viability to trading sentiment rather than to whether the dedup graph and trust tiers work.

Sybil resistance does not depend on a token: payment proof on paid queries is the anti-spam mechanism (`AGENT_TRUST_TIER_DESIGN.md` §7.1).

*Documented 2026-10-08 to close the `README.md` and `CRAWLNET_DATA_POINT.md` reference to this decision.*
