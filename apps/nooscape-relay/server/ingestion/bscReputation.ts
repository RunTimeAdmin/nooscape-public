import type { FeedbackEvent } from "../bscRaters";
import {
  decodeFeedbackRevokedLog,
  decodeNewFeedbackLog,
  ROBINHOOD_FEEDBACK_REVOKED_TOPIC,
  ROBINHOOD_NEW_FEEDBACK_TOPIC,
  ROBINHOOD_REPUTATION_IMPL,
  ROBINHOOD_REPUTATION_IMPL_SLOT,
  ROBINHOOD_REPUTATION_REGISTRY,
} from "./robinhoodReputation";

/**
 * Reading the BNB Chain ERC-8004 reputation registry (docs/bsc-rater-credibility-2026-10-16.md). Pure decoding and planning;
 * nothing here touches the network or the database.
 *
 * The registry is the standard ERC-8004 reputation proxy, at the same address on BNB Chain as on Robinhood Chain, behind the
 * same implementation (read from the ERC-1967 slot on both on 2026-10-16), so the event layouts the Robinhood adapter verified
 * on the wire are the layouts here, and its decoders are used as they are. The run checks the implementation slot each time and
 * stops if it has moved, because a layout this code has not verified is not read.
 */

export const BSC_REPUTATION_REGISTRY = ROBINHOOD_REPUTATION_REGISTRY;
/** The implementation the layouts were verified against. Read from the slot on BNB Chain on 2026-10-16. */
export const BSC_REPUTATION_IMPL = ROBINHOOD_REPUTATION_IMPL;
export const BSC_REPUTATION_IMPL_SLOT = ROBINHOOD_REPUTATION_IMPL_SLOT;
/** The first block with code at the registry's address, found on an archive node on 2026-10-16 (23 `eth_getCode` calls). The identity registry is 5 blocks older. */
export const BSC_REPUTATION_DEPLOY_BLOCK = 79_027_273;
/** The state row's key. There is one. */
export const BSC_REPUTATION_STATE_ID = "bsc";
/** One `eth_getLogs` filter for both event kinds: topic0 is an OR list at position zero. Replies and the proxy's own lifecycle events are not asked for. */
export const BSC_REPUTATION_TOPIC_FILTER: string[][] = [[ROBINHOOD_NEW_FEEDBACK_TOPIC, ROBINHOOD_FEEDBACK_REVOKED_TOPIC]];

export type LedgerRow = FeedbackEvent & { transactionHash: string };

export type ReputationWindowParse = { rows: LedgerRow[]; rejected: number };

/**
 * One window's `eth_getLogs` answer as ledger rows, in chain order. A log that does not decode (the filter asked only for the
 * two event kinds, so it is one of those with a layout that was not verified, or it is from another address) is counted as
 * rejected, and the run stops on a rejection and does not move its cursor past the window.
 */
export function parseReputationWindow(logs: unknown, bounds: { fromBlock: number; toBlock: number }): ReputationWindowParse {
  if (!Array.isArray(logs)) throw new Error("BNB Chain reputation log response must be an array.");
  const rows: LedgerRow[] = [];
  let rejected = 0;
  for (const log of logs) {
    const feedback = decodeNewFeedbackLog(log, bounds);
    const event = feedback ?? decodeFeedbackRevokedLog(log, bounds);
    if (!event) {
      rejected += 1;
      continue;
    }
    const agentId = Number(event.agentId);
    if (!Number.isSafeInteger(agentId)) {
      rejected += 1;
      continue;
    }
    rows.push({
      kind: event.kind === "new_feedback" ? "feedback" : "revoked",
      agentId,
      client: event.clientAddress,
      feedbackIndex: event.feedbackIndex,
      valueRaw: event.valueRaw,
      valueDecimals: event.valueDecimals,
      blockNumber: event.blockNumber,
      logIndex: event.logIndex,
      transactionHash: event.transactionHash,
    });
  }
  rows.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return { rows, rejected };
}

/** The address an ERC-1967 slot word names: its last 20 bytes, lower case. Null when the answer is not a 32-byte word. */
export function implementationOf(slotWord: unknown): string | null {
  return typeof slotWord === "string" && /^0x[0-9a-fA-F]{64}$/.test(slotWord) ? `0x${slotWord.slice(-40).toLowerCase()}` : null;
}
