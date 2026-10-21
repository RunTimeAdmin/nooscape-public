-- 8004 Solana agent registry ingestion (operator-approved design, 2026-10-12;
-- docs/8004-solana-chain-2026-10-12.md). Adds the solana_8004 protocol for the
-- chain pass over the QuantuLabs program 8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ
-- (the registry behind solana.com/agent-registry and 8004scan). The source row
-- is registered by the app's preset list as manual_only — nothing runs until an
-- operator activates it from /admin/sources. Enum-only: the pass reuses
-- agent_directory_entries (externalKey = the agent asset pubkey), the
-- per-source agent_solana_activity ledger, and the generic run/observation
-- tables; registrant is already varchar(64) (migration 0021) and closures reuse
-- the assetClosedAt marker (migration 0023). Idempotent guard: the MODIFY is a
-- superset, safe to re-run — MySQL re-maps enum values by string, so inserting
-- solana_8004 ahead of usdg_settlement (like 0018's mid-list insert) renumbers
-- nothing. Applied automatically at boot before traffic.
ALTER TABLE `ingestion_sources` MODIFY `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement') NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_directory_entries` MODIFY `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement') NOT NULL;--> statement-breakpoint
ALTER TABLE `source_observations` MODIFY `protocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement') NOT NULL;
