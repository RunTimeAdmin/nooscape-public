import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOT_FAILURE_FILE,
  FIRST_DELAY_MS,
  MAX_DELAY_MS,
  RESET_AFTER_MS,
  clearBootFailure,
  delayAfterFailures,
  recordBootFailure,
  waitOutBootFailure,
} from "./bootBackoff";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nooscape-boot-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A clock the test moves, and a sleep that moves it. */
function clock(start = 1_000_000) {
  let time = start;
  const slept: number[] = [];
  const lines: string[] = [];
  return {
    io: {
      dir,
      now: () => time,
      sleep: async (ms: number) => {
        slept.push(ms);
        time += ms;
      },
      log: (line: string) => lines.push(line),
    },
    advance: (ms: number) => {
      time += ms;
    },
    set: (to: number) => {
      time = to;
    },
    now: () => time,
    slept,
    lines,
  };
}

describe("delayAfterFailures", () => {
  it("starts at 15 seconds, doubles with each failure in a row, and stops at five minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(delayAfterFailures)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
    expect(FIRST_DELAY_MS).toBe(15_000);
    expect(MAX_DELAY_MS).toBe(300_000);
  });

  it("is the longest delay for any count, however large, and none for no failure", () => {
    expect(delayAfterFailures(1_000_000)).toBe(MAX_DELAY_MS);
    expect(delayAfterFailures(0)).toBe(0);
    expect(delayAfterFailures(-3)).toBe(0);
    expect(delayAfterFailures(Number.NaN)).toBe(0);
  });
});

describe("recordBootFailure", () => {
  it("counts the failures in a row, and starts the count again after a long quiet", () => {
    const c = clock();
    expect(recordBootFailure(c.io).count).toBe(1);
    c.advance(5_000);
    expect(recordBootFailure(c.io).count).toBe(2);
    c.advance(RESET_AFTER_MS - 1);
    expect(recordBootFailure(c.io).count).toBe(3);
    c.advance(RESET_AFTER_MS);
    expect(recordBootFailure(c.io).count).toBe(1);
  });

  it("does not throw when the note cannot be written", () => {
    const c = clock();
    expect(() => recordBootFailure({ ...c.io, dir: path.join(dir, "no", "such", "directory") })).not.toThrow();
  });
});

describe("waitOutBootFailure", () => {
  it("waits for nothing when no start has failed", async () => {
    const c = clock();
    expect(await waitOutBootFailure(c.io)).toBe(0);
    expect(c.slept).toEqual([]);
    expect(c.lines).toEqual([]);
  });

  it("waits out what is left of the delay after the last failure, and says so", async () => {
    const c = clock();
    recordBootFailure(c.io);
    c.advance(1_000);
    recordBootFailure(c.io); // two in a row: 30 s after this one
    c.advance(10_000);
    expect(await waitOutBootFailure(c.io)).toBe(20_000);
    expect(c.slept).toEqual([20_000]);
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toContain("2 starts in a row failed on the database");
    expect(c.lines[0]).toContain("waiting 20 s");
  });

  it("does not wait once the delay has passed", async () => {
    const c = clock();
    recordBootFailure(c.io);
    c.advance(FIRST_DELAY_MS);
    expect(await waitOutBootFailure(c.io)).toBe(0);
    expect(c.slept).toEqual([]);
  });

  it("never holds a start for longer than the longest delay, even if the clock moved back", async () => {
    const c = clock(5_000_000);
    recordBootFailure(c.io);
    recordBootFailure(c.io);
    c.set(5_000_000 - 3_600_000);
    expect(await waitOutBootFailure(c.io)).toBe(MAX_DELAY_MS);
  });

  it("ignores a note it cannot read or that makes no sense", async () => {
    const c = clock();
    const file = path.join(dir, BOOT_FAILURE_FILE);
    for (const text of ["", "not json", "null", "[]", JSON.stringify({ count: 0, lastAt: c.now() }), JSON.stringify({ count: "x", lastAt: c.now() }), JSON.stringify({ count: 3 })]) {
      fs.writeFileSync(file, text);
      expect(await waitOutBootFailure(c.io)).toBe(0);
    }
    expect(c.slept).toEqual([]);
  });
});

describe("clearBootFailure", () => {
  it("removes the note, so the next start waits for nothing and the next failure counts from one", async () => {
    const c = clock();
    for (let i = 0; i < 5; i += 1) recordBootFailure(c.io);
    clearBootFailure(c.io);
    expect(fs.existsSync(path.join(dir, BOOT_FAILURE_FILE))).toBe(false);
    expect(await waitOutBootFailure(c.io)).toBe(0);
    expect(recordBootFailure(c.io).count).toBe(1);
  });

  it("is a no-op when there is no note", () => {
    const c = clock();
    expect(() => clearBootFailure(c.io)).not.toThrow();
  });
});

describe("a crash loop", () => {
  it("makes about sixteen attempts in an hour and not thousands, the first one at once", async () => {
    const c = clock();
    const startedAt = c.now();
    const attempts: number[] = [];
    // The host starts the process again as soon as it ends; an attempt that reaches the database takes a second and fails.
    while (c.now() - startedAt < 3_600_000) {
      await waitOutBootFailure(c.io);
      if (c.now() - startedAt >= 3_600_000) break;
      attempts.push(c.now() - startedAt);
      c.advance(1_000);
      recordBootFailure(c.io);
    }
    expect(attempts[0]).toBe(0);
    expect(attempts.slice(0, 6)).toEqual([0, 16_000, 47_000, 108_000, 229_000, 470_000]);
    expect(attempts.length).toBeGreaterThanOrEqual(14);
    expect(attempts.length).toBeLessThanOrEqual(20);
  });

  it("goes back to no waiting at all once the database answers", async () => {
    const c = clock();
    for (let i = 0; i < 4; i += 1) {
      await waitOutBootFailure(c.io);
      recordBootFailure(c.io);
    }
    await waitOutBootFailure(c.io);
    clearBootFailure(c.io); // the database answered
    const slept = c.slept.length;
    expect(await waitOutBootFailure(c.io)).toBe(0);
    expect(c.slept).toHaveLength(slept);
  });
});

describe("where it is called", () => {
  const source = fs.readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
  const wait = source.indexOf("await waitOutBootFailure()");
  const migrate = source.indexOf("await applyPendingMigrations(process.env.DATABASE_URL)");
  const clear = source.indexOf("clearBootFailure()");
  const failed = source.indexOf("} catch (error) {", migrate);
  const exit = source.indexOf("process.exit(1)", failed);

  it("the wait comes before the first connection, the clear after the schema step, the note before the exit", () => {
    expect(wait).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(wait);
    expect(clear).toBeGreaterThan(migrate);
    expect(failed).toBeGreaterThan(clear);
    const recorded = source.indexOf("recordBootFailure()", failed);
    expect(recorded).toBeGreaterThan(failed);
    expect(exit).toBeGreaterThan(recorded);
  });

  it("applies in production only, as the lifecycle log does", () => {
    expect(source).toContain('const spaced = process.env.NODE_ENV === "production";');
    expect(source).toContain("if (spaced) await waitOutBootFailure();");
    expect(source).toContain("if (spaced) clearBootFailure();");
    expect(source).toContain("if (spaced) recordBootFailure();");
  });
});
