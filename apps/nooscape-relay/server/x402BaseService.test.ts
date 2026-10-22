import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexAnswer } from "./apiV1";
import { toChecksumAddress } from "./claimsCrypto";
import { llmsText, x402WellKnown } from "./discovery";
import { resetRateLimits } from "./rateLimit";
import { paymentsStatus } from "./routers/apiPayments";
import { ARC_MAINNET, ARC_USDC, BASE_MAINNET, BASE_USDC, CIRCLE_FACILITATORS, railsOf, type PaymentPayload, type X402Config, type X402Endpoint } from "./x402";
import { CDP_FACILITATOR_URL } from "./x402Cdp";
import type { Rpc } from "./x402Chain";
import { createPaymentService, paymentServiceFromEnv, type Charge, type PaymentService } from "./x402Service";
import { facilitatorAnswers, fakeChain, headerOf, memoryLedger, newBuyer, newCdpKeys, newContractBuyer, newFacilitator, testConfig, TEST_CIRCLE_KEY, TEST_PAY_TO } from "./x402Testing";

/**
 * What the server does with a payment on Base beside Arc (docs/x402-base-bazaar-2026-10-21.md): each payment goes to the facilitator that
 * settles its network and is recorded under that network; what protects a caller's money on Arc protects it on Base (settled once,
 * delivered only on a settlement, never refused after a send); a smart-contract wallet is never checked against Arc's node for a payment
 * on Base; and a setting for Base that is wrong never turns Arc off. Every key here is made for the test.
 */
const keys = newCdpKeys();
const cfg = testConfig(keys.env);
const RESOURCE = "https://nooscape.si/api/v1/check";
const CDP_SETTLE = `${CDP_FACILITATOR_URL}/settle`;
const TX = `0x${"5".repeat(64)}`;
const NOW = new Date("2026-10-21T00:00:00Z");

function setup(options: { script?: Parameters<typeof newFacilitator>[1]; rpc?: Rpc | null; config?: X402Config } = {}) {
  const config = options.config ?? cfg;
  const store = memoryLedger();
  const facilitator = newFacilitator(config, options.script);
  const clock = { ms: Date.now() };
  const service = createPaymentService({ config, ledger: store.ledger, fetchImpl: facilitator.fetchImpl, now: () => new Date(clock.ms), rpc: options.rpc });
  return { service, store, facilitator, clock, buyer: newBuyer() };
}

async function accepted(service: PaymentService, payment: PaymentPayload, endpoint: X402Endpoint = "check", resource = RESOURCE) {
  const result = await service.verify(endpoint, headerOf(payment), resource);
  if (!result.ok) throw new Error(`not accepted: ${JSON.stringify(result.reply.body)}`);
  return result.context;
}

const said = (charge: Charge) => (charge.deliver ? "" : JSON.stringify(charge.reply.body));
const statusOf = (charge: Charge) => (charge.deliver ? 200 : charge.reply.status);
const pending = () => facilitatorAnswers.status(500, { success: false, errorReason: "settlement_pending", transaction: TX, network: BASE_MAINNET });

