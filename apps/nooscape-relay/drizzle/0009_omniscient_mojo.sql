ALTER TABLE `agent_read_model` ADD `verificationExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `agent_read_model` ADD `verifiedCardHash` varchar(64);--> statement-breakpoint
ALTER TABLE `domain_verification_challenges` ADD `verificationExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `domain_verification_challenges` ADD `recheckedAt` timestamp;--> statement-breakpoint
ALTER TABLE `domain_verification_challenges` ADD `revokedAt` timestamp;
--> statement-breakpoint
-- Reviewed backfill (applied with the one-time operator bridge on 2026-10-08):
-- the single existing verified challenge (self-owned Nooscape Observatory pilot)
-- receives a full 90-day validity window starting at its verification date.
-- The matching agent_read_model copy (validity + verified-card fingerprint)
-- is written by the bridge because the fingerprint is a SHA-256 computed in
-- application code over the newest visible reviewed-run card.
UPDATE `domain_verification_challenges` SET `verificationExpiresAt` = DATE_ADD(`verifiedAt`, INTERVAL 90 DAY) WHERE `state` = 'verified' AND `verifiedAt` IS NOT NULL;