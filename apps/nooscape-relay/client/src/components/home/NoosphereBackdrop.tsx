import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { NoosphereSample } from "@shared/noosphere";
import { markerPath, type MarkerShape } from "./constellationModel";
import {
  activeSweep,
  driftOffset,
  fleetBounds,
  groupLights,
  lightBudget,
  parallaxOffset,
  placeLights,
  stillHighlight,
  sweepEnvelope,
  sweepMiddle,
  sweepOrder,
  type LightGroup,
  type PlacedLight,
  type Rect,
} from "./heroModel";

/** The fleet being swept (or marked, with reduced motion) and where its ring is, in pixels from the hero's corner. */
export type Sighting = { fleet: number; x: number; y: number; radius: number };

type Props = {
  sample: NoosphereSample;
  /** The hero: watched for being on screen and for changing size. */
  hostRef: RefObject<HTMLElement | null>;
  /** The sky reserved for fleets, so their rings and tooltip land clear of the text. */
  skyRef: RefObject<HTMLElement | null>;
  /** True while a visitor is on the tooltip: the sweep holds at its fullest. */
  holdRef: RefObject<boolean>;
  reduced: boolean;
  coarse: boolean;
  onDrawn: (count: number) => void;
  onSighted: (sighting: Sighting | null) => void;
};

const TAU = Math.PI * 2;
const AMBER = "#FFB547";
/** The canvas never holds more pixels than this, so a large or sharp screen draws it a little softer instead of slower. */
const MAX_PIXELS = 3_200_000;
/** A phone gets a third of that: the hero is tall there, and its canvas is the whole of it. */
const MAX_PIXELS_TOUCH = 1_000_000;
/** The drift is a few pixels a minute and the sweep is smooth at this rate, so the field is drawn 30 times a second, and 15 when drawing is slow. */
const FRAME_MS = 1000 / 30;
const SLOW_FRAME_GAP_MS = 1000 / 15;
/** Longer than this for a frame's drawing, on average, and the canvas draws half as often. */
const SLOW_FRAME_MS = 9;

function glowSprite(color: string): HTMLCanvasElement {
  const size = 64;
  const sprite = document.createElement("canvas");
  sprite.width = size;
  sprite.height = size;
  const context = sprite.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `${color}cc`);
    gradient.addColorStop(0.3, `${color}44`);
    gradient.addColorStop(1, `${color}00`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  return sprite;
}

/**
 * The field of lights behind the hero: one canvas, one animation-frame loop. The lights are the Noosphere sample,
 * placed by heroModel, and the loop only moves them a few pixels (drift and pointer parallax) and, every twelve
 * seconds, rings one real fleet. It stops while the hero is off screen or the tab is hidden, and with reduced
 * motion it draws one still frame and never starts. Returns the function that tears it down.
 */
