import type { IngestionSource } from "../../drizzle/schema";
import { assertPublicHostname } from "./a2a";
import {
  callRobinhoodRpc,
  hexToSafeInteger,
  ROBINHOOD_CHAIN_ID_HEX,
  ROBINHOOD_RPC_URL,
  RobinhoodRegistryResponseTooLargeError,
  RobinhoodRegistryValidationError,
  splitBackfillWindow,
} from "./robinhood";
import type { UsdgSettlementEvent } from "./types";

/**
 * The canonical Global Dollar (USDG) ERC-20 on Robinhood Chain — Blockscout-
 * verified, ~$3.1B supply at the 2026-10-09 probe. Unverified copycat
 * deployments exist; only this address is approved.
 */
export const USDG_CONTRACT_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
/**
 * EIP-3009 `AuthorizationUsed(address indexed authorizer, bytes32 indexed
 * nonce)` (openchain-verified). USDG settles pre-authorized transfers with NO
 * dedicated transfer event: every settlement pairs this log with the ERC-20
 * Transfer it spent inside the same transaction, so the pair — never a
 * standalone event — is the settlement (live-verified 2026-10-09: authorizer
 * == Transfer.from on every sampled receipt).
 */
export const USDG_AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
/** ERC-20 `Transfer(address,address,uint256)` topic on the USDG contract. */
export const USDG_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** eth_call data for `decimals()`; the adapter asserts the canonical 6 every run. */
const USDG_DECIMALS_CALL = "0x313ce567";
const USDG_EXPECTED_DECIMALS_HEX = "0x0000000000000000000000000000000000000000000000000000000000000006";
/**
 * Settlement budget for one window. The receipt-per-settlement decode is the
 * run's real cost (~0.7 s each at the measured safe pacing), so the budget
 * bounds every run to a few minutes however dense the window is; a denser
 * window is narrowed to its newest fetchable half and the cursor resumes just
 * below it, exactly like the ERC-8004 walk. Zero-batching measured live
 * (2026-10-09: 7,315 authorizations = 7,315 distinct transactions in the
 * newest 2M-block window), so one AuthorizationUsed log is one settlement.
 */
export const USDG_MAX_SETTLEMENTS_PER_WINDOW = 200;
const USDG_SCAN_WINDOW_BLOCKS = 2_000_000;
const USDG_FINALITY_MARGIN_BLOCKS = 256;
/** Halvings from a 2M-block window down to a single block (21) plus headroom. */
const MAX_WINDOW_SPLITS = 24;
/**
 * Fail-closed value bound: $10^18 in raw 6-decimal units. The largest
 * settlement ever observed on the rail is far below this; anything larger is
 * rejected and counted rather than stored.
 */
const USDG_MAX_VALUE_RAW = BigInt("1000000000000000000000000");
/**
 * Pacing between receipt reads, measured live (2026-10-10): 30 receipts at
 * 700 ms ran clean while rapid large getLogs probes drew HTTP 429.
 */
const USDG_RECEIPT_PACING_MS = 700;
/**
 * Pacing between eth_getLogs scans, including the narrowing passes. Measured
 * live 2026-10-10: the dense-era walk's back-to-back narrowing bursts drew
 * sustained HTTP 403s from the Cloudflare-fronted edge while 700 ms-spaced
 * receipt reads ran clean, so the same measured-safe interval now spaces the
 * log scans too.
 */
const USDG_LOG_PACING_MS = 700;

type UsdgSettlementCursor = { mode: "seed" } | { mode: "walk"; toBlock: number } | { mode: "done" };

/**
 * Parses the persisted settlement-walk position. A fresh source starts in
 * seed mode at the finality margin; `us:<block>` resumes a walk; `us:done` is
 * terminal (the walk tiled back to genesis). Any other cursor fails closed.
 * Pure; never touches the network.
 */
export function parseUsdgSettlementCursor(cursor: string | null): UsdgSettlementCursor {
  if (cursor === null || cursor.trim() === "") return { mode: "seed" };
  if (cursor === "us:done") return { mode: "done" };
  const match = /^us:(\d+)$/.exec(cursor.trim());
  if (!match) {
    throw new RobinhoodRegistryValidationError("The stored cursor is not an approved USDG settlement-walk position.");
  }
  const toBlock = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(toBlock) || toBlock < 1) {
    throw new RobinhoodRegistryValidationError("Stored USDG settlement-walk position is out of bounds.");
  }
  return { mode: "walk", toBlock };
}

