import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from "react";
import { AgentBotAvatar } from "@/components/AgentBotAvatar";
import { HeroScene } from "@/components/home/HeroScene";
import { JustArrived } from "@/components/home/JustArrived";
import { SiteHeader } from "@/components/home/SiteHeader";
import { statusLines } from "@/components/home/headerModel";
import { Term } from "@/components/Term";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { safeHttpsHref } from "@/lib/safeHref";
import { trpc } from "@/lib/trpc";
import { featureOn } from "@shared/features";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { buildProtocolPopulation, directoryProtocolDisplay, extraChainTotals, listingRulesSentence, reviewedProtocolCounts, splitDirectoryTotals } from "@/lib/directoryProtocols";
import { publisherStateExplanations, tierExplanations, tierFromProof } from "@/lib/evidenceExplain";
import { useElementSize } from "@/hooks/useElementSize";
import { planLabels, type LabelPlace } from "@/lib/fieldLabels";
import { countByEvidenceGroup, evidenceDiffers, evidenceGroup, evidenceRank, evidenceReadout, evidenceSummary, PUBLISHER_STATES, toPublisherState, type EvidenceGroup, type PublisherState } from "@/lib/evidenceReadout";
import { notYetMeasurable } from "@/lib/glossary";
import { buildTopologyLayer, connectionLinesForEntities, DUST_PARTICLE_LIMIT, pickFeaturedAgents } from "@/lib/topology";
import {
  Activity,
  ArrowUpRight,
  BadgeCheck,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Download,
  FileCheck2,
  Fingerprint,
  Layers3,
  Minus,
  Network,
  Orbit,
  PanelRightOpen,
  Plus,
  Radar,
  Radio,
  RotateCcw,
  Satellite,
  Search,
  Share2,
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
  Terminal,
  Waves,
  Waypoints,
  X,
} from "lucide-react";

type Lens = "field" | "protocol" | "trust";
type TrustFilter = "all" | EvidenceGroup;

/** The filter above the full field, in the order it reads: what each choice is called, and how it looks once chosen. */
const trustFilters: { value: TrustFilter; label: string; Icon: typeof Layers3; active: string }[] = [
  { value: "all", label: "All agents", Icon: Layers3, active: "border-[#BFFF76]/55 bg-[#BFFF76]/[.12] text-[#D9FFC2]" },
  { value: "owner", label: "Owner-verified", Icon: BadgeCheck, active: "border-[#66E8FF]/55 bg-[#66E8FF]/[.1] text-[#B9F6FF]" },
  { value: "website", label: "Website-verified", Icon: ShieldCheck, active: "border-[#BFFF76]/55 bg-[#BFFF76]/[.12] text-[#D9FFC2]" },
  { value: "none", label: "No proof yet", Icon: Fingerprint, active: "border-[#C3A6FF]/55 bg-[#C3A6FF]/[.12] text-[#E3D8FF]" },
];

type PublisherValidation = {
  status: PublisherState;
  publisherName: string | null;
  publicKeyFingerprint: string | null;
  verifiedAt: string | null;
  statusChangedAt: string | null;
};

const publisherStateMeta: Record<PublisherState, { label: string; detail: string }> = {
  allowlisted: { label: "Allowlisted", detail: "Active publisher key" },
  expired: { label: "Expired", detail: "Key needs renewal" },
  revoked: { label: "Revoked", detail: "Key no longer trusted" },
  unverified: { label: "Unverified", detail: "No known publisher key" },
};

const publisherStates = PUBLISHER_STATES;
type AtlasAgent = {
  id: string;
  name: string;
  handle: string;
  capability: string;
  chain: string;
  framework: string;
  status: string;
  summary: string;
  specialties: readonly string[];
  proof: string;
  position: { x: number; y: number };
  publisherValidation: PublisherValidation;
};

type LiveAtlasRecord = {
  agentId: string;
  displayName: string;
  handle: string;
  primaryCapability: string | null;
  untrustedSummary: string | null;
  protocols: string;
  publisherState: string;
  evidenceTier: string;
  sourceCount: number;
  lastObservedAt: Date;
};

type LiveAtlasCoverage = {
  publicRecordCount: number;
  provenanceReadyCount: number;
  coveragePercent: number;
};

// Acknowledgement ledger aggregate: every agent seen across all sources, split
// by protocol. Locator facts only — distinct from the reviewed record set.
// What fills the BNB Chain ERC-8004 registry, as recorded facts (null until the source is approved).
type BnbRegistryProfile = {
  recorded: number;
  listed: number;
  published: number;
  grouped: number;
  withoutProfileLink: number;
  numericName: number;
  pending: number;
  sharedProfileGroups: Array<{ label: string; registrations: number }>;
  topHosts: Array<{ host: string; registrations: number }>;
  rules: { sharedProfileLinkFrom: number; sharedHostFrom: number; sharedWalletFrom: number };
};

type DirectoryBreakdown = {
  total: number;
  byProtocol: readonly { protocol: string; count: number }[];
};

// Locator-class facts only. Directory acknowledgements are unreviewed census
// presence: they never carry summaries, trust or tiers. They do not reach the home map: BNB Chain is drawn there only as groups of registrations (`liveData.mapFleets`), never one registration at a time.
type DirectoryAckEntry = {
  id: string;
  displayName: string;
  locatorHost: string | null;
  protocol: string;
  sourceSignalNote: string | null;
  // Fold hints: other directory entries sharing this one's recorded wallet,
  // exact name, or locator host. Grouping facts, never identity or quality.
  related?: { sameWallet: number; sameName: number; sameHost: number };
};

type DirectoryAckHits = {
  entries: DirectoryAckEntry[];
  matchedTotal: number;
  // Set when the server declined the search because its search capacity was full.
  busy?: boolean;
};

// Wallet concentration over the acknowledgements that record a wallet (the
// ERC-8004 registrant, or the Solana registries' current owner or authority):
// the wallets recorded against the most identities, largest count first. The
// dominant host is a narration hint — locator-class chain facts, never a
// verified operator, never a rating.
type DirectoryWalletCensus = {
  wallets: readonly { registrant: string; agentCount: number; dominantHost: string | null }[];
};

