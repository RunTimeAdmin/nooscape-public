# SAID Protocol identity registry: on-chain directory pass (2026-10-13)

Status: **SHIPPED AND SEEDED (2026-10-13); scheduled refresh added by migration 0031.** Operator-approved
scope: directory-only, chain facts only, no SAID-computed scores, no paid endpoints. The source ships
`manual_only` at birth. An operator staged it, approved it, and ran the seed pass (13,313 of 13,313
enumerated identities acknowledged, cursor `said:456494102`). Migration 0031 then moved it to the scheduler
at a 60-minute cadence, so the directory refreshes itself and no one presses **Fill chain state**.

## 1. What this adds

A chain pass over the SAID Protocol program, acknowledging every registered agent identity into the master
directory (`agent_directory_entries`) the way the 8004 and Metaplex passes do. It reads Solana mainnet
only. It writes no reviewed record, no agent, no snapshot, and no evidence event, so no run of this source
can ever be projected.

| Fact | Value | Verified how |
| --- | --- | --- |
| Program | `5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G` (source: github.com/SAID-Protocol/said, MIT) | `getAccountInfo`, executable upgradeable program |
| Accounts | 13,794 total: 13,313 AgentIdentity, 451 ReceiptAnchor, 18 WalletLink, 8 AgentStake, 2 AgentReputation, 1 Treasury, 1 unmatched | full `getProgramAccounts` census, discriminators mapped to struct names by `sha256("account:<Name>")[..8]` |
| Identity key | PDA seeded `["agent", owner]`, so the owner wallet is the natural key | `lib.rs` account constraints |
| Closure | AgentIdentity is never closed by the program (only WalletLink has `close =`) | `lib.rs` |
| Cost of a pass | 2 requests, one ~8 MB response, 2.1 s measured against the public RPC | live run of the real adapter, 2026-10-13 |

## 2. Verified account layout (three versions)

The program was upgraded twice, and Anchor never resizes existing accounts, so three fixed account sizes
coexist. All 13,313 identities decode strictly under exactly one of them.

| Version | Bytes | Accounts | Registered | Fields after the 8-byte discriminator |
| --- | --- | --- | --- | --- |
| v1 | 263 | 1,156 | 2026-02-01 to 2026-03-03 | owner, metadata_uri, created_at, is_verified, verified_at, bump |
| v2 | 295 | 1,635 | 2026-03-05 to 2026-04-13 | v1 with `authority` after owner |
| v3 | 342 | 10,522 | 2026-04-13 onward | v2 plus verification_tier, stake_amount, staked_at, slash_count, last_slashed_at, last_receipt_seq, last_anchor_index |

Two findings shaped the decoder:

- **Borsh serializes a String as its length plus only its actual bytes.** The 200 byte `max_len` is
  allocation, not serialization, so every field after `metadata_uri` sits at a variable offset. A first
  decode that assumed a fixed 204 byte string produced 1970 dates and all-false flags; the corrected
  decode walks the offsets. A `created_at` outside 2025-01-01 to now+1 day now fails the decode as a
  misread layout.
- **24 of 10,522 v3 accounts carry non-zero bytes past the last field.** That is stale Anchor residue left
  when an update shortened the URI. It is counted and never parsed.

The layout was proven three ways before any adapter code existed: (1) a Python decode of every live
account, (2) the same fixtures decoded by the TypeScript decoder and compared to the Python values, and
(3) a cross-check against SAID's own free API. For all 13,313 on-chain identities the API agrees on the
PDA, the metadata URI, and the verified flag. The API's `registeredAt` differs from the chain's
`created_at` for 338 of them; the API timestamp is its own indexing time and the chain value is
authoritative. 73 API records have no on-chain account (off-chain registrations) and are out of scope.

## 3. How the pass works

`server/ingestion/saidChain.ts` (decode and adapter), `runSaid.ts` (orchestrator on the shared
`withIngestionRun`).

1. `getSlot`, then one `getProgramAccounts` filtered by `memcmp` on the AgentIdentity discriminator
   (`2wNAF3KUSPq` in base58), so the other account families are never downloaded.
