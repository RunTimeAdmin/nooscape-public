import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, like, lt, sql } from "drizzle-orm";
import { apiPayments } from "../drizzle/schema";
import { getDb, requireDb } from "./db";

/**
 * The record of what callers paid (docs/data-access-2026-10-19.md, stage D4): one row for each USDC authorization signed for an API
 * call, kept so that it is settled once, its caller can be served again if the answer was lost, and the operator can see what is
 * unresolved. The table is a manual migration (0044). Until it exists the ledger says it is not ready and pay per call stays off.
 *
 * Statuses, and the only moves between them:
 *   settling  recorded and about to be sent to the facilitator, or sent with no answer recorded
 *   open      the facilitator did not say: it may still settle. Never served, never charged again
 *   paid      settled and the transaction named. The only status that serves an answer
 *   refused   nothing moved. Final
 *   closed    the operator looked at a payment that was never decided and set it aside. Final
 * A row leaves `settling` or `open` and never leaves `paid`, `refused` or `closed`: every change below is conditional on that, so a late or
 * repeated write cannot undo a result.
 */

export type PaymentStatus = "settling" | "open" | "paid" | "refused" | "closed";

export type PaymentRow = {
  id: string;
  /** The order the rows were written in. */
  seq: number;
  paymentId: string;
  network: string;
  endpoint: string;
  payer: string;
  nonce: string;
  amount: number;
  validBefore: number;
  subjectHash: string;
  status: PaymentStatus;
  transaction: string | null;
  reason: string | null;
  sends: number;
  serves: number;
  createdAt: Date;
  updatedAt: Date;
};

export type NewPayment = Pick<PaymentRow, "paymentId" | "network" | "endpoint" | "payer" | "nonce" | "amount" | "validBefore" | "subjectHash">;

export type PaymentChange = { status: "open" | "paid" | "refused"; transaction?: string | null; reason?: string | null };

export type PaymentSummary = { status: string; count: number; amount: number };

/** Where payments are kept. The default is the database; a test gives its own. */
export type PaymentLedger = {
  /** Whether payments can be recorded: the table exists and the database answers. Held for a few seconds. */
  ready: () => Promise<boolean>;
  find: (network: string, payer: string, nonce: string) => Promise<PaymentRow | null>;
  /** Records a new authorization as `settling` with its first send counted, and returns it. Null when one with the same network, payer and nonce is there already. */
  begin: (payment: NewPayment) => Promise<PaymentRow | null>;
  /** Counts one more send of a payment that is not resolved. False when it is resolved. */
  countSend: (id: string) => Promise<boolean>;
  /** Moves a payment that is `settling` or `open`. A `paid` payment counts its first serve with the move. False when it was not unresolved. */
  resolve: (id: string, change: PaymentChange) => Promise<boolean>;
  /** The operator sets aside a payment that is `settling` or `open`, with what was found. False when it is not unresolved. */
  close: (id: string, reason: string) => Promise<boolean>;
  /** How many payments on one network have been `settling` or `open` since before a time: the ones nobody is going to resolve by retrying. */
  stale: (network: string, before: Date) => Promise<number>;
  /** How many payments from one wallet are `settling` or `open`. */
  openFor: (network: string, payer: string) => Promise<number>;
  /** How many payments from one wallet had a settlement that failed after the facilitator broadcast it, since a time (their reason starts "failed after broadcast"). */
  failedFor: (network: string, payer: string, since: Date) => Promise<number>;
  /** Counts one more serve of a paid payment, up to `max`. False when it is not paid or has been served `max` times. */
  countServe: (id: string, max: number) => Promise<boolean>;
  recent: (network: string, limit: number) => Promise<PaymentRow[]>;
  /** The payments on one network that are not resolved (settling or open), oldest first, and how many there are. */
  unresolved: (network: string, limit: number) => Promise<{ total: number; rows: PaymentRow[] }>;
  /** How many payments, and how much, on one network by status, since a date. */
  summary: (network: string, since: Date) => Promise<PaymentSummary[]>;
};

