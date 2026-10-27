# Source approval: AgenC agent registry (Solana)

Completed against `docs/external-source-approval-template.md`. Design and verification record:
[agenc-solana-2026-10-26.md](../agenc-solana-2026-10-26.md).

| Field | Record |
|---|---|
| Source owner | Tetsuo.AI Inc. (Alberta, Canada; GitHub org `tetsuo-ai`, program source at github.com/tetsuo-ai/agenc-protocol, GPL-3.0, with MIT npm packages). Nooscape does not contact the project: it reads public chain state only. |
| Contact | Not applicable for a chain read. The program is public; there is no hostname, API key or account involved. |
| Protocol | Solana on-chain program, adapter `solana_agenc` (migration 0051 adds the enum value, and it is run by hand). |
| Approved root | Solana mainnet JSON-RPC. The row records `https://api.mainnet-beta.solana.com`; production reads use the keyed provider in `SOLANA_RPC_URL` through the shared paced client (`server/ingestion/solanaRpc.ts`). |
| Permitted resource | Exactly two JSON-RPC methods: `getSlot`, and `getProgramAccounts` on program `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` filtered by `memcmp` on the AgentRegistration discriminator. No transaction is sent and no account is written. |
| Written permission / terms | Public blockchain state; the program is deployed on mainnet with public source. AgenC's Terms cover its site, its APIs and its feeds and do not restrict reading chain data. AgenC's HTTP API (whose `robots.txt` disallows `/api/` to crawlers), its feeds, its hosted indexer and its x402-metered endpoint are **not** used. |
| Data classification | Public chain facts only: the authority wallet, the endpoint's host when it is a public name, the profile link as a hash, the status, the registered and last-active dates, and the program's own counters (tasks completed, total earned, stake, reputation). Excluded: AgenC's labels (such as first-party), the profile documents the links name, the task, escrow, rating and dispute accounts, and anything behind a payment. The endpoint and the profile link are never dereferenced. |
| Cadence | Manual pilot first (`manual_only`, one attended run, then attended refreshes). A scheduled flip is a separate reviewed migration after a clean attended period. |
| Expected identity signal | Explicitly `unverified`. AgenC specifies a domain-verification attestation (`AgentVerification`) that has no accounts on chain; Nooscape reads none. The reputation number is a counter the AgenC program keeps: it is recorded as such, and is neither an identity check nor a Nooscape score. |
| Review owner | Nooscape operator account on /admin/sources, who stages, approves, pauses and revokes the source. |
| Revocation route | Pause or reject the source on /admin/sources: the active-source join in the reviewed-run gate and the directory visibility predicate hide its entries immediately, with no row deleted. |
| Decision | **Build approved 2026-10-26** by the operator for a directory-only pass (chain facts only, no AgenC-computed labels, no AgenC API or feed). **Activation pending:** the source does not exist until an operator pastes migration 0051 and stages it, and it is staged `review` and `manual_only` on first registration and must be approved by an operator before it can run. |
| Decision timestamp | Build scope: 2026-10-26 (operator, in chat: "yes, build the pilot"). Activation: pending. |

## Required checks before activation

- [x] Layout verified against the full live population before adapter code: 256 of 256 AgentRegistration accounts decode (one fixed size of 566 bytes, a zero tail on every account), and AgenC's own API lists the same 256 accounts.
- [x] The TypeScript decoder agrees with an independent Python decode on nine real mainnet accounts, one for each case the population shows.
- [x] Strict decode fails closed; a truncated listing fails the pass under the 98% floor; the cursor persists only after a whole snapshot.
- [x] The pass writes no agent, snapshot, evidence event or ledger row, so a run of this source can never be projected into the reviewed census.
- [x] Migration 0051 passes against a real MySQL 8.4 and a real MariaDB 10.11: refused before, accepted after, pasted twice a no-op, and the rollback refused while a row holds the value.
- [ ] Operator pastes 0051, records it, and checks the four protocol lists.
- [ ] Operator stages and approves the source, then runs it once.
- [ ] Operator compares the acknowledged count to a fresh census (256 or more) before any scheduling is considered.
