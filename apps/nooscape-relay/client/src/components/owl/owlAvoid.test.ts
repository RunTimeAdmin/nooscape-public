import { describe, expect, it } from "vitest";
import {
  AVOID_MARGIN,
  chooseTarget,
  clampFeet,
  COVER_GRACE_MS,
  FAINT,
  feetBounds,
  growForOwl,
  IDLE_MS,
  intersects,
  MAX_PUSH_PX,
  nearestFreeFeet,
  overlaps,
  owlBox,
  owlOpacity,
  PERCH_NEAR_PX,
  placeBubble,
  type Point,
  type Rect,
} from "./owlAvoid";
import { createOwlState, MAX_FRAME_PX, MAX_SPEED, MAX_STRETCH, OWL_SIZE, perchedBox, stepOwl, type OwlInput } from "./owlRig";

const size = OWL_SIZE.fine;
const VIEW = { width: 1440, height: 900 };
const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });
const inside = (point: Point, r: Rect) => point.x > r.left && point.x < r.right && point.y > r.top && point.y < r.bottom;

/** A small deterministic generator, so a failing scene can be run again. */
function generator(seed: number) {
  let value = seed;
  return () => (value = (value * 16807) % 2147483647) / 2147483647;
}

function scene(random: () => number, count: number): Rect[] {
  return Array.from({ length: count }, () => {
    const left = random() * 1300;
    const top = random() * 780;
    return rect(left, top, left + 40 + random() * 360, top + 20 + random() * 200);
  });
}

describe("boxes", () => {
  it("meet when they overlap, not when they merely touch, and a margin counts touching", () => {
    expect(intersects(rect(0, 0, 10, 10), rect(5, 5, 15, 15))).toBe(true);
    expect(intersects(rect(0, 0, 10, 10), rect(10, 0, 20, 10))).toBe(false);
    expect(intersects(rect(0, 0, 10, 10), rect(10, 0, 20, 10), 1)).toBe(true);
    expect(intersects(rect(0, 0, 10, 10), rect(30, 30, 40, 40), 5)).toBe(false);
  });

  it("is the box the owl fills: as big as the owl, centred on its feet, its tail below them", () => {
    const box = owlBox({ x: 500, y: 400 }, size);
    expect(box).toEqual(perchedBox({ x: 500, y: 400 }, size));
    expect(box.right - box.left).toBe(size.width);
    expect((box.left + box.right) / 2).toBe(500);
    expect(box.top).toBeLessThan(400);
    expect(box.bottom).toBeGreaterThan(400);
  });

  it("says an owl standing on text covers it, one beside it does not, and one just clear by the margin does not", () => {
    const text = rect(400, 300, 800, 360);
    expect(overlaps({ x: 600, y: 330 }, size, [text])).toBe(true);
    expect(overlaps({ x: 1000, y: 330 }, size, [text])).toBe(false);
    const edge = text.right + size.width / 2 + AVOID_MARGIN;
    expect(overlaps({ x: edge + 0.5, y: 330 }, size, [text], AVOID_MARGIN)).toBe(false);
    expect(overlaps({ x: edge - 0.5, y: 330 }, size, [text], AVOID_MARGIN)).toBe(true);
  });
});

