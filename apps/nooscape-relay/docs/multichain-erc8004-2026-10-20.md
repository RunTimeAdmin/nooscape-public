# One ERC-8004 identity importer for every EVM chain

**Status.** All three stages shipped (PR 174, 2026-10-20, main `49c7cd3`). Everything new was off: no chain ran, showed or was served until the operator ran migration 0046, set an endpoint and turned the chain's switch on. With all three switches off the site and the API answer as they did before these chains existed. Arc has been on since 2026-10-20 (0046 run, `chain_arc` on, the source staged, approved and walked to the finalized head: 246 of its 2,587 registrations listed); Ethereum and Base are off. Arc has a page of its own since [Chain Worlds stage C](./chain-worlds-2026-10-20.md).

**Decided:** 2026-10-20, by the operator, in chat. He attached the brief `CLAUDE_BRIEF_MULTICHAIN_ERC8004.md` (written 2026-10-19 against `main` at `ed3c2e7`), the brief was checked against `main` at `954d733` as it asked, and he then chose: drop the private-address exception, skip the payment guard, and deliver in three stops on one branch with one pull request at the end (auto-merge off). After stage 1 he said "go". He gave the Base provider as an Alchemy endpoint, and moved that account to the Pay As You Go plan the same day.

## What this is

The BNB Smart Chain pass reads the ERC-8004 identity registry from its deploy block to the finalized head, and writes registrations to registry rows that a listing rule then publishes. The registry is the same contract at the same address on every chain it runs on, so the same pass can read the others. Stage 1 made the pass one implementation that takes a chain as an argument, with BNB Smart Chain as its only entry and its behaviour unchanged. Stage 2 adds Ethereum, Base and Arc as entries, each behind a switch that is off.

## What the brief said, and what was changed after it was checked

The brief was checked claim by claim against the code. Every file it names exists and only one changed after its snapshot (`ChainTabs.tsx`, for a census link). The BNB constants, cursor, keys, budget and RPC rules, `loadX402` and the x402 client, the feature list and the listing thresholds all match. On chain, the identity registry has the same 130 bytes of code at the same address on Ethereum (chain id 1), Base (8453) and Arc (5042), and each node serves `finalized`. What differed:

1. **The private-address exception (section 2b) is dropped.** The `X402_RPC` address prepared for the operator is https on a `nooscape.si` name, on port 443, and resolves to a public address, so the public-address check passes and the exception would never have been used. Arc uses the same public-address check as BNB Chain, with the host taken from the configured address. (The existing x402 client makes no address check at all today; that is not changed.)
2. **The brief's "pinned connection" does not exist in the BNB client.** The BNB pass checks the host once with `assertPublicHostname` and then makes a plain `fetch`. Nothing here adds a pinned client; it was needed only by the exception.
3. **Migration 0047 is not needed.** A source row is made by the operator's stage action, not by a migration. Stage 2 adds the three staging buttons to the operator page and one enum migration (0046).
4. **The payment-first guard is skipped.** It would need a change in payment code (`x402Service.ts` builds the client), which the brief also puts out of scope. Arc's pass relies on its own limits instead: one request at a time, small caps, a gap between calls, back-off with jitter, and a shorter timeout than a payment check's. `loadX402` now reads `X402_RPC` through the shared helper (`server/arcRpc.ts`) with identical behaviour, held by a test that sets the old rule beside the new on 19 inputs.
5. **"Only a config entry" is true of the pass and not of the rest.** 28 non-test files name the BNB protocol and 13 use `ChainKey`. The chain list, API and tabs (stage 3) need a deliberate decision for each new chain.
6. **Four tables carry the protocol list, not three.** 0033 extended `agent_directory_entries`, `ingestion_sources` and `source_observations`. 0034 then created `agent_directory_registry_rows` with the same list, and the pass writes every registration there first. A value missing from it would fail the first insert of a run, so 0046 alters four tables. A test applies it to a real MySQL and shows the new values refused before and accepted after.
7. **The deploy block cannot be found by `eth_getCode` on Base and Arc.** Neither endpoint serves state that far back (Base's is pruned past about 5 million blocks, Arc's node prunes state). On Ethereum the search ran (25 probes) and three other ways agreed with it, so the method used for the other two was checked there first: the first log of any kind from the address is the proxy's own creation event, in the creation block. Base's block also comes from the explorer's creation transaction, and Arc's from a forward walk of 50,000-block windows from block 1.
8. **NodeReal cannot walk Base.** Its Base endpoint serves history only from block 50,000,000, about 65 days, and the registry's Base history starts 8.3 million blocks earlier. The host the brief names for it (`base-mainnet.nodereal.io`) does not resolve either; NodeReal's Base endpoint is `open-platform.nodereal.io/{key}/base`. The operator gave an Alchemy endpoint instead (host `base-mainnet.g.alchemy.com`), which serves the whole history. On its Free plan one `eth_getLogs` call may span 10 blocks, which is about 1.1 million calls (about 67M compute units, over twice the monthly 30M) for Base's history. On Pay As You Go the same history is about 11,000 calls. The operator moved to Pay As You Go, and the limits below were measured on it.
9. **The Alchemy host is fixed, so Base is pinned; only Arc's host is derived.** A vendor host is the same for every account (the key is in the path), so it is named in the code like BNB Chain's and Ethereum's. Arc's node is the operator's own, so its host is read from `X402_RPC` when the source is staged and recorded in the source row, and each run compares the variable's host with the row's.
10. **Base is in a surge.** See below. It changes what is sensible to run first, not what was built.

