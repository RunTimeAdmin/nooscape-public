import { describe, expect, it } from "vitest";
import { agentIdOfKey, NAME_CHAINS, newestKeyFirst, usableName } from "./chainNamesCore";
import { directoryDraft } from "./ingestion/erc8004Chain";
import { ARC_CHAIN, BASE_CHAIN, BSC_CHAIN, ETHEREUM_CHAIN } from "./ingestion/erc8004Chains";
import { ENTRY_PLACEHOLDER_PATTERN } from "./robinhoodNamesCore";

/**
 * The pure rules of the Base, Arc and Ethereum name step (docs/approvals/2026-10-26-base-arc-names.md): which chains it names, how it reads the
 * agent id out of a directory key, which registration it takes first, and which names it will not show. The step itself is held by
 * chainNames.integration.test.ts and the chain read by chainNamesRead.test.ts.
 */
const registration = (agentId: string) => ({ agentId, owner: "0x00000000000000000000000000000000000000aa", uri: "ipfs://x", blockNumber: 1, transactionHash: "0x", logIndex: 0 });

describe("the chains the step names", () => {
  it("are Base, Arc and Ethereum, in that order, and neither Robinhood Chain nor BNB Chain, whose reads keep their own rules", () => {
    expect(NAME_CHAINS.map(chain => chain.chainKey)).toEqual(["base", "arc", "ethereum"]);
    expect(NAME_CHAINS).toContain(BASE_CHAIN);
    expect(NAME_CHAINS).toContain(ARC_CHAIN);
    expect(NAME_CHAINS).toContain(ETHEREUM_CHAIN);
    expect(NAME_CHAINS).not.toContain(BSC_CHAIN);
  });

  it("each have a switch, so a chain that is off is never read", () => {
    for (const chain of NAME_CHAINS) expect(chain.feature, chain.chainKey).not.toBeNull();
  });
});

describe("the agent id of a directory key", () => {
  it("is read from the keys the chain pass makes, on each chain", () => {
    for (const chain of NAME_CHAINS) {
      const draft = directoryDraft(chain, registration("1135673"));
      expect(agentIdOfKey(chain, draft.externalKey), chain.chainKey).toBe("1135673");
    }
  });

  it("is not read from another chain's key, another registry's key, or a key that is not an id", () => {
    const base = directoryDraft(BASE_CHAIN, registration("77")).externalKey;
    expect(agentIdOfKey(ARC_CHAIN, base)).toBeNull();
    expect(agentIdOfKey(BASE_CHAIN, base.replace("0x8004A169", "0x8004B000"))).toBeNull();
    expect(agentIdOfKey(BASE_CHAIN, `${base}x`)).toBeNull();
    expect(agentIdOfKey(BASE_CHAIN, base.slice(0, -2))).toBeNull();
    expect(agentIdOfKey(BASE_CHAIN, "")).toBeNull();
    // An id of 19 digits is longer than any a chain has.
    expect(agentIdOfKey(BASE_CHAIN, `${base.slice(0, -2)}${"9".repeat(19)}`)).toBeNull();
  });
});

describe("newest key first", () => {
  it("puts the highest agent id first by its number and not by its letters", () => {
    const keys = ["a:9", "a:100", "a:10", "a:2", "a:1135673"];
    expect([...keys].sort(newestKeyFirst)).toEqual(["a:1135673", "a:100", "a:10", "a:9", "a:2"]);
  });

  it("keeps two equal ids where they are", () => {
    expect(newestKeyFirst("a:5", "b:5")).toBe(0);
  });
});

describe("the name to show", () => {
  it("is the name a file gave, cleaned and cut to the width the page shows", () => {
    expect(usableName("  Clawdia  ")).toBe("Clawdia");
    expect(usableName("Two   spaces")).toBe("Two spaces");
    expect(usableName("x".repeat(500))).toBe("x".repeat(120));
    // Invisible and control characters go, and a name made only of them is no name.
    expect(usableName(`A${String.fromCharCode(0x200b)}B${String.fromCharCode(7)}C`)).toBe("AB C");
    expect(usableName(` ${String.fromCharCode(0x200b)}${String.fromCharCode(7)} `)).toBeNull();
    expect(usableName("")).toBeNull();
  });

  it("is none for a name that is only a number, because the listing rules hold such a registration out", () => {
    expect(usableName("12345")).toBeNull();
    expect(usableName("0")).toBeNull();
    expect(usableName("Agent 12345")).toBe("Agent 12345");
    expect(usableName("2026 Bot")).toBe("2026 Bot");
  });

  it("is none for a name that reads like the placeholder, which would leave the entry looking unnamed", () => {
    expect(new RegExp(ENTRY_PLACEHOLDER_PATTERN).test("Agent #77")).toBe(true);
    expect(usableName("Agent #77")).toBeNull();
    expect(usableName(" Agent #77 ")).toBeNull();
    expect(usableName("Agent #77 Pro")).toBe("Agent #77 Pro");
    // The database matches the placeholder without regard to case, so a name in other letters is the placeholder to it.
    expect(usableName("agent #77")).toBeNull();
    expect(usableName("AGENT #77")).toBeNull();
  });
});
