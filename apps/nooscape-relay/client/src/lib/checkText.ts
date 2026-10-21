/**
 * What an agent's page says about one check of an endpoint the agent declares. Pure, so the words can be tested without a
 * browser: the page passes in the time already formatted for the viewer.
 *
 * The rules, which the operator set on 2026-10-16:
 * - A miss is a fact with its date in plain words, and the line says it is retrying. No number and no score.
 * - The line says "failing" only when the last three asks in a row got no answer, and says nothing about why.
 * - A 404 or a 405 to a plain GET is not a dead address: it says a plain GET is not served there, and that POST, which
 *   Nooscape does not send, is not tested.
 * - It says what the ask got, never that the host answered: the checker follows redirects, so the last answer can be
 *   another host's.
 */

/** One line of the Checks section. The server leaves out the address, the reason and the fingerprint. */
export type AgentCheck = {
  host: string;
  checkedAt: Date;
  outcome: "answered" | "no_answer";
  statusCode: number | null;
  latencyMs: number | null;
  /** The last three asks in a row got no answer (PUBLIC_CHECKS_FAILING_AFTER in server/agentChecks.ts, which the client cannot import). */
  failing: boolean;
};

/** The statuses a server gives a plain GET when it has nothing there for one, or only takes another method. */
const NOT_SERVED_FOR_GET: ReadonlySet<number> = new Set([404, 405]);

/**
 * The time of an ask as the viewer reads it: "Oct 16 at 2:10 PM CT", in their own time zone, with the year only when it is
 * not this year. A browser that does not know the generic zone name gets the plain one, and one that knows neither gets the
 * browser's own date and time.
 */
export function formatWhen(value: Date | string | number, options: { locale?: string; timeZone?: string; now?: Date } = {}): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "an unknown date";
  const { locale, timeZone, now = new Date() } = options;
  const yearOf = (instant: Date) => instant.toLocaleDateString("en-US", { year: "numeric", timeZone });
  const sameYear = yearOf(date) === yearOf(now);
  const day = date.toLocaleDateString(locale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone });
  for (const timeZoneName of ["shortGeneric", "short"] as const) {
    try {
      return `${day} at ${date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZoneName, timeZone })}`;
    } catch {
      // An older browser rejects a zone name it does not know; try the next.
    }
  }
  return date.toLocaleString(locale, { timeZone });
}

/** The sentence under a host: what the ask got, with when it was asked. `when` is the time as `formatWhen` gives it. */
export function checkSentence(check: AgentCheck, when: string): string {
  if (check.outcome === "no_answer") {
    return check.failing ? `Failing: the last three asks got no answer, the latest on ${when}.` : `Got no answer on ${when}, retrying.`;
  }
  if (check.statusCode !== null && NOT_SERVED_FOR_GET.has(check.statusCode)) {
    return `On ${when} the ask got HTTP ${check.statusCode}: a plain GET is not served there. Nooscape does not send POST, so whether it takes POST is not tested.`;
  }
  const status = check.statusCode === null ? "an answer" : `HTTP ${check.statusCode}`;
  const time = check.latencyMs === null ? "" : ` in ${check.latencyMs.toLocaleString()} ms`;
  return `On ${when} the ask got ${status}${time}.`;
}