## Stage 1: the importer takes a chain

| Piece | File | What it is |
|---|---|---|
| The chain list | `server/ingestion/erc8004Chains.ts` | One entry for each chain: protocol, chain key, chain id and its hex form, labels, registry address, deploy block, log range, window bound, hand-out hour, source key, provider (pinned to a host, or derived), the endpoint variable and its reader, the RPC policy, the run budget, cursor prefix, error and log names, the sentence a registry note ends a link with, optional listing rules, and an optional switch. `validateErc8004Chains` checks a list is sound. |
| Decoding and planning | `server/ingestion/erc8004Chain.ts` | The cursor, the window planner, the decoders, the registry row and its note. Pure. Everything that was BNB's comes from the entry. |
| The RPC client | `server/ingestion/erc8004Rpc.ts` | The endpoint check, the request, the retry ladder, the response cap, the error classes. Nothing it throws carries the provider key. |
| The pass | `server/ingestion/runErc8004Chain.ts` | The walk to the finalized head, strictly in chain order, with the cursor advancing only past windows fully applied. Refuses to run while the chain's switch is off, before any run row exists. |
| BNB's names | `bscChain.ts`, `bscRpc.ts`, `runBsc.ts` | Thin views over the above with every export, signature and message they always had, so the 11 other files that import them are unchanged. |
| The hand-out hour | `server/ingestion/evmIdentityChains.ts` | Takes each chain's measured hour from the list, so a chain added to the list is known there with no further line. Robinhood Chain keeps its own constant and its own walk. |

**Adding a chain** takes an entry in the list, a protocol value on the enum (a manual migration), a switch, a case in the worker's scheduled dispatch, its name in the staging action with a button on the operator page, and fixtures. It takes no new runner code, and the router's run dispatch finds the chain from the source's protocol. Stage 2 did exactly this three times.

## BNB Smart Chain behaves as before

The brief asks for this byte for byte, and four things hold it:

- **The BNB tests are untouched and pass.** 11 unit files with 248 tests (`bscChain`, `bscRpc`, `runBsc`, `bscMulticall`, `bscReputation`, `bscB1`, `bscClusters`, `claimsChain`, `bscSourceNote`, `bscScheduledFlip`, `bscRaters`) and 5 database-backed files with 66 tests (`bscPass`, `bscRatersRun`, `bscClusteringRun`, `bscRegistrationFiles`, `bscRegistrationRead`), none edited. One test outside those files had to follow the code: a wording guard in `checkerPage.test.ts` (see Checked).
- **The BNB entry is pinned field by field** in `erc8004Chains.test.ts`, with the check that it sets none of the options the shared client gained for a shared node, so a change to a value of a pass that is running is seen as one.
- **A differential check.** The old BNB files from `main` were set beside the new ones and given the same inputs: every fixture log, cursors (valid, out of bounds and malformed), window plans, URIs, the RPC client under 18 scripted responses (statuses 429, 500, 501, 502, 503, 504 and 404, range and size rejections, provider text carrying a key, a network failure carrying the address, malformed bodies, responses over the cap, and a timeout), and the whole pass under 28 scenarios against the same mocked database. Every result, error message, error name, call to the database, request, wait and log line was equal: 52 comparisons. It was run once after stage 1 and again after stage 2, and both times all 52 were equal. To show the check could fail, 16 small changes were planted in the new code one at a time and each was caught. The check is not part of the change.
- **One difference, cosmetic.** A test double that builds an error with `new BscRpcError(message)` now gets the shared class's default name, because the BNB names are the shared classes. Every error the pass throws itself carries the BNB name, and `instanceof` works across them. Nothing reads the name.