function mountNoosphere({ canvas, host, sky, sample, budget, reduced, coarse, holdRef, onDrawn, onSighted }: {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  sky: HTMLElement | null;
  sample: NoosphereSample;
  budget: number;
  reduced: boolean;
  coarse: boolean;
  holdRef: RefObject<boolean>;
  onDrawn: (count: number) => void;
  onSighted: (sighting: Sighting | null) => void;
}): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => {};
  const ctx = context;

  const paths = Object.fromEntries((["circle", "diamond", "square", "triangle"] as const).map(shape => [shape, new Path2D(markerPath(shape))])) as Record<MarkerShape, Path2D>;
  const sprites = new Map<string, HTMLCanvasElement>();
  const spriteFor = (color: string) => {
    let sprite = sprites.get(color);
    if (!sprite) {
      sprite = glowSprite(color);
      sprites.set(color, sprite);
    }
    return sprite;
  };

  let width = 0;
  let height = 0;
  let scale = 1;
  let zone: Rect = { x: 0, y: 0, width: 0, height: 0 };
  let groups: LightGroup[] = [];
  let steadyLights: PlacedLight[] = [];
  let order: number[] = [];
  let still: number | null = null;
  const bounds = new Map<number, { x: number; y: number; radius: number }>();

  let driftMs = 0;
  let sweepMs = 0;
  let holding = false;
  let sighted: number | null = null;
  let reportedCount = false;
  const pointer = { x: 0, y: 0 };
  const eased = { x: 0, y: 0 };
  const scratch = { dx: 0, dy: 0 };

  const report = (fleet: number | null) => {
    if (fleet === sighted) return;
    sighted = fleet;
    const at = fleet === null ? undefined : bounds.get(fleet);
    onSighted(fleet !== null && at ? { fleet, x: at.x, y: at.y, radius: at.radius } : null);
  };

  const draw = () => {
    const seconds = driftMs / 1000;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width, height);

    const sweep = reduced ? (still === null ? null : { fleet: still, progress: 0.5 }) : activeSweep(order, sweepMs);
    const swept = sweep ? sweep.fleet : 0;
    const dim = sweep ? sweepEnvelope(sweep.progress) : 0;
    const shift = [parallaxOffset(eased, 0), parallaxOffset(eased, 1), parallaxOffset(eased, 2)];
    let px = 0;
    let py = 0;
    const place = (light: PlacedLight) => {
      if (reduced) {
        px = light.x;
        py = light.y;
        return;
      }
      driftOffset(light, seconds, scratch);
      const parallax = shift[light.depth]!;
      px = light.x + scratch.dx + parallax.dx;
      py = light.y + scratch.dy + parallax.dy;
    };

    for (const group of groups) {
      ctx.fillStyle = group.color;
      ctx.globalAlpha = group.alpha;
      ctx.beginPath();
      for (const light of group.items) {
        if (swept !== 0 && light.fleet === swept) continue;
        place(light);
        ctx.moveTo(px + group.size, py);
        ctx.arc(px, py, group.size, 0, TAU);
      }
      ctx.fill();
      if (swept !== 0 && group.kind === "fleet") {
        ctx.globalAlpha = group.alpha * (1 - 0.7 * dim);
        ctx.beginPath();
        for (const light of group.items) {
          if (light.fleet !== swept) continue;
          place(light);
          ctx.moveTo(px + group.size, py);
          ctx.arc(px, py, group.size, 0, TAU);
        }
        ctx.fill();
      }
    }

    if (steadyLights.length > 0) {
      ctx.globalCompositeOperation = "lighter";
      for (const light of steadyLights) {
        place(light);
        const reach = light.size * 5;
        ctx.globalAlpha = 0.5 * light.alpha;
        ctx.drawImage(spriteFor(light.color), px - reach, py - reach, reach * 2, reach * 2);
      }
      ctx.globalCompositeOperation = "source-over";
      for (const light of steadyLights) {
        place(light);
        ctx.setTransform(scale * light.size, 0, 0, scale * light.size, scale * px, scale * py);
        ctx.globalAlpha = light.alpha;
        ctx.fillStyle = light.color;
        ctx.fill(paths[light.shape]);
      }
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
    }

    const ring = sweep ? bounds.get(sweep.fleet) : undefined;
    if (sweep && ring) {
      const reach = ring.radius + 14;
      const grow = 1 - Math.pow(1 - Math.min(1, sweep.progress / 0.3), 3);
      ctx.strokeStyle = AMBER;
      ctx.fillStyle = AMBER;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.9 * dim;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, reach * (0.75 + 0.25 * grow), 0, TAU);
      ctx.stroke();
      if (!reduced) {
        const angle = sweep.progress * TAU * 1.5 - Math.PI / 2;
        ctx.globalAlpha = 0.16 * dim;
        ctx.beginPath();
        ctx.moveTo(ring.x, ring.y);
        ctx.arc(ring.x, ring.y, reach, angle - 0.9, angle);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.7 * dim;
        ctx.beginPath();
        ctx.moveTo(ring.x, ring.y);
        ctx.lineTo(ring.x + Math.cos(angle) * reach, ring.y + Math.sin(angle) * reach);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  };

  /** Reads the canvas's size (it runs edge to edge, wider than the hero's column) and the sky's place, and places the lights again when either has changed. */
  const measure = () => {
    const canvasBox = canvas.getBoundingClientRect();
    const nextWidth = Math.round(canvasBox.width);
    const nextHeight = Math.round(canvasBox.height);
    if (nextWidth < 2 || nextHeight < 2) return;
    const skyBox = sky?.getBoundingClientRect();
    const usable = skyBox && skyBox.width >= 120 && skyBox.height >= 120;
    const nextZone: Rect = usable
      ? { x: skyBox.left - canvasBox.left, y: skyBox.top - canvasBox.top, width: skyBox.width, height: skyBox.height }
      : { x: nextWidth * 0.6, y: nextHeight * 0.45, width: nextWidth * 0.36, height: nextHeight * 0.48 };
    const same = nextWidth === width && nextHeight === height && nextZone.x === zone.x && nextZone.y === zone.y && nextZone.width === zone.width && nextZone.height === zone.height;
    if (same) return;
    width = nextWidth;
    height = nextHeight;
    zone = nextZone;
    scale = Math.max(0.75, Math.min(window.devicePixelRatio || 1, 2, Math.sqrt((coarse ? MAX_PIXELS_TOUCH : MAX_PIXELS) / (width * height))));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);

    const lights = placeLights(sample, budget, { width, height }, zone);
    groups = groupLights(lights);
    steadyLights = lights.filter(light => light.kind === "steady");
    order = sweepOrder(lights, sample.fleets);
    still = stillHighlight(order);
    bounds.clear();
    for (const number of order) {
      const at = fleetBounds(lights, number);
      if (at) bounds.set(number, at);
    }
    // A ring that is showing has moved with the resize.
    const showing = sighted;
    sighted = null;
    if (reduced) report(still);
    else if (showing !== null) report(showing);
    draw();
    if (!reportedCount) {
      reportedCount = true;
      onDrawn(lights.length);
      canvas.dataset.ready = "true";
    }
  };

  let measureFrame = 0;
  const scheduleMeasure = () => {
    if (measureFrame) return;
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      measure();
    });
  };

  // ---- the loop (not started with reduced motion)
  let frame = 0;
  let running = false;
  let last = 0;
  let lastDrawAt = 0;
  let slow = false;
  let cost = 0;
  const onPointer = (event: PointerEvent) => {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
  };
  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    const step = Math.min(64, now - last);
    last = now;
    driftMs += step;
    if (holdRef.current) {
      if (!holding) sweepMs = sweepMiddle(sweepMs);
      holding = true;
    } else {
      holding = false;
      sweepMs += step;
    }
    const follow = Math.min(1, step / 220);
    eased.x += (pointer.x - eased.x) * follow;
    eased.y += (pointer.y - eased.y) * follow;
    if (now - lastDrawAt < (slow ? SLOW_FRAME_GAP_MS : FRAME_MS) - 4) return;
    lastDrawAt = now;
    const started = performance.now();
    draw();
    cost += (performance.now() - started - cost) * 0.1;
    if (cost > SLOW_FRAME_MS) slow = true;
    report(activeSweep(order, sweepMs)?.fleet ?? null);
  };

  let onScreen = true;
  const sync = () => {
    const shouldRun = onScreen && !document.hidden && !reduced;
    if (shouldRun && !running) {
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(tick);
      if (!coarse) window.addEventListener("pointermove", onPointer, { passive: true });
    } else if (!shouldRun && running) {
      running = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointer);
    }
  };

  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
  resize?.observe(host);
  resize?.observe(canvas);
  if (sky) resize?.observe(sky);
  const visibility = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
    onScreen = entries[entries.length - 1]?.isIntersecting ?? true;
    sync();
  });
  visibility?.observe(host);
  document.addEventListener("visibilitychange", sync);
  measure();
  sync();

  return () => {
    running = false;
    cancelAnimationFrame(frame);
    cancelAnimationFrame(measureFrame);
    window.removeEventListener("pointermove", onPointer);
    document.removeEventListener("visibilitychange", sync);
    resize?.disconnect();
    visibility?.disconnect();
    onSighted(null);
  };
}

/** Draws the Noosphere sample on a canvas behind the hero. Decoration: hidden from assistive technology, and the facts it shows are also in text. */
export default function NoosphereBackdrop({ sample, hostRef, skyRef, holdRef, reduced, coarse, onDrawn, onSighted }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const budget = useMemo(
    () => lightBudget({ cores: navigator.hardwareConcurrency, memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory, coarse }),
    [coarse],
  );

  // `onDrawn` and `onSighted` are state setters in the hero, so they never change and never restart the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    return mountNoosphere({ canvas, host, sky: skyRef.current, sample, budget, reduced, coarse, holdRef, onDrawn, onSighted });
  }, [sample, budget, reduced, coarse, hostRef, skyRef, holdRef, onDrawn, onSighted]);

  return <canvas ref={canvasRef} className="hero-canvas" aria-hidden="true" />;
}
