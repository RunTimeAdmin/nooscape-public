import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildChainStats,
  buildExtraChainStats,
  CHAIN_LABEL,
  chainOf,
  CHAINS,
  EXTRA_CHAIN_LABEL,
  EXTRA_CHAIN_SWITCH,
  EXTRA_CHAINS,
  extraChainsOn,
  extraProtocolOf,
  listedChainLabel,
  listedChainOf,
  listedChains,
  parseProtocolList,
  protocolsOfChainsOff,
  type ChainStat,
  type ChainStatsInput,
  type ExtraChainKey,
} from "@shared/chains";
import { FEATURES } from "@shared/features";
import * as schema from "../drizzle/schema";
import { BSC_CHAIN, ERC8004_CHAINS } from "./ingestion/erc8004Chains";

/**
 * Ethereum, Base and Arc beside the three chains of the map (docs/multichain-erc8004-2026-10-20.md, stage 3): the shared model that
 * says which chains are listed under which switches, held to the chain pass's own entries so the two cannot drift, and the
 * per-chain figures held to the code they replaced for the original three.
 */

describe("the extra chains' model", () => {
  const switched = ERC8004_CHAINS.filter(chain => chain.feature !== null);

  it("has one entry for each chain the pass reads that has a switch, in the same order, with the pass's own protocol, name and switch", () => {
    expect(switched.map(chain => chain.chainKey)).toEqual([...EXTRA_CHAINS]);
    for (const chain of switched) {
      const key = chain.chainKey as ExtraChainKey;
      expect(listedChainOf(chain.protocol), key).toBe(key);
      expect(extraProtocolOf(key)).toBe(chain.protocol);
      expect(EXTRA_CHAIN_LABEL[key]).toBe(chain.chainLabel);
      expect(EXTRA_CHAIN_SWITCH[key]).toBe(chain.feature);
      expect(FEATURES).toContain(chain.feature);
    }
    expect(EXTRA_CHAIN_LABEL).toEqual({ ethereum: "Ethereum", base: "Base", arc: "Arc" });
  });

  it("leaves BNB Chain, the chain of the pass with no switch, where it was", () => {
    expect(BSC_CHAIN.feature).toBeNull();
    expect(chainOf(BSC_CHAIN.protocol)).toBe("bnb");
    expect(listedChainOf(BSC_CHAIN.protocol)).toBe("bnb");
    expect(CHAIN_LABEL.bnb).toBe(BSC_CHAIN.chainLabel);
  });

  it("keeps the extra chains out of the map's list of chains, so no light, page or Owl's Catch can name one", () => {
    expect([...CHAINS]).toEqual(["robinhood", "solana", "bnb"]);
    for (const chain of EXTRA_CHAINS) {
      expect(chainOf(extraProtocolOf(chain))).toBeNull();
      expect(CHAINS as readonly string[]).not.toContain(chain);
    }
  });

  it("has a protocol for each chain in the database's list of protocols", () => {
    const enumValues: readonly string[] = schema.ingestionSources.protocol.enumValues;
    for (const chain of EXTRA_CHAINS) {
      expect(enumValues).toContain(extraProtocolOf(chain));
      expect(schema.agentDirectoryEntries.protocol.enumValues).toContain(extraProtocolOf(chain));
    }
  });

  it("lists the extra chains only for the switches that are on, whatever else the list holds", () => {
    expect(extraChainsOn(undefined)).toEqual([]);
    expect(extraChainsOn("")).toEqual([]);
    expect(extraChainsOn("watch,patrols,claims")).toEqual([]);
    expect(extraChainsOn("chain_arcade,Chain,ethereum")).toEqual([]);
    expect(extraChainsOn("chain_base")).toEqual(["base"]);
    expect(extraChainsOn(" Chain_Arc , chain_ethereum ")).toEqual(["ethereum", "arc"]);
    expect(listedChains(undefined)).toEqual(["robinhood", "solana", "bnb"]);
    expect(listedChains("chain_base,chain_arc")).toEqual(["robinhood", "solana", "bnb", "base", "arc"]);
  });

  it("names the protocols to leave out of every public read: those of the chains whose switch is off", () => {
    expect(protocolsOfChainsOff(undefined).sort()).toEqual(["erc8004_arc", "erc8004_base", "erc8004_eth"]);
    expect(protocolsOfChainsOff("claims")).toEqual(protocolsOfChainsOff(undefined));
    expect(protocolsOfChainsOff("chain_base").sort()).toEqual(["erc8004_arc", "erc8004_eth"]);
    expect(protocolsOfChainsOff("chain_ethereum,chain_base,chain_arc")).toEqual([]);
  });

  it("names every listed chain", () => {
    expect([...CHAINS, ...EXTRA_CHAINS].map(listedChainLabel)).toEqual(["Robinhood Chain", "Solana", "BNB Chain", "Ethereum", "Base", "Arc"]);
  });
});

