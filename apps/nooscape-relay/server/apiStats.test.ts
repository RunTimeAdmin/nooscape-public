import { describe, expect, it } from "vitest";
import { ARRIVALS_WINDOW_HOURS, type Arrivals } from "@shared/arrivals";
import type { ChainStat, ExtraChainStat } from "@shared/chains";
import { API_CHAINS, type ApiChain } from "./apiChains";
import { readStats, STATS_STATEMENT, statsAnswer, type StatsFeeds, type StatsRead } from "./apiStats";

/**
 * What GET /api/v1/stats is built from and how (server/apiStats.ts): the site's own chain figures read once, and one row for each chain
 * the API serves. The route, the shape the document describes and the switches are held by apiV1.test.ts and apiV1Chains.test.ts, and
 * the figures themselves against a real database by apiV1.integration.test.ts.
 */

const row = (chain: ChainStat["chain"], over: Partial<ChainStat> = {}): ChainStat => ({ chain, indexed: true, acknowledged: 10, reviewed: 1, feedbackEvents: 3, registries: [{ protocol: "erc8004", count: 10 }], asOf: "2026-10-27T01:00:00.000Z", ...over });
const extra = (chain: ExtraChainStat["chain"], over: Partial<ExtraChainStat> = {}): ExtraChainStat => ({
  chain,
  indexed: true,
  acknowledged: 9087,
  reviewed: 0,
  feedbackEvents: 667689,
  registries: [{ protocol: `erc8004_${chain}`, count: 9087 }],
  asOf: "2026-10-27T01:15:00.000Z",
  registry: { recorded: 1135856, listed: 9087 },
  ...over,
});
const arrivals = (added: Partial<Record<ApiChain, number | null>>): Arrivals => ({
  windowHours: ARRIVALS_WINDOW_HOURS,
  computedAt: "2026-10-27T01:20:00.000Z",
  chains: Object.entries(added).map(([chain, count]) => ({ chain: chain as ApiChain, indexed: count !== null, added: count ?? null, newest: [], registries: [] })),
});

const read = (over: Partial<StatsRead> = {}): StatsRead => ({
  readAt: "2026-10-27T01:21:00.000Z",
  chains: [row("robinhood"), row("solana", { registries: [{ protocol: "solana_said", count: 7 }, { protocol: "solana_8004", count: 3 }] }), row("bnb", { acknowledged: 5, feedbackEvents: null, registries: [{ protocol: "erc8004_bsc", count: 5 }] })],
  extras: [],
  arrivals: arrivals({ robinhood: 4, solana: 6, bnb: 2 }),
  bnbRegistrations: 392502,
  ...over,
});

const feeds = (over: Partial<StatsFeeds> = {}): StatsFeeds => ({
  chainStats: async () => ({ chains: [row("robinhood")], extras: [extra("base")] }),
  arrivals: async () => ({ arrivals: arrivals({ robinhood: 1 }) }),
  bnbRegistry: async () => ({ profile: { recorded: 123 } }),
  ...over,
});

describe("reading the figures", () => {
  it("puts the three reads together and stamps them with the time they were read, taken from the clock it is given", async () => {
    const stats = await readStats(feeds(), () => new Date("2026-10-27T01:30:00Z"));
    expect(stats).toEqual({ readAt: "2026-10-27T01:30:00.000Z", chains: [row("robinhood")], extras: [extra("base")], arrivals: arrivals({ robinhood: 1 }), bnbRegistrations: 123 });
  });

  it("takes no extra chains while none is on, and leaves the two figures that are not there null", async () => {
    const stats = await readStats(feeds({ chainStats: async () => ({ chains: [row("robinhood")] }), arrivals: async () => ({ arrivals: null }), bnbRegistry: async () => ({ profile: null }) }));
    expect(stats.extras).toEqual([]);
    expect(stats.arrivals).toBeNull();
    expect(stats.bnbRegistrations).toBeNull();
  });

  it("fails when the site's read gave no chains, which is a read that failed and not a directory with nothing in it", async () => {
    await expect(readStats(feeds({ chainStats: async () => ({ chains: [] }) }))).rejects.toThrow("The chain figures could not be read.");
  });

  it("fails when a read fails, and does not answer with what it has", async () => {
    await expect(readStats(feeds({ arrivals: async () => Promise.reject(new Error("down")) }))).rejects.toThrow("down");
    await expect(readStats(feeds({ bnbRegistry: async () => Promise.reject(new Error("down")) }))).rejects.toThrow("down");
  });
});

