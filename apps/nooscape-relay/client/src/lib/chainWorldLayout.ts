import { placementHash } from "@shared/noosphere";

/**
 * Where the things in a chain world stand, in pixels from the top left of the stage. Pure, so none of it needs a browser to test.
 *
 * A world is made of zones: a lane for each Solana registry, a platform for each kind of shared fact on BNB Chain, a plate for the
 * registering wallets and one for the identities on Robinhood Chain. A zone is a plate with a name, the formations of its groups across
 * the top and the figures of its records below. Every formation and every figure gets a cell bigger than its drawing, each zone is as
 * tall as its cells need, and the stage is as tall as its rows of zones need, so nothing can stand on anything else at any width. The
 * wobble that keeps the rows from looking ruled is a few pixels inside the cell.
 *
 * The places mean only what the zone says: this registry, this kind of shared fact. They are not geography and they are not distance
 * between anything.
 */

/** The room the stage keeps above the first row of zones (the title bar) and below the last (the recorded-event banner and the footer line). */
export const WORLD_FRAME = { top: 64, bottom: 150 } as const;
export const WORLD_MIN_HEIGHT = 380;
/** A stage narrower than this stacks its zones, shows fewer figures and uses narrower cells. */
export const NARROW_WIDTH = 640;
export const WIDE_FIGURES = 24;
export const NARROW_FIGURES = 12;
/** No more formations than this are drawn in one zone. The rest stay in the list below the stage. */
export const MAX_GROUPS_SHOWN = 12;
/** A stage at least this wide sets a narrow zone beside a wide one when a world asks for a split. */
export const SPLIT_WIDTH = 700;

/** A zone: its name across the top (two lines at most), then its formations, then its figures. */
export const ZONE = { header: 64, pad: 14, gap: 16, formationFigureGap: 8, bottomPad: 14, minWidth: 260 } as const;

const cells = (width: number) =>
  width < NARROW_WIDTH
    ? { side: 12, formationW: 112, wobbleF: 1, limit: NARROW_FIGURES }
    : { side: 20, formationW: 116, wobbleF: 2, limit: WIDE_FIGURES };
/** A figure's cell, wide or narrow: the drawing is 64 by 80 and the cell leaves room for the wobble and the stagger between neighbours. */
const FIGURE_CELL = { w: 72, h: 90, wobbleX: 2, wobbleY: 2, stagger: 6 } as const;

/** What a figure and a formation take up on the stage, as the stylesheet sizes them: a formation is its drawing, a gap, a one-line title and a two-line count. */
export const FIGURE_BOX = { w: 64, h: 80 } as const;
export const FORMATION_BOX_W = 108;
export const FORMATION_LABELS_H = 63;
/** The drawing of a formation is `size` wide and 0.846 of that tall. */
export const formationDrawingHeight = (size: number): number => Math.round(size * 0.846);
export const formationBoxHeight = (size: number): number => formationDrawingHeight(size) + FORMATION_LABELS_H;
/** The cell of a formation is its box and a little room for the wobble. */
const FORMATION_ROOM = 6;

export type PlacedItem = { id: string; x: number; y: number };
export type PlacedZone = { id: string; x: number; y: number; w: number; h: number };
export type GroupSpec = { id: string; size: number };
export type ZoneSpec = { id: string; groups: readonly GroupSpec[]; figureIds: readonly string[] };
/** How a world sets its zones out: side by side (as many in a row as fit), or one narrow zone beside one wide one. A narrow stage stacks them. */
export type Arrangement = "columns" | "split";
export type Composition = {
  width: number;
  height: number;
  zones: PlacedZone[];
  groups: PlacedItem[];
  figures: PlacedItem[];
  /** How many zones stand in each row, for the tests. */
  rows: number[];
};

/** The size of a formation in pixels, from the count it stands for: it grows with the log of the count, from 48 at 100 to 112 at 130,000. The size says how many, nothing else. */
export const groupSize = (count: number): number => Math.min(112, Math.max(48, Math.round(48 + 20.5 * (Math.log10(Math.max(1, count)) - 2))));

