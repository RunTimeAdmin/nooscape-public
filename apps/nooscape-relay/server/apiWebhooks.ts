import express, { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ApiTier } from "@shared/apiKey";
import { AGENT_ID_MAX_CHARS, API_CHAINS, agentIdOfKey, apiChainOfProtocol, servedChains } from "./apiChains";
import { API_LICENSE } from "./apiLicense";
import type { ApiKeyRecord } from "./apiKeys";
import type { ApiErrorCode } from "./apiV1";
import { consumeRateLimit, retryAfterSeconds } from "./rateLimit";
import { dbEventSource, type EventSource } from "./webhookEvents";
import { defaultSend, type Send } from "./webhookPass";
import { dbWebhookStore, type WebhookRow, type WebhookStore } from "./webhookStore";
import { DISABLE_AFTER_FAILURES, EVENT_TYPES, WATCH_ADD_LIMIT, WATCH_LIMIT, deliveryHeaders, eventBody, loadSigningKey, signingSecret, webhookUrlProblem } from "./webhooks";

/**
 * Watchlists and the webhook, over the REST API (docs/data-access-2026-10-19.md, stage D5). A Builder or Pro key names the listings it wants
 * to hear about and one https address to hear at. This is the one place the API writes, and what it writes is the key's own watchlist and
 * webhook: nothing here changes a record, a score, a tier or an evidence level, and an event says only what the public API already says.
 * Kept in its own file so the rest of the API can still be shown to write nothing.
 */

/** The lowest tier that may watch and have a webhook. */
const WEBHOOK_MIN_TIER: ApiTier = "builder";
/** Changes to the webhook (setting it, rotating its secret) a key may make a minute: each one that sets it calls the address once. */
export const WEBHOOK_CHANGES_PER_MINUTE = 6;
const RECENT_DELIVERIES = 20;

export type WebhookService = {
  store: WebhookStore;
  entries: EventSource["entries"];
  signingKey: string;
  send: Send;
  now: () => Date;
  newId: () => string;
};

let shared: WebhookService | null | undefined;

/** The service the server runs: null, and so off, until WEBHOOK_SIGNING_KEY is set (and usable). */
export function sharedWebhookService(): WebhookService | null {
  if (shared !== undefined) return shared;
  try {
    const signingKey = loadSigningKey();
    shared = signingKey ? { store: dbWebhookStore, entries: dbEventSource.entries, signingKey, send: defaultSend, now: () => new Date(), newId: randomUUID } : null;
  } catch (error) {
    console.warn("[Webhooks] off:", error instanceof Error ? error.message : String(error));
    shared = null;
  }
  return shared;
}

/** What this file borrows from the router: how it refuses, who is asking, and how it finds a listing. */
type RouteHelpers = {
  fail: (res: Response, code: ApiErrorCode, message: string, extra?: Record<string, unknown>) => void;
  guarded: (res: Response, run: () => Promise<void>) => Promise<void>;
  requireKey: (res: Response) => ApiKeyRecord | null;
  requireTier: (res: Response, minimum: ApiTier) => boolean;
  findEntries: (protocols: readonly string[], externalKey: string) => Promise<Array<{ id: string; protocol: string; externalKey: string }>>;
  describeFailure: (issues: z.core.$ZodIssue[]) => string;
};

const REGISTRY_OPTIONS = ["solana_8004", "solana_said", "solana_registry", "solana_agenc"] as const;
const addSchema = z.object({ agents: z.array(z.object({ chain: z.string().max(16), id: z.string().max(AGENT_ID_MAX_CHARS), registry: z.enum(REGISTRY_OPTIONS).optional() }).strict()).min(1).max(WATCH_ADD_LIMIT) }).strict();
const setSchema = z.object({ url: z.unknown().optional() }).strict();
const ENTRY_ID = /^[A-Za-z0-9-]{1,36}$/;
const PING_MESSAGE = "A test from Nooscape. It is not about any agent.";

type WatchStatus = "added" | "already_watching" | "not_found" | "ambiguous" | "bad_request" | "limit_reached";

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

/** Runs one call at a time for each key. Held in this process, like the rate limits, which is where the site runs. */
const tails = new Map<string, Promise<unknown>>();
function serial<T>(keyId: string, run: () => Promise<T>): Promise<T> {
  const result = (tails.get(keyId) ?? Promise.resolve()).then(run, run);
  const tail = result.catch(() => undefined);
  tails.set(keyId, tail);
  void tail.then(() => {
    if (tails.get(keyId) === tail) tails.delete(keyId);
  });
  return result;
}

