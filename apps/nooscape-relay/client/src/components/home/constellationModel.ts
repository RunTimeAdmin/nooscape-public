/**
 * What the Home constellation is made of, and the arithmetic around it: where each
 * reviewed record sits, which one the scan point is over, and what the scanner says.
 * Pure, so none of it needs a browser to test.
 *
 * Nearly every node is a reviewed public record from `liveData.publicRecords`. Its tier is that
 * record's own `evidenceTier`, and its chain is the one its own protocol list names. The only other
 * node is an acknowledged entry from `liveData.mapAcknowledged`: a registration the directory lists
 * and Nooscape has not reviewed. It has no tier and no evidence, is drawn hollow, and is counted and
 * named apart from the reviewed ones. The third kind of node is a fleet light from `liveData.mapFleets`: on BNB Chain one
 * large circle for a group of registrations that share a wallet, a link, a host or a template, and on Solana one large
 * diamond for an owner wallet a registry records for many registrations, each with its count. It is a group and never an
 * agent, and no single BNB Chain registration is drawn. Nothing here invents an agent, scores one, or lets anything but
 * those facts decide how it looks.
 */

import { CHAIN_LABEL, chainOf, EXTRA_CHAIN_LABEL, listedChainLabel, parseProtocolList, type ChainKey } from "@shared/chains";
import { ARC_LIGHTS_LIMIT, fleetKindLabel, fleetShape, fleetTitle, type MapFleet, type MapFleets, type RegistryFleets } from "@shared/mapFleets";

export const MAX_NODES = 400;

/** What a node stands for: a reviewed record, an entry the directory lists that Nooscape has not reviewed, or a group of registrations that share one fact (BNB Chain), or are held by one owner wallet (Solana). */
export type ConstellationKind = "reviewed" | "acknowledged" | "fleet";
/** The tier an acknowledged entry carries on the map, so nothing reads it as one of the reviewed tiers. */
export const ACKNOWLEDGED_TIER = "acknowledged";
export const isAcknowledged = (node: Pick<ConstellationNode, "kind">) => node.kind === "acknowledged";
/** The tier a fleet light carries, so nothing reads it as one of the reviewed tiers. */
export const FLEET_TIER = "fleet";
export const isFleet = (node: Pick<ConstellationNode, "kind">) => node.kind === "fleet";

/** The chains a node of the map can be on: the original three, and Arc, whose groups have lights while its switch is on. */
export type MapChainKey = ChainKey | "arc";

/** The protocol a light sits on, which gives its node the chain it is drawn in: BNB Chain for the groups, the registry's own for a Solana owner wallet, Robinhood Chain's for a registering wallet, Arc's for an Arc group. */
const lightProtocol = (fleet: MapFleet) =>
  fleet.chain === "arc" ? "erc8004_arc" : fleet.chain === "robinhood" ? "erc8004" : fleet.chain === "solana" ? (fleet.registry === "8004" ? "solana_8004" : "solana_registry") : "erc8004_bsc";

/**
 * The Arc lights: the largest groups of the Arc page's, whatever their kind, at most {@link ARC_LIGHTS_LIMIT}, the largest first. A group
 * is the same fact the page draws, so the map and the page cannot disagree about it.
 */
export function arcLights(arc: Pick<RegistryFleets, "fleets"> | null | undefined): MapFleet[] {
  return [...(arc?.fleets ?? [])].sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, ARC_LIGHTS_LIMIT);
}

/** The fleets as nodes for the map: the group's own title, its kind in words, the chain's protocol, and marked as a fleet. BNB Chain groups first, then the Solana owner wallets, the Robinhood Chain registering wallets and the Arc groups. */
export function fleetRecords(sample: MapFleets | null | undefined, arc: Pick<RegistryFleets, "fleets"> | null | undefined = null): ConstellationRecord[] {
  // `solana` is read defensively: a map must never fail to draw because an answer lacks a field.
  return [...(sample?.fleets ?? []), ...(sample?.solana?.fleets ?? []), ...(sample?.robinhood?.fleets ?? []), ...arcLights(arc)].map(fleet => ({
    agentId: fleet.id,
    displayName: fleetTitle(fleet),
    handle: fleetKindLabel(fleet),
    protocols: JSON.stringify([lightProtocol(fleet)]),
    evidenceTier: FLEET_TIER,
    kind: "fleet" as const,
    fleet,
  }));
}

