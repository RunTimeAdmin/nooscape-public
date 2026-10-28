import type { ClaimEditFact, EventSource, Found, RatingFact, TransferFact, WatchedEntry } from "./webhookEvents";
import type { DeliveryRow, LiveWatch, WatchRow, WebhookRow, WebhookStore } from "./webhookStore";

/**
 * Test support for webhooks (docs/data-access-2026-10-19.md, stage D5): a store and an event source that live in memory and answer the way
 * the database ones do, so the pass and the router can be tested without a database. webhookStore.integration.test.ts holds the real ones to
 * the same behaviour.
 */

type MemoryKey = { tier: "free" | "builder" | "pro"; revoked?: boolean };

export function memoryWebhookStore(keys: Record<string, MemoryKey> = {}, clock: () => Date = () => new Date()) {
  const watches = new Map<string, WatchRow & { keyId: string }>();
  const webhooks = new Map<string, WebhookRow>();
  const deliveries = new Map<string, DeliveryRow>();
  const cursors = new Map<string, string>();
  let seq = 0;
  let ready = true;

  const live = (keyId: string) => {
    const key = keys[keyId];
    return Boolean(key && !key.revoked && (key.tier === "builder" || key.tier === "pro"));
  };
  const liveWebhook = (keyId: string) => {
    const hook = webhooks.get(keyId);
    return Boolean(hook && hook.disabledAt === null && live(keyId));
  };

  const store: WebhookStore = {
    ready: async () => ready,

    listWatches: async keyId =>
      Array.from(watches.values())
        .filter(watch => watch.keyId === keyId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.entryId.localeCompare(b.entryId))
        .map(({ entryId, visible, createdAt }) => ({ entryId, visible, createdAt })),
    countWatches: async keyId => Array.from(watches.values()).filter(watch => watch.keyId === keyId).length,
    addWatches: async (keyId, entryIds) => {
      let added = 0;
      for (const entryId of entryIds) {
        if (watches.has(`${keyId}|${entryId}`)) continue;
        watches.set(`${keyId}|${entryId}`, { keyId, entryId, visible: true, createdAt: clock() });
        added += 1;
      }
      return added;
    },
    removeWatch: async (keyId, entryId) => watches.delete(`${keyId}|${entryId}`),
    setVisible: async (keyId, entryId, visible) => {
      const watch = watches.get(`${keyId}|${entryId}`);
      if (watch) watch.visible = visible;
    },
    liveWatches: async () =>
      Array.from(watches.values())
        .filter(watch => liveWebhook(watch.keyId))
        .sort((a, b) => a.keyId.localeCompare(b.keyId) || a.entryId.localeCompare(b.entryId))
        .map((watch): LiveWatch => ({ keyId: watch.keyId, entryId: watch.entryId, visible: watch.visible, createdAt: watch.createdAt })),

    getWebhook: async keyId => {
      const hook = webhooks.get(keyId);
      return hook && hook.url !== "" ? hook : null;
    },
    setWebhook: async (keyId, url, options) => {
      const now = clock();
      const before = webhooks.get(keyId);
      const next: WebhookRow = before ? { ...before, url, failures: 0, disabledAt: null, updatedAt: now, ...(options?.rotateSecret ? { secretVersion: before.secretVersion + 1 } : {}) } : { keyId, url, secretVersion: 1, failures: 0, disabledAt: null, createdAt: now, updatedAt: now };
      webhooks.set(keyId, next);
      return next;
    },
    rotateSecret: async keyId => {
      const before = webhooks.get(keyId);
      if (!before || before.url === "") return null;
      const next = { ...before, secretVersion: before.secretVersion + 1, updatedAt: clock() };
      webhooks.set(keyId, next);
      return next;
    },
    // Removed, not deleted: the row stays with no address, so the secret's version is kept.
    deleteWebhook: async keyId => {
      const before = webhooks.get(keyId);
      if (!before || before.url === "") return false;
      webhooks.set(keyId, { ...before, url: "", failures: 0, disabledAt: before.disabledAt ?? clock(), updatedAt: clock() });
      return true;
    },
    recordResult: async (keyId, ok, disableAfter) => {
      const before = webhooks.get(keyId);
      if (!before) return;
      if (ok) return void webhooks.set(keyId, { ...before, failures: 0 });
      const failures = before.failures + 1;
      webhooks.set(keyId, { ...before, failures, disabledAt: failures >= disableAfter && before.disabledAt === null ? clock() : before.disabledAt });
    },

    insertDeliveries: async rows => {
      let inserted = 0;
      for (const row of rows) {
        if (Array.from(deliveries.values()).some(existing => existing.keyId === row.keyId && existing.eventRef === row.eventRef)) continue;
        seq += 1;
        const now = clock();
        deliveries.set(row.id, { ...row, seq, status: "pending", attempts: 0, nextAttemptAt: now, lastStatus: null, lastError: null, createdAt: now, sentAt: null });
        inserted += 1;
      }
      return inserted;
    },
    due: async (now, limits) => {
      const due = Array.from(deliveries.values())
        .filter(row => row.status === "pending" && row.nextAttemptAt.getTime() < now.getTime() + 1_000 && liveWebhook(row.keyId))
        .sort((a, b) => a.seq - b.seq);
      const keys = Array.from(new Set(due.map(row => row.keyId))).slice(0, limits.keys);
      return keys.flatMap(keyId => due.filter(row => row.keyId === keyId).slice(0, limits.perKey)).sort((a, b) => a.seq - b.seq);
    },
    lease: async (id, expected, until) => {
      const row = deliveries.get(id);
      if (!row || row.status !== "pending" || row.nextAttemptAt.getTime() !== expected.getTime()) return false;
      row.nextAttemptAt = until;
      return true;
    },
    markSent: async (id, status, now) => {
      const row = deliveries.get(id);
      if (row && row.status === "pending") Object.assign(row, { status: "sent", lastStatus: status, lastError: null, sentAt: now, attempts: row.attempts + 1 });
    },
    markFailed: async (id, change) => {
      const row = deliveries.get(id);
      if (row && row.status === "pending") Object.assign(row, { attempts: change.attempts, status: change.next ? "pending" : "dead", nextAttemptAt: change.next ?? clock(), lastStatus: change.status, lastError: change.error.slice(0, 40) });
    },
    recent: async (keyId, limit) =>
      Array.from(deliveries.values())
        .filter(row => row.keyId === keyId)
        .sort((a, b) => b.seq - a.seq)
        .slice(0, Math.min(Math.max(limit, 1), 50)),
    purge: async before => {
      let removed = 0;
      Array.from(deliveries.entries()).forEach(([id, row]) => {
        if (row.createdAt.getTime() >= before.getTime()) return;
        deliveries.delete(id);
        removed += 1;
      });
      return removed;
    },

    getCursor: async name => cursors.get(name) ?? null,
    setCursor: async (name, position) => void cursors.set(name, position),
  };

  return {
    store,
    keys,
    watches,
    webhooks,
    deliveries,
    cursors,
    setReady: (value: boolean) => void (ready = value),
    all: () => Array.from(deliveries.values()).sort((a, b) => a.seq - b.seq),
  };
}

