import { dbPaymentLedger, type PaymentLedger, type PaymentRow } from "../apiPayments";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { operatorProcedure, router } from "../_core/trpc";
import { sharedPaymentService, STALE_AFTER_MS } from "../x402Service";

/**
 * The operator's view of pay per call (docs/data-access-2026-10-19.md, stage D4): whether it is on, the price and the receiving address
 * it is set to, what came in over the last seven days, the payments that are not yet resolved (the ones to look at by hand: this
 * version has no refunds and no automatic closing of a payment the facilitator never decided), and the newest payments. Reads only.
 * The facilitator's key is never sent anywhere. Shown on the operator page only.
 */

const RECENT = 50;
const UNRESOLVED = 50;
const WINDOW_DAYS = 7;

const shown = (row: PaymentRow) => ({
  id: row.id,
  paymentId: row.paymentId,
  endpoint: row.endpoint,
  payer: row.payer,
  amount: row.amount,
  status: row.status,
  transaction: row.transaction,
  reason: row.reason,
  sends: row.sends,
  serves: row.serves,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export async function paymentsStatus(service = sharedPaymentService(), ledger: PaymentLedger = dbPaymentLedger, now: () => Date = () => new Date()) {
  if (!service) return { state: "not_configured" as const };
  const cfg = service.config;
  const base = { network: cfg.network, payTo: cfg.payTo, prices: { lookup: cfg.prices.agent, check: cfg.prices.check } };
  const state = await service.state();
  if (state === "off") return { state: "no_table" as const, ...base };
  const since = new Date(now().getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [summary, unresolved, recent, stale] = await Promise.all([
    ledger.summary(cfg.network, since),
    ledger.unresolved(cfg.network, UNRESOLVED),
    ledger.recent(cfg.network, RECENT),
    ledger.stale(cfg.network, new Date(now().getTime() - STALE_AFTER_MS)),
  ]);
  return { state, ...base, windowDays: WINDOW_DAYS, staleAfterMinutes: STALE_AFTER_MS / 60_000, stale, summary, unresolved: { total: unresolved.total, rows: unresolved.rows.map(shown) }, recent: recent.map(shown) };
}

/** The operator sets aside a payment he has looked at, with what he found. Only one that was never decided can be set aside. */
export async function closePayment(id: string, note: string, ledger: PaymentLedger = dbPaymentLedger) {
  const closed = await ledger.close(id, `closed by the operator: ${note}`);
  if (!closed) throw new TRPCError({ code: "CONFLICT", message: "That payment is not unresolved any more." });
  return { id };
}

export const apiPaymentsRouter = router({
  status: operatorProcedure.query(() => paymentsStatus()),
  /** Sets aside an unresolved payment. It stays in the ledger as closed and is never sent or served again. */
  close: operatorProcedure.input(z.object({ id: z.string().min(1).max(36), note: z.string().trim().min(3).max(120) }).strict()).mutation(({ input }) => closePayment(input.id, input.note)),
});
