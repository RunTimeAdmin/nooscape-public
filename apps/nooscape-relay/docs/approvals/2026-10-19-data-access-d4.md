# Decision record: Data access, stage D4 (pay per call, x402)

**Decided:** 2026-10-19, by the operator, in chat: "on to d4", after D3 was merged and live. The spec (`SPEC_DATA_ACCESS.md`) sets D4 as: "`/check` and single lookup answer 402 with x402 payment requirements when no key. Use an existing facilitator; settle USDC to the operator's address; no custody. Log payment tx hash per call; no refunds logic in v1." He then answered four questions: Arc mainnet with Circle's facilitator; keep the free public lookup and ask for payment only past its limit, and for the check with no key; $0.005 a lookup and $0.01 a check, set by environment; and the feature stays off until he sets the receiving address and the Circle key on the host.
**Changes:** a 402 with x402 terms on `POST /api/v1/check` with no key and on `GET /api/v1/agents/{chain}/{id}` past the free limit; a payment ledger (one table, migration 0044, manual, not run); a call to Circle's facilitator to settle; a view of payments on the operator page; a section on `/developers`; a paragraph each on Privacy and Terms; the 402 and the header in the OpenAPI document and the index.
**Does not change:** a record, a score, a tier, an evidence level, the listing, the map, the search, the history, the batch, the usage call, the key limits, or what the API says about any agent. A paid answer is the same answer a Pro key gets. Payment buys the call and nothing else, and a record the site hides is not served to anyone.

## What the operator is asked to approve

1. **The rules that keep a caller's money safe**, in `docs/data-access-2026-10-19.md` (the D4 section): charged only for a delivered answer; one authorization settled once; a payment belongs to its request; an unknown outcome is never delivered and never refused; no custody.
2. **The two settings he owns** and nothing else needed to switch it on: `X402_NETWORK`, `X402_PAY_TO` and `X402_API_KEY`. The address and the key are never in code.
3. **The Privacy and Terms wording**, written here with no legal round (the time box set on 18 Oct 2026). It says what is kept for a payment, who settles it, that there are no refunds in this version and that a payment is charged only for a delivered answer. It should be read before the switch is turned on.
4. **The choices below.**

## What the operator did not decide and I chose, so he can say no

1. **Regular wallets only for this version.** A smart-contract wallet is refused with a message saying so. Supporting them is planned as the next stage (D4b, outlined in the doc), since many agents pay from them. It is not started.
2. **A payment is served again twice more** if its answer was lost, until its authorization ends, with no second charge.
3. **A payment is sent to the facilitator at most three times**, and a refusal after a send is not trusted, because the first send may have settled.
4. **A payment must be valid for at least 15 seconds and at most 10 minutes.**
5. **60 requests a minute that carry a payment, 300 that only ask the price, 300 new payments a minute in all, and 8 settlements at once.**
6. **The payer's wallet address, the amount and the transaction are kept** for accounting and for a payment that went wrong. The signature, a name, an email and a network address are not.
7. **A payment the facilitator never decided stays open** for him to look at, and nothing closes it by itself. One left for over an hour raises a banner at the top of the operator page, shows as a count in the public index and fails the scheduled live health check (which opens its issue), so it cannot pile up unseen. He sets one aside, with a note, once he has checked the transaction. (Added after his review: the first version showed them only on the page, with no alert.)
8. **The check has no free tier for a caller with no key.** A Pro key still gets it without paying.
9. **A check that matches no listing is not charged**, as an agent that is not listed is not.
10. **A paid answer is refused, not charged, when a claim read or the check's ledger read failed.** A free answer degrades quietly and a paid one does not.
11. **Testnet and mainnet payments are separate rows**, so the testnet rehearsal never counts as mainnet income.

## What the spec leaves to later stages, and to the operator

- D4b: smart-contract wallets (ERC-1271 and ERC-6492), after a real settlement has proved the rest. D5: watchlists and webhooks. D6: exports and the data license.
- Circle's account and a testnet key (made, and working on testnet). Whether to restrict the live key to the host's outgoing address in the Circle console: it limits a stolen key, and it breaks every payment if a deploy changes that address. A card on file is not in Circle's docs; it appears only as a guess in a comment in the Archipelago server.
- Running migration 0044, when he chooses (the order, the record to insert, the check and the rollback are in the doc).
- Whether and how to refund a caller who was charged and not served: this version has none.

## Outcome

- [x] D4 built and tested on a local branch (2026-10-19).
- [x] Independent security review done; one critical, one medium cap, a transaction-hash overwrite and the lesser findings fixed with tests (2026-10-19).
- [x] The operator accepts the choices above (he changed two, the new alert and the plan for smart-contract wallets, and said merge).
- [x] Privacy and Terms wording read and confirmed by the operator (2026-10-19). It was written here with no separate legal round.
- [x] PR 161 opened, merged and deployed (2026-10-19).
- [x] Migration 0044 run on production, and the record row (`0044_record.sql`) inserted (the operator confirmed both; the operator page then read On).
- [x] Real settlements on Arc testnet through a local build of this branch with the real key and the real x402 client (2026-10-19): rows, transactions and balances agree.
- [x] The same on the live host on testnet (2026-10-19): the headers through the CDN, the host's own address, the receiving address up by exactly the price.
- [x] Mainnet (2026-10-19): live key accepted, network switched, one real $0.01 payment made by the operator from his own wallet and checked on chain.
- [ ] D4b (smart-contract wallets), D5.
