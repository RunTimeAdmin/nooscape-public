// Deep Space and its comparison panel. Home loads this file when Deep Space is first opened (pages/Home.tsx).
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { AgentBotAvatar } from "@/components/AgentBotAvatar";
import { EvidenceAsOf, staleSince } from "@/components/home/EvidenceAsOf";
import { Button } from "@/components/ui/button";
import { directoryProtocolDisplay } from "@/lib/directoryProtocols";
import { publisherStateExplanations, tierExplanations, tierFromProof } from "@/lib/evidenceExplain";
import { type PublisherState, evidenceDiffers, evidenceSummary } from "@/lib/evidenceReadout";
import { safeHttpsHref } from "@/lib/safeHref";
import { buildTopologyLayer, connectionLinesForEntities, pickFeaturedAgents } from "@/lib/topology";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ArrowUpRight, BadgeCheck, Check, ChevronRight, Download, FileCheck2, Fingerprint, Layers3, Minus, PanelRightOpen, Plus, Radar, RotateCcw, Satellite, Search, Share2, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import { type AtlasAgent, type ClusterMarker, type DirectoryAckHits, type DirectoryWalletCensus, EVIDENCE_POLL, type EvidenceEnvelope, type IngestionEvent, formatObservedTime, isDomainVerifiedAgent, publisherStateMeta, publisherStates, signalLineTone, tones } from "./atlasModel";
import { EvidenceIntegrity, FieldDust, IngressNode, LiveEvidenceFeed, PublisherBadge, PublisherStateIcon, SignalCell, useEvidenceVerification } from "./atlasParts";

/**
 * Radix gives focus back to a trigger, and these dialogs have none: this gives it back to the control that had it when they opened. The
 * page behind Deep Space is hidden with `visibility`, and the controls on it have a transition, so for a moment after Deep Space closes
 * the control is still hidden and cannot take focus. It is tried on the next frame, and once more after the transition has run.
 */
function giveFocusBackTo(opener: () => Element | null) {
  return (event: Event) => {
    event.preventDefault();
    const target = opener();
    if (!(target instanceof HTMLElement)) return;
    const focus = () => {
      if (target.isConnected && document.activeElement !== target) target.focus();
    };
    window.requestAnimationFrame(() => {
      focus();
      window.setTimeout(focus, 250);
    });
  };
}

