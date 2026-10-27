/**
 * How the live check asks the site a question (scripts/verify-live.mjs). The check runs on a GitHub runner, and the site's CDN
 * sometimes turns a runner away for a few minutes: a 403 or a 307 where the page should be, or a connection that fails at once.
 * The site was up each time, and the next run passed. A request the edge turned away is tried again after a wait, so only an
 * answer that keeps coming back wrong fails the check. Once one request has used up its tries the others get one try each, so a
 * site that is really down does not hold the job past its time limit, and a request that is answered gives the retries back.
 */

/** The answers that are the edge's and not the site's: a request that gets one is asked again. */
export const RETRY_STATUSES = [307, 403, 429, 502, 503, 504];

/** The waits before each new try: about four minutes in all, long enough for a turn-away that lasts a few. */
export const RETRY_WAITS_MS = [10_000, 30_000, 60_000, 120_000];

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createLiveGet({ base, fetchImpl = fetch, sleep = pause, waits = RETRY_WAITS_MS, timeoutMs = 30_000 }) {
  let turnedAway = false;

  async function get(path, init) {
    const tries = turnedAway ? 1 : waits.length + 1;
    let last = { error: new Error("no request was made") };
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (attempt > 0) await sleep(waits[attempt - 1]);
      try {
        const response = await fetchImpl(`${base}${path}`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), ...init });
        if (!RETRY_STATUSES.includes(response.status)) {
          turnedAway = false;
          return response;
        }
        // Not read, so its connection is let go before the next try.
        if (attempt + 1 < tries) await response.body?.cancel().catch(() => {});
        last = { response };
      } catch (error) {
        last = { error };
      }
    }
    if (tries > 1) turnedAway = true;
    if (last.error) throw last.error;
    return last.response;
  }

  return { get, wasTurnedAway: () => turnedAway };
}

/** An error as one line for the report, with the cause that `fetch failed` hides (a reset, a DNS failure, a timeout). */
export function why(error) {
  const line = `${error?.name ?? "Error"}: ${error?.message ?? error}`;
  const cause = error?.cause;
  const detail = cause ? [cause.code, cause.message].filter(Boolean).join(" ") : "";
  return detail ? `${line} (cause: ${detail})` : line;
}

/** The status of an answer for the report; when it is not one a check expects, what the edge said, so a turn-away can be told from the site. */
export function statusDetail(response) {
  const text = `HTTP ${response.status}`;
  if ([200, 401, 404].includes(response.status)) return text;
  const said = ["server", "location", "cf-ray", "cf-mitigated", "via"].map(name => [name, response.headers.get(name)]).filter(([, value]) => value);
  return said.length > 0 ? `${text} (${said.map(([name, value]) => `${name}: ${value}`).join(", ")})` : text;
}
