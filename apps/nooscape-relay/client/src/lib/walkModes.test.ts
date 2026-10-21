import { describe, expect, it } from "vitest";
import { identityWalkModes, identityWalkOffered, reputationWalkMode } from "./walkModes";

describe("reputationWalkMode", () => {
  it("offers only the backfill while the walk is still backward", () => {
    expect(reputationWalkMode(null)).toBe("backfill");
    expect(reputationWalkMode(undefined)).toBe("backfill");
    expect(reputationWalkMode("")).toBe("backfill");
    expect(reputationWalkMode("rb:12058837")).toBe("backfill");
  });

  it("offers only the ratings fill once the backfill reached genesis or the walk is forward", () => {
    expect(reputationWalkMode("rb:done")).toBe("activity");
    expect(reputationWalkMode(`fw:85000000#0x${"0a".repeat(32)}`)).toBe("activity");
    expect(reputationWalkMode(`fw:85000000#0x${"AB".repeat(32)}`)).toBe("activity");
  });

  it("shows both buttons for a cursor it does not recognize, and leaves the decision to the server", () => {
    for (const cursor of ["ac:12345", "fw:abc#0x00", "rb:", "rb:done2", "garbage"]) {
      expect(reputationWalkMode(cursor)).toBe("unknown");
    }
  });
});

describe("identityWalkModes", () => {
  const FORWARD = `fw:85000000#0x${"0a".repeat(32)}`;

  it("offers either backward walk on a fresh source", () => {
    for (const cursor of [null, undefined, "", "  "]) expect(identityWalkModes(cursor)).toEqual(["backfill", "registrants"]);
  });

  it("offers exactly the one walk each position can run", () => {
    expect(identityWalkModes("bf:12058837")).toEqual(["backfill"]);
    expect(identityWalkModes("bf:done")).toEqual(["registrants"]);
    expect(identityWalkModes("rb:5000")).toEqual(["registrants"]);
    expect(identityWalkModes("rb:done")).toEqual(["activity"]);
    expect(identityWalkModes("ac:777")).toEqual(["activity"]);
    expect(identityWalkModes("ac:done")).toEqual(["activity"]);
    expect(identityWalkModes(FORWARD)).toEqual(["activity"]);
    expect(identityWalkModes(`fw:85000000#0x${"AB".repeat(32)}`)).toEqual(["activity"]);
  });

  it("returns unknown for a cursor it does not recognize, so every button shows and the server decides", () => {
    for (const cursor of ["garbage", "bf:", "bf:0", "rb:done2", "ac:abc", "fw:abc#0x00", "fw:0#0x" + "0a".repeat(32)]) {
      expect(identityWalkModes(cursor)).toBe("unknown");
    }
  });

  it("hides the backfill and registrant buttons on the forward walk, where only Fill activity can run", () => {
    expect(identityWalkOffered(FORWARD, "backfill")).toBe(false);
    expect(identityWalkOffered(FORWARD, "registrants")).toBe(false);
    expect(identityWalkOffered(FORWARD, "activity")).toBe(true);
  });

  it("offers every button for an unrecognized cursor", () => {
    for (const mode of ["backfill", "registrants", "activity"] as const) expect(identityWalkOffered("garbage", mode)).toBe(true);
  });
});
