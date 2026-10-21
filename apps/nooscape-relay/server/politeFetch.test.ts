import { afterEach, describe, expect, it, vi } from "vitest";
import { createPoliteFetcher } from "./politeFetch";
import type { SafeFetchOptions, SafeFetchReason, SafeFetchResult } from "./safeFetch";

/**
 * The manners around safeFetch, with safeFetch replaced by one that plays the part the real one plays toward the hook
 * (it asks before each hop and stops if refused) and answers from a table, and with fake timers. No network, no real time.
 */

afterEach(() => vi.useRealTimers());

const ok = (url: string, over: Partial<Extract<SafeFetchResult, { ok: true }>> = {}): SafeFetchResult => ({
  ok: true,
  url,
  status: 200,
  headers: {},
  body: Buffer.from("fine"),
  truncated: false,
  bodySha256: "",
  address: "93.184.216.34",
  tlsProtocol: "TLSv1.3",
  redirects: [],
  latencyMs: 1,
  ...over,
});

type Hold = { release: () => void };

function harness(
  answers: Record<string, (url: URL) => SafeFetchResult> = {},
  config: { hold?: boolean; dns?: boolean } = {}
) {
  const requested: string[] = [];
  const requestedAt: Array<{ host: string; at: number }> = [];
  const robotsRequested: string[] = [];
  const sleeps: number[] = [];
  let calls = 0;
  const seenCalls: Array<{ url: string; options: SafeFetchOptions }> = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const holds: Hold[] = [];
  const safeFetch = async (rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> => {
    calls += 1;
    seenCalls.push({ url: rawUrl, options });
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    try {
      let url = new URL(rawUrl);
      let hop = 0;
      for (;;) {
        // The name lookup the real safeFetch does before it asks the hook.
        if (config.dns) await new Promise<void>(done => setImmediate(done));
        if (options.beforeRequest) {
          const allowed = await options.beforeRequest({ url, hop });
          if (!allowed.ok) return { ok: false, reason: allowed.reason, detail: allowed.detail ?? allowed.reason, url: url.toString(), redirects: [], latencyMs: 0 };
        }
        (url.pathname === "/robots.txt" ? robotsRequested : requested).push(`${url.hostname}${url.pathname}`);
        if (url.pathname !== "/robots.txt") requestedAt.push({ host: url.hostname, at: Date.now() });
        if (config.hold && url.pathname !== "/robots.txt") await new Promise<void>(release => holds.push({ release }));
        const answer = answers[`${url.hostname}${url.pathname}`] ?? answers[url.pathname] ?? (() => ok(url.toString()));
        const result = answer(url);
        if (result.ok && result.status === 302 && result.headers.location) {
          url = new URL(result.headers.location, url);
          hop += 1;
          continue;
        }
        return result;
      }
    } finally {
      inFlight -= 1;
    }
  };
  const fetcher = (options: Parameters<typeof createPoliteFetcher>[0] = {}) =>
    createPoliteFetcher(options, {
      safeFetch,
      sleep: ms => {
        sleeps.push(ms);
        return new Promise<void>(done => setTimeout(done, ms));
      },
    });
  return { fetcher, requested, requestedAt, robotsRequested, sleeps, holds, calls: () => calls, seen: () => seenCalls, mostInFlight: () => mostInFlight, inFlight: () => inFlight };
}

const robotsTxt = (text: string) => (url: URL) => ok(url.toString(), { body: Buffer.from(text) });
const missing = (url: URL) => ok(url.toString(), { status: 404, body: Buffer.from("") });

describe("at once", () => {
  it("runs no more than the limit and starts the next as one finishes", async () => {
    const h = harness({}, { hold: true });
    const polite = h.fetcher({ concurrency: 3, robots: false, perHostGapMs: 0 });
    const calls = Array.from({ length: 8 }, (_, index) => polite.fetch(`https://host${index}.example.com/`));
    await new Promise(done => setImmediate(done));
    expect(h.inFlight()).toBe(3);
    expect(h.holds).toHaveLength(3);
    h.holds.shift()!.release();
    await new Promise(done => setImmediate(done));
    expect(h.inFlight()).toBe(3);
    expect(h.holds).toHaveLength(3);
    while (h.holds.length > 0) {
      h.holds.shift()!.release();
      await new Promise(done => setImmediate(done));
    }
    const results = await Promise.all(calls);
    expect(results.every(result => result.ok)).toBe(true);
    expect(h.mostInFlight()).toBe(3);
  });

  it("defaults to five", async () => {
    const h = harness({}, { hold: true });
    const polite = h.fetcher({ robots: false, perHostGapMs: 0 });
    const calls = Array.from({ length: 9 }, (_, index) => polite.fetch(`https://host${index}.example.com/`));
    await new Promise(done => setImmediate(done));
    expect(h.inFlight()).toBe(5);
    while (h.holds.length > 0 || h.inFlight() > 0) {
      h.holds.shift()?.release();
      await new Promise(done => setImmediate(done));
    }
    await Promise.all(calls);
    expect(h.mostInFlight()).toBe(5);
  });
});

describe("at one host", () => {
  it("leaves the gap between two requests, however they arrive, and does not make another host wait", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const h = harness();
    const polite = h.fetcher({ robots: false, perHostGapMs: 1000 });
    const calls = [polite.fetch("https://a.example.com/1"), polite.fetch("https://a.example.com/2"), polite.fetch("https://a.example.com/3"), polite.fetch("https://b.example.org/1")];
    await vi.advanceTimersByTimeAsync(2500);
    await Promise.all(calls);
    expect(h.requested).toHaveLength(4);
    const at = (host: string) => h.requestedAt.filter(request => request.host === host).map(request => request.at - started);
    // The three to a.example.com went a gap apart, however together they were asked for, and the first did not wait.
    expect(at("a.example.com")).toEqual([0, 1000, 2000]);
    // Another host was not held up by them.
    expect(at("b.example.org")).toEqual([0]);
    expect(h.sleeps).toEqual([1000, 2000]);
  });

  it("is not made to wait for a host it asked long ago, and is a gap away from one it has just asked", async () => {
    vi.useFakeTimers();
    const h = harness();
    const polite = h.fetcher({ robots: false, perHostGapMs: 1000 });
    await polite.fetch("https://a.example.com/1");
    await vi.advanceTimersByTimeAsync(5000);
    await polite.fetch("https://a.example.com/2");
    expect(h.sleeps).toEqual([]);
    const third = polite.fetch("https://a.example.com/3");
    await vi.advanceTimersByTimeAsync(1000);
    await third;
    expect(h.sleeps).toEqual([1000]);
  });
});

