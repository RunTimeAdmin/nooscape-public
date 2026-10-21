# BNB rater credibility (PR-B4, check F and gate G4)

Server and database only, and internal. No UI, nothing public, no change to what the map, the directory or the gate show or do. A rating is supporting evidence and never a reason on its own to promote an agent.

## What the registry's feedback looks like

The BNB Chain ERC-8004 reputation registry sits at `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, the same address as on Robinhood Chain and behind the same implementation (`0x16e0fa7f…da34`, read from the ERC-1967 slot on both on 2026-10-16), so the event layouts the Robinhood adapter verified on the wire are the layouts here (three real BNB Chain logs are in the tests). It got its code at block 79,027,273, five blocks after the identity registry.

Read in full on 2026-10-16 (981 windows of 50,000 blocks, 982 requests, 49,065 compute units, paced at 75 CU/s):

| | |
|---|---|
| Events | 29,995: 29,994 ratings and 1 revocation, from block 79,376,784 to 128,035,745 |
| Ratings that stand | 29,993 |
| Raters | 129 wallets with a rating that stands (130 sent one) |
| Agents rated | 4,467 |
| Rated 20 agents or more | 36 wallets, 29,551 ratings (98.5%), 34 to 1,800 agents each; the next wallet rated 16 |
| Value exactly 70 | 53% of the ratings, 99.95% of them from those 36 wallets, with the tag `fragment` |
| A wallet rating its own agent | 0 |
| Wallets that also registered an agent | 22 of the 130 that sent a rating |
| The owner that received the most | 43% of the ratings, for its 230 agents |

## The rules

Each rule is a plain fact about wallets and events. None looks at what an agent is called, what it says or what it costs. A rater counts once for an agent, under the first rule that applies.

1. **Concentrated.** A wallet that rated 20 distinct agents or more. The bar sits in a measured gap: no wallet rated between 17 and 33 agents.
2. **A scripted batch.** Not concentrated, at least 5 ratings, and 90% or more of them one identical value (with its decimals). 5 wallets, 47 ratings. This is general, not tied to the value 70, which the concentrated wallets already cover.
3. **Tied to the agent's owner or fleet.** The owner's own wallet; a wallet that itself registered 50 agents or more (`FLEET_MIN`); or a wallet that registered an agent with the same profile link or the same host as the rated agent.
4. **Independent.** None of those.

Every rater set aside has weight 0 for that agent. An agent **qualifies** with three independent raters, unless its owner registered 50 agents or more, which puts the agent in a fleet (gate G1) whatever its raters say.

## Counts

On the whole registry, with every rating read from the chain and the registry rows replayed from it:

| Step | Agents |
|---|---|
| Rated | 4,467 |
| Three raters or more (the raw upper bound) | 331 |
| The same, less the agents whose owner is a fleet wallet | 60 |
| Three raters or more outside the concentrated wallets | 9 |
| After setting aside the scripted batches | 9 |
| After setting aside raters tied to the owner or fleet | 9 |
| **Qualify** (three independent raters, owner not a fleet) | **9** |

The plan estimated "raw at most 181" and "near 0 after discounting". Measured: 331 with three raters or more (the plan's 328 at Phase 0, a little later), 60 once the fleet-owned are left out (the plan's 181 came from a different cut, owners with more than 50 agents dropped, and was an upper bound; 60 is under it), and 9 after discounting, not 0. 954 of the 4,467 rated agents have a fleet owner.

The nine: seven are listed in the directory, one is held out as a shared link and one has no usable link. Three have 4 to 6 raters that rated nothing else among the nine. Two have 13 and 14 independent raters. Four are consecutive agents (341553 to 341556, whose ratings all name marque.trade) with the same six raters, so those four are one group of raters seen four times: counted as agents they are four, counted as groups of raters they are one. The rules do not see that, and it is the first thing to look at if the nine is ever used.

4,366 of the 4,467 rated agents were rated by a concentrated wallet. The ones only the concentrated wallets rated have no independent rater left.

## What is stored

`bsc_feedback_events`: one row for each event (29,995 now), so the check can be worked out again whenever the rules or the registry rows change. `bsc_rater_evidence`: one row for each rated agent, with the raw counts, how many raters were set aside by each rule, the independent ones left, the ratings that carry weight, the owner's registrations, whether the owner is a fleet, and whether the agent qualifies, dated. `bsc_reputation_state`: one row, where the read stands. Nothing public reads any of it.

## How it runs

A best-effort step of the worker, after the clustering, on a tick that claimed sources, with its own 25 second budget (skipped when the tick has already run 90 seconds). It never throws and never fails the tick; with the tables missing it does nothing and logs nothing.

1. It checks that the registry still sits behind the implementation the layouts were verified against, and stops, with one log line, if not.
2. It reads the events from where it left off to the finalized block, 50,000-block windows, one `eth_getLogs` each (50 CU), paced at 75 CU/s through the bucket the clustering uses (one bucket for both, so together they stay at half of the 150 the plan allows). It stops at a log that does not decode and does not move its cursor past that window.
3. Once it has caught up, and when ratings arrived or a day has passed, it works out the ratings and writes `bsc_rater_evidence`. A ledger that has not caught up is never described.

The first fill took 27 runs of about 25 seconds, 37 windows a run. After that a run asks two cheap questions (20 CU) and reads the one window the chain has grown into (50 CU); feedback has slowed to a few events a day.

## The migration (0039) is run by hand

The boot runner does not apply it. `0039_bsc_rater_evidence.sql` is on the skip list (`MANUAL_MIGRATIONS` in `server/dbMigrations.ts`), so no deploy, restart or tick creates the tables. Three new tables and nothing else; `CREATE TABLE IF NOT EXISTS` with every index inside, so running it again changes nothing; no foreign keys.

**Order.** (1) This code is deployed: it is inert, because the step finds the tables missing. (2) The owner runs the migration, when they choose. The first ticks after that fill the ledger.

**To run it.** Paste `drizzle/0039_bsc_rater_evidence.sql` into the host's SQL console, on the production database. Then record it:

```sql
INSERT INTO `nooscape_schema_migrations` (`version`, `name`) VALUES (39, '0039_bsc_rater_evidence.sql');
```

**To check.** `SHOW CREATE TABLE bsc_rater_evidence;` shows the table, and `SELECT * FROM nooscape_schema_migrations WHERE version = 39;` the record. After the fill: `SELECT nextBlock, finalizedBlock, evaluatedAt FROM bsc_reputation_state;` and `SELECT qualifies, COUNT(*) FROM bsc_rater_evidence GROUP BY qualifies;`.

**Rollback.**

```sql
DROP TABLE IF EXISTS `bsc_rater_evidence`;
DROP TABLE IF EXISTS `bsc_feedback_events`;
DROP TABLE IF EXISTS `bsc_reputation_state`;
DELETE FROM `nooscape_schema_migrations` WHERE `version` = 39;
```

After that the step finds the tables missing and does nothing, and no other code path changes.

## What it does not show

- **Not a verdict on an agent.** A qualifying agent has three raters that are not in the concentrated group and not tied to its owner by the facts above. That says nothing about whether it works or is any good, and a rater can be someone the owner knows by other means.
- **The rules see wallets, not people.** One operator with many wallets, each rating a few agents, is not found. Neither is a small group of wallets rating a set of related agents (the four consecutive agents above).
- **The ties are approximations.** Sharing a host is a hint, and a platform host can be shared by unrelated people; setting such a rater aside only lowers the count. A link between an owner and a rater through funding or a shared contract is not read.
- **Past ratings only.** A rater that rates many agents later is concentrated from that day, and agents it rated earlier lose it as an independent rater at the next evaluation.
- **Self-asserted values.** The value of a rating is whatever the rater sent. The check never uses it as a measure of quality.

## Decisions for the operator

1. **The bars.** 20 agents for a concentrated wallet (the measured gap is 17 to 33), 5 ratings and 90% for a batch, 3 independent raters to qualify, and 50 registrations for a fleet owner. They are constants in `server/bscRaters.ts` and each is tested at its boundary.
2. **Count groups of raters, not only raters.** The four sibling agents show the weakness. Counting a set of raters that rated the same set of agents as one would take the nine to about six. It is a further rule and is not made here.
3. **Public copy.** The plan allows a factual line ("X% of ratings come from N wallets") only after the operator approves the words. Nothing was shown until 2026-10-17, when the operator asked for a dated report (see the addendum). He reviewed the page and asked for it to be merged the same day.

## Addendum, 2026-10-17: the figures behind the public report

The report at [/field/bnb-ratings-2026-10-16](../client/src/pages/BnbRatingsReport.tsx) is a dated aggregate of this read, in the pattern of the census report: no agent, wallet or host is named, nothing is ranked or scored, and every number on it is in `client/src/lib/bnbRatingsReport.ts` with its source, held to this document by a test.

Every figure in the tables above was worked out again on 2026-10-17 from the saved ledger and registry of the read (`rep-chain.jsonl`, `chain.jsonl` and `rep-scan.json` in the gitignored `bsc-b1-output` folder), with the production rules in `server/bscRaters.ts`, and all of them matched. The report also states these, which the tables above do not:

| | |
|---|---|
| Finalized block the read stopped at | 128,045,092 |
| Ratings sent (events less the revocation) | 29,994 |
| Ratings with the value 70 | 16,028 |
| Of those, from the 36 concentrated wallets | 16,020 |
| Agents among the nine that share a set of raters | 4 |
| Wallets in that shared set | 6 |
| The nine, counted as groups of raters | 6 |

The owner that received the most ratings (43%) registered 230 agents, and 195 of them were rated. The report says the share and not the count.

The four agents that share a set of raters are consecutive, as described under "Counts". Counting groups of raters and not agents takes the nine to 6. The report says so under the nine, and the rule that would do the counting is still not made (decision 2 above).
