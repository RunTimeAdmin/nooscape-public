import { type CSSProperties, type MouseEvent as ReactMouseEvent, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { AgentBotAvatar } from "@/components/AgentBotAvatar";
import { Term } from "@/components/Term";
import { useElementSize } from "@/hooks/useElementSize";
import { countByEvidenceGroup, evidenceReadout } from "@/lib/evidenceReadout";
import { type LabelPlace, planLabels } from "@/lib/fieldLabels";
import { notYetMeasurable } from "@/lib/glossary";
import { buildTopologyLayer, connectionLinesForEntities, pickFeaturedAgents } from "@/lib/topology";
import { cn } from "@/lib/utils";
import { BadgeCheck, ChevronRight, Fingerprint, Layers3, Network, Orbit, Radio, Satellite, Search, ShieldCheck, Terminal } from "lucide-react";
import { type AtlasAgent, type ClusterMarker, type DirectoryBreakdown, type DirectoryUsdgSettlements, type EvidenceEnvelope, type IngestionEvent, type Lens, type LiveAtlasCoverage, type LiveAtlasRecord, type TrustFilter, isDomainVerifiedAgent, publisherStateMeta, signalLineTone, tones } from "./atlasModel";
import { FieldDust, IngressNode, LiveEvidenceFeed, PublisherStateIcon, SignalCell } from "./atlasParts";

/** The filter above the full field, in the order it reads: what each choice is called, and how it looks once chosen. */
const trustFilters: { value: TrustFilter; label: string; Icon: typeof Layers3; active: string }[] = [
  { value: "all", label: "All agents", Icon: Layers3, active: "border-[#BFFF76]/55 bg-[#BFFF76]/[.12] text-[#D9FFC2]" },
  { value: "owner", label: "Owner-verified", Icon: BadgeCheck, active: "border-[#66E8FF]/55 bg-[#66E8FF]/[.1] text-[#B9F6FF]" },
  { value: "website", label: "Website-verified", Icon: ShieldCheck, active: "border-[#BFFF76]/55 bg-[#BFFF76]/[.12] text-[#D9FFC2]" },
  { value: "none", label: "No proof yet", Icon: Fingerprint, active: "border-[#C3A6FF]/55 bg-[#C3A6FF]/[.12] text-[#E3D8FF]" },
];

const USDG_MICROS = BigInt(1_000_000);

// Formats a raw 6-decimal USDG amount as an exact dollar string. Values stay
// BigInt-exact end to end; no float ever touches an amount.
function formatUsdgAmount(raw: string): string {
  const value = BigInt(raw);
  const whole = value / USDG_MICROS;
  const micros = (value % USDG_MICROS).toString().padStart(6, "0").replace(/0+$/, "");
  if (whole > BigInt(0)) return micros ? `$${whole.toLocaleString("en-US")}.${micros}` : `$${whole.toLocaleString("en-US")}`;
  return micros ? `$0.${micros}` : "$0";
}

const lensCopy: Record<Lens, { title: string; detail: string; indicator: string }> = {
  field: { title: "FIELD / LIVE", detail: "Capability terrain", indicator: "Ecosystem state" },
  protocol: { title: "PROTOCOL / TRACE", detail: "Interoperability paths", indicator: "Service topology" },
  trust: { title: "EVIDENCE / TIER", detail: "Identity and evidence", indicator: "Verification contour" },
};

function AgentNode({ agent, active, index, label, onSelect }: { agent: AtlasAgent; active: boolean; index: number; label: LabelPlace | null; onSelect: () => void }) {
  const tone = tones[agent.capability] ?? "#BFFF76";
  const publisherState = agent.publisherValidation.status;
  const annotated = publisherState !== "unverified";
  return <button type="button" onClick={onSelect} className={cn("agent-node", active && "agent-node-active", `agent-node-publisher-${publisherState}`)} style={{ left: `${agent.position.x}%`, top: `${agent.position.y}%`, "--tone": tone, "--delay": `${index * 0.42}s` } as CSSProperties}><span className="agent-halo" /><span className="agent-pulse" /><span className="agent-bot"><AgentBotAvatar agentId={agent.id} tone={tone} /></span>{annotated && <span className={cn("field-publisher-badge", `publisher-state-${publisherState}`)} title={`${publisherStateMeta[publisherState].label}: ${agent.publisherValidation.publisherName}`}><PublisherStateIcon state={publisherState} size={10} /></span>}<span className={cn("agent-label", label?.side === "left" && "agent-label-left", !label && "agent-label-quiet")} style={label ? { maxWidth: label.width } : undefined}><strong>{agent.name}</strong><em>{agent.capability}</em></span></button>;
}

function FieldClusterNode({ cluster, onSelect }: { cluster: ClusterMarker; onSelect: () => void }) {
  const tone = tones[cluster.capability] ?? "#C3A6FF";
  return <button type="button" onClick={onSelect} className="topology-cluster" aria-label={`Open ${cluster.count} agent cluster`} style={{ left: `${cluster.position.x}%`, top: `${cluster.position.y}%`, "--tone": tone } as CSSProperties}><span><Layers3 size={12} /></span><strong>{cluster.count}</strong><em>{cluster.capability}</em></button>;
}

/**
 * Holds the place of the field and its filter while the live records load, so nothing below it moves when
 * it arrives. The heights are those of the real block at each width (it stacks into one column below xl);
 * change them if the field's layout changes.
 */
function AtlasPlaceholder({ state }: { state: "loading" | "unavailable" }) {
  return (
    <section data-owl-avoid="" aria-label="The field" aria-busy={state === "loading"} className="observatory-frame relative mb-5 grid min-h-[2240px] place-items-start justify-center overflow-hidden rounded-[1.5rem] border border-white/[0.11] bg-[#080B0E]/88 p-6 pt-16 text-center md:min-h-[2020px] lg:min-h-[1920px] xl:min-h-[1090px]">
      {state === "loading"
        ? <p role="status" className="font-mono text-xs uppercase tracking-[.17em] text-[#9AA8B8]">Loading the field</p>
        : <p role="alert" className="text-sm text-[#D9FFE9]">Nooscape is momentarily beyond the horizon. Refresh to reconnect.</p>}
    </section>
  );
}

/** The tier, the publisher and the sentence for each. */
function EvidenceReadoutBlock({ agent }: { agent: AtlasAgent }) {
  const readout = evidenceReadout(agent);
  return <div className="mt-6" data-evidence-readout="observed"><p className="eyebrow">Evidence</p><p className="mt-2 text-sm font-medium text-[#EAF7EE]">{readout.tierLabel}</p><p className="mt-1 text-xs leading-5 text-[#A5B6AA]">{readout.tierSentence}</p><p className="mt-3 text-xs font-medium text-[#D9E8DD]">{readout.publisherLabel}</p><p className="mt-1 text-xs leading-5 text-[#A5B6AA]">{readout.publisherSentence}</p></div>;
}

type FieldProps = {
  agents: AtlasAgent[];
  visibleAgents: AtlasAgent[];
  selected: AtlasAgent;
  selectedId: string;
  compareIds: string[];
  liveRecords: LiveAtlasRecord[];
  liveRecordsQuery: { isLoading: boolean };
  liveCoverage: LiveAtlasCoverage | undefined;
  directoryBreakdown: DirectoryBreakdown | undefined;
  directoryAckTotal: number;
  usdgTotals: DirectoryUsdgSettlements | null;
  ingressFeed: IngestionEvent[];
  verifiedIngress: IngestionEvent | null;
  showIngress: boolean;
  activeEvidence: EvidenceEnvelope | undefined;
  evidenceQuery: { isLoading: boolean };
  evidenceStaleSince: number | null;
  atlasReady: boolean;
  query: string;
  setQuery: (value: string) => void;
  trustFilter: TrustFilter;
  setMainTrustFilter: (value: TrustFilter) => void;
  setFrameworkFilter: (value: string) => void;
  setSelectedId: (id: string) => void;
  setDeepSpace: (open: boolean) => void;
  setZoom: (zoom: number) => void;
  locateAgent: (id: string) => void;
};

// The full field page: the capability terrain, the evidence filter, what nobody can measure yet, the settlement rail and the search.
// Home fetches this file when /field is opened (pages/Home.tsx), and hands it the page's records and handlers.
export default function FieldView({ agents, visibleAgents, selected, selectedId, compareIds, liveRecords, liveRecordsQuery, liveCoverage, directoryBreakdown, directoryAckTotal, usdgTotals, ingressFeed, verifiedIngress, showIngress, activeEvidence, evidenceQuery, evidenceStaleSince, atlasReady, query, setQuery, trustFilter, setMainTrustFilter, setFrameworkFilter, setSelectedId, setDeepSpace, setZoom, locateAgent }: FieldProps) {
  const [lens, setLens] = useState<Lens>("field");
  const trustPopulation = useMemo(() => countByEvidenceGroup(agents), [agents]);
  const locateMatches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return agents
      .filter(agent => `${agent.name} ${agent.handle} ${agent.capability} ${agent.framework}`.toLowerCase().includes(needle))
      .slice(0, 4);
  }, [agents, query]);
  // The field honors the active search/filter set; within it, a bounded bot
  // crew is featured — selected and pinned agents first, then trust flagships,
  // the seed crew, and freshest observations — while the rest renders as dust.
  const prominentAgents = useMemo(() => {
    const domainVerified = visibleAgents.filter(isDomainVerifiedAgent);
    const seedCrew = visibleAgents.filter(agent => agent.status !== "OBSERVED");
    const observed = visibleAgents.filter(agent => agent.status === "OBSERVED" && !isDomainVerifiedAgent(agent));
    return [...domainVerified, ...seedCrew, ...observed];
  }, [visibleAgents]);
  const fieldCrew = useMemo(
    () => pickFeaturedAgents(prominentAgents, selectedId, compareIds),
    [prominentAgents, selectedId, compareIds]
  );
  // Which of the featured agents get a name beside them on the map: as many as fit without touching (lib/fieldLabels).
  const [setSceneElement, sceneSize] = useElementSize();
  const labelPlan = useMemo(
    () => planLabels(fieldCrew.featured.map(agent => ({ id: agent.id, x: agent.position.x, y: agent.position.y, name: agent.name, detail: agent.capability })), sceneSize, selected?.id ?? null),
    [fieldCrew.featured, sceneSize, selected?.id]
  );
  const fieldTopology = useMemo(() => buildTopologyLayer(fieldCrew.featured, selectedId), [fieldCrew.featured, selectedId]);
  const fieldTopologyEntities = useMemo(() => [...fieldTopology.direct, ...fieldTopology.clusters], [fieldTopology]);
  const copy = lensCopy[lens];
  const fieldStats = liveRecords.length
    ? [
        { label: "Live records", value: String(liveCoverage?.publicRecordCount ?? liveRecords.length), detail: "source-scoped / publicly projected" },
        { label: "Protocols mapped", value: String(new Set(agents.map(agent => agent.framework)).size), detail: Array.from(new Set(agents.map(agent => agent.framework))).join(" · ") },
        {
          label: "Provenance coverage",
          value: liveCoverage ? `${liveCoverage.provenanceReadyCount}/${liveCoverage.publicRecordCount} · ${liveCoverage.coveragePercent}%` : "CHECKING",
          detail: "public snapshots with retained-evidence envelopes",
        },
        ...(directoryBreakdown && directoryBreakdown.total > 0
          ? [{ label: "Agents acknowledged", value: directoryBreakdown.total.toLocaleString(), detail: "total seen across every source" }]
          : []),
      ]
    : [];
  // The cursor light is steered by writing px offsets on the spotlight element itself:
  // the movement stays composited, and only that element restyles per pointer move.
  const spotlightRef = useRef<HTMLDivElement | null>(null);
  const steerField = (event: ReactMouseEvent<HTMLDivElement>) => {
    const light = spotlightRef.current;
    if (!light) return;
    const rect = event.currentTarget.getBoundingClientRect();
    light.style.setProperty("--spot-dx", `${event.clientX - rect.left - rect.width / 2}px`);
    light.style.setProperty("--spot-dy", `${event.clientY - rect.top - rect.height / 2}px`);
  };
  const parkFieldLight = () => {
    const light = spotlightRef.current;
    if (!light) return;
    light.style.setProperty("--spot-dx", "0px");
    light.style.setProperty("--spot-dy", "0px");
  };

  return (
          <>
        <section data-owl-avoid="" className="mb-5 pt-24">
          <p className="eyebrow">The full field</p>
          <h1 className="mt-2 text-3xl font-medium tracking-[-.04em] text-[#F2FFF5]">The field, in full</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ns-ink-dim">The capability terrain, the evidence filter, what nobody can measure yet, the settlement rail and the search that finds an agent in the Deep map. The home page keeps the Noosphere, the funnel, the regions and the field reports.</p>
          <Link href="/" className="mt-3 inline-flex min-h-11 items-center font-mono text-xs uppercase tracking-[.12em] text-ns-radar underline underline-offset-4 hover:text-ns-ink">Back to the Noosphere</Link>
        </section>

        <section data-owl-avoid="" className="protocol-ribbon mb-5 overflow-hidden rounded-2xl border border-white/[0.1] bg-[#0A0E11]/75"><div className="protocol-lane font-mono text-xs uppercase tracking-[0.19em] text-[#94A49A]">{[0, 1].map(copy => <div key={copy} className="protocol-set" aria-hidden={copy === 1 ? "true" : undefined}><span>↳ A2A / Agent Cards</span><span>↳ AGNTCY / Distributed directory</span><span>↳ ANP / JSON-LD discovery</span><span>↳ ERC-8004 / Optional identity</span></div>)}</div></section>

        {atlasReady ? <>
        <section data-owl-avoid="" aria-label="What we can prove" className="mb-5 flex flex-col gap-4 rounded-2xl border border-white/[0.1] bg-[#091012]/85 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <p className="eyebrow text-[#BFFF76]">What we can prove</p>
            <p className="mt-1 text-xs text-[#8FA196]">Filter agents by the evidence on record.</p>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter agents by the evidence on record">
            {trustFilters.map(({ value, label, Icon, active }) => (
              <button key={value} type="button" aria-pressed={trustFilter === value} onClick={() => setMainTrustFilter(value)} className={cn("rounded-full border px-3 py-2 font-mono text-xs uppercase tracking-[.12em] transition", trustFilter === value ? active : "border-white/[.13] bg-white/[.03] text-[#8FA196] hover:border-white/[.25]")}>
                <Icon size={12} className="mr-1.5 inline-block" />{label} <strong className="ml-1 text-[#F1FFF3]">{value === "all" ? agents.length : trustPopulation[value]}</strong>
              </button>
            ))}
          </div>
        </section>

        <section data-owl-avoid="" className="observatory-frame relative overflow-hidden rounded-[1.5rem] border border-white/[0.11] bg-[#080B0E]/88 shadow-[0_40px_100px_rgba(0,0,0,.35)]">
          <div className="absolute inset-0 frame-scanlines opacity-45" />
          <div className="relative grid min-h-[760px] grid-cols-[minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_320px]">
            <aside className="relative z-10 border-b border-white/[0.09] bg-[#090D10]/75 p-4 xl:border-b-0 xl:border-r"><div className="flex items-center justify-between xl:block"><p className="eyebrow">Navigation</p><span className="font-mono text-[9px] text-[#74867A]">/ NOO-01</span></div><div className="mt-4 flex gap-2 overflow-x-auto xl:block xl:space-y-1">{(["field", "protocol", "trust"] as Lens[]).map((item, index) => <button key={item} type="button" onClick={() => setLens(item)} className={cn("lens-control shrink-0", lens === item && "lens-control-active")}><span className="font-mono text-[10px] text-[#718176]">0{index + 1}</span><span>{item === "trust" ? "evidence" : item}</span><span className="lens-dot" /></button>)}</div><div className="mt-7 hidden xl:block"><p className="eyebrow">Legend</p><div className="mt-4 space-y-3">{Object.entries(tones).map(([label, color]) => <div key={label} className="flex items-center gap-2 text-xs text-[#94A69A]"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 12px ${color}` }} />{label}</div>)}</div></div>{verifiedIngress && <div className="absolute bottom-4 left-4 right-4 hidden rounded-xl border border-[#BFFF76]/15 bg-[#BFFF76]/[0.035] p-3 xl:block"><div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-[#BFFF76]"><Radio size={13} /> Verified intake</div><p className="mt-2 font-mono text-[10px] leading-4 text-[#D2E9D7]">{verifiedIngress.agent} / {verifiedIngress.protocol}</p><p className="mt-1 text-[9px] leading-4 text-[#809287]">Retained raw observation from an approved source.</p></div>}</aside>

            <div className="relative min-h-[535px] p-4 sm:p-6 xl:min-h-[760px]">
              <div className="mb-4 flex items-start justify-between gap-4"><div><p className="eyebrow text-[#C3A6FF]">{copy.title}</p><h2 className="mt-1 text-2xl font-medium tracking-[-0.05em] text-[#F0FCF2]">{copy.detail}</h2></div><div className="flex items-center gap-2"><button onClick={() => setDeepSpace(true)} type="button" className="map-expand"><Satellite size={13} /> Deep space</button><div className="hidden items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 font-mono text-xs uppercase tracking-[0.12em] text-[#8BA096] sm:flex"><Orbit size={12} className="text-[#BFFF76]" /> {copy.indicator}</div></div></div>
              <div ref={setSceneElement} className="field-scene relative isolate h-[430px] overflow-hidden rounded-2xl border border-white/[0.09] bg-[#05080A] sm:h-[540px]" data-lens={lens} onMouseMove={steerField} onMouseLeave={parkFieldLight}><div className="field-gradient" /><div className="field-vignette" /><div className="field-grid" /><div className="field-beacon field-beacon-a" /><div className="field-beacon field-beacon-b" /><div className="field-beacon field-beacon-c" /><div ref={spotlightRef} className="field-spotlight" /><div className="field-center"><div className="center-ring center-ring-one" /><div className="center-ring center-ring-two" /><div className="center-core"><Network size={24} /></div><span className="center-label">NOOSPHERE<br />INDEX</span></div><svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none"><defs><linearGradient id="flow" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#BFFF76" stopOpacity=".06" /><stop offset=".5" stopColor="#C3A6FF" stopOpacity=".7" /><stop offset="1" stopColor="#66E8FF" stopOpacity=".08" /></linearGradient></defs>{connectionLinesForEntities(fieldTopologyEntities, selected.id).map((line, index, lines) => <line key={`${line.from.id}-${line.to.id}`} x1={line.from.position.x} y1={line.from.position.y} x2={line.to.position.x} y2={line.to.position.y} className={signalLineTone("signal-line", index, lines.length)} stroke="url(#flow)" />)}</svg><FieldDust agents={fieldCrew.dust} />{fieldCrew.featured.map((agent, index) => <AgentNode key={agent.id} agent={agent} active={agent.id === selected.id} index={index} label={labelPlan.get(agent.id) ?? null} onSelect={() => setSelectedId(agent.id)} />)}{fieldTopology.clusters.map(cluster => <FieldClusterNode key={cluster.id} cluster={cluster} onSelect={() => { setSelectedId(cluster.representative.id); setZoom(1.15); setDeepSpace(true); }} />)}{visibleAgents.length === 0 && <div className="absolute inset-0 z-10 grid place-items-center p-6 text-center"><div className="max-w-xs rounded-2xl border border-[#C3A6FF]/30 bg-[#090A11]/85 px-5 py-4 shadow-[0_18px_50px_rgba(0,0,0,.35)]"><Fingerprint size={18} className="mx-auto text-[#C3A6FF]" /><strong className="mt-2 block font-mono text-sm uppercase tracking-[.08em] text-[#EEE8FF]">No matching live signals</strong><p className="mt-2 text-xs leading-5 text-[#A89FBB]">{trustFilter === "owner" ? "No owner-verified agents are on record right now. Agents with no proof yet are not presented as verified." : trustFilter === "website" ? "No website-verified agents are on record right now. Website verification expires, and the agent goes back to no proof yet until a recheck renews it." : "Adjust the search, protocol, or evidence filter to restore the field."}</p><button type="button" onClick={() => { setQuery(""); setFrameworkFilter("All protocols"); setMainTrustFilter("all"); }} className="mt-3 font-mono text-xs uppercase tracking-[.12em] text-[#D6FFC1] hover:text-[#BFFF76]">Reset field</button></div></div>}{showIngress && verifiedIngress && <IngressNode event={verifiedIngress} sceneWidth={sceneSize.width} />}{fieldCrew.dust.length > 0 && <div className="dust-note"><Search size={11} /><span><strong>{fieldCrew.dust.length}</strong> more in the dust · ⌘K to locate</span></div>}</div><div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 font-mono text-xs uppercase tracking-[0.1em]"><span className="flex items-center gap-2 rounded bg-black/30 px-2 py-1 text-[#BFFF76]"><Terminal size={12} /> {`PERSISTED / ${String(liveRecords.length).padStart(2, "0")}`}</span><span className="flex items-center gap-1.5 text-[#8FA196]"><Layers3 size={12} /> {fieldCrew.featured.length} bots · {fieldCrew.dust.length} dust · {fieldTopology.total} indexed{directoryAckTotal > 0 ? ` · ${directoryAckTotal} acknowledged` : ""}</span></div>
              <div className={cn("mt-4 grid gap-3", fieldStats.length === 4 ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3")}>{fieldStats.map((stat, index) => <div key={stat.label} className="micro-stat"><span className="font-mono text-xs uppercase tracking-[.14em] text-[#77897E]">0{index + 1} / {stat.label}</span><strong>{stat.value}</strong><span>{stat.detail}</span></div>)}</div>
            </div>

            <aside className="relative z-10 border-t border-white/[0.09] bg-[#090D10]/85 p-5 xl:border-l xl:border-t-0 xl:p-6"><div className="flex items-start justify-between"><div><p className="eyebrow">Interrogate signal</p><h2 className="mt-2 font-mono text-2xl tracking-[-0.06em] text-[#F1FFF2]">{selected.name}</h2></div><span className="rounded-full border border-[#BFFF76]/30 bg-[#BFFF76]/[0.08] px-2 py-1 font-mono text-[9px] uppercase text-[#BFFF76]">{selected.status}</span></div><p className="mt-4 text-sm leading-6 text-[#A5B6AA]">{selected.summary}</p><div className="mt-5 grid grid-cols-2 gap-2"><SignalCell label="Capability" value={selected.capability} /><SignalCell label="Source" value={selected.framework} /><SignalCell label="Realm" value={selected.chain} /><SignalCell label="Proof" value={selected.proof} mono /></div><EvidenceReadoutBlock agent={selected} /><div className="mt-5"><p className="eyebrow">Operative traits</p><div className="mt-3 flex flex-wrap gap-2">{selected.specialties.map(trait => <span key={trait} className="trait-chip">{trait}</span>)}</div></div><LiveEvidenceFeed evidence={activeEvidence} loading={evidenceQuery.isLoading} asOf={evidenceStaleSince} /><div className="mt-5 rounded-xl border border-[#C3A6FF]/20 bg-[#C3A6FF]/[0.055] p-3.5"><div className="flex items-center gap-2 text-[10px] uppercase tracking-[.14em] text-[#D8C6FF]"><Fingerprint size={13} /> Proof-aware discovery</div><p className="mt-2 text-xs leading-5 text-[#A49DB7]">Nooscape can index a service card now, then attach identity and outcome evidence as those protocols mature.</p></div></aside>
          </div>
        </section>
        </> : <AtlasPlaceholder state={liveRecordsQuery.isLoading ? "loading" : "unavailable"} />}

        <section data-owl-avoid="" className="mt-5" aria-label="What nobody can measure yet">
          <div className="rounded-2xl border border-white/[.1] bg-[#090D10]/80 p-5">
            <div><p className="eyebrow">Known unknowns</p><h2 className="mt-2 text-xl tracking-[-.04em] text-[#F1FFF3]">What nobody can measure yet</h2></div>
            <ul className="mt-4 space-y-3">
              {notYetMeasurable.map(item => (
                <li key={item.title} className="notyet-item"><strong>{item.title}</strong><span>{item.sentence}</span></li>
              ))}
            </ul>
            <p className="mt-4 text-[10px] leading-4 text-[#71857A]">Nooscape would rather show the gap than invent a number for it.</p>
          </div>
        </section>

        {usdgTotals && (
          <section data-owl-avoid="" className="mt-5 grid gap-5 lg:grid-cols-[1.25fr_.75fr]" aria-label="Money moving on Robinhood">
            <div className="rounded-2xl border border-white/[.1] bg-[#090D10]/80 p-5">
              <div className="flex items-start justify-between gap-4">
                <div><p className="eyebrow">Settlement rail</p><h2 className="mt-2 text-xl tracking-[-.04em] text-[#F1FFF3]">Money moving on Robinhood</h2></div>
                <span className="hidden shrink-0 font-mono text-[9px] uppercase tracking-[.14em] text-[#71857A] sm:block">eip-3009 settlements · measured on-chain</span>
              </div>
              <p className="mt-2 max-w-lg text-xs leading-5 text-[#8FA196]">Every USDG <Term k="preauth">pre-authorized transfer</Term> the settlement walk has covered, counted straight off the chain. The <Term k="x402">x402</Term> era of per-request agent payments settles on this rail.</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="micro-stat"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[#77897E]">01 / Settlements</span><strong>{usdgTotals.settlementCount.toLocaleString()}</strong><span>measured across blocks {usdgTotals.firstBlock.toLocaleString()} to {usdgTotals.lastBlock.toLocaleString()}</span></div>
                <div className="micro-stat"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[#77897E]">02 / Typical size</span><strong>{usdgTotals.medianValueRaw ? formatUsdgAmount(usdgTotals.medianValueRaw) : "?"}</strong><span>median settlement</span></div>
                <div className="micro-stat"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-[#77897E]">03 / Micropayments</span><strong>{Math.round((usdgTotals.microPaymentCount / Math.max(usdgTotals.settlementCount, 1)) * 100)}%</strong><span>{usdgTotals.microPaymentCount.toLocaleString()} settled at $0.01 or less</span></div>
              </div>
              <p className="mt-3 max-w-lg rounded-xl border border-white/[.08] bg-black/20 px-3.5 py-3 text-xs leading-5 text-[#8FA196]">
                {usdgTotals.payerCount.toLocaleString()} paying wallet{usdgTotals.payerCount === 1 ? "" : "s"}, {usdgTotals.payeeCount.toLocaleString()} receiving, {usdgTotals.relayerCount.toLocaleString()} relaying. EIP-3009 is older than x402, so occasional large transfers ride the same rail, so the median and the micropayment share, not a grand total, are the honest shape of rail traffic, some of which is agent traffic. The measured window spans roughly {Math.round(((usdgTotals.lastBlock - usdgTotals.firstBlock) * 0.1) / 3600).toLocaleString()} hours at this chain&rsquo;s ≈0.1 s blocks.
              </p>
              <p className="mt-3 text-[10px] leading-4 text-[#71857A]">Rail facts only. Nooscape measures the rail and never claims which settlement is an agent payment.</p>
            </div>
            <div className="rounded-2xl border border-white/[.1] bg-[#090D10]/80 p-5">
              <div><p className="eyebrow">The open attribution question</p><h2 className="mt-2 text-xl tracking-[-.04em] text-[#F1FFF3]">Who is getting paid</h2></div>
              <p className="mt-4 text-xs leading-5 text-[#8FA196]">Not measurable yet. A bounded scan found zero overlap between the wallets settling on this rail and the wallets registering agents in the directory. Until a facilitator&rsquo;s data ties a payment to a registered agent beyond doubt, no per-agent earnings number ships.</p>
              <p className="mt-4 text-[10px] leading-4 text-[#71857A]">The gap is shown, not papered over.</p>
            </div>
          </section>
        )}

        <section data-owl-avoid="" className="mt-5 grid gap-5 lg:grid-cols-[.8fr_1.2fr]"><div className="command-panel rounded-2xl border border-white/[.1] bg-[#090D10]/80 p-5"><div className="flex items-center justify-between"><div><p className="eyebrow">Signal command</p><h2 className="mt-2 text-xl tracking-[-.04em]">Find a mind</h2></div><Search className="text-[#BFFF76]" size={19} /></div><label className="command-input mt-5"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} aria-label="Search the field by capability, protocol, or handle" placeholder="Search capability, protocol, or handle" /><kbd>⌘ K</kbd></label>{locateMatches.length > 0 && <div className="locate-list" role="list" aria-label="Matching agents to locate">{locateMatches.map(agent => <button key={agent.id} type="button" role="listitem" onClick={() => locateAgent(agent.id)} className="locate-row"><span className="suggestion-bot"><AgentBotAvatar agentId={agent.id} tone={tones[agent.capability] ?? "#BFFF76"} /></span><span><strong>{agent.name}</strong><em>{agent.capability} · {agent.framework}{isDomainVerifiedAgent(agent) ? " · domain verified" : ""}</em></span><span className="locate-action">Locate <ChevronRight size={12} /></span></button>)}</div>}<p className="mt-3 text-xs leading-5 text-[#7E9084]">Search filters the field in real time. Locate jumps deep space straight to that bot.</p></div><div className="command-panel rounded-2xl border border-white/[.1] bg-[#090D10]/80 p-5"><div className="flex items-center justify-between"><div><p className="eyebrow">Verified ingress</p><h2 className="mt-2 text-xl tracking-[-.04em]">New signals entering</h2></div><Radio className="text-[#BFFF76]" size={19} /></div><div className="mt-5 grid gap-2 sm:grid-cols-3">{ingressFeed.map((event, index) => <div key={`${event.id}-${index}`} className={cn("ingest-card", index === 0 && "ingest-card-new")}><span className="ingest-orb" style={{ backgroundColor: event.tone, boxShadow: `0 0 14px ${event.tone}` }} /><strong>{event.agent}</strong><em>{event.protocol}</em></div>)}</div><p className="mt-3 text-[10px] leading-5 text-[#7E9084]">{verifiedIngress ? `${liveRecords.length} retained production observation${liveRecords.length === 1 ? "" : "s"} are projected from approved sources; unverified Tier 2 records retain source attribution.` : "No retained observations are visible right now."}</p></div></section>
          </>
  );
}
