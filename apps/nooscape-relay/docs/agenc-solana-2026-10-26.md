# AgenC agent registry: on-chain directory pass (2026-10-26)

Status: **BUILT AND TESTED (2026-10-26); NOT STAGED.** Operator-approved scope: a directory-only pilot, chain facts only, manual-only. Nothing runs until the owner pastes migration 0051 by hand, stages the source on /admin/sources, approves it and runs it once. The scheduled flip is a separate reviewed migration, after a clean attended period.

## 1. What this adds

A chain pass over the AgenC program, acknowledging every registered agent into the master directory (`agent_directory_entries`) the way the SAID, 8004 and Metaplex passes do. It reads Solana mainnet only. It writes no reviewed record, no agent, no snapshot, no evidence event and no ledger row, so no run of this source can ever be projected.

AgenC is a Solana protocol where agents are paid out of on-chain escrow, with a reference marketplace at agenc.ag run by Tetsuo.AI Inc. The review that led here (26 October 2026) found the protocol real but small and mostly operator-driven, and its registered agents almost all new to Nooscape (section 9). The pass is a pilot for that reason: it is the only source with per-agent paid-work counters, and it is about 1.5% of the three Solana registries already read.

| Fact | Value | Verified how |
| --- | --- | --- |
| Program | `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, Anchor, mainnet since 2026-06-11, revision 5 since 2026-07-22. Upgrade authority: a Squads v4 2-of-3 vault `Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf` (a system-owned address off the ed25519 curve). | `getAccountInfo` on the program and its ProgramData account |
| Accounts | 3,007 at the census: 256 AgentRegistration, 400 Task, 361 TaskModeration, 291 TaskJobSpec, 181 TaskSubmission, 85 ServiceListing, 68 HireRecord, 43 SaleReceipt, 31 GoodsListing, 7 Store, 5 HireRating, 5 Dispute, 4 ModerationAttestor, and the rest in other families | full `getProgramAccounts` census, discriminators mapped to the program's IDL names by `sha256("account:<Name>")[..8]` |
| Key | the agent's own PDA. One wallet can hold several agents: 204 wallets hold the 256 (26 hold two or more, one holds ten) | the decoded population |
| Closure | an agent is never closed. `deregister_agent` leaves a permanent Inactive tombstone owned by the program; the 6 Inactive accounts on chain all hold no stake | the instruction's source (`deregister_agent.rs`) and the population |
| Cost of a pass | 2 requests (`getSlot`, one filtered `getProgramAccounts`), about 145 KB (256 accounts of 566 bytes) | measured |

## 2. Verified account layout (one layout)

The account is a fixed 566 bytes: 182 bytes of fields and length prefixes, plus two strings allocated at their maximums (256 and 128). After the 8-byte discriminator `82356467794d9413` (base58 `NnBoGyMErrE`, `sha256("account:AgentRegistration")[..8]`):

| Field | Type | Carried into the directory |
| --- | --- | --- |
| `agent_id` | 32 bytes | no (the PDA derives from it and is the key) |
| `authority` | pubkey | yes: the registrant |
| `capabilities` | u64 bitmask | no: the vocabulary is the program's own |
| `status` | u8 (0 Inactive, 1 Active, 2 Busy, 3 Suspended) | yes, in the note |
| `endpoint` | string, up to 256 bytes | its host, when it is a public name |
| `metadata_uri` | string, up to 128 bytes | its SHA-256, and its host as a fallback |
| `registered_at`, `last_active` | i64 seconds | yes, as dates in the note |
| `tasks_completed`, `total_earned` | u64 | yes, in the note, as the program's own counters |
| `reputation` | u16, 0 to 10,000, 3,000 at registration | yes, in the note, as a counter the program keeps |
| `active_tasks` | u16 | no |
| `stake` | u64 lamports | yes, in the note |
| bump, rate-limit windows and counters, reserved | 49 bytes | no: read for bounds only |

Borsh serializes a String as its u32 length plus only its actual bytes, so every field after the first string sits at a variable offset. The layout was proven two ways before the adapter was written: (1) an independent Python decode of every live account (256 of 256 decode, every account has a zero tail past the last field, every time is plausible and every reputation is at most 10,000), and the same bytes decoded by the TypeScript decoder (nine real accounts in `server/ingestion/agencFixtures.ts`, with the Python values as the expected ones); (2) AgenC's own public API lists the same 256 accounts, the two sets equal.

## 3. How the pass works

`server/ingestion/agencChain.ts` (decode and adapter), `runAgenc.ts` (orchestrator on the shared `withIngestionRun`).

1. `getSlot`, then one `getProgramAccounts` filtered by `memcmp` on the AgentRegistration discriminator, so the program's other account families are never downloaded. There is no size filter, so a registration at another size fails the decode loudly instead of being left out.
2. Strict decode, fail closed: the exact length, the discriminator, the status byte, both string bounds, UTF-8, a plausible `registered_at` and `last_active` (not before 2025-01-01, not past tomorrow) and a reputation within 10,000 are enforced. A registration-discriminated account that fails decode fails the whole pass.
3. A duplicate account fails the pass. More than 5,000 agents fails the pass (the approved ceiling; 256 at probe time).
4. **Enumeration floor.** After the first pass, a listing under 98% of the prior pass's agents fails the pass. A truncated provider response must never read as a shrinking registry.
5. **No closures.** Because an agent is never closed, a prior agent missing from a listing that is inside the floor is counted in the run result (`rejectedCount`) and logged, never hidden.
6. Upsert into `agent_directory_entries`, then persist cursor `agenc:<slot>` only after the whole snapshot succeeded. A failure leaves the cursor untouched.

## 4. Directory mapping

| Column | Value |
| --- | --- |
| `externalKey` | the agent PDA |
| `registrant` | the `authority` wallet |
| `accountPubkey` | the agent PDA |
| `locatorHost` | the host of the https `endpoint` when it is a public name, else the host of an https `metadata_uri`, else none. A host with no dot, a name under `.local`, `.localhost`, `.invalid`, `.test`, `.example` or `.internal`, and an address literal are not public names. |
| `profileUriHash` | SHA-256 of `metadata_uri`, none when it is empty |
| `displayName` | `AgenC agent <first 8 of the PDA>` (the chain carries no name) |
| `sourceSignalNote` | registered and last-active dates, status, tasks completed, earned (SOL), stake, the reputation counter, a line when the endpoint is a placeholder, and "chain facts as recorded, not scored" |

Of the 256 live agents, 107 would carry a locator host (25 distinct hosts) and 149 none, 8 have a profile hash. The note is deterministic from the account and stays under the column's 512 characters.

## 5. What the numbers on an entry are

Tasks completed, earned and reputation are AgenC's own lifetime counters, kept by the program and shown as recorded. They are never used to order, weight or blend (invariant 14), and the reputation number is worded as a counter the AgenC program keeps, not a Nooscape score. They are not a measure of independent demand: one agent, the operator's own provider from AgenC's federation canary, holds 378 of the 568 recorded completions, and AgenC's explorer labels 378 of its 564 settlements first-party canary traffic. Nooscape does not adopt that labeling, which is AgenC's classification of wallets; the counters are shown as the chain holds them.

The `endpoint` is required by the program and nothing in its task flow uses it (claims, submissions and payouts are all on chain): 140 of the 256 agents hold the placeholder `https://agent.local`, 59 point at AgenC's own domains, and even the top organic earner registered `agent.local`. It is not a service address the way an ERC-8004 `agentURI` is, so it is never fetched and the Checker never asks it (the Checker asks only endpoints an approved A2A card declares). A note on such an entry says so.

