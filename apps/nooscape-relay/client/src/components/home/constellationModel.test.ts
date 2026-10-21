import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ARC_LIGHTS_LIMIT, type MapFleets } from "@shared/mapFleets";
import { regionIcon } from "./chainTabsModel";
import {
  ACKNOWLEDGED_TIER,
  acknowledgedLegendEntries,
  acknowledgedRecords,
  buildNodeGrid,
  CHAIN_STYLE,
  arcLights,
  chainStyleKey,
  constellationSummary,
  currentSelection,
  fleetRadius,
  fleetReach,
  fleetRecords,
  FLEET_TIER,
  isAcknowledged,
  isFleet,
  LIGHT_GAP,
  layoutNodes,
  legendEntries,
  markerPath,
  MAX_NODES,
  nearestLinks,
  nearestNode,
  nearestNodeInGrid,
  neighborInDirection,
  pickFeaturedNode,
  protocolLabel,
  recordChain,
  statusLines,
  throttleDelay,
  tierColor,
  truncateLabel,
  UNKNOWN_TIER_COLOR,
  type ConstellationNode,
  type ConstellationRecord,
} from "./constellationModel";

const record = (id: string, tier = "tier_2", protocols = '["a2a"]'): ConstellationRecord => ({ agentId: id, displayName: `Agent ${id}`, handle: `@${id}`, protocols, evidenceTier: tier });
const many = (count: number) => Array.from({ length: count }, (_, index) => record(`id-${String(index).padStart(4, "0")}`));
const node = (id: string, x: number, y: number, over: Partial<ConstellationNode> = {}): ConstellationNode => ({ id, name: id, handle: id, protocol: "A2A", tier: "tier_2", chain: null, kind: "reviewed", x, y, ...over });

describe("layoutNodes", () => {
  it("keeps every dot inside the canvas", () => {
    for (const placed of layoutNodes(many(82))) {
      expect(placed.x).toBeGreaterThanOrEqual(0.05 - 1e-9);
      expect(placed.x).toBeLessThanOrEqual(0.95 + 1e-9);
      expect(placed.y).toBeGreaterThanOrEqual(0.08 - 1e-9);
      expect(placed.y).toBeLessThanOrEqual(0.92 + 1e-9);
    }
  });

  it("puts the same records in the same places every time, whatever order they arrive in", () => {
    const records = many(40);
    const forward = layoutNodes(records);
    const backward = layoutNodes([...records].reverse());
    expect(backward).toEqual(forward);
    expect(layoutNodes(records)).toEqual(forward);
  });

  it("keeps dots from sitting on each other", () => {
    const placed = layoutNodes(many(82));
    let closest = Infinity;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        closest = Math.min(closest, Math.hypot((placed[j]!.x - placed[i]!.x) * 1.6, placed[j]!.y - placed[i]!.y));
      }
    }
    // The canvas is 1.6 wide for 1 tall, so 82 dots spread evenly are about 0.1 apart.
    expect(closest).toBeGreaterThan(0.03);
  });

  it("separates two records that hash to the same spot", () => {
    const placed = layoutNodes([record("same"), record("same")]);
    expect(placed).toHaveLength(2);
    expect(Math.hypot(placed[1]!.x - placed[0]!.x, placed[1]!.y - placed[0]!.y)).toBeGreaterThan(0);
  });

  it("handles none, one, and more than the cap", () => {
    expect(layoutNodes([])).toEqual([]);
    expect(layoutNodes([record("only")])).toHaveLength(1);
    expect(layoutNodes(many(MAX_NODES + 25))).toHaveLength(MAX_NODES);
  });

  it("carries each record's own tier, name and protocol, and nothing else", () => {
    const [placed] = layoutNodes([record("abc", "tier_3", '["solana_8004","a2a"]')]);
    expect(placed).toMatchObject({ id: "abc", name: "Agent abc", handle: "@abc", tier: "tier_3", protocol: "SOLANA 8004" });
  });
});

describe("protocolLabel and tierColor", () => {
  it("reads the first protocol from the JSON text, and says unknown when it cannot", () => {
    expect(protocolLabel('["erc8004"]')).toBe("ERC8004");
    expect(protocolLabel("[]")).toBe("UNKNOWN");
    expect(protocolLabel("not json")).toBe("UNKNOWN");
    expect(protocolLabel('{"a":1}')).toBe("UNKNOWN");
    expect(protocolLabel("[1,2]")).toBe("UNKNOWN");
  });

  it("colours the three tiers differently and anything else grey", () => {
    expect(new Set([tierColor("tier_2"), tierColor("tier_3"), tierColor("tier_4")]).size).toBe(3);
    expect(tierColor("tier_9")).toBe(UNKNOWN_TIER_COLOR);
  });
});

describe("nearestLinks", () => {
  it("joins each dot to its nearest neighbour, once per pair, with valid indices", () => {
    const placed = layoutNodes(many(60));
    const links = nearestLinks(placed);
    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThanOrEqual(placed.length);
    const keys = new Set(links.map(([a, b]) => `${a}:${b}`));
    expect(keys.size).toBe(links.length);
    for (const [a, b] of links) {
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(placed.length);
    }
    expect(nearestLinks(placed)).toEqual(links);
  });

  it("links the closer of two candidates, and nothing for fewer than two dots", () => {
    const line = [node("a", 0.1, 0.5), node("b", 0.2, 0.5), node("c", 0.9, 0.5)];
    expect(nearestLinks(line)).toEqual([[0, 1], [1, 2]]);
    expect(nearestLinks([node("only", 0.5, 0.5)])).toEqual([]);
    expect(nearestLinks([])).toEqual([]);
  });
});

