import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from "react";
import { Search } from "lucide-react";
import type { ChainStat } from "@shared/chains";
import type { NoosphereSample } from "@shared/noosphere";
import { TermTip } from "@/components/Term";
import { Button } from "@/components/ui/button";
import { usePointerKind } from "@/hooks/usePointerKind";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { ownRequest, trpc } from "@/lib/trpc";
import { CHAIN_STYLE, markerPath, type ChainStyleKey } from "./constellationModel";
import {
  fleetCountText,
  fleetSightedText,
  HERO_COPY,
  heroFigures,
  latestSweepAt,
  LEGEND,
  sampleCaption,
  sweepHeading,
  type ReadStatus,
} from "./heroModel";
import { Defined } from "./Defined";
import { arrivedHeroLine } from "./justArrivedModel";
import type { Sighting } from "./NoosphereBackdrop";

// The field of lights is decoration: it loads after the first paint, so the headline is what the page waits on.
const NoosphereBackdrop = lazy(() => import("./NoosphereBackdrop"));

/** The chains the key names, in the scan map's order. A steady light for a record that is only listed on a directory has no chain. */
const KEY_CHAINS: readonly ChainStyleKey[] = ["robinhood", "solana", "bnb", "none"];

const FLEET_ANCHOR = "#fleet-heading";
const MAP_ANCHOR = "#scan-field-heading";
const ARRIVED_ANCHOR = "#arrived-heading";

/** True once the page has painted and gone quiet, or a moment later where the browser has no idle callback. */
function useAfterPaint() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(() => setReady(true), { timeout: 1500 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(() => setReady(true), 250);
    return () => window.clearTimeout(handle);
  }, []);
  return ready;
}

/** An in-page link that scrolls to its target once it exists, the way the header's links do. */
function jumpTo(event: MouseEvent<HTMLElement>, href: string) {
  event.preventDefault();
  window.requestAnimationFrame(() => document.getElementById(href.slice(1))?.scrollIntoView({ block: "start" }));
}

function Swatch({ kind }: { kind: "steady" | "fleet" | "plain" }) {
  return (
    <svg aria-hidden="true" viewBox="-8 -8 16 16" className="size-4 shrink-0">
      {kind === "steady" && (
        <>
          <circle r="7" fill="var(--ns-radar)" opacity=".22" />
          <circle r="3.2" fill="var(--ns-radar)" />
        </>
      )}
      {kind === "fleet" && [[-4, -3], [1, -5], [4, -1], [-2, 2], [3, 4], [-5, 4], [0, 0]].map(([x, y]) => <circle key={`${x}/${y}`} cx={x} cy={y} r="1.5" fill="var(--ns-ink-dim)" opacity=".5" />)}
      {kind === "plain" && <circle r="1.8" fill="var(--ns-ink-dim)" opacity=".75" />}
    </svg>
  );
}

