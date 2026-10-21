# Nooscape Ingest Points Catalog

> **Status:** Research draft — October 2026 (revised for v1 scope; Agent Arena added Oct 7; AgentRank probed and rejected Oct 8)
> **Companion to:** `AGENT_TRUST_TIER_DESIGN.md`, `SCOPE.md`
> **Purpose:** Concrete, named ingest points with URLs, access methods, rate limits, and what signal each contributes. The design doc describes the pipeline; this doc is the shopping list.
> **Scope note:** v1 covers **Solana**, **Robinhood Chain**, and **Arc** (Circle, 5042; P1 first-party evidence and approved public catalogs only — see `SCOPE.md`). Base and BNB are deferred.
> **Operational update — 2026-10-08:** This is a research shortlist, not a production allowlist. Current production sources are documented in `apps/nooscape-relay/docs/AI_HANDOFF_2026-10-08.md`. Each candidate here still requires independent source/terms/access review, bounded adapter approval, immutable evidence review, and a projection decision before activation.

---

## 1. ERC-8004 Registry Indexers (EVM)

### 1.1 8004scan (AltLayer) — primary EVM indexer

- **URL:** https://8004scan.io
- **API base:** `https://api.8004scan.io/api/v1`
- **Key endpoints:**
  - `GET /agents` — list/filter agents with pagination (chain, owner, score, feedback, stars, x402 flag, created date)
  - `GET /agents/{chainId}/{tokenId}` — single agent
  - `GET /agents/search/semantic?q=...` — hybrid vector + keyword search
  - `GET /agents?owner_address={addr}` — wallet clustering (Sybil detection)
  - `GET /feedbacks` — reputation events
  - `GET /stats/global`, `GET /chains`
- **Coverage:** ~19–30 chains, ~109K agents on BNB alone, ~554K indexed globally (per their own claims; cross-check against on-chain counts)
- **Auth:** API key tiers — anonymous 30 req/min (1,000/day), free tier 600 req/min (100K/day), paid tiers up to 10,000 req/min unlimited
- **Signal contributed:** identity, owner, metadata, feedback, stars, x402 support flag, registration timestamps
- **v1 status:** **Deferred.** Useful as a census cross-check (agenteconomy.to comparison) but not a primary ingest for Solana/Robinhood. Revisit for Base/BNB expansion.
- **Notes:** Also has a mobile app and CLI-friendly design. Semantic search is useful for dedup (name/description similarity) but treat as a hint, not ground truth.

### 1.2 QuickNode ERC-8004 Explorer

- **URL:** https://erc-8004.quicknode.com
- **API:** REST endpoints for agents, feedback, validations, reputation — payable per request in USDC over x402 (no API key, no signup). 1M free RPC requests via wallet.
- **Coverage:** 18 networks, 54,400 registrations in past 30 days, 93,090 feedback events, 79 validation requests (as of research date). **Robinhood Chain now indexed** (`?network=robinhood-mainnet`) — identity, reputation, feedback, validations in one place.
- **Signal contributed:** verifiable reputation with a **public, replayable scoring formula** — every score can be recomputed from raw on-chain events. This is the closest thing to an auditable third-party score.
- **v1 status:** **P0 for Robinhood Chain.** Primary EVM ingest.
- **Notes:** The public formula is strategically interesting: if your directory's methodology is also public and replayable, you inherit the same trust property. Consider adopting or extending their formula rather than inventing one.

### 1.3 8004.fyi Explorer

- **URL:** https://8004.fyi
- **API:** `/api/v2` (builder-ready JSON), `/mcp` (MCP server), OpenAPI + llms.txt aligned to the same record
- **Coverage:** Ethereum + Base, 28,514 indexed agents, 1,470 with reputation, 2,787 feedback entries. Live sync.
- **Signal contributed:** MCP-native access (your directory can consume it as an agent would), provenance checkpoints, high-signal agent highlighting
- **v1 status:** Deferred (Base-only coverage). The MCP endpoint pattern is worth mirroring for your own serving layer.
- **Notes:** The MCP endpoint means this source is itself agent-readable — a good pattern to mirror for your own serving layer.

### 1.4 agenteconomy.to — measured on-chain dataset

