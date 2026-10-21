import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import { addressOfUncompressedKey } from "./claimsCrypto";
import {
  ARC_MAINNET,
  ARC_TESTNET,
  ARC_USDC,
  CIRCLE_FACILITATORS,
  base64Json,
  decodePayment,
  loadX402,
  paymentIdOf,
  paymentProblem,
  requirements,
  settleBody,
  settleOnce,
  signatureProblem,
  termsReply,
  timeProblem,
  usdOf,
  type PaymentPayload,
  type X402Config,
} from "./x402";
import { checkDiscovery, lookupDiscovery } from "./x402Bazaar";
import { transferAuthorizationDigest } from "./x402Crypto";

/**
 * The protocol parts of pay per call (docs/data-access-2026-10-19.md, stage D4): the settings and when they leave the feature off, the
 * terms, reading and checking a payment, and the facilitator's every answer sorted by what it proves about the money.
 */
const PAY_TO = "0x14791697260e4c9a71f18484c9f997b308e59325";
const LIVE_KEY = `LIVE_API_KEY:${"a".repeat(24)}:${"b".repeat(24)}`;
const TEST_KEY = `TEST_API_KEY:${"a".repeat(24)}:${"b".repeat(24)}`;
const MAINNET_ENV = { X402_NETWORK: ARC_MAINNET, X402_PAY_TO: PAY_TO, X402_API_KEY: LIVE_KEY } as NodeJS.ProcessEnv;
const TESTNET_ENV = { X402_NETWORK: ARC_TESTNET, X402_PAY_TO: PAY_TO, X402_API_KEY: TEST_KEY } as NodeJS.ProcessEnv;
const mainnet = loadX402(MAINNET_ENV)!;
const RESOURCE = "https://nooscape.si/api/v1/check";

