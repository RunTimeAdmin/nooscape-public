import { describe, expect, it } from "vitest";
import {
  buildNoosphereSample,
  FLEET_MIN,
  LIGHT_CHAIN_ORDER,
  lightChain,
  MAX_FLEETS,
  MAX_LIGHTS,
  NOOSPHERE_PROTOCOLS,
  placementHash,
  sampleModulus,
  TARGET_SAMPLE,
  type SampleInput,
} from "@shared/noosphere";

/**
 * The sample behind the Home hero. The arithmetic is pure and tested here; the database half, which proves
 * the entries the public must never see stay out of it, is in noosphereRead.test.ts.
 */
const now = new Date("2026-10-14T20:00:00.000Z");
const row = (hash: number, protocol = "erc8004", registrant: string | null = null) => ({ hash, protocol, registrant });
const wallet = (registrant: string, agentCount: number, dominantHost: string | null = null) => ({ registrant, agentCount, dominantHost });
const input = (over: Partial<SampleInput> = {}): SampleInput => ({ now, total: 25_000, rows: [], reviewed: [], wallets: [], ...over });

describe("sampleModulus", () => {
  it("keeps every nth registration so the sample is about the target size", () => {
    expect(sampleModulus(25_290)).toBe(Math.ceil(25_290 / TARGET_SAMPLE));
    expect(Math.ceil(25_290 / sampleModulus(25_290))).toBeLessThanOrEqual(TARGET_SAMPLE + 1);
    expect(sampleModulus(2_800)).toBe(2);
  });

  it("keeps them all when there are no more than the target, and for nothing", () => {
    expect(sampleModulus(TARGET_SAMPLE)).toBe(1);
    expect(sampleModulus(10)).toBe(1);
    expect(sampleModulus(0)).toBe(1);
  });
});

describe("what is drawn", () => {
  it("is only registrations on a chain: a locator listing or a ledger is not a light", () => {
    expect([...NOOSPHERE_PROTOCOLS].sort()).toEqual(["erc8004", "erc8004_bsc", "solana_8004", "solana_registry", "solana_said"]);
    const sample = buildNoosphereSample(input({ rows: [row(1, "catalog"), row(2, "a2a"), row(3, "erc8004_reputation"), row(4, "usdg_settlement"), row(5, "census"), row(6, "erc8004")] }));
    expect(sample.lights).toHaveLength(1);
    expect(sample.lights[0]![0]).toBe(6);
  });

  it("puts each light on the chain its protocol is on", () => {
    const sample = buildNoosphereSample(input({ rows: [row(1, "erc8004"), row(2, "solana_registry"), row(3, "solana_8004"), row(4, "solana_said"), row(5, "erc8004_bsc")] }));
    expect(sample.lights.map(light => LIGHT_CHAIN_ORDER[light[1]])).toEqual(["robinhood", "solana", "solana", "solana", "bnb"]);
  });

  it("has a light carry a hash, a chain, a steady flag and a fleet number, and nothing else", () => {
    const sample = buildNoosphereSample(input({ rows: [row(7)], reviewed: [{ agentId: "a", protocols: '["erc8004"]' }] }));
    for (const light of sample.lights) expect(light).toHaveLength(4);
    expect(Object.keys(sample).sort()).toEqual(["asOf", "fleets", "lights", "sampled", "steady", "total"]);
  });
});

describe("the steady lights", () => {
  it("are the reviewed records, all drawn, each once, with the chain their own protocols name", () => {
    const reviewed = [
      { agentId: "rec-b", protocols: '["a2a"]' },
      { agentId: "rec-a", protocols: '["a2a","solana_registry"]' },
      { agentId: "rec-b", protocols: '["a2a"]' },
      { agentId: "rec-c", protocols: "not json" },
    ];
    const sample = buildNoosphereSample(input({ reviewed }));
    expect(sample.steady).toBe(3);
    expect(sample.lights).toHaveLength(3);
    expect(sample.lights.every(light => light[2] === 1 && light[3] === 0)).toBe(true);
    expect(sample.lights.map(light => LIGHT_CHAIN_ORDER[light[1]])).toEqual(["solana", null, null]);
    expect(sample.lights.map(light => light[0])).toEqual([placementHash("rec-a"), placementHash("rec-b"), placementHash("rec-c")]);
  });

  it("are all kept when the cap binds, and the sampled lights give way to them", () => {
    const reviewed = Array.from({ length: 100 }, (_, index) => ({ agentId: `rec-${index}`, protocols: "[]" }));
    const rows = Array.from({ length: MAX_LIGHTS + 300 }, (_, index) => row(index + 1000));
    const sample = buildNoosphereSample(input({ reviewed, rows }));
    expect(sample.steady).toBe(100);
    expect(sample.lights).toHaveLength(MAX_LIGHTS);
    expect(sample.sampled).toBe(MAX_LIGHTS - 100);
    expect(sample.lights.filter(light => light[2] === 1)).toHaveLength(100);
  });

  it("do not exceed the cap themselves", () => {
    const reviewed = Array.from({ length: MAX_LIGHTS + 50 }, (_, index) => ({ agentId: `rec-${String(index).padStart(5, "0")}`, protocols: "[]" }));
    const sample = buildNoosphereSample(input({ reviewed, rows: [row(1)] }));
    expect(sample.lights).toHaveLength(MAX_LIGHTS);
    expect(sample.sampled).toBe(0);
  });
});