function driverErrorHas(error: unknown, code: string): boolean {
  for (let depth = 0, cause: unknown = error; cause && typeof cause === "object" && depth < 4; depth += 1) {
    if ((cause as { code?: unknown }).code === code) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

const affected = (result: unknown) => Number((result as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);

const READY_MS = 15_000;
let readyUntil = 0;
let readyValue = false;

/** Forgets what was learned about the table (a test makes or drops it). */
export function forgetPaymentsReady() {
  readyUntil = 0;
}

export const dbPaymentLedger: PaymentLedger = {
  ready: async () => {
    if (Date.now() < readyUntil) return readyValue;
    let value = false;
    try {
      await requireDb(await getDb()).select({ id: apiPayments.id }).from(apiPayments).limit(1);
      value = true;
    } catch {
      // A missing table, or a database that does not answer: pay per call is off until it does.
    }
    readyValue = value;
    readyUntil = Date.now() + READY_MS;
    return value;
  },

  find: async (network, payer, nonce) => {
    const db = requireDb(await getDb());
    const [row] = await db.select().from(apiPayments).where(and(eq(apiPayments.network, network), eq(apiPayments.payer, payer), eq(apiPayments.nonce, nonce))).limit(1);
    return row ? (row as PaymentRow) : null;
  },

  begin: async payment => {
    const db = requireDb(await getDb());
    const id = randomUUID();
    try {
      await db.insert(apiPayments).values({ id, ...payment, status: "settling", sends: 1 });
    } catch (error) {
      if (driverErrorHas(error, "ER_DUP_ENTRY")) return null;
      throw error;
    }
    const [row] = await db.select().from(apiPayments).where(eq(apiPayments.id, id)).limit(1);
    return row ? (row as PaymentRow) : null;
  },

  countSend: async id => {
    const db = requireDb(await getDb());
    const result = await db
      .update(apiPayments)
      .set({ sends: sql`${apiPayments.sends} + 1`, updatedAt: new Date() })
      .where(and(eq(apiPayments.id, id), inArray(apiPayments.status, ["settling", "open"])));
    return affected(result) === 1;
  },

  resolve: async (id, change) => {
    const db = requireDb(await getDb());
    const result = await db
      .update(apiPayments)
      .set({
        status: change.status,
        // A transaction the facilitator named once is never forgotten: a later send that names none keeps it, because it is the best evidence
        // the operator has when a payment has to be looked at by hand.
        transaction: change.transaction ?? sql`${apiPayments.transaction}`,
        reason: change.reason === undefined || change.reason === null ? null : change.reason.slice(0, 200),
        ...(change.status === "paid" ? { serves: sql`${apiPayments.serves} + 1` } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(apiPayments.id, id), inArray(apiPayments.status, ["settling", "open"])));
    return affected(result) === 1;
  },

  close: async (id, reason) => {
    const db = requireDb(await getDb());
    const result = await db
      .update(apiPayments)
      // A settlement that failed after it was broadcast stays marked as such when the operator sets it aside: it still pauses the wallet.
      .set({
        status: "closed",
        reason: sql`CASE WHEN ${apiPayments.reason} LIKE 'failed after broadcast%' THEN LEFT(CONCAT('failed after broadcast; ', ${reason}), 200) ELSE LEFT(${reason}, 200) END`,
        updatedAt: new Date(),
      })
      .where(and(eq(apiPayments.id, id), inArray(apiPayments.status, ["settling", "open"])));
    return affected(result) === 1;
  },

  openFor: async (network, payer) => {
    const db = requireDb(await getDb());
    const [counted] = await db
      .select({ total: sql<string>`count(*)` })
      .from(apiPayments)
      .where(and(eq(apiPayments.network, network), eq(apiPayments.payer, payer), inArray(apiPayments.status, ["settling", "open"])));
    return Number(counted?.total ?? 0);
  },

  failedFor: async (network, payer, since) => {
    const db = requireDb(await getDb());
    const [counted] = await db
      .select({ total: sql<string>`count(*)` })
      .from(apiPayments)
      .where(and(eq(apiPayments.network, network), eq(apiPayments.payer, payer), like(apiPayments.reason, "failed after broadcast%"), gte(apiPayments.updatedAt, since)));
    return Number(counted?.total ?? 0);
  },

  stale: async (network, before) => {
    const db = requireDb(await getDb());
    const [counted] = await db
      .select({ total: sql<string>`count(*)` })
      .from(apiPayments)
      .where(and(eq(apiPayments.network, network), inArray(apiPayments.status, ["settling", "open"]), lt(apiPayments.updatedAt, before)));
    return Number(counted?.total ?? 0);
  },

  countServe: async (id, max) => {
    const db = requireDb(await getDb());
    const result = await db
      .update(apiPayments)
      .set({ serves: sql`${apiPayments.serves} + 1`, updatedAt: new Date() })
      .where(and(eq(apiPayments.id, id), eq(apiPayments.status, "paid"), lt(apiPayments.serves, max)));
    return affected(result) === 1;
  },

  recent: async (network, limit) => {
    const db = requireDb(await getDb());
    return (await db.select().from(apiPayments).where(eq(apiPayments.network, network)).orderBy(desc(apiPayments.seq)).limit(Math.min(Math.max(limit, 1), 100))) as PaymentRow[];
  },

  unresolved: async (network, limit) => {
    const db = requireDb(await getDb());
    const open = and(eq(apiPayments.network, network), inArray(apiPayments.status, ["settling", "open"]));
    const [counted] = await db.select({ total: sql<string>`count(*)` }).from(apiPayments).where(open);
    const rows = (await db.select().from(apiPayments).where(open).orderBy(apiPayments.seq).limit(Math.min(Math.max(limit, 1), 100))) as PaymentRow[];
    return { total: Number(counted?.total ?? 0), rows };
  },

  summary: async (network, since) => {
    const db = requireDb(await getDb());
    const rows = await db
      .select({ status: apiPayments.status, count: sql<string>`count(*)`, amount: sql<string>`coalesce(sum(${apiPayments.amount}), 0)` })
      .from(apiPayments)
      .where(and(eq(apiPayments.network, network), gte(apiPayments.createdAt, since)))
      .groupBy(apiPayments.status);
    return rows.map(row => ({ status: row.status, count: Number(row.count), amount: Number(row.amount) }));
  },
};