- **URL:** https://agenteconomy.to (ERC-8004 page: /erc-8004, x402 page: /x402, Solana page: /stats)
- **Data:** `data.json` refreshed hourly, with per-source provenance and freshness stamps. Built from decoded on-chain events (Registered events), testnets excluded.
- **Coverage:** 618,776 ERC-8004 agents across 24 chains (BNB 360,707); 190.9M cumulative x402 txs, $41.9M settled volume across 12 chains; 3,182 Solana agent accounts (Metaplex 1,640 + SATI 1,542); Robinhood Chain 8,589 registered agent IDs (daily census).
- **Signal contributed:** independently recomputable census numbers with methodology transparency — useful as a cross-check on your own indexer counts, and as the canonical "how many agents exist" reference
- **v1 status:** **P2** — census cross-check and hourly freshness reference, not a primary ingest.
- **Notes:** Their own caveat is worth internalizing: registered-agent supply is identity infrastructure adoption, not revenue or completed work. This is exactly the gap your trust tiers fill. Robinhood Chain showed a +928 registration burst on Oct 6 vs. a median of 32 — bulk-mint pattern worth watching for spam filtering.

### 1.5 Arc ERC-8004 Explorer (community)

- **URL:** https://arcagents.app
- **API:** paid resolver at $0.01/call over x402 v2 via Circle Gateway (read-only)
- **Coverage:** Arc Mainnet (5042) + Arc Testnet. Identity Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, Reputation Registry `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, Validation Registry `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` — all three are deployed on Arc (registers are CREATE2-deterministic; Validation bytecode verified via `eth_getCode`, 2026-10-08).
- **Signal contributed:** Arc-specific agent data; demonstrates the x402-gated API pattern
- **v1 status:** Not a chain ingest. Arc remains relevant only as the home of your Sigvara/Countersig/MCPShield stack — those signals are first-class regardless of chain.
- **Notes:** Small chain but relevant given your Arc deployments (Sigvara, Levy, Archipelago all target Arc 5042).

### 1.6 Direct RPC indexing (ground truth)

- Read `Registered` events directly from Identity Registry contracts on each chain via RPC. This is the only method that does not depend on any third party's indexing completeness or uptime.
- **v1 priority chains:** Robinhood Chain (4663) first — Identity Registry at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. Solana side uses program-account reads instead of EVM events.
- **Tooling:** viem/ethers event subscription or The Graph subgraphs where available (Archipelago already uses The Graph patterns).
- **v1 status:** **P0 for Robinhood Chain.**

### 1.7 Robinhood Chain x402 facilitators (USDG settlement streams)

Multiple independent facilitators are live on Robinhood Chain (4663), settling USDG via EIP-3009 `transferWithAuthorization`:

| Facilitator | URL | Notes |
|---|---|---|
| Hoodx402 | https://facilitator.h402.finance (testnet 46630; mainnet equivalent) | Public facilitator, durable on-chain receipts |
| Aeron | https://x402-arc.aeron.sh/ | Verify + settle + status endpoints; relayer pays gas |
| Solvador | Facilitator service | Supports exact, upto, batch-settlement schemes |
| Payless | paylessnetwork | HTTP 402, USDG, no protocol fee; `/.well-known/x402` discovery |
| rhx402 | https://rhx402.xyz | First mainnet settlement Sep 25, 2026; MCP toolset for agents |

- **Signal contributed:** rail-level USDG settlement measurement on Robinhood Chain. Per-agent attribution is **not** resolvable from events alone (see the 2026-10-10 probe below) — facilitator APIs are **required** for payer/recipient attribution, not merely enrichment.
- **v1 status:** **Shipped (2026-10-10, migration 0014).** The rail is measured directly from the canonical contract through the manual-only `usdg_settlement` source (bounded windows, one receipt per settlement, `us:` backward walk cursor); the public money panel shows rail facts only and keeps attribution an explicit known-unknown per the census-integrity gate. The dense head era is fully tiled (2026-10-11: 7,417 settlements across blocks 83,273,422–85,319,293 in 63 paced runs; cursor `us:83272548` holds the position for the sparser pre-dense era).
- **Notes:** No Circle Gateway equivalent on 4663 (gas is ETH, settlement asset is USDG), so each facilitator is a separate relayer. Batch-settlement support (Salvador) matters for high-volume micropayments.

**Probe record (2026-10-10, bounded RPC + receipt decode; the basis for the shipped adapter):**

- **Canonical contract:** Global Dollar `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (Blockscout-verified, ~$3.1B, 10,518 holders, **6 decimals**). Unverified copycats exist; only this address is approved.
- **Event shape:** USDG settles EIP-3009 with **no dedicated TransferWithAuthorization event** (USDC-v2 style). Each settlement = `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` topic0 `0x98de5035…` (openchain-verified) + a paired ERC-20 `Transfer` in the same tx. Payer = `Transfer.from` (≡ authorizer, verified on every sampled receipt), payee = `Transfer.to`, value = `Transfer.data`, relayer = tx `from`. Zero batching measured: 7,315 authorizations = 7,315 distinct txs in the newest 2M-block window.
- **Density:** newest 2M blocks (83,296,767–85,296,111) exactly 7,315 auths; a fresh 300k window at head 85,302,597 held 1,626 auths across 368 payers (one wallet paid 649). Mid-chain 2M windows run ~183–247 auths. Rapid large getLogs bursts draw HTTP 429/403; receipts pace cleanly at 700 ms.
- **Value distribution:** bimodal — $0.001 per-request micropayments alongside pre-x402 EIP-3009 transfers up to $80,000. EIP-3009 is older than x402, so rail totals must never be presented as "all agent payments"; the shipped panel leads with the median and the micropayment share instead of a grand total.
- **Attribution (the census-integrity gate):** a bounded scan of the newest window found **zero overlap** between settlement participants (368 payers; sampled payees 0x266b…, 0xece6…, 0xccc8…, 0xc204…; relayers 0x833e…, 0xda06…, 0xf70d…, 0xb381…) and the top-12 registering wallets (0x62d3… 5,593 agents; …). Event-level scanning therefore cannot resolve payer/recipient to registry identities with unambiguous roles; per the gate, **no attribution number ships until facilitator APIs make it unambiguous**.

