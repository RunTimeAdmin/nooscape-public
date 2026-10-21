# Decision record: Data access, stage D2 (API keys, metering and the usage page)

**Decided:** 2026-10-19, by the operator, in chat: "do the pr and on to d2" after D1. The spec (`SPEC_DATA_ACCESS.md`) sets D2 as "API keys + metering + usage page (manual migrations like 0042, with rollback)": `api_keys` and `api_usage`, the key shown once and stored as a hash, a `Authorization: Bearer nsk_...` header, a limiter per key and per address, 429 with `Retry-After`, a usage page, free keys self-serve, paid tiers by hand.
**Changes:** two new tables (migration 0043, manual, not run), a key check and per-tier limits on `/api/v1`, three calls that need a key (batch, history, usage), a `/developers/keys` page, an operator section on `/admin/sources`, a keys section on `/developers`, a section on the Privacy page and three bullets on the Terms. No new dependency.
**Does not change:** a record, a tier, an evidence level, the listing, the map, any count, the claim flow, the site's own tRPC and its limit, or what any caller is told about an agent. A key changes how much can be asked and which calls are open, and a test holds the answers equal across no key, a free key and a paid key.

## What the operator is asked to approve

1. **The limits table** in `docs/data-access-2026-10-19.md`. The free numbers are the spec's. The Builder and Pro per-minute numbers (300 and 1,200) are mine and are placeholders, as the prices are.
2. **Running migration 0043** by hand, when he chooses. The order, the record to insert, the check and the rollback are in the doc. It makes two tables and changes nothing else.
3. **The wording added to the Privacy and Terms pages.** The Privacy page said "Nooscape does not ask you for a name or an email address". A key needs an email, so the line now has one exception and a section says what is kept. The operator asked for no more legal rounds for now, so this wording has not been through one.
4. **The choices below.**

## What the operator did not decide and I chose, so he can say no

1. **Free keys are self-serve with an email and no check,** because the site has no mail to confirm one. The only limits on making keys are three live keys per email and three sign-ups a day per address.
2. **An ended key keeps its row** (email and counts) until the owner asks for deletion, which the operator does by SQL (in the doc). The alternative is to delete on ending.
3. **A batch counts as one request,** however many agents it names, up to 25.
4. **A key that is wrong is refused with 401** and does not fall back to the public limit. Guessing is counted against the address.
5. **A ceiling of 300 requests a minute from one address with keys,** whatever the tier.
6. **Usage is counted in memory and written every 20 seconds.** A restart can lose a few seconds of counts, in the key's favour.
7. **The history call is registry events plus the public claim history.** The spec's feedback, fleets and raters endpoints are Builder-tier and are not in D2.
8. **Paid tiers are arranged by email and the page shows no price.** Nothing takes a payment.
9. **The usage call counts as a request** against the key.
10. **The keys page is indexed and in the sitemap.**

## What the spec leaves to later stages, and to the operator

- D3: `/check`. D4: x402, which needs the receiving wallet. D5: webhooks and watchlists. D6: exports and the data license, which needs the operator's decision on whether bulk exports are sold at all, and the license wording with the lawyer.
- Prices for Builder and Pro, and how an invoice or a USDC payment turns into a tier (today the operator sets a tier by hand on `/admin/sources`).

## Changed after the merge

- **Answers about an agent are `private, max-age=60`, not `public`** (19 Oct 2026). The host's CDN served a stored public answer to requests that carried a key, so those requests were uncounted and an ended key was not refused for up to a minute. This reverses D1 choice 5 for the CDN: a browser may still keep an answer for a minute, and a shared cache may not. See "Caching, corrected" in `docs/data-access-2026-10-19.md`.

## Outcome

- [x] D2 built and tested on a local branch (2026-10-19), stacked on D1.
- [x] D1 (PR 155) reviewed and merged.
- [x] The operator has read the diff and accepts the choices above (he said to merge, 19 Oct 2026).
- [x] Merged and deployed (PR 156, main c6b15e3, `verify-live` 38 passed, 0 failed).
- [x] Migration 0043 run on production (the operator said so; the tables are confirmed by a 401, not a 503, from the live API for a key that was never made). The record row is not confirmed.
- [x] A key made on the live page and its use read back (two keys with the operator's address, 19 Oct 2026, both ended afterwards).
- [ ] D3.
