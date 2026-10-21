import { describe, expect, it } from "vitest";
import { barPercent, clamp01, countUpValue, easeOutCubic, EVIDENCE_FROM, FOG_STAGE_MS, fogRows, fogSplit, fleetCards, funnelMax, shortWallet, stageDelays } from "./noiseModel";

describe("countUpValue", () => {
  it("starts at the start, ends exactly at the end, and only ever climbs", () => {
    expect(countUpValue(0, 246_850, 0)).toBe(0);
    expect(countUpValue(0, 246_850, 1)).toBe(246_850);
    expect(countUpValue(0, 246_850, 1.7)).toBe(246_850);
    let previous = -1;
    for (let step = 0; step <= 100; step += 1) {
      const value = countUpValue(0, 246_850, step / 100);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(Number.isInteger(value)).toBe(true);
      previous = value;
    }
  });

  it("is fast at first and settles", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(3)).toBe(1);
  });

  it("counts down as well as up, for a figure that falls between polls", () => {
    expect(countUpValue(100, 40, 0)).toBe(100);
    expect(countUpValue(100, 40, 1)).toBe(40);
    expect(countUpValue(100, 40, 0.5)).toBeLessThan(100);
    expect(countUpValue(100, 40, 0.5)).toBeGreaterThan(40);
  });
});

describe("barPercent", () => {
  it("leaves a missing value missing, and keeps a real zero a zero", () => {
    expect(barPercent(null, 1000)).toBeNull();
    expect(barPercent(0, 1000)).toBe(0);
  });

  it("scales against the longest, and never lets a real count vanish", () => {
    expect(barPercent(1000, 1000)).toBe(100);
    expect(barPercent(500, 1000)).toBe(50);
    expect(barPercent(82, 246_850)).toBe(0.8);
    expect(barPercent(5, 0)).toBe(100);
  });

  it("finds the longest among measured steps, ignoring the unmeasured", () => {
    expect(funnelMax([{ key: "a", value: 10 }, { key: "b", value: null }, { key: "c", value: 300 }])).toBe(300);
    expect(funnelMax([{ key: "a", value: null }])).toBe(0);
    expect(funnelMax([])).toBe(0);
  });
});

const funnel = [
  { key: "acknowledged", value: 246_850 },
  { key: "withLocator", value: 200_000 },
  { key: "withRegistrant", value: 100_000 },
  { key: "withMintMeasured", value: 50_000 },
  { key: "reviewed", value: 82 },
  { key: "domainProven", value: 1 },
];

describe("fogSplit", () => {
  it("puts the steps before the reviewed one in the fog, and the reviewed one and what follows it in what is left", () => {
    expect(EVIDENCE_FROM).toBe("reviewed");
    const split = fogSplit(funnel)!;
    expect(split.fog.map(step => step.key)).toEqual(["acknowledged", "withLocator", "withRegistrant", "withMintMeasured"]);
    expect(split.left.map(step => step.key)).toEqual(["reviewed", "domainProven"]);
  });

  it("is nothing when the funnel cannot say who is left: no reviewed step, it first, or its count not measured", () => {
    expect(fogSplit([])).toBeNull();
    expect(fogSplit(funnel.filter(step => step.key !== "reviewed"))).toBeNull();
    expect(fogSplit(funnel.slice(4))).toBeNull();
    expect(fogSplit(funnel.map(step => (step.key === "reviewed" ? { ...step, value: null } : step)))).toBeNull();
  });

  it("is still a split when a step after the evidence is not measured, and when a step before it is not", () => {
    expect(fogSplit(funnel.map(step => (step.key === "domainProven" ? { ...step, value: null } : step)))!.left).toHaveLength(2);
    expect(fogSplit(funnel.map(step => (step.key === "withLocator" ? { ...step, value: null } : step)))!.fog).toHaveLength(4);
  });
});

