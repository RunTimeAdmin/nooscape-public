/**
 * A small in-process read cache for the public directory aggregates.
 *
 * The directory holds ~240k rows and the homepage polls five aggregate
 * endpoints every 20 seconds per visitor. Each aggregate is a full-table
 * count (the funnel alone takes about 4 seconds), so uncached traffic scales
 * database load with visitors instead of with data. This cache bounds it:
 *
 * - A fresh value is served for `ttlMs`; after that the next caller reloads.
 *   Every write that can change what an aggregate counts invalidates the
 *   cache (see below), so the TTL does not keep counts fresh: it only bounds
 *   how long a change made behind this process's back goes unseen. It is
 *   therefore long. Rebuilding the aggregates takes the database to 500 to
 *   700% CPU for 4 to 8 seconds at 240k rows (the pressure test, on a shared
 *   4-core machine), so a 30-second TTL kept a shared database busy for much
 *   of every minute while anyone was watching.
 * - Concurrent callers for the same key share one load (request coalescing),
 *   so a burst after expiry costs one scan, not one per visitor.
 * - A fresh value that has aged past `refreshAheadMs` is reloaded in the
 *   background while callers keep getting it. Without this, every expiry lands
 *   on a visitor: under load the pressure test saw every request that touched
 *   an expired aggregate wait for the whole reload, 5 to 25 seconds. With it a
 *   reload normally finishes before the old value expires, so no caller waits
 *   for one. The value served is still never older than `ttlMs`, and a
 *   background reload that fails is never stored: the old value is served
 *   until it expires and the next caller then reloads in the foreground
 *   exactly as before.
 * - A failed load is never cached and never served stale: the error reaches
 *   every caller that was waiting on it, the router's fail-closed handling
 *   behaves exactly as before, and the next call retries from the database.
 * - `invalidate()` drops everything and discards any load that was already in
 *   flight, so a value read before a write can never be stored after it.
 * - `softInvalidate()` marks everything stale and drops nothing. A stale value
 *   is still served, at once, while one background reload replaces it, which
 *   starts once the writes have been quiet for `softQuietMs` (a burst of writes
 *   would otherwise start a rebuild that the next write throws away). Callers
 *   never wait for it; the value they get is no older than the TTL, as ever. It
 *   is for writes made by ingestion, where counts trailing by a few seconds
 *   cost nothing. A write that must show on the very next read (an operator's
 *   hide, or a source being paused) uses `invalidate()`, which also discards a
 *   soft reload that is in flight.
 *
 * What it must not cache: the reviewed census (`publicRecords`,
 * `publicCoverage`) and everything behind the reviewed-run gate. A withdrawal
 * or a paused source must take effect on the very next read, so those readers
 * do not use this module.
 *
 * The cache is per process. A second instance (for example during a deploy
 * overlap, or the standalone `pnpm worker:tick`) is at worst `ttlMs` stale.
 */
export type ReadCacheOptions = {
  /** How long a loaded value is served. 0 disables caching but keeps coalescing. */
  ttlMs?: number;
  /** Age at which a served value starts being reloaded in the background. Default 30 s before expiry (half the TTL for short TTLs); 0 turns it off. */
  refreshAheadMs?: number;
  /** After a failed background reload, how long before another is attempted. */
  refreshRetryMs?: number;
  /** How long writes must have been quiet before a soft-invalidated value is reloaded (a number, or a function read at each call). Default 3.5 s. */
  softQuietMs?: number | (() => number);
  /** Upper bound on distinct keys; the oldest entry is evicted past it. */
  maxKeys?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Called when a background reload fails (the value being served is unaffected). */
  onRefreshError?: (key: string, error: unknown) => void;
};

/**
 * How long ingestion writes must have been quiet before a stale value is reloaded.
 * A run writes in windows a second or so apart, so this is longer than that, and
 * shorter than WARM_DELAY_MS: the warm-up that follows a burst of writes reads the
 * aggregates, and has to find the quiet period already over.
 */
const DEFAULT_SOFT_QUIET_MS = 3_500;

