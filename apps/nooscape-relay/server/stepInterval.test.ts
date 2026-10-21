import { describe, expect, it } from "vitest";
import { stepIntervalGateMs, STEP_INTERVAL_SLACK_MS } from "./stepInterval";

const MINUTE = 60_000;

describe("the gate between two runs of a registration step", () => {
  it("is the interval less two minutes, so a tick 29 minutes after the last run is not skipped", () => {
    expect(STEP_INTERVAL_SLACK_MS).toBe(2 * MINUTE);
    expect(stepIntervalGateMs(30 * MINUTE)).toBe(28 * MINUTE);
    // The gap seen live on 2026-10-18: a run began at 01:15:50 and the next tick's step at 01:45:08.
    const seenLive = (45 * 60 + 8 - (15 * 60 + 50)) * 1000;
    expect(seenLive).toBeLessThan(30 * MINUTE);
    expect(seenLive).toBeGreaterThanOrEqual(stepIntervalGateMs(30 * MINUTE));
  });

  it("still holds a run back that is well inside the interval", () => {
    expect(10 * MINUTE).toBeLessThan(stepIntervalGateMs(30 * MINUTE));
    expect(15 * MINUTE).toBeLessThan(stepIntervalGateMs(30 * MINUTE));
  });

  it("takes a tenth of a short interval, so a test with a one minute interval still gates", () => {
    expect(stepIntervalGateMs(MINUTE)).toBe(MINUTE - 6_000);
    expect(stepIntervalGateMs(0)).toBe(0);
  });
});
