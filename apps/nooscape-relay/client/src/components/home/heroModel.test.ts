import { describe, expect, it } from "vitest";
import { FLEET_MIN, MAX_FLEETS, type Fleet, type Light, type NoosphereSample } from "@shared/noosphere";
import {
  activeSweep,
  DRIFT_PERIOD_S,
  DRIFT_RADIUS_PX,
  driftOffset,
  fleetBounds,
  fleetCenters,
  fleetCountText,
  fleetRadius,
  fleetSightedText,
  groupLights,
  HERO_COPY,
  heroFigures,
  latestSweepAt,
  LEGEND,
  lightBudget,
  lightCount,
  parallaxOffset,
  PARALLAX_MAX_PX,
  placeLights,
  sampleCaption,
  SIGHTING_ROOM,
  splitLabel,
  stillHighlight,
  SWEEP_EVERY_MS,
  SWEEP_FIRST_MS,
  SWEEP_LASTS_MS,
  sweepEnvelope,
  sweepHeading,
  sweepMiddle,
  sweepOrder,
  type PlacedLight,
  type Rect,
} from "./heroModel";
import { CHAIN_STYLE } from "./constellationModel";

const BOX = { width: 1200, height: 800 };
const ZONE: Rect = { x: 700, y: 300, width: 460, height: 460 };
const fleet = (wallet: string, size: number, chain: Fleet["chain"] = "robinhood"): Fleet => ({ wallet, size, chain, host: null });

/** Lights: some steady, some plain, and a number in each fleet. */
function build(over: { steady?: number; plain?: number; fleets?: Fleet[]; perFleet?: number; total?: number } = {}): NoosphereSample {
  const steady = over.steady ?? 20;
  const plain = over.plain ?? 200;
  const fleets = over.fleets ?? [fleet("0xaaa", 90_000), fleet("0xbbb", 4_000, "bnb"), fleet("0xccc", 300, "solana")];
  const perFleet = over.perFleet ?? 60;
  const lights: Light[] = [];
  for (let index = 0; index < steady; index += 1) lights.push([1_000 + index * 7919, ((index % 3) + 1) as 1 | 2 | 3, 1, 0]);
  for (let index = 0; index < plain; index += 1) lights.push([500_000 + index * 104_729, ((index % 3) + 1) as 1 | 2 | 3, 0, 0]);
  fleets.forEach((_, which) => {
    for (let index = 0; index < perFleet; index += 1) lights.push([9_000_000 + which * 777_777 + index * 31_337, ((which % 3) + 1) as 1 | 2 | 3, 0, which + 1]);
  });
  return { asOf: "2026-10-14T20:00:00.000Z", total: over.total ?? 31_873, sampled: lights.length - steady, steady, lights, fleets };
}

describe("the hero's words", () => {
  it("are the headline, the subcopy and the two calls to action, word for word (the naming record is docs/naming-2026-10-18.md)", () => {
    expect(HERO_COPY.headline.join(" ")).toBe("The Owl watches the Noosphere. Look up any agent. See what the evidence shows.");
    expect(HERO_COPY.subcopy).toBe(
      "Nooscape watches the public agent registries on Solana, Robinhood Chain and BNB Chain, groups the copycat fleets, and keeps the evidence it can read, labeled by how much has been checked. Most records are listed only. A few are reviewed. No scores for sale. No rankings for hire.",
    );
    expect(HERO_COPY.primaryCta).toBe("Ask the Owl");
    expect(HERO_COPY.secondaryCta).toBe("Explore the Noosphere");
  });

  it("say in the legend that light is evidence, not a score, and what steady and dim mean", () => {
    expect(LEGEND.rule).toBe("Light is evidence, not a score.");
    expect(LEGEND.steady).toMatch(/evidence on record/);
    expect(LEGEND.fleet).toMatch(/fleet/i);
    expect(LEGEND.fleet).toMatch(/registering wallet/);
    expect(LEGEND.plain).toMatch(/no evidence on record yet/);
  });
});

