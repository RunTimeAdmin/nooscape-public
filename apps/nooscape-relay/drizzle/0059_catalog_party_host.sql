-- The host a catalog entry points at, kept on its public snapshot (migration 0059, docs/catalog-party-rule-2026-11-07.md).
-- A registry run leaves out a party that another source's public record already holds. It read that from the endpoint rows, and a catalog record
-- carries none on purpose, so between catalog sources the rule saw nothing and the same agent was published once for each source that lists it.
-- This adds one nullable column, `partyHost`, written for every catalog record from the host of its card and read by the lookup beside the endpoint
-- rows. Nothing else reads it, and a null reads as "no host", so a row that has none changes nothing.
-- The boot runner applies it before traffic, so the code that reads the column never ships ahead of it. The table holds hundreds of rows and the ALTER
-- adds a nullable column, so it is quick.
-- The second statement fills the column for the Agenstry feed's records, whose identity is `<source id>:<host of the entry>`, so the rule holds for them
-- from the first run after the deploy. The registries' records are left null: the host of their card is in the stored object and not in the database, so
-- a registry's rows get their host the next time that source runs and an operator publishes the run (docs/catalog-party-rule-2026-11-07.md, "What is left").
-- Rolling back is ALTER TABLE agent_public_snapshots DROP COLUMN partyHost and deleting version 59 from nooscape_schema_migrations; the lookup (the code
-- before this change) then reads the endpoint rows alone.
ALTER TABLE `agent_public_snapshots` ADD `partyHost` varchar(255);--> statement-breakpoint
UPDATE `agent_public_snapshots` AS `p` INNER JOIN `source_observations` AS `o` ON `o`.`id` = `p`.`sourceObservationId` INNER JOIN `agent_identities` AS `i` ON `i`.`agentId` = `p`.`agentId` AND `i`.`identityType` = 'catalog_record' SET `p`.`partyHost` = LOWER(SUBSTRING(`i`.`externalId`, LOCATE(':', `i`.`externalId`) + 1)) WHERE `o`.`parserVersion` LIKE 'agenstry-catalog-%' AND `p`.`partyHost` IS NULL;