2. Strict decode, fail closed: exact length selects the layout; discriminator, bool and Option tags,
   string bounds (the program's own 200 byte limit), UTF-8 validity, and the `created_at` window are
   enforced. An identity-discriminated account that fails decode fails the whole pass.
3. Duplicate owners fail the pass (PDA seeds make that impossible on a faithful read). More than 40,000
   identities fails the pass (the approved ceiling).
4. **Enumeration floor.** After the seed, a listing under 98% of the prior pass's identities fails the pass.
   A truncated provider response must never read as a shrinking registry.
5. **No closures.** Because the program never closes an identity, a prior identity missing from a listing
   that is inside the floor is counted in the run result (`rejectedCount`) and never hidden. This replaces
   the 8004 pass's disappearance-based hide-once logic.
6. Upsert into `agent_directory_entries`, then persist cursor `said:<slot>` only after the whole snapshot
   succeeded. A failure leaves the cursor untouched.

Directory mapping:

| Column | Value |
| --- | --- |
| `externalKey` | owner wallet (the PDA seed) |
| `registrant` | current authority (equals owner on v1, which records none) |
| `accountPubkey` | the AgentIdentity PDA |
| `locatorHost` | host of an `https://` metadata URI, null for `ipfs://` |
| `profileUriHash` | SHA-256 of the full metadata URI |
| `displayName` | `SAID agent <first 8 of owner>` (the chain carries no name) |
| `sourceSignalNote` | layout version, registration date, badge, v3 stake and slash count |

## 4. What is deliberately not ingested

- **SAID's computed values.** `trustScore`, `reputationScore`, tiers, and EigenTrust live off chain in SAID's
  API and are SAID's own judgement. Invariant 14 forbids carrying a score Nooscape did not compute. They
  are not read.
- **The paid `/api/screen` endpoint** (0.001 USDC over x402). Payment-gated sources need explicit approval
  and none is requested.
- **`is_verified` as verification.** It is a badge bought for 0.01 SOL or granted by a sponsor. The note
  says "paid or sponsored, not an identity check" and nothing in the directory presents it as one.
- **Metadata cards.** The pass never dereferences a metadata URI. 12,962 of 13,313 point at SAID's own
  card host, which is mutable off chain. (From 2026-10-18 a separate worker step reads the cards for their
  names, a few at a time: see [the decision record](./approvals/2026-10-18-said-names.md).)
- **The other account families** (451 ReceiptAnchor, 18 WalletLink, 8 AgentStake, 2 AgentReputation,
  1 Treasury, and one account with an unmatched discriminator `184662bf3a907b9e`). v3 identities already
  carry the stake and slash facts inline.

## 5. Known limits and follow-ups

1. **Activity ledger.** Built in phase 2a (section 10) and shown publicly in phase 2b (section 11).
   Only changes the pass can anchor to a transaction are ledgered; the rest are adopted and counted.
2. **Placeholder names.** 13,313 rows named `SAID agent <wallet prefix>` search poorly by name. Real names
   exist in SAID's list API (13,386 records, roughly 19 MB per full listing), which would be its own
   source approval. Not requested here. *Update 2026-10-18: the names are read from the cards the identities'
   own links name instead, by the worker step in `server/saidNames.ts`, and the pass lays them over its
   drafts so its hourly rewrite keeps them (see [the decision record](./approvals/2026-10-18-said-names.md)).
   The list API was not used.*
3. **Badge and stake changes fire no event.** The ledger has no kind for them. They refresh the note.
4. **Response size.** The identity listing is ~8 MB against the shared client's 16 MiB cap. Growth
   (~1.8k identities a month) reaches the cap in roughly six months, and the pass then fails loudly.
   The remedy is to split the call by account size (`dataSize` filters 263, 295, 342), which keeps the
   largest bucket at the v3 population.
5. **Provider.** Production reads use the keyed endpoint from `SOLANA_RPC_URL`. The public mainnet RPC
   served the filtered call in testing but is documented as not intended for production.

## 6. Rollout

1. Merge. At boot, migration `0030` appends `solana_said` to the three protocol enums (metadata-only,
   re-runnable) before traffic is served.
2. An operator stages **SAID Solana registry** on /admin/sources, approves it with a rationale, and runs
   **Fill chain state** once. Expect 13,313 or more acknowledged identities and a run note of
   layouts 1,156 / 1,635 / 10,522 (plus any registrations since 2026-10-13).
3. Review the directory counts against a fresh census before any scheduling.
4. The scheduled flip is a separate reviewed migration (the 0021 and 0027 precedent). **Shipped as 0031**
   (see section 9). Until it applied, the worker could not claim the source.

## 7. Public count effects of the seed (decision needed before activation)

Seeding changes published numbers, because the directory counts are protocol-agnostic. Expected effects:

| Public number | Effect of a 13,313 identity seed |
| --- | --- |
| Acknowledged entries (funnel, search total) | +13,313 (226,256 to about 239,600) |
| `withLocator` | +13,313 (SAID metadata URIs are `https://`; `ipfs://` rows have none) |
| `withRegistrant` | +13,313 (11,831 to about 25,100) |
| Protocol chips on the homepage | a new "SOLANA SAID" chip appears automatically |
| Wallet census | 13,313 new single-identity wallets; no change to the top of the ranking |
| Headline "on-chain identities" | **unchanged in this change.** It counts `erc8004`, `solana_registry`, and `solana_8004` only. Adding `solana_said` would take it from 11,831 to about 25,100, driven by a registry where registration is free and 97% of cards are served from SAID's own host. That is the same distribution-versus-market question the 8004 hand-out analysis raised, so it is left as an explicit operator decision. |

Per the documentation rules, the docs index, handoff, and `todo.md` should be updated when these counts go live.

## 8. Verification record

- Typecheck clean; full suite green; production build clean.
- `saidChain.test.ts` (33 tests): real mainnet accounts for each layout and each edge case (authority moved
  away from owner, stale residue, `ipfs://` URI, staked), expected values from the independent Python
  decode; strictness cases; floor, duplicate, ceiling, and seed behaviour; the request shape including the
  base58 discriminator filter. Two deliberate decoder mutations were confirmed to fail 22 and 4 tests.
- `runSaid.test.ts` (8 tests): guards fire before any run row; cursor persists only on success; a failed
  read or a failed directory write records a failed run with the prior cursor.
- Live run of the real adapter against mainnet with no database: 13,313 identities, 2 requests, 2.1 s,
  layout counts and residue count identical to the independent verification.

## 9. Scheduled refresh (migration 0031)

`drizzle/0031_said_scheduled_flip.sql` is one guarded `UPDATE`: `executionPolicy = 'scheduled'`,
`scheduleMinutes = 60`, `nextRunAt = NOW()`. The guards are in its WHERE, so a fresh or unhealthy
deployment never wakes to an unattended pass:

| Guard | Why |
| --- | --- |
| `sourceKey` and `protocol` match the SAID source | No other source can be touched |
| `state = 'active'` | A paused, rejected, or in-review source stays put |
| `executionPolicy = 'manual_only'` | Re-running the file is a no-op, and an operator's later cadence is never overwritten |
| `cursor LIKE 'said:%'` | Only a seeded source flips; an unseeded one never runs an unattended inventory |
| `lastSuccessfulAt IS NOT NULL` and `failureCount = 0` | Only a source with a clean recorded run flips |

Two deliberate differences from 0027: the success and failure guards above, and `NOW()` instead of
`UTC_TIMESTAMP()`. The latter is only correct for a `TIMESTAMP` column when the database session is already
UTC, which cannot be seen from the application.

The unattended pass is exactly the reviewed one: two Solana RPC requests, strict fail-closed decode, the
98% enumeration floor, and an upsert into `agent_directory_entries`. It adds no reviewed record, and a
failed pass leaves the cursor and every directory row untouched. Cadence is 60 minutes because SAID registers
roughly 60 identities a day and each pass downloads about 8 MB. The worker claims due sources
oldest-`nextRunAt` first at two per 15-minute tick, so an hourly source takes its turn without starving the
15- and 30-minute chain passes. The worker's `maxSourcesPerTick` and interval are not touched.

`server/saidScheduledFlip.test.ts` runs the migration through the boot runner on a real MySQL and checks each
guard (seven cases: it flips a healthy seeded source; a second run is a no-op; unseeded, paused, rejected,
in-review, failed, and never-succeeded sources are left alone; an operator's cadence survives; no other
source is touched). Removing any one guard from the SQL fails a test.

To revert a flip: set the source back to `manual_only` on /admin/sources, or pause it. Neither needs a deploy.

## 10. Activity ledger (phase 2a)

After the seed, each pass diffs the on-chain identities against the source's own directory rows and anchors
every change to the transaction that made it, writing it to `agent_solana_activity`, the ledger the Metaplex
and 8004 passes already use. The ledger only ever records honestly anchored events.

| Event | Detected as | Anchored by instruction |
| --- | --- | --- |
| `register` | no prior directory row for the identity | `RegisterAgent`, `RegisterAndStake`, `SponsorRegister` |
| `transfer` | authority differs from the prior registrant | `TransferAuthority` |
| `profile_update` | metadata URI hash differs | `UpdateAgent` |

Badge, stake, and slash changes refresh the stored note and fire no event, because the ledger has no kind for
them.

**Attribution.** The program logs Anchor instruction names and emits binary `Program data:` lines, so the
instruction name is the only text signal. Parsing is scoped to the SAID program's own frame by the runtime
program stack, so another program's log lines cannot supply a match. Other instructions also touch an
identity's PDA (`SubmitAnchor`, `Stake`, `LinkWallet`, `GetVerified`, feedback), so attribution walks the PDA's
signatures newest first and anchors to the first match. A real `TransferAuthority` is found behind a newer
`LinkWallet`. The vocabulary was verified against live mainnet transactions.

**Bounds.** Anyone can submit feedback against a PDA and bury a real change under noise, which is the wedge
the 8004 review found. Three limits keep a spammed account from stalling the pass or starving later ones:

| Limit | What happens past it |
| --- | --- |
| 8 transaction reads per identity | the change is adopted into the directory without a ledger row and counted as unanchored |
| 40 transaction reads per pass | the remaining identities defer: no directory upsert and no event, so the next pass detects them again |
| 25 events per pass | the rest wait for the next pass |

**Ordering.** The ledger is written before the directory upsert, so a failure between the two re-detects the
change on the next pass instead of losing the event. Unanchored and deferred counts go to the server log, and
unanchored changes also count in the run's `rejectedCount` (alongside vanished identities).

Code: `server/ingestion/saidActivity.ts` (diff, log parsing, attribution), `saidPass.ts` (one whole pass),
`saidTxFixtures.ts` (real mainnet logs and account bytes), and `runSaid.ts`, which persists events and then
drafts. Tests: 33 activity cases on real mainnet logs with expected instruction lists from an independent
Python parse, 5 whole-pass cases on real bytes and logs, and a runner test that pins the write order.
Letting `transfer` match noise, removing the per-identity cap, and upserting a budget-deferred identity each
fail a test. A live run against mainnet found no events at steady state and, with a perturbed prior, exactly
the 5 expected events anchored to their real transactions (12 requests, 17 s).

## 11. Public feed (phase 2b)

The ledger had no reader for any Solana registry. `liveData.directorySolanaActivity` now serves 40
events across SAID, 8004, and Metaplex (the newest overall, with each registry's newest five always in, since
2026-10-18: one SAID pass can record more than 40 registrations at once) plus per-registry, per-kind totals, and `/changes` shows them under
the identity-registry feed.

- **Same public rules as every directory read.** The join is per source (`sourceId` and `externalKey`), and the
  rows pass `directoryVisibilityCondition()`: active sources only, nothing hidden, closed, or on a suppressed
  domain. A closure event belongs to an entry that has left every public read, so closures never appear.
- **Honest time.** The time shown is when Nooscape's pass recorded the event, in UTC, which bounds when it
  happened. It is not the chain's own timestamp, and the page says so. The slot is the observing pass's.
- **Plain wording.** A transfer is "Changed owner" (Metaplex, 8004) or "Authority handed to another wallet"
  (SAID), never a sale. An edit is "Profile edited". Nothing says whether an agent works.
- **Gaps stay visible.** A registry with no recorded events shows "none yet" rather than a zero, and an empty or
  failed read says so instead of inventing a feed. The procedure fails closed to an empty payload with the cause
  in the server log, and uses its own query so a failure never empties the identity-registry feed.
- **Cached.** Both readers use the 30-second directory read cache, and the Solana ledger write invalidates it, so
  a new event shows on the very next read. (Superseded 2026-10-14: the cache now holds 5 minutes and a ledger write
  marks it stale instead of dropping it, so a new event shows once the background reload lands, about 10 seconds
  later. See [worker-operations.md](./worker-operations.md).)

Tests: `server/solanaActivityFeed.test.ts` runs on a real MySQL (6 cases: newest first with sanitized names,
nothing hidden/closed/paused-source/suppressed surfaces, per-source join, limit bound, totals, and
invalidation on a real ledger write). Removing the per-source join fails three tests and removing the
visibility condition fails four. `client/src/lib/evidenceExplain.test.ts` covers the wording and the UTC time.