export type MemoryLedgers = {
  entries: WatchedEntry[];
  claims: ClaimEditFact[];
  transfers: TransferFact[];
  ratings: RatingFact[];
  /** When set, the reads answer as if they stopped at the limit. */
  full?: { claims?: boolean; transfers?: boolean; ratings?: boolean };
};

export function memoryEventSource(ledgers: MemoryLedgers): EventSource {
  const found = <T>(rows: T[], full: boolean | undefined): Found<T> => ({ rows, full: Boolean(full) });
  return {
    entries: async ids => ledgers.entries.filter(entry => ids.includes(entry.id)),
    maxClaimSeq: async () => ledgers.claims.reduce((top, row) => Math.max(top, row.seq), 0),
    claimEdits: async (afterSeq, entryIds, since) => found(ledgers.claims.filter(row => row.seq > afterSeq && row.occurredAt.getTime() >= since.getTime() && entryIds.includes(row.entryId)), ledgers.full?.claims),
    transfers: async (since, entries) => found(ledgers.transfers.filter(row => row.createdAt.getTime() >= since.getTime() && entries.some(entry => entry.id === row.entryId)), ledgers.full?.transfers),
    ratings: async (since, entries) => found(ledgers.ratings.filter(row => row.createdAt.getTime() >= since.getTime() && entries.some(entry => entry.id === row.entryId)), ledgers.full?.ratings),
  };
}

export const ROBINHOOD_ENTRY: WatchedEntry = {
  id: "entry-rh-1",
  protocol: "erc8004",
  sourceId: "source-rh",
  externalKey: "eip155:4663:0x0000000000000000000000000000000000000001:42",
  visible: true,
};
export const ARC_ENTRY: WatchedEntry = {
  id: "entry-arc-1",
  protocol: "erc8004_arc",
  sourceId: "source-arc",
  externalKey: "eip155:5042:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432:13",
  visible: true,
};
export const SOLANA_ENTRY: WatchedEntry = { id: "entry-sol-1", protocol: "solana_8004", sourceId: "source-sol", externalKey: "7Yw6u4v9kQ3pZ2r8s5t1x6c4b3n2m1k9j8h7g6f5d4e3", visible: true };
