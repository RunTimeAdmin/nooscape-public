import { FLEET_MIN, LIGHT_CHAIN_ORDER, MAX_FLEETS, type Fleet, type NoosphereSample } from "@shared/noosphere";
import { CHAIN_STYLE, type MarkerShape } from "./constellationModel";
import { formatAsOf } from "./chainTabsModel";

/**
 * The Home hero: its words, and the arithmetic behind the field of lights it draws. Pure, so none of it needs
 * a browser to test. Every light comes from the Noosphere sample (liveData.noosphereSample), and where it sits
 * and how it looks depends only on what the sample holds: its hash, its chain, whether Nooscape has reviewed
 * evidence for it, and the fleet it belongs to. There is no input for a rank, a score or a payment.
 */

export const HERO_COPY = {
  headline: ["The Owl watches the Noosphere.", "Look up any agent. See what the evidence shows."],
  subcopy:
    "Nooscape watches the public agent registries on Solana, Robinhood Chain and BNB Chain, groups the copycat fleets, and keeps the evidence it can read, labeled by how much has been checked. Most records are listed only. A few are reviewed. No scores for sale. No rankings for hire.",
  primaryCta: "Ask the Owl",
  secondaryCta: "Explore the Noosphere",
} as const;

/** What the lights mean, in the words the legend uses. Light is evidence on record or fleet signals found, and says so. */
export const LEGEND = {
  steady: "Steady light: evidence on record.",
  fleet: "Dim cluster: a fleet, many agents from one registering wallet.",
  plain: "Faint light: registered, no evidence on record yet.",
  rule: "Light is evidence, not a score.",
} as const;

// ------------------------------------------------------------------- figures

/** The newest time any chain's source succeeded, from the chain stats rows, or null when none has. */
export function latestSweepAt(rows: ReadonlyArray<{ asOf: string | null }>): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (row.asOf === null || Number.isNaN(Date.parse(row.asOf))) continue;
    if (latest === null || Date.parse(row.asOf) > Date.parse(latest)) latest = row.asOf;
  }
  return latest;
}

export type ReadStatus = "loading" | "ready" | "unavailable";

/** A line of the form "Label: the rest" as its label and the rest (which keeps the colon), so the label can carry its definition. A line with no label has an empty one. */
export function splitLabel(line: string): { label: string; rest: string } {
  const colon = Math.max(0, line.indexOf(":"));
  return { label: line.slice(0, colon), rest: line.slice(colon) };
}

/** The line above the figures. The time is the last successful read of any chain, never the time the page loaded. */
export function sweepHeading(sweptAt: string | null, status: ReadStatus = "ready"): string {
  if (status === "loading") return "The Owl's last sweep: reading";
  if (status === "unavailable") return "The Owl's last sweep: unavailable right now";
  const when = formatAsOf(sweptAt);
  return when ? `The Owl's last sweep: ${when}` : "The Owl has not finished a sweep yet";
}

export type HeroFigure = { label: string; value: number };

/**
 * The three numbers under the buttons, each one a count the sample returned. With no fleet found the third is
 * a zero that says so, never a number borrowed from somewhere else.
 */
export function heroFigures(sample: NoosphereSample): HeroFigure[] {
  const largest = sample.fleets[0];
  return [
    { label: "registered agents indexed", value: sample.total },
    { label: "reviewed, with signed evidence kept", value: sample.steady },
    largest ? { label: "registered by the largest fleet's wallet", value: largest.size } : { label: `fleets of ${FLEET_MIN} or more found`, value: 0 },
  ];
}

/** How many fleets the sample names, said without overstating it: the list stops at MAX_FLEETS, so a full list is "the largest". */
export function fleetCountText(count: number): string {
  if (count <= 0) return `No fleets of ${FLEET_MIN} or more found`;
  if (count >= MAX_FLEETS) return `The ${count} largest fleets, each ${FLEET_MIN} agents or more`;
  return `${count} ${count === 1 ? "fleet" : "fleets"} of ${FLEET_MIN} agents or more`;
}

const count = (value: number) => value.toLocaleString("en-US");

/** What the radar sweep's tooltip says. The size is the directory's own count for that wallet, not the sample's. */
export function fleetSightedText(fleet: Pick<Fleet, "size">): string {
  return `Fleet sighted: ${count(fleet.size)} agents, same registering wallet`;
}

