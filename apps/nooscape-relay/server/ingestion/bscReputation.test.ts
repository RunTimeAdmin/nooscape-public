import { describe, expect, it } from "vitest";
import {
  BSC_REPUTATION_DEPLOY_BLOCK,
  BSC_REPUTATION_IMPL,
  BSC_REPUTATION_REGISTRY,
  BSC_REPUTATION_TOPIC_FILTER,
  implementationOf,
  parseReputationWindow,
} from "./bscReputation";
import {
  ROBINHOOD_FEEDBACK_REVOKED_TOPIC,
  ROBINHOOD_NEW_FEEDBACK_TOPIC,
  ROBINHOOD_REPUTATION_IMPL,
  ROBINHOOD_REPUTATION_REGISTRY,
} from "./robinhoodReputation";
import { BSC_DEPLOY_BLOCK } from "./bscChain";

/**
 * Reading the BNB Chain reputation registry. The three logs are real ones from BNB Chain (fetched with `eth_getLogs` on
 * 2026-10-16): a rating with no strings, a rating with a tag and an endpoint string, and a revocation. The decoded values were
 * also compared with the Robinhood adapter's wire-verified layout, which these logs follow.
 */
const PLAIN = {
  "address": "0x8004baa17c55a88189ae136b182e5fda19de9b63",
  "topics": [
    "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc",
    "0x0000000000000000000000000000000000000000000000000000000000000089",
    "0x000000000000000000000000178393dd0b74af8bcd75d55de12238b673d0ca4e",
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
  ],
  "data": "0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  "blockNumber": "0x4bcb0bc",
  "transactionHash": "0x13fec17b7aa60aeed8bd931519d02ef918cd6ac28c22847767ce417575d00f90",
  "transactionIndex": "0x4a",
  "blockHash": "0x8b4793319412d2583e0d3891ffc64531a409fd189a02909ee7ea2435448fb46b",
  "blockTimestamp": "0x6984c685",
  "logIndex": "0xf4",
  "removed": false
};
const LIVENESS = {
  "address": "0x8004baa17c55a88189ae136b182e5fda19de9b63",
  "topics": [
    "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc",
    "0x000000000000000000000000000000000000000000000000000000000000017d",
    "0x000000000000000000000000809d59b1dc5f7f03aa2f5f02e9679d7f66b4c7c7",
    "0xf32a9c3077a9b8e2ccb97670cf9722e808c2460acba29dc22f29ebc72c4604f1"
  ],
  "data": "0x00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000002205a46dbda6c30554b4d7dd9c43f29a837b3891e3cdf58fb291afd94196f59e66200000000000000000000000000000000000000000000000000000000000000086c6976656e657373000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e6c6976656e6573732d636865636b00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000644c6976656e6573733a20726561636861626c653d547275652c20656e64706f696e743d68747470733a2f2f6d61726b6574706c6163652e6f6c61732e6e6574776f726b2f657263383030342f6f702d6d61696e6e65742f61692d6167656e74732f313232000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  "blockNumber": "0x533fbf8",
  "transactionHash": "0xa33d4097db53fc8a767344328c6573f2f07c6cda106d04216b12df06b8671a80",
  "transactionIndex": "0x38",
  "blockHash": "0x3fab7d7065119eaa7b2ecb6bd928ace1d43329f3b84dc0039988b733723e9490",
  "blockTimestamp": "0x69ba80a7",
  "logIndex": "0x110",
  "removed": false
};
const REVOKED = {
  "address": "0x8004baa17c55a88189ae136b182e5fda19de9b63",
  "topics": [
    "0x25156fd3288212246d8b008d5921fde376c71ed14ac2e072a506eb06fde6d09d",
    "0x0000000000000000000000000000000000000000000000000000000000049cb2",
    "0x000000000000000000000000bfb4b49787ce948c1ee304f6c197a0e8b038ddb2",
    "0x0000000000000000000000000000000000000000000000000000000000000001"
  ],
  "data": "0x",
  "blockNumber": "0x79b8dea",
  "transactionHash": "0x478a2ca07050415703b86474c86c12173e41cba02485a743f9e7d223928f8fc7",
  "transactionIndex": "0x21",
  "blockHash": "0x5c9406d97cf73b2e7162f227bed86c4dfc1fcf826d51bb69092f380df8d59f4e",
  "blockTimestamp": "0x6acfbc2a",
  "logIndex": "0xc6",
  "removed": false
};

