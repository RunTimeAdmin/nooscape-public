ALTER TABLE `agent_read_model` MODIFY COLUMN `evidenceTier` enum('tier_0','tier_1','tier_2','tier_3','tier_4') NOT NULL DEFAULT 'tier_2';--> statement-breakpoint
ALTER TABLE `publisher_key_history` MODIFY COLUMN `state` enum('pending','allowlisted','expired','revoked') NOT NULL;--> statement-breakpoint
ALTER TABLE `publisher_keys` MODIFY COLUMN `state` enum('pending','allowlisted','expired','revoked') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `publisher_keys` ADD `publicKeyPem` text;--> statement-breakpoint
ALTER TABLE `publisher_keys` ADD `attestationObjectKey` varchar(512);--> statement-breakpoint
ALTER TABLE `publisher_keys` ADD `attestationHash` varchar(64);--> statement-breakpoint
ALTER TABLE `publisher_keys` ADD `attestationSignature` text;--> statement-breakpoint
ALTER TABLE `publisher_keys` ADD `rotationOfKeyId` varchar(36);--> statement-breakpoint
ALTER TABLE `publisher_keys` ADD `rotationProofHash` varchar(64);--> statement-breakpoint
ALTER TABLE `publisher_keys` ADD `approvedByUserId` int;--> statement-breakpoint
ALTER TABLE `publisher_keys` ADD `approvedAt` timestamp;--> statement-breakpoint
ALTER TABLE `publisher_keys` ADD CONSTRAINT `publisher_keys_approvedByUserId_users_id_fk` FOREIGN KEY (`approvedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;