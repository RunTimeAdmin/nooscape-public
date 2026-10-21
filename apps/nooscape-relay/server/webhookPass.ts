import { randomUUID } from "node:crypto";
import { agentIdOfKey, apiChainOfProtocol, servedChains, type ApiChain } from "./apiChains";
import { safeFetch } from "./safeFetch";
import { dbEventSource, type EventSource, type WatchedEntry } from "./webhookEvents";
import { LIVE_WATCH_LIMIT, dbWebhookStore, type DeliveryRow, type LiveWatch, type NewDelivery, type WebhookStore } from "./webhookStore";
import {
  DELIVERY_TIMEOUT_MS,
  DISABLE_AFTER_FAILURES,
  KEEP_DELIVERIES_DAYS,
  WEBHOOK_USER_AGENT,
  deliveryHeaders,
  eventBody,
  loadSigningKey,
  retryAfterSeconds,
  signingSecret,
  type EventType,
} from "./webhooks";

/**
 * The webhook pass (docs/data-access-2026-10-19.md, stage D5). One run does three things, in this order: it reads what was recorded since
 * the last run about the listings that keys watch and writes one delivery for each key that should hear of it, it sends the deliveries that
 * are due, and now and then it clears out old ones. A run that is cut short loses nothing: events are written before they are sent, one row
 * for a key and an event, so the next run carries on, and a delivery is sent at least once and at most once at a time.
 *
 * Only forward: an event is sent only when it was recorded after the key's watch was made, and the first run reads no further back than
 * the oldest watch. The pass changes no record, score, tier or evidence level and writes only its own tables.
 */

export type SendResult = { ok: true; status: number } | { ok: false; status: number | null; error: string };
export type Send = (url: string, input: { body: string; headers: Record<string, string> }) => Promise<SendResult>;

export type PassDeps = {
  store: WebhookStore;
  source: EventSource;
  /** The server's signing key, or null when webhooks are off. */
  signingKey: string | null;
  send: Send;
  now: () => Date;
  newId: () => string;
  /** How long a pass spends sending before it leaves the rest for the next one. */
  budgetMs: number;
  /** Deliveries sent to different webhooks at the same moment. */
  parallel: number;
};

export type PassReport = {
  status: "off" | "busy" | "ran";
  reason?: string;
  /** Deliveries written this run. */
  created: number;
  sent: number;
  /** Tries that failed and will be made again. */
  retrying: number;
  /** Deliveries given up after their last try. */
  gaveUp: number;
  /** Webhooks that were turned off by this run. */
  disabled: number;
  purged: number;
  /** A read that came back full: the run did not move that cursor, and the next one reads again. */
  fullReads: string[];
};

/** How far back a pass reads past its cursor, for rows that were written late, and the furthest back it will ever read. */
export const OVERLAP_MS = 15 * 60_000;
export const LOOKBACK_MS = 7 * 24 * 3_600_000;
const SEQ_OVERLAP = 100;
const LEASE_MS = 120_000;
const PURGE_EVERY_MS = 6 * 3_600_000;
/** A run takes at most this many keys' deliveries, and at most this many of each key's, so one key with a long queue cannot fill it. */
const SEND_KEYS = 100;
const SEND_PER_KEY = 25;

export const defaultSend: Send = async (url, input) => {
  const result = await safeFetch(url, { method: "POST", body: input.body, headers: input.headers, userAgent: WEBHOOK_USER_AGENT, timeoutMs: DELIVERY_TIMEOUT_MS, maxBodyBytes: 512 });
  if (!result.ok) return { ok: false, status: null, error: result.reason };
  if (result.status >= 200 && result.status < 300) return { ok: true, status: result.status };
  return { ok: false, status: result.status, error: `http_${result.status}` };
};

const minuteStamp = (when: Date) => when.toISOString().slice(0, 16).replace(/[-:T]/g, "");

