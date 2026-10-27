import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  Fingerprint,
  Info,
  Search,
  Shield,
  Sparkles,
  X,
} from "lucide-react";
import { listedChainLabel, type ChainStat, type ExtraChainStat } from "@shared/chains";
import { fleetFact, fleetNotProved, fleetOverlapNote, fleetShape, shortWallet } from "@shared/mapFleets";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { AgentTheater } from "@/components/chain/AgentTheater";
import { RegistrationShare } from "@/components/chain/RegistrationShare";
import { AgentFigure } from "@/components/chain/AgentFigure";
import { FormationMark } from "@/components/chain/FormationMark";
import { ChainEventRail } from "@/components/chain/ChainEventRail";
import {
  buildWorldEntities,
  CHAIN_GROUP_REPORT,
  CHAIN_IDENTITY_PROTOCOLS,
  CHAIN_SHOWS_ACKNOWLEDGED,
  CHAIN_WORLDS,
  ENTRY_EVENT_WORLDS,
  filterWorldEntities,
  formatObserved,
  normalizeEvmEvents,
  normalizeSolanaEvents,
  registrationShare,
  undrawnRegistryNote,
  worldEntityLabel,
  worldProtocolLabel,
  worldsOn,
  type AcknowledgedWorldRecord,
  type WorldKey,
} from "@/lib/chainExplorerModel";
import { groupSize } from "@/lib/chainWorldLayout";
import {
  asOfSentence,
  ratingsNote,
  registrySentence,
  registrySplitText,
} from "@/components/home/chainTabsModel";
import "@/components/chain/chainWorld.css";