/** The radius of a fleet light in pixels: it grows with the log of the count, between 8 and 24. The size says how many, nothing else. */
export function fleetRadius(count: number): number {
  return Math.min(24, Math.max(8, 8 + 3.2 * Math.log10(Math.max(1, count))));
}

/** How far a light reaches from its centre, in pixels: its radius, and a Solana diamond's points a fifth further, so placement and drawing leave the same room. */
export function fleetReach(fleet: Pick<MapFleet, "chain" | "count"> | undefined): number {
  const radius = fleetRadius(fleet?.count ?? 1);
  return fleet?.chain === "solana" ? radius * 1.2 : radius;
}

/** What `liveData.mapAcknowledged` answers: a fixed sample of the entries the directory lists on one chain, and how many it lists in all. */
export type AcknowledgedSample = {
  entries: readonly { id: string; displayName: string; locatorHost: string | null; protocol: string }[];
  listed: number;
};

/** The sample as records for the map: the link host where a handle goes, the entry's own protocol, no tier, and marked acknowledged. */
export function acknowledgedRecords(sample: AcknowledgedSample | null | undefined): ConstellationRecord[] {
  return (sample?.entries ?? []).map(entry => ({
    agentId: entry.id,
    displayName: entry.displayName,
    handle: entry.locatorHost ?? "",
    protocols: JSON.stringify([entry.protocol]),
    evidenceTier: ACKNOWLEDGED_TIER,
    kind: "acknowledged" as const,
  }));
}

export type ConstellationRecord = {
  agentId: string;
  displayName: string;
  handle: string;
  protocols: string;
  evidenceTier: string;
  /** When the record was last observed (ISO 8601), when the read carries it. The owl may say it. */
  lastObservedAt?: Date | string | null;
  /** How many approved sources have seen it, when the read carries it. The owl may say it. */
  sourceCount?: number | null;
  /** "acknowledged" for a directory entry drawn beside the reviewed records, "fleet" for a group of BNB Chain registrations. A reviewed record when it is left out. */
  kind?: ConstellationKind;
  /** The group a fleet light stands for. Only on a fleet. */
  fleet?: MapFleet;
};

export type ConstellationNode = {
  id: string;
  name: string;
  handle: string;
  protocol: string;
  tier: string;
  /** The chain the record's protocol list names, or null for a record listed only on a directory or card endpoint. */
  chain: MapChainKey | null;
  /** Reviewed, only acknowledged (no tier, drawn hollow), or a fleet light (a group, drawn as a large circle). */
  kind: ConstellationKind;
  /** The group a fleet light stands for. Only on a fleet. */
  fleet?: MapFleet;
  /** Position inside the canvas, 0 to 1 each way. */
  x: number;
  y: number;
};

export const TIER_COLOR: Record<string, string> = {
  tier_2: "#66E8FF",
  tier_3: "#BFFF76",
  tier_4: "#C3A6FF",
};
export const UNKNOWN_TIER_COLOR = "#7E8B93";
export const tierColor = (tier: string) => TIER_COLOR[tier] ?? UNKNOWN_TIER_COLOR;

/** The chain a record's protocols name: the first protocol on a chain, or null when none is. Arc's identity registry counts, so an Arc group's light is on Arc. */
export function recordChain(protocols: string): MapChainKey | null {
  for (const protocol of parseProtocolList(protocols)) {
    const chain = chainOf(protocol);
    if (chain) return chain;
    if (protocol === "erc8004_arc") return "arc";
  }
  return null;
}

/**
 * How a chain looks on the map. A colour is never the only signal: each chain also has its own
 * shape, so the map reads in greys, and the legend and the card name the chain in words.
 */
export type ChainStyleKey = MapChainKey | "none";
export type MarkerShape = "circle" | "diamond" | "square" | "triangle" | "dome";
export const CHAIN_STYLE: Record<ChainStyleKey, { label: string; color: string; shape: MarkerShape }> = {
  robinhood: { label: CHAIN_LABEL.robinhood, color: "#C3F53C", shape: "circle" },
  solana: { label: CHAIN_LABEL.solana, color: "#A78BFA", shape: "diamond" },
  bnb: { label: CHAIN_LABEL.bnb, color: "#F3BA2F", shape: "square" },
  arc: { label: EXTRA_CHAIN_LABEL.arc, color: "#ACC6E9", shape: "dome" },
  none: { label: "No chain", color: "#9AA8B8", shape: "triangle" },
};
export const chainStyleKey = (node: Pick<ConstellationNode, "chain">): ChainStyleKey => node.chain ?? "none";

