CREATE TABLE `agent_directory_entries` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`externalKey` varchar(512) NOT NULL,
	`displayName` varchar(255) NOT NULL,
	`locatorHost` varchar(255),
	`protocol` enum('a2a','anp','agntcy','erc8004','catalog','census','solana_registry') NOT NULL,
	`sourceSignalNote` varchar(512),
	`firstSeenAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()),
	`lastRunId` varchar(36),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE now(),
	CONSTRAINT `agent_directory_entries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `agent_directory_entries` ADD CONSTRAINT `agent_directory_entries_sourceId_ingestion_sources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_directory_source_external_uq` ON `agent_directory_entries` (`sourceId`,`externalKey`);--> statement-breakpoint
CREATE INDEX `agent_directory_display_name_idx` ON `agent_directory_entries` (`displayName`);--> statement-breakpoint
CREATE INDEX `agent_directory_last_seen_idx` ON `agent_directory_entries` (`lastSeenAt`);
--> statement-breakpoint
-- Reviewed apply note (2026-10-09): master-directory acknowledgements. The
-- table records every agent a source observed without meeting the evidence
-- bar for a reviewed public record, so search can acknowledge "out there
-- speaking" agents without rating them. Locator-class facts only; entries are
-- upserted per (sourceId, externalKey) on each approved run and never feed the
-- reviewed-run public projection. Apply through the operator-gated migration
-- bridge before the first directory-harvest run.
