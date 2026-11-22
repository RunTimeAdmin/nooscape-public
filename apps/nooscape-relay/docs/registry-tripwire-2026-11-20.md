# The registry upgrade tripwire (2026-11-20)

The operator chose "a" on 2026-11-20 for item 4 of the 2026-11-19 review: read the three ERC-8004 registry proxies on every chain the app reads once a day, and say so when one has changed. This is the record of what it reads, what it was set against, what it says, and how to run it.

## Why

Three contracts decide what Nooscape can read and say on each chain. All three are upgradeable proxies (EIP-1967): their owner can change what they do in one transaction, and the address does not move. ERC-8004 was still a Draft on 2026-11-19. A changed implementation is the one signal that says "what Nooscape verified may no longer be true" before a wrong answer is served, and nothing else watches for it.

| Registry | What rests on it |
|---|---|
| Identity, `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | The chain passes (registrations, transfers, URI updates), the claims (`ownerOf`) and the check's `pay_to` (`getAgentWallet`, [the record](./check-pay-to-2026-11-20.md)). |
| Reputation, `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | The ratings step (`server/chainRatings.ts`) and Robinhood Chain's reputation reads. |
| Validation, `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` | The field note only ([the census](./validation-registry-census-2026-11-20.md)). Nothing is ingested from it. |

## What it reads

`eth_getStorageAt` at each proxy's EIP-1967 implementation slot (`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`), at the latest block, on the eight chains the app reads: Robinhood Chain (4663), BNB Chain (56), Ethereum (1), Base (8453), Monad (143), Gnosis (100), Arc (5042) and Celo (42220). That is 24 slots. (The first run and the first scheduled run read 21 slots on seven chains; Celo joined the same day with its own chain, [the record](./celo-erc8004-2026-11-20.md).) It is read only, and writes nothing anywhere.

For each chain it asks the app's own node first (`BSC_RPC_URL`, `ETH_RPC_URL`, `BASE_RPC_URL`, `MONAD_RPC_URL`, `GNOSIS_RPC_URL`, `CELO_RPC_URL` and `X402_RPC` for Arc), then public nodes if that one fails. A node that cannot answer is asked again twice, after one and three seconds. A node address can carry a key, so no line it prints names one: a failure is a fixed phrase ("the node did not answer"), and a test holds that.

## The pins

What each proxy pointed at on 2026-11-20, in `PINNED` and `PINNED_BY_CHAIN` in [the script](../scripts/registry-tripwire.mjs), and again as literals in its test.

| Registry | Implementation | Code | Chains |
|---|---|---|---|
| Identity | `0x7274e874ca62410a93bd8bf61c69d8045e399c02` | 14,474 bytes, SHA-256 `201b7634af2de088...` | all eight |
| Reputation | `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` | 10,491 bytes, `0d8bb97bb04ab481...` | all eight |
| Validation | `0xdb31f5d9167f8ebc8b30fbbf814c4d297c2d7f99` | 5,876 bytes, `ccc2b9fb56681186...` | seven, not Robinhood Chain |
| Validation on Robinhood Chain | `0x1b325b4035d264fe04f40a632b6798771127c79a` | 5,876 bytes, `37e046c9f4605ff9...` | Robinhood Chain |

The pins were set from two independent reads on 2026-11-20: the script on public nodes only, and the script through the app's own node settings (NodeReal for BNB Chain and Ethereum, Alchemy for Base, Monad and Gnosis, the operator's own node for Arc). Both gave the same 21 values. Celo's three slots were read through public nodes only and equal the same pins. The review of 2026-11-19 had found the same three implementations on the eleven chains it probed.

Robinhood Chain's Validation Registry is its own deployment. Its code has the same size as the others' and carries both event topics (`ValidationRequest` and `ValidationResponse`), and its hash differs. The first run found it, and it is not a change. Why the build differs was not looked into, because the app reads nothing from this registry.

## What it says

Through `notify.sh`, so to the system log and to `ALERT_WEBHOOK_URL`:

```
ERC-8004 registry change: 1 proxy slot differs from what Nooscape verified on 2026-11-20: Base Identity Registry now 0x..., verified 0x7274...9c02. The check's pay_to, the claims and the ratings rest on these registries. Re-check them, then update PINNED in scripts/registry-tripwire.mjs. This repeats on every run until then.
registry tripwire could not read 1 slot: Monad Identity Registry (the node did not answer). A change in that registry is not seen until it can.
registry tripwire is watching: all 24 proxy slots on 8 chains match the pins of 2026-11-20.
```

A clean run is quiet. The third line goes out on Mondays (UTC), or when `tripwire.sh --heartbeat` is run, and only when there is nothing else to say, so that silence is not taken for a dead job. A change is said on every run until the pins move: an upgrade that nobody has looked at stays loud. At most six slots are listed in a message, then a count. Every run also writes its summary and one line for each slot to the log (`journalctl -t nooscape-tripwire`).

## When it says a registry changed

1. Read the proxy's `Upgraded(address)` events to see when the implementation moved, and compare the new implementation's code with the pinned one (size, verified source, event topics).
2. Re-run what rests on it: `getAgentWallet` and `ownerOf` on a few agents of that chain (the end-to-end script of [the pay_to record](./check-pay-to-2026-11-20.md)), the event decoding against a fresh sample, and the ratings.
3. Change `PINNED` (or `PINNED_BY_CHAIN`) and `PINS_VERIFIED` in the script and the literal pins in `server/registryTripwire.test.ts`, say what was found in the pull request, and deploy. The alert stops at the next run.

## Run it

The script is copied into the app image (`deploy/vps/Dockerfile`), so a deploy of the commit that adds it comes first. Then, on the server as root:

```
install -m 0644 $KIT/tripwire.cron /etc/cron.d/nooscape-tripwire
cd $KIT && bash tripwire.sh --heartbeat
journalctl -t nooscape-tripwire -n 30
```

The second command runs it once, now, and puts the "watching" line in the chat. The schedule is once a day at 05:37 UTC through `run.sh`, like the other jobs. A fresh host gets the schedule from `host-setup.sh`. To stop it, remove `/etc/cron.d/nooscape-tripwire`. It runs inside the app container, so while a deploy has the container down it waits 90 seconds and tries once more before it says it did not run.

## What it does not do

- It reads the implementation slot only. A change of the proxy's owner, or of a setting inside an unchanged implementation, is not seen.
- It watches the eight chains the app reads. The other chains of the Validation census are not watched. A test fails when the app gains a chain that the tripwire does not list.
- It says nothing about whether a new implementation is safe or compatible. It says that it is new.
- A change is seen at the next run, so up to a day after it.
- It asks one node's answer to be true. Two independent paths agreed on the day the pins were set, but a day's run does not cross-check them.

## Files

- [`scripts/registry-tripwire.mjs`](../scripts/registry-tripwire.mjs), the reading and the comparison.
- `server/registryTripwire.test.ts`: the reading, the comparison, the secrecy of the node addresses, the chain list held to the app's own, and the wiring.
- `deploy/vps/tripwire.sh` and `tripwire.cron`; the image's `COPY` line in `deploy/vps/Dockerfile`; the install line in `deploy/vps/host-setup.sh`; a row in [the VPS runbook](./move-to-vps-2026-11-04.md).
