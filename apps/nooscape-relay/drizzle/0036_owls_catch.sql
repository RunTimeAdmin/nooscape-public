-- The Owl's Catch (migration 0036): one factual finding a day, chosen by a fixed
-- rule (shared/owlsCatch.ts) and stored with the values its words are made from,
-- so a day's catch can be shown again exactly as it was found. A day with no
-- finding is stored too (rule "none"), so a day is decided once.
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in
-- server/dbMigrations.ts). The owner applies it by pasting this file into the
-- host's SQL console, when they choose. docs/owls-catch-2026-10-15.md has the
-- order, the record to insert afterwards, the check and the rollback.
--
-- Review notes:
--   * One new table and nothing else. No ALTER of a live table, no index added to
--     an existing one, no data written, nothing rebuilt: it cannot slow or lock
--     the tables the public reads scan.
--   * CREATE TABLE IF NOT EXISTS, so running the file again is a no-op.
--   * Dates are YYYY-MM-DD text with a unique index, which is what makes the
--     worker's first tick of the UTC day the only writer that can win; a second
--     process inserting the same day is ignored by INSERT IGNORE.
--   * The facts and identity ids are JSON text, checked by the reader. No TEXT
--     column has a default, as MySQL requires.
--   * Nothing refers to this table and it refers to nothing. Rolling back is
--     DROP TABLE `owls_catch` and deleting version 36 from
--     `nooscape_schema_migrations`, after which the public reads fail closed to
--     "no catch" and the worker's step is logged and skipped.
CREATE TABLE IF NOT EXISTS `owls_catch` (
	`id` varchar(36) NOT NULL,
	`catchDate` varchar(10) NOT NULL,
	`rule` varchar(16) NOT NULL,
	`facts` text NOT NULL,
	`sourceQuery` varchar(255) NOT NULL,
	`agentIds` text NOT NULL,
	`selectedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `owls_catch_id` PRIMARY KEY(`id`),
	CONSTRAINT `owls_catch_date_uq` UNIQUE(`catchDate`)
);
