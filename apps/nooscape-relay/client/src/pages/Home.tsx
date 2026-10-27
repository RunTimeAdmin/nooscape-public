import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { HeroScene } from "@/components/home/HeroScene";
import { JustArrived } from "@/components/home/JustArrived";
import { SiteHeader } from "@/components/home/SiteHeader";
import { statusLines } from "@/components/home/headerModel";
import { staleSince } from "@/components/home/EvidenceAsOf";
import { cn } from "@/lib/utils";
import { setPageCovered } from "@/lib/pageCover";
import { trpc } from "@/lib/trpc";
import { featureOn } from "@shared/features";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { buildProtocolPopulation, extraChainTotals, listingRulesSentence, reviewedProtocolCounts, splitDirectoryTotals } from "@/lib/directoryProtocols";
import { evidenceGroup, evidenceRank, type PublisherState } from "@/lib/evidenceReadout";
import { recordsWithIsoDates } from "./home/liveRecords";
import { type AtlasAgent, type BnbRegistryProfile, type DirectoryBreakdown, type DirectoryFunnel, type DirectoryUsdgSettlements, type DirectoryWalletCensus, EVIDENCE_POLL, type EvidenceEnvelope, type IngestionEvent, type LiveAtlasCoverage, type LiveAtlasRecord, type TrustFilter, ingressMatchesFramework, mapLiveRecord, positionForLiveAgent, protocolsForLiveAgent } from "./home/atlasModel";

// The scan map loads after the first paint, so the Atlas below it does not wait on it.
const LandingHero = lazy(() => import("./home/LandingHero"));
const LandingEvidence = lazy(() => import("./home/LandingEvidence"));
// The full field page is fetched when /field is opened.
const FieldView = lazy(() => import("./home/FieldView"));
// Deep Space and its comparison panel are fetched the first time Deep Space is opened.
const DeepSpaceMap = lazy(() => import("./home/DeepSpace"));
const AgentComparisonPanel = lazy(() => import("./home/DeepSpace").then(module => ({ default: module.AgentComparisonPanel })));

