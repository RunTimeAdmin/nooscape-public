# Smart-contract wallets on Base (4 November 2026)

One setting, and one rule that moved from "Arc's node" to "the node of the network the payment names", with the index and the wording that follow. No migration. Nothing changes for Arc, for a regular wallet's key or for a caller with a key.

**Status.** Live. Merged as PR 257 on 2026-11-04 at 03:57 UTC with the switch off. The operator set `X402_BASE_SMART_WALLETS=1` and redeployed at 04:00 UTC, and the first smart-contract wallet's payment on Base settled at 04:02 UTC (see "The first live payment" below).

**Decided:** 2026-11-03 (evening, Central time), by the operator, in chat. A plugin for Coinbase's Wallet MCP was being tested with a paid call from a Coinbase Wallet, and Nooscape refused it. He was shown two options (make Nooscape accept smart-wallet signatures on Base, or pay from a regular key-based wallet outside the Wallet MCP) and chose the first.

## What happened

The Wallet MCP signs with a Coinbase Wallet (Base App) account, which is a smart-contract wallet. The paid check (`POST /api/v1/check`, 0.01 USDC on Base) answered 402 with Nooscape's own words: "payments from smart-contract wallets are not accepted yet: sign with a regular wallet's key". No money moved: the receiving address held the same 0.110000 USDC before and after.

Base had been regular-wallets-only by design since 21 October ([the Base record](./x402-base-bazaar-2026-10-21.md), point 3 of the choices): the only node the service held for a wallet check was Arc's. The index said so (`wallets: ["regular"]` for Base) and so did `llms.txt` ("Wallets: regular wallets"). The plugin text drafted for Coinbase's repository said the paid check works through the Wallet MCP, which was not true for any Wallet MCP user.

## What changed

- **A switch.** `X402_BASE_SMART_WALLETS` is on only when it is exactly `1` (`baseSmartWallets` in `loadX402`). Any other value, or none, is off. It needs Base to be offered and `BASE_RPC_URL` to be set, the same Base node the identity pass and the funds check already use. The startup log says which of the three cases holds, and never the node address.
- **One rule for the index and the service.** `takesContractWallets(cfg, rail)` in `server/x402.ts`: Arc takes such a wallet when `X402_RPC` is set (as before), Base when the switch is on and the Base node is set. `/api/v1`, `llms.txt`, the OpenAPI description and the developer page follow it; the discovery document does not change.
- **The node is chosen by the network the payment names** (`server/x402Service.ts`). `verify` looks the payment's network up in a table of nodes (Arc's, and Base's when the switch is on) and asks that node and no other. `verifyContract` takes the chain id and the USDC address from the rail instead of Arc's, so a Base payment is simulated against Base's USDC on chain 8453.
- **The rules for such a wallet apply on each network on its own** (`contractGate`): one payment unresolved at a time, a pause of a day after a settlement of its failed after it was broadcast, at most two sends. A failure on Base does not pause the same address on Arc.
- **A wallet is paused for a quarter of an hour when Coinbase refuses a payment that the chain check passed** (`refusedFor` in the ledger; the reason starts "refused after a passing check"). A network also takes no more smart-contract payments for the rest of the hour once 20 were refused or failed on it within an hour (`MAX_CONTRACT_FAULTS_PER_HOUR`, held in the process's memory, and the operator is told once in the log). A wallet's code can pass a simulation made with no sender and no gas price and still fail where the facilitator runs it, and a wallet costs nothing to make, so the pause of one wallet is not a limit on all of them.
- **A payment already recorded is resumed whatever the setting is now.** `verify` looks a smart-contract wallet's payment up in the ledger before it asks which node there is, so switching the setting off does not turn away a caller whose answer is still pending, with a refusal that invites a second payment.
- **Base's node is held tighter than Arc's.** It has 5 seconds to answer (Arc's 8) and its latest block may be 15 seconds behind (Arc's 60). A node's answer is read up to its cap and no further, where it used to be read whole and then measured. The wallet checks are counted on each network on its own, so a slow Base node cannot take Arc's places.
- **When the chain refuses a 65-byte signature, the local reason is told as well** (a Safe with one owner signs that way, so such a signature is checked as both): "As a regular wallet's key it was refused too: ...".
- **An undeployed wallet is still refused.** An ERC-6492 signature (what a Coinbase Wallet that has never sent a transaction signs) gets "the wallet is not deployed yet (an ERC-6492 signature): send one transaction from it first, or use a regular wallet's key". Coinbase's facilitator refuses such a wallet as well (`invalid_exact_evm_payload_undeployed_smart_wallet`, already in the payer's refusals).
- **The Terms and the Privacy page are unchanged.** The Terms say a deployed smart-contract wallet is accepted "where the API says so", and the Privacy page says a blockchain node provider is asked whether the wallet's own code accepts the signature. Both already cover Base once the index lists it. `legalPages.test.ts` holds them to the code, and two of its pinned lines moved.

