# Decision record: Data access, stage D5 (watchlists and webhooks)

**Decided:** 2026-10-19, by the operator, in chat: "lets do d4b and d5 then we pause until reset tomorrow".
**Changes:** a Builder or Pro key may watch up to 100 listings and set one https webhook, over new REST calls under `/api/v1` (`/watches`, `/webhook`, `/webhook/rotate-secret`, `/webhook/deliveries`). A new cron job (`liveData.admin.runWebhooks`) writes an event for each key that watches a listing something was recorded about (an ownership change, a Robinhood rating added or taken back, a claim edit, a listing leaving or returning to the public view) and sends it, signed, with retries. Four new tables (migration 0045, manual), one new setting (`WEBHOOK_SIGNING_KEY`). A POST in `safeFetch`. New sentences on Terms, Privacy and the developer page.
**Does not change:** a record, a score, a tier, an evidence level, or any answer the API gives. An event says what the public API already says, with a date, and never an owner's words. Nothing changes on merge: the calls answer 503 until the tables exist and the setting is set, and no event is written until the cron job is created.

## What the operator is asked to approve

1. **The exception to "read only".** D1 to D4 said `/api/v1` is read only. D5 lets a key write one thing, its own watchlist and webhook, in `server/apiWebhooks.ts`, and the wording that said "read only" now says "reads the public record and changes none of it" (the index, the OpenAPI document, the developer page, the 405 text, the guard tests). The alternative, managing it only on a web page through the tRPC router as keys are, would keep the old wording and make the feature unusable by the scripts and agents it is for.
2. **What an event may say,** in the D5 section of `docs/data-access-2026-10-19.md`: facts with their dates, no owner text, no rater or score, no reason for a removal. Robinhood ratings only.
3. **Sending to an address a key's owner typed.** Nooscape's server calls it, through the same guarded fetch the endpoint checks use (https, no port, public names only, every resolved address public, no redirect), and checks it again before every try. Setting it calls it once with a test, at most six changes a minute for a key.
4. **What is stored,** including the address as typed and a copy of each event for 30 days, and the new Terms, Privacy and developer-page wording, written with no legal round (the time box set on 18 Oct 2026). Please read the new sentences.
5. **The secret.** A signing secret is derived from `WEBHOOK_SIGNING_KEY` and not stored, so the key must be kept and changing it changes every secret.
6. **The choices in the doc,** notably Builder as the lowest tier, 100 and 25 as the limits, a ping that is saved whatever it got, at least once with six tries over about 15 hours, and a 5 minute cron.

## What the operator must do to switch it on (nothing happens until he does)

1. Paste migration 0045 and record it (`D:\scratch\for-david\0045_api_webhooks.sql` and `0045_record.sql`).
2. Set `WEBHOOK_SIGNING_KEY` on the host (32 or more random characters) and restart.
3. Create the third cron job (the command is in the D5 section).
4. Give a key the Builder tier by hand (an operator action, as for every paid tier), and try it with a receiver he controls.

## What D5 leaves

Events for BNB ratings and Solana feedback, several webhooks or a secret per webhook, filters, replay, a management page on the site, per-host politeness for many keys pointing at one host, and a trial against a real receiver on the internet and the real cron job.

## Outcome

- [x] D5 built and tested on a local branch (2026-10-19), against a real MySQL for the store and the ledger reads, one real bug found and fixed.
- [ ] The operator has read the diff and accepts the choices above.
- [ ] Privacy, Terms and developer-page wording read.
- [x] PR opened (after D4b), merged and deployed (PR 165, 2026-10-19, main ed3c2e7).
- [x] Migration 0045 run and `WEBHOOK_SIGNING_KEY` set (reported by the operator, 2026-10-19).
- [x] The record insert for 0045 confirmed by the operator, and the third cron job created; its first run answered `ran` with every count 0 (2026-10-19).
- [ ] A Builder key trialled with a real receiver.
- [ ] D6.
