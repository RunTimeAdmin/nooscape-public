# Validation Registry census: the measurement (2026-11-20)

This is the measurement behind the report at `/field/validation-registry-2026-11-20`. It counts the `ValidationRequest` and `ValidationResponse` events that the ERC-8004 Validation Registry has emitted on 23 chains, from 2026-01-01 to the newest block, read from the chains' own logs on 2026-11-20. It is a set of aggregate counts: no agent, validator or wallet address is named here, no request document was fetched and no validator was called. Only the chains in the tables were asked. A chain that is not in them was not read.

## The registry

The registry is the proxy at `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`, the same address on every chain that has it. The address comes from MAINNET_ADDRESSES in scripts/addresses.ts of the erc-8004-contracts repository, commit 2fcc66421cef. The same file lists `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` for test networks. That address also holds proxy code on some mainnets, and it is not this registry and is not counted.

On each chain where the registry was found, the EIP-1967 implementation slot held `0xdb31f5d9167f8ebc8b30fbbf814c4d297c2d7f99`, 5,876 bytes of code that hold both event signatures. Owners are read from the Identity Registry at `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.

## How it was done

[The script](./validation-registry-census-2026-11-20.mjs) ran on 2026-11-20 from 01:29 to 01:45 UTC (981 seconds). It is read only: it asks nodes for the registry's code, its implementation slot, block headers, `ownerOf` on the Identity Registry and `eth_getLogs` on the registry, and it writes nothing anywhere. It waits at least 90 milliseconds between two calls to the same host and uses a few workers at a time.

Most chains were read through public nodes that need no key. Base and BNB Chain keep too little history on their free public nodes, so they were read through archive endpoints of Nooscape's own (the hosts are in the second table; the addresses hold a key and are not published). Run without such an endpoint, the script reports those two chains as not read. It never reports a smaller count.

For each chain:

1. `eth_getCode` at the registry's address. No code means the chain has no registry at that address, and nothing more is asked of it.
2. The EIP-1967 implementation slot, and the implementation's code, which must hold the signatures of both events (check A). Code that does not is another contract on that address: the chain is counted as having no registry there and its logs are not read.
3. The newest block, and the first block at or after 2026-01-01 00:00 UTC, found by binary search over block headers. A node that has pruned its old blocks would make the search stop at the oldest block it still has, so the block found must be within an hour of the start time or the chain is not read.
4. Every log of the registry from that block to the newest, with no topic filter. The widest window the chain's nodes serve is found by asking for the whole range and then for smaller ranges ending at the newest block, and the range is then read in windows of that size. A node that answers 429 or a 5xx error, or does not answer, is waited for and asked again, six tries with growing pauses, and that is never read as "too wide". A window it still cannot answer is halved, and a node that cannot answer for more than 8 windows has stretches it times out on, so the chain is not read. Any other refusal says the window is too wide for that node, and the window is halved. A window that still fails at 100 blocks, or a chain that would need more than 12,000 calls, makes the chain not read: it is never counted as zero.
5. Check B: the unfiltered read returned only requests, responses and the proxy's own admin events (`Upgraded`, `OwnershipTransferred`, `Initialized`).
6. Check C: the implementation named by the last `Upgraded` event is the one the implementation slot holds at the newest block, so the read reached the end of the log.
7. For each request, `ownerOf(agentId)` at the Identity Registry at the block of the request and at the newest block, to say whether the validator the request names is the agent's own owner. An owner that cannot be read is counted as unknown, never as not the owner.

## Results

### Requests and responses, by chain

The order is the chains with a count (largest first), the chains that read as none, the chains not read, and the chains with no registry at the address. A date is the UTC date of the block header.

| Chain | Chain id | Read | Requests | Responses | Agents asked | Validators named | Validator was the owner at the request | Validator was not the owner | Owner unknown | First event | Last event | Head block |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|---|---:|
| Celo | 42220 | read | 21 | 17 | 1 | 21 | 0 | 21 | 0 | 2026-03-19 | 2026-03-19 | 83,237,399 |
| Base | 8453 | read | 18 | 15 | 7 | 7 | 15 | 3 | 0 | 2026-03-09 | 2026-11-18 | 59,738,892 |
| 0G | 16661 | read | 14 | 14 | 14 | 1 | 14 | 0 | 0 | 2026-07-15 | 2026-07-15 | 50,783,473 |
| Mantle | 5000 | read | 10 | 0 | 2 | 2 | 10 | 0 | 0 | 2026-06-18 | 2026-06-26 | 103,503,924 |
| Monad | 143 | read | 5 | 5 | 4 | 3 | 2 | 3 | 0 | 2026-09-20 | 2026-10-12 | 123,736,595 |
| Abstract | 2741 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 89,426,463 |
| Arbitrum One | 42161 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 525,783,286 |
| Avalanche C-Chain | 43114 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 100,829,008 |
| BNB Chain | 56 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 134,607,388 |
| Ethereum | 1 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 26,453,023 |
| GOAT Network | 2345 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 16,980,083 |
| Gnosis | 100 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 49,368,923 |
| Linea | 59144 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 32,657,726 |
| MegaETH | 4326 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 32,341,151 |
| Metis Andromeda | 1088 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 23,435,887 |
| Optimism | 10 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 159,769,688 |
| Polygon | 137 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 97,621,790 |
| SKALE Base | 1187947933 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 3,393,881 |
| Scroll | 534352 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 35,790,321 |
| Taiko | 167000 | read | 0 | 0 | 0 | 0 | 0 | 0 | 0 | none | none | 14,247,041 |
| Injective EVM | 1776 | not read | not read | not read | not read | not read | not read | not read | not read | not read | not read | not read |
| X Layer | 196 | not read | not read | not read | not read | not read | not read | not read | not read | not read | not read | not read |
| Soneium | 1868 | no registry | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

68 requests and 51 responses were found on the chains that were read. 5 of those 20 chains hold any; the other 15 hold none.

### How each chain was read

Check A runs before any log is read, so a chain that was not read still has a result for it. Checks B and C need the logs and say "not read" for such a chain. "No upgrade seen" means the read found no `Upgraded` event to compare, so check C has nothing to say.

| Chain | Nodes that answered | First block counted (UTC time) | Window (blocks) | Calls | Check A | Check B | Check C |
|---|---|---|---:|---:|---|---|---|
| Celo | celo.gateway.tenderly.co | 55,324,842 (2026-01-01 00:00) | 27,912,558 | 1 | held | held | held |
| Base | base-mainnet.g.alchemy.com | 40,218,127 (2026-01-01 00:00) | 19,520,766 | 1 | held | held | held |
| 0G | evmrpc.0g.ai | 19,229,582 (2026-01-01 00:00) | 50,000 | 636 | held | held | held |
| Mantle | mantle.gateway.tenderly.co | 89,547,644 (2026-01-01 00:00) | 13,956,281 | 1 | held | held | held |
| Monad | rpc2.monad.xyz | 45,742,991 (2026-01-01 00:00) | 10,000 | 7,805 | held | held | held |
| Abstract | api.mainnet.abs.xyz | 33,002,022 (2026-01-01 00:00) | 56,424,442 | 1 | held | held | held |
| Arbitrum One | arbitrum.gateway.tenderly.co | 416,593,974 (2026-01-01 00:00) | 109,189,313 | 1 | held | held | held |
| Avalanche C-Chain | avalanche.gateway.tenderly.co | 74,824,634 (2026-01-01 00:00) | 26,004,375 | 1 | held | held | held |
| BNB Chain | bsc-mainnet.nodereal.io | 73,631,159 (2026-01-01 00:00) | 50,000 | 1,224 | held | held | held |
| Ethereum | gateway.tenderly.co | 24,136,053 (2026-01-01 00:00) | 2,316,971 | 1 | held | held | held |
| GOAT Network | rpc.goat.network | 9,114,341 (2026-01-01 00:00) | 7,865,743 | 1 | held | held | held |
| Gnosis | gnosis.gateway.tenderly.co | 43,933,728 (2026-01-01 00:00) | 5,435,196 | 1 | held | held | held |
| Linea | linea.gateway.tenderly.co | 27,283,080 (2026-01-01 00:00) | 5,374,647 | 1 | held | held | held |
| MegaETH | mainnet.megaeth.com | 4,428,589 (2026-01-01 00:00) | 27,912,563 | 1 | held | held | held |
| Metis Andromeda | andromeda.metis.io | 21,896,212 (2026-01-01 00:00) | 1,539,676 | 1 | held | held | held |
| Optimism | optimism.gateway.tenderly.co | 145,813,412 (2026-01-01 00:00) | 13,956,277 | 1 | held | held | held |
| Polygon | polygon.gateway.tenderly.co | 81,053,171 (2026-01-01 00:00) | 16,568,620 | 1 | held | held | held |
| SKALE Base | skale-base.skalenodes.com | 236,572 (2026-01-01 00:00) | 2,000 | 1,584 | held | held | held |
| Scroll | rpc.scroll.io | 27,436,798 (2026-01-01 00:00) | 8,353,524 | 1 | held | held | held |
| Taiko | rpc.mainnet.taiko.xyz | 3,857,597 (2026-01-01 00:00) | 10,000 | 1,044 | held | held | held |
| Injective EVM | sentry.evm-rpc.injective.network | not read | not read | not read | held | not read | not read |
| X Layer | rpc.xlayer.tech | not read | not read | not read | held | not read | not read |
| Soneium | rpc.soneium.org | n/a | n/a | n/a | failed | n/a | n/a |

### Chains not read

The reason is the script's own, as it printed it.

- Injective EVM: `not read: the node could not answer for more than 8 windows, the last blocks 187058481 to 187063480 could not be read (HTTP 504)`
- X Layer: `not read: the node serves windows of 100 blocks, which would need 279,134 calls`

### A chain with another contract at the address

- Soneium (chain id 1868): the address holds code, and the implementation slot reads `0xcb7af40c0be4fb92e183942b6dbb6b14a888f067`, 2,188 bytes of code. The contract there is not this registry: its code does not hold both of its event signatures.

### The checks

All three held on each of the 20 chains that were read. On the chains that were read, the unfiltered read returned, besides the requests and responses, 101 admin events (40 Initialized, 21 OwnershipTransferred, 40 Upgraded) and 0 logs of any other kind.

### Who was asked

For each request the script read the owner of the agent at the block of the request and compared it with the validator the request names. In 41 of the 68 requests the validator named was that owner. In 27 it was not. Read at the newest block instead, the validator named is the owner in 37 and is not in 31.

### Compared with another reader's count

A reader published a count of the same registry as of 2026-10-13 ([the repository](https://github.com/achemperety/erc8004-usage-2026-10-13)), with its code and controls. It found 65 requests and 48 responses on 5 chains, and none on the others it read. Celo's figures there were lower bounds. Of the 19 chains both counts cover, they agree on 18, and this count is higher on 1, where requests or responses came after that date.

| Chain | Count as of 2026-10-13 | Count on 2026-11-20 | Agreement |
|---|---|---|---|
| Celo | 21 requests, 17 responses (a lower bound) | 21 requests, 17 responses | the lower bound is met |
| Base | 15 requests, 12 responses | 18 requests, 15 responses | higher |
| 0G | 14 requests, 14 responses | 14 requests, 14 responses | same |
| Mantle | 10 requests, 0 responses | 10 requests, 0 responses | same |
| Monad | 5 requests, 5 responses | 5 requests, 5 responses | same |

## What this does not say

- A request is not a result, and a response is not an endorsement. The registry stores what its contracts were called with.
- A chain that was not read is not a chain with none.
- A validator named is only an address. Nothing here says what a validator did.
- The registry accepts a request from the agent's owner or an approved operator. Which of them asked is not recorded here, so "validator was the owner" compares the validator with the owner only.
- Validation contracts that are not this registry are not counted.
- Only the chains in the tables were asked.

## Run it again

From `apps/nooscape-relay`:

```
node docs/validation-registry-census-2026-11-20.mjs > result.json
```

Progress goes to stderr and the result to stdout. To read Base or BNB Chain, set `VALIDATION_CENSUS_RPC_BASE` or `VALIDATION_CENSUS_RPC_BNB` to an archive endpoint of your own first. To read some chains only, name them after the script's path (`... base celo`). The figures file `client/src/lib/validationRegistryReport.ts` holds each row as the script printed it, and a test fails if a row differs from the first table here.
