# Record withdrawal — operator-gated census governance (2026-10-08)

> **Status:** **Applied in production on 2026-10-08.** Migration `0010_record_withdrawals.sql` (reviewed, in the repository) was applied through the one-time operator bridge from the authenticated `/admin/sources` console, and the bridge was removed by the follow-up commit — the bridge route returns tRPC `NOT_FOUND` / HTTP 404. Observation class for everything below: repository code, local tests, the operator's bridge run, and public-endpoint reads — no direct database inspection. Post-apply public verification (2026-10-08): `liveData.publicRecords` serves the full census again — **58 records (57 tier_2 + 1 tier_3)**, root HTTP 200 — which requires the ledger table to exist and read as an empty ledger.

## Why

The 2026-10-08 census review ([census integrity](./census-integrity-2026-10-08.md)) verified that retirement had only two paths, both source-wide: automatic non-re-observation, or revoking a source's entire public projection. Six flagged review candidates could not be retired without removing 7–48 innocent records alongside them. Withdrawal closes exactly that gap: one record, operator-gated, evidence-recorded, reversible.

## What ships

- **Append-only ledger** — `agent_record_withdrawals` (migration `0010`): `agentId`, `action` (`withdraw` | `reinstate`), the operator's `reason`, the deciding user, and a timestamp. The auto-increment `id` is the event order; there are no updates and no deletes.
- **Resolution rule (pure, unit-tested)** — the newest ledger event per agent decides visibility: withdraw hides the record, reinstate serves it again; withdraw → reinstate → withdraw resolves as withdrawn. `resolveWithdrawnAgentIds` in `server/db.ts`; five new cases in `server/reviewedRunGate.test.ts`.
- **Fail-closed read path** — `listLiveAtlasRecords` filters withdrawn agents before the newest-per-agent collapse, and `getLiveAtlasProvenanceCoverage` skips them. If the ledger cannot be read (for example if the table were missing or unreadable), the whole read fails and the public census serves empty rather than risk exposing a withheld record — or silently un-withdrawing one if the table were ever dropped.
- **Evidence events** — every decision persists an immutable `RECORD_WITHDRAWN` / `RECORD_REINSTATED` event against the record's newest reviewed-run observation (`proofReference: nooscape-census-governance`) carrying the operator's reason; the source, its approved run, snapshots, and all retained evidence stay untouched.
- **Operator UI** — `/admin/sources` gains a **Withdraw a record** panel (served-record picker + recorded reason), a **What withdrawal is not** scope panel, and a **Withdrawn records** ledger with a Reinstate action (fixed operator rationale; the recorded reason stays the rationale of the withdrawal itself).
- **Census-audit mirror** — `pnpm census:audit` applies the same ledger filter to its mirrored gate (the exact served-set guard holds with withheld records present) and reports a `governance` block with the withheld ids.

## What withdrawal is not

- It is not a delete: nothing is removed anywhere, and the ledger itself is append-only.
- It is not an evidence edit: the source, its approved run, snapshots, observations, and proof objects are unchanged.
- It is not a source-scope decision: prefer revoking the source projection when an entire source is in question.
- It is not a quality verdict by itself; the operator's recorded reason is the rationale.

## Deploy lifecycle (completed — same precedent as the 0006–0009 bridges)

1. Pushed (`0278a94`) → auto-deploy. Until the apply, the public census read **empty** (fail-closed) — the expected deploy-completion signal, observed live through `liveData.publicRecords` (zero records; root HTTP 200).
2. The operator applied migration `0010` through the one-time operator bridge (`liveData.admin.applyRecordWithdrawalSchema`) from the authenticated `/admin/sources` console — the four reviewed statements: table + two foreign keys + index. The bridge pre-checks the table, so re-running is safe (`already-applied`). The operator token was only ever entered through the normal login form; it is never printed or shared.
3. Recovery verified the same day: `liveData.publicRecords` serves the full census again — **58 records (57 tier_2 + 1 tier_3)**, root HTTP 200. Serving 58 again requires the ledger table to exist and resolve against an empty ledger: an unreadable ledger fails closed to zero.
4. The follow-up commit removes the bridge route (it returns tRPC `NOT_FOUND` / HTTP 404), exactly as `674a4c8` and `9d186fa` did for 0008/0009.

## Retiring the flagged candidates (apply complete — ready for operator action)

The six remaining flagged candidates from [census integrity](./census-integrity-2026-10-08.md) can now each be withdrawn one at a time — a written reason, an immutable evidence event, and a one-click reinstate if the call was wrong. The Agenstry self-listing (#16) still retires automatically on the next approved catalog run.

## Rollback

- **Before the apply (window closed 2026-10-08):** revert the commit and deploy; nothing in production had changed (the empty-census window closed when the operator applied `0010`).
- **After the apply:** the table is inert without the code path; to fully restore the previous behavior, revert the read-path filter. Withdrawals are ledger rows — reverse one through the UI (reinstate), never by editing the table.

## Verification recorded

- `pnpm check` clean; `pnpm build` clean.
- Suite: 18 files / 76 tests — 75 pass without a database (including the five new withdrawal-resolution cases); the crawler availability boundary test remains the single environmental failure on machines without production MySQL.
- Fail-closed window observed live before the apply (2026-10-08): the public census served zero records — the deploy-completion signal.
- Post-apply public verification (2026-10-08): the census serves 58 records again (57 tier_2 + 1 tier_3), root HTTP 200.
- Bridge removal follows the verified precedent (route absent → tRPC `NOT_FOUND` / HTTP 404; re-checked on production after the follow-up deploy).
