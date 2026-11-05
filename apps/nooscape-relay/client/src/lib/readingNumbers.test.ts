import { describe, expect, it } from "vitest";
import { LIGHT_CHAIN_ORDER } from "@shared/noosphere";
import { mapChainNames, readingTheNumbers } from "./readingNumbers";

describe("reading the numbers", () => {
  it("names the five counts the site shows, in the order a reader meets them", () => {
    const terms = readingTheNumbers({ listed: 61_282, reviewed: 76 }).map(entry => entry.term);
    expect(terms).toEqual(["Listed, also called acknowledged", "Reviewed", "Registered on chain", "New in the last day", "On the map"]);
  });

  it("puts a figure beside the two counts the site holds, and none beside the others", () => {
    const [listed, reviewed, registered, fresh, map] = readingTheNumbers({ listed: 61_282, reviewed: 76 });
    expect(listed!.figure).toBe(61_282);
    expect(reviewed!.figure).toBe(76);
    for (const entry of [registered!, fresh!, map!]) expect("figure" in entry).toBe(false);
  });

  it("keeps a figure that has not been read as null, never as a zero", () => {
    const [listed, reviewed] = readingTheNumbers({ listed: null, reviewed: null });
    expect(listed!.figure).toBeNull();
    expect(reviewed!.figure).toBeNull();
  });

  it("says the map draws the chains it is drawn from, so a new chain on the map changes the sentence", () => {
    expect(mapChainNames()).toBe("Robinhood Chain, Solana and BNB Chain");
    const drawn = LIGHT_CHAIN_ORDER.filter(chain => chain !== null);
    expect(drawn).toEqual(["robinhood", "solana", "bnb"]);
    const map = readingTheNumbers({ listed: 1, reviewed: 1 }).find(entry => entry.term === "On the map");
    expect(map!.meaning).toContain(mapChainNames());
  });

  it("has no long dash, no score and no verdict word in any meaning", () => {
    const text = readingTheNumbers({ listed: 1, reviewed: 1 }).map(entry => `${entry.term} ${entry.meaning}`).join(" ");
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\bscore\b|\btrusted\b|\bverified agent\b/i);
  });
});
