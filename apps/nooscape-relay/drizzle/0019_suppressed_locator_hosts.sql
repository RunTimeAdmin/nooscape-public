UPDATE `agent_directory_entries` SET `hidden` = true
WHERE `locatorHost` = 'agentrank.info' OR `locatorHost` LIKE '%.agentrank.info';--> statement-breakpoint
--- Reviewed apply note (2026-10-11): domain-wide AgentRank suppression.
--- Migration 0015 hid the exact host 'agentrank.info' only, which let
--- subdomain-hosted rows (api.agentrank.info) stay public. The operator
--- directed a whole-domain rule, so the harvest path now inserts suppressed
--- hosts hidden (server/db.ts SUPPRESSED_LOCATOR_DOMAINS) and the shared
--- visibility predicate also excludes them; this UPDATE is the one-time
--- backfill of rows that already exist.
