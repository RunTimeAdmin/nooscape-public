-- How many ratings a chain's ERC-8004 reputation registry holds (docs/extra-chain-ratings-2026-10-21.md).
-- One row for each of the chains the identity pass reads beyond BNB Chain (arc, base, ethereum). The ratings step counts the registry's NewFeedback
-- and FeedbackRevoked events, a window at a time, and stores only the two counts and the block it has read to. No event is kept, so a platform that
-- rates at scale cannot grow the table: it is three rows long however large the registry is.
-- One idempotent CREATE TABLE: no ALTER of a live table, nothing to rebuild, and a re-run after a crash is a no-op. The boot runner applies it
-- (it is not in MANUAL_MIGRATIONS). Production's migration log held 43 to 47 when this was written, so 48 was free; check it before relying on that
-- (docs/flood-host-cap-2026-10-21.md, "What went wrong at the deploy"). The code reads the table in a way that survives its absence: the step does
-- nothing and the figure stays "not measured".
-- The nullable timestamps say NULL, because MariaDB gives a timestamp column that does not say so a default of the current time.
-- Rolling back is DROP TABLE chain_reputation_counts and deleting version 48 from nooscape_schema_migrations; the figure goes back to "not measured".
CREATE TABLE IF NOT EXISTS `chain_reputation_counts` (
	`chainKey` varchar(16) NOT NULL,
	`ratings` int unsigned NOT NULL DEFAULT 0,
	`revocations` int unsigned NOT NULL DEFAULT 0,
	`nextBlock` int unsigned NOT NULL,
	`caughtUpAt` timestamp NULL DEFAULT NULL,
	`lastRunAt` timestamp NULL DEFAULT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `chain_reputation_counts_chainKey` PRIMARY KEY(`chainKey`)
);