## 6. What is deliberately not ingested

- **AgenC's REST API, feeds and hosted indexer.** The chain is the source of truth, the hosted read model is a cached snapshot, and AgenC's `robots.txt` disallows `/api/` to crawlers. The source row records the public Solana RPC, not an AgenC host.
- **The leaderboard's first-party labels and any AgenC-computed value.** They are AgenC's judgment.
- **The profile documents** that `metadata_uri` points at (8 of 256 agents have one). They are never fetched; the link is stored as a hash.
- **The task, escrow, listing, rating and dispute accounts.** They hold the paid-work evidence (400 tasks, 5 hire ratings), but closed task accounts leave the chain scan, so a settlement ledger needs a signature walk and a backfill. It is deferred until this pass has run for a month.
- **Anything about AgenC's token.** The directory shows no token reference for any registry.

## 7. Public number effects (once the source is run)

| Public number | Effect of the first pass (256 agents) |
| --- | --- |
| Acknowledged entries (funnel, search total) | +256 |
| On-chain identities (home headline) | +256. See the decision in section 11. |
| Chain stats, Solana | +256 acknowledged, and a registry row "AgenC 256" in the tabs' "By registry" line |
| Protocol population row | a new "SOLANA AGENC" row appears automatically |
| Wallet census and look-alike counts | 201 wallets new to the directory (204 wallets hold the agents, and 3 already held an entry elsewhere); an agent's look-alike line counts the entries that share its wallet, across registries |
| Just arrived | the seed shows as 256 arrivals on Solana, as SAID's did |
| Map lights, Solana world page, activity feed | none drawn on the lights or in the feed: the pass has no events, groups or reviewed records. The world page holds a fixed sample of its entries in a fourth lane, from 2026-10-28 ([the record](./agenc-lane-2026-10-28.md)) |

