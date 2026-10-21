-- The registrations a chain pass counts and does not store (docs/flood-host-cap-2026-10-21.md).
-- One host registered 140,000 agents a day on Base, a registry row and two ledger rows each, against a database limit of 6 GB. Once a
-- host holds its cap of stored rows, the pass counts further registrations from it here and writes no row and no ledger event for them.
-- One small table: a row per source and host, so it stays a few rows long however large a host becomes.
-- One idempotent CREATE TABLE: no ALTER of a live table, nothing to rebuild, and a re-run after a crash is a no-op. The boot runner applies
-- it before traffic, so the code that reads the table never ships ahead of it. Nothing is written until a host passes its cap.
-- Rolling back is DROP TABLE agent_directory_registry_overflow and deleting version 47 from nooscape_schema_migrations; the registry
-- counts then read the stored rows alone.
CREATE TABLE IF NOT EXISTS `agent_directory_registry_overflow` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`locatorHost` varchar(255) NOT NULL,
	`overflowCount` int unsigned NOT NULL,
	`lastBlock` int unsigned NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_directory_registry_overflow_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_registry_overflow_key_uq` UNIQUE(`sourceId`,`locatorHost`)
);
