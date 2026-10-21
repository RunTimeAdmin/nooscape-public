import { Activity, ArrowLeft, ArrowUpRight, Database, Radar, RefreshCw, ShieldCheck } from "lucide-react";
import type { CSSProperties } from "react";
import { safeHttpsHref } from "@/lib/safeHref";
import { trpc } from "@/lib/trpc";

function compactNumber(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatTimestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}

export default function EcosystemContext() {
  const snapshot = trpc.liveData.ecosystemContext.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const context = snapshot.data?.context;
  const sourceHref = safeHttpsHref(context?.source.locator);
  const maxChainTransactions = Math.max(...(context?.chains.map(chain => chain.transactions) ?? [1]), 1);

  return (
    <main className="ecosystem-page">
      <div className="ecosystem-noise" />
      <header className="ecosystem-header">
        <a href="/" className="ecosystem-back"><ArrowLeft size={15} /> Return to Atlas</a>
        <div className="ecosystem-header-mark"><Radar size={15} /> Ecosystem context</div>
        <a href="/sources" className="ecosystem-source-link"><Database size={14} /> Source ledger</a>
      </header>

      <section className="ecosystem-hero">
        <div>
          <p className="ecosystem-kicker"><Activity size={14} /> Retained aggregate signal</p>
          <h1>Machine economies,<br /><span>without invented precision.</span></h1>
          <p className="ecosystem-lede">A small, reviewable view of aggregate activity from an approved public census. It is context for discovery—not a trust score, valuation, or claim about any individual agent.</p>
        </div>
        <aside className="ecosystem-proof-card">
          <div><ShieldCheck size={15} /><span>Evidence boundary</span></div>
          <strong>{context ? "Retained raw source" : "Awaiting retained census"}</strong>
          <p>{context ? "Metrics are re-derived server-side from a private, content-addressed evidence object." : "The public view will populate after an approved aggregate census is retained."}</p>
          {sourceHref && <a href={sourceHref} target="_blank" rel="noopener noreferrer nofollow">Open source document <ArrowUpRight size={13} /></a>}
        </aside>
      </section>

      {snapshot.isLoading && <section className="ecosystem-loading"><RefreshCw className="animate-spin" size={17} /> Loading retained context…</section>}
      {snapshot.error && <section className="ecosystem-empty">The context relay is temporarily unavailable. Agent records and source status remain independently available.</section>}
      {!snapshot.isLoading && !snapshot.error && !context && <section className="ecosystem-empty">No approved aggregate census is available yet. This page intentionally does not fetch third-party data directly in the browser.</section>}

      {context && <>
        <section className="ecosystem-metric-grid" aria-label="Aggregate ecosystem metrics">
          {context.metrics.map((metric, index) => <article key={metric.label} className="ecosystem-metric" style={{ "--metric-delay": `${index * 60}ms` } as CSSProperties}>
            <span>{metric.label}</span>
            <strong>{compactNumber(metric.value)}</strong>
            <p>{metric.detail}</p>
          </article>)}
        </section>

        <section className="ecosystem-chain-section">
          <header><div><p className="ecosystem-kicker">Payment signal by chain</p><h2>Observed x402 activity</h2></div><span>Top {context.chains.length} reported chains</span></header>
          <div className="ecosystem-chain-list">
            {context.chains.map((chain, index) => <article key={chain.name} className="ecosystem-chain-row">
              <span className="ecosystem-chain-rank">{String(index + 1).padStart(2, "0")}</span>
              <strong>{chain.name}</strong>
              <div className="ecosystem-chain-bar"><i style={{ width: `${Math.max(4, (chain.transactions / maxChainTransactions) * 100)}%` }} /></div>
              <em>{compactNumber(chain.transactions)}</em>
            </article>)}
          </div>
        </section>

        <footer className="ecosystem-footer">
          <span><Database size={13} /> {context.source.label}</span>
          <span>Observed {formatTimestamp(context.observedAt)}</span>
          <code>sha256:{context.source.contentHash.slice(0, 18)}…</code>
        </footer>
      </>}
    </main>
  );
}