/** The listing as the API names it, or null for one on a chain the API does not serve now (an extra chain whose switch is off). */
function agentOf(entry: WatchedEntry, chains: readonly ApiChain[]) {
  const chain = apiChainOfProtocol(entry.protocol, chains);
  return chain ? { chain, agentId: agentIdOfKey(chain, entry.externalKey), registry: entry.protocol, entryId: entry.id } : null;
}

/** What each ledger row or change becomes, for each key that watches the listing it is about. Pure: no database and no network. */
export function plan(input: {
  watches: LiveWatch[];
  entries: Map<string, WatchedEntry>;
  now: Date;
  newId: () => string;
  claims: Array<{ seq: number; entryId: string; kind: string; field: string | null; wallet: string | null; reason: string | null; occurredAt: Date }>;
  transfers: Array<{ ref: string; entryId: string; from: string | null; to: string | null; blockNumber: number | null; transactionRef: string; isHandout: boolean; createdAt: Date }>;
  ratings: Array<{ ref: string; entryId: string; kind: "added" | "revoked"; createdAt: Date }>;
  /** The chains the API serves now. Read from the switches as the server runs unless given. */
  chains?: readonly ApiChain[];
}): { deliveries: NewDelivery[]; visibility: Array<{ keyId: string; entryId: string; visible: boolean }> } {
  const chains = input.chains ?? servedChains();
  const byEntry = new Map<string, LiveWatch[]>();
  for (const watch of input.watches) byEntry.set(watch.entryId, [...(byEntry.get(watch.entryId) ?? []), watch]);
  const deliveries: NewDelivery[] = [];
  const emit = (entry: WatchedEntry, type: EventType, ref: string, at: Date, data: Record<string, unknown>) => {
    const agent = agentOf(entry, chains);
    if (!agent) return;
    for (const watch of byEntry.get(entry.id) ?? []) {
      // Only what was recorded after the key began to watch the listing.
      if (at.getTime() < watch.createdAt.getTime()) continue;
      const id = input.newId();
      deliveries.push({ id, keyId: watch.keyId, eventRef: ref, kind: type, entryId: entry.id, body: eventBody({ id, type, createdAt: at, agent, data }) });
    }
  };

  // Nothing is said about a listing that is out of the public view, except that it left: the API answers 404 for it, and a freeze or an
  // ownership change right after a removal would hint at why it was hidden.
  const inView = (entryId: string) => {
    const entry = input.entries.get(entryId);
    return entry && entry.visible ? entry : undefined;
  };
  // The public history gives a wallet only for a claim and an edit, which are signed. A freeze, an unfreeze, a removal of text or a revocation shows none.
  const SIGNED_KINDS = ["claim", "edit"];
  for (const fact of input.claims) {
    const entry = inView(fact.entryId);
    if (entry) emit(entry, "claim.changed", `claim:${fact.seq}`, fact.occurredAt, { seq: fact.seq, kind: fact.kind, field: fact.field, wallet: SIGNED_KINDS.includes(fact.kind) ? fact.wallet : null, reason: fact.reason, occurred_at: fact.occurredAt.toISOString() });
  }
  for (const fact of input.transfers) {
    const entry = inView(fact.entryId);
    if (!entry) continue;
    const evm = entry.externalKey.startsWith("eip155:");
    emit(entry, "ownership.changed", fact.ref, fact.createdAt, {
      from: fact.from,
      to: fact.to,
      ...(evm ? { block_number: fact.blockNumber, transaction_hash: fact.transactionRef, is_handout: fact.isHandout } : { transaction_signature: fact.transactionRef }),
    });
  }
  for (const fact of input.ratings) {
    const entry = inView(fact.entryId);
    // The API gives counts and not the rating, who made it or where it is, so the event says only that one was added or taken back.
    if (entry) emit(entry, fact.kind === "added" ? "feedback.added" : "feedback.revoked", fact.ref, fact.createdAt, {});
  }

  const visibility: Array<{ keyId: string; entryId: string; visible: boolean }> = [];
  for (const watch of input.watches) {
    const entry = input.entries.get(watch.entryId);
    const visible = entry?.visible ?? false;
    if (visible === watch.visible) continue;
    // A listing on a chain that is not served now is neither reported on nor tracked, so the event that comes when the chain is served
    // again is for a change that happened while it was.
    if (entry && !agentOf(entry, chains)) continue;
    visibility.push({ keyId: watch.keyId, entryId: watch.entryId, visible });
    if (!entry) continue;
    const agent = agentOf(entry, chains);
    if (!agent) continue;
    const type: EventType = visible ? "listing.restored" : "listing.removed";
    const id = input.newId();
    deliveries.push({ id, keyId: watch.keyId, eventRef: `vis:${entry.id}:${visible ? "up" : "down"}:${minuteStamp(input.now)}`, kind: type, entryId: entry.id, body: eventBody({ id, type, createdAt: input.now, agent, data: {} }) });
  }
  return { deliveries, visibility };
}

