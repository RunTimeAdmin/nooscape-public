# Archipelago x402 Ingest Source

> **Status:** First-party ingest source — October 2026
> **Companion to:** `INGEST_POINTS.md`, `ARCHIPELAGO_X402.md`, `ARC_MARKETPLACE_LISTING.md`
> **Purpose:** Document Archipelago (Arc, Circle chain 5042) as a dedicated ingest source for Nooscape — attributable x402 settlement data, token-lookup API, and a prospective distribution signal from approved Arc directories.
> **Operational update — 2026-10-08:** Not active in Nooscape production. This first-party candidate must remain explicitly attributed and requires a separately reviewed, machine-readable, metadata-only source boundary; no payment flow is authorized by this document.

---

## 1. What Archipelago Is

**Archipelago** is a DEX on Arc (chain ID 5042) built by David Cooper (RuntimeAdmin). It accepts **x402 payments** for coin lookups — real USDC settlements, tested with real money. Beyond swaps, it exposes token-intelligence endpoints: liquidity, rug checks, and other per-token data an agent or trading bot would need.

The strategic value: a single penny-priced call that returns everything an agent needs about a token, instead of stitching together five separate APIs. For a trading bot, that's the difference between one x402 payment and five.

---

## 2. Ingest Signals Archipelago Contributes

| Signal | What it tells us |
|---|---|
| x402 settlement events (USDC transfers to Archipelago) | Per-agent economic activity — which agents actually pay for data |
| Token-lookup query patterns | Which tokens agents are researching — demand signal |
| Rug-check / liquidity results | Corroboration for trust scoring — an agent that queries rug checks is a serious actor |
| Facilitator used per settlement | Which x402 rails are live on Arc |

---

## 3. Distribution Angle

Archipelago runs on **Arc**, Circle’s chain 5042. It is a first-party ingest point. A marketplace or directory listing becomes a separate distribution and corroboration signal only after Nooscape records the exact source URL, machine-readable contract, and attribution method.

The flywheel: Archipelago's real settlements validate Nooscape's trust methodology from the inside, while Nooscape's Tier 0 bar gives Archipelago a credibility signal no other DEX listing provides.

---

## 4. Open Items

- [ ] Expose `/.well-known/x402` manifest and OpenAPI spec at Archipelago's root for reliable auto-discovery by x402scan / x402.new
- [ ] Declare the facilitator in the 402 header so settlement attribution is unambiguous
- [ ] Log per-query metadata (token, endpoint, price) for the dedup graph
- [ ] Confirm whether Arc x402 settlements are covered by x402scan / x402stats yet — if not, that's a gap Nooscape fills first
- [ ] Decide pricing: flat penny per full token-intel bundle vs. per-endpoint pricing

---

## 5. Why This Matters for Nooscape

Archipelago is a live, economically active service endpoint. Its settlement data is indexable via standard EVM RPC reads once the declared payment address and receipt attribution rules are published. As a first-party source it represents one evidence class, not standalone Tier 0 corroboration.

The discoverability problem is real: an agent-facing service must publish stable, machine-readable metadata before a directory can index it responsibly. Arc service discovery will be added through explicit source contracts, not assumed from a similarly named ecosystem.
