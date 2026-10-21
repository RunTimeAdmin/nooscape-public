import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSentence, formatWhen, type AgentCheck } from "./checkText";

/**
 * The words a check gets on an agent's page, held to the rules the operator set: a miss is a fact with its date in plain words
 * and says it is retrying, "failing" only after three misses in a row, a 404 or 405 to a plain GET is not a dead address, no
 * number and no score in a miss, and the ask is what got the answer, never the host.
 */
const WHEN = "Oct 16 at 2:10 PM CT";
const check = (over: Partial<AgentCheck> = {}): AgentCheck => ({ host: "agent.example.com", checkedAt: new Date("2026-10-16T19:10:00Z"), outcome: "answered", statusCode: 200, latencyMs: 184, failing: false, ...over });
const miss = (over: Partial<AgentCheck> = {}) => check({ outcome: "no_answer", statusCode: null, latencyMs: null, ...over });
/** Recent ICU puts a narrow no-break space before AM and PM; the words are the same. */
const plain = (text: string) => text.replace(/[  ]/g, " ");

describe("the time of an ask", () => {
  afterEach(() => vi.restoreAllMocks());
  const options = { locale: "en-US", timeZone: "America/Chicago", now: new Date("2026-10-17T12:00:00Z") };

  it("reads in the viewer's time zone as a short date, 'at', the time and the zone: Oct 16 at 2:10 PM CT", () => {
    expect(plain(formatWhen(new Date("2026-10-16T19:10:00Z"), options))).toBe(WHEN);
    expect(plain(formatWhen("2026-10-16T19:10:00Z", options))).toBe(WHEN);
    expect(plain(formatWhen(Date.parse("2026-10-16T19:10:00Z"), options))).toBe(WHEN);
  });

  it("is the same instant in another zone's wall clock, not the server's", () => {
    expect(plain(formatWhen(new Date("2026-10-16T19:10:00Z"), { ...options, timeZone: "America/Los_Angeles" }))).toMatch(/^Oct 16 at 12:10 PM P[DS]?T$/);
  });

  it("names the year only when it is not this year, by the viewer's own calendar", () => {
    expect(plain(formatWhen(new Date("2025-10-16T19:10:00Z"), options))).toBe("Oct 16, 2025 at 2:10 PM CT");
    // 9 PM on 31 December in Chicago is already 1 January in UTC: the zone, not UTC, decides the year.
    const newYear = { ...options, now: new Date("2026-01-02T12:00:00Z") };
    expect(plain(formatWhen(new Date("2026-01-01T03:00:00Z"), newYear))).toBe("Dec 31, 2025 at 9:00 PM CT");
    expect(plain(formatWhen(new Date("2026-01-01T07:00:00Z"), newYear))).toBe("Jan 1 at 1:00 AM CT");
  });

  it("decides the date in the zone it is shown in, not the machine's: an instant that is 31 December in Chicago is 1 January in Auckland", () => {
    const auckland = formatWhen(new Date("2025-12-31T12:00:00Z"), { locale: "en-US", timeZone: "Pacific/Auckland", now: new Date("2026-01-02T12:00:00Z") });
    expect(plain(auckland)).toMatch(/^Jan 1 at 1:00 AM /);
    expect(plain(formatWhen(new Date("2025-12-31T12:00:00Z"), { ...options, now: new Date("2026-01-02T12:00:00Z") }))).toMatch(/^Dec 31, 2025 at 6:00 AM /);
  });

  it("falls back to the plain zone name when the generic one is refused, and to the browser's own format when both are", () => {
    const real = Date.prototype.toLocaleTimeString;
    vi.spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(function (this: Date, locale, opts) {
      if (opts?.timeZoneName === "shortGeneric") throw new RangeError("not supported");
      return real.call(this, locale, opts);
    });
    expect(plain(formatWhen(new Date("2026-10-16T19:10:00Z"), options))).toBe("Oct 16 at 2:10 PM CDT");
    vi.spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(() => {
      throw new RangeError("not supported");
    });
    expect(formatWhen(new Date("2026-10-16T19:10:00Z"), options)).toContain("2026");
  });

  it("says so, in words, when the date cannot be read", () => {
    expect(formatWhen("not a date", options)).toBe("an unknown date");
  });
});