beforeEach(() => {
  resetRateLimits();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("a payment on Base", () => {
  it("is settled once through Coinbase, with the Bazaar's metadata, delivered, and recorded under Base", async () => {
    const { service, store, facilitator, buyer } = setup();
    const charge = await service.charge(await accepted(service, buyer.pay(cfg, "check", { network: BASE_MAINNET })), "subject");
    expect(charge.deliver).toBe(true);
    expect(facilitator.calls.map(call => call.url)).toEqual([CDP_SETTLE]);
    const bearer = facilitator.calls[0]!.authorization!;
    expect(bearer.startsWith("Bearer ")).toBe(true);
    expect(bearer.split(".")).toHaveLength(3);
    expect(Object.keys(facilitator.calls[0]!.body.paymentPayload.extensions)).toEqual(["bazaar"]);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ network: BASE_MAINNET, status: "paid", endpoint: "check", amount: 10000, payer: buyer.address.toLowerCase() });
    if (!charge.deliver) throw new Error("not delivered");
    expect(JSON.parse(Buffer.from(charge.headers["payment-response"]!, "base64").toString("utf8"))).toEqual({ success: true, transaction: store.rows[0]!.transaction, network: BASE_MAINNET, payer: buyer.address.toLowerCase() });
    const logged = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(logged).toContain(`on ${BASE_MAINNET} (bazaar: processing)`);
    expect(logged.toLowerCase()).not.toContain(buyer.address.toLowerCase());
  });

  it("leaves a payment on Arc with Circle, with its own key and its own idempotency key, in the same service", async () => {
    const { service, store, facilitator, buyer } = setup();
    const charge = await service.charge(await accepted(service, buyer.pay(cfg, "check", { network: ARC_MAINNET })), "subject");
    expect(charge.deliver).toBe(true);
    expect(facilitator.calls[0]!.url).toBe(`${CIRCLE_FACILITATORS.production}/settle`);
    expect(facilitator.calls[0]!.authorization).toBe(`Bearer ${TEST_CIRCLE_KEY}`);
    expect(Object.keys(facilitator.calls[0]!.body.paymentPayload.extensions)).toEqual(["payment-identifier"]);
    expect(store.rows[0]).toMatchObject({ network: ARC_MAINNET, status: "paid" });
  });

  it("is a payment of its own: the same wallet and nonce on Base and on Arc are two payments, each settled and recorded", async () => {
    const { service, store, facilitator, buyer } = setup();
    const nonce = `0x${"ab".repeat(32)}`;
    const onBase = await service.charge(await accepted(service, buyer.pay(cfg, "check", { network: BASE_MAINNET, nonce })), "s");
    const onArc = await service.charge(await accepted(service, buyer.pay(cfg, "check", { network: ARC_MAINNET, nonce })), "s");
    expect([onBase.deliver, onArc.deliver]).toEqual([true, true]);
    expect(store.rows.map(row => row.network).sort()).toEqual([ARC_MAINNET, BASE_MAINNET]);
    expect(facilitator.calls).toHaveLength(2);
  });

  it("is served again without a second settlement when it is sent again after it was delivered, and is never used for another request", async () => {
    const { service, facilitator, buyer } = setup();
    const payment = buyer.pay(cfg, "check", { network: BASE_MAINNET });
    const first = await service.charge(await accepted(service, payment), "request-a");
    const again = await service.charge(await accepted(service, payment), "request-a");
    expect([first.deliver, again.deliver]).toEqual([true, true]);
    expect(facilitator.calls).toHaveLength(1);
    const other = await service.charge(await accepted(service, payment), "request-b");
    expect(other.deliver).toBe(false);
    expect(said(other)).toContain("attached to a different request");
    expect(facilitator.calls).toHaveLength(1);
  });

  it("stays open when Coinbase says the settlement is pending, is not delivered, and settles when the same payment is sent again", async () => {
    const { service, store, facilitator, buyer } = setup({ script: [pending()] });
    const payment = buyer.pay(cfg, "check", { network: BASE_MAINNET });
    const first = await service.charge(await accepted(service, payment), "s");
    expect(first.deliver).toBe(false);
    expect(statusOf(first)).toBe(503);
    expect(said(first)).toContain("has not settled yet");
    expect(store.rows[0]).toMatchObject({ status: "open", transaction: TX, sends: 1 });
    const second = await service.charge(await accepted(service, payment), "s");
    expect(second.deliver).toBe(true);
    expect(facilitator.calls).toHaveLength(2);
    expect(store.rows[0]).toMatchObject({ status: "paid", sends: 2 });
  });

  it("is never delivered and never refused when its first answer was lost and Coinbase refuses the second send, as it refuses the replay of a payment that settled", async () => {
    // Coinbase has no idempotency key: sent again, a payment it already settled comes back as invalid_payload (the fake does the same).
    const { service, store, buyer } = setup({ script: ["lost"] });
    const payment = buyer.pay(cfg, "check", { network: BASE_MAINNET });
    const first = await service.charge(await accepted(service, payment), "s");
    expect(first.deliver).toBe(false);
    expect(statusOf(first)).toBe(503);
    expect(store.rows[0]).toMatchObject({ status: "open", sends: 1 });
    const second = await service.charge(await accepted(service, payment), "s");
    expect(second.deliver).toBe(false);
    expect(statusOf(second)).toBe(402);
    expect(said(second)).toContain("could not be confirmed");
    expect(said(second)).toContain("Check your wallet before paying again");
    expect(said(second)).toContain(store.rows[0]!.paymentId);
    expect(store.rows[0]).toMatchObject({ status: "open", reason: "refused on resend: invalid_payload", sends: 2 });
  });

  it("is refused at once, with nothing recorded as paid, when Coinbase refuses it on the first send: the caller may sign again", async () => {
    const { service, store, buyer } = setup({ script: [facilitatorAnswers.refused("insufficient_funds")] });
    const charge = await service.charge(await accepted(service, buyer.pay(cfg, "check", { network: BASE_MAINNET })), "s");
    expect(charge.deliver).toBe(false);
    expect(statusOf(charge)).toBe(402);
    expect(said(charge)).toContain("Nothing was charged");
    expect(store.rows[0]).toMatchObject({ status: "refused", reason: "insufficient_funds" });
  });

  it("is told the service is down, with nothing charged, when Coinbase refuses our token or our account has no payment method", async () => {
    const { service, store, buyer } = setup({ script: [facilitatorAnswers.status(402, { errorType: "payment_method_required" })] });
    const charge = await service.charge(await accepted(service, buyer.pay(cfg, "check", { network: BASE_MAINNET })), "s");
    expect(charge.deliver).toBe(false);
    expect(statusOf(charge)).toBe(503);
    expect(said(charge)).toContain("Nothing was charged");
    expect(store.rows[0]).toMatchObject({ status: "open", reason: "not settled: payment_method_required" });
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain("refused our credentials, terms or address (payment_method_required)");
  });

  it("is sent the terms again, with nothing recorded or sent, when a context names a network we do not take", async () => {
    const { service, store, facilitator, buyer } = setup();
    const context = await accepted(service, buyer.pay(cfg, "check", { network: BASE_MAINNET }));
    const foreign = { ...context, payment: { ...context.payment, accepted: { ...context.payment.accepted, network: "eip155:1" } } };
    const charge = await service.charge(foreign, "s");
    expect(charge.deliver).toBe(false);
    expect(statusOf(charge)).toBe(402);
    expect(said(charge)).toContain("payment terms do not match this resource");
    expect(store.rows).toHaveLength(0);
    expect(facilitator.calls).toHaveLength(0);
  });

  it("is not taken from a smart-contract wallet, and Arc's node is never asked about it, though the same wallet is checked on Arc", async () => {
    const chain = fakeChain();
    const { service } = setup({ rpc: chain.rpc });
    const wallet = newContractBuyer();
    const onBase = await service.verify("check", headerOf(wallet.pay(cfg, "check", { network: BASE_MAINNET })), RESOURCE);
    expect(onBase.ok).toBe(false);
    if (!onBase.ok) {
      expect(onBase.reply.status).toBe(402);
      expect(JSON.stringify(onBase.reply.body)).toContain("smart-contract wallets are not accepted");
    }
    expect(chain.calls).toHaveLength(0);
    const onArc = await service.verify("check", headerOf(wallet.pay(cfg, "check", { network: ARC_MAINNET })), RESOURCE);
    expect(onArc.ok).toBe(true);
    expect(chain.calls.length).toBeGreaterThan(0);
  });

  it("is refused where Base is not set, with terms that offer Arc only", async () => {
    const { service } = setup({ config: testConfig() });
    const result = await service.verify("check", headerOf(newBuyer().pay(cfg, "check", { network: BASE_MAINNET })), RESOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reply.status).toBe(402);
      expect(JSON.stringify(result.reply.body)).toContain("Base is not being taken right now");
      expect((result.reply.body as { accepts: Array<{ network: string }> }).accepts.map(item => item.network)).toEqual([ARC_MAINNET]);
    }
  });

  it("is still counted, listed and looked at when Base is switched off, and its caller is told how to find the payment", async () => {
    const { service, store, buyer, clock } = setup({ script: [pending()] });
    const payment = buyer.pay(cfg, "check", { network: BASE_MAINNET });
    expect((await service.charge(await accepted(service, payment), "s")).deliver).toBe(false);
    expect(store.rows[0]).toMatchObject({ network: BASE_MAINNET, status: "open" });
    // Base goes off (the key is removed, or its secret is mistyped): the same ledger, a service for Arc alone.
    const off = createPaymentService({ config: testConfig(), ledger: store.ledger, fetchImpl: newFacilitator(testConfig()).fetchImpl, now: () => new Date(clock.ms) });
    clock.ms += 61 * 60 * 1000;
    expect(await off.staleCount()).toBe(1);
    const status = await paymentsStatus(off, store.ledger, () => new Date(clock.ms));
    expect(status).toMatchObject({ state: "on", networks: [ARC_MAINNET], stale: 1, unresolved: { total: 1 } });
    if (!("recent" in status)) throw new Error("no detail");
    expect(status.unresolved.rows[0]).toMatchObject({ network: BASE_MAINNET, status: "open" });
    const retry = await off.verify("check", headerOf(payment), RESOURCE);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(JSON.stringify(retry.reply.body)).toContain("quote the payment id you were given");
  });

  it("keeps the first transaction a payment named when a later send names another, and says so in the reason", async () => {
    const second = `0x${"6".repeat(64)}`;
    const { service, store, buyer } = setup({ script: [pending(), facilitatorAnswers.status(500, { success: false, errorReason: "settle_exact_failed_onchain", transaction: second, network: BASE_MAINNET })] });
    const payment = buyer.pay(cfg, "check", { network: BASE_MAINNET });
    await service.charge(await accepted(service, payment), "s");
    expect(store.rows[0]).toMatchObject({ status: "open", transaction: TX });
    await service.charge(await accepted(service, payment), "s");
    // The first transaction may be the one that moved the money: it is the one the operator is shown.
    expect(store.rows[0]).toMatchObject({ status: "open", transaction: TX });
    expect(store.rows[0]!.reason).toContain("failed after broadcast: settle_exact_failed_onchain");
    expect(store.rows[0]!.reason).toContain(`a later send named ${second}`);
  });

  it("does not tell a caller that nothing was charged when a later send is refused for our credentials after a first answer was lost", async () => {
    const { service, store, buyer } = setup({ script: ["lost", facilitatorAnswers.status(401, { errorType: "unauthorized" })] });
    const payment = buyer.pay(cfg, "check", { network: BASE_MAINNET });
    await service.charge(await accepted(service, payment), "s");
    const second = await service.charge(await accepted(service, payment), "s");
    expect(second.deliver).toBe(false);
    expect(statusOf(second)).toBe(503);
    expect(said(second)).toContain("could not be confirmed right now");
    expect(said(second)).toContain(store.rows[0]!.paymentId);
    expect(said(second)).not.toContain("Nothing was charged");
    expect(store.rows[0]).toMatchObject({ status: "open", reason: "not settled: unauthorized" });
  });

  it("refuses a screened wallet at once, and shows a problem of ours as unavailable with the payment left open for the operator", async () => {
    const screened = setup({ script: [facilitatorAnswers.status(403, { errorReason: "kyt_risk_detected" })] });
    const charge = await screened.service.charge(await accepted(screened.service, screened.buyer.pay(cfg, "check", { network: BASE_MAINNET })), "s");
    expect(statusOf(charge)).toBe(402);
    expect(said(charge)).toContain("Nothing was charged");
    expect(screened.store.rows[0]).toMatchObject({ status: "refused", reason: "kyt_risk_detected" });
    const ours = setup({ script: [facilitatorAnswers.status(400, { success: false, errorReason: "invalid_bazaar_extension" })] });
    const other = await ours.service.charge(await accepted(ours.service, ours.buyer.pay(cfg, "check", { network: BASE_MAINNET })), "s");
    expect(statusOf(other)).toBe(503);
    expect(said(other)).toContain("Nothing was charged");
    expect(ours.store.rows[0]).toMatchObject({ status: "open", reason: "not settled: invalid_bazaar_extension" });
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain("invalid_bazaar_extension");
  });

  it("is counted with Arc's when a payment has been unresolved for over an hour", async () => {
    const { service, clock, buyer } = setup({ script: [pending(), pending()] });
    await service.charge(await accepted(service, buyer.pay(cfg, "check", { network: BASE_MAINNET })), "s");
    await service.charge(await accepted(service, buyer.pay(cfg, "check", { network: ARC_MAINNET })), "s");
    clock.ms += 61 * 60 * 1000;
    expect(await service.staleCount()).toBe(2);
  });
});