describe("the figures of the original three chains", () => {
  /** The function as it was before the extra chains: the algorithm, word for word, over `chainOf`. */
  function before(input: ChainStatsInput): ChainStat[] {
    const toIso = (value: Date | string | null) => {
      if (value === null) return null;
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };
    return CHAINS.map(chain => {
      const mine = input.sources.filter(source => chainOf(source.protocol) === chain);
      const indexed = mine.some(source => source.state === "active");
      const newest = mine
        .filter(source => source.state === "active")
        .map(source => toIso(source.lastSuccessfulAt))
        .filter((value): value is string => value !== null)
        .sort()
        .pop();
      const acknowledged = input.byProtocol.filter(entry => chainOf(entry.protocol) === chain).reduce((sum, entry) => sum + entry.count, 0);
      const reviewed = input.reviewedProtocols.filter(protocols => protocols.some(protocol => chainOf(protocol) === chain)).length;
      const feedbackEvents = !indexed ? null : chain === "robinhood" ? input.robinhoodFeedback : chain === "solana" ? (input.solanaFeedback ?? null) : null;
      const registries = input.byProtocol
        .filter(entry => chainOf(entry.protocol) === chain && entry.count > 0)
        .map(entry => ({ protocol: entry.protocol, count: entry.count }))
        .sort((left, right) => right.count - left.count);
      return { chain, indexed, acknowledged: indexed ? acknowledged : null, reviewed: indexed ? reviewed : null, feedbackEvents, registries: indexed ? registries : [], asOf: newest ?? null };
    });
  }

  const sources = (protocols: string[], state = "active") => protocols.map((protocol, index) => ({ protocol, state, lastSuccessfulAt: new Date(Date.UTC(2026, 9, 14, 10 + index)) }));
  const inputs: Array<[string, ChainStatsInput]> = [
    ["nothing at all", { byProtocol: [], reviewedProtocols: [], robinhoodFeedback: null, sources: [] }],
    [
      "the three chains, indexed",
      {
        byProtocol: [{ protocol: "erc8004", count: 90 }, { protocol: "erc8004_bsc", count: 6_000 }, { protocol: "solana_said", count: 13_764 }, { protocol: "solana_registry", count: 1_596 }, { protocol: "a2a", count: 4 }],
        reviewedProtocols: [["erc8004", "a2a"], ["solana_registry", "solana_8004"], ["a2a"], parseProtocolList("[\"erc8004_bsc\"]")],
        robinhoodFeedback: 641,
        solanaFeedback: 1_506,
        sources: sources(["erc8004", "erc8004_reputation", "solana_said", "solana_8004", "erc8004_bsc", "a2a"]),
      },
    ],
    [
      "the same, with the extra chains in the directory and the source list too",
      {
        byProtocol: [{ protocol: "erc8004", count: 90 }, { protocol: "erc8004_bsc", count: 6_000 }, { protocol: "erc8004_eth", count: 700 }, { protocol: "erc8004_base", count: 1_800 }, { protocol: "erc8004_arc", count: 30 }, { protocol: "solana_8004", count: 3 }],
        reviewedProtocols: [["erc8004_base"], ["erc8004", "erc8004_arc"]],
        robinhoodFeedback: null,
        sources: [...sources(["erc8004", "erc8004_bsc"]), ...sources(["erc8004_eth", "erc8004_base", "erc8004_arc"], "paused")],
      },
    ],
    [
      "chains that are not indexed",
      { byProtocol: [{ protocol: "erc8004_bsc", count: 5 }], reviewedProtocols: [["erc8004_bsc"]], robinhoodFeedback: 3, solanaFeedback: 9, sources: sources(["erc8004_bsc", "solana_said"], "paused") },
    ],
  ];

  it.each(inputs)("are what they were: %s", (_name, input) => {
    expect(JSON.stringify(buildChainStats(input))).toBe(JSON.stringify(before(input)));
  });

  it("have no row for an extra chain, and an extra chain's entries and sources count for none of the three", () => {
    const [, withExtras] = inputs[2]!;
    const rows = buildChainStats(withExtras);
    expect(rows.map(row => row.chain)).toEqual(["robinhood", "solana", "bnb"]);
    // Solana has entries but no active source in this input, so it is not measured: null, not three.
    expect(rows.map(row => row.acknowledged)).toEqual([90, null, 6_000]);
    expect(rows.find(row => row.chain === "bnb")!.registries).toEqual([{ protocol: "erc8004_bsc", count: 6_000 }]);
  });
});

