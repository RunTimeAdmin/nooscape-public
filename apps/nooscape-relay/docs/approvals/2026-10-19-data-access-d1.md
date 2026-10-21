# Decision record: Data access, stage D1 (the public REST API)

**Decided:** 2026-10-19, by the operator, in chat: he pointed at `SPEC_DATA_ACCESS.md` and said "we work on this next". The spec sets six stages, one pull request each, each stopping for review, none auto-merged. D1 is "REST /api/v1 read endpoints (public tier) + OpenAPI + /developers page", and the spec says D1 needs nothing from the operator.
**Changes:** a read-only JSON API under `/api/v1` (one agent by chain and id, a search, an index and the OpenAPI document), a limit of 30 requests a minute from one address on that path, a "REST API v1" section on `/developers`, two small reads and a registry filter on the directory search in `server/db.ts`. No migration, no key, no payment, no new dependency.
**Does not change:** a record, a tier, an evidence level, the listing, the map, any count, the site's own tRPC and its limit, the claim flow, or any legal page. The API only reads, and through the rules every public read already follows.

## What the operator is asked to approve

1. The shape of the answer: the envelope (`api_version`, `as_of`, `source`, `license`, `data`), the agent's fields and the evidence block (always `acknowledged`; on BNB Smart Chain `checked_unproven` or `not_checked`; no tier, score or verdict). The OpenAPI document is the exact description.
2. The choices below.
3. The provisional `license` text, until the data license (the spec's decision 4, with the lawyer) replaces it.

## What the operator did not decide and I chose, so he can say no

1. **Chain names are the site's:** `robinhood`, `bnb`, `solana`.
2. **The id is the registry token id on the two EVM chains and the address on Solana.** An address that more than one Solana registry lists answers 409 and takes `registry=`. Reviewed records (A2A, catalog, census) are on no chain and are not in this API.
3. **The 30 a minute is a new limit on `/api/v1`.** The spec calls it "the existing limiter", but that one is on tRPC and is 600 requests in 5 minutes, so it was left alone.
4. **Search takes one of `q`, `owner` or `host`**, with `chain` and `limit` up to 25, and no cursor yet. `owner` and `host` are exact filters over the page returned.
5. **Answers are cacheable for 60 seconds and any site's browser may read them** (open CORS, read only). A hidden or removed record can therefore be served for up to a minute after it changes, from a cache. The data layer itself is never stale.
6. **The claim is included** in an agent's answer, with the owner's text labelled as the owner's word and absent while the claim is on hold. The spec lists "owner claims + public edit history" among the data on offer; the history itself waits for D2, with the keys.
7. **The provisional license** requires attribution and says do not resell bulk copies. The Terms already bar scraping beyond the published limits.

## What the spec leaves to later stages, and to the operator

- D2: keys, metering and the usage page (a manual migration, like 0042). Needs the tier prices, which are placeholders in the spec.
- D3: `/check`. D4: x402 (needs the receiving wallet). D5: webhooks. D6: exports and the data license (needs the operator's decision on whether bulk exports are sold at all, and the license wording with the lawyer).
- The API Terms the spec mentions are not added to the Terms in D1. The Terms' acceptable use already covers scraping beyond the published limits, and the operator asked for no more legal rounds for now.

## Outcome

- [x] D1 built and tested on a local branch (2026-10-19).
- [x] The operator has read the diff and the answer shape, and accepts the choices above (he said to merge, 19 Oct 2026).
- [x] Merged and deployed, and the live API checked (PR 155, main 3954ba7, `verify-live` 38 passed, 0 failed).
- [x] D2 (PR 156).