describe("fogRows", () => {
  const rows = fogRows(funnel);

  it("marks each step as fog or left, in the funnel's own order", () => {
    expect(rows.map(row => row.key)).toEqual(funnel.map(step => step.key));
    expect(rows.map(row => row.role)).toEqual(["fog", "fog", "fog", "fog", "left", "left"]);
  });

  it("moves the fog one stage at a time down the list, and what is left together, a stage after the last of it", () => {
    expect(rows.map(row => row.stage)).toEqual([0, 1, 2, 3, 4, 4]);
  });

  it("draws every bar against the longest step, and never lets a real count vanish", () => {
    expect(rows[0]!.full).toBe(100);
    expect(rows[3]!.full).toBeCloseTo((50_000 / 246_850) * 100, 6);
    expect(rows[4]!.full).toBe(0.8);
    expect(rows[5]!.full).toBe(0.8);
  });

  it("draws what is left against the longest of what is left once the fog is cleared, and gives the fog no such bar", () => {
    expect(rows.slice(0, 4).map(row => row.zoomed)).toEqual([null, null, null, null]);
    expect(rows[4]!.zoomed).toBe(100);
    expect(rows[5]!.zoomed).toBeCloseTo((1 / 82) * 100, 6);
  });

  it("keeps a step that is not measured as not measured, never as a zero", () => {
    const gap = fogRows(funnel.map(step => (step.key === "domainProven" ? { ...step, value: null } : step)));
    expect(gap[5]!.full).toBeNull();
    expect(gap[5]!.zoomed).toBeNull();
  });

  it("has only fog when the funnel cannot be split", () => {
    expect(fogRows(funnel.slice(0, 3)).every(row => row.role === "fog" && row.zoomed === null)).toBe(true);
    expect(fogRows([])).toEqual([]);
  });
});

describe("stageDelays", () => {
  it("moves the figure on one stage of 600 ms after another, for each step of the fog, the last onto the evidence", () => {
    expect(FOG_STAGE_MS).toBe(600);
    expect(stageDelays(fogSplit(funnel)!)).toEqual([600, 1200, 1800, 2400]);
    expect(stageDelays(fogSplit(funnel.slice(1))!)).toEqual([600, 1200, 1800]);
  });

  it("lines up with the rows: the fog row at place i has gone when the figure reaches step i + 1, and the last stage lands on the first of what is left", () => {
    const split = fogSplit(funnel)!;
    const rows = fogRows(funnel);
    const delays = stageDelays(split);
    expect(delays).toHaveLength(split.fog.length);
    for (const row of rows.filter(item => item.role === "fog")) expect(delays[row.stage]).toBe((row.stage + 1) * FOG_STAGE_MS);
    expect(funnel[split.fog.length]!.key).toBe(EVIDENCE_FROM);
  });
});

describe("shortWallet", () => {
  it("shortens an EVM address and a Solana address, and leaves a short one alone", () => {
    expect(shortWallet("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortWallet("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBe("9xQe…VFin");
    expect(shortWallet("0xabc")).toBe("0xabc");
  });
});

describe("fleetCards", () => {
  const wallets = [
    { registrant: "0xb", agentCount: 40, dominantHost: "b.example" },
    { registrant: "0xa", agentCount: 40, dominantHost: null },
    { registrant: "0xc", agentCount: 400, dominantHost: "c.example" },
    { registrant: "0xz", agentCount: 0, dominantHost: null },
  ];

  it("orders by count, then address, drops a wallet with nothing recorded, and keeps the host hint as given", () => {
    const cards = fleetCards(wallets);
    expect(cards.map(card => card.registrant)).toEqual(["0xc", "0xa", "0xb"]);
    expect(cards[0]!.dominantHost).toBe("c.example");
    expect(cards[1]!.dominantHost).toBeNull();
  });

  it("gives each a share of the largest, never thinner than a sliver, and respects the limit", () => {
    const cards = fleetCards(wallets, 2);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.share).toBe(100);
    expect(cards[1]!.share).toBe(10);
    expect(fleetCards([{ registrant: "0xq", agentCount: 1, dominantHost: null }, { registrant: "0xr", agentCount: 100_000, dominantHost: null }])[1]!.share).toBe(2);
  });

  it("handles none", () => {
    expect(fleetCards([])).toEqual([]);
  });
});
