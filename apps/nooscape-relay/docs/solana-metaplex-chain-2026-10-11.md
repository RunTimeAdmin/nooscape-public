# Metaplex Solana registry — on-chain chain activity (2026-10-11)

Status: **LIVE ON MAIN** — shipped, deployed and scheduled 2026-10-11; migration 0021 was applied
automatically by the boot-time migration runner on the evening deploy. The first chain passes ran
with a getMultipleAccounts parsing bug that misread every live asset as closed; §9 is the same-day
postmortem, and the fixes (flat-shape parser, `sync2:` re-seed, migration 0022 ledger purge)
shipped the same evening. §10 records the 2026-10-12 review fixes (hide-once closures via
migration 0023, insert-only API acknowledgements). Every load-bearing fact was live-probed
2026-10-11 and recorded in `SOLANA_INGEST_SPEC.md` (workspace root); byte layouts below cite it
rather than restate it.

## 1. What this adds

The operator's directive ranked Solana sources by payoff: the Metaplex agent registry first
(~1,641 agents, already pulled once via the public REST API), the Solana 8004-style registry
second, SATI last. This change implements the first: the existing API pilot
(`metaplex.ts`, sourceKey `metaplex-solana-agent-registry`, protocol `solana_registry`) is joined
by an on-chain pass that tracks **profile changes and transfers the way the ERC-8004 activity
walk does for Robinhood** — the operator's "quickest win".

| Fact | Value | Verified how |
| --- | --- | --- |
| Identity program | `1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p` | spec §1, gPA full scan |
| MPL Core program | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` | spec §1, getMultipleAccounts |
| Identity PDAs | 1,643 (68 V1 40-byte, 1,575 V2 104-byte) | spec §2 live counts |
| Core facts read | owner (bytes 1..33), name (u32-LE @66), closed (<40 bytes) | spec §3 layout |
| Reputation/Validation programs | declared in source, **not deployed** on mainnet | spec §6 |

## 2. State diff, not an event sweep

URI and plugin edits live on the MPL Core program, whose transaction signatures cover all of
Metaplex — a Core-program signature sweep would drown registry events in unrelated volume.
The spec-verified catch is **re-reading state and diffing it against the source's own directory
rows**: the pass enumerates every identity PDA, batch-reads the referenced Core assets, and
classifies each asset against its prior acknowledged state.

- **register** — live asset with no prior row (from the chain pass's own perspective).
- **transfer** — prior registrant non-null and the Core owner changed. A prior-null registrant
  (the API pilot's shape) means the row was **never chain-acknowledged**: the full chain state
  is adopted silently — neither an owner nor a name difference is a chain event (see §10).
- **profile_update** — the registered name changed.
- **asset_closed** — the account is null or below 40 bytes (closed/burned; the identity PDA
  outlives the asset). A closed asset that was never acknowledged is counted
  (`closedSkippedCount`) and produces no event — nothing was ever acknowledged. A closure of
  an acknowledged agent is acknowledged **exactly once**: the ledger keeps one `asset_closed`
  event, the directory row is marked (`assetClosedAt`) with its last name and owner intact and
  leaves public reads, and every later pass skips it without an event (hide-once, §10). A
  re-registered asset emits a fresh `register` and the live upsert clears the marker.

Every diff event is attributed the asset's **newest successful transaction signature**
(`getSignaturesForAddress`, failed transactions skipped) as its evidence anchor. An asset whose
history shows no successful transaction fails the pass loudly.

## 3. Pass anatomy and cost

One pass = `getSlot` + 1 identity `getProgramAccounts` (~600 KB full scan, spec §7) + batched
`getMultipleAccounts` (100 keys per call, spec-verified maximum) + one signature scan per
event-bearing asset. At probe scale: 1 + 17 + N calls, paced 1.2 s apart
(`SOLANA_RPC_PACING_MS`), ~25 s per pass plus attribution. Growth past a 4,000-asset ceiling
stops the pass loudly rather than widening silently.

The **seed pass** (no `sync2:` cursor — v1 `sync:` cursors do not count, see §9) is a plain
inventory: every live asset is upserted, zero events, cursor set to `sync2:<slot>`. Pre-seed
history is not backfilled — `firstSeenAt` starts at seed date, an honest, documented limitation.

**Bounded deferral:** at most 25 events per pass
(`METAPLEX_CHAIN_MAX_EVENTS_PER_PASS`), each costing one attribution call. A busier day is
processed over consecutive passes: deferred assets are neither evented nor upserted, so their
stale prior state re-diffs next pass. Lossless by construction, bounded by design.

**Fail-closed persistence:** the snapshot (including every attribution) completes before
anything is written; a failure anywhere leaves prior directory state and cursor intact, and the
next pass re-detects the same changes. Ledger writes are INSERT-IGNORE'd on
`(sourceId, transactionSignature, externalKey)` — re-runs can never double-count.

## 4. Storage and search

- `agent_directory_entries.registrant` widens **varchar(42) → 64**: Solana base58 addresses are
  43–44 chars. The existing registrant index survives the MODIFY.
- New `agent_solana_activity` ledger (migration 0021) mirrors the ERC-8004 activity ledger,
  keyed by signature instead of (hash, logIndex). Chain facts only: an owner change says the
  asset moved between wallets, never who operates the agent or whether it works.
- Chain-pass upserts run with `preserveLocatorHost`: chain drafts carry no URL, and the update
  set must never null the `locatorHost` the API pilot wrote.
- Public search: queries matching base58 (`[1-9A-HJ-NP-Za-km-z]{4,44}`) get a registrant
  prefix OR'd into the existing FULLTEXT branch — `0x…` and base58 cannot collide (the base58
  alphabet excludes `0`). Name/host matches are never displaced.

## 5. RPC policy

`ENV.solanaRpcUrl` (default `https://api.mainnet-beta.solana.com`) is the single endpoint for
every Solana adapter (`solanaRpc.ts`): 30 s timeout, 16 MiB cap, JSON-RPC envelope validation,
and a **short** retry ladder (1 s/3 s/8 s on 403/429/5xx) — a scheduled source must never park
the tick, unlike the manual-only Robinhood ladder. The URL carries any provider key, so it
lives only in the environment — never in the database, never in a source row.