---

## 2. Solana-Native Registries

### 2.1 Metaplex MPL Agent Identity (~1,640 accounts)

- **Program:** Agent Identity `1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p`; Agent Tools `TLREGni9xQ8oPqJSvNjvB7FGK8S`
- **Read methods:** (a) `getProgramAccounts` on public RPC for upper-bound census; (b) Metaplex Agent Registry SDK (`@metaplex-foundation/mpl-agent-registry`) for structured reads; (c) DAS API (`searchAssets` with `is_agent` filter) on a DAS-enabled RPC — indexed fields include registration status, asset signer PDA, agent token mint.
- **Registration file format:** ERC-8004-compatible JSON with a `registrations` array using CAIP-2 identifiers (`solana:101:metaplex`) — this is the cross-chain link field for dedup.
- **Docs:** https://www.metaplex.com/docs/agents (onboarding, register, read-agent-data)
- **v1 status:** **P0.**

### 2.2 SATI — ERC-8004 port on Solana (~1,542 accounts)

- **SDK:** `@cascade-fyi/sati-sdk` (native) and `@cascade-fyi/sati-agent0-sdk` (agent0-compatible types)
- **Capabilities:** registration (IPFS-hosted metadata, no API keys), feedback (value/tag fields matching ERC-8004), reputation queries, marketplace search (`searchAgents` with filters: hasMCP, mcpTools, active, includeFeedbackStats, sort by averageValue)
- **Agent ID format:** `solana:{genesis}:{mint}` — CAIP-2 compatible, links to EVM identities via the `registrations` array
- **Docs:** https://docs.sati.cascade.fyi
- **v1 status:** **P0.** The SDK's `searchAgents` with feedback stats is a ready-made ranked feed.
- **Notes:** SATI's `setX402Support(true)` flag and MCP endpoint fields are directly usable as trust signals.

### 2.3 Solana Agent Registry (solana.com)

- Native identity + reputation + validation, interoperable with ERC-8004. Registration ~0.009 SOL.
- Read via standard Solana RPC / DAS.
- **v1 status:** **P0.**

---

## 3. Virtuals Protocol / ACP (Base) — DEFERRED

> **v1 decision:** Base/ACP indexing is deferred. See `SCOPE.md`. This section retained for Phase 2 reference.

### 3.1 ACP Registry + SDK

- **Platform:** https://app.virtuals.io/acp/agents
- **SDK:** `@virtuals-protocol/acp-node-v2` (TypeScript) and `virtuals_acp` (Python)
- **Discovery method:** `AcpAgent.browseAgents(keyword, params)` — multi-stage pipeline: cluster filter → hybrid keyword+embedding search → reranker on metrics (successful job count, buyer diversity) → sort options. Also `getAgentByWalletAddress`.
- **Online status filter:** `ACPOnlineStatus` enum — directly usable as a liveness signal
- **Graduation status:** `ACPGraduationStatus` — filters by lifecycle stage
- **Counts:** 59,386 launched agents; 44,061 registered for ACP commerce (commerce opt-in = stronger signal than bare launch)
- **Multi-chain:** Base Mainnet/Sepolia, BSC, optional Solana. **Also integrated on Robinhood Chain from day one** — Virtuals agent tokenization (launch, fund, own, operate) is live there.
- **Notes:** ACP v2 adds resource offerings (public read-only data endpoints) and `acp serve` which deploys handlers as x402/MPP/ACP-native endpoints. An ACP agent's resource offerings are a natural enrichment source. On Robinhood Chain, Virtuals ACP agents are indexable via the same 8004 + USDG event pipeline as native RH agents — no separate ACP ingest needed for v1.

