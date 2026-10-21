-- BNB Chain registry rows, held out of the directory table (operator decision,
-- 2026-10-13: the default directory view is a filtered set of about 6,600
-- registrations, not the 373,567 the BNB Chain ERC-8004 registry holds;
-- docs/bsc-erc8004-2026-10-13.md, sections 4 and 5).
-- A new table instead of columns on agent_directory_entries: the directory table
-- (~240k rows) is scanned by every public aggregate and by search, and 373k
-- extra rows would roughly double each of those. The chain pass writes every
-- registration here, a classification step sets each row's listing state, and
-- only the rows that pass the published rules are published into
-- agent_directory_entries. Same columns as a directory entry plus `listing`.
-- No FULLTEXT index on purpose. The four composite indexes make the per-wallet,
-- per-host, and per-profile-link counts the listing rules need index-only scans.
-- One idempotent CREATE TABLE: no ALTER of a live table, nothing to rebuild, and
-- a re-run after a mid-file crash is a no-op. Applied automatically at boot
-- before traffic.
CREATE TABLE IF NOT EXISTS `agent_directory_registry_rows` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`externalKey` varchar(512) NOT NULL,
	`displayName` varchar(255) NOT NULL,
	`locatorHost` varchar(255),
	`protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc') NOT NULL,
	`sourceSignalNote` varchar(512),
	`registrant` varchar(64),
	`mintBlock` int unsigned,
	`secondaryTransferCount` int unsigned,
	`handoutCount` int unsigned,
	`uriUpdateCount` int unsigned,
	`accountPubkey` varchar(64),
	`profileUriHash` varchar(64),
	`feedbackCount` int unsigned,
	`hidden` boolean NOT NULL DEFAULT false,
	`assetClosedAt` timestamp NULL,
	`firstSeenAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()),
	`lastRunId` varchar(36),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`listing` tinyint unsigned NOT NULL DEFAULT 3,
	CONSTRAINT `agent_directory_registry_rows_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_registry_rows_source_external_uq` UNIQUE(`sourceId`,`externalKey`),
	INDEX `agent_registry_rows_registrant_idx` (`sourceId`,`registrant`),
	INDEX `agent_registry_rows_host_idx` (`sourceId`,`locatorHost`),
	INDEX `agent_registry_rows_profile_idx` (`sourceId`,`profileUriHash`),
	INDEX `agent_registry_rows_listing_idx` (`sourceId`,`listing`),
	CONSTRAINT `agent_directory_registry_rows_sourceId_ingestion_sources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources`(`id`)
);
