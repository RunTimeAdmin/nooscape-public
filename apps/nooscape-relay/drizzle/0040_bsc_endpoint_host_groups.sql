-- BNB endpoint-host groups (migration 0040): the hosts that 50 or more listed BNB entries declare as the host of their first
-- agent address, found by the endpoint-host rule the operator adopted on 2026-10-17. `bsc_endpoint_host_groups` has one row
-- for each such host (two on the 2026-10-16 measurement), with how many listed entries and wallets are behind it and the
-- version and the date of the rule that found it. A shared fact with its date, never a score, a tier or a verdict, and BNB
-- stays directory-only. Nothing public reads it: the map, the key's total and every page read `bsc_clusters` only, so these
-- groups draw no light and change no count (docs/approvals/2026-10-17-bnb-census-report-and-b5-closed.md, decision 4).
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in server/dbMigrations.ts). The owner applies it by
-- pasting this file into the host's SQL console, when they choose. docs/bsc-clusters-2026-10-16.md ("Endpoint-host groups")
-- has the order, the record to insert afterwards, the check and the rollback.
--
-- Review notes:
--   * One new table and nothing else. No ALTER of a live table, no index added to an existing one, no data written, nothing
--     rebuilt: it cannot slow or lock the tables the public reads scan.
--   * CREATE TABLE IF NOT EXISTS, with every index inside it, so running the file again is a no-op.
--   * No foreign keys. Nothing refers to this table and it refers to nothing, so it cannot hold a lock on the registry rows
--     or the directory and can be dropped alone.
--   * A handful of rows at most: only a host shared by 50 or more listed entries is stored.
--   * No TEXT column, so no default is needed, and no nullable column.
--   * Until the table exists the clustering step skips this part alone, says nothing, and carries on with the rest. No other
--     code path reads it. Rolling back is DROP TABLE and deleting version 40 from `nooscape_schema_migrations`.
CREATE TABLE IF NOT EXISTS `bsc_endpoint_host_groups` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`host` varchar(255) NOT NULL,
	`listedCount` int unsigned NOT NULL,
	`walletCount` int unsigned NOT NULL,
	`ruleVersion` varchar(32) NOT NULL,
	`ruleDate` varchar(10) NOT NULL,
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bsc_endpoint_host_groups_id` PRIMARY KEY(`id`),
	CONSTRAINT `bsc_endpoint_host_groups_key_uq` UNIQUE(`sourceId`,`host`)
);