Provider status 2026-10-11: a fresh Helius key was verified live against `mainnet.helius-rpc.com`
— all four pass shapes served (getSlot; the full identity `getProgramAccounts`, returning the
spec's exact 1,643 accounts; a 100-key `getMultipleAccounts` batch; a `getSignaturesForAddress`
attribution scan). An earlier Helius key probed the same day returned HTTP 403 on every Helius
host (inactive/unprovisioned). A QuickNode token was also supplied, but it is a `QN_…` panel/API
token, not a full RPC endpoint URL — the instance hostname is still needed before it can be
probed. The public endpoint served every call shape from this machine during recon (~150 calls
at ≥1.2 s spacing, no 429s) and remains the coded default, but it is documented as
not-for-production and throttles per IP: the operator sets `SOLANA_RPC_URL` to the keyed Helius
URL in the Hostinger environment. No code change is needed to swap providers.

## 6. Scheduling and operator controls

- Migration 0021 flips the source `manual_only → scheduled` (15-minute cadence) — but only when
  it is already `active`, and the scheduled worker always runs the **activity** pass. It was
  applied automatically by the boot-time migration runner on the evening deploy (this section's
  original operator-bridge wording was obsolete by then); §9 covers what the first scheduled
  passes then did.
- The scheduled worker case now dispatches `solana_registry` to the chain pass (unattended-safe:
  chain-facts-only reads, idempotent ledger writes, fail-closed persistence).
- Operator console: the existing **Run once** button keeps running the API pilot (observe);
  a new **Fill chain state** button runs the activity pass. A `sync2:` cursor notice reports the
  inventory position. Backfill/registrants modes are rejected server-side with a clear message —
  the walk modes have no Metaplex meaning.
- The chain pass never fetches off-chain content and never writes reviewed records, so its runs
  must never be projected (same rule as the ERC-8004 walk modes).

## 7. Deliberately out of scope (next steps)

The operator's remaining Solana items, in the agreed order: the **8004-solana registry**
(program `8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ`, 1,504 AgentAccounts, 10,634 feedback —
read through the same `solanaRpc.ts` client); **cross-chain identity linking** (~64% of Robinhood
agents claim other chains; some name a Solana id); **x402 payments on Solana** (proof an agent
actually earns); Agenstry/A2A `solana:` address linking; SATI last (dormant, paid indexer).

## 8. Gates

`pnpm check` clean; `pnpm exec vitest run` 22 new tests in `metaplexChain.test.ts` (base58
vectors, V1/V2/closed decoders, envelope validators, signature attribution, silent adoption,
cap-deferral boundaries, seed and diff orchestrator runs against a mocked RPC) alongside the
existing suites; `pnpm build` clean.

## 9. Postmortem — the false-close passes (2026-10-11, same day)

The first scheduled passes ran with a parsing bug that classified **every live asset as
closed**. Symptom: the operator's pass notice read "25 entries refreshed" where a seed-scale
inventory should refresh ~1,640 — 25 is exactly the per-pass event cap. The broken seed
upserted nothing (all "closed"), and each broken diff pass then re-emitted `asset_closed` for
the same lexicographically-first 25 acknowledged rows: INSERT-IGNORE kept the ledger at ~25
fabricated rows while churning those directory rows to placeholder names and null owners. The
source was paused within minutes of the operator's report (a ~7-minute window where those
placeholder names were publicly searchable); no reviewed record was ever touched, and ~215 of
the pilot's 240 rows were never reached — perpetually deferred behind the cap.

