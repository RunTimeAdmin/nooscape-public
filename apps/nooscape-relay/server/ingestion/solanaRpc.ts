/**
 * Shared Solana JSON-RPC client for on-chain registry sources. One endpoint,
 * one bounded retry ladder, one response contract — every future Solana
 * adapter (metaplexChain, the 8004-solana registry, SAID) reads through here
 * so provider policy and pacing live in exactly one place.
 *
 * Provider: ENV.solanaRpcUrl defaults to the public mainnet endpoint, which
 * served every call shape in SOLANA_INGEST_SPEC.md §7 but is documented as
 * "not intended for production" and rate-limits per IP (~100 req/10 s). The
 * operator points the variable at a keyed provider (Helius/QuickNode) for
 * scheduled runs; the URL carries the provider key, so it lives only in the
 * environment — never in the database, never in a source row.
 */
import { ENV } from "../_core/env";

export class SolanaRpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaRpcValidationError";
  }
}

/** HTTP-level failure from the RPC edge; carries the status for transient classification. */
export class SolanaRpcHttpError extends SolanaRpcValidationError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SolanaRpcHttpError";
    this.status = status;
  }
}

/** Response above the transport cap — the run fails instead of trusting a truncated read. */
export class SolanaRpcResponseTooLargeError extends SolanaRpcValidationError {
  constructor(message: string) {
    super(message);
    this.name = "SolanaRpcResponseTooLargeError";
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
/** The largest planned single response is the SAID-scale gPA (~9 MiB measured); 16 MiB is headroom. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/**
 * Edge statuses observed to clear on their own after a backoff (the public
 * endpoint throttles bursts with 429 and intermittently serves 403/5xx).
 * Unlike the manual-only Robinhood ladder, this one stays short because it
 * runs from the scheduled worker: ~12 s of waiting total, then the run fails
 * and nextRunAt advances — a scheduled source must never park the tick.
 */
const TRANSIENT_RPC_HTTP_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
const RPC_RETRY_BACKOFF_MS = [1_000, 3_000, 8_000];

/**
 * Inter-call pacing for multi-call passes. The spec's live probing ran ~150
 * calls at >=1.2 s spacing against the public endpoint without a single 429;
 * scheduled passes keep the same cadence regardless of provider.
 */
export const SOLANA_RPC_PACING_MS = 1_200;

export type SolanaJsonRpcResponse = {
  result?: unknown;
  error?: { code?: number; message?: string } | null;
};

/**
 * The newest transaction version the passes ask for. Solana mainnet carries version 1 transactions (about one in six in a block
 * sampled on 2026-10-16), and a getTransaction that names an older maximum is answered with error -32015 for any of them, which
 * failed the whole pass. Version 1 transactions return the same `meta.logMessages` the attribution walks read.
 */
export const SOLANA_MAX_TRANSACTION_VERSION = 1;
/** The JSON-RPC error code for a transaction whose version is newer than the request allows. */
export const SOLANA_UNSUPPORTED_TRANSACTION_VERSION_CODE = -32015;

/** The getTransaction params the attribution walks send for one signature. */
export const getTransactionParams = (signature: string): unknown[] => [signature, { encoding: "json", maxSupportedTransactionVersion: SOLANA_MAX_TRANSACTION_VERSION }];

/**
 * A getTransaction answer as the attribution walks read it: the transaction, or null for one this client cannot read, which the
 * walks already skip the way they skip a pruned one. That includes a version newer than the one asked for, so the next new
 * transaction format costs an attribution and not the pass. Any other RPC error still fails loudly.
 */
export function parseTransactionResult(response: SolanaJsonRpcResponse): unknown {
  if (response && typeof response === "object" && response.error?.code === SOLANA_UNSUPPORTED_TRANSACTION_VERSION_CODE) return null;
  return parseSolanaRpcResult(response, "getTransaction");
}

export function sleepSolana(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * One paced JSON-RPC call with the bounded transient retry ladder. Every wire
 * attempt is reported back so the run's request count stays honest. `rpcUrl`
 * is injectable for tests; production always resolves ENV.solanaRpcUrl.
 */
export async function callSolanaRpc(
  method: string,
  params: unknown[],
  options: { countAttempt?: () => void; rpcUrl?: string } = {}
): Promise<SolanaJsonRpcResponse> {
  const rpcUrl = options.rpcUrl ?? ENV.solanaRpcUrl;
  for (let attempt = 0; ; attempt += 1) {
    options.countAttempt?.();
    try {
      return await callSolanaRpcOnce(rpcUrl, method, params);
    } catch (error) {
      if (
        attempt >= RPC_RETRY_BACKOFF_MS.length ||
        !(error instanceof SolanaRpcHttpError) ||
        !TRANSIENT_RPC_HTTP_STATUSES.has(error.status)
      ) {
        throw error;
      }
      await sleepSolana(RPC_RETRY_BACKOFF_MS[attempt]);
    }
  }
}

/**
 * Validates the JSON-RPC envelope and unwraps `result`. An RPC-level error
 * (method not allowed, invalid params, provider quota text) is a loud
 * validation failure — never an empty success.
 */
export function parseSolanaRpcResult(response: SolanaJsonRpcResponse, label: string): unknown {
  if (!response || typeof response !== "object") {
    throw new SolanaRpcValidationError(`Solana ${label} response is not a JSON-RPC object.`);
  }
  if (response.error) {
    const message = typeof response.error.message === "string" ? response.error.message : "unknown RPC error";
    throw new SolanaRpcValidationError(`Solana ${label} failed at the RPC layer: ${message}`);
  }
  if (!("result" in response)) {
    throw new SolanaRpcValidationError(`Solana ${label} response carries no result.`);
  }
  return response.result;
}

async function callSolanaRpcOnce(rpcUrl: string, method: string, params: unknown[]): Promise<SolanaJsonRpcResponse> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      redirect: "error",
      signal: timeout.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Nooscape-Source-Indexer/0.3 (+https://nooscape.si)",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new SolanaRpcHttpError(response.status, `Solana ${method} returned HTTP ${response.status}.`);
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new SolanaRpcValidationError(`Solana ${method} did not declare a JSON response.`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new SolanaRpcResponseTooLargeError(`Solana ${method} response exceeds the 16 MiB response limit.`);
    }
    // The body read stays under the armed timer: a stalled body aborts exactly
    // like the header phase.
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new SolanaRpcResponseTooLargeError(`Solana ${method} response exceeds the 16 MiB response limit.`);
    }
    try {
      return JSON.parse(text) as SolanaJsonRpcResponse;
    } catch {
      throw new SolanaRpcValidationError(`Solana ${method} response was not valid JSON.`);
    }
  } catch (error) {
    // All three domain errors extend SolanaRpcValidationError; one instanceof
    // pass preserves the specific verdict.
    if (error instanceof SolanaRpcValidationError) throw error;
    if (timeout.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw new SolanaRpcValidationError(`Solana ${method} request timed out.`);
    }
    throw new SolanaRpcValidationError(`Solana ${method} request failed without following redirects.`);
  } finally {
    clearTimeout(timer);
  }
}
