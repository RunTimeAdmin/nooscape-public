import { describe, expect, it } from "vitest";
import { balancedNewest } from "./balancedNewest";

type Item = { id: string; group: string; at: number };
const item = (id: string, group: string, at: number): Item => ({ id, group, at });
const options = (limit: number, floor: number) => ({ limit, floor, group: (entry: Item) => entry.group, compare: (a: Item, b: Item) => b.at - a.at });
const ids = (items: Item[]) => items.map(entry => entry.id);

// One busy group (a batch of A registrations at the same minute) and two quiet ones.
const feed = [
  ...Array.from({ length: 10 }, (_, index) => item(`a${index}`, "A", 1_000 - index)),
  item("b1", "B", 400),
  item("b2", "B", 300),
  item("c1", "C", 200),
  item("c2", "C", 100),
];

describe("balancedNewest", () => {
  it("is just the newest when no group is kept first", () => {
    expect(ids(balancedNewest(feed, options(4, 0)))).toEqual(["a0", "a1", "a2", "a3"]);
  });

  it("keeps each group's newest one however many newer items another group has", () => {
    expect(ids(balancedNewest(feed, options(6, 1)))).toEqual(["a0", "a1", "a2", "a3", "b1", "c1"]);
  });

  it("keeps each group's newest two, and fills the rest of the limit with the newest left", () => {
    expect(ids(balancedNewest(feed, options(8, 2)))).toEqual(["a0", "a1", "a2", "a3", "b1", "b2", "c1", "c2"]);
    expect(ids(balancedNewest(feed, options(7, 2)))).toEqual(["a0", "a1", "a2", "b1", "b2", "c1", "c2"]);
  });

  it("sorts what it returns newest first, whatever order it was given", () => {
    const shuffled = [feed[11]!, feed[3]!, feed[10]!, feed[0]!, feed[13]!, feed[12]!, feed[5]!];
    const out = balancedNewest(shuffled, options(5, 1));
    expect(out.map(entry => entry.at)).toEqual([...out.map(entry => entry.at)].sort((a, b) => b - a));
    expect(ids(out)).toEqual(["a0", "a3", "a5", "b1", "c1"].filter(id => ids(out).includes(id)));
  });

  it("returns everything, sorted, when there are fewer items than the limit", () => {
    expect(ids(balancedNewest([item("x", "A", 1), item("y", "B", 2)], options(6, 1)))).toEqual(["y", "x"]);
    expect(balancedNewest([], options(6, 1))).toEqual([]);
  });

  it("does not need every group to be there: a group with nothing simply has nothing kept", () => {
    const onlyA = feed.filter(entry => entry.group === "A");
    expect(ids(balancedNewest(onlyA, options(3, 1)))).toEqual(["a0", "a1", "a2"]);
  });

  it("never returns more than the limit, keeping the newest of the kept ones when the floors alone are too many", () => {
    expect(ids(balancedNewest(feed, options(2, 2)))).toEqual(["a0", "a1"]);
    expect(balancedNewest(feed, options(0, 1))).toEqual([]);
    expect(balancedNewest(feed, options(-3, 1))).toEqual([]);
  });

  it("counts a group's newest by the same order it sorts by, and does not change what it was given", () => {
    const given = [item("old", "B", 1), item("new", "B", 9), item("mid", "A", 5)];
    const copy = [...given];
    expect(ids(balancedNewest(given, options(2, 1)))).toEqual(["new", "mid"]);
    expect(given).toEqual(copy);
  });
});