describe("the viewport", () => {
  it("keeps the whole owl on screen at every corner", () => {
    for (const corner of [{ x: -1e9, y: -1e9 }, { x: 1e9, y: -1e9 }, { x: -1e9, y: 1e9 }, { x: 1e9, y: 1e9 }]) {
      const box = owlBox(clampFeet(corner, size, VIEW), size);
      expect(box.left).toBeGreaterThanOrEqual(-1e-6);
      expect(box.top).toBeGreaterThanOrEqual(-1e-6);
      expect(box.right).toBeLessThanOrEqual(VIEW.width + 1e-6);
      expect(box.bottom).toBeLessThanOrEqual(VIEW.height + 1e-6);
    }
    expect(clampFeet({ x: 700, y: 450 }, size, VIEW)).toEqual({ x: 700, y: 450 });
  });

  it("is tight: the feet can stand on the very edge of those bounds and no further", () => {
    const bounds = feetBounds(size, VIEW);
    expect(owlBox({ x: bounds.left, y: bounds.top }, size).left).toBeCloseTo(0);
    expect(owlBox({ x: bounds.left, y: bounds.top }, size).top).toBeCloseTo(0);
    expect(owlBox({ x: bounds.right, y: bounds.bottom }, size).right).toBeCloseTo(VIEW.width);
    expect(owlBox({ x: bounds.right, y: bounds.bottom }, size).bottom).toBeCloseTo(VIEW.height);
  });

  it("copes with a screen smaller than the owl", () => {
    const point = clampFeet({ x: 500, y: 500 }, size, { width: 60, height: 60 });
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });
});

describe("growForOwl", () => {
  it("makes 'does the box touch this' the same question as 'are the feet inside this', for any rect and any place", () => {
    const random = generator(7);
    for (let index = 0; index < 3000; index += 1) {
      const [target] = scene(random, 1);
      const feet = { x: random() * 1440, y: random() * 900 };
      const margin = random() * 20;
      expect(inside(feet, growForOwl(target!, size, margin)), JSON.stringify({ target, feet, margin })).toBe(overlaps(feet, size, [target!], margin));
    }
  });
});

describe("nearestFreeFeet", () => {
  const bounds = feetBounds(size, VIEW);
  const grow = (...rects: Rect[]) => rects.map(item => growForOwl(item, size));

  it("is the point itself when nothing holds it, kept inside the bounds", () => {
    const point = { x: 700, y: 450 };
    expect(nearestFreeFeet(point, grow(rect(0, 0, 100, 100)), bounds)).toEqual(point);
    expect(nearestFreeFeet({ x: -500, y: -500 }, [], bounds)).toEqual({ x: bounds.left, y: bounds.top });
  });

  it("leaves a rect by the nearest edge, level with where it was", () => {
    const text = rect(500, 400, 900, 480);
    const grown = growForOwl(text, size);
    const nearLeft = { x: grown.left + 10, y: 440 };
    const exit = nearestFreeFeet(nearLeft, [grown], bounds)!;
    expect(exit.x).toBeLessThanOrEqual(grown.left);
    expect(grown.left - exit.x).toBeLessThan(0.1);
    expect(exit.y).toBe(440);
    const nearBottom = { x: 700, y: grown.bottom - 5 };
    const down = nearestFreeFeet(nearBottom, [grown], bounds)!;
    expect(down.y).toBeGreaterThanOrEqual(grown.bottom);
    expect(down.y - grown.bottom).toBeLessThan(0.1);
    expect(down.x).toBe(700);
  });

  it("leaves two rects that hold it between them, and ends clear of both", () => {
    const grown = grow(rect(500, 400, 700, 600), rect(660, 380, 900, 560));
    const start = { x: 690, y: 500 };
    expect(grown.every(item => inside(start, item))).toBe(true);
    const exit = nearestFreeFeet(start, grown, bounds)!;
    expect(grown.some(item => inside(exit, item))).toBe(false);
  });

  it("goes out through a neighbouring rect when that is the nearest way, not only out of the first that holds it", () => {
    // Every way out of the wide block but the far right lands inside the narrow one beside it; past that one is clear and near.
    const wide = growForOwl(rect(300, 300, 1100, 700), size);
    const narrow = growForOwl(rect(150, 250, 330, 750), size);
    const start = { x: 300, y: 500 };
    expect(inside(start, wide) && inside(start, narrow)).toBe(true);
    const exit = nearestFreeFeet(start, [wide, narrow], bounds)!;
    expect([wide, narrow].some(item => inside(exit, item))).toBe(false);
    expect(Math.hypot(exit.x - start.x, exit.y - start.y)).toBeLessThan(300);
    expect(exit.x).toBeLessThan(start.x);
  });

  it("goes out of an open end when the other three sides are walled", () => {
    // A pocket: thick walls on the left, right and bottom, a gap between them too narrow for the owl, open above.
    const grown = grow(rect(100, 300, 500, 700), rect(560, 300, 960, 700), rect(100, 600, 960, 900));
    const start = { x: 530, y: 560 };
    expect(grown.some(item => inside(start, item))).toBe(true);
    const exit = nearestFreeFeet(start, grown, bounds)!;
    expect(grown.some(item => inside(exit, item))).toBe(false);
    expect(exit.y).toBeLessThan(300);
    expect(exit.x).toBe(530);
  });

  it("finds nowhere to go when one rect holds all of the bounds", () => {
    const everything = { left: bounds.left - 10, right: bounds.right + 10, top: bounds.top - 10, bottom: bounds.bottom + 10 };
    expect(nearestFreeFeet({ x: 700, y: 450 }, [everything], bounds)).toBeNull();
  });

  it("always returns a place that is clear and inside the bounds, or nothing", () => {
    const random = generator(11);
    for (let index = 0; index < 400; index += 1) {
      const grown = scene(random, 3 + Math.floor(random() * 8)).map(item => growForOwl(item, size));
      const start = { x: random() * 1440, y: random() * 900 };
      const exit = nearestFreeFeet(start, grown, bounds);
      if (exit === null) continue;
      expect(grown.some(item => inside(exit, item)), `scene ${index}`).toBe(false);
      expect(exit.x).toBeGreaterThanOrEqual(bounds.left - 1e-9);
      expect(exit.x).toBeLessThanOrEqual(bounds.right + 1e-9);
      expect(exit.y).toBeGreaterThanOrEqual(bounds.top - 1e-9);
      expect(exit.y).toBeLessThanOrEqual(bounds.bottom + 1e-9);
    }
  });

  it("does not go further than the nearest edge of the rect that holds the point, when that edge is clear", () => {
    const grown = growForOwl(rect(300, 300, 700, 500), size);
    const start = { x: 450, y: 420 };
    const best = Math.min(start.x - grown.left, grown.right - start.x, start.y - grown.top, grown.bottom - start.y);
    const exit = nearestFreeFeet(start, [grown], bounds)!;
    expect(Math.hypot(exit.x - start.x, exit.y - start.y)).toBeLessThan(best + 0.1);
  });
});

