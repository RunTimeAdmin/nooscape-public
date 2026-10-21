import { describe, expect, it } from "vitest";
import { LABEL_MAX_PX, LABEL_MIN_PX, labelRect, NAME_CHAR_PX, planLabels, SELECTED_MAX_PX, type LabelNode, type Rect } from "./fieldLabels";

const node = (id: string, x: number, y: number, name = id, detail = "Research"): LabelNode => ({ id, x, y, name, detail });
const SCENE = { width: 786, height: 540 };
const PHONE = { width: 377, height: 430 };

/** The 22 agents the /field map drew on 15 Oct 2026, in the order it drew them, the first of them selected. */
const LIVE: LabelNode[] = [
  node("noos-prime", 51, 38, "NOOS-PRIME", "Research"),
  node("observatory", 72, 28, "Nooscape Observatory", "Agent discovery metadata"),
  node("sable", 77, 31, "SABLE/9", "Security"),
  node("quill", 28, 25, "QUILL-01", "Build"),
  node("mercator", 66, 65, "MERCATOR", "Commerce"),
  node("lattice", 38, 69, "LATTICE", "Data"),
  node("vanta", 18, 54, "VANTA-7", "Research"),
  node("toolkit", 54, 57, "AgentCard.net Toolkit", "Agent Card Generator"),
  node("froggit", 46, 41, "Froggit.ai", "Agent discovery metadata"),
  node("rank", 31, 51, "AgentRank", "Agent discovery metadata"),
  node("google", 68, 48, "Google Sign-In Claude Agent", "Agent discovery metadata"),
  node("vorn", 21, 41, "Vorn", "Agent discovery metadata"),
  node("adcreator", 20, 36, "adcreator-ai", "Agent discovery metadata"),
  node("a2g", 76, 71, "A2G commons test agent", "Agent discovery metadata"),
  node("nexus", 38, 77, "Agent Nexus (agentnexus.app)", "Agent discovery metadata"),
  node("markovian", 73, 77, "Markovian Provenance", "Agent discovery metadata"),
  node("ainumbers", 29, 19, "AINumbers OpenChainGraph Suite", "Agent discovery metadata"),
  node("algovoi", 35, 53, "AlgoVoi Payment Agent", "Agent discovery metadata"),
  node("freia", 42, 72, "FREIA - France Real Estate Intelligence Agent", "Agent discovery metadata"),
  node("cabal", 24, 67, "Cabal-Hunter", "Agent discovery metadata"),
  node("gateway", 37, 65, "AAA A2A Gateway", "Agent discovery metadata"),
  node("toll", 62, 64, "GF Agent Toll", "Agent discovery metadata"),
];

const touch = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Everything the plan promises, checked from its result alone: no two names touch, none covers another node's bot, all are on the map. */
function expectSound(nodes: readonly LabelNode[], scene: { width: number; height: number }, selectedId: string | null) {
  const plan = planLabels(nodes, scene, selectedId);
  const rects = nodes.filter(n => plan.has(n.id)).map(n => ({ n, rect: labelRect(n, plan.get(n.id)!, scene, n.id === selectedId) }));
  for (const { n, rect } of rects) {
    expect(rect.x, `${n.id} left edge`).toBeGreaterThanOrEqual(0);
    expect(rect.y, `${n.id} top edge`).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w, `${n.id} right edge`).toBeLessThanOrEqual(scene.width);
    expect(rect.y + rect.h, `${n.id} bottom edge`).toBeLessThanOrEqual(scene.height);
    if (n.id === selectedId) continue;
    for (const other of nodes) {
      if (other.id === n.id) continue;
      const bot: Rect = { x: (other.x / 100) * scene.width - 11, y: (other.y / 100) * scene.height - 11, w: 22, h: 22 };
      expect(touch(rect, bot), `${n.id}'s name covers the bot of ${other.id}`).toBe(false);
    }
  }
  for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) expect(touch(rects[i]!.rect, rects[j]!.rect), `${rects[i]!.n.id} and ${rects[j]!.n.id} touch`).toBe(false);
  return plan;
}

