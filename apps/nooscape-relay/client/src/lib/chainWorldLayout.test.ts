import { describe, expect, it } from "vitest";
import {
  allocateFigures,
  composeWorld,
  FIGURE_BOX,
  FORMATION_BOX_W,
  formationBoxHeight,
  groupSize,
  gridFor,
  MAX_GROUPS_SHOWN,
  NARROW_FIGURES,
  NARROW_WIDTH,
  SPLIT_WIDTH,
  WIDE_FIGURES,
  WORLD_FRAME,
  WORLD_MIN_HEIGHT,
  ZONE,
  type Arrangement,
  type PlacedItem,
  type ZoneSpec,
} from "./chainWorldLayout";

const WIDTHS = [260, 320, 347, 375, 480, 639, 640, 700, 768, 1030, 1400, 1800];
const COUNTS = [100, 5_593, 130_144, 1_165, 332, 902, 40_983, 127_498, 9_684, 7_174, 133, 3_248];
const groupsOf = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-g${index}`, size: groupSize(COUNTS[index % COUNTS.length]!) }));
const figuresOf = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-f${index}-${"x".repeat(index % 4)}`);
const zone = (id: string, groups: number, figures: number): ZoneSpec => ({ id, groups: groupsOf(id, groups), figureIds: figuresOf(id, figures) });

/** Worlds of every shape: none, one zone, a narrow zone beside a wide one, three lanes, four platforms, and too many of everything. */
const WORLDS: Array<{ name: string; zones: ZoneSpec[] }> = [
  { name: "no zones", zones: [] },
  { name: "one zone", zones: [zone("a", 3, 8)] },
  { name: "wallets and identities", zones: [zone("wallets", 6, 0), zone("identities", 0, 24)] },
  { name: "three lanes", zones: [zone("metaplex", 3, 7), zone("8004", 3, 5), zone("said", 0, 4)] },
  { name: "four platforms", zones: [zone("host", 5, 0), zone("link", 2, 0), zone("wallet", 3, 0), zone("template", 1, 0)] },
  { name: "too many", zones: [zone("big", 40, 24), zone("empty", 0, 0), zone("other", 12, 3)] },
];

const overlap = (a: PlacedItem, ea: { w: number; h: number }, b: PlacedItem, eb: { w: number; h: number }) => Math.abs(a.x - b.x) < (ea.w + eb.w) / 2 && Math.abs(a.y - b.y) < (ea.h + eb.h) / 2;
const sizesOf = (zones: readonly ZoneSpec[]) => new Map(zones.flatMap(z => z.groups.map(group => [group.id, group.size] as const)));