describe("chooseTarget", () => {
  // Two blocks with a corridor between them wide enough for the owl, a third on the right, and open ground below and at the edge.
  const text = [rect(100, 100, 700, 300), rect(100, 500, 700, 700), rect(900, 100, 1300, 500)];
  const base = { owl: { x: 1100, y: 760 }, idleMs: 0, rects: text, perches: [] as Point[], size, viewport: VIEW };
  const top: Point = { x: 1370, y: 150 };
  const bottom: Point = { x: 200, y: 860 };

  it("follows the pointer where nothing is covered", () => {
    const choice = chooseTarget({ ...base, pointer: { x: 400, y: 450 } });
    expect(choice).toEqual({ target: { x: 400, y: 450 }, kind: "follow", perch: null });
  });

  it("keeps the owl on screen when the pointer is off it", () => {
    const choice = chooseTarget({ ...base, pointer: { x: -300, y: 5000 } });
    expect(choice.kind).toBe("follow");
    expect(overlaps(choice.target, size, [], 0)).toBe(false);
    expect(owlBox(choice.target, size).bottom).toBeLessThanOrEqual(VIEW.height + 1e-6);
    expect(owlBox(choice.target, size).left).toBeGreaterThanOrEqual(-1e-6);
  });

  it("goes to the nearest clear place when the pointer is over text", () => {
    const choice = chooseTarget({ ...base, pointer: { x: 400, y: 200 } });
    expect(choice.kind).toBe("push");
    expect(overlaps(choice.target, size, text, AVOID_MARGIN - 0.5)).toBe(false);
    // The corridor below the first block is the nearest clear place: the owl's box top sits just under the text.
    expect(choice.target.x).toBe(400);
    expect(choice.target.y).toBeGreaterThan(300 + AVOID_MARGIN);
    expect(Math.hypot(choice.target.x - 400, choice.target.y - 200)).toBeLessThanOrEqual(MAX_PUSH_PX);
  });

  it("never covers anything it follows or is pushed to, for any pointer over any page", () => {
    const random = generator(23);
    for (let index = 0; index < 600; index += 1) {
      const rects = scene(random, 4 + Math.floor(random() * 8));
      const choice = chooseTarget({ ...base, rects, pointer: { x: random() * 1440, y: random() * 900 } });
      if (choice.kind === "follow" || choice.kind === "push") expect(overlaps(choice.target, size, rects, AVOID_MARGIN - 0.5), `scene ${index}`).toBe(false);
    }
  });

  it("goes to a perch when the pointer is over text and no clear place is near", () => {
    const wall = [rect(0, 0, 1440, 900)];
    const perches = [top, bottom];
    const choice = chooseTarget({ ...base, rects: wall, perches, pointer: { x: 300, y: 700 } });
    expect(choice).toEqual({ target: bottom, kind: "perch", perch: 1 });
  });

  it("takes a perch over a clear place that is further than it is worth going", () => {
    const wide = [rect(0, 0, 1440, 700)];
    const choice = chooseTarget({ ...base, rects: wide, perches: [bottom], pointer: { x: 700, y: 100 } });
    // The only clear ground is the strip below the text, more than the push limit away.
    expect(Math.abs(700 - 100) + 100).toBeGreaterThan(MAX_PUSH_PX);
    expect(choice).toEqual({ target: bottom, kind: "perch", perch: 0 });
  });

  it("with no perch and no clear place near, still prefers a far clear place to covering text", () => {
    const wide = [rect(0, 0, 1440, 700)];
    const choice = chooseTarget({ ...base, rects: wide, perches: [], pointer: { x: 700, y: 100 } });
    expect(choice.kind).toBe("push");
    expect(overlaps(choice.target, size, wide, AVOID_MARGIN - 0.5)).toBe(false);
    expect(choice.target.y).toBeGreaterThan(700);
  });

  it("holds where it is when there is no clear place at all", () => {
    const choice = chooseTarget({ ...base, rects: [rect(-10, -10, 1450, 910)], perches: [], pointer: { x: 700, y: 450 }, owl: { x: 600, y: 600 } });
    expect(choice).toEqual({ target: { x: 600, y: 600 }, kind: "hold", perch: null });
  });

  it("lands on a perch the pointer comes within reach of, even over a clear place", () => {
    const perches = [top];
    const near = chooseTarget({ ...base, perches, pointer: { x: top.x - PERCH_NEAR_PX + 5, y: top.y } });
    expect(near).toEqual({ target: top, kind: "perch", perch: 0 });
    const far = chooseTarget({ ...base, perches, pointer: { x: 1100, y: 760 } });
    expect(far.kind).toBe("follow");
  });

  it("goes to the nearest perch to the pointer once the pointer has been still for a moment, but not before", () => {
    const perches = [top, bottom];
    const pointer = { x: 300, y: 450 };
    expect(chooseTarget({ ...base, perches, pointer, idleMs: IDLE_MS }).kind).toBe("follow");
    const idle = chooseTarget({ ...base, perches, pointer, idleMs: IDLE_MS + 1 });
    expect(idle).toEqual({ target: bottom, kind: "perch", perch: 1 });
  });

  it("stays put while it is reading something, however long the pointer rests", () => {
    const choice = chooseTarget({ ...base, perches: [top], pointer: { x: 400, y: 450 }, idleMs: 60_000, busy: true });
    expect(choice.kind).toBe("follow");
  });

  it("picks the same place for the same input", () => {
    const input = { ...base, pointer: { x: 400, y: 200 }, perches: [top] };
    expect(chooseTarget(input)).toEqual(chooseTarget(input));
  });
});

