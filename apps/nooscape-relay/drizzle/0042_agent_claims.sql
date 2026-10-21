-- Claim this agent (migration 0042): the three tables behind the owner claim flow (docs/claims-2026-10-18.md).
--   `agent_claim_nonces`  the nonces the server issued for a message to sign: only the SHA-256 of a nonce, used once, ten minutes to live.
--   `agent_claims`        a claim on a directory entry by the wallet the registry says owns it, and the few things the owner wrote.
--   `agent_claim_edits`   the public history, append-only: each claim, edit (old and new value), freeze, unfreeze and revocation,
--                         in the order they were written (`seq`).
-- A claim is the owner's own word. It is never a tier, a review, a rating or a score, and it changes nothing about whether an entry is
-- listed or where it sits (docs/approvals/2026-10-18-claims.md).
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in server/dbMigrations.ts). The owner applies it by pasting this
-- file into the host's SQL console, when they choose. docs/claims-2026-10-18.md has the order, the record to insert afterwards, the
-- check and the rollback.
--
-- Review notes:
--   * Three new tables and nothing else. No ALTER of a live table, no index added to an existing one, no data written, nothing rebuilt:
--     it cannot slow or lock the tables the public reads scan.
--   * CREATE TABLE IF NOT EXISTS, with every index inside it, so running the file again is a no-op.
--   * No foreign keys. Nothing refers to these tables from another table and they refer to none, so they cannot hold a lock on the
--     directory or the registry rows and can be dropped alone (or one at a time).
--   * One claim in force for an entry: `agent_claims.inForceEntryId` holds the entry's id while the claim is active or frozen and is
--     NULL once it is revoked, and its unique index (MySQL allows many NULLs) refuses a second claim in force.
--   * `agent_claim_edits.seq` is an AUTO_INCREMENT column with its own unique key, because a timestamp is only to the second and the
--     history has to be read in the order it was written. The primary key stays the row's own id.
--   * The nonce times are unix seconds in INT columns and not TIMESTAMPs: the message a wallet signs is rebuilt from them, and a database
--     session's time zone must not be able to change its text.
--   * `agent_claim_nonces_edits_idx` serves the daily count of an agent's edits, so no request scans the table. The worker's daily step
--     deletes nonce rows two days after they expire, so the table does not grow without bound.
--   * No TEXT column, so no default is needed. Every text column is a bounded VARCHAR; the longest is 4,000 characters (the edit a message
--     shows, as JSON) and the next 2,000 (the links, a JSON list of at most five addresses, and the old and new value of an edit).
--   * Rows are few: a claim needs a wallet signature, one claim is in force for an entry, and the history grows by one row for each
--     field an owner changes (at most 20 edits a day for an agent).
--   * Until the tables exist the claim procedures answer "claims are not available", the daily check does nothing and says nothing,
--     and no page changes. Rolling back is DROP TABLE for the three tables and deleting version 42 from `nooscape_schema_migrations`.
CREATE TABLE IF NOT EXISTS `agent_claim_edits` (
	`id` varchar(36) NOT NULL,
	`seq` bigint unsigned AUTO_INCREMENT NOT NULL,
	`claimId` varchar(36) NOT NULL,
	`entryId` varchar(36) NOT NULL,
	`kind` varchar(12) NOT NULL,
	`field` varchar(16),
	`oldValue` varchar(2000),
	`newValue` varchar(2000),
	`wallet` varchar(42),
	`signatureDigest` varchar(64),
	`reason` varchar(32),
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_claim_edits_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_claim_edits_seq_uq` UNIQUE(`seq`),
	INDEX `agent_claim_edits_entry_idx` (`entryId`,`seq`),
	INDEX `agent_claim_edits_claim_idx` (`claimId`,`seq`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_claim_nonces` (
	`id` varchar(36) NOT NULL,
	`nonceHash` varchar(64) NOT NULL,
	`action` varchar(8) NOT NULL,
	`entryId` varchar(36) NOT NULL,
	`wallet` varchar(42) NOT NULL,
	`chainId` int NOT NULL,
	`editText` varchar(4000),
	`issuedAt` int unsigned NOT NULL,
	`expiresAt` int unsigned NOT NULL,
	`usedAt` int unsigned NULL,
	`outcome` varchar(8),
	CONSTRAINT `agent_claim_nonces_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_claim_nonces_hash_uq` UNIQUE(`nonceHash`),
	INDEX `agent_claim_nonces_expiry_idx` (`expiresAt`),
	INDEX `agent_claim_nonces_edits_idx` (`entryId`,`action`,`usedAt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_claims` (
	`id` varchar(36) NOT NULL,
	`entryId` varchar(36) NOT NULL,
	`inForceEntryId` varchar(36),
	`protocol` varchar(16) NOT NULL,
	`chainId` int NOT NULL,
	`registry` varchar(42) NOT NULL,
	`tokenId` varchar(80) NOT NULL,
	`wallet` varchar(42) NOT NULL,
	`status` varchar(12) NOT NULL,
	`claimedAt` timestamp NOT NULL,
	`statusChangedAt` timestamp NOT NULL,
	`lastOwnerCheckAt` timestamp NOT NULL,
	`signatureDigest` varchar(64) NOT NULL,
	`name` varchar(120),
	`website` varchar(300),
	`description` varchar(1000),
	`links` varchar(2000),
	CONSTRAINT `agent_claims_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_claims_in_force_uq` UNIQUE(`inForceEntryId`),
	INDEX `agent_claims_entry_idx` (`entryId`,`claimedAt`),
	INDEX `agent_claims_wallet_idx` (`wallet`,`inForceEntryId`),
	INDEX `agent_claims_check_idx` (`status`,`lastOwnerCheckAt`)
);
