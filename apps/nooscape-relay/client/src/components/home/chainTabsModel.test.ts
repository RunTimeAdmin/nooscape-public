import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CHAIN_LABEL, CHAINS, EXTRA_CHAINS, type ChainStat } from "@shared/chains";
import { asOfSentence, bnbSentence, chainColorVar, formatAsOf, ratingsNote, REGION_ORDER, regionIcon, regionsHeading, regionsShown, registrySentence, registrySplitText, tabState } from "./chainTabsModel";
import { CHAIN_STYLE, markerPath } from "./constellationModel";

const row = (over: Partial<ChainStat> = {}): ChainStat => ({ chain: "robinhood", indexed: true, acknowledged: 10, reviewed: 2, feedbackEvents: 3, registries: [], asOf: "2026-10-14T15:30:00.000Z", ...over });

describe("tabState", () => {
  it("is ready for an indexed chain, not indexed for one with no active source, and unavailable with no row at all", () => {
    expect(tabState(row())).toBe("ready");
    expect(tabState(row({ indexed: false, acknowledged: null, reviewed: null, feedbackEvents: null, asOf: null }))).toBe("not-indexed");
    expect(tabState(undefined)).toBe("unavailable");
  });
});

describe("formatAsOf", () => {
  it("writes an ISO timestamp in UTC, whatever the visitor's zone", () => {
    expect(formatAsOf("2026-10-14T15:30:00.000Z")).toBe("14 Oct 2026, 15:30 UTC");
    expect(formatAsOf("2026-01-02T03:04:05Z")).toBe("2 Jan 2026, 03:04 UTC");
    expect(formatAsOf("2026-12-31T23:59:59Z")).toBe("31 Dec 2026, 23:59 UTC");
  });

  it("has nothing to show for no timestamp or one that does not parse", () => {
    expect(formatAsOf(null)).toBeNull();
    expect(formatAsOf("not a date")).toBeNull();
  });

  it("says so when a chain has never been read, rather than inventing a time", () => {
    expect(asOfSentence("2026-10-14T15:30:00.000Z")).toBe("Last successful read of this chain: 14 Oct 2026, 15:30 UTC.");
    expect(asOfSentence(null)).toBe("No successful read of this chain has been recorded yet.");
  });
});

describe("bnbSentence", () => {
  it("states what the chain holds and what the directory lists of it, as recorded facts", () => {
    expect(bnbSentence({ recorded: 373_567, listed: 6_670 })).toBe("The chain holds 373,567 registrations. The published listing rules put 6,670 of them in the directory; the rest are held out, not judged.");
  });

  it("says nothing without a published profile or with nothing recorded", () => {
    expect(bnbSentence(null)).toBeNull();
    expect(bnbSentence({ recorded: 0, listed: 0 })).toBeNull();
  });
});

describe("ratingsNote", () => {
  it("says on Solana that the figure is the 8004 registry's own counters and the other registries keep none, so it is never read as all of Solana", () => {
    expect(ratingsNote("solana")).toBe("The 8004 registry's own feedback counters, summed. SAID and Metaplex keep no ratings Nooscape reads. Not a score.");
  });

  it("keeps the wording the other chains already had", () => {
    expect(ratingsNote("robinhood")).toBe("Ratings written on-chain, revoked ones included. Not a score.");
    expect(ratingsNote("bnb")).toBe("Ratings written on-chain, revoked ones included. Not a score.");
  });
});

