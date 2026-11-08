# Two public A2A registries as catalog sources

The scout's report of 2026-11-06 (it is outside the repository; its numbers are in the two approvals) found two public A2A registries that could add reviewed records through a small variant of the Agenstry catalog adapter: **a2aregistry.org** (649 records, a community registry with probe results and no identity field) and **api.a2a-registry.org** (2,034 records, with an owner claim and a DNS or ANS check it calls "verified"). This change builds that variant, adds both as sources an operator can stage, and publishes nothing.

**Status.** Built on 2026-11-06 on branch `feat/a2a-registries`. **Nothing reads either registry until an operator stages the source, approves it active and runs it.** Both are staged manual only. No migration and no new setting.

**Update, 2026-11-07.** The operator staged, approved, ran and published both registries that evening, and Agenstry's latest run with them (the runs and their counts are in [the party rule record](./catalog-party-rule-2026-11-07.md)). That showed the rule below that leaves out a party another source's reviewed record holds had worked only against direct A2A sources: it read endpoint rows, and a catalog record has none. Migration 0059 of that day makes it hold between catalog sources (the lookup is now `listReviewedAddressesOfOtherSources`), but a registry's rows get their host only when that source is run and published again. Where this record says the rule holds, read it with that one.

**Decided:** 2026-11-06, by the operator, in chat: "Two public A2A registries could add reviewed records with a small adapter variant. add this". The defaults are mine, taken from the scout's drafts, and are listed under "Left open" so the operator can change any of them.

The two approval records, the scout's drafts made final: [a2aregistry.org](./approvals/2026-11-06-a2aregistry-catalog.md) and [a2a-registry.org](./approvals/2026-11-06-a2a-registry-org-catalog.md).

## What it adds

- `server/ingestion/a2aRegistryCatalog.ts`: the adapter. One policy per registry (endpoint, paging, scan limit, page and record caps, selection rule), one read loop, one way to pick and store records.
- `server/ingestion/runA2aRegistry.ts`: the run (the Agenstry run's shape): the lookup of other sources' reviewed hosts, the stored observations, the counts.
- `server/ingestion/runCatalog.ts`: one door for every `catalog` source. The two registries by their own source keys, the Agenstry feed otherwise. The worker and the operator's run both go through it, where each called the Agenstry run directly.
- `server/db.ts`: `listReviewedEndpointUrlsOfOtherSources`, and an optional parser version on `persistCatalogObservation` (the registries' observations say `a2a-registry-catalog-v1-source-scoped`, not the Agenstry feed's).
- `server/routers/liveData.ts` and `client/src/pages/SourceOperations.tsx`: two fixed sources an operator can stage (`a2aregistry`, `a2aRegistryApi`), with a button each, in review and manual only, like every other fixed source.

## What a run does

1. Checks the stored source is the approved one (key, protocol, state active, address, host) and that the registry's host is public.
2. Reads the list a page of 100 at a time, at least 1.2 seconds apart, each request under a 20 second timer and a page size cap, a GET with no redirect. A registry that reports more records than the scan limit, a list that ends before the records it reported, a status that is not a success, a page that is not JSON or is over the cap, or a shape that is not the documented one **fails the run** and takes nothing.
3. Picks records by the registry's rule (below), one per party (the oldest), none on a party that already holds a reviewed record from another source, the oldest first up to 96.
4. Stores each record as the registry served it under its content hash (the same storage and 90-day lock as every catalog), and writes it as a Tier 2 catalog record. What the registry says about itself is kept as findings, each followed by "not independently verified by Nooscape".

It never fetches a card, a service address or any other address a record names.

## The rules

| | a2aregistry.org | api.a2a-registry.org |
|---|---|---|
| Takes | not hidden, no flags, passed the conformance check, healthy, task probe WORKING | public, active, an A2A record the registry calls verified, no failed check since |
| Leaves out | a card or service address that is not https, or has credentials or a port; a card served by the registry itself | an import with no owner, a spotlight, a promoted or a badged placement, a card address that is not https, a card served by the registry itself |
| Page asked for | `?limit=100&offset=N` | `?limit=100&page=N` (counted from 1; the API ignores `offset`) |
| Scan limit, page cap, record cap | 2,000 records, 2 MiB, 128 KiB | 5,000 records, 1.5 MiB, 256 KiB |
| Ceiling | 96 | 96 |
| Cadence the approval allows | manual runs | manual runs, no more than once a week |

**Counts.** `discoveredCount` is the distinct records read. `acceptedCount` is the records taken. `rejectedCount` is everything else, so it includes the records that qualified past the ceiling. The run page cannot tell those apart, so each run also writes one line to the server log (`nooscape_a2a_registry_run`) with the discovered, qualified, accepted and rejected counts. For a2aregistry.org on 2026-11-06 that line would read 649, 285, 96 and 553.

**Oldest first.** 285 parties qualify at a2aregistry.org and the ceiling is 96. The oldest are taken, so the set does not change from run to run as new records arrive.

**Parties.** The registrable domain of the card's host, and the whole host on a hosting platform where each tenant is its own party. The platform list is short and fixed (13 names, in `a2aRegistryCatalog.ts`), not the public suffix list: a host it does not know is grouped with its neighbours, which can only drop a record, never add one.

## Checked on the real pages

The adapter read the scout's saved pages of 2026-11-06 for both registries (download and storage replaced): **a2aregistry.org** 7 requests, 649 discovered, **285 qualify** (the scout's figure, reproduced), 96 taken; **api.a2a-registry.org** 21 requests, 2,034 discovered, **86 qualify**, 86 taken. The scout's draft said 89 for the second: its count of 110 records and 99 hosts is the rule without the exclusion of placements, which removes 2 spotlight records ("Featured"), and the registry's own three utility agents are left out here as every catalog's own cards are. The check ran once, locally; the saved pages are not in the repository.

