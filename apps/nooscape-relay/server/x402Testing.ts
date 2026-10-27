import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { addressOfUncompressedKey } from "./claimsCrypto";
import type { NewPayment, PaymentLedger, PaymentRow } from "./apiPayments";
import { ARC_MAINNET, base64Json, loadX402, railFor, requirements, type PaymentPayload, type X402Config, type X402Endpoint } from "./x402";
import { transferAuthorizationDigest } from "./x402Crypto";

/**
 * Test support for pay per call: a ledger in memory that keeps the database ledger's rules, a buyer that signs real authorizations, and
 * a facilitator that answers as it is told. Not imported by the server.
 */

export const TEST_PAY_TO = "0x14791697260e4c9a71f18484c9f997b308e59325";
export const TEST_CIRCLE_KEY = `LIVE_API_KEY:${"a".repeat(24)}:${"b".repeat(24)}`;

export const TEST_CDP_ID = "00000000-0000-4000-8000-0000000000c0";

/**
 * The two CDP settings, from a key made for the test: Ed25519 (what the portal recommends) or ECDSA P-256 (a PEM). `publicKey` verifies the
 * tokens the key signs. Nothing here is a real key, and none is written down: every call makes a new one.
 */
export function newCdpKeys(kind: "ed25519" | "ec" = "ed25519"): { env: { CDP_API_KEY_ID: string; CDP_API_KEY_SECRET: string }; publicKey: KeyObject } {
  if (kind === "ec") {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    return { env: { CDP_API_KEY_ID: TEST_CDP_ID, CDP_API_KEY_SECRET: String(pair.privateKey.export({ type: "sec1", format: "pem" })) }, publicKey: pair.publicKey };
  }
  const pair = generateKeyPairSync("ed25519");
  const seed = pair.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const half = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { env: { CDP_API_KEY_ID: TEST_CDP_ID, CDP_API_KEY_SECRET: Buffer.concat([seed, half]).toString("base64") }, publicKey: pair.publicKey };
}

export function testConfig(env: Record<string, string> = {}): X402Config {
  return loadX402({ X402_NETWORK: ARC_MAINNET, X402_PAY_TO: TEST_PAY_TO, X402_API_KEY: TEST_CIRCLE_KEY, ...env } as NodeJS.ProcessEnv)!;
}

/** The database ledger's rules, in memory: unique payer and nonce, and a result that is never undone. */
export function memoryLedger(options: { ready?: boolean } = {}) {
  const rows: PaymentRow[] = [];
  const fail = { find: false, begin: false, resolve: 0, hideNextFind: false };
  const state = { ready: options.ready ?? true };
  const ledger: PaymentLedger = {
    ready: async () => state.ready,
    find: async (network, payer, nonce) => {
      if (fail.find) throw new Error("database down");
      if (fail.hideNextFind) {
        // Another process recorded it between this look and the insert.
        fail.hideNextFind = false;
        return null;
      }
      return rows.find(row => row.network === network && row.payer === payer && row.nonce === nonce) ?? null;
    },
    begin: async (payment: NewPayment) => {
      if (fail.begin) throw new Error("database down");
      if (rows.some(row => row.network === payment.network && row.payer === payment.payer && row.nonce === payment.nonce)) return null;
      const row: PaymentRow = { id: randomUUID(), seq: rows.length + 1, ...payment, status: "settling", transaction: null, reason: null, sends: 1, serves: 0, createdAt: new Date(), updatedAt: new Date() };
      rows.push(row);
      return { ...row };
    },
    countSend: async id => {
      const row = rows.find(item => item.id === id);
      if (!row || (row.status !== "settling" && row.status !== "open")) return false;
      row.sends += 1;
      row.updatedAt = new Date();
      return true;
    },
    resolve: async (id, change) => {
      if (fail.resolve > 0) {
        fail.resolve -= 1;
        throw new Error("database down");
      }
      const row = rows.find(item => item.id === id);
      if (!row || (row.status !== "settling" && row.status !== "open")) return false;
      row.status = change.status;
      row.transaction = change.status === "paid" ? (change.transaction ?? row.transaction) : (row.transaction ?? change.transaction ?? null);
      row.reason = change.reason ?? null;
      row.updatedAt = new Date();
      if (change.status === "paid") row.serves += 1;
      return true;
    },
    close: async (id, reason) => {
      const row = rows.find(item => item.id === id);
      if (!row || (row.status !== "settling" && row.status !== "open")) return false;
      row.status = "closed";
      row.reason = ((row.reason ?? "").startsWith("failed after broadcast") ? `failed after broadcast; ${reason}` : reason).slice(0, 200);
      row.updatedAt = new Date();
      return true;
    },
    openFor: async (network, payer) => rows.filter(row => row.network === network && row.payer === payer && (row.status === "settling" || row.status === "open")).length,
    failedFor: async (network, payer, since) => rows.filter(row => row.network === network && row.payer === payer && (row.reason ?? "").startsWith("failed after broadcast") && row.updatedAt >= since).length,
    stale: async (network, before) => rows.filter(row => row.network === network && (row.status === "settling" || row.status === "open") && row.updatedAt < before).length,
    countServe: async (id, max) => {
      const row = rows.find(item => item.id === id);
      if (!row || row.status !== "paid" || row.serves >= max) return false;
      row.serves += 1;
      return true;
    },
    recent: async (network, limit) => rows.filter(row => row.network === network).slice(-limit).reverse(),
    unresolved: async (network, limit) => {
      const open = rows.filter(row => row.network === network && (row.status === "settling" || row.status === "open"));
      return { total: open.length, rows: open.slice(0, limit) };
    },
    summary: async () => [],
  };
  return { ledger, rows, fail, state };
}

