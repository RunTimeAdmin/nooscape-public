UPDATE `ingestion_sources` SET `executionPolicy` = 'scheduled', `scheduleMinutes` = 30, `nextRunAt` = UTC_TIMESTAMP() WHERE `sourceKey` = 'solana-8004-agent-registry' AND `state` = 'active' AND `executionPolicy` = 'manual_only' AND `cursor` LIKE 's8004:%';--> statement-breakpoint
INSERT INTO `ingestion_worker_config` (`id`, `state`, `tickSeconds`, `maxSourcesPerTick`, `minGlobalIntervalMinutes`) VALUES ('primary', 'paused', 900, 2, 15) ON DUPLICATE KEY UPDATE `maxSourcesPerTick` = 2;--> statement-breakpoint
-- Reviewed apply note (2026-10-12): 8004 scheduled flip + two-source ticks,
-- migration 0027 — the same flip migration 0021 gave the Metaplex chain pass.
-- Preconditions, both encoded in the UPDATE's WHERE: the source is active and
-- holds an `s8004:` seed cursor, so a fresh or not-yet-seeded deployment never
-- wakes up to an unattended inventory. The seed was staged, reviewed, and run
-- by an operator (1,504 agents, an exact chain match, zero events), and the
-- diff pass this flip unattendedly runs is the reviewed step-2 posture:
-- chain-facts-only reads, INSERT-IGNORE ledger, the 98%-of-prior-live
-- enumeration floor, and a getAccountInfo confirmation before any closure
-- hides a row. Cadence 30 minutes: with six scheduled sources sharing the
-- worker, two per tick keeps every source's effective cadence near its
-- configured one instead of the one-per-tick rotation's ~60-90 minute waits.
-- The INSERT..ON DUPLICATE KEY UPDATE raises maxSourcesPerTick to 2 whether
-- or not the config row exists yet: a fresh install keeps the default paused
-- state (the INSERT carries 'paused'), and an existing row only has its
-- per-tick limit changed — tickSeconds, the interval, and the enabled/paused
-- state are never touched by this migration.
