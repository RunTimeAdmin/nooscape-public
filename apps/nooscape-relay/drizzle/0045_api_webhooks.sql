-- Watchlists and webhooks (migration 0045): the four tables behind stage D5 of the data-access plan (docs/data-access-2026-10-19.md).
--   `api_watches`        the listings a key asks to hear about: one row for a key and a listing, with whether it was last known to be served.
--   `api_webhooks`       a key's one webhook: the https address its events go to, the version of its signing secret, and how many deliveries failed in a row.
--   `api_deliveries`     one event for one key: the exact JSON sent, where it stands, and what the last try got. One row for a key and an event.
--   `api_event_cursors`  how far the event pass has read in each ledger, so it only reads forward.
-- A webhook tells a key's owner that something was recorded about a listing they watch. It never changes a record, a score, a tier or an evidence
-- level, and it names no more than the public API already does.
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in server/dbMigrations.ts). The owner applies it by pasting this file into
-- the host's SQL console, when they choose. docs/data-access-2026-10-19.md has the order, the record to insert afterwards, the check and the rollback.
-- Webhooks stay off until the owner also sets WEBHOOK_SIGNING_KEY in the host's environment, so the tables can exist with nothing writing to them.
--
-- Review notes:
--   * Four new tables and nothing else. No ALTER of a live table, no index added to an existing one, no data written, nothing rebuilt: it cannot
--     slow or lock the tables the public reads scan.
--   * CREATE TABLE IF NOT EXISTS, with every index inside it, so running the file again is a no-op.
--   * No foreign keys. Nothing refers to these tables from another table and they refer to none, so they can be dropped alone, in any order.
--   * `api_deliveries_event_uq` (keyId, eventRef) is the guard that matters: an event is one row for a key, so two passes, or a pass that is
--     run again, cannot make two deliveries of one event.
--   * The signing secret is not stored: it is derived from a secret of the server's, the key's id and `secretVersion`. The webhook address is the
--     only thing in these tables a key's owner typed. No network address of any caller is kept.
--   * `api_deliveries.body` is bounded (a few hundred bytes of JSON; 4,000 at most) and holds only what the public API shows. Delivered and
--     given-up rows are deleted after 30 days by the pass that writes them.
--   * No TEXT column, so no default is needed. Every text column is a bounded VARCHAR.
--   * Until the tables exist, and until the setting is set, the API answers exactly as it did before this migration, and the watchlist and webhook
--     calls answer that they are not available. Rolling back is DROP TABLE for the four tables and deleting version 45 from
--     `nooscape_schema_migrations`.
CREATE TABLE IF NOT EXISTS `api_watches` (
	`keyId` varchar(36) NOT NULL,
	`entryId` varchar(36) NOT NULL,
	`visible` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `api_watches_pk` PRIMARY KEY(`keyId`,`entryId`),
	INDEX `api_watches_entry_idx` (`entryId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_webhooks` (
	`keyId` varchar(36) NOT NULL,
	`url` varchar(500) NOT NULL,
	`secretVersion` int unsigned NOT NULL DEFAULT 1,
	`failures` int unsigned NOT NULL DEFAULT 0,
	`disabledAt` timestamp NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `api_webhooks_keyId` PRIMARY KEY(`keyId`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_deliveries` (
	`id` varchar(36) NOT NULL,
	`seq` bigint unsigned AUTO_INCREMENT NOT NULL,
	`keyId` varchar(36) NOT NULL,
	`eventRef` varchar(96) NOT NULL,
	`kind` varchar(24) NOT NULL,
	`entryId` varchar(36) NOT NULL,
	`body` varchar(4000) NOT NULL,
	`status` varchar(8) NOT NULL DEFAULT 'pending',
	`attempts` tinyint unsigned NOT NULL DEFAULT 0,
	`nextAttemptAt` timestamp NOT NULL DEFAULT (now()),
	`lastStatus` int unsigned NULL,
	`lastError` varchar(40) NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`sentAt` timestamp NULL,
	CONSTRAINT `api_deliveries_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_deliveries_seq_uq` UNIQUE(`seq`),
	CONSTRAINT `api_deliveries_event_uq` UNIQUE(`keyId`,`eventRef`),
	INDEX `api_deliveries_due_idx` (`status`,`nextAttemptAt`),
	INDEX `api_deliveries_key_idx` (`keyId`,`seq`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_event_cursors` (
	`name` varchar(24) NOT NULL,
	`position` varchar(40) NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `api_event_cursors_name` PRIMARY KEY(`name`)
);
