-- SAID Protocol identity registry ingestion (operator-approved design,
-- 2026-10-13; docs/said-solana-2026-10-13.md). Adds the solana_said protocol
-- for the chain pass over the SAID program
-- 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G. Enum-only: the pass reuses
-- agent_directory_entries (externalKey = the owner wallet, accountPubkey = the
-- AgentIdentity PDA, registrant = the current authority) and the generic
-- run/observation tables; no new columns. The value is APPENDED to the enum
-- list, which MySQL can apply as a metadata-only change without rebuilding
-- the table (a mid-list insert renumbers the stored values and may force a
-- rebuild; agent_directory_entries holds ~226k rows). All three statements
-- are supersets of the live enum and therefore safe to re-run after a
-- mid-file crash. The source row is
-- registered by the app's preset list as manual_only: nothing runs until an
-- operator stages and runs it from /admin/sources. Applied automatically at
-- boot before traffic.
ALTER TABLE `agent_directory_entries` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said') NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_sources` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said') NOT NULL;--> statement-breakpoint
ALTER TABLE `source_observations` MODIFY COLUMN `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','solana_said') NOT NULL;