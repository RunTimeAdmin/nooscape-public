CREATE TABLE `agent_directory_chain_activity` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`transactionHash` varchar(66) NOT NULL,
	`logIndex` int NOT NULL,
	`kind` enum('mint','secondary','uri_update') NOT NULL,
	`blockNumber` int unsigned NOT NULL,
	`externalKey` varchar(512) NOT NULL,
	`fromAddress` varchar(42),
	`toAddress` varchar(42),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_directory_chain_activity_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_directory_activity_event_uq` UNIQUE(`sourceId`,`transactionHash`,`logIndex`)
);
--> statement-breakpoint
ALTER TABLE `agent_directory_entries` ADD `mintBlock` int unsigned;--> statement-breakpoint
ALTER TABLE `agent_directory_entries` ADD `secondaryTransferCount` int unsigned;--> statement-breakpoint
ALTER TABLE `agent_directory_entries` ADD `handoutCount` int unsigned;--> statement-breakpoint
ALTER TABLE `agent_directory_entries` ADD `uriUpdateCount` int unsigned;--> statement-breakpoint
ALTER TABLE `agent_directory_chain_activity` ADD CONSTRAINT `agent_directory_chain_activity_sourceId_ingestion_sources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `agent_directory_activity_entry_idx` ON `agent_directory_chain_activity` (`sourceId`,`externalKey`);--> statement-breakpoint
CREATE INDEX `agent_directory_activity_block_idx` ON `agent_directory_chain_activity` (`sourceId`,`blockNumber`);
-- Reviewed apply note (2026-10-10): ERC-8004 chain activity. The ledger retains
-- one row per accepted Transfer/URIUpdated event (idempotent by
-- sourceId+transactionHash+logIndex) so per-agent rollups replay from raw
-- events; the entry columns (mintBlock, secondaryTransferCount, handoutCount,
-- uriUpdateCount) stay NULL until the activity walk covers the agent — null is
-- "not measured yet", never zero. Ownership counts are locator facts only: a
-- hand-out within 36,000 blocks of minting (~1 h at the observed ~0.1 s/block)
-- is a platform distribution, not a sale, and none of it says who operates the
-- agent or whether it works. Apply through the operator-gated migration bridge
-- before the first activity-walk run.