describe("the figures of an extra chain", () => {
  const input: ChainStatsInput = {
    byProtocol: [{ protocol: "erc8004", count: 90 }, { protocol: "erc8004_base", count: 1_800 }, { protocol: "erc8004_arc", count: 30 }],
    reviewedProtocols: [["erc8004_base"], ["erc8004", "erc8004_arc"], ["a2a"]],
    robinhoodFeedback: 641,
    sources: [
      { protocol: "erc8004", state: "active", lastSuccessfulAt: "2026-10-14T10:00:00.000Z" },
      { protocol: "erc8004_base", state: "active", lastSuccessfulAt: new Date("2026-10-20T09:00:00Z") },
      { protocol: "erc8004_base", state: "paused", lastSuccessfulAt: new Date("2026-10-21T09:00:00Z") },
      { protocol: "erc8004_arc", state: "paused", lastSuccessfulAt: null },
    ],
  };

  it("are the same figures as any chain's, from the chain's own protocol and sources", () => {
    const [base] = buildExtraChainStats(input, ["base"], { base: { recorded: 321_929, listed: 1_900 } });
    expect(base).toEqual({
      chain: "base",
      indexed: true,
      acknowledged: 1_800,
      reviewed: 1,
      feedbackEvents: null,
      registries: [{ protocol: "erc8004_base", count: 1_800 }],
      asOf: "2026-10-20T09:00:00.000Z",
      registry: { recorded: 321_929, listed: 1_900 },
    });
  });

  it("say so when a chain has no active source or no published profile: not measured, never zero", () => {
    const rows = buildExtraChainStats(input, ["ethereum", "arc"]);
    expect(rows.map(row => row.chain)).toEqual(["ethereum", "arc"]);
    for (const row of rows) expect(row).toEqual({ chain: row.chain, indexed: false, acknowledged: null, reviewed: null, feedbackEvents: null, registries: [], asOf: null, registry: null });
  });

  it("show a chain's own ratings count once it has one, and not measured before and beside it", () => {
    const withCount = { ...input, chainFeedback: { base: 150_000 } };
    expect(buildExtraChainStats(withCount, ["base"])[0]!.feedbackEvents).toBe(150_000);
    // No count for the chain (its read has not reached the head, or its table is not there): not measured, never zero.
    expect(buildExtraChainStats(input, ["base"])[0]!.feedbackEvents).toBeNull();
    expect(buildExtraChainStats({ ...input, chainFeedback: {} }, ["base"])[0]!.feedbackEvents).toBeNull();
    // A count is only ever for the chain it names, and a chain that is not indexed shows none whatever the table holds.
    expect(buildExtraChainStats({ ...input, chainFeedback: { arc: 609 } }, ["base"])[0]!.feedbackEvents).toBeNull();
    expect(buildExtraChainStats({ ...input, chainFeedback: { arc: 609 } }, ["arc"])[0]!.feedbackEvents).toBeNull();
    // A counted zero is a zero: the registry was read and holds no rating.
    expect(buildExtraChainStats({ ...input, chainFeedback: { base: 0 } }, ["base"])[0]!.feedbackEvents).toBe(0);
    // Robinhood Chain keeps its own source: a count under its key changes nothing.
    expect(buildChainStats({ ...input, chainFeedback: { robinhood: 1 } }).find(row => row.chain === "robinhood")!.feedbackEvents).toBe(641);
  });

  it("are one row for each chain given, in the order given, and none for a chain not given", () => {
    expect(buildExtraChainStats(input, []).length).toBe(0);
    expect(buildExtraChainStats(input, ["arc", "base"]).map(row => row.chain)).toEqual(["arc", "base"]);
  });
});

describe("the public reads in db.ts", () => {
  const source = readFileSync(new URL("./db.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

  it("leave out a chain whose switch is off through the one visibility rule every directory read uses", () => {
    const rule = source.slice(source.indexOf("function directoryVisibilityCondition()"), source.indexOf("export function sanitizeDirectoryEntry"));
    expect(rule).toContain("chainSwitchCondition()");
    // The switch list is read as the server runs, from the same variable the client is built with.
    const condition = source.slice(source.indexOf("function chainSwitchCondition()"), source.indexOf("function directoryVisibilityCondition()"));
    expect(condition).toContain("protocolsOfChainsOff(process.env.VITE_FEATURES)");
    expect(condition).toContain("notInArray(ingestionSources.protocol, off)");
    // With every switch on there is nothing to leave out, and drizzle's notInArray refuses an empty list.
    expect(condition).toContain("off.length > 0");
  });

  it("leave out the sources of a chain whose switch is off from the public source list", () => {
    const list = source.slice(source.indexOf("export async function listPublicIngestionSourceStatuses()"), source.indexOf("export async function listReviewItems()"));
    expect(list).toContain(".where(chainSwitchCondition())");
  });

  it("count the registrations of a registry the chain pass reads over the whole registry, for every chain the pass reads", () => {
    expect(source).toContain("erc8004ChainOfProtocol(entry.protocol) !== null");
    expect(source).not.toMatch(/entry\.protocol === "erc8004_bsc" && entry\.sourceId/);
  });
});
