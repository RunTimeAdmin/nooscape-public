import { Activity, ArrowLeft, ArrowUpRight, Database, History, RefreshCw } from "lucide-react";
import { Link } from "wouter";
import { Term } from "@/components/Term";
import { trpc } from "@/lib/trpc";
import {
  chainActivityEventLabel,
  formatRecordedAt,
  handoutExplanation,
  solanaActivityEventLabel,
  solanaActivityExplanation,
  solanaRegistries,
  solanaRegistryLabel,
} from "@/lib/evidenceExplain";

// The endpoint payload: measured identity-registry events (mints, hand-outs
// vs later changes of hands, profile-link edits), per-block-day series, and
// the totals both derive from. Null totals / empty lists mean the read fails
// closed — never a false zero.
type ActivityTotals = {
  mintedEntries: number;
  secondaryTransfers: number;
  handoutTransfers: number;
  uriUpdates: number;
  measuredThroughBlock: number | null;
};

type FeedEvent = {
  kind: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  fromAddress: string | null;
  toAddress: string | null;
  isHandout: boolean;
  entryId: string;
  displayName: string;
};

type DayCounts = {
  day: number;
  mints: number;
  handouts: number;
  laterTransfers: number;
  uriEdits: number;
};

// The Solana registries' anchored events (SAID, 8004, Metaplex). The time is
// when Nooscape's pass recorded the event, a bound on when it happened.
type SolanaFeedEvent = {
  id: string;
  kind: string;
  slot: number;
  transactionSignature: string;
  recordedAt: string | Date;
  protocol: string;
  entryId: string;
  displayName: string;
};

type SolanaTotal = { protocol: string; kind: string; count: number };

const solanaTone = (kind: string) => (kind === "register" ? "#BFFF76" : kind === "transfer" ? "#C3A6FF" : "#E8D8A0");

// One tone per measured event class, matching the observatory palette.
const eventTone = (kind: string, isHandout: boolean) =>
  kind === "mint" ? "#BFFF76" : kind === "secondary" ? (isHandout ? "#66E8FF" : "#C3A6FF") : "#E8D8A0";

// The series rows: label, extract the per-day count, and bar color.
const seriesRows: Array<{ label: string; color: string; pick: (day: DayCounts) => number }> = [
  { label: "New identities minted", color: "#BFFF76", pick: day => day.mints },
  { label: "Hand-outs (platform distribution)", color: "#66E8FF", pick: day => day.handouts },
  { label: "Later changes of hands", color: "#C3A6FF", pick: day => day.laterTransfers },
  { label: "Profile-link edits", color: "#E8D8A0", pick: day => day.uriEdits },
];

/** Reindexes sparse day rows onto a dense 0..max range so quiet days render as honest gaps, not missing bars. */
function denseDays(series: readonly DayCounts[]): DayCounts[] {
  if (series.length === 0) return [];
  const byDay = new Map<number, DayCounts>();
  for (const row of series) byDay.set(row.day, row);
  const first = series[0].day;
  const last = series[series.length - 1].day;
  const dense: DayCounts[] = [];
  for (let day = first; day <= last; day += 1) {
    dense.push(byDay.get(day) ?? { day, mints: 0, handouts: 0, laterTransfers: 0, uriEdits: 0 });
  }
  return dense;
}

/**
 * The Solana registries' anchored events, on their own query so a failure here
 * never empties the identity-registry feed above. A registry with no recorded
 * events yet says so plainly instead of showing a false zero.
 */
