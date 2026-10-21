# Publisher-key expiry enforcement — production record (2026-10-08)

> **Status:** Shipped (`bae186f`) and live. `expireDuePublisherKeys` — implemented but previously callerless — now runs on every scheduled worker tick, including paused and rate-limited ones, and both read paths resolve expiry fail-closed between ticks. A lapsed allowlisted key returns its records to the tier_2 baseline and records an immutable `PUBLISHER_KEY_EXPIRED` evidence event. No schema change; production holds zero publisher keys, so no public record changes tier.

## What was wrong

- `expireDuePublisherKeys` existed in `server/db.ts` with a complete deterministic implementation but **no caller**: an allowlisted publisher key past its configured `expiresAt` never transitioned to `expired`.
- Both read paths promoted any stored `allowlisted` row regardless of `expiresAt`: `refreshAgentPublisherReadModel` wrote `publisherState: "allowlisted"` / `evidenceTier: "tier_4"`, and `getPublisherValidationForAgent` returned `status: "allowlisted"`. `effectiveEvidenceTier` passes `tier_4` through unchanged, so nothing else demoted it at read time.
- Net effect: a lapsed publisher key could serve an allowlisted / tier_4 record indefinitely — contradicting the documented invariant that any non-allowlisted key state returns the record to the tier_2 baseline.

## Design: scheduled expiry + read-time fail-closed resolution

- **Pure resolver** (`effectivePublisherKeyState`, exported from `server/db.ts`): an allowlisted key is `expired` once `expiresAt <= now` (the same `<=` boundary as the SQL sweep); every other state passes through; a null expiry never expires. Both read paths resolve through it, so expiry holds even between ticks.
- **Worker trigger** (`server/ingestion/worker.ts`): expiry runs first on every tick, before the ingestion claim, so it executes even when the claim returns `paused` or `rate_limited`. It performs no external fetch and cannot bypass the global interval. Failures are caught, logged as `nooscape_publisher_key_expiry_failed`, and never abort the tick. `WorkerTickResult` gains an additive `expiredPublisherKeys` count (no client consumers).
- **Persistence + evidence** (`expireDuePublisherKeys`): the state transition and the `publisherKeyHistory` append stay in one transaction; each bound record additionally gets an immutable `PUBLISHER_KEY_EXPIRED` evidence event (mirroring the revoke-flow pattern; `eventType` is free-form varchar(160), no registry change). Read models refresh after commit.
- **Bounded window:** the host 15-minute cron and the operator `liveData.runWorkerTick` both funnel through `runRateLimitedIngestionTick`, so the persisted transition lands within ≤ one worker interval; read-time resolution closes the gap before it lands.
- **Explicitly not touched:** no schema migration, no new operator route, no client changes, no change to the approve / revoke / rotation flows.

## Tests and gates

- `server/publisherKeyExpiry.test.ts` — 3 cases: a past expiry (including the `<=` boundary) resolves as expired; an open or absent window stays allowlisted; non-allowlisted states pass through unchanged.
- `pnpm check` clean; `pnpm build` clean; suite **17 files / 66 tests** — 65 pass locally; the crawler availability boundary test requires production MySQL and fails environmentally only.

## Production verification (2026-10-08, after the `bae186f` deploy)

- Site healthy after deploy: root HEAD 200 with CSP + HSTS and no `X-Powered-By`.
- `liveData.publicRecords` returns **58 records** with **58** `untrustedSummary` values, **zero** old `summary` fields, **zero** version-like capability values (41 null), and the identical trust-surface distribution — **57 tier_2 + 1 tier_3**; the Nooscape Observatory stays `tier_3` with publisher state `unverified`. No public regression.
- Production currently holds **zero publisher keys**, so no record changes state or tier from this change; the enforcement path activates at the next consented key lifecycle. The server-side tick result now carries `expiredPublisherKeys` (visible in host worker logs at the next 15-minute tick).

## Rollback

Revert `bae186f` and push. Expiry stops transitioning keys and stops resolving at read time immediately. No schema or data change is involved; any already-persisted `expired` transitions are truthful history, and re-allowlisting is an explicit operator act.
