# Source approval: SAID Protocol identity registry (Solana)

Completed against `docs/external-source-approval-template.md`. Design and verification record:
[said-solana-2026-10-13.md](../said-solana-2026-10-13.md).

| Field | Record |
|---|---|
| Source owner | SAID Protocol (GitHub org `SAID-Protocol`, source at github.com/SAID-Protocol/said, MIT licensed; operator handle `@saidinfra` per saidprotocol.com/docs). Nooscape does not contact the project: it reads public chain state only. |
| Contact | Not applicable for a chain read. The program is open source and public; there is no hostname, API key, or account involved. |
| Protocol | Solana on-chain program, adapter `solana_said` (migration 0030 adds the enum value). |
| Approved root | Solana mainnet JSON-RPC. The row records `https://api.mainnet-beta.solana.com`; production reads use the keyed provider in `SOLANA_RPC_URL` through the shared paced client (`server/ingestion/solanaRpc.ts`). |
| Permitted resource | Exactly two JSON-RPC methods: `getSlot`, and `getProgramAccounts` on program `5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G` filtered by `memcmp` on the AgentIdentity discriminator. No transaction is sent and no account is written. |
| Written permission / terms | Public blockchain state; the program is deployed on mainnet and open source. No terms restrict reading chain data. SAID's HTTP API, its terms, and its paid x402 endpoint are **not** used. |
| Data classification | Public chain facts only: owner and authority wallets, the metadata URI string and its host, the badge flag, v3 stake and slash counts, and the registration date. Excluded: every SAID-computed score or tier, any off-chain registration, and anything behind a payment. The metadata URI is stored as a host and a hash and is never dereferenced. |
| Cadence | Manual pilot first (`manual_only`, seed pass then attended refreshes). A scheduled flip is a separate reviewed migration after a clean attended period. |
| Expected identity signal | Explicitly `unverified`. `is_verified` is a SAID badge bought for 0.01 SOL or granted by a sponsor; it is recorded as a badge and labelled "not an identity check". |
| Review owner | Nooscape operator account on /admin/sources, who stages, approves, pauses, and revokes the source. |
| Revocation route | Pause or reject the source on /admin/sources: the active-source join in the reviewed-run gate and the directory visibility predicate hide its entries immediately, with no row deleted. |
| Decision | **Build approved 2026-10-13** by the operator for a directory-only pass (chain facts only, no SAID scores, no paid endpoint). **Activation pending:** the source is staged `review` and `manual_only` on first registration and must be approved by an operator before it can run. |
| Decision timestamp | Build scope: 2026-10-13 (operator, in session). Activation: pending. |

## Required checks before activation

- [x] Layout verified against the full live population before adapter code: 13,313 of 13,313 AgentIdentity
  accounts decode (v1 1,156 / v2 1,635 / v3 10,522), and the PDA, URI, and verified flag agree with SAID's
  own API for every one.
- [x] The adapter ran against mainnet with no database: 13,313 identities, 2 requests, 2.1 s.
- [x] Strict decode fails closed; a truncated listing fails the pass under the 98% floor; the cursor
  persists only after a whole snapshot.
- [x] The pass writes no agent, snapshot, or evidence event, so a run of this source can never be
  projected into the reviewed census.
- [ ] Operator stages and approves the source, then runs the seed pass once.
- [ ] Operator compares the acknowledged count to a fresh census (expect 13,313 or more) before any
  scheduling is considered.
