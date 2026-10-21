CREATE TABLE `agent_registration_resolutions` (
  `id` varchar(36) NOT NULL,
  `sourceId` varchar(36) NOT NULL,
  `externalKey` varchar(64) NOT NULL,
  `uriHash` varchar(64) NOT NULL,
  `uriKind` varchar(16) NOT NULL,
  `uri` varchar(512) NOT NULL,
  `status` enum('resolved','no_name','failed') NOT NULL,
  `failReason` varchar(200),
  `resolvedName` varchar(200),
  `attempts` int NOT NULL DEFAULT 0,
  `lastAttemptAt` timestamp NOT NULL,
  `fetchedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `agent_registration_resolution_uq` (`sourceId`,`uriHash`),
  INDEX `agent_registration_resolution_status_idx` (`sourceId`,`status`),
  CONSTRAINT `arr_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
);--> statement-breakpoint
CREATE TABLE `agent_directory_chain_links` (
  `id` varchar(36) NOT NULL,
  `sourceId` varchar(36) NOT NULL,
  `externalKey` varchar(64) NOT NULL,
  `metadataKey` varchar(64) NOT NULL,
  `linkedProtocol` enum('a2a','anp','agntcy','erc8004','erc8004_reputation','catalog','census','solana_registry','solana_8004','usdg_settlement','other') NOT NULL,
  `linkedExternalKey` varchar(128) NOT NULL,
  `linkedEntryId` varchar(36),
  `metadataValueHash` varchar(64) NOT NULL,
  `discoveredAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `agent_directory_chain_link_uq` (`sourceId`,`externalKey`,`metadataKey`,`linkedExternalKey`),
  INDEX `agent_directory_chain_link_linked_idx` (`linkedExternalKey`),
  CONSTRAINT `adcl_source_fk` FOREIGN KEY (`sourceId`) REFERENCES `ingestion_sources` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
);--> statement-breakpoint
ALTER TABLE `agent_directory_entries` ADD COLUMN `feedbackCount` int unsigned NULL;--> statement-breakpoint
-- Reviewed apply note (2026-10-12): 8004 step-3 surfaces, migration 0028 —
-- names, twin links, and the ratings counters, probed against the live
-- program before any of it was written.
-- 1. `agent_registration_resolutions`: the record of the budgeted name
--    fetcher (30 URIs per pass, newest-hash first, ~10s timeout, 1 MiB cap,
--    net-guarded, ipfs:// through the configured gateway). Keyed by
--    (sourceId, uriHash) so a hash that already resolved or went terminal
--    no_name is never refetched, while `failed` rows retry up to the attempt
--    cap the adapter tracks in `attempts`. Fetched names are self-asserted
--    locator-class facts — the same posture as the ack layer's inline-decoded
--    names — and the enrichment rule only ever applies them to a row whose
--    chain-decoded name is still the placeholder. Enrichment emits no ledger
--    events; these rows are the record.
-- 2. `agent_directory_chain_links`: upsert-only storage for the program's
--    MetadataEntryPda cross-chain references. Probe finding (2026-10-12, all
--    36 live accounts): the vocabulary is free-form tags, not the hoped
--    `eip155:4663:<registry>:<id>` — the single `chain-registrations` row
--    holds the summary string "5-chains", and machine-readable ids live under
--    ad-hoc keys (`erc8004-eth: #25045`, `erc8004-base: #17483`,
--    `erc8004-anet: #18709`, `agentproof-avalanche: #1718`,
--    `acp-virtuals: #17681`, all on one asset). A bare "#25045" names nothing
--    without the key that scopes its registry, so `metadataKey` joins the
--    uniqueness key. `linkedEntryId` resolves only when exactly one
--    acknowledged directory entry carries the value verbatim; today that
--    matches zero rows — the Robinhood twin of asset fx6DUWG1cfvvwaDgWhfQHyd
--    sbdYVbgg1aJuYDskmTv9 has no on-chain metadata row — so v1 stores claims
--    and matches nothing rather than guessing a join. Upsert-only: nothing
--    un-links.
-- 3. `agent_directory_entries.feedbackCount`: the AgentAccount's live
--    feedback counter, decoded from bytes the pass already fetches (first
--    reputation window's u64 count). Live probe: total 10,634 across 1,173
--    agents with feedback (max 1,892) — an exact match to the reviewed
--    census; the response and revoke windows decode to zero census-wide and
--    are noted, not stored. Count changes fire no ledger event; the
--    per-rating event walk (GiveFeedback disc 91887b03d7a56229, non-trivial
--    arg layout, three byte-identical bot transactions on a ~24 h cadence in
--    the probe) stays follow-up work.
-- Backfill semantics: the column starts NULL and is written by each row's
-- next live 8004 pass (every live account is enumerated, so one pass
-- repopulates the whole source). Both new tables start empty and are
-- populated by the same pass. Every other protocol is unaffected.
