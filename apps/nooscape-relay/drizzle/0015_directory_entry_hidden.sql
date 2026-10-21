ALTER TABLE `agent_directory_entries` ADD `hidden` boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE INDEX `agent_directory_hidden_idx` ON `agent_directory_entries` (`hidden`);--> statement-breakpoint
--- Hide entries with dead locator hosts. AgentRank (agentrank.info) is a retired
--- service whose domain no longer resolves; these entries should not appear in
--- public directory search. Scoped narrowly to exactly agentrank.info.
UPDATE `agent_directory_entries` SET `hidden` = true WHERE `locatorHost` = 'agentrank.info';--> statement-breakpoint
--- Reviewed apply note (2026-10-10): directory entry hiding. The column lets
--- operators hide individual directory entries (for example, entries with dead
--- locator hosts like agentrank.info) without revoking the entire source. The
--- index supports efficient filtering of hidden entries from public reads.
--- Default false: existing entries remain visible until explicitly hidden.
--- The UPDATE statement above deterministically hides AgentRank entries (retired
--- service, dead domain) on migration apply. Future hiding uses the operator
--- tRPC mutation (liveData.admin.hideDirectoryEntry / unhideDirectoryEntry).
--- Apply through the operator-gated migration bridge before deploying new code.
