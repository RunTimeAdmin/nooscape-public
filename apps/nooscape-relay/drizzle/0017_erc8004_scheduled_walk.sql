-- Hand the erc8004 forward walk to the scheduled worker (operator decision,
-- 2026-10-11; docs/forward-cursor-2026-10-10.md). The cursor guard keeps this
-- a no-op until the walk has actually reached forward territory, so fresh
-- environments still register the source as manual_only and walk it by hand
-- through bf: -> rb: -> ac: first. A 15-minute due cadence with the 2M-block
-- per-run window stays far ahead of the measured ~141k blocks/h chain pace;
-- the worker's one-due-source-per-tick rotation sets the effective rhythm.
-- Idempotent: once flipped, the WHERE clause matches nothing.
UPDATE `ingestion_sources`
SET `executionPolicy` = 'scheduled',
    `scheduleMinutes` = 15,
    `nextRunAt` = UTC_TIMESTAMP()
WHERE `protocol` = 'erc8004'
  AND `executionPolicy` = 'manual_only'
  AND `cursor` LIKE 'fw:%';