/** A buyer with its own key: signs real EIP-3009 authorizations for the terms of an endpoint. */
export function newBuyer() {
  const secret = secp256k1.utils.randomSecretKey();
  const address = addressOfUncompressedKey(secp256k1.getPublicKey(secret, false));
  let counter = 0;
  const signature = (cfg: X402Config, authorization: PaymentPayload["payload"]["authorization"], network: string) => {
    const rail = railFor(cfg, network)!;
    const digest = transferAuthorizationDigest(rail.chainId, rail.asset, authorization, rail.domain);
    const recoverable = secp256k1.sign(digest ?? new Uint8Array(32), secret, { prehash: false, format: "recovered" });
    const bytes = new Uint8Array(65);
    bytes.set(recoverable.slice(1, 65), 0);
    bytes[64] = recoverable[0]! + 27;
    return `0x${bytesToHex(bytes)}`;
  };
  return {
    address,
    /** A payment for an endpoint, on Arc unless `network` says another. `nonce` defaults to a new one each time; `validFor` is seconds from `nowSeconds`. */
    pay(cfg: X402Config, endpoint: X402Endpoint, over: { nonce?: string; validFor?: number; nowSeconds?: number; network?: string } = {}): PaymentPayload {
      counter += 1;
      const rail = railFor(cfg, over.network ?? cfg.network)!;
      const nowSeconds = over.nowSeconds ?? Math.floor(Date.now() / 1000);
      const authorization = {
        from: address,
        to: rail.payTo,
        value: cfg.prices[endpoint],
        validAfter: "0",
        validBefore: String(nowSeconds + (over.validFor ?? 120)),
        nonce: over.nonce ?? `0x${randomUUID().replace(/-/g, "")}${counter.toString(16).padStart(32, "0")}`,
      };
      return { x402Version: 2, accepted: requirements(cfg, endpoint, rail), payload: { signature: signature(cfg, authorization, rail.network), authorization } };
    },
  };
}

export const headerOf = (payment: PaymentPayload) => base64Json(payment);

type FacilitatorCall = {
  url: string;
  authorization: string | undefined;
  body: {
    paymentPayload: { accepted: { network: string }; resource: { url: string }; payload: { authorization: { from: string; nonce: string } }; extensions: Record<string, { info: { id: string } }> };
    paymentRequirements: { network: string; payTo: string };
  };
};

/**
 * A facilitator that answers each /settle as scripted: by default it settles and names a transaction (the same one for the same
 * payment, as Circle's idempotency does; a call to Coinbase has no idempotency key, so it is keyed by payer and nonce, and a replay of a
 * payment it settled is refused as Coinbase refuses it). `script` is a list of answers used in order, then the default. "lost" settles on the
 * facilitator's side and then never answers, which is the case a payer cannot tell from a payment that did not happen. A call to
 * Coinbase's address is answered in Coinbase's shape, with the Bazaar's EXTENSION-RESPONSES header.
 */
