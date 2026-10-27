-- Drops `ingestion_worker_config`.`tickSeconds`, the length of a tick that the operator console set and nothing ever read (docs/worker-operations.md).
-- The code no longer names the column: the schema, the operator input and the write have lost it, and the table's default (900) covers an insert that omits it,
-- so the code runs the same before and after this statement. Run it by hand, once, when it suits (MANUAL_MIGRATIONS lists 49, so the boot never applies it):
-- paste it into the SQL console, then record it in the log. Before recording, read the log (select version, name from nooscape_schema_migrations order by version):
-- the version is bookkeeping, and a 49 that is already there means the next free number is the one to record.
-- Rolling back is ALTER TABLE `ingestion_worker_config` ADD `tickSeconds` int NOT NULL DEFAULT 900; and deleting the log row. The code does not need the column back.
ALTER TABLE `ingestion_worker_config` DROP COLUMN `tickSeconds`;
