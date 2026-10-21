ALTER TABLE `agent_directory_entries` MODIFY COLUMN `registrant` varchar(64);--> statement-breakpoint
CREATE TABLE `agent_solana_activity` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`transactionSignature` varchar(96) NOT NULL,
	`slot` int unsigned NOT NULL,
	`externalKey` varchar(512) NOT NULL,
	`kind` enum('register','transfer','profile_update','asset_closed') NOT NULL,
	`fromOwner` varchar(64),
	`toOwner` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_solana_activity_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_solana_activity_event_uq` UNIQUE(`sourceId`,`transactionSignature`,`externalKey`)
);
--> statement-breakpoint
ALTER TABLE `agent_solana_activity` ADD CONSTRAINT `agent_solana_activity_sourceId_ingestion_sources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `agent_solana_activity_entry_idx` ON `agent_solana_activity` (`sourceId`,`externalKey`);--> statement-breakpoint
CREATE INDEX `agent_solana_activity_slot_idx` ON `agent_solana_activity` (`sourceId`,`slot`);--> statement-breakpoint
UPDATE `ingestion_sources` SET `executionPolicy` = 'scheduled', `scheduleMinutes` = 15, `nextRunAt` = UTC_TIMESTAMP() WHERE `sourceKey` = 'metaplex-solana-agent-registry' AND `state` = 'active' AND `executionPolicy` = 'manual_only';
-- Reviewed apply note (2026-10-11): Metaplex Solana registry chain activity.
-- The registrant column widens 42 -> 64 so Solana base58 addresses (43-44
-- chars) fit beside EVM addresses; the existing registrant index survives the
-- MODIFY. The Solana ledger retains one row per accepted registry event
-- (register/transfer/profile_update/asset_closed), idempotent by
-- sourceId+transactionSignature+externalKey, so per-agent history replays from
-- raw events. Chain facts only: an owner change says the asset moved between
-- wallets, never who operates the agent or whether it works. The UPDATE flips
-- the Metaplex source from the API pilot's manual_only to a 15-minute
-- schedule so the first scheduled pass seeds inventory (cursor "sync:<slot>",
-- zero events); only an already-active source is flipped, and flipping can
-- never touch review/paused/rejected sources. Apply through the operator-gated
-- migration bridge before the first scheduled claim.