function SolanaRegistryActivity() {
  const query = trpc.liveData.directorySolanaActivity.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const payload: { feed: readonly SolanaFeedEvent[]; totals: readonly SolanaTotal[] } | undefined = query.data;
  const feed = payload?.feed ?? [];
  const totals = payload?.totals ?? [];
  const countFor = (protocol: string) => totals.filter(total => total.protocol === protocol).reduce((sum, total) => sum + total.count, 0);

  return (
    <section className="changes-grid" style={{ gridTemplateColumns: "minmax(0, 1fr)" }} aria-label="Solana registry events">
      <div className="changes-panel">
        <header className="changes-panel-head">
          <div>
            <p className="changes-kicker"><Activity size={14} /> Anchored on the Solana registries</p>
            <h2>SAID, 8004, and Metaplex events</h2>
          </div>
          {feed.length > 0 && <span>{feed.length} shown</span>}
        </header>
        {payload && (
          <p className="changes-feed-note">
            {solanaRegistries
              .map(registry => {
                const count = countFor(registry.protocol);
                return `${registry.label}: ${count > 0 ? count.toLocaleString() : "none yet"}`;
              })
              .join(" · ")}
          </p>
        )}

        {query.isLoading && <p className="changes-feed-note"><RefreshCw className="animate-spin" size={13} /> Loading anchored events…</p>}
        {query.error && <p className="changes-feed-note">The Solana activity relay is temporarily unavailable. The identity-registry feed above is independent.</p>}
        {!query.isLoading && !query.error && feed.length === 0 && (
          <p className="changes-feed-note">No anchored Solana events are available yet. Nooscape shows the gap instead of inventing events.</p>
        )}

        {feed.length > 0 && (
          <ol className="changes-feed">
            {feed.map(event => (
              <li key={event.id} className="changes-feed-item">
                <span className="changes-feed-dot" style={{ backgroundColor: solanaTone(event.kind), boxShadow: `0 0 10px ${solanaTone(event.kind)}` }} />
                <div className="changes-feed-copy">
                  <p className="changes-feed-label">
                    {solanaActivityEventLabel(event.kind, event.protocol)}:{" "}
                    <Link href={`/agents/${event.entryId}`} className="changes-feed-agent">{event.displayName}</Link>
                  </p>
                  <p className="changes-feed-meta">
                    {solanaRegistryLabel(event.protocol)} · recorded {formatRecordedAt(event.recordedAt)} · observed at slot {event.slot.toLocaleString()} · {event.transactionSignature.slice(0, 16)}…
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="changes-feed-note">{solanaActivityExplanation}</p>
      </div>
    </section>
  );
}

export default function WhatChanged() {
  const feedQuery = trpc.liveData.directoryActivityFeed.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const payload: { totals: ActivityTotals | null; feed: readonly FeedEvent[]; series: readonly DayCounts[] } | undefined = feedQuery.data;
  const totals = payload?.totals ?? null;
  const feed = payload?.feed ?? [];
  const series = denseDays(payload?.series ?? []);
  const throughBlock = totals?.measuredThroughBlock ?? null;
  const laterTransfers = totals ? Math.max(0, totals.secondaryTransfers - totals.handoutTransfers) : 0;

  return (
    <main className="changes-page">
      <div className="changes-noise" />
      <header className="changes-header">
        <a href="/" className="changes-back"><ArrowLeft size={15} /> Return to Atlas</a>
        <div className="changes-header-mark"><History size={15} /> Identity registry changes</div>
        <a href="/sources" className="changes-source-link"><Database size={14} /> Source ledger</a>
      </header>

      <section className="changes-hero">
        <div>
          <p className="changes-kicker"><Activity size={14} /> Measured on the identity registry</p>
          <h1>What changed,<br /><span>measured — not streamed.</span></h1>
          <p className="changes-lede">
            Every ownership and profile event the activity walk has covered on the ERC-8004 identity registry: mints,
            hand-outs from the minting wallet, later changes of hands, and profile-link edits. Timing is a chain fact
            about when an identity moved — never whether the agent works.
          </p>
        </div>
        <aside className="changes-proof-card">
          <div><Database size={15} /><span>Evidence boundary</span></div>
          <strong>{throughBlock !== null ? `as of block ${throughBlock.toLocaleString()}` : "Not measured yet"}</strong>
          <p>
            {throughBlock !== null
              ? "The walk measures forward from genesis to this block. Events after it exist on chain but are not counted here yet, and the walk is still catching up to the chain head."
              : "The activity ledger has not been measured yet. This page shows the gap rather than inventing a feed."}
          </p>
        </aside>
      </section>

      {feedQuery.isLoading && <section className="changes-loading"><RefreshCw className="animate-spin" size={17} /> Loading measured activity…</section>}
      {feedQuery.error && <section className="changes-empty">The activity relay is temporarily unavailable. Agent records and source status remain independently available.</section>}
      {!feedQuery.isLoading && !feedQuery.error && feed.length === 0 && (
        <section className="changes-empty">
          No measured registry activity is available yet. The activity walk fills this page as it covers the chain — Nooscape
          shows the gap instead of inventing events.
        </section>
      )}

      {feed.length > 0 && totals && (
        <>
          <section className="changes-metric-grid" aria-label="Measured registry activity totals">
            <article className="changes-metric">
              <span>Identities minted</span>
              <strong>{totals.mintedEntries.toLocaleString()}</strong>
              <p>mints the walk has measured, each anchoring its identity's ownership history</p>
            </article>
            <article className="changes-metric">
              <span>Hand-outs</span>
              <strong>{totals.handoutTransfers.toLocaleString()}</strong>
              <p>moved from the minting wallet within about an hour of minting — distribution, not sales</p>
            </article>
            <article className="changes-metric">
              <span>Later changes of hands</span>
              <strong>{laterTransfers.toLocaleString()}</strong>
              <p>ownership moves outside the hand-out window — possibly sales, never verified</p>
            </article>
            <article className="changes-metric">
              <span>Profile-link edits</span>
              <strong>{totals.uriUpdates.toLocaleString()}</strong>
              <p>URI updates recorded since launch — where an identity says its profile lives</p>
            </article>
          </section>

          <section className="changes-grid">
            <div className="changes-panel" aria-label="Newest measured events">
              <header className="changes-panel-head">
                <h2>Newest measured events</h2>
                <span>newest {feed.length} of the measured ledger{throughBlock !== null ? ` · as of block ${throughBlock.toLocaleString()}` : ""}</span>
              </header>
              <ol className="changes-feed">
                {feed.map(event => (
                  <li key={`${event.transactionHash}-${event.logIndex}`} className="changes-feed-item">
                    <span className="changes-feed-dot" style={{ backgroundColor: eventTone(event.kind, event.isHandout), boxShadow: `0 0 10px ${eventTone(event.kind, event.isHandout)}` }} />
                    <div className="changes-feed-copy">
                      <p className="changes-feed-label">
                        {chainActivityEventLabel(event.kind, event.isHandout)} —{" "}
                        <Link href={`/agents/${event.entryId}`} className="changes-feed-agent">{event.displayName}</Link>
                      </p>
                      <p className="changes-feed-meta">
                        block {event.blockNumber.toLocaleString()} · {event.transactionHash.slice(0, 18)}…
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="changes-feed-note">
                Events are ordered by block, newest first. A <Term k="handout">hand-out</Term> is a change of hands from the
                wallet that minted the identity, within about an hour of minting — the block-proxied hour on this chain.
                Ratings, registration-stream events, and everything past the walk's measured block are not on this page.
              </p>
            </div>

            <div className="changes-panel" aria-label="Activity per block-day since launch">
              <header className="changes-panel-head">
                <h2>Every block-day since launch</h2>
                <span>each bar is one block-day (≈24 h at ≈0.1 s blocks)</span>
              </header>
              <div className="changes-series">
                {seriesRows.map(row => {
                  const peak = Math.max(1, ...series.map(row.pick));
                  return (
                    <div key={row.label} className="changes-series-row">
                      <div className="changes-series-label">
                        <b>{row.label}</b>
                        <span>peak {peak.toLocaleString()} / block-day</span>
                      </div>
                      <div className="changes-series-bars" role="img" aria-label={`${row.label} per block-day`}>
                        {series.map(day => {
                          const count = row.pick(day);
                          return (
                            <i
                              key={day.day}
                              title={`day ${day.day.toLocaleString()}: ${count.toLocaleString()}`}
                              style={{ height: `${Math.max(count > 0 ? 6 : 0, (count / peak) * 100)}%`, backgroundColor: count > 0 ? row.color : "rgba(255,255,255,.07)" }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="changes-series-note">
                Block-days are chain-derived: the ledger stores block numbers, not timestamps, so the x-axis counts days the
                way the chain does. Spikes are platform mint-and-hand-out bursts, not adoption — most identities were
                distributed, not sold ({totals.handoutTransfers.toLocaleString()} of {totals.secondaryTransfers.toLocaleString()} changes of hands were hand-outs).
                Days after the walk's measured block appear once the forward cursor ships.
              </p>
            </div>
          </section>

          <section className="changes-explain">
            <p>{handoutExplanation}</p>
            <a href="/sources" className="changes-explain-link">How this is measured <ArrowUpRight size={13} /></a>
          </section>
        </>
      )}

      <SolanaRegistryActivity />
    </main>
  );
}
