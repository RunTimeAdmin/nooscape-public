import { createHash } from "node:crypto";
import { usdOf } from "@shared/usdc";
import { readArcRpc } from "./arcRpc";
import { isEvmAddress, toChecksumAddress } from "./claimsCrypto";
import { bazaarFor } from "./x402Bazaar";
import { cdpBearer, CDP_FACILITATOR_URL, CDP_X402_PATH, loadCdpKey, type CdpKey } from "./x402Cdp";
import { signerOfTransferAuthorization, type UsdcDomain } from "./x402Crypto";

/**
 * Pay per call over x402 (v2, https://x402.org): the protocol parts of stage D4 (docs/data-access-2026-10-19.md). A caller with no
 * key asks, is told the price in a 402 with terms, signs a USDC `TransferWithAuthorization` to our receiving address, sends it in a
 * PAYMENT-SIGNATURE header, and gets the answer with a PAYMENT-RESPONSE header naming the settlement. A facilitator settles it: it
 * checks the authorization, submits the transfer and pays the gas. No key that can move funds is on this server, and Nooscape never
 * holds a caller's funds: the transfer is from the caller's wallet to ours.
 *
 * Two networks take payment, each with its own facilitator (docs/x402-base-bazaar-2026-10-21.md). Arc is settled by Circle's
 * Facilitator Service. Base is settled by Coinbase's CDP facilitator, which is also what catalogues the endpoint in the Bazaar, and is
 * offered only when its key is set. Both pay the same address, at the same price.
 *
 * This file is the protocol and nothing that touches a database: the settings, the terms, reading and checking a payment, and the
 * one call to the facilitator with every answer sorted by what it proves about the money. server/x402Service.ts decides what to do
 * with a payment, and server/apiPayments.ts keeps the record of it.
 *
 * Settings come from the environment and the feature is off unless they are all there and right. A setting for Arc that is half there
 * or unsafe throws, and the caller keeps the feature off: a mistake never turns payments on. A setting for Base that is half there or
 * unsafe keeps Base off and says why, and never turns Arc off.
 */

export { usdOf };

export const ARC_MAINNET = "eip155:5042";
export const ARC_TESTNET = "eip155:5042002";
/** Arc's USDC on mainnet and testnet: EIP-712 name "USDC", version "2", six decimals. */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
export const BASE_MAINNET = "eip155:8453";
/** Base's USDC: EIP-712 name "USD Coin", version "2" (checked against the contract's DOMAIN_SEPARATOR), six decimals. */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
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

/**
 * What a route says about itself in a 402 and to the Bazaar, whose search reads it (the words of a query are matched against it). Three
 * limits hold it: Coinbase refuses a settle whose description is over 500 characters; the Bazaar drops a listing whose text could be read
 * as an instruction to an agent, so it describes the route and never addresses the caller; and it travels in the PAYMENT-REQUIRED header at
 * four bytes for every three characters, on a response block that was 3.7 KB at the edge when Base was added (x402Base.test.ts holds it).
 */
export const DESCRIPTIONS: Record<X402Endpoint, string> = {
  agent: "Nooscape agent lookup: one listed agent with its dated facts",
  check:
    "Nooscape pre-flight check on an AI agent in an on-chain registry (ERC-8004, Solana), a wallet that registers agents, or an endpoint host: dated flags for first seen, ownership changes, revoked ratings and fleet, with sources. No score, no verdict.",
};

/**
 * What the Bazaar lists a service under besides its description: a name and up to five tags, each at most 32 printable ASCII characters (the
 * reference package drops one that is not, without a word). The Bazaar reads them from the `resource` of the settlement, so they are sent to
 * Coinbase there and are not in the 402, whose header has no room for them. They name what the service is and promise nothing about an answer.
 */
export const SERVICE_NAME = "Nooscape";
export const SERVICE_TAGS = ["agents", "erc-8004", "registry", "pre-flight", "due-diligence"];

