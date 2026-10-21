import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { compactCount, fleetShape, type FleetShape } from "@shared/mapFleets";
import { useOwl } from "@/contexts/OwlContext";
import { usePointerKind } from "@/hooks/usePointerKind";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import {
  buildNodeGrid,
  CHAIN_STYLE,
  chainStyleKey,
  constellationSummary,
  fleetReach,
  isAcknowledged,
  isFleet,
  layoutNodes,
  markerPath,
  nearestLinks,
  nearestNodeInGrid,
  neighborInDirection,
  truncateLabel,
  type ConstellationNode,
  type ConstellationRecord,
  type Direction,
  type MarkerShape,
} from "./constellationModel";

type Props = {
  records: readonly ConstellationRecord[];
  /** The record the pointer, the owl or the keyboard is over right now. */
  scannedId: string | null;
  onScan: (id: string | null) => void;
  /** The record that stays selected until it is cleared. */
  pinnedId: string | null;
  onPin: (id: string | null) => void;
  /** The record the card is showing, drawn with a ring. */
  selectedId: string | null;
};

/** How close the scan point has to be to a dot, in pixels. */
const SCAN_RADIUS = { fine: 44, coarse: 56 } as const;
/** The brand accent, for the ring on the selected record. It is the same colour as --ns-radar in index.css. */
const SELECTED_RING = "#7CF5C8";

/** One path per shape, drawn at unit size and scaled per dot. */
const MARKERS: Record<MarkerShape, Path2D> = {
  circle: new Path2D(markerPath("circle")),
  diamond: new Path2D(markerPath("diamond")),
  square: new Path2D(markerPath("square")),
  triangle: new Path2D(markerPath("triangle")),
  dome: new Path2D(markerPath("dome")),
};

const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** The red, green and blue of a #RRGGBB colour, for the translucent fills of a light. */
const rgbOf = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** The outline of a light centred on a point: a circle, a diamond, a hexagon or a dome, whose points are `reach` away. It leaves the path ready to fill or stroke. */
function lightOutline(context: CanvasRenderingContext2D, x: number, y: number, reach: number, shape: FleetShape) {
  context.beginPath();
  if (shape === "circle") {
    context.arc(x, y, reach, 0, Math.PI * 2);
    return;
  }
  if (shape === "dome") {
    // A half circle on its base, set so the middle of its height is the light's centre.
    context.arc(x, y + reach * 0.5, reach, Math.PI, 0);
    context.closePath();
    return;
  }
  if (shape === "hexagon") {
    // Pointed at the top and the bottom, so it is not mistaken for the square that marks a BNB Chain dot.
    for (let corner = 0; corner < 6; corner += 1) {
      const angle = -Math.PI / 2 + (corner * Math.PI) / 3;
      if (corner === 0) context.moveTo(x + reach * Math.cos(angle), y + reach * Math.sin(angle));
      else context.lineTo(x + reach * Math.cos(angle), y + reach * Math.sin(angle));
    }
    context.closePath();
    return;
  }
  context.moveTo(x, y - reach);
  context.lineTo(x + reach, y);
  context.lineTo(x, y + reach);
  context.lineTo(x - reach, y);
  context.closePath();
}

/**
 * The map of reviewed records, and beside them the acknowledged entries the page hands it, drawn hollow. The scan point is the owl's feet when the owl is on (and on this page), and
 * otherwise the pointer. A click or tap pins the record under it; the arrow keys move between records, Enter pins
 * and Escape clears. One animation frame loop draws it, and it stops while the map is off screen or the tab is
 * hidden. Nothing in the loop reads the layout: sizes and the canvas's position are cached by observers and
 * scroll and resize handlers.
 */