describe("the sweep heading", () => {
  it("is the newest successful read of any chain, in UTC", () => {
    const rows = [{ asOf: "2026-10-14T15:30:00.000Z" }, { asOf: "2026-10-14T18:05:00.000Z" }, { asOf: null }, { asOf: "2026-10-13T01:00:00.000Z" }];
    expect(latestSweepAt(rows)).toBe("2026-10-14T18:05:00.000Z");
    expect(sweepHeading(latestSweepAt(rows))).toBe("The Owl's last sweep: 14 Oct 2026, 18:05 UTC");
  });

  it("skips a time it cannot read, and says so when no chain has been read", () => {
    expect(latestSweepAt([{ asOf: "not a date" }, { asOf: "2026-10-14T01:02:00.000Z" }])).toBe("2026-10-14T01:02:00.000Z");
    expect(latestSweepAt([{ asOf: null }, { asOf: "garbage" }])).toBeNull();
    expect(latestSweepAt([])).toBeNull();
    expect(sweepHeading(null)).toBe("The Owl has not finished a sweep yet");
  });

  it("says it is reading, or that the read failed, instead of showing a time it does not have", () => {
    expect(sweepHeading(null, "loading")).toBe("The Owl's last sweep: reading");
    expect(sweepHeading("2026-10-14T18:05:00.000Z", "loading")).toBe("The Owl's last sweep: reading");
    expect(sweepHeading("2026-10-14T18:05:00.000Z", "unavailable")).toBe("The Owl's last sweep: unavailable right now");
    expect(sweepHeading("2026-10-14T18:05:00.000Z", "ready")).toBe("The Owl's last sweep: 14 Oct 2026, 18:05 UTC");
  });
});

describe("the three figures", () => {
  it("are the sample's own counts: what is registered, what has evidence, and the largest fleet", () => {
    const sample = build({ total: 31_873, steady: 12, fleets: [fleet("0xaaa", 126_431), fleet("0xbbb", 900)] });
    expect(heroFigures(sample)).toEqual([
      { label: "registered agents indexed", value: 31_873 },
      { label: "reviewed, with signed evidence kept", value: 12 },
      { label: "registered by the largest fleet's wallet", value: 126_431 },
    ]);
  });

  it("never take a number from the lights that happen to be drawn", () => {
    const sample = build({ total: 5_000_000, steady: 3, plain: 10, fleets: [fleet("0xaaa", 77)], perFleet: 5 });
    const [registered, evidence, largest] = heroFigures(sample);
    expect(registered!.value).toBe(5_000_000);
    expect(registered!.value).not.toBe(sample.lights.length);
    expect(evidence!.value).toBe(3);
    expect(largest!.value).toBe(77);
  });

  it("show a zero that says so, not a borrowed number, when there is no fleet", () => {
    const [, , third] = heroFigures(build({ fleets: [], perFleet: 0 }));
    expect(third).toEqual({ label: `fleets of ${FLEET_MIN} or more found`, value: 0 });
  });

  it("say how many fleets there are without overstating a list that stops at its limit", () => {
    expect(fleetCountText(0)).toBe(`No fleets of ${FLEET_MIN} or more found`);
    expect(fleetCountText(1)).toBe(`1 fleet of ${FLEET_MIN} agents or more`);
    expect(fleetCountText(5)).toBe(`5 fleets of ${FLEET_MIN} agents or more`);
    expect(fleetCountText(MAX_FLEETS)).toBe(`The ${MAX_FLEETS} largest fleets, each ${FLEET_MIN} agents or more`);
  });

  it("word the tooltip and the caption from their counts", () => {
    expect(fleetSightedText({ size: 126_431 })).toBe("Fleet sighted: 126,431 agents, same registering wallet");
    expect(fleetSightedText({ size: 52 })).toBe("Fleet sighted: 52 agents, same registering wallet");
    expect(sampleCaption(1_437, 31_873)).toBe("Sample of 1,437 of 31,873 registered agents");
  });
});

describe("lightBudget", () => {
  it("draws the most on a machine with room, fewer on a weak one, fewest on a phone", () => {
    expect(lightBudget({ cores: 8, memory: 8 })).toBe(1500);
    expect(lightBudget({})).toBe(1500);
    expect(lightBudget({ cores: 4 })).toBe(800);
    expect(lightBudget({ cores: 2 })).toBe(800);
    expect(lightBudget({ cores: 12, memory: 4 })).toBe(800);
    expect(lightBudget({ cores: 8, memory: 8, coarse: true })).toBe(600);
    expect(lightBudget({ cores: 2, coarse: true })).toBe(600);
  });
});