/** What we ask the caller's authorization to stay valid for, and how long a new one may run. */
const MAX_TIMEOUT_SECONDS = 120;
const MIN_REMAINING_SECONDS = 15;
const MAX_VALIDITY_SECONDS = 600;
const MAX_HEADER_BYTES = 16_384;
/** The most one call may cost: one USDC, in base units. A price above it is a mistake in a setting. */
const MAX_PRICE = 1_000_000;
const DEFAULT_PRICES: Record<X402Endpoint, string> = { agent: "5000", check: "10000" };

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
  /** The CDP key that settles Base payments (CDP_API_KEY_ID and CDP_API_KEY_SECRET). Null: Base is not offered. Never put in an error or a log. */
  cdp: CdpKey | null;
  /** Why Base is not offered although its settings are there (half set, or unsafe), in words that never contain the secret. Null when Base is on or not asked for. */
  baseProblem: string | null;
  /**
   * A Base node (BASE_RPC_URL, which the Base identity pass reads too), asked how much USDC a payer holds before a payment on Base is sent to
   * Coinbase. Null: not asked. Unset, or not an https address, it is null and never stops payments from starting. Never put in an error or a log: it may carry a key.
   */
  baseRpc: string | null;
};

/**
 * The settings from the environment, or null when X402_NETWORK is unset (the feature is off). Throws on a half-set or unsafe setting
 * for Arc. Base, which needs both CDP settings and Arc mainnet, is on or off by itself: its problem is returned, never thrown.
 */
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
  const cdpId = (env.CDP_API_KEY_ID ?? "").trim();
  const cdpSecret = (env.CDP_API_KEY_SECRET ?? "").trim();
  let cdp: CdpKey | null = null;
  let baseProblem: string | null = null;
  if (cdpId !== "" || cdpSecret !== "") {
    try {
      if (cdpId === "" || cdpSecret === "") throw new Error("CDP_API_KEY_ID and CDP_API_KEY_SECRET must both be set");
      if (!mainnet) throw new Error("Base is offered only with Arc mainnet");
      cdp = loadCdpKey(cdpId, cdpSecret);
    } catch (error) {
      baseProblem = error instanceof Error ? error.message : "the CDP key could not be read";
    }
  }
  return {
    network,
    chainId: Number(network.split(":")[1]),
    payTo: payTo.toLowerCase(),
    prices,
    facilitator,
    apiKey,
    resourceBase,
    pauseNew: pause !== "" && pause !== "0",
    rpc: rpc.state === "set" ? rpc.url : null,
    cdp,
    baseProblem,
    baseRpc: httpsAddress(env.BASE_RPC_URL),
  };
}