/** Rows and columns for `count` cells when no row may hold more than `maxCols`: as few rows as possible, then as even as possible. */
export function gridFor(count: number, maxCols: number): { cols: number; rows: number } {
  if (count <= 0) return { cols: 0, rows: 0 };
  const rows = Math.ceil(count / Math.max(1, maxCols));
  return { cols: Math.ceil(count / rows), rows };
}

/**
 * How many figures each zone may show: the stage's limit shared out one at a time, round and round, to the zones that have more to show.
 * A zone with little gives its share to the rest, and a zone with something is never left with nothing.
 */
export function allocateFigures(width: number, zones: ReadonlyArray<{ id: string; available: number }>): Record<string, number> {
  const slots: Record<string, number> = Object.fromEntries(zones.map(zone => [zone.id, 0]));
  let left = cells(width).limit;
  let moved = true;
  while (left > 0 && moved) {
    moved = false;
    for (const zone of zones) {
      if (left > 0 && (slots[zone.id] ?? 0) < zone.available) {
        slots[zone.id] = (slots[zone.id] ?? 0) + 1;
        left -= 1;
        moved = true;
      }
    }
  }
  return slots;
}

/** Figures in a grid of equal cells, row by row. A short last row stands in the middle of the block. */
function placeFigures(ids: readonly string[], cols: number, left: number, width: number, top: number): PlacedItem[] {
  const rows = Math.ceil(ids.length / Math.max(1, cols));
  const cellW = width / Math.max(1, cols);
  return ids.map((id, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const inRow = row === rows - 1 ? ids.length - row * cols : cols;
    const lead = ((cols - inRow) * cellW) / 2;
    const hash = placementHash(id);
    return {
      id,
      x: Math.round(left + lead + (col + 0.5) * cellW + (hash % (2 * FIGURE_CELL.wobbleX + 1)) - FIGURE_CELL.wobbleX),
      y: Math.round(top + (row + 0.5) * FIGURE_CELL.h + (Math.floor(hash / 13) % (2 * FIGURE_CELL.wobbleY + 1)) - FIGURE_CELL.wobbleY + (col % 2) * FIGURE_CELL.stagger),
    };
  });
}

/**
 * Formations in rows whose heights come from their own sizes, so a row of small ones does not keep the room a large one needs. The drawings
 * in a row hang from the same line. The last row is centred. Returns the places and the height used.
 */
function placeFormations(groups: readonly GroupSpec[], cols: number, left: number, width: number, top: number, wobble: number): { items: PlacedItem[]; height: number } {
  const items: PlacedItem[] = [];
  const cellW = width / Math.max(1, cols);
  let y = top;
  for (let start = 0; start < groups.length; start += cols) {
    const row = groups.slice(start, start + cols);
    const rowHeight = Math.max(...row.map(group => formationBoxHeight(group.size))) + FORMATION_ROOM;
    const lead = ((cols - row.length) * cellW) / 2;
    row.forEach((group, col) => {
      const hash = placementHash(group.id);
      items.push({
        id: group.id,
        x: Math.round(left + lead + (col + 0.5) * cellW + (hash % (2 * wobble + 1)) - wobble),
        y: Math.round(y + formationBoxHeight(group.size) / 2 + (Math.floor(hash / 13) % 3) - 1),
      });
    });
    y += rowHeight;
  }
  return { items, height: y - top };
}

