# Decision record: Data access, stage D3 (the pre-flight check)

**Decided:** 2026-10-19, by the operator, in chat: "next", after D1, D2, the caching fix and the hardening PR were merged. The spec (`SPEC_DATA_ACCESS.md`) sets D3 as "/check pre-flight endpoint": `POST /check`, "given agent id or endpoint URL/wallet, return evidence level, flags (new, ownership changed recently, revoked feedback share, fleet size), and sources. Facts only, no safe/unsafe verdict." Its tier table gives the check to Pro, and to pay per call in D4.
**Changes:** one endpoint, `POST /api/v1/check`, behind a Pro key; one read of two ledgers in `server/db.ts`; a section on `/developers` and a line on the keys page. No migration, no table, no dependency, no payment.
**Does not change:** a record, a tier, an evidence level, the listing, the map, the lookup, the search, the key limits, the Privacy or Terms pages, or what the site says about any agent. The check only reads, through the shared visibility rule, and writes nothing.

## What the operator is asked to approve

1. **The four flags and what each says**, in `docs/data-access-2026-10-19.md` (the D3 section) and in the OpenAPI document, which is the exact description.
2. **That `ownership_changes` is counts, a block and a distance, and has no "recently".** The ledgers hold blocks and not clocks, so the plan's "ownership changed recently" cannot be answered honestly as a yes or no. The caller decides what is recent.
3. **Pro key only**, as the plan's table says, until D4.
4. **The choices below.**

## What the operator did not decide and I chose, so he can say no

1. **A Free or Builder key is refused with 403 `tier_required`**, naming the tier. The refusal still counts against the key's day.
2. **"New" is first seen by Nooscape within 30 days**, with the threshold in the answer. It is not the registration date and says so.
3. **Platform hand-outs just after a mint are not ownership changes** and are counted apart.
4. **A wallet or a url answers for up to 10 listings it matches exactly**, newest first, with "at least" when the page was full and no cursor yet. A url is matched by its host alone and nothing is fetched.
5. **A listing with 24 or more events gets no latest block**, only the count, with the reason in the basis.
6. **The check does not include** the dated endpoint checks the `/checker` page runs, the claim, or the history. The lookup and history calls have them.
7. **The flag names** are `first_seen`, `ownership_changes`, `revoked_feedback` and `fleet`.

## What the spec leaves to later stages, and to the operator

- D4: x402, which needs the receiving wallet, and answers 402 on the check and the lookup when there is no key. D5: webhooks and watchlists. D6: exports and the data license.
- Prices, and how an invoice or a USDC payment turns into a Pro key (today the operator sets the tier by hand on `/admin/sources`).

## Outcome

- [x] D3 built and tested on a local branch (2026-10-19).
- [x] The operator accepted the diff and the choices above (he said to open the PR, then merge).
- [x] PR 159 opened, merged and deployed (2026-10-19).
- [ ] A Pro key made on the live site and the check run against a real agent.
- [ ] D4.
