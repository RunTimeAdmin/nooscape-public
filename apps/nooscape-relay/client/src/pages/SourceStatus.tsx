import { trpc } from "@/lib/trpc";
import { directoryProtocolLabel } from "@/lib/directoryProtocols";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  Clock3,
  Eye,
  Loader2,
  PauseCircle,
  RadioTower,
  ShieldAlert,
  Signal,
  XCircle,
} from "lucide-react";
import { Link } from "wouter";

type SourceState = "review" | "active" | "paused" | "rejected";

const stateMeta: Record<SourceState, { label: string; detail: string; icon: typeof Signal; tone: string }> = {
  review: { label: "Review", detail: "Manual approval pending", icon: Eye, tone: "review" },
  active: { label: "Active", detail: "Approved for bounded observations", icon: CheckCircle2, tone: "active" },
  paused: { label: "Paused", detail: "No observations may run", icon: PauseCircle, tone: "paused" },
  rejected: { label: "Revoked", detail: "Source rejected or access withdrawn", icon: XCircle, tone: "revoked" },
};

function formatDate(value: Date | null) {
  return value ? new Date(value).toLocaleString() : "Not yet observed";
}

export default function SourceStatus() {
  const sourceQuery = trpc.liveData.sourceStatuses.useQuery(undefined, {
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const sources = sourceQuery.data?.sources ?? [];
  const counts = sources.reduce(
    (result, source) => {
      result[source.state] += 1;
      return result;
    },
    { review: 0, active: 0, paused: 0, rejected: 0 } as Record<SourceState, number>
  );

  return (
    <main className="source-status-page">
      <div className="source-status-grid" aria-hidden="true" />
      <header className="source-status-header">
        <Link href="/" className="source-status-brand">
          <span><RadioTower size={15} /></span>
          <div><strong>NOOSCAPE</strong><small>PUBLIC SOURCE LEDGER</small></div>
        </Link>
        <Link href="/" className="source-status-back"><ArrowLeft size={14} /> Return to observatory</Link>
      </header>

      <section className="source-status-hero">
        <p className="eyebrow"><Signal size={14} /> Transparency layer / public metadata only</p>
        <h1>Source <em>status</em>,<br />without blind trust.</h1>
        <p>Every source is visible before it is trusted. This ledger shows the current lifecycle and freshness of approved discovery boundaries—never raw payloads, operator identities, or storage locations.</p>
      </section>

      <section className="source-status-telemetry" aria-label="Source status summary">
        <StatusMetric icon={<Activity size={16} />} label="Registered boundaries" value={String(sources.length).padStart(2, "0")} note="Publicly disclosed" />
        <StatusMetric icon={<CheckCircle2 size={16} />} label="Active sources" value={String(counts.active).padStart(2, "0")} note="Scheduled or manual runs" tone="active" />
        <StatusMetric icon={<Eye size={16} />} label="Review queue" value={String(counts.review).padStart(2, "0")} note="No fetch authority" tone="review" />
        <StatusMetric icon={<PauseCircle size={16} />} label="Paused / revoked" value={String(counts.paused + counts.rejected).padStart(2, "0")} note="No observation" tone="paused" />
      </section>

      <section className="source-status-ledger" aria-labelledby="source-ledger-title">
        <div className="source-status-ledger-head">
          <div>
            <p className="eyebrow"><CircleDot size={14} /> Live public registry</p>
            <h2 id="source-ledger-title">Discovery boundaries</h2>
          </div>
          <div className="source-status-refresh" aria-live="polite">
            {sourceQuery.isFetching ? <Loader2 size={13} className="animate-spin" /> : <Clock3 size={13} />}
            Refreshes every 30 seconds
          </div>
        </div>

        {sourceQuery.isLoading ? (
          <div className="source-status-empty"><Loader2 className="animate-spin" size={20} /> Reading public source registry…</div>
        ) : sourceQuery.error ? (
          <div className="source-status-empty source-status-error"><ShieldAlert size={20} /> Status data is temporarily unavailable. No source configuration has been exposed.</div>
        ) : sources.length === 0 ? (
          <div className="source-status-empty"><RadioTower size={20} /> No external sources are currently disclosed. The map remains on its observed pilot record and illustrative seed layer.</div>
        ) : (
          <div className="source-status-list">
            {sources.map(source => {
              const meta = stateMeta[source.state];
              const Icon = meta.icon;
              return (
                <article className={`source-status-card source-status-${meta.tone}`} key={source.sourceKey}>
                  <div className="source-status-card-main">
                    <div className="source-status-state-icon"><Icon size={18} /></div>
                    <div>
                      <div className="source-status-card-title"><h3>{source.label}</h3><span className={`source-status-badge source-status-badge-${meta.tone}`}>{meta.label}</span></div>
                      <p>{meta.detail}</p>
                      <div className="source-status-boundary"><span>{directoryProtocolLabel(source.protocol)}</span><code>{source.hostname}</code><span>Public metadata</span></div>
                    </div>
                  </div>
                  <dl className="source-status-details">
                    <div><dt>Last accepted</dt><dd>{formatDate(source.lastSuccessfulAt)}</dd></div>
                    <div><dt>Observed failures</dt><dd>{source.failureCount}</dd></div>
                    <div><dt>Registry updated</dt><dd>{formatDate(source.updatedAt)}</dd></div>
                  </dl>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="source-status-guardrail">
        <ShieldAlert size={18} />
        <div><strong>What this means</strong><p>An <b>active</b> status authorizes bounded reads of public data from that source, scheduled or run by an operator. For an A2A source it also allows a check once a day that the endpoints its approved cards declare answer (Nooscape-Checker). For the 8004 registries on Solana, Robinhood Chain, BNB Chain, Ethereum, Base and Arc, and the SAID registry on Solana, it also allows reading the registration link of an entry, a few at a time, to find its name or to group look-alike entries (Nooscape-Checker). It does not verify a publisher key, invoke an agent, execute a tool, authorize payment, or create a trust score.</p></div>
      </section>

      <footer className="source-status-footer"><span>NOOSCAPE / PUBLIC AGENT OBSERVATORY</span><span>Source state is not a trust tier</span></footer>
    </main>
  );
}

function StatusMetric({ icon, label, value, note, tone = "default" }: { icon: React.ReactNode; label: string; value: string; note: string; tone?: "default" | "active" | "review" | "paused" }) {
  return <div className={`source-status-metric source-status-metric-${tone}`}><div>{icon}<span>{label}</span></div><strong>{value}</strong><small>{note}</small></div>;
}
