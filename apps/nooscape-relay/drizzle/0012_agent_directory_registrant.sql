ALTER TABLE `agent_directory_entries` ADD `registrant` varchar(42);--> statement-breakpoint
CREATE INDEX `agent_directory_registrant_idx` ON `agent_directory_entries` (`registrant`);--> statement-breakpoint
-- Reviewed apply note (2026-10-10): ERC-8004 registering wallets. The column
-- stores the owner address decoded from the on-chain Registered event so the
-- directory can group clone registrations and surface wallets running many
-- agents. An event-anchored chain fact only — never a verified operator
-- identity, and always null for non-chain protocols. Apply through the
-- operator-gated migration bridge before the first registrant-walk run.