/** An https address from a setting, or null when it is unset or is not one. A mistake in an optional node must not stop payments from starting. */
function httpsAddress(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  try {
    return new URL(text).protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the networks

export type Facilitator = "circle" | "cdp";

/** One network that takes payment: where, in what, to whom, and who settles it. */
export type Rail = {
  network: string;
  chainId: number;
  /** The USDC contract. */
  asset: string;
  /** What the contract signs under, and what the terms tell a buyer to sign. */
  domain: UsdcDomain;
  payTo: string;
  facilitator: Facilitator;
  /** The names a settlement answer may give this network: its CAIP-2 id, and for Base the older name Coinbase's examples still show. */
  names: readonly string[];
};

export function arcRail(cfg: X402Config): Rail {
  return { network: cfg.network, chainId: cfg.chainId, asset: ARC_USDC, domain: { name: "USDC", version: "2" }, payTo: cfg.payTo, facilitator: "circle", names: [cfg.network] };
}

/** Base, when its CDP key is set. Its address is the same as Arc's, spelled the way the CDP facilitator documents it (EIP-55). */
export function baseRail(cfg: X402Config): Rail | null {
  if (!cfg.cdp) return null;
  return { network: BASE_MAINNET, chainId: 8453, asset: BASE_USDC, domain: { name: "USD Coin", version: "2" }, payTo: toChecksumAddress(cfg.payTo), facilitator: "cdp", names: [BASE_MAINNET, "base"] };
}

/**
 * The networks in the order a 402 offers them. Base is first: most buyers hold Base USDC, a client that takes the first terms it can sign
 * pays there, and Coinbase's validator reads the first terms when it checks an endpoint for the Bazaar.
 */
export function railsOf(cfg: X402Config): Rail[] {
  const base = baseRail(cfg);
  return base ? [base, arcRail(cfg)] : [arcRail(cfg)];
}

/** The network a payment names, if it is one we take. */
export function railFor(cfg: X402Config, network: string): Rail | null {
  return railsOf(cfg).find(rail => rail.network === network) ?? null;
}

/**
 * Every network the ledger can hold a payment for, offered or not. A payment recorded on Base is still counted, listed and looked at when Base
 * is switched off, because it may have settled.
 */
export function ledgerNetworks(cfg: X402Config): string[] {
  return Array.from(new Set([cfg.network, BASE_MAINNET]));
}

// ---------------------------------------------------------------- the terms

type Requirements = {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod: string };
};

/** Our terms for one endpoint on one network (Arc unless a rail is given). Built here every time: a caller's copy is only ever compared with them. */
export function requirements(cfg: X402Config, endpoint: X402Endpoint, rail: Rail = arcRail(cfg)): Requirements {
  return {
    scheme: "exact",
    network: rail.network,
    amount: cfg.prices[endpoint],
    asset: rail.asset,
    payTo: rail.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: rail.domain.name, version: rail.domain.version, assetTransferMethod: "eip3009" },
  };
}

export const base64Json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

export type Reply = { status: number; headers: Record<string, string>; body: unknown };

/**
 * A 402 with the terms, in the header and the body, as x402 clients read it: one set of terms for each network we take, in the order of
 * railsOf. `error` says why the caller is being asked, and `extensions.bazaar` says how to call the route (server/x402Bazaar.ts).
 */
export function termsReply(cfg: X402Config, endpoint: X402Endpoint, resourceUrl: string, error: string): Reply {
  const required = {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: DESCRIPTIONS[endpoint], mimeType: "application/json" },
    accepts: railsOf(cfg).map(rail => requirements(cfg, endpoint, rail)),
    extensions: { bazaar: bazaarFor(endpoint, resourceUrl) },
  };
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

/** What a caller with a payment on Base is told while Base is not offered (its key is not set, or it was switched off). */
const BASE_NOT_TAKEN = "Base is not being taken right now: pay on Arc. If you signed a payment on Base earlier and were charged, contact the operator and quote the payment id you were given";

