# Source approval: a2aregistry.org community A2A registry

**Reviewed:** 2026-11-06 (the scout's draft of the same day, adjusted to what was built)
**Source key:** `a2aregistry-public-api`
**Protocol:** `catalog` (the A2A registry variant of the Agenstry adapter: paged JSON instead of gzip NDJSON, `server/ingestion/a2aRegistryCatalog.ts`)
**Canonical endpoint:** `https://a2aregistry.org/api/agents`
**Allowed hostname:** `a2aregistry.org`
**Staged as:** manual only. Nothing reads the registry until an operator approves the source and runs it.

## Approval scope

Approve a **single bounded, read-only snapshot** of the registry's documented public JSON list API for each manual run an operator makes. There is no scheduled read. Moving the source to a schedule is a separate, reviewed change (a source staged manual only is flipped by a migration, as the chain passes were).

The adapter may read the list endpoint above. It must not follow or invoke any URL found inside a record: no agent-card retrieval from `wellKnownURI`, no call to a record's `url`, no `/api/agents/{id}/chat`, `/recheck`, `/flag` or any other POST, no use of the registry's MCP server, no authentication, no JavaScript execution, no redirect, no browser interaction. A test holds that every request is a GET of the list endpoint with `redirect: "error"`.

## Template fields

| Field | Required record |
|---|---|
| Source owner | GitHub user `prassanna-ravishankar`, maintainer of the open-source project `prassanna-ravishankar/a2a-registry`. No legal entity is named on the site. |
| Contact | GitHub Issues: `https://github.com/prassanna-ravishankar/a2a-registry/issues` (the route the README gives). No email address found. |
| Protocol | A2A agent cards held in a registry list. Adapter: `catalog`, A2A registry variant. |
| Approved HTTPS root | `https://a2aregistry.org`, canonical hostname `a2aregistry.org`. |
| Permitted resource | `GET https://a2aregistry.org/api/agents?limit=100&offset=N` only, with N = 0, 100, 200 and so on up to the reported `total` (7 requests on 2026-11-06, total 649). |
| Written permission / terms | **No written permission found.** The site has no terms, licence or privacy page: `/terms`, `/privacy`, `/about` and `/license` all return the home page, and the sitemap holds only `/`, `/submit/` and the agent pages. The repository code is MIT licensed (`https://github.com/prassanna-ravishankar/a2a-registry`), which covers code and not registry data. `robots.txt` (`https://a2aregistry.org/robots.txt`) says `User-agent: *` and `Allow: /` with no Disallow line. The API is documented publicly at `https://a2aregistry.org/api/docs`. |
| Data classification | Public registry metadata only: name, description, author and provider fields, card and service addresses, category, and the registry's own conformance and probe fields as reported. Excluded: any call to an advertised endpoint, `maintainer_notes` as a public field, and anything behind a payment or login. |
| Cadence | Manual runs only. A run makes 7 requests today (at most 20), at least 1.2 seconds apart. |
| Expected identity signal | `unverified`. The registry has no identity field (no signed, domain-verified or owner-verified flag). It publishes reachability and conformance observations only, and the adapter keeps them as findings: "registry-reported conformance check: passed", "registry-reported health check: healthy", "registry-reported task probe: working", each followed by "not independently verified by Nooscape". |
| Review owner | Nooscape production operator. |
| Decision | Asked for by the operator, in chat, on 2026-11-06: "Two public A2A registries could add reviewed records with a small adapter variant. add this". The operator had the scout's report in front of them, which records that no written permission exists; whether to ask the maintainer first is left open (see open questions). This decision covers building the adapter and staging the source. Approving it active, running it and publishing a run are the operator's later steps (see Outcome). |
| Decision timestamp | 2026-11-06, evening (US Central time) |

## Bounds

| Control | Value |
|---|---:|
| List requests | 7 per manual run today; at most 20 (the scan limit) |
| Scan limit | 2,000 records. Today: 649, growing by about 31 a week. A registry that reports more fails the run, and no record is taken, instead of the rest being dropped without a word. |
| Accepted records | At most 96, the oldest first (see below) |
| Candidate selection | `hidden=false`, `flag_count=0`, `conformance=true`, `is_healthy=true`, `task_conformance.category=WORKING`; HTTPS card and service addresses without credentials or port; a card not served by `a2aregistry.org` itself; one record per party, the oldest; none on a party that already holds a reviewed record from another source |
| Page payload cap | 2 MiB per page (largest page seen: 825,369 bytes) |
| Record cap | 128 KiB per record as compact JSON (largest seen: 100,822 bytes; the Agenstry adapter's 32 KiB cap would reject 11 of 649) |
| Request timeout | 20 seconds per request, at least 1.2 seconds between requests |
| Evidence retention | 90-day governance Object Lock (the storage layer's, as for every catalog) |

**A party** is the registrable domain of the card's host, and the whole host on a hosting platform where each tenant is its own party (`workers.dev`, `vercel.app`, `onrender.com`, `railway.app`, `fly.dev`, `pages.dev`, `github.io`, `run.app`, `tcloudbaseapp.com`, `netlify.app`, `supabase.co`, `chatgpt.site`, `sslip.io`). Without the rule one vendor's templated agents pass as many (98 records on one domain in the 2026-11-06 list). The list is short and fixed, not the public suffix list: a host it does not know is grouped with its neighbours, which can only drop a record.

**Oldest first.** 285 parties qualify on 2026-11-06 and the ceiling is 96, so which 96 matters. The oldest are taken, so the set does not change from one run to the next as new records arrive, and the newest and least tested are the last to be taken. A record that does not say when it was created sorts last.

**Another source's party.** Before the records are picked, the run reads the endpoint addresses of the records that are public today from other sources and leaves out any party they hold, so the same agent is not shown once for each source that lists it. This counts only records an operator has published, so when two sources overlap, publish one before running the other.

## Evidence interpretation

A retained record is **registry discovery metadata**, not an assertion that Nooscape verified the provider, owner, domain, availability, safety or quality. The registry's `conformance`, `is_healthy` and `task_conformance` values are its own probe results at one moment. They are preserved as upstream observations. They may not change the Nooscape publisher state or exceed Tier 2.

## Projection rule

After the first run, an operator must recompute the stored-object SHA-256 and confirm governance retention. Each agent profile requires an explicit source-projection decision. The default is **not projected**.

## Scout evidence (2026-11-06) and the build's check of it

- Full bounded read of the list: 7 requests, 649 records, 649 distinct ids. `total` in the API and the home page both say 649.
- 328 records pass the registry's own flags; on 328 card hosts; 285 parties.
- Read again through the adapter from the saved pages (download and storage replaced): 7 requests, 649 discovered, **285 qualify** (the scout's figure, reproduced), 96 taken, 553 not taken. The 189 that qualified past the ceiling are counted with the 553.
- Probes are fresh: median `last_health_check` age 0.3 hours, oldest 21.8 hours.
- Largest identical skill-set clusters: 46, 29 and 12 records. Two vendors account for 134 records (98 and 36).
- A keyword check for token promotion matched 4 of 649 records.

## Open questions for the operator

1. No written permission exists. Run the pilot on robots-allows plus a documented public API, or send the maintainer a courtesy request first (GitHub Issues only; nothing has been sent)?
2. The registry has no identity signal. Probe results are the selection signal in place of Agenstry's signed, domain-verified and owner-verified flags.
3. The ceiling is 96, which binds at once (285 qualify). Smaller for the pilot, or the same?

## Outcome

- [x] Registered in production (2026-11-08 02:02:43 UTC)
- [x] Approved active by an operator (2026-11-08, before the first run)
- [x] First bounded snapshot completed (run `310e2bd7`, 2026-11-08 02:02:52 UTC: 7 requests, 655 read, 290 qualified, 96 taken)
- [ ] Retained raw objects passed independent SHA-256 recomputation and retention checks (the operator ran Verify evidence before publishing; the result is to be recorded here)
- [x] Source-level projection decision recorded (public, run `310e2bd7`, 2026-11-08 02:03:35 UTC)

**Update, 2026-11-07.** "None on a party that already holds a reviewed record from another source" held at this run only against sources whose records carry an endpoint row. 25 of this run's 96 records repeat an agent that Agenstry or api.a2a-registry.org already showed. It is fixed by migration 0059 ([the record](../catalog-party-rule-2026-11-07.md)); this source's run has to be run and published again to benefit.
