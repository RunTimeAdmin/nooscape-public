-- BNB Smart Chain ERC-8004 identity registry ingestion (operator-approved design,
-- 2026-10-13; docs/bnb-chain-agents-plan-2026-10-13.md, decisions D1 to D3).
-- Adds the erc8004_bsc protocol for the facts-only pass over the BSC (chain 56)
-- identity registry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432. Enum-only: the
-- pass reuses agent_directory_entries (externalKey = eip155:56:<registry>:<id>,
-- registrant = the Registered event's owner), the generic run/observation
-- tables, and the EVM activity ledger; no new columns. The value is APPENDED to
-- the enum list, which MySQL can apply as a metadata-only change without
-- rebuilding the table (a mid-list insert renumbers the stored values and may
-- force a rebuild; agent_directory_entries holds ~240k rows). All three
-- statements are supersets of the live enum and therefore safe to re-run after
-- a mid-file crash. The source row is registered by the app's preset list as
-- manual_only: nothing runs until an operator stages and runs it from
-- /admin/sources. Applied automatically at boot before traffic.
ALTER TABLE `agent_directory_entries` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc') NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_sources` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc') NOT NULL;--> statement-breakpoint
ALTER TABLE `source_observations` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said','erc8004_bsc') NOT NULL;
