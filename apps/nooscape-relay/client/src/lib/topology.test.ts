import { describe, expect, it } from "vitest";
import { buildTopologyLayer, connectionLinesForEntities } from "./topology";

type TestNode = {
  id: string;
  capability: string;
  framework: string;
  trust: number;
  position: { x: number; y: number };
};

const nodes: TestNode[] = Array.from({ length: 1_200 }, (_, index) => ({
  id: `agent-${index}`,
  capability: index % 3 === 0 ? "Research" : index % 3 === 1 ? "Trading" : "Solana registry metadata",
  framework: index % 2 === 0 ? "A2A Agent Card" : "SOLANA REGISTRY",
  trust: index % 100,
  position: { x: 8 + ((index * 17) % 84), y: 10 + ((index * 31) % 78) },
}));

describe("topology level of detail", () => {
  it("caps overview DOM entities while retaining the selected record", () => {
    const layer = buildTopologyLayer(nodes, "agent-1199", 0.75);
    expect(layer.mode).toBe("overview");
    expect(layer.direct.some(node => node.id === "agent-1199")).toBe(true);
    // Overview aggregates the other 1,199 records into at most a 4x3 grid.
    expect(layer.direct.length + layer.clusters.length).toBeLessThanOrEqual(13);
    expect(layer.total).toBe(1_200);
  });

  it("expands detail deterministically at a semantic zoom threshold", () => {
    const regional = buildTopologyLayer(nodes, "agent-4", 1);
    const direct = buildTopologyLayer(nodes, "agent-4", 1.5);
    expect(regional.mode).toBe("regional");
    expect(direct.mode).toBe("direct");
    expect(direct.direct.length).toBeGreaterThan(regional.direct.length);
    expect(direct.direct.length).toBeLessThanOrEqual(160);
  });

  it("bounds signal-line work to the selected entity and rendered layer", () => {
    const layer = buildTopologyLayer(nodes, "agent-0", 0.75);
    const entities = [...layer.direct, ...layer.clusters];
    expect(connectionLinesForEntities(entities, "agent-0")).toHaveLength(entities.length - 1);
  });
});
