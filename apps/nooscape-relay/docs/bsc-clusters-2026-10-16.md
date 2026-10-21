# BNB fleets and templates (PR-B2, check E)

Server and database only. No UI, no map, no change to the listing rules or the gate. BNB stays directory-only. Every row here is a shared fact with its date and never a score, a tier or a verdict.

The step groups the registrations of the BNB Chain ERC-8004 registry by what they share, and stores for each listed entry what that grouping found (gate G1 of AUTO_REVIEW_PLAN.md). PR-B3 (the lights) and PR-B5 (the gate) read it later. Nothing reads it today.

## What is stored

`bsc_clusters`, one row for each group:

| `kind` | The shared fact (`clusterKey`) | Stored when | `label` |
|---|---|---|---|
| `wallet` | a registering wallet | it registered 50 or more (`FLEET_MIN`) | none |
| `platform_host` | a host in the registered link | 50 or more registrations (the listing rule's own bar) | the host |
| `shared_link` | the SHA-256 of one profile link | 50 or more registrations record that exact link | the host, else the name every member records, else none |
| `template` | the template key of listed entries | two or more listed entries have it | one member's recorded name |
| `registry` | `all` | always, one row | none |

`memberCount` is the registrations in the group, `listedCount` the listed ones (zero for the first three kinds, because the listing rules already hold those out), `walletCount` the distinct wallets where it was counted. The `registry` row holds the registrations counted and the listed ones at the last refresh, and its date is how the step knows when the fleets were last recomputed.

The first three kinds are the shared facts the listing rules already use, counted over the whole registry from the recorded rows, and kept from the fleet size up so the table stays a few hundred rows. A shared link of 2 to 49 registrations is held out by the listing rules and is not stored here.

`bsc_entry_evidence`, one row for each listed entry (6,842 on 2026-10-16):

| Column | Meaning |
|---|---|
| `profileUriHash` | the link the evidence was read from. A different link on the registry row means the row is read again. |
| `readStatus` | `inline` (decoded from the link itself), `link_not_read` (a web or ipfs link), `unreadable` (the chain read failed for this id, or the inline JSON does not parse) |
| `templateKey`, `endpointHost` | the template key and the host of the first agent address, for `inline` |
| `g1` | `independent`, `template_group`, `wallet_fleet`, `wallet_fleet_and_template_group` or `unread` |
| `templateSize`, `walletRegistrations` | listed entries with the same template key (1 when none), and the wallet's registrations in the whole registry |

`unread` is not `independent`. An entry whose link is not read has no template to compare, so the step says it did not measure it. PR-B1 counted such entries as independent; the difference is explained below.

## The template key

The same function PR-B1 measured with (`templateKeyOf` in `server/bscB1.ts`): the name and the description, each with its case, width and punctuation normalized and every run of digits turned into `0`, and the lower-case host of the first agent address, hashed to 16 hex characters. The URI hash is not part of it: a link recorded twice is already held out by the listing rules, so every listed entry has a link of its own. An entry with neither a name nor a description has no key.

A web or ipfs link is not fetched. The /checker page does not say that Nooscape reads registration files, and it has to before the worker does. Those entries are `link_not_read` until it does: 376 of the 6,842 on 2026-10-16 (142 web, 234 ipfs). *Update 2026-10-17: the registration-file step reads them (see "Registration files" below). This step still never fetches a link.*

## When it runs

In the worker, after the sources and the Owl's Catch, only on a tick that claimed sources (a paused tick or one held back by the global interval fetches nothing, and neither does this). It never throws and never fails the tick: a failure is one log line, `nooscape_bsc_clusters_failed`, with no link and no key in it. The worker test pins that.

1. **The tables first.** With either missing, the step does nothing, asks the chain nothing and logs nothing (tested). The tables are made by the migration below.
2. **Fleets**, when the `registry` row is older than 6 hours or missing: four grouped counts over the registry rows, each served by an index (about 5 seconds in all on the full 375,343 rows on a laptop).
3. **Reading**, for the listed entries with no evidence or evidence for an older link: `tokenURI(agentId)` for 20 entries at a time through Multicall3 `aggregate3`, one `eth_call` of 20 compute units per batch, at most 40 batches and 20 seconds a run, paced at 75 CU/s through a token bucket (half of the 150 the plan allows), read at the `finalized` block. The URI read must hash to the link the registry row recorded; if it does not (the chain moved past the rows), the entry is left for a later run. A read that fails for one id alone, a token that reverts or a URI over 64 KiB, is settled as `unreadable` for that link and not asked again every run.
4. **Grouping**, when the fleets or any evidence changed: gate G1 over the listed entries from the evidence, written on each entry (one statement for the entries that share a result), and the template groups written to `bsc_clusters`. Evidence of an entry that is no longer listed is deleted.

The step skips a tick that has already run 90 seconds, and its own work stops starting at 20 seconds, so a tick with the BNB pass in it stays near what it was. A run with nothing to do takes about 100 ms.

## The migration (0038) is run by hand

The boot runner does not apply it. `0038_bsc_clusters.sql` is on the skip list (`MANUAL_MIGRATIONS` in `server/dbMigrations.ts`), so no deploy, restart or tick creates the tables. The file stays in `drizzle/`, in the journal and in the snapshot chain.

What it does: two new tables and nothing else. No `ALTER`, no index on an existing table, no data written, so it cannot slow or lock the tables the public reads scan. `CREATE TABLE IF NOT EXISTS` with every index inside, so running it again changes nothing. No foreign keys.

**Order.** (1) This code is deployed: it is inert, because the step finds the tables missing. (2) The owner runs the migration, when they choose. The first tick after that starts filling the tables: about eleven runs of up to 20 seconds, one a tick, so roughly three hours of ticks, then one short run for each newly listed entry.

**To run it.** Paste `drizzle/0038_bsc_clusters.sql` into the host's SQL console, on the production database. Then record it:

```sql
INSERT INTO `nooscape_schema_migrations` (`version`, `name`) VALUES (38, '0038_bsc_clusters.sql');
```

**To check.** `SHOW CREATE TABLE bsc_clusters;` and `SHOW CREATE TABLE bsc_entry_evidence;` show the tables, and `SELECT * FROM nooscape_schema_migrations WHERE version = 38;` shows the record. After the first runs: `SELECT kind, COUNT(*), SUM(memberCount) FROM bsc_clusters GROUP BY kind;` and `SELECT g1, readStatus, COUNT(*) FROM bsc_entry_evidence GROUP BY g1, readStatus;`.

**Rollback.**

```sql
DROP TABLE IF EXISTS `bsc_clusters`;
DROP TABLE IF EXISTS `bsc_entry_evidence`;
DELETE FROM `nooscape_schema_migrations` WHERE `version` = 38;
```

After that the step finds the tables missing and does nothing, and no other code path changes. The stored groups go with the tables.

## Endpoint-host groups (migration 0040)

Added on 2026-10-17, on the operator's decision ([record](./approvals/2026-10-17-bnb-census-report-and-b5-closed.md), "Answers given later on 2026-10-17"). PR-B1 found 328 independent entries on two endpoint hosts that no rule grouped. This rule stores those hosts as groups, and it does nothing more.

**The rule (`endpoint-host/1`, adopted 2026-10-17).** A host that 50 or more listed entries declare as the host of their first agent address is a group. 50 is `FLEET_MIN`, the bar of the other fleets. Only an entry whose registration is inline JSON has a host to count, and only an https address has one (`endpointHostOf` in `server/bscB1.ts`, the host B1 measured with). `ENDPOINT_HOST_RULE` in `server/bscClusters.ts` holds the version, the date and the bar.

`bsc_endpoint_host_groups`, one row for each host:

| Column | Meaning |
|---|---|
| `host` | the lower-case host |
| `listedCount` | listed entries that declare it |
| `walletCount` | the distinct wallets behind them |
| `ruleVersion`, `ruleDate` | the version of the rule that found the group, and the day the operator adopted that version. The step writes the code's current version, so a changed rule rewrites its rows with its own version and date. |
| `computedAt` | when the step last wrote the row |

**What it changes: nothing but this table.**
- No entry's G1 result changes. The entries on those hosts stay `independent` in `bsc_entry_evidence`; the groups are stored beside them and nothing uses them to relabel an entry.
- No light. The map, the key's total of groups and every page read `bsc_clusters` only, so these groups are not drawn and not counted there. A test (`bscClusters.test.ts`) fails if any file other than the clustering step refers to the new table. A light for them needs the operator's separate decision.
- The B1 report keeps its measured numbers and its footnote. The rule governs passes made after 2026-10-17. The 2026-10-16 measurement was made without it.
- A group says that many listed entries declare an address on one host. It says nothing about who runs them.

**What production will store.** The step reads inline registrations only, so its count for a host can be lower than B1's, which also read web and ipfs files. A host is stored only at 50 listed entries or more. B1's per-entry file for 2026-10-16 has two such hosts, with 257 and 102 listed entries, and every one of those entries is inline JSON. On that data the step stores the same two groups with the same counts. The next largest host has 14 entries and is not stored.

**The migration (0040) is run by hand.** The boot runner does not apply it. `0040_bsc_endpoint_host_groups.sql` is on the skip list (`MANUAL_MIGRATIONS`). One new table and nothing else: no `ALTER`, no index on an existing table, no data written, no foreign key, no nullable column. `CREATE TABLE IF NOT EXISTS`, so running it again changes nothing.

**Order.** (1) This code is deployed. The clustering step finds the table missing, skips this part alone, logs nothing and carries on with the rest (tested). (2) The owner runs the migration, when they choose. (3) The next grouping run stores the groups. Grouping runs when the fleets are recomputed (every six hours) or when a registration was read, so the rows appear within six hours.

**To run it.** Paste `drizzle/0040_bsc_endpoint_host_groups.sql` into the host's SQL console, on the production database. Then record it:

```sql
INSERT INTO `nooscape_schema_migrations` (`version`, `name`) VALUES (40, '0040_bsc_endpoint_host_groups.sql');
```

**To check.** `SHOW CREATE TABLE bsc_endpoint_host_groups;` shows the table and `SELECT * FROM nooscape_schema_migrations WHERE version = 40;` shows the record. Within six hours: `SELECT host, listedCount, walletCount, ruleVersion, ruleDate FROM bsc_endpoint_host_groups;`.

**Rollback.**

```sql
DROP TABLE IF EXISTS `bsc_endpoint_host_groups`;
DELETE FROM `nooscape_schema_migrations` WHERE `version` = 40;
```

After that the step finds the table missing and skips this part, and no other code path changes.

## Registration files (2026-10-17)

The operator approved reading the 376 web and ipfs entries, and the limits, on 2026-10-17 ([the record](./approvals/2026-10-17-bnb-registration-files.md)). A second best-effort worker step, `server/bscRegistrationFiles.ts`, after the Robinhood names, takes the listed entries whose evidence says `link_not_read`, reads their `tokenURI` again in one Multicall3 `eth_call` (the hash is all this step kept), reads the file behind each https or ipfs link through the safe fetch (256 KiB, 16 files a run, 6 from one host, a run every 30 minutes, the name reader's tries), and sets the evidence from it: `readStatus` `fetched`, the template key and the host of the first agent address. It then works gate G1 and the groups out again with `groupListed`. No agent address is asked. Nothing of the file is kept.

The statuses added to `bsc_entry_evidence.readStatus` (no migration; the column is 24 characters): `fetched`, `link_failed_<n>` (n tries that did not answer, five at most), `link_unparsed_<n>` (a file that is not a registration, or none, two at most), `link_not_fetchable` (an `http` address, another scheme, an ipfs address with no CID) and `unreadable` (the token reverts). A tried link waits 6 hours; the date is `readAt`. The pure rules are in `server/bscRegistrationFilesCore.ts`.

G1 treats `fetched` like `inline`: the entry has a template key to compare. The endpoint-host rule counts both kinds, with its version unchanged. The stored template groups grow toward B1's 150 groups holding 930 entries, which is what the report counts, so the map key's total of groups rises by the groups only these files form.

To see it work: `SELECT readStatus, COUNT(*) FROM bsc_entry_evidence GROUP BY readStatus;` after a day shows `link_not_read` falling to nothing and `fetched` rising by about 340.

## Against PR-B1's numbers

Measured by running the step, as the worker would, against a scratch MySQL holding the whole registry. The registry rows were built from the chain scan of 2026-10-16 (375,343 registrations) and classified by the production code (`classifyAgentRegistryListing`): 6,842 listed, 346,525 grouped, 16,575 without a link, 5,401 with a numeric name, the same as PR-B1's replay, which matched the public profile. The chain reads were real, through NodeReal. Eleven runs filled the evidence.

| | PR-B1 | PR-B2 | Why they differ |
|---|---|---|---|
| Wallets with 50 or more registrations | 34, holding 23,543 | 34, holding 23,543 | |
| Listed entries in a wallet fleet | 0 | 0 | the listing rule of 10 holds those out |
| Listed entries | 6,842 | 6,842 | |
| Template groups of the entries read from the link itself | 141 groups, 908 entries (recounted from the CSV) | 141 groups, 908 entries, the largest 300, 173, 63 | none |
| Template groups, all read entries | 150 groups, 930 entries | 141 groups, 908 entries | B1 also read 232 of the web and ipfs files, and 22 of those entries account for the 9 more groups and 22 more entries. B2 does not fetch. |
| Independent | 5,912 | 5,558, plus 376 unread | B1's 5,912 counts the 144 files it could not read as independent and the 22 above as grouped. 5,558 + 376 = 5,934 = 5,912 + 22. |

Registry-wide, the largest stored groups: hosts metadata.evoevo.ai 129,773, termix-platform-prod S3 40,871, evoevo.ai 7,174, q402.quackai.ai 6,728, api.evoevo.ai 1,353; shared links "Ave.ai Trading Agent" 126,839, "Debot Trading Agent" 9,684, "MevX Trading Agent" 591, and a link without a host 684. Counts of stored rows: 34 wallets, 15 hosts, 36 shared links, 141 templates, 1 registry row. Chain use for the whole fill: 11 runs, 6,842 reads in about 345 batches of 20 compute units each, about 6,900 CU, against 49,020 CU for PR-B1's scan.

## Limits

- **Inline JSON only, in this step.** 94.5% of the listed entries are inline JSON and are read in full. The 376 web and ipfs entries are `unread` until the registration-file step reads them through the safe fetch (decided 2026-10-17, below). PR-B1 found 20 of its 930 template-group entries among them.
- **Names are self-asserted.** A template's `label` is the recorded name of its lowest-id member that has one, cleaned like every public name. A group with the same name, description and host shares those, and nothing else is claimed: it does not say the entries have one operator, and it says nothing about whether they work.
- **The endpoint-host gap.** PR-B1 found 328 independents on two endpoint hosts (singularry.org, example-agent.ai) that no rule groups. `platform_host` is the host of the registered link, as the listing rule is, so these inline entries do not show in it. Since 2026-10-17 the endpoint-host rule stores the hosts as groups of their own (see "Endpoint-host groups" above). It does not change an entry's G1 result and it draws no light.
- **One refresh in six hours.** A fleet that forms in between shows at the next refresh. Template groups update on every run that read something.
- **The read is at the `finalized` block.** An entry whose link changed after that block is read again after the registry rows catch up.