describe("placeBubble", () => {
  const owl = rect(1300, 100, 1410, 228);
  const bubble = { width: 240, height: 48 };
  const place = (rects: Rect[], over: Partial<Parameters<typeof placeBubble>[0]> = {}) => placeBubble({ owl, bubble, rects, viewport: VIEW, ...over });

  it("goes to the owl's left, about its head, when that is clear", () => {
    const spot = place([])!;
    expect(spot.right).toBe(owl.left - 8);
    expect(spot.right - spot.left).toBe(bubble.width);
    expect(spot.bottom - spot.top).toBe(bubble.height);
    // Its middle is level with the owl's head, a little above the middle of its box.
    expect((spot.top + spot.bottom) / 2).toBeCloseTo(owl.top + (owl.bottom - owl.top) * 0.3, 6);
  });

  it("goes to the right when the left is taken, and the right is on screen", () => {
    const middle = rect(600, 100, 710, 228);
    const spot = place([rect(360, 80, 590, 240)], { owl: middle })!;
    expect(spot.left).toBe(710 + 8);
  });

  it("goes above, then below, when neither side is open", () => {
    const standing = rect(1000, 400, 1110, 528);
    // Walls level with the owl, to its left and right, leave the room above and below it open.
    const sides = [rect(700, 410, 990, 520), rect(1118, 410, 1440, 520)];
    const above = place(sides, { owl: standing })!;
    expect(above.bottom).toBe(400 - 8);
    expect(above.left).toBeCloseTo((1000 + 1110) / 2 - bubble.width / 2, 6);
    const below = place([...sides, rect(900, 300, 1300, 395)], { owl: standing })!;
    expect(below.top).toBe(528 + 8);
  });

  it("says nowhere when there is nowhere", () => {
    expect(place([rect(0, 0, 1440, 900)])).toBeNull();
  });

  it("never leaves the screen: where the left is off the edge, it goes to the right", () => {
    const spot = place([], { owl: rect(20, 100, 130, 228) })!;
    expect(spot.left).toBeGreaterThanOrEqual(8);
    expect(spot.left).toBe(130 + 8);
  });

  it("does not go past the bottom edge: the one place left would end at 900, over the 892 allowed, so nowhere", () => {
    // Walls on both sides of the owl and a block above it leave only the place below.
    const closed = (box: Rect) => [rect(box.left - 300, box.top + 10, box.left - 10, box.bottom - 8), rect(box.right + 8, box.top + 10, 1440, box.bottom - 8), rect(box.left - 100, box.top - 116, box.right + 190, box.top - 3)];
    const low = rect(1000, 716, 1110, 844);
    expect(place(closed(low), { owl: low })).toBeNull();
    // Eight pixels higher it ends at 892, which is allowed.
    const higher = rect(1000, 708, 1110, 836);
    expect(place(closed(higher), { owl: higher })!.bottom).toBe(892);
  });

  it("does not go past the right edge: the place to the right would end at 1438, over the 1432 allowed, so it goes above", () => {
    const wall = (box: Rect) => rect(700, box.top + 10, box.left - 5, box.bottom - 10);
    const near = rect(1080, 100, 1190, 228);
    expect(place([wall(near)], { owl: near })!.bottom).toBe(100 - 8);
    // Six pixels further left it ends at 1432, which is allowed.
    const fits = rect(1074, 100, 1184, 228);
    expect(place([wall(fits)], { owl: fits })!.left).toBe(1184 + 8);
  });

  it("does not go past the top edge: above would start at -6, under the 8 allowed, so it goes below", () => {
    const sides = (box: Rect) => [rect(box.left - 300, box.top + 10, box.left - 10, box.bottom - 8), rect(box.right + 8, box.top + 10, 1440, box.bottom - 8)];
    const high = rect(1000, 50, 1110, 178);
    expect(place(sides(high), { owl: high })!.top).toBe(178 + 8);
    // Fourteen pixels lower, above starts at 8, which is allowed, and above comes first.
    const lower = rect(1000, 64, 1110, 192);
    expect(place(sides(lower), { owl: lower })!.top).toBe(8);
  });

  it("keeps a margin from what it must not cover", () => {
    const standing = rect(700, 300, 810, 428);
    // The left place starts 5 px from a wall that ends at 447: clear by more than the margin.
    const clear = place([rect(300, 0, 447, 900)], { owl: standing })!;
    expect(clear.left).toBe(700 - 8 - bubble.width);
    // A wall 3 px from it is inside the margin, so the bubble goes to the other side.
    const close = place([rect(300, 0, 449, 900)], { owl: standing })!;
    expect(close.left).toBe(810 + 8);
  });

  it("is always on screen and clear of the rects, wherever the owl is, over any page", () => {
    const random = generator(41);
    for (let index = 0; index < 500; index += 1) {
      const rects = scene(random, 2 + Math.floor(random() * 6));
      const left = 100 + random() * 1100;
      const top = 100 + random() * 500;
      const box = rect(left, top, left + 110, top + 128);
      const spot = placeBubble({ owl: box, bubble, rects, viewport: VIEW });
      if (!spot) continue;
      expect(spot.left, `scene ${index}`).toBeGreaterThanOrEqual(8);
      expect(spot.top, `scene ${index}`).toBeGreaterThanOrEqual(8);
      expect(spot.right, `scene ${index}`).toBeLessThanOrEqual(VIEW.width - 8);
      expect(spot.bottom, `scene ${index}`).toBeLessThanOrEqual(VIEW.height - 8);
      expect(rects.some(item => intersects(spot, item, 3.999)), `scene ${index}`).toBe(false);
    }
  });
});

