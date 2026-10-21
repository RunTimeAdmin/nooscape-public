# Evidence durability — production record and drill plan (2026-10-08)

> **Status:** Audit tooling and the public baseline are shipped (`2865958`). The offsite copy and the first restore drill are **operator steps** — listed below, not yet executed. Nothing in this record writes to production.

## The gap

- Raw evidence objects live on a single RustFS node with no offsite copy; losing that node destroys the bytes behind every retained observation.
- MySQL backups exist through the hosting panel — daily backups plus manual backups (operator-confirmed 2026-10-08) — but no restore has ever been rehearsed, and the object store has no restore procedure at all.
- Nothing re-checked, as a whole-set operation, that every object a database row references still exists and matches its recorded SHA-256 — hash verification ran only per-object inside operator review flows.

## What production already guarantees

- Every raw object is written content-addressed with `ObjectLockMode: GOVERNANCE` and a 90-day retain-until; the database retains the object key and SHA-256 (observations, domain proofs, and publisher-key attestations alike).
- Served evidence re-verifies hash and Ed25519 signature against the pinned relay key; `atlas.verifyEvidence` returns `valid` only when hash, signature, key pin, and relay identity all pass.
- Public baseline (verified 2026-10-08): **58/58** live records' envelopes fetched from `atlas.evidence` pass local SHA-256 + key-pin checks and the server's `atlas.verifyEvidence`; a tampered payload is rejected. This is the external, infrastructure-free proof of the public evidence chain.

## The durability audit (shipped)

`pnpm durability:audit [sampleSize]` — `server/durabilityAudit.ts`, read-only, never writes.

- Loads every expected object/hash pair from `source_observations`, `domain_verification_challenges`, and `publisher_keys`.
- Re-reads each object (`GetObject` + `GetObjectRetention`) through the same `verifyStoredObject` path the operator review uses, and classifies it: matched, mismatched (hash), missing (`NoSuchKey`/`NotFound`), unreadable (other errors).
- Prints one JSON line: bucket, `checked`/`matched`, per-source tallies, up to 20 problem details per class, retention `modeCounts` + earliest `retainUntil` + `lapsed`, and a per-table row inventory (restore fingerprint) covering `ingestion_sources`, `source_observations`, `agents`, `agent_public_snapshots`, `agent_read_model`, `evidence_events`, `domain_verification_challenges`, `publisher_keys`.
- Exit 0 only when every expectation matched; exit 1 on any mismatch, missing object, or read error. Fails closed without `DATABASE_URL` / `NOOSCAPE_S3_*` and refuses to report against an empty database. `sampleSize` caps rows per source.

Run matrix — same tool, three proofs:

| `DATABASE_URL` | `NOOSCAPE_S3_*` | What it proves |
|---|---|---|
| production | production | live database ↔ live bucket integrity |
| restored copy | production | the database restore is complete (fingerprint + hashes) |
| restored copy | offsite copy | full disaster-recovery rehearsal |

## Operator checklist (pending)

**MySQL backups**

1. Confirmed 2026-10-08: the hosting panel provides daily backups (scheduled 21:25 CST) and manual backups. Remaining: record the retention window and the latest backup's date/size with the first drill entry.
2. Before any future schema migration: take a manual backup first.

**Offsite object copy**

1. Choose an S3-compatible destination on a different provider/account; enable versioning and, where supported, Object Lock (`GOVERNANCE`, ≥ 90 days).
2. On the VPS, configure rclone (or the AWS CLI) with the existing RustFS credentials as source and the destination bucket as target; run the first full copy, then a daily incremental cron.
3. Weekly: run the audit with production `DATABASE_URL` + destination `NOOSCAPE_S3_*`; expect all matched.
4. If the destination lacks Object Lock, the copy is protected only by versioning and provider policy — record that as an accepted residual, or pick a provider with lock support.

**Restore drill (quarterly + after schema migrations)**

1. Restore the latest backup into a scratch database (never over production).
2. Run the audit with the scratch `DATABASE_URL` + production `NOOSCAPE_S3_*`: expect `matched == checked`, empty problem classes, and an inventory equal to the recorded production fingerprint.
3. Spot-check three random observation IDs: `rawObjectKey` and `contentHash` must match production.
4. If remote MySQL access is needed, request a temporary read-only rule and remove it immediately after (the standing rule keeps remote access removed).
5. Tear down the scratch database; append one line to the drill log.

## Drill log

- 2026-10-08 — tooling shipped (`2865958`); public baseline passed (58/58 envelopes, tamper control rejected). MySQL backup: **daily + manual backups confirmed in the hosting panel (operator)**; daily run scheduled 21:25 CST; retention window not yet recorded. Offsite copy: **not created**. Restore drill: **not executed**.

## Rollback

Delete `server/durabilityAudit.ts` and the `durability:audit` script. Nothing in production is affected — the tool is wired into no request path and the database and bucket are never written.
