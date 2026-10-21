# Evidence-tier scale v1 (evidence-tier-v1)

> **Status — 2026-10-08:** Published. This memo is the single implemented direction for `evidenceTier`: tiers are **evidence levels**, not scores. It retires the un-implemented 0–100 "trust vector" copy that previously appeared on `/developers` and supersedes §4.3 of `AGENT_TRUST_TIER_DESIGN.md` for anything currently served.

## The scale

| Tier | Meaning | How it is earned |
|---|---|---|
| `tier_2` | Approved-source record (baseline) | Metadata from an **approved source**, served only through an **explicitly reviewed run** (`approvedRunId` gate). Every public record starts here. |
| `tier_3` | Domain-control verified | The agent's own domain served a one-time HTTPS proof file. **Valid for a 90-day window**; a recheck renews or revokes; the verification is pinned to the public card. |
| `tier_4` | Publisher-key allowlisted | A rotation-bound publisher key is on the operator allowlist. Publisher keys only ever **raise** a record; any non-allowlisted key state returns it to the `tier_2` baseline. |
| `tier_0`, `tier_1` | Reserved | Not assigned in v1. No record can claim them; no self-reported signal reaches them. |

A tier names the **highest evidence level a record has cleared**. There is no blended score, no weighting, and no partial credit.

## Versioning

- The version string `evidence-tier-v1` is stamped in the operator-facing verification records: the `DOMAIN_CONTROL_VERIFIED` / `DOMAIN_CONTROL_RECHECKED` / `DOMAIN_CONTROL_REVOKED` evidence-event descriptions and the read-model `evidenceSummary` written by the verification flows.
- Every tier change is operator-gated and leaves an immutable evidence event, so a historical tier decision remains explainable under the scale version that produced it.

## Validity model for tier_3 (fail-closed)

Domain-control verification is **not permanent**:

1. **TTL** — a successful verification is valid for `DOMAIN_VERIFICATION_VALIDITY_DAYS = 90`. The expiry is stored on both the challenge row and the read model.
2. **Card pin** — the verification pins a SHA-256 fingerprint of the public card it was granted against (display name, primary capability, summary, protocols). The card an operator sees and verifies is the card that stays verified.
3. **Read-time enforcement** — `collapseVisibleSnapshots` applies the `tier_3` read-model overlay **only while** the window is open **and** the pinned fingerprint still matches the visible card. Expired or changed → the record is served as `tier_2` immediately, with no cron job involved.
4. **Recheck** — the operator recheck re-fetches the live proof file. Success renews the window and re-pins the currently visible card (`DOMAIN_CONTROL_RECHECKED`). Any failure — missing proof, changed bytes, refused fetch — **revokes fail-closed**: the challenge is revoked, matching identity/endpoint rows revert to asserted/unverified, the read model returns to `tier_2`, and a `DOMAIN_CONTROL_REVOKED` event is recorded. Renewal is the only path; silence lets the window lapse.
5. **A changed card resets the pin.** When a later approved run changes the card, the read path immediately serves `tier_2` and the operator ledger shows the pin as `changed` until a successful recheck re-pins the new card.

## Where it lives in code

- `server/db.ts` — `EVIDENCE_TIER_SCALE_VERSION`, `DOMAIN_VERIFICATION_VALIDITY_DAYS`, `snapshotCardFingerprint`, `effectiveEvidenceTier`, `collapseVisibleSnapshots`, `completeDomainVerification`, `recheckDomainVerification`, `listDomainChallenges` (card-pin status). The one-time `applyDomainVerificationTtlSchema` bridge was removed after the production apply.
- `server/routers/liveData.ts` — `verifyDomainChallenge`, `recheckDomainVerification` operator routes.
- `client/src/pages/SourceOperations.tsx` — challenge ledger with state (`lapsed`/`revoked`), validity window, card-pin status, and the Recheck action.
- `client/src/pages/DeveloperApi.tsx` — `/developers` now documents this scale and the real `liveData.publicRecords` record shape. All 0–100 score artifacts were removed.
- `drizzle/0009_omniscient_mojo.sql` — the two `ADD COLUMN` statements plus the reviewed 90-day backfill for the pre-existing verified challenge.

## Current production state (at publication)

- 58 public records: 57 × `tier_2`, 1 × `tier_3` (the self-owned Nooscape Observatory pilot), 0 × `tier_4`.
- The pilot verification predates v1 stamping; the 0009 backfill pins its window (`verifiedAt + 90 days ≈ 2027-01-06`) and its visible-card fingerprint.
- Migration 0009 was applied through the one-time operator bridge and the bridge was removed immediately after (`9d186fa`; the route returns HTTP 404).

## Non-claims

A tier is an evidence level, not a guarantee: not safety, performance, identity ownership, legal entity, service availability, or real-world completion. `publisherState` remains independent of `evidenceTier` and stays `unverified` unless a separate publisher-key policy is approved.
