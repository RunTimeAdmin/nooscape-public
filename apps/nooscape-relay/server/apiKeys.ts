import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { API_TIER_NAMES, API_TIERS, KEY_PATTERN, KEY_PREFIX_LENGTH, type ApiTier } from "@shared/apiKey";
import { apiKeys, apiUsage } from "../drizzle/schema";
import { getDb, requireDb } from "./db";
import { consumeRateLimit } from "./rateLimit";

/**
 * API keys and their metering (docs/data-access-2026-10-19.md, stage D2). A key is a way to ask the REST API for more: a higher limit
 * and the endpoints that need one. It never changes what is served, and payment never changes a record, a tier or an evidence level.
 *
 * The key is 30 random bytes shown once, when it is made, and never stored: the table holds its SHA-256, which is enough to find it
 * again because a guess cannot be made. No network address is kept with a key or its usage. What is counted is how many requests a
 * key made to which endpoint on which UTC day. The counting is held in memory and written in batches every few seconds, so a busy key
 * adds a few writes and not one for each request, and a restart can lose a few seconds of counts and no more.
 *
 * Free keys are self-serve. The paid tiers are set by the operator by hand; nothing here takes a payment.
 */

export { API_TIER_NAMES, API_TIERS, KEY_PATTERN, KEY_PREFIX_LENGTH, type ApiTier };

/** A key lives at most this many requests a minute from one address, whatever its tier: a stolen key or one shared behind one address. */
export const KEY_ADDRESS_PER_MINUTE = 300;
/** Keys made from one address in a day, and live keys for one email. */
export const SIGNUPS_PER_ADDRESS_PER_DAY = 3;
export const LIVE_KEYS_PER_EMAIL = 3;

export type ApiKeyErrorCode = "UNAVAILABLE" | "BAD_EMAIL" | "TOO_MANY_SIGNUPS" | "TOO_MANY_KEYS" | "NOT_FOUND" | "BAD_TIER";

export const API_KEY_MESSAGES: Record<ApiKeyErrorCode, string> = {
  UNAVAILABLE: "API keys are not available right now.",
  BAD_EMAIL: "That is not an email address.",
  TOO_MANY_SIGNUPS: "Too many keys were made from this address today. Try again tomorrow.",
  TOO_MANY_KEYS: "That email already has the most live keys it may hold. Revoke one first.",
  NOT_FOUND: "That key is not in use.",
  BAD_TIER: "That is not a tier.",
};

export class ApiKeyError extends Error {
  constructor(readonly code: ApiKeyErrorCode) {
    super(API_KEY_MESSAGES[code]);
    this.name = "ApiKeyError";
  }
}

// ---------------------------------------------------------------- the key

export const hashApiKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");

