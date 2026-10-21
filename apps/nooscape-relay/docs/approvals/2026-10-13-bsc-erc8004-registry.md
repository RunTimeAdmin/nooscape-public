# Source approval: BNB Smart Chain ERC-8004 identity registry

Completed against `docs/external-source-approval-template.md`. Design and verification record:
[bsc-erc8004-2026-10-13.md](../bsc-erc8004-2026-10-13.md). Research and review:
[bnb-chain-agents-plan-2026-10-13.md](../bnb-chain-agents-plan-2026-10-13.md).

| Field | Record |
|---|---|
| Source owner | The ERC-8004 identity registry contract on BNB Smart Chain (chain 56) at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, deployed at block 79,027,268. Nooscape does not contact any project: it reads public chain state only. |
| Contact | Not applicable for a chain read. The contract is public; there is no API key or account on the source side. |
| Protocol | EVM on-chain registry, adapter `erc8004_bsc` (migration `0033` adds the enum value; migration `0034` adds the registry rows table the registrations are stored in). |
| Approved root | The source row records only the provider host: `https://bsc-mainnet.nodereal.io`, hostname `bsc-mainnet.nodereal.io`. The keyed endpoint lives only in the `BSC_RPC_URL` environment variable, never in the database, and the pass refuses an endpoint whose host differs. |
| Permitted resource | Exactly three JSON-RPC methods: `eth_chainId`, `eth_getBlockByNumber("finalized")`, and `eth_getLogs` on the registry address with the `Registered`, `Transfer`, and `URIUpdated` topics, in windows of at most 50,000 blocks over finalized blocks. No transaction is sent, no contract read method is called, and no agent URI is fetched. |
| Written permission / terms | Public blockchain state; no terms restrict reading chain data. The RPC provider is a paid NodeReal account held by the operator; the provider's terms govern request volume (the backfill is about 970 `eth_getLogs` calls, then one short run per tick). |
| Data classification | Public chain facts only: the registering owner wallet, the URI string's kind, host, and SHA-256, a name decoded locally from inline registration JSON (self-asserted), and mint, transfer, and URI-update events. Every registration is stored in the registry rows table; the directory lists only those that pass the published rules (a profile link no other registration holds, a host fewer than 50 registrations point at, a wallet that registered fewer than 10 agents, a name that is not only a number), which counts shared records and says nothing about whether an agent is real. Excluded: every score, tier, or quality judgment (D1), any fetched content (D2), and the reputation and validation registries. |
| Cadence | Manual pilot first (`manual_only`, attended runs until the cursor reaches the finalized head; the benchmark needed 36 runs that read blocks). A scheduled flip is a separate reviewed migration after a clean attended period. |
| Expected identity signal | Explicitly `unverified`. A registration is an owner's own recorded claim; most of the 373,567 identities are templates and platform issuers (86% name a platform from the URI alone). |
| Review owner | Nooscape operator account on /admin/sources, who stages, approves, pauses, and revokes the source. |
| Revocation route | Pause or reject the source on /admin/sources: the active-source join in the reviewed-run gate and the directory visibility predicate hide its entries immediately, with no row deleted. |
| Decision | **Build approved 2026-10-13** by the operator (decisions D1 facts only, D2 no URI fetching, D3 store all rows, D5 BNB next). **Activation pending:** the source is staged `review` and `manual_only` on first registration and must be approved by an operator before it can run; stage it only after the listing pull request has merged. The operator's instruction of 2026-10-13 (show about 5,000 real registrations, not 370k) is met by the published listing rules, not by a claim about which agents are real. |
| Decision timestamp | Build scope: 2026-10-13 (operator, in session). Activation: pending. |

## Required checks before activation

- [x] Phase 0 numbers re-derived independently from the raw logs and a fresh archive pull: ids 0 to 373,566 with no
  gaps, all 29,953 reputation logs identical, 30 sampled windows identical.
- [x] The provider's limits measured: the `eth_getLogs` range ceiling (50,000 blocks) and `finalized` tag support.
- [x] The pass decodes real registry logs for every registration variant and matches an independent decode.
- [x] The pass writes no agent, snapshot, or evidence event, so a run of this source can never be projected into the
  reviewed census.
- [x] The endpoint URL cannot appear in any error, log line, or run record (tested with a planted key).
- [x] The listing is built and tested against a real database: registry rows table, classification, publish, Home block, mutation-checked.
- [x] The listing pull request has merged and migration `0034` has applied at boot.
- [x] `BSC_RPC_URL` is set in the production environment (confirmed 2026-10-14: the first chain pass ran through it).
- [x] Operator stages and approves the source (2026-10-13, manual only) and runs the first chain pass (succeeded 2026-10-14 03:01Z).
- [ ] The chain pass reaches the finalized head. On 2026-10-14 the operator asked for the scheduled flip straight after that first attended run, so migration `0035` hands the remaining ~35 runs to the scheduler (a 15-minute cadence, in practice a run every 30 to 45 minutes, so 15 to 25 hours). Nothing is public until the run that reaches the head, which then publishes the listing in one step. To review first, pause the source on /admin/sources before that run; the walk and the stored rows are kept.
- [ ] Operator compares the registrations on-chain shown on Home with the chain, and reads the listed count against the published rules. The Home block exists only once the listing has published, so this follows the catch-up instead of preceding the scheduling; a bar that proves too loose can be tightened by a code change, which takes effect at the next classification.