Stage 2 added behaviour to the shared client and pass, all of it switched on by a field of a chain's policy that BNB Chain does not set: a pause between calls, jitter on the waits, a retry for a timeout or a busy node, reading the explanation in the body of a refused request, and removing the endpoint's own pieces from provider text. One thing is on for every chain, because no BNB answer can contain it: an answer that says "Log response size exceeded" is a result-size rejection, though it also mentions a block range.

## Stage 2: Ethereum, Base and Arc

### What was measured

Measured on 2026-10-20 with read-only requests, from the operator's NodeReal key (Ethereum), the operator's Alchemy key (Base) and the operator's own Arc node. No address or key was printed or kept.

| | Ethereum | Base | Arc |
|---|---|---|---|
| Chain id | 1 (`0x1`) | 8453 (`0x2105`) | 5042 (`0x13b2`) |
| Registry | the same proxy, `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, 130 bytes of code | same | same |
| Created | block 24,339,871 (29 Jan 2026) | block 41,663,783 (3 Feb 2026) | block 13,344,062 (1 Aug 2026) |
| How found | `eth_getCode` search, 25 probes; the first log; the explorers | the explorer's creation transaction; its header time; 3 logs in it on Alchemy and two public nodes; none in the 10 blocks before | the first log of any kind (state is pruned) |
| First registration event | block 24,339,925 | block 41,673,162 (about 5 hours after) | block 21,156,191 (16 Sep 2026) |
| Block time, blocks an hour | 12.04 s, 299 | 2.00 s, 1,800 | 0.508 s, about 7,080 |
| `finalized` behind the head | 71 to 93 blocks | 617 to 852 blocks | none (instant) |
| Provider | NodeReal, `ETH_RPC_URL` | Alchemy, `BASE_RPC_URL`, Pay As You Go | the operator's node, `X402_RPC` |
| Provider limits found | a window over 50,000 blocks is refused; so is a response over 50,000 logs | 10,000 blocks in full; any range up to 10,000 logs; the Free plan allows 10 blocks | 5,000,000 blocks accepted (the widest tried) |
| Registrations to the head | 54,333 | 321,929 | 2,585 |
| Shape | a burst at launch (23,100 registrations in the first 50,000 blocks), sparse after | quiet for months, then a surge in the last 10 days | small and bursty |

### Why each number is what it is

- **Ethereum: windows of 2,000 blocks, a 24 MiB response cap, 30,000 events a window.** The densest 2,000-block window holds 19,200 events and 12.4 MiB (the first 10,000 blocks hold 45,518 events). BNB Chain's 8 MiB cap would reject that window, and a rejected window splits only to 1,000 blocks, so the walk would stall at the burst. The cap is about twice the densest window and the bound half as much again. A window of 50,000 blocks, the provider's ceiling, could not be read in the burst at all.
- **Base: windows of 1,000 blocks, a 24 MiB cap, 40,000 events a window.** See the surge below: the densest 1,000-block window now holds 10,404 events and 6.7 MiB, and the caps leave about 3.6 times that. A window past the bound is a fault of the provider that fails the run, so the bound is sized for a registry that is still growing.
- **Arc: windows of 100,000 blocks, a 2 MiB cap.** The node took 5 million blocks in one request, and the whole history is about 6,000 events. A small window keeps each request light on a node that payment checks share.
- **Budgets start smaller than BNB Chain's** (60 windows, 6 at once, 20,000 events). Ethereum: 100 windows, 3 at once, 5,000 events. Base: 200 windows, 2 at once, 5,000 events at first and 40,000 since 2026-10-20 (see [Base backfill throughput](./base-backfill-throughput-2026-10-20.md)). Arc: 10 windows, 1 at a time, 1,000 events, 20 seconds. The event cap is checked between windows, so a dense window can run past it. Every one of these is a starting value for the operator to change after the first runs.
- **The hand-out hour** is each chain's measured blocks an hour (299, 1,800, 7,080), recorded in the entry with the date.
- **Listing rules** are BNB Chain's numbers for each chain (a shared profile link from 2, a shared host from 50, a shared wallet from 10), as a constant each. They are provisional. They were chosen for a registry of 373,567 registrations and none of these has had a census, so the operator tunes them after the first one.

### Base is in a surge

Base's registry was quiet for most of its life: 38 of 40 sampled 1,000-block windows across its history held 40 events or fewer, and about 99,000 registrations accumulated over eight months, a few hundred a day. It is not quiet now. Counted exactly on 2026-10-20 (registration events only, 321,929 to the head), registrations a day, counting back from the latest block:

| Days back | Registrations | | Days back | Registrations |
|---|---|---|---|---|
| 0 (the latest 24 hours) | 54,227 | | 5 | 14,743 |
| 1 | 51,882 | | 6 | 7,213 |
| 2 | 34,986 | | 7 | 9,064 |
| 3 | 25,337 | | 8 | 3,784 |
| 4 | 21,154 | | 9 and earlier | 245 to 351 a day |

Of the 321,929, 222,661 (69%) came in the last 10 days and 141,095 (44%) in the last 3. Inside the latest day the rate is higher again: the latest 10,000 blocks (about 5.6 hours) held 82,477 events, of which 26,647 were registrations from 26,606 different wallets and 55,830 were transfers. The densest 1,000-block window in the last 30,000 blocks held 10,404 events and 6.7 MiB. BNB Chain's whole registry is 373,567 registrations.

What this asks of the pass, none of which stage 2 changes:

- **Pace.** A window in the surge holds 8,000 to 10,000 events, so under the 5,000-event cap one window is applied a run. A scheduled run every 15 minutes applies about 40,000 events an hour against about 15,000 arriving (the average of the latest 10,000 blocks), so it keeps pace and works down the backlog at the difference. The history is about 320,000 registrations and around a million events, which is on the order of a hundred runs before the pass is caught up. *Corrected 2026-10-20:* the history is 189 runs at 5,000 events, and the supply was wrong. The shared worker gave Base about one run an hour, not four, because its two slots a tick are shared by eleven sources and a third of the ticks were refused; the arrival rate rose to 281,000 events a day. See [Base backfill throughput](./base-backfill-throughput-2026-10-20.md).
- **Size.** Registry rows are kept for every registration and the classification reads the whole table of the source on each run. BNB Chain's budget was set by a benchmark in which a run took up to 57 seconds at a 30,000-event cap (the comment on its budget), on a registry of 373,567 registrations. Base is at 321,929 now and gaining tens of thousands a day. Millions of rows have not been tried.
- **Where to start.** The pass walks from the deploy block, because a directory that is missing the registrations before a block would be wrong, and it is the only start the pass has. Whether Base starts there, and when to run its first pass, is for the operator to decide before the switch is turned on. The other roads are to hold Base until the surge settles, or to start at a later block, which would need pages that say the history is partial.

### Arc shares the operator's node

Arc reads the node through `X402_RPC`, the setting the payment code already holds (`server/arcRpc.ts`, which has no variable of its own). A payment check asks the same node whether a smart-contract wallet signed. So the pass: makes one request at a time; leaves 250 ms after one ends before the next starts; times a request out at 6 seconds, where a payment check's is 8; waits 1, 2 and 4 seconds (with up to a quarter added at random) after a 429, a 5xx, a timeout or a busy answer, and then stops and keeps its cursor for the next run; asks the chain id before anything else; and puts nothing of the setting in an error, a log line or a run record, including when the node echoes its own address back in an error. The host is the only part of the address that is kept, in the source row. To move Arc to another node, change `X402_RPC` and then the source row's two columns by hand (`rootUrl` to `https://` and the host, `allowedHostname` to the host); until the row agrees with the variable the pass refuses to run.

