import { describe, expect, it } from "vitest";
import {
  BNB_CHAIN_PROTOCOL,
  buildProtocolPopulation,
  directoryProtocolDisplay,
  directoryProtocolLabel,
  extraChainTotals,
  listingRulesSentence,
  lookalikeLine,
  ON_CHAIN_REGISTRY_PROTOCOLS,
  registryChainName,
  reviewedProtocolCounts,
  splitDirectoryTotals,
} from "./directoryProtocols";

/**
 * The homepage counts. Listing the BNB Chain registry's registrations (6,619 of
 * the 373,567 on-chain pass the listing rules) must change neither the registry
 * headline nor the locator-listing count: before this split, anything not on a
 * short list of registry protocols counted as a "locator listing", so approving
 * BNB Chain would have reported its listed registrations as locator listings.
 */
const live = [
  { protocol: "catalog", count: 214_975 },
  { protocol: "solana_said", count: 13_319 },
  { protocol: "erc8004", count: 8_785 },
  { protocol: "solana_registry", count: 1_547 },
  { protocol: "solana_8004", count: 1_505 },
];
const total = (rows: Array<{ count: number }>) => rows.reduce((sum, row) => sum + row.count, 0);

describe("splitDirectoryTotals", () => {
  it("is exactly the old arithmetic while there is no BNB Chain row", () => {
    expect(splitDirectoryTotals(live, total(live))).toEqual({ onChain: 25_156, bnbChain: 0, locator: 214_975 });
  });

  it("keeps the registry headline and the locator listings unchanged when the listed BNB Chain rows arrive", () => {
    const withBnb = [...live, { protocol: BNB_CHAIN_PROTOCOL, count: 6_619 }];
    expect(splitDirectoryTotals(withBnb, total(withBnb))).toEqual({ onChain: 25_156, bnbChain: 6_619, locator: 214_975 });
  });

  it("never lets the three parts overlap or lose a row", () => {
    const withBnb = [...live, { protocol: BNB_CHAIN_PROTOCOL, count: 6_619 }, { protocol: "a2a", count: 3 }];
    const split = splitDirectoryTotals(withBnb, total(withBnb));
    expect(split.onChain + split.bnbChain + split.locator).toBe(total(withBnb));
    expect(split.locator).toBe(214_975 + 3);
  });

  it("counts a protocol it does not know as a locator listing, never as a registry identity", () => {
    expect(splitDirectoryTotals([{ protocol: "something_new", count: 7 }], 7)).toEqual({ onChain: 0, bnbChain: 0, locator: 7 });
  });

  it("clamps to zero rather than going negative when the breakdown and the total disagree", () => {
    expect(splitDirectoryTotals([{ protocol: "erc8004", count: 10 }], 4)).toEqual({ onChain: 10, bnbChain: 0, locator: 0 });
  });

  it("counts the AgenC registry as an on-chain identity beside the other Solana registries, never as a locator listing", () => {
    const withAgenc = [...live, { protocol: "solana_agenc", count: 256 }];
    expect(splitDirectoryTotals(withAgenc, total(withAgenc))).toEqual({ onChain: 25_156 + 256, bnbChain: 0, locator: 214_975 });
    expect(ON_CHAIN_REGISTRY_PROTOCOLS).toContain("solana_agenc");
  });

  it("does not put BNB Chain in the registry list", () => {
    expect(ON_CHAIN_REGISTRY_PROTOCOLS).not.toContain(BNB_CHAIN_PROTOCOL);
  });
});

describe("directoryProtocolLabel", () => {
  it("names the BNB Chain registry by its chain", () => {
    expect(directoryProtocolLabel("erc8004_bsc")).toBe("ERC-8004 · BNB CHAIN");
  });

  it("names the Robinhood Chain registry by its chain too, so the two ERC-8004 registries cannot be confused", () => {
    expect(directoryProtocolLabel("erc8004")).toBe("ERC-8004 · ROBINHOOD CHAIN");
    expect(directoryProtocolLabel("erc8004")).not.toBe(directoryProtocolLabel("erc8004_bsc"));
  });

  it("leaves every other protocol's label exactly as it was", () => {
    expect(directoryProtocolLabel("solana_said")).toBe("SOLANA SAID");
    expect(directoryProtocolLabel("solana_8004")).toBe("SOLANA 8004");
    expect(directoryProtocolLabel("catalog")).toBe("CATALOG");
  });
});