export default function DeepSpaceMap({ agents, allAgents, selected, onSelect, onClose, zoom, pan, onZoom, onPan, onReset, ingress, showIngress, evidence, evidenceLoading, evidenceAsOf, frameworks, frameworkFilter, onFrameworkFilter, sortMode, onSortMode, onShare, shareState, agentSearch, onAgentSearch, searchOpen, onSearchOpen, searchRef, suggestions, onLocateAgent, drawerOpen, onCloseDrawer, pinned, onPin, onOpenComparison, compareCount, onDownloadEvidence, directoryTotal, directoryHits, directoryWallets, pinPulseId, comparisonPulse, pinnedIds, spotlight, trustedOnly, onTrustedOnly, publisherStateFilter, onPublisherStateFilter, opener, children }: { children?: ReactNode; opener: { current: Element | null }; agents: AtlasAgent[]; allAgents: AtlasAgent[]; selected: AtlasAgent; onSelect: (id: string) => void; onClose: () => void; zoom: number; pan: { x: number; y: number }; onZoom: (zoom: number) => void; onPan: (pan: { x: number; y: number }) => void; onReset: () => void; ingress: IngestionEvent | null; showIngress: boolean; evidence: EvidenceEnvelope | undefined; evidenceLoading: boolean; evidenceAsOf: number | null; frameworks: string[]; frameworkFilter: string; onFrameworkFilter: (value: string) => void; sortMode: "network" | "evidence" | "name"; onSortMode: (value: "network" | "evidence" | "name") => void; onShare: () => Promise<void>; shareState: "idle" | "copied"; agentSearch: string; onAgentSearch: (value: string) => void; searchOpen: boolean; onSearchOpen: (value: boolean) => void; searchRef: React.RefObject<HTMLInputElement | null>; suggestions: AtlasAgent[]; onLocateAgent: (id: string) => void; drawerOpen: boolean; onCloseDrawer: () => void; pinned: boolean; onPin: () => void; onOpenComparison: () => void; compareCount: number; onDownloadEvidence: (evidence: EvidenceEnvelope, agent: AtlasAgent) => void; directoryTotal: number; directoryHits: DirectoryAckHits | undefined; directoryWallets: DirectoryWalletCensus | undefined; pinPulseId: string | null; comparisonPulse: boolean; pinnedIds: string[]; spotlight: { id: string; nonce: number } | null; trustedOnly: boolean; onTrustedOnly: (value: boolean) => void; publisherStateFilter: PublisherState | "all"; onPublisherStateFilter: (state: PublisherState | "all") => void }) {
  const [drag, setDrag] = useState<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  // Deep space renders the same bounded crew as the main field; everything else
  // is ambient dust that stays reachable through the locate search.
  const crew = useMemo(() => pickFeaturedAgents(agents, selected.id, pinnedIds), [agents, selected.id, pinnedIds]);
  const topologyLayer = useMemo(() => buildTopologyLayer(crew.featured, selected.id, zoom), [crew.featured, selected.id, zoom]);
  const topologyEntities = useMemo(() => [...topologyLayer.direct, ...topologyLayer.clusters], [topologyLayer]);
  const trustedCount = allAgents.filter(agent => agent.publisherValidation.status === "allowlisted").length;
  const publisherStateCounts = Object.fromEntries(publisherStates.map(state => [state, allAgents.filter(agent => agent.publisherValidation.status === state).length])) as Record<PublisherState, number>;
  const clampZoom = (value: number) => Math.max(.62, Math.min(2.25, Number(value.toFixed(2))));
  // Gestures write the world transform directly and commit one state update per
  // gesture. A state update up here re-renders the whole page, so keeping it off
  // the per-event path is what holds dragging and zooming at frame rate.
  const worldRef = useRef<HTMLDivElement | null>(null);
  const livePan = useRef(pan);
  const liveZoom = useRef(zoom);
  const wheelCommit = useRef<number | null>(null);
  useEffect(() => { livePan.current = pan; }, [pan]);
  useEffect(() => { liveZoom.current = zoom; }, [zoom]);
  const applyView = (nextPan: { x: number; y: number }, nextZoom: number) => {
    const node = worldRef.current;
    if (node) node.style.transform = `translate3d(${nextPan.x}px, ${nextPan.y}px, 0) scale(${nextZoom})`;
  };
  const commitZoom = (next: number) => {
    liveZoom.current = next;
    onZoom(next);
  };
  const flushWheel = () => {
    if (wheelCommit.current === null) return;
    window.clearTimeout(wheelCommit.current);
    wheelCommit.current = null;
    commitZoom(liveZoom.current);
  };
  const stepZoom = (delta: number) => commitZoom(clampZoom(liveZoom.current + delta));
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    flushWheel();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ startX: event.clientX, startY: event.clientY, panX: livePan.current.x, panY: livePan.current.y });
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    livePan.current = { x: drag.panX + event.clientX - drag.startX, y: drag.panY + event.clientY - drag.startY };
    applyView(livePan.current, liveZoom.current);
  };
  const endDrag = () => {
    if (!drag) return;
    setDrag(null);
    onPan(livePan.current);
  };
  const wheelZoom = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const next = clampZoom(liveZoom.current + (event.deltaY < 0 ? .12 : -.12));
    liveZoom.current = next;
    applyView(livePan.current, next);
    if (wheelCommit.current !== null) window.clearTimeout(wheelCommit.current);
    wheelCommit.current = window.setTimeout(() => { wheelCommit.current = null; commitZoom(liveZoom.current); }, 120);
  };
  const resetWorld = () => {
    flushWheel();
    onReset();
  };
  const openSearch = () => {
    onSearchOpen(true);
    window.requestAnimationFrame(() => searchRef.current?.focus());
  };
  // This file is fetched the first time Deep Space is opened, so the shortcut that opened it may have asked for the search field
  // before the field existed. Home's own focus call then finds nothing, and the field is focused here once it does.
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, []);

  // Spotlight: fly the world so the located bot sits center stage, then let the
  // node-level CSS burst draw the eye. Runs once per locate action; pan/zoom
  // state stays authoritative through the same commit path the gestures use.
  useEffect(() => {
    if (!spotlight) return;
    const agent = agents.find(candidate => candidate.id === spotlight.id);
    const node = worldRef.current;
    if (!agent || !node) return;
    const width = node.offsetWidth || 1;
    const height = node.offsetHeight || 1;
    const nextZoom = clampZoom(1.3);
    // The world transform scales about its center, so centering a world point
    // X at viewport center C needs pan = zoom · (C − X).
    const nextPan = {
      x: (width / 2 - (agent.position.x / 100) * width) * nextZoom,
      y: (height / 2 - (agent.position.y / 100) * height) * nextZoom,
    };
    livePan.current = nextPan;
    liveZoom.current = nextZoom;
    applyView(nextPan, nextZoom);
    onPan(nextPan);
    commitZoom(nextZoom);
  }, [spotlight]);

  // A dialog of the page's own look: Radix keeps focus inside it, moves it in on open and gives it back on close, and hides the page from
  // assistive technology. Escape closes the search first (the page's own handler does that) and the map when nothing else is open.
  return (
    <DialogPrimitive.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPrimitive.Content className={cn("deep-space-overlay", comparisonPulse && "deep-space-compare-enter", trustedOnly && "deep-space-trusted-only")} aria-label="Nooscape deep space map" aria-labelledby={undefined} aria-describedby={undefined} onEscapeKeyDown={event => { if (searchOpen) event.preventDefault(); }} onCloseAutoFocus={giveFocusBackTo(() => opener.current)}>
      <div className="deep-stars" />
      <header className="deep-header">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-full border border-[#BFFF76]/45 bg-[#BFFF76]/[.07] text-[#BFFF76]"><Satellite size={17} /></span>
          <div><p className="font-mono text-[10px] uppercase tracking-[.2em] text-[#BFFF76]">Nooscape / Deep space</p><DialogPrimitive.Title asChild><h2 className="text-sm font-medium text-[#EDF9EF]">Semantic agent field</h2></DialogPrimitive.Title></div>
        </div>
        <div className="deep-header-actions">
          <span className="hidden font-mono text-[9px] uppercase tracking-[.14em] text-[#829589] xl:inline">Drag to pan · wheel to zoom</span>
          <button type="button" onClick={openSearch} className="deep-search-trigger"><Search size={14} /><span>Locate agent</span><kbd>⌘ K</kbd></button>
          <Button onClick={onShare} className="h-9 rounded-full border border-[#BFFF76]/30 bg-[#BFFF76]/[.08] px-3 text-[10px] uppercase tracking-[.12em] text-[#D8FFCA] hover:bg-[#BFFF76] hover:text-[#071006]">{shareState === "copied" ? <Check size={14} /> : <Share2 size={14} />}{shareState === "copied" ? "Copied" : "Share agent"}</Button>
          <Button onClick={onClose} className="h-9 rounded-full border border-white/[.13] bg-white/[.04] px-3 text-[10px] uppercase tracking-[.12em] text-[#D8E9DD] hover:bg-white/[.1]"><X size={14} /> Close</Button>
        </div>
      </header>
      <div className="deep-body">
        <div className="deep-map-shell">
          <div className="deep-discovery-panel">
            <div className="deep-panel-title"><span><SlidersHorizontal size={13} /> Map filter</span><em>{agents.length} visible · {crew.featured.length} featured · {directoryTotal} acknowledged</em></div>
            <label className="deep-select-label">Framework<select value={frameworkFilter} onChange={event => onFrameworkFilter(event.target.value)}>{frameworks.map(framework => <option key={framework} value={framework}>{framework}</option>)}</select></label>
            <div className="deep-sort-row"><span>Sort by</span><div>{(["network", "evidence", "name"] as const).map(mode => <button key={mode} type="button" onClick={() => onSortMode(mode)} className={cn(sortMode === mode && "deep-sort-active")}>{mode}</button>)}</div></div><button type="button" role="switch" aria-checked={trustedOnly} onClick={() => onTrustedOnly(!trustedOnly)} className={cn("trusted-only-toggle", trustedOnly && "trusted-only-toggle-active")}><BadgeCheck size={13} /><span>Trusted only</span><i /></button><section className="publisher-state-legend" aria-label="Publisher key state legend"><div className="publisher-legend-heading"><span>Publisher key states</span><button type="button" onClick={() => onPublisherStateFilter("all")} className={cn("publisher-legend-all", publisherStateFilter === "all" && "publisher-legend-all-active")}>All {allAgents.length}</button></div><div className="publisher-legend-items">{publisherStates.map(state => <button key={state} type="button" onClick={() => onPublisherStateFilter(state)} className={cn("publisher-legend-item", `publisher-state-${state}`, publisherStateFilter === state && "publisher-legend-item-active")}><PublisherStateIcon state={state} size={12} /><span><strong>{publisherStateMeta[state].label}</strong><em>{publisherStateMeta[state].detail}</em></span><b>{publisherStateCounts[state]}</b></button>)}</div></section><div className="allowlist-map-note"><BadgeCheck size={13} /><span>Publisher-key allowlist</span><em>{trustedCount} trusted</em></div>
            {directoryWallets && directoryWallets.wallets.length > 0 && <section className="wallet-census-panel" aria-label="Wallet concentration"><div className="wallet-census-heading"><span>Wallets recorded against many identities</span><em>top {directoryWallets.wallets.length}</em></div><ol className="wallet-census-list">{directoryWallets.wallets.map(wallet => <li key={wallet.registrant}><span className="wallet-census-wallet"><code>{wallet.registrant}</code>{wallet.dominantHost && <em className="wallet-census-host">mostly {wallet.dominantHost}</em>}</span><b>{wallet.agentCount}</b></li>)}</ol><p className="wallet-census-note">Wallets a registry records against the most identities. For ERC-8004 this is the wallet that paid the registration, decoded from the registration event. For the Solana registries it is the current owner or authority read from the on-chain account. None is a verified operator, and most ERC-8004 identities were handed out to other wallets soon after minting, so this is who minted, not who holds or runs them.</p></section>}
          </div>
          <div className={cn("deep-agent-search", searchOpen && "deep-agent-search-open")}>
            <label className="deep-agent-search-input"><Search size={15} /><input ref={searchRef} data-owl-search="" aria-label="Locate an agent by name, domain, mint, or capability" value={agentSearch} onFocus={() => onSearchOpen(true)} onChange={event => onAgentSearch(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && suggestions[0]) onLocateAgent(suggestions[0].id); }} placeholder="Locate a name, domain, mint, or capability" /><kbd>ESC</kbd></label>
            {searchOpen && <div className="agent-suggestion-list" role="listbox" aria-label="Agent suggestions">{suggestions.length > 0 ? suggestions.map((agent, index) => <button key={agent.id} type="button" role="option" aria-selected={agent.id === selected.id} onClick={() => onLocateAgent(agent.id)} className="agent-suggestion"><span className="suggestion-bot"><AgentBotAvatar agentId={agent.id} tone={tones[agent.capability] ?? "#BFFF76"} /></span><span><strong>{agent.name}</strong><em>{agent.capability} · {agent.framework}{isDomainVerifiedAgent(agent) ? " · domain verified" : ""}</em></span><span className="suggestion-rank">0{index + 1}</span><ChevronRight size={14} /></button>) : <div className="agent-search-empty">{directoryHits && directoryHits.entries.length > 0 ? "No reviewed signal matches; directory acknowledgements follow." : "No agent signal matches that query."}</div>}</div>}
            {searchOpen && directoryHits?.busy && <div className="agent-search-empty">Directory search is busy right now. Try again in a moment.</div>}
            {searchOpen && directoryHits && directoryHits.entries.length > 0 && <div className="directory-ack-list" role="list" aria-label="Directory acknowledgements"><div className="directory-ack-heading"><Radar size={12} /><span>Directory ack · {directoryHits.matchedTotal} unreviewed match{directoryHits.matchedTotal === 1 ? "" : "es"}</span></div>{directoryHits.entries.map(entry => <a key={entry.id} role="listitem" href={`/agents/${entry.id}`} className="directory-ack-row"><strong>{entry.displayName}</strong><em>{entry.locatorHost ?? "no locator"} · {directoryProtocolDisplay(entry.protocol)}</em>{entry.related && entry.related.sameWallet + entry.related.sameName > 0 && <span className="directory-ack-fold">{[entry.related.sameWallet > 0 ? `+${entry.related.sameWallet.toLocaleString()} same wallet` : "", entry.related.sameName > 0 ? `+${entry.related.sameName.toLocaleString()} same name` : ""].filter(Boolean).join(" · ")}</span>}</a>)}<div className="directory-ack-note">Acknowledged, not reviewed · fold counts are locator facts · no trust or map placement · select an entry for its page</div></div>}
          </div>
          <div className="deep-viewport" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onWheel={wheelZoom}>
            <div ref={worldRef} className="deep-world" style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}>
              <div className="deep-galaxy deep-galaxy-a" /><div className="deep-galaxy deep-galaxy-b" /><div className="deep-graticule" /><div className="deep-core"><div /><span>NOOSPHERE</span></div>
              <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none"><defs><linearGradient id="deepFlow" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#66E8FF" stopOpacity=".05" /><stop offset=".5" stopColor="#C3A6FF" stopOpacity=".85" /><stop offset="1" stopColor="#BFFF76" stopOpacity=".08" /></linearGradient></defs>{connectionLinesForEntities(topologyEntities, selected.id).map((line, index, lines) => <line key={`${line.from.id}-${line.to.id}`} x1={line.from.position.x} y1={line.from.position.y} x2={line.to.position.x} y2={line.to.position.y} className={signalLineTone("deep-signal-line", index, lines.length)} stroke="url(#deepFlow)" />)}</svg>
              <FieldDust agents={crew.dust} />
              {crew.featured.map((agent, index) => <DeepAgentNode key={spotlight && spotlight.id === agent.id ? `${agent.id}-${spotlight.nonce}` : agent.id} agent={agent} active={agent.id === selected.id} spotlighted={Boolean(spotlight && spotlight.id === agent.id)} pulsing={agent.id === pinPulseId} index={index} onSelect={() => onLocateAgent(agent.id)} />)}
              {topologyLayer.clusters.map(cluster => <DeepClusterNode key={cluster.id} cluster={cluster} onSelect={() => { onSelect(cluster.representative.id); commitZoom(clampZoom(Math.max(liveZoom.current, 1.15))); }} />)}
              {agents.length === 0 && <div className="deep-empty-field"><Search size={18} /><strong>No visible signals</strong><span>Change the protocol filter to restore the field.</span></div>}
              {crew.dust.length > 0 && <div className="dust-note"><Search size={11} /><span><strong>{crew.dust.length}</strong> more in the dust · search to locate</span></div>}
              {showIngress && ingress && <IngressNode event={ingress} deep />}
            </div>
            <div className="deep-scan-label"><Layers3 size={12} /> {crew.featured.length} CREW · {crew.dust.length} DUST · {agents.some(agent => agent.status === "OBSERVED") ? "VERIFIED OBSERVATION" : "ANIMATED SIMULATION"}</div>
          </div>
          <div className="deep-map-controls"><button type="button" onClick={() => stepZoom(.15)} aria-label="Zoom in"><Plus size={17} /></button><button type="button" onClick={() => stepZoom(-.15)} aria-label="Zoom out"><Minus size={17} /></button><button type="button" onClick={resetWorld} aria-label="Reset map view"><RotateCcw size={15} /></button><span>{Math.round(zoom * 100)}%</span></div>
        </div>
        <aside className="deep-inspector">
          <div className="flex items-start justify-between"><div><p className="eyebrow">Active signal</p><h3 className="mt-2 font-mono text-2xl tracking-[-.06em] text-white">{selected.name}</h3></div><span className="rounded-full border border-[#BFFF76]/30 bg-[#BFFF76]/[.08] px-2 py-1 font-mono text-[9px] text-[#BFFF76]">{selected.status.toUpperCase()}</span></div>
          <p className="eyebrow mt-4">Source-reported · untrusted</p>
          <p className="mt-2 text-sm leading-6 text-[#A4B7AA]">{selected.summary}</p>
          <div className="mt-3"><PublisherBadge validation={selected.publisherValidation} /></div>
          <div className="mt-5 grid grid-cols-2 gap-2"><SignalCell label="Capability" value={selected.capability} /><SignalCell label="Source" value={selected.framework} /><SignalCell label="Realm" value={selected.chain} /><SignalCell label="Evidence" value={evidenceSummary(selected)} mono /></div>
          <LiveEvidenceFeed evidence={evidence} loading={evidenceLoading} asOf={evidenceAsOf} />
          <div className="inspector-action-row"><button type="button" onClick={() => onLocateAgent(selected.id)} className="open-record-button"><PanelRightOpen size={14} /> Open signal record <ChevronRight size={14} /></button><button type="button" onClick={onPin} className={cn("compare-pin-button", pinned && "compare-pin-active")}>{pinned ? <Check size={14} /> : <Plus size={14} />}{pinned ? "Pinned" : "Pin to compare"}<span>{compareCount}/2</span></button></div>
          <div className="mt-5 rounded-xl border border-[#66E8FF]/18 bg-[#66E8FF]/[.04] p-3 font-mono text-[10px] leading-5 text-[#9BEAF3]">Click a node to inspect its full activity record, evidence references, and live statistics.</div>
        </aside>
      </div>
      {drawerOpen && <AgentActivityDrawer agent={selected} evidence={evidence} loading={evidenceLoading} asOf={evidenceAsOf} pinned={pinned} onPin={onPin} onOpenComparison={onOpenComparison} compareCount={compareCount} onDownloadEvidence={onDownloadEvidence} onClose={onCloseDrawer} />}
      {children}
    </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
}

