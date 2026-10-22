import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARC_MAINNET, ARC_USDC } from "./x402";
import { resetRateLimits } from "./rateLimit";
import { MAX_IN_FLIGHT, MAX_NEW_PER_MINUTE, MAX_SENDS, MAX_SERVES, STALE_AFTER_MS, createPaymentService, type Charge, type PayContext } from "./x402Service";
import { facilitatorAnswers, headerOf, memoryLedger, newBuyer, newFacilitator, testConfig, TEST_CIRCLE_KEY } from "./x402Testing";

/**
 * What the server does with a payment (docs/data-access-2026-10-19.md, stage D4), against a ledger kept in memory with the database
 * ledger's rules and a facilitator that answers as it is told. The point of every case is the caller's money: a payment settles once,
 * is delivered only when settled, and is never given up on while it may have settled.
 */
const RESOURCE = "https://nooscape.si/api/v1/check";
const cfg = testConfig();

function setup(options: { script?: Parameters<typeof newFacilitator>[1]; config?: ReturnType<typeof testConfig>; ready?: boolean } = {}) {
  const config = options.config ?? cfg;
  const store = memoryLedger({ ready: options.ready });
  const facilitator = newFacilitator(config, options.script);
  const clock = { ms: Date.now() };
  const service = createPaymentService({ config, ledger: store.ledger, fetchImpl: facilitator.fetchImpl, now: () => new Date(clock.ms) });
  const buyer = newBuyer();
  const context = (endpoint: "agent" | "check" = "check", over: Parameters<typeof buyer.pay>[2] = {}, from = buyer): PayContext => {
    const payment = from.pay(config, endpoint, over);
    const accepted = service.accept(endpoint, headerOf(payment), RESOURCE);
    if (!accepted.ok) throw new Error(`not accepted: ${JSON.stringify(accepted.reply.body)}`);
    return accepted.context;
  };
  return { service, store, facilitator, buyer, context, config, clock };
}

/** Everything a refusal says, as text. */
const said = (charge: Charge) => (charge.deliver ? "" : JSON.stringify(charge.reply.body));
const statusOf = (charge: Charge) => (charge.deliver ? 200 : charge.reply.status);
const paymentResponse = (charge: Charge) => (charge.deliver ? JSON.parse(Buffer.from(charge.headers["payment-response"]!, "base64").toString("utf8")) : null);