describe("lookalikeLine", () => {
  it("counts directory entries for every protocol but BNB Chain, exactly as the page always worded it", () => {
    expect(lookalikeLine("erc8004", 1, "registering wallet")).toBe("1 other entry shares this registering wallet.");
    expect(lookalikeLine("catalog", 2_500, "locator host")).toBe("2,500 other entries share this locator host.");
  });

  it("says a BNB Chain count covers the whole registry, because most of its registrations are held out of the listing", () => {
    expect(lookalikeLine(BNB_CHAIN_PROTOCOL, 1, "registering wallet")).toBe("1 other registration on BNB Chain shares this registering wallet (counted over the whole registry, listed or not).");
    expect(lookalikeLine(BNB_CHAIN_PROTOCOL, 7, "locator host")).toBe("7 other registrations on BNB Chain share this locator host (counted over the whole registry, listed or not).");
  });
});

describe("listingRulesSentence", () => {
  it("states the published thresholds, so the page cannot disagree with the rule", () => {
    expect(listingRulesSentence({ sharedProfileLinkFrom: 2, sharedHostFrom: 50, sharedWalletFrom: 10 })).toBe(
      "Listed means a profile link no other registration holds, a host fewer than 50 registrations point at, a wallet that registered fewer than 10 agents, and a name that is not only a number"
    );
  });

  it("follows the numbers when a threshold changes", () => {
    const sentence = listingRulesSentence({ sharedProfileLinkFrom: 3, sharedHostFrom: 1_000, sharedWalletFrom: 5 });
    expect(sentence).toContain("a profile link held by fewer than 3 registrations");
    expect(sentence).toContain("a host fewer than 1,000 registrations point at");
    expect(sentence).toContain("a wallet that registered fewer than 5 agents");
  });
});

describe("directoryProtocolDisplay", () => {
  it("chain-labels the two EVM registries and prints every other protocol as recorded", () => {
    expect(directoryProtocolDisplay("erc8004")).toBe("ERC-8004 · ROBINHOOD CHAIN");
    expect(directoryProtocolDisplay("erc8004_bsc")).toBe("ERC-8004 · BNB CHAIN");
    expect(directoryProtocolDisplay("catalog")).toBe("catalog");
    expect(directoryProtocolDisplay("solana_said")).toBe("solana_said");
  });
});

describe("reviewedProtocolCounts", () => {
  it("counts one protocol per record, so the counts add up to the reviewed records", () => {
    const lists = [["a2a"], ["catalog"], ["catalog", "a2a"], ["erc8004", "a2a"], ["erc8004"], ["solana_registry"], []];
    const counts = reviewedProtocolCounts(lists);
    expect(counts).toEqual({ a2a: 2, catalog: 2, erc8004: 2, solana_registry: 1 });
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(lists.length);
  });

  it("shows a record under its Solana registry first, the Metaplex one before the 8004 one", () => {
    expect(reviewedProtocolCounts([["a2a", "solana_8004"], ["solana_8004", "solana_registry"], ["solana_8004"]])).toEqual({ solana_8004: 2, solana_registry: 1 });
  });

  it("matches the live reviewed set: 82 records over four protocols", () => {
    const lists = [...Array.from({ length: 3 }, () => ["a2a"]), ...Array.from({ length: 48 }, () => ["catalog"]), ...Array.from({ length: 24 }, () => ["erc8004", "a2a"]), ...Array.from({ length: 7 }, () => ["solana_registry"])];
    expect(reviewedProtocolCounts(lists)).toEqual({ a2a: 3, catalog: 48, erc8004: 24, solana_registry: 7 });
  });
});