### The switches

`chain_base`, `chain_ethereum` and `chain_arc` join `watch`, `patrols` and `claims` in `VITE_FEATURES`. While a chain's switch is off: its pass does not run (before a run row exists, with a line in the log and a message that says it is switched off); its source cannot be staged (the operator's page shows no button, and the server refuses); and nothing else about it is shown or served either: stage 3 makes the tabs, the API and the chain list, search and the aggregates follow the same switch (below).

### The operator's page

`/admin/sources` has a "Stage ... · manual only" button for each chain whose switch is on, and the run button for a staged source is the same "Run chain pass" BNB Chain's has. A staged source is `manual_only` and in review, as BNB Chain's was: the operator approves it, runs it from the page as many times as the walk needs, and a later, reviewed migration (not written) hands it to the scheduler once a first pass on that chain has been run and checked.

### The migration (0046, manual)

Like 0036 to 0045 it is not run on boot (`MANUAL_MIGRATIONS`). Four `ALTER TABLE ... MODIFY COLUMN` statements append `erc8004_base`, `erc8004_eth` and `erc8004_arc` to the end of the protocol list, as 0033 did, which MySQL can apply without rebuilding the table. Each statement writes the whole list, so running the file again changes nothing.

1. **Choose a quiet time.** Even a metadata change waits for queries still reading the table.
2. **Paste `drizzle/0046_multichain_erc8004_protocols.sql`** into the host's SQL console. A paste-safe copy is at `0046_multichain_erc8004_protocols.sql`.
3. **Then record it** (`0046_record.sql`):

