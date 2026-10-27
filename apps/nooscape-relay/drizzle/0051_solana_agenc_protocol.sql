-- The AgenC Solana agent registry pass (migration 0051): adds the protocol value solana_agenc.
-- The pass reads the AgenC program's AgentRegistration accounts and writes directory entries only (docs/agenc-solana-2026-10-26.md), so the only
-- schema change is the new protocol value on the tables that carry the list.
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in server/dbMigrations.ts). The owner applies it by pasting this file
-- into the host's SQL console, when they choose. docs/agenc-solana-2026-10-26.md has the order, the record to insert afterwards, the check and the
-- rollback. It is manual, and not applied at boot like 0030 and 0033, because every statement restates the whole list and the list now ends with the
-- Base, Ethereum and Arc values that migration 0046 keeps out of every boot until the owner applies it. Nothing writes the new value until the
-- source is staged, so the value can exist with nothing using it.
--
-- Review notes:
--   * Run 0046 first. This file names the Base, Ethereum and Arc values too, because the list is restated whole, so on a database where 0046 has not
--     been run it would add them as well. Production has 0046.
--   * Four tables, as in 0046: `agent_directory_entries`, `agent_directory_registry_rows`, `ingestion_sources` and `source_observations`. The pass
--     writes directory entries under a source row and never a registry row or an observation, and all four are altered so that the four lists stay
--     one list, as the schema holds it.
--   * The value is APPENDED to the end of the list, as 0030, 0033 and 0046 did. MySQL can apply that as a metadata-only change, with no rebuild of the
--     table and no copy of its rows (a value put mid-list renumbers the stored values and can force a rebuild). The tables are large, so run it at a
--     quiet moment: even a metadata change waits for queries that are still reading the table.
--   * Every statement writes the whole list, which is a superset of the live one, so running the file again, or after a crash part-way, changes nothing.
--   * No data is written and no index changes.
--   * Rolling back is the same four statements with the earlier list (the one in 0046), then deleting version 51 from `nooscape_schema_migrations`.
--     MySQL cannot drop a value a row still holds, so check first that no row carries the new value (the check is in the doc).
ALTER TABLE `agent_directory_entries` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc','solana_agenc') NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_directory_registry_rows` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc','solana_agenc') NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_sources` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc','solana_agenc') NOT NULL;--> statement-breakpoint
ALTER TABLE `source_observations` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc','solana_agenc') NOT NULL;