beforeEach(() => {
  resetRateLimits();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("whether pay per call is on", () => {
  it("is off while the table is missing, paused when the pause is set, and on otherwise", async () => {
    expect(await setup({ ready: false }).service.state()).toBe("off");
    expect(await setup({ config: testConfig({ X402_PAUSE_NEW: "1" }) }).service.state()).toBe("paused");
    expect(await setup().service.state()).toBe("on");
  });
});

describe("accepting a payment header, before anything is recorded", () => {
  it("takes a payment on our terms signed by its payer, and refuses anything else with the terms again and a reason", () => {
    const { service, buyer } = setup();
    expect(service.accept("check", headerOf(buyer.pay(cfg, "check")), RESOURCE).ok).toBe(true);
    for (const bad of ["", "###", headerOf(buyer.pay(cfg, "agent")), headerOf({ ...buyer.pay(cfg, "check"), x402Version: 1 } as never)]) {
      const result = service.accept("check", bad, RESOURCE);
      expect(result.ok, bad.slice(0, 12)).toBe(false);
      if (!result.ok) {
        expect(result.reply.status).toBe(402);
        expect(result.reply.headers["payment-required"]).toBeTruthy();
      }
    }
    const forged = buyer.pay(cfg, "check");
    forged.payload.authorization.value = forged.accepted.amount;
    forged.payload.authorization.nonce = `0x${"ee".repeat(32)}`;
    const refused = service.accept("check", headerOf(forged), RESOURCE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect((refused.reply.body as { error: string }).error).toMatch(/signature/);
  });
});

describe("a new payment", () => {
  it("is recorded before it is sent, settled once with the right credentials, and delivered with the transaction named", async () => {
    const { service, store, facilitator, context } = setup();
    const ctx = context();
    const charge = await service.charge(ctx, "check|agent|robinhood|1");
    expect(charge.deliver).toBe(true);
    expect(facilitator.calls).toHaveLength(1);
    expect(facilitator.calls[0]).toMatchObject({ url: `${cfg.facilitator}/settle`, authorization: `Bearer ${TEST_CIRCLE_KEY}` });
    const row = store.rows[0]!;
    expect(row).toMatchObject({ status: "paid", endpoint: "check", payer: ctx.payment.payload.authorization.from.toLowerCase(), amount: 10000, sends: 1, serves: 1, network: ARC_MAINNET });
    expect(row.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(row.paymentId).toBe(facilitator.calls[0]!.body.paymentPayload.extensions["payment-identifier"].info.id);
    expect(paymentResponse(charge)).toEqual({ success: true, transaction: row.transaction, network: ARC_MAINNET, payer: row.payer });
    expect(JSON.stringify(row)).not.toContain(ctx.payment.payload.signature);
    expect(charge.deliver && charge.headers["cache-control"]).toBe("no-store");
  });

  it("is a lookup at the lookup's price and a check at the check's price", async () => {
    const { service, store, context } = setup();
    await service.charge(context("agent"), "agent|robinhood|1");
    await service.charge(context("check"), "check|x");
    expect(store.rows.map(row => [row.endpoint, row.amount])).toEqual([["agent", 5000], ["check", 10000]]);
  });

  it("is never settled twice when the same request arrives again: the caller is served again for the same payment, a limited number of times", async () => {
    const { service, store, facilitator, context } = setup();
    const ctx = context();
    const first = await service.charge(ctx, "s");
    for (let serves = 2; serves <= MAX_SERVES; serves += 1) expect((await service.charge(ctx, "s")).deliver, `serve ${serves}`).toBe(true);
    const spent = await service.charge(ctx, "s");
    expect(spent.deliver).toBe(false);
    expect(said(spent)).toMatch(/already been used/);
    expect(facilitator.calls).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.serves).toBe(MAX_SERVES);
    expect(paymentResponse(first).transaction).toBe(store.rows[0]!.transaction);
  });

  it("is never served after its authorization ran out, even if it was paid", async () => {
    const { service, facilitator, context, clock } = setup();
    const ctx = context("check", { validFor: 120 });
    expect((await service.charge(ctx, "s")).deliver).toBe(true);
    clock.ms += 121_000;
    const late = await service.charge(ctx, "s");
    expect(late.deliver).toBe(false);
    expect(said(late)).toMatch(/already been used/);
    expect(facilitator.calls).toHaveLength(1);
  });

  it("is used for the request it was sent with and no other, even when it is paid", async () => {
    const { service, facilitator, context } = setup();
    const ctx = context();
    await service.charge(ctx, "the first request");
    const other = await service.charge(ctx, "another request");
    expect(other.deliver).toBe(false);
    expect(statusOf(other)).toBe(402);
    expect(said(other)).toMatch(/different request/);
    expect(facilitator.calls).toHaveLength(1);
  });

  it("is one record, one settlement and two answers when two requests carry it at once", async () => {
    const { service, store, facilitator, context } = setup();
    const ctx = context();
    const [one, two] = await Promise.all([service.charge(ctx, "s"), service.charge(ctx, "s")]);
    expect([one.deliver, two.deliver]).toEqual([true, true]);
    expect(facilitator.calls).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.serves).toBe(2);
  });

  it("is the same authorization whatever the case of the payer's address or the nonce", async () => {
    const { service, store, facilitator, context } = setup();
    const ctx = context();
    await service.charge(ctx, "s");
    const upper: PayContext = {
      ...ctx,
      payment: { ...ctx.payment, payload: { ...ctx.payment.payload, authorization: { ...ctx.payment.payload.authorization, from: `0x${ctx.payment.payload.authorization.from.slice(2).toUpperCase()}`, nonce: `0x${ctx.payment.payload.authorization.nonce.slice(2).toUpperCase()}` } } },
    };
    expect((await service.charge(upper, "s")).deliver).toBe(true);
    expect(facilitator.calls).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
  });

  it("is found, not settled again, when another process recorded it between the look and the insert", async () => {
    const { service, store, facilitator, context } = setup();
    const ctx = context();
    await service.charge(ctx, "s");
    store.fail.hideNextFind = true;
    expect((await service.charge(ctx, "s")).deliver).toBe(true);
    expect(facilitator.calls).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
  });

  it("is turned away before anything is recorded when its authorization is about to run out", async () => {
    const { service, store, facilitator, context } = setup();
    const charge = await service.charge(context("check", { validFor: 5 }), "s");
    expect(charge.deliver).toBe(false);
    expect(!charge.deliver && charge.reply.status).toBe(402);
    expect(store.rows).toHaveLength(0);
    expect(facilitator.calls).toHaveLength(0);
  });
});

describe("a payment the facilitator refused", () => {
  it("is final: nothing is delivered, the row is refused with the reason, and the same authorization is not sent again", async () => {
    const { service, store, facilitator, context } = setup({ script: [facilitatorAnswers.refused("insufficient_funds")] });
    const ctx = context();
    const first = await service.charge(ctx, "s");
    expect(first.deliver).toBe(false);
    expect(!first.deliver && first.reply.status).toBe(402);
    expect(store.rows[0]).toMatchObject({ status: "refused", reason: "insufficient_funds", transaction: null });
    const again = await service.charge(ctx, "s");
    expect(again.deliver).toBe(false);
    expect(facilitator.calls).toHaveLength(1);
  });
});

describe("a payment the facilitator did not decide", () => {
  it("is never delivered and never refused while it is pending, and is sent again with the same key until it settles", async () => {
    const { service, store, facilitator, context } = setup({ script: [facilitatorAnswers.pending(), facilitatorAnswers.pending(`0x${"5".repeat(64)}`)] });
    const ctx = context();
    const one = await service.charge(ctx, "s");
    expect(!one.deliver && one.reply.status).toBe(503);
    expect(!one.deliver && (one.reply.body as { error: { payment_id: string } }).error.payment_id).toBe(store.rows[0]!.paymentId);
    expect(store.rows[0]).toMatchObject({ status: "open", sends: 1 });
    const two = await service.charge(ctx, "s");
    expect(two.deliver).toBe(false);
    expect(store.rows[0]).toMatchObject({ status: "open", sends: 2, transaction: `0x${"5".repeat(64)}` });
    const three = await service.charge(ctx, "s");
    expect(three.deliver).toBe(true);
    expect(store.rows[0]).toMatchObject({ status: "paid", sends: 3, serves: 1 });
    expect(new Set(facilitator.calls.map(call => call.body.paymentPayload.extensions["payment-identifier"].info.id)).size).toBe(1);
  });

  it("is delivered once, and charged once, when it settled but the answer never came back", async () => {
    const { service, store, facilitator, context } = setup({ script: ["lost"] });
    const ctx = context();
    const lost = await service.charge(ctx, "s");
    expect(lost.deliver).toBe(false);
    expect(store.rows[0]).toMatchObject({ status: "open", reason: "no answer from the payment service" });
    const retry = await service.charge(ctx, "s");
    expect(retry.deliver).toBe(true);
    expect(facilitator.settled.size).toBe(1);
    expect(store.rows[0]!.transaction).toBe(Array.from(facilitator.settled.values())[0]);
  });

  it("stops being sent after a few tries, says it could not be confirmed, and gives the caller the id to quote", async () => {
    const pending = facilitatorAnswers.pending();
    const { service, store, facilitator, context } = setup({ script: Array.from({ length: MAX_SENDS }, () => pending) });
    const ctx = context();
    for (let attempt = 1; attempt <= MAX_SENDS; attempt += 1) expect((await service.charge(ctx, "s")).deliver).toBe(false);
    expect(facilitator.calls).toHaveLength(MAX_SENDS);
    const last = await service.charge(ctx, "s");
    expect(last.deliver).toBe(false);
    expect(statusOf(last)).toBe(503);
    expect(said(last)).toContain(store.rows[0]!.paymentId);
    expect(said(last)).toMatch(/could not be confirmed/);
    expect(facilitator.calls).toHaveLength(MAX_SENDS);
    expect(store.rows[0]!.status).toBe("open");
  });

  it("is not called refused when a later send says so: it stays open, because the first send may have settled", async () => {
    const { service, store, context } = setup({ script: [facilitatorAnswers.pending(), facilitatorAnswers.refused("invalid_exact_evm_payload_authorization_valid_before")] });
    const ctx = context();
    await service.charge(ctx, "s");
    const second = await service.charge(ctx, "s");
    expect(second.deliver).toBe(false);
    expect(statusOf(second)).toBe(402);
    expect(store.rows[0]).toMatchObject({ status: "open" });
    expect(store.rows[0]!.reason).toContain("refused on resend");
    expect(said(second)).toContain(store.rows[0]!.paymentId);
  });

  it("never forgets a transaction the facilitator named, whatever a later send says", async () => {
    const tx = `0x${"5".repeat(64)}`;
    const { service, store, context } = setup({ script: [facilitatorAnswers.pending(tx), facilitatorAnswers.down(), facilitatorAnswers.status(409, { message: "conflict" })] });
    const ctx = context();
    await service.charge(ctx, "s");
    expect(store.rows[0]).toMatchObject({ status: "open", transaction: tx });
    await service.charge(ctx, "s");
    expect(store.rows[0]).toMatchObject({ status: "open", transaction: tx });
    await service.charge(ctx, "s");
    expect(store.rows[0]).toMatchObject({ status: "open", transaction: tx });
  });

  it("treats a key the facilitator does not accept (401) as our own fault, like a refused address", async () => {
    const { service, store, context } = setup({ script: [facilitatorAnswers.status(401, { message: "unauthorized" })] });
    const charge = await service.charge(context(), "s");
    expect(statusOf(charge)).toBe(503);
    expect(!charge.deliver && charge.reply.headers["retry-after"]).toBe("60");
    expect(said(charge)).toMatch(/Nothing was charged/);
    expect(store.rows[0]).toMatchObject({ status: "open" });
    expect(console.error).toHaveBeenCalled();
  });

  it("is not the caller's fault when the facilitator refuses our own credentials: the row stays open, and the caller is told nothing was charged", async () => {
    const { service, store, context } = setup({ script: [facilitatorAnswers.status(403, { errors: [{ reason: "forbidden" }] })] });
    const ctx = context();
    const charge = await service.charge(ctx, "s");
    expect(!charge.deliver && charge.reply.status).toBe(503);
    expect(!charge.deliver && charge.reply.headers["retry-after"]).toBe("60");
    expect(store.rows[0]).toMatchObject({ status: "open" });
    expect(store.rows[0]!.reason).toContain("forbidden");
    expect(console.error).toHaveBeenCalled();
    // It settles when the facilitator accepts us again.
    expect((await service.charge(ctx, "s")).deliver).toBe(true);
  });
});

describe("the limits and the switch", () => {
  it("takes no new payment while paused, and still resolves one already recorded", async () => {
    const live = setup({ script: [facilitatorAnswers.pending()] });
    const ctx = live.context();
    await live.service.charge(ctx, "s");
    expect(live.store.rows[0]!.status).toBe("open");
    // The same ledger, a paused service.
    const pausedConfig = testConfig({ X402_PAUSE_NEW: "1" });
    const paused = createPaymentService({ config: pausedConfig, ledger: live.store.ledger, fetchImpl: live.facilitator.fetchImpl });
    expect((await paused.charge(ctx, "s")).deliver).toBe(true);
    const fresh = await paused.charge({ ...ctx, payment: live.buyer.pay(cfg, "check") }, "s");
    expect(statusOf(fresh)).toBe(503);
    expect(said(fresh)).toMatch(/paused/);
    expect(live.store.rows).toHaveLength(1);
    expect(live.facilitator.calls).toHaveLength(2);
  });

  it("settles at most eight payments at once and tells the ninth to try again, without recording it", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    const hang = Array.from({ length: MAX_IN_FLIGHT }, () => async () => {
      await gate;
      return Response.json({ success: false, errorReason: "settlement_pending" });
    });
    const { service, store, context } = setup({ script: hang });
    const running = Array.from({ length: MAX_IN_FLIGHT }, () => service.charge(context(), "s"));
    await vi.waitFor(() => expect(store.rows).toHaveLength(MAX_IN_FLIGHT));
    const ninth = await service.charge(context(), "s");
    expect(!ninth.deliver && ninth.reply.status).toBe(503);
    expect(store.rows).toHaveLength(MAX_IN_FLIGHT);
    release();
    await Promise.all(running);
    expect((await service.charge(context(), "s")).deliver).toBe(true);
  });
});

describe("a burst", () => {
  it("never has more than eight settlements under way, however many requests arrive at the same moment, and records only those", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    const hang = Array.from({ length: 40 }, () => async () => {
      await gate;
      return Response.json({ success: false, errorReason: "settlement_pending" });
    });
    const { service, store, facilitator, context } = setup({ script: hang });
    const contexts = Array.from({ length: 40 }, () => context());
    const running = contexts.map(ctx => service.charge(ctx, "s"));
    await vi.waitFor(() => expect(facilitator.calls.length).toBeGreaterThanOrEqual(MAX_IN_FLIGHT));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(facilitator.calls).toHaveLength(MAX_IN_FLIGHT);
    expect(store.rows).toHaveLength(MAX_IN_FLIGHT);
    release();
    const done = await Promise.all(running);
    expect(done.filter(charge => !charge.deliver && charge.reply.status === 503)).toHaveLength(40);
    expect(done.filter(charge => said(charge).includes("being settled at once"))).toHaveLength(40 - MAX_IN_FLIGHT);
  });

  it("starts at most 300 new payments a minute from everyone, and says so without recording the rest", async () => {
    const { service, store, facilitator, context } = setup();
    // Each from a wallet of its own: one wallet may start only so many in a minute (the cases on the funds and the pace of a payer).
    for (let index = 0; index < MAX_NEW_PER_MINUTE; index += 1) expect((await service.charge(context("check", {}, newBuyer()), "s")).deliver, `payment ${index + 1}`).toBe(true);
    const over = await service.charge(context("check", {}, newBuyer()), "s");
    expect(statusOf(over)).toBe(503);
    expect(said(over)).toMatch(/started right now/);
    expect(!over.deliver && over.reply.headers["retry-after"]).toBe("10");
    expect(store.rows).toHaveLength(MAX_NEW_PER_MINUTE);
    expect(facilitator.calls).toHaveLength(MAX_NEW_PER_MINUTE);
  }, 60_000);

  it("does not count a payment that is only being served again or resolved against the new-payment cap", async () => {
    const { service, context } = setup();
    const ctx = context();
    await service.charge(ctx, "s");
    for (let index = 0; index < 2; index += 1) expect((await service.charge(ctx, "s")).deliver).toBe(true);
    for (let index = 0; index < MAX_NEW_PER_MINUTE - 1; index += 1) await service.charge(context(), "s");
    expect(statusOf(await service.charge(context(), "s"))).toBe(503);
  }, 60_000);
});

