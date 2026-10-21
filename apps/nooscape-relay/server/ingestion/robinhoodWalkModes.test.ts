import { describe, expect, it } from "vitest";
import { identityWalkModes } from "../../client/src/lib/walkModes";
import {
  assertRobinhoodModeFitsCursor,
  robinhoodWalkModesForCursor,
  RobinhoodRegistryValidationError,
  RobinhoodWalkModeRefusedError,
  type RobinhoodWalkMode,
} from "./robinhood";

/**
 * Which identity-registry walk can run from which persisted cursor. The four
 * walks share one position that moves strictly forward (bf: backfill, rb:
 * registrants, ac: activity, then fw: forward), so one walk runs from any
 * recognized position. A click the position cannot honor is an operator
 * mistake and is refused before a run row exists; the console mirrors the same
 * rules so it never offers the button, and a parity test keeps the two in step.
 */
const FORWARD = `fw:85000000#0x${"0a".repeat(32)}`;
const FORWARD_UPPER = `fw:85000000#0x${"AB".repeat(32)}`;

const POSITIONS: Array<[string, string | null, RobinhoodWalkMode[]]> = [
  ["a fresh source", null, ["backfill", "registrants"]],
  ["a blank cursor", "  ", ["backfill", "registrants"]],
  ["the middle of the backfill", "bf:12058837", ["backfill"]],
  ["a finished backfill", "bf:done", ["registrants"]],
  ["the middle of the registrant walk", "rb:5000", ["registrants"]],
  ["a finished registrant walk", "rb:done", ["activity"]],
  ["the middle of the activity walk", "ac:777", ["activity"]],
  ["a finished activity walk", "ac:done", ["activity"]],
  ["the forward walk", FORWARD, ["activity"]],
  ["the forward walk with an uppercase hash", FORWARD_UPPER, ["activity"]],
];

const UNRECOGNIZED = ["garbage", "bf:", "bf:0", "rb:done2", "ac:abc", "fw:abc#0x00", "fw:0#0x" + "0a".repeat(32), "bf:12 34"];

const ALL_WALKS: RobinhoodWalkMode[] = ["backfill", "registrants", "activity"];

describe("robinhoodWalkModesForCursor", () => {
  for (const [label, cursor, expected] of POSITIONS) {
    it(`allows exactly ${expected.join(" and ")} from ${label}`, () => {
      expect(robinhoodWalkModesForCursor(cursor)).toEqual(expected);
    });
  }

  it("allows no walk from a cursor it does not recognize", () => {
    for (const cursor of UNRECOGNIZED) expect(robinhoodWalkModesForCursor(cursor)).toEqual([]);
  });
});

describe("the console mirrors the server's rules", () => {
  it("offers the same walks the server allows for every recognized position", () => {
    for (const [, cursor] of POSITIONS) expect(identityWalkModes(cursor)).toEqual(robinhoodWalkModesForCursor(cursor));
    expect(identityWalkModes(undefined)).toEqual(robinhoodWalkModesForCursor(null));
  });

  it("falls back to every button for a cursor it does not recognize, where the server allows none", () => {
    for (const cursor of UNRECOGNIZED) {
      expect(identityWalkModes(cursor)).toBe("unknown");
      expect(robinhoodWalkModesForCursor(cursor)).toEqual([]);
    }
  });
});

describe("assertRobinhoodModeFitsCursor", () => {
  it("accepts every walk the position allows", () => {
    for (const [, cursor, allowed] of POSITIONS) {
      for (const mode of allowed) expect(() => assertRobinhoodModeFitsCursor(cursor, mode)).not.toThrow();
    }
  });

  it("accepts observe from any cursor, including one it does not recognize", () => {
    for (const [, cursor] of POSITIONS) expect(() => assertRobinhoodModeFitsCursor(cursor, "observe")).not.toThrow();
    for (const cursor of UNRECOGNIZED) expect(() => assertRobinhoodModeFitsCursor(cursor, "observe")).not.toThrow();
  });

  it("refuses every walk the position does not allow, as an operator mistake", () => {
    for (const [, cursor, allowed] of POSITIONS) {
      for (const mode of ALL_WALKS.filter(candidate => !allowed.includes(candidate))) {
        expect(() => assertRobinhoodModeFitsCursor(cursor, mode)).toThrow(RobinhoodWalkModeRefusedError);
      }
    }
    for (const cursor of UNRECOGNIZED) {
      for (const mode of ALL_WALKS) expect(() => assertRobinhoodModeFitsCursor(cursor, mode)).toThrow(RobinhoodWalkModeRefusedError);
    }
  });

  it("is still a validation error, so existing handlers keep treating it as one", () => {
    expect(() => assertRobinhoodModeFitsCursor("bf:done", "backfill")).toThrow(RobinhoodRegistryValidationError);
  });

  it("names the button, the position, and what can run, without echoing the anchor hash", () => {
    expect(() => assertRobinhoodModeFitsCursor("bf:done", "backfill")).toThrow(
      "Backfill window cannot run from the current position, backfill complete (bf:done). Fill registrants can run from here."
    );
    expect(() => assertRobinhoodModeFitsCursor(null, "activity")).toThrow(
      "Fill activity cannot run from the current position, not started. Backfill window or Fill registrants can run from here."
    );
    expect(() => assertRobinhoodModeFitsCursor("rb:done", "registrants")).toThrow(
      "Fill registrants cannot run from the current position, registrant walk complete (rb:done). Fill activity can run from here."
    );
    let forwardMessage = "";
    try {
      assertRobinhoodModeFitsCursor(FORWARD, "backfill");
    } catch (error) {
      forwardMessage = (error as Error).message;
    }
    expect(forwardMessage).toBe("Backfill window cannot run from the current position, forward walk (fw:85000000). Fill activity can run from here.");
    expect(forwardMessage).not.toContain("0x");
  });

  it("says no walk can run when the stored cursor is not an approved position", () => {
    expect(() => assertRobinhoodModeFitsCursor("garbage", "backfill")).toThrow(
      "Backfill window cannot run: the stored cursor is not an approved walk position (garbage), so no walk can run from it."
    );
  });
});
