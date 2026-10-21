import { createHash } from "node:crypto";
import { usdOf } from "@shared/usdc";
import { readArcRpc } from "./arcRpc";
import { isEvmAddress } from "./claimsCrypto";
import { bazaarFor } from "./x402Bazaar";
import { signerOfTransferAuthorization } from "./x402Crypto";

/**
 * Pay per call over x402 (v2, https://x402.org): the protocol parts of stage D4 (docs/data-access-2026-10-19.md). A caller with no
 * key asks, is told the price in a 402 with terms, signs a USDC `TransferWithAuthorization` to our receiving address, sends it in a
 * PAYMENT-SIGNATURE header, and gets the answer with a PAYMENT-RESPONSE header naming the settlement. Circle's Facilitator Service
 * settles it: it checks the authorization, submits the transfer and pays the gas. No key that can move funds is on this server, and
 * Nooscape never holds a caller's funds: the transfer is from the caller's wallet to ours.
 *
 * This file is the protocol and nothing that touches a database: the settings, the terms, reading and checking a payment, and the
 * one call to the facilitator with every answer sorted by what it proves about the money. server/x402Service.ts decides what to do
 * with a payment, and server/apiPayments.ts keeps the record of it.
 *
 * Settings come from the environment and the feature is off unless they are all there and right. A setting that is half there or
 * unsafe throws, and the caller keeps the feature off: a mistake never turns payments on.
 */

export { usdOf };

export const ARC_MAINNET = "eip155:5042";
export const ARC_TESTNET = "eip155:5042002";
/** Arc's USDC on mainnet and testnet: EIP-712 name "USDC", version "2", six decimals. */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
/**
 * Circle's two facilitator endpoints. The production host serves Arc mainnet and Arc testnet both (its public /supported lists the exact
 * scheme on eip155:5042 and eip155:5042002), and it is where a testnet key is used. The sandbox host answered every request with a server
 * error when it was probed on 19 Oct 2026, so it is never the default; it stays allowed for the operator to choose.
 */
export const CIRCLE_FACILITATORS = {
  production: "https://api.circle.com/v1/facilitator/x402",
  sandbox: "https://api-sandbox.circle.com/v1/facilitator/x402",
} as const;

/** What can be bought: one agent's lookup (past the free limit) and the pre-flight check. */
export type X402Endpoint = "agent" | "check";
export const X402_ENDPOINTS: readonly X402Endpoint[] = ["agent", "check"];

export const DESCRIPTIONS: Record<X402Endpoint, string> = {
  agent: "Nooscape agent lookup: one listed agent with its dated facts",
  check: "Nooscape pre-flight check: dated facts about an agent, a wallet or an endpoint host",
};

/** What we ask the caller's authorization to stay valid for, and how long a new one may run. */
export const MAX_TIMEOUT_SECONDS = 120;
const MIN_REMAINING_SECONDS = 15;
const MAX_VALIDITY_SECONDS = 600;
const MAX_HEADER_BYTES = 16_384;
/** The most one call may cost: one USDC, in base units. A price above it is a mistake in a setting. */
const MAX_PRICE = 1_000_000;
export const DEFAULT_PRICES: Record<X402Endpoint, string> = { agent: "5000", check: "10000" };

export type X402Config = {
  network: typeof ARC_MAINNET | typeof ARC_TESTNET;
  chainId: number;
  /** Where the money goes, lower case. Set by the operator in the host's environment and never in code. */
  payTo: string;
  /** USDC base units (six decimals): "5000" is $0.005. */
  prices: Record<X402Endpoint, string>;
  facilitator: string;
  apiKey: string;
  /** The origin the 402 names a resource under. */
  resourceBase: string;
  /** New payments are not taken or offered; one already recorded is still resolved and re-served. */
  pauseNew: boolean;
  /** A node to ask whether a smart-contract wallet signed a payment (ERC-1271). Null: those wallets are not accepted. Never put in an error or a log: it may carry a key. */
  rpc: string | null;
};

