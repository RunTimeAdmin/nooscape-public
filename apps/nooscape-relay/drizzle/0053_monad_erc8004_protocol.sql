-- The Monad ERC-8004 identity pass (migration 0053): adds the protocol value erc8004_monad.
-- The pass reads the identity registry's Registered, Transfer and URIUpdated events on Monad and writes directory entries and registry rows only
-- (docs/monad-erc8004-2026-11-01.md), so the only schema change is the new protocol value on the tables that carry the list.
--
-- This migration is MANUAL: the boot runner skips it (MANUAL_MIGRATIONS in server/dbMigrations.ts). The owner applies it by pasting this file
-- into the host's SQL console, when they choose. docs/monad-erc8004-2026-11-01.md has the order, the record to insert afterwards, the check and the
-- rollback. It is manual, and not applied at boot, for the reason 0051 gives: every statement restates the whole list, and the list now ends with the
-- Base, Ethereum and Arc values that migration 0046 keeps out of every boot, and the AgenC value of 0051, until the owner applies them. Nothing writes
-- the new value until the source is staged, which needs the chain_monad switch on, so the value can exist with nothing using it.
--
-- Review notes:
--   * Run 0046 and 0051 first. This file names their values too, because the list is restated whole, so on a database where either has not been run
--     it would add those as well. Production has both.
--   * Four tables, as in 0046 and 0051: `agent_directory_entries`, `agent_directory_registry_rows`, `ingestion_sources` and `source_observations`. The
--     pass writes directory entries and registry rows under a source row and never an observation, and all four are altered so that the four lists
--     stay one list, as the schema holds it.
--   * The value is APPENDED to the end of the list, as 0030, 0033, 0046 and 0051 did. MySQL can apply that as a metadata-only change, with no rebuild
--     of the table and no copy of its rows (a value put mid-list renumbers the stored values and can force a rebuild). The tables are large, so run it
--     at a quiet moment: even a metadata change waits for queries that are still reading the table.
--   * Every statement writes the whole list, which is a superset of the live one, so running the file again, or after a crash part-way, changes nothing.
--   * No data is written and no index changes.
--   * Rolling back is the same four statements with the earlier list (the one in 0051), then deleting version 53 from `nooscape_schema_migrations`.
--     MySQL cannot drop a value a row still holds, so check first that no row carries the new value (the check is in the doc).
ALTER TABLE `agent_directory_entries` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc','solana_agenc','erc8004_monad') NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_directory_registry_rows` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc','solana_agenc','erc8004_monad') NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_sources` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc','solana_agenc','erc8004_monad') NOT NULL;--> statement-breakpoint
ALTER TABLE `source_observations` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc','solana_agenc','erc8004_monad') NOT NULL;