import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatObservedTime,
  ingressMatchesFramework,
  isDomainVerifiedAgent,
  mapLiveRecord,
  positionForLiveAgent,
  protocolsForLiveAgent,
  SIGNAL_ANIMATED_LINES,
  signalLineTone,
  type LiveAtlasRecord,
} from "./atlasModel";

/**
 * The plain helpers of the home page's field, which had no test while they lived inside Home.tsx. These pin what they do today:
 * a node's place on the map comes from its id alone, so a change to the hash would move every light on the page.
 */
const record = (over: Partial<LiveAtlasRecord> = {}): LiveAtlasRecord => ({
  agentId: "agent-1",
  displayName: "Agent One",
  handle: "agent-one",
  primaryCapability: null,
  untrustedSummary: null,
  protocols: '["a2a"]',
  publisherState: "unverified",
  evidenceTier: "tier_2",
  sourceCount: 1,
  lastObservedAt: "2026-10-13T12:00:00.000Z",
  ...over,
});

describe("where a record sits on the field", () => {
  it("comes from its id alone, the same every time", () => {
    expect(positionForLiveAgent("a")).toEqual({ x: 28, y: 26 });
    expect(positionForLiveAgent("agent-1")).toEqual({ x: 60, y: 38 });
    expect(positionForLiveAgent("50d4117e-1466-4b41-b596-6df9386d397a")).toEqual({ x: 46, y: 41 });
    expect(positionForLiveAgent("agent-1")).toEqual(positionForLiveAgent("agent-1"));
  });

  it("stays inside the margins of the field for any id", () => {
    for (const id of ["", "a", "zzzzzzzzzzzz", "0xabc".repeat(20), "ünï-çødé"]) {
      const { x, y } = positionForLiveAgent(id);
      expect(x).toBeGreaterThanOrEqual(16);
      expect(x).toBeLessThan(84);
      expect(y).toBeGreaterThanOrEqual(18);
      expect(y).toBeLessThan(80);
    }
  });
});

describe("the protocols of a record", () => {
  it("reads a list of names and ignores anything else in it", () => {
    expect(protocolsForLiveAgent('["a2a","erc_8004"]')).toEqual(["a2a", "erc_8004"]);
    expect(protocolsForLiveAgent('["a2a",3,null,{"x":1}]')).toEqual(["a2a"]);
  });

  it("is empty for text that is not a list", () => {
    expect(protocolsForLiveAgent("not json")).toEqual([]);
    expect(protocolsForLiveAgent('{"a2a":true}')).toEqual([]);
    expect(protocolsForLiveAgent('"a2a"')).toEqual([]);
    expect(protocolsForLiveAgent("")).toEqual([]);
  });
});

describe("a public record as an agent on the field", () => {
  it("is observed, on the public web, with the first protocol as its label", () => {
    const agent = mapLiveRecord(record({ protocols: '["anp","a2a"]', primaryCapability: "Search", sourceCount: 3, evidenceTier: "tier_3" }));
    expect(agent).toMatchObject({
      id: "agent-1",
      name: "Agent One",
      handle: "agent-one",
      capability: "Search",
      chain: "Public web",
      framework: "ANP",
      status: "OBSERVED",
      specialties: ["Search", "anp", "a2a"],
      proof: "TIER_3 · 3 source",
      position: positionForLiveAgent("agent-1"),
    });
  });

  it("says plainly what it was not given", () => {
    const agent = mapLiveRecord(record({ protocols: "[]" }));
    expect(agent.capability).toBe("Agent discovery metadata");
    expect(agent.summary).toBe("No public description was retained for this record.");
    expect(agent.framework).toBe("A2A");
    expect(agent.specialties).toEqual(["Discovery"]);
  });

  it("is a Solana registry record when either Solana protocol is named", () => {
    for (const name of ["solana_registry", "solana_8004"]) {
      const agent = mapLiveRecord(record({ protocols: JSON.stringify([name]) }));
      expect(agent).toMatchObject({ chain: "Solana", framework: "SOLANA REGISTRY", capability: "Solana registry metadata" });
    }
  });

  it("holds at most four specialties", () => {
    expect(mapLiveRecord(record({ primaryCapability: "A", protocols: '["b","c","d","e"]' })).specialties).toEqual(["A", "b", "c", "d"]);
  });

  it("shows a publisher state the page does not know as the weakest one", () => {
    expect(mapLiveRecord(record({ publisherState: "allowlisted" })).publisherValidation.status).toBe("allowlisted");
    expect(mapLiveRecord(record({ publisherState: "something-new" })).publisherValidation.status).toBe("unverified");
  });

  it("is verified by its domain only when it is observed, unverified by a publisher and at tier 3", () => {
    expect(isDomainVerifiedAgent(mapLiveRecord(record({ evidenceTier: "tier_3" })))).toBe(true);
    expect(isDomainVerifiedAgent(mapLiveRecord(record({ evidenceTier: "tier_2" })))).toBe(false);
    expect(isDomainVerifiedAgent(mapLiveRecord(record({ evidenceTier: "tier_3", publisherState: "allowlisted" })))).toBe(false);
  });
});

describe("the arriving agent against the protocol filter", () => {
  it("passes everything for all protocols and otherwise only its own family", () => {
    expect(ingressMatchesFramework("All protocols", "ANYTHING")).toBe(true);
    expect(ingressMatchesFramework("A2A Agent Card", "A2A")).toBe(true);
    expect(ingressMatchesFramework("A2A Agent Card", "ANP")).toBe(false);
    expect(ingressMatchesFramework("ERC-8004 Identity", "ERC-8004 REGISTRY")).toBe(true);
    expect(ingressMatchesFramework("AGNTCY Directory", "AGNTCY")).toBe(true);
    expect(ingressMatchesFramework("ANP JSON-LD", "ANP")).toBe(true);
    expect(ingressMatchesFramework("Unknown protocol", "A2A")).toBe(false);
  });
});

describe("which connection lines animate", () => {
  it("animates every line while there are no more than the limit, brightening every other one", () => {
    const tones = Array.from({ length: SIGNAL_ANIMATED_LINES }, (_, index) => signalLineTone("signal-line", index, SIGNAL_ANIMATED_LINES));
    expect(tones.some(tone => tone.endsWith("-static"))).toBe(false);
    expect(tones[0]).toBe("signal-line signal-line-bright");
    expect(tones[1]).toBe("signal-line");
  });

  it("animates a bounded sample of a larger set and draws the rest as static strands", () => {
    const total = SIGNAL_ANIMATED_LINES * 3;
    const tones = Array.from({ length: total }, (_, index) => signalLineTone("signal-line", index, total));
    expect(tones.filter(tone => !tone.endsWith("-static"))).toHaveLength(SIGNAL_ANIMATED_LINES);
    expect(tones[1]).toBe("signal-line-static");
  });
});

describe("the age of an observation", () => {
  afterEach(() => vi.useRealTimers());

  it("counts seconds below a minute and whole minutes after it, and never a negative age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
    expect(formatObservedTime("2026-10-23T11:59:55.000Z")).toBe("T-5S");
    expect(formatObservedTime("2026-10-23T11:57:30.000Z")).toBe("T-2M");
    expect(formatObservedTime("2026-10-23T12:00:30.000Z")).toBe("T-0S");
  });
});