describe("a check that got no answer", () => {
  it("says it in plain words with its date, and that the checker is retrying", () => {
    expect(checkSentence(miss(), WHEN)).toBe("Got no answer on Oct 16 at 2:10 PM CT, retrying.");
  });

  it("says failing only after three in a row, and then says what it is: the last three asks got no answer", () => {
    expect(checkSentence(miss({ failing: true }), WHEN)).toBe("Failing: the last three asks got no answer, the latest on Oct 16 at 2:10 PM CT.");
    expect(checkSentence(miss({ failing: false }), WHEN)).not.toMatch(/failing/i);
  });

  it("has no number and no score in it beyond the date, and no grade", () => {
    for (const failing of [false, true]) {
      const sentence = checkSentence(miss({ failing }), WHEN).replace(WHEN, "");
      expect(sentence).not.toMatch(/\d/);
      expect(sentence).not.toMatch(/\b(?:healthy|unhealthy|alive|dead|offline|online|down|trusted|reliable|uptime|score|percent|bad|good)\b/i);
    }
  });

  it("does not use the status the row carried, if it carried one", () => {
    expect(checkSentence(miss({ statusCode: 503, latencyMs: 9000 }), WHEN)).not.toMatch(/503|9,000|9000/);
  });
});

describe("an answer", () => {
  it("is what the ask got, with its status and time, and when", () => {
    expect(checkSentence(check(), WHEN)).toBe("On Oct 16 at 2:10 PM CT the ask got HTTP 200 in 184 ms.");
    expect(checkSentence(check({ statusCode: 503, latencyMs: 1234 }), WHEN)).toBe("On Oct 16 at 2:10 PM CT the ask got HTTP 503 in 1,234 ms.");
  });

  it("copes with a status or a time the row does not have", () => {
    expect(checkSentence(check({ statusCode: null, latencyMs: null }), WHEN)).toBe("On Oct 16 at 2:10 PM CT the ask got an answer.");
    expect(checkSentence(check({ latencyMs: null }), WHEN)).toBe("On Oct 16 at 2:10 PM CT the ask got HTTP 200.");
  });

  it("does not read as dead when a plain GET got a 404 or a 405: it says a plain GET is not served and that POST is not tested", () => {
    for (const statusCode of [404, 405]) {
      const sentence = checkSentence(check({ statusCode }), WHEN);
      expect(sentence).toContain(`HTTP ${statusCode}`);
      expect(sentence).toContain("a plain GET is not served there");
      expect(sentence).toContain("Nooscape does not send POST, so whether it takes POST is not tested");
      expect(sentence).not.toMatch(/\b(?:dead|down|offline|failing|broken|gone|missing)\b/i);
    }
  });

  it("gives the other client and server errors as the statuses they are, without the GET and POST words", () => {
    for (const statusCode of [400, 401, 403, 500, 502, 503]) {
      const sentence = checkSentence(check({ statusCode }), WHEN);
      expect(sentence).toBe(`On ${WHEN} the ask got HTTP ${statusCode} in 184 ms.`);
      expect(sentence).not.toMatch(/POST|plain GET/);
    }
  });

  it("is a failing line's opposite: an answer is never called failing, even when the row says it is", () => {
    expect(checkSentence(check({ failing: true }), WHEN)).not.toMatch(/failing/i);
  });
});

describe("every line", () => {
  it("says what the ask got and never that the host answered or replied, because the checker follows redirects", () => {
    const all = [check(), check({ statusCode: 404 }), check({ statusCode: 405 }), check({ statusCode: null }), miss(), miss({ failing: true })];
    for (const line of all) expect(checkSentence(line, WHEN)).not.toMatch(/\b(?:answered|replied|responded)\b/i);
  });

  it("uses no long dash", () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const line of [check(), check({ statusCode: 404 }), miss(), miss({ failing: true })]) expect(checkSentence(line, WHEN)).not.toMatch(dashes);
  });
});
