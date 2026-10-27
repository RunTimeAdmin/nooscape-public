import { feetOffset, perchedBox, type OwlSize } from "./owlRig";

/**
 * Where the owl may stand. The page marks what the owl must not cover (`data-owl-avoid`) and where it may rest
 * (`data-owl-perch`); this is the geometry that turns those marks and the pointer into a place to go. Pure,
 * in viewport pixels, so none of it needs a browser to test.
 *
 * The owl follows the pointer. When the pointer is over something the owl must not cover, the owl goes to the
 * nearest clear place instead; when no clear place is near, or the pointer is close to a perch or has been
 * still for a moment, it goes to a perch.
 */
export type Rect = { left: number; top: number; right: number; bottom: number };
export type Point = { x: number; y: number };
export type Viewport = { width: number; height: number };

/** Clear space kept between the owl's box and anything it must not cover. */
export const AVOID_MARGIN = 6;
/** The pointer has been still this long: the owl goes to a perch. */
export const IDLE_MS = 1_200;
/** A pointer this close to a perch brings the owl to it. */
export const PERCH_NEAR_PX = 120;
/** Further than this from the pointer, a clear place is not worth going to while a perch is on screen. */
export const MAX_PUSH_PX = 320;
/** How visible the owl is while it passes over something it must not cover. */
export const FAINT = 0.28;
/** Over something it must not cover for longer than this, the owl is out of sight until it is clear. */
export const COVER_GRACE_MS = 150;

const EPS = 0.01;
const clamp = (value: number, low: number, high: number) => (value < low ? low : value > high ? high : value);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function intersects(a: Rect, b: Rect, margin = 0): boolean {
  return a.left < b.right + margin && a.right > b.left - margin && a.top < b.bottom + margin && a.bottom > b.top - margin;
}

/** The box the owl fills with its feet at `feet`. */
export const owlBox = (feet: Point, size: OwlSize): Rect => perchedBox(feet, size);

/** Whether an owl standing at `feet` would cover any of the rects. */
export function overlaps(feet: Point, size: OwlSize, rects: readonly Rect[], margin = 0): boolean {
  const box = owlBox(feet, size);
  return rects.some(rect => intersects(box, rect, margin));
}

/** Where the owl's feet may be so that its whole box stays on screen. */
export function feetBounds(size: OwlSize, viewport: Viewport): Rect {
  const above = feetOffset(size);
  return { left: size.width / 2, right: viewport.width - size.width / 2, top: above, bottom: viewport.height - (size.height - above) };
}

export function clampFeet(point: Point, size: OwlSize, viewport: Viewport): Point {
  const bounds = feetBounds(size, viewport);
  return { x: clamp(point.x, bounds.left, Math.max(bounds.left, bounds.right)), y: clamp(point.y, bounds.top, Math.max(bounds.top, bounds.bottom)) };
}

/**
 * A rect grown by the owl's own size, so that the owl's feet are outside it exactly when the owl's box clears
 * the original by `margin`. It turns "does a box touch this" into "is a point inside this".
 */
export function growForOwl(rect: Rect, size: OwlSize, margin = AVOID_MARGIN): Rect {
  const above = feetOffset(size);
  return {
    left: rect.left - margin - size.width / 2,
    right: rect.right + margin + size.width / 2,
    top: rect.top - margin - (size.height - above),
    bottom: rect.bottom + margin + above,
  };
}

const inside = (point: Point, rect: Rect) => point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom;
const insideAny = (point: Point, rects: readonly Rect[]) => rects.some(rect => inside(point, rect));

/**
 * The nearest place for the owl's feet that no grown rect holds, inside `bounds`: the point itself when it is
 * clear, else the nearest exit past an edge of whatever holds it, trying up to four edges deep (a point in a
 * corner between two rects has to leave both). Null when there is nowhere to go.
 */
