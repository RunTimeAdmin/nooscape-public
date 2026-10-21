import { Link } from "wouter";
import { Term } from "@/components/Term";
import { useEffect, useMemo, useState } from "react";
import { AgentConstellation } from "@/components/home/AgentConstellation";
import { CheckCard } from "@/components/home/CheckCard";
import { bubbleFacts } from "@/components/home/landingFacts";
import { ScanStatusLine } from "@/components/home/ScanStatusLine";
import { acknowledgedLegendEntries, acknowledgedRecords, CHAIN_STYLE, currentSelection, fleetRecords, isAcknowledged, isFleet, layoutNodes, legendEntries, markerPath, statusLines, type AcknowledgedSample, type ConstellationRecord, type EvidenceState } from "@/components/home/constellationModel";
import { sweepLine } from "@/components/home/sweepModel";
import { setOwlFacts } from "@/components/owl/owlFacts";
import { useOwl } from "@/contexts/OwlContext";
import type { ChainStat } from "@shared/chains";
import { arcLightsCaption, fleetShape, fleetsCaption, robinhoodLightsCaption, solanaLightsCaption, type MapFleets, type RegistryFleets } from "@shared/mapFleets";
import { tierExplanations } from "@/lib/evidenceExplain";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/lib/useDebouncedValue";

type Props = {
  records: readonly ConstellationRecord[];
  status: "loading" | "ready" | "unavailable";
  /** A fixed sample of what the directory lists on BNB Chain, and how many it lists in all: drawn hollow beside the reviewed records. */
  acknowledged?: AcknowledgedSample | null;
  /** The largest groups of BNB Chain registrations that share one fact, and the Solana owner wallets that hold many, from `liveData.mapFleets`: each BNB Chain group is drawn as one large circle and each wallet as one large diamond, with its count. */
  fleets?: MapFleets | null;
  /** The groups of Arc registrations that share one wallet, host or profile link, from `liveData.registryFleets`, while Arc's switch is on: each of the largest is drawn as one large dome with its count. */
  arcFleets?: RegistryFleets | null;
};

/** The parts of the evidence envelope the card reads. */
type EnvelopeFacts = {
  sequence: number;
  publisherValidation?: { status: string };
  provenance?: { sourceLabel: string; validationStatus: string };
};

/**
 * Reviewed records on one map, scanned by the owl or the pointer. Every filled dot is a record from `liveData.publicRecords`.
 * The only other dots are the hollow ones: entries from `liveData.mapAcknowledged` that the directory lists and Nooscape has
 * not reviewed. Nothing else is drawn.
 */
