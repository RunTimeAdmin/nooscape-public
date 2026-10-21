CREATE TABLE `source_projection_decisions` (
	`sourceId` varchar(36) NOT NULL,
	`state` enum('review','public','revoked') NOT NULL DEFAULT 'review',
	`rationale` text NOT NULL,
	`decidedByUserId` int NOT NULL,
	`decidedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `source_projection_decisions_sourceId` PRIMARY KEY(`sourceId`)
);
--> statement-breakpoint
ALTER TABLE `source_projection_decisions` ADD CONSTRAINT `source_projection_decisions_sourceId_ingestion_sources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `source_projection_decisions` ADD CONSTRAINT `source_projection_decisions_decidedByUserId_users_id_fk` FOREIGN KEY (`decidedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;