# Data access: the REST API (D1 to D4b)

Nooscape holds a combined, dated record that nobody else has in one place: ERC-8004 identities on Robinhood Chain and BNB Smart Chain, Solana owner wallets, reputation feedback and revocations, evidence levels, endpoint-host groups, owner claims with their public history. The plan to offer it to platforms, wallets, facilitators and researchers is the operator's `SPEC_DATA_ACCESS.md`: a free public tier, free and paid keys, a pre-flight `/check`, pay-per-call x402, webhooks and daily exports, in six stages (D1 to D6), one pull request each, each stopping for review, none auto-merged.

**Status.** D1 (PR 155) and D2 (PR 156) are merged and live (19 Oct 2026). A follow-up (PR 157) made answers about an agent private to the caller's cache: see "Caching, corrected" below. D3 (the pre-flight check, PR 159) is merged and live. D4 (pay per call, PR 161) is merged and live on Arc testnet and Arc mainnet: see the D4 section below. D4b (smart-contract wallets) is built on a local branch: see the D4b section at the end. D5 and D6 are not started.

## What D1 is

A read-only JSON API under `/api/v1`, separate from the tRPC the site's own pages use, for the public tier that needs no key. It is in `server/apiV1.ts` (the router and the answers), `server/apiV1Spec.ts` (the OpenAPI 3.1 document, served at `/api/v1/openapi.json`) and a "REST API v1" section on `/developers`.

| Endpoint | What it does |
|---|---|
| `GET /api/v1` | What the API is, its limit, its chains and its endpoints. |
| `GET /api/v1/openapi.json` | The API described in OpenAPI 3.1. |
| `GET /api/v1/agents/{chain}/{id}` | One agent. |
| `GET /api/v1/agents/search` | Search by name, host, registry key or wallet. |

**Every answer** carries `api_version`, `as_of` (for an agent, when Nooscape last saw it at its source; for a search, when it ran), `source` (the chain, the registry, the key the agent is stored under, first and last seen, the mint block where known) and `license`. Errors are `{ "error": { "code", "message" } }` with `bad_request`, `not_found`, `ambiguous`, `method_not_allowed`, `rate_limited` or `unavailable`.

**An agent** is the directory entry the site's own agent page reads (`getAgentDirectoryEntry`), so the two cannot disagree: name, registrant, locator host, dates, the evidence block, the look-alike counts, chain activity, a ratings summary, the twin on another chain, and the claim. The evidence block says `layer: "acknowledged"` always. On BNB Smart Chain, `level` is `checked_unproven` or `not_checked` (the registration read, in the words the site uses). There is no tier, no score and no verdict, and a test fails if one appears.

**A claim** shows as `claim.owner_text` with the statement "Written by the claim holder. Nooscape has not checked it", only for a claim in force, and `null` while it is on hold. The API reads claims through the public `claim.state` procedure, so it does not import the claim module and the guard on who may import it still holds.

## The rules the spec sets, and where each is held

| Rule | Held by |
|---|---|
| Read only | The router routes GET and nothing else; a test fails on any other verb or any write; a write answers 405. |
| Payment never changes a record, tier or evidence level | Nothing in the API takes a payment; the document and the page say so; no tier or score field exists. |
| Hidden, withdrawn, removed and closed records are never served | The lookup, the search and the entry read all go through `directoryVisibilityCondition`; tests against a real database cover a hidden entry, a paused source and a hidden duplicate of an address. A hidden record and one never listed answer the same words. |
| Owner text is always labelled as the owner's word | The statement is on every `owner_text`; none while on hold, held in the API as well as where the claim is read. |
| Truthful marketing, no "verified safe" language | A test fails on a verdict word in the answers and in the document, apart from the sentences that say what a record does not mean. |

## Choices the spec left open

These are mine, so the operator can say no.

