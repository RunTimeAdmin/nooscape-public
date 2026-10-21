import { describe, expect, it } from "vitest";
import {
  ROBINHOOD_FORWARD_FINALITY_MARGIN_BLOCKS,
  ROBINHOOD_FORWARD_WINDOW_BLOCKS,
  ROBINHOOD_IDENTITY_REGISTRY,
  ROBINHOOD_MAX_BACKFILL_EVENTS,
  ROBINHOOD_MAX_BACKFILL_SUBWINDOW_EVENTS,
  ROBINHOOD_REGISTERED_TOPIC,
  ROBINHOOD_TRANSFER_TOPIC,
  ROBINHOOD_URI_UPDATED_TOPIC,
  ROBINHOOD_ZERO_ADDRESS,
  RobinhoodRegistryValidationError,
  decodeAbiString,
  decodeTransferActivityLog,
  decodeUriUpdatedActivityLog,
  parseRobinhoodActivityCursor,
  parseRobinhoodActivityLogs,
  parseRobinhoodBackfillCursor,
  parseRobinhoodForwardCursor,
  parseRobinhoodRegistrantCursor,
  parseRobinhoodRegisteredLogs,
  robinhoodActivityCursorAfter,
  robinhoodBackfillCursorAfter,
  robinhoodForwardCursorAfter,
  robinhoodForwardWindowBounds,
  robinhoodRegistrantCursorAfter,
  splitBackfillWindow,
  splitForwardWindow,
} from "./robinhood";

const BOUNDS = { fromBlock: 83_000_000, toBlock: 83_500_000 };

function encodeString(value: string) {
  const bytes = Buffer.from(value, "utf8");
  const length = bytes.length.toString(16).padStart(64, "0");
  const body = bytes.toString("hex").padEnd(Math.max(64, Math.ceil(bytes.length / 32) * 64), "0");
  return `0x${"20".padStart(64, "0")}${length}${body}`;
}

function padWord(hex: string) {
  return `0x${hex.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

function buildLog(input: { agentId: number; owner?: string; uri: string; block?: number; logIndex?: number; topic?: string }) {
  return {
    address: ROBINHOOD_IDENTITY_REGISTRY,
    topics: [
      input.topic ?? ROBINHOOD_REGISTERED_TOPIC,
      padWord(`0x${input.agentId.toString(16)}`),
      padWord(input.owner ?? "0x2b5b35ac5a2d5c1224337ba86bf3816abee69da3"),
    ],
    data: encodeString(input.uri),
    blockNumber: `0x${(input.block ?? 83_100_000).toString(16)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex: `0x${(input.logIndex ?? 0).toString(16)}`,
    removed: false,
  };
}

function buildTransferLog(input: { tokenId: number; from?: string; to?: string; block?: number; logIndex?: number; topic?: string }) {
  return {
    address: ROBINHOOD_IDENTITY_REGISTRY,
    topics: [
      input.topic ?? ROBINHOOD_TRANSFER_TOPIC,
      padWord(input.from ?? ROBINHOOD_ZERO_ADDRESS),
      padWord(input.to ?? "0x2b5b35ac5a2d5c1224337ba86bf3816abee69da3"),
      padWord(`0x${input.tokenId.toString(16)}`),
    ],
    data: "0x",
    blockNumber: `0x${(input.block ?? 83_100_000).toString(16)}`,
    transactionHash: `0x${"cd".repeat(32)}`,
    logIndex: `0x${(input.logIndex ?? 0).toString(16)}`,
    removed: false,
  };
}

function buildUriUpdatedLog(input: { agentId: number; updatedBy?: string; block?: number; logIndex?: number; topic?: string }) {
  return {
    address: ROBINHOOD_IDENTITY_REGISTRY,
    topics: [
      input.topic ?? ROBINHOOD_URI_UPDATED_TOPIC,
      padWord(`0x${input.agentId.toString(16)}`),
      padWord(input.updatedBy ?? "0x2b5b35ac5a2d5c1224337ba86bf3816abee69da3"),
    ],
    data: encodeString("https://updated.example/agent.json"),
    blockNumber: `0x${(input.block ?? 83_100_000).toString(16)}`,
    transactionHash: `0x${"ef".repeat(32)}`,
    logIndex: `0x${(input.logIndex ?? 0).toString(16)}`,
    removed: false,
  };
}

