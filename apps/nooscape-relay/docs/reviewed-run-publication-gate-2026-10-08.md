# Reviewed-run publication gate — production record (2026-10-08)

> **Status:** Shipped and live. Public visibility is bound to an explicitly approved completed ingestion run. This is the production activation record; see [live-data implementation plan](./live-data-implementation-plan.md) for current state.

## What shipped

A `public` source projection decision now names the approved completed run (`approvedRunId`) it was reviewed against, and a snapshot is public only while its observation is linked to that run through `source_observation_runs`.

- Scheduled runs never publish unreviewed changes; later runs stay withheld until reviewed and explicitly approved.
- Records not re-observed in the approved run retire from the public set automatically.
- The last approved version stays visible until a later run is approved.

Code shipped in `7513d14`: `drizzle/schema.ts`, `drizzle/0008_nostalgic_karen_page.sql`, run-bound queries (`listLiveAtlasRecords`, `getLiveAtlasProvenanceCoverage`, `collapseVisibleSnapshots`) in `server/db.ts`, operator approve/revoke flow with pending-run visibility in `liveData.ts` and the `/admin/sources` projection column.

## Production activation (verified 2026-10-08)

1. The `main` push auto-deployed the code. Until the schema existed, both public queries failed closed (`publicRecords` empty, `publicCoverage` 0/0/0) — the expected temporary window.
2. The reviewed 0008 SQL was applied through the one-time operator-gated bridge on the production app connection. Applied statements: `ADD COLUMN approvedRunId`, `ADD CONSTRAINT spd_approved_run_fk`, `BACKFILL approvedRunId (6 row(s))` — all 6 public decisions bound to their source's latest completed run.
3. Verification after apply: **58/58 records retained, handles identical to the pre-gate baseline**, `publicCoverage` 58/58 (100%). No record retired; nothing leaked.
4. The bridge was removed immediately after apply (`674a4c8`); its route returns HTTP 404.

## Operator flow

- `/admin/sources` shows per-source projection state: the bound approved run and how many records in the latest run await review.
- **Publish reviewed run** binds the source's current latest completed run after its evidence review; **Revoke public** returns the source to withheld.
- After each later scheduled run, re-publishing is an explicit operator act — visibility never advances automatically.

## Notes and open items

- The production database has no Drizzle journal table (`drizzleJournalTablePresent: false`); applying migrations from the pipeline instead of the reviewed-file + operator-bridge lifecycle remains an open improvement item.
- Local validation: 13 files / 41 tests — 38 pass without a database; the 3 crawler boundary tests require the production MySQL.
- Pushing `main` auto-deploys production (Hostinger managed hosting); there is no separate deployment target.
