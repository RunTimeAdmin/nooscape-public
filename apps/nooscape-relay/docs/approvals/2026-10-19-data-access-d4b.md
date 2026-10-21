# Decision record: Data access, stage D4b (smart-contract wallets)

**Decided:** 2026-10-19, by the operator, in chat: "lets do d4b and d5", after he raised on reviewing D4 that "a lot of AI agents pay from smart-contract wallets, which are exactly who the check is for" and that refusing them "will cost sales", and asked for support in a later stage.
**Changes:** a payment from a deployed smart-contract wallet is taken when the chain says the wallet's own code accepts the signature and the transfer would settle (a simulation, before anything is recorded or sent). One optional setting, `X402_RPC`. A wallet has one payment at a time, at most two sends and a day's pause after a settlement of its failed after it was broadcast. The index lists the kinds of wallet taken. New sentences on Terms, Privacy and the developer page. No migration, no new table, no new dependency.
**Does not change:** a record, a score, a tier, an evidence level, any answer, the price, who is paid, or what a regular wallet's payment does. Nothing changes on merge: smart-contract wallets stay refused until the operator sets `X402_RPC`.

## What the operator is asked to approve

1. **The rules that keep money safe for a wallet whose answer can change**, in the D4b section of `docs/data-access-2026-10-19.md`: nothing is recorded or sent unless the chain says it would settle; one payment at a time; two sends at most; a day's pause after a failed broadcast; a recorded payment is never asked of the chain again.
2. **The Terms, Privacy and developer-page wording**, written with no legal round (the time box set on 18 Oct 2026). It says that a deployed smart-contract wallet is accepted where the API says so, that one not deployed yet is not, and that for such a payment the server asks a node provider, which sees only public chain data.
3. **Which node to use.** A public node worked in the tests but is rate limited; a node of the operator's own is better once real traffic comes. The address is a setting and is never logged.
4. **The choices in the doc**, notably that a contract wallet with too little USDC is refused before anything is recorded.

## What the operator did not decide and I chose, so he can say no

See "Choices the spec left open" in the D4b section: off until `X402_RPC` is set; deployed wallets only; an unfunded contract wallet is refused up front; the per-wallet limits; the chain is not asked about a recorded payment; the wording had no legal round.

## What D4b leaves

Wallets that are not deployed yet (ERC-6492), a receipt reader and a budget for gas lost to failed settlements (the Archipelago server has both), a fallback node, and a live trial with a Safe and an ERC-4337 account (the test used a minimal owner-signed contract wallet on Arc testnet).

## Outcome

- [x] D4b built and tested on a local branch (2026-10-19), including a real settlement through Circle on Arc testnet from a deployed contract wallet.
- [ ] The operator has read the diff and accepts the choices above.
- [ ] Privacy and Terms wording read.
- [x] PR opened, merged and deployed (PR 164, 2026-10-19, main 79638b8).
- [x] `X402_RPC` set on the host (2026-10-19, the operator's own Arc node) and the live path probed on mainnet with a payment that cannot succeed: refused with the ERC-1271 message, nothing charged.
- [ ] A real payment from a deployed contract wallet tried on the live site on mainnet.
- [x] D5 (see its record).
