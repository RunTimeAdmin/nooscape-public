import { describe, expect, it } from "vitest";
import { closePayment, paymentsStatus } from "./routers/apiPayments";
import { appRouter } from "./routers";
import { createPaymentService } from "./x402Service";
import { memoryLedger, newBuyer, newFacilitator, headerOf, testConfig, TEST_CIRCLE_KEY, TEST_PAY_TO } from "./x402Testing";

/**
 * The operator's view of pay per call (docs/data-access-2026-10-19.md, stage D4): what it says when the feature is off, waiting for its
 * table, paused or on, that the facilitator's key is never in it, and that only the operator can read it.
 */
describe("the operator's payments view", () => {
  const cfg = testConfig();

  it("says it is not configured when no setting is there, and waiting for the table when the settings are there and the table is not", async () => {
    expect(await paymentsStatus(null)).toEqual({ state: "not_configured" });
    const { ledger } = memoryLedger({ ready: false });
    const waiting = await paymentsStatus(createPaymentService({ config: cfg, ledger }), ledger);
    expect(waiting).toMatchObject({ state: "no_table", network: cfg.network, payTo: TEST_PAY_TO, prices: { lookup: "5000", check: "10000" } });
    expect(waiting).not.toHaveProperty("recent");
  });

  it("is paused or on with the week's totals, the payments not yet resolved apart, and never the facilitator's key or a signature", async () => {
    const store = memoryLedger();
    const facilitator = newFacilitator(cfg, [() => Response.json({ success: false, errorReason: "settlement_pending" })]);
    const service = createPaymentService({ config: cfg, ledger: store.ledger, fetchImpl: facilitator.fetchImpl });
    const buyer = newBuyer();
    const take = async () => {
      const accepted = service.accept("check", headerOf(buyer.pay(cfg, "check")), "https://nooscape.si/api/v1/check");
      if (!accepted.ok) throw new Error("not accepted");
      return { accepted, charge: await service.charge(accepted.context, "s") };
    };
    const open = await take();
    expect(open.charge.deliver).toBe(false);
    await take();
    const status = await paymentsStatus(service, store.ledger);
    expect(status).toMatchObject({ state: "on", windowDays: 7, unresolved: { total: 1 } });
    if (!("recent" in status)) throw new Error("no detail");
    expect(status.recent).toHaveLength(2);
    expect(status.unresolved.rows[0]).toMatchObject({ status: "open", endpoint: "check", amount: 10000, payer: buyer.address.toLowerCase() });
    const text = JSON.stringify(status);
    expect(text).not.toContain(TEST_CIRCLE_KEY);
    expect(text).not.toContain(open.accepted.context.payment.payload.signature);
    expect(await paymentsStatus(createPaymentService({ config: testConfig({ X402_PAUSE_NEW: "1" }), ledger: store.ledger }), store.ledger)).toMatchObject({ state: "paused" });
  });

  it("counts the payments unresolved for over an hour, and lets the operator set one aside, once, with a note kept", async () => {
    const store = memoryLedger();
    const facilitator = newFacilitator(cfg, [() => Response.json({ success: false, errorReason: "settlement_pending" })]);
    const service = createPaymentService({ config: cfg, ledger: store.ledger, fetchImpl: facilitator.fetchImpl });
    const buyer = newBuyer();
    const accepted = service.accept("check", headerOf(buyer.pay(cfg, "check")), "https://nooscape.si/api/v1/check");
    if (!accepted.ok) throw new Error("not accepted");
    await service.charge(accepted.context, "s");
    const fresh = await paymentsStatus(service, store.ledger);
    expect(fresh).toMatchObject({ stale: 0, staleAfterMinutes: 60 });
    store.rows[0]!.updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const aged = await paymentsStatus(service, store.ledger);
    expect(aged).toMatchObject({ stale: 1, unresolved: { total: 1 } });
    expect(await closePayment(store.rows[0]!.id, "nothing moved on chain", store.ledger)).toEqual({ id: store.rows[0]!.id });
    expect(store.rows[0]).toMatchObject({ status: "closed", reason: "closed by the operator: nothing moved on chain" });
    expect(await paymentsStatus(service, store.ledger)).toMatchObject({ stale: 0, unresolved: { total: 0 } });
    await expect(closePayment(store.rows[0]!.id, "again", store.ledger)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("is for the operator alone", async () => {
    const caller = appRouter.createCaller({ req: { headers: {}, ip: "198.51.100.7" }, res: {}, user: null } as never);
    await expect(caller.apiPayments.status()).rejects.toMatchObject({ code: expect.stringMatching(/UNAUTHORIZED|FORBIDDEN/) });
    await expect(caller.apiPayments.close({ id: "x", note: "a note" })).rejects.toMatchObject({ code: expect.stringMatching(/UNAUTHORIZED|FORBIDDEN/) });
  });
});