## What stays as it was

- A regular wallet's key on Base: no node is asked, with the switch on or off.
- A wallet that holds less than the price: the simulation fails at the balance, so it is turned away before anything is recorded or sent. A smart-contract wallet is not asked about its funds twice.
- The limits: 16 wallet checks at once and 600 a minute, on each network on its own.
- What the node sees: one `eth_call` naming the token, the wallet and the transfer. No key, no email, no network address of the caller.

## Checked

- `server/x402BaseSmartWallet.test.ts`, 27 tests, with one in `x402Chain.test.ts` and one in `apiPayments.integration.test.ts`: 29 new tests. Twelve of the seventeen first written failed before the change, and eight of the eleven added after the review failed against the code as first written (the other three describe behaviour that did not change). All pass now. The first 18 cover: the setting (exactly `1`), the index per network, the startup log, the switch off or no node (the old words, and the node never asked even when one is handed in), a payment taken after the Base node says yes (Base chain id and Base USDC in the call, Arc's node not asked, settled by Coinbase with the long signature as signed, recorded under Base), Arc unchanged, every refusal reason, a node that cannot say (down, another chain, behind, nonsense), no funds check for such a wallet, one payment at a time, the pause per network, at most two sends, no second look at the chain for a payment already recorded, an undeployed wallet's signature and junk, our terms held first, and a regular key untouched.
- The related suites (x402, apiV1, apiPayments, discovery, legalPages, publicText): 20 files, 435 tests pass. `pnpm check` is clean.
- Against the real Base node (a read-only `eth_call` through `checkContractSignature`, signed by a throwaway key that holds nothing): a good signature from an empty wallet failed only at the balance ("the wallet's USDC balance is below the price"), so Multicall3, chain 8453, a fresh block time and Base USDC's bytes-signature `transferWithAuthorization` all answer as the code expects. Junk of a smart wallet's length from an ordinary address came back as "not one this wallet's own code accepts (ERC-1271)". A wrong chain id gave no verdict.
- The review's cases are covered: a recorded payment resumed with the setting off (open, then paid), the pause after a refusal on that network only, the limit of twenty and the hour moving on, a regular key's refusal left as it was, the local reason told, the node taken from `BASE_RPC_URL` and not Arc's when none is handed in (a fetch that answers by address), the checks counted per network, the lag allowance per network, Coinbase's catch-all refusal on the last send left open, an answer without end cancelled at its cap, and the new ledger method on a real database.
- Not checked before the switch was on: that Coinbase's facilitator settles a smart-wallet signature. Its refusal list names an undeployed smart wallet, which says it knows them, and the Wallet MCP pays Coinbase's own catalogue this way, but nothing here had sent it one. The live payment below answered it.

## The first live payment (2026-11-04)

The operator set `X402_BASE_SMART_WALLETS=1` in hPanel and redeployed: the deploy is stamped 04:00:17 UTC, and the log of each of the two processes opens with `[x402] Base takes smart-contract wallets (deployed ones, whose own code accepts the signature)`. At 04:02:56 UTC he ran the paid check from a Coinbase Wallet through the Wallet MCP (`initiate_x402_request`, then `complete_x402_request`, `maxPayment` `0.01`), for the Base agent 96560.

- **On chain.** 0.01 USDC (10,000 units) moved from the wallet to the receiving address in block 53487815: transaction `[transaction hash withheld]`, status 1, 123,644 gas, sent by Coinbase's facilitator through `transferWithAuthorization` with the signature as bytes (selector `0xcf092995`). The payer has code on Base, so it is a deployed smart-contract wallet.
- **In Nooscape.** One log line for the payment, `[x402] paid check nsc_69a3f8ac52a1d825f32eab69612c0a92 [transaction hash withheld] on eip155:8453 (bazaar: processing)`, and nothing after it: no `failed after broadcast`, no settlement code that is not known. `scripts/verify-live.mjs`, run straight afterwards: 48 passed, 0 warnings, 0 failed, including "no payment is stuck".
- **At the Wallet MCP.** The answer came back with the check's four flags (first seen 2026-10-21, 14 days before, against a threshold of 30; no ownership change recorded through block 53485056; revoked feedback not measured, because ratings are read on Robinhood Chain only; a fleet of 7 listings by the same wallet, 2 others on the same host and none with the same name) and Nooscape's line that none of this is a safety verdict, which the agent passed on.
- **What it shows.** Coinbase's facilitator settles a deployed smart-contract wallet's signature as Nooscape forwards it, and the Wallet MCP's two calls are enough for a paid check. The plugin text in coinbase/agents#16, which says so, is true as written.
- **What it does not show.** It is one payment. The wallet was already deployed, so the refusal of an undeployed wallet (the ERC-6492 words) was not seen live. No payment was refused after a passing check, so neither the pause of a quarter of an hour nor the limit of twenty an hour has run live; the tests cover them. At 04:12 UTC the Bazaar row for `/api/v1/check` still counted 11 calls in 30 days (the log line says `bazaar: processing`).

## The independent review

A reviewer who had not seen my reasoning read the diff and the code around it (the security-reviewer agent, 4 November 2026). It found nothing high, said the code is correct for honest wallets and that merging is safe because the switch is off, and asked for fixes before the switch is turned on.

| Finding | What was done |
|---|---|
| M1. A wallet whose code passes our simulation and fails at Coinbase is refused with no pause, can start 60 payments a minute, and many of them fill the shared 300-a-minute budget | Fixed: a pause of a quarter of an hour on that network after a refusal, and the limit of twenty refusals or failures an hour on a network. The pause is short on purpose: an honest wallet refused for a small reason is not shut out for a day. |
| M2. Switching the setting off turns away a caller whose payment is recorded, with a refusal that invites a second payment | Fixed: a recorded payment is resumed first. This also corrects step 4 below, which was true only of Arc's node being set. |
| L1. A delegated account (EIP-7702) signs 65 bytes like a regular key, yet USDC sends any payer that has code to ERC-1271 | Not fixed. It needs a read of the payer's code on every payment. It is the same for Arc, no payment is lost (Coinbase's own check and the token decide), and it is written down below. |
| L2. The limits are shared across networks, and held in each process's memory, of which the host runs two | Per-network counters done, and Base's node is held to 5 seconds. The limits being per process is how every limit in this service is held and is not changed here. |
| L3. A bad regular signature on Base reaches the node and the real cause is lost | Fixed: the local reason is told for a 65-byte signature. |
| L4. A node's answer is read whole before it is measured, and the lag allowance is 30 Base blocks | Fixed: read up to the cap, and 15 seconds on Base. |