### 3.2 Virtuals MCP server

- **URL:** `https://mcp.acp.virtuals.io/`
- **Operations:** agent management (create/list/prepare-launch), agent cards, agent email
- **Notes:** Another agent-readable surface — your directory's MCP server can sit alongside it in an agent's toolset.

---

## 4. x402 Payment Activity

### 4.1 x402stats.io

- **URL:** https://x402stats.io/data
- **Free (CC BY 4.0):** `/api/stats/csv` (daily series since 2025-05-09: volume, sellers, buyers, txs), `/api/stats` (JSON), `/api/facilitators` (per-facilitator series + 30d market share), `/llms-full.txt` (full dataset as plain text for LLMs/agents). Cached ~1h.
- **x402-payable (agents, $0.005/call, USDC on Base):** `/api/x402/stats`, `/api/x402/facilitators` — standard x402 v2 challenge, no API key
- **Signal contributed:** ecosystem-wide volume/velocity trends, facilitator market share (Coinbase, PayAI, etc.)
- **Limitation:** aggregate stats, not per-agent attribution. Use for macro context and freshness, not per-agent scoring. **Does not cover Robinhood Chain.**
- **v1 status:** **P1** (macro only).

### 4.2 x402scan (achivx)

- **URL:** https://x402scan.achivx.com
- **API:** `GET /v1/stats/ecosystem` (agent-card-discoverable: `/.well-known/agent-card.json`), settlement feeds, facilitator lists, service leaderboards ranked by settled USDC volume, transaction verification by hash
- **Coverage:** Base + Solana, mainnet only, USDC == USD. Distinguishes "x402" (settled through known facilitator or paid to catalogued endpoint — defensible) from "gross" (every observed USDC settlement — upper bound).
- **Signal contributed:** per-service settled volume leaderboards, verified settlement index, service discovery catalog — the closest thing to per-agent economic activity data
- **v1 status:** **P1** for Solana service leaderboards. **Does not cover Robinhood Chain** — gap your RH facilitator indexing fills.
- **Notes:** Has a live agent console demonstrating an AI agent working x402scan over MCP/A2A/REST. The "verified vs gross" distinction is a methodology lesson: your directory should similarly separate defensible signals from upper bounds.

### 4.3 x402-solana-pulse (Substreams, open source)

- **Repo:** https://github.com/PaulieB14/x402-solana-pulse
- **What it does:** StreamingFast Substreams that detects every x402 settlement on Solana — both `exact` (top-level SPL Token TransferChecked) and `upto` (payment-channels CPI) schemes. Extracts payer, recipient, mint, amount, facilitator, fee, memo per settlement.
- **Output:** SQL tables — `settlements`, `payers` (aggregated spend per pubkey), `recipients` (revenue per resource server), `facilitators`
- **Signal contributed:** **per-agent economic activity on Solana** — this is the highest-value ingest for Solana-side trust scoring. Recipient aggregation maps directly to agent wallets.
- **v1 status:** **P0** (self-hosted). Highest-value Solana ingest.
- **Notes:** Open source; you can run your own instance and sink to your own Postgres. This turns an aggregate feed into a per-agent signal.

### 4.4 Dune (underlying source for agenteconomy.to x402 data)

- Dashboards: `@thechriscen/x402 Payment Analytics`, `@hashed_official/x402 Analytics` — public, queryable if you have Dune access. agenteconomy.to already aggregates these hourly.
- **v1 status:** Rely on agenteconomy.to's hourly aggregation unless you have Dune access.

---

## 5. Secondary / Enrichment Sources

### 5.1 Agenstry (independent A2A + MCP evidence)

