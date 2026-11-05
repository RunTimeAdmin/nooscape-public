import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ageText, databaseState, FRESHNESS_HOURS, overall, paymentsState, summarizeSources, type SourceReading } from "./statusModel";

const app = fileURLToPath(new URL("../../..", import.meta.url));
const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * HOUR);

const source = (over: Partial<SourceReading> = {}): SourceReading => ({
  sourceKey: "k",
  label: "A source",
  protocol: "erc8004",
  state: "active",
  executionPolicy: "scheduled",
  failureCount: 0,
  lastSuccessfulAt: ago(1),
  ...over,
});

describe("the limits", () => {
  it("are the ones the live check holds the same sources to", () => {
    const script = readFileSync(join(app, "scripts", "verify-live.mjs"), "utf8");
    const block = /const FRESHNESS_HOURS = \{([\s\S]*?)\n\};/.exec(script)?.[1] ?? "";
    const table = Object.fromEntries(Array.from(block.replace(/\/\/.*$/gm, "").matchAll(/(\w+):\s*(\d+)/g), match => [match[1]!, Number(match[2])]));
    expect(Object.keys(table).length).toBeGreaterThan(8);
    expect(FRESHNESS_HOURS).toEqual(table);
  });
});

describe("summarizeSources", () => {
  it("counts a scheduled active source with a recent read as on time", () => {
    expect(summarizeSources([source()], NOW)).toEqual({ judged: 1, onTime: 1, late: [], failing: [] });
  });

  it("calls a read older than the limit late, and one exactly at the limit on time", () => {
    const limit = FRESHNESS_HOURS.erc8004!;
    expect(summarizeSources([source({ lastSuccessfulAt: ago(limit) })], NOW).late).toEqual([]);
    const late = summarizeSources([source({ label: "Slow", lastSuccessfulAt: ago(limit + 0.5) })], NOW);
    expect(late.onTime).toBe(0);
    expect(late.late).toEqual([{ label: "Slow", hoursAgo: limit + 0.5, limitHours: limit }]);
  });

  it("uses each protocol's own limit", () => {
    const readings = [source({ protocol: "catalog", lastSuccessfulAt: ago(30), label: "Daily" }), source({ protocol: "erc8004_arc", lastSuccessfulAt: ago(13), label: "Arc" })];
    expect(summarizeSources(readings, NOW).late.map(item => item.label)).toEqual(["Arc"]);
  });

  it("calls a source that never succeeded late, with no age", () => {
    expect(summarizeSources([source({ lastSuccessfulAt: null })], NOW).late).toEqual([{ label: "A source", hoursAgo: null, limitHours: 3 }]);
  });

  it("does not judge a source that is paused, in review, run by hand or has no limit", () => {
    const readings = [
      source({ state: "paused", lastSuccessfulAt: ago(500) }),
      source({ state: "review", lastSuccessfulAt: null }),
      source({ executionPolicy: "manual_only", lastSuccessfulAt: ago(500) }),
      source({ protocol: "solana_agenc", lastSuccessfulAt: ago(500) }),
    ];
    expect(summarizeSources(readings, NOW)).toEqual({ judged: 0, onTime: 0, late: [], failing: [] });
  });

  it("lists recorded failures of a judged source, late or not", () => {
    const result = summarizeSources([source({ label: "Flaky", failureCount: 2 }), source({ label: "Quiet", state: "paused", failureCount: 5 })], NOW);
    expect(result.failing).toEqual([{ label: "Flaky", failures: 2 }]);
    expect(result.onTime).toBe(1);
  });

  it("reads a date given as text", () => {
    expect(summarizeSources([source({ lastSuccessfulAt: ago(1).toISOString() })], NOW).onTime).toBe(1);
  });
});

describe("paymentsState", () => {
  it("is off when the index has no count, clear at zero, waiting above it, and unknown when it cannot be read", () => {
    expect(paymentsState({})).toEqual({ kind: "off" });
    expect(paymentsState({ payments_unresolved_over_hour: 0 })).toEqual({ kind: "clear" });
    expect(paymentsState({ payments_unresolved_over_hour: 3 })).toEqual({ kind: "waiting", count: 3 });
    expect(paymentsState({ payments_unresolved_over_hour: null })).toEqual({ kind: "unknown" });
    expect(paymentsState({ payments_unresolved_over_hour: Number.NaN })).toEqual({ kind: "unknown" });
    expect(paymentsState(undefined)).toEqual({ kind: "unknown" });
  });
});

