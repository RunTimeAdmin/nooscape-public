/**
 * What the status page says, worked out from two public reads: the source statuses (the answer /sources shows) and the API index.
 * The limits are the ones the live check holds the same sources to (scripts/verify-live.mjs); a test keeps the two tables equal, so
 * the page and the six-hourly check never disagree about what "late" means.
 */
export const FRESHNESS_HOURS: Readonly<Record<string, number>> = {
  erc8004: 3,
  solana_registry: 3,
  solana_8004: 3,
  solana_said: 3,
  erc8004_bsc: 3,
  erc8004_base: 3,
  catalog: 36,
  census: 36,
  a2a: 36,
  erc8004_arc: 12,
  erc8004_eth: 36,
  erc8004_monad: 36,
};

export type SourceReading = {
  sourceKey: string;
  label: string;
  protocol: string;
  state: string;
  executionPolicy: string;
  failureCount: number;
  lastSuccessfulAt: Date | string | null;
};

export type LateSource = { label: string; hoursAgo: number | null; limitHours: number };
export type FailingSource = { label: string; failures: number };
export type SourceSummary = { judged: number; onTime: number; late: LateSource[]; failing: FailingSource[] };

const HOUR = 3_600_000;

/**
 * Only an active source that runs on a schedule and has a limit is judged, as in the live check: a paused source, one waiting for
 * review and one that is run by hand are the operator's to pace, and are not late. A source that never succeeded is late.
 */
export function summarizeSources(sources: readonly SourceReading[], now: number): SourceSummary {
  const late: LateSource[] = [];
  const failing: FailingSource[] = [];
  let judged = 0;
  let onTime = 0;
  for (const source of sources) {
    if (source.state !== "active" || source.executionPolicy !== "scheduled") continue;
    const limitHours = FRESHNESS_HOURS[source.protocol];
    if (limitHours === undefined) continue;
    judged += 1;
    const last = source.lastSuccessfulAt ? new Date(source.lastSuccessfulAt).getTime() : Number.NaN;
    const hoursAgo = Number.isFinite(last) ? (now - last) / HOUR : null;
    if (hoursAgo === null || hoursAgo > limitHours) late.push({ label: source.label, hoursAgo, limitHours });
    else onTime += 1;
    if (source.failureCount > 0) failing.push({ label: source.label, failures: source.failureCount });
  }
  return { judged, onTime, late, failing };
}

/** What the API index says about pay per call: off, nothing waiting, some payment waiting over an hour, or not readable. */
export type PaymentsState = { kind: "off" } | { kind: "clear" } | { kind: "waiting"; count: number } | { kind: "unknown" };

export function paymentsState(index: { payments_unresolved_over_hour?: number | null } | undefined): PaymentsState {
  if (!index) return { kind: "unknown" };
  const count = index.payments_unresolved_over_hour;
  if (count === undefined) return { kind: "off" };
  if (count === null || !Number.isFinite(count)) return { kind: "unknown" };
  return count === 0 ? { kind: "clear" } : { kind: "waiting", count };
}

export type Overall = { level: "ok" | "attention" | "unknown"; headline: string };

/** The line at the top. It claims only what was read: a part that could not be read is never counted as fine. */
export function overall(sources: SourceSummary | null, payments: PaymentsState | null): Overall {
  const paymentsKnown = payments !== null && payments.kind !== "unknown";
  if (sources === null && !paymentsKnown) return { level: "unknown", headline: "Status could not be read just now." };
  if (sources && sources.late.length > 0) return { level: "attention", headline: sources.late.length === 1 ? "One scheduled source is late." : `${sources.late.length} scheduled sources are late.` };
  if (sources && sources.failing.length > 0) return { level: "attention", headline: "A scheduled source has recorded failures." };
  if (payments?.kind === "waiting") return { level: "attention", headline: "Pay per call needs attention." };
  if (sources === null || !paymentsKnown) return { level: "unknown", headline: "Part of the status could not be read just now." };
  if (sources.judged === 0) return { level: "unknown", headline: "No scheduled source was found to check." };
  return { level: "ok", headline: "Everything checked is on schedule." };
}

/** How long ago, in the words the page uses. */
export function ageText(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "never";
  const minutes = Math.max(0, Math.round(hours * 60));
  if (minutes < 2) return "just now";
  if (minutes < 120) return `${minutes} minutes ago`;
  const rounded = Math.round(hours * 10) / 10;
  if (hours < 72) return `${rounded} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}