describe("the terms the service offers", () => {
  it("name Base first and Arc second", () => {
    const { service } = setup();
    const offer = service.offer("check", RESOURCE, "PAYMENT-SIGNATURE header is required");
    expect((offer.body as { accepts: Array<{ network: string }> }).accepts.map(item => item.network)).toEqual([BASE_MAINNET, ARC_MAINNET]);
  });
});

describe("the service from the environment", () => {
  const arcEnv = { X402_NETWORK: ARC_MAINNET, X402_PAY_TO: TEST_PAY_TO, X402_API_KEY: TEST_CIRCLE_KEY };

  it("keeps Arc on, says why Base is off, and never logs the secret, when the CDP setting is wrong", () => {
    const service = paymentServiceFromEnv({ ...arcEnv, CDP_API_KEY_ID: keys.env.CDP_API_KEY_ID, CDP_API_KEY_SECRET: "not-a-key-0123456789" } as NodeJS.ProcessEnv, memoryLedger().ledger);
    expect(service).not.toBeNull();
    expect(railsOf(service!.config).map(rail => rail.network)).toEqual([ARC_MAINNET]);
    const logged = [console.log, console.error].flatMap(spy => vi.mocked(spy).mock.calls.flat()).join(" ");
    expect(logged).toContain("configured for eip155:5042");
    expect(logged).toContain("Base is not offered: CDP_API_KEY_SECRET must be");
    expect(logged).not.toContain("not-a-key-0123456789");
  });

  it("says both networks when the CDP setting is right, and nothing about Base when it is not set", () => {
    const withBase = paymentServiceFromEnv({ ...arcEnv, ...keys.env } as NodeJS.ProcessEnv, memoryLedger().ledger);
    expect(railsOf(withBase!.config).map(rail => rail.network)).toEqual([BASE_MAINNET, ARC_MAINNET]);
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("configured for eip155:8453 and eip155:5042");
    vi.mocked(console.log).mockClear();
    vi.mocked(console.error).mockClear();
    paymentServiceFromEnv(arcEnv as NodeJS.ProcessEnv, memoryLedger().ledger);
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("configured for eip155:5042;");
  });
});

