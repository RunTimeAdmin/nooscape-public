import { verify } from "node:crypto";
import { inspect } from "node:util";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import { toChecksumAddress } from "./claimsCrypto";
import {
  ARC_MAINNET,
  ARC_TESTNET,
  BASE_MAINNET,
  BASE_USDC,
  CIRCLE_FACILITATORS,
  DESCRIPTIONS,
  SERVICE_NAME,
  SERVICE_TAGS,
  arcRail,
  base64Json,
  baseRail,
  loadX402,
  paymentIdOf,
  paymentProblem,
  railFor,
  railsOf,
  requirements,
  settleBody,
  settleOnRail,
  signatureProblem,
  termsReply,
  type PaymentPayload,
  type Settled,
} from "./x402";
import { bazaarFor } from "./x402Bazaar";
import { CDP_FACILITATOR_URL, CDP_X402_PATH } from "./x402Cdp";
import { usdcDomainSeparator } from "./x402Crypto";
import { newBuyer, newCdpKeys, TEST_CDP_ID, TEST_CIRCLE_KEY, TEST_PAY_TO, testConfig } from "./x402Testing";

/**
 * Base beside Arc (docs/x402-base-bazaar-2026-10-21.md): the settings that turn it on and what they never turn off, the terms for both
 * networks, a payment read under the network it names (and under that network's signing domain), the body Coinbase is sent, and
 * Coinbase's every answer to a settlement sorted by what it proves about the money. Every key here is made for the test.
 */
const keys = newCdpKeys();
const both = testConfig(keys.env);
const arcOnly = testConfig();
const RESOURCE = "https://nooscape.si/api/v1/check";
const LOOKUP_RESOURCE = "https://nooscape.si/api/v1/agents/base/42";
const TX = `0x${"7".repeat(64)}`;
const TEST_KEY = `TEST_API_KEY:${"a".repeat(24)}:${"b".repeat(24)}`;
const lower = (text: string) => text.toLowerCase();

describe("the settings for Base", () => {
  it("leave Arc alone when the CDP key is not set: it takes payment as it always did, with nothing else offered", () => {
    expect(arcOnly.cdp).toBeNull();
    expect(arcOnly.baseProblem).toBeNull();
    expect(baseRail(arcOnly)).toBeNull();
    expect(railsOf(arcOnly)).toEqual([arcRail(arcOnly)]);
    expect(railFor(arcOnly, BASE_MAINNET)).toBeNull();
  });

  it("turn Base on with both CDP settings: first, to the same address as Arc, settled by Coinbase", () => {
    expect(both.cdp).not.toBeNull();
    expect(both.baseProblem).toBeNull();
    const rails = railsOf(both);
    expect(rails.map(rail => rail.network)).toEqual([BASE_MAINNET, ARC_MAINNET]);
    expect(rails[0]).toMatchObject({ network: BASE_MAINNET, chainId: 8453, asset: BASE_USDC, domain: { name: "USD Coin", version: "2" }, facilitator: "cdp", payTo: toChecksumAddress(TEST_PAY_TO) });
    expect(rails[1]).toMatchObject({ network: ARC_MAINNET, facilitator: "circle", payTo: TEST_PAY_TO });
    // One receiving address on both networks: the same account, spelled the way Coinbase documents it on Base.
    expect(lower(rails[0]!.payTo)).toBe(rails[1]!.payTo);
    expect(railFor(both, ARC_MAINNET)).toEqual(rails[1]);
    expect(railFor(both, "eip155:1")).toBeNull();
  });

  it("keep Base off, and say why, when they are half there or unsafe, and never turn Arc off", () => {
    const testnet = { X402_NETWORK: ARC_TESTNET, X402_PAY_TO: TEST_PAY_TO, X402_API_KEY: TEST_KEY };
    const mainnet = { X402_NETWORK: ARC_MAINNET, X402_PAY_TO: TEST_PAY_TO, X402_API_KEY: TEST_CIRCLE_KEY };
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ ...mainnet, CDP_API_KEY_ID: keys.env.CDP_API_KEY_ID }, /must both be set/],
      [{ ...mainnet, CDP_API_KEY_SECRET: keys.env.CDP_API_KEY_SECRET }, /must both be set/],
      [{ ...mainnet, ...keys.env, CDP_API_KEY_SECRET: "not-a-key-0123456789" }, /CDP_API_KEY_SECRET must be/],
      [{ ...mainnet, ...keys.env, CDP_API_KEY_ID: "x" }, /CDP_API_KEY_ID/],
      [{ ...testnet, ...keys.env }, /only with Arc mainnet/],
    ];
    for (const [env, problem] of cases) {
      const cfg = loadX402(env as NodeJS.ProcessEnv);
      expect(cfg, JSON.stringify(Object.keys(env))).not.toBeNull();
      expect(cfg!.cdp).toBeNull();
      expect(cfg!.baseProblem).toMatch(problem);
      expect(railsOf(cfg!).map(rail => rail.network)).toEqual([cfg!.network]);
      expect(cfg!.baseProblem).not.toContain("not-a-key-0123456789");
    }
  });

  it("never put the secret in the settings that are kept or in a problem, and are off with everything else when X402_NETWORK is unset", () => {
    // The key is held as a key object, which prints as nothing: the secret is in no field, in JSON or in what a debugger would show.
    expect(Object.keys(both.cdp!).sort()).toEqual(["algorithm", "id", "key"]);
    expect(JSON.stringify(both.cdp)).toBe(`{"id":"${TEST_CDP_ID}","algorithm":"EdDSA","key":{}}`);
    const seed = Buffer.from(keys.env.CDP_API_KEY_SECRET, "base64");
    for (const shown of [JSON.stringify(both), inspect(both, { depth: 6 })]) {
      for (const secret of [keys.env.CDP_API_KEY_SECRET, seed.subarray(0, 32).toString("hex"), seed.subarray(0, 32).toString("base64")]) expect(shown).not.toContain(secret);
    }
    expect(loadX402({ ...keys.env } as NodeJS.ProcessEnv)).toBeNull();
    // The Arc settings still throw as they did: a mistake there keeps all of pay per call off.
    expect(() => loadX402({ X402_NETWORK: ARC_MAINNET, X402_PAY_TO: "0x123", X402_API_KEY: TEST_CIRCLE_KEY, ...keys.env } as NodeJS.ProcessEnv)).toThrow(/X402_PAY_TO/);
  });
});