/** A new key: "nsk_" and 40 characters from 30 random bytes. Its hash is what is stored. */
export function newApiKey(): { key: string; hash: string; prefix: string } {
  const key = `nsk_${randomBytes(30).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, KEY_PREFIX_LENGTH) };
}

/** An email as it is stored (trimmed, lower case), or null when it cannot be one. No mail is sent to it. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  // eslint-disable-next-line no-control-regex
  if (email.length < 6 || email.length > 254 || /[\u0000-\u001F\u007F\s]/.test(email)) return null;
  return /^[^@]{1,64}@[^@]{1,190}\.[^@.]{2,}$/.test(email) ? email : null;
}

export const isApiTier = (value: string): value is ApiTier => (API_TIER_NAMES as readonly string[]).includes(value);

// ---------------------------------------------------------------- the tables

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function driverErrorHas(error: unknown, code: string): boolean {
  for (let depth = 0, cause: unknown = error; cause && typeof cause === "object" && depth < 4; depth += 1) {
    if ((cause as { code?: unknown }).code === code) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/** Runs a database step, answering "keys are not available" when the tables are missing and passing every other failure up. */
async function withTables<T>(step: (db: Db) => Promise<T>): Promise<T> {
  try {
    return await step(requireDb(await getDb()));
  } catch (error) {
    if (driverErrorHas(error, "ER_NO_SUCH_TABLE")) throw new ApiKeyError("UNAVAILABLE");
    throw error;
  }
}

export type ApiKeyRecord = { id: string; tier: ApiTier; prefix: string };

type KeyCacheEntry = { record: ApiKeyRecord | null; until: number };
const KEY_CACHE_MS = 30_000;
const KEY_CACHE_MAX = 10_000;
const keyCache = new Map<string, KeyCacheEntry>();

/** Forgets what was read about a key (a revoke or a change of tier takes effect at once in this process). */
export function forgetKey(hash: string) {
  keyCache.delete(hash);
}
export function clearKeyCache() {
  keyCache.clear();
}

/**
 * The live key a request carries, or null. Held for 30 seconds, an unknown key too, so a key in use costs one read in half a minute and
 * a flood of one wrong key costs one. A key that was never made costs a read each time; the caller counts those against the address.
 */
export async function resolveApiKey(rawKey: string, now: () => number = Date.now): Promise<ApiKeyRecord | null> {
  if (!KEY_PATTERN.test(rawKey)) return null;
  const hash = hashApiKey(rawKey);
  const cached = keyCache.get(hash);
  if (cached && cached.until > now()) return cached.record;
  const record = await withTables(async db => {
    const [row] = await db.select({ id: apiKeys.id, tier: apiKeys.tier, prefix: apiKeys.keyPrefix, revokedAt: apiKeys.revokedAt }).from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
    return row && row.revokedAt === null && isApiTier(row.tier) ? { id: row.id, tier: row.tier, prefix: row.prefix } : null;
  });
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(hash, { record, until: now() + KEY_CACHE_MS });
  return record;
}

/** Makes a free key for an email and returns it once. `clientKey` is who is asking, for the limit on keys from one address. */
export async function createApiKey(input: { email: string; clientKey: string }): Promise<{ key: string; id: string; prefix: string; tier: ApiTier }> {
  const email = normalizeEmail(input.email);
  if (!email) throw new ApiKeyError("BAD_EMAIL");
  const verdict = consumeRateLimit(`api-key-signup:${input.clientKey}`, SIGNUPS_PER_ADDRESS_PER_DAY, 24 * 60 * 60 * 1000);
  if (!verdict.allowed) throw new ApiKeyError("TOO_MANY_SIGNUPS");
  return withTables(async db => {
    const [live] = await db.select({ total: count() }).from(apiKeys).where(and(eq(apiKeys.ownerEmail, email), isNull(apiKeys.revokedAt)));
    if (Number(live?.total ?? 0) >= LIVE_KEYS_PER_EMAIL) throw new ApiKeyError("TOO_MANY_KEYS");
    const made = newApiKey();
    const id = randomUUID();
    await db.insert(apiKeys).values({ id, keyHash: made.hash, keyPrefix: made.prefix, ownerEmail: email, tier: "free" });
    return { key: made.key, id, prefix: made.prefix, tier: "free" as const };
  });
}

/** Ends a key, for the owner who holds it. A revoked key stays in the table with its usage. */
export async function revokeApiKey(rawKey: string): Promise<{ prefix: string }> {
  if (!KEY_PATTERN.test(rawKey)) throw new ApiKeyError("NOT_FOUND");
  const hash = hashApiKey(rawKey);
  return withTables(async db => {
    const [row] = await db.select({ id: apiKeys.id, prefix: apiKeys.keyPrefix }).from(apiKeys).where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt))).limit(1);
    if (!row) throw new ApiKeyError("NOT_FOUND");
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, row.id));
    forgetKey(hash);
    return { prefix: row.prefix };
  });
}

export type OperatorKey = { id: string; prefix: string; ownerEmail: string; tier: string; createdAt: Date; revokedAt: Date | null; lastUsedAt: Date | null };

/** Keys for the operator's tool: those of one email, or the newest. At most 50. */
export async function listKeysForOperator(email?: string): Promise<OperatorKey[]> {
  const wanted = email === undefined ? null : normalizeEmail(email);
  if (email !== undefined && !wanted) throw new ApiKeyError("BAD_EMAIL");
  return withTables(async db => {
    const rows = await db
      .select({ id: apiKeys.id, prefix: apiKeys.keyPrefix, ownerEmail: apiKeys.ownerEmail, tier: apiKeys.tier, createdAt: apiKeys.createdAt, revokedAt: apiKeys.revokedAt, lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(wanted ? eq(apiKeys.ownerEmail, wanted) : undefined)
      .orderBy(desc(apiKeys.createdAt))
      .limit(50);
    return rows;
  });
}

/** The operator sets a key's tier. The paid tiers are only ever set here, by hand. */
export async function setKeyTier(id: string, tier: string): Promise<{ id: string; tier: ApiTier }> {
  if (!isApiTier(tier)) throw new ApiKeyError("BAD_TIER");
  return withTables(async db => {
    const [row] = await db.select({ id: apiKeys.id, hash: apiKeys.keyHash }).from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    if (!row) throw new ApiKeyError("NOT_FOUND");
    await db.update(apiKeys).set({ tier }).where(eq(apiKeys.id, id));
    forgetKey(row.hash);
    return { id, tier };
  });
}

/** The operator ends a key. */
export async function revokeKeyById(id: string): Promise<{ id: string }> {
  return withTables(async db => {
    const [row] = await db.select({ id: apiKeys.id, hash: apiKeys.keyHash }).from(apiKeys).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt))).limit(1);
    if (!row) throw new ApiKeyError("NOT_FOUND");
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
    forgetKey(row.hash);
    return { id };
  });
}

// ---------------------------------------------------------------- the counting

export type UsageRow = { keyId: string; day: string; endpoint: string; count: number };

/** Where the counts live. The default is the database; a test gives its own. */
export type UsageStore = {
  loadDay: (keyId: string, day: string) => Promise<number>;
  addUsage: (rows: UsageRow[]) => Promise<void>;
  touch: (keyIds: string[], at: Date) => Promise<void>;
};

export const dbUsageStore: UsageStore = {
  loadDay: (keyId, day) =>
    withTables(async db => {
      const [row] = await db.select({ total: sql<string>`coalesce(sum(${apiUsage.count}), 0)` }).from(apiUsage).where(and(eq(apiUsage.keyId, keyId), eq(apiUsage.day, day)));
      return Number(row?.total ?? 0);
    }),
  addUsage: rows =>
    withTables(async db => {
      if (rows.length === 0) return;
      await db.insert(apiUsage).values(rows).onDuplicateKeyUpdate({ set: { count: sql`${apiUsage.count} + VALUES(${apiUsage.count})` } });
    }),
  touch: (keyIds, at) =>
    withTables(async db => {
      if (keyIds.length === 0) return;
      await db.update(apiKeys).set({ lastUsedAt: at }).where(inArray(apiKeys.id, keyIds));
    }),
};

export const utcDay = (date: Date) => date.toISOString().slice(0, 10);
const nextUtcMidnight = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));

export type MeterResult = { allowed: boolean; limit: number; used: number; remaining: number; resetsAt: Date };

/**
 * The day's count for each key, and the request that would pass it refused. The total for a key is read from the table once a day and
 * then counted in memory; what is counted is written every `flushEveryMs`, as one batch. This server runs one process (the host's
 * note says so at start), so one process holds every count.
 */
export class ApiMeter {
  private totals = new Map<string, { day: string; total: number }>();
  private loading = new Map<string, Promise<void>>();
  private pending = new Map<string, UsageRow>();
  private touched = new Set<string>();
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFailureLogAt = 0;

  constructor(
    private readonly store: UsageStore,
    private readonly now: () => Date = () => new Date(),
    private readonly flushEveryMs = 20_000
  ) {}

  /** Counts one request for a key and endpoint, or refuses it when the key has used its day. A refused request is not counted. */
  async consume(keyId: string, perDay: number, endpoint: string): Promise<MeterResult> {
    const now = this.now();
    const day = utcDay(now);
    let entry = this.totals.get(keyId);
    if (!entry || entry.day !== day) {
      await this.load(keyId, day);
      entry = this.totals.get(keyId)!;
    }
    const resetsAt = nextUtcMidnight(now);
    if (entry.total >= perDay) return { allowed: false, limit: perDay, used: entry.total, remaining: 0, resetsAt };
    entry.total += 1;
    const slot = `${keyId}|${day}|${endpoint}`;
    const row = this.pending.get(slot);
    if (row) row.count += 1;
    else this.pending.set(slot, { keyId, day, endpoint, count: 1 });
    this.touched.add(keyId);
    return { allowed: true, limit: perDay, used: entry.total, remaining: perDay - entry.total, resetsAt };
  }

  private load(keyId: string, day: string): Promise<void> {
    const slot = `${keyId}|${day}`;
    let pending = this.loading.get(slot);
    if (!pending) {
      pending = this.store
        .loadDay(keyId, day)
        .then(total => {
          this.totals.set(keyId, { day, total });
        })
        .finally(() => this.loading.delete(slot));
      this.loading.set(slot, pending);
    }
    return pending;
  }

  /**
   * Writes what has been counted, and waits for a write already under way first, so that on return everything counted before the call
   * is in the table (or kept for the next try when the table could not be written).
   */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
    if (this.pending.size === 0 && this.touched.size === 0) return;
    this.flushing = this.write().finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  /** How many keys the meter holds a day's total for. Only keys used today are held, so it is bounded by the day's active keys. */
  trackedKeys(): number {
    return this.totals.size;
  }

  /** A total for a day that has passed is not needed: a key that comes back reads its new day from the table once. */
  private pruneStaleTotals() {
    const today = utcDay(this.now());
    for (const [keyId, entry] of Array.from(this.totals.entries())) if (entry.day !== today) this.totals.delete(keyId);
  }

  /** One batch. Never rejects: what cannot be written is kept and tried again at the next flush. */
  private async write(): Promise<void> {
    this.pruneStaleTotals();
    const rows = Array.from(this.pending.values());
    const keyIds = Array.from(this.touched);
    this.pending = new Map();
    this.touched = new Set();
    try {
      if (rows.length > 0) await this.store.addUsage(rows);
    } catch (error) {
      // Nothing was written: put the counts back, beside any counted since.
      for (const row of rows) {
        const slot = `${row.keyId}|${row.day}|${row.endpoint}`;
        const again = this.pending.get(slot);
        if (again) again.count += row.count;
        else this.pending.set(slot, row);
      }
      for (const keyId of keyIds) this.touched.add(keyId);
      return this.logFailure(error);
    }
    try {
      if (keyIds.length > 0) await this.store.touch(keyIds, this.now());
    } catch (error) {
      // The counts are written and must not be written again: only the "last used" dates are tried again.
      for (const keyId of keyIds) this.touched.add(keyId);
      this.logFailure(error);
    }
  }

  private logFailure(error: unknown) {
    const at = Date.now();
    if (at - this.lastFailureLogAt <= 60_000) return;
    this.lastFailureLogAt = at;
    console.warn("[ApiKeys] could not write usage; it will be tried again:", error instanceof Error ? error.message.split("\nparams:")[0] : String(error));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushEveryMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const apiMeter = new ApiMeter(dbUsageStore);

export type UsageReport = {
  today: { date: string; used: number; remaining: number; limit: number; resetsAt: Date };
  days: Array<{ date: string; total: number; endpoints: Record<string, number> }>;
};

/** A key's use: today against its limit, and the last `days` UTC days by endpoint, newest first. Counts not yet written are included. */
export async function readKeyUsage(record: ApiKeyRecord, days = 30, meter: ApiMeter = apiMeter, now: () => Date = () => new Date()): Promise<UsageReport> {
  await meter.flush();
  const today = utcDay(now());
  const since = utcDay(new Date(now().getTime() - (days - 1) * 24 * 60 * 60 * 1000));
  const rows = await withTables(db =>
    db.select({ day: apiUsage.day, endpoint: apiUsage.endpoint, count: apiUsage.count }).from(apiUsage).where(and(eq(apiUsage.keyId, record.id), gte(apiUsage.day, since))).orderBy(desc(apiUsage.day))
  );
  const byDay = new Map<string, { date: string; total: number; endpoints: Record<string, number> }>();
  for (const row of rows) {
    const entry = byDay.get(row.day) ?? { date: row.day, total: 0, endpoints: {} };
    entry.total += row.count;
    entry.endpoints[row.endpoint] = (entry.endpoints[row.endpoint] ?? 0) + row.count;
    byDay.set(row.day, entry);
  }
  const limit = API_TIERS[record.tier].perDay;
  const used = byDay.get(today)?.total ?? 0;
  return { today: { date: today, used, remaining: Math.max(limit - used, 0), limit, resetsAt: nextUtcMidnight(now()) }, days: Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? 1 : -1)) };
}