function AgentActivityDrawer({ agent, evidence, loading, asOf, pinned, onPin, onOpenComparison, compareCount, onDownloadEvidence, onClose }: { agent: AtlasAgent; evidence: EvidenceEnvelope | undefined; loading: boolean; asOf: number | null; pinned: boolean; onPin: () => void; onOpenComparison: () => void; compareCount: number; onDownloadEvidence: (evidence: EvidenceEnvelope, agent: AtlasAgent) => void; onClose: () => void }) {
  const observedInteractions = (evidence?.entries.length ?? 0) * 4 + agent.specialties.length;
  const verification = useEvidenceVerification(evidence);
  // Plain sentences for every label shown above: the tier and the publisher state.
  const tierKey = tierFromProof(agent.proof);
  const tierExplanation = tierKey ? tierExplanations[tierKey] : undefined;
  const publisherSentence = publisherStateExplanations[agent.publisherValidation.status] ?? publisherStateExplanations.unverified;
  // Where focus was when this opened, so it can go back there when it closes.
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement));

  // The drawer sits beside the map and does not block it: clicking another node updates the record, so a click outside does not close it.
  // Focus moves into it when it opens, Escape closes it, and focus goes back to what opened it.
  return <DialogPrimitive.Root open modal={false} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogPrimitive.Content asChild aria-labelledby={undefined} aria-describedby={undefined} onInteractOutside={event => event.preventDefault()} onCloseAutoFocus={giveFocusBackTo(() => opener)}>
  <aside className="agent-activity-drawer" aria-label={`${agent.name} signal record`}>
    <div className="drawer-accent" style={{ background: tones[agent.capability] ?? "#BFFF76" }} />
    <header className="drawer-header"><div><p className="eyebrow">Signal record / verified view</p><DialogPrimitive.Title asChild><h2>{agent.name}</h2></DialogPrimitive.Title><span>@{agent.handle}</span></div><button type="button" onClick={onClose} className="drawer-close" aria-label="Close agent record"><X size={17} /></button></header>
    <div className="drawer-summary"><span className="drawer-capability" style={{ color: tones[agent.capability] ?? "#BFFF76" }}>{agent.capability}</span><span className="eyebrow" style={{ display: "block", marginTop: ".35rem" }}>Source-reported · untrusted</span><p>{agent.summary}</p></div>
    <div className="mt-3"><PublisherBadge validation={agent.publisherValidation} /></div>
    <section className="drawer-stat-grid"><DrawerStat label="Evidence" value={evidenceSummary(agent)} suffix={agent.publisherValidation.status} /><DrawerStat label="Observed links" value={`${observedInteractions}`} suffix="edges" /><DrawerStat label="Evidence entries" value={`${evidence?.entries.length ?? 0}`} suffix="live" /><DrawerStat label="Protocol" value={agent.framework.replace(" ", "\n")} compact /></section>
    <section className="drawer-proof"><div><Fingerprint size={15} /><span>Proof reference</span></div><strong>{agent.proof}</strong><p>Identity source: {agent.framework} · realm: {agent.chain}</p></section>
    {tierExplanation && <section className="drawer-proof"><div><ShieldCheck size={15} /><span>What these labels mean</span></div><p><strong>{tierExplanation.label}.</strong> {tierExplanation.sentence}</p><p><strong>Publisher state: {agent.publisherValidation.status}.</strong> {publisherSentence}</p></section>}
    {evidence?.provenance && <PersistedEvidenceProvenance provenance={evidence.provenance} relayKeyId={evidence.relayKeyId} />}
    <section className="drawer-log-section"><div className="drawer-section-title"><span><FileCheck2 size={14} /> Live evidence relay</span><em>{verification === "verified" ? "hash confirmed" : verification === "checking" ? "checking" : "relay pending"}</em></div>{loading && <div className="evidence-loading">Refreshing signed relay envelope…</div>}<EvidenceAsOf at={asOf} />{evidence?.entries.map(log => <article key={log.id} className="drawer-log"><span className="drawer-log-dot" style={{ backgroundColor: tones[agent.capability] ?? "#BFFF76", boxShadow: `0 0 12px ${tones[agent.capability] ?? "#BFFF76"}` }} /><div><span>{formatObservedTime(log.observedAt)} · {log.event}</span><p>{log.detail}</p><code>{log.proofReference}</code><em>{log.source}</em></div><Check size={14} /></article>)}{evidence && <EvidenceIntegrity evidence={evidence} verification={verification} />}</section>
    <button type="button" disabled={!evidence} onClick={() => evidence && onDownloadEvidence(evidence, agent)} className="drawer-download-evidence"><Download size={14} /> Export signed JSON <span>{evidence?.signatureAlgorithm ?? "loading"}</span></button>
    <div className="drawer-compare-actions">{agent.status === "OBSERVED" && <a href={`/agents/${agent.id}`} className="drawer-compare-open">Agent page <ArrowUpRight size={14} /></a>}<button type="button" onClick={onPin} className={cn("drawer-pin", pinned && "drawer-pin-active")}>{pinned ? <Check size={14} /> : <Plus size={14} />}{pinned ? "Pinned for comparison" : "Pin this agent"}</button><button type="button" onClick={onOpenComparison} className="drawer-compare-open">Compare <span>{compareCount}/2</span><ChevronRight size={14} /></button></div>
    <footer className="drawer-footer">Exported JSON includes the signed canonical payload, Ed25519 public key, signature, and SHA-256 digest for independent review. Connector availability remains protocol-dependent.</footer>
  </aside>
    </DialogPrimitive.Content>
  </DialogPrimitive.Root>;
}