1. **The chain is named as the site names it:** `robinhood`, `bnb`, `solana`. The spec wrote "chain" without values.
2. **The id is the registry token id on Robinhood Chain and BNB Smart Chain** (digits only), **and the address on Solana.** Reviewed records (the A2A, catalog and census layers) are on no chain and are not in this API.
3. **A Solana address can be listed by more than one registry** (the 8004 registry, SAID, the Metaplex registry). The answer is 409 and names them, and `registry=` chooses. Whether any address is listed twice today has not been checked; the key spaces are separate, so it should be rare, and nothing stops it.
4. **The limit is 30 requests a minute from one address, on `/api/v1` alone.** The spec says "30 per minute (existing limiter)". The existing limiter is on tRPC and is 600 requests in 5 minutes, so this API has its own, and the tRPC one is untouched. Every response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`; a refusal carries `Retry-After`. A refusal writes the same log line as every other limit (the address and the name of the limit), which the Privacy page already says.
5. **Search takes exactly one of `q`, `owner` or `host`**, plus `chain` and `limit` (1 to 25, default 10). `owner` and `host` are exact filters over the page the search returns, so a count with one of them says "at least" when the page was full. There is no cursor yet.
6. **A browser may keep an answer for 60 seconds, and a shared cache may not** (`Cache-Control: private, max-age=60`; errors are `no-store`). D1 first sent `public, max-age=60`. That was changed on 19 Oct 2026, after D2 went live: see "Caching, corrected" below. The index and the OpenAPI document hold nothing per caller and stay `public, max-age=300`.
7. **Browsers on other sites may read it** (`Access-Control-Allow-Origin: *`, GET, HEAD and OPTIONS only). A preflight does not count against the limit. The API is public, read only and carries no credential.
8. **The license field is provisional.** It says attribution is required and bulk copies are not to be resold, and points at the Terms. The Terms already bar scraping beyond the published limits. A final data license is decision 4 in the spec, with the lawyer, and replaces it.
9. **An unknown query option is refused** on search (so a typo is not silently ignored) and on lookup.

## Not in D1

- **Free keys, batch lookup, history, feedback, fleets, raters, watchlists** (D2 and later): they need keys and metering. A lookup for several agents, or the claim history, is therefore not here.
- **`/check`** (D3), **x402** (D4, needs the receiving wallet), **webhooks** (D5), **daily exports and the final data license** (D6).
- **Prices and any billing.**

## Checked

- Unit tests with the data injected: every answer is checked against the schemas in the OpenAPI document the API serves, and the document's paths against the router's. They cover each error, the 409, CORS, the limit, a data failure (the cause stays out of the answer and the log line has no parameters), and a chain-to-registry table.
- Tests against a real database: the same visibility rule as the site's reads, a claim in force, on hold and ended, a BNB entry with its evidence table missing, a Solana address two registries list, the search narrowed by chain, wallet and host.
- Guard tests: read only, no import of the claim module, mounted once before the tRPC limiter, the schema checker used by tests only, and one limit said the same in the code, the document and the developer page.
- Eight deliberate breakages of the rules were applied. Six were caught at once. Two were not, because a second layer behind each hid them (the entry read behind the lookup's own visibility check; the claim read behind the API's own hold check). Tests were added for each layer on its own and both are now caught.
- A production build run against a seeded database and called over HTTP: the four endpoints, the errors, a write answered 405, a preflight, the limit refusing the 31st request with `Retry-After`, and the site's own tRPC unaffected. The developer page was checked at 1440 and 375 pixels.

## Files

`server/apiV1.ts`, `server/apiV1Spec.ts`, `server/apiV1Check.ts` (the schema checker, tests only), `server/db.ts` (`findVisibleDirectoryEntriesByKey`, `listVisibleDirectoryKeys`, and a `protocols` option on the search that the page's own search does not use), `server/_core/index.ts` (mounted once), `client/src/pages/DeveloperApi.tsx`, and the tests `server/apiV1.test.ts` and `server/apiV1.integration.test.ts`.

# D2: keys, metering and the usage page

**Status.** Merged (PR 156) and live. Migration 0043 is manual: the operator ran it on production on 19 Oct 2026 (he said so, and a request to the live API with a well-formed key that was never made gets 401 `invalid_key` and not 503, which shows the tables exist). Whether the record row (step 3 below) was inserted is not confirmed. A real key was made on the live page with the operator's address, used, read back and ended, twice, the same day: the counts, the headers and the refusal of an ended key were as designed, apart from the CDN finding below. Before the tables existed, nothing changed for a reader: a request with no key is unaffected, a request with a key is told "API keys are not available right now" (503), and the sign-up says the same.

## What D2 adds

A key is a way to ask for more. It raises the limit, unlocks three calls, and never changes what the API says: the same agent is answered the same way with no key, a free key and a paid key (a test holds this).

| | |
|---|---|
| `/developers/keys` (page) | Make a free key from an email, shown once. Look up what a key has used. End a key. Saves nothing in the browser. |
| `POST /api/v1/agents/batch` | Up to 25 agents in one request, each with its own result and status. Needs a key. Counts as one request. |
| `GET /api/v1/agents/{chain}/{id}/history` | The agent's registry events (up to 24, oldest first, with a flag when there may be more) and the public history of its claims. Needs a key. |
| `GET /api/v1/usage` | What the key has used today against its day, and the last 30 days by endpoint. Needs a key. |
| `/admin/sources`, "API keys" | The operator lists keys (the newest 50, or one email's), sets a tier by hand, ends a key. |

Making and ending a key go through the site's tRPC (`apiKeys.create`, `apiKeys.revoke`), so `/api/v1` stays read only apart from the batch call, which reads from a body and writes nothing.

## The limits

| | Per minute | Per day |
|---|---|---|
| No key | 30 from one address | none |
| Free | 60 | 1,000 |
| Builder | 300 | 50,000 |
| Pro | 1,200 | 500,000 |

- The free numbers are the plan's. **The Builder and Pro per-minute numbers are mine and are placeholders**, as the prices are. The plan gives those tiers a daily limit only.
- A key also counts against a ceiling of **300 requests a minute from one address**, whatever its tier, so a key that is stolen, or several held behind one address, do not multiply an allowance.
- A key that is wrong is refused with **401** and does not fall back to the public limit, so a typo is not mistaken for a slow API. Guessing is counted against the address (20 a minute), so a run of guesses stops.
- The day is a UTC day. `429 quota_exceeded` carries `Retry-After` in seconds until 00:00 UTC. `429 rate_limited` is the minute.
- Responses with a key carry `X-Api-Tier`, `X-Quota-Limit`, `X-Quota-Remaining` and `X-Quota-Reset`, and, like every answer about an agent, are cached privately (`Cache-Control: private, max-age=60`). Every answer varies on `Authorization`.

## What is stored

Two tables, from migration 0043:

- **`api_keys`:** an id, the SHA-256 of the key, the key's first ten characters, the owner's email (trimmed, lower case), the tier, and the times it was made, last used and ended.
- **`api_usage`:** one row for a key, a UTC day and an endpoint, with a count.

The key is 30 random bytes (`nsk_` and 40 characters), shown once and never stored, so a guess cannot be made and the hash is enough to find it. **No network address is stored.** The limit on sign-ups from one address (three a day) and on guesses is held in the server's memory. The email is kept so the operator can write about a key. No email is sent to confirm it, and it is not checked.

A free key is **self-serve with no email check**, because the site has no mail. An email may hold up to three live keys. That cap and three sign-ups a day from one address are the only limits on one person making keys.

**Counting.** A key's day total is read from the table once, then counted in memory and written every 20 seconds as one batch, so a busy key adds a few writes and not one for each request. The server runs one process (the host's note says so), so one process holds every count. **A restart can lose up to about 20 seconds of counts, in the key's favour.** A failed write is kept and retried, and a failed "last used" update never writes the counts twice.

## The migration (0043, manual)

Two new tables and nothing else: no change to a live table, no index on an existing one, no data written. It cannot slow or lock a table the public reads scan. The file is `CREATE TABLE IF NOT EXISTS`, so running it again is a no-op. The boot runner skips it (`MANUAL_MIGRATIONS` is `[36 … 43]`).

1. **Merge and deploy.** The code works without the tables, as above.
2. **Paste `drizzle/0043_api_keys.sql`** into the host's SQL console on the production database and run it.
3. **Record it:**

```sql
INSERT INTO `nooscape_schema_migrations` (`version`, `name`) VALUES (43, '0043_api_keys.sql');
```

4. **Check:** `SHOW TABLES LIKE 'api_%';` lists `api_keys` and `api_usage`. Then make a key on `/developers/keys` and look it up on the same page. A key is cached for 30 seconds, so a change made by hand in SQL takes up to 30 seconds to show. A change through the tool is at once.
5. **Rollback:**

```sql
DROP TABLE IF EXISTS `api_usage`;
DROP TABLE IF EXISTS `api_keys`;
DELETE FROM `nooscape_schema_migrations` WHERE `version` = 43;
```

   Every key stops working (the API answers keyed requests with 503 again). Nothing else is touched.

**To delete a customer's data on request.** The Privacy page promises this on request, and there is no tool for it:

```sql
DELETE u FROM `api_usage` u JOIN `api_keys` k ON k.`id` = u.`keyId` WHERE k.`ownerEmail` = 'person@example.com';
DELETE FROM `api_keys` WHERE `ownerEmail` = 'person@example.com';
```

An ended key keeps its row, with the email and the counts, until this is done.

## The rules, and where each is held

| Rule | Held by |
|---|---|
| Payment never changes a record, score, tier or evidence level | The same agent, search and index answer identically to no key, a free key and a pro key (`apiV1.test.ts`). A tier is a rate and a quota and has no other field (`apiKeys.test.ts`). |
| Read only | The one POST is the batch lookup. A guard test fails on any other verb or any write in `apiV1.ts`. Keys are made and ended in the tRPC router. |
| Hidden, withdrawn and removed records are never served | The batch and the history use the lookup the plain call uses, so the same visibility rule. A test covers an entry the data layer does not give. |
| Owner text always the owner's word, none while on hold | The batch answers an agent with the same function as the plain call, and a test with a claim on hold finds none of the text. The history carries what `claim.history` gives, which has already left out removed text and text on a held claim, and the API adds nothing. |
| Key shown once, hash only stored | An integration test searches every stored row for the key and for the address the sign-up came from. |
| Truthful marketing | The verdict-word test covers the whole document, including the new text. |

## Choices the spec left open

These are mine, so the operator can say no.

1. **Free keys are self-serve with an email and no check.** The spec says "self-serve". No mail exists to confirm an address.
2. **Three live keys per email, three sign-ups a day per address.**
3. **Builder and Pro per-minute limits** (300 and 1,200), and the 300 a minute per-address ceiling.
4. **A batch counts as one request** against the minute and the day, however many agents it names (up to 25).
5. **The history** is registry events plus the claim history. The spec's feedback, fleets and raters endpoints are Builder-tier and are not in D2.
6. **The usage call counts as a request** against the key, like any other.
7. **Usage is counted in memory and written every 20 seconds.**
8. **Paid tiers are arranged by email.** The page says so and shows no price. Nothing takes a payment.
9. **A key's email and counts are kept after it is ended**, until the owner asks for deletion, and the Privacy page says so. The alternative is to delete them when a key is ended, which loses the record of use.
10. **Wording added to the Privacy page** (a section, "When you get an API key", and an exception to "Nooscape does not ask you for an email address") **and to the Terms** (three bullets under "The data and the API", and "for a claim" added to the sentence about email). They are plain statements of what the code does, pinned by tests. The operator asked for no more legal rounds for now, so they have not been through one.

## Caching, corrected (19 Oct 2026)

**What was found.** A live test with a real key, after D1 and D2 were merged, showed that the host's CDN (`hcdn`) stores a `Cache-Control: public, max-age=60` answer and serves it to a request that carries an `Authorization` key as well, even though every answer says `Vary: Authorization`. It was proved with a fake key: a request for a URL someone had just asked without a key came back 200, marked a cache hit, with the public headers.

**What that meant.** For up to 60 seconds after anyone asked a URL without a key, a request for that URL with a key (including an ended or invalid one) got the public answer. The data was the same, but the request was not counted against the key, carried none of the key's headers, and an ended key was not refused. The calls that need a key (batch, history, usage) were never affected: they are never cached, and the server refused an ended key correctly on all three.

**The fix.** Every answer about an agent (a lookup and a search) is now `private, max-age=60`. The host does not store a `private` answer: the keyed answers were already `private` and the live test showed the CDN never served them to anyone else. A browser still keeps an answer for a minute. A request with a key now always reaches the server, so it is counted and an ended key is refused at once.

**The cost.** The CDN no longer takes the load of repeated requests for the same public URL, so each reaches the server, where the 30 a minute per address and the key limits now apply to every request. This reverses D1 choice 6. The index and the OpenAPI document, which hold no per-caller state, are still cached by the CDN for five minutes.

## Not in D2

`/check` (D3), x402 (D4, needs the receiving wallet), webhooks and watchlists (D5), daily exports and the final data license (D6), the Builder-tier endpoints (feedback, fleets, owners, raters), prices, and any billing.

## Checked

- Tests: the metering against an in-memory store with a clock the test moves (the day's total, a new day at 00:00 UTC, a batch write, a failed write kept without loss or repeat, a failed date update not writing counts twice, a flush that waits for a write under way). The API with injected keys (the minute, the day, the address ceiling, a wrong key, caching, batch, history, usage, the keys being unavailable). A real database (the tables missing, the migration file pasted twice, the key made, found and revoked, the caps, a tier change at once, the count written and read back, the router and the operator-only calls). The client library, and the page held to a rule of saving nothing in the browser. The legal pages held to the code.
- Deliberate breakages of the rules were applied to the API and the key module: ten and eight. All were caught except one that was my error (a mutation that changed nothing). Redone correctly, it was caught.
- Two bugs found while writing the tests and fixed: a failed "last used" update after the counts were written made the next flush write the counts again, and `GET /api/v1/agents/batch` answered "no such endpoint" instead of saying the call takes POST.

## Files

`drizzle/0043_api_keys.sql`, `drizzle/schema.ts` and the snapshot. `shared/apiKey.ts` (the tiers and the key pattern, read by the server and the pages). `server/apiKeys.ts` (keys, sign-up, resolution, the meter, the usage report). `server/routers/apiKeys.ts` (`create`, `revoke`, and the operator's `list`, `setTier`, `revokeById`). `server/apiV1.ts` and `server/apiV1Spec.ts` (keys, limits, batch, history, usage). `server/dbMigrations.ts` (43 is manual). `client/src/pages/DeveloperKeys.tsx`, `client/src/lib/apiKeysFlow.ts`, `client/src/components/apikeys/OperatorKeys.tsx`. The route in `client/src/App.tsx`, `server/clientRoutes.ts`, `server/routeHead.ts` and the sitemap. The REST section of `client/src/pages/DeveloperApi.tsx`. The Privacy and Terms pages. Tests: `server/apiKeys.test.ts`, `server/apiKeys.integration.test.ts`, `server/apiV1.test.ts`, `client/src/lib/apiKeysClient.test.ts`, `client/src/pages/legalPages.test.ts`, `server/dbMigrations.test.ts`.

# D3: the pre-flight check

**Status.** Merged (PR 159) and live (19 Oct 2026). No migration, no new table, no new dependency, no payment. Not yet run live with a Pro key: the operator sets a key's tier on `/admin/sources`, and the live call with a real Pro key is still to do.

## What D3 adds

`POST /api/v1/check`: before an agent is paid, called or trusted with something, ask Nooscape what it has on record. Give exactly one of:

- `agent`: `{ "chain": "robinhood", "id": "7" }` (with `registry` on Solana, as the lookup takes it).
- `wallet`: the address that registered agents.
- `url`: an endpoint address. Only its **host** is used, to find listings that registered that host. Nothing is fetched, so the check opens no outbound request.

`chain` narrows a wallet or a url. A wallet or a url answers for the listings it matches exactly, **newest first, up to 10**, and says "at least" (`matched_total_capped`) when the page was full. There is no cursor yet. A wallet or an address nothing matches answers 200 with an empty list. An agent nothing lists answers 404, in the same words as a hidden one.

**Who may ask.** A **Pro** key, as the plan's table puts it, until pay per call (D4) exists. A Free or Builder key gets `403 tier_required` with `required_tier: "pro"`; no key gets 401. The tier is one setting (`CHECK_MIN_TIER` in `shared/apiKey.ts`), checked before the body is read. The check counts as one request against the key's minute and day, under the name `check` in the usage count. A refused request also counts, because the limiter runs before the route, as for every other error.

## What an answer holds

For each listing: who it is, the **evidence level** (always `acknowledged`; on BNB Smart Chain "Checked, unproven" or "Not checked", exactly as the lookup says it), **four flags**, and the **sources** they were read from (the registry source with its dates, the block the identity ledger is read through, the block the ratings are measured through, and when a BNB registration was read). The envelope has `as_of` (when the check ran), `source`, `license` and a `statement` that none of it is a verdict.

Every flag has `present` and a `basis` that says what it rests on and what it does not mean. **`present: true` means Nooscape has recorded one, `false` that it has recorded none, and `null` that the fact is not measured for this agent, which is not the same as none.** A flag is a fact about Nooscape's records and never a finding. Nothing is weighed into a score and no answer says an agent is safe or unsafe.

| Flag (the plan's name) | What it says | Where it comes from |
|---|---|---|
| `first_seen` (new) | When Nooscape first saw the listing, the days since, and whether that was under 30 days ago (the threshold is in the answer). **Not when the agent was registered:** a listing found while Nooscape read a registry's history is dated by that read. | The entry's first-seen date. |
| `ownership_changes` (ownership changed) | Transfers recorded, apart from the platform hand-outs made just after a mint (counted separately). EVM registries are placed **by block**: the latest change's block, the ledger's head, the blocks between. Robinhood Chain adds **block days** (864,000 blocks, a proxy, as the What-changed page already uses). Solana gives the **date Nooscape recorded** the latest transfer, which is no later than the transfer. | The identity ledger's rollups and events (EVM), the Solana activity ledger. |
| `revoked_feedback` (revoked feedback share) | Ratings recorded against the agent, how many the rater later revoked, and the share to three places. Robinhood Chain only. It does not say whether a rating was fair. | The reputation ledger's summary. |
| `fleet` (fleet size) | Listings Nooscape shows that one wallet registered, this agent included, and the other agents sharing its host and name. "A fleet means identities registered by one wallet, and nothing more." | The look-alike counts. |

**Why there is no "recently".** The plan says "ownership changed recently". The ledgers hold block numbers and not clocks (the site's own convention: "an honest chain-derived proxy, never an invented clock"), and a Solana transfer is dated by when Nooscape recorded it, so a transfer read when Nooscape first saw an agent could be older than its date. Saying "recent" would be a claim the data cannot back. The flag gives the count, the latest block and its distance from the ledger's head, or the recorded date, and the caller decides what is recent.

## Choices the spec left open

These are mine, so the operator can say no.

1. **Pro key only**, as the plan's table says, until D4. The paid tiers are set by hand, so a Pro key is how the check is tried.
2. **`ownership_changes` is counts, a block and a distance, not a "recent" yes or no** (above).
3. **"New" is first seen by Nooscape within 30 days**, with the threshold and the date in the answer.
4. **Hand-outs are not ownership changes.** They are the platform's distribution just after a mint and the site already separates them.
5. **A wallet or a url is up to 10 listings.** A host is matched exactly, so `alice.example.org` does not match `alice.example`.
6. **An agent with 24 or more recorded events gets no latest block.** The entry read keeps the oldest 24 events, so with that many in hand the latest may not be among them; the count is still given and the basis says why the block is not.
7. **Not measured is `null`.** BNB ratings are not read, Solana's SAID registry has no activity ledger, and a ledger that has not covered an agent says so.
8. **The check does not fetch the endpoint.** The facts are Nooscape's records. The dated endpoint checks the site runs for `/checker` are not included here.

## Not in D3

x402 pay per call (D4, needs the receiving wallet), the Builder-tier fleet, owner and rater endpoints, webhooks (D5), exports and the data license (D6), prices, and a cursor for wallets with more than 10 listings.

## Checked

- Unit tests with the data injected (33): who may ask and in what order, every request shape and refusal, the three subjects, each flag at its edges (the 30-day line, hand-outs, a truncated event list, no ledger, a Solana transfer, no ratings, a fleet of one), and the rules that hold whatever is asked (no verdict word, nothing written, the statement pinned word for word, the same answer for every Pro key, the same tier named in the code, the document and the pages).
- A real database (8): the ledgers read for an EVM agent whose first transfer was a hand-out, a Solana agent with recorded transfers, ratings with a revocation, a fleet of one wallet, a hidden entry that must add nothing, and real keys with the tier gate. It ran with the process in local time and in UTC. **It found one bug before this change was shown:** the Solana date was read from a raw `max()`, which comes back without a time zone, so on a server not in UTC it was off by hours. It now reads through the typed column.
- Fifteen deliberate breakages of the rules (the tier gate, an inexact wallet or host match, credentials in a URL, the 30-day line, counting hand-outs, trusting a truncated list, block days on every chain, the share's rounding, the fleet count, not measured read as none, a verdict word in the statement). The last one slipped past a scan that exempts the statement, so the statement is now pinned word for word, and it is caught.
- A production build against a seeded database, called over HTTP with keys made through the site and a Pro tier set in the table, and the developer and keys pages in a browser at 1440 and 375 pixels: the tier gate, the flags with their numbers, the wallet, the URL and the Solana subjects, a hidden agent answered as one never listed, the refusals, fourteen checks (refused ones too) counted as fourteen, and no sideways scroll.

## Files

`server/apiCheck.ts` (the request, the thresholds and the four flags, with no import from the router), `server/apiV1.ts` (the route, the tier gate, the `tier_required` error, the result and the answer), `server/apiV1Spec.ts` (the path and its schemas), `server/db.ts` (`readAgentCheckFacts`, and the block-day constant now exported), `shared/apiKey.ts` (`tierAtLeast`, `CHECK_MIN_TIER`), `client/src/pages/DeveloperApi.tsx` and the keys page, and the tests `server/apiCheck.test.ts`, `server/apiCheck.integration.test.ts` and an updated `server/apiV1.test.ts`.

# D4: pay per call (x402)

**Status.** Merged (PR 161, 19 Oct 2026) and **live on Arc mainnet**. One manual migration (0044, run by the operator), no new dependency. It was switched on in order: migration 0044, then testnet (a payment from a throwaway wallet through the live site), then mainnet (a real $0.01 payment made by the operator from his own wallet, which arrived at his receiving address exactly once). Testnet and mainnet rows are kept apart in the ledger.

**Later.** Base was added to pay per call on 21 October 2026, settled by Coinbase's facilitator, with Arc left as described here: see [x402-base-bazaar-2026-10-21.md](./x402-base-bazaar-2026-10-21.md).

## What D4 adds

Where it is switched on, a caller with no key can pay for two things, in USDC on Arc, over [x402](https://x402.org) (version 2):

- **A lookup past the free limit.** `GET /api/v1/agents/{chain}/{id}`. The free 30 a minute is unchanged and still free. Past it, the answer is 402 with the price, where it was 429.
- **The pre-flight check.** `POST /api/v1/check` with no key is answered 402 with the price. A Pro key still gets the check without paying.

Search, history, batch and usage are not for sale and are limited exactly as before. A request that carries a key is never asked to pay, and a payment header next to a key is ignored. With the settings unset, the table missing, or `X402_PAUSE_NEW` set, the API answers as it did before D4: past 30 lookups a minute it is 429, the check with no key is 401.

Nothing about what is said changes. A paid answer is the same bytes a free or a Pro-keyed request gets (the tests compare them), hidden and withdrawn records are not served to anyone, and payment buys the call and nothing else: no record, score, tier or evidence level moves.

## How a payment goes

1. The caller asks. The answer is 402 with the terms in the body and in a `PAYMENT-REQUIRED` header: USDC on Arc, scheme `exact`, the price in base units (six decimals, so 5000 is $0.005), the receiving address, a 120 second timeout.
2. The caller signs an EIP-3009 `TransferWithAuthorization` for exactly that amount to that address, and sends the same request again with a `PAYMENT-SIGNATURE` header.
3. The server checks the header with no database and no network: it is a payment, its terms are ours to the last field, the authorization pays our address the exact price, it is valid for at least 15 seconds and at most 10 minutes (for a new payment), and the signature is the payer's own, recovered here (regular wallets only).
4. The answer is built. A request that fails here (not found, hidden, a bad body, a failed read) is never charged.
5. The authorization is recorded in `api_payments` before anything is sent, then sent to Circle's facilitator (`POST /settle`) with an idempotency key. One payer and nonce is one row, held by a unique index, so one authorization cannot be settled twice by a retry or by two requests at once.
6. Only a settlement the facilitator confirmed and named a transaction for delivers the answer, with a `PAYMENT-RESPONSE` header (the transaction, the network and the payer). Anything else is sorted by what it proves about the money (next section).

Nooscape never holds a caller's funds and no key that can move funds is on the server. The transfer is from the caller's wallet to the operator's receiving address, and Circle's facilitator submits it and pays the gas. The only secret on the server is the facilitator API key.

## What the facilitator's answer means

| It said | Meaning | What the server does |
|---|---|---|
| Success, a transaction, our network, our payer | Settled | Records `paid`, delivers the answer. |
| Failure with a reason that means no transfer was made (invalid payload, signature, recipient or value mismatch, validity window, insufficient funds), no transaction | Refused | Records `refused`, delivers nothing. The authorization is not sent again. |
| 400 or 403 for the request itself (a bad request, a screened party) | Refused | Same. |
| 401, or 403 `forbidden` | Our key or our account was refused, not the payment | Records `open`, answers 503 "nothing was charged", logs it for the operator. The caller's retry sends it again. |
| `settlement_pending`, an unknown reason, a conflict, a limit, an outage, no answer, a body that is not JSON, a transaction named alongside a failure | It may have settled | Records `open`, delivers nothing, answers 503 with a `payment_id`. The caller's retry sends the same payment again with the same idempotency key. |

A payment that is `open` is sent again only when its caller sends the request again, at most three times in all. A refusal that comes back on a later send is not trusted (the first send may have settled): the row stays `open` and the caller is told it could not be confirmed, with the id to quote.

## The rules that keep a caller's money safe

- **Charged only for a delivered answer.** The answer is built before the charge, and the one call that charges is the one that sends it.
- **One authorization, one settlement.** Recorded before it is sent; a unique index on payer and nonce; one request at a time per authorization inside the process; the same idempotency key on every send.
- **A payment belongs to its request.** It carries a hash of what was asked. The same payment for another request is refused, so it cannot be used to buy a second answer.
- **Served again, a limited number of times.** If the answer is lost, the same request with the same payment is answered again with no second charge: twice more, and only until the authorization's own end.
- **Never delivered on a guess.** Only `paid` delivers. An outcome that is not known is never turned into a refusal and never into a delivery.
- **Limits.** At most 8 settlements in flight, with the place taken before the database is touched so that a burst cannot get past the cap; at most 300 new payments started in a minute from everyone; at most 60 requests a minute from one address that carry a payment (each costs a signature check, and then a write and a call to the facilitator, and a signed authorization costs its maker nothing); at most 300 a minute that only ask the price; a pause switch that stops new payments and still resolves the ones already recorded.
- **A paid answer is never a degraded one.** A free answer says "not measured" or shows no claim when a read fails. A paid one is not given in that state: the request answers 503 and costs nothing.
- **An empty check is not charged.** A wallet or an address that matches no listing is answered, as an agent that is not listed is, and costs nothing.
- **A transaction the facilitator named is never forgotten.** A later send that names none keeps it, because it is the best evidence the operator has when a payment is looked at by hand.
- **The two networks are kept apart.** The chain is part of the key, so a testnet payment and a mainnet payment are never taken for each other, and the operator's view shows the network it is set to.
- **A header is a stranger's.** Every field of the terms it carries must be a string, and nothing in reading it can throw: a header whose terms are objects is refused with a 402. (An independent review found that one such header could stop the whole process; it is fixed and tested, and the reviewer's own script now ends with the process still running.)
- **Fails closed.** If the payments table is missing or the database does not answer, pay per call is off and the API answers as it did before. If recording a result fails after a settlement, the answer is still delivered and the transaction is logged, and the next send of the same payment is idempotent.
- **No refunds in this version, and no payment left unseen.** The operator sees every payment that is not resolved on `/admin/sources` and decides by hand. One that has been unresolved for over an hour (a retry will not resolve it) raises a banner at the top of that page, shows as a count in the public index (`payments_unresolved_over_hour`, while pay per call is on or paused), and fails the scheduled live health check, which opens its issue, so nothing waits unseen for a daily look. Once the operator has checked the transaction he sets the payment aside with a note (status `closed`, final, never sent or served again) and the count falls.

## What is stored

One table, from migration 0044: `api_payments`, one row for each authorization: the payer's wallet address, the nonce, the amount, when it ends, the kind of call and a hash of the request, the facilitator's idempotency key, the settlement transaction, the status (`settling`, `open`, `paid`, `refused` or `closed`) and the facilitator's short reason or the operator's note, how many times it was sent and served, and the times. It does not hold the signature, a name, an email address or a network address. The rate-limit log records an address and the limit's name when a caller goes over the payment attempt limit, as it does for the other limits.

## The migration (0044, manual)

Like 0042 and 0043 it is not run on boot. One table, `CREATE TABLE IF NOT EXISTS`, no foreign key, no change to a live table.

1. **Choose the time.** Nothing writes to the table until the settings below are also set, so the table can exist for as long as you like.
2. **Paste `drizzle/0044_api_payments.sql`** into the host's SQL console on the production database and run it. A paste-safe copy is at `D:\scratch\for-david\0044_api_payments.sql`.
3. **Then record it**, so the bookkeeping matches (`D:\scratch\for-david\0044_record.sql`):

```sql
INSERT INTO `nooscape_schema_migrations` (`version`, `name`) VALUES (44, '0044_api_payments.sql');
```

4. **Check:** `SHOW TABLES LIKE 'api_payments';` lists one table.
5. **Rollback** (`D:\scratch\for-david\0044_rollback.sql`), only after the payments in it are accounted for, since it holds the only record of who paid:

```sql
DROP TABLE IF EXISTS `api_payments`;
DELETE FROM `nooscape_schema_migrations` WHERE `version` = 44;
```

## Switching it on

Nothing here is done by the code. Pay per call is off until all three of these are set in the host's environment, and the server then needs a restart:

| Setting | What it is |
|---|---|
| `X402_NETWORK` | `eip155:5042` (Arc mainnet) or `eip155:5042002` (Arc testnet). Unset means off. |
| `X402_PAY_TO` | The receiving address. Never in code. |
| `X402_API_KEY` | A Circle API key for the facilitator: `LIVE_API_KEY:id:secret` for mainnet, `TEST_API_KEY:id:secret` for testnet. A key of the wrong kind for the network keeps it off. |

Optional: `X402_PRICE_LOOKUP` and `X402_PRICE_CHECK` (USDC base units; 5000 and 10000 by default; at most 1,000,000), `X402_PAUSE_NEW=1` (take no new payment), `X402_RESOURCE_BASE` (default `https://nooscape.si`). `X402_FACILITATOR` may only be one of Circle's own two endpoints, and defaults to the production one for both networks: its public `/supported` lists Arc mainnet and Arc testnet, and a testnet key is used against it. (The sandbox host answered every request with a server error when probed on 19 Oct 2026.) A setting that is half there or unsafe keeps it off and says why in the log, and never stops the site from starting.

