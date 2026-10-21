# Incident record: the 8004 Solana pass failing on version 1 transactions (2026-10-16)

The 8004 Solana pass failed on its 17:30Z and 19:00Z runs and was still failing when it was found at about 19:45Z. Its last good run was at 16:15Z. The data the pass keeps (the agent registrations, their owners and links) went stale for that time; nothing was served wrong, because a failed pass leaves its cursor and its rows untouched.

**Status.** The fix is in a pull request and is not live when this is written. The timeline's last row is filled in after the deploy.

## Cause

Solana mainnet now carries version 1 transactions. In a block sampled on 2026-10-16 (slot 457757616) 277 of 1,683 transactions were version 1, 173 were version 0 and 1,233 were legacy. The attribution walk of the 8004 pass asks `getTransaction` for the transactions that touched an agent's account, and it asked with `maxSupportedTransactionVersion: 0`. For a version 1 transaction the node answers error `-32015`, "Transaction version (1) is not supported by the requesting client", and the pass treated any RPC error as fatal, so one such transaction in one agent's recent history failed the whole pass. The same request in the SAID pass had the same exposure and had not met a version 1 transaction yet.

The run record held the start of the message (`Solana getTransaction failed at the RPC layer: Tra...`); the version 1 error is the cause that fits it, and it was reproduced against the public RPC: the same signature fails with version 0 and reads with version 1, `meta.logMessages` included.

## Timeline (UTC)

| Time | What |
| --- | --- |
| 14:15, 15:15, 16:15 | The pass completes. |
| 17:30:05 | The pass fails with the RPC error. `failureCount` is 1. |
| 19:00:04 | The pass fails the same way. `failureCount` is 2. |
| 19:39 | `verify-live` fails twice on the source: its failure count, and the 3 hour freshness limit (last success 3.4 hours ago). |
| about 19:45 | The run records are read in the host's SQL console, and the cause is found by asking mainnet for recent blocks with the old request. |
| after the deploy | The next pass completes; `verify-live` is 36 passed. |

## The fix

- Both walks ask for transactions up to version 1 (`SOLANA_MAX_TRANSACTION_VERSION` in `server/ingestion/solanaRpc.ts`).
- An answer of `-32015` is read as a transaction this client cannot read, which the walks already skip the way they skip a pruned one (`parseTransactionResult`). The next transaction format then costs one attribution and not the pass. Any other RPC error still fails loudly.
- Tests: the request names version 1 in both passes; a transaction answered with `-32015` is skipped and the next one anchors; another RPC error still fails the pass. Putting the old request back fails four of them.

## What it exposed

- A pass that cannot read one transaction should not stop for the others. The walk still throws when it has examined every transaction of an account and none matches (`solana8004.ts`), which can wedge a pass the same way for a different reason (the independent review's item 4, partly confirmed: it needs an account with ten or fewer transactions, because a busier one defers). SAID's model, adopting the change unanchored and counting it, is the shape of the fix and is not made here.
- The live check reports this correctly (run by hand at 19:39Z), but it is scheduled every three hours and GitHub has been running it every five to seven: its runs today were at 04:36Z, 11:29Z and 16:42Z (green, 27 minutes after the last good pass), and it had not run again by 19:48Z. So nothing automatic had noticed a pass that was three hours stale.