function PersistedEvidenceProvenance({ provenance, relayKeyId }: { provenance: NonNullable<EvidenceEnvelope["provenance"]>; relayKeyId?: string }) {
  const observedHref = safeHttpsHref(provenance.canonicalLocator);
  return <section className="persisted-provenance">
    <header><span><Fingerprint size={14} /> Persisted provenance</span><em>raw bytes private</em></header>
    <p>Signed envelope references an immutable observation without exposing the evidence object or storage credentials.</p>
    <dl>
      <div><dt>Digest</dt><dd><code>{provenance.contentHash}</code></dd></div>
      <div><dt>Retention</dt><dd>{provenance.retentionPolicy}</dd></div>
      <div><dt>Validation</dt><dd className="provenance-valid"><Check size={11} /> {provenance.validationStatus}</dd></div>
      <div><dt>Relay key</dt><dd><code>{relayKeyId ?? "legacy relay"}</code></dd></div>
    </dl>
    {observedHref && <a href={observedHref} target="_blank" rel="noopener noreferrer nofollow">Open observed document <ArrowUpRight size={12} /></a>}
  </section>;
}

export function AgentComparisonPanel({ agents, onRemove, onClose, onSelect, onShare, shareState, comparisonPulse }: { agents: AtlasAgent[]; onRemove: (id: string) => void; onClose: () => void; onSelect: (id: string) => void; onShare: () => Promise<void>; shareState: "idle" | "copied"; comparisonPulse: boolean }) {
  const [left, right] = agents;
  const differenceCount = left && right ? [evidenceDiffers(left, right), left.capability !== right.capability, left.framework !== right.framework, left.chain !== right.chain].filter(Boolean).length : 0;
  return <section className={cn("agent-comparison-panel", comparisonPulse && "comparison-panel-pulse")} aria-label="Pinned agent comparison"><header><div><p className="eyebrow">Pinned signal comparison</p><h2>Side-by-side analysis</h2>{left && right && <span className="comparison-diff-summary"><i /> {differenceCount} signal differences highlighted</span>}</div><div className="comparison-header-actions"><button type="button" disabled={agents.length !== 2} onClick={onShare} className="comparison-share">{shareState === "copied" ? <Check size={13} /> : <Share2 size={13} />}{shareState === "copied" ? "Copied" : "Share"}</button><button type="button" onClick={onClose} aria-label="Close comparison"><X size={16} /></button></div></header><div className="comparison-grid">{agents.map(agent => <ComparisonCard key={agent.id} agent={agent} counterpart={agents.find(candidate => candidate.id !== agent.id)} onRemove={() => onRemove(agent.id)} onSelect={() => onSelect(agent.id)} />)}{agents.length < 2 && <div className="comparison-empty"><Plus size={18} /><strong>Pin one more agent</strong><span>Select a node, then choose “Pin to compare” to populate the second column.</span></div>}</div></section>;
}