export function AgentConstellation({ records, scannedId, onScan, pinnedId, onPin, selectedId }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { enabled: owlEnabled, position, scanning } = useOwl();
  const reducedMotion = useReducedMotion();
  const coarse = usePointerKind() === "coarse";
  // The latest of everything the loop reads, so the loop itself never restarts for a re-render.
  // Laid out for the shape the canvas actually has, so dots keep their spacing on a phone as well as a wide screen.
  const [aspect, setAspect] = useState(2);
  const nodes = useMemo(() => layoutNodes(records, aspect), [records, aspect]);
  // The faint links join the dots only. The fleet lights come after the dots in `nodes`, so the indices still match.
  const links = useMemo(() => nearestLinks(nodes.filter(node => !isFleet(node)), aspect), [nodes, aspect]);
  const live = useRef({ nodes, links, scannedId, pinnedId, selectedId, onScan, onPin, owlOn: owlEnabled, coarse, reducedMotion });
  live.current = { nodes, links, scannedId, pinnedId, selectedId, onScan, onPin, owlOn: owlEnabled, coarse, reducedMotion };
  const [focusId, setFocusId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusableId = focusId !== null && nodes.some(node => node.id === focusId) ? focusId : (nodes[0]?.id ?? null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!wrap || !canvas || !context) return;

    let width = 0;
    let height = 0;
    let ratio = 1;
    let rect = { left: 0, top: 0 };
    let visible = true;
    let pointer: { x: number; y: number } | null = null;
    let last: string | null = null;
    let frame = 0;
    // The grid is rebuilt when the nodes or the size change, never per frame.
    let grid = buildNodeGrid([], 1, 1, SCAN_RADIUS.coarse);
    let gridFor: { nodes: readonly ConstellationNode[]; width: number; height: number } | null = null;
    const gridAt = (current: readonly ConstellationNode[]) => {
      if (!gridFor || gridFor.nodes !== current || gridFor.width !== width || gridFor.height !== height) {
        grid = buildNodeGrid(current, width, height, SCAN_RADIUS.coarse);
        gridFor = { nodes: current, width, height };
      }
      return grid;
    };

    const measure = () => {
      const box = wrap.getBoundingClientRect();
      rect = { left: box.left, top: box.top };
      return box;
    };
    const resize = () => {
      const box = measure();
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = box.width;
      height = box.height;
      if (width > 0 && height > 0) setAspect(Math.min(3, Math.max(0.75, Math.round((width / height) * 4) / 4)));
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    const intersection = new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? true;
    });
    intersection.observe(wrap);
    const onScroll = () => {
      measure();
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    const onPointerMove = (event: PointerEvent) => {
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onPointerLeave = (event: PointerEvent) => {
      // A finger lifting is not the pointer leaving: the tapped record stays scanned.
      if (event.pointerType !== "touch") pointer = null;
    };
    const onPointerDown = (event: PointerEvent) => {
      // A tap scans where it lands; scrolling is left alone.
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    // A click (a tap, on a touch screen) pins the record under it, and pins it off again. A scroll is not a click.
    const onClick = (event: MouseEvent) => {
      const { nodes: current, pinnedId: pinned, onPin: pin, coarse: touch } = live.current;
      measure();
      const hit = nearestNodeInGrid(gridAt(current), event.clientX - rect.left, event.clientY - rect.top, SCAN_RADIUS[touch ? "coarse" : "fine"]);
      if (hit) pin(hit.id === pinned ? null : hit.id);
    };
    canvas.addEventListener("pointermove", onPointerMove, { passive: true });
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("pointerdown", onPointerDown, { passive: true });
    canvas.addEventListener("click", onClick);

    const label = (node: ConstellationNode, x: number, y: number) => {
      // A fleet light is a group, so its label gives the group and its count, never a chain-and-agent line.
      const text = isFleet(node) ? `${truncateLabel(node.name, 22)} · ${compactCount(node.fleet?.count ?? 0)}` : `${truncateLabel(node.name, 24)} · ${CHAIN_STYLE[chainStyleKey(node)].label.toUpperCase()}`;
      context.font = '12px "DM Mono", ui-monospace, monospace';
      const boxWidth = context.measureText(text).width + 16;
      const boxHeight = 24;
      const reach = isFleet(node) ? fleetReach(node.fleet) + 6 : 14;
      // On the side with room, and kept inside the canvas whichever side that is.
      const left = Math.max(2, Math.min(width - boxWidth - 2, x + reach + boxWidth > width ? x - reach - boxWidth : x + reach));
      const top = Math.max(2, Math.min(height - boxHeight - 2, y - boxHeight / 2));
      context.fillStyle = "rgba(5,7,10,0.92)";
      context.strokeStyle = "rgba(148,180,220,0.35)";
      context.lineWidth = 1;
      context.beginPath();
      context.roundRect(left, top, boxWidth, boxHeight, 8);
      context.fill();
      context.stroke();
      context.fillStyle = "#E8EEF5";
      context.textBaseline = "middle";
      context.fillText(text, left + 8, top + boxHeight / 2 + 0.5);
    };

    const draw = (now: number) => {
      const { nodes: current, links: joins, scannedId: scanned, pinnedId: pinned, selectedId: selected, onScan: report, owlOn, coarse: touch, reducedMotion: still } = live.current;
      if (visible && !document.hidden) {
        // Where the scan point is, in canvas pixels: the owl's feet, or the pointer.
        let point: { x: number; y: number } | null = null;
        if (owlOn) point = { x: position.current.x - rect.left, y: position.current.y - rect.top };
        else if (pointer) point = pointer;
        const inside = point !== null && point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height;
        const hit = inside && point ? nearestNodeInGrid(gridAt(current), point.x, point.y, SCAN_RADIUS[touch ? "coarse" : "fine"]) : null;
        // A keyboard-focused record keeps the scan until focus leaves, so the loop does not clear it.
        if (!(scanned !== null && hit === null && document.activeElement instanceof HTMLButtonElement && document.activeElement.dataset.constellationNode === scanned)) {
          const id = hit?.id ?? null;
          if (id !== last) {
            last = id;
            report(id);
          }
        }
        scanning.current = owlOn && hit !== null;

        context.clearRect(0, 0, width, height);
        // Faint links from each dot to its neighbours give the map its constellation look; they carry no meaning.
        context.lineWidth = 1;
        context.strokeStyle = "rgba(102,232,255,0.16)";
        context.beginPath();
        for (const [from, to] of joins) {
          const a = current[from]!;
          const b = current[to]!;
          context.moveTo(a.x * width, a.y * height);
          context.lineTo(b.x * width, b.y * height);
        }
        context.stroke();

        let labelled: ConstellationNode | null = null;
        let pinnedNode: ConstellationNode | null = null;
        // The fleet lights first, so the dots stay readable on top of them. Each is one circle for one group, and the count is written under it.
        for (const node of current) {
          if (!isFleet(node)) continue;
          const x = node.x * width;
          const y = node.y * height;
          const style = CHAIN_STYLE[chainStyleKey(node)];
          // A BNB Chain group is a circle, a Solana owner wallet a diamond, a Robinhood Chain registering wallet a hexagon, an Arc group a dome; each in its chain's colour, which for a circle is the amber it always was.
          const shape = fleetShape(node.fleet);
          const radius = fleetReach(node.fleet);
          const [red, green, blue] = rgbOf(style.color);
          const hot = node.id === scanned;
          const chosen = node.id === selected;
          if (hot) labelled = node;
          if (node.id === pinned) pinnedNode = node;
          const pulse = still ? 0 : Math.sin(now / 1400 + node.x * 9) * 0.06;
          const glow = context.createRadialGradient(x, y, radius * 0.3, x, y, radius * 1.9);
          glow.addColorStop(0, `rgba(${red},${green},${blue},0.30)`);
          glow.addColorStop(1, `rgba(${red},${green},${blue},0)`);
          context.globalAlpha = hot || chosen ? 1 : 0.9 + pulse;
          context.fillStyle = glow;
          context.beginPath();
          context.arc(x, y, radius * 1.9, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = `rgba(${red},${green},${blue},0.14)`;
          lightOutline(context, x, y, radius, shape);
          context.fill();
          context.strokeStyle = style.color;
          context.lineWidth = hot || chosen ? 2.4 : 1.6;
          context.stroke();
          context.fillStyle = style.color;
          lightOutline(context, x, y, radius * 0.28, shape);
          context.fill();
          context.globalAlpha = 1;
          context.font = '600 11px "DM Mono", ui-monospace, monospace';
          context.textAlign = "center";
          context.textBaseline = "top";
          context.lineWidth = 3;
          context.strokeStyle = "rgba(5,8,10,0.9)";
          const text = compactCount(node.fleet?.count ?? 0);
          context.strokeText(text, x, y + radius + 3);
          context.fillStyle = style.color;
          context.fillText(text, x, y + radius + 3);
          context.textAlign = "left";
          if (hot) {
            context.globalAlpha = 0.5;
            context.strokeStyle = style.color;
            context.lineWidth = 1.5;
            context.beginPath();
            context.arc(x, y, radius + 6, 0, Math.PI * 2);
            context.stroke();
          }
          if (chosen) {
            context.globalAlpha = 1;
            context.strokeStyle = SELECTED_RING;
            context.lineWidth = 2;
            context.beginPath();
            context.arc(x, y, radius + 5, 0, Math.PI * 2);
            context.stroke();
          }
          context.globalAlpha = 1;
        }
        for (const node of current) {
          if (isFleet(node)) continue;
          const x = node.x * width;
          const y = node.y * height;
          const style = CHAIN_STYLE[chainStyleKey(node)];
          const hot = node.id === scanned;
          const chosen = node.id === selected;
          if (hot) labelled = node;
          if (node.id === pinned) pinnedNode = node;
          const twinkle = still ? 0 : Math.sin(now / 900 + node.x * 40 + node.y * 25) * 0.12;
          const size = hot || chosen ? 5.2 : 3.6;
          context.globalAlpha = hot || chosen ? 1 : 0.78 + twinkle;
          context.fillStyle = style.color;
          context.strokeStyle = style.color;
          context.save();
          context.translate(x, y);
          context.scale(size, size);
          // An acknowledged entry is only an outline: the directory lists it and Nooscape has not reviewed it.
          if (isAcknowledged(node)) {
            context.lineWidth = 0.4;
            context.stroke(MARKERS[style.shape]);
          } else {
            context.fill(MARKERS[style.shape]);
          }
          context.restore();
          if (hot) {
            // A glow in the record's own chain colour: where the scan is.
            context.globalAlpha = 0.5;
            context.strokeStyle = style.color;
            context.lineWidth = 1.5;
            context.beginPath();
            context.arc(x, y, 13, 0, Math.PI * 2);
            context.stroke();
          }
          if (chosen) {
            // The ring on the record the card shows: brand colour, so it reads whatever the chain colour is.
            context.globalAlpha = 1;
            context.strokeStyle = SELECTED_RING;
            context.lineWidth = 2;
            context.beginPath();
            context.arc(x, y, 10, 0, Math.PI * 2);
            context.stroke();
          }
        }
        context.globalAlpha = 1;
        if (pinnedNode && pinnedNode !== labelled) label(pinnedNode, pinnedNode.x * width, pinnedNode.y * height);
        if (labelled) label(labelled, labelled.x * width, labelled.y * height);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
      window.removeEventListener("scroll", onScroll);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("click", onClick);
      scanning.current = false;
    };
  }, [position, scanning]);

  const focusNode = (id: string) => {
    setFocusId(id);
    listRef.current?.querySelector<HTMLButtonElement>(`button[data-constellation-node="${CSS.escape(id)}"]`)?.focus();
  };

  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    const current = (event.target as HTMLElement).dataset.constellationNode ?? focusableId;
    if (event.key in ARROWS) {
      const next = current ? neighborInDirection(nodes, current, ARROWS[event.key]!, aspect) : null;
      event.preventDefault();
      if (next) focusNode(next);
    } else if (event.key === "Home") {
      event.preventDefault();
      if (nodes[0]) focusNode(nodes[0].id);
    } else if (event.key === "End") {
      event.preventDefault();
      if (nodes.length > 0) focusNode(nodes[nodes.length - 1]!.id);
    } else if (event.key === "Escape") {
      // Clears the pin and the scan, and leaves the focus where it is.
      onPin(null);
      onScan(null);
    }
  };

  const summary = useMemo(() => constellationSummary(nodes), [nodes]);
  return (
    <div>
      <div ref={wrapRef} className="relative h-[340px] w-full overflow-hidden rounded-2xl border border-white/[0.09] bg-[#05080A] focus-within:shadow-[0_0_0_2px_var(--ns-radar)] sm:h-[420px]">
        <canvas ref={canvasRef} role="img" aria-label={summary} aria-describedby="map-keys" className="absolute inset-0 h-full w-full touch-pan-y" />
        {/* The same records as a list a keyboard can reach: one tab stop, arrow keys between neighbours on the map, Enter to pin. It sits inside the map so the map shows the focus. */}
        <ul ref={listRef} className="sr-only" aria-label="Records and groups on the map" onKeyDown={move}>
          {nodes.map(node => (
            <li key={node.id}>
              <button
                type="button"
                data-constellation-node={node.id}
                aria-pressed={node.id === pinnedId}
                tabIndex={node.id === focusableId ? 0 : -1}
                onFocus={() => {
                  setFocusId(node.id);
                  onScan(node.id);
                }}
                onBlur={() => onScan(null)}
                onClick={() => onPin(node.id === pinnedId ? null : node.id)}
              >
                {isFleet(node)
                  ? node.fleet?.chain === "robinhood"
                    ? `${node.name}, a registering wallet recorded against ${(node.fleet?.count ?? 0).toLocaleString("en-US")} registrations on ${CHAIN_STYLE[chainStyleKey(node)].label}, not an agent`
                    : node.fleet?.chain === "solana"
                      ? `${node.name}, an owner wallet that holds ${(node.fleet?.count ?? 0).toLocaleString("en-US")} registrations on ${CHAIN_STYLE[chainStyleKey(node)].label}, not an agent`
                      : `${node.name}, a group of ${(node.fleet?.count ?? 0).toLocaleString("en-US")} registrations on ${CHAIN_STYLE[chainStyleKey(node)].label} that share one fact, not an agent`
                  : `${node.name}, ${CHAIN_STYLE[chainStyleKey(node)].label}, ${node.protocol}, ${isAcknowledged(node) ? "acknowledged, not reviewed" : node.tier.replace("_", " ")}`}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p id="map-keys" className="mt-2 text-xs leading-5 text-ns-ink-dim">
        Click or tap a light to pin it. By keyboard: tab to the map, arrow keys to move, Enter to pin, Escape to clear.
      </p>
    </div>
  );
}