```sql
INSERT INTO `nooscape_schema_migrations` (`version`, `name`) VALUES (46, '0046_multichain_erc8004_protocols.sql');
```

4. **Check** (`0046_check.sql`): each of the four rows ends with `'erc8004_bsc','erc8004_base','erc8004_eth','erc8004_arc')`.

```sql
SELECT TABLE_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'protocol'
  AND TABLE_NAME IN ('agent_directory_entries','agent_directory_registry_rows','ingestion_sources','source_observations')
ORDER BY TABLE_NAME;
```

5. **Rollback** (`0046_rollback.sql`): the first query counts the rows that hold a new value and every count must be 0, because MySQL cannot drop a value a row still holds. Then the same four statements with the earlier list, and the version is deleted.

### Turning a chain on

In this order, for one chain at a time. Nothing before step 4 changes what the site does.

1. Run migration 0046 and record it.
2. Set the endpoint on the host: `ETH_RPC_URL` (a NodeReal Ethereum URL) or `BASE_RPC_URL` (the Alchemy Base URL, on a plan that allows wide ranges). Arc needs nothing new: `X402_RPC` is already set.
3. Add the chain's switch to `VITE_FEATURES`, build and restart (the client needs the build and the server the restart).
4. On `/admin/sources`: stage the source, approve it, and run the chain pass. Repeat the run until the cursor reaches the finalized head. At the starting budgets that is roughly 15 to 20 runs for Arc and 20 to 25 for Ethereum (its burst takes one window a run); these are estimates from the budgets, not measurements. Base is for the operator to size, after the surge section above.
5. Read what it recorded. Only then ask for the scheduled flip.

## Stage 3: the lists, the API and the tabs

A chain whose switch is on is listed and counted beside the others. A chain whose switch is off is not there at all. The switch list is `VITE_FEATURES`, which the client reads when it is built and the server as it runs, so the two agree after a deploy.

### What a chain that is on gets

| Where | What |
|---|---|
| Home, the region tabs | A tab after the original three, in the order Ethereum, Base, Arc, with the three figures every tab has (acknowledged, reviewed records, ratings recorded) and the last successful read. Ratings say "not measured here". Under the figures, once a pass that reached the finalized head has published, one sentence says how many registrations the chain holds and how many of them the directory lists ("the rest are held out, not judged"), in BNB Chain's words. The heading follows the tabs ("Robinhood, BNB, Solana, Base. Same Owl, four skies."). Arc's tab links to its page ("Open the Arc page", while that page is on); Base and Ethereum have no page, so no link. |
| Home, the full-field totals | A line "listed from Base" beside "listed from BNB Chain". The listed registrations of these chains leave the "locator listings" remainder, which they were never part of. |
| Search, entry pages, counts, the public source list | Its entries and its source, named "ERC-8004 · BASE" and so on. An entry's wallet and host look-alike counts run over the whole registry, listed or not, and the sentence says so, as BNB Chain's do. |
| The API | The chain is in the index, in the lookups by chain and id (one, a batch, a history), in the search (all chains, or `chain=base`), in the check, and in the OpenAPI document (every list of chains and the three sentences that name the registries). The developer page says so too while a chain is on. |

### What a chain that is off gets

Nothing of it is counted, listed, searched, found by key, read as an entry, named in the source list, given a row in the tabs or accepted as a value.

