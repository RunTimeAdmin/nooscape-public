import { describe, expect, it } from "vitest";
import { ARRIVALS_NEWEST_PER_CHAIN, ARRIVALS_WINDOW_HOURS, buildArrivals } from "./arrivals";
import { CHAINS, chainOf, extraProtocolOf, protocolsOf } from "./chains";

describe("protocolsOf", () => {
  it("is the inverse of chainOf for every chain", () => {
    for (const chain of CHAINS) {
      expect(protocolsOf(chain).length).toBeGreaterThan(0);
      for (const protocol of protocolsOf(chain)) expect(chainOf(protocol)).toBe(chain);
    }
    expect(protocolsOf("bnb")).toEqual(["erc8004_bsc"]);
    expect(protocolsOf("solana").sort()).toEqual(["solana_8004", "solana_agenc", "solana_registry", "solana_said"]);
  });
});

describe("buildArrivals", () => {
  const now = new Date("2026-10-17T22:50:00Z");
  const base = {
    now,
    counts: [
      { protocol: "erc8004", count: 12 },
      { protocol: "solana_8004", count: 7 },
      { protocol: "solana_said", count: 5 },
      { protocol: "catalog", count: 900 },
    ],
    newest: [
      { chain: "robinhood" as const, id: "rh-3", displayName: "Mesh Gate", firstSeenAt: new Date("2026-10-17T18:30:26Z") },
      { chain: "robinhood" as const, id: "rh-2", displayName: "Agent #8839", firstSeenAt: "2026-10-17T12:15:24.000Z" },
      { chain: "solana" as const, id: "sol-1", displayName: "R1", firstSeenAt: new Date("2026-10-17T20:00:00Z") },
    ],
    activeProtocols: ["erc8004", "erc8004_reputation", "solana_8004", "solana_said"],
  };

  it("gives one row per chain in the same order, stamped with the window and the time it was counted", () => {
    const read = buildArrivals(base);
    expect(read.chains.map(row => row.chain)).toEqual([...CHAINS]);
    expect(read.windowHours).toBe(ARRIVALS_WINDOW_HOURS);
    expect(read.computedAt).toBe("2026-10-17T22:50:00.000Z");
  });

  it("sums each chain's protocols and leaves the locator protocols out", () => {
    const read = buildArrivals(base);
    expect(read.chains.find(row => row.chain === "robinhood")!.added).toBe(12);
    expect(read.chains.find(row => row.chain === "solana")!.added).toBe(12);
  });

  it("reports a chain with no active source as not indexed, with no count and no names, never as zero", () => {
    const bnb = buildArrivals({ ...base, counts: [...base.counts, { protocol: "erc8004_bsc", count: 400 }], newest: [...base.newest, { chain: "bnb", id: "bnb-1", displayName: "Hidden", firstSeenAt: now }] }).chains.find(row => row.chain === "bnb")!;
    expect(bnb).toEqual({ chain: "bnb", indexed: false, added: null, newest: [], registries: [] });
  });

  it("splits a chain's count by registry, largest first, with the locator protocols in no chain's split", () => {
    const read = buildArrivals(base);
    expect(read.chains.find(row => row.chain === "solana")!.registries).toEqual([{ protocol: "solana_8004", count: 7 }, { protocol: "solana_said", count: 5 }]);
    expect(read.chains.find(row => row.chain === "robinhood")!.registries).toEqual([{ protocol: "erc8004", count: 12 }]);
    expect(read.chains.flatMap(row => row.registries).some(registry => registry.protocol === "catalog")).toBe(false);
    // The split always adds up to the chain's count, and a registry with nothing new is left out of it.
    const solana = buildArrivals({ ...base, counts: [{ protocol: "solana_said", count: 5 }, { protocol: "solana_registry", count: 0 }] }).chains.find(row => row.chain === "solana")!;
    expect(solana.registries).toEqual([{ protocol: "solana_said", count: 5 }]);
    expect(solana.added).toBe(5);
    expect(buildArrivals({ ...base, counts: [] }).chains.find(row => row.chain === "solana")!.registries).toEqual([]);
  });

  it("counts a measured chain with nothing new as zero", () => {
    const solana = buildArrivals({ ...base, counts: [] }).chains.find(row => row.chain === "solana")!;
    expect(solana).toMatchObject({ indexed: true, added: 0 });
  });

  it("keeps each chain's own newest entries, as ISO times, at most the limit", () => {
    const many = Array.from({ length: ARRIVALS_NEWEST_PER_CHAIN + 2 }, (_, index) => ({ chain: "robinhood" as const, id: `rh-${index}`, displayName: `Agent #${index}`, firstSeenAt: new Date(now.getTime() - index * 60_000) }));
    const read = buildArrivals({ ...base, newest: many });
    const robinhood = read.chains.find(row => row.chain === "robinhood")!;
    expect(robinhood.newest.map(entry => entry.id)).toEqual(["rh-0", "rh-1", "rh-2"]);
    expect(robinhood.newest[0]!.firstSeenAt).toBe("2026-10-17T22:50:00.000Z");
    const named = buildArrivals(base).chains.find(row => row.chain === "robinhood")!.newest;
    expect(named.map(entry => [entry.displayName, entry.firstSeenAt])).toEqual([["Mesh Gate", "2026-10-17T18:30:26.000Z"], ["Agent #8839", "2026-10-17T12:15:24.000Z"]]);
  });
});