let running = false;

/** One run of the pass. Never throws for a webhook's own failure; a database that cannot be read throws and the run is simply not done. */
export async function runWebhookPass(overrides: Partial<PassDeps> = {}): Promise<PassReport> {
  const report: PassReport = { status: "ran", created: 0, sent: 0, retrying: 0, gaveUp: 0, disabled: 0, purged: 0, fullReads: [] };
  let signingKey: string | null;
  try {
    signingKey = "signingKey" in overrides ? (overrides.signingKey ?? null) : loadSigningKey();
  } catch (error) {
    return { ...report, status: "off", reason: error instanceof Error ? error.message : "the signing key is not usable" };
  }
  const deps: PassDeps = { store: dbWebhookStore, source: dbEventSource, send: defaultSend, now: () => new Date(), newId: randomUUID, budgetMs: 45_000, parallel: 4, ...overrides, signingKey };
  if (!signingKey) return { ...report, status: "off", reason: "WEBHOOK_SIGNING_KEY is not set" };
  if (running) return { ...report, status: "busy" };
  running = true;
  try {
    if (!(await deps.store.ready())) return { ...report, status: "off", reason: "the webhook tables do not exist yet (migration 0045)" };
    const started = deps.now();
    await detect(deps, started, report);
    await sendDue(deps, started, signingKey, report);
    await tidy(deps, started, report);
    return report;
  } finally {
    running = false;
  }
}

async function detect(deps: PassDeps, now: Date, report: PassReport) {
  const { store, source } = deps;
  const watches = await store.liveWatches();
  const top = await source.maxClaimSeq();
  const claimCursor = Number((await store.getCursor("claims")) ?? "0");
  const ledgerCursorText = await store.getCursor("ledgers");
  if (watches.length === 0) {
    // Nobody is watching: there is nothing to read, and what happens now is not owed to a watch that does not exist yet.
    await store.setCursor("claims", String(top));
    await store.setCursor("ledgers", now.toISOString());
    return;
  }

  // Reading every watch is what makes a cursor safe to move. If the list was cut short, some keys were not read at all.
  const cut = watches.length >= LIVE_WATCH_LIMIT;
  if (cut) report.fullReads.push("watches");
  const ids = Array.from(new Set(watches.map(watch => watch.entryId)));
  const entries = new Map((await source.entries(ids)).map(entry => [entry.id, entry]));
  // Only listings in the public view are read for events. A listing that has left is told about once, by the visibility check below.
  const live = Array.from(entries.values()).filter(entry => entry.visible);

  const oldest = watches.reduce((least, watch) => Math.min(least, watch.createdAt.getTime()), now.getTime());
  const floor = now.getTime() - LOOKBACK_MS;
  const since = new Date(Math.max(floor, ledgerCursorText ? new Date(ledgerCursorText).getTime() - OVERLAP_MS : oldest));

  // The claim history is read by sequence number with an overlap, and never further back than the ledgers are: a row older than that has
  // had its delivery tidied away, and would be sent again.
  const claims = await source.claimEdits(Math.max(claimCursor - SEQ_OVERLAP, 0), live.map(entry => entry.id), new Date(floor));
  const transfers = await source.transfers(since, live);
  const ratings = await source.ratings(since, live);

  const planned = plan({ watches, entries, now, newId: deps.newId, claims: claims.rows, transfers: transfers.rows, ratings: ratings.rows });
  report.created = await store.insertDeliveries(planned.deliveries);
  for (const change of planned.visibility) await store.setVisible(change.keyId, change.entryId, change.visible);

  if (claims.full) report.fullReads.push("claims");
  else if (!cut) await store.setCursor("claims", String(Math.max(top, ...claims.rows.map(row => row.seq))));
  if (transfers.full) report.fullReads.push("transfers");
  if (ratings.full) report.fullReads.push("ratings");
  if (!transfers.full && !ratings.full && !cut) await store.setCursor("ledgers", now.toISOString());
}

