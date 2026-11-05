import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { InfoPage, headingClass, linkClass, textClass } from "@/components/InfoPage";
import { INCIDENTS } from "@/lib/incidents";
import { trpc } from "@/lib/trpc";
import { ageText, FRESHNESS_HOURS, overall, paymentsState, summarizeSources, type PaymentsState } from "@/lib/statusModel";

/** The history of the check that runs from outside the host: one workflow run every six hours, kept in public. */
const HEALTH_HISTORY = "https://github.com/RunTimeAdmin/nooscape-public/actions/workflows/health.yml";
const REFRESH_MS = 60_000;

const LIMITS = Array.from(new Set(Object.values(FRESHNESS_HOURS))).sort((a, b) => a - b);
const limitsText = `${LIMITS.slice(0, -1).join(", ")} or ${LIMITS[LIMITS.length - 1]} hours`;

async function readApiIndex(): Promise<{ payments_unresolved_over_hour?: number | null }> {
  const response = await fetch("/api/v1", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`The API index answered ${response.status}`);
  return (await response.json()) as { payments_unresolved_over_hour?: number | null };
}

const bannerTone = { ok: "border-ns-radar/40 bg-ns-radar/10", attention: "border-ns-amber/50 bg-ns-amber/10", unknown: "border-white/15 bg-white/[.04]" } as const;

function paymentsText(state: PaymentsState | null) {
  if (state === null || state.kind === "unknown") return "Not read just now.";
  if (state.kind === "off") return "Off.";
  if (state.kind === "clear") return "On. No payment has waited over an hour.";
  return `On. ${state.count} ${state.count === 1 ? "payment has" : "payments have"} waited over an hour.`;
}

/**
 * Whether Nooscape is answering and whether its scheduled sources are reading on time, from the two public reads the rest of the site
 * already makes. It claims only what it read, says what it cannot see (an outage while it is happening: it is served by the app it
 * describes), points at the check that runs from outside, and lists the incidents the operator has written up. It shows no uptime
 * figure, because nothing outside the host measures one yet. The words are held to the code by client/src/pages/status.test.ts.
 */