describe("the chain world composition", () => {
  it("never stands one thing on another, at any width, in any world", () => {
    for (const width of WIDTHS) {
      for (const arrangement of ["columns", "split"] as Arrangement[]) {
        for (const world of WORLDS) {
          const sizeOf = sizesOf(world.zones);
          const layout = composeWorld({ width, arrangement, zones: world.zones });
          const all = [
            ...layout.groups.map(item => ({ item, box: { w: FORMATION_BOX_W, h: formationBoxHeight(sizeOf.get(item.id)!) } })),
            ...layout.figures.map(item => ({ item, box: FIGURE_BOX })),
          ];
          for (let i = 0; i < all.length; i += 1) {
            for (let j = i + 1; j < all.length; j += 1) {
              expect(overlap(all[i]!.item, all[i]!.box, all[j]!.item, all[j]!.box), `${width}px ${arrangement} ${world.name}: ${all[i]!.item.id} and ${all[j]!.item.id}`).toBe(false);
            }
          }
        }
      }
    }
  });

  it("keeps every thing inside its own zone, below the zone's name and above its foot", () => {
    for (const width of WIDTHS) {
      for (const arrangement of ["columns", "split"] as Arrangement[]) {
        for (const world of WORLDS) {
          const sizeOf = sizesOf(world.zones);
          const layout = composeWorld({ width, arrangement, zones: world.zones });
          for (const placed of layout.zones) {
            const spec = world.zones.find(z => z.id === placed.id)!;
            const mine = [
              ...layout.groups.filter(item => spec.groups.some(group => group.id === item.id)).map(item => ({ item, w: FORMATION_BOX_W, h: formationBoxHeight(sizeOf.get(item.id)!) })),
              ...layout.figures.filter(item => spec.figureIds.includes(item.id)).map(item => ({ item, w: FIGURE_BOX.w, h: FIGURE_BOX.h })),
            ];
            for (const { item, w, h } of mine) {
              const label = `${width}px ${arrangement} ${world.name} ${item.id}`;
              expect(item.x - w / 2, `${label} left`).toBeGreaterThanOrEqual(placed.x + ZONE.pad - 1);
              expect(item.x + w / 2, `${label} right`).toBeLessThanOrEqual(placed.x + placed.w - ZONE.pad + 1);
              expect(item.y - h / 2, `${label} top`).toBeGreaterThanOrEqual(placed.y + ZONE.header - 2);
              expect(item.y + h / 2, `${label} bottom`).toBeLessThanOrEqual(placed.y + placed.h - ZONE.bottomPad + 4);
            }
          }
        }
      }
    }
  });

  it("sets the zones out without crossing: inside the stage, below the title bar, with the foot kept clear", () => {
    for (const width of WIDTHS) {
      for (const arrangement of ["columns", "split"] as Arrangement[]) {
        for (const world of WORLDS) {
          const layout = composeWorld({ width, arrangement, zones: world.zones });
          for (const z of layout.zones) {
            expect(z.x, `${width} ${world.name} ${z.id} left`).toBeGreaterThanOrEqual(0);
            expect(z.x + z.w, `${width} ${world.name} ${z.id} right`).toBeLessThanOrEqual(layout.width);
            expect(z.y).toBeGreaterThanOrEqual(WORLD_FRAME.top);
            expect(z.y + z.h + WORLD_FRAME.bottom).toBeLessThanOrEqual(layout.height);
          }
          for (let i = 0; i < layout.zones.length; i += 1) {
            for (let j = i + 1; j < layout.zones.length; j += 1) {
              const a = layout.zones[i]!;
              const b = layout.zones[j]!;
              const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
              expect(apart, `${width} ${arrangement} ${world.name}: ${a.id} and ${b.id}`).toBe(true);
            }
          }
          expect(layout.height).toBeGreaterThanOrEqual(WORLD_MIN_HEIGHT);
        }
      }
    }
  });

  it("stacks the zones on a narrow stage, and sets them side by side on a wide one", () => {
    const three = WORLDS.find(world => world.name === "three lanes")!.zones;
    const narrow = composeWorld({ width: 375, arrangement: "columns", zones: three });
    expect(narrow.rows).toEqual([1, 1, 1]);
    const wide = composeWorld({ width: 1030, arrangement: "columns", zones: three });
    expect(wide.rows).toEqual([3]);
    expect(wide.zones.every(z => z.w >= ZONE.minWidth)).toBe(true);
    expect(new Set(wide.zones.map(z => z.h)).size).toBe(1);
    // A fourth platform on a stage that holds three across goes in a second row, and the rows are even.
    const four = composeWorld({ width: 1030, arrangement: "columns", zones: WORLDS.find(world => world.name === "four platforms")!.zones });
    expect(four.rows).toEqual([2, 2]);
  });

  it("splits a narrow zone beside a wide one when asked and there is room, and stacks them when there is not", () => {
    const pair = WORLDS.find(world => world.name === "wallets and identities")!.zones;
    const split = composeWorld({ width: 1030, arrangement: "split", zones: pair });
    expect(split.rows).toEqual([2]);
    expect(split.zones[0]!.w).toBeLessThan(split.zones[1]!.w);
    expect(split.zones[0]!.w / (split.zones[0]!.w + split.zones[1]!.w)).toBeCloseTo(0.4, 1);
    expect(composeWorld({ width: SPLIT_WIDTH + 39, arrangement: "split", zones: pair }).rows).toEqual([2]);
    expect(composeWorld({ width: NARROW_WIDTH - 1, arrangement: "split", zones: pair }).rows).toEqual([1, 1]);
    // Wide enough for two columns but not for the split: they stand side by side, evenly.
    const even = composeWorld({ width: 660, arrangement: "split", zones: pair });
    expect(even.rows).toEqual([2]);
    expect(Math.abs(even.zones[0]!.w - even.zones[1]!.w)).toBeLessThanOrEqual(1);
  });

  it("leaves a zone with nothing in it out, and makes a stage of only the minimum height of a world with nothing", () => {
    const layout = composeWorld({ width: 1030, arrangement: "columns", zones: [zone("a", 2, 0), zone("none", 0, 0)] });
    expect(layout.zones.map(z => z.id)).toEqual(["a"]);
    const empty = composeWorld({ width: 1030, arrangement: "columns", zones: [] });
    expect(empty.zones).toEqual([]);
    expect(empty.groups).toEqual([]);
    expect(empty.height).toBe(WORLD_MIN_HEIGHT);
  });

  it("draws at most the limit of formations in a zone", () => {
    const layout = composeWorld({ width: 1030, arrangement: "columns", zones: [zone("big", 40, 0)] });
    expect(layout.groups).toHaveLength(MAX_GROUPS_SHOWN);
  });

  it("hangs the drawings in a row of formations from one line, and gives a row of small ones less room than a row of large ones", () => {
    const sizes: Record<string, number> = { a: 112, b: 48, c: 80 };
    const row = composeWorld({ width: 1030, arrangement: "columns", zones: [{ id: "z", groups: [{ id: "a", size: 112 }, { id: "b", size: 48 }, { id: "c", size: 80 }], figureIds: [] }] });
    const tops = row.groups.map(item => item.y - formationBoxHeight(sizes[item.id]!) / 2);
    // They hang from one line, give or take the pixel of wobble each is allowed and the rounding.
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(3);
    const small = composeWorld({ width: 1030, arrangement: "columns", zones: [{ id: "z", groups: [{ id: "a", size: 48 }, { id: "b", size: 48 }], figureIds: [] }] });
    const large = composeWorld({ width: 1030, arrangement: "columns", zones: [{ id: "z", groups: [{ id: "a", size: 112 }, { id: "b", size: 112 }], figureIds: [] }] });
    expect(small.zones[0]!.h).toBeLessThan(large.zones[0]!.h);
    expect(formationBoxHeight(48)).toBeLessThan(formationBoxHeight(112));
  });

  it("shares the figure limit out round and round, to the zones that have more to show", () => {
    expect(allocateFigures(1030, [{ id: "a", available: 100 }, { id: "b", available: 100 }, { id: "c", available: 100 }])).toEqual({ a: 8, b: 8, c: 8 });
    expect(allocateFigures(1030, [{ id: "a", available: 7 }, { id: "b", available: 5 }, { id: "c", available: 4 }])).toEqual({ a: 7, b: 5, c: 4 });
    // A zone with little gives its share to the rest.
    expect(allocateFigures(1030, [{ id: "a", available: 2 }, { id: "b", available: 100 }])).toEqual({ a: 2, b: WIDE_FIGURES - 2 });
    expect(allocateFigures(375, [{ id: "a", available: 100 }, { id: "b", available: 100 }])).toEqual({ a: NARROW_FIGURES / 2, b: NARROW_FIGURES / 2 });
    expect(allocateFigures(1030, [{ id: "a", available: 0 }, { id: "b", available: 3 }])).toEqual({ a: 0, b: 3 });
    expect(allocateFigures(1030, [])).toEqual({});
    for (const width of [375, 1030]) {
      const slots = allocateFigures(width, [{ id: "a", available: 50 }, { id: "b", available: 1 }, { id: "c", available: 50 }]);
      expect(slots.b).toBe(1);
      expect(Object.values(slots).reduce((sum, count) => sum + count, 0)).toBe(width < NARROW_WIDTH ? NARROW_FIGURES : WIDE_FIGURES);
    }
  });

  it("puts the same things in the same places every time", () => {
    const zones = WORLDS.find(world => world.name === "three lanes")!.zones;
    expect(composeWorld({ width: 900, arrangement: "columns", zones })).toEqual(composeWorld({ width: 900, arrangement: "columns", zones }));
  });

  it("splits cells into as few, as even rows as the width allows", () => {
    expect(gridFor(0, 6)).toEqual({ cols: 0, rows: 0 });
    expect(gridFor(16, 8)).toEqual({ cols: 8, rows: 2 });
    expect(gridFor(10, 7)).toEqual({ cols: 5, rows: 2 });
    expect(gridFor(9, 3)).toEqual({ cols: 3, rows: 3 });
    expect(gridFor(5, 2)).toEqual({ cols: 2, rows: 3 });
  });

  it("sizes a formation by the log of its count, from 48 at 100 to 112 at 130,000, and by nothing else", () => {
    expect(groupSize(0)).toBe(48);
    expect(groupSize(100)).toBe(48);
    expect(groupSize(130_144)).toBe(112);
    expect(groupSize(10_000_000)).toBe(112);
    expect(groupSize(5_593) - groupSize(100)).toBeGreaterThan(30);
    for (let count = 1; count < 1_000_000; count *= 3) expect(groupSize(count + 1)).toBeGreaterThanOrEqual(groupSize(count));
  });
});