/** Next persisted settlement-walk position after scanning a window that starts at fromBlock. */
export function usdgSettlementCursorAfter(fromBlock: number): string {
  return fromBlock > 1 ? `us:${fromBlock - 1}` : "us:done";
}

/** Decodes one ABI-encoded uint256 data word into an exact decimal string. */
function decodeUint256(data: unknown): string | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data)) return null;
  try {
    return BigInt(data).toString();
  } catch {
    return null;
  }
}

/**
 * Decodes one settlement from an AuthorizationUsed log plus the receipt that
 * contains it: payer and value come from the ERC-20 Transfer whose `from`
 * equals the authorizer, payee from its `to`, relayer from the transaction
 * sender. The authorizer == Transfer.from assertion is the pairing rule — a
 * receipt whose Transfer set does not resolve the pairing unambiguously (zero
 * or multiple matches) yields null and is rejected and counted upstream,
 * never guessed. Returns null for anything that does not match the approved
 * contract, topic, or bounds. Pure; never touches the network.
 */
export function decodeUsdgSettlement(
  authLog: unknown,
  receipt: unknown,
  bounds: { fromBlock: number; toBlock: number }
): UsdgSettlementEvent | null {
  if (!authLog || typeof authLog !== "object" || Array.isArray(authLog)) return null;
  const auth = authLog as Record<string, unknown>;
  if (auth.removed === true) return null;
  if (typeof auth.address !== "string" || auth.address.toLowerCase() !== USDG_CONTRACT_ADDRESS.toLowerCase()) return null;
  const authTopics = auth.topics;
  if (!Array.isArray(authTopics) || authTopics.length !== 3) return null;
  if (typeof authTopics[0] !== "string" || authTopics[0].toLowerCase() !== USDG_AUTHORIZATION_USED_TOPIC) return null;
  if (typeof authTopics[1] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(authTopics[1])) return null;
  const blockNumber = hexToSafeInteger(auth.blockNumber);
  const logIndex = hexToSafeInteger(auth.logIndex);
  if (blockNumber === null || blockNumber < bounds.fromBlock || blockNumber > bounds.toBlock) return null;
  if (logIndex === null) return null;
  if (typeof auth.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(auth.transactionHash)) return null;
  const authorizer = `0x${authTopics[1]!.slice(26).toLowerCase()}`;

  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const transaction = receipt as Record<string, unknown>;
  if (typeof transaction.from !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(transaction.from)) return null;
  const relayerAddress = transaction.from.toLowerCase();
  if (!Array.isArray(transaction.logs)) return null;

  const matching: Array<{ payee: string; valueRaw: string }> = [];
  for (const entry of transaction.logs) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const log = entry as Record<string, unknown>;
    if (log.removed === true) continue;
    if (typeof log.address !== "string" || log.address.toLowerCase() !== USDG_CONTRACT_ADDRESS.toLowerCase()) continue;
    const topics = log.topics;
    if (!Array.isArray(topics) || topics.length !== 3) continue;
    if (typeof topics[0] !== "string" || topics[0].toLowerCase() !== USDG_TRANSFER_TOPIC) continue;
    if (
      typeof topics[1] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topics[1]) ||
      typeof topics[2] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topics[2])
    ) {
      continue;
    }
    if (`0x${topics[1]!.slice(26).toLowerCase()}` !== authorizer) continue;
    const valueRaw = decodeUint256(log.data);
    if (valueRaw === null) continue;
    matching.push({ payee: `0x${topics[2]!.slice(26).toLowerCase()}`, valueRaw });
  }
  // Zero or multiple value-decodable Transfers from the authorizer: the
  // pairing is ambiguous, so the settlement is not countable. Never guess.
  if (matching.length !== 1) return null;
  const [transfer] = matching;
  if (BigInt(transfer.valueRaw) > USDG_MAX_VALUE_RAW) return null;
  return {
    transactionHash: auth.transactionHash,
    logIndex,
    blockNumber,
    payerAddress: authorizer,
    payeeAddress: transfer.payee,
    relayerAddress,
    valueRaw: transfer.valueRaw,
  };
}

