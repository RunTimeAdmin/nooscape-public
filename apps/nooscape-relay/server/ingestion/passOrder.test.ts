import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { admitUnderCap, inPassOrder } from "./passOrder";

const here = fileURLToPath(new URL(".", import.meta.url));

const same = (key: string) => key;
const keys = (prefix: string, count: number) => Array.from({ length: count }, (_value, index) => `${prefix}${String(index).padStart(2, "0")}`);

describe("inPassOrder", () => {
  it("returns every item once and leaves its input alone", () => {
    const input = keys("k", 12);
    const copy = [...input];
    const ordered = inPassOrder(input, same, 7);
    expect(ordered).toHaveLength(12);
    expect([...ordered].sort()).toEqual(copy);
    expect(input).toEqual(copy);
  });

  it("is the same order for the same slot, however the items arrive, and another order for another slot", () => {
    const input = keys("k", 30);
    const first = inPassOrder(input, same, 100);
    expect(inPassOrder([...input].reverse(), same, 100)).toEqual(first);
    expect(inPassOrder(input, same, 101)).not.toEqual(first);
  });

  it("does not put the key that sorts first first in every pass", () => {
    // In key order 'k00' is first in every pass. Here it is first in about one pass in thirty.
    const input = keys("k", 30);
    let firsts = 0;
    for (let slot = 1; slot <= 300; slot += 1) if (inPassOrder(input, same, slot)[0] === "k00") firsts += 1;
    expect(firsts).toBeGreaterThan(0);
    expect(firsts).toBeLessThan(30);
  });
});

describe("admitUnderCap", () => {
  it("never admits more than the cap and takes an item whole or not at all", () => {
    const weights: Record<string, number> = { a: 3, b: 3, c: 2, d: 2, e: 1, f: 1, g: 1 };
    for (let slot = 1; slot <= 50; slot += 1) {
      const admitted = admitUnderCap(Object.keys(weights), same, key => weights[key]!, 6, slot);
      const used = [...admitted].reduce((sum, key) => sum + weights[key]!, 0);
      expect(used).toBeLessThanOrEqual(6);
    }
  });

  it("skips an item that does not fit and still admits a lighter one after it", () => {
    // A weight of 3 cannot fit in what is left of a cap of 4 once a weight of 2 is in, but a weight of 1 can.
    const weights: Record<string, number> = { heavy: 3, middle: 2, light: 1 };
    for (let slot = 1; slot <= 50; slot += 1) {
      const admitted = admitUnderCap(Object.keys(weights), same, key => weights[key]!, 4, slot);
      const used = [...admitted].reduce((sum, key) => sum + weights[key]!, 0);
      // Whatever the order, nothing that fits is left out: the cap is full or every item is in.
      expect(used === 4 || admitted.size === 3 || used === 3).toBe(true);
      if (admitted.has("heavy")) expect(admitted.has("middle")).toBe(false);
    }
  });

  it("never admits an item of no weight", () => {
    const admitted = admitUnderCap(["a", "b", "c"], same, key => (key === "b" ? 0 : 1), 10, 1);
    expect([...admitted].sort()).toEqual(["a", "c"]);
  });

  it("serves a late-sorting change in most passes when 25 early-sorting keys change in every pass", () => {
    // The shape of the audit's R11: keys ground to sort first fill a cap of 25 in key order in every pass, and the 5 honest changes
    // are never served. Here each honest change is served in about 25 passes in 30.
    const attackers = keys("a", 25);
    const honest = keys("z", 5);
    const all = [...attackers, ...honest];
    const served = new Map<string, number>(honest.map(key => [key, 0]));
    for (let slot = 1; slot <= 90; slot += 1) {
      const admitted = admitUnderCap(all, same, () => 1, 25, slot);
      expect(admitted.size).toBe(25);
      for (const key of honest) if (admitted.has(key)) served.set(key, served.get(key)! + 1);
    }
    for (const key of honest) expect(served.get(key)!).toBeGreaterThan(55);
  });
});

describe("the passes that cap their events", () => {
  // The classifiers are pure and take the slot as an argument, so a pass that stopped handing them the slot it read would still
  // pass every test of the classifiers and serve the same order in every run. The call is held to the slot here.
  const calls: Array<[string, RegExp]> = [
    ["solana8004.ts", /classifySolana8004Diff\(\{[^}]*passSlot: slotResult/],
    ["metaplexChain.ts", /classifyMetaplexChainDiff\(\{[^}]*passSlot: slotResult/],
    ["saidPass.ts", /classifySaidDiff\(\{[^}]*passSlot: chain\.slot/],
  ];
  for (const [file, call] of calls) {
    it(`${file} hands its classifier the slot the pass read`, () => {
      expect(readFileSync(join(here, file), "utf8")).toMatch(call);
    });
  }
});