## 8. Rollout

1. Merge. The code is inert: the source does not exist, the protocol value is not in the database, and nothing is scheduled.
2. **The migration (0051) is run by hand.** It appends `solana_agenc` to the protocol list of four tables. It is manual because every statement restates the whole list, which now ends with the Base, Ethereum and Arc values that migration 0046 keeps out of every boot; run it at a quiet moment, not on a worker tick (:00, :15, :30, :45), because even a metadata change waits for queries that are still reading the table.
   - **Before:** migration 0046 must already be applied and recorded (production has it). This file would add its three values on a database that lacks them.
   - **Paste** `drizzle/0051_solana_agenc_protocol.sql` into the host's SQL console. A paste-safe copy is at `0051_solana_agenc_protocol.sql`.
   - **Record it** (`0051_record.sql`): `INSERT INTO nooscape_schema_migrations (version, name) VALUES (51, '0051_solana_agenc_protocol.sql');`. The name must be exactly the file's: a version recorded under another name stops the next boot.
   - **Check** (`0051_check.sql`): each of the four rows ends with `'erc8004_arc','solana_agenc')`.
   - **Rollback** (`0051_rollback.sql`): the first query counts the rows that hold the value and every count must be 0, because MySQL cannot drop a value a row still holds. Then the same four statements with the 0046 list, and the version is deleted.
   - Staging the source before the file is pasted answers "The database does not have the AgenC protocol value yet. Paste migration 0051 first", and creates nothing.
