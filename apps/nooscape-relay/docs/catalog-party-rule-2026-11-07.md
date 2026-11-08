# The cross-source party rule, now holding between catalog sources

A registry run leaves out a party that another source's public record already holds, so the same agent is not published once for each source that lists it ([the A2A registries record](./a2a-registries-2026-11-06.md), "What a run does", step 3). On 2026-11-07 the operator published the three catalog sources and the count of public records went from 76 to 313. About one in nine of the new records was a second or third copy of an agent another source already showed. The rule had not been working between catalog sources. This record says why, what was changed, and what the operator does next.

**Status.** Built on 2026-11-07 on branch `fix/catalog-party-rule`. Migration 0059 adds one nullable column and the boot runner applies it before traffic. It publishes nothing and changes no public record by itself: the copies already public stay until the operator re-runs and publishes the two registries (see "What is left").

## What was found

The operator staged, approved, ran and published the sources between 01:58 and 02:03 UTC on 2026-11-08 (7:58 to 8:03 PM Central on the 7th). Each run went as the approvals describe, with no failure:

| Source | Run | Read | Taken | Public |
|---|---|---:|---:|---|
| Agenstry catalog | `b916090a` (the daily run of 04:01 UTC on the 7th) | 299,318 lines | 99 | 01:58:17 |
| api.a2a-registry.org | `149b2fea`, 21 requests in 42 seconds (staged 02:00:21) | 2,044 records, 90 qualify | 90 | 02:02:27 |
| a2aregistry.org | `310e2bd7`, 7 requests in 12 seconds (staged 02:02:43) | 655 records, 290 qualify | 96 (the ceiling) | 02:03:35 |

The public records read 313 afterwards, every one with retained evidence. Counting them by display name, 31 names are used more than once and cover 67 records, and 30 of those 31 groups have identical summaries. Keeping one record in each group leaves 36 redundant copies: 25 from a2aregistry.org (17 of agents Agenstry shows, 8 of agents api.a2a-registry.org shows) and 11 from api.a2a-registry.org (all of agents Agenstry shows), none from Agenstry, which went first. That is 277 distinct agents among the 313.

## Why the rule saw nothing

The lookup the registry run makes before it picks records, `listReviewedEndpointUrlsOfOtherSources`, read the endpoint rows of the public records of other sources. A catalog record has no endpoint row, on purpose: `persistCatalogObservation` passes no endpoint address, so that an advertised address "can support a future merge review but never takes over a direct identity". So the rule saw direct A2A sources and no catalog source at all, and the three sources it was written for are all catalog sources.

The test of the lookup did not catch it because it seeded endpoint rows for sources whose protocol is `catalog`, which production never writes. It passed on a shape the real data does not have. The record and both approvals said the rule held; it held only against direct sources.

## What was considered

| Way | Verdict | Why |
|---|---|---|
| Write an endpoint row for every catalog record | No | The catalog design says an advertised address never becomes an endpoint of the agent. Endpoint rows are read for the profile, for the domain checks and for the census audit, and the persistence writes the protocol `a2a` on them, so a catalog record would look like a direct one. (The hourly checks job would not ask them: it asks only sources whose protocol is in `CHECKABLE_SOURCE_PROTOCOLS`, which is `a2a` alone. That is a guard, and not a reason to put the rows there.) |
| Read the host from each stored object at lookup time | No | The host of a registry record's card is only in the stored object. Reading a few hundred objects from storage in the middle of a run couples the run to the object store and is slow. |
| Keep the host of the card on the public snapshot | Yes | One nullable column, read by the lookup and by nothing else, written at the same moment as the snapshot. |

## What changed

- **Migration 0059** adds `agent_public_snapshots.partyHost` (nullable, 255). The second statement fills it for the Agenstry feed's snapshots from their identity (`<source id>:<host of the entry>`), so the rule holds against Agenstry from the first run after the deploy. It leaves the registries' rows and any host already there alone.
- **`persistCatalogObservation`** writes the host of the card address, or of the service address when the card address names no host (`server/partyHost.ts`), on the snapshot, on insert and when the record is seen again. It still writes no endpoint row.
- **The lookup** is now `listReviewedAddressesOfOtherSources`. It returns an endpoint row's address as before and, for a snapshot with a host, `https://host/`, under the same gate (an active source, a public decision, the approved run, not withdrawn). The registry run is unchanged apart from the name.

## Held by tests

- `partyHost.test.ts`: the host in lower case without port, credentials, path or query, null for an address that names none or a host that does not fit the column.
- `registryHostSkip.integration.test.ts` (MySQL 8 and MariaDB 10.11): a catalog record with no endpoint row is held by its host and left out for its own source; every condition that keeps a record out (withdrawn, paused source, observation outside the approved run, decision not public) holds for the host as for the endpoint; a record written by the real persist path gets its host, a service-address fallback, no endpoint row, and is held once its run is public; migration 0059's second statement fills an Agenstry snapshot from its identity and leaves a registry's and a filled one alone.
- The journal and snapshot parity tests for the new migration.

## What is left

The registries' existing rows have no host, because the host of their card is in the stored object. They get one the next time that source runs and an operator publishes the run. In this order, after the deploy:

1. **api.a2a-registry.org**: Run once, Verify evidence, Publish reviewed run. The run now leaves out the parties Agenstry holds. Its approval says no more often than once a week; its first run was 02:00 UTC on 2026-11-08, so a second one before 02:00 UTC on 2026-11-15 (8 PM Central on the 14th) is an exception that only the operator can make (21 requests, 1.2 seconds apart).
2. **a2aregistry.org**: the same three steps, after the first, so that it also leaves out the parties api.a2a-registry.org now holds.

Each run replaces the source's public run; the old observations stay as retained evidence. Until both are done the copies stay public. The operator may instead withdraw the redundant records one at a time (a reversible, append-only ledger), and the list of the 36 with the copy to keep was handed to the operator outside the repository.

Not done here: Agenstry lists some parties twice under two hosts of one registrable domain (its rule is one record per host, not per party); a record whose card moves to another host keeps its first host on its old snapshot until the run that sees it again; and two different parties that happen to share a generic name are not this rule's business.
