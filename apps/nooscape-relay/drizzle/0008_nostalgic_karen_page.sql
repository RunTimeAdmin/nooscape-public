ALTER TABLE `source_projection_decisions` ADD `approvedRunId` varchar(36);--> statement-breakpoint
ALTER TABLE `source_projection_decisions` ADD CONSTRAINT `spd_approved_run_fk` FOREIGN KEY (`approvedRunId`) REFERENCES `ingestion_runs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Data migration for the reviewed-run publication gate: seal the already reviewed
-- public state by binding each public decision to its source's latest completed
-- run. Only observations linked to that run stay visible; records the run did not
-- re-observe retire from the public set until a later run is approved explicitly.
UPDATE `source_projection_decisions` SET `approvedRunId` = (SELECT `r`.`id` FROM `ingestion_runs` `r` WHERE `r`.`sourceId` = `source_projection_decisions`.`sourceId` AND `r`.`status` = 'completed' AND `r`.`finishedAt` IS NOT NULL ORDER BY `r`.`finishedAt` DESC, `r`.`startedAt` DESC LIMIT 1) WHERE `state` = 'public' AND `approvedRunId` IS NULL;