describe("the options", () => {
  it("cannot go past five at once, and a number that is not a number is not a limit", async () => {
    for (const concurrency of [50, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const h = harness({}, { hold: true });
      const polite = h.fetcher({ concurrency, robots: false, perHostGapMs: 0 });
      const calls = Array.from({ length: 9 }, (_, index) => polite.fetch(`https://host${index}.example.com/`));
      await new Promise(done => setImmediate(done));
      expect(h.inFlight(), String(concurrency)).toBe(5);
      while (h.holds.length > 0 || h.inFlight() > 0) {
        h.holds.shift()?.release();
        await new Promise(done => setImmediate(done));
      }
      await Promise.all(calls);
    }
  });

  it("holds the budget and the gap to their ceilings: a huge gap is a minute, not a timer that fires at once", async () => {
    vi.useFakeTimers();
    const h = harness();
    const polite = h.fetcher({ budget: 1e9, perHostGapMs: 2 ** 31, robots: false });
    expect(polite.remainingBudget()).toBe(1000);
    await polite.fetch("https://a.example.com/1");
    const second = polite.fetch("https://a.example.com/2");
    await vi.advanceTimersByTimeAsync(60_000);
    await second;
    expect(h.sleeps).toEqual([60_000]);
  });

  it("gives a budget that is not a number the default, and a gap that is not a number the default", async () => {
    vi.useFakeTimers();
    const h = harness();
    const polite = h.fetcher({ budget: Number.POSITIVE_INFINITY, perHostGapMs: Number.NaN, robots: false });
    expect(polite.remainingBudget()).toBe(200);
    await polite.fetch("https://a.example.com/1");
    const second = polite.fetch("https://a.example.com/2");
    await vi.advanceTimersByTimeAsync(1000);
    await second;
    expect(h.sleeps).toEqual([1000]);
  });
});

describe("the budget", () => {
  it("covers the whole run, and a fetch that finds it spent is refused with nothing sent", async () => {
    const h = harness();
    const polite = h.fetcher({ robots: false, budget: 3, perHostGapMs: 0 });
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await polite.fetch(`https://host${i}.example.com/`));
    expect(results.map(result => (result.ok ? "ok" : result.reason))).toEqual(["ok", "ok", "ok", "budget_exhausted", "budget_exhausted"]);
    expect(h.requested).toHaveLength(3);
    expect(polite.remainingBudget()).toBe(0);
    expect(polite.spent()).toBe(3);
  });

  it("does no work at all for a fetch when the run has nothing left, not even a name lookup", async () => {
    const h = harness();
    const polite = h.fetcher({ robots: false, budget: 1, perHostGapMs: 0 });
    expect(await polite.fetch("https://a.example.com/")).toMatchObject({ ok: true });
    expect(h.calls()).toBe(1);
    expect(await polite.fetch("https://b.example.org/")).toMatchObject({ ok: false, reason: "budget_exhausted" });
    expect(h.calls()).toBe(1);
    // With robots.txt on, a spent run does not ask for any host's robots.txt either.
    const robotsOn = harness({ "/robots.txt": missing });
    const spent = robotsOn.fetcher({ budget: 0, perHostGapMs: 0 });
    expect(await spent.fetch("https://c.example.net/")).toMatchObject({ ok: false, reason: "budget_exhausted" });
    expect(robotsOn.calls()).toBe(0);
  });

  it("refuses a fetch at once when the run has nothing left, without waiting for a place", async () => {
    const h = harness({}, { hold: true });
    const polite = h.fetcher({ concurrency: 1, robots: false, budget: 1, perHostGapMs: 0 });
    // The first spends the only request and is held, with the only place.
    const first = polite.fetch("https://a.example.com/");
    await new Promise(done => setImmediate(done));
    const second = polite.fetch("https://b.example.org/");
    const outcome = await Promise.race([second.then(() => "refused"), new Promise(done => setTimeout(() => done("waiting"), 30))]);
    expect(outcome).toBe("refused");
    h.holds.shift()!.release();
    await first;
  });

  it("refuses a fetch that was waiting for a place when the run ran out, without a name lookup", async () => {
    const h = harness({}, { dns: true });
    const polite = h.fetcher({ concurrency: 1, robots: false, budget: 1, perHostGapMs: 0 });
    const results = await Promise.all([polite.fetch("https://a.example.com/"), polite.fetch("https://b.example.org/")]);
    expect(results.map(result => (result.ok ? "ok" : result.reason))).toEqual(["ok", "budget_exhausted"]);
    expect(h.calls()).toBe(1);
  });

  it("asks no name server for a robots.txt once the run has nothing left, even half way along a redirect", async () => {
    const h = harness({
      "a.example.com/start": url => ok(url.toString(), { status: 302, headers: { location: "https://b.example.org/end" } }),
      "/robots.txt": missing,
    });
    const polite = h.fetcher({ budget: 2, perHostGapMs: 0 });
    expect(await polite.fetch("https://a.example.com/start")).toMatchObject({ ok: false, reason: "budget_exhausted" });
    // The first host's robots.txt and the first page took the budget. The second host's robots.txt was never asked for.
    expect(h.robotsRequested).toEqual(["a.example.com/robots.txt"]);
    expect(h.calls()).toBe(2);
  });

  it("counts the robots.txt of a host as a request of its own", async () => {
    const h = harness({ "/robots.txt": missing });
    const polite = h.fetcher({ budget: 4, perHostGapMs: 0 });
    const results = [];
    for (const url of ["https://a.example.com/x", "https://b.example.org/y", "https://c.example.net/z"]) results.push(await polite.fetch(url));
    // Two hosts cost two requests each; the third host cannot afford its robots.txt.
    expect(results.map(result => (result.ok ? "ok" : result.reason))).toEqual(["ok", "ok", "budget_exhausted"]);
    expect(h.robotsRequested).toEqual(["a.example.com/robots.txt", "b.example.org/robots.txt"]);
    expect(h.requested).toEqual(["a.example.com/x", "b.example.org/y"]);
  });

  it("does not let a run that has spent its fetches remember a host as unreadable", async () => {
    const h = harness({ "/robots.txt": missing });
    const polite = h.fetcher({ budget: 1, perHostGapMs: 0 });
    expect(await polite.fetch("https://a.example.com/x")).toMatchObject({ ok: false, reason: "budget_exhausted" });
    const fresh = h.fetcher({ budget: 5, perHostGapMs: 0 });
    expect(await fresh.fetch("https://a.example.com/x")).toMatchObject({ ok: true });
  });
});