describe("the registry and its implementation", () => {
  it("is the standard reputation address behind the implementation the layouts were verified against, the same as on Robinhood Chain", () => {
    expect(BSC_REPUTATION_REGISTRY).toBe(ROBINHOOD_REPUTATION_REGISTRY);
    expect(BSC_REPUTATION_REGISTRY).toBe("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63");
    expect(BSC_REPUTATION_IMPL).toBe(ROBINHOOD_REPUTATION_IMPL);
    expect(BSC_REPUTATION_IMPL).toBe("0x16e0fa7f7c56b9a767e34b192b51f921be31da34");
  });

  it("starts at the block where the registry got its code, five after the identity registry", () => {
    expect(BSC_REPUTATION_DEPLOY_BLOCK).toBe(79_027_273);
    expect(BSC_REPUTATION_DEPLOY_BLOCK - BSC_DEPLOY_BLOCK).toBe(5);
  });

  it("asks for the two event kinds only, as one OR list", () => {
    expect(BSC_REPUTATION_TOPIC_FILTER).toEqual([[ROBINHOOD_NEW_FEEDBACK_TOPIC, ROBINHOOD_FEEDBACK_REVOKED_TOPIC]]);
  });

  it("reads the address an implementation slot names, and nothing else", () => {
    expect(implementationOf("0x00000000000000000000000016e0fa7f7c56b9a767e34b192b51f921be31da34")).toBe(BSC_REPUTATION_IMPL);
    expect(implementationOf("0x00000000000000000000000016E0FA7F7C56B9A767E34B192B51F921BE31DA34")).toBe(BSC_REPUTATION_IMPL);
    expect(implementationOf("0x1234")).toBeNull();
    expect(implementationOf(null)).toBeNull();
  });
});

describe("a window of logs", () => {
  const bounds = { fromBlock: 79_000_000, toBlock: 128_000_000 };

  it("decodes real ratings and a real revocation into ledger rows, in chain order", () => {
    const { rows, rejected } = parseReputationWindow([REVOKED, LIVENESS, PLAIN], bounds);
    expect(rejected).toBe(0);
    expect(rows.map(row => [row.kind, row.agentId, row.blockNumber])).toEqual([
      ["feedback", 137, 79_474_876],
      ["feedback", 381, 87_292_920],
      ["revoked", 302_258, 127_634_922],
    ]);
    expect(rows[0]).toMatchObject({ client: "0x178393dd0b74af8bcd75d55de12238b673d0ca4e", feedbackIndex: 1, valueRaw: "100", valueDecimals: 0, transactionHash: "0x13fec17b7aa60aeed8bd931519d02ef918cd6ac28c22847767ce417575d00f90" });
    expect(rows[1]).toMatchObject({ client: "0x809d59b1dc5f7f03aa2f5f02e9679d7f66b4c7c7", valueRaw: "100" });
    expect(rows[2]).toMatchObject({ client: "0xbfb4b49787ce948c1ee304f6c197a0e8b038ddb2", feedbackIndex: 1, valueRaw: null, valueDecimals: null });
  });

  it("counts a log it cannot decode as rejected instead of skipping it, so the run can stop there", () => {
    const wrongAddress = { ...PLAIN, address: "0x0000000000000000000000000000000000000001" };
    const wrongTopic = { ...PLAIN, topics: ["0x" + "11".repeat(32), ...PLAIN.topics.slice(1)] };
    const cutData = { ...PLAIN, data: PLAIN.data.slice(0, 200) };
    const outside = { ...PLAIN, blockNumber: "0x1" };
    expect(parseReputationWindow([wrongAddress, wrongTopic, cutData, outside, PLAIN], bounds)).toMatchObject({ rejected: 4, rows: [{ agentId: 137 }] });
  });

  it("refuses an answer that is not a list", () => {
    expect(() => parseReputationWindow({}, bounds)).toThrow(/must be an array/);
    expect(parseReputationWindow([], bounds)).toEqual({ rows: [], rejected: 0 });
  });
});
