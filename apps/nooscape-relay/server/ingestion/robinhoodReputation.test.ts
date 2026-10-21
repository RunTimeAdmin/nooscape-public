import { describe, expect, it } from "vitest";
import { RobinhoodRegistryValidationError } from "./robinhood";
import {
  MAX_REPUTATION_STRING_CHARS,
  ROBINHOOD_FEEDBACK_REVOKED_TOPIC,
  ROBINHOOD_NEW_FEEDBACK_TOPIC,
  ROBINHOOD_REPUTATION_IMPL,
  ROBINHOOD_REPUTATION_IMPL_SLOT,
  ROBINHOOD_REPUTATION_REGISTRY,
  ROBINHOOD_RESPONSE_APPENDED_TOPIC,
  RobinhoodReputationUnknownEventError,
  decodeFeedbackRevokedLog,
  decodeNewFeedbackLog,
  decodeResponseAppendedLog,
  parseRobinhoodReputationCursor,
  parseRobinhoodReputationLogs,
  robinhoodReputationBackwardCursorAfter,
} from "./robinhoodReputation";

const BOUNDS = { fromBlock: 83_000_000, toBlock: 85_500_000 };
const CLIENT = "0x03af41aeb1eea4da0572bbb6ab1b4c5331f17ac7";
const REVOKED_CLIENT = "0x613854463bb854225306b9b18bdb451a78430a73";
const TAG_HASH = "0x5c6b6f864b66974aa4cd2664138bc11735baac37f8c8ae4ac2334fe4dba474ac";