/** The settings from the environment, or null when X402_NETWORK is unset (the feature is off). Throws on a half-set or unsafe setting. */
export function loadX402(env: NodeJS.ProcessEnv = process.env): X402Config | null {
  const network = (env.X402_NETWORK ?? "").trim();
  if (!network) return null;
  if (network !== ARC_MAINNET && network !== ARC_TESTNET) throw new Error(`X402_NETWORK must be ${ARC_MAINNET} (Arc mainnet) or ${ARC_TESTNET} (Arc testnet)`);
  const mainnet = network === ARC_MAINNET;
  const payTo = (env.X402_PAY_TO ?? "").trim();
  if (!isEvmAddress(payTo) || /^0x0{40}$/i.test(payTo)) throw new Error("X402_PAY_TO must be the receiving address");
  const apiKey = (env.X402_API_KEY ?? "").trim();
  const key = /^(TEST|LIVE)_API_KEY:[A-Za-z0-9]{16,64}:[A-Za-z0-9]{16,64}$/.exec(apiKey);
  if (!key) throw new Error("X402_API_KEY must be a Circle API key (TEST_API_KEY:... or LIVE_API_KEY:...)");
  if ((key[1] === "LIVE") !== mainnet) throw new Error(`X402_API_KEY: ${mainnet ? "mainnet needs a LIVE_API_KEY" : "testnet needs a TEST_API_KEY"}`);
  const prices = { ...DEFAULT_PRICES };
  for (const [endpoint, name] of [["agent", "X402_PRICE_LOOKUP"], ["check", "X402_PRICE_CHECK"]] as const) {
    const given = (env[name] ?? "").trim();
    if (!given) continue;
    if (!/^[1-9]\d{0,6}$/.test(given) || Number(given) > MAX_PRICE) throw new Error(`${name} must be a whole number of USDC base units, at most ${MAX_PRICE} (one USDC)`);
    prices[endpoint] = given;
  }
  const facilitator = (env.X402_FACILITATOR ?? "").trim() || CIRCLE_FACILITATORS.production;
  if (facilitator !== CIRCLE_FACILITATORS.production && facilitator !== CIRCLE_FACILITATORS.sandbox) {
    throw new Error("X402_FACILITATOR must be one of Circle's own facilitator endpoints");
  }
  const resourceBase = (env.X402_RESOURCE_BASE ?? "").trim().replace(/\/+$/, "") || "https://nooscape.si";
  if (!/^https:\/\/[^/\s]+$/.test(resourceBase)) throw new Error("X402_RESOURCE_BASE must be an https origin, such as https://nooscape.si");
  const pause = (env.X402_PAUSE_NEW ?? "").trim();
  // The same address is read by the Arc identity pass, so the rule for it lives in one place (server/arcRpc.ts).
  const rpc = readArcRpc(env);
  if (rpc.state === "invalid") throw new Error("X402_RPC must be an https address");
  return { network, chainId: Number(network.split(":")[1]), payTo: payTo.toLowerCase(), prices, facilitator, apiKey, resourceBase, pauseNew: pause !== "" && pause !== "0", rpc: rpc.state === "set" ? rpc.url : null };
}

// ---------------------------------------------------------------- the terms

export type Requirements = {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod: string };
};

/** Our terms for one endpoint. Built here every time: a caller's copy is only ever compared with them. */
export function requirements(cfg: X402Config, endpoint: X402Endpoint): Requirements {
  return {
    scheme: "exact",
    network: cfg.network,
    amount: cfg.prices[endpoint],
    asset: ARC_USDC,
    payTo: cfg.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
  };
}

export const base64Json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

export type Reply = { status: number; headers: Record<string, string>; body: unknown };

/**
 * A 402 with the terms, in the header and the body, as x402 clients read it. `error` says why the caller is being asked, and
 * `extensions.bazaar` says how to call the route (server/x402Bazaar.ts).
 */
export function termsReply(cfg: X402Config, endpoint: X402Endpoint, resourceUrl: string, error: string): Reply {
  const required = { x402Version: 2, error, resource: { url: resourceUrl, description: DESCRIPTIONS[endpoint], mimeType: "application/json" }, accepts: [requirements(cfg, endpoint)], extensions: { bazaar: bazaarFor(endpoint, resourceUrl) } };
  return { status: 402, headers: { "payment-required": base64Json(required) }, body: required };
}

// ---------------------------------------------------------------- reading a payment