export default function LandingHero({ records, status, acknowledged = null, fleets = null, arcFleets = null }: Props) {
  const { enabled: owlOn } = useOwl();
  const entries = useMemo(() => acknowledgedRecords(acknowledged), [acknowledged]);
  const lights = useMemo(() => fleetRecords(fleets, arcFleets), [fleets, arcFleets]);
  // An entry that is also a reviewed record is drawn once, as the record.
  const everything = useMemo(() => {
    const reviewed = new Set(records.map(candidate => candidate.agentId));
    return [...records, ...entries.filter(entry => !reviewed.has(entry.agentId)), ...lights];
  }, [records, entries, lights]);
  const nodes = useMemo(() => layoutNodes(everything), [everything]);
  const [scannedId, setScannedId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  // The card shows the pinned record, else the one under the scan, else the one the map opens on, so it is never empty.
  const selection = useMemo(() => currentSelection(nodes, pinnedId, scannedId), [nodes, pinnedId, scannedId]);
  const node = selection.node;
  const shownId = node?.id ?? null;
  const record = useMemo(() => everything.find(candidate => candidate.agentId === shownId), [everything, shownId]);
  const legend = useMemo(() => legendEntries(nodes), [nodes]);
  const acknowledgedLegend = useMemo(() => acknowledgedLegendEntries(nodes), [nodes]);
  const lightCount = useMemo(() => nodes.filter(node => isFleet(node) && fleetShape(node.fleet) === "circle").length, [nodes]);
  const solanaLightCount = useMemo(() => nodes.filter(node => isFleet(node) && fleetShape(node.fleet) === "diamond").length, [nodes]);
  const robinhoodLightCount = useMemo(() => nodes.filter(node => isFleet(node) && fleetShape(node.fleet) === "hexagon").length, [nodes]);
  const arcLightCount = useMemo(() => nodes.filter(node => isFleet(node) && fleetShape(node.fleet) === "dome").length, [nodes]);
  const fleetNote = fleets ? fleetsCaption(fleets) : null;
  const solanaNote = fleets?.solana ? solanaLightsCaption(fleets.solana) : null;
  const robinhoodNote = fleets?.robinhood ? robinhoodLightsCaption(fleets.robinhood) : null;
  const arcNote = arcFleets ? arcLightsCaption(arcFleets, arcLightCount) : null;

  // The evidence is read only for the record on the card, and only once the selection has settled on it.
  const settledId = useDebouncedValue(shownId, 150);
  const evidenceQuery = trpc.atlas.evidence.useQuery({ agentId: settledId ?? "" }, { enabled: settledId !== null && settledId === shownId && node !== null && !isAcknowledged(node) && !isFleet(node), staleTime: 60_000, retry: false });
  const evidence: EvidenceState = useMemo(() => {
    if (!shownId) return { status: "idle" };
    // An acknowledged entry or a fleet light has no signed evidence to read, so none is asked for.
    if (node && (isAcknowledged(node) || isFleet(node))) return { status: "idle" };
    if (shownId !== settledId || evidenceQuery.isLoading) return { status: "loading" };
    if (evidenceQuery.isError || !evidenceQuery.data) return { status: "unavailable" };
    const facts: EnvelopeFacts = evidenceQuery.data;
    return {
      status: "ready",
      publisher: facts.publisherValidation?.status ?? "unverified",
      provenance: facts.provenance?.validationStatus ?? null,
      observations: facts.sequence,
      source: facts.provenance?.sourceLabel ?? null,
    };
  }, [shownId, settledId, node, evidenceQuery.isLoading, evidenceQuery.isError, evidenceQuery.data]);

  // What the owl may say about the record on the card is the card's own facts, and nothing more. They are told again
  // when they change, and taken back only when the map goes: a read of the same data tells the owl nothing new.
  useEffect(() => {
    setOwlFacts(bubbleFacts(node, evidence, record));
  }, [node, evidence, record]);
  useEffect(() => () => setOwlFacts(null), []);

  // The Owl's last sweep: the same reads the hero's heading and the regions use, so they agree. The block is how far the Robinhood activity ledger is measured.
  const statsQuery = trpc.liveData.chainStats.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true });
  const activityQuery = trpc.liveData.directoryActivityFeed.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true });
  const sweep = sweepLine({
    status: statsQuery.isError ? "unavailable" : statsQuery.data ? "ready" : "loading",
    rows: statsQuery.data?.chains ?? [],
    robinhoodBlock: activityQuery.data?.totals?.measuredThroughBlock ?? null,
  });

  const tiers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const candidate of nodes) if (!isAcknowledged(candidate) && !isFleet(candidate)) counts.set(candidate.tier, (counts.get(candidate.tier) ?? 0) + 1);
    return Array.from(counts.entries()).sort(([a], [b]) => (a < b ? -1 : 1));
  }, [nodes]);

  return (
    <section aria-labelledby="scan-field-heading" className="radar-grid relative mb-5 rounded-[1.5rem] p-4 sm:p-6">
      {/* A place for the owl in the empty top right, on a wide screen: reserved, so it never stands on the words. */}
      <div data-owl-perch="top-right" data-owl-topic="records" aria-hidden="true" className="pointer-events-none absolute right-6 top-3 hidden h-[8.25rem] w-28 xl:block" />
      {/* On a wide screen the top right is the owl's perch, so the words keep the room above the map that it stands in. */}
      <div data-owl-avoid="" className="max-w-3xl xl:min-h-[7rem]">
        <p className="eyebrow"><Term k="noosphere">The Noosphere</Term></p>
        <h2 id="scan-field-heading" className="mt-1 text-2xl font-medium tracking-[-.02em] text-[#F2FFF5]">Every reviewed record on one map</h2>
        <p className="mt-2 text-sm leading-6 text-[#A9B8AE]">
          Hover or tap a light to read what its evidence says; nothing here is a score.
          {entries.length > 0 && acknowledged && ` Hollow squares are BNB Chain registrations the directory lists and Nooscape has not reviewed: ${entries.length} of ${acknowledged.listed.toLocaleString("en-US")}, picked by a fixed rule that ignores quality.`}
        </p>
      </div>

      {status !== "ready" || nodes.length === 0 ? (
        <p data-owl-avoid="" className="mt-5 rounded-2xl border border-white/[0.09] bg-[#05080A] px-5 py-12 text-center font-mono text-xs text-[#819588]">
          {status === "loading" ? "Loading reviewed records…" : "No reviewed records are available right now. Nothing is drawn in their place."}
        </p>
      ) : (
        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-3">
            <AgentConstellation records={everything} scannedId={scannedId} onScan={setScannedId} pinnedId={pinnedId} onPin={setPinnedId} selectedId={shownId} />
            <ScanStatusLine lines={statusLines(node, evidence, owlOn ? "owl" : "pointer", selection.kind ?? "scanned")} sweep={sweep} />
            <ul data-owl-avoid="" className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs uppercase tracking-[.12em] text-ns-ink-dim" aria-label="Map key">
              {legend.map(entry => (
                <li key={entry.key} className="flex items-center gap-2">
                  <svg aria-hidden="true" viewBox="-1.5 -1.5 3 3" className="size-3 shrink-0">
                    <path d={markerPath(entry.shape)} fill={entry.color} />
                  </svg>
                  {entry.label} · {entry.count}
                </li>
              ))}
              {acknowledgedLegend.map(entry => (
                <li key={`acknowledged-${entry.key}`} className="flex items-center gap-2">
                  <svg aria-hidden="true" viewBox="-1.5 -1.5 3 3" className="size-3 shrink-0">
                    <path d={markerPath(entry.shape)} fill="none" stroke={entry.color} strokeWidth={0.35} />
                  </svg>
                  {entry.label} · {entry.count} of {(acknowledged?.listed ?? entry.count).toLocaleString("en-US")} acknowledged
                </li>
              ))}
              {lightCount > 0 && fleets && (
                <li className="flex items-center gap-2">
                  <svg aria-hidden="true" viewBox="-6 -6 12 12" className="size-3.5 shrink-0">
                    <circle r="4.6" fill="rgba(243,186,47,0.14)" stroke={CHAIN_STYLE.bnb.color} strokeWidth="1.1" />
                    <circle r="1.3" fill={CHAIN_STYLE.bnb.color} />
                  </svg>
                  {CHAIN_STYLE.bnb.label} groups · {lightCount} of {Math.max(fleets.groups, lightCount).toLocaleString("en-US")} drawn
                </li>
              )}
              {solanaLightCount > 0 && fleets?.solana && (
                <li className="flex items-center gap-2">
                  <svg aria-hidden="true" viewBox="-6 -6 12 12" className="size-3.5 shrink-0">
                    <path d="M0 -5.2L5.2 0L0 5.2L-5.2 0Z" fill="rgba(167,139,250,0.14)" stroke={CHAIN_STYLE.solana.color} strokeWidth="1.1" />
                    <path d="M0 -1.5L1.5 0L0 1.5L-1.5 0Z" fill={CHAIN_STYLE.solana.color} />
                  </svg>
                  {CHAIN_STYLE.solana.label} owner wallets · {solanaLightCount} of {Math.max(fleets.solana.groups, solanaLightCount).toLocaleString("en-US")} drawn
                </li>
              )}
              {robinhoodLightCount > 0 && fleets?.robinhood && (
                <li className="flex items-center gap-2">
                  <svg aria-hidden="true" viewBox="-6 -6 12 12" className="size-3.5 shrink-0">
                    <path d="M0 -5.2L4.5 -2.6L4.5 2.6L0 5.2L-4.5 2.6L-4.5 -2.6Z" fill="rgba(195,245,60,0.14)" stroke={CHAIN_STYLE.robinhood.color} strokeWidth="1.1" />
                    <path d="M0 -1.5L1.3 -0.75L1.3 0.75L0 1.5L-1.3 0.75L-1.3 -0.75Z" fill={CHAIN_STYLE.robinhood.color} />
                  </svg>
                  {CHAIN_STYLE.robinhood.label} registering wallets · {robinhoodLightCount} of {Math.max(fleets.robinhood.groups, robinhoodLightCount).toLocaleString("en-US")} drawn
                </li>
              )}
              {arcLightCount > 0 && arcFleets && (
                <li className="flex items-center gap-2">
                  <svg aria-hidden="true" viewBox="-6 -6 12 12" className="size-3.5 shrink-0">
                    <path d="M-5.2 3A5.2 5.2 0 0 1 5.2 3Z" fill="rgba(172,198,233,0.14)" stroke={CHAIN_STYLE.arc.color} strokeWidth="1.1" />
                    <path d="M-1.5 0.9A1.5 1.5 0 0 1 1.5 0.9Z" fill={CHAIN_STYLE.arc.color} />
                  </svg>
                  {CHAIN_STYLE.arc.label} groups · {arcLightCount} of {Math.max(arcFleets.groups, arcLightCount).toLocaleString("en-US")} drawn
                </li>
              )}
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="inline-block size-3 shrink-0 rounded-full shadow-[0_0_0_2px_var(--ns-radar)]" />
                Ring: the record on the card
              </li>
            </ul>
            {fleetNote && <p data-owl-avoid="" className="text-xs leading-5 text-ns-ink-dim">{fleetNote}</p>}
            {solanaNote && <p data-owl-avoid="" className="text-xs leading-5 text-ns-ink-dim">{solanaNote}</p>}
            {robinhoodNote && <p data-owl-avoid="" className="text-xs leading-5 text-ns-ink-dim">{robinhoodNote}</p>}
            {arcNote && <p data-owl-avoid="" className="text-xs leading-5 text-ns-ink-dim">{arcNote}</p>}
            {fleetNote && (
              <p data-owl-avoid="" className="text-xs leading-5 text-ns-ink-dim">
                Two reports, both dated 16 October 2026: the <Link href="/field/bnb-registry-2026-10-16" className="underline underline-offset-4 hover:text-ns-ink">BNB Chain registry census</Link> and the <Link href="/field/bnb-ratings-2026-10-16" className="underline underline-offset-4 hover:text-ns-ink">BNB Chain rating census</Link>.
              </p>
            )}
            {solanaNote && (
              <p data-owl-avoid="" className="text-xs leading-5 text-ns-ink-dim">
                One report, dated 18 October 2026: the <Link href="/field/solana-registries-2026-10-18" className="underline underline-offset-4 hover:text-ns-ink">Solana registry census</Link>.
              </p>
            )}
            {robinhoodNote && (
              <p data-owl-avoid="" className="text-xs leading-5 text-ns-ink-dim">
                One report, dated 20 October 2026: the <Link href="/field/robinhood-registry-2026-10-20" className="underline underline-offset-4 hover:text-ns-ink">Robinhood Chain registry census</Link>.
              </p>
            )}
            {arcNote && (
              <p data-owl-avoid="" className="text-xs leading-5 text-ns-ink-dim">
                One report, dated 20 October 2026: the <Link href="/field/arc-registry-2026-10-20" className="underline underline-offset-4 hover:text-ns-ink">Arc registry census</Link>.
              </p>
            )}
            <p data-owl-avoid="" className="text-xs leading-5 text-ns-ink-dim">
              Evidence tiers on this map: {tiers.map(([tier, count]) => `${tierExplanations[tier]?.label ?? tier} · ${count}`).join(", ")}.
            </p>
          </div>
          <CheckCard node={node} evidence={evidence} kind={selection.kind} onUnpin={() => setPinnedId(null)} />
        </div>
      )}
    </section>
  );
}
