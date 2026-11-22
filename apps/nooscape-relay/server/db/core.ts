/** The database handles: the pool and its guard, getDb and requireDb, and the operator account. Part of server/db.ts, which re-exports every module of this folder. */
import { eq, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool } from "mysql2";
import { createHash } from "node:crypto";
import { ingestionSources, users } from "../../drizzle/schema";
import { breakerStream, databaseBreaker, guardPool } from "../dbBreaker";
import { protocolsOfChainsOff } from "@shared/chains";

let _db: ReturnType<typeof drizzle> | null = null;

/**
 * The host caps this database account at 500 new connections an hour. Past that
 * it refuses every further connection until the hour turns over
 * (ER_USER_LIMIT_REACHED, "max_connections_per_hour"), which took down the
 * operator console and every other call that needs a fresh connection. A
 * connection is therefore a budgeted resource, and the pool keeps the ones it has.
 *
 * Idle connections used to be retired on a timer (maxIdle 5, idleTimeout 45 s)
 * so the host's idle killer could not sever them silently. mysql2 destroys every
 * free connection beyond maxIdle within a second, and every connection idle past
 * idleTimeout, so any burst after a quiet moment reopened up to ten, and the
 * pages that poll every 8 to 20 seconds spent the hour's budget. maxIdle now
 * equals connectionLimit, which leaves mysql2's idle reaper off, and TCP
 * keepalive probes every 10 s keep an idle connection from being dropped without
 * notice (the default delay is the OS's two hours). A connection that does die is
 * noticed by the probe or the close and leaves the pool. If the host does refuse a
 * connection, dbBreaker.ts stops every request from dialling it again until a
 * cooldown has passed.
 *
 * A request also stops waiting for a connection after DB_ACQUIRE_TIMEOUT_MS
 * (guardPool). Without that, a database that stops answering holds all eight
 * connections in hung queries and every request behind them waits for as long as
 * the freeze lasts. The wait is long on purpose: while the cached aggregates
 * rebuild they hold most of the connections for several seconds, and a visitor
 * who waits that out gets a right answer where a short limit would give an empty
 * one. queueLimit is only a memory valve against that queue growing without bound.
 */
export const DB_POOL_OPTIONS = { connectionLimit: 8, maxIdle: 8, queueLimit: 2_000, enableKeepAlive: true, keepAliveInitialDelay: 10_000 } as const;

/** How long a request waits for a pooled connection before it is answered as a failed read. */
export const DB_ACQUIRE_TIMEOUT_MS = 30_000;

/** A process opens about ten connections and keeps them, so this many inside an hour means the pool is churning. */
export const DB_CONNECTIONS_WARN_PER_HOUR = 150;

/**
 * Logs once per hour-long window when the process has opened an unusual number
 * of connections, so a pool that starts churning again (a host that drops idle
 * connections, a code path that bypasses the pool) shows in the runtime log long
 * before the host's cap does.
 */
export function watchPoolConnections(pool: { on(event: "connection", listener: () => void): unknown }, now: () => number = Date.now) {
  let windowStart = now();
  let opened = 0;
  pool.on("connection", () => {
    if (now() - windowStart >= 3_600_000) {
      windowStart = now();
      opened = 0;
    }
    opened += 1;
    if (opened === DB_CONNECTIONS_WARN_PER_HOUR) {
      console.warn(`[Database] ${opened} connections opened within an hour; the host refuses new ones at 500.`);
    }
  });
}

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const pool = createPool({ uri: process.env.DATABASE_URL, ...DB_POOL_OPTIONS, stream: breakerStream(databaseBreaker) });
      watchPoolConnections(pool);
      guardPool(pool, databaseBreaker, { acquireTimeoutMs: DB_ACQUIRE_TIMEOUT_MS });
      _db = drizzle(pool);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export function requireDb<T>(db: T | null): T {
  if (!db) throw new Error("Nooscape live data requires a configured database.");
  return db;
}

export function safeErrorSummary(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown ingestion error";
  return message.replace(/[\r\n]+/g, " ").slice(0, 1000);
}

export function mapPositionFromHandle(handle: string) {
  let hash = 0;
  for (const character of handle) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { x: 12 + (hash % 76), y: 14 + ((hash >>> 8) % 70) };
}

export function hashValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Version of the single published evidence-tier scale (docs/evidence-tier-scale-v1-2026-10-08.md). */
export const EVIDENCE_TIER_SCALE_VERSION = "evidence-tier-v1";

/** Domain-control verification is not permanent: a recheck renews this window. */
export const DOMAIN_VERIFICATION_VALIDITY_DAYS = 90;

export function domainVerificationExpiry(now: Date) {
  return new Date(now.getTime() + DOMAIN_VERIFICATION_VALIDITY_DAYS * 24 * 60 * 60 * 1_000);
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * Ensures the production-only operator token resolves to a persistent audit actor.
 * The token itself is never stored in the database: it exists only as a server
 * environment variable and is checked before this function is called.
 */
export async function ensureProductionOperator() {
  const db = requireDb(await getDb());
  const openId = "nooscape-production-operator";

  await db
    .insert(users)
    .values({
      openId,
      name: "Nooscape production operator",
      loginMethod: "server-operator-token",
      role: "admin",
      lastSignedIn: new Date(),
    })
    .onDuplicateKeyUpdate({
      set: {
        name: "Nooscape production operator",
        loginMethod: "server-operator-token",
        role: "admin",
        lastSignedIn: new Date(),
      },
    });

  const [operator] = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  if (!operator) throw new Error("Unable to resolve the production operator identity.");
  return operator;
}

/**
 * Wraps a write that can change what the cached directory aggregates count: they are invalidated on success or failure (a failure may
 * have written part of it). `invalidate` is invalidateDirectoryReadsSoftly for ingestion writes, whose aggregates are served as they are
 * and reloaded once the writes go quiet, and invalidateDirectoryReads for an operator's change, which must show on the very next read.
 */
export function withInvalidation<Args extends unknown[], Result>(write: (...args: Args) => Promise<Result>, invalidate: () => void) {
  return async (...args: Args): Promise<Result> => {
    try {
      return await write(...args);
    } finally {
      invalidate();
    }
  };
}

/**
 * Source-level visibility condition for queries that read `ingestion_sources`
 * without joining the directory table: only active sources are visible.
 * Source-only queries must use this helper instead of
 * directoryVisibilityCondition, whose hidden-flag reference requires the
 * directory join — an unjoined column is a runtime SQL error on MySQL.
 */
export function activeSourceCondition() {
  return eq(ingestionSources.state, "active");
}

/**
 * Excludes the sources of a chain whose switch is off (shared/features.ts, docs/multichain-erc8004-2026-10-20.md): Ethereum, Base
 * and Arc are read from `VITE_FEATURES` as the server runs, like every other switch, and what they hold is not shown, counted or
 * served until the owner turns them on. It names the protocols to leave out, so a database that has not run migration 0046 sees
 * a comparison with a value its list does not have, which matches no row. With every switch on there is nothing to leave out.
 */
export function chainSwitchCondition() {
  const off = protocolsOfChainsOff(process.env.VITE_FEATURES) as Array<(typeof ingestionSources.protocol.enumValues)[number]>;
  return off.length > 0 ? notInArray(ingestionSources.protocol, off) : undefined;
}