// The honesty funnel: how far from merely acknowledged to independently
// proven. A null value is an honest "not measured yet", never a false zero.
type DirectoryFunnel = {
  steps: readonly { key: string; value: number | null }[];
  // Ledger-wide chain-activity totals over the measured entries; null while
  // the activity migration is pending, so the copy stays absent rather than
  // showing false zeros. measuredThroughBlock is the ledger's high-water
  // block — the walk measures up to that block, so counts are honest only
  // "as of" it.
  activityTotals: {
    mintedEntries: number;
    secondaryTransfers: number;
    handoutTransfers: number;
    uriUpdates: number;
    measuredThroughBlock: number | null;
  } | null;
};

// Rail-level USDG settlement totals over the measured windows of the one
// settlement ledger: counts, the median raw value, the micropayment share,
// and block coverage. Null while the source is unmeasured or the migration
// is pending — the money panel stays absent rather than showing false zeros.
type DirectoryUsdgSettlements = {
  settlementCount: number;
  payerCount: number;
  payeeCount: number;
  relayerCount: number;
  microPaymentCount: number;
  medianValueRaw: string | null;
  firstBlock: number;
  lastBlock: number;
};

// Formats a raw 6-decimal USDG amount as an exact dollar string. Values stay
// BigInt-exact end to end; no float ever touches an amount.
/** One polling cadence for every live Atlas read on this page (was repeated inline six times). */
// The scan map loads after the first paint, so the Atlas below it does not wait on it.
const LandingHero = lazy(() => import("./home/LandingHero"));
const LandingEvidence = lazy(() => import("./home/LandingEvidence"));

const LIVE_POLL = { refetchInterval: 20_000, refetchOnWindowFocus: true } as const;
const USDG_MICROS = BigInt(1_000_000);
function formatUsdgAmount(raw: string): string {
  const value = BigInt(raw);
  const whole = value / USDG_MICROS;
  const micros = (value % USDG_MICROS).toString().padStart(6, "0").replace(/0+$/, "");
  if (whole > BigInt(0)) return micros ? `$${whole.toLocaleString("en-US")}.${micros}` : `$${whole.toLocaleString("en-US")}`;
  return micros ? `$0.${micros}` : "$0";
}

type IngestionEvent = {
  id: string;
  agent: string;
  capability: string;
  protocol: string;
  tone: string;
  position: { x: number; y: number };
};

type HistoryEvent = {
  at: string;
  action: string;
  detail: string;
  tone: string;
};

type EvidenceEntry = {
  id: string;
  observedAt: string;
  event: string;
  detail: string;
  source: string;
  proofReference: string;
};

type EvidenceEnvelope = {
  agentId: string;
  observedAt: string;
  sequence: number;
  algorithm: string;
  integrityHash: string;
  signatureAlgorithm: string;
  signature: string;
  relayPublicKeyPem: string;
  relayKeyId?: string;
  canonicalPayload: string;
  relayMode: string;
  publisherValidation?: PublisherValidation;
  provenance?: {
    evidenceClass: "persisted-observation";
    sourceLabel: string;
    sourceRoot: string;
    canonicalLocator: string;
    contentHash: string;
    rawPayloadAccess: "private-object-store";
    retentionPolicy: string;
    validationStatus: "valid" | "invalid" | "partial";
  };
  entries: EvidenceEntry[];
};

const tones: Record<string, string> = {
  Research: "#C3A6FF",
  Security: "#BFFF76",
  Build: "#FFB86A",
  Commerce: "#66E8FF",
  Data: "#FF9FE7",
};

const lensCopy: Record<Lens, { title: string; detail: string; indicator: string }> = {
  field: { title: "FIELD / LIVE", detail: "Capability terrain", indicator: "Ecosystem state" },
  protocol: { title: "PROTOCOL / TRACE", detail: "Interoperability paths", indicator: "Service topology" },
  trust: { title: "EVIDENCE / TIER", detail: "Identity and evidence", indicator: "Verification contour" },
};

function positionForLiveAgent(agentId: string) {
  const value = Array.from(agentId).reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 17);
  return { x: 16 + (value % 68), y: 18 + (Math.floor(value / 71) % 62) };
}

