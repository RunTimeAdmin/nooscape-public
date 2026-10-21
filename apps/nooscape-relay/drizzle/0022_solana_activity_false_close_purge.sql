-- 2026-10-11 incident cleanup (docs/solana-metaplex-chain-2026-10-11.md §9).
-- The build that shipped migration 0021 read getMultipleAccounts entries through
-- a wrapped `.account.data` path, but that method returns the account tuple flat
-- on the entry, so its passes classified every live asset as closed and
-- acknowledged fabricated `asset_closed` events into this ledger. No correct
-- pass ran before the fixed build deployed, and this migration runs at that
-- deploy's boot — before the fixed code can serve a single pass — so every
-- `asset_closed` row for this source is one of the fabrications. The bound is
-- therefore the source and kind, not a slot number: the purge is exact however
-- many broken passes ran, and genuine close events (writable only by the fixed
-- build, from later slots) cannot exist yet. The directory rows those passes
-- churned are re-healed by the fixed build's next pass: the v1 `sync:` cursor
-- no longer counts as an inventory, so the pass re-seeds (upserts only, zero
-- events).

DELETE FROM `agent_solana_activity`
WHERE `kind` = 'asset_closed'
	AND `sourceId` = (
		SELECT `id` FROM `ingestion_sources` WHERE `sourceKey` = 'metaplex-solana-agent-registry'
	);