- **URL:** https://agenstry.com
- **What it measures:** 7,467 A2A agents (1,066 responding live), 205,520 MCP servers (13,793 responding live), 14,833 skills, 4,669 paid APIs catalogued. Observed inflow $902K to 1,714 wallets over 30d. Open methodology, no paid placement.
- **Signal contributed:** **independent liveness evidence** — an agent that responds to A2A/MCP introspection is alive, which no on-chain registry proves. This is the liveness dimension of the trust model.
- **v1 status:** **P1.**
- **Notes:** The "responding live" vs "indexed" split is exactly the Tier 0 vs Tier 2 distinction. Agenstry's methodology (independent measurement, open) is a model for your own health-check layer.

### 5.2 Glama.ai + PulseMCP (MCP directories)

- Glama: 14,274+ MCP servers/agents, hosting + discovery API + Discord community
- PulseMCP: MCP directory run by MCP Steering Committee members
- **Signal contributed:** MCP server manifests, tool lists, hosting status — cross-check against SATI's `hasMCP` flags and A2A card endpoints
- **v1 status:** **P3.**
- **Notes:** From the Q1 2026 discovery landscape report: 104K+ agents across 17+ registries, 11+ competing discovery protocols, zero interoperability. Your dedup layer is the interoperability.

### 5.3 Agentic Resource Discovery (ARD) — emerging standard

- Open spec (Microsoft + GoDaddy, Google, Hugging Face, Cisco, Databricks, GitHub, Nvidia, Salesforce, ServiceNow, Snowflake): publishers host `ai-catalog.json` at a well-known path; registries crawl and index; clients search by natural-language intent via `POST /search`.
- Hugging Face Hub publishes at `https://huggingface.co/.well-known/ai-catalog.json`; HF discover space at `https://huggingface-hf-discover.hf.space/search`
- GitHub launching "agent finder" on ARD for Copilot runtime discovery
- **Signal contributed:** future-proofing — ARD is the direction agent discovery is heading. Indexing ARD catalogs gives coverage of agents that never touch a blockchain.
- **v1 status:** **P3 / monitor only.**
- **Notes:** Worth monitoring for Phase 4; not a Phase 1 dependency.

### 5.4 Existing directories (cross-check, not primary)

- The Grid (thegrid.id), itinai.com A2A Hub, AgentBazaar, AI Agent Store, Alchemy dapp lists
- **Signal contributed:** coverage gaps — agents listed here but missing from 8004scan/agenteconomy are either on chains you haven't indexed or registered outside ERC-8004
- **v1 status:** **P3.**

### 5.5 Your own stack (first-class, not afterthought)

- **Sigvara:** reputation scores (6-factor, on Arc) — direct trust input
- **Countersig:** W3C DIDs + Ed25519 PKI + attestations on Robinhood Chain — identity + validation input
- **MCPShield:** MCP server risk assessments — safety/behavioral input
- **agentclear:** closed loop over Countersig/Levy/Sigvara/CounterAudit — operational context
- These are differentiated signals no public indexer has. They are the moat. **Chain-independent — always on.**

### 5.6 Arc (P1)

- **v1 status:** P1. Arc is Circle’s chain 5042. Archipelago supplies first-party x402 service and settlement evidence; any external catalog must be machine-readable, permitted for indexing, and independently attributable before it is enabled. See `ARC_INGEST_RESEARCH.md`.
- If an external Arc catalog satisfies the source review checklist, it becomes an additional P1 ingest. A public, independently useful identity and validation registry would be required before considering broader Arc indexing.

### 5.7 Agent Arena (comparison point — not a v1 ingest)

- **URL:** https://agentarena.site
- **What it is:** On-chain ERC-8004 agent registry indexing 22,000+ agents across 17 chains (16 EVM + Solana). Two-sided reputation: sellers AND buyers scored. Buyers earn tiered discounts for verified payment history (Verified 5% off, Trusted 10%, Premium 20%).
- **API:** `GET /api/agent/{chainId}/{agentId}` for profiles; `/.well-known/agent-buyer-incentives.json` for buyer-tier metadata; `/.well-known/skill.md` for agent-readable skill docs.
- **Signal contributed:** cross-chain 8004 coverage with buyer-side reputation — a useful comparison for how two-sided scoring works, and a dedup cross-check on the EVM slice.
- **v1 status:** **Not a v1 ingest** (Base-heavy coverage, overlaps with deferred Base scope). Added as a **comparison point** for the trust-tier design: Agent Arena's buyer-discount model is an interesting incentive pattern worth studying, but it doesn't solve the cross-registry dedup or spam-filtering problem your directory targets.
- **Notes:** The buyer-reputation angle is worth watching — if your directory ever surfaces agents to agent-buyers (not just human browsers), buyer scoring becomes a real feature. Also note Agent Arena's chain list includes Solana, which is a rare cross-EVM/Solana 8004 indexer.