function protocolsForLiveAgent(protocols: string) {
  try {
    const parsed = JSON.parse(protocols);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapLiveRecord(record: LiveAtlasRecord): AtlasAgent {
  const protocols = protocolsForLiveAgent(record.protocols);
  const solanaRegistered = protocols.includes("solana_registry") || protocols.includes("solana_8004");
  const protocol = solanaRegistered ? "SOLANA REGISTRY" : protocols[0]?.toUpperCase() ?? "A2A";
  const observedAt = new Date(record.lastObservedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return {
    id: record.agentId,
    name: record.displayName,
    handle: record.handle,
    capability: record.primaryCapability ?? (solanaRegistered ? "Solana registry metadata" : "Agent discovery metadata"),
    chain: solanaRegistered ? "Solana" : "Public web",
    framework: protocol,
    status: "OBSERVED",
    summary: record.untrustedSummary ?? "No public description was retained for this record.",
    specialties: [record.primaryCapability ?? "Discovery", ...protocols].slice(0, 4),
    proof: `${record.evidenceTier.toUpperCase()} · ${record.sourceCount} source`,
    position: positionForLiveAgent(record.agentId),
    publisherValidation: {
      status: toPublisherState(record.publisherState),
      publisherName: null,
      publicKeyFingerprint: null,
      verifiedAt: null,
      statusChangedAt: null,
    },
  };
}

function isDomainVerifiedAgent(agent: AtlasAgent) {
  return agent.status === "OBSERVED" && agent.publisherValidation.status === "unverified" && agent.proof.toUpperCase().startsWith("TIER_3");
}

/** `home` is the page; `field` is the older, longer view of the field (the capability terrain, the evidence filter, what nobody can measure yet, the settlement rail and the search), kept at /field. */
export default function Home({ view = "home" }: { view?: "home" | "field" }) {
  const liveRecordsQuery = trpc.liveData.publicRecords.useQuery(undefined, LIVE_POLL);
  const liveCoverageQuery = trpc.liveData.publicCoverage.useQuery(undefined, LIVE_POLL);
  // The largest groups of BNB Chain registrations that share one fact, drawn as one large circle each with its count. Read in the same batch as the records and waited for, so the page below does not move when they arrive; not retried, so a failed read leaves the map as it was. No single BNB Chain registration is read for the map.
  const mapFleetsQuery = trpc.liveData.mapFleets.useQuery(undefined, { enabled: view === "home", retry: false, staleTime: 10 * 60_000, refetchOnWindowFocus: false });
  // The groups of Arc registrations, drawn as domes beside the others while Arc's switch is on in this build. Not waited for and not retried: a failed or empty read leaves the map as it was, and the domes are placed after everything else, so they move nothing when they arrive.
  const arcFleetsQuery = trpc.liveData.registryFleets.useQuery({ chain: "arc" }, { enabled: view === "home" && featureOn("chain_arc", import.meta.env.VITE_FEATURES), retry: false, staleTime: 10 * 60_000, refetchOnWindowFocus: false });
  const [lens, setLens] = useState<Lens>("field");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
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

  const liveRecords: LiveAtlasRecord[] = liveRecordsQuery.data?.records ?? [];
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
  const trustPopulation = useMemo(() => countByEvidenceGroup(agents), [agents]);
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
  const locateMatches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return agents
      .filter(agent => `${agent.name} ${agent.handle} ${agent.capability} ${agent.framework}`.toLowerCase().includes(needle))
      .slice(0, 4);
  }, [agents, query]);
  const selected = visibleAgents.find(agent => agent.id === selectedId) ?? visibleAgents[0] ?? agents[0];
  const deepVisibleAgents = useMemo(() => visibleAgents.filter(agent => {
    const matchesTrustedOnly = !trustedOnly || agent.publisherValidation.status === "allowlisted";
    const matchesPublisherState = publisherStateFilter === "all" || agent.publisherValidation.status === publisherStateFilter;
    return matchesTrustedOnly && matchesPublisherState;
  }), [publisherStateFilter, trustedOnly, visibleAgents]);
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
  const deepSelected = deepVisibleAgents.find(agent => agent.id === selectedId) ?? deepVisibleAgents[0] ?? selected;
  const selectedLiveRecord = liveRecords.find(record => record.agentId === selected?.id);
  const selectedTrail = selectedLiveRecord
    ? [{ at: new Date(selectedLiveRecord.lastObservedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), action: `RAW ${protocolsForLiveAgent(selectedLiveRecord.protocols)[0]?.toUpperCase() ?? "SOURCE"} OBSERVATION RETAINED`, detail: "Approved-source observation with immutable raw evidence", tone: "#BFFF76" }]
    : [];
  const copy = lensCopy[lens];
  const fieldStats = liveRecords.length
    ? [
        { label: "Live records", value: String(liveCoverage?.publicRecordCount ?? liveRecords.length), detail: "source-scoped / publicly projected" },
        { label: "Protocols mapped", value: String(new Set(liveAgents.map(agent => agent.framework)).size), detail: Array.from(new Set(liveAgents.map(agent => agent.framework))).join(" · ") },
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
  const ingressFeed: IngestionEvent[] = liveRecords.slice(0, 3).map(record => ({ id: `observed-${record.agentId}`, agent: record.displayName, capability: record.primaryCapability ?? "Discovery", protocol: protocolsForLiveAgent(record.protocols)[0]?.toUpperCase() ?? "A2A", tone: "#BFFF76", position: positionForLiveAgent(record.agentId) }));
  const verifiedIngress = ingressFeed[0] ?? null;
  const showIngress = verifiedIngress !== null && ingressMatchesFramework(frameworkFilter, verifiedIngress.protocol);
  const evidenceQuery = trpc.atlas.evidence.useQuery({ agentId: selected?.id ?? "" }, { enabled: Boolean(selected), refetchInterval: 8_000, refetchOnWindowFocus: true });
  const activeEvidence: EvidenceEnvelope | undefined = evidenceQuery.data;
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

  useEffect(() => {
    const url = new URL(window.location.href);
    const linkedAgent = url.searchParams.get("agent");
    const comparison = (url.searchParams.get("compare") ?? "").split("~").filter(id => agents.some(agent => agent.id === id)).slice(0, 2);
    if (linkedAgent && agents.some(agent => agent.id === linkedAgent)) setSelectedId(linkedAgent);
    if (comparison.length > 0) {
      setCompareIds(comparison);
      setComparisonOpen(true);
    }
    if (url.hash === "#deep-space") setDeepSpace(true);
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
              <LandingHero records={liveRecords} status={liveRecordsQuery.isLoading || mapFleetsQuery.isLoading ? "loading" : liveRecordsQuery.isError ? "unavailable" : "ready"} fleets={mapFleetsQuery.data ?? null} arcFleets={arcFleetsQuery.data ?? null} />
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

            <aside className="relative z-10 border-t border-white/[0.09] bg-[#090D10]/85 p-5 xl:border-l xl:border-t-0 xl:p-6"><div className="flex items-start justify-between"><div><p className="eyebrow">Interrogate signal</p><h2 className="mt-2 font-mono text-2xl tracking-[-0.06em] text-[#F1FFF2]">{selected.name}</h2></div><span className="rounded-full border border-[#BFFF76]/30 bg-[#BFFF76]/[0.08] px-2 py-1 font-mono text-[9px] uppercase text-[#BFFF76]">{selected.status}</span></div><p className="mt-4 text-sm leading-6 text-[#A5B6AA]">{selected.summary}</p><div className="mt-5 grid grid-cols-2 gap-2"><SignalCell label="Capability" value={selected.capability} /><SignalCell label="Source" value={selected.framework} /><SignalCell label="Realm" value={selected.chain} /><SignalCell label="Proof" value={selected.proof} mono /></div><EvidenceReadoutBlock agent={selected} /><div className="mt-5"><p className="eyebrow">Operative traits</p><div className="mt-3 flex flex-wrap gap-2">{selected.specialties.map(trait => <span key={trait} className="trait-chip">{trait}</span>)}</div></div><LiveEvidenceFeed evidence={activeEvidence} loading={evidenceQuery.isLoading} /><div className="mt-5 rounded-xl border border-[#C3A6FF]/20 bg-[#C3A6FF]/[0.055] p-3.5"><div className="flex items-center gap-2 text-[10px] uppercase tracking-[.14em] text-[#D8C6FF]"><Fingerprint size={13} /> Proof-aware discovery</div><p className="mt-2 text-xs leading-5 text-[#A49DB7]">Nooscape can index a service card now, then attach identity and outcome evidence as those protocols mature.</p></div></aside>
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

        <section data-owl-avoid="" className="mt-5 grid gap-5 lg:grid-cols-[.8fr_1.2fr]"><div className="command-panel rounded-2xl border border-white/[.1] bg-[#090D10]/80 p-5"><div className="flex items-center justify-between"><div><p className="eyebrow">Signal command</p><h2 className="mt-2 text-xl tracking-[-.04em]">Find a mind</h2></div><Search className="text-[#BFFF76]" size={19} /></div><label className="command-input mt-5"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search capability, protocol, or handle" /><kbd>⌘ K</kbd></label>{locateMatches.length > 0 && <div className="locate-list" role="list" aria-label="Matching agents to locate">{locateMatches.map(agent => <button key={agent.id} type="button" role="listitem" onClick={() => locateAgent(agent.id)} className="locate-row"><span className="suggestion-bot"><AgentBotAvatar agentId={agent.id} tone={tones[agent.capability] ?? "#BFFF76"} /></span><span><strong>{agent.name}</strong><em>{agent.capability} · {agent.framework}{isDomainVerifiedAgent(agent) ? " · domain verified" : ""}</em></span><span className="locate-action">Locate <ChevronRight size={12} /></span></button>)}</div>}<p className="mt-3 text-xs leading-5 text-[#7E9084]">Search filters the field in real time. Locate jumps deep space straight to that bot.</p></div><div className="command-panel rounded-2xl border border-white/[.1] bg-[#090D10]/80 p-5"><div className="flex items-center justify-between"><div><p className="eyebrow">Verified ingress</p><h2 className="mt-2 text-xl tracking-[-.04em]">New signals entering</h2></div><Radio className="text-[#BFFF76]" size={19} /></div><div className="mt-5 grid gap-2 sm:grid-cols-3">{ingressFeed.map((event, index) => <div key={`${event.id}-${index}`} className={cn("ingest-card", index === 0 && "ingest-card-new")}><span className="ingest-orb" style={{ backgroundColor: event.tone, boxShadow: `0 0 14px ${event.tone}` }} /><strong>{event.agent}</strong><em>{event.protocol}</em></div>)}</div><p className="mt-3 text-[10px] leading-5 text-[#7E9084]">{verifiedIngress ? `${liveRecords.length} retained production observation${liveRecords.length === 1 ? "" : "s"} are projected from approved sources; unverified Tier 2 records retain source attribution.` : "No retained observations are visible right now."}</p></div></section>
          </>
        )}
      </main>

      {deepSpaceOpen && <DeepSpaceMap agents={deepVisibleAgents} allAgents={visibleAgents} selected={deepSelected} onSelect={setSelectedId} onClose={() => { setDrawerOpen(false); setSearchOpen(false); setDeepSpace(false); const url = new URL(window.location.href); url.hash = ""; window.history.replaceState({}, "", url); }} zoom={zoom} pan={pan} onZoom={setZoom} onPan={setPan} onReset={resetView} ingress={verifiedIngress} showIngress={showIngress && !trustedOnly && publisherStateFilter === "all"} history={selectedTrail} evidence={activeEvidence} evidenceLoading={evidenceQuery.isLoading} frameworks={frameworks} frameworkFilter={frameworkFilter} onFrameworkFilter={setFrameworkFilter} sortMode={sortMode} onSortMode={setSortMode} onShare={shareSelectedAgent} shareState={shareState} agentSearch={agentSearch} onAgentSearch={setAgentSearch} searchOpen={searchOpen} onSearchOpen={setSearchOpen} searchRef={agentSearchRef} suggestions={agentSuggestions.filter(agent => deepVisibleAgents.some(visible => visible.id === agent.id))} onLocateAgent={locateAgent} drawerOpen={drawerOpen} onCloseDrawer={() => { setDrawerOpen(false); setSpotlight(null); }} pinned={compareIds.includes(selected.id)} onPin={() => toggleAgentPin(selected.id)} onOpenComparison={() => setComparisonOpen(true)} compareCount={compareIds.length} onDownloadEvidence={downloadEvidence} directoryTotal={directoryAckTotal} directoryHits={directorySearchQuery.data ?? undefined} directoryWallets={directoryWalletCensus} pinPulseId={pinPulseId} comparisonPulse={comparisonPulse} pinnedIds={compareIds} spotlight={spotlight} trustedOnly={trustedOnly} onTrustedOnly={setMapTrustedOnly} publisherStateFilter={publisherStateFilter} onPublisherStateFilter={setMapPublisherState} />}
      {deepSpaceOpen && comparisonOpen && <AgentComparisonPanel agents={comparedAgents} onRemove={id => setCompareIds(current => current.filter(agentId => agentId !== id))} onClose={() => setComparisonOpen(false)} onSelect={locateAgent} onShare={shareComparison} shareState={comparisonShareState} comparisonPulse={comparisonPulse} />}
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

function DeepSpaceMap({ agents, allAgents, selected, onSelect, onClose, zoom, pan, onZoom, onPan, onReset, ingress, showIngress, history, evidence, evidenceLoading, frameworks, frameworkFilter, onFrameworkFilter, sortMode, onSortMode, onShare, shareState, agentSearch, onAgentSearch, searchOpen, onSearchOpen, searchRef, suggestions, onLocateAgent, drawerOpen, onCloseDrawer, pinned, onPin, onOpenComparison, compareCount, onDownloadEvidence, directoryTotal, directoryHits, directoryWallets, pinPulseId, comparisonPulse, pinnedIds, spotlight, trustedOnly, onTrustedOnly, publisherStateFilter, onPublisherStateFilter }: { agents: AtlasAgent[]; allAgents: AtlasAgent[]; selected: AtlasAgent; onSelect: (id: string) => void; onClose: () => void; zoom: number; pan: { x: number; y: number }; onZoom: (zoom: number) => void; onPan: (pan: { x: number; y: number }) => void; onReset: () => void; ingress: IngestionEvent | null; showIngress: boolean; history: HistoryEvent[]; evidence: EvidenceEnvelope | undefined; evidenceLoading: boolean; frameworks: string[]; frameworkFilter: string; onFrameworkFilter: (value: string) => void; sortMode: "network" | "evidence" | "name"; onSortMode: (value: "network" | "evidence" | "name") => void; onShare: () => Promise<void>; shareState: "idle" | "copied"; agentSearch: string; onAgentSearch: (value: string) => void; searchOpen: boolean; onSearchOpen: (value: boolean) => void; searchRef: React.RefObject<HTMLInputElement | null>; suggestions: AtlasAgent[]; onLocateAgent: (id: string) => void; drawerOpen: boolean; onCloseDrawer: () => void; pinned: boolean; onPin: () => void; onOpenComparison: () => void; compareCount: number; onDownloadEvidence: (evidence: EvidenceEnvelope, agent: AtlasAgent) => void; directoryTotal: number; directoryHits: DirectoryAckHits | undefined; directoryWallets: DirectoryWalletCensus | undefined; pinPulseId: string | null; comparisonPulse: boolean; pinnedIds: string[]; spotlight: { id: string; nonce: number } | null; trustedOnly: boolean; onTrustedOnly: (value: boolean) => void; publisherStateFilter: PublisherState | "all"; onPublisherStateFilter: (state: PublisherState | "all") => void }) {
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

  return (
    <div className={cn("deep-space-overlay", comparisonPulse && "deep-space-compare-enter", trustedOnly && "deep-space-trusted-only")} role="dialog" aria-modal="true" aria-label="Nooscape deep space map">
      <div className="deep-stars" />
      <header className="deep-header">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-full border border-[#BFFF76]/45 bg-[#BFFF76]/[.07] text-[#BFFF76]"><Satellite size={17} /></span>
          <div><p className="font-mono text-[10px] uppercase tracking-[.2em] text-[#BFFF76]">Nooscape / Deep space</p><h2 className="text-sm font-medium text-[#EDF9EF]">Semantic agent field</h2></div>
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
            <label className="deep-agent-search-input"><Search size={15} /><input ref={searchRef} data-owl-search="" value={agentSearch} onFocus={() => onSearchOpen(true)} onChange={event => onAgentSearch(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && suggestions[0]) onLocateAgent(suggestions[0].id); }} placeholder="Locate a name, domain, mint, or capability" /><kbd>ESC</kbd></label>
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
          <LiveEvidenceFeed evidence={evidence} loading={evidenceLoading} />
          <div className="inspector-action-row"><button type="button" onClick={() => onLocateAgent(selected.id)} className="open-record-button"><PanelRightOpen size={14} /> Open signal record <ChevronRight size={14} /></button><button type="button" onClick={onPin} className={cn("compare-pin-button", pinned && "compare-pin-active")}>{pinned ? <Check size={14} /> : <Plus size={14} />}{pinned ? "Pinned" : "Pin to compare"}<span>{compareCount}/2</span></button></div>
          <div className="mt-5 rounded-xl border border-[#66E8FF]/18 bg-[#66E8FF]/[.04] p-3 font-mono text-[10px] leading-5 text-[#9BEAF3]">Click a node to inspect its full activity record, evidence references, and live statistics.</div>
        </aside>
      </div>
      {drawerOpen && <AgentActivityDrawer agent={selected} evidence={evidence} loading={evidenceLoading} pinned={pinned} onPin={onPin} onOpenComparison={onOpenComparison} compareCount={compareCount} onDownloadEvidence={onDownloadEvidence} onClose={onCloseDrawer} />}
    </div>
  );
}

function AgentActivityDrawer({ agent, evidence, loading, pinned, onPin, onOpenComparison, compareCount, onDownloadEvidence, onClose }: { agent: AtlasAgent; evidence: EvidenceEnvelope | undefined; loading: boolean; pinned: boolean; onPin: () => void; onOpenComparison: () => void; compareCount: number; onDownloadEvidence: (evidence: EvidenceEnvelope, agent: AtlasAgent) => void; onClose: () => void }) {
  const observedInteractions = (evidence?.entries.length ?? 0) * 4 + agent.specialties.length;
  const verification = useEvidenceVerification(evidence);
  // Plain sentences for every label shown above: the tier and the publisher state.
  const tierKey = tierFromProof(agent.proof);
  const tierExplanation = tierKey ? tierExplanations[tierKey] : undefined;
  const publisherSentence = publisherStateExplanations[agent.publisherValidation.status] ?? publisherStateExplanations.unverified;

  return <aside className="agent-activity-drawer" role="dialog" aria-modal="true" aria-label={`${agent.name} signal record`}>
    <div className="drawer-accent" style={{ background: tones[agent.capability] ?? "#BFFF76" }} />
    <header className="drawer-header"><div><p className="eyebrow">Signal record / verified view</p><h2>{agent.name}</h2><span>@{agent.handle}</span></div><button type="button" onClick={onClose} className="drawer-close" aria-label="Close agent record"><X size={17} /></button></header>
    <div className="drawer-summary"><span className="drawer-capability" style={{ color: tones[agent.capability] ?? "#BFFF76" }}>{agent.capability}</span><span className="eyebrow" style={{ display: "block", marginTop: ".35rem" }}>Source-reported · untrusted</span><p>{agent.summary}</p></div>
    <div className="mt-3"><PublisherBadge validation={agent.publisherValidation} /></div>
    <section className="drawer-stat-grid"><DrawerStat label="Evidence" value={evidenceSummary(agent)} suffix={agent.publisherValidation.status} /><DrawerStat label="Observed links" value={`${observedInteractions}`} suffix="edges" /><DrawerStat label="Evidence entries" value={`${evidence?.entries.length ?? 0}`} suffix="live" /><DrawerStat label="Protocol" value={agent.framework.replace(" ", "\n")} compact /></section>
    <section className="drawer-proof"><div><Fingerprint size={15} /><span>Proof reference</span></div><strong>{agent.proof}</strong><p>Identity source: {agent.framework} · realm: {agent.chain}</p></section>
    {tierExplanation && <section className="drawer-proof"><div><ShieldCheck size={15} /><span>What these labels mean</span></div><p><strong>{tierExplanation.label}.</strong> {tierExplanation.sentence}</p><p><strong>Publisher state: {agent.publisherValidation.status}.</strong> {publisherSentence}</p></section>}
    {evidence?.provenance && <PersistedEvidenceProvenance provenance={evidence.provenance} relayKeyId={evidence.relayKeyId} />}
    <section className="drawer-log-section"><div className="drawer-section-title"><span><FileCheck2 size={14} /> Live evidence relay</span><em>{verification === "verified" ? "hash confirmed" : verification === "checking" ? "checking" : "relay pending"}</em></div>{loading && <div className="evidence-loading">Refreshing signed relay envelope…</div>}{evidence?.entries.map(log => <article key={log.id} className="drawer-log"><span className="drawer-log-dot" style={{ backgroundColor: tones[agent.capability] ?? "#BFFF76", boxShadow: `0 0 12px ${tones[agent.capability] ?? "#BFFF76"}` }} /><div><span>{formatObservedTime(log.observedAt)} · {log.event}</span><p>{log.detail}</p><code>{log.proofReference}</code><em>{log.source}</em></div><Check size={14} /></article>)}{evidence && <EvidenceIntegrity evidence={evidence} verification={verification} />}</section>
    <button type="button" disabled={!evidence} onClick={() => evidence && onDownloadEvidence(evidence, agent)} className="drawer-download-evidence"><Download size={14} /> Export signed JSON <span>{evidence?.signatureAlgorithm ?? "loading"}</span></button>
    <div className="drawer-compare-actions">{agent.status === "OBSERVED" && <a href={`/agents/${agent.id}`} className="drawer-compare-open">Agent page <ArrowUpRight size={14} /></a>}<button type="button" onClick={onPin} className={cn("drawer-pin", pinned && "drawer-pin-active")}>{pinned ? <Check size={14} /> : <Plus size={14} />}{pinned ? "Pinned for comparison" : "Pin this agent"}</button><button type="button" onClick={onOpenComparison} className="drawer-compare-open">Compare <span>{compareCount}/2</span><ChevronRight size={14} /></button></div>
    <footer className="drawer-footer">Exported JSON includes the signed canonical payload, Ed25519 public key, signature, and SHA-256 digest for independent review. Connector availability remains protocol-dependent.</footer>
  </aside>;
}

function LiveEvidenceFeed({ evidence, loading }: { evidence: EvidenceEnvelope | undefined; loading: boolean }) {
  const verification = useEvidenceVerification(evidence);
  return <section className="live-evidence-feed"><div className="live-evidence-header"><span><Radio size={13} /> Live evidence relay</span><em>{verification === "verified" ? "integrity confirmed" : loading ? "refreshing" : "awaiting envelope"}</em></div>{evidence?.entries.slice(0, 3).map(entry => <div key={entry.id} className="live-evidence-row"><i /><div><strong>{entry.event}</strong><span>{formatObservedTime(entry.observedAt)} · {entry.source}</span></div><Check size={13} /></div>)}{evidence && <EvidenceIntegrity evidence={evidence} verification={verification} compact />}</section>;
}

function EvidenceIntegrity({ evidence, verification, compact = false }: { evidence: EvidenceEnvelope; verification: "checking" | "verified" | "mismatch" | "unavailable"; compact?: boolean }) {
  return <div className={cn("evidence-integrity", compact && "evidence-integrity-compact")}><span>{verification === "verified" ? <Check size={12} /> : <Fingerprint size={12} />}{evidence.signatureAlgorithm} signed · seq {evidence.sequence}</span><code>{evidence.integrityHash.slice(0, compact ? 14 : 24)}…</code><em>{evidence.algorithm} digest · {evidence.relayMode}</em></div>;
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

function AgentComparisonPanel({ agents, onRemove, onClose, onSelect, onShare, shareState, comparisonPulse }: { agents: AtlasAgent[]; onRemove: (id: string) => void; onClose: () => void; onSelect: (id: string) => void; onShare: () => Promise<void>; shareState: "idle" | "copied"; comparisonPulse: boolean }) {
  const [left, right] = agents;
  const differenceCount = left && right ? [evidenceDiffers(left, right), left.capability !== right.capability, left.framework !== right.framework, left.chain !== right.chain].filter(Boolean).length : 0;
  return <section className={cn("agent-comparison-panel", comparisonPulse && "comparison-panel-pulse")} aria-label="Pinned agent comparison"><header><div><p className="eyebrow">Pinned signal comparison</p><h2>Side-by-side analysis</h2>{left && right && <span className="comparison-diff-summary"><i /> {differenceCount} signal differences highlighted</span>}</div><div className="comparison-header-actions"><button type="button" disabled={agents.length !== 2} onClick={onShare} className="comparison-share">{shareState === "copied" ? <Check size={13} /> : <Share2 size={13} />}{shareState === "copied" ? "Copied" : "Share"}</button><button type="button" onClick={onClose} aria-label="Close comparison"><X size={16} /></button></div></header><div className="comparison-grid">{agents.map(agent => <ComparisonCard key={agent.id} agent={agent} counterpart={agents.find(candidate => candidate.id !== agent.id)} onRemove={() => onRemove(agent.id)} onSelect={() => onSelect(agent.id)} />)}{agents.length < 2 && <div className="comparison-empty"><Plus size={18} /><strong>Pin one more agent</strong><span>Select a node, then choose “Pin to compare” to populate the second column.</span></div>}</div></section>;
}

function ComparisonCard({ agent, counterpart, onRemove, onSelect }: { agent: AtlasAgent; counterpart?: AtlasAgent; onRemove: () => void; onSelect: () => void }) {
  const evidence: EvidenceEnvelope | undefined = trpc.atlas.evidence.useQuery({ agentId: agent.id }, { refetchInterval: 8_000, refetchOnWindowFocus: true }).data;
  const evidenceDiff = Boolean(counterpart && evidenceDiffers(agent, counterpart));
  const capabilityDiff = Boolean(counterpart && agent.capability !== counterpart.capability);
  const frameworkDiff = Boolean(counterpart && agent.framework !== counterpart.framework);
  const realmDiff = Boolean(counterpart && agent.chain !== counterpart.chain);
  return <article className="comparison-card"><div className="comparison-card-top"><span className="comparison-color" style={{ backgroundColor: tones[agent.capability] ?? "#BFFF76" }} /><div><strong>{agent.name}</strong><em>{agent.capability} · {agent.framework}</em></div><button type="button" onClick={onRemove} aria-label={`Remove ${agent.name} from comparison`}><X size={13} /></button></div><div className="comparison-metrics"><span className={cn(evidenceDiff && "comparison-metric-diff")}><em>Evidence</em><strong>{evidenceSummary(agent)}</strong>{evidenceDiff && <b>different</b>}</span><span className={cn(realmDiff && "comparison-metric-diff")}><em>Realm</em><strong>{agent.chain}</strong>{realmDiff && <b>different</b>}</span><span className={cn(capabilityDiff && "comparison-metric-diff")}><em>Capability</em><strong>{agent.capability}</strong>{capabilityDiff && <b>different</b>}</span><span className={cn(frameworkDiff && "comparison-metric-diff")}><em>Protocol</em><strong>{agent.framework}</strong>{frameworkDiff && <b>different</b>}</span><span><em>Evidence</em><strong>{evidence?.entries.length ?? "n/a"}</strong></span><span><em>Relay seq</em><strong>{evidence?.sequence ?? "n/a"}</strong></span></div><div className="comparison-capabilities">{agent.specialties.map(specialty => <span key={specialty} className={cn(counterpart && !counterpart.specialties.includes(specialty) && "comparison-capability-diff")}>{specialty}</span>)}</div><div className="comparison-hash"><Fingerprint size={12} /><code>{evidence?.integrityHash.slice(0, 16) ?? "Awaiting relay"}…</code></div><button type="button" onClick={onSelect} className="comparison-focus">Focus node <ChevronRight size={13} /></button></article>;
}

function useEvidenceVerification(evidence: EvidenceEnvelope | undefined) {
  const [status, setStatus] = useState<"checking" | "verified" | "mismatch" | "unavailable">("unavailable");
  useEffect(() => {
    if (!evidence || !window.crypto?.subtle) { setStatus("unavailable"); return; }
    let active = true;
    setStatus("checking");
    window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(evidence.canonicalPayload)).then(buffer => {
      const actual = Array.from(new Uint8Array(buffer)).map(byte => byte.toString(16).padStart(2, "0")).join("");
      if (active) setStatus(actual === evidence.integrityHash ? "verified" : "mismatch");
    }).catch(() => { if (active) setStatus("unavailable"); });
    return () => { active = false; };
  }, [evidence]);
  return status;
}

function formatObservedTime(timestamp: string) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1_000));
  return elapsedSeconds < 60 ? `T-${elapsedSeconds}S` : `T-${Math.floor(elapsedSeconds / 60)}M`;
}