describe("what is published about Base", () => {
  it("is in the index for each network, in the order of the 402, with only Arc able to take a smart-contract wallet", () => {
    const pay = indexAnswer(NOW, cfg).pay_per_call!;
    expect(pay).toMatchObject({ network: BASE_MAINNET, asset: BASE_USDC, pay_to: toChecksumAddress(TEST_PAY_TO), wallets: ["regular"] });
    expect(pay.networks).toEqual([
      { network: BASE_MAINNET, asset: BASE_USDC, pay_to: toChecksumAddress(TEST_PAY_TO), wallets: ["regular"] },
      { network: ARC_MAINNET, asset: ARC_USDC, pay_to: TEST_PAY_TO, wallets: ["regular"] },
    ]);
    const withNode = indexAnswer(NOW, testConfig({ ...keys.env, X402_RPC: "https://rpc.example.org/arc" })).pay_per_call!;
    expect(withNode.networks.map(item => item.wallets)).toEqual([["regular"], ["regular", "smart_contract"]]);
    expect(withNode.wallets).toEqual(["regular"]);
    // Arc alone is the index it always was, with the one network listed.
    const arcOnly = indexAnswer(NOW, testConfig()).pay_per_call!;
    expect(arcOnly).toMatchObject({ network: ARC_MAINNET, asset: ARC_USDC, pay_to: TEST_PAY_TO, networks: [{ network: ARC_MAINNET, asset: ARC_USDC, pay_to: TEST_PAY_TO, wallets: ["regular"] }] });
  });

  it("is on the page for a model, a line for each network, and the discovery document for indexers is the one it was, with the standard part listing the terms of each network", () => {
    const text = llmsText(indexAnswer(NOW, cfg));
    expect(text).toContain(`Network: Base (eip155:8453). Asset: USDC at ${BASE_USDC}. Pay to: ${toChecksumAddress(TEST_PAY_TO)}. Wallets: regular wallets.`);
    expect(text).toContain(`Network: Arc mainnet (eip155:5042). Asset: USDC at ${ARC_USDC}. Pay to: ${TEST_PAY_TO}. Wallets: regular wallets.`);
    expect(text.indexOf("Network: Base")).toBeLessThan(text.indexOf("Network: Arc mainnet"));
    // The x402scan form is the same with Base on or off; the standard items list the terms of each network that takes payment, Arc first.
    const withBase = x402WellKnown(cfg, NOW);
    const arcOnly = x402WellKnown(testConfig(), NOW);
    expect({ ...withBase, items: null }).toEqual({ ...arcOnly, items: null });
    expect(withBase.items[0]!.accepts.map(terms => terms.network)).toEqual([ARC_MAINNET, BASE_MAINNET]);
    expect(arcOnly.items[0]!.accepts.map(terms => terms.network)).toEqual([ARC_MAINNET]);
  });
});

