# Decision record: informational fetching, a second cron job, and BNB Chain on the home map

**Decided:** 2026-10-15, by the operator, in chat, in answer to the review of `AUTO_REVIEW_PLAN.md`.
**Changes:** decision D2 of [bsc-erc8004-2026-10-13.md](../bsc-erc8004-2026-10-13.md) ("no URI fetching, in the worker or anywhere else"), in part, and the rule that the home map draws only the reviewed census.
**Does not change:** D1 (no scoring, no tiers, no quality judgments for the BNB pass), the reviewed-run publication gate, and every rule that no score is shown, no payment or token holding affects standing, and a failed check is never a verdict.

## What was decided

1. **D2 is reversed for informational use only.** Nooscape may fetch what an agent's own registration points at (its profile link, the endpoints it declares, its `/.well-known` files) from third-party hosts, to record plain facts: that it answered, what it returned, and when. What a check finds is shown as a fact with its date. It never changes an agent's tier, visibility, order or place on the map, it never promotes anything into the reviewed census, and it is never a score. A check that fails once says nothing; a pattern of failures over several days may be shown as "not answering", never as a verdict.
2. **Nothing is fetched yet.** The BNB pass still fetches nothing, and the public copy that says Nooscape did not fetch any profile link stays until the first check runs. Before it does, a shared safe fetch must exist (see the bounds below).
3. **A second cron job** runs the checks, on its own endpoint, apart from the ingestion tick, which is at capacity (two sources a tick, about 100 seconds a tick). The operator creates it in hPanel when the endpoint ships. It carries the same operator header as the first and a body of `{}`.
4. **BNB Chain goes on the home map**, as acknowledged entries and not as reviewed records (the rule below).

## The rule for what the home map draws

- **Filled dots** are reviewed records from `liveData.publicRecords`, as before.
- **Hollow dots** are acknowledged entries from `liveData.mapAcknowledged`: a fixed sample of at most 30 of the registrations the directory lists on BNB Chain (6,839 at the time of this decision). The sample is the entries whose id hashes lowest (`SHA2(id, 256)`), a rule that looks at nothing about an agent but its id, so it is the same set on every read until the listing changes. Nothing hidden, closed, on a suppressed host or from an inactive source is in it: it uses the directory's own visibility rule.
- **They have no tier, no evidence and no score.** The key, the card and the scanner say "acknowledged, not reviewed". The card links to the entry page, not to a record.
- **They are counted apart.** They are not in the reviewed counts or in the tiers line, and the key says how many are shown of how many are listed.
- **They are never promoted.** A hollow dot does not become a reviewed record because of where it is drawn or what a check finds. Promotion into the reviewed census stays the human reviewed-run publication gate.
- **It fails closed.** If the read fails or the source is not approved, there are no hollow dots and the map is exactly the reviewed records.
- **It applies to BNB Chain only.** Another chain would need its own decision.

## Bounds for the safe fetch (before any check runs)

- Every outbound fetch goes through one shared function: https only, no userinfo or port, the host resolved first and every address checked with the net guard, the connection made to the address that was checked (not to a second lookup), no redirect followed without the same checks at every hop and a limit of three, a 5 second timeout, a 4 KiB body cap for a probe, a `Nooscape-Checker` user agent that names a page describing it, and a refusal for any host that has opted out.
- At most 5 fetches at once, 1 a second per host, and a budget per run, so a run stays short.
- Errors are logged and never fail the tick.

## Outcome

- [x] `liveData.mapAcknowledged` and the hollow dots on the home map (this change).
- [x] The shared safe fetch, with connection pinning ([safe-fetch-2026-10-15](../safe-fetch-2026-10-15.md)). Nothing calls it yet.
- [x] The page the user agent names ([/checker](../safe-fetch-2026-10-15.md): who is asking, what is fetched, how a host opts out). Its note at the top says what it asks for and how often; the line that said no request had been made yet went with stage 2.
- [x] The checks endpoint and its table, built and not switched on ([agent-checks-2026-10-16](../agent-checks-2026-10-16.md)): migration 0037 run by hand, `liveData.admin.runChecks`, liveness for the https endpoints that the approved version of an active A2A source declares for served reviewed agents, and nothing asked unless the answer can be recorded.
- [x] Stage 2, live before anything is switched on (deployed and checked live 2026-10-16; see [agent-checks-2026-10-16](../agent-checks-2026-10-16.md), "What the site shows"): the public read on `agentProfile` and the Checks section on the agent page, which show each check with its date, and the copy that said Nooscape did not fetch, each changed only where it stopped being true: the `/checker` note and its list of what is asked, the line on the About page ("does not fetch arbitrary URLs", untrue already because of the Solana 8004 name fetch) and the sources page ("authorizes only a bounded AgentCard metadata fetch"). The BNB card and the "Nooscape did not fetch it" signals the BNB and Robinhood passes record stay true, because the checks are not asked of those sources, and a test fails if one is put on the list.
- [x] The owner ran migration 0037 and created the second cron job in hPanel (2026-10-16; it runs at :07 each hour). Two things were found on the way and fixed: the job's first call was refused with a 401 (a wrong token), and the table was not yet in `u373211336_nooscape` when it first ran, so a run answered `unavailable` and logged `ER_NO_SUCH_TABLE` until it was created.
- [x] The first informational check, 2026-10-16 at 10:40Z: one address, `https://agents-txt.com/a2a` (the only live card with a top-level `url`), answered HTTP 404 in 124 ms to a plain GET, and the agent's page shows it with its date.
- [ ] How a miss shows (decided by the operator 2026-10-16, built the same day, see "Display rules" in [agent-checks-2026-10-16](../agent-checks-2026-10-16.md)): a failed ask is a fact in plain words with its date and the line says it is retrying; the page says "failing" only when the last three asks in a row got no answer, and nothing about why; a 404 or a 405 to a plain GET is worded as "a plain GET is not served there" with POST not tested. To be ticked when deployed and checked live.