export function newFacilitator(_cfg: X402Config, script: Array<(() => Response | Promise<Response>) | "lost"> = []) {
  const calls: FacilitatorCall[] = [];
  const settled = new Map<string, string>();
  const queue = [...script];
  let counter = 0;
  const settle = (id: string) => {
    if (!settled.has(id)) {
      counter += 1;
      settled.set(id, `0x${counter.toString(16).padStart(64, "0")}`);
    }
    return settled.get(id)!;
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as FacilitatorCall["body"];
    calls.push({ url, authorization: (init.headers as Record<string, string>).authorization, body });
    const id = body.paymentPayload.extensions["payment-identifier"]?.info.id ?? `${body.paymentPayload.payload.authorization.from}:${body.paymentPayload.payload.authorization.nonce}`;
    const next = queue.shift();
    if (next === "lost") {
      settle(id);
      throw new TypeError("fetch failed");
    }
    if (next) return next();
    const coinbase = String(url).startsWith("https://api.cdp.coinbase.com/");
    // Coinbase has no idempotency key: a replay of an authorization it has settled is refused, with its catch-all reason (invalid_payload).
    if (coinbase && settled.has(id)) return Response.json({ success: false, errorReason: "invalid_payload" }, { status: 400 });
    const answer = { success: true, transaction: settle(id), network: body.paymentPayload.accepted.network, payer: body.paymentPayload.payload.authorization.from };
    if (!coinbase) return Response.json(answer);
    return Response.json(answer, { headers: { "extension-responses": base64Json({ bazaar: { status: "processing" } }) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, settled };
}

export const facilitatorAnswers = {
  pending: (transaction?: string) => () => Response.json({ success: false, errorReason: "settlement_pending", ...(transaction ? { transaction } : {}) }),
  refused: (errorReason: string) => () => Response.json({ success: false, errorReason }),
  status: (status: number, body: unknown = {}) => () => Response.json(body, { status }),
  down: () => () => {
    throw new TypeError("fetch failed");
  },
};

// ---------------------------------------------------------------- smart-contract wallets (stage D4b)

/** A smart-contract wallet as a buyer: its signature is whatever its code takes, here 130 bytes that are no key's signature of anything. */
export function newContractBuyer(address = `0x${"c0".repeat(20)}`) {
  let counter = 0;
  return {
    address,
    pay(cfg: X402Config, endpoint: X402Endpoint, over: { nonce?: string; validFor?: number; nowSeconds?: number; signature?: string; network?: string } = {}): PaymentPayload {
      counter += 1;
      const rail = railFor(cfg, over.network ?? cfg.network)!;
      const nowSeconds = over.nowSeconds ?? Math.floor(Date.now() / 1000);
      const authorization = {
        from: address,
        to: rail.payTo,
        value: cfg.prices[endpoint],
        validAfter: "0",
        validBefore: String(nowSeconds + (over.validFor ?? 120)),
        nonce: over.nonce ?? `0x${randomUUID().replace(/-/g, "")}${counter.toString(16).padStart(32, "0")}`,
      };
      return { x402Version: 2, accepted: requirements(cfg, endpoint, rail), payload: { signature: over.signature ?? `0x${randomUUID().replace(/-/g, "").repeat(7).slice(0, 260)}`, authorization } };
    },
  };
}

const wordOf = (value: bigint | number) => hexToBytes(BigInt(value).toString(16).padStart(64, "0"));
const paddedOf = (data: Uint8Array) => concatBytes(wordOf(data.length), data, new Uint8Array((32 - (data.length % 32)) % 32));

/** Multicall3's aggregate3 answer, as a node returns it. */
export function encodeAggregate3Result(results: Array<{ success: boolean; returnData: Uint8Array }>): string {
  const tuples = results.map(item => concatBytes(wordOf(item.success ? 1 : 0), wordOf(64), paddedOf(item.returnData)));
  const offsets: Uint8Array[] = [];
  let at = results.length * 32;
  for (const tuple of tuples) {
    offsets.push(wordOf(at));
    at += tuple.length;
  }
  return `0x${bytesToHex(concatBytes(wordOf(32), wordOf(results.length), ...offsets, ...tuples))}`;
}

/** An Error(string) revert, as USDC gives one. */
export function encodeRevert(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  return concatBytes(hexToBytes("08c379a0"), wordOf(32), paddedOf(bytes));
}

type ChainVerdict = "ok" | "invalid" | "balance" | "used" | "expired" | "silent" | "wrongChain" | "behind" | "down" | "garbage";

/**
 * A chain node that answers the contract-wallet check as scripted. `verdict` can be changed between calls; every call is recorded.
 * `now` is the time the node's latest block has, in seconds.
 */
export function fakeChain(options: { chainId?: number; now?: () => number } = {}) {
  const state = { verdict: "ok" as ChainVerdict };
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    calls.push({ method, params });
    if (state.verdict === "down") throw new Error("the node is down");
    if (state.verdict === "garbage") return "not an answer";
    const chainId = state.verdict === "wrongChain" ? 1 : (options.chainId ?? 5042);
    const time = (options.now?.() ?? Math.floor(Date.now() / 1000)) - (state.verdict === "behind" ? 3_600 : 0);
    const revert: Partial<Record<ChainVerdict, string>> = { invalid: "FiatTokenV2: invalid signature", balance: "ERC20: transfer amount exceeds balance", used: "FiatTokenV2: authorization is used or canceled", expired: "FiatTokenV2: authorization is expired" };
    const transfer = state.verdict in revert ? { success: false, returnData: encodeRevert(revert[state.verdict]!) } : state.verdict === "silent" ? { success: false, returnData: new Uint8Array(0) } : { success: true, returnData: new Uint8Array(0) };
    return encodeAggregate3Result([{ success: true, returnData: wordOf(chainId) }, { success: true, returnData: wordOf(time) }, transfer]);
  };
  return { rpc, calls, state };
}
