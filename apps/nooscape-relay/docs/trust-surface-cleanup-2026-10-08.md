# Trust-surface cleanup — production record (2026-10-08)

> **Status:** Shipped (`2152919`) and live. `liveData.publicRecords` now serves the source-reported description as a sanitized `untrustedSummary` with explicit "Source-reported · untrusted" labels in the Atlas UI and `/developers`; version-like `primaryCapability` values are suppressed at the public read path; the Agenstry catalog adapter no longer promotes protocol versions and rejects feed self-listings. Stored snapshots and the Tier 3 card-pin path are intentionally untouched. This is an implementation record; see [AI handoff](./AI_HANDOFF_2026-10-08.md) for current state.

## What was wrong

- **Unlabeled untrusted text (M2).** The public read mapping served the stored self-description column as `summary` — no provenance in the contract, and the Atlas inspector/drawer presented it indistinguishably from Nooscape statements.
- **Version strings served as capabilities (L2).** The Agenstry adapter built `specialties = [category, protocol_version, payment_protocol].filter(Boolean)` and set `primaryCapability: specialties[0] ?? "A2A discovery metadata"`. When the source omitted `category`, the positional index after the filter promoted `protocol_version`: **41 of 58 live records served version-like capabilities** ("1.0" ×28, "0.3.0" ×8, "1.0.0" ×2, "0.2.5", "0.3", "1.0.1").
- **Feed self-listing.** The adapter accepted records whose AgentCard is served by the feed host itself; Agenstry's own card appeared in its own discovery results.

## Design: read-path guards now, governed re-projection later

Stored snapshots are never rewritten. The fix has two layers:

- **Adapter correction (future runs)** (`server/ingestion/agenstry.ts`): `primaryCapability` derives from `category` only; `protocol_version` is removed from the specialties candidate list (the positional fallback is gone); records whose AgentCard hostname matches the feed hostname (normalized, `www.` stripped) are rejected.
- **Read-path guards (existing data)** (`server/publicText.ts`, applied in `collapseVisibleSnapshots` in `server/db.ts`): served text is sanitized (control characters → space; zero-width/bidi/soft-hyphen removed; whitespace collapsed; length-capped) and version-like capability values matching `/^\d+(?:\.\d+)+$/` become `null`. The reviewed-run gate keeps the last approved projection public, so this is what today's records serve; the corrupted stored values retire at the next governed catalog re-projection, and the existing self-listed record `agenstry-48555b12fc-1277b40b29` retires the same way.
- **Contract rename:** the served field is `summary` → `untrustedSummary` (v0 API with no external consumers; the Atlas client is tRPC-typed). `/developers` documents the new field and a sanitized example.
- **Explicitly not touched:** `getNewestVisibleSnapshotCard` — it feeds the Tier 3 `snapshotCardFingerprint` (SHA-256 of the visible card) for the 90-day domain-control pin; sanitizing that path could break the live Observatory pin. DB columns, select aliases, and stored values are unchanged.
- **UI labels:** the Atlas inspector and signal drawer now show "Source-reported · untrusted" above the description; the old fallback copy ("Verified public discovery metadata…") is replaced with "No public description was retained for this record."

## Tests

- `server/publicText.test.ts` — 6 cases: control-character stripping, invisible/bidi removal, whitespace collapse, length cap, null/non-string handling, version-like capability drop with honest values kept.
- `server/reviewedRunGate.test.ts` — 2 added read-mapping cases: sanitization + version-like suppression through `collapseVisibleSnapshots`; clean values (e.g. "verification") pass through unchanged.
- Suite: **16 files / 63 tests** — 62 pass locally; the crawler availability boundary test requires production MySQL and fails environmentally.

## Production verification (2026-10-08, after the `2152919` deploy)

- `liveData.publicRecords` returns **58 records**; all 58 expose `untrustedSummary` and **zero** still expose the old `summary` field.
- Version-like `primaryCapability` values remaining: **0** (was 41). Null capabilities: **41**. Honest values are kept: 7× "Solana registry metadata", 6× "verification", 1× "a2a_x402", 1× "Agent Card Generator", 1× "Agent discovery metadata", 1× "Explain an agents.txt directive".
- The Tier 3 record (Nooscape Observatory) is unchanged — still `tier_3`, with its card-pin path untouched.
- The live bundle (`assets/index-DHVuicDU.js`) contains "Source-reported", "untrustedSummary", and the corrected fallback copy.
- Headers unchanged: root HEAD 200 with CSP + HSTS and no `X-Powered-By`.

## Companion doc corrections

- Root `AGENT_TRUST_TIER_DESIGN.md`: the unverifiable "$50B+ x402 processed" claim is replaced with the measured figure — ≈$41.9M settled across 12 chains with 190.9M cumulative transactions (agenteconomy.to, via `INGEST_POINTS.md` §1.4, 2026-10-08).
- Root `SCOPE.md`: new §6 "No Token at Launch (decision)" records the decision that `README.md` and `CRAWLNET_DATA_POINT.md` already referenced but the file did not contain.
- `docs/approvals/2026-10-08-agents-txt-a2a.md`: reviewer identity note — reviewers are recorded by role only under the single-operator constraint; "independent" means independent of the publisher; the `Second reviewer | Pending` checklist row is retained as state, not as evidence of a second review.

## Rollback

Revert `2152919` and push: the served contract returns to the previous `summary` field and the previous UI copy immediately. No schema or data change is involved; stored snapshots were never modified, so nothing needs restoring.
