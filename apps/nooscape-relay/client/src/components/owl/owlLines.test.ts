import { describe, expect, it } from "vitest";
import {
  agoText,
  canSay,
  DISMISS_QUIET_MS,
  HOLD_MAX_MS,
  linesFor,
  maySpeak,
  nextLine,
  present,
  SETTLE_MS,
  SHOW_MS,
  SPEAK_GAP_MS,
  TEMPLATES,
  type FactName,
  type OwlFacts,
  type Template,
} from "./owlLines";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Distinctive values, so a line that says one can be told from one that made it up. */
const full: OwlFacts = {
  key: "agent-1",
  tierLabel: "Tier 3 · Domain-control verified",
  observations: 7777,
  lastObservedAt: ago(2 * DAY),
  publisher: "unverified",
  chain: "Robinhood Chain",
  source: "Nooscape owned A2A AgentCard pilot",
  sourceCount: 8888,
};
const without = (name: FactName): OwlFacts => ({ ...full, [name]: null });
const FACTS = Object.keys(full).filter(name => name !== "key") as FactName[];

describe("agoText", () => {
  it("says just now under a minute, and for a time a little ahead of the clock", () => {
    expect(agoText(ago(0), NOW)).toBe("just now");
    expect(agoText(ago(59_999), NOW)).toBe("just now");
    expect(agoText(ago(-3 * MINUTE), NOW)).toBe("just now");
  });

  it("counts minutes, hours and days, singular and plural, each from where the last runs out", () => {
    expect(agoText(ago(MINUTE), NOW)).toBe("1 minute ago");
    expect(agoText(ago(59 * MINUTE + 59_000), NOW)).toBe("59 minutes ago");
    expect(agoText(ago(HOUR), NOW)).toBe("1 hour ago");
    expect(agoText(ago(35 * HOUR + 59 * MINUTE), NOW)).toBe("35 hours ago");
    expect(agoText(ago(36 * HOUR), NOW)).toBe("1 day ago");
    expect(agoText(ago(2 * DAY), NOW)).toBe("2 days ago");
    expect(agoText(ago(59 * DAY + 23 * HOUR), NOW)).toBe("59 days ago");
  });

  it("gives a date in UTC once it is two months back", () => {
    expect(agoText("2026-08-16T01:00:00.000Z", NOW)).toBe("on 16 Aug 2026");
    expect(agoText("2025-01-02T23:59:00.000Z", NOW)).toBe("on 2 Jan 2025");
  });
});

describe("present", () => {
  it("takes a whole number from zero up for a count, and nothing else", () => {
    for (const name of ["observations", "sourceCount"] as const) {
      expect(present({ key: "a", [name]: 0 }, name, NOW)).toBe(true);
      expect(present({ key: "a", [name]: 12 }, name, NOW)).toBe(true);
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, "3" as unknown as number]) expect(present({ key: "a", [name]: bad }, name, NOW), `${name} ${String(bad)}`).toBe(false);
    }
  });

  it("takes text that says something, and no blank", () => {
    for (const name of ["tierLabel", "publisher", "chain", "source"] as const) {
      expect(present({ key: "a", [name]: "Robinhood Chain" }, name, NOW)).toBe(true);
      for (const bad of ["", "   ", null, undefined, 4 as unknown as string]) expect(present({ key: "a", [name]: bad }, name, NOW), `${name} ${String(bad)}`).toBe(false);
    }
  });

  it("takes a time that reads and is not far ahead of the clock", () => {
    expect(present({ key: "a", lastObservedAt: ago(DAY) }, "lastObservedAt", NOW)).toBe(true);
    expect(present({ key: "a", lastObservedAt: ago(-4 * MINUTE) }, "lastObservedAt", NOW)).toBe(true);
    expect(present({ key: "a", lastObservedAt: ago(-6 * MINUTE) }, "lastObservedAt", NOW)).toBe(false);
    expect(present({ key: "a", lastObservedAt: "not a time" }, "lastObservedAt", NOW)).toBe(false);
    expect(present({ key: "a", lastObservedAt: "" }, "lastObservedAt", NOW)).toBe(false);
  });
});

