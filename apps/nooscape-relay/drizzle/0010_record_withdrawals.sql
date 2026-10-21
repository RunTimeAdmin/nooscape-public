CREATE TABLE `agent_record_withdrawals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`agentId` varchar(36) NOT NULL,
	`action` enum('withdraw','reinstate') NOT NULL,
	`reason` varchar(1024) NOT NULL,
	`decidedByUserId` int NOT NULL,
	`decidedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_record_withdrawals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `agent_record_withdrawals` ADD CONSTRAINT `agent_record_withdrawals_decidedByUserId_users_id_fk` FOREIGN KEY (`decidedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `agent_record_withdrawals` ADD CONSTRAINT `arw_agent_fk` FOREIGN KEY (`agentId`) REFERENCES `agents`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `agent_record_withdrawals_agent_decided_idx` ON `agent_record_withdrawals` (`agentId`,`decidedAt`);

--> statement-breakpoint
-- Reviewed apply note (2026-10-08): this table ships with the per-record
-- withdrawal capability and is applied in production through the one-time
-- operator bridge (docs/record-withdrawal-2026-10-08.md), which is removed
-- immediately after the apply. The ledger is append-only: no updates and no
-- deletes; the newest event per agent decides public-record visibility.