function DrawerStat({ label, value, suffix = "", compact = false }: { label: string; value: string; suffix?: string; compact?: boolean }) {
  return <div className={cn("drawer-stat", compact && "drawer-stat-compact")}><span>{label}</span><strong>{value}</strong>{suffix && <em>{suffix}</em>}</div>;
}

function PublisherStateIcon({ state, size = 13 }: { state: PublisherState; size?: number }) {
  if (state === "allowlisted") return <BadgeCheck size={size} />;
  if (state === "expired") return <Clock3 size={size} />;
  if (state === "revoked") return <ShieldX size={size} />;
  return <CircleDot size={size} />;
}

function PublisherBadge({ validation, compact = false }: { validation: PublisherValidation; compact?: boolean }) {
  const meta = publisherStateMeta[validation.status];
  const source = validation.publisherName ?? meta.detail;
  return <span className={cn("publisher-state-badge", `publisher-state-${validation.status}`, compact && "publisher-state-badge-compact")} title={`${meta.label}: ${source}${validation.publicKeyFingerprint ? ` · ${validation.publicKeyFingerprint}` : ""}`}><PublisherStateIcon state={validation.status} size={compact ? 12 : 14} /><span>{compact ? meta.label : `Publisher ${meta.label.toLowerCase()}`}</span>{!compact && <em>{source}</em>}</span>;
}

