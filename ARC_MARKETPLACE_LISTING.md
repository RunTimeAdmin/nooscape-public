# Arc Marketplace Listing — Archipelago x402

> **Status:** Scope correction — October 2026
> **Companion to:** `ARCHIPELAGO_X402.md`, `ARC_INGEST_RESEARCH.md`
> **Owner:** David (RunTimeAdmin)
> **Operational update — 2026-10-08:** Research only. No Arc marketplace/catalog is approved or active in Nooscape production; a permitted machine-readable catalog and independent source review remain required.

---

## 1. Scope correction

Archipelago is a DEX and token-intelligence service on **Arc**, Circle’s blockchain (chain ID 5042). Earlier documentation called the related marketplace and proposed ingest source “ARK.” That terminology was incorrect and has been removed.

Any confirmed listing, discovery page, or x402 catalog for Archipelago must be identified by its exact provider URL and contract before it becomes a Nooscape source. A named listing without a machine-readable, permitted catalog is not an automated ingest commitment.

## 2. What a valid Arc marketplace source must provide

A source may be admitted as an Arc marketplace adapter only after Nooscape has documented:

- the catalog URL, operator, terms of use, and polling limit;
- stable service identifiers and endpoint URLs;
- network and chain metadata that explicitly identifies Arc (5042) where relevant;
- x402 pricing, facilitator, and declared payment-address fields where available;
- an update cursor, ETag, or equivalent freshness signal;
- whether listing, uptime, delivery, or payment signals are observed independently or are publisher-declared.

Nooscape will store the raw catalog observation and its digest before normalizing a listing. A listing is a discovery and liveness candidate, not automatic proof of service quality or agent identity.

## 3. Trust handling

Archipelago’s own listing and settlement data is a **first-party evidence class**. It may demonstrate that an attributed endpoint is active, but it cannot qualify Archipelago for the independent-corroboration requirement by itself. The agent profile should disclose the first-party relationship.

When an external marketplace independently observes a listing, delivery, or settlement, its observation can contribute an additional evidence class after source provenance and attribution are validated.

## 4. Follow-up work

- [ ] Record the exact Arc marketplace or directory URL and API/manifest contract.
- [ ] Confirm catalog crawling and redistribution terms.
- [ ] Validate that each listing contains enough endpoint and payment information for identity resolution.
- [ ] Cross-reference source records with Arc transactions and public service metadata.
- [ ] Add the approved source to `ingestion_sources` only after the connector review checklist is complete.