describe("where a name goes", () => {
  it("is on the right of its node, and on the left when the right has no room", () => {
    expect(planLabels([node("a", 20, 50)], SCENE, null).get("a")?.side).toBe("right");
    expect(planLabels([node("b", 92, 50, "Some Agent")], SCENE, null).get("b")?.side).toBe("left");
  });

  it("is as wide as its words, and no wider than the cap", () => {
    expect(planLabels([node("a", 20, 50, "Vorn")], SCENE, null).get("a")?.width).toBe(Math.ceil(4 * NAME_CHAR_PX + 12));
    expect(planLabels([node("b", 20, 20, "x".repeat(60))], SCENE, null).get("b")?.width).toBe(LABEL_MAX_PX);
  });

  it("is left out when it would touch a name already placed, and each node on its own keeps its name", () => {
    const plan = planLabels([node("a", 20, 40), node("b", 20, 41), node("c", 20, 42)], SCENE, null);
    expect([...plan.keys()]).toEqual(["a", "b"]);
    expect(plan.get("a")?.side).toBe("right");
    expect(plan.get("b")?.side).toBe("left");
  });

  it("is left out when it would cover another node's bot, or the mark in the middle", () => {
    // b has a bot close on each side, so its name would have to run across one of them.
    expect(planLabels([node("b", 40, 30), node("left", 36, 30), node("right", 44, 30)], SCENE, null).has("b")).toBe(false);
    // Nothing is drawn over the mark in the middle of the map.
    expect(planLabels([node("m", 50, 51, "Middle")], SCENE, null).has("m")).toBe(false);
  });

  it("is given to nobody until the map has a size", () => {
    expect(planLabels(LIVE, { width: 0, height: 0 }, "noos-prime").size).toBe(0);
    expect(planLabels(LIVE, { width: 30, height: 30 }, "noos-prime").size).toBe(0);
  });
});

describe("the selected agent", () => {
  it("has its name before everyone else, so the others give way to it", () => {
    const pair = [node("a", 30, 20, "Alpha"), node("sel", 30, 20, "Chosen")];
    // Listed second, but placed first: it takes the right, and the other node takes the left.
    const withSelection = planLabels(pair, SCENE, "sel");
    expect(withSelection.get("sel")?.side).toBe("right");
    expect(withSelection.get("a")?.side).toBe("left");
    // With nothing selected the order of the list decides.
    const without = planLabels(pair, SCENE, null);
    expect(without.get("a")?.side).toBe("right");
    expect(without.get("sel")?.side).toBe("left");
  });

  it("takes the side that is clear of other bots when there is one", () => {
    // A bot stands 31px to the right of the selected node, in the way of a name on that side.
    const plan = planLabels([node("sel", 60, 20, "Chosen"), node("bot", 64, 20)], SCENE, "sel");
    expect(plan.get("sel")?.side).toBe("left");
    // With no bot in the way it is on the right, as for any other node.
    expect(planLabels([node("sel", 60, 20, "Chosen")], SCENE, "sel").get("sel")?.side).toBe("right");
  });

  it("has two lines, wide enough for its capability, up to the cap", () => {
    const plan = planLabels([node("sel", 20, 50, "Ab", "Agent discovery metadata")], SCENE, "sel");
    expect(plan.get("sel")?.width).toBeGreaterThan(24 * 7.5);
    expect(planLabels([node("sel", 20, 50, "x".repeat(80))], SCENE, "sel").get("sel")?.width).toBe(SELECTED_MAX_PX);
  });

  it("keeps its name on a narrow map, squeezed to the room there is", () => {
    const plan = planLabels([node("sel", 50, 20, "x".repeat(80), "Agent discovery metadata")], PHONE, "sel");
    const place = plan.get("sel")!;
    expect(place.width).toBeGreaterThanOrEqual(LABEL_MIN_PX);
    expect(place.width).toBeLessThan(SELECTED_MAX_PX);
    const rect = labelRect(node("sel", 50, 20), place, PHONE, true);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(PHONE.width);
  });
});

describe("a crowded map", () => {
  it("names a good share of the 22 agents the live map drew, with no two names touching", () => {
    const plan = expectSound(LIVE, SCENE, "noos-prime");
    expect(plan.size).toBeGreaterThanOrEqual(8);
    expect(plan.has("noos-prime")).toBe(true);
  });

  it("does the same on a phone-sized map", () => {
    const plan = expectSound(LIVE, PHONE, "noos-prime");
    expect(plan.has("noos-prime")).toBe(true);
  });

  it("holds for any layout: no names touching, none over a bot, all on the map", () => {
    // A small seeded generator, so a failure can be reproduced.
    let seed = 20261015;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let round = 0; round < 150; round += 1) {
      const scene = round % 3 === 0 ? PHONE : round % 3 === 1 ? SCENE : { width: 480 + Math.floor(random() * 400), height: 360 + Math.floor(random() * 240) };
      const count = 1 + Math.floor(random() * 30);
      const nodes = Array.from({ length: count }, (_, i) => node(`n${i}`, 16 + random() * 68, 18 + random() * 62, "w".repeat(3 + Math.floor(random() * 40)), "Agent discovery metadata"));
      expectSound(nodes, scene, round % 2 === 0 ? "n0" : null);
    }
  });
});