// Ambient background representation for records outside the featured crew.
// Count is bounded by DUST_PARTICLE_LIMIT and drift animates transform only,
// so the dust never triggers layout or competes with the interactive bots.
function FieldDust({ agents }: { agents: readonly AtlasAgent[] }) {
  const motes = agents.slice(0, DUST_PARTICLE_LIMIT);
  if (motes.length === 0) return null;
  return <div className="field-dust" aria-hidden="true">{motes.map(agent => {
    let hash = 11;
    for (const character of agent.id) hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
    return <span
      key={agent.id}
      className="dust-mote"
      style={{
        "--tone": tones[agent.capability] ?? "#BFFF76",
        left: `${agent.position.x}%`,
        top: `${agent.position.y}%`,
        "--delay": `${(hash % 90) / 10}s`,
        "--drift": `${((hash >> 3) % 14) - 7}px`,
        opacity: 0.2 + ((hash >> 5) % 5) / 10,
      } as CSSProperties}
    />;
  })}</div>;
}

function AgentNode({ agent, active, index, label, onSelect }: { agent: AtlasAgent; active: boolean; index: number; label: LabelPlace | null; onSelect: () => void }) {
  const tone = tones[agent.capability] ?? "#BFFF76";
  const publisherState = agent.publisherValidation.status;
  const annotated = publisherState !== "unverified";
  return <button type="button" onClick={onSelect} className={cn("agent-node", active && "agent-node-active", `agent-node-publisher-${publisherState}`)} style={{ left: `${agent.position.x}%`, top: `${agent.position.y}%`, "--tone": tone, "--delay": `${index * 0.42}s` } as CSSProperties}><span className="agent-halo" /><span className="agent-pulse" /><span className="agent-bot"><AgentBotAvatar agentId={agent.id} tone={tone} /></span>{annotated && <span className={cn("field-publisher-badge", `publisher-state-${publisherState}`)} title={`${publisherStateMeta[publisherState].label}: ${agent.publisherValidation.publisherName}`}><PublisherStateIcon state={publisherState} size={10} /></span>}<span className={cn("agent-label", label?.side === "left" && "agent-label-left", !label && "agent-label-quiet")} style={label ? { maxWidth: label.width } : undefined}><strong>{agent.name}</strong><em>{agent.capability}</em></span></button>;
}

