import { describe, expect, it, vi } from "vitest";
import {
  createDatabaseRoomReader,
  databaseLimitBytes,
  databaseRoomOf,
  DEFAULT_DATABASE_LIMIT_MB,
  ROOM_CRITICAL_FROM,
  ROOM_LOW_FROM,
} from "./databaseRoom";

const MB = 1024 * 1024;
const LIMIT = 6_144 * MB;

describe("the room the database has", () => {
  it("is ok below 70 percent of the limit, low from 70, critical from 85, and critical past the limit", () => {
    expect(ROOM_LOW_FROM).toBe(0.7);
    expect(ROOM_CRITICAL_FROM).toBe(0.85);
    expect(databaseRoomOf(0, LIMIT)).toBe("ok");
    expect(databaseRoomOf(LIMIT * 0.6999, LIMIT)).toBe("ok");
    expect(databaseRoomOf(LIMIT * 0.7, LIMIT)).toBe("low");
    expect(databaseRoomOf(LIMIT * 0.8499, LIMIT)).toBe("low");
    expect(databaseRoomOf(LIMIT * 0.85, LIMIT)).toBe("critical");
    expect(databaseRoomOf(LIMIT * 1.3, LIMIT)).toBe("critical");
  });

  it("measures against the plan's 6 GB unless the environment says another limit in megabytes", () => {
    expect(DEFAULT_DATABASE_LIMIT_MB).toBe(6_144);
    expect(databaseLimitBytes({})).toBe(LIMIT);
    expect(databaseLimitBytes({ NOOSCAPE_DATABASE_LIMIT_MB: "9216" })).toBe(9_216 * MB);
    for (const bad of ["", "0", "-5", "lots", "NaN"]) expect(databaseLimitBytes({ NOOSCAPE_DATABASE_LIMIT_MB: bad }), bad).toBe(LIMIT);
  });
});

describe("the reader of the room", () => {
  const reader = (sizes: Array<number | Error>, now: { at: number }, log: (line: string) => void = () => {}) => {
    const usedBytes = vi.fn(async () => {
      const next = sizes.length > 1 ? sizes.shift()! : sizes[0]!;
      if (next instanceof Error) throw next;
      return next;
    });
    return { read: createDatabaseRoomReader({ usedBytes, limitBytes: () => LIMIT, now: () => now.at, log }), usedBytes };
  };

  it("asks the database once in ten minutes, however many visitors ask, and again after that", async () => {
    const now = { at: 1_000_000 };
    const { read, usedBytes } = reader([2_000 * MB, 5_000 * MB], now);
    expect(await read()).toBe("ok");
    expect(await Promise.all([read(), read(), read()])).toEqual(["ok", "ok", "ok"]);
    now.at += 9 * 60_000;
    expect(await read()).toBe("ok");
    expect(usedBytes).toHaveBeenCalledTimes(1);
    now.at += 61_000;
    expect(await read()).toBe("low");
    expect(usedBytes).toHaveBeenCalledTimes(2);
  });

  it("lets the callers who ask at the same moment share one question", async () => {
    const now = { at: 1_000_000 };
    const { read, usedBytes } = reader([2_000 * MB], now);
    expect(await Promise.all([read(), read(), read(), read()])).toEqual(["ok", "ok", "ok", "ok"]);
    expect(usedBytes).toHaveBeenCalledTimes(1);
  });

  it("answers null when the size cannot be read, never ok, and asks again after a minute and not sooner", async () => {
    const now = { at: 1_000_000 };
    const { read, usedBytes } = reader([new Error("no database"), 1_000 * MB], now);
    expect(await read()).toBeNull();
    now.at += 30_000;
    expect(await read()).toBeNull();
    expect(usedBytes).toHaveBeenCalledTimes(1);
    now.at += 31_000;
    expect(await read()).toBe("ok");
    expect(usedBytes).toHaveBeenCalledTimes(2);
  });

  it("does not take a size that is not a number for an answer", async () => {
    for (const size of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const { read } = reader([size], { at: 1_000_000 });
      expect(await read(), String(size)).toBeNull();
    }
  });

  it("writes the size to the log, in megabytes, once an hour while the room is low or critical, and never while it is fine", async () => {
    const lines: string[] = [];
    const now = { at: 1_000_000 };
    const { read } = reader([1_000 * MB, 4_500 * MB, 4_600 * MB, 5_400 * MB], now, line => lines.push(line));
    expect(await read()).toBe("ok");
    expect(lines).toEqual([]);
    now.at += 11 * 60_000;
    expect(await read()).toBe("low");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[Database] room is low: 4500 MB of 6144 MB");
    now.at += 11 * 60_000;
    expect(await read()).toBe("low");
    expect(lines).toHaveLength(1);
    now.at += 50 * 60_000;
    expect(await read()).toBe("critical");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("room is critical: 5400 MB of 6144 MB");
  });
});