describe("the answer", () => {
  it("has a row for each chain served, in the order given, with its chain id and the registry contract of an EVM chain", () => {
    const answer = statsAnswer(read(), ["robinhood", "bnb", "solana"]);
    expect(answer.data.chains.map(item => item.chain)).toEqual(["robinhood", "bnb", "solana"]);
    expect(answer.data.chains.map(item => item.chain_id)).toEqual([4663, 56, null]);
    expect(answer.data.chains[0]!.registries).toEqual([{ registry: "erc8004", address: API_CHAINS.robinhood.registry, acknowledged: 10 }]);
    expect(answer.data.chains[2]!.registries).toEqual([
      { registry: "solana_said", address: null, acknowledged: 7 },
      { registry: "solana_8004", address: null, acknowledged: 3 },
    ]);
    expect(answer.api_version).toBe("v1");
    expect(answer.as_of).toBe("2026-10-27T01:21:00.000Z");
  });

  it("leaves out a chain that is not served, whatever the read holds, and does not change the list it was given", () => {
    const served: ApiChain[] = ["robinhood", "bnb", "solana", "base"];
    const answer = statsAnswer(read({ extras: [extra("base"), extra("ethereum", { acknowledged: 99 })] }), served);
    expect(answer.data.chains.map(item => item.chain)).toEqual(["robinhood", "bnb", "solana", "base"]);
    expect(answer.source).toEqual({ kind: "directory_stats", chains: ["robinhood", "bnb", "solana", "base"] });
    expect(answer.source.chains).not.toBe(served);
    expect(served).toEqual(["robinhood", "bnb", "solana", "base"]);
    expect(answer.data.totals.acknowledged).toBe(10 + 5 + 10 + 9087);
  });

  it("gives an extra chain the registrations its registry holds, with its chain id and contract, and null while that count is not complete", () => {
    const full = statsAnswer(read({ extras: [extra("base"), extra("arc", { registry: null })] }), ["robinhood", "base", "arc"]);
    const [, base, arc] = full.data.chains;
    expect(base).toMatchObject({ chain: "base", label: "Base", chain_id: 8453, acknowledged: 9087, registrations_on_chain: 1135856, ratings_recorded: 667689 });
    expect(base!.registries).toEqual([{ registry: "erc8004_base", address: API_CHAINS.base.registry, acknowledged: 9087 }]);
    expect(arc).toMatchObject({ chain: "arc", chain_id: 5042, registrations_on_chain: null });
  });

  it("counts registrations on chain for BNB Chain from its own registry read, and for no other chain that has none", () => {
    const answer = statsAnswer(read(), ["robinhood", "bnb", "solana"]);
    expect(answer.data.chains.map(item => item.registrations_on_chain)).toEqual([null, 392502, null]);
    expect(statsAnswer(read({ bnbRegistrations: null }), ["bnb"]).data.chains[0]!.registrations_on_chain).toBeNull();
  });

  it("reports the entries first seen in the window from the arrivals read, and null for a chain that read does not hold", () => {
    const answer = statsAnswer(read({ arrivals: arrivals({ robinhood: 4, bnb: null }) }), ["robinhood", "bnb", "solana"]);
    expect(answer.data.chains.map(item => item.new_in_24h)).toEqual([4, null, null]);
    // The name says 24 hours, and the figure is read over the window the site's own page uses.
    expect(ARRIVALS_WINDOW_HOURS).toBe(24);
    expect(statsAnswer(read({ arrivals: null }), ["robinhood"]).data.chains[0]!.new_in_24h).toBeNull();
  });

  it("reports a served chain with no figures, and one that is not indexed, as not indexed and not zero, and adds nothing to the total", () => {
    const answer = statsAnswer(read({ chains: [row("robinhood"), row("bnb", { indexed: false, acknowledged: null, reviewed: null, feedbackEvents: null, registries: [], asOf: null })] }), ["robinhood", "bnb", "solana"]);
    const [robinhood, bnb, solana] = answer.data.chains;
    expect(robinhood!.indexed).toBe(true);
    for (const missing of [bnb!, solana!]) expect(missing, missing.chain).toMatchObject({ indexed: false, acknowledged: null, ratings_recorded: null, registries: [], last_read_at: null });
    expect(answer.data.totals).toEqual({ acknowledged: 10 });
  });

  it("states what the counts are and are not, in plain words with no long dash and no verdict", () => {
    const answer = statsAnswer(read(), ["robinhood"]);
    expect(answer.data.statement).toBe(STATS_STATEMENT);
    expect(STATS_STATEMENT).toContain("not a count of the agents that exist or work");
    expect(STATS_STATEMENT).toContain("held out and not judged");
    expect(STATS_STATEMENT).not.toMatch(/[\u2013\u2014]/);
    expect(STATS_STATEMENT).not.toMatch(/\b(safe|unsafe|trusted|trustworthy|certified|endorsed|secure|score|rank|ranking|verdict)\b/i);
  });
});