/**
 * Reads exactly one bounded block window of EIP-3009 settlements from the
 * canonical USDG contract on the approved Robinhood Chain RPC: chain check,
 * head, decimals assertion, filtered AuthorizationUsed eth_getLogs, then one
 * receipt per settlement at the measured safe pacing. It never queries wallet
 * balances, calls a facilitator, or submits a transaction. A window denser
 * than the settlement budget is narrowed to its newest fetchable half until
 * the response fits; the cursor resumes just below the scanned sub-window, so
 * no block of chain history is ever jumped over. Every settlement that does
 * not decode unambiguously is rejected and counted — the ledger keeps only
 * resolved payer/payee/value/relayer facts, never a guess.
 */
export async function fetchUsdgSettlements(source: IngestionSource) {
  if (source.protocol !== "usdg_settlement" || source.sourceKey !== "robinhood-usdg-settlements") {
    throw new RobinhoodRegistryValidationError("Source is not the approved Robinhood Chain USDG settlement ledger.");
  }
  if (source.state !== "active") throw new RobinhoodRegistryValidationError("Only active sources may be fetched.");
  if (source.rootUrl !== ROBINHOOD_RPC_URL || source.allowedHostname !== "rpc.mainnet.chain.robinhood.com") {
    throw new RobinhoodRegistryValidationError("Stored USDG source policy does not match the approved RPC endpoint.");
  }
  await assertPublicHostname(source.allowedHostname);

  let requestCount = 0;
  const countRpcAttempt = () => {
    requestCount += 1;
  };

  const chain = await callRobinhoodRpc({ method: "eth_chainId", params: [] }, countRpcAttempt);
  if (chain.error || chain.result !== ROBINHOOD_CHAIN_ID_HEX) {
    throw new RobinhoodRegistryValidationError("Robinhood Chain RPC did not confirm the approved chain id 4663.");
  }

  const headResponse = await callRobinhoodRpc({ method: "eth_blockNumber", params: [] }, countRpcAttempt);
  const headBlock = typeof headResponse.result === "string" ? Number.parseInt(headResponse.result.slice(2), 16) : Number.NaN;
  if (!Number.isSafeInteger(headBlock)) throw new RobinhoodRegistryValidationError("Robinhood Chain RPC did not return a valid head block.");

  // The ledger's value column assumes 6 decimals; a contract change must fail
  // the run closed rather than store mis-scaled amounts.
  const decimals = await callRobinhoodRpc(
    { method: "eth_call", params: [{ to: USDG_CONTRACT_ADDRESS, data: USDG_DECIMALS_CALL }, "latest"] },
    countRpcAttempt
  );
  if (decimals.error || decimals.result !== USDG_EXPECTED_DECIMALS_HEX) {
    throw new RobinhoodRegistryValidationError("The USDG contract did not report the expected 6 decimals; refusing to store mis-scaled amounts.");
  }

  const cursor = parseUsdgSettlementCursor(source.cursor);
  if (cursor.mode === "done") {
    throw new RobinhoodRegistryValidationError("The USDG settlement walk already reached genesis; no older window remains.");
  }
  // Seed exactly at the finality margin so the walk tiles the newest era
  // first — the dense x402 settlement era is the measurement that matters;
  // resume from the persisted position otherwise.
  const toBlock = cursor.mode === "seed" ? headBlock - USDG_FINALITY_MARGIN_BLOCKS : cursor.toBlock;
  const fromBlock = Math.max(1, toBlock - USDG_SCAN_WINDOW_BLOCKS);

  const fetchAuthorizationLogs = async (scanFrom: number, scanTo: number) => {
    const logsResponse = await callRobinhoodRpc(
      {
        method: "eth_getLogs",
        params: [
          {
            address: USDG_CONTRACT_ADDRESS,
            fromBlock: `0x${scanFrom.toString(16)}`,
            toBlock: `0x${scanTo.toString(16)}`,
            topics: [USDG_AUTHORIZATION_USED_TOPIC],
          },
        ],
      },
      countRpcAttempt
    );
    if (logsResponse.error) {
      // The public node enforces its own window caps (block range per filter
      // shape, result counts) as JSON-RPC errors. The walk treats those
      // exactly like the 4 MiB transport cap: a narrowable window, never a
      // hard walk failure.
      const detail = typeof logsResponse.error.message === "string" ? ` ${logsResponse.error.message}` : "";
      throw new RobinhoodRegistryResponseTooLargeError(`Robinhood Chain RPC rejected the bounded settlement window.${detail}`);
    }
    return logsResponse.result;
  };

  // Narrow the window to its newest fetchable half whenever any limit trips —
  // the 4 MiB transport cap, the node's own range/result caps, or the
  // settlement budget that keeps one run's receipt decode bounded. The
  // cursor resumes just below the scanned sub-window, so a dense era tiles
  // over a few runs without skipping a single block.
  let scannedFrom = fromBlock;
  let scannedTo = toBlock;
  let authLogs: unknown;
  for (let splits = 0; ; splits += 1) {
    if (splits > MAX_WINDOW_SPLITS) {
      throw new RobinhoodRegistryValidationError(
        `The USDG settlement walk could not narrow block window ${fromBlock}-${toBlock} to a fetchable sub-window within ${MAX_WINDOW_SPLITS} splits.`
      );
    }
    // Log-scan pacing: the dense-era narrowing burst fired its getLogs calls
    // back-to-back and drew sustained edge 403s (2026-10-10); every scan after
    // the first now waits the measured-safe interval, exactly like the receipt
    // reads below.
    if (splits > 0) await new Promise(resolve => setTimeout(resolve, USDG_LOG_PACING_MS));
    try {
      authLogs = await fetchAuthorizationLogs(scannedFrom, scannedTo);
    } catch (error) {
      if (!(error instanceof RobinhoodRegistryResponseTooLargeError)) throw error;
      if (scannedTo - scannedFrom < 1) {
        throw new RobinhoodRegistryValidationError(
          `Robinhood Chain block ${scannedTo} alone cannot be fetched within the RPC's response limits; the public RPC cannot serve this settlement window.`
        );
      }
      scannedFrom = splitBackfillWindow(scannedFrom, scannedTo).fromBlock;
      continue;
    }
    if (Array.isArray(authLogs) && authLogs.length > USDG_MAX_SETTLEMENTS_PER_WINDOW && scannedTo - scannedFrom >= 1) {
      scannedFrom = splitBackfillWindow(scannedFrom, scannedTo).fromBlock;
      continue;
    }
    break;
  }
  if (!Array.isArray(authLogs)) {
    throw new RobinhoodRegistryValidationError("Robinhood Chain RPC settlement response was not a log array.");
  }
  if (authLogs.length > USDG_MAX_SETTLEMENTS_PER_WINDOW) {
    // A single block denser than the budget: the public-RPC walk refuses the
    // pathological burst rather than run an unbounded receipt decode.
    throw new RobinhoodRegistryValidationError(
      `USDG settlement response exceeds the approved bounded scan of ${USDG_MAX_SETTLEMENTS_PER_WINDOW} settlements.`
    );
  }

  const settlements: UsdgSettlementEvent[] = [];
  let rejectedCount = 0;
  for (let index = 0; index < authLogs.length; index += 1) {
    // Receipt pacing measured live: 700 ms between reads ran clean while
    // rapid bursts drew HTTP 429 from the edge.
    if (index > 0) await new Promise(resolve => setTimeout(resolve, USDG_RECEIPT_PACING_MS));
    const log = authLogs[index];
    const hash = (log as Record<string, unknown> | null)?.transactionHash;
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      rejectedCount += 1;
      continue;
    }
    const receiptResponse = await callRobinhoodRpc({ method: "eth_getTransactionReceipt", params: [hash] }, countRpcAttempt);
    if (receiptResponse.error || !receiptResponse.result || typeof receiptResponse.result !== "object") {
      // A receipt that cannot be read is an honest counted gap, never a guess.
      rejectedCount += 1;
      continue;
    }
    const settlement = decodeUsdgSettlement(log, receiptResponse.result, { fromBlock: scannedFrom, toBlock: scannedTo });
    if (settlement) settlements.push(settlement);
    else rejectedCount += 1;
  }

  return {
    settlements,
    rejectedCount,
    requestCount,
    walkCursor: usdgSettlementCursorAfter(scannedFrom),
  };
}
