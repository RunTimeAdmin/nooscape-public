-- API keys (migration 0043): the two tables behind the REST API's keys and metering (docs/data-access-2026-10-19.md, stage D2).
--   `api_keys`   who holds a key and at what tier: only the SHA-256 of the key, its first characters, the owner's email, the tier and dates.
--   `api_usage`  what each key asked of the API: one row for a key, a UTC day and an endpoint, counted up as requests are answered.
-- A key is a way to ask for more, never a way to change what is served: payment never changes a record, a tier or an evidence level.
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in server/dbMigrations.ts). The owner applies it by pasting this
-- file into the host's SQL console, when they choose. docs/data-access-2026-10-19.md has the order, the record to insert afterwards, the
-- check and the rollback.
--
-- Review notes:
--   * Two new tables and nothing else. No ALTER of a live table, no index added to an existing one, no data written, nothing rebuilt:
--     it cannot slow or lock the tables the public reads scan.
--   * CREATE TABLE IF NOT EXISTS, with every index inside it, so running the file again is a no-op.
--   * No foreign keys. Nothing refers to these tables from another table and they refer to none, so they can be dropped alone.
--   * The key itself is never stored: `keyHash` is the SHA-256 of a key that is 30 random bytes, found again by its unique index. The
--     owner sees the key once, when it is made.
--   * No network address is kept in either table. The limits that stop a flood of sign-ups are held in the server's memory.
--   * `api_keys_email_idx` serves the cap on live keys for one email, so a sign-up scans no table.
--   * `api_usage` has one row for each key, day and endpoint (a handful of endpoints), written in batches every few seconds and not for
--     each request, so a busy key adds a few rows a day and the writes stay well inside the host's connection budget.
--   * No TEXT column, so no default is needed. Every text column is a bounded VARCHAR (the longest is the 254-character email).
--   * Until the tables exist the API answers requests that carry a key with "keys are not available" and every request without one is
--     unchanged; the sign-up answers the same. Rolling back is DROP TABLE for the two tables and deleting version 43 from
--     `nooscape_schema_migrations`.
CREATE TABLE IF NOT EXISTS `api_keys` (
	`id` varchar(36) NOT NULL,
	`keyHash` varchar(64) NOT NULL,
	`keyPrefix` varchar(16) NOT NULL,
	`ownerEmail` varchar(254) NOT NULL,
	`tier` varchar(12) NOT NULL DEFAULT 'free',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`revokedAt` timestamp NULL,
	`lastUsedAt` timestamp NULL,
	CONSTRAINT `api_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_keys_hash_uq` UNIQUE(`keyHash`),
	INDEX `api_keys_email_idx` (`ownerEmail`,`revokedAt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_usage` (
	`keyId` varchar(36) NOT NULL,
	`day` date NOT NULL,
	`endpoint` varchar(24) NOT NULL,
	`count` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `api_usage_pk` PRIMARY KEY(`keyId`,`day`,`endpoint`)
);