Before mainnet, the sequence that proves the one thing the tests cannot: a real settlement through Circle.
1. Make a Circle account and a **testnet** API key (`TEST_API_KEY:id:secret`). Each key is tied to one environment (`TEST_` for testnet, `LIVE_` for mainnet) and is used against Circle's production host, which serves both Arc networks. A key has an **Allowed IP Addresses** setting in the Circle console. Left at "all" it works from anywhere; set to an address list it refuses every other address, and Circle's answer to a request from an address it does not allow is 401 "Invalid credentials", the same words it gives a made-up key (the first testnet key was answered that way from the developer's machine until the setting was opened, and worked at once after). Circle's docs say nothing about a card on file; that appears only as a guess in a comment in the Archipelago server, so it is not a step here. A 401 "Malformed authorization" means Circle could not read the key at all. For mainnet, whether to restrict the key to the host's outgoing address is a choice: it limits what a stolen key can do, and it breaks every payment if a deploy changes that address.
2. Set the three settings on the host for **testnet** (`eip155:5042002`), restart, and make a payment with Archipelago's MCP buyer pointed at Arc testnet. Look at the row on `/admin/sources` and at the transaction.
3. Then switch to a mainnet key and `eip155:5042` and make one payment of a few cents.

## Choices the spec left open

I chose these, so the operator can say no to any of them:

1. **The free lookup stays free**, and the 402 replaces the 429 only past 30 a minute. The check has no free tier for a caller with no key.
2. **Prices** $0.005 a lookup and $0.01 a check, from settings, not code.
3. **Regular wallets only.** A smart-contract wallet (ERC-1271 or ERC-6492) is refused with a message saying so; its signature is decided by the chain and cannot be checked here before the facilitator is asked.
4. **A payment may be served again twice more**, until its own end. Without that a lost answer would cost the caller a second payment.
5. **A payment is sent to the facilitator at most three times**, and a refusal after a send is not trusted.
6. **A payment must be valid for at least 15 seconds and at most 10 minutes.** Shorter could expire during settlement; longer is a standing authorization.
7. **60 requests a minute that carry a payment, 300 that only ask the price, 300 new payments a minute in all, 8 settlements at once.** A caller who needs more should have a key.
8. **The payer's wallet address is kept in plain form**, as public chain data, with the amount and the transaction, for accounting and for a payment that went wrong. The signature is not kept.
9. **The Privacy and Terms wording was written here and had no legal round**, as set on 18 Oct 2026. It says what is kept, who settles, that there are no refunds in this version, and that a payment is charged only for a delivered answer; `client/src/pages/legalPages.test.ts` holds each sentence to the code. It should be read before the switch is turned on.
10. **No refund logic.** The spec says none for v1.
11. **A check that matches no listing is not charged**, so it reads the same as an agent that is not listed.
12. **A paid answer is refused, not charged, when a claim read or the check's ledger read failed**, where a free answer degrades quietly.
13. **Testnet and mainnet payments are separate rows**, so the testnet rehearsal leaves nothing in the mainnet totals.
14. **"Stuck" is an hour.** A payment unresolved that long raises the banner, the public count and the health failure. A buyer's retry comes within seconds, so an hour is long past one.
15. **The count is public, as a number only.** It is in the index and read by the health check, which uses no credential. It names no payer, amount or transaction.
16. **A payment is set aside, not deleted or refunded.** `closed` keeps the row and the operator's note, and the payment is never sent or served again.

## Not in D4

Refunds, smart-contract wallets (D4b, at the end), other chains and tokens, a facilitator other than Circle's, a paid search or history, a monthly invoice, turning a payment into a key, the operator's accounting export, and the receiving wallet's own custody (the operator's).