describe("registrySplitText", () => {
  it("names each Solana registry with its count, in the order given", () => {
    expect(registrySplitText([{ protocol: "solana_said", count: 13_764 }, { protocol: "solana_registry", count: 1_596 }, { protocol: "solana_8004", count: 1_506 }])).toBe("By registry: SAID 13,764 · Metaplex 1,596 · 8004 1,506.");
  });

  it("words a single registry on its own, and says nothing for the chains that have only one registry each", () => {
    expect(registrySplitText([{ protocol: "solana_8004", count: 3 }])).toBe("By registry: 8004 3.");
    expect(registrySplitText([{ protocol: "erc8004", count: 80 }])).toBeNull();
    expect(registrySplitText([{ protocol: "erc8004_bsc", count: 6_000 }])).toBeNull();
    expect(registrySplitText([])).toBeNull();
  });

  it("leaves a protocol it has no name for out of the line, including names an object would inherit", () => {
    expect(registrySplitText([{ protocol: "toString", count: 1 }, { protocol: "solana_said", count: 2 }])).toBe("By registry: SAID 2.");
    expect(registrySplitText([{ protocol: "constructor", count: 1 }])).toBeNull();
  });
});

describe("chainColorVar", () => {
  const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

  it("names a colour token that index.css defines, for every chain", () => {
    for (const chain of CHAINS) expect(css, chain).toMatch(new RegExp(`${chainColorVar(chain)}:\\s*#[0-9a-fA-F]{6};`));
  });

  it("gives every chain its own colour", () => {
    const colours = CHAINS.map(chain => new RegExp(`${chainColorVar(chain)}:\\s*(#[0-9a-fA-F]{6});`).exec(css)?.[1]?.toLowerCase());
    expect(new Set(colours).size).toBe(CHAINS.length);
  });
});