Root cause: `getMultipleAccounts` returns each account's tuple **flat on the entry**
(`data`, `executable`, `lamports`, `owner`, `rentEpoch`, `space`), while `getProgramAccounts`
wraps it under `account`. The parser read `entry.account.data` — undefined for every live
asset — and the old fall-through treated "no decodable data" as closed instead of failing
loudly. The suite stayed green because its fixtures inherited the same wrapped shape: hand-built
fixtures must reproduce the exact wire format, or a green suite proves nothing about the accept
path (the same lesson as the ERC-8004 `0x`-prefix fixture bug).

Fixes shipped the same evening, gates re-run clean (check, 24-test suite, build):

- `parseGetMultipleAccountsResponse` reads the flat tuple and **fails the pass loudly** on a
  wrapped or undecodable non-null entry — it can never invent a closure again. Both wire shapes
  are live-verified against Helius (gPA wrapped, gMA flat), and a regression test pins the
  wrapped shape to a thrown error.
- Cursor versioning: only a `sync2:` cursor counts as a completed inventory, so the v1
  `sync:455825920` cursor the broken passes left triggers an automatic re-seed on the fixed
  build's first pass — upserts only, zero events — re-healing the churned rows with real chain
  names and owners.
- Migration 0022 purges the fabricated `asset_closed` ledger rows at boot, before any correct
  pass can exist, so the purge is exact without a slot bound.
- Operator runbook: resume the paused source on /admin/sources; the next pass (worker tick
  within 15 minutes, or **Fill chain state**) should report ~1,63x entries refreshed and a
  `sync2:<slot>` position. While the source is paused, its rows are hidden from public
  search/breakdown by the active-source visibility rule — counts reappear only after resume,
  which is also the external verification signal.

## 10. Review fixes — hide-once closures and insert-only API acknowledgements (2026-10-12)

An external review of the live source confirmed the counts (1,547 public rows = 1,643 enumerated
− 96 closed) and surfaced two structural defects, both shipped as one gated change with
migration 0023 (`agent_directory_entries.assetClosedAt`).

**Closure storms (fixed).** The diff re-emitted `asset_closed` for every acknowledged closed
asset on every pass, each time upserting the row to a placeholder name with a null owner and
consuming one of the 25 per-pass event slots. Since 25 stale closures would defer every other
event forever — the same starvation shape as the §9 incident — closures are now **hide-once**:
the first observation acknowledges one ledger event and marks the row (the row keeps its last
name and owner; the visibility predicate excludes marked rows from every public read), and
later passes see the marker in their prior state and skip the row without an event. A
deferred closure stays unmarked so the next pass re-detects it, and a re-registered asset
clears the marker via its live upsert and returns to public reads.

**API/chain write conflict (fixed).** The API pilot's "Run once" upserted the API's display name
and a null registrant over chain-written rows — the API name differs from the on-chain name for
~128 agents, so the next chain pass would record fabricated `profile_update` events, and a real
transfer between the API click and the next chain pass would be silently adopted (missed)
because the nulled registrant reads as "never chain-acknowledged". The API pilot's directory
acknowledgements are now **insert-only** (INSERT-IGNORE): it may add rows for assets the chain
pass has not acknowledged, but the chain activity pass is the only writer of an acknowledged
row's display name and registrant. The silent-adoption rule now covers the whole row: a
null-registrant prior adopts chain name and owner with no events at all.

**Two-pass tests.** `metaplexChain.test.ts` pins the closure lifecycle across two consecutive
diffs (event once, then skip while a real transfer in the same pass still gets its slot), and
the new `runMetaplex.test.ts` pins the runner wiring: live drafts only in the chain upsert,
`markAgentDirectoryEntriesClosed` called with exactly the closure events' keys (empty on the
second pass), observe-mode upserts insert-only. Gates: tsc clean, 27 files / 220 tests, build
clean.

**Scheduling note (no defect).** A 6:55 PM "stopped running" report was the seed's landing time
(23:55:05Z). The worker claims one source per tick with a 15-minute global interval, so with
two scheduled sources (Metaplex + Robinhood ERC-8004) the effective per-source cadence is ~30
minutes and the two alternate by `nextRunAt` age; the 7:45 PM CT pass refreshed all 1,547 rows
(`lastSeenAt` on every public row) with zero failures. `SOLANA_RPC_URL` stays the operator-set
Helius endpoint from the Hostinger panel — no fallback to the public RPC is in effect.

**Minor:** the wallet-search trigger now requires a real base58 address length (32–44 chars) so
plain search words no longer also run a registrant prefix query. The name offset (66) stays a
spec-verified layout constant with loud-failure decode guards — the production-grade fix is the
`@metaplex-foundation/mpl-core` deserializer, queued with future layout work. The source's
"Boundary" column showing `api.metaplex.com` is the fetch-origin allowlist policy, not a
display label; changing it would break the observe path's origin check, so it stays as-is.
