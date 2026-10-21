CREATE TABLE `agent_public_snapshots` (
	`id` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`sourceObservationId` varchar(36) NOT NULL,
	`displayName` varchar(255) NOT NULL,
	`displayHandle` varchar(160) NOT NULL,
	`primaryCapability` varchar(160),
	`untrustedSelfDescription` text,
	`protocols` text NOT NULL,
	`publisherState` enum('allowlisted','expired','revoked','unverified') NOT NULL DEFAULT 'unverified',
	`evidenceTier` enum('tier_0','tier_1','tier_2','tier_3','tier_4') NOT NULL DEFAULT 'tier_2',
	`sourceCount` int NOT NULL DEFAULT 1,
	`observedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_public_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_public_snapshots_source_observation_uq` UNIQUE(`sourceObservationId`)
);
--> statement-breakpoint
CREATE TABLE `identity_merge_reviews` (
	`id` varchar(36) NOT NULL,
	`identityType` enum('a2a_url','anp_url','erc8004','did','domain','wallet','solana_mint','catalog_record') NOT NULL,
	`externalIdHash` varchar(64) NOT NULL,
	`existingAgentId` varchar(36) NOT NULL,
	`proposedAgentId` varchar(36) NOT NULL,
	`sourceObservationId` varchar(36) NOT NULL,
	`state` enum('pending','merged','rejected') NOT NULL DEFAULT 'pending',
	`rationale` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`resolvedAt` timestamp,
	CONSTRAINT `identity_merge_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `identity_merge_reviews_identity_observation_uq` UNIQUE(`identityType`,`externalIdHash`,`sourceObservationId`)
);
--> statement-breakpoint
ALTER TABLE `agent_identities` MODIFY COLUMN `identityType` enum('a2a_url','anp_url','erc8004','did','domain','wallet','solana_mint','catalog_record') NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_public_snapshots` ADD CONSTRAINT `aps_agent_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_public_snapshots` ADD CONSTRAINT `aps_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_public_snapshots` ADD CONSTRAINT `aps_observation_fk` FOREIGN KEY (`sourceObservationId`) REFERENCES `source_observations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `identity_merge_reviews` ADD CONSTRAINT `imr_existing_agent_fk` FOREIGN KEY (`existingAgentId`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `identity_merge_reviews` ADD CONSTRAINT `imr_proposed_agent_fk` FOREIGN KEY (`proposedAgentId`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `identity_merge_reviews` ADD CONSTRAINT `imr_observation_fk` FOREIGN KEY (`sourceObservationId`) REFERENCES `source_observations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `agent_public_snapshots_agent_observed_idx` ON `agent_public_snapshots` (`agentId`,`observedAt`);--> statement-breakpoint
CREATE INDEX `agent_public_snapshots_source_observed_idx` ON `agent_public_snapshots` (`sourceId`,`observedAt`);--> statement-breakpoint
CREATE INDEX `identity_merge_reviews_state_idx` ON `identity_merge_reviews` (`state`,`createdAt`);