describe("buildArrivals with an extra chain", () => {
  const now = new Date("2026-10-20T18:00:00Z");
  const arc = extraProtocolOf("arc");
  const base = {
    now,
    counts: [
      { protocol: "erc8004", count: 4 },
      { protocol: arc, count: 246 },
    ],
    newest: [
      { chain: "arc" as const, id: "arc-2", displayName: "Harbor Two", firstSeenAt: new Date("2026-10-20T16:45:00Z") },
      { chain: "arc" as const, id: "arc-1", displayName: "Harbor One", firstSeenAt: "2026-10-20T16:44:00.000Z" },
      { chain: "robinhood" as const, id: "rh-1", displayName: "Mesh Gate", firstSeenAt: new Date("2026-10-20T12:00:00Z") },
    ],
    activeProtocols: ["erc8004", arc],
  };

  it("adds a row after the original three for each extra chain that is on, and no row for one that is not", () => {
    expect(buildArrivals({ ...base, extras: ["arc"] }).chains.map(row => row.chain)).toEqual([...CHAINS, "arc"]);
    expect(buildArrivals({ ...base, extras: [] }).chains.map(row => row.chain)).toEqual([...CHAINS]);
    // With no list at all it is the original three, and the extra chain's count lands in no row.
    const without = buildArrivals(base);
    expect(without.chains.map(row => row.chain)).toEqual([...CHAINS]);
    expect(without.chains.reduce((sum, row) => sum + (row.added ?? 0), 0)).toBe(4);
  });

  it("counts, splits and names an extra chain as it does the others, and keeps the others as they were", () => {
    const read = buildArrivals({ ...base, extras: ["arc"] });
    const row = read.chains.find(chain => chain.chain === "arc")!;
    expect(row).toEqual({
      chain: "arc",
      indexed: true,
      added: 246,
      newest: [
        { id: "arc-2", displayName: "Harbor Two", firstSeenAt: "2026-10-20T16:45:00.000Z" },
        { id: "arc-1", displayName: "Harbor One", firstSeenAt: "2026-10-20T16:44:00.000Z" },
      ],
      registries: [{ protocol: arc, count: 246 }],
    });
    expect(read.chains.find(chain => chain.chain === "robinhood")).toMatchObject({ indexed: true, added: 4 });
    expect(read.chains.find(chain => chain.chain === "robinhood")!.newest.map(entry => entry.id)).toEqual(["rh-1"]);
  });

  it("reports an extra chain with no active source as not indexed, with no count and no names, never as zero", () => {
    const row = buildArrivals({ ...base, extras: ["arc"], activeProtocols: ["erc8004"] }).chains.find(chain => chain.chain === "arc")!;
    expect(row).toEqual({ chain: "arc", indexed: false, added: null, newest: [], registries: [] });
  });

  it("counts an extra chain that is on and has nothing new as zero", () => {
    const row = buildArrivals({ ...base, extras: ["arc"], counts: [{ protocol: "erc8004", count: 4 }], newest: [] }).chains.find(chain => chain.chain === "arc")!;
    expect(row).toMatchObject({ indexed: true, added: 0, newest: [], registries: [] });
  });
});
