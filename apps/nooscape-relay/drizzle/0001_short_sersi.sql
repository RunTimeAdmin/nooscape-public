CREATE TABLE `agent_endpoints` (
	`id` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`protocol` enum('a2a','anp','agntcy','erc8004') NOT NULL,
	`endpointUrl` varchar(2048) NOT NULL,
	`endpointHash` varchar(64) NOT NULL,
	`authentication` varchar(160),
	`domainVerification` enum('unverified','verified','mismatch') NOT NULL DEFAULT 'unverified',
	`lastHealth` enum('unknown','healthy','unreachable') NOT NULL DEFAULT 'unknown',
	`sourceObservationId` varchar(36) NOT NULL,
	`lastObservedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_endpoints_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_endpoints_url_uq` UNIQUE(`agentId`,`endpointHash`)
);
--> statement-breakpoint
CREATE TABLE `agent_identities` (
	`id` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`identityType` enum('a2a_url','anp_url','erc8004','did','domain','wallet') NOT NULL,
	`externalId` varchar(2048) NOT NULL,
	`externalIdHash` varchar(64) NOT NULL,
	`sourceObservationId` varchar(36) NOT NULL,
	`verificationState` enum('asserted','verified','conflicted') NOT NULL DEFAULT 'asserted',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_identities_external_uq` UNIQUE(`identityType`,`externalIdHash`)
);
--> statement-breakpoint
CREATE TABLE `agent_read_model` (
	`agentId` varchar(36) NOT NULL,
	`displayName` varchar(255) NOT NULL,
	`handle` varchar(160) NOT NULL,
	`primaryCapability` varchar(160),
	`summary` text,
	`protocols` text NOT NULL,
	`publisherState` enum('allowlisted','expired','revoked','unverified') NOT NULL DEFAULT 'unverified',
	`evidenceTier` enum('tier_0','tier_1','tier_2','tier_3') NOT NULL DEFAULT 'tier_2',
	`sourceCount` int NOT NULL DEFAULT 0,
	`lastObservedAt` timestamp NOT NULL DEFAULT (now()),
	`evidenceSummary` text NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_read_model_agentId` PRIMARY KEY(`agentId`)
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` varchar(36) NOT NULL,
	`displayName` varchar(255) NOT NULL,
	`handle` varchar(160) NOT NULL,
	`primaryCapability` varchar(160),
	`summary` text,
	`lifecycle` enum('active','inactive','unknown','conflicted') NOT NULL DEFAULT 'unknown',
	`mapX` int,
	`mapY` int,
	`firstSeenAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agents_id` PRIMARY KEY(`id`),
	CONSTRAINT `agents_handle_uq` UNIQUE(`handle`)
);
--> statement-breakpoint
CREATE TABLE `evidence_events` (
	`id` varchar(36) NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`sourceObservationId` varchar(36) NOT NULL,
	`eventType` varchar(160) NOT NULL,
	`description` text NOT NULL,
	`proofReference` varchar(2048),
	`payloadHash` varchar(64),
	`observedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `evidence_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ingestion_runs` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`trigger` enum('manual','scheduled','replay') NOT NULL,
	`status` enum('running','completed','failed','skipped') NOT NULL,
	`cursorBefore` text,
	`cursorAfter` text,
	`requestCount` int NOT NULL DEFAULT 0,
	`discoveredCount` int NOT NULL DEFAULT 0,
	`acceptedCount` int NOT NULL DEFAULT 0,
	`rejectedCount` int NOT NULL DEFAULT 0,
	`errorSummary` varchar(1024),
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	CONSTRAINT `ingestion_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ingestion_sources` (
	`id` varchar(36) NOT NULL,
	`sourceKey` varchar(64) NOT NULL,
	`label` varchar(160) NOT NULL,
	`protocol` enum('a2a','anp','agntcy','erc8004') NOT NULL,
	`rootUrl` varchar(2048) NOT NULL,
	`allowedHostname` varchar(255) NOT NULL,
	`state` enum('review','active','paused','rejected') NOT NULL DEFAULT 'review',
	`scheduleMinutes` int NOT NULL DEFAULT 15,
	`cursor` text,
	`nextRunAt` timestamp,
	`lastSuccessfulAt` timestamp,
	`failureCount` int NOT NULL DEFAULT 0,
	`lastError` text,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `ingestion_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `ingestion_sources_source_key_uq` UNIQUE(`sourceKey`)
);
--> statement-breakpoint
CREATE TABLE `publisher_bindings` (
	`id` varchar(36) NOT NULL,
	`agentIdentityId` varchar(36) NOT NULL,
	`publisherKeyId` varchar(36) NOT NULL,
	`validationMethod` varchar(255) NOT NULL,
	`sourceObservationId` varchar(36) NOT NULL,
	`validatedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `publisher_bindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `publisher_bindings_identity_key_uq` UNIQUE(`agentIdentityId`,`publisherKeyId`)
);
--> statement-breakpoint
CREATE TABLE `publisher_key_history` (
	`id` varchar(36) NOT NULL,
	`publisherKeyId` varchar(36) NOT NULL,
	`state` enum('allowlisted','expired','revoked') NOT NULL,
	`reason` varchar(1024),
	`changedByUserId` int NOT NULL,
	`changedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `publisher_key_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `publisher_keys` (
	`id` varchar(36) NOT NULL,
	`issuerName` varchar(255) NOT NULL,
	`publicKeyFingerprint` varchar(512) NOT NULL,
	`permittedDomains` text NOT NULL,
	`permittedProtocols` text NOT NULL,
	`state` enum('allowlisted','expired','revoked') NOT NULL DEFAULT 'allowlisted',
	`expiresAt` timestamp,
	`revokedAt` timestamp,
	`policyVersion` varchar(64) NOT NULL,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `publisher_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `publisher_keys_fingerprint_uq` UNIQUE(`publicKeyFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `review_items` (
	`id` varchar(36) NOT NULL,
	`type` enum('source','identity_collision','publisher_key','endpoint_mismatch') NOT NULL,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`subjectType` varchar(64) NOT NULL,
	`subjectId` varchar(36) NOT NULL,
	`rationale` text NOT NULL,
	`createdByUserId` int NOT NULL,
	`decidedByUserId` int,
	`decidedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `review_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `source_observation_runs` (
	`runId` varchar(36) NOT NULL,
	`observationId` varchar(36) NOT NULL,
	`linkedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `source_observation_runs_uq` UNIQUE(`runId`,`observationId`)
);
--> statement-breakpoint
CREATE TABLE `source_observations` (
	`id` varchar(36) NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`protocol` enum('a2a','anp','agntcy','erc8004') NOT NULL,
	`canonicalLocator` varchar(2048) NOT NULL,
	`locatorHash` varchar(64) NOT NULL,
	`contentHash` varchar(64) NOT NULL,
	`rawObjectKey` varchar(512) NOT NULL,
	`contentType` varchar(255) NOT NULL,
	`httpStatus` int,
	`parserVersion` varchar(64) NOT NULL,
	`validationStatus` enum('valid','invalid','partial') NOT NULL,
	`validationFindings` text NOT NULL,
	`observedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `source_observations_id` PRIMARY KEY(`id`),
	CONSTRAINT `source_observations_content_uq` UNIQUE(`sourceId`,`locatorHash`,`contentHash`)
);
--> statement-breakpoint
ALTER TABLE `agent_endpoints` ADD CONSTRAINT `agent_endpoints_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_endpoints` ADD CONSTRAINT `agent_endpoints_sourceObservationId_source_observations_id_fk` FOREIGN KEY (`sourceObservationId`) REFERENCES `source_observations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_identities` ADD CONSTRAINT `agent_identities_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_identities` ADD CONSTRAINT `agent_identities_sourceObservationId_source_observations_id_fk` FOREIGN KEY (`sourceObservationId`) REFERENCES `source_observations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_read_model` ADD CONSTRAINT `agent_read_model_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evidence_events` ADD CONSTRAINT `evidence_events_agentId_agents_id_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `evidence_events` ADD CONSTRAINT `evidence_events_sourceObservationId_source_observations_id_fk` FOREIGN KEY (`sourceObservationId`) REFERENCES `source_observations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ingestion_runs` ADD CONSTRAINT `ingestion_runs_sourceId_ingestion_sources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ingestion_sources` ADD CONSTRAINT `ingestion_sources_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_bindings` ADD CONSTRAINT `publisher_bindings_agentIdentityId_agent_identities_id_fk` FOREIGN KEY (`agentIdentityId`) REFERENCES `agent_identities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_bindings` ADD CONSTRAINT `publisher_bindings_publisherKeyId_publisher_keys_id_fk` FOREIGN KEY (`publisherKeyId`) REFERENCES `publisher_keys`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_bindings` ADD CONSTRAINT `publisher_bindings_sourceObservationId_source_observations_id_fk` FOREIGN KEY (`sourceObservationId`) REFERENCES `source_observations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_key_history` ADD CONSTRAINT `publisher_key_history_publisherKeyId_publisher_keys_id_fk` FOREIGN KEY (`publisherKeyId`) REFERENCES `publisher_keys`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_key_history` ADD CONSTRAINT `publisher_key_history_changedByUserId_users_id_fk` FOREIGN KEY (`changedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publisher_keys` ADD CONSTRAINT `publisher_keys_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `review_items` ADD CONSTRAINT `review_items_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `review_items` ADD CONSTRAINT `review_items_decidedByUserId_users_id_fk` FOREIGN KEY (`decidedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `source_observation_runs` ADD CONSTRAINT `source_observation_runs_runId_ingestion_runs_id_fk` FOREIGN KEY (`runId`) REFERENCES `ingestion_runs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `source_observation_runs` ADD CONSTRAINT `source_observation_runs_observationId_source_observations_id_fk` FOREIGN KEY (`observationId`) REFERENCES `source_observations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `source_observations` ADD CONSTRAINT `source_observations_sourceId_ingestion_sources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `agent_endpoints_agent_idx` ON `agent_endpoints` (`agentId`);--> statement-breakpoint
CREATE INDEX `agent_identities_agent_idx` ON `agent_identities` (`agentId`);--> statement-breakpoint
CREATE INDEX `agent_read_model_freshness_idx` ON `agent_read_model` (`lastObservedAt`);--> statement-breakpoint
CREATE INDEX `evidence_events_agent_observed_idx` ON `evidence_events` (`agentId`,`observedAt`);--> statement-breakpoint
CREATE INDEX `ingestion_runs_source_started_idx` ON `ingestion_runs` (`sourceId`,`startedAt`);--> statement-breakpoint
CREATE INDEX `ingestion_sources_state_next_run_idx` ON `ingestion_sources` (`state`,`nextRunAt`);--> statement-breakpoint
CREATE INDEX `publisher_key_history_key_changed_idx` ON `publisher_key_history` (`publisherKeyId`,`changedAt`);--> statement-breakpoint
CREATE INDEX `review_items_status_created_idx` ON `review_items` (`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `source_observations_source_observed_idx` ON `source_observations` (`sourceId`,`observedAt`);