describe("Base's signing domain", () => {
  it("reproduces Base USDC's own DOMAIN_SEPARATOR, as read from the contract on 21 October 2026, and Arc's name and version do not", () => {
    const BASE_USDC_DOMAIN_SEPARATOR = "02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f";
    const rail = baseRail(both)!;
    // Not through the buyer or the rail alone: the name, the version, the chain and the contract are written out, so that a wrong one in the code fails here.
    expect(bytesToHex(usdcDomainSeparator(8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2")!)).toBe(BASE_USDC_DOMAIN_SEPARATOR);
    expect(bytesToHex(usdcDomainSeparator(rail.chainId, rail.asset, rail.domain.name, rail.domain.version)!)).toBe(BASE_USDC_DOMAIN_SEPARATOR);
    expect(bytesToHex(usdcDomainSeparator(8453, BASE_USDC, "USDC", "2")!)).not.toBe(BASE_USDC_DOMAIN_SEPARATOR);
    expect(bytesToHex(usdcDomainSeparator(5042, "0x3600000000000000000000000000000000000000", "USD Coin", "2")!)).not.toBe(BASE_USDC_DOMAIN_SEPARATOR);
  });
});

describe("the terms with Base", () => {
  it("are an exact USDC payment on Base to the same address, in Base's USDC and under its signing name", () => {
    expect(requirements(both, "check", baseRail(both)!)).toEqual({
      scheme: "exact",
      network: BASE_MAINNET,
      amount: "10000",
      asset: BASE_USDC,
      payTo: toChecksumAddress(TEST_PAY_TO),
      maxTimeoutSeconds: 120,
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    });
    expect(requirements(both, "agent", baseRail(both)!).amount).toBe("5000");
  });

  it("are offered in the 402 for each network, Base first and Arc second, the same in the header and the body, and fit one header line", () => {
    const reply = termsReply(both, "check", RESOURCE, "PAYMENT-SIGNATURE header is required");
    const fromHeader = JSON.parse(Buffer.from(reply.headers["payment-required"]!, "base64").toString("utf8"));
    expect(fromHeader).toEqual(reply.body);
    expect(fromHeader.accepts).toEqual([requirements(both, "check", baseRail(both)!), requirements(both, "check", arcRail(both))]);
    expect(fromHeader.accepts.map((item: { network: string }) => item.network)).toEqual([BASE_MAINNET, ARC_MAINNET]);
    expect(fromHeader.extensions).toEqual({ bazaar: bazaarFor("check", RESOURCE) });
    expect(fromHeader.resource.description).toBe(DESCRIPTIONS.check);
    expect(reply.headers["payment-required"]!.length).toBeLessThan(5_000);
  });

  it("send a header for the check with no key that leaves room in the 4 KB a proxy may buffer for a whole response block", () => {
    const reply = termsReply(both, "check", RESOURCE, "The pre-flight check needs a Pro key or a payment of $0.01 per call. PAYMENT-SIGNATURE header is required.");
    // The block was 3,930 bytes at the edge on 22 Oct 2026, 2,460 of them this line (name, colon, value, line break), so the other headers took
    // 1,470; a payment reply then drops 536 bytes of headers only a document needs (apiV1.ts) and the output block adds 532 to this line. That
    // leaves the other headers about 934 bytes, and a 4,096-byte buffer leaves the line 3,162. The call uses the live error message and addresses
    // as long as the live ones, so it measures what the edge is sent. A third network or more text has to be weighed against the budget first.
    expect(reply.headers["payment-required"]!.length).toBeLessThan(3_100);
  });

  it("are Arc's alone, exactly as before, while Base is not set", () => {
    const reply = termsReply(arcOnly, "check", RESOURCE, "PAYMENT-SIGNATURE header is required");
    expect((reply.body as { accepts: unknown[] }).accepts).toEqual([requirements(arcOnly, "check")]);
    expect(requirements(arcOnly, "check")).toEqual(requirements(arcOnly, "check", arcRail(arcOnly)));
  });
});

describe("the text of a route in a 402 and in the Bazaar", () => {
  it("fits Coinbase's 500 characters, is plain ASCII, and describes the route without addressing the caller", () => {
    for (const text of Object.values(DESCRIPTIONS)) {
      expect(text.length).toBeLessThanOrEqual(500);
      expect(text).toMatch(/^[ -~]+$/);
    }
    // The Bazaar drops a listing whose text could be read as an instruction to an agent, and it comes back only after another paid call.
    const words = DESCRIPTIONS.check.toLowerCase().match(/[a-z0-9-]+/g) ?? [];
    const addressing = ["you", "your", "must", "should", "always", "never", "ignore", "instruction", "instructions", "prompt"];
    expect(words.filter(word => addressing.includes(word))).toEqual([]);
  });

  it("names the service and tags it within the limits the reference package keeps, which drops what is over them without a word", () => {
    const printable = /^[ -~]+$/;
    expect(SERVICE_NAME.length).toBeLessThanOrEqual(32);
    expect(SERVICE_NAME).toMatch(printable);
    expect(SERVICE_TAGS.length).toBeLessThanOrEqual(5);
    expect(new Set(SERVICE_TAGS.map(tag => tag.toLowerCase())).size).toBe(SERVICE_TAGS.length);
    for (const tag of SERVICE_TAGS) {
      expect(tag.length).toBeGreaterThan(0);
      expect(tag.length).toBeLessThanOrEqual(32);
      expect(tag).toMatch(printable);
    }
    // They are keywords for a catalogue, in the same plain words as the description: nothing that addresses a caller or claims a finding.
    const words = [SERVICE_NAME, ...SERVICE_TAGS].join(" ").toLowerCase().match(/[a-z0-9-]+/g) ?? [];
    expect(words.filter(word => ["you", "your", "must", "should", "always", "never", "ignore", "safe", "trusted", "verified", "score"].includes(word))).toEqual([]);
  });

  it("names the service in the settlement to Coinbase only: Circle's body is what it was, and the 402 does not carry the name", () => {
    const buyer = newBuyer();
    const forCoinbase = JSON.parse(settleBody(both, "check", RESOURCE, buyer.pay(both, "check", { network: BASE_MAINNET }), "nsc_abc"));
    const forCircle = JSON.parse(settleBody(both, "check", RESOURCE, buyer.pay(both, "check", { network: ARC_MAINNET }), "nsc_abc"));
    expect(forCoinbase.paymentPayload.resource).toMatchObject({ serviceName: "Nooscape", tags: SERVICE_TAGS });
    expect(forCircle.paymentPayload.resource).toEqual({ url: RESOURCE, description: DESCRIPTIONS.check, mimeType: "application/json" });
    const terms = termsReply(both, "check", RESOURCE, "x");
    expect((terms.body as { resource: Record<string, unknown> }).resource).toEqual({ url: RESOURCE, description: DESCRIPTIONS.check, mimeType: "application/json" });
  });

  it("keeps what a search for the check should find and what Nooscape never says: the registry standard, and no score and no verdict", () => {
    expect(DESCRIPTIONS.check).toContain("pre-flight check");
    expect(DESCRIPTIONS.check).toContain("ERC-8004");
    expect(DESCRIPTIONS.check).toContain("No score, no verdict");
  });
});

describe("reading a payment on Base", () => {
  const buyer = newBuyer();
  const pay = (over: Parameters<typeof buyer.pay>[2] = {}) => buyer.pay(both, "check", { network: BASE_MAINNET, ...over });

  it("holds it to Base's terms and Base's signing domain, and takes it", () => {
    expect(paymentProblem(both, "check", pay())).toBeNull();
    expect(signatureProblem(both, pay())).toBeNull();
  });

  it("is refused with its own words where Base is not offered, which point to Arc and to the payment id, and with the usual words for any other terms that are not ours", () => {
    expect(paymentProblem(arcOnly, "check", pay())).toMatch(/^Base is not being taken right now: pay on Arc/);
    expect(paymentProblem(arcOnly, "check", pay())).toContain("quote the payment id you were given");
    const elsewhere = { ...pay(), accepted: { ...pay().accepted, network: "eip155:1" } };
    expect(paymentProblem(both, "check", elsewhere)).toBe("payment terms do not match this resource");
  });

  it("takes the receiving address in any spelling, and refuses another address", () => {
    for (const spelling of [(text: string) => text.toLowerCase(), (text: string) => `0x${text.slice(2).toUpperCase()}`]) {
      const payment = pay();
      payment.payload.authorization.to = spelling(payment.payload.authorization.to);
      payment.accepted.payTo = spelling(payment.accepted.payTo);
      expect(paymentProblem(both, "check", payment)).toBeNull();
      expect(signatureProblem(both, payment)).toBeNull();
    }
    const other = pay();
    other.payload.authorization.to = `0x${"ab".repeat(20)}`;
    expect(paymentProblem(both, "check", other)).toBe("the authorization does not pay this resource");
    const wrongTerms = pay();
    wrongTerms.accepted.payTo = `0x${"ab".repeat(20)}`;
    expect(paymentProblem(both, "check", wrongTerms)).toBe("payment terms do not match this resource");
  });

  it("is signed under its own network's domain: what was signed for Arc does not pass as a payment on Base", () => {
    const onArc = buyer.pay(both, "check", { network: ARC_MAINNET });
    expect(signatureProblem(both, onArc)).toBeNull();
    // The same signed transfer under Base's terms: the terms and the address fit, and the signature is not the payer's.
    const relabelled: PaymentPayload = { ...onArc, accepted: requirements(both, "check", baseRail(both)!) };
    expect(paymentProblem(both, "check", relabelled)).toBeNull();
    expect(signatureProblem(both, relabelled)).toBe("the signature is not the payer's");
    // And the other way round.
    const relabelledArc: PaymentPayload = { ...pay(), accepted: requirements(both, "check", arcRail(both)) };
    expect(paymentProblem(both, "check", relabelledArc)).toBeNull();
    expect(signatureProblem(both, relabelledArc)).toBe("the signature is not the payer's");
  });

  it("has an id that names its network: the same signed transfer on Base and on Arc is two payments", () => {
    const onBase = pay();
    const onArc: PaymentPayload = { ...onBase, accepted: requirements(both, "check", arcRail(both)) };
    expect(paymentIdOf(both, onBase, "s")).not.toBe(paymentIdOf(both, onArc, "s"));
    expect(paymentIdOf(both, onBase, "s")).toMatch(/^nsc_[0-9a-f]{32}$/);
  });
});

describe("the /settle body for Base", () => {
  const buyer = newBuyer();

  it("is the Bazaar's metadata and the resource, built here, with the terms stated by us and nothing taken from the caller but the signed transfer", () => {
    const payment = buyer.pay(both, "check", { network: BASE_MAINNET });
    const hostile = { ...payment, accepted: { ...payment.accepted, extra: { evil: true } } } as unknown as PaymentPayload;
    const body = JSON.parse(settleBody(both, "check", RESOURCE, hostile, "nsc_abc"));
    const terms = requirements(both, "check", baseRail(both)!);
    expect(body).toEqual({
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        resource: { url: RESOURCE, description: expect.stringContaining("pre-flight check"), mimeType: "application/json", serviceName: SERVICE_NAME, tags: SERVICE_TAGS },
        accepted: terms,
        payload: { signature: payment.payload.signature, authorization: payment.payload.authorization },
        extensions: { bazaar: bazaarFor("check", RESOURCE) },
      },
      paymentRequirements: terms,
    });
    // Coinbase refuses a description over 500 characters.
    expect(body.paymentPayload.resource.description.length).toBeLessThanOrEqual(500);
  });

  it("gives Coinbase our receiving address as it documents it, whatever case the caller signed, and leaves Arc's body as it was", () => {
    const payment = buyer.pay(both, "check", { network: BASE_MAINNET });
    payment.payload.authorization.to = payment.payload.authorization.to.toLowerCase();
    const body = JSON.parse(settleBody(both, "check", RESOURCE, payment, "nsc_abc"));
    expect(body.paymentPayload.payload.authorization.to).toBe(toChecksumAddress(TEST_PAY_TO));
    const onArc = buyer.pay(both, "check", { network: ARC_MAINNET });
    onArc.payload.authorization.to = onArc.payload.authorization.to.toUpperCase().replace("0X", "0x");
    expect(JSON.parse(settleBody(both, "check", RESOURCE, onArc, "nsc_abc")).paymentPayload.payload.authorization.to).toBe(onArc.payload.authorization.to);
  });

  it("names the route's template and path parameters for a lookup, and gives Circle's idempotency key only to Circle", () => {
    const payment = buyer.pay(both, "agent", { network: BASE_MAINNET });
    const body = JSON.parse(settleBody(both, "agent", LOOKUP_RESOURCE, payment, "nsc_abc"));
    expect(body.paymentPayload.extensions).toEqual({ bazaar: bazaarFor("agent", LOOKUP_RESOURCE) });
    expect(body.paymentPayload.extensions["payment-identifier"]).toBeUndefined();
    const onArc = JSON.parse(settleBody(both, "check", RESOURCE, buyer.pay(both, "check", { network: ARC_MAINNET }), "nsc_abc"));
    expect(onArc.paymentPayload.extensions).toEqual({ "payment-identifier": { info: { required: true, id: "nsc_abc" } } });
  });
});

describe("settling on Base, by what Coinbase's answer proves about the money", () => {
  const rail = baseRail(both)!;
  const payer = newBuyer().address.toLowerCase();
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch =>
    (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers })) as typeof fetch;
  const settle = (fetchImpl: typeof fetch, cfg = both) => settleOnRail(cfg, rail, "{}", payer, fetchImpl, 1_000);
  const bazaarHeader = (value: unknown) => ({ "extension-responses": base64Json(value) });

  it("calls Coinbase's one address with a token made for this request, follows no redirect, times out, and never sends Circle's key", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, transaction: TX, network: BASE_MAINNET, payer }), { status: 200 })) as unknown as typeof fetch;
    await settle(fetchImpl);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CDP_FACILITATOR_URL}/settle`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const bearer = (init.headers as Record<string, string>).authorization!;
    expect(bearer.startsWith("Bearer ")).toBe(true);
    const [head, claims, signature] = bearer.slice(7).split(".");
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString("utf8")).uris).toEqual([`POST api.cdp.coinbase.com${CDP_X402_PATH}/settle`]);
    expect(verify(null, Buffer.from(`${head}.${claims}`), keys.publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    expect(JSON.stringify(init.headers)).not.toContain(TEST_CIRCLE_KEY);
    expect(url).not.toContain("circle.com");
  });

  it("is paid only when it succeeded, named a transaction, and the network (by its id or its older name) and payer are ours", async () => {
    expect(await settle(answer(200, { success: true, transaction: TX, network: BASE_MAINNET, payer, amount: "10000" }))).toEqual({ kind: "paid", transaction: TX });
    expect(await settle(answer(200, { success: true, transaction: TX, network: "base" }))).toEqual({ kind: "paid", transaction: TX });
    for (const odd of [
      { success: true, network: BASE_MAINNET, payer },
      { success: true, transaction: "0xabc", network: BASE_MAINNET },
      { success: true, transaction: TX, network: ARC_MAINNET },
      { success: true, transaction: TX, network: "eip155:1" },
      { success: true, transaction: TX },
      { success: true, transaction: TX, network: BASE_MAINNET, payer: "0x0000000000000000000000000000000000000001" },
      { success: "true", transaction: TX, network: BASE_MAINNET },
    ]) {
      expect((await settle(answer(200, odd))).kind, JSON.stringify(odd)).toBe("open");
    }
  });

  it("says what Coinbase said about cataloguing the endpoint, and drops what it cannot read", async () => {
    const paid = { success: true, transaction: TX, network: BASE_MAINNET, payer };
    expect(await settle(answer(200, paid, bazaarHeader({ bazaar: { status: "processing" } })))).toEqual({ kind: "paid", transaction: TX, bazaar: "processing" });
    expect(await settle(answer(200, paid, bazaarHeader({ bazaar: { status: "rejected", rejectedReason: "input does not match its schema" } })))).toEqual({ kind: "paid", transaction: TX, bazaar: "rejected: input does not match its schema" });
    // Whatever the header holds is cut to printable characters: a line break cannot get into a log.
    const noisy = await settle(answer(200, paid, bazaarHeader({ bazaar: { status: "rejected", rejectedReason: `bad${String.fromCharCode(10)}line${"x".repeat(300)}` } })));
    expect(noisy.kind === "paid" ? noisy.bazaar : "").toMatch(/^rejected: badline/);
    expect(noisy.kind === "paid" ? noisy.bazaar!.length : 999).toBeLessThanOrEqual(160);
    for (const header of [{ "extension-responses": "not base64 json" }, bazaarHeader({ other: { status: "success" } }), bazaarHeader({ bazaar: { status: 3 } }), { "extension-responses": "A".repeat(5_000) }, {}]) {
      expect(await settle(answer(200, paid, header))).toEqual({ kind: "paid", transaction: TX });
    }
  });

  it("is refused, with no charge, for the reasons that are the payer's, whatever the status: too little USDC, a payload or signature that is wrong, a payment to oneself, a screened wallet", async () => {
    const reasons = [
      "insufficient_funds",
      "invalid_payload",
      "invalid_exact_evm_payload_signature",
      "invalid_exact_evm_payload_authorization_value",
      "invalid_exact_evm_payload_authorization_valid_before",
      "invalid_exact_evm_payload_authorization_valid_after",
      "invalid_exact_evm_payload_undeployed_smart_wallet",
      "self_send_not_allowed",
      "kyt_risk_detected",
      "invalid_exact_evm_payload_authorization_from_address_kyt",
    ];
    for (const reason of reasons) {
      for (const status of [200, 400, 403]) expect(await settle(answer(status, { success: false, errorReason: reason, errorMessage: "words" })), `${reason} ${status}`).toEqual({ kind: "refused", reason });
    }
    // Coinbase says a declined payment is a 403 with kyt_risk_detected: under whichever name it comes.
    expect(await settle(answer(403, { errorType: "kyt_risk_detected", errorMessage: "declined" }))).toEqual({ kind: "refused", reason: "kyt_risk_detected" });
  });

  it("is unavailable, nothing charged and nobody told to pay again, for the reasons that are ours: our terms, our metadata, our request, our account or the place our server is", async () => {
    const reasons = [
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
    ];
    for (const reason of reasons) {
      for (const status of [200, 400, 403]) expect(await settle(answer(status, { success: false, errorReason: reason })), `${reason} ${status}`).toEqual({ kind: "unavailable", reason });
    }
    // A request Coinbase rejected with no settlement code is our request, not the payer's.
    expect(await settle(answer(400, { errorType: "invalid_request", errorMessage: "body is not valid" }))).toEqual({ kind: "unavailable", reason: "invalid_request" });
    expect(await settle(answer(400, "<html>bad request</html>"))).toEqual({ kind: "unavailable", reason: "HTTP 400" });
  });

  it("is pending, and never refused, when Coinbase says settlement_pending: an HTTP 500 that names the transaction", async () => {
    const pending = { success: false, errorReason: "settlement_pending", transaction: TX, network: BASE_MAINNET };
    for (const status of [500, 200]) expect(await settle(answer(status, pending)), String(status)).toMatchObject({ kind: "open", reason: "settlement_pending", pending: true, transaction: TX });
  });

  it("is open, never refused and never delivered, for everything that may hide a transfer", async () => {
    const hiding = ["settle_exact_evm_transaction_confirmation_timed_out", "settle_exact_node_failure", "settle_exact_failed_onchain", "smart_wallet_deployment_failed", "invalid_exact_evm_verification_failed", "unknown_error", "some_new_reason"];
    for (const reason of hiding) {
      for (const status of [400, 500]) expect(await settle(answer(status, { success: false, errorReason: reason })), `${reason} ${status}`).toMatchObject({ kind: "open", reason });
      expect(await settle(answer(500, { success: false, errorReason: reason, transaction: TX })), reason).toMatchObject({ kind: "open", reason, transaction: TX });
    }
    // A refusal or a problem of ours that names a transaction is not trusted: a transfer was broadcast.
    expect(await settle(answer(400, { success: false, errorReason: "invalid_payload", transaction: TX }))).toMatchObject({ kind: "open", transaction: TX });
    expect(await settle(answer(400, { success: false, errorReason: "invalid_scheme", transaction: TX }))).toMatchObject({ kind: "open", transaction: TX });
    for (const status of [404, 409, 429, 500, 502, 503]) expect((await settle(answer(status, { errorType: "internal_server_error" }))).kind, String(status)).toBe("open");
    expect(await settle(answer(200, "not json"))).toMatchObject({ kind: "open" });
    expect(await settle(answer(200, "[1,2]"))).toMatchObject({ kind: "open" });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await settle(down)).toEqual({ kind: "open", reason: "no answer from the payment service", noAnswer: true });
  });

  it("is unavailable, and not the payer's fault, when Coinbase refuses our token, or our account has no payment method", async () => {
    expect(await settle(answer(401, { errorType: "unauthorized", errorMessage: "bad token" }))).toEqual({ kind: "unavailable", reason: "unauthorized" });
    expect(await settle(answer(402, { errorType: "payment_method_required", errorMessage: "add a payment method" }))).toEqual({ kind: "unavailable", reason: "payment_method_required" });
    expect(await settle(answer(403, { errorType: "forbidden" }))).toEqual({ kind: "unavailable", reason: "forbidden" });
    expect(await settle(answer(401, ""))).toEqual({ kind: "unavailable", reason: "HTTP 401" });
  });

  it("keeps Coinbase's words short and printable, and never the key or a token, in what it reports", async () => {
    const long = "x".repeat(500);
    const results: Settled[] = [await settle(answer(500, { errorType: long })), await settle(answer(200, { success: false, errorReason: `weird${String.fromCharCode(10)}${long}` })), await settle(answer(200, { success: true, transaction: TX, network: long }))];
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text.length).toBeLessThan(400);
      expect(text).not.toContain(keys.env.CDP_API_KEY_SECRET);
      expect(text).not.toContain("Bearer");
    }
    expect(JSON.stringify(results[1])).not.toContain(`${String.fromCharCode(92)}n`);
  });

  it("sends nothing, and says so, when no CDP key is set", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await settle(fetchImpl, { ...both, cdp: null })).toEqual({ kind: "unavailable", reason: "no CDP key is set" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves Arc with Circle: its own address and its own key, as before", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, transaction: TX, network: ARC_MAINNET, payer }), { status: 200 })) as unknown as typeof fetch;
    expect(await settleOnRail(both, arcRail(both), "{}", payer, fetchImpl, 1_000)).toEqual({ kind: "paid", transaction: TX });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CIRCLE_FACILITATORS.production}/settle`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TEST_CIRCLE_KEY}`);
  });
});
