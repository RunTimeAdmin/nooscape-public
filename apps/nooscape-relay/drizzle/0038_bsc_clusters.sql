-- BNB fleets and templates (migration 0038): which registrations of the BNB Chain ERC-8004 registry share a
-- registering wallet, a profile link, a host or a registration template, and what the clustering found about each
-- listed entry (gate G1). `bsc_clusters` has one row for each group, with how many registrations are in it.
-- `bsc_entry_evidence` has one row for each listed entry. Both are shared facts with their dates and never a score, a
-- tier or a verdict (docs/approvals/2026-10-15-informational-use-and-bnb-map.md), and BNB stays directory-only.
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in server/dbMigrations.ts). The owner applies
-- it by pasting this file into the host's SQL console, when they choose. docs/bsc-clusters-2026-10-16.md has the
-- order, the record to insert afterwards, the check and the rollback.
--
-- Review notes:
--   * Two new tables and nothing else. No ALTER of a live table, no index added to an existing one, no data written,
--     nothing rebuilt: it cannot slow or lock the tables the public reads scan.
--   * CREATE TABLE IF NOT EXISTS, with every index inside it, so running the file again is a no-op (a separate
--     CREATE INDEX would fail the second time).
--   * No foreign keys. Nothing refers to these tables and they refer to nothing, so they cannot hold a lock on the
--     registry rows or the directory and can be dropped alone.
--   * `bsc_clusters` holds the groups large enough to be a fleet (50 registrations or more, `FLEET_MIN`) and the
--     groups of two or more listed entries with the same template: a few hundred rows at the first run, and the
--     clustering step replaces them, it does not append. `bsc_entry_evidence` holds one row for each listed entry
--     (6,842 on 2026-10-16).
--   * No TEXT column, so no default is needed. `label` and the other nullable columns are null where they have no
--     meaning.
--   * Until the tables exist the clustering step finds the first one missing, does nothing and says nothing. No other
--     code path reads them. Rolling back is DROP TABLE for both and deleting version 38 from
--     `nooscape_schema_migrations`.
CREATE TABLE IF NOT EXISTS `bsc_clusters` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`clusterKey` varchar(255) NOT NULL,
	`label` varchar(200),
	`memberCount` int unsigned NOT NULL,
	`listedCount` int unsigned NOT NULL,
	`walletCount` int unsigned,
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bsc_clusters_id` PRIMARY KEY(`id`),
	CONSTRAINT `bsc_clusters_key_uq` UNIQUE(`sourceId`,`kind`,`clusterKey`),
	INDEX `bsc_clusters_size_idx` (`sourceId`,`kind`,`memberCount`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bsc_entry_evidence` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`externalKey` varchar(128) NOT NULL,
	`profileUriHash` varchar(64) NOT NULL,
	`readStatus` varchar(24) NOT NULL,
	`templateKey` varchar(16),
	`endpointHost` varchar(255),
	`g1` varchar(32) NOT NULL,
	`templateSize` int unsigned NOT NULL,
	`walletRegistrations` int unsigned NOT NULL,
	`readAt` timestamp NOT NULL DEFAULT (now()),
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bsc_entry_evidence_id` PRIMARY KEY(`id`),
	CONSTRAINT `bsc_entry_evidence_key_uq` UNIQUE(`sourceId`,`externalKey`),
	INDEX `bsc_entry_evidence_template_idx` (`sourceId`,`templateKey`)
);