describe("the settings", () => {
  it("leave the feature off when no network is set, and give the plan's placeholder prices when it is on", () => {
    expect(loadX402({})).toBeNull();
    expect(loadX402({ X402_NETWORK: "  " })).toBeNull();
    expect(mainnet).toMatchObject({ network: ARC_MAINNET, chainId: 5042, payTo: PAY_TO, prices: { agent: "5000", check: "10000" }, facilitator: CIRCLE_FACILITATORS.production, resourceBase: "https://nooscape.si", pauseNew: false });
    // Circle's production host serves both Arc networks, and a testnet key is used against it.
    expect(loadX402(TESTNET_ENV)).toMatchObject({ network: ARC_TESTNET, chainId: 5042002, facilitator: CIRCLE_FACILITATORS.production });
  });

  it("take prices, a resource origin and a pause from the environment, and keep the receiving address in lower case", () => {
    const cfg = loadX402({ ...MAINNET_ENV, X402_PRICE_LOOKUP: "1000", X402_PRICE_CHECK: "20000", X402_RESOURCE_BASE: "https://example.org/", X402_PAUSE_NEW: "1", X402_PAY_TO: PAY_TO.toUpperCase().replace("0X", "0x") })!;
    expect(cfg).toMatchObject({ prices: { agent: "1000", check: "20000" }, resourceBase: "https://example.org", pauseNew: true, payTo: PAY_TO });
    expect(loadX402({ ...MAINNET_ENV, X402_PAUSE_NEW: "0" })!.pauseNew).toBe(false);
  });

  it("throw, so the caller keeps the feature off, for any setting that is half there or unsafe", () => {
    const bad: Array<[Record<string, string>, RegExp]> = [
      [{ X402_NETWORK: "eip155:1" }, /X402_NETWORK must be/],
      [{ X402_PAY_TO: "" }, /X402_PAY_TO/],
      [{ X402_PAY_TO: "0x123" }, /X402_PAY_TO/],
      [{ X402_PAY_TO: `0x${"0".repeat(40)}` }, /X402_PAY_TO/],
      [{ X402_API_KEY: "" }, /X402_API_KEY must be/],
      [{ X402_API_KEY: "sk_live_something" }, /X402_API_KEY must be/],
      [{ X402_API_KEY: TEST_KEY }, /mainnet needs a LIVE_API_KEY/],
      [{ X402_PRICE_LOOKUP: "0" }, /X402_PRICE_LOOKUP/],
      [{ X402_PRICE_LOOKUP: "0.005" }, /X402_PRICE_LOOKUP/],
      [{ X402_PRICE_CHECK: "-1" }, /X402_PRICE_CHECK/],
      [{ X402_PRICE_CHECK: "1000001" }, /X402_PRICE_CHECK/],
      [{ X402_FACILITATOR: "https://evil.example/facilitator" }, /X402_FACILITATOR must be/],
      [{ X402_RESOURCE_BASE: "http://nooscape.si" }, /X402_RESOURCE_BASE/],
      [{ X402_RESOURCE_BASE: "https://nooscape.si/path" }, /X402_RESOURCE_BASE/],
    ];
    for (const [change, message] of bad) expect(() => loadX402({ ...MAINNET_ENV, ...change }), JSON.stringify(change)).toThrow(message);
    expect(() => loadX402({ ...TESTNET_ENV, X402_API_KEY: LIVE_KEY })).toThrow(/testnet needs a TEST_API_KEY/);
    expect(() => loadX402({ ...TESTNET_ENV, X402_FACILITATOR: "https://api.circle.com.evil.example/v1/facilitator/x402" })).toThrow(/X402_FACILITATOR must be/);
    // Either of Circle's two endpoints may be chosen for either network.
    for (const env of [MAINNET_ENV, TESTNET_ENV]) {
      for (const facilitator of Object.values(CIRCLE_FACILITATORS)) expect(loadX402({ ...env, X402_FACILITATOR: facilitator })!.facilitator).toBe(facilitator);
    }
  });

  it("never put the key or the address in an error message", () => {
    for (const change of [{ X402_PAY_TO: "0xnope" }, { X402_API_KEY: "LIVE_API_KEY:short" }]) {
      try {
        loadX402({ ...MAINNET_ENV, ...change });
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(LIVE_KEY);
        expect(String((error as Error).message)).not.toContain(PAY_TO);
      }
    }
  });
});

describe("a price", () => {
  it("is shown in dollars with the cents always there and no more places than the price needs", () => {
    expect([usdOf("5000"), usdOf("10000"), usdOf("1000000"), usdOf("250000"), usdOf("1"), usdOf("12345"), usdOf(20000)]).toEqual(["$0.005", "$0.01", "$1.00", "$0.25", "$0.000001", "$0.012345", "$0.02"]);
  });
});

describe("the terms", () => {
  it("are an exact USDC payment on Arc to the receiving address, for the price of the endpoint, built from the settings every time", () => {
    expect(requirements(mainnet, "check")).toEqual({ scheme: "exact", network: ARC_MAINNET, amount: "10000", asset: ARC_USDC, payTo: PAY_TO, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } });
    expect(requirements(mainnet, "agent").amount).toBe("5000");
  });

  it("are the same in the 402's header and body, with a reason and the resource named", () => {
    const reply = termsReply(mainnet, "check", RESOURCE, "PAYMENT-SIGNATURE header is required");
    expect(reply.status).toBe(402);
    const fromHeader = JSON.parse(Buffer.from(reply.headers["payment-required"]!, "base64").toString("utf8"));
    expect(fromHeader).toEqual(reply.body);
    expect(fromHeader).toMatchObject({ x402Version: 2, error: "PAYMENT-SIGNATURE header is required", resource: { url: RESOURCE, mimeType: "application/json" }, accepts: [requirements(mainnet, "check")], extensions: { bazaar: checkDiscovery() } });
    expect(fromHeader.resource.description).toContain("pre-flight check");
  });

  it("say how to call the route in a Bazaar block, with the lookup's path parameters taken from the address, and still read the same from the header and the body", () => {
    const resource = "https://nooscape.si/api/v1/agents/base/42";
    const reply = termsReply(mainnet, "agent", resource, "PAYMENT-SIGNATURE header is required");
    const fromHeader = JSON.parse(Buffer.from(reply.headers["payment-required"]!, "base64").toString("utf8"));
    expect(fromHeader).toEqual(reply.body);
    expect(fromHeader.extensions).toEqual({ bazaar: lookupDiscovery({ chain: "base", id: "42" }) });
    // What is bought is still decided by our own terms and not by this block: the amounts and the receiving address are the ones in `accepts`.
    expect(fromHeader.accepts).toEqual([requirements(mainnet, "agent")]);
    // The header that carries it stays well under what an edge accepts for one header line.
    expect(reply.headers["payment-required"]!.length).toBeLessThan(3_000);
  });
});