## Held by tests

- `a2aRegistryCatalog.test.ts` (the adapter, 62 tests): the party rule, every field of each registry's rule on its own (a record broken one way at a time), the mapping, the oldest-first order and the ceiling, one record per party, the other-source rule applied before the ceiling counts, the record cap from both sides, the stored text and key, the pages asked for and the pause between them, no request but the list's, no redirect, and each way a run fails (scan limit, short list, status, type, shape, size by declared length and by bytes with the stream cancelled, a stalled request, a failed request, a source that is not the approved one).
- `runA2aRegistry.test.ts`, `runCatalog.test.ts`, `worker.test.ts`, `a2aRegistriesRoute.test.ts`: the run (other sources' parties passed in, the registry's parser version, the counts, a failed run closed as failed), the one door for catalog sources (worker and operator), and staging and running each source through the real router (operator only, the preset, one source however often it is staged, a source that is not active is not run).
- `registryHostSkip.integration.test.ts` (MySQL 8 and MariaDB 10.11): the lookup of other sources' reviewed addresses composes the same gate every public read uses. It returns another source's public record and not the asking source's own, a withdrawn record, a paused source's, an observation outside the approved run, or a decision that is not public.
- Planted changes: 56, each caught. Each field of each registry's rule taken out in turn, the address rules, the party rule (several for one party, another source's party not skipped, the platform list, www, the two-label suffixes, the registry's own cards), the ceiling and its order, the pause and its length, the pages asked for, every check that fails a run, the stored key and text, the run's wiring, the dispatch of the router and the worker, and each condition of the lookup.

## Left open, and not done

- **No run yet.** Nothing here has read either registry for real. The pilot is the check. (Superseded 2026-11-07: both were run and published that evening, api.a2a-registry.org with 90 records and a2aregistry.org with 96; see [the party rule record](./catalog-party-rule-2026-11-07.md).)
- **No schedule.** Both sources are manual only. Moving one to a schedule is a reviewed change, as for the chain passes.
- **No directory acknowledgement.** Unlike the Agenstry feed, the registries' other records are not acknowledged into the master directory; only the records taken are stored. That is a decision of its own.
- **Permission.** a2aregistry.org states no terms and api.a2a-registry.org states no reuse licence. The pilot is a manual run of a documented public API that robots.txt allows. Whether to ask either maintainer first is the operator's call (GitHub Issues only; nothing has been sent).
- **The ceiling of 96** binds at once at a2aregistry.org. Smaller for the pilot, or the same, is the operator's call.
- **The scan limit of the second registry** (5,000) can bind within weeks to months at the recent rate. It fails the run and says so; raising it is a reviewed change.

## To use it

For each registry, in this order (the second to run leaves out the first's parties once the first is published, so publish one before running the other):

1. On `/admin/sources`, **Stage** the source. It is created in review, manual only.
2. Approve it active (the operator's approval of the source).
3. **Run** it once. The run page shows the discovered, accepted and rejected counts; the server log has the qualified count.
4. Recompute the SHA-256 of the stored objects and confirm the lock, as the Agenstry approval describes.
5. Record the source's projection decision for that run. Nothing is public before this step.
