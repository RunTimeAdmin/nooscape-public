import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";

/**
 * Minimal in-memory fixed-window rate limiting for the public relay surface.
 *
 * The window starts at the first request for a key and resets after `windowMs`,
 * mirroring the operator login limiter in operatorAuth.ts. State is per-process
 * and intentionally in-memory: the relay runs as a single node behind the
 * Hostinger reverse proxy, and these limits guard against anonymous abuse
 * rather than enforce billing-grade quotas. The hard cost ceiling for the
 * seed-only comparison LLM is the daily call budget in routers.ts, which is
 * IP-independent.
 *
 * Two properties keep the limiter from being the thing that falls over:
 * - An IPv6 client is keyed by its /64, because one residential connection owns
 *   a whole /64 and every address in it would otherwise be a fresh budget.
 * - The table is bounded. When it is full of live windows, a client it has not
 *   seen shares one overflow budget per limit instead of growing the table, so
 *   a flood of new keys degrades to "everyone new shares one budget" and never
 *   to a slow server. (The earlier version scanned the whole table for every
 *   new key once it held 10,000, which cost 29 seconds for 50,000 keys.)
 */

type Bucket = { count: number; startedAt: number; windowMs: number };

export const MAX_TRACKED_KEYS = 50_000;
/** A full table is swept for expired windows at most this often, so a flood cannot make every request scan it. */
const FULL_TABLE_SWEEP_MS = 1000;

const buckets = new Map<string, Bucket>();
let lastSweepAt = 0;

type RateLimitVerdict = {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
};

/** The eight 16-bit groups of an IPv6 address, or null when the text is not one. */
function ipv6Groups(address: string): number[] | null {
  let text = address.trim().toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (isIP(text) !== 6) return null;
  // A dotted IPv4 tail (::ffff:203.0.113.7) stands for the last two groups.
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
  const groups = [...head, ...Array.from({ length: missing }, () => "0"), ...rest].map(group => parseInt(group, 16));
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/**
 * The key a client is counted under. IPv4 stays as it is, an IPv4-mapped IPv6
 * address becomes its IPv4 form, and any other IPv6 address becomes its /64.
 * Anything that is not an address (such as "unknown") is kept, cut to 64 characters.
 */
export function clientBucketKey(ip: string | null | undefined): string {
  if (!ip) return "unknown";
  const groups = ipv6Groups(ip);
  if (!groups) return ip.slice(0, 64);
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  return `${groups.slice(0, 4).map(group => group.toString(16).padStart(4, "0")).join(":")}::/64`;
}

/** Drops every window that has run out. */
export function sweepExpiredRateLimits(now = Date.now()) {
  lastSweepAt = now;
  buckets.forEach((bucket, key) => {
    if (now - bucket.startedAt >= bucket.windowMs) buckets.delete(key);
  });
}

/** Whether a window still has room, without taking a place in it. The answer is the one `consumeRateLimit` would give, bar the count. */
export function peekRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitVerdict {
  let bucket = buckets.get(key);
  // A full table counts a client it has no room for in a shared window; the peek looks where the count would go.
  if (!bucket && buckets.size >= MAX_TRACKED_KEYS) bucket = buckets.get(`overflow|${limit}|${windowMs}`);
  if (!bucket || now - bucket.startedAt >= windowMs) return { allowed: true, retryAfterMs: 0, remaining: limit };
  if (bucket.count >= limit) return { allowed: false, retryAfterMs: windowMs - (now - bucket.startedAt), remaining: 0 };
  return { allowed: true, retryAfterMs: 0, remaining: Math.max(limit - bucket.count, 0) };
}

export function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): RateLimitVerdict {
  let bucketKey = key;
  let bucket = buckets.get(bucketKey);
  if (!bucket && buckets.size >= MAX_TRACKED_KEYS) {
    // Full: first let go of whatever has expired, then, if it is still full, count this client in the shared overflow window.
    if (now - lastSweepAt >= FULL_TABLE_SWEEP_MS) sweepExpiredRateLimits(now);
    if (buckets.size >= MAX_TRACKED_KEYS) {
      bucketKey = `overflow|${limit}|${windowMs}`;
      bucket = buckets.get(bucketKey);
    }
  }
  if (!bucket || now - bucket.startedAt >= windowMs) {
    buckets.set(bucketKey, { count: 1, startedAt: now, windowMs });
    return { allowed: true, retryAfterMs: 0, remaining: Math.max(limit - 1, 0) };
  }
  if (bucket.count >= limit) {
    return { allowed: false, retryAfterMs: windowMs - (now - bucket.startedAt), remaining: 0 };
  }
  bucket.count += 1;
  return { allowed: true, retryAfterMs: 0, remaining: Math.max(limit - bucket.count, 0) };
}

/**
 * Client identity for limit buckets. Uses Express's req.ip, which respects
 * the app's `trust proxy` setting and extracts the correct client IP from
 * X-Forwarded-For based on the trusted proxy hop count. Direct X-Forwarded-For
 * parsing is vulnerable to spoofing by untrusted clients. An IPv6 address is
 * reduced to its /64 (see clientBucketKey).
 */
export function clientKeyFrom(request: {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string | null;
}): string {
  return clientBucketKey(request.ip);
}

/** Whole seconds a refused caller is told to wait: never under one, since a Retry-After of 0 invites an immediate retry. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(Math.ceil(retryAfterMs / 1000), 1);
}

/** Express middleware applying a fixed-window limit per client key. */
export function rateLimitExpress(name: string, limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientKey = clientKeyFrom(req);
    const verdict = consumeRateLimit(`${name}:${clientKey}`, limit, windowMs);
    if (!verdict.allowed) {
      const seconds = retryAfterSeconds(verdict.retryAfterMs);
      console.warn(`[RateLimit] ${name} limit reached for ${clientKey} (retry in ${seconds}s)`);
      res.set("Retry-After", String(seconds));
      res.status(429).json({ error: "Too many requests. Try again later." });
      return;
    }
    next();
  };
}

/** Test helper: clears all tracked windows. */
export function resetRateLimits() {
  buckets.clear();
  lastSweepAt = 0;
}
