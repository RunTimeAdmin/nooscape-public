import { describe, expect, it } from "vitest";
import { linesFor } from "@/components/owl/owlLines";
import { bubbleFacts } from "./landingFacts";
import type { ConstellationNode, EvidenceState } from "./constellationModel";

const node = (over: Partial<ConstellationNode> = {}): ConstellationNode => ({ id: "rec-1", name: "Nooscape Observatory", handle: "nooscape-observatory", protocol: "A2A", tier: "tier_3", chain: "robinhood", kind: "reviewed", x: 0.5, y: 0.5, ...over });
const ready: EvidenceState = { status: "ready", publisher: "unverified", provenance: "valid", observations: 3, source: "Nooscape owned A2A AgentCard pilot" };
const NOW = new Date("2026-10-15T12:00:00.000Z");

describe("the facts the owl is told", () => {
  it("are only the chain for an acknowledged entry: no tier, no evidence, nothing the card does not hold", () => {
    const facts = bubbleFacts(node({ id: "bnb-1", tier: "acknowledged", chain: "bnb", kind: "acknowledged" }), { status: "idle" }, undefined);
    expect(facts).toEqual({ key: "bnb-1", tierLabel: null, chain: "BNB Chain", observations: null, publisher: null, source: null, lastObservedAt: null, sourceCount: null });
    expect(linesFor(facts, NOW).map(line => line.text)).toEqual(["Its registry is on BNB Chain."]);
  });

  it("are the card's own: tier, chain, observations, publisher, source, and what the read says of the record", () => {
    const facts = bubbleFacts(node(), ready, { lastObservedAt: new Date("2026-10-13T12:00:00.000Z"), sourceCount: 2 });
    expect(facts).toEqual({
      key: "rec-1",
      tierLabel: "Tier 3 · Domain-control verified",
      chain: "Robinhood Chain",
      observations: 3,
      publisher: "unverified",
      source: "Nooscape owned A2A AgentCard pilot",
      lastObservedAt: "2026-10-13T12:00:00.000Z",
      sourceCount: 2,
    });
    expect(linesFor(facts, NOW).map(line => line.id)).toEqual(["tier", "observations", "seen", "publisher", "chain", "source", "sources"]);
  });

  it("are nothing when there is no record on the card", () => {
    expect(bubbleFacts(null, ready, undefined)).toBeNull();
  });

  it("leave out what the evidence has not yet said, so the owl says nothing that needs it", () => {
    for (const evidence of [{ status: "loading" }, { status: "unavailable" }, { status: "idle" }] as EvidenceState[]) {
      const facts = bubbleFacts(node(), evidence, { lastObservedAt: "2026-10-13T12:00:00.000Z", sourceCount: 1 })!;
      expect(facts.observations).toBeNull();
      expect(facts.publisher).toBeNull();
      expect(facts.source).toBeNull();
      expect(linesFor(facts, NOW).map(line => line.id)).toEqual(["tier", "seen", "chain", "sources"]);
    }
  });

  it("has no chain for a record that is only listed on a directory, and no label for a tier it does not know", () => {
    const facts = bubbleFacts(node({ chain: null, tier: "tier_9" }), ready, undefined)!;
    expect(facts.chain).toBeNull();
    expect(facts.tierLabel).toBeNull();
    expect(linesFor(facts, NOW).map(line => line.id)).toEqual(["observations", "publisher", "source"]);
  });

  it("read a time as text or as a date, and drop one that does not read", () => {
    expect(bubbleFacts(node(), ready, { lastObservedAt: "2026-10-13T12:00:00Z" })!.lastObservedAt).toBe("2026-10-13T12:00:00.000Z");
    expect(bubbleFacts(node(), ready, { lastObservedAt: "never" })!.lastObservedAt).toBeNull();
    expect(bubbleFacts(node(), ready, { lastObservedAt: null })!.lastObservedAt).toBeNull();
    expect(bubbleFacts(node(), ready, undefined)!.lastObservedAt).toBeNull();
    expect(bubbleFacts(node(), ready, { sourceCount: null })!.sourceCount).toBeNull();
  });
});
