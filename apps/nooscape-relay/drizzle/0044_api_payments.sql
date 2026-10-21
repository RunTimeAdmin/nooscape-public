-- API payments (migration 0044): the one table behind pay per call over x402 (docs/data-access-2026-10-19.md, stage D4).
--   `api_payments`  one row for each USDC authorization a caller signed for an API call: who signed it, the nonce they chose, the price,
--                   what it was asked for (a hash), where it stands (settling, open, paid or refused) and the settlement transaction.
-- Payment is a way to ask for a call without a key, never a way to change what is served: it never changes a record, a score, a tier or
-- an evidence level, and a record the site hides is not served to anyone.
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in server/dbMigrations.ts). The owner applies it by pasting this
-- file into the host's SQL console, when they choose. docs/data-access-2026-10-19.md has the order, the record to insert afterwards, the
-- check and the rollback. Pay per call stays off until the owner also sets X402_NETWORK, X402_PAY_TO and X402_API_KEY in the host's
-- environment, so this table can exist for as long as they like with nothing writing to it.
--
-- Review notes:
--   * One new table and nothing else. No ALTER of a live table, no index added to an existing one, no data written, nothing rebuilt:
--     it cannot slow or lock the tables the public reads scan.
--   * CREATE TABLE IF NOT EXISTS, with every index inside it, so running the file again is a no-op.
--   * No foreign keys. Nothing refers to this table from another table and it refers to none, so it can be dropped alone.
--   * `api_payments_authorization_uq` (network, payer, nonce) is the guard that matters: a USDC authorization is identified by the chain,
--     who signed it and the nonce they chose, and the server records it before it asks the facilitator to settle it, so the same
--     authorization is never sent to settle as a new payment twice, not by a retry and not by two requests at once. The chain is in
--     the key so that a testnet payment and a mainnet payment can never be taken for each other.
--   * The signature is never stored. Neither is a network address. The payer's wallet address, the amount, the transaction hash, the
--     endpoint and the time are, because they are the record of a payment that moved money.
--   * `seq` is the order rows were written in (a timestamp is only to the second); the operator's list is read by it, and
--     `api_payments_status_idx` serves the list of payments that are not yet resolved.
--   * No TEXT column, so no default is needed. Every text column is a bounded VARCHAR (the longest is the 200-character reason).
--   * Until the table exists, and until the settings are set, the API answers exactly as it did before this migration: a request over
--     the free limit is told it is limited, and the check without a key is told it needs one. Rolling back is DROP TABLE and deleting
--     version 44 from `nooscape_schema_migrations`.
CREATE TABLE IF NOT EXISTS `api_payments` (
	`id` varchar(36) NOT NULL,
	`seq` bigint unsigned AUTO_INCREMENT NOT NULL,
	`paymentId` varchar(36) NOT NULL,
	`network` varchar(20) NOT NULL,
	`endpoint` varchar(12) NOT NULL,
	`payer` varchar(42) NOT NULL,
	`nonce` varchar(66) NOT NULL,
	`amount` int unsigned NOT NULL,
	`validBefore` bigint unsigned NOT NULL,
	`subjectHash` varchar(64) NOT NULL,
	`status` varchar(10) NOT NULL,
	`transaction` varchar(66),
	`reason` varchar(200),
	`sends` tinyint unsigned NOT NULL DEFAULT 0,
	`serves` tinyint unsigned NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `api_payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_payments_seq_uq` UNIQUE(`seq`),
	CONSTRAINT `api_payments_authorization_uq` UNIQUE(`network`,`payer`,`nonce`),
	INDEX `api_payments_status_idx` (`status`,`seq`)
);
