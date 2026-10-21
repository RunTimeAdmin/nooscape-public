CREATE TABLE `agent_directory_usdg_settlements` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`transactionHash` varchar(66) NOT NULL,
	`logIndex` int NOT NULL,
	`blockNumber` int unsigned NOT NULL,
	`payerAddress` varchar(42) NOT NULL,
	`payeeAddress` varchar(42) NOT NULL,
	`relayerAddress` varchar(42) NOT NULL,
	`valueRaw` decimal(30,0) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_directory_usdg_settlements_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_directory_usdg_settlement_uq` UNIQUE(`sourceId`,`transactionHash`,`logIndex`)
);
--> statement-breakpoint
ALTER TABLE `agent_directory_usdg_settlements` ADD CONSTRAINT `agent_directory_usdg_sourceId_ingestion_sources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ingestion_sources` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','catalog','census','solana_registry','usdg_settlement') NOT NULL;--> statement-breakpoint
ALTER TABLE `source_observations` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','catalog','census','solana_registry','usdg_settlement') NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_directory_entries` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','catalog','census','solana_registry','usdg_settlement') NOT NULL;--> statement-breakpoint
CREATE INDEX `agent_directory_usdg_settlement_block_idx` ON `agent_directory_usdg_settlements` (`sourceId`,`blockNumber`);
-- Reviewed apply note (2026-10-10): USDG settlement ledger. EIP-3009 on the
-- canonical Robinhood Chain Global Dollar (0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,
-- Blockscout-verified) has no dedicated transfer event: each settlement emits
-- AuthorizationUsed paired with the ERC-20 Transfer it spent, so the adapter
-- keys one row on the AuthorizationUsed log (idempotent by
-- sourceId+transactionHash+logIndex) and decodes payer/payee/value/relayer from
-- the same receipt, asserting authorizer == Transfer.from. valueRaw keeps the
-- raw 6-decimal amount exact — dollars are derived at render, never stored.
-- Rail facts only: the 2026-10-10 attribution probe found zero overlap between
-- settlement participants (368 payers, sampled payees and relayers) and the
-- top-12 registering wallets, so per the census-integrity gate no per-agent
-- attribution ships from this ledger; public reads expose rail totals and the
-- attribution question stays an open known-unknown until facilitator APIs make
-- it unambiguous. The protocol enum extension follows the 0005/0006 precedent:
-- only the three full-list tables gain usdg_settlement (agent_endpoints is
-- untouched, exactly as solana_registry was). Apply through the operator-gated
-- migration bridge before the first settlement-walk run; the bridge is removed
-- in the follow-up commit. Applied note (2026-10-10): the foreign-key
-- constraint name is the shortened 53-char form — the drizzle-conventional
-- 65-char name exceeded MySQL's 64-char identifier limit (error 1059) on the
-- first apply attempt, which created the table and stopped; the bridge applies
-- items idempotently against information_schema so the corrected items
-- complete the migration without re-running the table create.
