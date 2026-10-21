import { createRobotsGate, ROBOTS_MAX_BYTES } from "./robots";
import { safeFetch as realSafeFetch, type SafeFetchOptions, type SafeFetchReason, type SafeFetchResult } from "./safeFetch";

/**
 * The manners around safeFetch, for a run that asks many hosts one question each (a check pass): at most a handful of
 * fetches at once, a pause between two requests to the same host, a budget of requests for the whole run so a run stays
 * short, and a look at each host's robots.txt before the first thing is asked of it. Each hop of a redirect is a request
 * of its own, so it spends budget, takes its turn at its host and has its host's robots.txt read.
 *
 * Make one for each run. The budget is for the life of the fetcher, robots.txt requests included, and a fetch that finds
 * it spent is refused as `budget_exhausted` without anything being sent.
 */

export type PoliteOptions = {
  /** At most this many fetches at once, and never more than POLITE_MAX_CONCURRENCY. */
  concurrency?: number;
  /** At least this long between two requests to one host (a minute at most). */
  perHostGapMs?: number;
  /** The most requests this fetcher makes in all, robots.txt included (1,000 at most). */
  budget?: number;
  /** Look at robots.txt first. It is on unless a caller has the host's leave not to. */
  robots?: boolean;
};

/** The most fetches at once, however many a caller asks for. */
export const POLITE_MAX_CONCURRENCY = 5;
/** The pause between two requests to one host unless a caller asks for a longer one. */
export const POLITE_DEFAULT_GAP_MS = 1000;
/** A longer gap would be a timer too long for setTimeout, which then fires at once. */
const MAX_GAP_MS = 60_000;
const DEFAULT_BUDGET = 200;
export const POLITE_MAX_BUDGET = 1000;
/** A robots.txt may move to another host's robots.txt (example.com to www.example.com), but not far. */
const ROBOTS_MAX_REDIRECTS = 1;

/** `value` if it is a finite number. NaN and Infinity (what a missing setting becomes) are not a limit, so they get the default. */
const finiteOr = (value: number | undefined, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

const budgetSpent = (url: string): SafeFetchResult => ({ ok: false, reason: "budget_exhausted", detail: "this run has used its fetches", url, redirects: [], latencyMs: 0 });

/**
 * Reasons that are about the host itself: it was refused, it does not resolve, or it did not answer (not in time, not at all, not with a
 * valid certificate, not with HTTP). If robots.txt could not be fetched for one of them, the page could not be either, and that is the
 * reason to give. A robots.txt that answered badly (a 5xx, a 429, too long, a redirect to anything but a robots.txt) is a robots matter
 * and stays `robots_unavailable`.
 */
const ABOUT_THE_HOST = new Set<SafeFetchReason>(["forbidden_host", "forbidden_address", "unresolvable", "timeout", "connection_failed", "tls_failed", "response_invalid"]);

export function createPoliteFetcher(
  options: PoliteOptions = {},
  deps: { safeFetch?: typeof realSafeFetch; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
) {
  const concurrency = Math.min(POLITE_MAX_CONCURRENCY, Math.max(1, Math.floor(finiteOr(options.concurrency, POLITE_MAX_CONCURRENCY))));
  const gapMs = Math.min(MAX_GAP_MS, Math.max(0, finiteOr(options.perHostGapMs, POLITE_DEFAULT_GAP_MS)));
  let remaining = Math.min(POLITE_MAX_BUDGET, Math.max(0, Math.floor(finiteOr(options.budget, DEFAULT_BUDGET))));
  const spentAtStart = remaining;
  const fetchImpl = deps.safeFetch ?? realSafeFetch;
  // A clock that cannot be set back: a step of the system clock must not turn a one second pause into an hour.
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  const nextAt = new Map<string, number>();

  /** A request is about to be made to `host`: it spends one of the budget and waits for its turn there. */
  const spend = async (host: string): Promise<{ ok: true } | { ok: false; reason: "budget_exhausted"; detail: string }> => {
    if (remaining <= 0) return { ok: false, reason: "budget_exhausted", detail: "this run has used its fetches" };
    remaining -= 1;
    // The turn is taken before the wait, so requests that arrive together are spaced out and not released together.
    const at = Math.max(now(), nextAt.get(host) ?? 0);
    nextAt.set(host, at + gapMs);
    const wait = at - now();
    if (wait > 0) await sleep(wait);
    return { ok: true };
  };

  const robots =
    options.robots === false
      ? null
      : createRobotsGate({
          now,
          fetchRobots: url => {
            // A run with nothing left does not ask anyone's name server about the rest of its list either.
            if (remaining <= 0) return Promise.resolve(budgetSpent(url));
            return fetchImpl(url, {
              maxBodyBytes: ROBOTS_MAX_BYTES,
              accept: "text/plain",
              maxRedirects: ROBOTS_MAX_REDIRECTS,
              beforeRequest: async ({ url: target, hop }) => {
                // A robots.txt may be sent to another host's robots.txt and to nothing else. Whatever it is sent to has not been
                // asked whether visitors like this one are welcome there, so a host could not be used to aim a check at a path.
                if (hop > 0 && (target.pathname !== "/robots.txt" || target.search !== "")) {
                  return { ok: false, reason: "redirect_invalid", detail: "robots.txt was sent to something that is not a robots.txt" };
                }
                return spend(target.hostname);
              },
            });
          },
        });

  let active = 0;
  const waiting: Array<() => void> = [];
  /** Runs `task` when fewer than `concurrency` are running. A finishing task hands its place straight to the next in line. */
  const limit = async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>(release => waiting.push(release));
    else active += 1;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };

  return {
    /** safeFetch, with the manners above. It never throws. */
    fetch(url: string, fetchOptions: Omit<SafeFetchOptions, "beforeRequest"> = {}): Promise<SafeFetchResult> {
      // A run that has nothing left does no DNS work for the rest of its list.
      if (remaining <= 0) return Promise.resolve(budgetSpent(url));
      return limit(() =>
        remaining <= 0
          ? Promise.resolve(budgetSpent(url))
          : fetchImpl(url, {
              ...fetchOptions,
              beforeRequest: async ({ url: hop }) => {
                if (robots) {
                  const decision = await robots.check(hop);
                  if (!decision.allowed) {
                    const reason = decision.reason === "robots_unavailable" && decision.cause && ABOUT_THE_HOST.has(decision.cause) ? decision.cause : decision.reason;
                    return { ok: false, reason, detail: decision.detail };
                  }
                }
                return spend(hop.hostname);
              },
            })
      );
    },
    /** How many requests this fetcher may still make. */
    remainingBudget: () => remaining,
    /** How many it has made, or is waiting to make. */
    spent: () => spentAtStart - remaining,
  };
}
