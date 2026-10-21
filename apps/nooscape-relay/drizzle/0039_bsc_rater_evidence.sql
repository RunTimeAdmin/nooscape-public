-- BNB rater credibility (migration 0039): the feedback the BNB Chain ERC-8004 reputation registry has recorded, and what the
-- rater check found about each rated agent (gate G4 of AUTO_REVIEW_PLAN.md). `bsc_feedback_events` has one row for each
-- NewFeedback or FeedbackRevoked event. `bsc_rater_evidence` has one row for each rated agent: how many raters it has, how many
-- are discounted and why, and how many independent ones are left. `bsc_reputation_state` is one row: where the read stands.
-- All of it is internal supporting evidence with its date, never a score, a rank or a verdict, and never a reason on its own to
-- promote anything (docs/approvals/2026-10-15-informational-use-and-bnb-map.md). Nothing public reads it.
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in server/dbMigrations.ts). The owner applies it by
-- pasting this file into the host's SQL console, when they choose. docs/bsc-rater-credibility-2026-10-16.md has the order, the
-- record to insert afterwards, the check and the rollback.
--
-- Review notes:
--   * Three new tables and nothing else. No ALTER of a live table, no index added to an existing one, no data written, nothing
--     rebuilt: it cannot slow or lock the tables the public reads scan.
--   * CREATE TABLE IF NOT EXISTS, with every index inside it, so running the file again is a no-op.
--   * No foreign keys. Nothing refers to these tables and they refer to nothing, so they cannot hold a lock on the registry rows
--     or the directory and can be dropped alone. The existing Robinhood ledger (`agent_reputation_events`) is not touched or
--     shared: agent ids on the two chains collide.
--   * `bsc_feedback_events` holds about 30,000 rows on 2026-10-16 (29,994 ratings and 1 revocation from 130 wallets) and grows
--     with the registry's feedback, which has slowed to a handful of events a day. `bsc_rater_evidence` holds one row for each
--     rated agent (4,467 on 2026-10-16).
--   * No TEXT column, so no default is needed. The nullable columns are null where they have no meaning (a revocation has no
--     value).
--   * Until the tables exist the rater step finds the first one missing, does nothing, asks the chain nothing and says nothing.
--     No other code path reads them. Rolling back is DROP TABLE for all three and deleting version 39 from
--     `nooscape_schema_migrations`.
CREATE TABLE IF NOT EXISTS `bsc_feedback_events` (
	`id` varchar(36) NOT NULL,
	`transactionHash` varchar(66) NOT NULL,
	`logIndex` int NOT NULL,
	`kind` varchar(16) NOT NULL,
	`blockNumber` int unsigned NOT NULL,
	`agentId` bigint NOT NULL,
	`clientAddress` varchar(42) NOT NULL,
	`feedbackIndex` bigint,
	`valueRaw` varchar(40),
	`valueDecimals` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bsc_feedback_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `bsc_feedback_event_uq` UNIQUE(`transactionHash`,`logIndex`),
	INDEX `bsc_feedback_agent_idx` (`agentId`),
	INDEX `bsc_feedback_client_idx` (`clientAddress`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bsc_rater_evidence` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`externalKey` varchar(128) NOT NULL,
	`agentId` bigint NOT NULL,
	`rawEvents` int unsigned NOT NULL,
	`rawRaters` int unsigned NOT NULL,
	`concentratedRaters` int unsigned NOT NULL,
	`uniformRaters` int unsigned NOT NULL,
	`linkedRaters` int unsigned NOT NULL,
	`independentRaters` int unsigned NOT NULL,
	`weightedEvents` int unsigned NOT NULL,
	`ownerRegistrations` int unsigned NOT NULL,
	`ownerFleet` boolean NOT NULL,
	`qualifies` boolean NOT NULL,
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bsc_rater_evidence_id` PRIMARY KEY(`id`),
	CONSTRAINT `bsc_rater_evidence_key_uq` UNIQUE(`sourceId`,`externalKey`),
	INDEX `bsc_rater_evidence_qualifies_idx` (`sourceId`,`qualifies`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bsc_reputation_state` (
	`id` varchar(16) NOT NULL,
	`nextBlock` int unsigned NOT NULL,
	`finalizedBlock` int unsigned,
	`implementation` varchar(42),
	`evaluatedAt` timestamp,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bsc_reputation_state_id` PRIMARY KEY(`id`)
);