function DeepAgentNode({ agent, active, spotlighted, pulsing, index, onSelect }: { agent: AtlasAgent; active: boolean; spotlighted: boolean; pulsing: boolean; index: number; onSelect: () => void }) {
  const tone = tones[agent.capability] ?? "#BFFF76";
  const publisherState = agent.publisherValidation.status;
  const annotated = publisherState !== "unverified";
  return <button type="button" onPointerDown={event => event.stopPropagation()} onClick={onSelect} className={cn("deep-agent-node", active && "deep-agent-node-active", spotlighted && "deep-agent-node-spotlight", pulsing && "deep-agent-node-pinning", `deep-agent-node-publisher-${publisherState}`)} style={{ left: `${agent.position.x}%`, top: `${agent.position.y}%`, "--tone": tone, "--delay": `${index * .3}s` } as CSSProperties}><span className="deep-node-orbit" /><span className="deep-node-bot"><AgentBotAvatar agentId={agent.id} tone={tone} /></span>{annotated && <span className={cn("deep-publisher-badge", `publisher-state-${publisherState}`)} title={`${publisherStateMeta[publisherState].label}: ${agent.publisherValidation.publisherName}`}><PublisherStateIcon state={publisherState} size={11} /><em>{publisherStateMeta[publisherState].label}</em></span>}<span className="deep-node-label"><strong>{agent.name}</strong><em>{agent.capability}</em></span></button>;
}