// ---------------------------------------------------------------- a payment

const secret = secp256k1.utils.randomSecretKey();
const PAYER = addressOfUncompressedKey(secp256k1.getPublicKey(secret, false));
const NONCE = `0x${"cd".repeat(32)}`;
const NOW = 1_792_390_000;

function payment(over: { authorization?: Partial<PaymentPayload["payload"]["authorization"]>; accepted?: Partial<PaymentPayload["accepted"]>; version?: number; signature?: string; sign?: boolean } = {}, endpoint: "agent" | "check" = "check", cfg: X402Config = mainnet): PaymentPayload {
  const authorization = { from: PAYER, to: cfg.payTo, value: cfg.prices[endpoint], validAfter: "0", validBefore: String(NOW + 120), nonce: NONCE, ...over.authorization };
  const digest = transferAuthorizationDigest(cfg.chainId, ARC_USDC, authorization);
  let signature = over.signature;
  if (signature === undefined) {
    const recoverable = secp256k1.sign(digest ?? new Uint8Array(32), secret, { prehash: false, format: "recovered" });
    const bytes = new Uint8Array(65);
    bytes.set(recoverable.slice(1, 65), 0);
    bytes[64] = recoverable[0]! + 27;
    signature = `0x${bytesToHex(bytes)}`;
  }
  return { x402Version: over.version ?? 2, accepted: { ...requirements(cfg, endpoint), ...over.accepted }, payload: { signature, authorization } };
}
const header = (p: unknown) => base64Json(p);
const header_ = (json: string) => Buffer.from(json).toString("base64");