## Smart-contract wallets

Refused in D4 and taken in D4b, which is the last section of this document.

## Checked

- Protocol unit tests (32): the settings and every unsafe or half-set setting, the terms, reading and checking a payment field by field (including terms that are not strings), the signature against reference values from another implementation (viem) on both chains, the recovery byte, and every facilitator answer sorted by what it proves.
- Service tests (30) with the ledger's rules kept in memory, including the count of payments left for over an hour and a payment set aside: settled once, served again, a different request refused, two at once, pending, lost, refused, forbidden and a refused key, the retry cap, the pause, forty requests at the same moment against the cap of eight, the new-payment cap, the two networks, a transaction that is never forgotten, a database that fails before the send and after it.
- HTTP tests (27, with the operator's view) on a real port: who is asked to pay and who is not, 402 with the exact terms, the same answer as a Pro key, nothing charged for a failed or a degraded or an empty answer, keys unaffected, the two limits, headers of every hostile shape, the document and the index, the log.
- A real database (11): the table pasted as the owner would paste it, twice; one row however many requests record at once; a result that cannot be undone; a transaction that stays; the two networks apart; the serve cap; the full path from request to row.
- Deliberate breakages of the money rules, the limits, the router, the ledger and the wording (about 60 in all): each is caught by a test.
- **An independent security review** of the payment code, from the files and the rules alone. It found one critical bug (a crafted header could stop the process), one cap that did not hold under a burst, a transaction hash that a later send could erase, and a handful of lesser ones. All are fixed with tests. It also checked the EIP-712 type hashes and found the money logic held under every sequence it tried.
- **On chain, Arc mainnet:** the USDC contract's own `DOMAIN_SEPARATOR()` is exactly the value the code computes for name "USDC", version "2", chain 5042, and `name()`, `version()` and `decimals()` agree. The testnet value could not be read from here and is the same computation for chain 5042002.
- A production build against a seeded database with Circle stood in for, and **the real x402 client libraries as the buyer** (the ones Archipelago's MCP buyer uses): the table missing and then pasted, the 402 read and signed by the real client, a paid answer, the same payment served again, a different request refused, a hidden and a missing agent not charged, the check, pending, refused, lost and forbidden, with the ledger and the facilitator's calls read afterwards. The operator view was read in a browser.
- **Against real Circle on Arc testnet, with the real testnet key and the real x402 client as the buyer (a throwaway testnet wallet funded from Circle's faucet).** First an unfunded wallet: Circle answered `200 {"success":false,"errorReason":"insufficient_funds", ...}`, the same on a repeat, and our code sorted it `refused`. Then the built server with the payments table pasted and the real key: the lookup past the free limit answered 402; the real client signed; Circle settled; the answer came with a `PAYMENT-RESPONSE` naming the transaction, the network exactly as `eip155:5042002` and the payer; the same payment sent again was served again with the same transaction and no second charge; the check paid for separately with a second transaction; both rows are `paid` in the ledger. Straight against Circle, a settled payment sent again with the same payment identifier returned the same transaction. On chain the receiving address held exactly 25,000 base units (0.025 USDC), the three settlements, and the buyer 19,975,000 (20 USDC less the same), so money moved once for each payment and no more. On a failure Circle sends empty `transaction` and `network`. The USDC contract's own `DOMAIN_SEPARATOR()` equals the value the code computes on both Arc mainnet and Arc testnet.
- **On the live host, on testnet (19 Oct 2026):** a paid check from a throwaway wallet went through the content delivery network and the host's own address: the 402 and its `PAYMENT-REQUIRED` header arrived, the `PAYMENT-SIGNATURE` header reached the app, Circle settled, the `PAYMENT-RESPONSE` named the transaction, the answer was not cached, a repeat was served again with the same transaction, and the receiving address gained exactly the price, once.
- **On mainnet (19 Oct 2026):** Circle accepts the live key; an unfunded canary payment (a throwaway wallet with no USDC, so nothing could move) was answered `insufficient_funds` and sorted `refused`; then the operator made one real $0.01 payment from a wallet he holds, and the receiving address held exactly 10,000 base units afterwards, with nothing left unresolved and the live health check passing. The agent that does the engineering does not make real-money payments, so that one was made by the operator with a small script that refuses to sign unless the network, the receiving address, the token and the price are exactly as expected.
- **Still not checked:** a smart-contract wallet as the payer (refused in this version, planned as D4b). The Privacy and Terms wording was written here with no separate legal round; the operator has read it and confirmed it.

## Files

`server/x402Crypto.ts` (the EIP-712 digest and the signer), `server/x402.ts` (the settings, the terms, reading and checking a payment, the facilitator call and its answers), `server/x402Service.ts` (what is done with a payment), `server/apiPayments.ts` (the ledger), `drizzle/0044_api_payments.sql`, `drizzle/schema.ts` and the snapshot, `server/apiV1.ts` (who is asked to pay, the limits, the charge, the headers), `server/apiV1Spec.ts` (the 402, the header, the index entry), `server/routers/apiPayments.ts` and `client/src/components/apikeys/OperatorPayments.tsx` (the operator's view, the banner and setting a payment aside), `scripts/verify-live.mjs` (the stuck-payment check), `shared/usdc.ts`, `client/src/pages/DeveloperApi.tsx`, `Privacy.tsx`, `Terms.tsx` and their pins in `legalPages.test.ts`. Tests: `x402.test.ts`, `x402Crypto.test.ts`, `x402Service.test.ts`, `apiV1Payments.test.ts`, `apiPaymentsRouter.test.ts`, `apiPayments.integration.test.ts`, with `x402Testing.ts` as the shared test support.

# D4b: smart-contract wallets

**Status.** Merged as PR 164 and deployed (19 Oct 2026, main 79638b8). No migration, no new table, no new dependency. One optional new setting, `X402_RPC`; until it was set a smart-contract wallet was refused exactly as before, so merging changed nothing for any caller. **Switched on 19 Oct 2026:** the operator pointed it at his own Arc mainnet node and restarted, and the live index now lists `smart_contract` under `wallets`. A probe of the live site with a payment that cannot succeed (the payer has no code and the signature is a throwaway key's) was refused with the ERC-1271 message in 385 ms, which shows the production host reaches the node and the check runs; nothing was charged or recorded. A real payment from a deployed contract wallet on mainnet has not been made (only on Arc testnet).

## What D4b adds

Many AI agents pay from a smart-contract wallet (a Safe, a deployed ERC-4337 account), and those are the callers the check is for. A regular wallet's payment is checked here by recovering the signer from its key. A contract wallet has no key to recover: its signature is decided by the wallet's own code (ERC-1271), and the USDC contract asks that code when it settles. So the same transfer is **simulated on chain first**, before anything is recorded or sent to Circle, and the payment is taken only if the wallet's code accepts it and the transfer would settle.

1. The server reads a payment whose signature is not a regular wallet's key's, well-formed and not too long (at most 2,048 bytes), and not the wrapped form of a wallet that is not deployed yet (ERC-6492), which is still refused: Circle documents deployed smart accounts.
2. With `X402_RPC` set, it asks the node one `eth_call` through Multicall3: the chain id, the latest block's time, and the token's own `transferWithAuthorization` with this exact signature, with a gas cap of 500,000. It moves nothing.
3. Only a success is taken. Every refusal is before a record is made or the facilitator is called, so nothing is charged and nothing is left behind: a signature the wallet's code does not accept, a wallet with less USDC than the price (a regular wallet's lack of funds is decided by Circle and recorded as a refusal; a contract wallet's is refused here, because a settlement that fails after it is broadcast costs gas), an authorization used, cancelled, early or late, a party USDC refuses.
4. If the node cannot say (down, on another chain, more than a minute behind, or an answer that is not one), the payment is turned away with a 503 and "nothing was charged", never accepted on a guess.
5. A payment already recorded (the same signed payment, which the idempotency key holds) is **not asked of the chain again**: its authorization is spent by then, and a caller whose answer was lost must be served, not refused. A different signature for the same wallet and nonce (both are public once a payment settles) is asked, and refused.

From there it is the D4 path: recorded before it is sent, settled by Circle, delivered only when the settlement is confirmed, served again for the same payment, bound to its request.

## The extra rules for a smart-contract wallet

A wallet's code can change its answer between the simulation and the settlement, and the facilitator pays the gas of a settlement that fails. So, beyond D4's limits:

- **One payment going at a time** for one wallet, even two sent at the same moment (the second is told to wait).
- **Paused for a day** after a settlement of its failed after the facilitator broadcast it (it named a transaction and did not call it pending). The mark survives the operator setting the payment aside.
- **Sent to the facilitator at most twice**, where a regular wallet's payment is sent three times.
- **At most 16 chain checks at once and 600 a minute** from everyone, each being a read on a metered node.

## Settings

`X402_RPC` is the https address of a node for the network the site is set to (it may carry an API key, so it is never put in an error or a log). Unset, smart-contract wallets are refused with the same words as before. Public nodes (`arc-mainnet.drpc.org`, `arc-testnet.drpc.org`) worked in the tests; they are rate limited, so a node of the operator's own is better once real traffic comes. The index lists the kinds of wallet taken (`wallets`: `regular`, and `smart_contract` when `X402_RPC` is set).

### The node (as set on 19 Oct 2026)

The operator runs Circle's Arc node (execution and consensus, version 0.8.0) on two of his VPSs, both synced to Arc mainnet with Multicall3 and USDC present. `X402_RPC` points at the one whose node rejects the `debug`, `txpool` and `admin` methods. The other node serves `debug` and `txpool`, so it was not exposed. A node listens on localhost only, so this one is reached through the nginx server block that already serves `ipfs.nooscape.si` on that host (it has the certificate and the DNS): a location with a long random path, POST only, a 32 KB body limit, a rate limit of 20 requests a second with a burst of 40, and no access log for that path. The path is the secret, so the address is held by the operator and is not recorded here. A rate-limit refusal does write the path into nginx's error log, so the path should be changed if that log is ever shared.

Before the change the server block's file was copied to `/root/nginx-backups/` on that host. Restoring that copy and running `nginx -t && systemctl reload nginx` undoes it. Tested from outside: the app's own chain call returns chain 5042, a block one second old and a round trip of about 290 ms; a GET is refused (403), a wrong path is 404, an oversized body 413, and a burst of 150 requests got 67 answers and 83 rate-limited; the IPFS gateway on the same host was unchanged. Circle's public RPC (`rpc.mainnet.arc.io`) and `arc-mainnet.drpc.org` both answered the same checks and are the fallbacks.

## What is stored

Nothing new. A settlement that failed after it was broadcast is recorded with the reason "failed after broadcast: ..." on the existing row. The Privacy page says that for a payment from a smart-contract wallet the server also asks a node provider whether the wallet's code accepts the signature, and that the call carries only public chain data.

## Choices the spec left open

I chose these, so the operator can say no to any of them:

1. **Off until `X402_RPC` is set.** Nothing changes on merge.
2. **Deployed wallets only.** A wallet that is not deployed yet (ERC-6492) is refused.
3. **An unfunded contract wallet is refused before anything is recorded**, where a regular wallet's lack of funds is left to Circle.
4. **One payment at a time per wallet, at most two sends, paused a day after a failed broadcast.** These follow what the operator's Archipelago server does, in a smaller form: that server also reads receipts and keeps a budget of gas lost; this version has no receipts and no budget, so it is stricter per wallet and does not measure the loss.
5. **The chain is not asked about a payment that is already recorded.**
6. **The Terms and Privacy wording changed with no legal round**, as set on 18 Oct 2026; the operator should read the new sentences.

## Not in D4b

Wallets that are not deployed yet (ERC-6492), a receipt reader that measures the gas a failed settlement cost, a budget of gas lost, another node as a fallback, and a wallet that signs in a way that needs more than 500,000 gas to check.

## Checked

- ABI codec (9): the transfer call, Multicall3's call and its answer, and an `Error(string)` revert, against values from an independent implementation (viem), including the fake node the other tests use; every answer a node can give (signed, each refusal, another chain, behind, silent, garbage, a node that errors).
- Service tests (14): without a node, a payment taken and settled with its long signature sent as signed, every refusal with nothing recorded, a node that cannot say, a recorded payment not asked again and a forged signature for it asked, one at a time (including two at the same moment), the pause and its end, the two-send limit against a regular wallet's three, the check limits, and the other terms (price, payee, network) before the node is asked.
- HTTP tests on a real port (4) and a real database (1): a contract wallet's check delivered with the same answer a Pro key gets, refusals and an unreachable node, the index and its document, a recorded payment served again without a second look at the chain; a wallet's unresolved and failed counts, the mark kept when an operator sets a payment aside, and its end after a day.
- Deliberate breakages of the rules (more than 30 across the service, the chain check and the ledger): each caught by a test, apart from two that cannot change an outcome because a later check catches the same case.
- **On Arc testnet with real Circle and a real node:** a minimal ERC-1271 contract wallet was deployed (test money only) and funded. The built server with `X402_RPC` set took its check: the node's simulation passed, Circle settled, the answer was delivered with the wallet named as payer, the receiving address gained exactly the price and the wallet lost exactly the price; the same payment was served again with no second charge; a signature the wallet's code does not accept was refused with "ERC-1271", and an unfunded contract wallet was refused for its balance, both before anything was recorded.
- **Not checked:** a Safe or an ERC-4337 account in the wild (the test wallet is a minimal owner-signed contract), mainnet, a wallet whose answer changes between the simulation and the settlement (reasoned about and limited, not provoked), and how the host's chosen node behaves under real load.

## Files

`server/x402Chain.ts` (the call to the chain, the ABI, the verdict), `server/x402.ts` (the setting and what may be a contract wallet's signature), `server/x402Service.ts` (`verify`, the gates and limits), `server/apiPayments.ts` (a wallet's unresolved and failed counts, the mark kept on close), `server/apiV1.ts` and `server/apiV1Spec.ts` (`verify` in the router, `wallets` in the index), the Terms, Privacy and developer pages and their pins in `legalPages.test.ts`. Tests: `x402Chain.test.ts`, `x402Contract.test.ts`, additions to `apiV1Payments.test.ts` and `apiPayments.integration.test.ts`, and `x402Testing.ts` (a contract-wallet buyer and a scripted node).

# D5: watchlists and webhooks

**Status.** Merged as PR 165 and deployed (19 Oct 2026, main ed3c2e7). One manual migration (0045, four tables), one new setting (`WEBHOOK_SIGNING_KEY`) and one new cron job (`liveData.admin.runWebhooks`). Off until all three are done: until the tables exist and the setting is set, the API answers exactly as before and the new calls answer 503 "not available yet". On 19 Oct 2026 the operator ran 0045 and its record, set `WEBHOOK_SIGNING_KEY` and created the third cron job (`*/5 * * * *`). Its first run answered `status: ran` with every count 0, which is right while no key has a webhook and a watch. Still open: a Builder key tried with a real receiver.

**Arc.** The watchlist and the webhook covered Robinhood Chain, BNB Chain and Solana and no other chain. The Arc work (built 20 Oct 2026, [the record](./arc-watch-2026-10-20.md)) makes them cover every chain the API serves, so a key can watch an agent on Arc, and on Ethereum or Base once those are on. It also judges a transfer's `is_handout` flag by the chain's own mint hour, which changes the flag in a BNB Chain event for a transfer from the minting wallet between 8,000 and 36,000 blocks after the mint.

## What D5 adds

A Builder or Pro key may **watch** up to 100 listings and set one **webhook**: an https address that Nooscape calls when something is recorded about a watched listing. It is the spec's "webhooks: ownership change, new feedback, claim edit, removal (Builder+)". The calls are under `/api/v1`:

| Call | What it does |
|---|---|
| `GET /watches`, `POST /watches` | List the watchlist (with whether each listing is in the public view). Add up to 25 listings in one call, 100 in all; each gets its own result. |
| `DELETE /watches/{nooscape_id}` | Stop watching. The id is the one the list shows, so a listing that has left the public view can still be removed. |
| `GET /webhook`, `PUT /webhook`, `DELETE /webhook` | Show the webhook with its signing secret, set its address (https, public name, no user name, no password, no port; at most 500 characters), remove it. Setting it sends one signed test event (`ping`) at once and says what the address answered; the address is saved either way, and setting it again turns a webhook that was turned off back on. |
| `POST /webhook/rotate-secret` | A new signing secret (the old one stops working at once). |
| `GET /webhook/deliveries` | The last 20 events written for the key and what became of each. |

A free key or no key is refused (403 `tier_required` naming Builder, 401 `key_required`), before a body is read. Changes to the webhook are limited to 6 a minute for a key, because setting it calls the address.

## What an event is

One JSON body, the same on every try: `api_version`, `id`, `type`, `created_at`, `agent` (chain, agent id, registry, Nooscape id, page and API links, or null for a ping), `data`, the statement "A fact Nooscape recorded, with its date. It is a record, not a review, and it says nothing about whether an agent works." and the license. It says what the public API already says, and no more.

| Type | Read from | `data` |
|---|---|---|
| `ownership.changed` | Secondary transfers on the Robinhood ledger (`agent_directory_chain_activity`); transfers on the Solana ledger (`agent_solana_activity`) | `from`, `to`, and `block_number`, `transaction_hash` and `is_handout` (the same hand-out rule the history uses) on an EVM registry, or `transaction_signature` on Solana |
| `feedback.added`, `feedback.revoked` | The Robinhood reputation ledger (`agent_reputation_events`) | empty. The API gives counts and not the rating, who made it or where it is, so the event says only that one was added or taken back, and the counts are in the agent's answer. |
| `claim.changed` | The claim history (`agent_claim_edits`) | `seq`, `kind` (claim, edit, freeze, unfreeze, redact, revoke), `field`, `wallet`, `reason`, `occurred_at`. **Never the old or new text**: an owner's words are not sent, and the history says what the field became. The wallet is given only for a claim and an edit, as the public history does, and is null for the rest. |
| `listing.removed`, `listing.restored` | The public-view rule every public read uses (hidden, closed, inactive source) | empty. It says that a listing left or returned, and not why. |

## How a run goes

The cron job calls `liveData.admin.runWebhooks` (operator token, same shape as the other two jobs). One run: reads the live watches (a Builder or Pro key that has not ended, with a webhook that is not off); reads what is new for exactly those listings (the claim history by sequence, the ledgers by time with a 15 minute overlap for rows written late, and the public-view rule); writes **one row for a key and an event** (a unique index on the key and a reference to the event, so a run that is repeated or cut short cannot make two); sends what is due; and, at most every six hours, deletes deliveries older than 30 days.

- **A listing that has left the public view is told about once, and then nothing more.** Events are written only for listings in the public view, so a freeze or an ownership change right after a removal does not hint at why it was hidden.
- **Only forward.** An event is written only if it was recorded after the key's watch was made. A run with no live watch moves its cursors to now, so what happened before a watch exists is never owed to it. The first run reads no further back than the oldest watch, and never more than 7 days. The claim history is held to the same 7 days, which is less than the 30 days a delivery is kept, so a row that has been tidied away is never read again and sent a second time.
- **A read that comes back full** (5,000 rows, or 20,000 live watches) does not move its cursor and is named in the answer, so nothing is skipped.
- **A webhook that is off hears nothing,** and what happened while it was off is not sent later when it is set again: events are written only for live webhooks.
- **Sending.** One POST through the same guarded fetch as the endpoint checks (`safeFetch`): https only, no port, a public DNS name, every address it resolves to must be public, the connection is pinned to the checked address, real certificate checks, no redirect (a 3xx is a failure), 5 seconds, no cookie. The address is checked again before every try, not only when it was set. Headers: `X-Nooscape-Event`, `X-Nooscape-Delivery`, `X-Nooscape-Timestamp` and `X-Nooscape-Signature: t=<seconds>,v1=<hex>`, the HMAC-SHA256 of the timestamp, a dot and the body under the key's secret. The user agent names the developer page.
- **The secret is not stored.** It is `whsec_` plus an HMAC of the key's id and a version number under `WEBHOOK_SIGNING_KEY`: the same key and version always give the same secret, and rotating raises the version.
- **Retries.** Any 2xx is a success. A failed try is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, then given up (six tries). The first failure ends a key's tries for that run, so a down endpoint is not hit by every event in its queue. After 20 failed tries in a row the webhook is turned off until it is set again.
- **At least once, and one try at a time.** A delivery is taken for a try by moving its due time two minutes on, conditional on what was read, so two overlapping runs cannot both send it; a run that dies leaves it to be sent again after two minutes. Events may arrive late, more than once or out of order.
- **Budget.** A run sends for at most 45 seconds, four webhooks at a time, and leaves the rest for the next run. It takes at most 25 of one key's due deliveries and the deliveries of at most 100 keys, picked by the age of each key's oldest, so one key with a long queue and a receiver that is down is one slot in a run and cannot keep other keys' events waiting.

## What is stored

Four tables from migration 0045: `api_watches` (the key, the listing and whether it was last in the public view), `api_webhooks` (the key, the address, the secret's version, the failure count, when it was turned off; removing a webhook erases the address and keeps the row, so a secret that was rotated away does not come back when it is set again), `api_deliveries` (one event for one key: the exact JSON sent, its type, the listing, the status, the tries, the status the address answered with, a short reason for a failure, the times) and `api_event_cursors` (how far each pass has read). No network address of anyone, no email, no user agent. The Privacy page says so, and `client/src/pages/legalPages.test.ts` holds its column list.

## The migration (0045, manual)

Like 0042 to 0044 it is not run on boot. Four `CREATE TABLE IF NOT EXISTS`, every index inside, no foreign key, no change to a live table.

1. **Choose the time.** Nothing writes to the tables until the setting and the cron job below are also in place.
2. **Paste `drizzle/0045_api_webhooks.sql`** into the host's SQL console on the production database and run it. A paste-safe copy is at `D:\scratch\for-david\0045_api_webhooks.sql`.
3. **Then record it** (`D:\scratch\for-david\0045_record.sql`):

```sql
INSERT INTO `nooscape_schema_migrations` (`version`, `name`) VALUES (45, '0045_api_webhooks.sql');
```

4. **Check:** `SHOW TABLES LIKE 'api_%';` lists `api_watches`, `api_webhooks`, `api_deliveries` and `api_event_cursors` (with the earlier `api_` tables).
5. **Rollback** (`D:\scratch\for-david\0045_rollback.sql`): drops the four tables and deletes version 45. Webhooks and watchlists stop; nothing else is touched.

## Switching it on

| What | Where |
|---|---|
| `WEBHOOK_SIGNING_KEY` | The host's environment: at least 32 random characters, never in code or a log. Unset or too short, webhooks stay off and the log says why. Changing it changes every key's secret. A restart is needed. |
| The third cron job | `*/5 * * * *  curl -fsS --max-time 90 -X POST -H 'x-nooscape-operator-token: <the operator token>' -H 'content-type: application/json' -d '{}' https://nooscape.si/api/trpc/liveData.admin.runWebhooks` (copy the token from the working tick job). The delay between a change and its event is at most this interval plus the run. |

`runWebhooks` answers with counts only: `status` (`ran`, `off` with the reason, `busy` or `error`), `created`, `sent`, `retrying`, `gaveUp`, `disabled`, `purged` and `fullReads`.

## What D5 changes in earlier text

D1 to D4 said the API is read only and that keys are made and ended in the tRPC router. D5 makes one exception, so these now say something else: the index statement ("Reads the public record and changes none of it"), the OpenAPI description, the developer page's lead and callout, the 405 wording, and the guard tests. The rule that is kept is the one that mattered: nothing here changes a record, a score, a tier or an evidence level. The only thing a key can write is its own watchlist and webhook, in `server/apiWebhooks.ts` and the store, and the guard tests fail on a write in `apiV1.ts` or `apiWebhooks.ts` themselves.

## Choices the spec left open

I chose these, so the operator can say no to any of them:

1. **Managed over the REST API,** not the site's tRPC. A webhook that can only be set on a web page cannot be set by the agents and scripts that are its users. The cost is the exception above.
2. **Builder and Pro, 100 listings, 25 a call.** The spec says "Builder+" and gives no numbers.
3. **Events are facts with no text.** A claim event names the field and not the words, and gives a wallet only where the public history does; a rating event says only that one was added or taken back; a removal does not say why.
4. **Robinhood ratings only.** The BNB rating ledger is internal evidence that nothing public reads, so it is not sent, and Solana's feedback count deliberately fires no ledger event.
5. **Hand-outs are sent, and flagged** (`is_handout`), as the history shows them, rather than left out.
6. **Only forward, from when the key began to watch.** No backfill.
7. **One webhook for a key, one secret per key.** The secret is derived from a server secret so it need not be stored; the cost is that `WEBHOOK_SIGNING_KEY` must be kept.
8. **Retries 1 minute to 12 hours, six tries, off after 20 failures in a row.** Events kept 30 days.
9. **A ping on set, saved whatever it got.** Refusing to save a webhook whose test failed would make a briefly down receiver impossible to configure.
10. **Latency is the cron interval (5 minutes suggested).** A faster loop would need its own process.
11. **The Terms, Privacy and developer-page wording had no legal round,** as set on 18 Oct 2026. It says what is kept (including the address as typed), who sees the message, that an address must be one the key's owner may send to, that events are at least once and no guarantee. It should be read before the switch is turned on.

## Not in D5

A signing key per webhook, several webhooks for a key, event filters, replay of a past delivery, an email or Telegram channel, events for BNB ratings or Solana feedback, a manual "send now", per-host politeness for many keys pointing at one host, and a management page on the site (it is the REST calls only).

## Checked

- Pure parts (`webhooks.test.ts`): the derived secret, the signature and its headers, the address rules and their words, the retry schedule, the event body (no verdict word, no long dash, the same body every time).
- The pass with an in-memory store, ledgers, clock and network (`webhookPass.test.ts`, 22): who hears what, no backfill, no duplicate on a second run, tiers, ended keys and webhooks that are off, each event type, listings leaving and returning, the retry schedule to the sixth try, a recovered endpoint, off at 20, one try at a time, a dead process, cursors that do not pass a full read, tidying. Twenty deliberate breakages: each caught once three missing tests were added.
- **An independent security review** of the diff (a separate agent, given only the code) found no way to make the server call an address it should not, no way for one key to reach another's data, and a sound signing scheme, and six other problems, all fixed and each now held by a test: one key's long queue could starve every other key (events are now taken per key); a claim edit could be sent again about every 30 days after its delivery was tidied away (the claim read is bounded by date); events kept flowing for a listing that had left the public view; removing a webhook and setting it again brought back a secret that had been rotated away (the row is kept); two calls at once could go past the 100 listings (adds are one at a time for a key); and a claim event gave a wallet where the public history gives none, and a rating event gave a transaction where the API gives only counts.
- **A real database** (`webhookStore.integration.test.ts`, 18, MySQL 8): the migration pasted twice, every store call, five concurrent leases giving one, the ledger reads (the public-view rule, claims by sequence, the hand-out rule against the mint, Solana, ratings by registry and source) and a full run from the ledgers to a signed send and back to nothing new. It found one real bug: MySQL applies `SET` assignments in the order written and the query builder writes them in column order, so a webhook was turned off one failure early; the failure update is now an ordered raw statement.
- **HTTP** (`apiWebhooks.test.ts`, 21, through the real router): tiers, 503 while off, each call's answer in the shape the document gives (the document is held to the answers), the 100 limit, bad bodies, the six-a-minute limit, a ping signed with the secret the key can read, another key seeing nothing, 405 with what is allowed. Seventeen deliberate breakages, all caught.
- `safeFetch` POST (`safeFetchPost.test.ts`, 8, including real TLS to a local server): body and headers arrive whole with the right length, no redirect is followed, refused headers and bodies, the same address checks as a GET.
- `runWebhooks` through the real router (`webhookRoute.test.ts`, 4): the operator only; `error` and nothing of the cause.
- **The production build on a real MySQL** (a scratch database, 20 checks in two phases): without the tables a Builder key gets 503, a free key 403 and no key 401, the index and the document list the new calls, the plain lookup is unchanged, and `runWebhooks` answers `off` and refuses a caller with no token; after migration 0045 is pasted the watchlist is added, listed and removed, a bad address is refused, a webhook is saved and its test goes through the real guarded fetch (the name does not resolve, so it is reported as `unresolvable`), a claim edit is written as one event that carries the field and no owner text and is tried once and not again before its time, a hidden listing is told once, the secret rotates, and the webhook is removed. The server log held no error.
- **Not checked:** a delivery answered 2xx by a real receiver on the internet (the built-server run used a name that does not resolve, and the sends in the tests are local or replaced), the cron job on the host, the Hostinger CDN's behaviour with a long `runWebhooks` answer, and load with many keys.

## Files

`server/safeFetch.ts` (the POST), `server/webhooks.ts` (the secret, the signature, the address rules, the schedule, the body), `server/webhookStore.ts` (the tables), `server/webhookEvents.ts` (what is read), `server/webhookPass.ts` (the run), `server/apiWebhooks.ts` (the calls), `server/apiChains.ts` and `server/apiLicense.ts` (moved out of `apiV1.ts` so the pass can name an agent without the router), `server/apiV1.ts` and `server/apiV1Spec.ts`, `server/routers/liveData.ts` (`runWebhooks`), `drizzle/0045_api_webhooks.sql`, `drizzle/schema.ts` and the snapshot, `server/dbMigrations.ts` (0045 is manual), `server/db.ts` (exports the hand-out rule), and the Terms, Privacy and developer pages with their pins in `legalPages.test.ts`. Tests: the files named above, with `webhookTesting.ts` as the shared test support.