function ComparisonCard({ agent, counterpart, onRemove, onSelect }: { agent: AtlasAgent; counterpart?: AtlasAgent; onRemove: () => void; onSelect: () => void }) {
  const evidenceRead = trpc.atlas.evidence.useQuery({ agentId: agent.id }, EVIDENCE_POLL);
  const evidence: EvidenceEnvelope | undefined = evidenceRead.data;
  const evidenceDiff = Boolean(counterpart && evidenceDiffers(agent, counterpart));
  const capabilityDiff = Boolean(counterpart && agent.capability !== counterpart.capability);
  const frameworkDiff = Boolean(counterpart && agent.framework !== counterpart.framework);
  const realmDiff = Boolean(counterpart && agent.chain !== counterpart.chain);
  return <article className="comparison-card"><div className="comparison-card-top"><span className="comparison-color" style={{ backgroundColor: tones[agent.capability] ?? "#BFFF76" }} /><div><strong>{agent.name}</strong><em>{agent.capability} · {agent.framework}</em></div><button type="button" onClick={onRemove} aria-label={`Remove ${agent.name} from comparison`}><X size={13} /></button></div><div className="comparison-metrics"><span className={cn(evidenceDiff && "comparison-metric-diff")}><em>Evidence</em><strong>{evidenceSummary(agent)}</strong>{evidenceDiff && <b>different</b>}</span><span className={cn(realmDiff && "comparison-metric-diff")}><em>Realm</em><strong>{agent.chain}</strong>{realmDiff && <b>different</b>}</span><span className={cn(capabilityDiff && "comparison-metric-diff")}><em>Capability</em><strong>{agent.capability}</strong>{capabilityDiff && <b>different</b>}</span><span className={cn(frameworkDiff && "comparison-metric-diff")}><em>Protocol</em><strong>{agent.framework}</strong>{frameworkDiff && <b>different</b>}</span><span><em>Evidence</em><strong>{evidence?.entries.length ?? "n/a"}</strong></span><span><em>Relay seq</em><strong>{evidence?.sequence ?? "n/a"}</strong></span></div><div className="comparison-capabilities">{agent.specialties.map(specialty => <span key={specialty} className={cn(counterpart && !counterpart.specialties.includes(specialty) && "comparison-capability-diff")}>{specialty}</span>)}</div><div className="comparison-hash"><Fingerprint size={12} /><code>{evidence?.integrityHash.slice(0, 16) ?? "Awaiting relay"}…</code></div><EvidenceAsOf at={staleSince(evidenceRead)} /><button type="button" onClick={onSelect} className="comparison-focus">Focus node <ChevronRight size={13} /></button></article>;
}

