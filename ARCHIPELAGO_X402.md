# Archipelago x402 Listing — Ingest Signal

> **Status:** Active — October 2026
> **Companion to:** `INGEST_POINTS.md` Section 5.5, `SCOPE.md`
> **Owner:** David (RunTimeAdmin)
> **Nooscape operational update — 2026-10-08:** The service may be active independently, but it is not a Nooscape production ingestion source. Nooscape must not make an x402 payment, execute a service request, or treat first-party activity as independent verification without a separate approved integration.

---

## 1. What It Is

**Archipelago** is David's DEX, deployed on Arc (chain ID 5042). It accepts x402 payments for coin lookups — an agent can pay per request in USDC and get a price/market-data response with no account, no API key, no human in the loop.

David has applied for Archipelago's listing on an x402 marketplace (application in progress as of Oct 7, 2026).

## 2. Why This Matters for the Directory

- **Archipelago is a live Tier 0-style agent endpoint** — identity (deployed contract on Arc) + economic activity (x402 settlements) + liveness (responding to paid requests). This is exactly the corroboration pattern the trust tiers require.
- **It is also a first-party ingest point.** David controls the service, so he can emit structured settlement logs, endpoint health, and per-buyer attribution directly into the directory pipeline — no third-party indexer needed for this one source.
- **Marketplace listing is a distribution channel.** If Archipelago gets listed on x402-list.com, x402scan, x402.new, or Coinbase's Agentic.Market, that listing itself becomes a discoverable, machine-readable signal the directory can consume.

## 3. Marketplace Landscape (as of Oct 7, 2026)

| Marketplace | Listings | Notes | Archipelago fit |
|---|---|---|---|
| x402-list.com | 921 services (860 payment-ready, 12 delivery-verified) | Independent, measures uptime + observed settlements, CC BY 4.0 data, agent-first JSON | Strong — measures real settlement activity, not just registration |
| x402.new | 14,201 listed services | Auto-indexes from x402 discovery network; 3,833 providers | Strong if Archipelago exposes `/.well-known/x402` or OpenAPI discovery |
| x402scan (Merit-Systems) | Growing | OpenAPI-first discovery + `/.well-known/x402` fan-out; SIWX-authenticated registration | Strong — implement discovery endpoints for reliable pickup |
| x402scout.com | 2,500+ services, trust scores 0–100 | Free registration, auto-scan within 6h, MCP endpoint | Good — free, fast, scored |
| x402-trust.com | Scored + probed | Manual submit; flags submissions to avoid auto-delisting | Good — end-to-end verification including facilitator declaration |
| Agentic.Market (Coinbase) | CDP-catalog-only | Only indexes Coinbase CDP-catalog domains — PayAI-settled services get zero hits | Weak unless Archipelago settles via CDP |
| Circle Discovery API | `api.circle.com/v2/x402/discovery/resources` | Official Circle marketplace resource index | Worth checking for Arc coverage |

## 4. Action Items

- [ ] Confirm which marketplace the Archipelago application targets.
- [ ] Ensure Archipelago exposes `/.well-known/x402` (v2 manifest) and/or `/openapi.json` with per-route input schemas — this is what x402scan and x402.new auto-discover.
- [ ] Declare the facilitator in the 402 challenge or submission (x402-trust specifically asks; the 402 header never says).
- [ ] Once listed, add the marketplace as a P2 ingest: listing status + observed settlement volume + uptime metrics become trust signals for Archipelago itself.
- [ ] Feed Archipelago's own settlement logs into the directory as a first-party economic-activity source (higher trust than third-party observation).

## 5. Strategic Note

Being both a **listed x402 service** and the **operator of the directory that indexes x402 services** is a compounding position: Archipelago's real payment activity validates the directory's methodology, and the directory's Tier 0 bar gives Archipelago a credibility signal no other DEX listing provides. This is the same flywheel as Sigvara/Countersig/MCPShield — your stack feeds the directory, the directory amplifies your stack.
