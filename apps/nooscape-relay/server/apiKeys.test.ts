import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_TIER_NAMES, API_TIERS, ApiKeyError, ApiMeter, hashApiKey, isApiTier, KEY_PATTERN, KEY_PREFIX_LENGTH, newApiKey, normalizeEmail, utcDay, type UsageRow, type UsageStore } from "./apiKeys";

/**
 * The key module without a database (docs/data-access-2026-10-19.md, stage D2): what a key looks like and what is stored of it, which
 * emails are taken, the tiers, and the count of a key's day (ApiMeter) against an in-memory store with a clock the test moves.
 */

afterEach(() => vi.restoreAllMocks());

describe("a key", () => {
  it("is nsk_ and 40 characters from 30 random bytes, different every time, and matches the pattern the API accepts", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const { key } = newApiKey();
      expect(key).toMatch(KEY_PATTERN);
      expect(key).toHaveLength(44);
      seen.add(key);
    }
    expect(seen.size).toBe(200);
  });

  it("is stored as its SHA-256 and its first characters, and the hash does not contain the key", () => {
    const made = newApiKey();
    expect(made.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(made.hash).toBe(hashApiKey(made.key));
    expect(made.prefix).toBe(made.key.slice(0, KEY_PREFIX_LENGTH));
    expect(made.prefix).toHaveLength(10);
    expect(made.hash).not.toContain(made.key.slice(4, 14));
    expect(hashApiKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is refused by the pattern when it is the wrong length, has other characters or another start", () => {
    for (const text of ["", "nsk_", `nsk_${"a".repeat(39)}`, `nsk_${"a".repeat(41)}`, `NSK_${"a".repeat(40)}`, `nsk_${"a".repeat(39)}!`, `nsk_${"a".repeat(39)} `, ` nsk_${"a".repeat(40)}`]) {
      expect(KEY_PATTERN.test(text), JSON.stringify(text)).toBe(false);
    }
    expect(KEY_PATTERN.test(`nsk_${"A-_z09".repeat(6)}abcd`)).toBe(true);
  });
});

