CREATE TABLE `domain_verification_challenges` (
	`id` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`domain` varchar(255) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`proofUrl` varchar(2048) NOT NULL,
	`state` enum('pending','verified','failed','expired') NOT NULL DEFAULT 'pending',
	`expiresAt` timestamp NOT NULL,
	`verifiedAt` timestamp,
	`proofObjectKey` varchar(512),
	`proofHash` varchar(64),
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `domain_verification_challenges_id` PRIMARY KEY(`id`),
	CONSTRAINT `domain_verification_challenges_token_uq` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `ingestion_worker_config` (
	`id` varchar(32) NOT NULL,
	`state` enum('paused','enabled') NOT NULL DEFAULT 'paused',
	`tickSeconds` int NOT NULL DEFAULT 900,
	`maxSourcesPerTick` int NOT NULL DEFAULT 1,
	`minGlobalIntervalMinutes` int NOT NULL DEFAULT 15,
	`lastStartedAt` timestamp,
	`lastCompletedAt` timestamp,
	`lastError` varchar(1024),
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ingestion_worker_config_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `domain_verification_challenges` ADD CONSTRAINT `domain_verification_challenges_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `domain_verification_challenges` ADD CONSTRAINT `domain_verification_challenges_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ingestion_worker_config` ADD CONSTRAINT `ingestion_worker_config_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `domain_verification_challenges_agent_state_idx` ON `domain_verification_challenges` (`agentId`,`state`);