export function createReadCache(options: ReadCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? 30_000;
  const refreshAheadMs = options.refreshAheadMs ?? Math.floor(Math.max(ttlMs - 30_000, ttlMs / 2));
  const refreshRetryMs = options.refreshRetryMs ?? 5_000;
  const maxKeys = options.maxKeys ?? 64;
  const now = options.now ?? (() => Date.now());
  const onRefreshError = options.onRefreshError ?? (() => {});
  const softQuietMs = () => (typeof options.softQuietMs === "function" ? options.softQuietMs() : (options.softQuietMs ?? DEFAULT_SOFT_QUIET_MS));
  // `epoch` counts soft invalidations; a value loaded in an earlier one is stale.
  const values = new Map<string, { value: unknown; loadedAt: number; expiresAt: number; epoch: number }>();
  const inflight = new Map<string, Promise<unknown>>();
  const refreshBlockedUntil = new Map<string, number>();
  let generation = 0;
  let epoch = 0;
  let lastSoftInvalidationAt = Number.NEGATIVE_INFINITY;
  let lastReadAt = Number.NEGATIVE_INFINITY;

  function load<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const startedIn = generation;
    // A load that began before a later soft invalidation may have missed the write, so what it stores is stale already.
    const startedEpoch = epoch;
    // Declared first so the settle handler below can compare itself to the map entry.
    let promise!: Promise<T>;
    promise = (async () => {
      try {
        const value = await loader();
        // A write invalidated the cache while this load ran: serve the value
        // to the callers that were already waiting, but never store it.
        if (startedIn === generation && ttlMs > 0) {
          if (!values.has(key) && values.size >= maxKeys) {
            const oldest = values.keys().next().value;
            if (oldest !== undefined) values.delete(oldest);
          }
          const loadedAt = now();
          values.set(key, { value, loadedAt, expiresAt: loadedAt + ttlMs, epoch: startedEpoch });
        }
        return value;
      } finally {
        if (inflight.get(key) === promise) inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  function read<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const time = now();
    lastReadAt = time;
    const hit = values.get(key);
    if (hit && hit.expiresAt > time) {
      const ageing = refreshAheadMs > 0 && time - hit.loadedAt >= refreshAheadMs;
      const stale = hit.epoch < epoch && time - lastSoftInvalidationAt >= softQuietMs();
      if ((ageing || stale) && !inflight.has(key) && time >= (refreshBlockedUntil.get(key) ?? 0)) {
        // Reload before expiry, or once the writes that made it stale have settled, so no caller has to wait for it. The caller below still gets the value it asked for.
        load(key, loader).catch(error => {
          refreshBlockedUntil.set(key, now() + refreshRetryMs);
          onRefreshError(key, error);
        });
      }
      return Promise.resolve(hit.value as T);
    }
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
    return load(key, loader);
  }

  function invalidate() {
    generation += 1;
    values.clear();
    inflight.clear();
  }

  function softInvalidate() {
    epoch += 1;
    lastSoftInvalidationAt = now();
  }

  return {
    read,
    invalidate,
    softInvalidate,
    size: () => values.size,
    /** Milliseconds since anything last read from this cache (Infinity if nothing has). */
    idleMs: () => now() - lastReadAt,
  };
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** The TTL is tunable (and 0 turns caching off) without a deploy-time code change. */
function configuredTtlMs() {
  const raw = process.env.NOOSCAPE_DIRECTORY_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

let directorySoftQuietMs = DEFAULT_SOFT_QUIET_MS;

/** Test helper: how long writes must be quiet before stale aggregates are reloaded. */
export function setDirectorySoftQuietMsForTests(ms: number) {
  directorySoftQuietMs = ms;
}

const directoryReads = createReadCache({
  ttlMs: configuredTtlMs(),
  softQuietMs: () => directorySoftQuietMs,
  onRefreshError: (key, error) => console.warn(`[ReadCache] background reload of ${key} failed; the current value is served until it expires: ${error instanceof Error ? error.message.split("\nparams:")[0] : String(error)}`),
});

/** Serves a directory aggregate from the shared cache, loading it on a miss. */
export function cachedDirectoryRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  return directoryReads.read(key, load);
}

/**
 * Search results. A text search costs a second or more of database time, and the
 * same words get searched repeatedly (a popular name, the partial strings of a
 * word being typed), so a result is held for a minute. It is dropped with the
 * aggregates by every write that can change what a search finds, so a hidden
 * entry or a paused source leaves the results on the very next search. There is
 * no refresh-ahead: a search nobody repeats should not be recomputed.
 */
const searchReads = createReadCache({ ttlMs: 60_000, refreshAheadMs: 0, maxKeys: 500 });

export function cachedSearchRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  return searchReads.read(key, load);
}

let warmer: (() => Promise<unknown>) | null = null;
let warmTimer: ReturnType<typeof setTimeout> | null = null;
/** Someone read the aggregates this recently, so a dropped cache is worth rebuilding before they ask again. */
const WARM_IF_READ_WITHIN_MS = 5 * 60 * 1000;
/** An ingestion run writes in windows a second or so apart; a rebuild started between two of them is thrown away by the next. */
const WARM_DELAY_MS = 4_000;

/**
 * Registers the function that rebuilds the aggregates visitors read. After an
 * invalidation it runs once the writes settle (a burst of upserts invalidates
 * many times), but only if the cache was read recently: a dropped cache nobody
 * is looking at is not worth ten seconds of database work.
 */
export function setDirectoryReadsWarmer(fn: (() => Promise<unknown>) | null) {
  warmer = fn;
}

function scheduleWarm() {
  if (!warmer || directoryReads.idleMs() > WARM_IF_READ_WITHIN_MS) return;
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    warmTimer = null;
    warmer?.().catch(() => {});
  }, WARM_DELAY_MS);
  warmTimer.unref?.();
}

/**
 * Drops every cached directory aggregate and every held search, so the very next
 * read comes from the database. Called after a write that must show at once: an
 * operator's hide or unhide, and a source being approved, paused or rejected
 * (the directory only counts entries from active sources).
 */
export function invalidateDirectoryReads() {
  directoryReads.invalidate();
  searchReads.invalidate();
  scheduleWarm();
}

/**
 * Marks the cached directory aggregates stale without dropping them, for the
 * writes ingestion makes (directory upserts and closure markers, activity-ledger
 * writes, the BNB registry rows and listing). Visitors keep getting the current
 * counts, at once, while one background reload replaces them after the writes have
 * been quiet for a few seconds; before this, the first visitors after every write
 * waited for a rebuild that took MySQL to 500 to 700% CPU for 4 to 8 seconds at
 * 240k rows. Held searches are left alone: they expire within a minute.
 */
export function invalidateDirectoryReadsSoftly() {
  directoryReads.softInvalidate();
  scheduleWarm();
}