describe("an email", () => {
  it("is trimmed and lower-cased, and kept only when it can be an address", () => {
    expect(normalizeEmail("  Dev@Example.COM ")).toBe("dev@example.com");
    expect(normalizeEmail("a.b+tag@sub.example.org")).toBe("a.b+tag@sub.example.org");
    for (const text of ["", "dev", "dev@", "@example.com", "dev@example", "dev@@example.com", "dev example@example.com", "dev@exa mple.com", "dev@example.c", "a@b.c", `${"x".repeat(65)}@example.com`, `dev@${"x".repeat(250)}.com`, "dev\n@example.com", "dev@example.com\u0000"]) {
      expect(normalizeEmail(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe("the tiers", () => {
  it("are free, builder and pro, with a day's allowance and a minute's that only grow, and the free ones the spec names", () => {
    expect([...API_TIER_NAMES]).toEqual(["free", "builder", "pro"]);
    expect(API_TIERS.free).toMatchObject({ perMinute: 60, perDay: 1_000 });
    expect(API_TIERS.builder.perDay).toBe(50_000);
    expect(API_TIERS.pro.perDay).toBe(500_000);
    expect(API_TIERS.builder.perMinute).toBeGreaterThan(API_TIERS.free.perMinute);
    expect(API_TIERS.pro.perMinute).toBeGreaterThan(API_TIERS.builder.perMinute);
    expect(isApiTier("pro")).toBe(true);
    for (const text of ["", "enterprise", "Free", "admin"]) expect(isApiTier(text), text).toBe(false);
  });

  it("have no field that could buy a different answer: a tier is a rate and a quota and nothing else", () => {
    for (const tier of API_TIER_NAMES) expect(Object.keys(API_TIERS[tier]).sort(), tier).toEqual(["label", "perDay", "perMinute"]);
  });
});

// ---------------------------------------------------------------- the meter

function memoryStore() {
  const rows = new Map<string, number>();
  const calls = { loadDay: 0, addUsage: [] as UsageRow[][], touch: [] as Array<{ keyIds: string[]; at: Date }> };
  const failures = { addUsage: 0, touch: 0 };
  const store: UsageStore = {
    loadDay: async (keyId, day) => {
      calls.loadDay += 1;
      let total = 0;
      for (const [slot, count] of rows) if (slot.startsWith(`${keyId}|${day}|`)) total += count;
      return total;
    },
    addUsage: async batch => {
      if (failures.addUsage > 0) {
        failures.addUsage -= 1;
        throw new Error("insert into `api_usage` ...\nparams: secret");
      }
      calls.addUsage.push(batch.map(row => ({ ...row })));
      for (const row of batch) {
        const slot = `${row.keyId}|${row.day}|${row.endpoint}`;
        rows.set(slot, (rows.get(slot) ?? 0) + row.count);
      }
    },
    touch: async (keyIds, at) => {
      if (failures.touch > 0) {
        failures.touch -= 1;
        throw new Error("update failed");
      }
      calls.touch.push({ keyIds, at });
    },
  };
  return { store, rows, calls, failures };
}

const START = new Date("2026-10-19T10:00:00Z");

function meter(store: UsageStore) {
  const clock = { now: new Date(START) };
  return { meter: new ApiMeter(store, () => clock.now), clock };
}

describe("the count of a key's day", () => {
  it("counts each request, tells how many are left and when the day restarts, and refuses the one past the limit without counting it", async () => {
    const { store, rows } = memoryStore();
    const { meter: m } = meter(store);
    const first = await m.consume("k1", 3, "agent");
    expect(first).toMatchObject({ allowed: true, limit: 3, used: 1, remaining: 2 });
    expect(first.resetsAt.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect((await m.consume("k1", 3, "agent")).remaining).toBe(1);
    expect((await m.consume("k1", 3, "search")).remaining).toBe(0);
    const refused = await m.consume("k1", 3, "agent");
    expect(refused).toMatchObject({ allowed: false, used: 3, remaining: 0 });
    expect((await m.consume("k1", 3, "agent")).allowed).toBe(false);
    await m.flush();
    expect(Array.from(rows.values()).reduce((sum, count) => sum + count, 0)).toBe(3);
    expect((await m.consume("k2", 3, "agent")).allowed).toBe(true);
  });

  it("reads the day's total from the store once, then counts in memory", async () => {
    const { store, rows, calls } = memoryStore();
    rows.set(`k1|2026-10-19|agent`, 7);
    const { meter: m } = meter(store);
    for (let index = 0; index < 5; index += 1) await m.consume("k1", 100, "agent");
    expect(calls.loadDay).toBe(1);
    const result = await m.consume("k1", 100, "agent");
    expect(result.used).toBe(13);
  });

  it("starts from what was already counted today, so a restart does not give the day back", async () => {
    const { store, rows } = memoryStore();
    const first = meter(store);
    for (let index = 0; index < 4; index += 1) await first.meter.consume("k1", 5, "agent");
    await first.meter.flush();
    expect(Array.from(rows.values())).toEqual([4]);
    const restarted = meter(store);
    expect((await restarted.meter.consume("k1", 5, "agent")).remaining).toBe(0);
    expect((await restarted.meter.consume("k1", 5, "agent")).allowed).toBe(false);
  });

  it("loads once when the first requests of a key arrive together, and lets through no more than the limit", async () => {
    const { store, calls } = memoryStore();
    const { meter: m } = meter(store);
    const results = await Promise.all(Array.from({ length: 6 }, () => m.consume("k1", 2, "agent")));
    expect(calls.loadDay).toBe(1);
    expect(results.filter(result => result.allowed)).toHaveLength(2);
  });

  it("starts a new day at 00:00 UTC with nothing used, and counts the days apart", async () => {
    const { store, rows } = memoryStore();
    const { meter: m, clock } = meter(store);
    clock.now = new Date("2026-10-19T23:59:59Z");
    await m.consume("k1", 1, "agent");
    expect((await m.consume("k1", 1, "agent")).allowed).toBe(false);
    clock.now = new Date("2026-10-20T00:00:00Z");
    const next = await m.consume("k1", 1, "agent");
    expect(next).toMatchObject({ allowed: true, used: 1 });
    expect(next.resetsAt.toISOString()).toBe("2026-10-21T00:00:00.000Z");
    await m.flush();
    expect(Array.from(rows.keys()).sort()).toEqual(["k1|2026-10-19|agent", "k1|2026-10-20|agent"]);
    expect(utcDay(new Date("2026-10-19T23:59:59.999Z"))).toBe("2026-10-19");
  });

  it("writes what it counted as one batch with a row for each key, day and endpoint, and marks the keys used", async () => {
    const { store, calls } = memoryStore();
    const { meter: m } = meter(store);
    await m.consume("k1", 100, "agent");
    await m.consume("k1", 100, "agent");
    await m.consume("k1", 100, "search");
    await m.consume("k2", 100, "agent");
    await m.flush();
    expect(calls.addUsage).toHaveLength(1);
    expect(calls.addUsage[0]!.sort((a, b) => (a.keyId + a.endpoint < b.keyId + b.endpoint ? -1 : 1))).toEqual([
      { keyId: "k1", day: "2026-10-19", endpoint: "agent", count: 2 },
      { keyId: "k1", day: "2026-10-19", endpoint: "search", count: 1 },
      { keyId: "k2", day: "2026-10-19", endpoint: "agent", count: 1 },
    ]);
    expect(calls.touch).toHaveLength(1);
    expect(calls.touch[0]!.keyIds.sort()).toEqual(["k1", "k2"]);
    await m.flush();
    expect(calls.addUsage).toHaveLength(1);
  });

  it("keeps what it could not write and writes it with the next batch, without losing or repeating a count, and does not log the cause's parameters", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, rows, failures } = memoryStore();
    const { meter: m } = meter(store);
    await m.consume("k1", 100, "agent");
    await m.consume("k1", 100, "agent");
    failures.addUsage = 1;
    await m.flush();
    expect(rows.size).toBe(0);
    await m.consume("k1", 100, "agent");
    await m.flush();
    expect(rows.get("k1|2026-10-19|agent")).toBe(3);
    await m.flush();
    expect(rows.get("k1|2026-10-19|agent")).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).not.toContain("secret");
  });

  it("does not write counts twice when only the date of last use could not be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, rows, calls, failures } = memoryStore();
    const { meter: m } = meter(store);
    await m.consume("k1", 100, "agent");
    failures.touch = 1;
    await m.flush();
    expect(rows.get("k1|2026-10-19|agent")).toBe(1);
    await m.flush();
    expect(rows.get("k1|2026-10-19|agent")).toBe(1);
    expect(calls.addUsage).toHaveLength(1);
    expect(calls.touch).toHaveLength(1);
    expect(calls.touch[0]!.keyIds).toEqual(["k1"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("holds a total only for the keys used today: the totals of earlier days are dropped at the next write, and a key that comes back reads its day once", async () => {
    const { store, rows, calls } = memoryStore();
    const { meter: m, clock } = meter(store);
    await m.consume("k1", 100, "agent");
    await m.consume("k2", 100, "agent");
    await m.flush();
    expect(m.trackedKeys()).toBe(2);
    // The next day: nothing is dropped until something is written, and then only what is no longer today's.
    clock.now = new Date("2026-10-20T01:00:00Z");
    expect(m.trackedKeys()).toBe(2);
    await m.consume("k3", 100, "agent");
    await m.flush();
    expect(m.trackedKeys()).toBe(1);
    // k1 comes back: its new day is read from the store, which holds yesterday's rows and none for today.
    const loadsBefore = calls.loadDay;
    expect((await m.consume("k1", 100, "agent")).used).toBe(1);
    expect(calls.loadDay).toBe(loadsBefore + 1);
    await m.flush();
    expect(rows.get("k1|2026-10-19|agent")).toBe(1);
    expect(rows.get("k1|2026-10-20|agent")).toBe(1);
    expect(m.trackedKeys()).toBe(2);
  });

  it("keeps the total of a key used today across writes, so it is not read again and no count is lost", async () => {
    const { store, calls } = memoryStore();
    const { meter: m } = meter(store);
    await m.consume("k1", 100, "agent");
    await m.flush();
    await m.consume("k1", 100, "agent");
    await m.flush();
    expect(calls.loadDay).toBe(1);
    expect(m.trackedKeys()).toBe(1);
    expect((await m.consume("k1", 3, "agent")).remaining).toBe(0);
  });

  it("has written everything counted before a flush returns, even when a write was already under way", async () => {
    const { store, rows } = memoryStore();
    const slowStore: UsageStore = {
      ...store,
      addUsage: async batch => {
        await new Promise(done => setTimeout(done, 20));
        return store.addUsage(batch);
      },
    };
    const { meter: m } = meter(slowStore);
    await m.consume("k1", 100, "agent");
    const underWay = m.flush();
    await m.consume("k1", 100, "agent");
    await m.flush();
    await underWay;
    expect(rows.get("k1|2026-10-19|agent")).toBe(2);
  });
});

describe("what the key module may touch", () => {
  const source = readFileSync(fileURLToPath(new URL("./apiKeys.ts", import.meta.url)), "utf8");

  it("stores no network address: the sign-up limit is held in memory, and the insert names only the key's own columns", () => {
    expect(source).toMatch(/consumeRateLimit\(`api-key-signup:/);
    const insert = source.match(/db\.insert\(apiKeys\)\.values\(\{[^}]*\}\)/)?.[0] ?? "";
    expect(insert).toContain("keyHash: made.hash");
    expect(insert).not.toMatch(/clientKey|ip\b|address/i);
    expect(source).not.toMatch(/ipAddress|remoteAddress|x-forwarded/i);
  });

  it("never throws an error whose text could carry a key or a parameter: the key errors have fixed words", () => {
    const error = new ApiKeyError("TOO_MANY_KEYS");
    expect(error.message).toBe("That email already has the most live keys it may hold. Revoke one first.");
    expect(error.name).toBe("ApiKeyError");
  });
});