describe("nearestNode", () => {
  const nodes = [node("a", 0.25, 0.5), node("b", 0.75, 0.5)];

  it("finds the node the point is over", () => {
    expect(nearestNode(nodes, 205, 255, 800, 500, 40)?.id).toBe("a");
    expect(nearestNode(nodes, 590, 240, 800, 500, 40)?.id).toBe("b");
  });

  it("finds none when the point is outside every radius", () => {
    expect(nearestNode(nodes, 400, 250, 800, 500, 40)).toBeNull();
    expect(nearestNode([], 10, 10, 800, 500, 40)).toBeNull();
  });

  it("takes the nearer of two, and the lower id on an exact tie", () => {
    const close = [node("far", 0.5, 0.5), node("near", 0.52, 0.5)];
    expect(nearestNode(close, 415, 250, 800, 500, 60)?.id).toBe("near");
    const tied = [node("b", 0.5, 0.4), node("a", 0.5, 0.6)];
    expect(nearestNode(tied, 400, 250, 800, 500, 80)?.id).toBe("a");
  });
});

describe("statusLines", () => {
  const target = node("rec-1", 0.5, 0.5);

  it("says what moves the scan point when nothing is scanned", () => {
    expect(statusLines(null, { status: "idle" }, "owl")[1]).toContain("owl");
    expect(statusLines(null, { status: "idle" }, "pointer")[1]).toContain("point");
  });

  it("names the agent and says it is reading while the evidence loads", () => {
    const [head, detail] = statusLines(target, { status: "loading" }, "owl");
    expect(head).toContain("rec-1");
    expect(detail).toContain("reading");
  });

  it("reports only what the evidence carries once it is read", () => {
    const [, detail] = statusLines(target, { status: "ready", publisher: "unverified", provenance: "valid", observations: 3, source: "A source" }, "owl");
    expect(detail).toBe("> tier_2 · 3 retained observations · provenance valid");
    expect(statusLines(target, { status: "ready", publisher: "unverified", provenance: null, observations: 1, source: null }, "owl")[1]).toBe("> tier_2 · 1 retained observation");
  });

  it("says so when the evidence cannot be read, without a verdict", () => {
    expect(statusLines(target, { status: "unavailable" }, "owl")[1]).toBe("> tier_2 · evidence not available right now");
  });
});

describe("throttleDelay", () => {
  it("is zero once the gap has passed, and the remainder before", () => {
    expect(throttleDelay(1000, 2500, 1200)).toBe(0);
    expect(throttleDelay(1000, 1500, 1200)).toBe(700);
    expect(throttleDelay(1000, 1000, 1200)).toBe(1200);
  });
});

describe("constellationSummary", () => {
  it("describes the map for someone who cannot see it", () => {
    const placed = layoutNodes([record("a", "tier_2"), record("b", "tier_2"), record("c", "tier_3")]);
    expect(constellationSummary(placed)).toBe("Map of 3 reviewed records. By chain: 3 No chain. By evidence tier: 2 tier 2, 1 tier 3. Each dot is one record. Tab to the map, use the arrow keys to move between records and Enter to pin one.");
    expect(constellationSummary([])).toBe("No reviewed records to show.");
  });
});

describe("which chain a record is on", () => {
  it("is the first protocol that names a chain, and none for a record listed only on a directory", () => {
    expect(recordChain('["erc8004"]')).toBe("robinhood");
    expect(recordChain('["a2a","solana_registry"]')).toBe("solana");
    expect(recordChain('["erc8004_bsc"]')).toBe("bnb");
    expect(recordChain('["a2a","catalog"]')).toBeNull();
    expect(recordChain("not json")).toBeNull();
    expect(recordChain("[]")).toBeNull();
  });

  it("is carried onto the placed node", () => {
    const [placed] = layoutNodes([record("x", "tier_2", '["solana_8004"]')]);
    expect(placed!.chain).toBe("solana");
    expect(chainStyleKey(placed!)).toBe("solana");
    expect(chainStyleKey({ chain: null })).toBe("none");
  });
});

describe("how a chain looks", () => {
  it("gives every chain its own colour and its own shape, so colour is never the only signal", () => {
    const styles = Object.values(CHAIN_STYLE);
    expect(new Set(styles.map(style => style.color)).size).toBe(styles.length);
    expect(new Set(styles.map(style => style.shape)).size).toBe(styles.length);
    for (const style of styles) expect(style.label.length).toBeGreaterThan(2);
  });

  it("uses the chain colours of the design tokens", () => {
    const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8").toLowerCase();
    for (const [key, token] of [["robinhood", "--ns-chain-robinhood"], ["solana", "--ns-chain-solana"], ["bnb", "--ns-chain-bnb"]] as const) {
      expect(css, key).toContain(`${token}: ${CHAIN_STYLE[key].color.toLowerCase()};`);
    }
    expect(css).toContain(`--ns-ink-dim: ${CHAIN_STYLE.none.color.toLowerCase()};`);
    // Arc's tab colour is the colour of its dome on the map.
    expect(css).toContain(`--ns-chain-arc: ${CHAIN_STYLE.arc.color.toLowerCase()};`);
  });

  it("draws Arc's records with the dome of its tab, so the key, the tab and the map agree", () => {
    expect(CHAIN_STYLE.arc).toMatchObject({ label: "Arc", shape: "dome" });
    expect(markerPath("dome")).toBe(regionIcon("arc").path);
    expect(recordChain('["erc8004_arc"]')).toBe("arc");
    // Only Arc's identity registry counts: the other extra chains have no place on the map.
    expect(recordChain('["erc8004_base"]')).toBeNull();
    expect(recordChain('["erc8004_eth"]')).toBeNull();
    const nodes = [node("a", 0.1, 0.1, { chain: "arc" }), node("b", 0.2, 0.2, { chain: "bnb" }), node("c", 0.3, 0.3)];
    expect(legendEntries(nodes).map(entry => [entry.key, entry.count])).toEqual([["bnb", 1], ["arc", 1], ["none", 1]]);
  });

  it("lists in the legend only the chains that have a record on the map, with counts, in a fixed order", () => {
    const nodes = [node("a", 0.1, 0.1, { chain: "solana" }), node("b", 0.2, 0.2, { chain: "robinhood" }), node("c", 0.3, 0.3, { chain: "solana" }), node("d", 0.4, 0.4)];
    expect(legendEntries(nodes).map(entry => [entry.key, entry.count])).toEqual([["robinhood", 1], ["solana", 2], ["none", 1]]);
    expect(legendEntries([])).toEqual([]);
  });
});