describe("the operator's view with Base on", () => {
  it("names both networks, adds up their totals, lists their payments together with the network of each, and never a key", async () => {
    const { service, store, buyer } = setup();
    await service.charge(await accepted(service, buyer.pay(cfg, "check", { network: BASE_MAINNET })), "s");
    await service.charge(await accepted(service, buyer.pay(cfg, "check", { network: ARC_MAINNET })), "s");
    const ledger = { ...store.ledger, summary: async (network: string) => [{ status: "paid", count: network === BASE_MAINNET ? 2 : 1, amount: network === BASE_MAINNET ? 20000 : 10000 }] };
    const status = await paymentsStatus(service, ledger);
    expect(status).toMatchObject({ state: "on", network: ARC_MAINNET, networks: [BASE_MAINNET, ARC_MAINNET], payTo: TEST_PAY_TO, summary: [{ status: "paid", count: 3, amount: 30000 }] });
    if (!("recent" in status)) throw new Error("no detail");
    expect(status.recent.map(row => row.network)).toEqual([ARC_MAINNET, BASE_MAINNET]);
    const text = JSON.stringify(status);
    expect(text).not.toContain(TEST_CIRCLE_KEY);
    expect(text).not.toContain(keys.env.CDP_API_KEY_SECRET);
  });
});