describe("the templates", () => {
  it("each need at least one fact, are named once, and need only facts the owl can be told", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(7);
    expect(new Set(TEMPLATES.map(template => template.id)).size).toBe(TEMPLATES.length);
    for (const template of TEMPLATES) {
      expect(template.needs.length, template.id).toBeGreaterThan(0);
      for (const need of template.needs) expect(FACTS, `${template.id} needs ${need}`).toContain(need);
    }
  });

  it("between them use every fact the owl is told, so none is dead", () => {
    const used = new Set(TEMPLATES.flatMap(template => template.needs));
    expect([...used].sort()).toEqual([...FACTS].sort());
  });

  it("each say the facts they need, as they are", () => {
    const lines = Object.fromEntries(linesFor(full, NOW).map(line => [line.id, line.text]));
    expect(lines.tier).toBe("Evidence on record: Tier 3 · Domain-control verified.");
    expect(lines.observations).toBe("The Owl has kept 7777 observations of this one.");
    expect(lines.seen).toBe("Last seen 2 days ago.");
    expect(lines.publisher).toBe("Publisher: unverified.");
    expect(lines.chain).toBe("Its registry is on Robinhood Chain.");
    expect(lines.source).toBe("Read from Nooscape owned A2A AgentCard pilot.");
    expect(lines.sources).toBe("8888 approved sources have seen it.");
  });

  it("make no claim of their own: take away the facts a line quotes and no number is left", () => {
    for (const line of linesFor({ ...full, lastObservedAt: null }, NOW)) {
      let text = line.text;
      for (const [name, value] of Object.entries(full)) if (name !== "key" && name !== "lastObservedAt") text = text.replaceAll(String(value), "");
      expect(text, line.id).not.toMatch(/\d/);
    }
  });

  it("use the singular for one and zero is a fact like any other", () => {
    const one = Object.fromEntries(linesFor({ ...full, observations: 1, sourceCount: 1 }, NOW).map(line => [line.id, line.text]));
    expect(one.observations).toBe("The Owl has kept 1 observation of this one.");
    expect(one.sources).toBe("1 approved source has seen it.");
    const none = Object.fromEntries(linesFor({ ...full, observations: 0, sourceCount: 0 }, NOW).map(line => [line.id, line.text]));
    expect(none.observations).toBe("The Owl has kept 0 observations of this one.");
    expect(none.sources).toBe("0 approved sources have seen it.");
  });
});

describe("canSay", () => {
  const two: Template = { id: "two", needs: ["observations", "publisher"], say: facts => `${facts.observations} by ${facts.publisher}` };

  it("needs every fact the template names, not some of them", () => {
    expect(canSay(two, full, NOW)).toBe(true);
    expect(canSay(two, { ...full, observations: null }, NOW)).toBe(false);
    expect(canSay(two, { ...full, publisher: null }, NOW)).toBe(false);
    expect(canSay(two, { key: "a" }, NOW)).toBe(false);
  });

  it("needs each of them to be usable, and a template with nothing named is the template's mistake, not a line", () => {
    expect(canSay(two, { ...full, publisher: "  " }, NOW)).toBe(false);
    expect(canSay(two, { ...full, observations: 1.5 }, NOW)).toBe(false);
    expect(canSay({ id: "none", needs: [], say: () => "x" }, { key: "a" }, NOW)).toBe(true);
  });
});

