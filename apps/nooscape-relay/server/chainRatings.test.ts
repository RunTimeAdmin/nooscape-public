import { describe, expect, it } from "vitest";
import { countRatingLogs } from "./chainRatings";
import { ERC8004_REPUTATION_REGISTRY } from "./ingestion/erc8004Chains";
import { ROBINHOOD_FEEDBACK_REVOKED_TOPIC, ROBINHOOD_NEW_FEEDBACK_TOPIC } from "./ingestion/robinhoodReputation";

/**
 * The count of one window's logs (docs/extra-chain-ratings-2026-10-21.md). It counts the registry's two events and nothing else, and a log it did
 * not ask for is a fault in the provider's answer, never a number: a count that is wrong by one is worse than "not measured".
 */
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const log = (block: number, kind: "rating" | "revocation" | string, over: Record<string, unknown> = {}) => ({
  address: ERC8004_REPUTATION_REGISTRY.toLowerCase(),
  topics: [kind === "rating" ? ROBINHOOD_NEW_FEEDBACK_TOPIC : kind === "revocation" ? ROBINHOOD_FEEDBACK_REVOKED_TOPIC : kind, word(1), word(2), word(3)],
  blockNumber: `0x${block.toString(16)}`,
  ...over,
});
const bounds = { fromBlock: 100, toBlock: 199 };
const count = (logs: unknown[]) => countRatingLogs(logs, ERC8004_REPUTATION_REGISTRY, bounds);

describe("countRatingLogs", () => {
  it("counts ratings and revocations apart, and an empty window as zero", () => {
    expect(count([])).toEqual({ ratings: 0, revocations: 0 });
    expect(count([log(100, "rating"), log(150, "rating"), log(199, "revocation"), log(120, "rating")])).toEqual({ ratings: 3, revocations: 1 });
  });

  it("reads the topic and the address in any case, as a node may write them", () => {
    expect(count([log(150, "rating", { address: ERC8004_REPUTATION_REGISTRY.toUpperCase().replace("0X", "0x") }), { ...log(151, "rating"), topics: [ROBINHOOD_NEW_FEEDBACK_TOPIC.toUpperCase().replace("0X", "0x"), word(1), word(2), word(3)] }])).toEqual({ ratings: 2, revocations: 0 });
  });

  it("does not count a log a reorg removed", () => {
    expect(count([log(150, "rating"), log(151, "rating", { removed: true })])).toEqual({ ratings: 1, revocations: 0 });
  });

  it.each([
    ["not an object", "nonsense"],
    ["an array", []],
    ["from another address", log(150, "rating", { address: "0x0000000000000000000000000000000000000001" })],
    ["without an address", log(150, "rating", { address: undefined })],
    ["before the window", log(99, "rating")],
    ["after the window", log(200, "rating")],
    ["without a block", log(150, "rating", { blockNumber: undefined })],
    ["with a block that is not hex", log(150, "rating", { blockNumber: "150" })],
    ["with three topics", log(150, "rating", { topics: [ROBINHOOD_NEW_FEEDBACK_TOPIC, word(1), word(2)] })],
    ["with five topics (a reply)", log(150, "rating", { topics: [ROBINHOOD_NEW_FEEDBACK_TOPIC, word(1), word(2), word(3), word(4)] })],
    ["with no topics", log(150, "rating", { topics: undefined })],
    ["of a kind that was not asked for", log(150, "0x" + "cd".repeat(32))],
  ])("refuses the window when a log is %s", (_label, bad) => {
    expect(() => count([log(120, "rating"), bad])).toThrow();
  });
});