/** The caption under the field. N is what is drawn, so it is never claimed before the canvas has drawn it. */
export function sampleCaption(drawn: number, total: number): string {
  return `Sample of ${count(drawn)} of ${count(total)} registered agents`;
}

// ---------------------------------------------------------------- placement

export type LightKind = "steady" | "plain" | "fleet";
export type Depth = 0 | 1 | 2;
export type PlacedLight = {
  /** Pixels from the hero's top-left corner. */
  x: number;
  y: number;
  /** 0 far, 1 middle, 2 near: farther lights are smaller, fainter and move less. */
  depth: Depth;
  kind: LightKind;
  chain: "robinhood" | "solana" | "bnb" | "none";
  /** The chain's colour (index.css has the same values as tokens). */
  color: string;
  /** The chain's marker, which the steady lights are drawn as so colour is never the only signal. */
  shape: MarkerShape;
  /** Radius in pixels. */
  size: number;
  alpha: number;
  /** Which fleet it belongs to, from 1, or 0. */
  fleet: number;
  /** Offsets the slow drift so lights do not move together. */
  phase: number;
};

export type Box = { width: number; height: number };
/** A rectangle inside the hero, in pixels from its top-left corner. */
export type Rect = { x: number; y: number; width: number; height: number };

/** A 32-bit mix of a number with a seed, so two numbers drawn from one hash do not line up. */
function mix(value: number, seed: number): number {
  let h = (value ^ Math.imul(seed, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
const unit = (value: number, seed: number) => mix(value, seed) / 0x100000000;

const SIZE: Record<LightKind, readonly [number, number, number]> = { steady: [2.6, 3.4, 4.4], plain: [1, 1.5, 2], fleet: [1.1, 1.6, 2] };
const ALPHA: Record<LightKind, readonly [number, number, number]> = { steady: [0.8, 0.9, 1], plain: [0.45, 0.62, 0.8], fleet: [0.24, 0.32, 0.4] };
const EDGE = 8;

/**
 * How many lights to draw. A phone, a machine with few cores or little memory draws fewer, and the steady
 * lights, which are the reviewed records, are always among them.
 */
export function lightBudget(device: { cores?: number; memory?: number; coarse?: boolean }): number {
  if (device.coarse) return 600;
  const weak = (device.cores !== undefined && device.cores <= 4) || (device.memory !== undefined && device.memory <= 4);
  return weak ? 800 : 1500;
}

/** The lights that will be drawn: every steady one, then every n-th sampled one so the whole stays within the budget. */
function chosenLights(sample: NoosphereSample, budget: number) {
  const steady = sample.lights.slice(0, sample.steady);
  const sampled = sample.lights.slice(sample.steady);
  const room = Math.max(0, budget - steady.length);
  const stride = room > 0 && sampled.length > room ? Math.ceil(sampled.length / room) : 1;
  const kept = room === 0 ? [] : sampled.filter((_, index) => index % stride === 0);
  return [...steady, ...kept];
}

/** How many lights `placeLights` will return for this sample and budget, so a caption can say it before anything is placed. */
export const lightCount = (sample: NoosphereSample, budget: number) => chosenLights(sample, budget).length;

function depthFor(kind: LightKind, hash: number): Depth {
  const r = unit(hash, 5);
  if (kind === "steady") return r < 0.35 ? 1 : 2;
  if (kind === "fleet") return r < 0.6 ? 0 : 1;
  return r < 0.55 ? 0 : r < 0.9 ? 1 : 2;
}

/** A fleet's radius in pixels: a little larger for the bigger ones. */
export function fleetRadius(size: number, largest: number): number {
  return 26 + 34 * Math.sqrt(size / Math.max(1, largest));
}

/** The room a fleet's tooltip needs below its ring. */
export const SIGHTING_ROOM = 52;

/**
 * Where each fleet's centre goes: inside the reserved sky, clear of the others where it can be, and the same on
 * every visit. A centre keeps its ring and its tooltip inside the sky, so neither can land on the text.
 */
export function fleetCenters(fleets: readonly Fleet[], zone: Rect): Array<{ x: number; y: number; radius: number }> {
  const largest = fleets.reduce((max, fleet) => Math.max(max, fleet.size), 0);
  const placed: Array<{ x: number; y: number; radius: number }> = [];
  fleets.forEach((fleet, index) => {
    const radius = fleetRadius(fleet.size, largest);
    const key = fleet.wallet.split("").reduce((sum, character) => (Math.imul(sum, 31) + character.charCodeAt(0)) >>> 0, index + 1);
    const room = { x: zone.x + radius, y: zone.y + radius, width: Math.max(0, zone.width - 2 * radius), height: Math.max(0, zone.height - 2 * radius - SIGHTING_ROOM) };
    let best = { x: room.x + room.width / 2, y: room.y + room.height / 2, clearance: -Infinity };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const x = room.x + room.width * unit(key, 11 + attempt * 2);
      const y = room.y + room.height * unit(key, 12 + attempt * 2);
      const clearance = placed.reduce((least, other) => Math.min(least, Math.hypot(x - other.x, y - other.y) - radius - other.radius - 10), Infinity);
      if (clearance > best.clearance) best = { x, y, clearance };
      if (clearance >= 0) break;
    }
    placed.push({ x: best.x, y: best.y, radius });
  });
  return placed;
}

/**
 * Where each light sits, in pixels. The same sample gives the same places on every visit. Steady lights and
 * plain ones are spread over the whole hero; a fleet's lights are gathered around a centre of its own inside
 * `zone`, the sky reserved for them, which is what makes a dim cluster a cluster.
 */
export function placeLights(sample: NoosphereSample, budget: number, box: Box, zone: Rect): PlacedLight[] {
  const centers = fleetCenters(sample.fleets, zone);
  return chosenLights(sample, budget).map(light => {
    const [hash, chain, isSteady, fleet] = light;
    const kind: LightKind = isSteady ? "steady" : fleet > 0 && centers[fleet - 1] ? "fleet" : "plain";
    const depth = depthFor(kind, hash);
    let x: number;
    let y: number;
    if (kind === "fleet") {
      const center = centers[fleet - 1]!;
      const angle = unit(hash, 3) * Math.PI * 2;
      const distance = center.radius * Math.sqrt(unit(hash, 4));
      x = center.x + Math.cos(angle) * distance;
      y = center.y + Math.sin(angle) * distance;
    } else {
      x = EDGE + (box.width - 2 * EDGE) * unit(hash, 1);
      y = EDGE + (box.height - 2 * EDGE) * unit(hash, 2);
    }
    const key = LIGHT_CHAIN_ORDER[chain] ?? "none";
    const style = CHAIN_STYLE[key];
    return {
      x: Math.min(box.width - EDGE / 2, Math.max(EDGE / 2, x)),
      y: Math.min(box.height - EDGE / 2, Math.max(EDGE / 2, y)),
      depth,
      kind,
      chain: key,
      color: style.color,
      shape: style.shape,
      size: SIZE[kind][depth],
      alpha: ALPHA[kind][depth],
      fleet: kind === "fleet" ? fleet : 0,
      phase: unit(hash, 6) * Math.PI * 2,
    };
  });
}

export type LightGroup = { key: string; color: string; kind: LightKind; depth: Depth; size: number; alpha: number; items: PlacedLight[] };

/** The lights that look alike, so each group is one path and one fill. Steady lights are not grouped: each is its own shape. */
export function groupLights(lights: readonly PlacedLight[]): LightGroup[] {
  const groups = new Map<string, LightGroup>();
  for (const light of lights) {
    if (light.kind === "steady") continue;
    const key = `${light.color}/${light.kind}/${light.depth}`;
    const group = groups.get(key) ?? { key, color: light.color, kind: light.kind, depth: light.depth, size: light.size, alpha: light.alpha, items: [] };
    group.items.push(light);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

/** The middle of a fleet's drawn lights and how far they reach, in pixels, or null when none are drawn. */
export function fleetBounds(lights: readonly PlacedLight[], fleet: number): { x: number; y: number; radius: number; count: number } | null {
  const members = lights.filter(light => light.fleet === fleet);
  if (members.length === 0) return null;
  const x = members.reduce((sum, light) => sum + light.x, 0) / members.length;
  const y = members.reduce((sum, light) => sum + light.y, 0) / members.length;
  const radius = members.reduce((max, light) => Math.max(max, Math.hypot(light.x - x, light.y - y)), 0);
  return { x, y, radius, count: members.length };
}

// -------------------------------------------------------------------- motion

/** A loop of the drift takes at least thirty seconds at every depth, and a light never strays more than a few pixels. */
export const DRIFT_PERIOD_S = [64, 44, 32] as const;
export const DRIFT_RADIUS_PX = [2, 4, 7] as const;
/** The pointer moves the nearest lights by this much at most. */
export const PARALLAX_MAX_PX = 12;
const PARALLAX_BY_DEPTH = [0.25, 0.6, 1] as const;

/** `out` is written and returned, so a loop that moves every light each frame can reuse one object. */
export function driftOffset(light: Pick<PlacedLight, "depth" | "phase">, seconds: number, out = { dx: 0, dy: 0 }): { dx: number; dy: number } {
  const angle = (seconds / DRIFT_PERIOD_S[light.depth]) * Math.PI * 2 + light.phase;
  const radius = DRIFT_RADIUS_PX[light.depth];
  out.dx = Math.cos(angle) * radius;
  out.dy = Math.sin(angle) * radius * 0.8;
  return out;
}

/** `pointer` runs from -1 to 1 each way across the hero. */
export function parallaxOffset(pointer: { x: number; y: number }, depth: Depth): { dx: number; dy: number } {
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  const reach = PARALLAX_MAX_PX * PARALLAX_BY_DEPTH[depth];
  return { dx: -clamp(pointer.x) * reach, dy: -clamp(pointer.y) * reach };
}

// -------------------------------------------------------------------- sweep

export const SWEEP_EVERY_MS = 12_000;
export const SWEEP_LASTS_MS = 3_200;
/** The first sweep waits for the page to settle. */
export const SWEEP_FIRST_MS = 3_000;
/** A fleet needs at least this many drawn lights to be worth a sweep. */
export const SWEEP_MIN_LIGHTS = 3;

/** The fleets worth sweeping, biggest first: those with enough drawn lights to show. */
export function sweepOrder(lights: readonly PlacedLight[], fleets: readonly Fleet[]): number[] {
  return fleets
    .map((fleet, index) => ({ number: index + 1, size: fleet.size, drawn: lights.filter(light => light.fleet === index + 1).length }))
    .filter(entry => entry.drawn >= SWEEP_MIN_LIGHTS)
    .sort((a, b) => b.size - a.size || a.number - b.number)
    .map(entry => entry.number);
}

/** Which fleet is being swept at this moment, and how far through the sweep it is (0 to 1), or null between sweeps. */
export function activeSweep(order: readonly number[], elapsedMs: number): { fleet: number; progress: number } | null {
  const since = elapsedMs - SWEEP_FIRST_MS;
  if (order.length === 0 || since < 0) return null;
  const slot = Math.floor(since / SWEEP_EVERY_MS);
  const into = since - slot * SWEEP_EVERY_MS;
  if (into > SWEEP_LASTS_MS) return null;
  return { fleet: order[slot % order.length]!, progress: into / SWEEP_LASTS_MS };
}

/**
 * Where the sweep clock should sit to hold a sweep at its fullest: the middle of the sweep that `elapsedMs` is in,
 * or `elapsedMs` itself between sweeps. A visitor on the tooltip freezes the clock here, so the ring stays lit.
 */
export function sweepMiddle(elapsedMs: number): number {
  const since = elapsedMs - SWEEP_FIRST_MS;
  if (since < 0) return elapsedMs;
  const slot = Math.floor(since / SWEEP_EVERY_MS);
  if (since - slot * SWEEP_EVERY_MS > SWEEP_LASTS_MS) return elapsedMs;
  return SWEEP_FIRST_MS + slot * SWEEP_EVERY_MS + SWEEP_LASTS_MS / 2;
}

const smoothstep = (low: number, high: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

/** How strongly the swept cluster is dimmed and ringed: in over the first sixth of the sweep, out over the last. */
export function sweepEnvelope(progress: number): number {
  return smoothstep(0, 0.16, progress) * (1 - smoothstep(0.84, 1, progress));
}

/** With reduced motion nothing sweeps: one fleet, the biggest that is drawn, is simply marked. */
export function stillHighlight(order: readonly number[]): number | null {
  return order[0] ?? null;
}