describe("buildProtocolPopulation", () => {
  const live = [
    { protocol: "catalog", count: 214_975 },
    { protocol: "solana_said", count: 13_361 },
    { protocol: "erc8004", count: 8_786 },
    { protocol: "solana_registry", count: 1_548 },
    { protocol: "solana_8004", count: 1_505 },
  ];
  const reviewed = { a2a: 3, catalog: 48, erc8004: 24, solana_registry: 7 };

  it("lists every protocol Nooscape reads, acknowledged count first and the reviewed count beside it", () => {
    expect(buildProtocolPopulation(live, reviewed).map(row => [row.label, row.acknowledged, row.reviewed])).toEqual([
      ["CATALOG", 214_975, 48],
      ["SOLANA SAID", 13_361, 0],
      ["ERC-8004 · ROBINHOOD CHAIN", 8_786, 24],
      ["SOLANA REGISTRY", 1_548, 7],
      ["SOLANA 8004", 1_505, 0],
      ["A2A", null, 3],
    ]);
  });

  it("counts six protocols today and seven once the BNB Chain registry is listed", () => {
    expect(buildProtocolPopulation(live, reviewed)).toHaveLength(6);
    const withBnb = buildProtocolPopulation([...live, { protocol: BNB_CHAIN_PROTOCOL, count: 6_619 }], reviewed);
    expect(withBnb).toHaveLength(7);
    expect(withBnb.map(row => row.label)).toContain("ERC-8004 · BNB CHAIN");
    // Sorted by what is acknowledged, so BNB Chain sits between the Robinhood registry and the Solana ones.
    expect(withBnb.map(row => row.protocol).slice(2, 4)).toEqual(["erc8004", "erc8004_bsc"]);
  });

  it("still lists the reviewed protocols while the directory read has not arrived", () => {
    expect(buildProtocolPopulation([], reviewed).map(row => [row.protocol, row.acknowledged, row.reviewed])).toEqual([
      ["catalog", null, 48],
      ["erc8004", null, 24],
      ["solana_registry", null, 7],
      ["a2a", null, 3],
    ]);
  });
});

describe("Ethereum, Base and Arc in the directory's counts and names", () => {
  const withExtras = [
    ...live,
    { protocol: BNB_CHAIN_PROTOCOL, count: 6_619 },
    { protocol: "erc8004_arc", count: 30 },
    { protocol: "erc8004_eth", count: 700 },
    { protocol: "erc8004_base", count: 1_800 },
  ];

  it("takes their listed registrations out of the locator listings and counts them as neither identities nor listings", () => {
    const split = splitDirectoryTotals(withExtras, total(withExtras));
    expect(split).toEqual({ onChain: 25_156, bnbChain: 6_619, locator: 214_975 });
    expect(split.onChain + split.bnbChain + split.locator + 30 + 700 + 1_800).toBe(total(withExtras));
  });

  it("is the old arithmetic while the directory holds none of them, which is what every switch off gives", () => {
    const withBnb = [...live, { protocol: BNB_CHAIN_PROTOCOL, count: 6_619 }];
    expect(splitDirectoryTotals(withBnb, total(withBnb))).toEqual({ onChain: 25_156, bnbChain: 6_619, locator: 214_975 });
    expect(extraChainTotals(withBnb)).toEqual([]);
    expect(extraChainTotals([])).toEqual([]);
  });

  it("totals each of them that has any, in the order of the tabs", () => {
    expect(extraChainTotals(withExtras)).toEqual([
      { chain: "ethereum", label: "Ethereum", count: 700 },
      { chain: "base", label: "Base", count: 1_800 },
      { chain: "arc", label: "Arc", count: 30 },
    ]);
    expect(extraChainTotals([{ protocol: "erc8004_base", count: 0 }, { protocol: "erc8004_arc", count: 2 }])).toEqual([{ chain: "arc", label: "Arc", count: 2 }]);
  });

  it("names each registry by its chain, the way the other EVM registries are named", () => {
    expect(directoryProtocolLabel("erc8004_eth")).toBe("ERC-8004 · ETHEREUM");
    expect(directoryProtocolLabel("erc8004_base")).toBe("ERC-8004 · BASE");
    expect(directoryProtocolLabel("erc8004_arc")).toBe("ERC-8004 · ARC");
    expect(directoryProtocolDisplay("erc8004_base")).toBe("ERC-8004 · BASE");
  });

  it("says a look-alike count over their registries covers the whole registry, as BNB Chain's does", () => {
    expect(registryChainName("erc8004_bsc")).toBe("BNB Chain");
    expect(registryChainName("erc8004_eth")).toBe("Ethereum");
    expect(registryChainName("erc8004")).toBeNull();
    expect(registryChainName("solana_said")).toBeNull();
    expect(lookalikeLine("erc8004_base", 1, "registering wallet")).toBe("1 other registration on Base shares this registering wallet (counted over the whole registry, listed or not).");
    expect(lookalikeLine("erc8004_arc", 3, "locator host")).toBe("3 other registrations on Arc share this locator host (counted over the whole registry, listed or not).");
    expect(lookalikeLine("erc8004_bsc", 2, "locator host")).toBe("2 other registrations on BNB Chain share this locator host (counted over the whole registry, listed or not).");
    expect(lookalikeLine("erc8004", 2, "locator host")).toBe("2 other entries share this locator host.");
  });
});
