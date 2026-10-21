ALTER TABLE `agent_directory_entries` ADD FULLTEXT INDEX `agent_directory_fulltext_idx` (`displayName`, `locatorHost`);--> statement-breakpoint
--- Reviewed apply note (2026-10-10): directory FULLTEXT search. The composite
--- FULLTEXT index on displayName and locatorHost enables word-boundary matching
--- (so 'kudos' finds 'Agent Consensus Kudos') while remaining index-friendly.
--- The search function uses MATCH() AGAINST() in boolean mode with a wildcard
--- suffix on each word, so partial-word prefixes work and queries like 'agen*'
--- match 'agent' or 'agentry'. For short queries (<3 chars) we still fall back
--- to LIKE for single-char matching. Apply through the operator-gated migration
--- bridge before deploying the updated search function.
