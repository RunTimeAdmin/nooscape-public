-- ERC-8004 Reputation Registry ingestion (operator-approved design,
-- 2026-10-11; docs/reputation-ingest-2026-10-11.md). Adds the
-- erc8004_reputation protocol and the ratings ledger. The source row itself is
-- registered by the app's preset list as manual_only — nothing runs until an
-- operator drives the backward walk from /admin/sources. Hand-applied via
-- hPanel phpMyAdmin like migrations 0014-0017 (the drizzle journal stops at
-- 0013). Idempotent guards: the enum MODIFY is a superset (safe to re-run) and
-- the table uses CREATE TABLE IF NOT EXISTS.
ALTER TABLE `ingestion_sources` MODIFY `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','usdg_settlement') NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_directory_entries` MODIFY `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','usdg_settlement') NOT NULL;--> statement-breakpoint
ALTER TABLE `source_observations` MODIFY `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','usdg_settlement') NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_reputation_events` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`transactionHash` varchar(66) NOT NULL,
	`logIndex` int NOT NULL,
	`kind` enum('new_feedback','feedback_revoked','response_appended') NOT NULL,
	`blockNumber` int unsigned NOT NULL,
	`agentId` bigint NOT NULL,
	`clientAddress` varchar(42) NOT NULL,
	`feedbackIndex` bigint,
	`valueRaw` decimal(39,0),
	`valueDecimals` int,
	`tag1` varchar(512),
	`tag2` varchar(512),
	`endpoint` varchar(512),
	`feedbackUri` varchar(512),
	`feedbackHash` varchar(66),
	`responderAddress` varchar(42),
	`pairOrdinal` int unsigned,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_reputation_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_reputation_event_uq` UNIQUE(`sourceId`,`transactionHash`,`logIndex`)
);--> statement-breakpoint
ALTER TABLE `agent_reputation_events` ADD CONSTRAINT `agent_reputation_events_sourceId_ingestion_sources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `agent_reputation_agent_idx` ON `agent_reputation_events` (`sourceId`,`agentId`);--> statement-breakpoint
CREATE INDEX `agent_reputation_pair_idx` ON `agent_reputation_events` (`sourceId`,`agentId`,`clientAddress`,`blockNumber`,`logIndex`);--> statement-breakpoint
CREATE INDEX `agent_reputation_feedback_idx` ON `agent_reputation_events` (`sourceId`,`agentId`,`clientAddress`,`feedbackIndex`);--> statement-breakpoint
CREATE INDEX `agent_reputation_block_idx` ON `agent_reputation_events` (`sourceId`,`blockNumber`);
-- Ledger semantics (docs/reputation-ingest-2026-10-11.md §3): ratings are
-- chain-anchored opinion facts. valueRaw keeps the rater's exact int128 with
-- its own valueDecimals — no cross-rater aggregation ever derives from this
-- table. Dynamic strings are untrusted text (capped at decode; URIs are never
-- dereferenced). feedbackIndex is the contract's per-(agentId, clientAddress)
-- 1-indexed counter, emitted by every event kind (wire-verified 2026-10-11:
-- NewFeedback carries it as the first data word, FeedbackRevoked and
-- ResponseAppended as their third indexed topic), so a revocation joins the
-- exact rating it names on (agentId, clientAddress, feedbackIndex) — a rating
-- row is never deleted. pairOrdinal is the recomputed chain-order rank of a
-- NewFeedback row within its pair; rank === feedbackIndex on a complete
-- ledger, and any divergence is the deep-history gap detector checked during
-- reconciliation. Rows are INSERT-IGNORE idempotent on
-- sourceId+transactionHash+logIndex.