export function nearestFreeFeet(point: Point, grown: readonly Rect[], bounds: Rect): Point | null {
  const start = { x: clamp(point.x, bounds.left, bounds.right), y: clamp(point.y, bounds.top, bounds.bottom) };
  if (!insideAny(start, grown)) return start;
  let best: Point | null = null;
  let bestDistance = Infinity;
  const seen = new Set<string>();
  let frontier: Point[] = [start];
  for (let depth = 0; depth < 4 && frontier.length > 0; depth += 1) {
    const next: Point[] = [];
    for (const candidate of frontier) {
      const holder = grown.find(rect => inside(candidate, rect));
      if (!holder) continue;
      const exits: Point[] = [
        { x: holder.left - EPS, y: candidate.y },
        { x: holder.right + EPS, y: candidate.y },
        { x: candidate.x, y: holder.top - EPS },
        { x: candidate.x, y: holder.bottom + EPS },
      ].map(exit => ({ x: clamp(exit.x, bounds.left, bounds.right), y: clamp(exit.y, bounds.top, bounds.bottom) }));
      for (const exit of exits) {
        const key = `${Math.round(exit.x * 4)}/${Math.round(exit.y * 4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (insideAny(exit, grown)) {
          next.push(exit);
        } else if (distance(exit, start) < bestDistance) {
          best = exit;
          bestDistance = distance(exit, start);
        }
      }
    }
    frontier = next;
  }
  return best;
}

export type Choice = {
  /** Where the owl's feet should go. */
  target: Point;
  /** `follow`: the pointer. `push`: the nearest clear place to it. `perch`: a perch. `hold`: nowhere clear, so where it is. */
  kind: "follow" | "push" | "perch" | "hold";
  /** The perch, when the choice is one. */
  perch: number | null;
};

type ChoiceInput = {
  /** Where the pointer is. */
  pointer: Point;
  /** Where the owl's feet are now. */
  owl: Point;
  /** How long the pointer has been still, in milliseconds. */
  idleMs: number;
  /** What the owl must not cover. */
  rects: readonly Rect[];
  /** The feet position on each perch that is on screen and clear. */
  perches: readonly Point[];
  size: OwlSize;
  viewport: Viewport;
  /** The owl is reading something (it is over a record on the scan map): it stays while the pointer rests. */
  busy?: boolean;
};

export function chooseTarget({ pointer, owl, idleMs, rects, perches, size, viewport, busy = false }: ChoiceInput): Choice {
  const wanted = clampFeet(pointer, size, viewport);
  const nearestPerch = (from: Point) => {
    let index = -1;
    let least = Infinity;
    perches.forEach((perch, at) => {
      const gap = distance(from, perch);
      if (gap < least) {
        least = gap;
        index = at;
      }
    });
    return { index, gap: least };
  };
  const toPerch = (index: number): Choice => ({ target: perches[index]!, kind: "perch", perch: index });

  if (perches.length > 0) {
    const near = nearestPerch(wanted);
    if (near.gap <= PERCH_NEAR_PX) return toPerch(near.index);
    if (idleMs > IDLE_MS && !busy) return toPerch(near.index);
  }

  const grown = rects.map(rect => growForOwl(rect, size));
  if (!insideAny(wanted, grown)) return { target: wanted, kind: "follow", perch: null };

  const free = nearestFreeFeet(wanted, grown, feetBounds(size, viewport));
  if (free && distance(free, wanted) <= MAX_PUSH_PX) return { target: free, kind: "push", perch: null };
  if (perches.length > 0) return toPerch(nearestPerch(wanted).index);
  if (free) return { target: free, kind: "push", perch: null };
  return { target: clampFeet(owl, size, viewport), kind: "hold", perch: null };
}

export type Size = { width: number; height: number };

/**
 * Where a speech bubble of this size goes beside the owl: to its left, else its right, else above, else below, the
 * first place that is on screen and clear of everything the owl must not cover. Null when there is no such place.
 * `owl` is the owl's box; the bubble's left and right edges sit about its head.
 */
export function placeBubble({ owl, bubble, rects, viewport, gap = 8, margin = 4 }: { owl: Rect; bubble: Size; rects: readonly Rect[]; viewport: Viewport; gap?: number; margin?: number }): Rect | null {
  const at = (left: number, top: number): Rect => ({ left, top, right: left + bubble.width, bottom: top + bubble.height });
  const head = owl.top + (owl.bottom - owl.top) * 0.3 - bubble.height / 2;
  const middle = (owl.left + owl.right) / 2 - bubble.width / 2;
  const candidates = [at(owl.left - gap - bubble.width, head), at(owl.right + gap, head), at(middle, owl.top - gap - bubble.height), at(middle, owl.bottom + gap)];
  const edge = 8;
  return (
    candidates.find(
      place =>
        place.left >= edge && place.top >= edge && place.right <= viewport.width - edge && place.bottom <= viewport.height - edge && !rects.some(rect => intersects(place, rect, margin)),
    ) ?? null
  );
}

/**
 * How visible the owl is: clear when it covers nothing, faint while it passes over what it must not cover, and out
 * of sight once it has been over it for more than a moment, or when nowhere on screen is clear and it is over it.
 */
export function owlOpacity(state: { covering: boolean; coveringMs: number; stranded: boolean }): number {
  if (!state.covering) return 1;
  return state.stranded || state.coveringMs > COVER_GRACE_MS ? 0 : FAINT;
}