/** Why this payment's terms cannot buy this endpoint, or null when they are exactly ours. */
export function paymentProblem(cfg: X402Config, endpoint: X402Endpoint, payment: PaymentPayload): string | null {
  const accepted = payment.accepted;
  if (payment.x402Version !== 2) return "x402Version must be 2";
  // The network the payment names picks the terms it is held to: one we do not take has none.
  const rail = railFor(cfg, accepted.network);
  const want = rail ? requirements(cfg, endpoint, rail) : null;
  if (!rail && accepted.network === BASE_MAINNET) return BASE_NOT_TAKEN;
  if (!want || accepted.scheme !== want.scheme || accepted.amount !== want.amount || lower(accepted.asset) !== lower(want.asset) || lower(accepted.payTo) !== lower(want.payTo)) {
    return "payment terms do not match this resource";
  }
  const authorization = payment.payload.authorization;
  if (lower(authorization.to) !== lower(want.payTo) || authorization.value !== want.amount) return "the authorization does not pay this resource";
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
  // The network the payment names, as paymentProblem has already held it to. Terms for a network we do not take are checked as Arc's, as they always were.
  const rail = railFor(cfg, payment.accepted.network) ?? arcRail(cfg);
  const signature = payment.payload.signature;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(signature) || signature.length > 2 + 2 * 2048) return "malformed signature (hex)";
  if (signature.toLowerCase().endsWith(ERC_6492_SUFFIX)) return "the wallet is not deployed yet (an ERC-6492 signature): use a regular wallet";
  if (signature.length !== 132) return "payments from smart-contract wallets are not accepted yet: sign with a regular wallet's key";
  // The token contract takes only 27 or 28 as the recovery byte. Another form recovers here and is refused there, after a record and a call.
  if (!/^(1b|1c)$/i.test(signature.slice(130))) return "the last byte of the signature (v) must be 27 or 28";
  const signer = signerOfTransferAuthorization(rail.chainId, rail.asset, payment.payload.authorization, signature, rail.domain);
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
  // The network the payment is on. A payment on a network we do not take is held to Arc's, as it always was.
  const network = railFor(cfg, payment.accepted.network)?.network ?? cfg.network;
  return `nsc_${createHash("sha256").update(`${network}|${signed}|${subjectHash}`).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------- the facilitator

/**
 * The /settle body for one payment. Only the signed authorization and its signature are taken from the caller; the rest is ours.
 * Circle is given an idempotency key as an extension. Coinbase is given the Bazaar's: the metadata we declare for the route (built
 * here, never copied from the caller), which its catalogue picks up from the settlement that goes through.
 */
export function settleBody(cfg: X402Config, endpoint: X402Endpoint, resourceUrl: string, payment: PaymentPayload, paymentId: string): string {
  const rail = railFor(cfg, payment.accepted.network) ?? arcRail(cfg);
  const want = requirements(cfg, endpoint, rail);
  const { signature, authorization: z } = payment.payload;
  const extensions = rail.facilitator === "cdp" ? { bazaar: bazaarFor(endpoint, resourceUrl) } : { "payment-identifier": { info: { required: true, id: paymentId } } };
  // Only Coinbase catalogues the route, so only its body names the service; Circle's body is what it always was.
  const listing = rail.facilitator === "cdp" ? { serviceName: SERVICE_NAME, tags: SERVICE_TAGS } : {};
  return JSON.stringify({
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: { url: resourceUrl, description: DESCRIPTIONS[endpoint], mimeType: "application/json", ...listing },
      accepted: want,
      // The address a caller signed may be spelled in any case (the signature is the same); Coinbase is given ours, as it documents it.
      payload: { signature, authorization: { from: z.from, to: rail.facilitator === "cdp" ? want.payTo : z.to, value: z.value, validAfter: z.validAfter, validBefore: z.validBefore, nonce: z.nonce } },
      extensions,
    },
    paymentRequirements: want,
  });
}

/**
 * The facilitator's answer sorted by what it proves about the money:
 * - paid: it settled and named the transaction. Only this delivers. `bazaar` is what Coinbase said about cataloguing the endpoint, when it said.
 * - refused: no transfer happened, so the caller may pay again.
 * - unavailable: our key or our address was refused, not the payment. Nothing was charged, and it is our problem.
 * - open: it may still settle. Never deliver on it and never charge again; the same signature is sent again until it resolves.
 */
export type Settled =
  | { kind: "paid"; transaction: string; bazaar?: string }
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

/**
 * Coinbase's settle codes, as its troubleshooting reference lists the ones it returns in practice, by whose problem they are. Any other code, and
 * any code that comes with a transaction, may hide a transfer and is left open.
 * - The payer's: nothing moved, and another payment may be signed. `invalid_payload` is Coinbase's catch-all (a malformed payload, a spent
 *   authorization, a failed simulation) and is also how it refuses a replay of a payment that settled, so a refusal on a resend is never
 *   trusted: the service keeps that payment open. `kyt_risk_detected` is a screened payer or a screened receiving address, which cannot be told apart.
 * - Ours: nothing moved, but no payer can fix it, because our terms, our metadata, our request, our account or the place our server is were refused.
 */
const CDP_PAYER_REFUSALS = new Set([
  "insufficient_funds",
  "invalid_payload",
  "invalid_exact_evm_payload_signature",
  "invalid_exact_evm_payload_authorization_value",
  "invalid_exact_evm_payload_authorization_valid_before",
  "invalid_exact_evm_payload_authorization_valid_after",
  "invalid_exact_evm_payload_undeployed_smart_wallet",
  "self_send_not_allowed",
  "kyt_risk_detected",
  // The older names in its API reference.
  "invalid_exact_evm_payload_authorization_value_too_low",
  "invalid_exact_evm_payload_authorization_typed_data_message",
  "invalid_exact_evm_payload_authorization_from_address_kyt",
  "invalid_exact_evm_payload_signature_address",
]);
const CDP_OUR_PROBLEMS = new Set([
  "invalid_scheme",
  "invalid_network",
  "invalid_x402_version",
  "invalid_payment_requirements",
  "invalid_amount",
  "amount_too_low",
  "permit2_disabled",
  "preflight_validation_failed",
  "invalid_bazaar_extension",
  "unsupported_payload_type",
  "request_blocked_by_location",
  "invalid_exact_evm_payload_authorization_to_address_kyt",
]);

const TRANSACTION = /^0x[0-9a-fA-F]{64}$/;
const SETTLE_TIMEOUT_MS = 15_000;
/**
 * Coinbase's settlement window is not published. Its own answer for a settlement that has not confirmed (settlement_pending, with the
 * transaction) should arrive before ours gives up, or a settlement that was broadcast comes back to us as no answer at all, with no transaction
 * to look up. So the wait is long. The first live payments say how long it needs.
 */
const CDP_SETTLE_TIMEOUT_MS = 40_000;

/** Text from a facilitator, cut to a length and to printable characters, for a record or a log. */
const printable = (text: string, max = 160) =>
  Array.from(text)
    .filter(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) < 127)
    .join("")
    .slice(0, max);

/** What Coinbase said about cataloguing the endpoint: its EXTENSION-RESPONSES header, base64 JSON keyed by extension, then "success", "processing" or "rejected". */
function bazaarStatus(response: Response): string | undefined {
  const header = response.headers.get("extension-responses");
  if (!header || header.length > 4_096) return undefined;
  try {
    const bazaar = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { bazaar?: { status?: unknown; rejectedReason?: unknown } }).bazaar;
    if (typeof bazaar?.status !== "string") return undefined;
    return printable(typeof bazaar.rejectedReason === "string" ? `${bazaar.status}: ${bazaar.rejectedReason}` : bazaar.status);
  } catch {
    return undefined;
  }
}

/** Circle's answer to a /settle. */
function circleAnswer(response: Response, answer: Record<string, unknown> | null, rail: Rail, payer: string): Settled {
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
    const same = transaction !== null && answer.network === rail.network && (answer.payer === undefined || lower(answer.payer) === payer);
    return same ? { kind: "paid", transaction } : { kind: "open", reason: `unexpected settlement response: ${JSON.stringify(answer).slice(0, 160)}`, ...named };
  }
  const reason = typeof answer?.errorReason === "string" ? answer.errorReason.slice(0, 160) : "unreadable settlement response";
  if (reason === "settlement_pending") return { kind: "open", reason, pending: true, ...named };
  return NO_TRANSFER.has(reason) && !transaction ? { kind: "refused", reason } : { kind: "open", reason, ...named };
}

/**
 * Coinbase's answer to a /settle (docs/x402-base-bazaar-2026-10-21.md). A settlement that has not confirmed in its window comes back as an
 * HTTP 500 that names the transaction and the reason settlement_pending: it may still confirm, and is sent once more unchanged, as the docs say.
 * A code it gives is read whatever the status, by whose problem it is (CDP_PAYER_REFUSALS, CDP_OUR_PROBLEMS). An answer with no settlement code
 * is an error of the platform's own: a refused token, an account with no payment method once the free allowance is used (402), or a request it
 * rejected (400), and says nothing about the payment.
 */
function cdpAnswer(response: Response, answer: Record<string, unknown> | null, rail: Rail, payer: string): Settled {
  const transaction = typeof answer?.transaction === "string" && TRANSACTION.test(answer.transaction) ? answer.transaction : null;
  const named = transaction ? { transaction } : {};
  // The code, under whichever name it comes: errorReason on a settlement, errorType on an error of the platform's own.
  const coded = typeof answer?.errorReason === "string";
  const code = [answer?.errorReason, answer?.errorType].find((item): item is string => typeof item === "string");
  const reason = code === undefined ? null : printable(code);
  if (response.ok && answer?.success === true) {
    const network = typeof answer.network === "string" ? answer.network : "";
    const same = transaction !== null && rail.names.includes(network) && (answer.payer === undefined || lower(answer.payer) === payer);
    if (!same) return { kind: "open", reason: `unexpected settlement response: ${printable(JSON.stringify(answer))}`, ...named };
    const bazaar = bazaarStatus(response);
    return { kind: "paid", transaction, ...(bazaar ? { bazaar } : {}) };
  }
  if (reason !== null) {
    if (reason === "settlement_pending") return { kind: "open", reason, pending: true, ...named };
    if (!transaction && CDP_PAYER_REFUSALS.has(reason)) return { kind: "refused", reason };
    if (!transaction && CDP_OUR_PROBLEMS.has(reason)) return { kind: "unavailable", reason };
    // A settlement code we do not know, or a known one that comes with a transaction: it may hide a transfer.
    if (coded) return { kind: "open", reason, ...named };
  }
  const text = reason ?? printable(String(answer?.errorMessage ?? `HTTP ${response.status}`));
  if (!transaction && [400, 401, 402, 403].includes(response.status)) return { kind: "unavailable", reason: text };
  return { kind: "open", reason: `${text} (HTTP ${response.status})`, ...named };
}

/** One /settle call to Circle, for Arc. */
export function settleOnce(cfg: X402Config, body: string, payer: string, fetchImpl: typeof fetch = fetch, timeoutMs = SETTLE_TIMEOUT_MS): Promise<Settled> {
  return settleOnRail(cfg, arcRail(cfg), body, payer, fetchImpl, timeoutMs);
}

/** One /settle call on one network, to the facilitator that settles it. It never throws: a failure to reach the facilitator is an answer of its own. */
export async function settleOnRail(cfg: X402Config, rail: Rail, body: string, payer: string, fetchImpl: typeof fetch = fetch, timeoutMs?: number): Promise<Settled> {
  let url: string;
  let headers: Record<string, string>;
  if (rail.facilitator === "cdp") {
    if (!cfg.cdp) return { kind: "unavailable", reason: "no CDP key is set" };
    try {
      headers = { "content-type": "application/json", authorization: `Bearer ${cdpBearer(cfg.cdp, "POST", `${CDP_X402_PATH}/settle`)}` };
    } catch {
      return { kind: "unavailable", reason: "the CDP key could not sign a request" };
    }
    url = `${CDP_FACILITATOR_URL}/settle`;
  } else {
    url = `${cfg.facilitator}/settle`;
    headers = { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` };
  }
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(Math.max(1_000, timeoutMs ?? (rail.facilitator === "cdp" ? CDP_SETTLE_TIMEOUT_MS : SETTLE_TIMEOUT_MS))) });
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
  return rail.facilitator === "cdp" ? cdpAnswer(response, answer, rail, payer) : circleAnswer(response, answer, rail, payer);
}