async function sendDue(deps: PassDeps, started: Date, signingKey: string, report: PassReport) {
  const { store } = deps;
  const due = await store.due(started, { keys: SEND_KEYS, perKey: SEND_PER_KEY });
  if (due.length === 0) return;
  const byKey = new Map<string, DeliveryRow[]>();
  for (const delivery of due) byKey.set(delivery.keyId, [...(byKey.get(delivery.keyId) ?? []), delivery]);
  const queue = Array.from(byKey.values());
  const stopAt = Date.now() + deps.budgetMs;

  const work = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (Date.now() >= stopAt) return;
      await sendForKey(deps, signingKey, next, stopAt, report);
    }
  };
  await Promise.all(Array.from({ length: Math.min(deps.parallel, queue.length) }, work));
}

/** One webhook's deliveries, oldest first. The first failure ends this run's tries for it, so a down endpoint is not hammered by every event in its queue. */
async function sendForKey(deps: PassDeps, signingKey: string, list: DeliveryRow[], stopAt: number, report: PassReport) {
  const { store } = deps;
  const webhook = await store.getWebhook(list[0]!.keyId);
  if (!webhook || webhook.disabledAt) return;
  const secret = signingSecret(signingKey, webhook.keyId, webhook.secretVersion);
  for (const delivery of list) {
    if (Date.now() >= stopAt) return;
    const at = deps.now();
    if (!(await store.lease(delivery.id, delivery.nextAttemptAt, new Date(at.getTime() + LEASE_MS)))) continue;
    const timestamp = Math.floor(at.getTime() / 1000);
    const result = await deps.send(webhook.url, { body: delivery.body, headers: deliveryHeaders({ secret, deliveryId: delivery.id, type: delivery.kind, timestamp, body: delivery.body }) });
    if (result.ok) {
      await store.markSent(delivery.id, result.status, deps.now());
      await store.recordResult(webhook.keyId, true, DISABLE_AFTER_FAILURES);
      report.sent += 1;
      continue;
    }
    const attempts = delivery.attempts + 1;
    const wait = retryAfterSeconds(attempts);
    await store.markFailed(delivery.id, { attempts, next: wait === null ? null : new Date(deps.now().getTime() + wait * 1000), status: result.status, error: result.error });
    const before = webhook.failures;
    await store.recordResult(webhook.keyId, false, DISABLE_AFTER_FAILURES);
    if (wait === null) report.gaveUp += 1;
    else report.retrying += 1;
    if (before + 1 >= DISABLE_AFTER_FAILURES) report.disabled += 1;
    return;
  }
}

async function tidy(deps: PassDeps, now: Date, report: PassReport) {
  const last = await deps.store.getCursor("purged");
  if (last && now.getTime() - new Date(last).getTime() < PURGE_EVERY_MS) return;
  report.purged = await deps.store.purge(new Date(now.getTime() - KEEP_DELIVERIES_DAYS * 24 * 3_600_000));
  await deps.store.setCursor("purged", now.toISOString());
}
