-- Three more chains for the ERC-8004 identity pass (migration 0046): Base (erc8004_base), Ethereum (erc8004_eth) and Arc (erc8004_arc).
-- The pass reads each chain's identity registry (docs/multichain-erc8004-2026-10-20.md). It reuses the tables the BNB Chain pass already writes
-- (registry rows, directory entries, the run and observation tables), so the only schema change is the new protocol values.
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in server/dbMigrations.ts). The owner applies it by pasting this file
-- into the host's SQL console, when they choose. docs/multichain-erc8004-2026-10-20.md has the order, the record to insert afterwards, the check
-- and the rollback. Nothing uses a new value until a chain's switch is on and its source is staged, so the values can exist with nothing writing them.
--
-- Review notes:
--   * Four tables, not three. 0033 extended the protocol enum on `agent_directory_entries`, `ingestion_sources` and `source_observations`. 0034 then
--     created `agent_directory_registry_rows` with the same list, and the pass writes every registration there first. A value missing from that table
--     would fail the first insert of a run.
--   * Each value is APPENDED to the end of the list, as 0033 did. MySQL can apply that as a metadata-only change, with no rebuild of the table and no
--     copy of its rows (a value put mid-list renumbers the stored values and can force a rebuild). The tables are large (agent_directory_registry_rows
--     holds most of the BNB Chain registry), so run it at a quiet moment: even a metadata change waits for queries that are still reading the table.
--   * Every statement writes the whole list, which is a superset of the live one, so running the file again, or after a crash part-way, changes nothing.
--   * No data is written and no index changes.
--   * Rolling back is the same four statements with the earlier list (the one in 0033), then deleting version 46 from `nooscape_schema_migrations`.
--     MySQL cannot drop a value a row still holds, so check first that no row carries a new value (the check is in the doc).
ALTER TABLE `agent_directory_entries` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc') NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_directory_registry_rows` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc') NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_sources` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc') NOT NULL;--> statement-breakpoint
ALTER TABLE `source_observations` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc') NOT NULL;