const READ = {
  staleTime: 60_000,
  refetchOnWindowFocus: false,
  retry: false,
} as const;
const EMPTY_GROUPS = [] as const;
const NO_ENTRIES: readonly AcknowledgedWorldRecord[] = [];
// Arc, Base and Ethereum have a page only while their switches are in the build (shared/features.ts); the server answers 404 for them otherwise (server/clientRoutes.ts).
const FEATURES: string | undefined = import.meta.env.VITE_FEATURES;
function Figure({
  value,
  label,
  note,
}: {
  value: number | null | undefined;
  label: string;
  note: string;
}) {
  return (
    <div className="cw-stat" title={note}>
      <strong className={value == null ? "cw-unmeasured" : ""}>
        {value == null ? "Not measured" : value.toLocaleString()}
      </strong>
      <span>{label}</span>
    </div>
  );
}
export default function ChainExplorer({ chain }: { chain: WorldKey }) {
  const world = CHAIN_WORLDS[chain];
  // BNB Chain, Arc, Base and Ethereum have no global feed: an event is shown for the entry that is selected, from that entry's own activity.
  const entryEvents = ENTRY_EVENT_WORLDS.includes(chain);
  const entryProtocol = CHAIN_IDENTITY_PROTOCOLS[chain][0]!;
  const [query, setQuery] = useState("");
  const [protocol, setProtocol] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [motion, setMotion] = useState(true);
  const reduced = useReducedMotion();
  const searchRef = useRef<HTMLInputElement>(null);
  const settledQuery = useDebouncedValue(query.trim(), 350);
  const statsQuery = trpc.liveData.chainStats.useQuery(undefined, READ);
  const recordsQuery = trpc.liveData.publicRecords.useQuery(undefined, READ);
  const evmQuery = trpc.liveData.directoryActivityFeed.useQuery(undefined, {
    ...READ,
    enabled: chain === "robinhood",
  });
  const solanaQuery = trpc.liveData.directorySolanaActivity.useQuery(
    undefined,
    { ...READ, enabled: chain === "solana" }
  );
  // Arc, Base and Ethereum read their groups from their own registries (registryFleets); the other three from the map's reads.
  const registryWorld: "arc" | "base" | "ethereum" | null = chain === "arc" || chain === "base" || chain === "ethereum" ? chain : null;
  const fleetsQuery = trpc.liveData.mapFleets.useQuery(undefined, {
    ...READ,
    staleTime: 10 * 60_000,
    enabled: registryWorld === null,
  });
  const registryFleetsQuery = trpc.liveData.registryFleets.useQuery({ chain: registryWorld ?? "arc" }, { ...READ, staleTime: 10 * 60_000, enabled: registryWorld !== null });
  const arcSampleQuery = trpc.liveData.chainSample.useQuery({ chain: "arc" }, { ...READ, staleTime: 10 * 60_000, enabled: chain === "arc" });
  const searchQuery = trpc.liveData.directorySearch.useQuery(
    { query: settledQuery, limit: 25 },
    { ...READ, enabled: CHAIN_SHOWS_ACKNOWLEDGED[chain] && settledQuery.length >= 2 }
  );
  const stats: ChainStat | ExtraChainStat | undefined = statsQuery.data?.chains.find(row => row.chain === chain) ?? statsQuery.data?.extras?.find(row => row.chain === chain);
  const registry = stats && "registry" in stats ? stats.registry : null;
  const undrawnNote = undrawnRegistryNote(chain, stats?.registries);
  const baseEvents = useMemo(
    () =>
      chain === "robinhood"
        ? normalizeEvmEvents(evmQuery.data?.feed ?? [])
        : chain === "solana"
          ? normalizeSolanaEvents(solanaQuery.data?.feed ?? [])
          : [],
    [chain, evmQuery.data, solanaQuery.data]
  );
  const matches = useMemo(
    () => (CHAIN_SHOWS_ACKNOWLEDGED[chain] && settledQuery.length >= 2 ? (searchQuery.data?.entries ?? []) : []),
    [chain, searchQuery.data, settledQuery]
  );
  // Arc has no feed to draw its first figures from, so they are a fixed sample of the entries the directory lists; the search adds to them.
  const acknowledgements = useMemo(
    () => (chain === "arc" ? [...(arcSampleQuery.data?.entries ?? NO_ENTRIES), ...matches] : matches),
    [chain, arcSampleQuery.data, matches]
  );
  const groups = useMemo(
    () =>
      registryWorld !== null
        ? (registryFleetsQuery.data?.fleets ?? EMPTY_GROUPS)
        : chain === "bnb"
          ? (fleetsQuery.data?.fleets ?? EMPTY_GROUPS)
          : chain === "solana"
            ? (fleetsQuery.data?.solana?.fleets ?? EMPTY_GROUPS)
            : (fleetsQuery.data?.robinhood?.fleets ?? EMPTY_GROUPS),
    [chain, registryWorld, fleetsQuery.data, registryFleetsQuery.data]
  );
  const robinhoodLights = fleetsQuery.data?.robinhood;
  const arcFleets = registryFleetsQuery.data;
  // Robinhood Chain's share is of the entries the directory lists, Arc's of the registrations its registry holds: one figure from one read each.
  const share = useMemo(
    () =>
      chain === "robinhood"
        ? registrationShare(robinhoodLights?.fleets ?? EMPTY_GROUPS, robinhoodLights?.listed, robinhoodLights?.groups)
        : chain === "arc"
          ? registrationShare((arcFleets?.fleets ?? EMPTY_GROUPS).filter(fleet => fleet.kind === "wallet"), arcFleets?.recorded, arcFleets?.walletGroups)
          : null,
    [chain, robinhoodLights, arcFleets]
  );
  const shareAsOf = chain === "arc" ? (arcFleets?.asOf ?? null) : (robinhoodLights?.asOf ?? null);
  const entities = useMemo(
    () =>
      buildWorldEntities(
        chain,
        recordsQuery.data?.records ?? [],
        baseEvents,
        acknowledgements,
        groups
      ),
    [chain, recordsQuery.data, baseEvents, acknowledgements, groups]
  );
  const selected = entities.find(entity => entity.id === selectedId) ?? null;
  const profileQuery = trpc.liveData.agentProfile.useQuery(
    { id: selected?.id ?? "" },
    { ...READ, enabled: Boolean(selected && selected.kind !== "group") }
  );
  const events = useMemo(() => {
    if (!entryEvents) return baseEvents;
    const entry = profileQuery.data?.entry;
    if (
      !entry ||
      entry.protocol !== entryProtocol ||
      !entry.activity ||
      selected?.id !== entry.id
    )
      return [];
    return normalizeEvmEvents(
      entry.activity.events.map(event => ({
        ...event,
        entryId: entry.id,
        displayName: entry.displayName,
      })),
      entryProtocol
    );
  }, [entryEvents, entryProtocol, baseEvents, profileQuery.data, selected?.id]);
  const selectedEntry = profileQuery.data?.entry;
  const entryMatches = Boolean(
    selected && selected.kind !== "group" && selectedEntry?.id === selected.id
  );
  const visibleEntities = useMemo(
    () => filterWorldEntities(entities, query, protocol),
    [entities, query, protocol]
  );
  const activeEvent = events.find(event => event.id === activeEventId) ?? null;
  // Historical selection always stays in the theater even when a text filter would hide it.
  const stageEntities = useMemo(() => {
    const focused = activeEvent
      ? entities.find(entity => entity.id === activeEvent.entryId)
      : null;
    return focused && !visibleEntities.some(entity => entity.id === focused.id)
      ? [focused, ...visibleEntities]
      : visibleEntities;
  }, [activeEvent, entities, visibleEntities]);
  const protocols = Array.from(
    new Set(entities.map(entity => entity.protocol))
  );
  const sceneStatus =
    statsQuery.isLoading || recordsQuery.isLoading || (registryWorld !== null && registryFleetsQuery.isLoading) || (chain === "arc" && arcSampleQuery.isLoading)
      ? "loading"
      : !stats || statsQuery.isError
        ? "unavailable"
        : !stats.indexed
          ? "not-indexed"
          : "ready";
  const feedLoading =
    chain === "robinhood"
      ? evmQuery.isLoading
      : chain === "solana"
        ? solanaQuery.isLoading
        : Boolean(
            selected && selected.kind !== "group" && profileQuery.isLoading
          );
  const feedError =
    chain === "robinhood"
      ? evmQuery.isError
      : chain === "solana"
        ? solanaQuery.isError
        : profileQuery.isError;
  const feedStatus = feedLoading
    ? "loading"
    : feedError
      ? "unavailable"
      : !entryEvents
        ? "ready"
        : !selected || selected.kind === "group"
          ? "unsupported"
          : !entryMatches ||
              selectedEntry?.protocol !== entryProtocol ||
              !selectedEntry.activity
            ? "unmeasured"
            : "ready";
  const coverage =
    chain === "robinhood"
      ? evmQuery.data?.totals?.measuredThroughBlock != null
        ? `Measured through block ${evmQuery.data.totals.measuredThroughBlock.toLocaleString()}`
        : "High-water block not measured"
      : chain === "solana"
        ? "Anchored transactions · observation slots"
        : !selected || selected.kind === "group"
          ? "Global feed not published"
          : entryMatches && selectedEntry?.activity
            ? "Selected entry · oldest 24 events at most"
            : "Selected entry · activity not measured";

  useEffect(() => {
    setQuery("");
    setProtocol("all");
    setSelectedId(null);
    setActiveEventId(null);
    setPlaying(false);
  }, [chain]);
  useEffect(() => {
    if (!playing || events.length === 0 || reduced) return;
    // Explicit replay, not a real-time simulation. Stops at the newest indexed event.
    const timer = window.setTimeout(() => {
      if (document.hidden) {
        setPlaying(false);
        return;
      }
      const index = events.findIndex(event => event.id === activeEventId);
      const next = events[index + 1];
      if (next) setActiveEventId(next.id);
      else setPlaying(false);
    }, 3200);
    return () => window.clearTimeout(timer);
  }, [playing, events, activeEventId, reduced]);
  useEffect(() => {
    if (reduced && playing) setPlaying(false);
  }, [reduced, playing]);
  useEffect(() => {
    if (playing && events.length === 0) setPlaying(false);
  }, [events.length, playing]);
  const selectEvent = (id: string) => {
    setActiveEventId(id);
    setPlaying(false);
    const event = events.find(item => item.id === id);
    if (event) setSelectedId(event.entryId);
  };
  const selectEntity = (id: string | null) => {
    setSelectedId(id);
    setActiveEventId(null);
    setPlaying(false);
  };
  const startReplay = () => {
    if (reduced) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (!events.length) return;
    if (
      activeEventId === null ||
      activeEventId === events[events.length - 1]?.id
    )
      setActiveEventId(events[0]!.id);
    setPlaying(true);
  };
  return (
    <div
      className="cw-page"
      style={
        {
          "--cw-accent": world.accent,
          "--cw-secondary": world.secondary,
        } as CSSProperties
      }
    >
      <header className="cw-topbar">
        <Link href="/" className="cw-brand">
          <img src="/favicon.svg" alt="" />
          <span>
            <strong>Nooscape</strong>
            <small>Open agent observatory</small>
          </span>
        </Link>
        <Link className="cw-back" href="/">
          <ArrowLeft size={13} aria-hidden="true" /> Back to the observatory
        </Link>
      </header>
      <main className="cw-main">
        <div className="cw-breadcrumb">
          <Link href="/">Observatory</Link>
          <ChevronRight size={10} aria-hidden="true" />
          <span>Chain Worlds</span>
          <ChevronRight size={10} aria-hidden="true" />
          <span>{listedChainLabel(chain)}</span>
        </div>
        <div className="cw-header">
          <div>
            <p className="cw-small-label">
              WORLD {world.number} / {listedChainLabel(chain).toUpperCase()}
            </p>
            <h1 className="cw-title">
              {world.title.split(" ").slice(0, -1).join(" ")}{" "}
              <span>{world.title.split(" ").at(-1)}</span>
            </h1>
            <p className="cw-description">
              {world.subtitle} {world.description}
              {undrawnNote && ` ${undrawnNote}`}
            </p>
          </div>
          <div className="cw-header-stamp">
            <strong>
              {sceneStatus === "ready"
                ? "SOURCE-BACKED EXPLORATION"
                : sceneStatus === "loading"
                  ? "READING THE INDEX"
                  : "NO DATA INVENTED"}
            </strong>
            {chain === "bnb" || chain === "base" || chain === "ethereum" ? "Formations are illustrations." : chain === "arc" ? "Characters and formations are illustrations." : "Characters are illustrations."}
            <br />
            {chain === "bnb" || chain === "arc" || chain === "base" || chain === "ethereum" ? "Counts are Nooscape’s grouping of the registry." : "Activity comes from the ledgers."}
          </div>
        </div>
        <nav className="cw-navigation" aria-label="Chain worlds">
          {worldsOn(FEATURES).map(key => (
            <Link
              key={key}
              href={`/chains/${key}`}
              className="cw-chain-link"
              aria-current={key === chain ? "page" : undefined}
              style={
                { "--link-accent": CHAIN_WORLDS[key].accent } as CSSProperties
              }
            >
              <span>{CHAIN_WORLDS[key].number}</span>
              {listedChainLabel(key)}
              <ArrowUpRight size={12} aria-hidden="true" />
            </Link>
          ))}
          <span className="cw-navigation-note">
            <Shield size={12} aria-hidden="true" /> Same public rules. Every
            chain.
          </span>
        </nav>
        <div className="cw-stats" aria-label="Chain figures">
          <Figure
            value={stats?.acknowledged}
            label="Acknowledged entries"
            note="Source-listed entries, not endorsements."
          />
          <Figure
            value={stats?.reviewed}
            label="Reviewed records"
            note="Public records with retained reviewed evidence."
          />
          <Figure
            value={stats?.feedbackEvents}
            label="Ratings recorded"
            note={ratingsNote(chain)}
          />
          <div
            className="cw-small-label"
            style={{ marginLeft: "auto", alignSelf: "center", maxWidth: 300 }}
          >
            {stats
              ? asOfSentence(stats.asOf)
              : statsQuery.isLoading
                ? "Reading source coverage…"
                : "Chain figures are unavailable."}
            {stats && registrySplitText(stats.registries) && (
              <>
                <br />
                {registrySplitText(stats.registries)}
              </>
            )}
          </div>
        </div>
        {registrySentence(registry) && <p className="cw-registry-sentence">{registrySentence(registry)}</p>}
        {share && (chain === "robinhood" || chain === "arc") && <RegistrationShare chain={chain} share={share} asOf={shareAsOf} selectedId={selectedId} onSelect={selectEntity} />}
        {sceneStatus === "not-indexed" && (
          <p className="cw-notice">
            No active approved source indexes this chain yet. No figures or
            agents are substituted.
          </p>
        )}
        <div className="cw-workspace">
          <div className="cw-world-column">
            <div className="cw-controls">
              <label className="cw-search">
                <Search size={14} aria-hidden="true" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder={!CHAIN_SHOWS_ACKNOWLEDGED[chain] ? "Find a group, host or wallet…" : "Find an identity, name or registry…"}
                  aria-label="Search this chain's visible records"
                  maxLength={64}
                />
              </label>
              {protocols.length > 1 && (
                <select
                  aria-label="Filter by registry"
                  value={protocol}
                  onChange={event => setProtocol(event.target.value)}
                >
                  <option value="all">All registries</option>
                  {protocols.map(item => (
                    <option key={item} value={item}>
                      {worldProtocolLabel(item)}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="cw-motion"
                aria-pressed={motion && !reduced}
                disabled={reduced}
                onClick={() => setMotion(value => !value)}
              >
                <Sparkles size={13} aria-hidden="true" />
                {reduced
                  ? "Reduced motion"
                  : motion
                    ? "Ambient motion on"
                    : "Ambient motion off"}
              </button>
            </div>
            {settledQuery.length >= 2 && !CHAIN_SHOWS_ACKNOWLEDGED[chain] && (
              <p className="cw-search-note">Search matches the groups and reviewed records on this page. {listedChainLabel(chain)}’s individual registrations are not drawn.</p>
            )}
            {settledQuery.length >= 2 && CHAIN_SHOWS_ACKNOWLEDGED[chain] && (
              <p className="cw-search-note">
                {searchQuery.isFetching
                  ? "Searching visible directory entries…"
                  : searchQuery.data &&
                      "busy" in searchQuery.data &&
                      searchQuery.data.busy
                    ? "Directory search is busy. Local matches remain available."
                    : "Search adds matching visible directory entries. The world shows only this chain’s matches, not the whole registry."}
              </p>
            )}
            <AgentTheater
              chain={chain}
              entities={sceneStatus === "ready" ? stageEntities : []}
              registries={stats?.registries}
              selectedId={selectedId}
              onSelect={selectEntity}
              event={activeEvent}
              motion={motion}
              status={sceneStatus}
            />
            <div className="cw-explanation">
              <Info size={13} aria-hidden="true" />
              <p>
                {!CHAIN_SHOWS_ACKNOWLEDGED[chain]
                  ? `Each stack is a group of registrations that share one fact, not an agent. Its size grows with the log of its count and says nothing else. Motion is illustrative. Individual ${listedChainLabel(chain)} registrations are not drawn.`
                  : "Motion is illustrative, not agent behavior. Hollow, dashed figures are acknowledged identities, not reviewed agents. Stacked formations are registration groups, not individuals. A replay highlights a recorded registry event, not a conversation or proof of work."}
              </p>
            </div>
            {selected ? (
              <section className="cw-inspector" aria-label="Selected record">
                <div className="cw-inspector-figure">
                  {selected.kind === "group" ? (
                    <FormationMark shape={fleetShape(selected.fleet ?? undefined)} size={groupSize(selected.count ?? 1)} tone={world.accent} />
                  ) : (
                    <AgentFigure
                      agentId={selected.id}
                      tone={world.accent}
                      kind={selected.kind}
                      large
                    />
                  )}
                </div>
                <div className="cw-inspector-content">
                  <span className="cw-small-label">
                    {worldEntityLabel(selected)}
                  </span>
                  <h2>{selected.name}</h2>
                  <p>{selected.detail}</p>
                  <div className="cw-inspector-meta">
                    <span>{worldProtocolLabel(selected.protocol)}</span>
                    {selected.sourceCount != null && (
                      <span>
                        {selected.sourceCount} approved{" "}
                        {selected.sourceCount === 1 ? "source" : "sources"}
                      </span>
                    )}
                    {selected.evidenceTier && (
                      <span>{selected.evidenceTier.replace(/_/g, " ")}</span>
                    )}
                  </div>
                  {selected.observedAt && (
                    <p>
                      Last recorded observation:{" "}
                      <time dateTime={selected.observedAt}>
                        {formatObserved(selected.observedAt) ?? selected.observedAt}
                      </time>
                    </p>
                  )}
                  {selected.kind === "group" && selected.fleet ? (
                    <>
                      <p className="cw-inspector-status">{fleetFact(selected.fleet)}</p>
                      <div className="cw-group-facts">
                        <p>
                          <strong>What this does not show.</strong> {fleetNotProved(selected.fleet)}
                        </p>
                        <p>
                          A group is not an agent and is not reviewed. Nooscape holds no evidence tier for it and draws none of its registrations.{" "}
                          {fleetOverlapNote(selected.fleet)}
                        </p>
                        {selected.fleet.wallet && (
                          <p className="cw-figure-wallet">
                            {selected.fleet.chain === "solana" ? "Owner wallet" : "Registering wallet"}{" "}
                            <span title={selected.fleet.wallet}>{shortWallet(selected.fleet.wallet)}</span>
                          </p>
                        )}
                      </div>
                      {CHAIN_GROUP_REPORT[chain] && (
                        <Link href={CHAIN_GROUP_REPORT[chain]!.href} className="cw-inspector-link">
                          {CHAIN_GROUP_REPORT[chain]!.label} <ArrowUpRight size={13} />
                        </Link>
                      )}
                    </>
                  ) : (
                    <>
                      <p className="cw-inspector-status">
                        {selected.kind === "acknowledged"
                          ? "Registration does not establish operator identity, quality, or current availability."
                          : "A reviewed record is not a guarantee of safety or successful work."}
                      </p>
                      <Link
                        href={`/agents/${encodeURIComponent(selected.id)}`}
                        className="cw-inspector-link"
                      >
                        Open full evidence dossier <ArrowUpRight size={13} />
                      </Link>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="cw-inspector-close"
                  aria-label="Clear selected record"
                  onClick={() => selectEntity(null)}
                >
                  <X size={17} />
                </button>
              </section>
            ) : (
              <div className="cw-empty-inspector">
                <Fingerprint size={26} />
                <span>
                  Select a figure to meet its record.
                  <br />
                  <span className="cw-small-label">
                    Arrow keys explore the crew · Enter selects · Escape clears
                  </span>
                </span>
              </div>
            )}
            <details className="cw-loaded-list">
              <summary>
                Browse all {visibleEntities.length} loaded records in this view
              </summary>
              <div className="cw-list-grid">
                {visibleEntities.map(entity => (
                  <button
                    key={entity.id}
                    type="button"
                    aria-pressed={entity.id === selectedId}
                    onClick={() => selectEntity(entity.id)}
                  >
                    <span>{entity.name}</span>
                    <span className="cw-small-label">
                      {entity.kind === "group" ? "group" : entity.kind}
                    </span>
                  </button>
                ))}
              </div>
            </details>
          </div>
          <aside className="cw-sidebar">
            <ChainEventRail
              chain={chain}
              events={sceneStatus === "ready" ? events : []}
              activeId={activeEventId}
              onSelect={selectEvent}
              playing={playing}
              onTogglePlayback={startReplay}
              motionReduced={reduced}
              status={
                sceneStatus === "loading"
                  ? "loading"
                  : sceneStatus !== "ready"
                    ? "unavailable"
                    : feedStatus
              }
              coverage={coverage}
            />
            {chain === "solana" && (
              <p className="cw-explanation">
                Slots are the observing pass’s slots; Nooscape-observed times
                are not transaction timestamps.
              </p>
            )}
            {chain === "robinhood" && (
              <p className="cw-explanation">
                Identity events only. Reputation is inspectable in individual
                dossiers. USDG settlements are not attributed to agents.
              </p>
            )}
          </aside>
        </div>
        <footer className="cw-footer">
          <span>
            NOOSCAPE / CHAIN WORLDS · Registration ≠ endorsement · Events ≠
            conversations
          </span>
          <span>
            <Link href="/sources">Sources & methodology</Link> ·{" "}
            <Link href="/field">The full field</Link> ·{" "}
            <Link href="/verify">Verify evidence</Link>
          </span>
        </footer>
      </main>
    </div>
  );
}
