# Source approval: A2A Registry public API (a2a-registry.org)

**Reviewed:** 2026-11-06 (the scout's draft of the same day, adjusted to what was built)
**Source key:** `a2a-registry-org-public-api`
**Protocol:** `catalog` (the A2A registry variant of the Agenstry adapter: paged JSON instead of gzip NDJSON, `server/ingestion/a2aRegistryCatalog.ts`)
**Canonical endpoint:** `https://api.a2a-registry.org/public/agents`
**Allowed hostname:** `api.a2a-registry.org`
**Staged as:** manual only. Nothing reads the registry until an operator approves the source and runs it.

## Approval scope

Approve a **single bounded, read-only snapshot** of the registry's public listing endpoint for each manual run an operator makes, no more often than once a week. There is no scheduled read. Moving the source to a schedule is a separate, reviewed change.

The adapter may read the listing endpoint above without the `q` parameter (search needs a token and is out of scope). It must not follow or invoke any URL found inside a record: no retrieval of `manifestUrl`, no call to a service URL, no `/a2a/discover`, `/a2a/utility/*`, `/agents/{id}/chat`, `/recheck`, `/flag` or any other POST, no token, no authentication, no JavaScript execution, no redirect, no browser interaction. A test holds that every request is a GET of the list endpoint with `redirect: "error"`.

## Template fields

| Field | Required record |
|---|---|
| Source owner | "A2A Registry" (site `https://www.a2a-registry.org`, GitHub organisation `A2ARegistry`, repository `GlobalA2ARegistry`). No legal entity is named on the site. |
| Contact | GitHub Issues: `https://github.com/A2ARegistry/GlobalA2ARegistry/issues` (linked from the About page). No email address found. |
| Protocol | A2A agent cards held in a registry list. Adapter: `catalog`, A2A registry variant. |
| Approved HTTPS root | `https://api.a2a-registry.org`, canonical hostname `api.a2a-registry.org`. |
| Permitted resource | `GET https://api.a2a-registry.org/public/agents?limit=100&page=N` only, with N = 1, 2, 3 and so on up to the reported `total` (21 requests on 2026-11-06, total 2,034). The API caps `limit` at 100 and ignores `offset`. |
| Written permission / terms | Terms of Service, last updated 2026-10-08: `https://www.a2a-registry.org/terms`. Section 2 says "Core registry browsing, public API access, and basic agent registration are free." Section 5 bars abusive bulk scraping that degrades the platform and circumventing rate limits. **No licence for reuse or republication of registry data found**, and the footer says all rights reserved. `robots.txt` on the API host (`https://api.a2a-registry.org/robots.txt`) holds content-signal comments and no Disallow rule. The `www` host's `robots.txt` disallows `/api/`, which is a path on the `www` host and not the API host; the mismatch is noted here and was not resolved. |
| Data classification | Public registry metadata only: display name, description, card address, owner organisation, category, verification level, check status, and the registry's copy of the card (`source_agent_card`), kept inside the retained record and not parsed. Excluded: payment objects as claims of capability, promotional flags, any call to an advertised endpoint, and anything behind a token. |
| Cadence | Manual runs only, no more often than once a week. A run makes 21 requests today (at most 50), about 12 MB, at least 1.2 seconds apart. |
| Expected identity signal | `unverified`. The registry's `verification_level` is kept as an upstream assertion ("registry-reported verification level: verified", "not independently verified by Nooscape"). Its guide says identity is checked by DNS or GoDaddy ANS (`https://www.a2a-registry.org/resources/guide`). Nooscape did not test those proofs. |
| Review owner | Nooscape production operator. |
| Decision | Asked for by the operator, in chat, on 2026-11-06: "Two public A2A registries could add reviewed records with a small adapter variant. add this". The operator had the scout's report in front of them, which records that no reuse licence exists. This decision covers building the adapter and staging the source. Approving it active, running it and publishing a run are the operator's later steps (see Outcome). |
| Decision timestamp | 2026-11-06, evening (US Central time) |

## Bounds

| Control | Value |
|---|---:|
| List requests | 21 per manual run today; at most 50 (the scan limit); a run no more than once a week |
| Scan limit | 5,000 records. Today: 2,034, and 1,614 were created in the last 30 days. A registry that reports more fails the run, and no record is taken, instead of the rest being dropped without a word. At the recent rate this can bind within weeks to months; raising it is a reviewed change. |
| Accepted records | At most 96, the oldest first. 86 qualify today, so the ceiling does not bind. |
| Candidate selection | `visibility=public`, `status=ACTIVE`, `protocolStd=a2a`, `verification_level=verified`, `consecutiveFailures=0`, HTTPS `manifestUrl` without credentials or port, a card not served by `a2a-registry.org` itself, one record per party, the oldest; none on a party that already holds a reviewed record from another source |
| Excluded by rule | `system-unclaimed` owner records (registry imports with no owner claim), `github_verified` and `unverified` levels, and any record with `is_spotlight`, `is_promoted_top` or a `badge_label` (paid placement must not shape selection or display) |
| Page payload cap | 1.5 MiB per page (largest page seen: 1,098,456 bytes) |
| Record cap | 256 KiB per record as compact JSON (largest seen: 185,520 bytes; the Agenstry adapter's 32 KiB cap would reject 39 of 2,034) |
| Request timeout | 20 seconds per request, at least 1.2 seconds between requests |
| Evidence retention | 90-day governance Object Lock (the storage layer's, as for every catalog) |

"Party", "oldest first" and the other-source rule are as in the approval for a2aregistry.org (`2026-11-06-a2aregistry-catalog.md`). Here the ceiling does not bind today, and the other-source rule matters more: 562 of this registry's card hosts also appear in a2aregistry.org's list.

## Evidence interpretation

A retained record is **registry discovery metadata**, not an assertion that Nooscape verified the provider, owner, domain, availability, safety or quality. Any registry-reported verification level or check status is preserved as an upstream assertion and may not change the Nooscape publisher state or exceed Tier 2.

## Projection rule

After the first run, an operator must recompute the stored-object SHA-256 and confirm governance retention. Each agent profile requires an explicit source-projection decision. The default is **not projected**.

## Scout evidence (2026-11-06) and the build's check of it

- Full bounded read: 21 requests, 2,034 records, 2,034 distinct ids. `total` in the API says 2,034.
- `protocolStd`: a2a 2,028, mcp 3, openai 3. All 2,034 are public and ACTIVE.
- `verification_level`: verified 118, github_verified 909, unverified 1,007.
- Owner mix: 982 records belong to `system-unclaimed` (imported, no owner). 885 belong to one claimant and all point at one host (a `tcloudbaseapp.com` tenant), all `github_verified`, created within about 17 hours, two to three days before the read. The other 167 records come from 139 organisations.
- The rule yields 108 records on 97 hosts, 87 parties; the registry's own utility agents (3 records on `www.a2a-registry.org`) are left out, which leaves **86**.
- Read again through the adapter from the saved pages (download and storage replaced): 21 requests, 2,034 discovered, **86 qualify**, 86 taken, 1,948 not taken. The scout's draft said 110 records and 89 parties: that count was taken before the rule's own exclusion of the 2 spotlight records, and before the registry's own agents were left out.
- 138 of 1,976 stored card copies carry a `signatures` field. Nothing validates a signature.
- A keyword check for token promotion matched 7 of 2,034 records and 0 of the 118 verified ones.

## Open questions for the operator

1. The terms say public API access is free but give no reuse licence. Run the pilot on that, or ask the operator first (GitHub Issues only; nothing has been sent)?
2. `verification_level=verified` is the selection signal. It is the registry's word, backed by a DNS or ANS check Nooscape did not repeat.
3. One claimant filled 885 slots within days. The rule already leaves that block out (it is all `github_verified`), and one record per party would hold it to one record in any case. A per-owner cap was not added.
4. Both registries: the two selected sets share about 28 parties. Publish one before running the other so the second leaves the first's parties out.

## Outcome

- [x] Registered in production (2026-11-08 02:00:21 UTC)
- [x] Approved active by an operator (2026-11-08, before the first run)
- [x] First bounded snapshot completed (run `149b2fea`, 2026-11-08 02:00:55 UTC: 21 requests, 2,044 read, 90 qualified and taken)
- [ ] Retained raw objects passed independent SHA-256 recomputation and retention checks (the operator ran Verify evidence before publishing; the result is to be recorded here)
- [x] Source-level projection decision recorded (public, run `149b2fea`, 2026-11-08 02:02:27 UTC)

**Update, 2026-11-07.** "None on a party that already holds a reviewed record from another source" held at this run only against sources whose records carry an endpoint row. 11 of this run's 90 records repeat an agent that Agenstry already showed. It is fixed by migration 0059 ([the record](../catalog-party-rule-2026-11-07.md)); this source's run has to be run and published again to benefit, and its next run is allowed from 02:00 UTC on 2026-11-15 under the once-a-week limit above.
