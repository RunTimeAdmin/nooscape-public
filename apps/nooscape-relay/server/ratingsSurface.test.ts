import { describe, expect, it } from "vitest";
import {
  computeRatingsSummary,
  formatRatingValue,
  parseReputationExternalKey,
  type RatingsEventInput,
} from "./ratingsSurface";

const APPROVED_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

function ratingEvent(overrides: Partial<RatingsEventInput> = {}): RatingsEventInput {
  return {
    kind: "new_feedback",
    blockNumber: 100,
    transactionHash: `0x${"a".repeat(64)}`,
    logIndex: 0,
    clientAddress: `0x${"1".repeat(40)}`,
    feedbackIndex: 1,
    valueRaw: "2500000",
    valueDecimals: 6,
    tag1: null,
    tag2: null,
    ...overrides,
  };
}

describe("parseReputationExternalKey", () => {
  it("extracts the agent id from a Robinhood identity entry's external key", () => {
    expect(parseReputationExternalKey(`eip155:4663:${APPROVED_REGISTRY}:462`)).toBe(462);
    expect(parseReputationExternalKey(`eip155:4663:${APPROVED_REGISTRY}:1`)).toBe(1);
  });

  it("rejects a different registry segment", () => {
    expect(parseReputationExternalKey("eip155:4663:0x9999:462")).toBeNull();
  });

  it("rejects other chains even with the approved registry", () => {
    expect(parseReputationExternalKey(`eip155:1:${APPROVED_REGISTRY}:462`)).toBeNull();
    expect(parseReputationExternalKey(`solana:${APPROVED_REGISTRY}:462`)).toBeNull();
  });

  it("rejects 3- and 5-segment keys", () => {
    expect(parseReputationExternalKey(`eip155:4663:${APPROVED_REGISTRY}`)).toBeNull();
    expect(parseReputationExternalKey(`eip155:4663:${APPROVED_REGISTRY}:462:extra`)).toBeNull();
  });

  it("rejects a non-numeric tail", () => {
    expect(parseReputationExternalKey(`eip155:4663:${APPROVED_REGISTRY}:abc`)).toBeNull();
    expect(parseReputationExternalKey(`eip155:4663:${APPROVED_REGISTRY}:12x`)).toBeNull();
    expect(parseReputationExternalKey(`eip155:4663:${APPROVED_REGISTRY}:`)).toBeNull();
  });

  it("rejects zero and huge tails beyond the safe-integer range", () => {
    expect(parseReputationExternalKey(`eip155:4663:${APPROVED_REGISTRY}:0`)).toBeNull();
    expect(parseReputationExternalKey(`eip155:4663:${APPROVED_REGISTRY}:99999999999999999999`)).toBeNull();
  });
});

describe("formatRatingValue", () => {
  it("shifts the decimal point and trims trailing fraction zeros", () => {
    expect(formatRatingValue("2500000", 6)).toBe("2.5");
    expect(formatRatingValue("1000000", 6)).toBe("1");
    expect(formatRatingValue("123456", 3)).toBe("123.456");
    expect(formatRatingValue("123400", 3)).toBe("123.4");
    expect(formatRatingValue("1234000", 3)).toBe("1234");
  });

  it("keeps an all-zero fraction as a clean zero", () => {
    expect(formatRatingValue("0", 6)).toBe("0");
    expect(formatRatingValue("000", 2)).toBe("0");
  });

  it("preserves negative scores", () => {
    expect(formatRatingValue("-2500000", 6)).toBe("-2.5");
    expect(formatRatingValue("-0", 6)).toBe("0");
  });

  it("treats non-positive decimals as integer placement", () => {
    expect(formatRatingValue("42", 0)).toBe("42");
    expect(formatRatingValue("42", -3)).toBe("42");
  });

  it("handles more decimals than digits", () => {
    expect(formatRatingValue("5", 6)).toBe("0.000005");
  });
});

