import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Maximize2, Minus, Plus, RotateCcw, Orbit } from "lucide-react";
import { compactCount, fleetShape, shortWallet } from "@shared/mapFleets";
import { placementHash } from "@shared/noosphere";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { CHAIN_WORLDS, WORLD_ARRANGEMENT, worldCrew, worldEntityLabel, worldProtocolLabel, worldZones, type ChainWorldEntity, type ChainWorldEvent, type WorldKey, type WorldZone } from "@/lib/chainExplorerModel";
import { allocateFigures, composeWorld, groupSize, MAX_GROUPS_SHOWN } from "@/lib/chainWorldLayout";
import { AgentFigure } from "./AgentFigure";
import { FormationMark } from "./FormationMark";
import "./chainWorld.css";

type Props = {
  chain: WorldKey;
  entities: readonly ChainWorldEntity[];
  /** What each registry lists, for the name of a Solana lane. */
  registries?: ReadonlyArray<{ protocol: string; count: number }>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  event: ChainWorldEvent | null;
  motion: boolean;
  status: "loading" | "ready" | "unavailable" | "not-indexed";
};

const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-4)}`;
const NO_REGISTRIES: ReadonlyArray<{ protocol: string; count: number }> = [];

export function AgentTheater({ chain, entities, registries = NO_REGISTRIES, selectedId, onSelect, event, motion, status }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [width, setWidth] = useState(980);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const reduced = useReducedMotion();
  const world = CHAIN_WORLDS[chain];
  const moving = motion && visible && !reduced;

  const zones = useMemo(() => worldZones(chain, entities, registries), [chain, entities, registries]);
  // How many figures each zone may show at this width decides who stands on the stage; then the zones are set out for exactly those.
  const scene = useMemo(() => {
    const slots = allocateFigures(width, zones.map(zone => ({ id: zone.id, available: zone.figures.length })));
    const crews = zones.map(zone => ({ zone, groups: zone.groups.slice(0, MAX_GROUPS_SHOWN), crew: worldCrew(zone.figures, selectedId, event?.entryId ?? null, slots[zone.id] ?? 0) }));
    const composition = composeWorld({
      width,
      arrangement: WORLD_ARRANGEMENT[chain],
      zones: crews.map(({ zone, groups, crew }) => ({ id: zone.id, groups: groups.map(group => ({ id: group.id, size: groupSize(group.count ?? 1) })), figureIds: crew.map(figure => figure.id) })),
    });
    const spots = new Map([...composition.groups, ...composition.figures].map(item => [item.id, item] as const));
    const byZone = new Map(crews.map(entry => [entry.zone.id, entry] as const));
    const items: Array<{ entity: ChainWorldEntity; zone: WorldZone }> = composition.zones.flatMap(placed => {
      const entry = byZone.get(placed.id)!;
      return [...entry.groups, ...entry.crew].map(entity => ({ entity, zone: entry.zone }));
    });
    return { composition, spots, items, figures: crews.reduce((sum, entry) => sum + entry.crew.length, 0), formations: crews.reduce((sum, entry) => sum + entry.groups.length, 0) };
  }, [chain, width, zones, selectedId, event?.entryId]);
  const { composition, spots, items } = scene;
  const zoneById = useMemo(() => new Map(zones.map(zone => [zone.id, zone] as const)), [zones]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let intersecting = true;
    const update = () => setVisible(intersecting && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false;
      update();
    });
    observer.observe(element);
    const resize = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    resize.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      resize.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [chain]);

  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
    if (forward || backward || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (forward ? 1 : -1) + items.length) % items.length;
      ref.current?.querySelector<HTMLButtonElement>(`[data-crew-index="${next}"]`)?.focus();
    } else if (event.key === "Escape") onSelect(null);
  };

  return (
    <div
      ref={ref}
      className={`cw-theater${expanded ? " cw-theater-expanded" : ""}${dragging ? " cw-dragging" : ""}${moving ? "" : " cw-motion-paused"}`}
      style={expanded ? undefined : { height: composition.height }}
      data-chain={chain}
      data-motion={moving ? "on" : "off"}
      aria-label={`${world.terrain}, interactive registry visualization`}
      onKeyDown={event => {
        if (event.key === "Escape" && expanded) setExpanded(false);
      }}
    >
      <div className="cw-theater-hud">
        <span className="cw-hud-title">
          <Orbit size={13} aria-hidden="true" /> <span className="cw-hud-terrain">{world.terrain} · </span>
          {world.registry}
        </span>
        <div className="cw-camera" aria-label="Scene camera">
          <button type="button" aria-label="Zoom in" onClick={() => setZoom(value => Math.min(1.65, value + 0.15))} disabled={zoom >= 1.65}>
            <Plus size={16} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Zoom out" onClick={() => setZoom(value => Math.max(0.75, value - 0.15))} disabled={zoom <= 0.75}>
            <Minus size={16} />
          </button>
          <button
            type="button"
            aria-label="Reset view"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            <RotateCcw size={15} />
          </button>
          <button type="button" aria-label={expanded ? "Exit expanded scene" : "Expand scene"} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>
            <Maximize2 size={15} />
          </button>
        </div>
      </div>
      <div
        className="cw-scene-viewport"
        onPointerDown={event => {
          if ((event.target as HTMLElement).closest("button, a")) return;
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          if (!drag.current) return;
          const dx = event.clientX - drag.current.x;
          const dy = event.clientY - drag.current.y;
          if (Math.abs(dx) + Math.abs(dy) > 5) {
            drag.current.moved = true;
            setDragging(true);
          }
          if (drag.current.moved)
            setPan({
              x: Math.max(-180, Math.min(180, drag.current.panX + dx)),
              y: Math.max(-140, Math.min(140, drag.current.panY + dy)),
            });
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        <div className="cw-world-space" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          <Landscape chain={chain} />
          {composition.zones.map(placed => {
            const zone = zoneById.get(placed.id);
            return (
              <div key={placed.id} className="cw-zone" data-zone={placed.id} style={{ left: placed.x, top: placed.y, width: placed.w, height: placed.h }} aria-hidden="true">
                <span className="cw-zone-label">{zone?.label}</span>
                {zone?.sublabel && <span className="cw-zone-sub">{zone.sublabel}</span>}
              </div>
            );
          })}
          {items.map(({ entity, zone }, index) => {
            const spot = spots.get(entity.id);
            if (!spot) return null;
            const selected = selectedId === entity.id;
            const traced = event?.entryId === entity.id;
            const hash = placementHash(entity.id);
            const isGroup = entity.kind === "group";
            // A wallet formation is labelled by its short address: the kind is in the card and the plate.
            const label = isGroup && entity.fleet?.kind === "wallet" && entity.fleet.wallet ? shortWallet(entity.fleet.wallet) : entity.name;
            const edge = spot.x < composition.width * 0.18 ? "left" : spot.x > composition.width * 0.82 ? "right" : undefined;
            return (
              <button
                type="button"
                key={entity.id}
                data-crew-index={index}
                data-zone={zone.id}
                data-edge={edge}
                className={`cw-entity cw-entity-${entity.kind}${isGroup ? "" : " cw-entity-figure"}${selected ? " cw-selected" : ""}${traced ? " cw-traced" : ""}`}
                style={
                  {
                    left: `${spot.x}px`,
                    top: `${spot.y}px`,
                    "--cw-phase": `${(hash % 100) * -0.21}s`,
                    "--cw-drift": `${11 + (hash % 3) * 3}s`,
                  } as CSSProperties
                }
                aria-label={
                  isGroup
                    ? `${entity.name}, ${(entity.count ?? 0).toLocaleString("en-US")} registrations, ${worldEntityLabel(entity)}, in ${zone.label}. Inspect group.`
                    : `${entity.name}, ${worldEntityLabel(entity)}, in ${zone.label}. Inspect record.`
                }
                aria-pressed={selected}
                onKeyDown={event => keyboard(event, index)}
                onClick={() => onSelect(selected ? null : entity.id)}
              >
                {isGroup ? (
                  <>
                    <span className="cw-entity-character cw-entity-formation" aria-hidden="true">
                      <FormationMark shape={fleetShape(entity.fleet ?? undefined)} size={groupSize(entity.count ?? 1)} tone={world.accent} />
                    </span>
                    <span className="cw-entity-name">{label}</span>
                    <span className="cw-group-count">
                      <strong>{compactCount(entity.count ?? 0)}</strong>
                      registrations
                    </span>
                  </>
                ) : (
                  <>
                    <span className="cw-entity-platform" aria-hidden="true" />
                    <span className="cw-entity-character">
                      <AgentFigure agentId={entity.id} tone={world.accent} kind={entity.kind === "reviewed" ? "reviewed" : "acknowledged"} />
                    </span>
                    {/* A scout's name is shown for the one under the pointer or focus and for the selected one, so a crowd of them never runs its labels together. */}
                    <span className="cw-entity-tag" aria-hidden="true">
                      <strong>{entity.name}</strong>
                      <span>{`${worldProtocolLabel(entity.protocol)} · ${entity.kind === "reviewed" ? "reviewed" : "not reviewed"}`}</span>
                    </span>
                  </>
                )}
                {traced && <span className="cw-trace-label">{event.label}</span>}
              </button>
            );
          })}
        </div>
      </div>
      {(status !== "ready" || items.length === 0) && (
        <div className="cw-scene-empty" role="status">
          <Orbit size={32} />
          <h3>
            {status === "loading"
              ? "Reading this sky…"
              : status === "not-indexed"
                ? "This sky is not indexed yet"
                : status === "unavailable"
                  ? "The records are unavailable"
                  : "Nothing to draw in this view"}
          </h3>
          <p>{status === "loading" ? "Only source-backed records will appear." : "The world stays empty rather than inventing agents. Try another filter or chain."}</p>
        </div>
      )}
      {event && (
        <div className="cw-scene-event" key={event.id}>
          <span className="cw-event-beacon" aria-hidden="true" />
          <div className="cw-scene-event-text">
            <span className="cw-small-label">
              RECORDED EVENT / {event.heightLabel.toUpperCase()} {event.height.toLocaleString()}
            </span>
            <strong>
              {event.name} <span>· {event.label}</span>
            </strong>
            {event.kind === "transfer" && event.from && event.to && (
              <span className="cw-scene-event-trace" title={`${event.from} to ${event.to}`}>
                RECORDED OWNERSHIP CHANGE / NOT A MESSAGE · From {short(event.from)} To {short(event.to)}
              </span>
            )}
          </div>
        </div>
      )}
      <div className="cw-theater-footer">
        <span>
          {scene.figures} figures · {scene.formations} formations · {entities.length} records in this view · symbolic space, not geography
        </span>
        <span>{scene.figures > 0 ? "Hover or focus a scout for its name" : "Select a formation for its card"} · drag to pan</span>
      </div>
    </div>
  );
}

/** The ground of a world, drawn behind everything: a fog, some stars and a few lines of perspective, and for Robinhood Chain the rings of an orbit. Decoration only: the plates carry the meaning. */
function Landscape({ chain }: { chain: WorldKey }) {
  const world = CHAIN_WORLDS[chain];
  return (
    <svg className="cw-landscape" viewBox="0 0 1000 670" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id={`cw-fog-${chain}`}>
          <stop stopColor={world.accent} stopOpacity=".11" />
          <stop offset="1" stopColor={world.accent} stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="500" cy="385" rx="530" ry="360" fill={`url(#cw-fog-${chain})`} />
      {Array.from({ length: 40 }, (_, index) => (
        <circle key={index} cx={(index * 173 + 29) % 1000} cy={(index * 127 + 71) % 490} r={index % 7 === 0 ? 1.8 : 0.8} fill={index % 3 === 0 ? world.secondary : "#dcece5"} opacity={0.15 + (index % 4) * 0.07} />
      ))}
      <g stroke={world.accent} fill="none" strokeWidth=".7" opacity=".14">
        {Array.from({ length: 13 }, (_, index) => (
          <path key={`ray-${index}`} d={`M 500 230 L ${-550 + index * 175} 740`} />
        ))}
        {[280, 325, 380, 450, 540, 655].map(y => (
          <path key={y} d={`M 0 ${y} Q 500 ${y - 95} 1000 ${y}`} />
        ))}
      </g>
      {chain === "robinhood" && (
        <g fill="none" stroke={world.accent}>
          <ellipse cx="500" cy="405" rx="350" ry="180" strokeOpacity=".15" />
          <ellipse cx="500" cy="405" rx="440" ry="230" strokeDasharray="2 16" strokeOpacity=".25" />
          <ellipse cx="500" cy="405" rx="245" ry="130" strokeOpacity=".12" />
        </g>
      )}
    </svg>
  );
}