describe("the brief's numbers", () => {
  it("lands the owl after the pointer has been still for 1.2 seconds, or comes within 120 pixels of a perch", () => {
    expect(IDLE_MS).toBe(1_200);
    expect(PERCH_NEAR_PX).toBe(120);
  });
});

describe("owlOpacity", () => {
  it("is clear on open ground, whatever else is true", () => {
    expect(owlOpacity({ covering: false, coveringMs: 0, stranded: false })).toBe(1);
    expect(owlOpacity({ covering: false, coveringMs: 9_999, stranded: true })).toBe(1);
  });

  it("is faint for a moment over text, then out of sight if it stays", () => {
    expect(owlOpacity({ covering: true, coveringMs: 0, stranded: false })).toBe(FAINT);
    expect(owlOpacity({ covering: true, coveringMs: COVER_GRACE_MS, stranded: false })).toBe(FAINT);
    expect(owlOpacity({ covering: true, coveringMs: COVER_GRACE_MS + 1, stranded: false })).toBe(0);
    expect(FAINT).toBeLessThan(0.5);
    expect(COVER_GRACE_MS).toBeLessThanOrEqual(150);
  });

  it("is out of sight at once over text when nowhere on screen is clear", () => {
    expect(owlOpacity({ covering: true, coveringMs: 0, stranded: true })).toBe(0);
  });
});

