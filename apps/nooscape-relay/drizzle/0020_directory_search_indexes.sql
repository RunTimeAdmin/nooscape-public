ALTER TABLE `agent_directory_entries` ADD FULLTEXT INDEX `agent_directory_external_key_ft_idx` (`externalKey`);--> statement-breakpoint
CREATE INDEX `agent_directory_locator_host_idx` ON `agent_directory_entries` (`locatorHost`);--> statement-breakpoint
--- Reviewed apply note (2026-10-11): directory search indexes. The FULLTEXT
--- index serves registry-key searches (catalog ids, ERC-8004 composite keys,
--- Solana mints) with word-boundary semantics; the locatorHost index serves
--- short-query and host prefix matches. Together with the shape-routed query
--- in server/db.ts (wallet prefixes on the existing registrant index), this
--- removes the unconditional leading-wildcard scans of externalKey and
--- registrant that made public search take seconds on the ~222k-row table.
