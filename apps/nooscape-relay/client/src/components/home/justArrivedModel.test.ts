import { describe, expect, it } from "vitest";
import type { Arrivals } from "@shared/arrivals";
import { arrivedCountedAt, arrivedCountText, arrivedGridClass, arrivedHeroLine, arrivedRegions, arrivedTotal, firstSeenText, measuredChains } from "./justArrivedModel";

// The window is a number the server sends; no test writes it out as words, since the client says one promise about hours (the reply time).
const HOURS = 24;

const arrivals = (rows: Array<[string, boolean, number | null]>): Arrivals => ({
  windowHours: HOURS,
  computedAt: "2026-10-17T22:50:00.000Z",
  chains: rows.map(([chain, indexed, added]) => ({ chain: chain as "robinhood", indexed, added, newest: [], registries: [] })),
});

describe("what a chain's count says", () => {
  it("words one, many and none, and says nothing for a chain that is not measured", () => {
    expect(arrivedCountText({ indexed: true, added: 12 })).toBe("new entries");
    expect(arrivedCountText({ indexed: true, added: 1 })).toBe("new entry");
    expect(arrivedCountText({ indexed: true, added: 0 })).toBe("nothing new");
    expect(arrivedCountText({ indexed: false, added: null })).toBeNull();
    expect(arrivedCountText({ indexed: true, added: null })).toBeNull();
  });
});

describe("the total and the hero line", () => {
  it("sums only the chains that are measured", () => {
    const read = arrivals([["robinhood", true, 12], ["bnb", false, null], ["solana", true, 19]]);
    expect(measuredChains(read).map(row => row.chain)).toEqual(["robinhood", "solana"]);
    expect(arrivedTotal(read)).toBe(31);
    expect(arrivedHeroLine(read)).toBe(`The Owl first saw 31 entries in the last ${HOURS} hours.`);
  });

  it("says one entry, says nothing new when the measured chains gained none, and is silent when nothing is measured", () => {
    expect(arrivedHeroLine(arrivals([["robinhood", true, 1], ["bnb", true, 0]]))).toBe(`The Owl first saw 1 entry in the last ${HOURS} hours.`);
    expect(arrivedHeroLine(arrivals([["robinhood", true, 0], ["bnb", true, 0]]))).toBe(`The Owl saw nothing new in the last ${HOURS} hours.`);
    expect(arrivedHeroLine(arrivals([["robinhood", false, null]]))).toBeNull();
    expect(arrivedTotal(arrivals([]))).toBeNull();
    expect(arrivedHeroLine(null)).toBeNull();
  });

  it("groups thousands like the other figures", () => {
    expect(arrivedHeroLine(arrivals([["solana", true, 13313]]))).toBe(`The Owl first saw 13,313 entries in the last ${HOURS} hours.`);
  });
});

describe("the times", () => {
  it("dates the count in the server's time and UTC, and each first sight in UTC", () => {
    expect(arrivedCountedAt(arrivals([]))).toBe("Counted 17 Oct 2026, 22:50 UTC, from each entry's own first-seen time, under the same public rules as every other count.");
    expect(firstSeenText("2026-10-17T18:30:26.000Z")).toBe("first seen 17 Oct 2026, 18:30 UTC");
  });

  it("shows nothing for a time that cannot be read", () => {
    expect(firstSeenText("not a date")).toBeNull();
    expect(arrivedCountedAt({ ...arrivals([]), computedAt: "nope" })).toBeNull();
  });
});

describe("the chains the section draws", () => {
  const read = arrivals([["robinhood", true, 1], ["solana", true, 2], ["bnb", true, 3], ["arc", true, 246]]);
  const original = ["robinhood", "bnb", "solana"];

  it("draws the original three in the page's order, and Arc after them only when its switch is on in this build and the server sent a row for it", () => {
    expect(arrivedRegions(read, undefined)).toEqual(original);
    expect(arrivedRegions(read, "claims,chain_base,chain_ethereum")).toEqual(original);
    expect(arrivedRegions(read, "chain_arc")).toEqual([...original, "arc"]);
    expect(arrivedRegions(read, " Watch , CHAIN_ARC ")).toEqual([...original, "arc"]);
    // On in the build and off on the server: no row came, so nothing is drawn for it. The same before the answer is in.
    expect(arrivedRegions(arrivals([["robinhood", true, 1]]), "chain_arc")).toEqual(original);
    expect(arrivedRegions(null, "chain_arc")).toEqual(original);
  });

  it("lays out three cards across as it always has, and four across when there are four", () => {
    expect(arrivedGridClass(3)).toBe("sm:grid-cols-3");
    expect(arrivedGridClass(4)).toBe("sm:grid-cols-2 lg:grid-cols-4");
    expect(arrivedGridClass(5)).toBe("sm:grid-cols-2 lg:grid-cols-3");
    expect(arrivedGridClass(6)).toBe("sm:grid-cols-2 lg:grid-cols-3");
  });

  it("counts Arc in the hero line once it is measured, and leaves it out while it is not indexed", () => {
    expect(arrivedTotal(read)).toBe(252);
    expect(arrivedHeroLine(read)).toBe(`The Owl first saw 252 entries in the last ${HOURS} hours.`);
    const notIndexed = arrivals([["robinhood", true, 1], ["solana", true, 2], ["bnb", true, 3], ["arc", false, null]]);
    expect(measuredChains(notIndexed).map(row => row.chain)).toEqual(["robinhood", "solana", "bnb"]);
    expect(arrivedTotal(notIndexed)).toBe(6);
  });
});