function padWord(hex: string) {
  return `0x${hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

function uintWord(value: number | bigint) {
  return BigInt(value).toString(16).padStart(64, "0");
}

/** Two's-complement int128 data word for a signed value. */
function int128Word(value: bigint) {
  const modulus = BigInt(1) << BigInt(128);
  return (value < BigInt(0) ? value + modulus : value).toString(16).padStart(64, "0");
}

/**
 * Canonical ABI blob for the wire-verified NewFeedback data layout: head
 * [feedbackIndex, int128 value, uint8 decimals, 4 string offsets, bytes32
 * feedbackHash] followed by the four string bodies.
 */
function buildNewFeedbackData(input: {
  feedbackIndex: number;
  value?: bigint;
  decimals?: number;
  strings: [string, string, string, string];
  feedbackHash?: string;
}) {
  const encoded = input.strings.map(value => {
    const bytes = Buffer.from(value, "utf8");
    const length = bytes.length.toString(16).padStart(64, "0");
    const body = bytes.toString("hex").padEnd(Math.max(64, Math.ceil(bytes.length / 32) * 64), "0");
    return `${length}${body}`;
  });
  let offset = 256;
  const offsets = encoded.map(chunk => {
    const at = offset;
    offset += chunk.length / 2;
    return at.toString(16).padStart(64, "0");
  });
  const head = [
    uintWord(input.feedbackIndex),
    int128Word(input.value ?? BigInt(1)),
    uintWord(input.decimals ?? 0),
    ...offsets,
    // The default carries the 0x prefix so the unconditional slice(2) below
    // leaves a full 32-byte word (an unprefixed default would shear two hex
    // digits off and make the data length non-word-aligned).
    (input.feedbackHash ?? `0x${"ab".repeat(32)}`).slice(2),
  ];
  return `0x${head.join("")}${encoded.join("")}`;
}

function buildNewFeedbackLog(input: {
  agentId: number;
  client?: string;
  feedbackIndex: number;
  value?: bigint;
  decimals?: number;
  strings?: [string, string, string, string];
  feedbackHash?: string;
  block?: number;
  logIndex?: number;
  data?: string;
  address?: string;
}) {
  return {
    address: input.address ?? ROBINHOOD_REPUTATION_REGISTRY,
    topics: [
      ROBINHOOD_NEW_FEEDBACK_TOPIC,
      padWord(`0x${input.agentId.toString(16)}`),
      padWord(input.client ?? CLIENT),
      TAG_HASH,
    ],
    data:
      input.data ??
      buildNewFeedbackData({
        feedbackIndex: input.feedbackIndex,
        value: input.value,
        decimals: input.decimals,
        strings: input.strings ?? ["credit.statement", "unsecured", "", "data:application/json;base64,eyJhZ2VudElkIjoiODY1MyJ9"],
        feedbackHash: input.feedbackHash,
      }),
    blockNumber: `0x${(input.block ?? 85_182_162).toString(16)}`,
    transactionHash: `0x${"b0".repeat(32)}`,
    logIndex: `0x${(input.logIndex ?? 0).toString(16)}`,
    removed: false,
  };
}

function buildRevokedLog(input: { agentId: number; client?: string; feedbackIndex: number; block?: number; logIndex?: number; address?: string }) {
  return {
    address: input.address ?? ROBINHOOD_REPUTATION_REGISTRY,
    topics: [
      ROBINHOOD_FEEDBACK_REVOKED_TOPIC,
      padWord(`0x${input.agentId.toString(16)}`),
      padWord(input.client ?? REVOKED_CLIENT),
      padWord(`0x${input.feedbackIndex.toString(16)}`),
    ],
    data: "0x",
    // The wire sample sat at block 80,992,193 — below this file's fixture
    // BOUNDS (83M+), so fixtures default inside the window instead.
    blockNumber: `0x${(input.block ?? 85_000_000).toString(16)}`,
    transactionHash: `0x${"8c".repeat(32)}`,
    logIndex: `0x${(input.logIndex ?? 10).toString(16)}`,
    removed: false,
  };
}

describe("Robinhood ERC-8004 reputation registry adapter", () => {
  it("pins the wire-verified registry, implementation-slot, and topic constants", () => {
    // Checksummed casing matches the identity adapter's registry constant
    // convention; every adapter comparison lowercases both sides.
    expect(ROBINHOOD_REPUTATION_REGISTRY).toBe("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63");
    expect(ROBINHOOD_REPUTATION_IMPL).toBe("0x16e0fa7f7c56b9a767e34b192b51f921be31da34");
    expect(ROBINHOOD_REPUTATION_IMPL_SLOT).toBe("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
    expect(ROBINHOOD_NEW_FEEDBACK_TOPIC).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ROBINHOOD_FEEDBACK_REVOKED_TOPIC).toMatch(/^0x[0-9a-f]{64}$/);
    // The reply topic is pinned to its exact hash: unlike the two live-read
    // topics above, it was verified from two signature databases before any
    // real event existed, so the constant itself is the record.
    expect(ROBINHOOD_RESPONSE_APPENDED_TOPIC).toBe(
      "0xb1c6be0b5b8aef6539e2fac0fd131a2faa7b49edf8e505b5eb0ad487d56051d4"
    );
  });

  it("decodes a live-shaped NewFeedback with the emitted feedback index and raw score", () => {
    // Head words verified on-chain 2026-10-11 (agent 8653, client 0x03af…7ac7):
    // [index=1, value=0, decimals=6, offsets 256/320/384/416, hash 0xece2fcbe…].
    const event = decodeNewFeedbackLog(
      buildNewFeedbackLog({
        agentId: 8653,
        feedbackIndex: 1,
        value: BigInt(0),
        decimals: 6,
        feedbackHash: `0x${"ec".repeat(1)}e2fcbee10b0f10533aae136eaca625fd5701dc062b191f8140776e006e9af8`.slice(0, 66),
      }),
      BOUNDS
    );

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("new_feedback");
    expect(event?.agentId).toBe("8653");
    expect(event?.clientAddress).toBe(CLIENT);
    expect(event?.feedbackIndex).toBe(1);
    expect(event?.valueRaw).toBe("0");
    expect(event?.valueDecimals).toBe(6);
    expect(event?.tag1).toBe("credit.statement");
    expect(event?.tag2).toBe("unsecured");
    expect(event?.endpoint).toBe("");
    expect(event?.feedbackUri).toBe("data:application/json;base64,eyJhZ2VudElkIjoiODY1MyJ9");
    expect(event?.feedbackHash).toBe("0xece2fcbee10b0f10533aae136eaca625fd5701dc062b191f8140776e006e9af8");
    expect(event?.responderAddress).toBeNull();
  });

  it("decodes a negative int128 score exactly, never as a float", () => {
    const event = decodeNewFeedbackLog(buildNewFeedbackLog({ agentId: 1, feedbackIndex: 2, value: BigInt(-5) }), BOUNDS);
    expect(event?.valueRaw).toBe("-5");
    expect(event?.feedbackIndex).toBe(2);
  });

  it("caps untrusted strings at 512 characters with an explicit truncation marker", () => {
    const longUri = `data:application/json;base64,${"A".repeat(600)}`;
    const event = decodeNewFeedbackLog(
      buildNewFeedbackLog({ agentId: 2, feedbackIndex: 1, strings: ["t1", "t2", "", longUri] }),
      BOUNDS
    );
    expect(event?.feedbackUri).toHaveLength(MAX_REPUTATION_STRING_CHARS);
    expect(event?.feedbackUri?.endsWith("[truncated]")).toBe(true);
    expect(event?.tag1).toBe("t1");
  });

  it("decodes the wire-verified FeedbackRevoked shape (index in topics, empty data)", () => {
    const event = decodeFeedbackRevokedLog(buildRevokedLog({ agentId: 462, feedbackIndex: 1 }), BOUNDS);
    expect(event).not.toBeNull();
    expect(event?.kind).toBe("feedback_revoked");
    expect(event?.agentId).toBe("462");
    expect(event?.clientAddress).toBe(REVOKED_CLIENT);
    expect(event?.feedbackIndex).toBe(1);
    expect(event?.valueRaw).toBeNull();
    expect(event?.feedbackHash).toBeNull();
  });

  it("decodes the EIP-documented ResponseAppended shape now that its topic is whitelisted", () => {
    const log = {
      address: ROBINHOOD_REPUTATION_REGISTRY,
      topics: [
        ROBINHOOD_RESPONSE_APPENDED_TOPIC,
        padWord("0x1d8a"),
        padWord(CLIENT),
        padWord("0x3"),
        padWord("0x5544332211ffeeddccbbaa998877665544332211"),
      ],
      data: "0x",
      blockNumber: `0x${(85_000_000).toString(16)}`,
      transactionHash: `0x${"aa".repeat(32)}`,
      logIndex: "0x1",
      removed: false,
    };
    const event = decodeResponseAppendedLog(log, BOUNDS);
    expect(event?.kind).toBe("response_appended");
    expect(event?.agentId).toBe("7562");
    expect(event?.feedbackIndex).toBe(3);
    expect(event?.responderAddress).toBe("0x5544332211ffeeddccbbaa998877665544332211");
  });

  it("acknowledges every decodable event in a bounded window parse", () => {
    const result = parseRobinhoodReputationLogs(
      [buildNewFeedbackLog({ agentId: 8653, feedbackIndex: 1 }), buildRevokedLog({ agentId: 462, feedbackIndex: 1 })],
      BOUNDS
    );
    expect(result.discoveredCount).toBe(2);
    expect(result.rejectedCount).toBe(0);
    expect(result.events).toHaveLength(2);
    expect(result.events.map(event => event.kind)).toEqual(["new_feedback", "feedback_revoked"]);
  });

  it("throws the unknown-event tripwire on any unverified proxy topic", () => {
    const stranger = {
      address: ROBINHOOD_REPUTATION_REGISTRY,
      topics: [padWord("0xdeadbeef"), padWord("0x1"), padWord(CLIENT), padWord("0x1")],
      data: "0x",
      blockNumber: `0x${(85_000_000).toString(16)}`,
      transactionHash: `0x${"dd".repeat(32)}`,
      logIndex: "0x0",
      removed: false,
    };
    expect(() => parseRobinhoodReputationLogs([stranger], BOUNDS)).toThrow(RobinhoodReputationUnknownEventError);
    try {
      parseRobinhoodReputationLogs([stranger], BOUNDS);
    } catch (error) {
      const tripwire = error as RobinhoodReputationUnknownEventError;
      expect(tripwire.topic0).toBe(padWord("0xdeadbeef"));
      expect(tripwire.blockNumber).toBe(85_000_000);
      // ResponseAppended is whitelisted now, so the message no longer names
      // it — the instruction it gives instead is the whitelist-verification
      // procedure itself.
      expect(tripwire.message).toContain("whitelist the verified topic");
    }
  });

  it("skips proxy lifecycle topics swept up by the address-only fetch", () => {
    // The proxy's birth (block 12,058,837, tx 0x76b048b3…36af: Upgraded to
    // 0xcb7af40c…f067, constructor OwnershipTransferred zero→0x547289…2603,
    // Initialized) and upgrade #1 (block 30,786,790, tx 0x1ad2c9bd…7c5). All
    // are recognized-and-skipped, never fatal.
    const upgraded = {
      address: ROBINHOOD_REPUTATION_REGISTRY,
      topics: [
        "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b",
        padWord("0xcb7af40c0be4fb92e183942b6dbb6b14a888f067"),
      ],
      data: "0x",
      blockNumber: `0x${(12_058_837).toString(16)}`,
      transactionHash: "0x76b048b37514932c9db2de6aa07de4019458fbb12ca0414db4a0367ef02b36af",
      logIndex: "0x0",
      removed: false,
    };
    const ownershipTransferred = {
      address: ROBINHOOD_REPUTATION_REGISTRY,
      topics: [
        "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
        padWord("0x0000000000000000000000000000000000000000"),
        padWord("0x547289319c3e6aedb179c0b8e8af0b5acd062603"),
      ],
      data: "0x",
      blockNumber: `0x${(12_058_837).toString(16)}`,
      transactionHash: "0x76b048b37514932c9db2de6aa07de4019458fbb12ca0414db4a0367ef02b36af",
      logIndex: "0x1",
      removed: false,
    };
    const initialized = {
      address: ROBINHOOD_REPUTATION_REGISTRY,
      topics: ["0xc7f505b2f371ae2175ee4913f4499e1f2633a7b5936321eed1cdaeb6115181d2"],
      data: `0x${(1).toString(16).padStart(64, "0")}`,
      blockNumber: `0x${(12_058_837).toString(16)}`,
      transactionHash: "0x76b048b37514932c9db2de6aa07de4019458fbb12ca0414db4a0367ef02b36af",
      logIndex: "0x2",
      removed: false,
    };
    const result = parseRobinhoodReputationLogs(
      [upgraded, ownershipTransferred, initialized, buildNewFeedbackLog({ agentId: 8653, feedbackIndex: 1 })],
      BOUNDS
    );
    expect(result.discoveredCount).toBe(4);
    expect(result.rejectedCount).toBe(3);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("new_feedback");
  });

  it("ingests a first ResponseAppended reply without halting the ratings walk", () => {
    // The stale-import scenario the operator flagged: before this topic was
    // whitelisted, the first reply to any rating would have tripped the
    // unknown-event guard and stopped the walk. Now the reply ingests as a
    // ledger row and the window keeps going.
    const reply = {
      address: ROBINHOOD_REPUTATION_REGISTRY,
      topics: [
        ROBINHOOD_RESPONSE_APPENDED_TOPIC,
        padWord(`0x${(8653).toString(16)}`),
        padWord(CLIENT),
        padWord("0x1"),
        padWord("0x9d7f4b2f2e0aa2cb4d4ba3b5fe8f5c4a2b9c0e11"),
      ],
      data: "0x",
      blockNumber: `0x${(85_100_000).toString(16)}`,
      transactionHash: `0x${"cc".repeat(32)}`,
      logIndex: "0x5",
      removed: false,
    };
    const result = parseRobinhoodReputationLogs(
      [buildNewFeedbackLog({ agentId: 8653, feedbackIndex: 1 }), reply],
      BOUNDS
    );
    expect(result.discoveredCount).toBe(2);
    expect(result.rejectedCount).toBe(0);
    expect(result.events.map(event => event.kind)).toEqual(["new_feedback", "response_appended"]);
    expect(result.events[1]?.feedbackIndex).toBe(1);
    expect(result.events[1]?.clientAddress).toBe(CLIENT);
    expect(result.events[1]?.responderAddress).toBe("0x9d7f4b2f2e0aa2cb4d4ba3b5fe8f5c4a2b9c0e11");
  });

  it("counts a reorged-out unknown-topic row as rejected instead of tripping", () => {
    const removed = {
      address: ROBINHOOD_REPUTATION_REGISTRY,
      topics: [padWord("0xdeadbeef")],
      data: "0x",
      blockNumber: `0x${(85_000_000).toString(16)}`,
      transactionHash: `0x${"dd".repeat(32)}`,
      logIndex: "0x0",
      removed: true,
    };
    const result = parseRobinhoodReputationLogs([removed], BOUNDS);
    expect(result.discoveredCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
    expect(result.events).toHaveLength(0);
  });

  it("rejects out-of-bounds, foreign, and malformed logs by count without failing the window", () => {
    const logs = [
      buildNewFeedbackLog({ agentId: 1, feedbackIndex: 1, block: 82_999_999 }), // below bounds
      buildNewFeedbackLog({ agentId: 1, feedbackIndex: 1, address: "0x1111111111111111111111111111111111111111" }), // wrong contract
      buildNewFeedbackLog({ agentId: 1, feedbackIndex: 1, data: "0x" }), // no data words
      buildNewFeedbackLog({ agentId: 1, feedbackIndex: 1, decimals: 256 }), // decimals out of uint8
      buildNewFeedbackLog({
        // feedbackIndex is unused here (data is given explicitly); the data
        // head below carries an index beyond the safe-integer range — still
        // under uint64 — which cannot be stored exactly and is rejected.
        agentId: 1,
        feedbackIndex: 1,
        strings: ["a", "b", "c", "d"],
        data: `0x${[
          uintWord(BigInt("0x20000000000001")),
          int128Word(BigInt(1)),
          uintWord(0),
          uintWord(256),
          uintWord(320),
          uintWord(384),
          uintWord(416),
          "ab".repeat(32),
          ...["a", "b", "c", "d"].map(value => {
            const bytes = Buffer.from(value, "utf8");
            return `${bytes.length.toString(16).padStart(64, "0")}${bytes.toString("hex").padEnd(64, "0")}`;
          }),
        ].join("")}`,
      }),
    ];
    const result = parseRobinhoodReputationLogs(logs, BOUNDS);
    expect(result.discoveredCount).toBe(5);
    expect(result.rejectedCount).toBe(5);
    expect(result.events).toHaveLength(0);
  });

  it("rejects a NewFeedback whose string offsets are not canonical", () => {
    const malformed = `0x${[
      uintWord(1),
      int128Word(BigInt(1)),
      uintWord(0),
      uintWord(100), // not word-aligned
      uintWord(320),
      uintWord(384),
      uintWord(416),
      "ab".repeat(32),
    ].join("")}`;
    const event = decodeNewFeedbackLog(buildNewFeedbackLog({ agentId: 1, feedbackIndex: 1, data: malformed }), BOUNDS);
    expect(event).toBeNull();
  });

  it("rejects a NewFeedback whose offsets point past the data blob", () => {
    const malformed = `0x${[
      uintWord(1),
      int128Word(BigInt(1)),
      uintWord(0),
      uintWord(256),
      uintWord(320),
      uintWord(384),
      uintWord(416),
      "ab".repeat(32),
    ].join("")}`; // head only: offsets point into the empty tail
    const event = decodeNewFeedbackLog(buildNewFeedbackLog({ agentId: 1, feedbackIndex: 1, data: malformed }), BOUNDS);
    expect(event).toBeNull();
  });

  it("enforces the bounded scan limit on window parses", () => {
    const logs = [
      buildNewFeedbackLog({ agentId: 1, feedbackIndex: 1 }),
      buildNewFeedbackLog({ agentId: 2, feedbackIndex: 1 }),
      buildNewFeedbackLog({ agentId: 3, feedbackIndex: 1 }),
    ];
    expect(() => parseRobinhoodReputationLogs(logs, BOUNDS, { eventLimit: 2 })).toThrow(RobinhoodRegistryValidationError);
  });

  it("parses only the approved reputation cursor positions", () => {
    expect(parseRobinhoodReputationCursor(null)).toEqual({ mode: "backward-seed" });
    expect(parseRobinhoodReputationCursor("  ")).toEqual({ mode: "backward-seed" });
    expect(parseRobinhoodReputationCursor("rb:84999999")).toEqual({ mode: "backward", toBlock: 84_999_999 });
    expect(parseRobinhoodReputationCursor("rb:done")).toEqual({ mode: "forward-seed" });
    // The forward anchor hash is stored 0x-prefixed and lowercased, matching
    // the identity adapter's fw: cursor format exactly.
    expect(parseRobinhoodReputationCursor(`fw:85000000#0x${"0a".repeat(32)}`)).toEqual({
      mode: "forward",
      block: 85_000_000,
      blockHash: `0x${"0a".repeat(32)}`,
    });
    expect(() => parseRobinhoodReputationCursor("ac:done")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodReputationCursor("bf:84999999")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodReputationCursor("rb:0")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodReputationCursor("walk-faster")).toThrow(RobinhoodRegistryValidationError);
  });

  it("advances the backward cursor one tiled window and reaches rb:done at genesis", () => {
    expect(robinhoodReputationBackwardCursorAfter(83_000_001)).toBe("rb:83000000");
    expect(robinhoodReputationBackwardCursorAfter(1)).toBe("rb:done");
  });
});