3. On /admin/sources, **Stage AgenC Solana registry** (in review, manual only), approve it, and press **Fill chain state** once. Expect 256 or more agents acknowledged (`registeredAgents` on AgenC's own `/api/stats` reads 256 on 26 October, and registrations have run at 7 to 17 a month since August), 2 requests, 0 rejected, and a cursor `agenc:<slot>`.
4. Compare the acknowledged count with a fresh census before any scheduling: the program has exactly as many AgentRegistration accounts as the pass acknowledges, and `deregister_agent` never reduces it.
5. After several clean attended runs, the scheduled flip is a reviewed migration (0053, the 0050 pattern: a guarded UPDATE that names no protocol; 0052 went to the Ethereum flip) at a daily cadence, with `solana_agenc: 36` added to the live check's freshness table in the same change. Until then the worker cannot claim the source, and the runner refuses a scheduled trigger from a source that is not scheduled.

### What the migration was tested against

`server/agencProtocolMigration.integration.test.ts` runs against a real database built the way boot builds it, with 0046 applied as production has it: the value is refused before the file, accepted after it, the earlier values still work, the file pasted twice changes nothing, and the rollback is refused while a row holds the value and succeeds when none does. It passes on MySQL 8.4.11 and on MariaDB 10.11.19, the production engine. On both, the append was also accepted as `ALGORITHM=INSTANT` on a 30,000-row table in about 3 milliseconds, which the engine refuses when a rebuild would be needed.

## 9. Measured against the directory at build time (2026-10-26)

Each of AgenC's 204 authority wallets and each of its 21 third-party endpoint hosts was looked up through Nooscape's own public search, paced under its limit.

- **3 of 204 wallets** already held a Nooscape entry, all on Solana: one in the Metaplex registry, 8004-solana and SAID together (it also holds an AgenC agent), two in the Metaplex registry.
- **0 of the 43 wallets** that have earned anything on AgenC held a Nooscape entry.
- **1 of 21 hosts** matched a real project: an AgenC agent's profile host is also the locator host of a Base ERC-8004 registration. A shared host name is a link worth showing and proves a shared domain, not a shared operator.

So the pass adds real coverage and few cross-registry links. The search covers visible directory entries only.

## 10. Known limits and follow-ups

1. **Settlement facts are not read** (section 6). A ledger like the USDG one, one row per settlement with its signature, is a later change.
2. **Names.** The chain carries none, so 256 entries are named `AgenC agent <PDA prefix>`. The profile documents name some, and fetching them would be its own source approval.
3. **Layout drift fails loudly.** The account size is fixed at 566. If AgenC upgrades the program and resizes the account, the pass fails and `verify-live` shows the failure once the source is scheduled. A rising count of accounts with bytes past the last field is logged as the earlier signal.
4. **No activity ledger.** The pass records no register or change events, so the check's ownership facts read "not measured" for these agents, not none.
5. **The ceiling and the floor.** 5,000 agents and 98% of the prior pass. Both fail the pass and leave the cursor and the directory untouched.
6. **Provider.** Production reads use the keyed endpoint from `SOLANA_RPC_URL` through the shared paced client. The response is about 145 KB against the client's 16 MiB cap.
7. **AgenC watch items.** The program is upgradeable by a 2-of-3 multisig and has no published external audit. An AgenC interop assessment of 2026-07-04 (its file carries a banner calling it a historical record) sets 2026-12-01 to revisit minting ERC-8004 identities for its agents; if it does, they reach Nooscape through the existing EVM passes with no new code.
8. **AgenC is drawn on the Solana world page as a fixed sample, and only as that.** Its entries have no events, groups or reviewed records, so no formation or replay of the page can come from the pass. Built on 2026-10-28 ([the record](./agenc-lane-2026-10-28.md)): a fourth lane with a fixed sample of its agents, read as Arc's page reads its own (`chainSample`), beside the search matches the page already adds for the other registries. A fourth lane changes the page's picture, so its share card would need a new file name: the subtitle and the card said three registries when the lane was built, and were changed to four later on 2026-10-28 (see the lane record).

## 11. Decisions

- **2026-10-26, operator, in chat:** "yes, build the pilot", in answer to an offer of a directory-only, chain-facts-only, manual-only pass with the counters shown as recorded text and placeholder hosts left empty.
- **Headline, confirmed 2026-10-26.** The operator was told the pass would be kept out of the "on-chain identities" headline "as SAID is". The code counts SAID there (since the wallet-wording and headline change of 13 October), so that premise was wrong. A registry kept out of the headline would also have been counted as 256 "locator listings" by the home card's remainder, unless the card grew a separate bucket as the BNB Chain and extra-chain rows have. The pass was put in `ON_CHAIN_REGISTRY_PROTOCOLS` beside the other three Solana registries (one line), which keeps the card's parts adding up. AgenC registration needs a stake (0.01 SOL is the lowest any active agent holds), unlike SAID's free registration. Changing this costs one line and a bucket on the card. The operator answered in chat on 2026-10-26, after the first run had raised the headline's on-chain identities from 37,169 to 37,425: "keep agenc in the headline".
- **Solana world page, 2026-10-26, operator, in chat:** "do the solana world page", after being told its header said three registries while the figures under it counted four. The page drew three, and its header said, while the chain's count included AgenC, that AgenC was counted and not drawn (`undrawnRegistryNote`). On 2026-10-28, in the order "do these next ... the AgenC page", the fourth lane was built and the note became `sampledRegistryNote` in `client/src/lib/chainExplorerModel.ts`. The subtitle and the share card kept their words at first, because they describe the three registries that record events, and were changed to four later the same day, on the operator's request (see the lane record).

## 12. Tests

- `server/ingestion/agencChain.test.ts`: nine real mainnet accounts decoded to the independent values; the discriminator derived by Anchor's rule; each strictness check (length, discriminator, status, both string bounds, UTF-8, both times, reputation, residue); the public-host rules for placeholders, reserved names, address literals in any form and non-https; the draft and the note, including that no word grades an agent; the enumeration floor, the seed exemption, a duplicate, the ceiling and an unusable slot.
- `server/ingestion/runAgenc.test.ts`: the guards fire before any run row; the seed and the cursor; a failure keeps the cursor and writes nothing.
- `server/agencRoute.test.ts`: staging and running through the real router, and the clear message when 0051 has not been pasted.
- `server/agencProtocolMigration.integration.test.ts` (real MySQL or MariaDB): see section 8.
- `server/dbMigrations.test.ts`: 0051 is manual, and is exactly four appends, last. `server/ingestion/multichainDispatch.test.ts`: the protocol list is the same in the code and in the schema's three places.
- `server/solanaActivityFeed.test.ts` (real MySQL): runs with an AgenC source and entry present. Putting AgenC on Solana had halved the feed's per-registry floor, which was split across every protocol on Solana. The feed now reads a named list of the registries that write a ledger (`SOLANA_FEED_PROTOCOLS` in `server/db.ts`), so AgenC, which writes none, takes no share of the floor and has no place in the feed or the totals. A registry that later gets a ledger is added to that list on purpose.
- Updated: `apiV1.test.ts` (a lookup of an AgenC agent by its account, and the registry lists), `apiV1Chains.test.ts`, `shared/arrivals.test.ts`, `directoryProtocols.test.ts`, `chainTabsModel.test.ts`, `evidenceExplain.test.ts`.
