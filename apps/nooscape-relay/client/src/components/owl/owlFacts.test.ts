import { afterEach, describe, expect, it, vi } from "vitest";
import { getOwlFacts, setOwlFacts, subscribeOwlFacts } from "./owlFacts";
import type { OwlFacts } from "./owlLines";

const facts = (over: Partial<OwlFacts> = {}): OwlFacts => ({ key: "a", tierLabel: "Tier 2", observations: 3, ...over });

afterEach(() => setOwlFacts(null));

describe("what the page tells the owl", () => {
  it("holds one record's facts, and none when the page has none", () => {
    expect(getOwlFacts()).toBeNull();
    const told = facts();
    setOwlFacts(told);
    expect(getOwlFacts()).toBe(told);
    setOwlFacts(null);
    expect(getOwlFacts()).toBeNull();
  });

  it("tells whoever is listening when the facts change, and not when they are told again unchanged", () => {
    const listener = vi.fn();
    const stop = subscribeOwlFacts(listener);
    setOwlFacts(facts());
    expect(listener).toHaveBeenCalledTimes(1);
    setOwlFacts(facts());
    expect(listener).toHaveBeenCalledTimes(1);
    setOwlFacts(facts({ observations: 4 }));
    expect(listener).toHaveBeenCalledTimes(2);
    setOwlFacts(facts({ key: "b", observations: 4 }));
    expect(listener).toHaveBeenCalledTimes(3);
    setOwlFacts(null);
    expect(listener).toHaveBeenCalledTimes(4);
    setOwlFacts(null);
    expect(listener).toHaveBeenCalledTimes(4);
    stop();
  });

  it("notices a fact that is added or taken away, not only one that changes", () => {
    const listener = vi.fn();
    const stop = subscribeOwlFacts(listener);
    setOwlFacts({ key: "a" });
    setOwlFacts({ key: "a", chain: "Solana" });
    setOwlFacts({ key: "a" });
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stops telling a listener that has gone", () => {
    const listener = vi.fn();
    const stop = subscribeOwlFacts(listener);
    stop();
    setOwlFacts(facts());
    expect(listener).not.toHaveBeenCalled();
  });
});