describe("when the database fails", () => {
  it("sends nothing to the facilitator when the payment cannot be looked up or recorded first", async () => {
    const lookup = setup();
    lookup.store.fail.find = true;
    await expect(lookup.service.charge(lookup.context(), "s")).rejects.toThrow("database down");
    expect(lookup.facilitator.calls).toHaveLength(0);
    const insert = setup();
    insert.store.fail.begin = true;
    await expect(insert.service.charge(insert.context(), "s")).rejects.toThrow("database down");
    expect(insert.facilitator.calls).toHaveLength(0);
  });

  it("still delivers a payment that settled when its outcome cannot be written, logs the transaction, and settles it again idempotently next time", async () => {
    const { service, store, facilitator, context } = setup();
    store.fail.resolve = 2;
    const ctx = context();
    const first = await service.charge(ctx, "s");
    expect(first.deliver).toBe(true);
    expect(store.rows[0]!.status).toBe("settling");
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).toContain(store.rows[0]!.paymentId);
    const again = await service.charge(ctx, "s");
    expect(again.deliver).toBe(true);
    expect(store.rows[0]).toMatchObject({ status: "paid", sends: 2 });
    expect(facilitator.settled.size).toBe(1);
    expect(paymentResponse(again).transaction).toBe(paymentResponse(first).transaction);
  });
});