/** An SVG path for a shape, centred on the origin at unit size. The canvas draws it with Path2D and the legend draws the same one. */
export function markerPath(shape: MarkerShape): string {
  switch (shape) {
    case "circle":
      return "M1 0A1 1 0 1 1 -1 0A1 1 0 1 1 1 0Z";
    case "diamond":
      return "M0 -1.25L1.25 0L0 1.25L-1.25 0Z";
    case "square":
      return "M-0.9 -0.9H0.9V0.9H-0.9Z";
    case "triangle":
      return "M0 -1.2L1.15 0.9L-1.15 0.9Z";
    case "dome":
      return "M-1.2 0.9A1.2 1.2 0 0 1 1.2 0.9Z";
  }
}

/** A name short enough for the label on the map. */
export function truncateLabel(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}\u2026`;
}

type LegendEntry = { key: ChainStyleKey; label: string; color: string; shape: MarkerShape; count: number };

function legendOf(nodes: readonly ConstellationNode[]): LegendEntry[] {
  const counts = new Map<ChainStyleKey, number>();
  for (const node of nodes) counts.set(chainStyleKey(node), (counts.get(chainStyleKey(node)) ?? 0) + 1);
  return (["robinhood", "solana", "bnb", "arc", "none"] as const)
    .filter(key => (counts.get(key) ?? 0) > 0)
    .map(key => ({ key, ...CHAIN_STYLE[key], count: counts.get(key)! }));
}

/** The map's legend: one entry for each chain that has a reviewed record on the map, in a fixed order. Acknowledged entries are not counted here. */
export function legendEntries(nodes: readonly ConstellationNode[]): LegendEntry[] {
  return legendOf(nodes.filter(node => !isAcknowledged(node) && !isFleet(node)));
}

/** The legend for the acknowledged entries on the map, one entry for each chain they are on, in the same order. They are drawn hollow. Fleet lights are not counted here either. */
export function acknowledgedLegendEntries(nodes: readonly ConstellationNode[]): LegendEntry[] {
  return legendOf(nodes.filter(isAcknowledged));
}

/** The record's protocols arrive as a JSON array in a string; the first is the one to show. */
export function protocolLabel(protocols: string): string {
  try {
    const parsed: unknown = JSON.parse(protocols);
    const first = Array.isArray(parsed) ? parsed.find((item): item is string => typeof item === "string") : undefined;
    return first ? first.replace(/_/g, " ").toUpperCase() : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

/** A 32-bit FNV-1a hash with a final mix (so ids that differ in one character still land far apart), so a record sits in the same place on every visit and every device. */
function hash(text: string, seed: number): number {
  let value = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

const MARGIN_X = 0.05;
const MARGIN_Y = 0.08;

/**
 * Places the records: each starts at a position derived from its id, then a few
 * rounds of pushing apart stop two dots from sitting on each other. The result
 * depends only on the set of ids, not on the order they arrived in. `aspect` is the
 * canvas's width over its height, so "apart" means apart on screen.
 */
export function layoutNodes(records: readonly ConstellationRecord[], aspect = 1.6): ConstellationNode[] {
  const plain = layoutPlainNodes(records.filter(record => record.kind !== "fleet"), aspect);
  const fleets = records.filter(record => record.kind === "fleet");
  // The fleet lights are placed after the rest and never move them: a dot sits where it sat before there were any lights.
  return fleets.length === 0 ? plain : [...plain, ...placeFleetNodes(fleets, plain, aspect)];
}

function layoutPlainNodes(records: readonly ConstellationRecord[], aspect: number): ConstellationNode[] {
  const chosen = [...records].sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)).slice(0, MAX_NODES);
  const nodes: ConstellationNode[] = chosen.map(record => ({
    id: record.agentId,
    name: record.displayName,
    handle: record.handle,
    protocol: protocolLabel(record.protocols),
    tier: record.evidenceTier,
    chain: recordChain(record.protocols),
    kind: record.kind ?? "reviewed",
    x: MARGIN_X + (1 - 2 * MARGIN_X) * (hash(record.agentId, 1) / 0xffffffff),
    y: MARGIN_Y + (1 - 2 * MARGIN_Y) * (hash(record.agentId, 2) / 0xffffffff),
  }));
  if (nodes.length < 2) return nodes;
  // The spacing that would spread this many dots evenly, a little under so they may still cluster.
  const minimum = 0.75 * Math.sqrt((1 - 2 * MARGIN_X) * (1 - 2 * MARGIN_Y) * aspect / nodes.length) / aspect;
  for (let round = 0; round < 40; round += 1) {
    let moved = false;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const dx = (b.x - a.x) * aspect;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= minimum) continue;
        moved = true;
        // Two dots on the same spot are pushed along a fixed axis, so the result stays deterministic.
        const ux = distance > 1e-9 ? dx / distance : 1;
        const uy = distance > 1e-9 ? dy / distance : 0;
        const push = (minimum - distance) / 2;
        a.x -= (ux * push) / aspect;
        a.y -= uy * push;
        b.x += (ux * push) / aspect;
        b.y += uy * push;
      }
    }
    for (const node of nodes) {
      node.x = Math.min(1 - MARGIN_X, Math.max(MARGIN_X, node.x));
      node.y = Math.min(1 - MARGIN_Y, Math.max(MARGIN_Y, node.y));
    }
    if (!moved) break;
  }
  return nodes;
}

/** The canvas height the fleet placement assumes, in pixels: a phone's map is 340 and a wide screen's 420. */
const NOMINAL_HEIGHT = 340;
/** How far a plain dot reaches from its centre, in pixels, and the gap kept between a light and anything beside it, which leaves room for the count written under it. */
const DOT_REACH = 4;
export const LIGHT_GAP = 16;
const LIGHT_MARGIN_X = 0.09;
const LIGHT_MARGIN_Y = 0.15;

/**
 * Places the fleet lights, the largest first. Each starts where its id hashes and is pushed away from every dot already on
 * the map and every light placed before it until it has room. If that leaves it crowded, it tries a few other starting
 * places, also taken from its id, and keeps the one with the least overlap. Only the light moves, so the same ids always give
 * the same places, whatever order they arrive in, and the dots under them are exactly where they were.
 */
const LIGHT_ATTEMPTS = 24;

function placeFleetNodes(records: readonly ConstellationRecord[], obstacles: readonly ConstellationNode[], aspect: number): ConstellationNode[] {
  const placed: ConstellationNode[] = [];
  // The BNB Chain lights are placed first, so they are exactly where they were before there were Solana lights, and the Solana lights next, so they are where they were before there were Robinhood Chain lights; those find room around them, and the Arc lights find room last.
  const lightOrder = (record: ConstellationRecord) => (record.fleet?.chain === "arc" ? 3 : record.fleet?.chain === "robinhood" ? 2 : record.fleet?.chain === "solana" ? 1 : 0);
  const ordered = [...records].sort((a, b) => lightOrder(a) - lightOrder(b) || (b.fleet?.count ?? 0) - (a.fleet?.count ?? 0) || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  for (const record of ordered) {
    const radius = fleetReach(record.fleet);
    const others = [...obstacles, ...placed];
    const need = (other: ConstellationNode) => (radius + (other.kind === "fleet" ? fleetReach(other.fleet) : DOT_REACH) + LIGHT_GAP) / NOMINAL_HEIGHT;
    const nodeAt = (attempt: number): ConstellationNode => ({
      id: record.agentId,
      name: record.displayName,
      handle: record.handle,
      protocol: protocolLabel(record.protocols),
      tier: FLEET_TIER,
      chain: recordChain(record.protocols),
      kind: "fleet",
      fleet: record.fleet,
      x: LIGHT_MARGIN_X + (1 - 2 * LIGHT_MARGIN_X) * (hash(record.agentId, 1 + 2 * attempt) / 0xffffffff),
      y: LIGHT_MARGIN_Y + (1 - 2 * LIGHT_MARGIN_Y) * (hash(record.agentId, 2 + 2 * attempt) / 0xffffffff),
    });
    const relax = (node: ConstellationNode) => {
      for (let round = 0; round < 80; round += 1) {
        let moved = false;
        for (const other of others) {
          const wanted = need(other);
          const dx = (node.x - other.x) * aspect;
          const dy = node.y - other.y;
          const distance = Math.hypot(dx, dy);
          if (distance >= wanted) continue;
          moved = true;
          // Two on the same spot are pushed along a fixed axis, so the result stays deterministic.
          const ux = distance > 1e-9 ? dx / distance : 1;
          const uy = distance > 1e-9 ? dy / distance : 0;
          node.x += ((wanted - distance) * ux) / aspect;
          node.y += (wanted - distance) * uy;
          node.x = Math.min(1 - LIGHT_MARGIN_X, Math.max(LIGHT_MARGIN_X, node.x));
          node.y = Math.min(1 - LIGHT_MARGIN_Y, Math.max(LIGHT_MARGIN_Y, node.y));
        }
        if (!moved) break;
      }
    };
    // How much of the room it should have it lacks, summed over everything near it.
    const overlap = (node: ConstellationNode) => {
      let total = 0;
      for (const other of others) total += Math.max(0, need(other) - Math.hypot((node.x - other.x) * aspect, node.y - other.y));
      return total;
    };
    let best: { node: ConstellationNode; lack: number } | null = null;
    for (let attempt = 0; attempt < LIGHT_ATTEMPTS; attempt += 1) {
      const trial = nodeAt(attempt);
      relax(trial);
      const lack = overlap(trial);
      if (best === null || lack < best.lack - 1e-12) best = { node: trial, lack };
      if (lack <= 1e-9) break;
    }
    placed.push(best!.node);
  }
  return placed;
}

/** Each dot joined to its nearest neighbour, as index pairs with the lower index first and no pair twice. They give the map its constellation look and mean nothing. */
export function nearestLinks(nodes: readonly ConstellationNode[], aspect = 1.6): Array<[number, number]> {
  const seen = new Set<string>();
  const links: Array<[number, number]> = [];
  for (let i = 0; i < nodes.length; i += 1) {
    let nearest = -1;
    let nearestDistance = Infinity;
    for (let j = 0; j < nodes.length; j += 1) {
      if (j === i) continue;
      const distance = Math.hypot((nodes[j]!.x - nodes[i]!.x) * aspect, nodes[j]!.y - nodes[i]!.y);
      if (distance < nearestDistance) {
        nearest = j;
        nearestDistance = distance;
      }
    }
    if (nearest < 0) continue;
    const pair: [number, number] = i < nearest ? [i, nearest] : [nearest, i];
    const key = `${pair[0]}:${pair[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push(pair);
    }
  }
  return links;
}