describe("computeRatingsSummary", () => {
  it("marks exactly the (client, feedbackIndex) rating a revocation names", () => {
    const summary = computeRatingsSummary(
      [
        ratingEvent({ clientAddress: `0x${"1".repeat(40)}`, feedbackIndex: 1, blockNumber: 100, logIndex: 0 }),
        ratingEvent({ clientAddress: `0x${"1".repeat(40)}`, feedbackIndex: 2, blockNumber: 110, logIndex: 0 }),
        ratingEvent({ clientAddress: `0x${"2".repeat(40)}`, feedbackIndex: 1, blockNumber: 120, logIndex: 0 }),
        ratingEvent({
          kind: "feedback_revoked",
          clientAddress: `0x${"1".repeat(40)}`,
          feedbackIndex: 1,
          blockNumber: 130,
          logIndex: 0,
          valueRaw: null,
          valueDecimals: null,
        }),
      ],
      130
    );
    const revoked = summary.events.filter(event => event.revoked);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ clientAddress: `0x${"1".repeat(40)}`, feedbackIndex: 1 });
    // Same feedbackIndex from a different client stays untouched, and so does
    // the same client's later rating.
    expect(summary.events.find(event => event.feedbackIndex === 2)?.revoked).toBe(false);
    expect(summary.events.find(event => event.clientAddress === `0x${"2".repeat(40)}`)?.revoked).toBe(false);
  });

  it("adds the counts up honestly", () => {
    const summary = computeRatingsSummary(
      [
        ratingEvent({ feedbackIndex: 1 }),
        ratingEvent({ feedbackIndex: 2, blockNumber: 110 }),
        ratingEvent({
          kind: "feedback_revoked",
          feedbackIndex: 1,
          blockNumber: 120,
          valueRaw: null,
          valueDecimals: null,
        }),
        ratingEvent({
          kind: "response_appended",
          feedbackIndex: 2,
          blockNumber: 130,
          valueRaw: null,
          valueDecimals: null,
        }),
      ],
      130
    );
    expect(summary).toMatchObject({
      measuredThroughBlock: 130,
      totalEvents: 4,
      ratingCount: 2,
      activeRatingCount: 1,
      revokedCount: 1,
      responseCount: 1,
    });
  });

  it("keeps a revoked-only agent at zero ratings with the revocation counted", () => {
    const summary = computeRatingsSummary(
      [
        ratingEvent({
          kind: "feedback_revoked",
          clientAddress: `0x${"3".repeat(40)}`,
          feedbackIndex: 7,
          valueRaw: null,
          valueDecimals: null,
        }),
      ],
      100
    );
    expect(summary.ratingCount).toBe(0);
    expect(summary.activeRatingCount).toBe(0);
    expect(summary.revokedCount).toBe(1);
    expect(summary.totalEvents).toBe(1);
  });

  it("preserves the caller's chain order (rows arrive blockNumber/logIndex-ordered from SQL)", () => {
    const summary = computeRatingsSummary(
      [
        ratingEvent({ blockNumber: 200, logIndex: 1 }),
        ratingEvent({ blockNumber: 100, logIndex: 9 }),
        ratingEvent({ blockNumber: 200, logIndex: 0 }),
      ],
      200
    );
    expect(summary.events.map(event => [event.blockNumber, event.logIndex])).toEqual([
      [200, 1],
      [100, 9],
      [200, 0],
    ]);
  });

  it("returns zero counts for an empty ledger slice", () => {
    const summary = computeRatingsSummary([], 42);
    expect(summary).toEqual({
      measuredThroughBlock: 42,
      totalEvents: 0,
      ratingCount: 0,
      activeRatingCount: 0,
      revokedCount: 0,
      responseCount: 0,
      events: [],
    });
  });

  it("passes untrusted tag text through the public-text scrubber", () => {
    const summary = computeRatingsSummary([ratingEvent({ tag1: "great\x00agent\u202Ereversed" })], 100);
    expect(summary.events[0]?.tag1).not.toMatch(/[\x00\u202E]/);
  });

  it("reports an unmeasured ledger as null, never a false block zero", () => {
    const summary = computeRatingsSummary([ratingEvent()], null);
    expect(summary.measuredThroughBlock).toBeNull();
  });
});