describe("reading a payment", () => {
  it("takes a well-formed header and refuses one that is not JSON, not base64, empty, too long or missing a field", () => {
    const good = payment();
    expect(decodePayment(header(good))).toEqual(good);
    for (const bad of ["", "not base64 !!", Buffer.from("not json").toString("base64"), header({}), header({ ...good, payload: { signature: "0x00" } }), header({ ...good, accepted: null }), header({ ...good, payload: { ...good.payload, authorization: { ...good.payload.authorization, value: 5000 } } }), "A".repeat(16_385)]) {
      expect(decodePayment(bad), bad.slice(0, 20)).toBeNull();
    }
  });

  it("refuses a header whose terms are not strings, and never lets a stranger's shape throw", () => {
    const good = payment();
    const hostile: unknown[] = [{ toString: 1 }, { valueOf: 1 }, ["x"], 5, null, true, { a: { b: 1 } }];
    for (const field of ["scheme", "network", "amount", "asset", "payTo"] as const) {
      for (const value of hostile) {
        const header = header_(JSON.stringify({ ...good, accepted: { ...good.accepted, [field]: value } }));
        expect(decodePayment(header), `${field}=${JSON.stringify(value)}`).toBeNull();
      }
    }
    for (const field of ["from", "to", "value", "validAfter", "validBefore", "nonce"] as const) {
      for (const value of hostile) {
        const header = header_(JSON.stringify({ ...good, payload: { ...good.payload, authorization: { ...good.payload.authorization, [field]: value } } }));
        expect(decodePayment(header), `${field}=${JSON.stringify(value)}`).toBeNull();
      }
    }
    for (const shape of ["null", "[]", "5", '"text"', "{}", '{"accepted":{"asset":{"toString":1}},"payload":{}}']) expect(decodePayment(header_(shape)), shape).toBeNull();
  });

  it("accepts the terms we asked for and refuses a payment whose terms or authorization differ in any way", () => {
    expect(paymentProblem(mainnet, "check", payment())).toBeNull();
    expect(paymentProblem(mainnet, "agent", payment({}, "agent"))).toBeNull();
    const cases: Array<[string, Parameters<typeof payment>[0]]> = [
      ["version", { version: 1 }],
      ["scheme", { accepted: { scheme: "upto" as never } }],
      ["network", { accepted: { network: ARC_TESTNET } }],
      ["amount", { accepted: { amount: "9999" } }],
      ["asset", { accepted: { asset: "0x3600000000000000000000000000000000000001" } }],
      ["payTo", { accepted: { payTo: "0x14791697260e4c9a71f18484c9f997b308e59326" } }],
      ["authorization payee", { authorization: { to: "0x14791697260e4c9a71f18484c9f997b308e59326" } }],
      ["authorization value", { authorization: { value: "9999" } }],
      ["payer", { authorization: { from: "0x123" } }],
      ["nonce", { authorization: { nonce: "0xabcd" } }],
      ["validAfter", { authorization: { validAfter: "-1" } }],
      ["validBefore", { authorization: { validBefore: "soon" } }],
    ];
    for (const [label, change] of cases) expect(paymentProblem(mainnet, "check", payment(change, "check", mainnet)), label).not.toBeNull();
    // A payment for the lookup's price does not buy the check.
    expect(paymentProblem(mainnet, "check", payment({}, "agent"))).toBe("payment terms do not match this resource");
  });

  it("takes a new payment only while its authorization has a margin left and not more than ten minutes to run", () => {
    expect(timeProblem(payment({ authorization: { validBefore: String(NOW + 120) } }), NOW)).toBeNull();
    expect(timeProblem(payment({ authorization: { validBefore: String(NOW + 15) } }), NOW)).toBeNull();
    expect(timeProblem(payment({ authorization: { validBefore: String(NOW + 14) } }), NOW)).toBe("the authorization expires too soon");
    expect(timeProblem(payment({ authorization: { validBefore: String(NOW + 600) } }), NOW)).toBeNull();
    expect(timeProblem(payment({ authorization: { validBefore: String(NOW + 601) } }), NOW)).toContain("at most 600 seconds");
    expect(timeProblem(payment({ authorization: { validAfter: String(NOW + 1), validBefore: String(NOW + 120) } }), NOW)).toBe("the authorization is not valid yet");
  });

  it("takes only the payer's own regular-wallet signature of exactly this transfer", () => {
    expect(signatureProblem(mainnet, payment())).toBeNull();
    // Signed for another chain, another amount or by another key: not the payer's.
    const other = secp256k1.utils.randomSecretKey();
    const foreign = payment();
    const recoverable = secp256k1.sign(transferAuthorizationDigest(5042, ARC_USDC, foreign.payload.authorization)!, other, { prehash: false, format: "recovered" });
    const bytes = new Uint8Array(65);
    bytes.set(recoverable.slice(1, 65), 0);
    bytes[64] = recoverable[0]! + 27;
    expect(signatureProblem(mainnet, { ...foreign, payload: { ...foreign.payload, signature: `0x${bytesToHex(bytes)}` } })).toBe("the signature is not the payer's");
    const wrongChain = loadX402(TESTNET_ENV)!;
    expect(signatureProblem(wrongChain, payment({}, "check", mainnet))).toBe("the signature is not the payer's");
    const tampered = payment();
    tampered.payload.authorization.nonce = `0x${"ce".repeat(32)}`;
    expect(signatureProblem(mainnet, tampered)).toBe("the signature is not the payer's");
  });

  it("takes only 27 or 28 as the recovery byte, because the token contract takes no other", () => {
    const good = payment();
    expect(signatureProblem(mainnet, good)).toBeNull();
    const body = good.payload.signature.slice(0, 130);
    const last = good.payload.signature.slice(130);
    const flipped = last === "1b" ? "00" : "01";
    expect(signatureProblem(mainnet, payment({ signature: `${body}${flipped}` }))).toMatch(/27 or 28/);
    expect(signatureProblem(mainnet, payment({ signature: `${body}${last.toUpperCase()}` }))).toBeNull();
  });

  it("says why a signature that is not a regular wallet's cannot be taken, and never lets a malformed one through", () => {
    const good = payment();
    const longer = `${good.payload.signature}${"00".repeat(40)}`;
    expect(signatureProblem(mainnet, payment({ signature: longer }))).toContain("smart-contract wallets are not accepted");
    expect(signatureProblem(mainnet, payment({ signature: `0x${"12".repeat(60)}6492649264926492649264926492649264926492649264926492649264926492` }))).toContain("not deployed yet");
    for (const bad of ["", "0x", "0xzz", "abcdef", `0x${"00".repeat(65)}`, `0x${"ff".repeat(65)}`, `0x${"00".repeat(3000)}`]) {
      expect(signatureProblem(mainnet, payment({ signature: bad })), bad.slice(0, 12)).not.toBeNull();
    }
  });

  it("gives a payment an idempotency key that changes with anything signed, the signature, the network and what was bought", () => {
    const base = paymentIdOf(mainnet, payment(), "subject-a");
    expect(base).toMatch(/^nsc_[0-9a-f]{32}$/);
    expect(paymentIdOf(mainnet, payment(), "subject-a")).toBe(base);
    expect(paymentIdOf(mainnet, payment(), "subject-b")).not.toBe(base);
    expect(paymentIdOf(mainnet, payment({ authorization: { nonce: `0x${"ce".repeat(32)}` } }), "subject-a")).not.toBe(base);
    expect(paymentIdOf(loadX402(TESTNET_ENV)!, payment({}, "check", loadX402(TESTNET_ENV)!), "subject-a")).not.toBe(base);
    expect(paymentIdOf(mainnet, payment({ signature: `0x${"11".repeat(65)}` }), "subject-a")).not.toBe(base);
  });
});

