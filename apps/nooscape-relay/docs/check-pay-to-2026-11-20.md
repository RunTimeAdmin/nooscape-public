# The check's pay_to (20 November 2026)

**Status.** Added to `POST /api/v1/check` on 2026-11-20. No migration, no new table, no new dependency, no job. The one new thing the route does is a single chain read, and only when a request carries `pay_to`. The operator chose this design ("a") from two on 2026-11-20: a live read when asked (this one), or ingesting the registry's `MetadataSet` events into a new table (not built).

## What it adds

An agent check may carry `pay_to`, an address such as the `payTo` of an x402 payment requirement:

```json
{ "agent": { "chain": "base", "id": "123" }, "pay_to": "0x..." }
```

Nooscape reads `getAgentWallet(agentId)` on the agent's own ERC-8004 identity registry at the latest block (one `eth_call`) and sets the address against it. The agent's result then has a `pay_to` block beside `evidence`, `flags` and `sources`:

| Field | What it holds |
|---|---|
| `address` | The address asked about, in lower case. |
| `outcome` | `matches_agent_wallet`, `differs_from_agent_wallet`, `no_agent_wallet` or `not_read`. |
| `agent_wallet` | The wallet the registry holds, in lower case. `null` when it holds none, and when it was not read. |
| `read_at` | When the check ran, or `null` when the registry was not read. |
| `reason` | Why it was not read: a fixed sentence with no address and no URL. `null` otherwise. |
| `basis` | What was compared, and what a match does not show. |

- **`matches_agent_wallet`**: the registry holds a wallet for the agent and it is this address.
- **`differs_from_agent_wallet`**: it holds a wallet and it is another address.
- **`no_agent_wallet`**: it holds none. None was set, or it was cleared when the agent changed hands.
- **`not_read`**: the registry could not be read, so nothing is said either way. It is never taken for "holds none".

`pay_to` goes with an agent only: with a wallet or a url it is a 400. A Solana agent with `pay_to` is a 400 too (a Solana registry has no `getAgentWallet`), and so is a value that is not `0x` and 40 hex digits. Letter case does not matter on either side of the comparison. Without `pay_to` the answer is exactly what it was and nothing is read from a chain. For an agent nothing lists (404), no chain is read.

It reads the eight EVM registries the API serves: Robinhood Chain, BNB Smart Chain, Ethereum, Base, Arc, Monad, Gnosis and Celo (the extra chains only while their switches are on, as the rest of the API). The read goes through `callChain` in `server/claimsChain.ts`, the paced clients the claims already use, so a visitor's reads of one chain are held to 60 a minute, shared with the claims' own reads; a BNB read spends from the compute-unit bucket the worker shares, and an Arc read goes through the operator's own node. When the budget is spent, or a node is down or slow, the answer is `not_read`.

## Payments