- **One rule for the directory reads.** `directoryVisibilityCondition()` in `server/db.ts` is the predicate that about forty queries share (counts, the breakdown by protocol, search, the entry page, keys, wallets and look-alike counts, and more). It now ends with `chainSwitchCondition()`: a `NOT IN` over the protocols of the chains that are off, on the joined source row. With every switch on it adds nothing. The list is read as the server runs.
- **The public source list** leaves out a source of a chain that is off, even one that was staged while the switch was on.
- **The tabs' answer.** `liveData.chainStats` is `{ chains }` with the original three rows, as before, and gains an `extras` list only while a chain is on. With every switch off the whole answer is what it was, byte for byte.
- **The API.** The table of chains has six entries, but each request reads which are served (`servedChains()`): the three, then each extra chain that is on. A lookup for a chain that is off answers "chain must be one of robinhood, bnb, solana". The search and check schemas are built from the served list, so their refusals read as they did, and the document is the same object as before while all three are off.
- **The client.** The tabs, the heading and the developer page follow the build's switch list, and an extra chain the server sent no row for is left out.

### Where the extra chains stop

They are listed and counted. They are kept out of `ChainKey` on purpose: a chain in that list gets a light on the map, a page of its own and a place in the Owl's Catch, and these have none of those. (Arc has since been given the rest, outside `ChainKey` too: a page (`WorldKey` in `client/src/lib/chainExplorerModel.ts`, [Chain Worlds stage C](./chain-worlds-2026-10-20.md)), map lights, a share card, a census report, a card in "just arrived", a place in the Owl's Catch's round numbers, the watchlist and the webhook, and claims behind a switch of their own. Each has a record in [the docs index](./README.md), and the notes below say what stage 3 itself left out.) So that a switch changes only what the brief asked for, stage 3 does not cover:

- Map lights, share cards, the pages of Base and Ethereum, the Noosphere sample, "just arrived" and the Owl's Catch.
- The watchlist and the webhook: the brief puts events for the new chains out of scope, so a watch on a listing of one of these chains is refused as an unknown chain.
- Claims (the panel is for Robinhood Chain and BNB Chain), ratings and feedback, and the registration read that gives a BNB entry "Checked, unproven" or "Not checked". An entry on the new chains has no registration read, and says nothing in its place.
- The check answers for these chains with the flags it gives any EVM registry. Where Nooscape holds no ledger for the chain, the flag says it is not measured.

## Held by a test

Stage 1's tests are kept (the chain list, the decoding, the RPC client and the pass, run on a chain that is not in the list). Stage 2 adds:

- `erc8004Chains.test.ts`: all four entries pinned field by field; the relations between a cap and the densest window measured; a switch for each chain named for its key; each chain's own listing rules; and the validator on the new fields.
- `erc8004RpcPolicy.test.ts`: a derived host compared with the row's, the row's host taken from the variable and nothing else of it, the pause between calls, the ladder with jitter, a timeout or a busy answer tried again on Arc and on no other chain, a refusal's explanation read only where a chain asks, and the endpoint's pieces removed from provider text for Arc only.
- `runErc8004ChainArc.test.ts`: the pass on Arc through the real client against a fake node with a clock the test controls: only while its switch is on, not configured without `X402_RPC`, refused on another host, the chain id first, one request at a time with the gap, back-off and then a stop with the cursor kept, and nothing of `X402_RPC` thrown, logged or recorded in ten failure and success scenarios.
- `erc8004ChainFixtures.test.ts`, `runErc8004ChainFixtures.test.ts`: real logs from each chain (`erc8004ChainFixtures.ts`, with expected values decoded independently in Python) decoded under the chain's own entry, and the pass walked over them for each chain with the database layer mocked: chain order, cursor, idempotence, resume, the budget stops, and the providers' recorded refusals named correctly by the real client.
- `multichainPass.integration.test.ts` (real MySQL): the new values refused before 0046 and accepted after; 0046 pasted twice is a no-op; the pass for each chain writes the real logs, lists them, publishes them under the chain's protocol, rolls the mints up, keeps the ledger, is idempotent and is quiet once caught up; three chains share one database without touching each other.
- `multichainListing.integration.test.ts` (real MySQL): each chain's own listing rules hold out a registration with no link, one named only with a number, and a profile link, a host or a wallet shared as many times as the rules name; one short of each stays listed; only the listed are published, under the chain's protocol; and rules one lower hold out a group the chain's own rules list.
- `erc8004RealChains.test.ts`: Ethereum's and Base's real entries read their own variable, accept their provider's host over https and nothing else (not http, not userinfo, not a look-alike, not another chain's provider), and say so in words that name the variable and never its value.
- `multichainRoute.test.ts`: staging and running through the real router: operator only, refused with the switch off, made from the chain's entry, manual only, Arc's host alone, and each refusal put as what it is.
- `multichainWording.test.ts`: none of the new strings says verified, safe, trusted or guaranteed, but for one sentence every chain's note ends with, shared with BNB Chain and Robinhood Chain: "current ownership is not verified".
- `multichainDispatch.test.ts`, `arcRpc.test.ts`, `features.test.ts`, `dbMigrations.test.ts`: the scheduled dispatch, the one rule for `X402_RPC` in the payment code and the Arc pass, the six switches, and 0046 (manual, and exactly four appends, last).
- Stage 3 adds:
  - `extraChains.test.ts`: the shared model held to the pass's own entries (protocol, name, switch and order), BNB Chain and the original three chains left where they were, the three chains' figures held to a copy of the code they replaced on four inputs (byte for byte), the figures of an extra chain, and the shape of the visibility rule in `db.ts`.
  - `apiV1Chains.test.ts`: the API with every switch off (the index and the document word for word; a lookup, a search or a check for an extra chain refused in the words it uses for any name that is not a chain, and no call to the data layer), with one switch on, with all on, the key an agent is stored under equal to the one the pass writes, and, in stage 3, the watchlist and webhook code not asking which chains are served (the Arc work reversed this, and the test now says they do: [the record](./arc-watch-2026-10-20.md)).
  - `chainSwitch.integration.test.ts` (real MySQL): the same reads with the switches off, on one at a time and all on, on a database before 0046 and after it: counts, the breakdown, search, lookup by key, the entry page (with its look-alike count over the whole registry), the wallet census, the source list and the tabs' answer, which must equal what it was byte for byte with every switch off.
  - `chainTabsModel.test.ts`, `directoryProtocols.test.ts`, `evidenceExplain.test.ts`: the regions shown, the heading, the icons and colours, the totals, the labels, and the look-alike and wallet sentences. `chainTabsModel.test.ts` also had two assertions that read `ChainTabs.tsx` as text and expected `REGION_ORDER` in four places and the heading as a literal; the component now takes its regions from `regionsShown`, and the same facts are asserted on the new code (the heading is held equal to the old sentence).
- 37 small changes planted one at a time in the new code (a missing pause, no jitter, a timeout never retried, the host not compared, the URI-update step without the chain's rules, a switch not checked, a response cap back at BNB Chain's, a run sent to the wrong entry point, a value put mid-list in 0046, and others) were each caught.

## Checked