describe("payments left for the operator", () => {
  it("counts the ones unresolved for over an hour, holds the count for a minute, and tells an unreadable count as unknown", async () => {
    const { service, store, context, clock } = setup({ script: [facilitatorAnswers.pending()] });
    await service.charge(context(), "s");
    expect(store.rows[0]!.status).toBe("open");
    expect(await service.staleCount()).toBe(0);
    store.rows[0]!.updatedAt = new Date(clock.ms - STALE_AFTER_MS - 1000);
    expect(await service.staleCount()).toBe(0);
    clock.ms += 61_000;
    expect(await service.staleCount()).toBe(1);
    store.rows[0]!.status = "paid";
    expect(await service.staleCount()).toBe(1);
    clock.ms += 61_000;
    expect(await service.staleCount()).toBe(0);
    store.ledger.stale = async () => {
      throw new Error("database down");
    };
    clock.ms += 61_000;
    expect(await service.staleCount()).toBeNull();
  });

  it("is never sent or served again once the operator has set it aside, and the caller is told how to be heard", async () => {
    const { service, store, facilitator, context } = setup({ script: [facilitatorAnswers.pending()] });
    const ctx = context();
    await service.charge(ctx, "s");
    expect(await store.ledger.close(store.rows[0]!.id, "closed by the operator: nothing moved")).toBe(true);
    const after = await service.charge(ctx, "s");
    expect(after.deliver).toBe(false);
    expect(statusOf(after)).toBe(402);
    expect(said(after)).toMatch(/set aside/);
    expect(said(after)).toContain(store.rows[0]!.paymentId);
    expect(facilitator.calls).toHaveLength(1);
    expect(store.rows[0]!.status).toBe("closed");
  });
});