The check is for a Pro key or a payment. The rule for an answer that could not be built is the one the ledger facts already follow: a key is given the answer with `not_read`, and a payment is answered 503 and **not charged** (the call's own sentence: a payment is charged only for an answer that was built and delivered). The address is part of what a payment is for: a payment made for the plain check does not buy the check with `pay_to`, and a payment made for one address does not buy another. A subject without `pay_to` is spelled exactly as before.

## What the registries hold (measured 2026-11-20)

The registries are one proxy at one address (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`), and on all eight chains (Celo came after the others: [its record](./celo-erc8004-2026-11-20.md), [its claims record](./celo-claims-2026-11-20.md)) the proxy's implementation slot points at `0x7274e874ca62410a93bd8bf61c69d8045e399c02`, 14,474 bytes of code. `getAgentWallet(uint256)` (selector `0x00339509`) answered on all seven for every registered id tried, and for an id nobody registered it answered the zero address and did not revert (the same call to `ownerOf` reverted). The registry's source (`contracts/IdentityRegistryUpgradeable.sol` in erc-8004/erc-8004-contracts) writes the registering address as the agent's wallet in `register`, clears it in `_update` whenever a token moves between two non-zero addresses, and returns `address(bytes20(data))`, so an empty entry reads as the zero address.

So "none" is common wherever agents were minted by one address and handed to another. A random sample of 100 registered ids on each chain (a seeded draw, each id's owner and wallet read through the chain's node on 2026-11-20; the id range is the one found by bisecting `ownerOf`):

| Chain | Ids | Wallet is the owner | Another wallet | None |
|---|---|---|---|---|
| Robinhood Chain | 26,202 | 14 | 2 | 84 |
| BNB Smart Chain | 420,010 | 100 | 0 | 0 |
| Ethereum | 56,705 | 51 | 1 | 48 |
| Base | 1,216,596 | 9 | 0 | 91 |
| Monad | 10,426 | 100 | 0 | 0 |
| Gnosis | 4,190 | 6 | 16 | 78 |
| Arc | 427,188 | 2 | 0 | 98 |
| Celo | 10,080 | 27 | 72 | 1 |

On Celo most agents hold a wallet that is not the owner's (72 of the 100 read on 2026-11-20, a seeded draw with the seed 20261120 through the claim route's worker variant, and one holds none). On Base, Arc, Robinhood Chain and Gnosis most agents hold no wallet, so for them the usual answer is `no_agent_wallet`, which is a fact about the registry and not a fact about the address. The `basis` says so ("none is common"), and so do the OpenAPI document, the developer page and the skill file.

## Choices the request left open

These are mine, so the operator can say no.

1. **Plain comparison words, not the draft ERC's.** ERC-8478 (a draft in ethereum/ERCs, PR 2132, open on 2026-11-20) has nine outcomes, among them an endpoint that is not listed in the agent's registration file and a delegation from the wallet. This check reads the wallet and nothing else, and an outcome named `verified` would claim a binding it does not make. `matches_agent_wallet` is the wallet part of the draft's `verified-wallet`, `differs_from_agent_wallet` is its `mismatch` without the delegation test, `no_agent_wallet` is its `no-agent-wallet` and `owner-only` together, and `not_read` is its `not-read`.
2. **The wallet only, not the owner.** With 78 to 98 percent of agents on four chains holding none, a second read (`ownerOf`, already written for the claims) would let `no_agent_wallet` say whether the address is the registry's owner now, which is the draft's `owner-only`. It costs one more call a check and one more outcome, and is not built.
3. **Not read is a 503 to a payment**, as the ledger facts are, and not a free answer. A read that is never made for a reason that does not change (a registry that does not answer the call) is still `not_read`, so a payer is never told "none" for a read that failed.
4. **The address is in the payment's subject**, so a payment cannot be moved to another question.
5. **The claims' budget is shared.** A flood of checks with `pay_to` on one chain can use that chain's 60 reads a minute and make a claim's own read there answer "try again". Claims are on for Robinhood Chain, BNB Smart Chain and Arc (the production switches `claims` and `claims_arc`), and off for the other four. A budget of its own would be a small change to `makeCallChain`. Update 2026-11-21: built (the audit of that day, finding S1). The reads now have a bucket of their own for each chain (`callChainForPayTo`, still 60 a minute), each caller (a key, or an address with no key) is held to 20 reads a minute, and a wallet or a none is kept 30 seconds, so a repeated check of one agent costs no read. A refused read is `not_read`, which a payment is not charged for.
6. **Left as they were:** the x402 listing's example input (`CHECK_BODY_EXAMPLE`) and its schema, `examples/preflight-policy.ts`, and the `nooscape-mcp` package (a separate repository). None of them knows `pay_to` yet.

## What it does not say

It does not read the endpoint, the agent's registration file, a `payees` list or a delegation, and it does not know the network a payment is made on: the comparison is of two addresses. It is read at the latest block, so a transfer in a later block changes the answer, and the answer is never cached by a browser or a proxy (`Cache-Control: no-store`, as the whole check). Since 2026-11-21 the server keeps a wallet or a none for 30 seconds, and `read_at` is then the time it was read.

## Files

`server/agentWallet.ts` (the call, its answer and its reasons), `server/apiCheck.ts` (the request, `PAY_TO_BASIS`, `payToResult`), `server/apiV1.ts` (the `agentWallet` dependency, the route), `server/apiV1Spec.ts` (the request, the result, the path's description), `server/discovery.ts` (the skill file), `client/src/pages/DeveloperApi.tsx` (the panel). Tests: `server/agentWallet.test.ts`, `server/apiCheck.test.ts`, `server/apiV1Payments.test.ts`.