Type check clean. The production build passes, and the built server boots against a migrated database with the three switches off (schema current, the home page answers). The full suite on the finished stage 2 code: **230 files, 3,684 tests passed, 9 skipped, none failed** (stage 1's last run was 219 files and 3,419 tests).

**Stage 1 on the way.** The first full run had one failure, and it was real. `checkerPage.test.ts` holds the page's claims about what Nooscape reads to the source: it read `bscChain.ts` as text and expected it to name `BNB_FETCH_SENTENCE` and not to carry the old "did not fetch it" wording. Stage 1 moved that sentence with the code, so `bscChain.ts` no longer names it. The guard now follows the code and asks the same of the new places: BNB's entry in `erc8004Chains.ts` must take its sentence from `BNB_FETCH_SENTENCE`, the shared note builder must read `chain.fetchSentence`, and neither `bscChain.ts` nor `erc8004Chain.ts` may carry the old wording. Two planted regressions each fail it. It is the only existing test file edited for stage 1, two lines replaced by four. A later run on the committed tree failed one test in `dbBreaker.integration.test.ts`, which counts dials to a fake host, is sensitive to load, passes alone (3 of 3), imports only `dbBreaker.ts` and does not touch this change.

**Stage 2 on the way.** The first full run of stage 2 had one failure, the client's wallet guard: only `lib/wallet.ts` may contain `.ethereum`, and the operator page's switch table named a property that. It is `eth` now. The earlier tests edited in stage 2 are the two that pin the list of features (`features.test.ts`, `claimClient.test.ts`), because the list grew; `dbMigrations.test.ts` only gained tests.

**Stage 3.** Type check clean and the production build passes. The full suite on the finished stage 3 code, with the real database up: **233 files, 3,742 tests passed, 9 skipped, none failed** (stage 2's last run was 230 files and 3,684 tests). The built server was run against a seeded scratch database, built once with the three switches off and once with them on. Off: the home page has three tabs under "Robinhood, BNB, Solana. Same Owl, three skies.", the API index lists three chains, the tabs' answer has only `chains`, the breakdown and the public source list show the three original protocols (the other three sources were active and held 37 entries), a lookup of a Base agent answers 400 ("chain must be one of robinhood, bnb, solana") and a directory search finds none. On: six tabs under "...Same Owl, six skies.", the three extra tabs with their registry sentence ("The chain holds 30 registrations. The published listing rules put 24 of them in the directory; the rest are held out, not judged."), an entry page headed "ERC-8004 · BASE" with "This wallet has registered only this identity on Base.", the API index and search naming six chains and a Base lookup answering 200, and the developer page's extra paragraph. The full-field page needs a reviewed record to draw its totals, so the "listed from Base" line is held by its helper's tests and the type check, not by a page.

**Query plans.** On a 243,000-row copy of the directory, the breakdown query has the same access path with and without the new predicate (the entries by their hidden index, the source by its primary key) and the same time, because the predicate is on the source row, a table of seven.

**Other checks.** The differential check against main's BNB files was run again after stage 3 and is still equal on all 52 comparisons. 32 planted changes in the stage 3 code (9 of them needing the real database) were each caught, with every file put back byte for byte, as were 37 planted in the stage 2 code. The repo's secret scan is clean, a scan of the added lines and new files finds no long dash, control byte, Manus text or token-shaped string, and `rpc.mainnet.arc.io` is nowhere in the code.

## Not in these stages

(Update, 25 October 2026: the Arc identity pass has since been put on the scheduler, once a day, by migration 0050; see "Source-specific rules" in [worker-operations.md](./worker-operations.md).)

The scheduled flip of any new source. Map lights, pages, share cards, the Owl's Catch and the "just arrived" lines for the new chains (stage 3 lists and counts them, nothing more). Fetching registration files for the new chains: facts only, as BNB Chain started. The ValidationRegistry, reputation and feedback for the new chains, scores, tiers and evidence levels, webhooks and the watchlist for the new chains. (Arc has since been given the map lights, page, share card, census, "just arrived" card, Owl's Catch round numbers, watchlist and webhook, and claims, as the note above says. Ethereum and Base have the last four that the code applies to every extra chain that is on: "just arrived", the Owl's Catch's round numbers, the watchlist and the webhook.)

## Files

`server/ingestion/erc8004Chains.ts` (the list), `erc8004Chain.ts`, `erc8004Rpc.ts`, `runErc8004Chain.ts`, `chainPresets.ts`, `bscChain.ts`, `bscRpc.ts`, `runBsc.ts`, `evmIdentityChains.ts`, `worker.ts`, `types.ts`; `server/arcRpc.ts`, `server/x402.ts`, `server/_core/env.ts`, `server/routers/liveData.ts`, `server/dbMigrations.ts`; `shared/features.ts`; `drizzle/schema.ts`, `drizzle/0046_multichain_erc8004_protocols.sql`, its snapshot and journal entry; `client/src/pages/SourceOperations.tsx`; for stage 3, `shared/chains.ts`, `server/db.ts`, `server/agentRegistryRows.ts`, `server/apiChains.ts`, `apiV1.ts`, `apiV1Spec.ts`, `apiCheck.ts` (and `apiV1Testing.ts`, the tests' document checker), `client/src/components/home/ChainTabs.tsx` and `chainTabsModel.ts`, `client/src/pages/Home.tsx`, `DirectoryAgent.tsx` and `DeveloperApi.tsx`, `client/src/lib/directoryProtocols.ts` and `evidenceExplain.ts`, `client/src/index.css`; the fixtures `erc8004ChainFixtures.ts` and `erc8004TestChain.ts` (a chain that is not in the list, for tests); and the test files named above.

One rename came from a guard that was doing its job: the client's wallet guard lets only `lib/wallet.ts` contain `.ethereum`, so the operator page's switch table calls Ethereum's `eth`.