type ClusterMarker = { id: string; position: { x: number; y: number }; count: number; capability: string };

function FieldClusterNode({ cluster, onSelect }: { cluster: ClusterMarker; onSelect: () => void }) {
  const tone = tones[cluster.capability] ?? "#C3A6FF";
  return <button type="button" onClick={onSelect} className="topology-cluster" aria-label={`Open ${cluster.count} agent cluster`} style={{ left: `${cluster.position.x}%`, top: `${cluster.position.y}%`, "--tone": tone } as CSSProperties}><span><Layers3 size={12} /></span><strong>{cluster.count}</strong><em>{cluster.capability}</em></button>;
}

function DeepClusterNode({ cluster, onSelect }: { cluster: ClusterMarker; onSelect: () => void }) {
  const tone = tones[cluster.capability] ?? "#C3A6FF";
  return <button type="button" onPointerDown={event => event.stopPropagation()} onClick={onSelect} className="deep-topology-cluster" aria-label={`Zoom into ${cluster.count} agent cluster`} style={{ left: `${cluster.position.x}%`, top: `${cluster.position.y}%`, "--tone": tone } as CSSProperties}><span><Layers3 size={14} /></span><strong>{cluster.count}</strong><em>{cluster.capability}</em></button>;
}

function IngressNode({ event, deep = false, sceneWidth = 0 }: { event: IngestionEvent; deep?: boolean; sceneWidth?: number }) {
  // The label goes beside the node on the side with more room and is cut to fit. Where the map's width is not known (the Deep map), it goes to the left on the right of the map.
  const x = (event.position.x / 100) * sceneWidth;
  const roomRight = sceneWidth - x - 30;
  const roomLeft = x - 30;
  const flip = sceneWidth > 0 ? roomRight < 200 && roomLeft > roomRight : event.position.x > 55;
  const labelWidth = sceneWidth > 0 ? Math.min(220, Math.max(105, Math.floor(flip ? roomLeft : roomRight))) : undefined;
  return <div key={event.id} className={cn("ingress-node", deep && "ingress-node-deep", flip && "ingress-node-flip")} style={{ left: `${event.position.x}%`, top: `${event.position.y}%`, "--ingress-tone": event.tone } as CSSProperties}><span className="ingress-trail" /><span className="ingress-core" /><span className="ingress-label" style={labelWidth ? { maxWidth: labelWidth } : undefined}><strong>{event.agent}</strong><em>NEW / {event.protocol}</em></span></div>;
}

