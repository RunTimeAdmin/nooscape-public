# The host cap on the chain pass (21 October 2026)

Status: merged as PR #184 on 21 October 2026 and live. The pass on Ethereum, Base and Arc stores at most 2,000 registry rows for any one
host and counts the rest. BNB Chain is not capped. The rows stored before the cap were cleared the same day (see "Clearing what was stored"),
which took the database from 4,193 MB to about 1,900 MB of its 6 GB limit.

## Why

On 11 October one platform, Central City (centralcity.ai), began registering an agent on Base for every agent created on its site. It
needs no account to create one. The registrations arrive as ERC-4337 user operations: each deploys a fresh smart account for the agent and
has it call `register()`, and a paymaster pays the gas. The count went from 655 on the first day to 102,000 on 20 October, and has held at
about 5,800 an hour (139,000 a day) since. Every other host on Base together adds about 300 a day.

Each Central City agent costs the database a registry row (about 2.7 KB with its indexes, measured on production) and two ledger rows,
the mint and the hand-out about 20 minutes later (about 1.2 KB each): about 5 KB, so about 0.7 GB a day. Hostinger's Cloud Startup plan
allows one database 6 GB and suspends the database's write permissions past that
(https://www.hostinger.com/support/6976044-parameters-and-limits-of-hosting-plans-in-hostinger/ and
https://www.hostinger.com/support/5534251-what-to-do-if-the-database-size-limit-has-been-reached-in-hostinger/). On 21 October the
database measured 4,193 MB: registry rows 2,214, chain activity 1,614, directory entries 318, everything else under 25 MB. At 0.7 GB a day
that was about three days from the limit.

None of those rows is read. Every Central City registration is held out of the listing by the host rule (a host of 50 or more
registrations is a platform host), so the listing and the pages need the host's count and a few of its rows, not 480,000 of them.

## What the cap does

`hostRowCap` is a field of a chain's entry in `server/ingestion/erc8004Chains.ts`. Ethereum, Base and Arc set it to
`FLOOD_HOST_ROW_CAP`, 2,000: forty times the host rule's bar. BNB Chain sets none and stores every registration, as it always has.

For each window of a chain with a cap, `runErc8004Chain.ts`:

1. Decodes the window as before, then asks `keepWithinHostCap` (`server/agentRegistryRows.ts`) which registrations to store. A host that
   already holds its cap of rows takes no more, and the first registrations of a host in chain order are the ones stored. A registration
   whose URI has no https host is never capped. The room left for a host is read with a count that stops at the cap, so a host with
   hundreds of thousands of rows costs the same index range as one at the cap.
2. Counts the registrations it did not keep in `agent_directory_registry_overflow`, one row per source and host.
3. Inserts the kept registrations.
4. Asks `keepStoredTokens` which of the window's ledger events belong to a token that has a row, and writes only those. The mint of a
   counted token is dropped with its registration, and so is any later hand-out, transfer or URI update of it. Nothing rolls up onto a row
   that does not exist, so the ledger lost nothing a page reads.

The run's budget still counts what the window held, so a run does the same number of windows as before; it writes less.

### The count is exact, and applying a window again changes nothing

- `lastBlock` on the overflow row is the highest block counted for that host. A window whole-blocks wide is applied in chain order, so
  a block at or below it was counted already. The counter and its high-water mark move in one statement.
- A registration that already has a row is never counted, even when the host has no room left. A window that stored its registrations while
  the host had room, and arrives again after the host filled, counts nothing.
- The counter is written before the rows, so a crash between the two leaves a count with no double: the retry finds the same split.

### What the pages read

`readRegistryCounts` adds the host counts to the stored rows for "recorded", and `readRegistryGroups` adds each host's count to the group of
its stored rows, ranks the hosts again before the cut, and adds the total to "recorded". The pages therefore say what they said with every
row stored: Base still shows its full count, and Central City as its largest host. Wallets and profile links are counted over
stored rows only. The look-alike counts on a listed entry (`registryRelatedCounts`) are unchanged: a listed entry's host has fewer than 50
registrations, far under the cap.

### What the cap does not do

- A registration with no https host (an `ipfs://` URI, inline JSON, no URI) is not capped, because it has no host to count it under. A
  flood of those, each from a wallet of its own, would be stored. The rules would list it too (a link and a wallet of its own pass every
  rule), which is a limit of the rules and not of this change.
- A stored row whose URI is updated to another host leaves the host, and that frees room under the cap for a later registration.
- Rows stored before the cap are still there. See "Clearing what was stored" below.
- The census queries in `docs/base-census-queries-2026-10-21.sql` and `docs/arc-census-queries-2026-10-20.sql` count stored rows. For a
  capped host they now stop at the cap; add the host's `overflowCount` to read a total.

## Files

- `drizzle/0047_registry_overflow_counts.sql`: one `CREATE TABLE IF NOT EXISTS`. Not in `MANUAL_MIGRATIONS`, so on a database built from the
  repo the boot runner applies it before traffic. **It was not applied on production**: see "What went wrong at the deploy". Nothing is written
  to the table until a host passes its cap.
- `server/agentRegistryRows.ts`: `keepWithinHostCap`, `keepStoredTokens`, and the two readers above.
- `server/ingestion/erc8004Chains.ts`: `hostRowCap`, `FLOOD_HOST_ROW_CAP`, and the check that a cap is at least twice the host rule.
- `server/ingestion/runErc8004Chain.ts`: the two calls, only for a chain with a cap.
- Tests: `server/registryHostCap.integration.test.ts` (a real database; also run against MariaDB 10.11, the engine production runs),
  `server/ingestion/runErc8004Chain.test.ts`, `server/ingestion/erc8004Chains.test.ts`.

## What went wrong at the deploy

The change merged at 11:14:53Z on 21 October and was deployed by 11:15:26Z. Production's `nooscape_schema_migrations` already held a version 47,
`0047_base_scheduled_flip.sql`: the Base flip the operator applied by hand on 20 October, whose file was never merged. The boot runner counts a
version it finds recorded as applied and skips the file, so `agent_directory_registry_overflow` was never created. The new code was live and
read a table that did not exist, and the readers fail closed:

- `liveData.registryFleets` answered no formations for Base and Arc, so both chain pages drew none.
- `liveData.chainStats` left the registry sentence out of the Base and Arc Home tabs (`registry: null`).
- The Base pass had not run on the new code (its last run, 11:15:12Z, was on the old), so it never failed, and nothing was lost.

The operator pasted the `CREATE TABLE` at about 11:38Z. By 11:39Z Base showed its 24 formations and 447,287 registrations, Arc its 11 and 2,587.
Every test passed beforehand because the test database is built from the repo, which has no other 47.

The table exists by hand, and the bookkeeping still reads 47 as the flip. That is harmless: nothing reads the bookkeeping but the boot runner, which
skips 47 either way. A database built from the repo gets the table from this file.

The rule for next time: before numbering a migration, read production's log (`SELECT version, name FROM nooscape_schema_migrations ORDER BY
version DESC LIMIT 5;`) for numbers the repo does not hold. A change whose code reads a new table should have the owner create the table before the
merge, or read it in a way that survives its absence for one deploy.

## Clearing what was stored

The cap stops new rows. The rows stored before it stay until they are cleared. Clearing keeps the first 2,000 rows of the host in chain order,
which is what the cap would have stored, moves the count of the others into `agent_directory_registry_overflow`, and drops their ledger events.
The pages read the same before and after. It is safe to run while the pass runs: after the deploy, the new code stores nothing more for a host
that is over its cap.

### What was done on 21 October

| | Before | After |
|---|---|---|
| Central City rows stored | 343,946 | 2,000 |
| Central City registrations counted | 1,350 | 343,296 |
| Registry rows, all of Base | 447,287 | 105,341 |
| Ledger rows, Base | 825,413 | 147,309, none without a row (B ran seven times: six of 100,000 and a last of 78,104) |
| `agent_directory_registry_rows` | 2,214 MB | 1,035 MB (465,145 rows, BNB Chain's among them) |
| `agent_directory_chain_activity` | 1,614 MB | 535 MB (546,544 rows) |
| The database, six largest tables | 4,193 MB | 1,934 MB |

Base read 448,637 registrations before the cleanup and after it. Stored plus counted for Central City was 345,296 both times.

Two things went wrong, and the blocks below are the corrected versions.

- **phpMyAdmin resets `ROW_COUNT()` between statements.** The first version of A deleted with `LIMIT`, then read `ROW_COUNT()` to know how many to add to
  the count. Under phpMyAdmin it read nothing, so the rows went and the count was not added: the pages fell from 448,637 to 106,691 until the
  operator ran one guarded `UPDATE` that added the 341,946 removed rows (343,946 stored before, minus 2,000 after). The first version of B ended with
  `SELECT ROW_COUNT()`, which printed 0 after a delete of 100,000 rows, and the instruction "run until it prints 0" was met at once. The line
  to read is the one phpMyAdmin prints itself, "N rows deleted". The rehearsal ran in the MariaDB command-line client, which keeps `ROW_COUNT()`, so it
  did not show either fault.
- The corrected A counts its batch before it deletes (a count of the same set the delete takes), inside the transaction, and uses no `ROW_COUNT()`. It was
  rehearsed with an unrelated `SELECT` between every statement.

Rehearsed on MariaDB 10.11 (the engine production runs), on a copy with 150,000 flooding rows and 304,000 ledger rows: 150,000 rows became
2,000 with 148,000 counted through the right block, the ledger fell to 8,000 with no event left for a token without a row, and a run of
100,000 rows took 3 to 7 seconds. On production a run of 100,000 ledger rows took about 3 seconds.

Run these in the SQL tab, each with Go, in this order. Every block finds the source by its key, so there is nothing to fill in.

**0. Write down where you are.** Keep the numbers it prints, and the database's size.

```sql
SET @src = (SELECT id FROM ingestion_sources WHERE sourceKey = 'base-erc8004-identity-registry' AND protocol = 'erc8004_base');
SELECT (SELECT COUNT(*) FROM agent_directory_registry_rows WHERE sourceId = @src AND locatorHost = 'centralcity.ai') AS stored_flood,
       (SELECT overflowCount FROM agent_directory_registry_overflow WHERE sourceId = @src AND locatorHost = 'centralcity.ai') AS counted,
       (SELECT lastBlock FROM agent_directory_registry_overflow WHERE sourceId = @src AND locatorHost = 'centralcity.ai') AS counted_through,
       (SELECT COUNT(*) FROM agent_directory_registry_rows WHERE sourceId = @src) AS stored_all,
       (SELECT COUNT(*) FROM agent_directory_chain_activity WHERE sourceId = @src) AS ledger_rows;
```

**A. Registry rows. Run it again and again until `rows_counted_and_removed` is 0.** Each run is one transaction: it counts the next batch of up to
100,000 rows after the 2,000th, adds that number to the host's count, and deletes the batch, so a run that fails or is stopped counts nothing twice and
loses nothing. Read `rows_counted_and_removed` in the last result.

```sql
SET @src  = (SELECT id FROM ingestion_sources WHERE sourceKey = 'base-erc8004-identity-registry' AND protocol = 'erc8004_base');
SET @host = 'centralcity.ai';
SET @cut  = (SELECT mintBlock FROM agent_directory_registry_rows WHERE sourceId = @src AND locatorHost = @host ORDER BY mintBlock LIMIT 1 OFFSET 1999);
START TRANSACTION;
SET @n   = (SELECT COUNT(*) FROM (SELECT 1 FROM agent_directory_registry_rows WHERE sourceId = @src AND locatorHost = @host AND mintBlock > @cut LIMIT 100000) AS batch);
SET @top = (SELECT MAX(mintBlock) FROM agent_directory_registry_rows WHERE sourceId = @src AND locatorHost = @host AND mintBlock > @cut);
INSERT INTO agent_directory_registry_overflow (id, sourceId, locatorHost, overflowCount, lastBlock)
SELECT UUID(), @src, @host, @n, @top FROM DUAL WHERE @n > 0
ON DUPLICATE KEY UPDATE overflowCount = overflowCount + @n, lastBlock = GREATEST(lastBlock, @top);
DELETE FROM agent_directory_registry_rows WHERE sourceId = @src AND locatorHost = @host AND mintBlock > @cut LIMIT 100000;
COMMIT;
SELECT @n AS rows_counted_and_removed, @cut AS cut_block;
```

If the host has fewer than 2,000 rows, `@cut` is empty and nothing is deleted or counted.

**B. Ledger events of the tokens that no longer have a row.** Run it, read the "N rows deleted" line phpMyAdmin prints, and run it again
while N is 1,000,000. Stop when N is smaller. On the rehearsal copy one run removed 296,000 rows in 6 seconds.

```sql
SET @src  = (SELECT id FROM ingestion_sources WHERE sourceKey = 'base-erc8004-identity-registry' AND protocol = 'erc8004_base');
SET @cut  = (SELECT mintBlock FROM agent_directory_registry_rows WHERE sourceId = @src AND locatorHost = 'centralcity.ai' ORDER BY mintBlock LIMIT 1 OFFSET 1999);
DELETE FROM agent_directory_chain_activity
WHERE sourceId = @src AND blockNumber > @cut
  AND NOT EXISTS (SELECT 1 FROM agent_directory_registry_rows r WHERE r.sourceId = agent_directory_chain_activity.sourceId AND r.externalKey = agent_directory_chain_activity.externalKey)
LIMIT 1000000;
```

**C. Check.** Run block 0 again. `stored_flood` should be about 2,000, and `stored_flood` plus `counted` should equal the earlier
`stored_flood` plus the earlier `counted` (plus whatever the pass has counted since). This should return 0:

```sql
SET @src = (SELECT id FROM ingestion_sources WHERE sourceKey = 'base-erc8004-identity-registry' AND protocol = 'erc8004_base');
SELECT COUNT(*) AS ledger_rows_without_a_row FROM agent_directory_chain_activity a
WHERE a.sourceId = @src AND NOT EXISTS (SELECT 1 FROM agent_directory_registry_rows r WHERE r.sourceId = a.sourceId AND r.externalKey = a.externalKey);
```

**D. Rebuild the two tables, one at a time, the larger first.** A delete leaves the pages in place, so the sizes (and Hostinger's size for the database,
which is the sum of them) only fall after a rebuild. Each rebuild writes a copy of what remains, which is small by now. phpMyAdmin shows "Table does not
support optimize, doing recreate + analyze instead" for each, which is normal.

```sql
OPTIMIZE TABLE agent_directory_registry_rows;
```

```sql
OPTIMIZE TABLE agent_directory_chain_activity;
```

Then run the size query, and look at the database list in hPanel:

```sql
SELECT table_name, ROUND((data_length + index_length) / 1048576) AS mb, table_rows FROM information_schema.tables WHERE table_schema = 'app_database' ORDER BY (data_length + index_length) DESC LIMIT 6;
```

To clear another host or keep another number, change `'centralcity.ai'` and the `1999` (the cap minus one) in A and B. Arc's source key is
`arc-erc8004-identity-registry`.

## Operating it

Pausing and resuming a chain's schedule (the worker only picks sources whose policy is `scheduled`):

```sql
UPDATE ingestion_sources SET executionPolicy = 'manual_only' WHERE sourceKey = 'base-erc8004-identity-registry' AND protocol = 'erc8004_base';
UPDATE ingestion_sources SET executionPolicy = 'scheduled', nextRunAt = NOW() WHERE sourceKey = 'base-erc8004-identity-registry' AND protocol = 'erc8004_base';
```

A paused source keeps its cursor, so the next run walks the whole gap. With the cap that costs counts and no rows.

Checking a host after a run, with the source's id from `ingestion_sources`:

```sql
SELECT (SELECT COUNT(*) FROM agent_directory_registry_rows WHERE sourceId = '<id>' AND locatorHost = 'centralcity.ai') AS stored,
       (SELECT overflowCount FROM agent_directory_registry_overflow WHERE sourceId = '<id>' AND locatorHost = 'centralcity.ai') AS counted;
```

Rolling back: set `hostRowCap` aside in the chain's entry (a one-line change), and drop the table with `DROP TABLE agent_directory_registry_overflow`
and `DELETE FROM nooscape_schema_migrations WHERE version = 47`. The counted registrations are then not recorded anywhere; a walk from the
deploy block would store them again.