### 5.8 AgentRank (probed — retired; do not ingest)

- **What it was:** Settlement-grounded reputation for x402/A2A counterparties — a 0–1000 score recomputed from real on-chain USDC settlement weighted by payer standing (not self-reported feedback). Shipped Ed25519-signed verification receipts, `verify-before-pay` (payer side) and `require-rank` (provider side) npm guards, and a platform-verifier `POST /verify/batch` mode (≤100 subjects; permissive/cautious/strict policies). Publisher: Crest Deployment Systems LLC (agentrank.info); included a preregistered "counterfeit verifiability" study on agent payment decisions.
- **Probed 2026-10-08:** `agentrank.info` and `api.agentrank.info` connection-timeout; `github.com/andysalvo/agentrank` **archived** — *"Retired. … The hosted service no longer runs."* The npm packages remain published but default to the dead API base. The A2A Registry listing still shows "passed" health checks while both hosts are unreachable — a stale listing on a dead service.
- **v1 status:** **Rejected — do not ingest.** No callable surface; do not re-chase unless un-retired. Evidence: §7 of `apps/nooscape-relay/docs/source-access-validation-2026-10-08.md`.
- **Notes:** Patterns worth studying for our own trust surface — signed per-record receipts, batch allow/caution/deny policies for directory-scale screening, and "no score without a receipt." Cautionary lesson: its receipt-verification key was served only from the live host, so third-party verification died with the service. Publisher pattern: sibling hosted services (`supership-scan`, `agentic-platform`) are archived with the same retirement wording — treat this publisher's hosted services as retired by default.

---

## 6. Priority Ordering for Build (v1)

| Priority | Ingest | Why |
|---|---|---|
| P0 | SATI SDK + Metaplex DAS + Solana Agent Registry | Solana side, CAIP-2 links for dedup |
| P0 | x402-solana-pulse (self-hosted) | Per-agent economic activity — highest-weight Solana trust signal |
| P0 | QuickNode ERC-8004 Explorer (robinhood-mainnet) | Auditable public scoring formula + RH identity/reputation |
| P0 | Direct RPC: RH Identity Registry + USDG TransferWithAuthorization events | Ground truth; covers all five RH x402 facilitators |
| P1 | x402scan + x402stats | Macro + Solana per-service settlement verification |
| P1 | Agenstry | Independent liveness evidence |
| P1 | Arc service/directory catalog (crawl/API) | Enable only after machine-readability, provenance, and indexing terms are verified |
| P1 | Arc settlement and public identity research | First-party service evidence; broad identity coverage TBD |
| P2 | agenteconomy.to data.json | Census cross-check + hourly freshness |
| P3 | Glama/PulseMCP, 8004scan, 8004.fyi, ARD, The Grid | Coverage expansion / later phases |
| Deferred | ACP SDK, 8004scan Base slice | Base expansion trigger (see SCOPE.md Section 4) |
| Comparison | Agent Arena | Two-sided reputation model; not a v1 ingest |
| Rejected | AgentRank (probed 2026-10-08) | Retired — hosts unreachable, repo archived, registry listing stale. Do not ingest. |
| Always | Sigvara / Countersig / MCPShield | Differentiated moat signals |

---

## 7. Open Items

1. **Arc catalog URL + API:** identify a permitted machine-readable Arc directory or marketplace contract before adding it as a named P1 source with rate limits and signal details. *Blocking for external Arc catalog ingestion.*
2. **Robinhood x402 attribution:** is USDG TransferWithAuthorization event scanning across five facilitators sufficient, or do facilitator APIs add per-agent signal?
3. **Solana x402 attribution completeness:** does x402-solana-pulse miss batch or channel settlement patterns?
4. **8004scan vs direct RPC:** does 8004scan lag or miss Registered events on Robinhood Chain? Validate against agenteconomy.to's on-chain census.
5. **ACP API stability:** `browseAgents` pipeline is SDK-internal; confirm rate limits and public REST equivalent (Phase 2, Base).
6. **Agenstry API access:** currently appears web-only with 1,974 API calls/30d observed. Confirm programmatic access terms.
7. **Dune access:** do you have Dune access, or rely entirely on agenteconomy.to's aggregation?
8. **Agent Arena API completeness:** does `/api/agent/{chainId}/{agentId}` support bulk listing or only single-agent lookup? Relevant if Agent Arena ever becomes a v1 cross-check.
