# Domain-control verification

> **Status — 2026-10-08:** The consent-gated Tier 3 workflow completed its first production challenge. The self-owned Nooscape Observatory (`nooscape.si`) published the one-time proof and now projects publicly as **Tier 3** with publisher state still `unverified`; the other 57 public records remain Tier 2 / unverified. As of the same day the upgrade is time-boxed under **evidence-tier-v1**: a 90-day validity window, an operator recheck that renews or revokes, and a card fingerprint pin — see [evidence-tier scale v1](./evidence-tier-scale-v1-2026-10-08.md).

## Purpose

Nooscape can now verify that the operator of an already-discovered agent domain controls a narrowly scoped HTTPS proof-file location. This is an **evidence-tier upgrade** for an eligible Tier 2 observation; it is not a publisher-key allowlist or a trust endorsement.

## Flow

1. An operator selects an already asserted A2A AgentCard or endpoint domain for an existing agent.
2. Nooscape creates a 48-hour challenge with an opaque challenge ID and one-time bearer token.
3. The domain operator publishes the exact token as plain text at:
   `https://<asserted-domain>/.well-known/nooscape-domain-verification/<challenge-id>.txt`
4. An operator triggers one bounded HTTPS `GET`. No redirects, credentials, cookies, service calls, or agent tools are allowed.
5. Nooscape stores the proof bytes in the private evidence bucket, recomputes a SHA-256 digest, and applies normal governance retention.
6. A successful proof marks matching identity and endpoint records as domain verified and upgrades the map read model to **Tier 3**.
7. The upgrade is time-boxed: valid for 90 days, pinned to the verified card fingerprint, and renewable only by an operator recheck that re-fetches the live proof. A failed recheck revokes it fail-closed back to Tier 2 evidence.

## What a Tier 3 domain-control result means

- The asserted domain served the issued proof file during the challenge window.
- The associated identity/endpoint is domain-verified for Nooscape evidence purposes.

It **does not** mean that Nooscape has verified a legal entity, publisher-key ownership, authorization to represent an organization, the safety or availability of a service endpoint, payment behavior, or claimed capabilities. `publisherState` remains `unverified` unless a separate publisher-key policy is approved.

## Validity, recheck, and revocation (added 2026-10-08)

- A verified challenge is valid for **90 days** (`DOMAIN_VERIFICATION_VALIDITY_DAYS`). The expiry is stored on the challenge row and on the read model.
- The verification pins a **SHA-256 fingerprint of the public card** it was granted against (display name, primary capability, summary, protocols). The public read path serves the Tier 3 overlay only while the window is open and the visible card still matches the pin; otherwise the record is served as Tier 2 evidence immediately — fail-closed, with no scheduled job involved.
- The operator ledger (`/admin/sources`) shows the verification window and the card-pin status (`current` / `changed` / `unpinned`) and offers **Recheck**, which re-fetches the live proof file:
  - **success** → the window renews 90 days from the recheck and the currently visible card is re-pinned (`DOMAIN_CONTROL_RECHECKED`);
  - **any failure** → the upgrade is revoked: the challenge is marked revoked, matching identity/endpoint rows revert to `asserted` / `unverified`, the read model returns to Tier 2, and a `DOMAIN_CONTROL_REVOKED` event records the reason.
- Renewal is the only path forward: letting the window lapse returns the record to Tier 2 until a recheck or a new challenge succeeds.

## Safeguards

- The bearer token is returned only once and only its SHA-256 digest is stored.
- The stored proof URL contains the challenge ID, never the bearer token.
- Domains must already be asserted by an agent identity or endpoint.
- Private, loopback, link-local, multicast, credential-bearing, port-bearing, and redirected targets are rejected.
- Proof bodies are capped at 4 KiB and raw bytes remain private.

## First production execution — 2026-10-08

- **Participant:** Nooscape Observatory (`nooscape-observatory-2a1a325963`), the owner-operated `nooscape.si` pilot card for the evidence-first discovery path.
- **Challenge:** `4c7be0cd-315d-4750-80dc-787619953d2d`, issued 2:56 PM and verified 2:59 PM local operator time (the signed evidence entry is stamped `2026-10-08T19:59:59Z`).
- **Proof:** the exact 43-byte one-time token served from the `.well-known` proof location; retained SHA-256 `cdb2c29bbca601a4e0b8ba273d41f70ff74907022ecdad3071c0ada401f5d3e3`.
- **Outcome:** matching identity and endpoint rows marked domain verified; a signed `DOMAIN_CONTROL_VERIFIED` entry appended to the retained envelope; the public projection upgraded to **Tier 3** while `publisherState` remains `unverified`.
- **Validity (added 2026-10-08):** the existing verification was backfilled under migration 0009 (applied in production 2026-10-08) — expiry `verifiedAt + 90 days` (≈ 2027-01-06) and the visible-card fingerprint pinned — so it is subject to the same recheck and revocation rules as any future verification.