function Figures({ sample, status }: { sample: NoosphereSample | null; status: ReadStatus }) {
  if (status === "unavailable") {
    return <p className="mt-4 text-sm text-ns-ink-dim">The Owl's figures are unavailable right now. Nothing is shown in their place.</p>;
  }
  if (!sample) {
    return (
      <div className="hero-stats" aria-hidden="true">
        {[0, 1, 2].map(index => (
          <div key={index} className="w-24 space-y-2 sm:w-36">
            <div className="h-[clamp(1.5rem,4.2vw,3.25rem)] w-full animate-pulse rounded-md bg-white/10 motion-reduce:animate-none" />
            <div className="h-3.5 w-4/5 animate-pulse rounded bg-white/10 motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <dl className="hero-stats">
      {heroFigures(sample).map(figure => (
        <div key={figure.label} className="hero-figure">
          <dt>{figure.label}</dt>
          <dd>{figure.value.toLocaleString("en-US")}</dd>
        </div>
      ))}
    </dl>
  );
}

type Props = {
  /** The same action as the header's button: open the agent search, or scroll to the map while it is still loading. */
  onAskTheOwl: () => void;
};

/**
 * The top of the home page: one scene and very little text. The headline and the two buttons are in the page from
 * the first paint, the three numbers fill their reserved place when the read arrives, and the field of lights behind
 * them (the Noosphere sample) comes after that. The right-hand column is reserved: the owl's perch above, and below
 * it the sky, which is where the fleets are drawn, so a ring or its tooltip never lands on the words.
 */
export function HeroScene({ onAskTheOwl }: Props) {
  const reduced = useReducedMotion();
  const coarse = usePointerKind() === "coarse";
  // The sample is the heaviest read on the page when its cache is cold, so it goes in a request of its own and holds nothing else back.
  const sampleQuery = trpc.liveData.noosphereSample.useQuery(undefined, { staleTime: 5 * 60_000, refetchOnWindowFocus: false, ...ownRequest });
  const statsQuery = trpc.liveData.chainStats.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true });
  // The router answers { sample }, and { sample: null } when the read failed on the server.
  const sample: NoosphereSample | null = sampleQuery.data?.sample ?? null;
  const sampleStatus: ReadStatus = sampleQuery.isError || sampleQuery.data?.sample === null ? "unavailable" : sample ? "ready" : "loading";
  const statsStatus: ReadStatus = statsQuery.isError ? "unavailable" : statsQuery.data ? "ready" : "loading";
  const rows: readonly ChainStat[] = statsQuery.data?.chains ?? [];
  // The same read the "New to the Owl" section makes, so the one request serves both. It is a line the hero can do without, so it goes alone.
  const arrivalsQuery = trpc.liveData.arrivals.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true, ...ownRequest });
  const freshLine = arrivedHeroLine(arrivalsQuery.data?.arrivals ?? null);

  const heroRef = useRef<HTMLElement>(null);
  const skyRef = useRef<HTMLDivElement>(null);
  const holdRef = useRef(false);
  const afterPaint = useAfterPaint();
  const [drawn, setDrawn] = useState<number | null>(null);
  const [sighting, setSighting] = useState<Sighting | null>(null);

  const fleetNote = sample ? fleetCountText(sample.fleets.length) : null;
  const sighted = sighting && sample ? sample.fleets[sighting.fleet - 1] : undefined;
  // A hold belongs to the tooltip that set it: when the tooltip goes, so does the hold.
  useEffect(() => {
    if (!sighting) holdRef.current = false;
  }, [sighting]);

  return (
    <section ref={heroRef} aria-labelledby="hero-heading" className="hero-scene">
      <div className="hero-layer hero-backdrop" aria-hidden="true">
        <div className="hero-poster" />
        {afterPaint && sample && (
          <Suspense fallback={null}>
            <NoosphereBackdrop sample={sample} hostRef={heroRef} skyRef={skyRef} holdRef={holdRef} reduced={reduced} coarse={coarse} onDrawn={setDrawn} onSighted={setSighting} />
          </Suspense>
        )}
        <div className="hero-vignette" />
      </div>

      <div className="hero-inner">
        <div className="hero-grid">
          <h1 id="hero-heading" className="hero-headline" data-owl-avoid="">
            <span>{HERO_COPY.headline[0]}</span>
            <span className="holographic-text">{HERO_COPY.headline[1]}</span>
          </h1>

          <div className="hero-owl" data-owl-perch="top-right" aria-hidden="true" />

          <p className="hero-copy" data-owl-avoid="">{HERO_COPY.subcopy}</p>

          <div className="hero-actions" data-owl-avoid="">
            <TermTip k="askTheOwl">
              <Button onClick={onAskTheOwl} className="h-12 rounded-full bg-ns-radar px-6 text-ns-void shadow-ns-glow hover:bg-ns-radar hover:brightness-110">
                <Search size={18} />
                {HERO_COPY.primaryCta}
              </Button>
            </TermTip>
            <a
              href={MAP_ANCHOR}
              onClick={event => jumpTo(event, MAP_ANCHOR)}
              className="inline-flex h-12 items-center rounded-full bg-white/[0.04] px-6 text-ns-ink shadow-[inset_0_0_0_1px_var(--ns-glass-border)] transition-colors hover:bg-white/[0.09] focus-visible:bg-white/[0.09] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar"
            >
              {HERO_COPY.secondaryCta}
            </a>
          </div>

          <div className="hero-figures" data-owl-avoid="">
            <p className="ns-label m-0"><Defined k="owlsLastSweep" text={sweepHeading(latestSweepAt(rows), statsStatus)} /></p>
            <Figures sample={sample} status={sampleStatus} />
            {freshLine && (
              <p className="m-0 mt-3 text-sm leading-5 text-ns-ink-dim">
                <a href={ARRIVED_ANCHOR} onClick={event => jumpTo(event, ARRIVED_ANCHOR)} className="underline-offset-4 hover:text-ns-ink hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar">{freshLine}</a>
              </p>
            )}
          </div>

          <div ref={skyRef} className="hero-sky" aria-hidden="true" />

          <div className="hero-legend ns-glass" role="group" aria-label="What the lights mean" data-owl-avoid="">
            <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-2 p-0 text-[0.8125rem] leading-snug text-ns-ink">
              <li className="flex items-center gap-2"><Swatch kind="steady" /><span><Defined k="steadyLight" text={LEGEND.steady} /></span></li>
              <li className="flex items-center gap-2"><Swatch kind="fleet" /><span><Defined k="dimCluster" text={LEGEND.fleet} /></span></li>
              <li className="flex items-center gap-2"><Swatch kind="plain" />{LEGEND.plain}</li>
            </ul>
            <p className="m-0 mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] leading-snug text-ns-ink-dim">
              <span className="text-ns-ink">{LEGEND.rule}</span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {KEY_CHAINS.map(chain => (
                  <span key={chain} className="flex items-center gap-1.5">
                    <svg aria-hidden="true" viewBox="-1.5 -1.5 3 3" className="size-3 shrink-0">
                      <path d={markerPath(CHAIN_STYLE[chain].shape)} fill={CHAIN_STYLE[chain].color} />
                    </svg>
                    {CHAIN_STYLE[chain].label}
                  </span>
                ))}
              </span>
            </p>
            <p className="m-0 mt-2 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-ns-ink-dim">
              {drawn !== null && sample && <span>{sampleCaption(drawn, sample.total)}</span>}
              {fleetNote && <span>{fleetNote}</span>}
              {sample && sample.fleets.length > 0 && (
                <a href={FLEET_ANCHOR} onClick={event => jumpTo(event, FLEET_ANCHOR)} className="inline-flex min-h-11 items-center rounded-sm text-ns-radar underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar sm:min-h-6">
                  See the fleets
                </a>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="hero-layer hero-overlay">
        {sighting && sighted && (
          <a
            href={FLEET_ANCHOR}
            onClick={event => jumpTo(event, FLEET_ANCHOR)}
            onPointerEnter={() => { holdRef.current = true; }}
            onPointerLeave={() => { holdRef.current = false; }}
            onFocus={() => { holdRef.current = true; }}
            onBlur={() => { holdRef.current = false; }}
            className="hero-sighting"
            data-owl-avoid=""
            style={{ left: `clamp(7.5rem, ${Math.round(sighting.x)}px, calc(100% - 7.5rem))`, top: Math.round(sighting.y + sighting.radius + 24) }}
          >
            {fleetSightedText(sighted)}
          </a>
        )}
      </div>
    </section>
  );
}