describe("the owl across a page of text", () => {
  // Nine blocks of text with corridors between them wide enough for the owl, and a perch at the top right.
  const blocks: Rect[] = [];
  for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) blocks.push(rect(60 + column * 420, 60 + row * 270, 60 + column * 420 + 270, 60 + row * 270 + 110));
  const perch = { x: 1370, y: 140 };
  const tail = (fn: (frame: number) => void, frames: number) => {
    for (let frame = 0; frame < frames; frame += 1) fn(frame);
  };

  it("never goes faster or further a frame than its limits, never stretches past eight percent, and is never settled over text for long", () => {
    const random = generator(5);
    const state = createOwlState(perch.x, perch.y);
    const pointerAt = (second: number): Point => {
      // Wander across the whole page, with a long rest every ten seconds, and a hard throw across it now and then.
      if (second % 10 > 7) return { x: 700, y: 480 };
      if (Math.floor(second) % 4 === 3) return { x: second % 2 > 1 ? 30 : 1410, y: second % 3 > 1.5 ? 40 : 860 };
      return { x: 720 + Math.sin(second * 0.9) * 680, y: 450 + Math.cos(second * 0.6) * 400 };
    };
    let fastest = 0;
    let farthest = 0;
    let stretchX = 0;
    let stretchY = 0;
    let runOverText = 0;
    let longestRun = 0;
    let lastIdleAt = 0;
    let previous = { x: perch.x, y: perch.y };
    const dt = 1000 / 60;
    tail(frame => {
      const now = frame * dt;
      const second = now / 1000;
      const pointer = pointerAt(second);
      if (frame === 0 || Math.hypot(pointer.x - pointerAt(second - 1 / 60).x, pointer.y - pointerAt(second - 1 / 60).y) > 0.5) lastIdleAt = now;
      const choice = chooseTarget({ pointer, owl: { x: state.x, y: state.y }, idleMs: now - lastIdleAt, rects: blocks, perches: [perch], size, viewport: VIEW });
      const onPerch = choice.kind === "perch";
      const input: OwlInput = { dtMs: dt, nowMs: now, target: choice.target, reducedMotion: false, scanning: false, size, onPerch };
      const pose = stepOwl(state, input, random);
      fastest = Math.max(fastest, Math.hypot(state.vx, state.vy));
      farthest = Math.max(farthest, Math.hypot(state.x - previous.x, state.y - previous.y));
      previous = { x: state.x, y: state.y };
      stretchX = Math.max(stretchX, Math.abs(Math.abs(pose.rootScaleX) / Math.abs(state.flip || 1) - 1));
      stretchY = Math.max(stretchY, Math.abs(pose.rootScaleY - 1));
      const settled = Math.hypot(state.vx, state.vy) < 60;
      if (settled && overlaps({ x: state.x, y: state.y }, size, blocks)) runOverText += 1;
      else runOverText = 0;
      longestRun = Math.max(longestRun, runOverText);
    }, 60 * 120);
    // The run is looking at something: the owl is thrown across the page hard enough to reach the cap.
    expect(fastest).toBeGreaterThan(MAX_SPEED * 0.8);
    expect(stretchY).toBeGreaterThan(0.01);
    expect(fastest).toBeLessThanOrEqual(MAX_SPEED + 1e-6);
    expect(farthest).toBeLessThanOrEqual(MAX_FRAME_PX + 1e-6);
    expect(stretchX).toBeLessThanOrEqual(MAX_STRETCH + 1e-9);
    expect(stretchY).toBeLessThanOrEqual(MAX_STRETCH + 1e-9);
    // 150 ms is nine frames at 60 a second.
    expect(longestRun).toBeLessThanOrEqual(9);
  });

  it("comes to rest on the perch when the pointer rests, and sits there inside its box", () => {
    const random = generator(9);
    const state = createOwlState(700, 700);
    const rest = { x: 700, y: 700 };
    let now = 0;
    tail(frame => {
      now = frame * (1000 / 60);
      const choice = chooseTarget({ pointer: rest, owl: { x: state.x, y: state.y }, idleMs: now, rects: blocks, perches: [perch], size, viewport: VIEW });
      stepOwl(state, { dtMs: 1000 / 60, nowMs: now, target: choice.target, reducedMotion: false, scanning: false, size, onPerch: choice.kind === "perch" }, random);
    }, 60 * 8);
    expect(Math.hypot(state.x - perch.x, state.y - perch.y)).toBeLessThan(1);
    expect(state.mode).toBe("perched");
    expect(overlaps({ x: state.x, y: state.y }, size, blocks, AVOID_MARGIN)).toBe(false);
  });
});