export default function Status() {
  const sourceQuery = trpc.liveData.sourceStatuses.useQuery(undefined, { refetchInterval: REFRESH_MS });
  const indexQuery = useQuery({ queryKey: ["status", "api-index"], queryFn: readApiIndex, refetchInterval: REFRESH_MS, retry: 1 });

  const summary = sourceQuery.data ? summarizeSources(sourceQuery.data.sources, Date.now()) : null;
  const payments: PaymentsState | null = indexQuery.data ? paymentsState(indexQuery.data) : indexQuery.isError ? { kind: "unknown" } : null;
  const reading = (sourceQuery.isLoading || indexQuery.isLoading) && !summary && !indexQuery.data;
  const state = reading ? { level: "unknown" as const, headline: "Reading the status." } : overall(summary, payments);
  const answered = Boolean(sourceQuery.data || indexQuery.data);
  const readAt = Math.max(sourceQuery.dataUpdatedAt, indexQuery.dataUpdatedAt);

  return (
    <InfoPage title="Status" eyebrow="Status" heading="Is Nooscape working right now?">
      <p className={textClass}>
        This page says whether Nooscape is answering and whether its scheduled sources are reading on time. It does not say whether what they
        read is right: the records and their evidence are for that.
      </p>

      <section aria-labelledby="status-now" aria-live="polite">
        <h2 id="status-now" className={headingClass}>Right now</h2>
        <p className={`mt-4 max-w-prose rounded-xl border px-4 py-3 text-lg font-medium text-ns-ink ${bannerTone[state.level]}`}>{state.headline}</p>
        <dl className="mt-4 max-w-prose divide-y divide-white/[.08] text-base leading-7">
          <div className="flex flex-wrap justify-between gap-x-6 py-2">
            <dt className="text-ns-ink-dim">Site and API</dt>
            <dd className="text-ns-ink">{reading ? "Reading." : answered ? "Answering." : "This page loaded, but its reads did not answer."}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-6 py-2">
            <dt className="text-ns-ink-dim">Scheduled sources</dt>
            <dd className="text-ns-ink">{summary ? `${summary.onTime} of ${summary.judged} read inside their limit.` : reading ? "Reading." : "Not read just now."}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-6 py-2">
            <dt className="text-ns-ink-dim">Pay per call</dt>
            <dd className="text-ns-ink">{reading ? "Reading." : paymentsText(payments)}</dd>
          </div>
        </dl>
        {summary && summary.late.length > 0 && (
          <ul className="mt-3 max-w-prose list-disc space-y-1 pl-5 text-base leading-7 text-ns-ink-dim">
            {summary.late.map(source => (
              <li key={source.label}>
                {source.label}: last read {ageText(source.hoursAgo)}, limit {source.limitHours} hours.
              </li>
            ))}
          </ul>
        )}
        {summary && summary.failing.length > 0 && (
          <ul className="mt-3 max-w-prose list-disc space-y-1 pl-5 text-base leading-7 text-ns-ink-dim">
            {summary.failing.map(source => (
              <li key={source.label}>
                {source.label}: {source.failures} recorded {source.failures === 1 ? "failure" : "failures"}.
              </li>
            ))}
          </ul>
        )}
        <p className={textClass}>
          {readAt > 0 ? `Read at ${new Date(readAt).toLocaleTimeString()}, and again every minute.` : "Read again every minute."} Each source&apos;s last read is
          on the <Link href="/sources" className={linkClass}>source ledger</Link>.
        </p>
      </section>

      <section aria-labelledby="status-cannot">
        <h2 id="status-cannot" className={headingClass}>What this page cannot tell you</h2>
        <p className={textClass}>
          It is served by the app it describes. If the app is down this page is down with it, so it can show a source that is late but not an
          outage as it happens. The check from outside, below, can.
        </p>
      </section>

      <section aria-labelledby="status-late">
        <h2 id="status-late" className={headingClass}>When a source counts as late</h2>
        <p className={textClass}>
          Each scheduled source has a limit that fits how often it is meant to run: {limitsText}. A source is late when its last successful read
          is older than its limit, or when it has never succeeded. A source that is paused, waiting for review or run by hand is not judged. The
          live check below holds the sources to the same limits.
        </p>
      </section>

      <section aria-labelledby="status-outside">
        <h2 id="status-outside" className={headingClass}>The check from outside</h2>
        <p className={textClass}>
          Every six hours a workflow on GitHub, which runs outside Nooscape&apos;s hosting, runs the live checks against nooscape.si: the pages,
          the security headers, the surfaces that stay removed, the reviewed census, the directory, each scheduled source and pay per call. A failed
          check opens an issue. The history of every run is public:{" "}
          <a href={HEALTH_HISTORY} rel="noopener noreferrer" className={linkClass}>the Live health runs</a>.
        </p>
      </section>

      <section aria-labelledby="status-incidents">
        <h2 id="status-incidents" className={headingClass}>Past incidents</h2>
        <p className={textClass}>
          The operator writes each one up after it happens. A source that shows as late above is not an incident until it is written here.
        </p>
        <ul className="mt-4 max-w-prose space-y-6">
          {INCIDENTS.map(incident => (
            <li key={incident.date}>
              <p className="font-mono text-xs uppercase tracking-[.14em] text-ns-ink-dim">{incident.date} · {incident.window}</p>
              <h3 className="mt-1 text-base font-medium text-[#F2FFF5]">{incident.title}</h3>
              <p className={textClass}>{incident.summary}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="status-not-yet">
        <h2 id="status-not-yet" className={headingClass}>Not here yet</h2>
        <p className={textClass}>
          An uptime percentage. Nothing outside the host measures the site every minute yet, and a figure from the app&apos;s own records could not
          show the times it was down.
        </p>
      </section>
    </InfoPage>
  );
}