/** The widths of the zones in a row: shares of the room left once the gaps are taken out. */
function rowWidths(weights: readonly number[], inner: number): number[] {
  const room = inner - ZONE.gap * (weights.length - 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map(weight => Math.floor((room * weight) / total));
}

/** How the zones are split into rows, and each row's weights. */
function planRows(count: number, inner: number, arrangement: Arrangement, narrow: boolean): number[][] {
  if (count === 0) return [];
  if (narrow) return Array.from({ length: count }, () => [1]);
  if (arrangement === "split" && count === 2 && inner >= SPLIT_WIDTH) return [[40, 60]];
  const perRow = Math.max(1, Math.min(count, Math.floor((inner + ZONE.gap) / (ZONE.minWidth + ZONE.gap))));
  const rows = Math.ceil(count / perRow);
  const even = Math.ceil(count / rows);
  const plan: number[][] = [];
  for (let left = count; left > 0; left -= even) plan.push(Array.from({ length: Math.min(even, left) }, () => 1));
  return plan;
}

/**
 * Sets the zones out and places every formation and figure in them. `zones` are in the order to be shown, and a zone with nothing in it is
 * left out. The figures in `figureIds` are the ones to place: how many a zone may show is `allocateFigures`'s to say.
 */
export function composeWorld(input: { width: number; arrangement: Arrangement; zones: readonly ZoneSpec[] }): Composition {
  const width = Math.max(260, Math.round(input.width));
  const c = cells(width);
  const narrow = width < NARROW_WIDTH;
  const inner = Math.max(200, width - 2 * c.side);
  const zones = input.zones.filter(zone => zone.groups.length + zone.figureIds.length > 0);
  const plan = planRows(zones.length, inner, input.arrangement, narrow);

  const placedZones: PlacedZone[] = [];
  const groups: PlacedItem[] = [];
  const figures: PlacedItem[] = [];
  let top: number = WORLD_FRAME.top;
  let index = 0;
  for (const weights of plan) {
    const widths = rowWidths(weights, inner);
    const members = zones.slice(index, index + weights.length);
    index += weights.length;
    // The contents of each zone at its width, and the height the tallest needs.
    const contents = members.map((zone, at) => {
      const iw = Math.max(c.formationW, widths[at]! - 2 * ZONE.pad);
      const shown = zone.groups.slice(0, MAX_GROUPS_SHOWN);
      const groupGrid = gridFor(shown.length, Math.max(1, Math.floor(iw / c.formationW)));
      const figureGrid = gridFor(zone.figureIds.length, Math.max(1, Math.floor(iw / FIGURE_CELL.w)));
      return { zone, shown, iw, groupGrid, figureGrid };
    });
    // The formations are placed first, because their rows set how far down the figures start.
    const heights = contents.map(content => {
      const probe = placeFormations(content.shown, content.groupGrid.cols, 0, content.iw, 0, c.wobbleF);
      const figuresH = content.figureGrid.rows * FIGURE_CELL.h;
      return { groupsH: probe.height, figuresH, total: ZONE.header + probe.height + (probe.height > 0 && figuresH > 0 ? ZONE.formationFigureGap : 0) + figuresH + ZONE.bottomPad };
    });
    const rowHeight = Math.max(...heights.map(height => height.total));
    let left = c.side;
    contents.forEach((content, at) => {
      const w = widths[at]!;
      const height = heights[at]!;
      placedZones.push({ id: content.zone.id, x: left, y: top, w, h: rowHeight });
      const inside = left + ZONE.pad + (w - 2 * ZONE.pad - content.iw) / 2;
      const groupsTop = top + ZONE.header;
      groups.push(...placeFormations(content.shown, content.groupGrid.cols, inside, content.iw, groupsTop, c.wobbleF).items);
      const figuresTop = groupsTop + height.groupsH + (height.groupsH > 0 ? ZONE.formationFigureGap : 0);
      figures.push(...placeFigures(content.zone.figureIds, content.figureGrid.cols, inside, content.iw, figuresTop));
      left += w + ZONE.gap;
    });
    top += rowHeight + ZONE.gap;
  }

  const bottom = placedZones.length ? top - ZONE.gap : WORLD_FRAME.top;
  const height = Math.max(WORLD_MIN_HEIGHT, bottom + WORLD_FRAME.bottom);
  return { width, height, zones: placedZones, groups, figures, rows: plan.map(row => row.length) };
}
