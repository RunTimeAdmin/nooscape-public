# Agent checks (2026-10-16)

> **Status:** Live since 2026-10-16. Stage 1 (the server side) and stage 2 (the public read, the agent page that shows each check with its date, and the wording on the site) are deployed, migration 0037 was run by hand and the second cron job runs at :07 each hour. The first check ran at 10:40Z the same day (see "The first run"). Stopping the checks is deleting the cron job.

## What it does

Nooscape-Checker asks the endpoints that reviewed agents declare whether they answer, and records the fact with its date: that an answer came, its status, how long it took, and a fingerprint of the first 4 KiB. That is what the [decision record](./approvals/2026-10-15-informational-use-and-bnb-map.md) allows and what the [`/checker` page](./safe-fetch-2026-10-15.md) promises. A check never changes a tier, whether an agent is listed, its order or its place on the map, and what it finds is never a verdict. It asks through the [safe fetch](./safe-fetch-2026-10-15.md): https only, the connection pinned to the checked address, robots.txt first, a second between two requests to a host.

## Which endpoints, how often, how much

| | |
|---|---|
| Which | An endpoint is asked when **the approved version of an active A2A source declares it**, for an agent in the served reviewed set. That is the gate the public reads use, applied to the endpoint's own observation: the source is `active`, its decision is `public`, and the observation belongs to the run the operator approved. Only https ones. A withdrawn agent, a hidden one and an acknowledged-only directory entry are never asked. |
| Where they come from | `agent_endpoints`, which the ingestion writes. In practice **only the A2A source gives an address worth asking today**: an agent card's own `url`, at a host the operator approved. The catalog (Agenstry) pass writes none. The Robinhood, Solana 8004 and census passes write none. **The Metaplex (Solana registry) pass writes one**, a route on `api.metaplex.com` (`/v1/agents/<mint>/a2a`) that Metaplex serves for its own agents, and its boundary document limits that source to a public list with no A2A invocation. It is not an address the agent declared, so it is not asked (`CHECKABLE_SOURCE_PROTOCOLS` is `["a2a"]`). Checking Metaplex's would be a decision of its own, with its signal ("Nooscape did not invoke it") changed first. How many addresses the first run finds is in its answer (`due`), and it was one (see "The first run"). |
| A URL from a run nobody approved | Not asked until that run is approved. A card that changes its `url` writes a new endpoint row whose observation belongs to the newer run, so it waits for the operator, like the record does. So does a card that changes in any other way and keeps its `url`: the ingestion moves the existing endpoint row to the new observation (observations are per content hash, over the raw bytes), so the endpoint pauses until that run is approved, and its last check keeps its date. A card that has not changed is linked to every run that sees it, so it stays eligible when a newer run is approved. **A card whose bytes change on every fetch is in effect never asked**, because the A2A sources are fetched every 15 to 30 minutes and it is eligible only between an approval and the next fetch. That fails safe (it asks less), and a proper fix needs the ingestion to record which observation declared which endpoint. Before switching on, `SELECT sourceId, COUNT(*) FROM source_observations WHERE protocol = 'a2a' GROUP BY sourceId;` shows whether it matters today: a count close to the number of runs means a card changes on every fetch. |
| A URL the approved version no longer declares | Stops being asked when the operator approves the run that no longer shows it. Nothing deletes an endpoint row, and the gate is what makes a stale one fall out. |
| One address, many endpoints | An address that several endpoint rows declare is asked once, and a row is recorded for each. |
| How often | An address is due when it has never been checked or the **latest check of any endpoint that declares it** is a day old (`CHECK_INTERVAL_MS`), so a new endpoint row for an address asked an hour ago does not make it due. In practice 24 to 25 hours: the time is taken after the answer and MySQL rounds a timestamp up to the second, and due is judged when a run starts. That asks less, not more. The cron job can run as often as the owner likes; it only changes how soon a due address is reached. |
| In what order | Never checked first, then the one checked longest ago, then dealt out across hosts one at a time, so a host with many endpoints cannot hold up the rest. |
| How much a run does | At most 40 addresses (`CHECKS_PER_RUN`), none started after 20 seconds (`CHECKS_START_WINDOW_MS`), five at a time, a budget of 120 requests with robots.txt counted. One address can take about 25 seconds from its start (a redirect through new hosts reads each host's robots.txt, each with its own 5 seconds) and a write can wait for a connection, so a run normally ends in well under a minute and is not cut by the CDN's. Addresses not reached stay due for the next run. |

### The address a card declares

The endpoint of an A2A agent is read from its card by `normalizeA2aAgentCard` (`server/ingestion/a2a.ts`). The top-level `url` of an A2A 0.3 card is read first, as it always was, and a card whose `url` is present and not https is still refused. Without one, the first `supportedInterfaces[].url` that is a valid https address is taken: an A2A 1.0 card lists its interfaces in order of preference, so the first is the card's own choice. An interface that is not https (a gRPC `host:port`, say) is passed over, and a card with no https interface is not refused for it. The address is only read. Nothing here calls it; what asks it is the run described below.

Two live cards declare an address this way: agents.txt's top-level `url` (`https://agents-txt.com/a2a`) and AgentCard.net's interface (`https://www.agentcard.net/api/agent-card`, binding HTTP+JSON, A2A 1.0). The Nooscape Observatory card declares none.

**When AgentCard.net's address is first asked.** The ingestion hangs an endpoint on the observation of the card it read, and an observation is kept by its content. AgentCard.net's card has not changed, so the next scheduled run of its source finds the observation that the approved run already holds, and the new endpoint hangs on it. The gate asks whether the endpoint's observation belongs to the approved run, and it does, so the next run of the checks asks the address without the later run being approved (a test against a real database does exactly this). A card that does change writes a new observation, which the approved run does not hold, and its address waits for the operator as before. `parserVersion` is unchanged, because nothing reads it.

## What a run does

1. **Probes the checks table.** If it cannot be read (the migration has not been run, the database is busy) the run answers `unavailable` and **asks nobody anything**. Which addresses are due is read from this table, so nothing can be asked that cannot be recorded.
2. Reads the served agent ids, their endpoints through the gate above, and the latest liveness check of each.
3. Leaves out an address this process asked within the last day, whether or not its row was written (see "Nothing asked that cannot be recorded"), and works out the due addresses and the order.
4. Asks each address through the polite fetcher and records the result as soon as it arrives, so a run that stops half way keeps what it did.
5. Logs one line of counts (`nooscape_checks`) and answers with the same counts. No address, host or path is in the log or the answer.

A second call while a run is going answers `busy` and does nothing (one run at a time in the process). A result that is `budget_exhausted` is not recorded, and its address stays due.

**Nothing asked that cannot be recorded.** The probe only proves a read, so two more things hold the line. If a row cannot be written (the app's user lacks `INSERT` on the hand-made table, the database stopped accepting writes), the run stops there, and the answers already in flight (at most five) are lost. And the process remembers each address it asked and does not ask it again for a day, so a database that keeps refusing writes costs each address one ask a day, not one a run. The memory is in the process and is lost on a restart. Runs after a failure would look like "nothing is due", so they report `heldBack` and log it.

## What is stored

One row for each ask of each endpoint, in `agent_checks` (migration 0037, `drizzle/schema.ts`):

| Column | Meaning |
|---|---|
| `id`, `agentId`, `endpointId` | The row, the agent and the endpoint row it was for. No foreign keys: nothing refers to the table and it refers to nothing. |
| `kind` | `liveness`. The column exists so later checks (metadata, `.well-known`) can share the table. |
| `checkedAt` | When. |
| `outcome` | `answered`, `no_answer` or `skipped`. |
| `reason` | A safe-fetch reason for `no_answer` and `skipped`, null for an answer. |
| `statusCode`, `latencyMs`, `bodySha256` | For an answer only: the status, the time, and the SHA-256 of the first 4 KiB. The body is not kept. |

Two indexes, both with the kind in them: `(endpointId, kind, checkedAt)`, which the run's latest-check read uses from the index alone and the agent page's read uses to find the newest row of an endpoint, and `(agentId, kind, checkedAt)`, which no read uses yet (the page reads by endpoint).

How a result becomes an outcome (`factsOf`, held by a test typed on every reason, so a new reason has to be decided before the tests compile):

| Outcome | When |
|---|---|
| `answered` | Any complete HTTP answer. A 404, a 401 or a 500 is an answer and a fact, not a verdict. |
| `no_answer` | The host was asked and did not answer in full: `timeout`, `connection_failed`, `tls_failed`, `response_invalid`, `unresolvable`. |
| `skipped` | The ask was not made or was stopped by a rule, not by the host: `robots_disallowed`, `robots_unavailable`, `forbidden_host`, `forbidden_address`, `not_https`, `invalid_url`, `credentials_in_url`, `port_not_allowed`, `redirect_invalid`, `too_many_redirects`. |
| not recorded | `budget_exhausted`. |

**A host that is down is `no_answer`, not `skipped`.** robots.txt is the first request, so a host that refuses connections, times out or has a bad certificate fails there. The polite fetcher now gives the host's own reason (`connection_failed`, `timeout`, `tls_failed`, `response_invalid`, `unresolvable`) when robots.txt could not be fetched because of the host, and keeps `robots_unavailable` for a robots.txt that answered badly (a 5xx, a 429, too long, sent to something that is not a robots.txt). Before this was fixed every dead host would have been stored as `skipped` for good, because rows are never updated.

## What it never does

- It writes one table, its own. A test reads the module and fails on any other insert, on any database update or delete, and on any mention of a tier, the read model, a hide or a withdrawal. It does not set `agent_endpoints.lastHealth` (`healthy` and `unreachable` would read as verdicts); nothing reads that column.
- It does not ask anyone unless it can record the answer, and it does not ask an address twice in a day because a write failed.
- It does not put an address in a log or an answer. A failure is logged with its reason: the driver's error and code lead, the query is cut short, and the parameters are dropped.
- It is not reachable without an operator: there is no public procedure for it (a test goes through the real router). Like the other operator procedures it accepts the operator's token or an operator session, which is the same authority.

## What the site shows (stage 2)

**The read.** `liveData.agentProfile` carries `checks` for a reviewed record, from `readPublicChecks(agentId)` in `server/agentChecks.ts`. An acknowledged entry gets an empty list and the checks are not even read for it. The read never throws: with no database, with the table missing (migration 0037 not run yet, which is silent) or on any other failure the answer is an empty list. Anything but a missing table or an open connection breaker leaves one log line, `[LiveData] agent checks read failed:`, with the driver's reason and no address. A failing read cannot turn a reviewed record into "none".

**Which checks.** The endpoints the run would ask for that agent, through the same gate, so a check is shown only while its endpoint is still one that the approved version of an active A2A source declares, over https. If the operator approves a run that drops it, pauses the source or revokes its decision, the check goes from the page at once, whatever rows the table holds. An agent that declares no such endpoint (most reviewed records) costs no read of the checks table. At most 10 endpoints are read, one read of the endpoint index for each.

**What is shown.** One line for each host, newest first: the host and not the address (no path, no query), a sentence with the date and whether the ask got an answer, with the status code and the time (the wording is under "Display rules" below). The line says what the ask got, never that the host answered: the checker follows redirects, so the last answer can come from another host (an endpoint behind a sign-in gateway redirects to the gateway's host, which answers 200), and a failure can be a later hop's. The Checks section says so. The line is the newest check of the endpoints on that host. The reason, the fingerprint and the endpoint and agent ids never leave the server: `PublicCheck` has no field for them, and the tests compare the whole object.

**What is not.** An ask that a rule stopped (`skipped`) is not shown, and neither is an older answer in its place: if a site puts Nooscape-Checker in its robots.txt, the next ask records that and the earlier check goes from the page. A host is shown by its newest check, whichever of its endpoints that was for, so a stopped ask also hides an older answer of another endpoint on the same host (robots.txt covers the whole host). A check of another kind is ignored. A line stays, with its date, until the next ask replaces it, so if the cron job stops the page keeps showing a check that is 20 days old as 20 days old. Before the first check an agent shows no Checks section at all, not "not checked yet".

**The agent page.** A "Checks" section (`dossier-checks`) after the evidence timeline, for a reviewed record with at least one line. It says what the checker is, that any HTTP answer counts, and that a check which gets no answer says nothing by itself, and it links to `/checker`. A line is the host with one sentence under it (see "Display rules" below), with a neutral dot (nothing lights a line). No word grades a host (a test fails on "healthy", "down", "offline", "verified" and the like), except "failing", the operator's own word for three misses in a row, and the page reads the answer by typed access, never by a cast of the whole answer.

### Display rules (2026-10-16)

The operator set three rules for how the agent page words a check. They replaced the first wording ("The ask got HTTP 404 in 124 ms." and "The ask got no complete answer."):

- **A miss is a fact in plain words, and it is retrying.** "Got no answer on Oct 16 at 2:10 PM CT, retrying." No number and no score. The time is the viewer's own, in their own zone (`formatWhen` in `client/src/lib/checkText.ts`: "CT" where the browser knows the generic zone name, "CDT" where it knows only the plain one), with the year only when it is not this year.
- **"Failing" only after three misses in a row.** "Failing: the last three asks got no answer, the latest on Oct 16 at 2:10 PM CT." It says nothing about why. The three are the newest asks of one endpoint (`PUBLIC_CHECKS_FAILING_AFTER`; the read takes them from the endpoint index with `LIMIT 3`, so no history is read), by when they were made and not by the order the rows arrive in. An answer among them ends the run, and so does an ask that a rule stopped (`skipped`: that was not a miss). The count is for one endpoint, so two endpoints on one host do not add their misses together; the line is still the newest check of the host. `PublicCheck` gained one boolean, `failing`, and no count, and a line that answered is never failing.
- **A 404 or a 405 to a plain GET is not a dead address.** "On Oct 16 at 2:10 PM CT the ask got HTTP 404: a plain GET is not served there. Nooscape does not send POST, so whether it takes POST is not tested." The status stays, because it is the fact. The operator asked for "responds to POST only, not tested"; a 404 does not show that an address answers POST, so the line says what is known: a plain GET is not served, and POST is not tried. An A2A endpoint takes POST JSON-RPC, so a GET to its path commonly answers 404 or 405 (agents.txt's answered 404 in 124 ms).
- Any other status is the answer it is: "On Oct 16 at 2:10 PM CT the ask got HTTP 200 in 184 ms."

The date moved from a line under the host into the sentence, so each line reads whole by itself, and the dot stays neutral. `/checker` says the same in "What it records" (failing only after three in a row, and what a 404 or a 405 is shown as), and a test holds its number to the constant. The word "failing" is the one grading word the Checks section may use, in the note that defines it and in the sentence of a line whose last three asks got no answer; a test fails on any other.

Shown in a real browser against the built server, with a line of every kind (an answer, a miss, three misses, a 404, a 405 and a 503) at 1440 and 375 wide: no overflow, nothing under 12px in the section, no console problem.

### The copy that said Nooscape asks nothing

Each place was read against what the checks do, and changed only where it stopped being true:

| Where | It said | It says now |
|---|---|---|
| `/checker`, the note at the top | No request has been made yet | It checks one thing, whether an endpoint that the published card of a reviewed agent declares answers; reads robots.txt first; asks each endpoint at most once a day; and the agent's page shows the latest check with its date |
| `/checker`, "What it asks for" | A profile link or an endpoint, and `/.well-known/` paths | One endpoint address and where it redirects to, and apart from /robots.txt nothing else on the site |
| `/checker`, "How gently", "What it records", "How to make it stop" | No daily limit; a run of failures "may be shown as not answering"; a change picked up "within a day" | At most once a day for each endpoint address, and robots.txt read each time it visits a site; what it records now includes the reason and says the status is after any redirects; a failure is a fact with its date; a change is picked up the next time it would ask the site, and a robots.txt that keeps it out removes the earlier check from the agent's page |
| `/checker`, the introduction and "Why it may ask your site" | Registries and registrations | Registries and published agent cards, because the checks begin with A2A cards |
| The About page, "What Nooscape is not" | "does not fetch arbitrary URLs" | See below |
| The sources page | "Manual runs only" and "approved for bounded manual observations" (ten of the twelve live sources run on a schedule), every source labelled "A2A", and an active status "authorizes only a bounded AgentCard metadata fetch" | "Scheduled or manual runs"; each source shows its own protocol; an active status authorizes bounded reads of public data from that source, scheduled or run by an operator, and for an A2A source also a check once a day that the endpoints its approved cards declare answer |
| The note on every Solana 8004 entry ("Source note" on the entry page) | "no off-chain content is fetched" | "... When that gives no name, the pass may fetch the registration link to read one." The next pass rewrites every row |
| The home funnel step "Reachable at a locator" | An entry with a locator host counted as reachable | "Locator host recorded" |

**The About line was already untrue before the checks.** The Solana 8004 pass (`server/ingestion/registrationFetch.ts`; its source is active) fetches the registration links that registrants wrote on chain, to read a name: its own header counts about 755 ipfs links and about 410 https links on third-party hosts. Nobody at Nooscape chose those addresses. The line now says what is true: Nooscape does not crawl the open web or invoke discovered tools, and it asks the addresses that approved sources' records name, such as the endpoints reviewed agents declare, within limits on time and size. That fetch moved onto the safe fetch on 2026-10-16 ([the safe-fetch record](./safe-fetch-2026-10-15.md), "The 8004 name fetch"): it now sends the Nooscape-Checker user agent, reads robots.txt and pins its connection, and `/checker` describes it.

**Left as they are, and why.** The BNB card on the home page ("Nooscape did not fetch any profile link"), the signals the BNB and Robinhood passes record ("Nooscape did not fetch it") and the Metaplex one ("Nooscape did not invoke it") stay true while the checks are not asked of those sources. `server/checkerPage.test.ts` fails if `CHECKABLE_SOURCE_PROTOCOLS` gains `erc8004_bsc`, `erc8004` or `solana_registry`, so adding one has to change those words first. The decision record expected the BNB copy to change with the first check; it does not need to, because the first check asks no BNB link. The glossary's "fetched from an approved source" is about the ingestion and is true, and so are its "Uptime over time" (the checks are daily samples of reviewed A2A endpoints and nothing shows an uptime) and "Whether an acknowledged agent is alive" (acknowledged entries are not checked).

## The endpoint and the second cron job

`liveData.admin.runChecks`, an operator procedure like `runWorkerTick` (same header, same token, same `{}` body). It answers with the run's counts:

```json
{ "state": "completed", "due": 3, "taken": 3, "heldBack": 0, "asked": 3, "answered": 3, "noAnswer": 0, "skipped": 0, "notReached": 0, "recorded": 4, "failedToRecord": 0, "ms": 2400 }
```

`state` is `completed`, `unavailable` (the table cannot be read, nobody was asked) or `busy`. **`heldBack` above zero with `taken` at zero is not "nothing is due".** It counts the addresses the database says are due that this process refused to ask again because it asked them within the day, which happens only when the rows of those asks were lost: writes are failing. The run logs a line for it too.

The cron job is the owner's to create in hPanel, when the migration has been run and stage 2 is live. It is the existing job's shape with another path, an hourly schedule that stays off the ingestion tick's quarter hours, and a shorter limit:

```
7 * * * *  curl -fsS --max-time 90 -X POST -H 'x-nooscape-operator-token: <the operator token>' -H 'content-type: application/json' -d '{}' https://nooscape.si/api/trpc/liveData.admin.runChecks
```

The body has to be `{}`: the cron runner strips double quotes. Deleting the job stops the checks at once, with nothing else to undo.

## The first run (2026-10-16)

The cron job was created in the morning. Its first scheduled call, at 10:07Z, was refused with a 401: the token in the job's command was not the one the app holds. A call by hand at 10:30Z answered `unavailable`, and the runtime log carried one `nooscape_checks_failed` line, `Table 'u373211336_nooscape.agent_checks' doesn't exist (ER_NO_SUCH_TABLE)`: the table was not in the app's database yet. Nothing was asked at either point, which is the design. After the table was created, the run at 10:40Z answered:

```json
{ "state": "completed", "due": 1, "taken": 1, "heldBack": 0, "asked": 1, "answered": 1, "noAnswer": 0, "skipped": 0, "notReached": 0, "recorded": 1, "failedToRecord": 0, "ms": 1155 }
```

The one address was `https://agents-txt.com/a2a`, from the agents.txt Reference Agent's card. It answered **HTTP 404 in 124 ms** to a plain GET (an A2A endpoint takes POST JSON-RPC, so a GET to its path commonly answers 404 or 405). That is an answer and is shown as one. The agent's page first read "The ask got HTTP 404 in 124 ms." under the host and the date; since the display rules above it reads that a plain GET is not served there and that POST is not tested.

**Why one address and not a handful.** On the day of the first run the A2A adapter read only a card's top-level `url`. Of the three live A2A cards, agents.txt's declares `https://agents-txt.com/a2a`; AgentCard.net's lists its interface under `supportedInterfaces` (A2A 1.0), which was not read; and the Nooscape Observatory card declares no URL. So one reviewed record had an endpoint to ask. The adapter now reads `supportedInterfaces` too (the operator said yes on 2026-10-16; see "The address a card declares"), which adds AgentCard.net's.

## The migration (0037) is run by hand

The boot runner does not apply this migration. `0037_agent_checks.sql` is on its skip list (`MANUAL_MIGRATIONS` in `server/dbMigrations.ts`), so no deploy, restart or tick creates the table. The file stays in `drizzle/`, in the journal and in the snapshot chain, so drizzle-kit's picture of the schema stays whole.

What it does: one new table and nothing else. No `ALTER`, no index on an existing table, no data written, nothing rebuilt, so it cannot slow or lock the tables the public reads scan. `CREATE TABLE IF NOT EXISTS` with both indexes inside it, so running it again changes nothing.

**Order.** (1) This code is deployed: it is inert, because `runChecks` answers `unavailable` and asks nobody while the table is missing and nothing calls it. (2) Stage 2 is live. (3) The owner runs the migration. (4) The owner creates the cron job. Doing (3) before (2) is harmless; doing (4) before (2) would have the old `/checker` note, the About line and the sources page say Nooscape asks nothing while requests are being made. All four were done on 2026-10-16.

**To run it.** Paste `drizzle/0037_agent_checks.sql` into the host's SQL console, on the production database, and run it. Then record it, so the bookkeeping matches:

```sql
INSERT INTO `nooscape_schema_migrations` (`version`, `name`) VALUES (37, '0037_agent_checks.sql');
```

**To check.** `SHOW CREATE TABLE agent_checks;` shows the table, and `SELECT * FROM nooscape_schema_migrations WHERE version = 37;` shows the record. Before the first run, `SELECT SUBSTRING_INDEX(SUBSTRING_INDEX(endpointUrl, '/', 3), '/', -1) AS host, COUNT(*) FROM agent_endpoints GROUP BY host;` shows which hosts the endpoint rows name (only the A2A source's are asked). After the first run, `SELECT outcome, COUNT(*) FROM agent_checks GROUP BY outcome;` shows what came back.

**Rollback.** Delete the cron job, then:

```sql
DROP TABLE IF EXISTS `agent_checks`;
DELETE FROM `nooscape_schema_migrations` WHERE `version` = 37;
```

After that `runChecks` answers `unavailable` and asks nobody, and no other code path changes. The stored checks go with the table.

## The promises on `/checker`, and where each is kept

| On the page | Kept by |
|---|---|
| One endpoint address that a reviewed agent's card declares, and where it redirects to; apart from /robots.txt nothing else on the site | The endpoints come from `agent_endpoints` through the gate: an A2A source's approved version, an agent card's own `url`. No `.well-known` path and no profile link is asked, and the page names neither (a test). |
| GET over https on port 443, robots.txt first, no cookie, no private address | The safe fetch and the polite fetcher (`server/safeFetch.ts`, `server/politeFetch.ts`). |
| Each address at most once a day | `CHECK_INTERVAL_MS`, which `server/checkerPage.test.ts` holds the page to. |
| One request a second to a host, five at a time, 5 seconds, 4 KiB, 3 redirects | The same, and `server/checkerPage.test.ts` holds the page to those constants. |
| Records the date, whether it answered, the status, the time and a fingerprint of the first 4 KiB, which is not shown | The columns above. Nothing else about an answer is stored, and the fingerprint is not in what the page reads. |
| Never changes a tier, whether an agent is listed, its order or its place on the map | The module writes only `agent_checks`, by test. |
| A failure says nothing by itself | No verdict is computed anywhere. The page shows a miss as a fact with its date and says the checker is retrying, says "failing" only when the last three asks in a row got no answer (and nothing about why), and a test fails on any other grading word in the section. |
| Shown on the agent's page with its date | `readPublicChecks` and the Checks section. A test holds `/checker` to the section existing and linking back. |
| A robots.txt that keeps it out removes the earlier check from the page | A `skipped` latest check shows nothing (`readPublicChecks`, by the integration test). |

## Independent review (2026-10-16)

A separate read-only reviewer read the stage before anything was switched on, ran it against real databases and reproduced each finding. Its findings, and what changed:

1. **High: Metaplex's route would have been asked.** The Metaplex pass writes an `agent_endpoints` row for its agents' A2A route on `api.metaplex.com`, which this document first said no source did, and which that source's boundary forbids invoking. The endpoint read is now limited to sources whose protocol is on `CHECKABLE_SOURCE_PROTOCOLS` (`a2a`).
2. **High: endpoints were not gated by the reviewed run.** The served set gates agents, not endpoint rows, and the ingestion writes a row for every observation, approved or not, and nothing deletes one. A URL an unreviewed run introduced, and a stale one, would have been asked. The read now joins each endpoint's own observation through the public gate (source active, decision public, observation in the approved run).
3. **Medium: a failing database would have had the same five addresses asked every run.** The probe proves a read only and the stop was per run. The process now remembers what it asked and skips an address for a day.
4. **Medium: a host that is down was stored as `skipped`.** See above. Fixed in the polite fetcher.
5. **Low: a run could end after the CDN's minute,** and this document's arithmetic was wrong. The start window is 20 seconds, and the figures here say what a worst-case address takes.
6. **Low: the failure log carried the query, not the reason.** It now leads with the driver's error and code.
7. **Low: the latest-check index did not include `kind`.** On 73,000 rows the read took 827 ms against 10 ms with it. Fixed in the schema and in 0037 before the table exists, when it costs nothing.
8. Notes, also done: due is judged by address and not by endpoint row; a queue of 10,000 addresses on one host no longer takes quadratic time; the cadence is stated as 24 to 25 hours; the operator route is said to accept a session as well as the token.

A second pass over the fixes found all of the above fixed and nothing that blocks shipping. It walked one card through ten approvals and changes with the real ingestion code, confirmed that an unchanged card stays eligible when a newer run is approved and that no path keeps a wrong endpoint in, and found the one way an endpoint of an approved record drops out that is not temporary, described in the table above (a card whose bytes change on every fetch). It also found two smaller things in the fixes, now fixed: later runs after a persistent write failure said `due: 0` and logged nothing, which looks like "nothing is due" (they now report `heldBack` and log it), and the guard test that stops the module writing anything else had been loosened to let a Map's `delete` through (it now allows only that Map's).

It checked and found nothing wrong with: the lock (set with the check, released on every path), the probe-first rule (with no table nobody is asked), the stop at the first failed write, the budget (`budget_exhausted` is not recorded; at most 12 requests an address against 120), time zones (dates round-trip whatever the session's), the chunked reads, the served set (withdrawals applied, fail closed, directory entries never in it), the migration (one table, no foreign keys, no `ALTER`, pasted whole it runs and a second paste is a no-op), the drizzle journal and snapshot chain, and that the operator answer and the success log are counts only.

## Independent review of stage 2 (2026-10-16)

A separate read-only reviewer read the stage-2 diff, reproduced what it could against real databases, and searched the whole site for sentences about fetching. It found the read sound: nothing leaves but the five fields, the gate held for every case it seeded (an unapproved run, a paused, rejected or not-yet-public source, a Metaplex endpoint, an http one, another source's observation, another kind of check, a withdrawn record, a record behind a paused source, an acknowledged entry), a failing read cannot take a record down, and nothing in the read reaches a host. Its findings, and what changed in the same pull request:

1. **High, new in this change: a redirect made the page credit the named host with another host's answer.** `https://a.example.com/rpc` redirecting to `b.example.org`, which answers 200, showed as "Answered with HTTP 200" under a.example.com, and a redirect to a name that does not resolve showed "No complete answer came back" for a host that had answered. The line now says what the ask got ("The ask got HTTP 200 in 184 ms."), and the Checks section says that redirects are followed and a status can come from another host. Recording the final host is not done (see the limits).
2. **High, older: the note on every Solana 8004 entry said "no off-chain content is fetched",** while the same pass fetches registration links to read names. It now says the pass may fetch the registration link when that gives no name. Every row is rewritten by the next pass.
3. **High, older: `/sources` said sources run by hand only** ("Manual runs only", "approved for bounded manual observations"), and ten of the twelve live sources run on a schedule. It now says "scheduled or manual".
4. **Medium: `/sources` labelled every source "A2A",** so the new sentence read as if every source were checked. Each card now shows its own protocol.
5. **Medium: "at most once a day" was not true of robots.txt** (read in each run that visits a site) **or of a redirect target** that two endpoints share. `/checker` now says each endpoint address, and that robots.txt is read each time it visits a site.
6. **Medium, older: the home funnel called entries with a locator host "Reachable at a locator".** Nothing tests reachability. It is now "Locator host recorded".
7. Low, fixed: the section said "each endpoint this agent declares" (it asks the https endpoints of approved cards); a stopped ask of one endpoint did not hide an older answer of another endpoint on the same host; `/checker` left out the recorded reason; a lime dot beside "no complete answer" read like a status light; a trailing dot made one host two lines; the decision record ticked stage 2 as live before it was deployed (now unticked until it is verified live).
8. Tests added: the router with real data (a withdrawn record, a record whose only snapshot is behind a paused source and an acknowledged entry each carry no checks, although each has a gated endpoint and a check), the host rule, the trailing dot, and the wording.

Not changed: the older notes that the server has no cap on a batch of reads and that `listLiveAtlasRecords` runs once for each profile read, and long dashes in older text on `/about` and `/sources`. None is new here.

## Tests

- `server/agentChecks.test.ts`: what a result says (typed on every reason), what is due and in what order (by address, with the skip list), a run with every dependency replaced (grouping, recording, the start window, a spent budget, a row that cannot be written stopping the run, no address asked twice in a day when writes keep failing, a second run while one is going, no address in the answer or the log, the reason in the log), a down host recorded as `no_answer` through the real polite fetcher, and what the module can touch.
- `server/agentChecks.integration.test.ts`: a real MySQL. The migration run as pasted (columns, indexes with the kind, no foreign keys, running it again), and which endpoints are asked through a seeded reviewed-run gate: the approved A2A one is, and an unapproved run's, Metaplex's, a paused source's, a source not yet public, an http one and an unserved agent's are not; approving the next run drops what it no longer declares and adds what it does; pausing a source or revoking its decision stops it at once. Also an address shared by two agents asked once and recorded twice, what is due after a run and after a day, a new endpoint row not making an address due, other kinds of check not counting, the recorded reasons, a run with the table renamed away asking nobody (with the reason in the log), and the latest-check read planning on the index alone. Skips when no database is reachable.
- `server/agentChecksRoute.test.ts`: through the real router, the route refuses a caller without the operator's token and runs nothing, runs once for the operator, and is not a public procedure. Also `agentProfile`: a reviewed record carries its checks, an acknowledged entry carries none and the checks are not read for it, and a failed read closes to "none" with an empty list.
- Stage 2, in the files above: `readPublicChecks` without a database (the host and not the address, an HTTP error shown as the answer it is, a stopped ask and an unknown outcome not shown, one line a host and newest first, the cap, nothing read for an agent with nothing to ask, an empty list when the read fails and a log line only for a failure that is news), and against the real gate (the latest check of the approved endpoints; nothing for what the gate keeps out even when a row exists; gone at once when the run is no longer approved, the source is paused or the decision revoked; a newer `no_answer` replaces an answer, a newer stopped ask removes the line, another kind is ignored; the table missing is empty and silent; the read plans on the endpoint index without a sort), and through the real router with real data (a served reviewed record carries its checks and only the five fields; a withdrawn record, one whose only snapshot is behind a paused source and an acknowledged entry each carry none although each has a gated endpoint and a check).
- `client/src/pages/dossier.test.ts`: the Checks section is after the timeline, in the reviewed record's block, drawn only when there are checks, read by typed access (a cast of the answer fails), states each check as a fact with its date, links to `/checker`, uses no grading word and nothing under 12px.
- `server/checkerPage.test.ts`: the page says what it asks for and holds "once a day" to `CHECK_INTERVAL_MS`; it no longer says no request has been made or names a `.well-known` path or a profile link; it promises only what the agent page does. And the rest of the site on fetching: the About line, the sources page, and the claims left alone (they fail if a registry source is put on the checkable list).
- Display rules: `client/src/lib/checkText.test.ts` (each sentence; the time in a fixed zone, across a year boundary and in a zone that is another day; the fallbacks), the unit and real-database tests of `readPublicChecks` (two misses do not fail, three do, an answer or a stopped ask among them breaks it, rows out of order, other endpoints on the host, only the newest three read from a long history), `dossier.test.ts` and `checkerPage.test.ts` for the wording and the number. Each of 21 changes to the rules, the read and the wording was made in turn to see the tests fail.
- `server/politeFetch.test.ts`: the host's own reason through the polite fetcher.
- `server/dbMigrations.test.ts`: a boot never runs or records version 37, including from the real `drizzle/` folder.
- Each of ten changes to the module after the review (the run gate, the protocol list, the source state, the decision state, due by endpoint, the memory of asks, going on after a failed write, parameters in the log, the host's own reason, the window) was made in turn to see that the tests fail.

## Limits and open points

- **One process.** The lock and the memory of asks are in the process. A second instance running at the same moment could ask the same address twice in one window. The host runs one.
- **Only two live cards give an endpoint.** agents.txt's top-level `url`, and, once its source has run again, AgentCard.net's `supportedInterfaces` entry. The Nooscape Observatory card declares none. More come with the `.well-known` and metadata checks, and if the owner decides the Metaplex route should be asked.
- **Skipped asks are recorded every day.** A host that opts out has a `skipped` row a day for each endpoint. It is cheap, and it shows the opt-out is honoured. Nothing is pruned: at one row a day for each endpoint the table stays small.
- **One line a host.** Two endpoints on one host show one line (the newest check of the host, and none if that was stopped by a rule), and the path is not shown, so a visitor cannot tell which address was asked. An A2A agent declares one endpoint in practice.
- **The final host after a redirect is not recorded.** The page cannot say that a status came from another host, so it says what the ask got and that redirects are followed. Recording the final host, or the number of redirects, takes a column in `agent_checks`, which is free to add in 0037 only until the migration is run. It is the operator's call whether it is worth it.
- **One claim to confirm.** The BNB card ("Nooscape did not fetch any profile link") and the BNB signal ("Nooscape did not fetch it") are true of the BNB pass. They would be false for a link that the Solana 8004 name fetch had also fetched for a cross-chain registration that names the same address. Whether any does is not known here. `SELECT COUNT(*) FROM agent_directory_entries d JOIN ingestion_sources s ON s.id = d.sourceId AND s.protocol = 'erc8004_bsc' JOIN agent_registration_resolutions r ON r.uriHash = d.profileUriHash AND r.uriKind = 'web';` shows it for the entries (the same join on `agent_directory_registry_rows` for the registry rows). If the count is not zero the wording needs the words "for these registrations".
- **"Failing" counts asks, not days.** Three misses in a row are three asks, normally three days, but the dates can be further apart (an endpoint that left the approved version and came back keeps its old rows). The sentence gives the date of the latest.
- **A line stays until the next ask replaces it.** If the cron job stops, the page keeps showing the last check with its date. Nothing says "stale"; the date is the statement.
- **No count.** No page says how many checks have been made or how many hosts answered. A count would be a step towards a ranking, which the decision record rules out.
- **`/checker` names no `.well-known` path and no profile link,** because no check asks one. The `.well-known` and metadata checks, when they ship, change the page and its test first.
- **The Metaplex signal.** The Metaplex pass records "Registry declares an A2A service URL; Nooscape did not invoke it". That stays true while its route is not asked.