describe("finding a node through the grid", () => {
  const nodes = layoutNodes(many(120), 1.6).map((placed, index) => ({ ...placed, chain: index % 3 === 0 ? ("solana" as const) : null }));
  const width = 900;
  const height = 420;
  const grid = buildNodeGrid(nodes, width, height, 56);

  it("answers a pointer 20px from a node with that node", () => {
    for (const target of nodes.slice(0, 25)) {
      const found = nearestNodeInGrid(grid, target.x * width + 14, target.y * height + 14, 44);
      expect(found?.id).toBe(nearestNode(nodes, target.x * width + 14, target.y * height + 14, width, height, 44)?.id);
      expect(found).not.toBeNull();
    }
  });

  it("gives the same answer as the search over every node, at points all over the map", () => {
    for (let step = 0; step < 400; step += 1) {
      const x = ((step * 37) % 1000) - 50;
      const y = ((step * 91) % 500) - 40;
      for (const radius of [24, 44, 56]) {
        expect(nearestNodeInGrid(grid, x, y, radius)?.id ?? null, `${x},${y},${radius}`).toBe(nearestNode(nodes, x, y, width, height, radius)?.id ?? null);
      }
    }
  });

  it("finds nothing past the radius", () => {
    const lonely = buildNodeGrid([node("a", 0.5, 0.5)], 800, 400, 56);
    expect(nearestNodeInGrid(lonely, 400 + 45, 200, 44)).toBeNull();
    expect(nearestNodeInGrid(lonely, 400 + 43, 200, 44)?.id).toBe("a");
    expect(nearestNodeInGrid(buildNodeGrid([], 800, 400, 56), 10, 10, 44)).toBeNull();
  });

  it("takes the lower id on an exact tie", () => {
    const tied = buildNodeGrid([node("b", 0.5, 0.4), node("a", 0.5, 0.6)], 800, 500, 56);
    expect(nearestNodeInGrid(tied, 400, 250, 80)?.id).toBe("a");
  });
});

