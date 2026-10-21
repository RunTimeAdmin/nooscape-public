import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Link } from "wouter";
import { Term } from "@/components/Term";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { directoryFunnelStepCopy } from "@/lib/glossary";
import { CountUp } from "./CountUp";
import { FOG_STAGE_MS, fogRows, fogSplit, stageDelays, type FunnelStep } from "./noiseModel";

/** What the activity walk has measured over the minted identities. */
type Activity = { secondaryTransfers: number; handoutTransfers: number; uriUpdates: number };

type Props = {
  steps: readonly FunnelStep[];
  status: "loading" | "ready" | "unavailable";
  /** The activity ledger's high-water block, when the funnel's later steps are counted "as of" one. */
  asOfBlock: number | null;
  /** What the activity walk has measured, when it has measured any. */
  activity: Activity | null;
};

const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

/**
 * The one funnel on the home page: what is left after each check, with the steps that only count listings
 * as fog. Clear the Fog dims the fog a step at a time and draws the evidence that is left against its own
 * longest bar, and Show all brings it back. The counts are the server's `directoryFunnel` steps and nothing
 * else; a step the server has not measured shows "not measured yet", never a zero.
 *
 * Every state is complete before anything moves: all rows, bars and counts are in the page from the first
 * paint (a screen reader, a page that is never scrolled and a visitor with reduced motion all get the whole
 * funnel), the bars are transforms of a full-width bar, and clearing the fog changes only opacity and
 * transform, so nothing in the layout moves. The bars draw in once, just before the section is on screen.
 */
export function NoiseFunnel({ steps, status, asOfBlock, activity }: Props) {
  const reduced = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const [armed, setArmed] = useState(false);
  const [cleared, setCleared] = useState(false);
  const known = steps.filter(step => directoryFunnelStepCopy[step.key]);
  const ready = status === "ready" && known.length > 0;
  const rows = fogRows(known);
  const split = fogSplit(known);
  const fogCount = split?.fog.length ?? 0;
  // The figure in view is the count of the first step still showing: the whole funnel's first while the fog is up, then each
  // step in turn as the fog clears, and the evidence last. Every number it passes through is a step's own count.
  const [stage, setStage] = useState(0);
  const inView = known[Math.min(stage, known.length - 1)];

  // The bars draw in once, a little before the section is on screen. A section already in view draws them before
  // the first paint, so they are never seen complete and then empty.
  useLayoutEffect(() => {
    const element = sectionRef.current;
    if (!element || reduced || armed || !ready) return;
    const box = element.getBoundingClientRect();
    if (box.bottom > 0 && box.top < window.innerHeight + 120) {
      setArmed(true);
      return;
    }
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setArmed(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px 120px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [reduced, armed, ready]);

  useEffect(() => {
    if (!split) return;
    if (!cleared || reduced) {
      setStage(cleared ? fogCount : 0);
      return;
    }
    const timers = stageDelays(split).map((delay, index) => window.setTimeout(() => setStage(index + 1), delay));
    return () => timers.forEach(timer => window.clearTimeout(timer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleared, reduced, fogCount]);

  return (
    <section ref={sectionRef} aria-labelledby="fog-heading" data-armed={armed} style={{ "--fog-stage": `${FOG_STAGE_MS}ms` } as CSSProperties} className="noise-funnel">
      <div className="fog-head">
        <div data-owl-avoid="" className="max-w-xl">
          <p className="eyebrow"><Term k="clearTheFog">Clear the Fog</Term></p>
          <h2 id="fog-heading" className="mt-2 text-xl tracking-[-.04em] text-ns-ink">See who&rsquo;s left after each check</h2>
        </div>
        {ready && split && (
          <button type="button" data-owl-avoid="" aria-pressed={cleared} onClick={() => setCleared(value => !value)} className="fog-button">
            {cleared ? "Show all" : "Clear the Fog"}
          </button>
        )}
      </div>
      <p data-owl-avoid="" className="mt-2 max-w-xl text-sm leading-6 text-ns-ink-dim">
        Most of what registries list has never been checked by anyone; Clear the Fog dims the steps that only count listings.
      </p>

      {ready ? (
        <>
          {split && inView && (
            <>
              <p data-owl-avoid="" className="fog-view">
                <strong className="fog-view-n">{inView.value === null ? "?" : <CountUp value={inView.value} durationMs={FOG_STAGE_MS} />}</strong>
                <span className="fog-view-unit">in view: {directoryFunnelStepCopy[inView.key]!.label}</span>
              </p>
              <p role="status" data-owl-avoid="" className="fog-state">
                {cleared
                  ? `Fog cleared. ${plural(split.left.length, "step", "steps")} left, bars drawn against the longest of ${split.left.length === 1 ? "it" : "them"}.`
                  : `All ${plural(rows.length, "step", "steps")} showing, every bar drawn against the longest.`}
              </p>
            </>
          )}
          <ol data-owl-avoid="" data-fog={cleared ? "clear" : "all"} className="fog-list" role="list">
            {rows.map(row => {
              const copy = directoryFunnelStepCopy[row.key]!;
              const style = { "--stage": row.stage, "--w": (row.full ?? 0) / 100, "--z": (row.zoomed ?? row.full ?? 0) / 100 } as CSSProperties;
              return (
                <li key={row.key} data-role={row.role} style={style} className="fog-row">
                  <div className="fog-copy">
                    <span className="fog-label">{copy.term ? <Term k={copy.term}>{copy.label}</Term> : copy.label}</span>
                    <span className="fog-note">{copy.note}</span>
                  </div>
                  <span className="fog-track">{row.value === null ? <span className="fog-na">not measured yet</span> : <span aria-hidden="true" className="fog-bar" />}</span>
                  <strong className="fog-value">{row.value === null ? "?" : <CountUp value={row.value} durationMs={900} />}</strong>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <p data-owl-avoid="" className="mt-5 rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-sm leading-6 text-ns-ink-dim">
          {status === "loading" ? "Reading the funnel counts…" : "The funnel counts cannot be read right now. Public reads fail closed rather than guess."}
        </p>
      )}

      <details data-owl-avoid="" className="fog-how">
        <summary>How these were counted</summary>
        <p>
          Every count is one the server reported, as it stands now.
          {asOfBlock !== null && ` The chain steps are counted as of block ${asOfBlock.toLocaleString()}.`} A question mark means not measured yet. Nooscape shows the gap instead of inventing a number for it.
        </p>
        {activity && (
          <p>
            Across the minted identities measured so far: {plural(activity.secondaryTransfers, "later change", "later changes")} of hands, of which {activity.handoutTransfers.toLocaleString()} moved within about an hour of minting (<Term k="handout">hand-outs</Term>, not sales), and {plural(activity.uriUpdates, "profile-link edit", "profile-link edits")} ever recorded. Ownership timing says when an identity moved between wallets, never whether the agent works.
            {asOfBlock !== null && ` Activity is measured as of block ${asOfBlock.toLocaleString()}; the walk is still catching up to the chain head.`}{" "}
            <Link href="/changes" className="fog-link">See what changed</Link>
          </p>
        )}
      </details>
    </section>
  );
}