describe("placeLights", () => {
  const sample = build();
  const placed = placeLights(sample, 1500, BOX, ZONE);

  it("draws every light in the sample when the budget allows, and says so before anything is placed", () => {
    expect(placed).toHaveLength(sample.lights.length);
    expect(lightCount(sample, 1500)).toBe(sample.lights.length);
  });

  it("keeps every steady light however small the budget, and thins only the sampled ones", () => {
    const small = placeLights(sample, 100, BOX, ZONE);
    expect(small.filter(light => light.kind === "steady")).toHaveLength(sample.steady);
    expect(small.length).toBeLessThanOrEqual(100 + 1);
    expect(small.length).toBe(lightCount(sample, 100));
    expect(placeLights(sample, 0, BOX, ZONE).filter(light => light.kind !== "steady")).toHaveLength(0);
    expect(placeLights(sample, 0, BOX, ZONE)).toHaveLength(sample.steady);
  });

  it("thins evenly across the sample instead of dropping the end of it", () => {
    const small = placeLights(sample, 120, BOX, ZONE);
    expect(small.some(light => light.kind === "fleet")).toBe(true);
    expect(small.some(light => light.kind === "plain")).toBe(true);
  });

  it("puts a light in the same place on every visit", () => {
    expect(placeLights(sample, 1500, BOX, ZONE)).toEqual(placed);
  });

  it("does not move a plain or steady light when other lights come or go", () => {
    const alone = placeLights({ ...sample, lights: sample.lights.slice(0, 5), steady: 5 }, 1500, BOX, ZONE);
    expect(alone).toEqual(placed.slice(0, 5));
  });

  it("keeps every light inside the hero", () => {
    for (const light of placed) {
      expect(light.x).toBeGreaterThan(0);
      expect(light.x).toBeLessThan(BOX.width);
      expect(light.y).toBeGreaterThan(0);
      expect(light.y).toBeLessThan(BOX.height);
    }
  });

  it("spreads the steady and plain lights over the whole hero, not into one edge or corner", () => {
    const spread = placeLights(build({ steady: 300, plain: 1_000, fleets: [], perFleet: 0 }), 5_000, BOX, ZONE);
    expect(spread).toHaveLength(1_300);
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(spread.map(light => light.x)) / BOX.width).toBeGreaterThan(0.45);
    expect(mean(spread.map(light => light.x)) / BOX.width).toBeLessThan(0.55);
    expect(mean(spread.map(light => light.y)) / BOX.height).toBeGreaterThan(0.45);
    expect(mean(spread.map(light => light.y)) / BOX.height).toBeLessThan(0.55);
    expect(spread.filter(light => light.y >= BOX.height - 10).length / spread.length).toBeLessThan(0.03);
    expect(spread.filter(light => light.x >= BOX.width - 10).length / spread.length).toBeLessThan(0.03);
    for (const [column, row] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const inQuarter = spread.filter(light => Math.floor((light.x / BOX.width) * 2) === column && Math.floor((light.y / BOX.height) * 2) === row);
      expect(inQuarter.length / spread.length, `quarter ${column},${row}`).toBeGreaterThan(0.18);
    }
  });

  it("marks steady, fleet and plain lights by what the sample says and nothing else", () => {
    expect(placed.filter(light => light.kind === "steady")).toHaveLength(sample.steady);
    expect(placed.filter(light => light.kind === "fleet")).toHaveLength(3 * 60);
    expect(placed.filter(light => light.kind === "plain")).toHaveLength(200);
    expect(placed.filter(light => light.kind === "fleet").every(light => light.fleet >= 1 && light.fleet <= 3)).toBe(true);
    expect(placed.filter(light => light.kind !== "fleet").every(light => light.fleet === 0)).toBe(true);
  });

  it("colours a light by its chain and draws a steady one as that chain's shape", () => {
    const steady = placed.filter(light => light.kind === "steady");
    expect(new Set(steady.map(light => light.chain))).toEqual(new Set(["robinhood", "solana", "bnb"]));
    for (const light of placed) {
      expect(light.color).toBe(CHAIN_STYLE[light.chain].color);
      expect(light.shape).toBe(CHAIN_STYLE[light.chain].shape);
    }
    expect(new Set(steady.map(light => light.shape)).size).toBe(3);
  });

  it("makes evidence the brightest and a fleet's lights the dimmest wherever two kinds share a depth", () => {
    const many = placeLights(build({ steady: 80, plain: 400, perFleet: 120 }), 1500, BOX, ZONE);
    const alpha = (kind: PlacedLight["kind"], depth: PlacedLight["depth"]) => many.find(light => light.kind === kind && light.depth === depth)?.alpha;
    let compared = 0;
    for (const depth of [0, 1, 2] as const) {
      const [steady, plain, dim] = [alpha("steady", depth), alpha("plain", depth), alpha("fleet", depth)];
      if (steady !== undefined && plain !== undefined) {
        expect(steady).toBeGreaterThan(plain);
        compared += 1;
      }
      if (plain !== undefined && dim !== undefined) {
        expect(plain).toBeGreaterThan(dim);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(4);
  });

  it("makes steady lights bigger than the rest and nearer lights bigger than far ones", () => {
    const sizes = (kind: PlacedLight["kind"]) => placed.filter(light => light.kind === kind).map(light => light.size);
    expect(Math.min(...sizes("steady"))).toBeGreaterThan(Math.max(...sizes("plain")));
    const far = placed.find(light => light.kind === "plain" && light.depth === 0)!;
    const near = placed.find(light => light.kind === "plain" && light.depth === 2)!;
    expect(near.size).toBeGreaterThan(far.size);
    expect(near.alpha).toBeGreaterThan(far.alpha);
  });

  it("carries a light's looks and place and nothing that could be a rank, a score or a payment", () => {
    expect(Object.keys(placed[0]!).sort()).toEqual(["alpha", "chain", "color", "depth", "fleet", "kind", "phase", "shape", "size", "x", "y"]);
  });

  it("gathers a fleet's lights around a centre of its own, inside the sky reserved for fleets", () => {
    const centers = fleetCenters(sample.fleets, ZONE);
    placed.filter(light => light.kind === "fleet").forEach(light => {
      const center = centers[light.fleet - 1]!;
      expect(Math.hypot(light.x - center.x, light.y - center.y)).toBeLessThanOrEqual(center.radius + 0.001);
      expect(light.x).toBeGreaterThanOrEqual(ZONE.x);
      expect(light.x).toBeLessThanOrEqual(ZONE.x + ZONE.width);
      expect(light.y).toBeGreaterThanOrEqual(ZONE.y);
      expect(light.y).toBeLessThanOrEqual(ZONE.y + ZONE.height);
    });
  });
});

describe("fleetCenters", () => {
  const fleets = [fleet("0xaaa", 90_000), fleet("0xbbb", 4_000), fleet("0xccc", 300), fleet("0xddd", 60)];

  it("keeps each ring, and the tooltip under it, inside the reserved sky", () => {
    fleetCenters(fleets, ZONE).forEach(center => {
      expect(center.x - center.radius).toBeGreaterThanOrEqual(ZONE.x - 0.001);
      expect(center.x + center.radius).toBeLessThanOrEqual(ZONE.x + ZONE.width + 0.001);
      expect(center.y - center.radius).toBeGreaterThanOrEqual(ZONE.y - 0.001);
      expect(center.y + center.radius + SIGHTING_ROOM).toBeLessThanOrEqual(ZONE.y + ZONE.height + 0.001);
    });
  });

  it("keeps the tooltip inside the sky for every wallet, even in a sky only just tall enough for a ring and its tooltip", () => {
    const tight: Rect = { x: 100, y: 100, width: 400, height: 2 * fleetRadius(3_000, 3_000) + SIGHTING_ROOM + 6 };
    for (let index = 0; index < 40; index += 1) {
      const wallet = fleet(`0xwallet${index}`, 3_000);
      const [center] = fleetCenters([wallet], tight);
      expect(center!.y + center!.radius + SIGHTING_ROOM, wallet.wallet).toBeLessThanOrEqual(tight.y + tight.height + 0.001);
      expect(center!.y - center!.radius, wallet.wallet).toBeGreaterThanOrEqual(tight.y - 0.001);
    }
  });

  it("finds every cluster a place clear of the others in a crowded sky", () => {
    const crowd = Array.from({ length: 12 }, (_, index) => fleet(`0xcrowd${index}`, 5_000 - index));
    const centers = fleetCenters(crowd, { x: 0, y: 0, width: 1400, height: 900 });
    for (let a = 0; a < centers.length; a += 1) {
      for (let b = a + 1; b < centers.length; b += 1) {
        expect(Math.hypot(centers[a]!.x - centers[b]!.x, centers[a]!.y - centers[b]!.y), `${a} and ${b}`).toBeGreaterThanOrEqual(centers[a]!.radius + centers[b]!.radius);
      }
    }
  });

  it("keeps the clusters apart when there is room for that", () => {
    const centers = fleetCenters(fleets, { x: 0, y: 0, width: 1400, height: 900 });
    for (let a = 0; a < centers.length; a += 1) {
      for (let b = a + 1; b < centers.length; b += 1) {
        expect(Math.hypot(centers[a]!.x - centers[b]!.x, centers[a]!.y - centers[b]!.y)).toBeGreaterThanOrEqual(centers[a]!.radius + centers[b]!.radius);
      }
    }
  });

  it("is the same on every visit, and the bigger the fleet the bigger the ring", () => {
    expect(fleetCenters(fleets, ZONE)).toEqual(fleetCenters(fleets, ZONE));
    const radii = fleetCenters(fleets, ZONE).map(center => center.radius);
    expect(radii).toEqual([...radii].sort((a, b) => b - a));
    expect(fleetRadius(90_000, 90_000)).toBeGreaterThan(fleetRadius(60, 90_000));
  });

  it("still returns a finite place when the sky is too small to hold the rings", () => {
    for (const center of fleetCenters(fleets, { x: 10, y: 10, width: 20, height: 20 })) {
      expect(Number.isFinite(center.x)).toBe(true);
      expect(Number.isFinite(center.y)).toBe(true);
    }
    expect(fleetCenters([], ZONE)).toEqual([]);
  });
});

describe("groupLights", () => {
  const placed = placeLights(build(), 1500, BOX, ZONE);
  const groups = groupLights(placed);

  it("leaves the steady lights out, since each is drawn as its own shape", () => {
    expect(groups.some(group => group.items.some(light => light.kind === "steady"))).toBe(false);
    expect(groups.reduce((sum, group) => sum + group.items.length, 0)).toBe(placed.filter(light => light.kind !== "steady").length);
  });

  it("puts only lights that look alike in a group, so one fill can draw it", () => {
    for (const group of groups) {
      for (const light of group.items) {
        expect([light.color, light.kind, light.depth]).toEqual([group.color, group.kind, group.depth]);
        expect(light.size).toBe(group.size);
        expect(light.alpha).toBe(group.alpha);
      }
    }
    expect(new Set(groups.map(group => group.key)).size).toBe(groups.length);
  });
});

describe("fleetBounds", () => {
  it("is the middle of a fleet's drawn lights and the reach of the farthest", () => {
    const base = placeLights(build({ steady: 0, plain: 0, perFleet: 2 }), 1500, BOX, ZONE);
    const lights: PlacedLight[] = [
      { ...base[0]!, fleet: 1, x: 100, y: 100 },
      { ...base[0]!, fleet: 1, x: 200, y: 100 },
      { ...base[0]!, fleet: 1, x: 150, y: 190 },
      { ...base[0]!, fleet: 2, x: 900, y: 900 },
    ];
    const bounds = fleetBounds(lights, 1)!;
    expect(bounds.x).toBeCloseTo(150);
    expect(bounds.y).toBeCloseTo(130);
    expect(bounds.count).toBe(3);
    expect(bounds.radius).toBeCloseTo(Math.hypot(0, 60));
    expect(bounds.radius).toBeCloseTo(Math.max(Math.hypot(50, 30), Math.hypot(0, 60)));
    expect(fleetBounds(lights, 7)).toBeNull();
  });
});

describe("drift and parallax", () => {
  it("take at least thirty seconds a loop at every depth", () => {
    for (const period of DRIFT_PERIOD_S) expect(period).toBeGreaterThanOrEqual(30);
  });

  it("is a closed loop that never strays past its radius, and moves the near lights most", () => {
    for (const depth of [0, 1, 2] as const) {
      const light = { depth, phase: 1.3 };
      const start = driftOffset(light, 0);
      const again = driftOffset(light, DRIFT_PERIOD_S[depth]);
      expect(again.dx).toBeCloseTo(start.dx, 6);
      expect(again.dy).toBeCloseTo(start.dy, 6);
      for (let second = 0; second <= 100; second += 1.7) {
        const offset = driftOffset(light, second);
        expect(Math.hypot(offset.dx, offset.dy)).toBeLessThanOrEqual(DRIFT_RADIUS_PX[depth] + 1e-9);
      }
    }
    expect(DRIFT_RADIUS_PX[2]).toBeGreaterThan(DRIFT_RADIUS_PX[1]);
    expect(DRIFT_RADIUS_PX[1]).toBeGreaterThan(DRIFT_RADIUS_PX[0]);
  });

  it("moves slowly: a light covers under two pixels a second", () => {
    for (const depth of [0, 1, 2] as const) {
      const a = driftOffset({ depth, phase: 0 }, 10);
      const b = driftOffset({ depth, phase: 0 }, 11);
      expect(Math.hypot(b.dx - a.dx, b.dy - a.dy)).toBeLessThan(2);
    }
  });

  it("lets the pointer shift the nearest lights by 12 pixels at most, the far ones by less, and the centre not at all", () => {
    expect(PARALLAX_MAX_PX).toBe(12);
    expect(parallaxOffset({ x: 0, y: 0 }, 2).dx).toBeCloseTo(0);
    expect(parallaxOffset({ x: 0, y: 0 }, 2).dy).toBeCloseTo(0);
    const near = parallaxOffset({ x: 1, y: -1 }, 2);
    expect(near).toEqual({ dx: -12, dy: 12 });
    expect(Math.abs(parallaxOffset({ x: 1, y: 1 }, 0).dx)).toBeLessThan(Math.abs(parallaxOffset({ x: 1, y: 1 }, 1).dx));
    expect(Math.abs(parallaxOffset({ x: 1, y: 1 }, 1).dx)).toBeLessThan(Math.abs(near.dx));
    expect(parallaxOffset({ x: 9, y: -9 }, 2)).toEqual(near);
  });
});

describe("the fleet sweep", () => {
  it("visits the biggest fleet first and skips a fleet too thin to show", () => {
    const sample = build({ fleets: [fleet("0xaaa", 100), fleet("0xbbb", 90_000), fleet("0xccc", 5_000)], perFleet: 10 });
    const lights = placeLights(sample, 1500, BOX, ZONE).filter(light => light.fleet !== 3 || light.phase > 3);
    const counts = [1, 2, 3].map(number => lights.filter(light => light.fleet === number).length);
    const order = sweepOrder(lights, sample.fleets);
    expect(order[0]).toBe(2);
    expect(order).toEqual(
      [1, 2, 3]
        .filter((_, index) => counts[index]! >= 3)
        .sort((a, b) => sample.fleets[b - 1]!.size - sample.fleets[a - 1]!.size),
    );
    const thin = placeLights(build({ fleets: [fleet("0xaaa", 100)], perFleet: 2 }), 1500, BOX, ZONE);
    expect(sweepOrder(thin, [fleet("0xaaa", 100)])).toEqual([]);
  });

  it("waits for the page to settle, sweeps for 3.2 seconds, then rests until twelve seconds have passed", () => {
    const order = [4, 2];
    expect(activeSweep(order, 0)).toBeNull();
    expect(activeSweep(order, SWEEP_FIRST_MS - 1)).toBeNull();
    expect(activeSweep(order, SWEEP_FIRST_MS)).toEqual({ fleet: 4, progress: 0 });
    expect(activeSweep(order, SWEEP_FIRST_MS + SWEEP_LASTS_MS / 2)!.progress).toBeCloseTo(0.5);
    expect(activeSweep(order, SWEEP_FIRST_MS + SWEEP_LASTS_MS)).toEqual({ fleet: 4, progress: 1 });
    expect(activeSweep(order, SWEEP_FIRST_MS + SWEEP_LASTS_MS + 1)).toBeNull();
    expect(activeSweep(order, SWEEP_FIRST_MS + SWEEP_EVERY_MS - 1)).toBeNull();
  });

  it("moves on to the next fleet every twelve seconds and comes back to the first", () => {
    const order = [4, 2, 9];
    expect(SWEEP_EVERY_MS).toBe(12_000);
    expect(activeSweep(order, SWEEP_FIRST_MS + SWEEP_EVERY_MS + 100)!.fleet).toBe(2);
    expect(activeSweep(order, SWEEP_FIRST_MS + 2 * SWEEP_EVERY_MS + 100)!.fleet).toBe(9);
    expect(activeSweep(order, SWEEP_FIRST_MS + 3 * SWEEP_EVERY_MS + 100)!.fleet).toBe(4);
  });

  it("holds a sweep at its fullest by moving the clock to the middle of the sweep it is in", () => {
    const second = SWEEP_FIRST_MS + SWEEP_EVERY_MS;
    expect(sweepMiddle(SWEEP_FIRST_MS + 100)).toBe(SWEEP_FIRST_MS + SWEEP_LASTS_MS / 2);
    expect(sweepMiddle(second + SWEEP_LASTS_MS)).toBe(second + SWEEP_LASTS_MS / 2);
    expect(activeSweep([5, 6], sweepMiddle(second + 100))).toEqual({ fleet: 6, progress: 0.5 });
    // Between sweeps, and before the first, there is nothing to hold.
    expect(sweepMiddle(SWEEP_FIRST_MS + SWEEP_LASTS_MS + 1)).toBe(SWEEP_FIRST_MS + SWEEP_LASTS_MS + 1);
    expect(sweepMiddle(1_000)).toBe(1_000);
  });

  it("has nothing to sweep without a fleet, or before time has begun", () => {
    expect(activeSweep([], SWEEP_FIRST_MS + 500)).toBeNull();
    expect(activeSweep([1], -5_000)).toBeNull();
  });

  it("dims the cluster in and out: nothing at the ends, full in the middle", () => {
    expect(sweepEnvelope(0)).toBe(0);
    expect(sweepEnvelope(1)).toBe(0);
    expect(sweepEnvelope(0.5)).toBe(1);
    expect(sweepEnvelope(0.08)).toBeGreaterThan(0);
    expect(sweepEnvelope(0.08)).toBeLessThan(1);
    expect(sweepEnvelope(0.95)).toBeGreaterThan(0);
    expect(sweepEnvelope(0.95)).toBeLessThan(1);
  });

  it("with reduced motion marks the first fleet in the order and sweeps nothing", () => {
    expect(stillHighlight([3, 1])).toBe(3);
    expect(stillHighlight([])).toBeNull();
  });
});

describe("a line that starts with a name", () => {
  it("is split at its first colon, so the name can carry its definition, and the rest keeps the colon", () => {
    expect(splitLabel("Steady light: evidence on record.")).toEqual({ label: "Steady light", rest: ": evidence on record." });
    expect(splitLabel("A: b: c")).toEqual({ label: "A", rest: ": b: c" });
  });

  it("has no name when there is no colon, or the colon comes first", () => {
    expect(splitLabel("No label here")).toEqual({ label: "", rest: "No label here" });
    expect(splitLabel(": starts with a colon")).toEqual({ label: "", rest: ": starts with a colon" });
    expect(splitLabel("")).toEqual({ label: "", rest: "" });
  });

  it("finds the names the legend and the sweep heading start with, and none in the line that has no sweep to name", () => {
    expect(splitLabel(LEGEND.steady).label).toBe("Steady light");
    expect(splitLabel(LEGEND.fleet).label).toBe("Dim cluster");
    expect(splitLabel(sweepHeading("2026-10-14T18:05:00.000Z")).label).toBe("The Owl's last sweep");
    expect(splitLabel(sweepHeading(null, "unavailable")).label).toBe("The Owl's last sweep");
    expect(splitLabel(sweepHeading(null)).label).toBe("");
  });
});
