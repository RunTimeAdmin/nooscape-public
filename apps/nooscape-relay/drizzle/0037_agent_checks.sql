-- Agent checks (migration 0037): what Nooscape-Checker found when it asked an endpoint
-- that a reviewed agent declares. One row for each ask: the date, whether it answered
-- (a complete HTTP answer, whatever its status), the status code, how long it took and
-- a fingerprint (SHA-256) of the first 4 KiB of the answer. A row that records no answer
-- or a skipped ask carries the reason instead. It is a fact with its date and never a
-- tier, an order or a verdict (docs/approvals/2026-10-15-informational-use-and-bnb-map.md).
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in
-- server/dbMigrations.ts). The owner applies it by pasting this file into the host's SQL
-- console, when they choose. docs/agent-checks-2026-10-16.md has the order, the record to
-- insert afterwards, the check and the rollback.
--
-- Review notes:
--   * One new table and nothing else. No ALTER of a live table, no index added to an
--     existing one, no data written, nothing rebuilt: it cannot slow or lock the tables
--     the public reads scan.
--   * CREATE TABLE IF NOT EXISTS, with both indexes inside it, so running the file again
--     is a no-op (a separate CREATE INDEX would fail the second time).
--   * No foreign keys. Nothing refers to this table and it refers to nothing, so it
--     cannot hold a lock on `agents` or `agent_endpoints` and can be dropped alone.
--   * Two indexes, each on a column, the kind of check and the date: the latest check of
--     an endpoint (what decides which addresses are due, and what the code filters by
--     kind) and the checks of an agent (what the agent's page will show). With the kind
--     inside the index the latest-check query reads the index alone. At one check a day
--     for each endpoint the table stays small.
--   * No TEXT column, so no default is needed. The reason, status, time and fingerprint
--     are null where they have no meaning (an answer has no reason, a refusal has no
--     status).
--   * Until the table exists, the checks endpoint answers "unavailable" and asks no host
--     anything: which addresses are due is read from this table, so with no table nothing
--     is due and nothing is sent. Rolling back is DROP TABLE `agent_checks` and deleting
--     version 37 from `nooscape_schema_migrations`.
CREATE TABLE IF NOT EXISTS `agent_checks` (
	`id` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`endpointId` varchar(36) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`checkedAt` timestamp NOT NULL DEFAULT (now()),
	`outcome` varchar(16) NOT NULL,
	`reason` varchar(32),
	`statusCode` int,
	`latencyMs` int,
	`bodySha256` varchar(64),
	CONSTRAINT `agent_checks_id` PRIMARY KEY(`id`),
	INDEX `agent_checks_endpoint_idx` (`endpointId`,`kind`,`checkedAt`),
	INDEX `agent_checks_agent_idx` (`agentId`,`kind`,`checkedAt`)
);
