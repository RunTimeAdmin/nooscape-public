import { and, asc, count, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { apiDeliveries, apiEventCursors, apiKeys, apiWatches, apiWebhooks } from "../drizzle/schema";
import { getDb, requireDb } from "./db";
import { isMissingTable } from "./driverErrors";

/**
 * Where webhooks and watchlists are kept (docs/data-access-2026-10-19.md, stage D5). The tables are a manual migration (0045); until they
 * exist `ready` says so and nothing else is called. The default is the database; the router's and the pass's tests give their own.
 */

/** The most live watches one run reads. A run that reaches it says so and does not move its cursors, rather than quietly leave later keys out. */
export const LIVE_WATCH_LIMIT = 20_000;

export type WebhookRow = { keyId: string; url: string; secretVersion: number; failures: number; disabledAt: Date | null; createdAt: Date; updatedAt: Date };
export type DeliveryRow = {
  id: string;
  seq: number;
  keyId: string;
  eventRef: string;
  kind: string;
  entryId: string;
  body: string;
  status: "pending" | "sent" | "dead";
  attempts: number;
  nextAttemptAt: Date;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
};
export type NewDelivery = Pick<DeliveryRow, "id" | "keyId" | "eventRef" | "kind" | "entryId" | "body">;
export type WatchRow = { entryId: string; visible: boolean; createdAt: Date };
/** A watch that is live: its key is not ended and is a Builder or Pro key, and has a webhook that is not turned off. */
export type LiveWatch = { keyId: string; entryId: string; visible: boolean; createdAt: Date };

export type WebhookStore = {
  /** Whether the tables exist. Held for a few seconds. */
  ready: () => Promise<boolean>;

  listWatches: (keyId: string) => Promise<WatchRow[]>;
  countWatches: (keyId: string) => Promise<number>;
  /** Adds the listings that are not watched yet and returns how many were new. */
  addWatches: (keyId: string, entryIds: string[]) => Promise<number>;
  removeWatch: (keyId: string, entryId: string) => Promise<boolean>;
  setVisible: (keyId: string, entryId: string, visible: boolean) => Promise<void>;
  liveWatches: () => Promise<LiveWatch[]>;

  getWebhook: (keyId: string) => Promise<WebhookRow | null>;
  /** Sets the address, turns the webhook on and clears its failures. A new webhook starts at secret version 1; a set one keeps its version. */
  setWebhook: (keyId: string, url: string) => Promise<WebhookRow>;
  /** Raises the secret's version, which gives a new secret. Null when there is no webhook. */
  rotateSecret: (keyId: string) => Promise<WebhookRow | null>;
  deleteWebhook: (keyId: string) => Promise<boolean>;
  /** Counts a delivery's result against a webhook: a success clears its failures, a failure adds one and turns it off at the limit. */
  recordResult: (keyId: string, ok: boolean, disableAfter: number) => Promise<void>;

  /** Records the events that are new for their key (one row for a key and an event) and returns how many were. */
  insertDeliveries: (rows: NewDelivery[]) => Promise<number>;
  /** Deliveries that are due, oldest first, for a live webhook only. */
  /**
   * Deliveries that are due, for a live webhook only: at most `perKey` of each key's, oldest first, for the `keys` keys whose oldest due
   * delivery is oldest. One key with a long queue and a receiver that is down cannot fill a run and starve the others.
   */
  due: (now: Date, limits: { keys: number; perKey: number }) => Promise<DeliveryRow[]>;
  /** Takes a delivery for one try by moving its due time on, so a second pass that overlaps this one does not send it too. False when it was taken or changed. */
  lease: (id: string, expected: Date, until: Date) => Promise<boolean>;
  markSent: (id: string, status: number, now: Date) => Promise<void>;
  markFailed: (id: string, change: { attempts: number; next: Date | null; status: number | null; error: string }) => Promise<void>;
  recent: (keyId: string, limit: number) => Promise<DeliveryRow[]>;
  /** Deletes delivered and given-up deliveries from before a date, and gives up the pending ones that waited as long. Returns how many were deleted. */
  purge: (before: Date) => Promise<number>;

  getCursor: (name: string) => Promise<string | null>;
  setCursor: (name: string, position: string) => Promise<void>;
};

const affected = (result: unknown) => Number((result as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);

const READY_MS = 15_000;
let readyUntil = 0;
let readyValue = false;
export function forgetWebhooksReady() {
  readyUntil = 0;
}

const delivery = (row: typeof apiDeliveries.$inferSelect): DeliveryRow => ({ ...row, status: row.status as DeliveryRow["status"] });

export const dbWebhookStore: WebhookStore = {
  ready: async () => {
    if (Date.now() < readyUntil) return readyValue;
    let value = false;
    try {
      await requireDb(await getDb()).select({ keyId: apiWatches.keyId }).from(apiWatches).limit(1);
      await requireDb(await getDb()).select({ keyId: apiWebhooks.keyId }).from(apiWebhooks).limit(1);
      await requireDb(await getDb()).select({ id: apiDeliveries.id }).from(apiDeliveries).limit(1);
      await requireDb(await getDb()).select({ name: apiEventCursors.name }).from(apiEventCursors).limit(1);
      value = true;
    } catch {
      // A missing table, or a database that does not answer: webhooks are off until it does.
    }
    readyValue = value;
    readyUntil = Date.now() + READY_MS;
    return value;
  },

  listWatches: async keyId => {
    const db = requireDb(await getDb());
    return db.select({ entryId: apiWatches.entryId, visible: apiWatches.visible, createdAt: apiWatches.createdAt }).from(apiWatches).where(eq(apiWatches.keyId, keyId)).orderBy(asc(apiWatches.createdAt), asc(apiWatches.entryId));
  },
  countWatches: async keyId => {
    const db = requireDb(await getDb());
    const [row] = await db.select({ total: count() }).from(apiWatches).where(eq(apiWatches.keyId, keyId));
    return Number(row?.total ?? 0);
  },
  addWatches: async (keyId, entryIds) => {
    if (entryIds.length === 0) return 0;
    const db = requireDb(await getDb());
    const result = await db.insert(apiWatches).ignore().values(entryIds.map(entryId => ({ keyId, entryId })));
    return affected(result);
  },
  removeWatch: async (keyId, entryId) => {
    const db = requireDb(await getDb());
    return affected(await db.delete(apiWatches).where(and(eq(apiWatches.keyId, keyId), eq(apiWatches.entryId, entryId)))) === 1;
  },
  setVisible: async (keyId, entryId, visible) => {
    const db = requireDb(await getDb());
    await db.update(apiWatches).set({ visible }).where(and(eq(apiWatches.keyId, keyId), eq(apiWatches.entryId, entryId)));
  },
  liveWatches: async () => {
    const db = requireDb(await getDb());
    return db
      .select({ keyId: apiWatches.keyId, entryId: apiWatches.entryId, visible: apiWatches.visible, createdAt: apiWatches.createdAt })
      .from(apiWatches)
      .innerJoin(apiWebhooks, and(eq(apiWebhooks.keyId, apiWatches.keyId), isNull(apiWebhooks.disabledAt)))
      .innerJoin(apiKeys, and(eq(apiKeys.id, apiWatches.keyId), isNull(apiKeys.revokedAt), inArray(apiKeys.tier, ["builder", "pro"])))
      .orderBy(asc(apiWatches.keyId), asc(apiWatches.entryId))
      .limit(LIVE_WATCH_LIMIT);
  },

  getWebhook: async keyId => {
    const db = requireDb(await getDb());
    const [row] = await db.select().from(apiWebhooks).where(eq(apiWebhooks.keyId, keyId)).limit(1);
    // A removed webhook is kept as a row with no address (see deleteWebhook), and is not a webhook.
    return row && row.url !== "" ? row : null;
  },
  setWebhook: async (keyId, url) => {
    const db = requireDb(await getDb());
    await db
      .insert(apiWebhooks)
      .values({ keyId, url })
      .onDuplicateKeyUpdate({ set: { url, failures: 0, disabledAt: null, updatedAt: new Date() } });
    const [row] = await db.select().from(apiWebhooks).where(eq(apiWebhooks.keyId, keyId)).limit(1);
    return row!;
  },
  rotateSecret: async keyId => {
    const db = requireDb(await getDb());
    await db.update(apiWebhooks).set({ secretVersion: sql`${apiWebhooks.secretVersion} + 1`, updatedAt: new Date() }).where(and(eq(apiWebhooks.keyId, keyId), ne(apiWebhooks.url, "")));
    const [row] = await db.select().from(apiWebhooks).where(eq(apiWebhooks.keyId, keyId)).limit(1);
    return row && row.url !== "" ? row : null;
  },
  // Removing a webhook erases its address and turns it off, and keeps the row, so the secret's version is kept: a secret that was rotated
  // away does not come back when the webhook is removed and set again.
  deleteWebhook: async keyId => {
    const db = requireDb(await getDb());
    return (
      affected(await db.update(apiWebhooks).set({ url: "", failures: 0, disabledAt: sql`COALESCE(${apiWebhooks.disabledAt}, CURRENT_TIMESTAMP)`, updatedAt: new Date() }).where(and(eq(apiWebhooks.keyId, keyId), ne(apiWebhooks.url, "")))) === 1
    );
  },
  recordResult: async (keyId, ok, disableAfter) => {
    const db = requireDb(await getDb());
    if (ok) {
      await db.update(apiWebhooks).set({ failures: 0 }).where(eq(apiWebhooks.keyId, keyId));
      return;
    }
    // Raw, because MySQL applies the assignments in the order written and the query builder writes them in the table's column order:
    // `disabledAt` must come first so that it sees the count as it was before this failure.
    await db.execute(
      sql`UPDATE api_webhooks SET disabledAt = CASE WHEN failures + 1 >= ${disableAfter} AND disabledAt IS NULL THEN CURRENT_TIMESTAMP ELSE disabledAt END, failures = failures + 1 WHERE keyId = ${keyId}`
    );
  },

  insertDeliveries: async rows => {
    if (rows.length === 0) return 0;
    const db = requireDb(await getDb());
    let inserted = 0;
    for (let start = 0; start < rows.length; start += 200) {
      inserted += affected(await db.insert(apiDeliveries).ignore().values(rows.slice(start, start + 200)));
    }
    return inserted;
  },
  due: async (now, limits) => {
    const db = requireDb(await getDb());
    const dueNow = (keyId?: string) => and(eq(apiDeliveries.status, "pending"), lt(apiDeliveries.nextAttemptAt, new Date(now.getTime() + 1_000)), keyId === undefined ? undefined : eq(apiDeliveries.keyId, keyId));
    // The keys first, by the age of each one's oldest due delivery, then each key's own few: a key is one slot in a run, however long its queue.
    const keys = await db
      .select({ keyId: apiDeliveries.keyId, first: sql<number>`MIN(${apiDeliveries.seq})` })
      .from(apiDeliveries)
      .innerJoin(apiWebhooks, and(eq(apiWebhooks.keyId, apiDeliveries.keyId), isNull(apiWebhooks.disabledAt)))
      .innerJoin(apiKeys, and(eq(apiKeys.id, apiDeliveries.keyId), isNull(apiKeys.revokedAt), inArray(apiKeys.tier, ["builder", "pro"])))
      .where(dueNow())
      .groupBy(apiDeliveries.keyId)
      .orderBy(sql`MIN(${apiDeliveries.seq})`)
      .limit(limits.keys);
    const out: DeliveryRow[] = [];
    for (const { keyId } of keys) {
      const rows = await db.select().from(apiDeliveries).where(dueNow(keyId)).orderBy(asc(apiDeliveries.seq)).limit(limits.perKey);
      out.push(...rows.map(delivery));
    }
    return out.sort((a, b) => a.seq - b.seq);
  },
  lease: async (id, expected, until) => {
    const db = requireDb(await getDb());
    return affected(await db.update(apiDeliveries).set({ nextAttemptAt: until }).where(and(eq(apiDeliveries.id, id), eq(apiDeliveries.status, "pending"), eq(apiDeliveries.nextAttemptAt, expected)))) === 1;
  },
  markSent: async (id, status, now) => {
    const db = requireDb(await getDb());
    await db.update(apiDeliveries).set({ status: "sent", lastStatus: status, lastError: null, sentAt: now, attempts: sql`${apiDeliveries.attempts} + 1` }).where(and(eq(apiDeliveries.id, id), eq(apiDeliveries.status, "pending")));
  },
  markFailed: async (id, change) => {
    const db = requireDb(await getDb());
    await db
      .update(apiDeliveries)
      .set({ attempts: change.attempts, status: change.next ? "pending" : "dead", nextAttemptAt: change.next ?? new Date(), lastStatus: change.status, lastError: change.error.slice(0, 40) })
      .where(and(eq(apiDeliveries.id, id), eq(apiDeliveries.status, "pending")));
  },
  recent: async (keyId, limit) => {
    const db = requireDb(await getDb());
    const rows = await db.select().from(apiDeliveries).where(eq(apiDeliveries.keyId, keyId)).orderBy(desc(apiDeliveries.seq)).limit(Math.min(Math.max(limit, 1), 50));
    return rows.map(delivery);
  },
  purge: async before => {
    const db = requireDb(await getDb());
    // A delivery that waited this long for a webhook that is off, or a key that ended, is given up rather than kept for ever.
    await db.update(apiDeliveries).set({ status: "dead", lastError: "expired" }).where(and(eq(apiDeliveries.status, "pending"), lt(apiDeliveries.createdAt, before)));
    return affected(await db.delete(apiDeliveries).where(and(inArray(apiDeliveries.status, ["sent", "dead"]), lt(apiDeliveries.createdAt, before))));
  },

  getCursor: async name => {
    const db = requireDb(await getDb());
    const [row] = await db.select({ position: apiEventCursors.position }).from(apiEventCursors).where(eq(apiEventCursors.name, name)).limit(1);
    return row?.position ?? null;
  },
  setCursor: async (name, position) => {
    const db = requireDb(await getDb());
    await db.insert(apiEventCursors).values({ name, position }).onDuplicateKeyUpdate({ set: { position, updatedAt: new Date() } });
  },
};

/** Runs a store step and treats a missing table as "not available" for the caller to turn into its own answer. */
export { isMissingTable };