// ---------------------------------------------------------------- the facilitator

describe("the /settle body", () => {
  it("takes only the signed authorization and signature from the caller, and states the terms and the idempotency key itself", () => {
    const p = payment();
    const hostile = { ...p, accepted: { ...p.accepted, extra: { evil: true } } } as unknown as PaymentPayload;
    const body = JSON.parse(settleBody(mainnet, "check", RESOURCE, hostile, "nsc_abc"));
    expect(body).toEqual({
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        resource: { url: RESOURCE, description: expect.stringContaining("pre-flight check"), mimeType: "application/json" },
        accepted: requirements(mainnet, "check"),
        payload: { signature: p.payload.signature, authorization: p.payload.authorization },
        extensions: { "payment-identifier": { info: { required: true, id: "nsc_abc" } } },
      },
      paymentRequirements: requirements(mainnet, "check"),
    });
  });
});

describe("settling, by what the facilitator's answer proves about the money", () => {
  const TX = `0x${"7".repeat(64)}`;
  const answer = (status: number, body: unknown): typeof fetch => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;
  const settle = (fetchImpl: typeof fetch) => settleOnce(mainnet, "{}", PAYER.toLowerCase(), fetchImpl, 1_000);

  it("calls Circle's settle with the key as a bearer token, follows no redirect, and times out", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, transaction: TX, network: ARC_MAINNET, payer: PAYER }), { status: 200 })) as unknown as typeof fetch;
    await settle(fetchImpl);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CIRCLE_FACILITATORS.production}/settle`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${LIVE_KEY}`);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("is paid only when it succeeded, named a transaction, and the network and payer are ours", async () => {
    expect(await settle(answer(200, { success: true, transaction: TX, network: ARC_MAINNET, payer: PAYER, amount: "10000" }))).toEqual({ kind: "paid", transaction: TX });
    expect(await settle(answer(200, { success: true, transaction: TX, network: ARC_MAINNET }))).toEqual({ kind: "paid", transaction: TX });
    for (const odd of [
      { success: true, network: ARC_MAINNET, payer: PAYER },
      { success: true, transaction: "0xabc", network: ARC_MAINNET },
      { success: true, transaction: TX, network: ARC_TESTNET },
      { success: true, transaction: TX, network: ARC_MAINNET, payer: "0x0000000000000000000000000000000000000001" },
      { success: "true", transaction: TX, network: ARC_MAINNET },
    ]) {
      expect((await settle(answer(200, odd))).kind, JSON.stringify(odd)).toBe("open");
    }
  });

  it("is refused, with no charge, for the reasons that mean no transfer happened, and for a bad request or a screened party", async () => {
    for (const reason of ["invalid_payload", "invalid_exact_evm_payload_signature", "insufficient_funds", "invalid_exact_evm_payload_authorization_valid_before"]) {
      expect(await settle(answer(200, { success: false, errorReason: reason })), reason).toEqual({ kind: "refused", reason });
    }
    expect(await settle(answer(400, { errors: [{ reason: "invalid_request" }] }))).toEqual({ kind: "refused", reason: "invalid_request" });
    expect(await settle(answer(403, { errors: [{ reason: "party_screened" }] }))).toEqual({ kind: "refused", reason: "party_screened" });
  });

  it("is unavailable, and not the payer's fault, when Circle refuses our key or our address", async () => {
    expect(await settle(answer(403, { errors: [{ reason: "forbidden" }] }))).toEqual({ kind: "unavailable", reason: "forbidden" });
    expect(await settle(answer(401, { message: "invalid api key" }))).toEqual({ kind: "unavailable", reason: "invalid api key" });
  });

  it("is open, never refused and never delivered, for everything that may hide a transfer: pending, an unknown reason, a conflict, a limit, an outage, a transaction named with a failure, no answer, no JSON", async () => {
    expect(await settle(answer(200, { success: false, errorReason: "settlement_pending", transaction: TX }))).toMatchObject({ kind: "open", pending: true, transaction: TX });
    expect(await settle(answer(200, { success: false, errorReason: "some_new_reason" }))).toMatchObject({ kind: "open" });
    expect(await settle(answer(200, { success: false, errorReason: "insufficient_funds", transaction: TX }))).toMatchObject({ kind: "open", transaction: TX });
    expect(await settle(answer(200, { success: false }))).toMatchObject({ kind: "open", reason: "unreadable settlement response" });
    for (const status of [404, 409, 429, 500, 502, 503]) expect((await settle(answer(status, { message: "x" }))).kind, String(status)).toBe("open");
    expect((await settle(answer(400, { errors: [{ reason: "registration_required" }] }))).kind).toBe("open");
    expect((await settle(answer(400, { errors: [{ reason: "invalid_request" }], transaction: TX }))).kind).toBe("open");
    expect(await settle(answer(200, "not json"))).toMatchObject({ kind: "open" });
    expect(await settle(answer(200, "[1,2]"))).toMatchObject({ kind: "open" });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await settle(down)).toEqual({ kind: "open", reason: "no answer from the payment service", noAnswer: true });
  });

  it("keeps the facilitator's words short, and never the key, in what it reports", async () => {
    const long = "x".repeat(500);
    const result = await settle(answer(500, { message: long }));
    expect(result.kind).toBe("open");
    expect(JSON.stringify(result).length).toBeLessThan(260);
    expect(JSON.stringify(result)).not.toContain(LIVE_KEY);
  });
});
