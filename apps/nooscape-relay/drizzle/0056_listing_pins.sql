-- Operator pins for the registry listing (migration 0056; docs/bsc-erc8004-2026-10-13.md, addendum 2026-11-05, step 2 of finding R4 of the outside audit of
-- 2026-11-05). A row here keeps the registry row of the same source and key listed whatever the listing rules say about its link, host, wallet or name, and
-- lists one the rules had held out at the next classification. The operator adds a row by hand (phpMyAdmin) with a note saying why, and removes it to hand
-- the registration back to the rules.
-- One idempotent CREATE TABLE: no ALTER of a live table (the registry rows table holds about 570,000 rows), nothing to rebuild, and a re-run after a crash is
-- a no-op. The boot runner applies it (it is not in MANUAL_MIGRATIONS). Production's migration log held 46 to 55 when this was written, so 56 was free; check
-- it before relying on that (docs/flood-host-cap-2026-10-21.md, "What went wrong at the deploy"). The table starts empty, so nothing changes on the day it ships.
-- Rolling back is DROP TABLE agent_directory_listing_pins and deleting version 56 from nooscape_schema_migrations; the pins stop counting.
CREATE TABLE IF NOT EXISTS `agent_directory_listing_pins` (
	`sourceId` varchar(36) NOT NULL,
	`externalKey` varchar(512) NOT NULL,
	`note` varchar(300) NULL DEFAULT NULL,
	`pinnedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_directory_listing_pins_pk` PRIMARY KEY(`sourceId`,`externalKey`)
);