/** The node nearest the point (in canvas pixels) within `radius`, or null. A tie goes to the lower id. */
export function nearestNode(nodes: readonly ConstellationNode[], pointX: number, pointY: number, width: number, height: number, radius: number): ConstellationNode | null {
  let best: ConstellationNode | null = null;
  let bestDistance = radius;
  for (const node of nodes) {
    const distance = Math.hypot(node.x * width - pointX, node.y * height - pointY);
    if (distance < bestDistance || (distance === bestDistance && best !== null && node.id < best.id)) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

/** The nodes bucketed into square cells, so a query looks at a handful of cells instead of every node. */
export type NodeGrid = { cellPx: number; width: number; height: number; cells: Map<string, ConstellationNode[]> };

export function buildNodeGrid(nodes: readonly ConstellationNode[], width: number, height: number, cellPx: number): NodeGrid {
  const cells = new Map<string, ConstellationNode[]>();
  for (const node of nodes) {
    const key = `${Math.floor((node.x * width) / cellPx)}:${Math.floor((node.y * height) / cellPx)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(node);
    else cells.set(key, [node]);
  }
  return { cellPx, width, height, cells };
}

/** The same answer as {@link nearestNode}, found through the grid. */
export function nearestNodeInGrid(grid: NodeGrid, pointX: number, pointY: number, radius: number): ConstellationNode | null {
  const { cellPx, width, height, cells } = grid;
  let best: ConstellationNode | null = null;
  let bestDistance = radius;
  for (let cx = Math.floor((pointX - radius) / cellPx); cx <= Math.floor((pointX + radius) / cellPx); cx += 1) {
    for (let cy = Math.floor((pointY - radius) / cellPx); cy <= Math.floor((pointY + radius) / cellPx); cy += 1) {
      for (const node of cells.get(`${cx}:${cy}`) ?? []) {
        const distance = Math.hypot(node.x * width - pointX, node.y * height - pointY);
        if (distance < bestDistance || (distance === bestDistance && best !== null && node.id < best.id)) {
          best = node;
          bestDistance = distance;
        }
      }
    }
  }
  return best;
}

export type Direction = "left" | "right" | "up" | "down";

/**
 * The node an arrow key moves to: the nearest one in that direction, weighing sideways drift twice as much
 * as distance along the way so the move follows the key. Null at an edge, so the focus stays where it is.
 */
export function neighborInDirection(nodes: readonly ConstellationNode[], fromId: string, direction: Direction, aspect = 1.6): string | null {
  const from = nodes.find(node => node.id === fromId);
  if (!from) return null;
  let best: { id: string; score: number } | null = null;
  for (const node of nodes) {
    if (node.id === from.id) continue;
    const dx = (node.x - from.x) * aspect;
    const dy = node.y - from.y;
    const along = direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
    const across = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1e-9) continue;
    const score = along + 2 * across;
    if (best === null || score < best.score - 1e-12 || (Math.abs(score - best.score) <= 1e-12 && node.id < best.id)) best = { id: node.id, score };
  }
  return best?.id ?? null;
}

const TIER_ORDER = ["tier_2", "tier_3", "tier_4"];

/**
 * The record the map opens on, so the card is never empty: the one with the highest evidence tier, and among
 * those the one whose id hashes lowest, which is the same record on every visit. It is where to start, not an
 * endorsement, and the card says so.
 */
export function pickFeaturedNode(nodes: readonly ConstellationNode[]): ConstellationNode | null {
  let best: ConstellationNode | null = null;
  let bestTier = -1;
  let bestHash = Infinity;
  // An acknowledged entry or a fleet light has no tier, so the map never opens on one while it has a reviewed record.
  const reviewed = nodes.filter(node => !isAcknowledged(node) && !isFleet(node));
  for (const node of reviewed.length > 0 ? reviewed : nodes) {
    const tier = TIER_ORDER.indexOf(node.tier);
    const rank = hash(node.id, 3);
    if (tier > bestTier || (tier === bestTier && (rank < bestHash || (rank === bestHash && best !== null && node.id < best.id)))) {
      best = node;
      bestTier = tier;
      bestHash = rank;
    }
  }
  return best;
}

export type SelectionKind = "pinned" | "scanned" | "featured";
export type Selection = { node: ConstellationNode; kind: SelectionKind } | { node: null; kind: null };

/** What the card shows: the pinned record, else the one being scanned, else the featured one. */
export function currentSelection(nodes: readonly ConstellationNode[], pinnedId: string | null, scannedId: string | null): Selection {
  const pinned = pinnedId === null ? undefined : nodes.find(candidate => candidate.id === pinnedId);
  if (pinned) return { node: pinned, kind: "pinned" };
  const scanned = scannedId === null ? undefined : nodes.find(candidate => candidate.id === scannedId);
  if (scanned) return { node: scanned, kind: "scanned" };
  const featured = pickFeaturedNode(nodes);
  return featured ? { node: featured, kind: "featured" } : { node: null, kind: null };
}

/** What the scanner has read about the node it is over: only facts the evidence envelope carries. */
export type EvidenceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; publisher: string; provenance: string | null; observations: number; source: string | null };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The two lines of the scanner's status display. `guide` says what moves the scan point, so the hint matches how the visitor is scanning. */
export function statusLines(node: ConstellationNode | null, evidence: EvidenceState, guide: "owl" | "pointer", kind: SelectionKind = "scanned"): [string, string] {
  if (!node) return ["nooscape://scanner idle", guide === "owl" ? "> move the owl over an agent" : "> point at an agent, or tab to one"];
  if (isFleet(node)) {
    const count = node.fleet ? `${node.fleet.count.toLocaleString("en-US")} registrations` : "registrations";
    return [kind === "pinned" ? `> pinned ${node.name}` : `> scanning ${node.name}…`, `> ${count} on ${listedChainLabel(node.chain ?? "bnb")} share one fact · a group, not an agent`];
  }
  if (isAcknowledged(node)) {
    return [kind === "pinned" ? `> pinned ${node.name}` : `> scanning ${node.name}…`, `> acknowledged${node.chain ? ` on ${listedChainLabel(node.chain)}` : ""}, not reviewed · no evidence tier`];
  }
  const head = kind === "pinned" ? `> pinned ${node.name}` : kind === "featured" ? `> opened on ${node.name}, the highest evidence tier here` : `> scanning ${node.name}…`;
  switch (evidence.status) {
    case "ready":
      return [head, `> ${node.tier} · ${plural(evidence.observations, "retained observation")}${evidence.provenance ? ` · provenance ${evidence.provenance}` : ""}`];
    case "unavailable":
      return [head, `> ${node.tier} · evidence not available right now`];
    default:
      return [head, "> reading retained evidence…"];
  }
}

/** How long to wait before showing new text, given when text was last shown: 0 when the gap has already passed. */
export function throttleDelay(lastShownAt: number, now: number, gapMs: number): number {
  return Math.max(0, lastShownAt + gapMs - now);
}

/** What the canvas says to assistive technology, which cannot see the dots. */
export function constellationSummary(nodes: readonly ConstellationNode[]): string {
  if (nodes.length === 0) return "No reviewed records to show.";
  const reviewed = nodes.filter(node => !isAcknowledged(node) && !isFleet(node));
  const lights = nodes.filter(node => isFleet(node) && fleetShape(node.fleet) === "circle").length;
  const diamonds = nodes.filter(node => isFleet(node) && fleetShape(node.fleet) === "diamond").length;
  const hexagons = nodes.filter(node => isFleet(node) && fleetShape(node.fleet) === "hexagon").length;
  const domes = nodes.filter(node => isFleet(node) && fleetShape(node.fleet) === "dome").length;
  const counts = new Map<string, number>();
  for (const node of reviewed) counts.set(node.tier, (counts.get(node.tier) ?? 0) + 1);
  const tiers = Array.from(counts.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([tier, count]) => `${count} ${tier.replace("_", " ")}`);
  const chains = legendEntries(nodes).map(entry => `${entry.count} ${entry.label}`);
  const acknowledged = acknowledgedLegendEntries(nodes).map(entry => `${entry.count} on ${entry.label}`);
  // Said apart from the reviewed records, and only when there are some: these are listed by the directory, not reviewed.
  const apart = acknowledged.length > 0 ? ` Also ${acknowledged.join(", ")}: entries the directory lists that Nooscape has not reviewed, drawn hollow, with no evidence tier.` : "";
  // The lights are groups of registrations that share a fact, said apart from the dots, and they are not agents.
  const groups = lights > 0 ? ` Also ${plural(lights, "large circle")}: each is a group of ${CHAIN_LABEL.bnb} registrations that share one fact, with its count. A circle is a group, not an agent, and no single ${CHAIN_LABEL.bnb} registration is drawn.` : "";
  // The Solana lights are owner wallets, said apart from the BNB Chain groups: a diamond is one wallet in one registry, not an agent.
  const wallets = diamonds > 0 ? ` Also ${plural(diamonds, "large diamond")}: each is one owner wallet that a ${CHAIN_LABEL.solana} registry records as holding many registrations, with its count. A diamond is a wallet, not an agent.` : "";
  // The Robinhood Chain lights are registering wallets: a hexagon is one wallet, not an agent.
  const registrants = hexagons > 0 ? ` Also ${plural(hexagons, "large hexagon")}: each is one registering wallet that the directory records against many ${CHAIN_LABEL.robinhood} registrations, with its count. A hexagon is a wallet, not an agent.` : "";
  // The Arc lights are groups that share a wallet, a host or a profile link: a dome is a group, not an agent.
  const arcGroups = domes > 0 ? ` Also ${plural(domes, "large dome")}: each is a group of ${EXTRA_CHAIN_LABEL.arc} registrations that share one wallet, host or profile link, with its count. A dome is a group, not an agent, and no single ${EXTRA_CHAIN_LABEL.arc} registration is drawn.` : "";
  const lead = reviewed.length > 0 ? `Map of ${plural(reviewed.length, "reviewed record")}. By chain: ${chains.join(", ")}. By evidence tier: ${tiers.join(", ")}.` : "No reviewed records to show.";
  return `${lead}${apart}${groups}${wallets}${registrants}${arcGroups} Each dot is one record. Tab to the map, use the arrow keys to move between records and Enter to pin one.`;
}