describe("moving between nodes with the arrow keys", () => {
  const nodes = [node("centre", 0.5, 0.5), node("right", 0.7, 0.5), node("farRight", 0.9, 0.5), node("up", 0.5, 0.2), node("down", 0.5, 0.8), node("left", 0.2, 0.52)];

  it("goes to the nearest node in the direction of the key", () => {
    expect(neighborInDirection(nodes, "centre", "right")).toBe("right");
    expect(neighborInDirection(nodes, "centre", "left")).toBe("left");
    expect(neighborInDirection(nodes, "centre", "up")).toBe("up");
    expect(neighborInDirection(nodes, "centre", "down")).toBe("down");
    expect(neighborInDirection(nodes, "right", "right")).toBe("farRight");
  });

  it("stays where it is at an edge, and for an id that is not on the map", () => {
    expect(neighborInDirection(nodes, "farRight", "right")).toBeNull();
    expect(neighborInDirection(nodes, "up", "up")).toBeNull();
    expect(neighborInDirection(nodes, "nobody", "left")).toBeNull();
  });

  it("prefers the node straight ahead over a nearer one off to the side", () => {
    const set = [node("from", 0.5, 0.5), node("straight", 0.8, 0.5), node("sideways", 0.58, 0.9)];
    expect(neighborInDirection(set, "from", "right")).toBe("straight");
  });

  it("can reach every node from the first by arrow keys alone", () => {
    const placed = layoutNodes(many(60), 1.6);
    const reached = new Set<string>([placed[0]!.id]);
    const queue = [placed[0]!.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const direction of ["left", "right", "up", "down"] as const) {
        const next = neighborInDirection(placed, id, direction, 1.6);
        if (next && !reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    expect(reached.size).toBe(placed.length);
  });
});

describe("the record the map opens on", () => {
  it("is the highest evidence tier, and the same record whatever order the records arrive in", () => {
    const records = [record("a", "tier_2"), record("b", "tier_3"), record("c", "tier_3"), record("d", "tier_2"), record("e", "tier_4"), record("f", "tier_4")];
    const placed = layoutNodes(records);
    const featured = pickFeaturedNode(placed)!;
    expect(featured.tier).toBe("tier_4");
    expect(pickFeaturedNode([...placed].reverse())!.id).toBe(featured.id);
    expect(pickFeaturedNode(layoutNodes([...records].reverse()))!.id).toBe(featured.id);
  });

  it("is a record that is on the map, and nothing when the map is empty", () => {
    const placed = layoutNodes(many(30));
    expect(placed.map(entry => entry.id)).toContain(pickFeaturedNode(placed)!.id);
    expect(pickFeaturedNode([])).toBeNull();
  });
});

describe("what the card shows", () => {
  const placed = layoutNodes([record("a", "tier_2"), record("b", "tier_3"), record("c", "tier_2")]);

  it("is the pinned record first, then the scanned one, then the featured one", () => {
    expect(currentSelection(placed, "a", "c")).toMatchObject({ kind: "pinned", node: { id: "a" } });
    expect(currentSelection(placed, null, "c")).toMatchObject({ kind: "scanned", node: { id: "c" } });
    expect(currentSelection(placed, null, null)).toMatchObject({ kind: "featured", node: { id: "b" } });
  });

  it("falls back when the pinned or scanned id is not on the map any more", () => {
    expect(currentSelection(placed, "gone", "c").kind).toBe("scanned");
    expect(currentSelection(placed, "gone", "also-gone").kind).toBe("featured");
  });

  it("is empty only when the map is", () => {
    expect(currentSelection([], null, null)).toEqual({ node: null, kind: null });
    expect(currentSelection([], "a", "b")).toEqual({ node: null, kind: null });
  });
});

describe("the status lines by kind of selection", () => {
  const target = node("rec-1", 0.5, 0.5);

  it("says pinned, scanning or opened on, and always names the record", () => {
    expect(statusLines(target, { status: "loading" }, "owl", "pinned")[0]).toBe("> pinned rec-1");
    expect(statusLines(target, { status: "loading" }, "owl", "scanned")[0]).toBe("> scanning rec-1…");
    expect(statusLines(target, { status: "loading" }, "owl", "featured")[0]).toBe("> opened on rec-1, the highest evidence tier here");
    expect(statusLines(target, { status: "loading" }, "owl")[0]).toBe("> scanning rec-1…");
  });
});

describe("the marker shapes", () => {
  it("have a path each, and the paths differ", () => {
    const paths = (["circle", "diamond", "square", "triangle"] as const).map(shape => markerPath(shape));
    for (const path of paths) expect(path).toMatch(/^M-?[\d.]+ -?[\d.]+/);
    expect(new Set(paths).size).toBe(4);
  });
});

describe("truncateLabel", () => {
  it("leaves a short name alone and cuts a long one with an ellipsis within the limit", () => {
    expect(truncateLabel("Short", 24)).toBe("Short");
    expect(truncateLabel("A".repeat(24), 24)).toBe("A".repeat(24));
    const cut = truncateLabel("Agent with a name that runs on and on", 24);
    expect(cut.length).toBeLessThanOrEqual(24);
    expect(cut.endsWith("\u2026")).toBe(true);
    expect(truncateLabel("", 24)).toBe("");
  });
});

describe("acknowledged entries on the map", () => {
  /** A BNB Chain registration the directory lists: no tier, no evidence, and its link host where a handle goes. */
  const ack = (id: string, protocols = '["erc8004_bsc"]'): ConstellationRecord => ({ agentId: id, displayName: `Entry ${id}`, handle: "agents.example.org", protocols, evidenceTier: ACKNOWLEDGED_TIER, kind: "acknowledged" });

  it("come from the read as records: the link host where a handle goes, their own protocol, and no tier", () => {
    const records = acknowledgedRecords({
      entries: [
        { id: "bnb-1", displayName: "Alpha", locatorHost: "alpha.example", protocol: "erc8004_bsc" },
        { id: "bnb-2", displayName: "Beta", locatorHost: null, protocol: "erc8004_bsc" },
      ],
      listed: 6838,
    });
    expect(records).toEqual([
      { agentId: "bnb-1", displayName: "Alpha", handle: "alpha.example", protocols: '["erc8004_bsc"]', evidenceTier: ACKNOWLEDGED_TIER, kind: "acknowledged" },
      { agentId: "bnb-2", displayName: "Beta", handle: "", protocols: '["erc8004_bsc"]', evidenceTier: ACKNOWLEDGED_TIER, kind: "acknowledged" },
    ]);
    expect(layoutNodes(records).every(entry => entry.chain === "bnb" && entry.kind === "acknowledged")).toBe(true);
    expect(acknowledgedRecords(null)).toEqual([]);
    expect(acknowledgedRecords({ entries: [], listed: 0 })).toEqual([]);
  });

  it("are placed like any other dot, and carry that they are acknowledged", () => {
    const placed = layoutNodes([record("rev-1", "tier_3"), ack("bnb-1"), ack("bnb-2")]);
    expect(placed.map(entry => [entry.id, entry.kind]).sort()).toEqual([["bnb-1", "acknowledged"], ["bnb-2", "acknowledged"], ["rev-1", "reviewed"]]);
    // A record that says nothing about its kind is a reviewed one.
    expect(layoutNodes([record("plain")])[0]!.kind).toBe("reviewed");
    expect(isAcknowledged(placed.find(entry => entry.id === "bnb-1")!)).toBe(true);
    expect(isAcknowledged(placed.find(entry => entry.id === "rev-1")!)).toBe(false);
  });

  it("sit on the chain their protocol names, in the same places however the records arrive", () => {
    const records = [record("rev-1"), ack("bnb-1"), ack("bnb-2"), ack("bnb-3")];
    const placed = layoutNodes(records);
    expect(placed.filter(isAcknowledged).every(entry => entry.chain === "bnb")).toBe(true);
    const again = layoutNodes([...records].reverse());
    expect(again.map(entry => [entry.id, entry.x, entry.y])).toEqual(placed.map(entry => [entry.id, entry.x, entry.y]));
  });

  it("are left out of the reviewed legend, and counted by chain in their own", () => {
    const placed = layoutNodes([record("a", "tier_2", '["erc8004"]'), record("b", "tier_3", '["solana_registry"]'), ack("bnb-1"), ack("bnb-2"), ack("bnb-3")]);
    expect(legendEntries(placed).map(entry => [entry.key, entry.count])).toEqual([["robinhood", 1], ["solana", 1]]);
    expect(acknowledgedLegendEntries(placed).map(entry => [entry.key, entry.count])).toEqual([["bnb", 3]]);
    expect(acknowledgedLegendEntries(layoutNodes([record("a")]))).toEqual([]);
  });

  it("are never where the map opens, while there is a reviewed record to open on", () => {
    // Many entries, so one of them is sure to hash lowest; the reviewed record is still the one.
    const placed = layoutNodes([record("rev-1", "tier_2"), ...Array.from({ length: 60 }, (_, index) => ack(`bnb-${index}`))]);
    expect(pickFeaturedNode(placed)!.id).toBe("rev-1");
    expect(currentSelection(placed, null, null)).toMatchObject({ kind: "featured", node: { id: "rev-1" } });
    // With none reviewed it opens on an entry rather than on nothing.
    expect(isAcknowledged(pickFeaturedNode(layoutNodes([ack("only-1"), ack("only-2")]))!)).toBe(true);
  });

  it("are named for what they are in the scanner's lines, with no tier and no evidence", () => {
    const target = layoutNodes([ack("bnb-1")])[0]!;
    expect(statusLines(target, { status: "idle" }, "owl", "scanned")).toEqual([`> scanning Entry bnb-1…`, "> acknowledged on BNB Chain, not reviewed · no evidence tier"]);
    expect(statusLines(target, { status: "idle" }, "owl", "pinned")[0]).toBe("> pinned Entry bnb-1");
    // The evidence state is not read for them, whatever it says.
    expect(statusLines(target, { status: "unavailable" }, "pointer")[1]).toBe("> acknowledged on BNB Chain, not reviewed · no evidence tier");
  });

  it("are said apart in what the map says to a screen reader, and do not change the reviewed counts", () => {
    const reviewedOnly = layoutNodes([record("a", "tier_2"), record("b", "tier_3")]);
    const withEntries = layoutNodes([record("a", "tier_2"), record("b", "tier_3"), ack("bnb-1"), ack("bnb-2")]);
    const summary = constellationSummary(withEntries);
    expect(summary).toContain("Map of 2 reviewed records.");
    expect(summary).toContain("By evidence tier: 1 tier 2, 1 tier 3.");
    expect(summary).toContain("Also 2 on BNB Chain: entries the directory lists that Nooscape has not reviewed, drawn hollow, with no evidence tier.");
    // Without them the sentence is not there at all.
    expect(constellationSummary(reviewedOnly)).not.toContain("Also");
  });
});

describe("fleet lights", () => {
  const fleet = (id: string, count: number, kind: "wallet" | "shared_link" | "platform_host" | "template" = "platform_host", name: string | null = `${id}.example.io`) => ({
    id,
    kind,
    chain: "bnb" as const,
    name: kind === "wallet" ? null : name,
    wallet: kind === "wallet" ? "0x8ce2b1348740d27d6075f602ad679a041407fdec" : null,
    registry: null,
    count,
    wallets: null,
  });
  const owner = (id: string, count: number, registry: "8004" | "metaplex" = "8004") => ({
    id,
    kind: "wallet" as const,
    chain: "solana" as const,
    name: null,
    wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    registry,
    count,
    wallets: null,
  });
  const registrant = (id: string, count: number) => ({
    id,
    kind: "wallet" as const,
    chain: "robinhood" as const,
    name: null,
    wallet: "0x62d304d1df6b102c43470a4b27f53bc4c009575c",
    registry: null,
    count,
    wallets: null,
  });
  const noSolana = { fleets: [], groups: 0, asOf: null };
  const noRobinhood = { fleets: [], groups: 0, asOf: null, listed: null };
  const sample = (...fleets: ReturnType<typeof fleet>[]) => ({ fleets, groups: fleets.length + 20, registrations: 375_343, asOf: "2026-10-16T12:00:00.000Z", solana: noSolana, robinhood: noRobinhood });
  const solanaSample = (...wallets: ReturnType<typeof owner>[]) => ({ fleets: [], groups: 0, registrations: null, asOf: null, solana: { fleets: wallets, groups: wallets.length, asOf: "2026-10-18T12:00:00.000Z" }, robinhood: noRobinhood });
  const robinhoodSample = (...wallets: ReturnType<typeof registrant>[]) => ({ fleets: [], groups: 0, registrations: null, asOf: null, solana: noSolana, robinhood: { fleets: wallets, groups: wallets.length, asOf: "2026-10-19T12:00:00.000Z", listed: null } });
  const withLights = () => [...many(82), ...fleetRecords(sample(fleet("bsc-fleet-a", 129_773), fleet("bsc-fleet-b", 126_839, "shared_link", "Ave.ai Trading Agent"), fleet("bsc-fleet-c", 13_419, "wallet"), fleet("bsc-fleet-d", 300, "template", "CryptoMaster Agent #2")))];

  it("turns a group into a record of its own kind: its title, its kind in words, BNB Chain, and no tier", () => {
    const [record] = fleetRecords(sample(fleet("bsc-fleet-b", 126_839, "shared_link", "Ave.ai Trading Agent")));
    expect(record).toMatchObject({ agentId: "bsc-fleet-b", displayName: "Ave.ai Trading Agent", handle: "Same profile link", evidenceTier: FLEET_TIER, kind: "fleet" });
    expect(recordChain(record!.protocols)).toBe("bnb");
    expect(fleetRecords(null)).toEqual([]);
    expect(fleetRecords(undefined)).toEqual([]);
    expect(fleetRecords({ fleets: [], groups: 0, registrations: null, asOf: null, solana: noSolana, robinhood: noRobinhood })).toEqual([]);
    // An answer that lacks the Solana and Robinhood Chain fields, as an older server's would, still draws its BNB Chain lights.
    expect(fleetRecords({ fleets: [fleet("bsc-fleet-a", 100)], groups: 1, registrations: null, asOf: null } as unknown as MapFleets)).toHaveLength(1);
  });

  it("turns a Solana owner wallet into a record on Solana, named for its registry's protocol, with no tier", () => {
    const records = fleetRecords(solanaSample(owner("sol-fleet-a", 326, "8004"), owner("sol-fleet-b", 332, "metaplex")));
    expect(records[0]).toMatchObject({ agentId: "sol-fleet-a", displayName: "Wallet 7xKXtg…gAsU", handle: "Same owner wallet", evidenceTier: FLEET_TIER, kind: "fleet" });
    expect(recordChain(records[0]!.protocols)).toBe("solana");
    expect(JSON.parse(records[0]!.protocols)).toEqual(["solana_8004"]);
    expect(JSON.parse(records[1]!.protocols)).toEqual(["solana_registry"]);
  });

  it("puts the BNB Chain groups before the Solana owner wallets", () => {
    const both = fleetRecords({ ...sample(fleet("bsc-fleet-a", 100)), solana: { fleets: [owner("sol-fleet-a", 326)], groups: 1, asOf: null } });
    expect(both.map(record => record.agentId)).toEqual(["bsc-fleet-a", "sol-fleet-a"]);
  });

  it("reaches as far as its radius, and a Solana diamond a fifth further", () => {
    expect(fleetReach({ chain: "bnb", count: 300 })).toBe(fleetRadius(300));
    expect(fleetReach({ chain: "solana", count: 300 })).toBeCloseTo(fleetRadius(300) * 1.2, 9);
    expect(fleetReach(undefined)).toBe(8);
  });

  it("grows a light with the log of its count, between 8 and 24 pixels", () => {
    expect(fleetRadius(1)).toBe(8);
    expect(fleetRadius(50)).toBeCloseTo(13.44, 1);
    expect(fleetRadius(300)).toBeGreaterThan(fleetRadius(50));
    expect(fleetRadius(129_773)).toBe(24);
    expect(fleetRadius(10_000_000)).toBe(24);
    expect(fleetRadius(0)).toBe(8);
  });

  it("leaves every dot exactly where it was, with or without the lights", () => {
    const plain = layoutNodes(many(82), 2);
    const lit = layoutNodes(withLights(), 2);
    expect(lit.slice(0, 82)).toEqual(plain);
    expect(lit.slice(82).every(isFleet)).toBe(true);
    expect(lit).toHaveLength(86);
  });

  it("puts the lights in the same places every time, whatever order they arrive in", () => {
    const forward = layoutNodes(withLights(), 2);
    const backward = layoutNodes([...withLights()].reverse(), 2);
    const places = (nodes: ConstellationNode[]) => nodes.filter(isFleet).map(placed => [placed.id, placed.x, placed.y]).sort();
    expect(places(backward)).toEqual(places(forward));
  });

  it("keeps the lights inside the canvas and away from each other and from the dots", () => {
    for (const aspect of [0.75, 1, 2, 3]) {
      const nodes = layoutNodes(withLights(), aspect);
      const lights = nodes.filter(isFleet);
      for (const light of lights) {
        expect(light.x).toBeGreaterThanOrEqual(0.09 - 1e-9);
        expect(light.x).toBeLessThanOrEqual(0.91 + 1e-9);
        expect(light.y).toBeGreaterThanOrEqual(0.15 - 1e-9);
        expect(light.y).toBeLessThanOrEqual(0.85 + 1e-9);
      }
      for (let i = 0; i < lights.length; i += 1) {
        for (let j = i + 1; j < lights.length; j += 1) {
          const a = lights[i]!;
          const b = lights[j]!;
          const need = (fleetRadius(a.fleet!.count) + fleetRadius(b.fleet!.count) + LIGHT_GAP) / 340;
          expect(Math.hypot((a.x - b.x) * aspect, a.y - b.y)).toBeGreaterThanOrEqual(need - 1e-6);
        }
      }
    }
  });

  it("places the Solana owner wallets around the BNB Chain lights without moving any of them, and gives each diamond its full reach", () => {
    const solana = [owner("sol-fleet-a", 332, "metaplex"), owner("sol-fleet-b", 326), owner("sol-fleet-c", 195), owner("sol-fleet-d", 160), owner("sol-fleet-e", 115), owner("sol-fleet-f", 106)];
    const everything = [...withLights(), ...fleetRecords({ ...sample(), solana: { fleets: solana, groups: solana.length, asOf: null } })];
    for (const aspect of [0.75, 1, 2, 3]) {
      const before = layoutNodes(withLights(), aspect);
      const after = layoutNodes(everything, aspect);
      // Every dot and every BNB Chain light is exactly where it was.
      expect(after.slice(0, before.length)).toEqual(before);
      const lights = after.filter(isFleet);
      expect(lights).toHaveLength(10);
      for (const light of lights.filter(candidate => candidate.fleet?.chain === "solana")) {
        expect(light.x).toBeGreaterThanOrEqual(0.09 - 1e-9);
        expect(light.x).toBeLessThanOrEqual(0.91 + 1e-9);
        expect(light.y).toBeGreaterThanOrEqual(0.15 - 1e-9);
        expect(light.y).toBeLessThanOrEqual(0.85 + 1e-9);
      }
    }
    // The same places whatever order they arrive in.
    const places = (nodes: ConstellationNode[]) => nodes.filter(isFleet).map(placed => [placed.id, placed.x, placed.y]).sort();
    expect(places(layoutNodes([...everything].reverse(), 2))).toEqual(places(layoutNodes(everything, 2)));
  });

  it("carries the group on the node, and counts no light as a record in the legend or the featured pick", () => {
    const nodes = layoutNodes(withLights(), 2);
    const light = nodes.find(candidate => candidate.id === "bsc-fleet-b")!;
    expect(light).toMatchObject({ kind: "fleet", tier: FLEET_TIER, chain: "bnb", name: "Ave.ai Trading Agent" });
    expect(light.fleet?.count).toBe(126_839);
    expect(isAcknowledged(light)).toBe(false);
    // The legend counts the reviewed records only, and the featured record is never a light while there is a record.
    expect(legendEntries(nodes).reduce((sum, entry) => sum + entry.count, 0)).toBe(82);
    expect(acknowledgedLegendEntries(nodes)).toEqual([]);
    expect(isFleet(pickFeaturedNode(nodes)!)).toBe(false);
    expect(pickFeaturedNode(layoutNodes(fleetRecords(sample(fleet("bsc-fleet-a", 100))), 2))).toMatchObject({ id: "bsc-fleet-a" });
  });

  it("says in the scanner that it is a group, not an agent, with its count", () => {
    const nodes = layoutNodes(withLights(), 2);
    const light = nodes.find(candidate => candidate.id === "bsc-fleet-b")!;
    expect(statusLines(light, { status: "idle" }, "pointer", "scanned")).toEqual(["> scanning Ave.ai Trading Agent…", "> 126,839 registrations on BNB Chain share one fact · a group, not an agent"]);
    expect(statusLines(light, { status: "idle" }, "pointer", "pinned")[0]).toBe("> pinned Ave.ai Trading Agent");
  });

  it("describes the lights apart from the records for someone who cannot see them, without counting them as records", () => {
    const summary = constellationSummary(layoutNodes(withLights(), 2));
    expect(summary).toContain("Map of 82 reviewed records.");
    expect(summary).toContain("Also 4 large circles: each is a group of BNB Chain registrations that share one fact, with its count.");
    expect(summary).toContain("A circle is a group, not an agent, and no single BNB Chain registration is drawn.");
    expect(constellationSummary(layoutNodes(many(3), 2))).not.toContain("large circle");
    expect(constellationSummary(layoutNodes([...many(3), ...fleetRecords(sample(fleet("bsc-fleet-a", 100)))], 2))).toContain("Also 1 large circle:");
  });

  it("says in the scanner that a Solana owner wallet is on Solana, with its count, and not an agent", () => {
    const nodes = layoutNodes([...many(3), ...fleetRecords(solanaSample(owner("sol-fleet-a", 326)))], 2);
    const diamond = nodes.find(candidate => candidate.id === "sol-fleet-a")!;
    expect(diamond).toMatchObject({ kind: "fleet", tier: FLEET_TIER, chain: "solana" });
    expect(statusLines(diamond, { status: "idle" }, "pointer", "scanned")[1]).toBe("> 326 registrations on Solana share one fact · a group, not an agent");
  });

  it("describes the Solana diamonds apart from the BNB Chain circles and from the records", () => {
    const nodes = layoutNodes([...many(3), ...fleetRecords({ ...sample(fleet("bsc-fleet-a", 100)), solana: { fleets: [owner("sol-fleet-a", 326), owner("sol-fleet-b", 195)], groups: 2, asOf: null } })], 2);
    const summary = constellationSummary(nodes);
    expect(summary).toContain("Map of 3 reviewed records.");
    expect(summary).toContain("Also 1 large circle: each is a group of BNB Chain registrations that share one fact");
    expect(summary).toContain("Also 2 large diamonds: each is one owner wallet that a Solana registry records as holding many registrations, with its count. A diamond is a wallet, not an agent.");
    expect(constellationSummary(layoutNodes(many(3), 2))).not.toContain("diamond");
  });

  it("turns a Robinhood Chain registering wallet into a record on Robinhood Chain, named for its protocol, with no tier", () => {
    const [record] = fleetRecords(robinhoodSample(registrant("rh-fleet-a", 5_593)));
    expect(record).toMatchObject({ agentId: "rh-fleet-a", displayName: "Wallet 0x62d3…575c", handle: "Same registering wallet", evidenceTier: FLEET_TIER, kind: "fleet" });
    expect(recordChain(record!.protocols)).toBe("robinhood");
    expect(JSON.parse(record!.protocols)).toEqual(["erc8004"]);
  });

  it("puts the Robinhood Chain wallets after the BNB Chain groups and the Solana owner wallets", () => {
    const all = fleetRecords({ ...sample(fleet("bsc-fleet-a", 100)), solana: { fleets: [owner("sol-fleet-a", 326)], groups: 1, asOf: null }, robinhood: { fleets: [registrant("rh-fleet-a", 5_593)], groups: 1, asOf: null, listed: null } });
    expect(all.map(record => record.agentId)).toEqual(["bsc-fleet-a", "sol-fleet-a", "rh-fleet-a"]);
  });

  it("reaches as far as its radius, whichever outline it has but a Solana diamond", () => {
    expect(fleetReach({ chain: "robinhood", count: 300 })).toBe(fleetRadius(300));
  });

  it("places the Robinhood Chain wallets around the BNB Chain and Solana lights without moving any of them, inside the canvas", () => {
    const solana = [owner("sol-fleet-a", 332, "metaplex"), owner("sol-fleet-b", 326), owner("sol-fleet-c", 195)];
    const robinhood = [registrant("rh-fleet-a", 5_593), registrant("rh-fleet-b", 1_091), registrant("rh-fleet-c", 902), registrant("rh-fleet-d", 133), registrant("rh-fleet-e", 100)];
    const before = [...withLights(), ...fleetRecords({ ...sample(), solana: { fleets: solana, groups: solana.length, asOf: null } })];
    const everything = [...before, ...fleetRecords({ ...sample(), robinhood: { fleets: robinhood, groups: robinhood.length, asOf: null, listed: null } })];
    for (const aspect of [0.75, 1, 2, 3]) {
      const without = layoutNodes(before, aspect);
      const lit = layoutNodes(everything, aspect);
      // Every dot, every BNB Chain light and every Solana light is exactly where it was.
      expect(lit.slice(0, without.length)).toEqual(without);
      const hexagons = lit.filter(candidate => isFleet(candidate) && candidate.fleet?.chain === "robinhood");
      expect(hexagons).toHaveLength(5);
      for (const light of hexagons) {
        expect(light.x).toBeGreaterThanOrEqual(0.09 - 1e-9);
        expect(light.x).toBeLessThanOrEqual(0.91 + 1e-9);
        expect(light.y).toBeGreaterThanOrEqual(0.15 - 1e-9);
        expect(light.y).toBeLessThanOrEqual(0.85 + 1e-9);
      }
    }
    const places = (nodes: ConstellationNode[]) => nodes.filter(isFleet).map(placed => [placed.id, placed.x, placed.y]).sort();
    expect(places(layoutNodes([...everything].reverse(), 2))).toEqual(places(layoutNodes(everything, 2)));
  });

  it("says in the scanner that a Robinhood Chain registering wallet is on Robinhood Chain, with its count, and not an agent", () => {
    const nodes = layoutNodes([...many(3), ...fleetRecords(robinhoodSample(registrant("rh-fleet-a", 5_593)))], 2);
    const hexagon = nodes.find(candidate => candidate.id === "rh-fleet-a")!;
    expect(hexagon).toMatchObject({ kind: "fleet", tier: FLEET_TIER, chain: "robinhood" });
    expect(statusLines(hexagon, { status: "idle" }, "pointer", "scanned")[1]).toBe("> 5,593 registrations on Robinhood Chain share one fact · a group, not an agent");
  });

  it("describes the Robinhood Chain hexagons apart from the circles, the diamonds and the records", () => {
    const nodes = layoutNodes([...many(3), ...fleetRecords({ ...sample(fleet("bsc-fleet-a", 100)), solana: { fleets: [owner("sol-fleet-a", 326)], groups: 1, asOf: null }, robinhood: { fleets: [registrant("rh-fleet-a", 5_593), registrant("rh-fleet-b", 1_091)], groups: 2, asOf: null, listed: null } })], 2);
    const summary = constellationSummary(nodes);
    expect(summary).toContain("Also 1 large circle: each is a group of BNB Chain registrations");
    expect(summary).toContain("Also 1 large diamond: each is one owner wallet that a Solana registry");
    expect(summary).toContain("Also 2 large hexagons: each is one registering wallet that the directory records against many Robinhood Chain registrations, with its count. A hexagon is a wallet, not an agent.");
    expect(constellationSummary(layoutNodes(many(3), 2))).not.toContain("hexagon");
  });

  it("draws no light from the fleet kind alone: a record without the group stays a plain node", () => {
    expect(layoutNodes([{ ...record("x"), kind: "fleet" as const }], 2)).toHaveLength(1);
  });
});

describe("the Arc lights on the scan map", () => {
  const group = (id: string, count: number, kind: "wallet" | "platform_host" | "shared_link" = "wallet") => ({
    id,
    kind,
    chain: "arc" as const,
    name: kind === "wallet" ? null : "api.example.test",
    wallet: kind === "wallet" ? "0x1030405000000000000000000000000000000abc" : null,
    registry: null,
    count,
    wallets: kind === "wallet" ? 1 : null,
  });
  const noOthers = { fleets: [], groups: 0, registrations: null, asOf: null, solana: { fleets: [], groups: 0, asOf: null }, robinhood: { fleets: [], groups: 0, asOf: null, listed: null } };
  const bnb = (id: string, count: number) => ({ id, kind: "platform_host" as const, chain: "bnb" as const, name: "host.example", wallet: null, registry: null, count, wallets: null });
  const dots = Array.from({ length: 60 }, (_, index) => ({ agentId: `dot-${index}`, displayName: `Dot ${index}`, handle: `@d${index}`, protocols: '["a2a"]', evidenceTier: "tier_2" }));

  it("turns an Arc group into a record on Arc, named for its protocol, with no tier", () => {
    const [light] = fleetRecords(null, { fleets: [group("arc-fleet-a", 1_000)] });
    expect(light).toMatchObject({ agentId: "arc-fleet-a", displayName: "Wallet 0x1030…0abc", handle: "Same registering wallet", evidenceTier: FLEET_TIER, kind: "fleet" });
    expect(recordChain(light!.protocols)).toBe("arc");
    expect(JSON.parse(light!.protocols)).toEqual(["erc8004_arc"]);
    expect(fleetRecords(null, null)).toEqual([]);
    expect(fleetRecords(null, { fleets: [] })).toEqual([]);
  });

  it("draws the largest eight groups, the largest first and a tie by id, and leaves the rest to the count", () => {
    const groups = Array.from({ length: 11 }, (_, index) => group(`arc-fleet-${String.fromCharCode(97 + index)}`, 100 - Math.floor(index / 2) * 10));
    const drawn = arcLights({ fleets: groups });
    expect(ARC_LIGHTS_LIMIT).toBe(8);
    expect(drawn).toHaveLength(8);
    expect(drawn.map(light => light.count)).toEqual([100, 100, 90, 90, 80, 80, 70, 70]);
    expect(drawn.map(light => light.id)).toEqual(["arc-fleet-a", "arc-fleet-b", "arc-fleet-c", "arc-fleet-d", "arc-fleet-e", "arc-fleet-f", "arc-fleet-g", "arc-fleet-h"]);
    expect(arcLights({ fleets: [...groups].reverse() }).map(light => light.id)).toEqual(drawn.map(light => light.id));
    expect(arcLights(null)).toEqual([]);
  });

  it("puts the Arc lights after the other chains' lights", () => {
    const all = fleetRecords({ ...noOthers, fleets: [bnb("bsc-fleet-a", 100)] }, { fleets: [group("arc-fleet-a", 1_000)] });
    expect(all.map(candidate => candidate.agentId)).toEqual(["bsc-fleet-a", "arc-fleet-a"]);
  });

  it("places the Arc domes around the other lights without moving any of them, inside the canvas", () => {
    const others = [...dots, ...fleetRecords({ ...noOthers, fleets: [bnb("bsc-fleet-a", 129_773), bnb("bsc-fleet-b", 40_983)] })];
    const arc = [group("arc-fleet-a", 1_000), group("arc-fleet-b", 868, "platform_host"), group("arc-fleet-c", 247, "shared_link"), group("arc-fleet-d", 100)];
    const everything = [...others, ...fleetRecords(null, { fleets: arc })];
    for (const aspect of [0.75, 1, 2, 3]) {
      const without = layoutNodes(others, aspect);
      const lit = layoutNodes(everything, aspect);
      // Every dot and every other light is exactly where it was.
      expect(lit.slice(0, without.length)).toEqual(without);
      const domes = lit.filter(candidate => isFleet(candidate) && candidate.fleet?.chain === "arc");
      expect(domes).toHaveLength(4);
      for (const light of domes) {
        expect(light.x).toBeGreaterThanOrEqual(0.09 - 1e-9);
        expect(light.x).toBeLessThanOrEqual(0.91 + 1e-9);
        expect(light.y).toBeGreaterThanOrEqual(0.15 - 1e-9);
        expect(light.y).toBeLessThanOrEqual(0.85 + 1e-9);
      }
    }
    const places = (nodes: ConstellationNode[]) => nodes.filter(isFleet).map(placed => [placed.id, placed.x, placed.y]).sort();
    expect(places(layoutNodes([...everything].reverse(), 2))).toEqual(places(layoutNodes(everything, 2)));
  });

  it("reaches as far as its radius", () => {
    expect(fleetReach({ chain: "arc", count: 1_000 })).toBe(fleetRadius(1_000));
  });

  it("says in the scanner that an Arc group is on Arc, with its count, and not an agent", () => {
    const nodes = layoutNodes([...dots.slice(0, 3), ...fleetRecords(null, { fleets: [group("arc-fleet-a", 1_000)] })], 2);
    const dome = nodes.find(candidate => candidate.id === "arc-fleet-a")!;
    expect(dome).toMatchObject({ kind: "fleet", tier: FLEET_TIER, chain: "arc" });
    expect(statusLines(dome, { status: "idle" }, "pointer", "scanned")[1]).toBe("> 1,000 registrations on Arc share one fact · a group, not an agent");
  });

  it("describes the domes apart from the circles, the diamonds, the hexagons and the records", () => {
    const nodes = layoutNodes([...dots.slice(0, 3), ...fleetRecords({ ...noOthers, fleets: [bnb("bsc-fleet-a", 100)] }, { fleets: [group("arc-fleet-a", 1_000), group("arc-fleet-b", 868, "platform_host")] })], 2);
    const summary = constellationSummary(nodes);
    expect(summary).toContain("Also 1 large circle: each is a group of BNB Chain registrations");
    expect(summary).toContain("Also 2 large domes: each is a group of Arc registrations that share one wallet, host or profile link, with its count. A dome is a group, not an agent, and no single Arc registration is drawn.");
    expect(constellationSummary(layoutNodes(dots.slice(0, 3), 2))).not.toContain("dome");
  });
});