describe("two networks", () => {
  it("never take one for the other: the same payer and nonce on testnet and on mainnet are two payments", async () => {
    const testnet = testConfig({ X402_NETWORK: "eip155:5042002", X402_API_KEY: TEST_CIRCLE_KEY.replace("LIVE", "TEST") });
    const store = memoryLedger();
    const facilitator = newFacilitator(cfg);
    const mainnetService = createPaymentService({ config: cfg, ledger: store.ledger, fetchImpl: facilitator.fetchImpl });
    const testnetFacilitator = newFacilitator(testnet);
    const testnetService = createPaymentService({ config: testnet, ledger: store.ledger, fetchImpl: testnetFacilitator.fetchImpl });
    const buyer = newBuyer();
    const nonce = `0x${"ab".repeat(32)}`;
    const onTestnet = testnetService.accept("check", headerOf(buyer.pay(testnet, "check", { nonce })), RESOURCE);
    const onMainnet = mainnetService.accept("check", headerOf(buyer.pay(cfg, "check", { nonce })), RESOURCE);
    if (!onTestnet.ok || !onMainnet.ok) throw new Error("not accepted");
    expect((await testnetService.charge(onTestnet.context, "s")).deliver).toBe(true);
    expect((await mainnetService.charge(onMainnet.context, "s")).deliver).toBe(true);
    expect(store.rows.map(row => row.network).sort()).toEqual(["eip155:5042", "eip155:5042002"]);
    expect(facilitator.calls).toHaveLength(1);
    expect(testnetFacilitator.calls).toHaveLength(1);
  });
});

describe("what the payment is for", () => {
  it("names the ARC USDC contract and nothing else in what is sent to be settled", async () => {
    const { service, facilitator, context } = setup();
    await service.charge(context(), "s");
    const sent = JSON.stringify(facilitator.calls[0]!.body);
    expect(sent).toContain(ARC_USDC);
    expect(sent).toContain(cfg.payTo);
    expect(sent).not.toContain(TEST_CIRCLE_KEY);
  });
});