describe("linesFor", () => {
  it("has a line for each template when every fact is there, in the order they are written", () => {
    expect(linesFor(full, NOW).map(line => line.id)).toEqual(TEMPLATES.map(template => template.id));
  });

  it("has nothing for a record it knows nothing about", () => {
    expect(linesFor(null, NOW)).toEqual([]);
    expect(linesFor({ key: "a" }, NOW)).toEqual([]);
  });

  it("loses a line exactly when a fact the line needs is taken away, and only that line", () => {
    for (const name of FACTS) {
      const ids = linesFor(without(name), NOW).map(line => line.id);
      for (const template of TEMPLATES) {
        const needsIt = template.needs.includes(name);
        expect(ids.includes(template.id), `${template.id} without ${name}`).toBe(!needsIt);
      }
    }
  });

  it("loses a line too when a fact is there but unusable", () => {
    expect(linesFor({ ...full, observations: -4 }, NOW).some(line => line.id === "observations")).toBe(false);
    expect(linesFor({ ...full, chain: "  " }, NOW).some(line => line.id === "chain")).toBe(false);
    expect(linesFor({ ...full, lastObservedAt: "yesterday" }, NOW).some(line => line.id === "seen")).toBe(false);
  });
});

describe("nextLine", () => {
  it("is the first line not yet said, then the next, then nothing", () => {
    const said: string[] = [];
    const order: string[] = [];
    for (let step = 0; step < TEMPLATES.length + 2; step += 1) {
      const line = nextLine(full, NOW, said);
      if (!line) break;
      order.push(line.id);
      said.push(line.id);
    }
    expect(order).toEqual(TEMPLATES.map(template => template.id));
    expect(nextLine(full, NOW, said)).toBeNull();
  });

  it("skips what the record cannot say, and ignores what was said about something else", () => {
    expect(nextLine(without("tierLabel"), NOW, [])?.id).toBe("observations");
    expect(nextLine(full, NOW, ["not-a-line"])?.id).toBe("tier");
    expect(nextLine(null, NOW, [])).toBeNull();
    expect(nextLine({ key: "a" }, NOW, [])).toBeNull();
  });
});

describe("maySpeak", () => {
  const base = { now: 100_000, restingSince: 90_000, lastSpokeAt: null, dismissedUntil: null, coarse: false };

  it("is the brief's: one bubble in eight seconds, after a moment at rest, and none on a touch screen", () => {
    expect(SPEAK_GAP_MS).toBe(8_000);
    expect(SHOW_MS).toBeLessThanOrEqual(SPEAK_GAP_MS);
    // A held note waits longer than a free one, but not for ever: it always goes by itself.
    expect(HOLD_MAX_MS).toBeGreaterThan(SHOW_MS);
    expect(HOLD_MAX_MS).toBeLessThanOrEqual(30_000);
    expect(SETTLE_MS).toBeGreaterThan(0);
    expect(DISMISS_QUIET_MS).toBeGreaterThanOrEqual(30_000);
    expect(maySpeak(base)).toBe(true);
    expect(maySpeak({ ...base, coarse: true })).toBe(false);
  });

  it("waits for the owl to be at rest, and for a moment of it", () => {
    expect(maySpeak({ ...base, restingSince: null })).toBe(false);
    expect(maySpeak({ ...base, restingSince: base.now - SETTLE_MS + 1 })).toBe(false);
    expect(maySpeak({ ...base, restingSince: base.now - SETTLE_MS })).toBe(true);
  });

  it("leaves eight seconds between one bubble and the next", () => {
    expect(maySpeak({ ...base, lastSpokeAt: base.now - SPEAK_GAP_MS + 1 })).toBe(false);
    expect(maySpeak({ ...base, lastSpokeAt: base.now - SPEAK_GAP_MS })).toBe(true);
    expect(maySpeak({ ...base, lastSpokeAt: 0 })).toBe(true);
  });

  it("stays quiet about a record that was dismissed, until the quiet is over", () => {
    expect(maySpeak({ ...base, dismissedUntil: base.now + 1 })).toBe(false);
    expect(maySpeak({ ...base, dismissedUntil: base.now })).toBe(true);
    expect(maySpeak({ ...base, dismissedUntil: base.now - 1 })).toBe(true);
  });
});