describe("the live check", () => {
  it("reads the room the status page reads, from the same index, and fails on critical only", () => {
    const script = readFileSync(join(app, "scripts", "verify-live.mjs"), "utf8");
    expect(script).toContain("index.database_room");
    expect(script).toContain('room === "critical") check("the database has room", false, "over 85 percent of its limit: every write stops at the limit");');
    expect(script).toContain('"over 70 percent of its limit: read the biggest tables and plan the ceilings", "warn"');
  });
});

describe("databaseState", () => {
  it("reads the one word the index carries, and anything else, or nothing, as not read", () => {
    expect(databaseState({ database_room: "ok" })).toEqual({ kind: "ok" });
    expect(databaseState({ database_room: "low" })).toEqual({ kind: "low" });
    expect(databaseState({ database_room: "critical" })).toEqual({ kind: "critical" });
    for (const index of [undefined, {}, { database_room: null }, { database_room: "" }, { database_room: "full" }, { database_room: "OK" }]) {
      expect(databaseState(index as never)).toEqual({ kind: "unknown" });
    }
  });
});

describe("overall", () => {
  const fine = summarizeSources([source(), source({ protocol: "catalog" })], NOW);

  it("says the database is getting full or nearly full, after a late source, a failing one and a waiting payment, and only then", () => {
    expect(overall(fine, { kind: "clear" }, { kind: "low" })).toEqual({ level: "attention", headline: "The database is getting full." });
    expect(overall(fine, { kind: "clear" }, { kind: "critical" })).toEqual({ level: "attention", headline: "The database is nearly full." });
    expect(overall(fine, { kind: "waiting", count: 1 }, { kind: "critical" }).headline).toBe("Pay per call needs attention.");
    const late = summarizeSources([source({ lastSuccessfulAt: ago(9) })], NOW);
    expect(overall(late, { kind: "clear" }, { kind: "critical" }).headline).toBe("One scheduled source is late.");
  });

  it("does not let a room that is fine, or could not be read, change the headline", () => {
    expect(overall(fine, { kind: "clear" }, { kind: "ok" })).toEqual({ level: "ok", headline: "Everything checked is on schedule." });
    expect(overall(fine, { kind: "clear" }, { kind: "unknown" })).toEqual({ level: "ok", headline: "Everything checked is on schedule." });
    expect(overall(fine, { kind: "clear" }, null).level).toBe("ok");
  });

  it("says everything is on schedule only when every part was read and fine", () => {
    expect(overall(fine, { kind: "clear" })).toEqual({ level: "ok", headline: "Everything checked is on schedule." });
    expect(overall(fine, { kind: "off" }).level).toBe("ok");
  });

  it("says a part could not be read when it could not, and never counts it as fine", () => {
    expect(overall(null, null)).toEqual({ level: "unknown", headline: "Status could not be read just now." });
    expect(overall(null, { kind: "unknown" }).level).toBe("unknown");
    expect(overall(fine, null).level).toBe("unknown");
    expect(overall(fine, { kind: "unknown" }).headline).toBe("Part of the status could not be read just now.");
    expect(overall(null, { kind: "clear" }).level).toBe("unknown");
  });

  it("says a source is late, in the singular and the plural, before anything else", () => {
    const one = summarizeSources([source({ lastSuccessfulAt: ago(9) })], NOW);
    const two = summarizeSources([source({ lastSuccessfulAt: ago(9) }), source({ label: "B", lastSuccessfulAt: ago(9) })], NOW);
    expect(overall(one, { kind: "waiting", count: 1 })).toEqual({ level: "attention", headline: "One scheduled source is late." });
    expect(overall(two, null).headline).toBe("2 scheduled sources are late.");
  });

  it("says recorded failures and waiting payments need attention", () => {
    expect(overall(summarizeSources([source({ failureCount: 1 })], NOW), { kind: "clear" }).headline).toBe("A scheduled source has recorded failures.");
    expect(overall(fine, { kind: "waiting", count: 2 })).toEqual({ level: "attention", headline: "Pay per call needs attention." });
  });

  it("does not say fine when no scheduled source was judged", () => {
    expect(overall(summarizeSources([], NOW), { kind: "clear" })).toEqual({ level: "unknown", headline: "No scheduled source was found to check." });
  });
});

describe("ageText", () => {
  it("says how long ago in words", () => {
    expect(ageText(null)).toBe("never");
    expect(ageText(Number.NaN)).toBe("never");
    expect(ageText(0.01)).toBe("just now");
    expect(ageText(0.5)).toBe("30 minutes ago");
    expect(ageText(3.24)).toBe("3.2 hours ago");
    expect(ageText(40)).toBe("40 hours ago");
    expect(ageText(96)).toBe("4 days ago");
  });
});