export function webhookRoutes(service: WebhookService | null, helpers: RouteHelpers): Router {
  const router = Router({ caseSensitive: true });
  const { fail, guarded, requireKey, requireTier } = helpers;

  const envelope = (data: Record<string, unknown>) => ({ api_version: "v1", as_of: (service?.now() ?? new Date()).toISOString(), license: API_LICENSE, data });
  const reply = (res: Response, data: Record<string, unknown>) => {
    res.set("Cache-Control", "no-store");
    res.json(envelope(data));
  };

  /** The key must be a Builder or Pro key (checked before a body is read), and the service must be there to answer. */
  const open = (_req: Request, res: Response, next: () => void) => {
    if (!requireKey(res) || !requireTier(res, WEBHOOK_MIN_TIER)) return;
    next();
  };
  const ready = async (res: Response): Promise<WebhookService | null> => {
    if (service && (await service.store.ready())) return service;
    res.set("Cache-Control", "no-store");
    fail(res, "unavailable", "Watchlists and webhooks are not available yet.");
    return null;
  };
  const keyOf = (res: Response) => (res.locals.apiKey as ApiKeyRecord).id;
  const secretOf = (hook: WebhookRow) => signingSecret(service!.signingKey, hook.keyId, hook.secretVersion);
  const tooOften = (res: Response, keyId: string) => {
    const verdict = consumeRateLimit(`webhook-change:${keyId}`, WEBHOOK_CHANGES_PER_MINUTE, 60_000);
    if (verdict.allowed) return false;
    res.set("Retry-After", String(retryAfterSeconds(verdict.retryAfterMs)));
    fail(res, "rate_limited", "The webhook was changed too often. Try again shortly.");
    return true;
  };

  const webhookData = (hook: WebhookRow) => ({
    configured: true,
    url: hook.url,
    status: hook.disabledAt ? "off" : "active",
    off_since: iso(hook.disabledAt),
    consecutive_failures: hook.failures,
    turned_off_after_failures: DISABLE_AFTER_FAILURES,
    secret_version: hook.secretVersion,
    signing_secret: secretOf(hook),
    events: EVENT_TYPES,
    created_at: iso(hook.createdAt),
    updated_at: iso(hook.updatedAt),
  });

  // ------------------------------------------------------------ the watchlist

  router.get("/watches", open, (_req, res) =>
    guarded(res, async () => {
      const live = await ready(res);
      if (!live) return;
      const watches = await live.store.listWatches(keyOf(res));
      const entries = new Map((await live.entries(watches.map(watch => watch.entryId))).map(entry => [entry.id, entry]));
      reply(res, {
        limit: WATCH_LIMIT,
        watching: watches.length,
        watches: watches.map(watch => {
          const entry = entries.get(watch.entryId);
          const chain = entry ? apiChainOfProtocol(entry.protocol, servedChains()) : null;
          return {
            nooscape_id: watch.entryId,
            chain,
            agent_id: entry && chain ? agentIdOfKey(chain, entry.externalKey) : null,
            registry: entry && chain ? entry.protocol : null,
            listed: entry?.visible ?? false,
            watching_since: iso(watch.createdAt),
            page_url: `https://nooscape.si/agents/${watch.entryId}`,
          };
        }),
      });
    })
  );

  router.post("/watches", open, express.json({ limit: "4kb" }), (req, res) =>
    guarded(res, async () => {
      const live = await ready(res);
      if (!live) return;
      const parsed = addSchema.safeParse(req.body);
      if (!parsed.success) return fail(res, "bad_request", helpers.describeFailure(parsed.error.issues));
      const keyId = keyOf(res);
      // The chains the API serves now: the original three, and each extra chain whose switch is on.
      const served = servedChains();
      // One at a time for a key: two calls that both see room would between them go past the limit.
      await serial(keyId, async () => {
        const already = new Set((await live.store.listWatches(keyId)).map(watch => watch.entryId));
        let room = WATCH_LIMIT - already.size;
        const toAdd: string[] = [];
        const results: Array<{ chain: string; id: string; status: WatchStatus; nooscape_id: string | null; message: string | null }> = [];
        for (const item of parsed.data.agents) {
          const chain = served.find(key => key === item.chain);
          const refuse = (status: WatchStatus, message: string) => results.push({ chain: item.chain, id: item.id, status, nooscape_id: null, message });
          if (!chain) {
            refuse("bad_request", `chain must be one of ${served.join(", ")}`);
            continue;
          }
          const table = API_CHAINS[chain];
          if (!table.idPattern.test(item.id)) {
            refuse("bad_request", chain === "solana" ? "id must be a Solana address" : "id must be a registry token id (digits only)");
            continue;
          }
          if (item.registry && chain !== "solana") {
            refuse("bad_request", "registry applies to solana only");
            continue;
          }
          const matches = await helpers.findEntries(item.registry ? [item.registry] : table.protocols, table.keyOf(item.id));
          if (matches.length === 0) {
            refuse("not_found", "No listed agent has that id on that chain.");
            continue;
          }
          if (matches.length > 1) {
            refuse("ambiguous", `More than one registry lists that address. Add registry=: ${matches.map(match => match.protocol).sort().join(", ")}.`);
            continue;
          }
          const entryId = matches[0]!.id;
          if (already.has(entryId)) {
            results.push({ chain: item.chain, id: item.id, status: "already_watching", nooscape_id: entryId, message: null });
          } else if (room <= 0) {
            results.push({ chain: item.chain, id: item.id, status: "limit_reached", nooscape_id: entryId, message: `A key may watch ${WATCH_LIMIT} listings.` });
          } else {
            already.add(entryId);
            toAdd.push(entryId);
            room -= 1;
            results.push({ chain: item.chain, id: item.id, status: "added", nooscape_id: entryId, message: null });
          }
        }
        await live.store.addWatches(keyId, toAdd);
        reply(res, { limit: WATCH_LIMIT, watching: already.size, results });
      });
    })
  );

  router.delete("/watches/:entry", open, (req, res) =>
    guarded(res, async () => {
      const live = await ready(res);
      if (!live) return;
      const entryId = req.params.entry ?? "";
      if (!ENTRY_ID.test(entryId)) return fail(res, "bad_request", "The id is the nooscape_id of a watched listing.");
      if (!(await live.store.removeWatch(keyOf(res), entryId))) return fail(res, "not_found", "That listing is not on this key's watchlist.");
      reply(res, { removed: true, nooscape_id: entryId });
    })
  );

  router.all(["/watches", "/watches/:entry"], (req, res) => {
    res.set("Allow", req.path === "/watches" ? "GET, POST, OPTIONS" : "DELETE, OPTIONS");
    fail(res, "method_not_allowed", req.path === "/watches" ? "The watchlist takes GET and POST." : "A watch is removed with DELETE.");
  });

  // ------------------------------------------------------------ the webhook

  router.get("/webhook", open, (_req, res) =>
    guarded(res, async () => {
      const live = await ready(res);
      if (!live) return;
      const hook = await live.store.getWebhook(keyOf(res));
      reply(res, hook ? webhookData(hook) : { configured: false, events: EVENT_TYPES });
    })
  );

  router.put("/webhook", open, express.json({ limit: "2kb" }), (req, res) =>
    guarded(res, async () => {
      const live = await ready(res);
      if (!live) return;
      const parsed = setSchema.safeParse(req.body);
      if (!parsed.success) return fail(res, "bad_request", helpers.describeFailure(parsed.error.issues));
      const problem = webhookUrlProblem(parsed.data.url);
      if (problem) return fail(res, "bad_request", problem);
      const keyId = keyOf(res);
      if (tooOften(res, keyId)) return;
      const hook = await live.store.setWebhook(keyId, parsed.data.url as string);
      // The address is called once, now, with a ping that says what it is, so its owner sees at once whether it is right. It is saved either way.
      const at = live.now();
      const id = live.newId();
      const body = eventBody({ id, type: "ping", createdAt: at, agent: null, data: { message: PING_MESSAGE } });
      const result = await live.send(hook.url, { body, headers: deliveryHeaders({ secret: secretOf(hook), deliveryId: id, type: "ping", timestamp: Math.floor(at.getTime() / 1000), body }) });
      reply(res, { ...webhookData(hook), ping: result.ok ? { ok: true, status: result.status } : { ok: false, status: result.status, error: result.error } });
    })
  );

  router.delete("/webhook", open, (_req, res) =>
    guarded(res, async () => {
      const live = await ready(res);
      if (!live) return;
      reply(res, { removed: await live.store.deleteWebhook(keyOf(res)), configured: false });
    })
  );

  router.post("/webhook/rotate-secret", open, (_req, res) =>
    guarded(res, async () => {
      const live = await ready(res);
      if (!live) return;
      const keyId = keyOf(res);
      if (tooOften(res, keyId)) return;
      const hook = await live.store.rotateSecret(keyId);
      if (!hook) return fail(res, "not_found", "This key has no webhook. Set one with PUT /api/v1/webhook.");
      reply(res, webhookData(hook));
    })
  );

  router.get("/webhook/deliveries", open, (_req, res) =>
    guarded(res, async () => {
      const live = await ready(res);
      if (!live) return;
      const rows = await live.store.recent(keyOf(res), RECENT_DELIVERIES);
      reply(res, {
        deliveries: rows.map(row => ({
          id: row.id,
          type: row.kind,
          nooscape_id: row.entryId,
          status: row.status,
          attempts: row.attempts,
          last_status: row.lastStatus,
          last_error: row.lastError,
          next_attempt_at: row.status === "pending" ? iso(row.nextAttemptAt) : null,
          created_at: iso(row.createdAt),
          sent_at: iso(row.sentAt),
        })),
      });
    })
  );

  router.all(["/webhook", "/webhook/rotate-secret", "/webhook/deliveries"], (req, res) => {
    const [allowed, words] = req.path === "/webhook" ? ["GET, PUT, DELETE, OPTIONS", "GET, PUT and DELETE"] : req.path === "/webhook/rotate-secret" ? ["POST, OPTIONS", "POST"] : ["GET, OPTIONS", "GET"];
    res.set("Allow", allowed);
    fail(res, "method_not_allowed", `This takes ${words}.`);
  });

  return router;
}

/** Whether a path under /api/v1 is one of this file's, so the router's read-only method guard leaves it to this file. */
export const isWebhookPath = (path: string) => ["/watches", "/webhook"].some(root => path === root || path.startsWith(`${root}/`));