describe("the regions", () => {
  const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
  const tabs = readFileSync(new URL("./ChainTabs.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

  it("are the three chains, in the order the brief names them", () => {
    expect([...REGION_ORDER]).toEqual(["robinhood", "bnb", "solana"]);
    expect([...REGION_ORDER].sort()).toEqual([...CHAINS].sort());
  });

  it("each have an icon that is the shape the map gives that chain, and no two are alike", () => {
    const icons = REGION_ORDER.map(chain => regionIcon(chain));
    expect(icons.map(icon => icon.shape)).toEqual(["circle", "square", "diamond"]);
    expect(new Set(icons.map(icon => icon.path)).size).toBe(3);
    for (const chain of REGION_ORDER) {
      expect(regionIcon(chain).shape).toBe(CHAIN_STYLE[chain].shape);
      expect(regionIcon(chain).path).toBe(markerPath(CHAIN_STYLE[chain].shape));
    }
  });

  it("have the colour the map draws them in as their token, so the tab and the map agree", () => {
    for (const chain of CHAINS) expect(css, chain).toMatch(new RegExp(`${chainColorVar(chain)}:\\s*${CHAIN_STYLE[chain].color};`, "i"));
  });

  it("are tabs in that order, each with its icon beside its name, drawn as an outline until it is open and filled when it is", () => {
    expect(tabs).not.toContain("CHAINS");
    // The page links, the tabs, the panels and the first tab with figures all follow the regions: the original three, then the extra chains that are on.
    expect(tabs.match(/(?:REGION_ORDER|regions)\.(?:map|find)\(/g)).toHaveLength(4);
    expect(tabs.match(/regions\.map\(/g)).toHaveLength(2);
    expect(tabs).toContain('<svg aria-hidden="true" viewBox="-1.5 -1.5 3 3"');
    expect(tabs).toContain("<path d={regionIcon(chain).path} />");
    expect(tabs).toContain("fill-transparent stroke-[var(--chain)]");
    expect(tabs).toContain("group-data-[state=active]:fill-[var(--chain)]");
    // The name stays as text, so the icon and the colour are never the only way to tell a region.
    expect(tabs).toContain("{listedChainLabel(chain)}{\" \"}");
  });

  it("are named in the heading in the same order as the tabs, and with every extra chain off the heading is the sentence the page has always had", () => {
    expect(tabs).toContain("{regionsHeading(regions)}");
    expect(regionsHeading(REGION_ORDER)).toBe("Robinhood, BNB, Solana. Same Owl, three skies.");
    expect(REGION_ORDER.map(chain => CHAIN_LABEL[chain].split(" ")[0])).toEqual(["Robinhood", "BNB", "Solana"]);
  });

  it("link to a page of their own for the original three, and for Arc and Base while their switches are on, since Ethereum has none", () => {
    // The page links are the only use of REGION_ORDER in the component besides the import.
    expect(tabs.match(/REGION_ORDER\.map\(/g)).toHaveLength(1);
    expect(tabs).toContain("href={`/chains/${chain}`}");
    expect(tabs).toContain('regions.includes("arc")');
    expect(tabs).toContain('href="/chains/arc"');
    expect(tabs).toContain('regions.includes("base")');
    expect(tabs).toContain('href="/chains/base"');
    expect(tabs).not.toMatch(/\/chains\/ethereum/);
  });
});

describe("the extra chains' tabs", () => {
  const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
  const extraRows = EXTRA_CHAINS.map(chain => ({ chain }));

  it("are absent while every switch is off, whatever the server sends", () => {
    for (const features of [undefined, "", "watch,patrols,claims", "chain_arcade", "ethereum"]) {
      expect(regionsShown(extraRows, features), String(features)).toEqual([...REGION_ORDER]);
      expect(regionsShown(null, features), String(features)).toEqual([...REGION_ORDER]);
    }
  });

  it("appear after the original three for each switch that is on, in the order Ethereum, Base, Arc", () => {
    expect(regionsShown(extraRows, "chain_base")).toEqual(["robinhood", "bnb", "solana", "base"]);
    expect(regionsShown(extraRows, "chain_arc, chain_ethereum")).toEqual(["robinhood", "bnb", "solana", "ethereum", "arc"]);
    expect(regionsShown(extraRows, "claims,chain_base,chain_ethereum,chain_arc")).toEqual(["robinhood", "bnb", "solana", "ethereum", "base", "arc"]);
  });

  it("are left out when the server sent no row for them, and are all planned from the switches before the answer is in", () => {
    expect(regionsShown([], "chain_base,chain_arc")).toEqual([...REGION_ORDER]);
    expect(regionsShown([{ chain: "arc" }], "chain_base,chain_arc")).toEqual(["robinhood", "bnb", "solana", "arc"]);
    expect(regionsShown(null, "chain_base,chain_arc")).toEqual(["robinhood", "bnb", "solana", "base", "arc"]);
  });

  it("are named in the heading, with the number of skies counted", () => {
    expect(regionsHeading(["robinhood", "bnb", "solana", "base"])).toBe("Robinhood, BNB, Solana, Base. Same Owl, four skies.");
    expect(regionsHeading(["robinhood", "bnb", "solana", "ethereum", "base", "arc"])).toBe("Robinhood, BNB, Solana, Ethereum, Base, Arc. Same Owl, six skies.");
  });

  it("each have a shape and a colour of their own, different from the three on the map and from each other", () => {
    const all = [...REGION_ORDER, ...EXTRA_CHAINS];
    expect(new Set(all.map(chain => regionIcon(chain).path)).size).toBe(all.length);
    const colours = all.map(chain => new RegExp(`${chainColorVar(chain)}:\\s*(#[0-9a-fA-F]{6});`).exec(css)?.[1]?.toLowerCase());
    expect(colours.every(Boolean)).toBe(true);
    expect(new Set(colours).size).toBe(all.length);
  });

  it("state the registry's recorded and listed counts in the BNB tab's own words", () => {
    expect(registrySentence).toBe(bnbSentence);
    expect(registrySentence({ recorded: 54_333, listed: 1_200 })).toBe("The chain holds 54,333 registrations. The published listing rules put 1,200 of them in the directory; the rest are held out, not judged.");
    expect(registrySentence(null)).toBeNull();
  });

  it("show the same states and the same wording as any other chain", () => {
    expect(tabState({ indexed: true })).toBe("ready");
    expect(tabState({ indexed: false })).toBe("not-indexed");
    expect(ratingsNote("base")).toBe("Ratings written on-chain, revoked ones included. Not a score.");
  });
});