describe("robots.txt", () => {
  it("is read once for a host, before the first thing is asked of it", async () => {
    const h = harness({ "/robots.txt": missing });
    const polite = h.fetcher({ perHostGapMs: 0 });
    await polite.fetch("https://a.example.com/one");
    await polite.fetch("https://a.example.com/two");
    expect(h.robotsRequested).toEqual(["a.example.com/robots.txt"]);
    expect(h.requested).toEqual(["a.example.com/one", "a.example.com/two"]);
  });

  it("stops a fetch the host disallows, with nothing asked of the page", async () => {
    const h = harness({ "/robots.txt": robotsTxt("User-agent: *\nDisallow: /private") });
    const polite = h.fetcher({ perHostGapMs: 0 });
    expect(await polite.fetch("https://a.example.com/private/x")).toMatchObject({ ok: false, reason: "robots_disallowed" });
    expect(await polite.fetch("https://a.example.com/open")).toMatchObject({ ok: true });
    expect(h.requested).toEqual(["a.example.com/open"]);
  });

  it("stops a fetch when the host's robots.txt cannot be read, and says so", async () => {
    const h = harness({ "/robots.txt": url => ok(url.toString(), { status: 503 }) });
    const polite = h.fetcher({ perHostGapMs: 0 });
    expect(await polite.fetch("https://a.example.com/x")).toMatchObject({ ok: false, reason: "robots_unavailable" });
    expect(h.requested).toEqual([]);
  });

  it("gives the host's own reason when robots.txt could not be fetched because of the host: refused, not resolving, or not answering", async () => {
    const reasons: SafeFetchReason[] = ["forbidden_host", "forbidden_address", "unresolvable", "timeout", "connection_failed", "tls_failed", "response_invalid"];
    for (const reason of reasons) {
      const h = harness({ "/robots.txt": url => ({ ok: false, reason, detail: reason, url: url.toString(), redirects: [], latencyMs: 0 }) });
      const polite = h.fetcher({ perHostGapMs: 0 });
      expect(await polite.fetch("https://a.example.com/x"), reason).toMatchObject({ ok: false, reason });
    }
    // A robots.txt that answered badly is a robots matter, not the host's: a 5xx, a 429, a file too long, a redirect to anything but a robots.txt.
    const sent = harness({ "/robots.txt": url => ({ ok: false, reason: "redirect_invalid", detail: "sent elsewhere", url: url.toString(), redirects: [], latencyMs: 0 }) });
    expect(await sent.fetcher({ perHostGapMs: 0 }).fetch("https://a.example.com/x")).toMatchObject({ ok: false, reason: "robots_unavailable" });
    for (const status of [429, 500, 503]) {
      const answered = harness({ "/robots.txt": url => ok(url.toString(), { status }) });
      expect(await answered.fetcher({ perHostGapMs: 0 }).fetch("https://a.example.com/x"), String(status)).toMatchObject({ ok: false, reason: "robots_unavailable" });
    }
  });

  it("does not let a robots.txt send the fetch anywhere but to a robots.txt: nothing is asked of a path another host never had a say in", async () => {
    const h = harness({
      "a.example.com/robots.txt": url => ok(url.toString(), { status: 302, headers: { location: "https://victim.example/private/delete?id=1" } }),
      "victim.example/robots.txt": robotsTxt("User-agent: *\nDisallow: /"),
    });
    const polite = h.fetcher({ perHostGapMs: 0 });
    expect(await polite.fetch("https://a.example.com/x")).toMatchObject({ ok: false, reason: "robots_unavailable" });
    expect([...h.requested, ...h.robotsRequested].filter(entry => entry.startsWith("victim.example"))).toEqual([]);
    expect(h.requested).toEqual([]);
    // A query on the robots.txt it is sent to is not a robots.txt either.
    const query = harness({ "a.example.com/robots.txt": url => ok(url.toString(), { status: 302, headers: { location: "https://b.example.org/robots.txt?x=1" } }) });
    expect(await query.fetcher({ perHostGapMs: 0 }).fetch("https://a.example.com/x")).toMatchObject({ ok: false, reason: "robots_unavailable" });
    expect(query.robotsRequested).toEqual(["a.example.com/robots.txt"]);
  });

  it("lets a robots.txt move to the robots.txt of another host, which is what example.com to www.example.com is", async () => {
    const h = harness({
      "example.com/robots.txt": url => ok(url.toString(), { status: 302, headers: { location: "https://www.example.com/robots.txt" } }),
      "www.example.com/robots.txt": robotsTxt("User-agent: *\nDisallow: /private"),
    });
    const polite = h.fetcher({ perHostGapMs: 0 });
    expect(await polite.fetch("https://example.com/private/x")).toMatchObject({ ok: false, reason: "robots_disallowed" });
    expect(await polite.fetch("https://example.com/open")).toMatchObject({ ok: true });
    expect(h.robotsRequested).toEqual(["example.com/robots.txt", "www.example.com/robots.txt"]);
  });

  it("asks for a robots.txt with no more than one redirect and no more than 64 KiB", async () => {
    const h = harness({ "/robots.txt": missing });
    await h.fetcher({ perHostGapMs: 0 }).fetch("https://a.example.com/x");
    const call = h.seen().find(entry => entry.url.endsWith("/robots.txt"));
    expect(call?.options).toMatchObject({ maxRedirects: 1, maxBodyBytes: 64 * 1024 });
  });

  it("is not read at all when the caller has the host's leave", async () => {
    const h = harness({ "/robots.txt": robotsTxt("User-agent: *\nDisallow: /") });
    const polite = h.fetcher({ robots: false, perHostGapMs: 0 });
    expect(await polite.fetch("https://a.example.com/x")).toMatchObject({ ok: true });
    expect(h.robotsRequested).toEqual([]);
  });

  it("is read for each host a redirect goes to, which also spends budget and takes its turn there", async () => {
    const h = harness({
      "a.example.com/start": url => ok(url.toString(), { status: 302, headers: { location: "https://b.example.org/end" } }),
      "b.example.org/robots.txt": robotsTxt("User-agent: *\nDisallow: /end"),
    });
    const polite = h.fetcher({ perHostGapMs: 0 });
    expect(await polite.fetch("https://a.example.com/start")).toMatchObject({ ok: false, reason: "robots_disallowed" });
    expect(h.robotsRequested).toEqual(["a.example.com/robots.txt", "b.example.org/robots.txt"]);
    // The first host, its robots.txt, the page, the second host's robots.txt: four requests.
    expect(polite.spent()).toBe(3);
  });
});