describe("fleets", () => {
  it("are the registering wallets with at least the minimum registrations, largest first", () => {
    const sample = buildNoosphereSample(input({ wallets: [wallet("0xsmall", FLEET_MIN - 1), wallet("0xb", 200), wallet("0xa", 900), wallet("0xc", FLEET_MIN)] }));
    expect(sample.fleets.map(fleet => fleet.wallet)).toEqual(["0xa", "0xb", "0xc"]);
    expect(sample.fleets.map(fleet => fleet.size)).toEqual([900, 200, FLEET_MIN]);
  });

  it("are no more than the cap, and break a tie by wallet so the order never wobbles", () => {
    const wallets = Array.from({ length: MAX_FLEETS + 5 }, (_, index) => wallet(`0x${String(index).padStart(3, "0")}`, 100));
    const sample = buildNoosphereSample(input({ wallets }));
    expect(sample.fleets).toHaveLength(MAX_FLEETS);
    expect(sample.fleets.map(fleet => fleet.wallet)).toEqual(wallets.slice(0, MAX_FLEETS).map(entry => entry.registrant));
  });

  it("mark the sampled registrations that belong to them, and no others", () => {
    const sample = buildNoosphereSample(input({ wallets: [wallet("0xbig", 500), wallet("0xmid", 100)], rows: [row(1, "erc8004", "0xbig"), row(2, "erc8004", "0xmid"), row(3, "erc8004", "0xother"), row(4, "erc8004", null), row(5, "erc8004", "0xbig")] }));
    expect(sample.lights.map(light => light[3])).toEqual([1, 2, 0, 0, 1]);
    expect(sample.lights.every(light => light[2] === 0)).toBe(true);
  });

  it("take the chain most of their sampled registrations are on, and none when none were sampled", () => {
    const sample = buildNoosphereSample(input({
      wallets: [wallet("0xrh", 300), wallet("0xsol", 200), wallet("0xnone", 100)],
      rows: [row(1, "erc8004", "0xrh"), row(2, "erc8004", "0xrh"), row(3, "erc8004_bsc", "0xrh"), row(4, "solana_registry", "0xsol")],
    }));
    expect(sample.fleets.map(fleet => fleet.chain)).toEqual(["robinhood", "solana", null]);
  });

  it("take the chain the majority is on even when it comes later in the chain order, and the earlier chain on a tie", () => {
    const sample = buildNoosphereSample(input({
      wallets: [wallet("0xmix", 300), wallet("0xtie", 200)],
      rows: [row(1, "solana_registry", "0xmix"), row(2, "erc8004_bsc", "0xmix"), row(3, "erc8004_bsc", "0xmix"), row(4, "erc8004_bsc", "0xmix"), row(5, "solana_registry", "0xtie"), row(6, "erc8004", "0xtie")],
    }));
    expect(sample.fleets.map(fleet => fleet.chain)).toEqual(["bnb", "robinhood"]);
  });

  it("carry where the wallet's registrations mostly point, and the count the directory holds", () => {
    const sample = buildNoosphereSample(input({ wallets: [wallet("0xa", 5538, "api.example.org"), wallet("0xb", 60, null)] }));
    expect(sample.fleets).toEqual([
      { wallet: "0xa", size: 5538, chain: null, host: "api.example.org" },
      { wallet: "0xb", size: 60, chain: null, host: null },
    ]);
  });
});

describe("the same input gives the same sample", () => {
  const wallets = [wallet("0xa", 300), wallet("0xb", 90)];
  const rows = Array.from({ length: 40 }, (_, index) => row(index * 977 + 3, index % 3 === 0 ? "solana_registry" : "erc8004", index % 4 === 0 ? "0xa" : index % 5 === 0 ? "0xb" : null));
  const reviewed = [{ agentId: "x", protocols: '["erc8004"]' }, { agentId: "y", protocols: "[]" }];

  it("whatever order the rows, the records and the wallets arrive in", () => {
    const forward = buildNoosphereSample(input({ rows, reviewed, wallets }));
    const reversed = buildNoosphereSample(input({ rows: [...rows].reverse(), reviewed: [...reviewed].reverse(), wallets: [...wallets].reverse() }));
    expect(reversed).toEqual(forward);
  });

  it("keeps the same registrations when the cap cuts some, because it cuts by hash", () => {
    const many = Array.from({ length: MAX_LIGHTS + 100 }, (_, index) => row(index * 3 + 1));
    const a = buildNoosphereSample(input({ rows: many }));
    const b = buildNoosphereSample(input({ rows: [...many].reverse() }));
    expect(a.lights).toEqual(b.lights);
    expect(a.lights[0]![0]).toBe(1);
  });

  it("dates itself and says what it was drawn from", () => {
    const sample = buildNoosphereSample(input({ total: 25_290, rows: [row(1)] }));
    expect(sample.asOf).toBe("2026-10-14T20:00:00.000Z");
    expect(sample.total).toBe(25_290);
    expect(sample.sampled).toBe(1);
  });

  it("is empty and valid with nothing in it", () => {
    expect(buildNoosphereSample(input({ total: 0 }))).toEqual({ asOf: "2026-10-14T20:00:00.000Z", total: 0, sampled: 0, steady: 0, lights: [], fleets: [] });
  });
});

describe("placementHash and lightChain", () => {
  it("hash an id to the same 32-bit number every time, and different ids apart", () => {
    expect(placementHash("agent-1")).toBe(placementHash("agent-1"));
    expect(placementHash("agent-1")).not.toBe(placementHash("agent-2"));
    for (const id of ["", "a", "agent-1", "0xabc:1"]) {
      expect(placementHash(id)).toBeGreaterThanOrEqual(0);
      expect(placementHash(id)).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("numbers the chains in a fixed order", () => {
    expect([null, "robinhood", "solana", "bnb"].map(chain => lightChain(chain as never))).toEqual([0, 1, 2, 3]);
  });
});