function MissionTrail({ history, compact = false }: { history: HistoryEvent[]; compact?: boolean }) {
  return <div className={cn("mission-trail", compact && "mission-trail-compact")}><div className="flex items-center justify-between"><p className="eyebrow">Mission trail</p><span className="font-mono text-[9px] uppercase tracking-[.13em] text-[#819287]">Hover nodes</span></div><div className="trail-events">{history.map((event, index) => <div key={`${event.at}-${event.action}`} className="trail-event" tabIndex={0} aria-label={`${event.action}: ${event.detail}`}><span className="trail-rail"><i style={{ backgroundColor: event.tone, boxShadow: `0 0 10px ${event.tone}` }} /></span><span className="trail-tooltip"><span>Activity detail</span><strong>{event.action}</strong><em>{event.detail}</em></span><div><span className="trail-time">{event.at}</span><strong>{event.action}</strong><p>{event.detail}</p></div>{index < history.length - 1 && <span className="trail-dash" />}</div>)}</div></div>;
}

function ingressMatchesFramework(framework: string, protocol: string) {
  if (framework === "All protocols") return true;
  if (framework === "A2A Agent Card") return protocol.includes("A2A");
  if (framework === "ERC-8004 Identity") return protocol.includes("ERC-8004");
  if (framework === "AGNTCY Directory") return protocol.includes("AGNTCY");
  if (framework === "ANP JSON-LD") return protocol.includes("ANP");
  return false;
}

// Flow animation is the costliest paint on the field, so only a bounded sample of
// connection lines animates; the rest render as static strands.
const SIGNAL_ANIMATED_LINES = 14;
function signalLineTone(base: string, index: number, total: number) {
  const stride = Math.max(1, Math.ceil(total / SIGNAL_ANIMATED_LINES));
  if (index % stride !== 0) return `${base}-static`;
  return cn(base, index % 2 === 0 && `${base}-bright`);
}

/** The population card before the live read answers: the same shape as the static page in index.html, so no seed count is shown first. */
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

function SignalCell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="signal-cell"><span>{label}</span><strong className={mono ? "font-mono" : ""}>{value}</strong></div>;
}