export type Authorization = { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
export type PaymentPayload = { x402Version: number; accepted: Requirements; payload: { signature: string; authorization: Authorization } };

/** Lower case for a string, and nothing for anything else: a header is a stranger's, so a value that is not a string must not be able to throw. */
const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");

/** The PAYMENT-SIGNATURE header's payload, or null when it is not one. */
export function decodePayment(header: string): PaymentPayload | null {
  if (typeof header !== "string" || header.length === 0 || header.length > MAX_HEADER_BYTES) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentPayload;
    const authorization = parsed?.payload?.authorization;
    const accepted = parsed?.accepted;
    const strings = [
      parsed?.payload?.signature,
      authorization?.from,
      authorization?.to,
      authorization?.value,
      authorization?.validAfter,
      authorization?.validBefore,
      authorization?.nonce,
      accepted?.scheme,
      accepted?.network,
      accepted?.amount,
      accepted?.asset,
      accepted?.payTo,
    ];
    return typeof accepted === "object" && accepted !== null && strings.every(item => typeof item === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/** Why this payment's terms cannot buy this endpoint, or null when they are exactly ours. */
export function paymentProblem(cfg: X402Config, endpoint: X402Endpoint, payment: PaymentPayload): string | null {
  const want = requirements(cfg, endpoint);
  const accepted = payment.accepted;
  if (payment.x402Version !== 2) return "x402Version must be 2";
  if (accepted.scheme !== want.scheme || accepted.network !== want.network || accepted.amount !== want.amount || lower(accepted.asset) !== lower(want.asset) || lower(accepted.payTo) !== lower(want.payTo)) {
    return "payment terms do not match this resource";
  }
  const authorization = payment.payload.authorization;
  if (lower(authorization.to) !== want.payTo || authorization.value !== want.amount) return "the authorization does not pay this resource";
  if (!isEvmAddress(authorization.from) || !/^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)) return "malformed authorization";
  if (!/^\d{1,12}$/.test(authorization.validAfter) || !/^\d{1,12}$/.test(authorization.validBefore)) return "malformed authorization";
  return null;
}

/** Why a new payment cannot start now, or null. A payment already recorded is resolved, not judged again. */
export function timeProblem(payment: PaymentPayload, nowSeconds: number): string | null {
  const after = Number(payment.payload.authorization.validAfter);
  const before = Number(payment.payload.authorization.validBefore);
  if (after > nowSeconds) return "the authorization is not valid yet";
  if (before < nowSeconds + MIN_REMAINING_SECONDS) return "the authorization expires too soon";
  if (before > nowSeconds + MAX_VALIDITY_SECONDS) return `the authorization may run at most ${MAX_VALIDITY_SECONDS} seconds`;
  return null;
}

const ERC_6492_SUFFIX = "6492649264926492649264926492649264926492649264926492649264926492";

/**
 * Whether a signature that is not a regular wallet's key's could be a smart-contract wallet's: well-formed hex, not too long, and not the
 * wrapped form of a wallet that is not deployed yet (that one stays refused). The chain decides whether it is.
 */
export function contractCandidate(payment: PaymentPayload): boolean {
  const signature = payment.payload.signature;
  return /^0x(?:[0-9a-fA-F]{2})+$/.test(signature) && signature.length <= 2 + 2 * 2048 && !signature.toLowerCase().endsWith(ERC_6492_SUFFIX);
}

/** Why the signature is not the payer's own, or null when a regular wallet's key signed exactly this transfer. */
export function signatureProblem(cfg: X402Config, payment: PaymentPayload): string | null {
  const signature = payment.payload.signature;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(signature) || signature.length > 2 + 2 * 2048) return "malformed signature (hex)";
  if (signature.toLowerCase().endsWith(ERC_6492_SUFFIX)) return "the wallet is not deployed yet (an ERC-6492 signature): use a regular wallet";
  if (signature.length !== 132) return "payments from smart-contract wallets are not accepted yet: sign with a regular wallet's key";
  // The token contract takes only 27 or 28 as the recovery byte. Another form recovers here and is refused there, after a record and a call.
  if (!/^(1b|1c)$/i.test(signature.slice(130))) return "the last byte of the signature (v) must be 27 or 28";
  const signer = signerOfTransferAuthorization(cfg.chainId, ARC_USDC, payment.payload.authorization, signature);
  if (signer === null) return "the signature is not a valid one for this payment";
  if (signer !== lower(payment.payload.authorization.from)) return "the signature is not the payer's";
  return null;
}

/**
 * The facilitator's idempotency key: the whole signed authorization, its signature, and what was bought. A retry of the same
 * request settles once. The same authorization sent for another request is another purchase, and its nonce is already spent.
 */
export function paymentIdOf(cfg: X402Config, payment: PaymentPayload, subjectHash: string): string {
  const z = payment.payload.authorization;
  const signed = [z.from, z.to, z.value, z.validAfter, z.validBefore, z.nonce, payment.payload.signature].map(lower).join("|");
  return `nsc_${createHash("sha256").update(`${cfg.network}|${signed}|${subjectHash}`).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------- the facilitator

/** The /settle body for one payment. Only the signed authorization and its signature are taken from the caller; the rest is ours. */
export function settleBody(cfg: X402Config, endpoint: X402Endpoint, resourceUrl: string, payment: PaymentPayload, paymentId: string): string {
  const want = requirements(cfg, endpoint);
  const { signature, authorization: z } = payment.payload;
  return JSON.stringify({
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: { url: resourceUrl, description: DESCRIPTIONS[endpoint], mimeType: "application/json" },
      accepted: want,
      payload: { signature, authorization: { from: z.from, to: z.to, value: z.value, validAfter: z.validAfter, validBefore: z.validBefore, nonce: z.nonce } },
      extensions: { "payment-identifier": { info: { required: true, id: paymentId } } },
    },
    paymentRequirements: want,
  });
}

/**
 * The facilitator's answer sorted by what it proves about the money:
 * - paid: it settled and named the transaction. Only this delivers.
 * - refused: no transfer happened, so the caller may pay again.
 * - unavailable: our key or our address was refused, not the payment. Nothing was charged, and it is our problem.
 * - open: it may still settle. Never deliver on it and never charge again; the same signature is sent again until it resolves.
 */
export type Settled =
  | { kind: "paid"; transaction: string }
  | { kind: "refused"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "open"; reason: string; pending?: boolean; noAnswer?: boolean; transaction?: string };

/** Circle's settle error reasons that mean the transfer was refused before it happened. Any other may hide a transfer. */
const NO_TRANSFER = new Set([
  "invalid_payload",
  "invalid_exact_evm_payload_recipient_mismatch",
  "invalid_exact_evm_payload_authorization_value_mismatch",
  "invalid_exact_evm_payload_authorization_valid_after",
  "invalid_exact_evm_payload_authorization_valid_before",
  "invalid_exact_evm_payload_signature",
  "insufficient_funds",
]);

const TRANSACTION = /^0x[0-9a-fA-F]{64}$/;
const SETTLE_TIMEOUT_MS = 15_000;

/** One /settle call. It never throws: a failure to reach the facilitator is an answer of its own. */
export async function settleOnce(cfg: X402Config, body: string, payer: string, fetchImpl: typeof fetch = fetch, timeoutMs = SETTLE_TIMEOUT_MS): Promise<Settled> {
  let response: Response;
  try {
    response = await fetchImpl(`${cfg.facilitator}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1_000, timeoutMs)),
    });
  } catch {
    return { kind: "open", reason: "no answer from the payment service", noAnswer: true };
  }
  let answer: Record<string, unknown> | null = null;
  try {
    const parsed = (await response.json()) as unknown;
    answer = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    // not JSON
  }
  const transaction = typeof answer?.transaction === "string" && TRANSACTION.test(answer.transaction) ? answer.transaction : null;
  const named = transaction ? { transaction } : {};
  if (!response.ok) {
    const reason = String((answer?.errors as Array<{ reason?: string }> | undefined)?.[0]?.reason ?? answer?.message ?? `HTTP ${response.status}`).slice(0, 160);
    // Our credentials or our address refused (a key that is wrong, ended or not allowed from here): nothing about the payment.
    if (response.status === 401 || (response.status === 403 && reason === "forbidden")) return { kind: "unavailable", reason };
    // A request the facilitator rejected outright (a bad request, or screening of a party) moved nothing. A conflict, a limit or an
    // outage say nothing about a payment it may already be settling.
    const rejected = (response.status === 400 || response.status === 403) && reason !== "registration_required" && !transaction;
    return rejected ? { kind: "refused", reason } : { kind: "open", reason: `${reason} (HTTP ${response.status})`, ...named };
  }
  if (answer?.success === true) {
    const same = transaction !== null && answer.network === cfg.network && (answer.payer === undefined || lower(answer.payer) === payer);
    return same ? { kind: "paid", transaction } : { kind: "open", reason: `unexpected settlement response: ${JSON.stringify(answer).slice(0, 160)}`, ...named };
  }
  const reason = typeof answer?.errorReason === "string" ? answer.errorReason.slice(0, 160) : "unreadable settlement response";
  if (reason === "settlement_pending") return { kind: "open", reason, pending: true, ...named };
  return NO_TRANSFER.has(reason) && !transaction ? { kind: "refused", reason } : { kind: "open", reason, ...named };
}