function DrawerStat({ label, value, suffix = "", compact = false }: { label: string; value: string; suffix?: string; compact?: boolean }) {
  return <div className={cn("drawer-stat", compact && "drawer-stat-compact")}><span>{label}</span><strong>{value}</strong>{suffix && <em>{suffix}</em>}</div>;
}

function DeepAgentNode({ agent, active, spotlighted, pulsing, index, onSelect }: { agent: AtlasAgent; active: boolean; spotlighted: boolean; pulsing: boolean; index: number; onSelect: () => void }) {
  const tone = tones[agent.capability] ?? "#BFFF76";
  const publisherState = agent.publisherValidation.status;
  const annotated = publisherState !== "unverified";
  return <button type="button" onPointerDown={event => event.stopPropagation()} onClick={onSelect} className={cn("deep-agent-node", active && "deep-agent-node-active", spotlighted && "deep-agent-node-spotlight", pulsing && "deep-agent-node-pinning", `deep-agent-node-publisher-${publisherState}`)} style={{ left: `${agent.position.x}%`, top: `${agent.position.y}%`, "--tone": tone, "--delay": `${index * .3}s` } as CSSProperties}><span className="deep-node-orbit" /><span className="deep-node-bot"><AgentBotAvatar agentId={agent.id} tone={tone} /></span>{annotated && <span className={cn("deep-publisher-badge", `publisher-state-${publisherState}`)} title={`${publisherStateMeta[publisherState].label}: ${agent.publisherValidation.publisherName}`}><PublisherStateIcon state={publisherState} size={11} /><em>{publisherStateMeta[publisherState].label}</em></span>}<span className="deep-node-label"><strong>{agent.name}</strong><em>{agent.capability}</em></span></button>;
}

function DeepClusterNode({ cluster, onSelect }: { cluster: ClusterMarker; onSelect: () => void }) {
  const tone = tones[cluster.capability] ?? "#C3A6FF";
  return <button type="button" onPointerDown={event => event.stopPropagation()} onClick={onSelect} className="deep-topology-cluster" aria-label={`Zoom into ${cluster.count} agent cluster`} style={{ left: `${cluster.position.x}%`, top: `${cluster.position.y}%`, "--tone": tone } as CSSProperties}><span><Layers3 size={14} /></span><strong>{cluster.count}</strong><em>{cluster.capability}</em></button>;
}