## Known limits

- A delegated account (EIP-7702) is treated as a regular wallet's key, as on Arc. Where USDC sends such a payer to its delegate's code, the token decides at settlement.
- The pause, the limit of twenty and the one-payment-at-a-time lock live in each process's memory or are read from the ledger per request; the host runs two processes of the app, so each limit can be reached once in each.
- One live payment is one data point. Keep watching the log for "failed after broadcast", for a settlement code that is not known, and for the first refusal after a passing check, which starts the pause.

## Turning it on (the operator)

1. Merging deploys with the switch off. Nothing changes.
2. In hPanel set `X402_BASE_SMART_WALLETS` to `1` (`BASE_RPC_URL` is set already) and redeploy. The runtime log then shows `[x402] Base takes smart-contract wallets`, and `/api/v1` lists `smart_contract` for Base.
3. Live test: a paid check from a Coinbase Wallet through the Wallet MCP, 0.01 USDC. If the wallet has never sent a transaction, send one from it first.
4. To turn it off, remove the setting and redeploy. A payment already recorded still resolves: its caller's retry is resumed, not refused (a test holds this).

## Open

- The refusal paths have run in tests only: an undeployed wallet's refusal, the pause after a refusal that Coinbase makes, and the limit of twenty an hour.
- The Bazaar row's counters had not counted the live payment ten minutes after it. A later look at the row says whether they did; nothing here depends on it.