describe("Robinhood ERC-8004 identity registry adapter", () => {
  it("accepts only the newest 24 of a bounded window", () => {
    const logs = Array.from({ length: 30 }, (_, index) =>
      buildLog({ agentId: index + 1, uri: "", block: 83_100_000 + index, logIndex: index })
    );
    const result = parseRobinhoodRegisteredLogs(logs, BOUNDS);

    expect(result.discoveredCount).toBe(30);
    expect(result.rejectedCount).toBe(6);
    expect(result.entries).toHaveLength(24);
    expect(result.entries[0]?.candidate.externalId).toBe(`eip155:4663:${ROBINHOOD_IDENTITY_REGISTRY}:30`);
    expect(result.entries[0]?.candidate.agentUri).toBeNull();
    expect(result.entries[0]?.candidate.uriKind).toBe("empty");
    expect(result.entries[0]?.candidate.sourceSignals.join(" ")).toContain("No URI was set at registration.");
  });

  it("decodes a self-asserted name from URL-encoded inline JSON without network access", () => {
    const logs = [
      buildLog({
        agentId: 8589,
        uri: "data:application/json,%7B%22name%22%3A%22Gand%20OS%20Funding%22%2C%22role%22%3A%22agent%22%7D",
      }),
    ];
    const result = parseRobinhoodRegisteredLogs(logs, BOUNDS);
    const candidate = result.entries[0]?.candidate;

    expect(candidate?.displayName).toBe("Gand OS Funding");
    expect(candidate?.uriKind).toBe("inline-json");
    expect(candidate?.sourceSignals.join(" ")).toContain("decoded locally without network access");
  });

  it("decodes base64 inline registration JSON and keeps the description as a self-asserted note", () => {
    const registration = { name: "Probe Agent", description: "Bounded decode test." };
    const logs = [
      buildLog({
        agentId: 42,
        uri: `data:application/json;base64,${Buffer.from(JSON.stringify(registration), "utf8").toString("base64")}`,
      }),
    ];
    const result = parseRobinhoodRegisteredLogs(logs, BOUNDS);
    const candidate = result.entries[0]?.candidate;

    expect(candidate?.displayName).toBe("Probe Agent");
    expect(candidate?.summary).toContain("Bounded decode test.");
    expect(candidate?.summary).toContain("remain unverified assertions");
  });

  it("keeps web and IPFS URIs as unresolved assertions only", () => {
    const web = parseRobinhoodRegisteredLogs([buildLog({ agentId: 7, uri: "https://a-identity.xyz/.well-known/agent-card.json" })], BOUNDS);
    expect(web.entries[0]?.candidate.displayName).toBe("Agent #7");
    expect(web.entries[0]?.candidate.uriKind).toBe("web");
    expect(web.entries[0]?.candidate.sourceSignals.join(" ")).toContain("Nooscape did not fetch it.");

    const ipfs = parseRobinhoodRegisteredLogs([buildLog({ agentId: 8, uri: "ipfs://QmRLBfR7QcS6adyu63Fd17XVJp8mu7zHPF1fgjRBs26s59" })], BOUNDS);
    expect(ipfs.entries[0]?.candidate.uriKind).toBe("ipfs");
    expect(ipfs.entries[0]?.candidate.sourceSignals.join(" ")).toContain("did not resolve it");
  });

  it("rejects scans beyond the approved 256-event bound", () => {
    const logs = Array.from({ length: 257 }, (_, index) => buildLog({ agentId: index + 1, uri: "" }));
    expect(() => parseRobinhoodRegisteredLogs(logs, BOUNDS)).toThrow(RobinhoodRegistryValidationError);
  });

  it("rejects logs that do not match the approved registry, topic, or bounds", () => {
    const wrongTopic = parseRobinhoodRegisteredLogs([buildLog({ agentId: 9, uri: "", topic: `0x${"00".repeat(32)}` })], BOUNDS);
    expect(wrongTopic.entries).toHaveLength(0);
    expect(wrongTopic.rejectedCount).toBe(1);

    const outsideBounds = parseRobinhoodRegisteredLogs([buildLog({ agentId: 10, uri: "", block: 82_000_000 })], BOUNDS);
    expect(outsideBounds.entries).toHaveLength(0);

    const removed = parseRobinhoodRegisteredLogs([{ ...buildLog({ agentId: 11, uri: "" }), removed: true }], BOUNDS);
    expect(removed.entries).toHaveLength(0);
  });

  it("accepts token id 0 in the Registered decoder (agent #0 is a real agent)", () => {
    const result = parseRobinhoodRegisteredLogs([buildLog({ agentId: 0, uri: "" })], BOUNDS);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.candidate.externalId).toBe(`eip155:4663:${ROBINHOOD_IDENTITY_REGISTRY}:0`);
    expect(result.entries[0]?.candidate.displayName).toBe("Agent #0");
  });

  it("accepts token id 0 in the Transfer decoder as a mint", () => {
    const event = decodeTransferActivityLog(
      buildTransferLog({ tokenId: 0, from: ROBINHOOD_ZERO_ADDRESS, to: "0x2b5b35ac5a2d5c1224337ba86bf3816abee69da3" }),
      BOUNDS
    );
    expect(event?.kind).toBe("mint");
    expect(event?.externalKey).toBe(`eip155:4663:${ROBINHOOD_IDENTITY_REGISTRY}:0`);
  });

  it("accepts token id 0 in the URIUpdated decoder", () => {
    const event = decodeUriUpdatedActivityLog(buildUriUpdatedLog({ agentId: 0 }), BOUNDS);
    expect(event?.kind).toBe("uri_update");
    expect(event?.externalKey).toBe(`eip155:4663:${ROBINHOOD_IDENTITY_REGISTRY}:0`);
  });

  it("validates ABI string decoding boundaries", () => {
    expect(decodeAbiString(encodeString("https://example.org/agent.json"))).toBe("https://example.org/agent.json");
    expect(decodeAbiString(encodeString(""))).toBe("");
    expect(decodeAbiString("0x1234")).toBeNull();
    expect(decodeAbiString(`0x${"11".padStart(64, "0")}${"0".repeat(64)}${"0".repeat(64)}`)).toBeNull();
  });

  it("acknowledges a backfill window into the directory without any reviewed entries", () => {
    const logs = Array.from({ length: 30 }, (_, index) =>
      buildLog({ agentId: 8580 + index, uri: "https://legacy.example/agent.json", block: 83_100_000 + index, logIndex: index })
    );
    const result = parseRobinhoodRegisteredLogs(logs, BOUNDS, { backfill: true });

    expect(result.discoveredCount).toBe(30);
    expect(result.entries).toHaveLength(0);
    expect(result.directory).toHaveLength(30);
    expect(result.directory[0]?.externalKey).toBe(`eip155:4663:${ROBINHOOD_IDENTITY_REGISTRY}:8580`);
    expect(result.directory[0]?.locatorHost).toBe("legacy.example");
    expect(result.directory[0]?.sourceSignalNote).toContain("backfilled from chain history");
  });

  it("rejects backfill scans beyond the approved 2,000-event bound but not the evidence 256 bound", () => {
    const tooMany = Array.from({ length: ROBINHOOD_MAX_BACKFILL_EVENTS + 1 }, (_, index) =>
      buildLog({ agentId: index + 1, uri: "", block: 83_100_000 + index, logIndex: index })
    );
    expect(() => parseRobinhoodRegisteredLogs(tooMany, BOUNDS, { backfill: true })).toThrow(RobinhoodRegistryValidationError);
    // The same density stays legal in backfill mode and is rejected as an
    // evidence scan in observe mode: reviewed intake keeps its tighter cap.
    const heavy = Array.from({ length: 300 }, (_, index) =>
      buildLog({ agentId: index + 1, uri: "", block: 83_100_000 + index, logIndex: index })
    );
    expect(parseRobinhoodRegisteredLogs(heavy, BOUNDS, { backfill: true }).directory).toHaveLength(300);
    expect(() => parseRobinhoodRegisteredLogs(heavy, BOUNDS)).toThrow(RobinhoodRegistryValidationError);
  });

  it("narrows an over-budget backfill window to its newest half without skipping blocks", () => {
    // The stuck production window: 5,725 events / 4.33 MB in a 2,000,001-block window.
    const split = splitBackfillWindow(70_250_678, 72_250_678);
    expect(split).toEqual({ fromBlock: 71_250_678, toBlock: 72_250_678 });

    // The skipped older half [70,250,678 .. 71,250,677] is fully re-tiled by the
    // next 2M window that resumes from the persisted cursor.
    expect(robinhoodBackfillCursorAfter(split.fromBlock)).toBe("bf:71250677");
    expect(split.fromBlock - 1 - 2_000_000).toBeLessThanOrEqual(70_250_678);

    expect(splitBackfillWindow(10, 11)).toEqual({ fromBlock: 11, toBlock: 11 });
    expect(() => splitBackfillWindow(5, 5)).toThrow(RobinhoodRegistryValidationError);
  });

  it("acknowledges a narrowed backfill sub-window up to the transport-bounded cap", () => {
    const burst = Array.from({ length: ROBINHOOD_MAX_BACKFILL_EVENTS + 500 }, (_, index) =>
      buildLog({ agentId: index + 1, uri: "https://burst.example/agent.json", block: 83_100_000 + index, logIndex: index })
    );
    // A full window keeps the 2,000-event budget and fails closed...
    expect(() => parseRobinhoodRegisteredLogs(burst, BOUNDS, { backfill: true })).toThrow(RobinhoodRegistryValidationError);
    // ...while a narrowed sub-window acknowledges the whole burst, bounded by
    // the 4 MiB transport cap instead.
    const narrowed = parseRobinhoodRegisteredLogs(burst, BOUNDS, { backfill: true, backfillEventLimit: ROBINHOOD_MAX_BACKFILL_SUBWINDOW_EVENTS });
    expect(narrowed.directory).toHaveLength(ROBINHOOD_MAX_BACKFILL_EVENTS + 500);
    expect(narrowed.entries).toHaveLength(0);
    expect(narrowed.directory[0]?.sourceSignalNote).toContain("backfilled from chain history");
  });

  it("carries the decoded registering wallet into every directory draft", () => {
    const walk = parseRobinhoodRegisteredLogs(
      [buildLog({ agentId: 8601, uri: "https://clone.example/agent.json", owner: "0x1111111111111111111111111111111111111111" })],
      BOUNDS,
      { backfill: true }
    );
    expect(walk.directory[0]?.registrant).toBe("0x1111111111111111111111111111111111111111");

    // Observe-mode overflow drafts acknowledge the same registering wallet.
    const many = Array.from({ length: 30 }, (_, index) =>
      buildLog({ agentId: index + 1, uri: "", owner: "0x2222222222222222222222222222222222222222", block: 83_100_000 + index, logIndex: index })
    );
    const observe = parseRobinhoodRegisteredLogs(many, BOUNDS);
    expect(observe.directory.length).toBeGreaterThan(0);
    expect(observe.directory.every(draft => draft.registrant === "0x2222222222222222222222222222222222222222")).toBe(true);
  });

  it("parses registrant walk positions without clobbering the backfill walk", () => {
    expect(parseRobinhoodRegistrantCursor(null)).toEqual({ mode: "seed" });
    // A finished backfill seeds the registrant walk; a half-walked backfill
    // fails closed instead of letting either walk overwrite the other.
    expect(parseRobinhoodRegistrantCursor("bf:done")).toEqual({ mode: "seed" });
    expect(() => parseRobinhoodRegistrantCursor("bf:80176268")).toThrow(RobinhoodRegistryValidationError);
    expect(parseRobinhoodRegistrantCursor("rb:80176268")).toEqual({ mode: "walk", toBlock: 80_176_268 });
    expect(parseRobinhoodRegistrantCursor("rb:done")).toEqual({ mode: "done" });
    expect(() => parseRobinhoodRegistrantCursor("cursor:12")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodRegistrantCursor("rb:0")).toThrow(RobinhoodRegistryValidationError);

    expect(robinhoodRegistrantCursorAfter(80_176_269)).toBe("rb:80176268");
    expect(robinhoodRegistrantCursorAfter(1)).toBe("rb:done");
  });

  it("parses backfill walk positions and advances the cursor without overlap", () => {
    expect(parseRobinhoodBackfillCursor(null)).toEqual({ mode: "seed" });
    expect(parseRobinhoodBackfillCursor("bf:80176268")).toEqual({ mode: "walk", toBlock: 80_176_268 });
    expect(parseRobinhoodBackfillCursor("bf:done")).toEqual({ mode: "done" });
    expect(() => parseRobinhoodBackfillCursor("cursor:12")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodBackfillCursor("bf:0")).toThrow(RobinhoodRegistryValidationError);

    expect(robinhoodBackfillCursorAfter(80_176_269)).toBe("bf:80176268");
    expect(robinhoodBackfillCursorAfter(1)).toBe("bf:done");
  });

  it("decodes mint and secondary Transfers into ownership-timing facts only", () => {
    const mint = decodeTransferActivityLog(buildTransferLog({ tokenId: 6555, block: 83_200_000, logIndex: 3 }), BOUNDS);
    expect(mint).toMatchObject({
      kind: "mint",
      externalKey: `eip155:4663:${ROBINHOOD_IDENTITY_REGISTRY}:6555`,
      blockNumber: 83_200_000,
      logIndex: 3,
      fromAddress: ROBINHOOD_ZERO_ADDRESS,
      toAddress: "0x2b5b35ac5a2d5c1224337ba86bf3816abee69da3",
    });

    const secondary = decodeTransferActivityLog(
      buildTransferLog({
        tokenId: 11,
        from: "0x2b5b35ac5a2d5c1224337ba86bf3816abee69da3",
        to: "0x9999999999999999999999999999999999999999",
        block: 83_200_500,
        logIndex: 1,
      }),
      BOUNDS
    );
    expect(secondary).toMatchObject({
      kind: "secondary",
      externalKey: `eip155:4663:${ROBINHOOD_IDENTITY_REGISTRY}:11`,
      fromAddress: "0x2b5b35ac5a2d5c1224337ba86bf3816abee69da3",
      toAddress: "0x9999999999999999999999999999999999999999",
    });
  });

  it("decodes URIUpdated into a counted profile edit without addresses", () => {
    const edit = decodeUriUpdatedActivityLog(buildUriUpdatedLog({ agentId: 42, block: 83_300_000, logIndex: 2 }), BOUNDS);
    expect(edit).toMatchObject({
      kind: "uri_update",
      externalKey: `eip155:4663:${ROBINHOOD_IDENTITY_REGISTRY}:42`,
      blockNumber: 83_300_000,
      logIndex: 2,
      fromAddress: null,
      toAddress: null,
    });
  });

  it("rejects activity logs that do not match the approved registry, topic, or bounds", () => {
    expect(decodeTransferActivityLog(buildTransferLog({ tokenId: 1, topic: ROBINHOOD_REGISTERED_TOPIC }), BOUNDS)).toBeNull();
    expect(decodeTransferActivityLog(buildTransferLog({ tokenId: 2, block: 82_000_000 }), BOUNDS)).toBeNull();
    expect(decodeTransferActivityLog({ ...buildTransferLog({ tokenId: 3 }), removed: true }, BOUNDS)).toBeNull();
    expect(
      decodeUriUpdatedActivityLog({ ...buildUriUpdatedLog({ agentId: 4 }), address: "0x0000000000000000000000000000000000000001" }, BOUNDS)
    ).toBeNull();
  });

  it("acknowledges a mixed activity window and counts what it cannot decode", () => {
    const logs = [
      buildTransferLog({ tokenId: 100, logIndex: 0 }),
      buildTransferLog({ tokenId: 100, from: "0x2b5b35ac5a2d5c1224337ba86bf3816abee69da3", logIndex: 1 }),
      buildUriUpdatedLog({ agentId: 100, logIndex: 2 }),
      // A Registered event shares the window but is not chain activity; it is
      // rejected and counted rather than silently dropped.
      buildLog({ agentId: 100, uri: "" }),
    ];
    const result = parseRobinhoodActivityLogs(logs, BOUNDS);
    expect(result.discoveredCount).toBe(4);
    expect(result.rejectedCount).toBe(1);
    expect(result.activity).toHaveLength(3);
    expect(result.activity.map(event => event.kind)).toEqual(["mint", "secondary", "uri_update"]);
  });

  it("rejects activity scans beyond the approved bounded budget", () => {
    const tooMany = Array.from({ length: ROBINHOOD_MAX_BACKFILL_EVENTS + 1 }, (_, index) =>
      buildTransferLog({ tokenId: index + 1, logIndex: index })
    );
    expect(() => parseRobinhoodActivityLogs(tooMany, BOUNDS)).toThrow(RobinhoodRegistryValidationError);
    // A narrowed sub-window keeps the transport-bounded cap instead.
    const narrowedBurst = Array.from({ length: ROBINHOOD_MAX_BACKFILL_SUBWINDOW_EVENTS }, (_, index) =>
      buildTransferLog({ tokenId: index + 1, logIndex: index })
    );
    const narrowed = parseRobinhoodActivityLogs(narrowedBurst, BOUNDS, {
      activityEventLimit: ROBINHOOD_MAX_BACKFILL_SUBWINDOW_EVENTS,
    });
    expect(narrowed.activity).toHaveLength(ROBINHOOD_MAX_BACKFILL_SUBWINDOW_EVENTS);
  });

  it("parses activity walk positions seeded only from a finished registrant walk", () => {
    expect(parseRobinhoodActivityCursor("rb:done")).toEqual({ mode: "seed" });
    expect(parseRobinhoodActivityCursor("ac:80176268")).toEqual({ mode: "walk", toBlock: 80_176_268 });
    expect(parseRobinhoodActivityCursor("ac:done")).toEqual({ mode: "done" });
    // No other walk position may seed or resume the activity walk: a null
    // cursor, a finished backfill, and even a half-walked registrant walk all
    // fail closed so the activity ledger can never run ahead of the walk it
    // depends on.
    expect(() => parseRobinhoodActivityCursor(null)).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodActivityCursor("bf:done")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodActivityCursor("rb:80176268")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodActivityCursor("cursor:12")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodActivityCursor("ac:0")).toThrow(RobinhoodRegistryValidationError);

    expect(robinhoodActivityCursorAfter(80_176_269)).toBe("ac:80176268");
    expect(robinhoodActivityCursorAfter(1)).toBe("ac:done");
  });

  it("parses forward-walk positions reached only through a finished activity walk", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(parseRobinhoodForwardCursor("ac:done")).toEqual({ mode: "seed" });
    expect(parseRobinhoodForwardCursor(`fw:83111950#${hash}`)).toEqual({ mode: "anchor", block: 83_111_950, blockHash: hash });
    // Hash case is normalized, not rejected: an operator pasting an explorer's
    // uppercase hash into the console must not brick the walk.
    expect(parseRobinhoodForwardCursor(`fw:83111950#0x${"AB".repeat(32)}`)).toEqual({ mode: "anchor", block: 83_111_950, blockHash: hash });
    // Every other position fails closed — a forward cursor is reachable only
    // through ac:done, mirroring the ordered progression of the backward walks.
    expect(() => parseRobinhoodForwardCursor(null)).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodForwardCursor("rb:done")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodForwardCursor("ac:80176268")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodForwardCursor("fw:83111950")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodForwardCursor("fw:83111950#0x1234")).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodForwardCursor(`fw:0#${hash}`)).toThrow(RobinhoodRegistryValidationError);
    expect(() => parseRobinhoodForwardCursor("cursor:12")).toThrow(RobinhoodRegistryValidationError);

    expect(robinhoodForwardCursorAfter(83_111_950, hash.toUpperCase())).toBe(`fw:83111950#${hash}`);
  });

  it("bounds the forward window by the finality margin and the per-run budget", () => {
    expect(robinhoodForwardWindowBounds(83_000_000, 83_100_000)).toEqual({
      fromBlock: 83_000_001,
      toBlock: 83_100_000 - ROBINHOOD_FORWARD_FINALITY_MARGIN_BLOCKS,
    });
    // A head far beyond one window's budget: the per-run budget clamps first.
    expect(robinhoodForwardWindowBounds(83_000_000, 86_000_000)).toEqual({
      fromBlock: 83_000_001,
      toBlock: 83_000_000 + ROBINHOOD_FORWARD_WINDOW_BLOCKS,
    });
    // Caught up: a toBlock below fromBlock signals the honest zero-event run
    // that keeps the anchor instead of pretending to advance.
    const caught = robinhoodForwardWindowBounds(83_000_000, 83_000_500);
    expect(caught.toBlock).toBeLessThan(caught.fromBlock);
    expect(() => robinhoodForwardWindowBounds(83_000_000, 82_999_999)).toThrow(RobinhoodRegistryValidationError);
  });

  it("narrows a dense forward window to its oldest half without skipping blocks", () => {
    expect(splitForwardWindow(83_000_000, 83_099_999)).toEqual({ fromBlock: 83_000_000, toBlock: 83_049_999 });
    // The mirror of the backward split: the run scans the oldest fetchable
    // half, the anchor advances to its top, and the newest half re-tiles on
    // the next run from exactly that position.
    expect(splitForwardWindow(10, 11)).toEqual({ fromBlock: 10, toBlock: 10 });
    expect(() => splitForwardWindow(5, 5)).toThrow(RobinhoodRegistryValidationError);
  });
});
