# Arc Ingest Research

> **Status:** Scope correction — October 2026
> **Companion to:** `SCOPE.md`, `INGEST_POINTS.md`, `ARC_MARKETPLACE_LISTING.md`
> **Owner:** David (RunTimeAdmin)
> **Operational update — 2026-10-08:** Research only. No Arc source is active in Nooscape production; any Arc source requires a separate permitted, machine-readable source contract and the standard evidence review before activation.

---

## 1. Scope correction

This document concerns **Arc**, Circle’s EVM-compatible Layer-1 blockchain, **chain ID 5042**. It is not the unrelated ARK network, ARK token ecosystem, or any project with a similar name.

The previous research notes incorrectly used “ARK” as the chain and marketplace label while describing Archipelago, which runs on Arc. All Nooscape source configuration, agent metadata, UI labels, and documentation must use **Arc** consistently.

Source: [Circle — Arc Mainnet launch](https://www.circle.com/pressroom/circle-launches-arc-mainnet-an-economic-operating-system-for-the-internet) and [Arc connection documentation](https://docs.arc.io/arc/references/connect-to-arc).

## 2. What Nooscape can ingest on Arc

Arc is relevant to Nooscape as a first-party and ecosystem source of x402 service evidence. The first implementation should use direct, attributable observations:

- **Archipelago service record:** public endpoint metadata, service capability declaration, discovery document when published, and documented x402 request behavior.
- **Arc settlement evidence:** on-chain records linked to a service’s declared payment address, captured with transaction hash, asset, amount, timestamp, facilitator context where available, and attribution confidence.
- **Endpoint liveness:** protocol-safe metadata and health observations. Nooscape must not execute discovered tools, prompts, swaps, or payment requests as part of indexing.
- **Publisher and identity evidence:** explicit domain control, public keys, DIDs, or other signed records when Archipelago or another Arc service publishes them.

Nooscape must not treat a general transfer as agent activity unless the recipient/payment endpoint is already linked to a public service identity. Settlement data measures activity, not quality, safety, or completed work.

## 3. Why Arc is useful but not a privileged source

Archipelago is an owned, first-party source. That makes its event data useful for exercising the full evidence pipeline, but it cannot count as independent corroboration for itself. Nooscape should disclose `source_claims.operatorRelationship = first_party` and permit first-party evidence to satisfy at most one evidence class in the trust policy.

Arc is therefore a **P1 source** after core identity and deduplication work on the primary external sources. It should not be used to inflate raw agent counts or to bypass the minimum independent-evidence requirement for Tier 0.

## 4. Implementation requirements

Before Arc ingestion is enabled, establish the exact public sources and technical contract:

1. The canonical Arc RPC endpoint or an owned, production-grade RPC provider.
2. The Archipelago payment address and service endpoint(s) to which settlements may be attributed.
3. The x402 facilitator and receipt or transaction semantics needed to distinguish a valid service settlement from an unrelated transfer.
4. A machine-readable discovery surface such as `/.well-known/x402`, an OpenAPI document, or a signed service manifest.
5. Source retention rules for raw transaction references and redacted request metadata.

The adapter cursor should persist `(chainId, blockNumber, transactionIndex, logIndex)` and reprocess a small confirmation window to handle reorgs. It must retain raw event locations and normalized evidence separately.

## 5. Open items

- [ ] Confirm the production Arc RPC and event indexes to use in the worker.
- [ ] Publish Archipelago’s discovery manifest and document its facilitator/payment attribution.
- [ ] Define the public payment address mapping used by the Arc adapter.
- [ ] Decide whether an Arc-specific identity registry is available and useful after direct service metadata is live.
- [ ] Add a test fixture with an attributed settlement, an unattributed transfer, and a stale endpoint observation.