/** One polling cadence for every live Atlas read on this page (was repeated inline six times). */
const LIVE_POLL = { refetchInterval: 20_000, refetchOnWindowFocus: true } as const;
const NO_RECORDS: LiveAtlasRecord[] = [];
/** `home` is the page; `field` is the older, longer view of the field (the capability terrain, the evidence filter, what nobody can measure yet, the settlement rail and the search), kept at /field. */
export default function Home({ view = "home" }: { view?: "home" | "field" }) {
  // The records come with their dates as text, so a poll that brings nothing new hands the page the same objects (pages/home/liveRecords.ts).
  const liveRecordsQuery = trpc.liveData.publicRecords.useQuery(undefined, { ...LIVE_POLL, select: recordsWithIsoDates });
  const liveCoverageQuery = trpc.liveData.publicCoverage.useQuery(undefined, LIVE_POLL);
  // The largest groups of BNB Chain registrations that share one fact, drawn as one large circle each with its count. Read in the same batch as the records and waited for, so the page below does not move when they arrive; not retried, so a failed read leaves the map as it was. No single BNB Chain registration is read for the map.
  const mapFleetsQuery = trpc.liveData.mapFleets.useQuery(undefined, { enabled: view === "home", retry: false, staleTime: 10 * 60_000, refetchOnWindowFocus: false });
  // The groups of Arc registrations, drawn as domes beside the others while Arc's switch is on in this build. Not waited for and not retried: a failed or empty read leaves the map as it was, and the domes are placed after everything else, so they move nothing when they arrive.
  const arcFleetsQuery = trpc.liveData.registryFleets.useQuery({ chain: "arc" }, { enabled: view === "home" && featureOn("chain_arc", import.meta.env.VITE_FEATURES), retry: false, staleTime: 10 * 60_000, refetchOnWindowFocus: false });
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [linkedAgentId, setLinkedAgentId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [deepSpace, setDeepSpace] = useState(false);
  const [frameworkFilter, setFrameworkFilter] = useState("All protocols");
  const [trustFilter, setTrustFilter] = useState<TrustFilter>("all");
  const [trustedOnly, setTrustedOnly] = useState(false);
  const [publisherStateFilter, setPublisherStateFilter] = useState<PublisherState | "all">("all");
  const [sortMode, setSortMode] = useState<"network" | "evidence" | "name">("network");
  const [shareState, setShareState] = useState<"idle" | "copied">("idle");
  const [agentSearch, setAgentSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [comparisonShareState, setComparisonShareState] = useState<"idle" | "copied">("idle");
  const [pinPulseId, setPinPulseId] = useState<string | null>(null);
  const [comparisonPulse, setComparisonPulse] = useState(false);
  const [spotlight, setSpotlight] = useState<{ id: string; nonce: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const agentSearchRef = useRef<HTMLInputElement>(null);

  const liveRecords: LiveAtlasRecord[] = liveRecordsQuery.data?.records ?? NO_RECORDS;
  const liveCoverage: LiveAtlasCoverage | undefined = liveCoverageQuery.data;
  // One read carries both the acknowledged total and its protocol split.
  const directoryBreakdownQuery = trpc.liveData.directoryBreakdown.useQuery(undefined, LIVE_POLL);
  // Directory acks echo the ⌘K query; the endpoint enforces the two-char minimum.
  // A search costs the server a second or more, so it waits for the typing to pause instead of sending one per keystroke.
  const settledSearch = useDebouncedValue(agentSearch.trim(), 350);
  const directorySearchQuery = trpc.liveData.directorySearch.useQuery({ query: settledSearch }, { enabled: settledSearch.length >= 2 });
  // Wallet concentration over acks that record a wallet, ranked by how many
  // identities each wallet is recorded against. Locator-class chain facts; the
  // endpoint fails closed to empty.
  const directoryWalletQuery = trpc.liveData.directoryWalletCensus.useQuery(undefined, LIVE_POLL);
  const directoryBscQuery = trpc.liveData.directoryBscRegistry.useQuery(undefined, LIVE_POLL);
  // The acknowledged-to-proven funnel for the main observatory page. Steps
  // that cannot be counted yet arrive as null; the endpoint fails closed to
  // an empty step list.
  const directoryFunnelQuery = trpc.liveData.directoryFunnel.useQuery(undefined, LIVE_POLL);
  // Rail-level USDG settlement totals for the money panel. Rail facts only;
  // the endpoint fails closed to null totals while the settlement source is
  // unmeasured or its migration is pending.
  const directoryUsdgQuery = trpc.liveData.directoryUsdgSettlements.useQuery(undefined, LIVE_POLL);
  const directoryBreakdown: DirectoryBreakdown | undefined = directoryBreakdownQuery.data;
  const directoryAckTotal = directoryBreakdown?.total ?? 0;
  // Registry-backed identities (ERC-8004 on Robinhood Chain, Solana registry,
  // 8004 Solana registry, SAID Solana registry) are chain facts; every other protocol row is a
  // locator listing seen on a directory or card endpoint. The headline leads
  // with the registry count so 213k catalog rows can't masquerade as 213k
  // agents.
  // The BNB Chain registrations in the directory are the few thousand the listing rules publish out of the
  // 373k on-chain. They are chain facts too, but they are counted on their own, beside the registry profile
  // below, and never as locator listings.
  const directorySplit = splitDirectoryTotals(directoryBreakdown?.byProtocol ?? [], directoryAckTotal);
  const directoryOnChainTotal = directorySplit.onChain;
  const bnbRegistry: BnbRegistryProfile | null = directoryBscQuery.data?.profile ?? null;
  const directoryWalletCensus: DirectoryWalletCensus | undefined = directoryWalletQuery.data;
  const directoryFunnel: DirectoryFunnel | undefined = directoryFunnelQuery.data;
  const usdgTotals: DirectoryUsdgSettlements | null = directoryUsdgQuery.data?.totals ?? null;
  const funnelSteps = directoryFunnel?.steps ?? [];
  // The activity walk's high-water block: every activity count on this page is
  // measured "as of" it. Null while the ledger is empty or unmeasured — the
  // labels fall back to a plain "no estimates" rather than inventing a block.
  const activityThroughBlock = directoryFunnel?.activityTotals?.measuredThroughBlock ?? null;
  const liveAgents = useMemo(() => liveRecords.map(mapLiveRecord), [liveRecords]);
  const agents = liveAgents;
  const frameworks = useMemo(() => ["All protocols", ...Array.from(new Set(agents.map(agent => agent.framework)))], [agents]);
  // Every protocol Nooscape reads: what the directory acknowledges under it, with how many of its records are reviewed
  // beside it. The reviewed counts take one protocol per record, so they add up to the reviewed total.
  const reviewedByProtocol = useMemo(() => reviewedProtocolCounts(liveRecords.map(record => protocolsForLiveAgent(record.protocols))), [liveRecords]);
  const populationRows = useMemo(() => buildProtocolPopulation(directoryBreakdown?.byProtocol ?? [], reviewedByProtocol), [directoryBreakdown, reviewedByProtocol]);
  const reviewedTotal = liveCoverage?.publicRecordCount ?? liveRecords.length;
  const visibleAgents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = agents.filter(agent => {
      const matchesQuery = !needle || `${agent.name} ${agent.handle} ${agent.capability} ${agent.framework} ${agent.summary}`.toLowerCase().includes(needle);
      const matchesProtocol = frameworkFilter === "All protocols" || agent.framework === frameworkFilter;
      const matchesTrust = trustFilter === "all" || evidenceGroup(agent) === trustFilter;
      return matchesQuery && matchesProtocol && matchesTrust;
    });
    if (sortMode === "evidence") return [...matching].sort((left, right) => evidenceRank(right) - evidenceRank(left));
    if (sortMode === "name") return [...matching].sort((left, right) => left.name.localeCompare(right.name));
    return matching;
  }, [agents, frameworkFilter, query, sortMode, trustFilter]);
  const agentSuggestions = useMemo(() => {
    const needle = agentSearch.trim().toLowerCase();
    if (!needle) return agents.slice(0, 5);
    return [...agents]
      .filter(agent => `${agent.name} ${agent.handle} ${agent.capability} ${agent.framework}`.toLowerCase().includes(needle))
      .sort((left, right) => {
        const leftStarts = `${left.name} ${left.handle}`.toLowerCase().startsWith(needle) ? 0 : 1;
        const rightStarts = `${right.name} ${right.handle}`.toLowerCase().startsWith(needle) ? 0 : 1;
        return leftStarts - rightStarts || evidenceRank(right) - evidenceRank(left);
      })
      .slice(0, 7);
  }, [agentSearch, agents]);
  const selected = visibleAgents.find(agent => agent.id === selectedId) ?? visibleAgents[0] ?? agents[0];
  const deepVisibleAgents = useMemo(() => visibleAgents.filter(agent => {
    const matchesTrustedOnly = !trustedOnly || agent.publisherValidation.status === "allowlisted";
    const matchesPublisherState = publisherStateFilter === "all" || agent.publisherValidation.status === publisherStateFilter;
    return matchesTrustedOnly && matchesPublisherState;
  }), [publisherStateFilter, trustedOnly, visibleAgents]);
  const deepSelected = deepVisibleAgents.find(agent => agent.id === selectedId) ?? deepVisibleAgents[0] ?? selected;
  const ingressFeed: IngestionEvent[] = liveRecords.slice(0, 3).map(record => ({ id: `observed-${record.agentId}`, agent: record.displayName, capability: record.primaryCapability ?? "Discovery", protocol: protocolsForLiveAgent(record.protocols)[0]?.toUpperCase() ?? "A2A", tone: "#BFFF76", position: positionForLiveAgent(record.agentId) }));
  const verifiedIngress = ingressFeed[0] ?? null;
  const showIngress = verifiedIngress !== null && ingressMatchesFramework(frameworkFilter, verifiedIngress.protocol);
  // Read only where its answer is drawn, the field view and Deep Space. On the home page it fed nothing and was asked for every 8 seconds, half of the page's requests.
  const evidenceQuery = trpc.atlas.evidence.useQuery({ agentId: selected?.id ?? "" }, { ...EVIDENCE_POLL, enabled: Boolean(selected) && (view === "field" || deepSpace) });
  const activeEvidence: EvidenceEnvelope | undefined = evidenceQuery.data;
  const evidenceStaleSince = staleSince(evidenceQuery);
  const comparedAgents = useMemo(() => compareIds.map(id => agents.find(agent => agent.id === id)).filter((agent): agent is AtlasAgent => Boolean(agent)), [agents, compareIds]);

  useEffect(() => {
    if (!pinPulseId && !comparisonPulse) return;
    const timer = window.setTimeout(() => {
      setPinPulseId(null);
      setComparisonPulse(false);
    }, 680);
    return () => window.clearTimeout(timer);
  }, [comparisonPulse, pinPulseId]);

  // The spotlight burst is a one-shot emphasis; clear it so the located node
  // returns to normal crew presentation after the fly-in completes.
  useEffect(() => {
    if (!spotlight) return;
    const timer = window.setTimeout(() => setSpotlight(null), 2600);
    return () => window.clearTimeout(timer);
  }, [spotlight]);

  // A link's state is read once. The agent and the comparison wait for the records to arrive and are applied then; they used to be
  // applied again each time the records changed, which put a reader who had unpinned an agent or closed the comparison back where the link said.
  const linkApplied = useRef(false);
  useEffect(() => {
    if (window.location.hash === "#deep-space") setDeepSpace(true);
  }, []);
  useEffect(() => {
    if (linkApplied.current || agents.length === 0) return;
    linkApplied.current = true;
    const url = new URL(window.location.href);
    const linkedAgent = url.searchParams.get("agent");
    const comparison = (url.searchParams.get("compare") ?? "").split("~").filter(id => agents.some(agent => agent.id === id)).slice(0, 2);
    if (linkedAgent && agents.some(agent => agent.id === linkedAgent)) {
      setSelectedId(linkedAgent);
      setLinkedAgentId(linkedAgent);
    }
    if (comparison.length > 0) {
      setCompareIds(comparison);
      setComparisonOpen(true);
    }
  }, [agents]);

  // A link that arrives with a hash (from the full field's header, say) lands on its section. The sections draw after the page and
  // the page grows above them as they do, so it keeps the section in place until it has stayed put, or until the reader takes over.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (view !== "home" || !id || id === "deep-space") return;
    let ticks = 0;
    let steady = 0;
    const stop = () => window.clearInterval(timer);
    const timer = window.setInterval(() => {
      ticks += 1;
      const target = document.getElementById(id);
      if (target) {
        const offset = (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + (parseFloat(getComputedStyle(target).scrollMarginTop) || 0);
        if (Math.abs(target.getBoundingClientRect().top - offset) > 4) {
          steady = 0;
          target.scrollIntoView({ block: "start" });
        } else steady += 1;
      }
      if (steady >= 8 || ticks > 60) stop();
    }, 150);
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    events.forEach(name => window.addEventListener(name, stop, { once: true, passive: true }));
    return () => {
      stop();
      events.forEach(name => window.removeEventListener(name, stop));
    };
  }, [view]);

  useEffect(() => {
    if (deepVisibleAgents.length > 0 && !deepVisibleAgents.some(agent => agent.id === selectedId)) setSelectedId(deepVisibleAgents[0].id);
  }, [deepVisibleAgents, selectedId]);

  useEffect(() => {
    if (visibleAgents.length > 0 && !visibleAgents.some(agent => agent.id === selectedId)) setSelectedId(visibleAgents[0].id);
  }, [selectedId, visibleAgents]);

  const setMapPublisherState = (state: PublisherState | "all") => {
    setPublisherStateFilter(state);
    if (state !== "allowlisted") setTrustedOnly(false);
  };

  const setMapTrustedOnly = (value: boolean) => {
    setTrustedOnly(value);
    if (value) setPublisherStateFilter("allowlisted");
  };

  const setMainTrustFilter = (value: TrustFilter) => {
    setTrustFilter(value);
    // The main-page trust mode is authoritative when entering Deep Space; clear
    // any narrower overlay-only publisher-state choice to avoid a hidden empty map.
    setTrustedOnly(false);
    setPublisherStateFilter("all");
  };

  useEffect(() => {
    if (!deepSpace || !selected) return;
    const url = new URL(window.location.href);
    url.searchParams.set("agent", selected.id);
    url.hash = "deep-space";
    window.history.replaceState({}, "", url);
  }, [deepSpace, selected]);

  // One opener for the ⌘K shortcut and the header Search button: deep map open,
  // query focused.
  const openCatalogSearch = useCallback(() => {
    setDeepSpace(true);
    setSearchOpen(true);
    window.requestAnimationFrame(() => agentSearchRef.current?.focus());
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openCatalogSearch();
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setDrawerOpen(false);
        // Focus mode dims the page and the way out is the Exit focus button; Escape is the other way.
        setFocused(false);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openCatalogSearch]);


  const resetView = () => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
  };

  const locateAgent = (agentId: string) => {
    setSelectedId(agentId);
    // Locate is a jump-to-bot action, not a field filter: release the main
    // search so deep space keeps its full crew around the spotlight target.
    setQuery("");
    setDeepSpace(true);
    setDrawerOpen(true);
    setAgentSearch("");
    setSearchOpen(false);
    setSpotlight({ id: agentId, nonce: Date.now() });
    resetView();
  };

  const toggleAgentPin = (agentId: string) => {
    const isPinning = !compareIds.includes(agentId);
    const completesPair = isPinning && compareIds.length === 1;
    if (isPinning) setPinPulseId(agentId);
    if (completesPair) setComparisonPulse(true);
    setCompareIds(current => {
      if (current.includes(agentId)) return current.filter(id => id !== agentId);
      return [...current.slice(-1), agentId];
    });
    setComparisonOpen(true);
  };

  const downloadEvidence = (evidence: EvidenceEnvelope, agent: AtlasAgent) => {
    const exportPacket = {
      format: "Nooscape Signed Evidence Envelope v1",
      exportedAt: new Date().toISOString(),
      verification: {
        signatureAlgorithm: evidence.signatureAlgorithm,
        signedField: "envelope.canonicalPayload",
        publicKeyPem: evidence.relayPublicKeyPem,
        instructions: "Verify the base64 signature against the UTF-8 canonicalPayload using the included Ed25519 public key; then verify the SHA-256 integrityHash.",
      },
      envelope: evidence,
    };
    const blob = new Blob([JSON.stringify(exportPacket, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `nooscape-${agent.id}-evidence-seq-${evidence.sequence}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  };

  const shareComparison = async () => {
    if (compareIds.length !== 2) return;
    const url = new URL(window.location.href);
    url.searchParams.set("compare", compareIds.join("~"));
    url.searchParams.set("agent", selected.id);
    url.hash = "deep-space";
    try {
      await navigator.clipboard.writeText(url.toString());
    } catch {
      const copyTarget = document.createElement("textarea");
      copyTarget.value = url.toString();
      copyTarget.setAttribute("readonly", "");
      copyTarget.style.position = "fixed";
      copyTarget.style.opacity = "0";
      document.body.appendChild(copyTarget);
      copyTarget.select();
      document.execCommand("copy");
      document.body.removeChild(copyTarget);
    }
    setComparisonShareState("copied");
    window.setTimeout(() => setComparisonShareState("idle"), 1800);
  };

  const shareSelectedAgent = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("agent", selected.id);
    url.hash = "deep-space";
    const link = url.toString();
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const copyTarget = document.createElement("textarea");
      copyTarget.value = link;
      copyTarget.setAttribute("readonly", "");
      copyTarget.style.position = "fixed";
      copyTarget.style.opacity = "0";
      document.body.appendChild(copyTarget);
      copyTarget.select();
      document.execCommand("copy");
      document.body.removeChild(copyTarget);
    }
    setShareState("copied");
    window.setTimeout(() => setShareState("idle"), 1800);
  };

  // The field and its filter are drawn from the live records, like everything else on the page, and hold their place until
  // there is a record to select.
  const atlasReady = Boolean(selected);
  const deepSpaceOpen = deepSpace && atlasReady;
  // Deep Space is opaque and fixed over the viewport, so the loops behind it (the map, the hero canvas, the owl) stop while it is open.
  useEffect(() => {
    setPageCovered(deepSpaceOpen);
    return () => setPageCovered(false);
  }, [deepSpaceOpen]);
  // Deep Space hides the page behind it, and a hidden control loses focus. The control that opened it is noted in a layout effect, which
  // runs before the browser takes focus away, so that Deep Space can give focus back to it when it closes. It is not cleared on close:
  // the focus is given back after the commit that closes Deep Space, and the next opening replaces it.
  const deepSpaceOpener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (deepSpaceOpen) deepSpaceOpener.current = document.activeElement;
  }, [deepSpaceOpen]);
  // The header button: search for an agent in the Deep map or, until there is a record for that map to draw,
  // scroll to the scan map, which does not need one.
  const askTheOwl = () => {
    if (atlasReady) openCatalogSearch();
    else document.getElementById("scan-field-heading")?.scrollIntoView({ block: "start" });
  };

  return (
    <div className={cn("nooscape-shell min-h-screen overflow-x-clip bg-[#06070B] text-[#EAF7EE]", focused && "signal-focused", deepSpaceOpen && "shell-deep-open")}>

      <SiteHeader
        focused={focused}
        onToggleFocus={() => setFocused(value => !value)}
        onAskTheOwl={askTheOwl}
        onOpenDeepMap={() => setDeepSpace(true)}
        status={statusLines({
          loading: liveRecordsQuery.isLoading,
          recordCount: liveRecords.length,
          publicRecordCount: liveCoverage?.publicRecordCount ?? null,
          coveragePercent: liveCoverage?.coveragePercent ?? null,
        })}
      />

      <main id="top" className="relative z-10 mx-auto max-w-[1540px] px-5 pb-12 lg:px-8">
        {view === "home" ? (
          <>
            <HeroScene onAskTheOwl={askTheOwl} />

            <Suspense fallback={<div className="mb-5 h-[520px]" aria-hidden="true" />}>
              <LandingHero records={liveRecords} status={liveRecordsQuery.isLoading || mapFleetsQuery.isLoading ? "loading" : liveRecordsQuery.isError ? "unavailable" : "ready"} fleets={mapFleetsQuery.data ?? null} arcFleets={arcFleetsQuery.data ?? null} linkedAgentId={linkedAgentId} />
            </Suspense>

            {/* Below the map, not above it: the map is the best thing on the page and should be the first section a visitor reaches. The hero's own line says what is new and links here. */}
            <JustArrived />

            <Suspense fallback={<div className="mb-5 h-[420px]" aria-hidden="true" />}>
              <LandingEvidence
                funnelSteps={funnelSteps}
                funnelStatus={directoryFunnelQuery.isLoading ? "loading" : directoryFunnelQuery.isError ? "unavailable" : "ready"}
                asOfBlock={activityThroughBlock}
                activity={directoryFunnel?.activityTotals ?? null}
                wallets={directoryWalletCensus?.wallets ?? []}
                walletStatus={directoryWalletQuery.isLoading ? "loading" : directoryWalletQuery.isError ? "unavailable" : "ready"}
                bnbProfile={bnbRegistry ? { recorded: bnbRegistry.recorded, listed: bnbRegistry.listed } : null}
              />
            </Suspense>

          </>
        ) : (
          <Suspense fallback={<div className="min-h-[760px]" aria-hidden="true" />}>
            <FieldView agents={agents} visibleAgents={visibleAgents} selected={selected} selectedId={selectedId} compareIds={compareIds} liveRecords={liveRecords} liveRecordsQuery={liveRecordsQuery} liveCoverage={liveCoverage} directoryBreakdown={directoryBreakdown} directoryAckTotal={directoryAckTotal} usdgTotals={usdgTotals} ingressFeed={ingressFeed} verifiedIngress={verifiedIngress} showIngress={showIngress} activeEvidence={activeEvidence} evidenceQuery={evidenceQuery} evidenceStaleSince={evidenceStaleSince} atlasReady={atlasReady} query={query} setQuery={setQuery} trustFilter={trustFilter} setMainTrustFilter={setMainTrustFilter} setFrameworkFilter={setFrameworkFilter} setSelectedId={setSelectedId} setDeepSpace={setDeepSpace} setZoom={setZoom} locateAgent={locateAgent} />
          </Suspense>
        )}
      </main>

      {deepSpaceOpen && (
        <Suspense fallback={<DeepSpaceOpening />}>
          <DeepSpaceMap opener={deepSpaceOpener} agents={deepVisibleAgents} allAgents={visibleAgents} selected={deepSelected} onSelect={setSelectedId} onClose={() => { setDrawerOpen(false); setSearchOpen(false); setDeepSpace(false); const url = new URL(window.location.href); url.hash = ""; window.history.replaceState({}, "", url); }} zoom={zoom} pan={pan} onZoom={setZoom} onPan={setPan} onReset={resetView} ingress={verifiedIngress} showIngress={showIngress && !trustedOnly && publisherStateFilter === "all"} evidence={activeEvidence} evidenceLoading={evidenceQuery.isLoading} evidenceAsOf={evidenceStaleSince} frameworks={frameworks} frameworkFilter={frameworkFilter} onFrameworkFilter={setFrameworkFilter} sortMode={sortMode} onSortMode={setSortMode} onShare={shareSelectedAgent} shareState={shareState} agentSearch={agentSearch} onAgentSearch={setAgentSearch} searchOpen={searchOpen} onSearchOpen={setSearchOpen} searchRef={agentSearchRef} suggestions={agentSuggestions.filter(agent => deepVisibleAgents.some(visible => visible.id === agent.id))} onLocateAgent={locateAgent} drawerOpen={drawerOpen} onCloseDrawer={() => { setDrawerOpen(false); setSpotlight(null); }} pinned={compareIds.includes(selected.id)} onPin={() => toggleAgentPin(selected.id)} onOpenComparison={() => setComparisonOpen(true)} compareCount={compareIds.length} onDownloadEvidence={downloadEvidence} directoryTotal={directoryAckTotal} directoryHits={directorySearchQuery.data ?? undefined} directoryWallets={directoryWalletCensus} pinPulseId={pinPulseId} comparisonPulse={comparisonPulse} pinnedIds={compareIds} spotlight={spotlight} trustedOnly={trustedOnly} onTrustedOnly={setMapTrustedOnly} publisherStateFilter={publisherStateFilter} onPublisherStateFilter={setMapPublisherState}>
            {comparisonOpen && <Suspense fallback={null}><AgentComparisonPanel agents={comparedAgents} onRemove={id => setCompareIds(current => current.filter(agentId => agentId !== id))} onClose={() => setComparisonOpen(false)} onSelect={locateAgent} onShare={shareComparison} shareState={comparisonShareState} comparisonPulse={comparisonPulse} /></Suspense>}
          </DeepSpaceMap>
        </Suspense>
      )}
      <footer data-owl-avoid="" className="relative z-10 mx-auto max-w-[1540px] px-5 pb-10 lg:px-8">
        {view === "home" && (
          <details data-owl-avoid="" className="how-we-count rounded-2xl border border-white/[0.1] bg-[#091012]/70 px-4 py-1 sm:px-5">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-ns-ink-dim hover:text-ns-ink">How we count</summary>
          <div className="pb-4">
            {liveRecordsQuery.isLoading ? <PopulationSkeleton /> : <section aria-label="Live observatory population" className="mt-6 overflow-hidden rounded-2xl border border-[#BFFF76]/25 bg-[#BFFF76]/[0.045] shadow-[0_18px_44px_rgba(104,255,156,.06)]">
              <div className="flex items-end justify-between gap-4 border-b border-[#BFFF76]/15 px-4 py-3.5 sm:px-5">
                <div><p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[.17em] text-[#BFFF76]"><span className="pulse-dot" /> Live population</p><p className="mt-1 text-xs text-[#A7B9AC]">{liveRecords.length ? (directoryAckTotal > 0 ? "Agents acknowledged across every source" : "Public source-scoped records visible now") : "No public records are visible right now"}</p></div>
                <div className="text-right"><strong className="block font-mono text-4xl leading-none tracking-[-.08em] text-[#F2FFF5]">{liveRecords.length && directoryAckTotal > 0 ? directoryAckTotal.toLocaleString() : String(liveRecords.length ? reviewedTotal : 6).padStart(2, "0")}</strong><span className="mt-1 block font-mono text-xs uppercase tracking-[.15em] text-[#8EA597]">{liveRecords.length && directoryAckTotal > 0 ? "acknowledged" : "viewable here"}</span>{liveRecords.length > 0 && directoryAckTotal > 0 && <span className="mt-0.5 block font-mono text-xs uppercase tracking-[.15em] text-[#BFFF76]">{reviewedTotal.toLocaleString()} reviewed</span>}</div>
              </div>
              <div className="grid grid-cols-2 divide-x divide-[#BFFF76]/15">
                <div className="px-4 py-3.5 sm:px-5"><p className="font-mono text-xs uppercase tracking-[.14em] text-[#819588]">Provenance ready</p><strong className="mt-1 block font-mono text-lg text-[#DFFFF0]">{liveRecords.length ? (liveCoverage ? `${liveCoverage.coveragePercent}%` : "…") : "DEMO"}</strong><span className="mt-1 block text-xs leading-4 text-[#71857A]">of reviewed records have retained evidence</span></div>
                <div className="px-4 py-3.5 sm:px-5"><p className="font-mono text-xs uppercase tracking-[.14em] text-[#819588]">Discovery surfaces</p><strong className="mt-1 block font-mono text-lg text-[#DFFFF0]">{liveRecords.length ? populationRows.length : 4}</strong><span className="mt-1 block text-xs leading-4 text-[#71857A]">protocol surfaces read</span></div>
              </div>
              <div className="border-t border-[#BFFF76]/15 px-4 py-3.5 sm:px-5"><p className="font-mono text-xs uppercase tracking-[.14em] text-[#819588]">Protocol population</p><div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{liveRecords.length ? populationRows.map(row => <span key={row.protocol} className="flex items-baseline gap-1.5 font-mono text-xs uppercase tracking-[.08em] text-[#9CB0A2]"><strong className="text-base tracking-[-.05em] text-[#E4FFE9]">{(row.acknowledged ?? row.reviewed).toLocaleString()}</strong><span>{row.label} <em className="not-italic text-[#71857A]">· {row.acknowledged === null ? "reviewed only" : `${row.reviewed.toLocaleString()} reviewed`}</em></span></span>) : <span className="font-mono text-xs uppercase tracking-[.08em] text-[#71857A]">Awaiting live source refresh</span>}</div></div>
              {directoryBreakdown && directoryBreakdown.total > 0 && <div className="border-t border-[#BFFF76]/15 px-4 py-3.5 sm:px-5"><p className="font-mono text-xs uppercase tracking-[.14em] text-[#819588]">Registry identities & listings seen</p><div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2"><span className="flex items-baseline gap-1.5 font-mono text-xs uppercase tracking-[.08em] text-[#9CB0A2]"><strong className="text-base tracking-[-.05em] text-[#E4FFE9]">{directoryOnChainTotal.toLocaleString()}</strong>on-chain identities</span><span className="flex items-baseline gap-1.5 font-mono text-xs uppercase tracking-[.08em] text-[#9CB0A2]"><strong className="text-base tracking-[-.05em] text-[#E4FFE9]">{directorySplit.locator.toLocaleString()}</strong>locator listings</span>{directorySplit.bnbChain > 0 && <span className="flex items-baseline gap-1.5 font-mono text-xs uppercase tracking-[.08em] text-[#9CB0A2]"><strong className="text-base tracking-[-.05em] text-[#E4FFE9]">{directorySplit.bnbChain.toLocaleString()}</strong>listed from BNB Chain</span>}{extraChainTotals(directoryBreakdown.byProtocol).map(row => <span key={row.chain} className="flex items-baseline gap-1.5 font-mono text-xs uppercase tracking-[.08em] text-[#9CB0A2]"><strong className="text-base tracking-[-.05em] text-[#E4FFE9]">{row.count.toLocaleString()}</strong>listed from {row.label}</span>)}</div><span className="mt-2 block text-xs leading-4 text-[#71857A]">on-chain identities are registry facts · locator listings are rows seen on directories and card endpoints, not verified agents · searchable via ⌘K · reviewed records are the subset viewable here</span></div>}
              {bnbRegistry && bnbRegistry.recorded > 0 && <div className="border-t border-[#BFFF76]/15 px-4 py-3.5 sm:px-5"><p className="font-mono text-xs uppercase tracking-[.14em] text-[#819588]">BNB Chain ERC-8004 registry · recorded facts</p><div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2"><span className="flex items-baseline gap-1.5 font-mono text-xs uppercase tracking-[.08em] text-[#9CB0A2]"><strong className="text-base tracking-[-.05em] text-[#E4FFE9]">{bnbRegistry.recorded.toLocaleString()}</strong>registrations on-chain</span><span className="flex items-baseline gap-1.5 font-mono text-xs uppercase tracking-[.08em] text-[#9CB0A2]"><strong className="text-base tracking-[-.05em] text-[#E4FFE9]">{bnbRegistry.published.toLocaleString()}</strong>listed here</span><span className="flex items-baseline gap-1.5 font-mono text-xs uppercase tracking-[.08em] text-[#9CB0A2]"><strong className="text-base tracking-[-.05em] text-[#E4FFE9]">{(bnbRegistry.recorded - bnbRegistry.listed).toLocaleString()}</strong>held out</span></div><span className="mt-2 block text-xs leading-4 text-[#9CB0A2]">Held out: {bnbRegistry.grouped.toLocaleString()} share a profile link, host, or wallet with other registrations · {bnbRegistry.withoutProfileLink.toLocaleString()} set no usable profile link · {bnbRegistry.numericName.toLocaleString()} are named only with a number{bnbRegistry.pending > 0 ? ` · ${bnbRegistry.pending.toLocaleString()} not classified yet` : ""}</span>{bnbRegistry.listed > bnbRegistry.published && <span className="mt-1 block text-xs leading-4 text-[#9CB0A2]">{(bnbRegistry.listed - bnbRegistry.published).toLocaleString()} more pass the rules and appear here once the chain read has caught up</span>}{bnbRegistry.sharedProfileGroups.length > 0 && <span className="mt-1 block break-words text-xs leading-4 text-[#9CB0A2]">Profile links shared by the most registrations: {bnbRegistry.sharedProfileGroups.map(group => `${group.label} ×${group.registrations.toLocaleString()}`).join(" · ")}</span>}{bnbRegistry.topHosts.length > 0 && <span className="mt-1 block break-words text-xs leading-4 text-[#9CB0A2]">Hosts the most registrations point at: {bnbRegistry.topHosts.map(host => `${host.host} ×${host.registrations.toLocaleString()}`).join(" · ")}</span>}<span className="mt-2 block text-xs leading-4 text-[#71857A]">{listingRulesSentence(bnbRegistry.rules)} · held-out registrations are stored chain facts, not judged fake · the directory pass reads the registration file behind the https or ipfs link of a listed entry, to group look-alike entries, and a one-off census on 2026-10-16 read some earlier</span></div>}
            </section>}
          </div>
          </details>
        )}
        <div className="mt-4 flex flex-col justify-between gap-2 text-xs leading-5 text-ns-ink-dim md:flex-row">
          <span>Nooscape. A public agent observatory. Nooscape has issued no token on any chain and is not connected to any token that uses its name. Nothing here is an offer to sell a token or a place to buy one.</span>
          <span>Nooscape doesn&rsquo;t hold funds, sell placement, or rank agents. {liveRecords.length ? `${liveRecords.length} retained observation${liveRecords.length === 1 ? "" : "s"}.` : "No retained observations are visible right now."}</span>
        </div>
        <nav aria-label="Disputes, privacy, terms and contact" className="mt-3">
          <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs leading-5 text-ns-ink-dim">
            <li><Link href="/disputes" className="inline-flex min-h-6 items-center underline underline-offset-4 hover:text-ns-ink">Disputes</Link></li>
            <li><Link href="/privacy" className="inline-flex min-h-6 items-center underline underline-offset-4 hover:text-ns-ink">Privacy</Link></li>
            <li><Link href="/terms" className="inline-flex min-h-6 items-center underline underline-offset-4 hover:text-ns-ink">Terms</Link></li>
            <li><Link href="/contact" className="inline-flex min-h-6 items-center underline underline-offset-4 hover:text-ns-ink">Contact</Link></li>
          </ul>
        </nav>
      </footer>
    </div>
  );
}

/** The population card before the live read answers: the same shape as the static page in index.html, so no seed count is shown first. */
/** What stands in for Deep Space while its file is fetched: the same opaque overlay, so the page behind it is covered at once. */
function DeepSpaceOpening() {
  return <div className="deep-space-overlay" role="status" aria-label="Opening Deep Space"><div className="deep-stars" /><p className="absolute inset-0 grid place-items-center font-mono text-xs uppercase tracking-[.2em] text-[#8FA196]">Opening Deep Space</p></div>;
}

function PopulationSkeleton() {
  return (
    <section aria-label="Live observatory population" aria-busy="true" className="mt-6 min-h-[480px] overflow-hidden rounded-2xl border border-[#BFFF76]/25 bg-[#BFFF76]/[0.045] p-5">
      <span role="status" className="sr-only">Loading the live population</span>
      <div className="grid gap-3" aria-hidden="true">
        <div className="h-9 w-2/5 animate-pulse rounded-lg bg-white/[0.08] motion-reduce:animate-none" />
        <div className="h-3.5 w-4/5 animate-pulse rounded-lg bg-white/[0.08] motion-reduce:animate-none" />
        <div className="h-3.5 w-3/5 animate-pulse rounded-lg bg-white/[0.08] motion-reduce:animate-none" />
        <div className="h-3.5 w-full animate-pulse rounded-lg bg-white/[0.08] motion-reduce:animate-none" />
      </div>
    </section>
  );
}
