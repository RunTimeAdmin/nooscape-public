import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_INTERVAL_MS,
  CHECK_KIND,
  CHECKS_START_WINDOW_MS,
  CHECKABLE_SOURCE_PROTOCOLS,
  dueAddresses,
  factsOf,
  isDue,
  PUBLIC_CHECKS_FAILING_AFTER,
  PUBLIC_CHECKS_MAX,
  readPublicChecks,
  runLivenessChecks,
  type CheckableEndpoint,
  type CheckOutcome,
  type CheckRow,
  type ChecksDeps,
  type LatestCheck,
  type PublicChecksDeps,
} from "./agentChecks";
import { createPoliteFetcher } from "./politeFetch";
import type { SafeFetchOptions, SafeFetchReason, SafeFetchResult } from "./safeFetch";

/**
 * The checks without a database or a network: what a result says, which endpoints are due and in what order, and the run
 * with every dependency replaced. agentChecks.integration.test.ts runs the same code against a real MySQL.
 */
afterEach(() => vi.restoreAllMocks());

const answered = (status: number, over: Partial<Extract<SafeFetchResult, { ok: true }>> = {}): SafeFetchResult => ({
  ok: true,
  url: "https://a.example.com/",
  status,
  headers: {},
  body: Buffer.from("x"),
  truncated: false,
  bodySha256: "ab".repeat(32),
  address: "93.184.216.34",
  tlsProtocol: "TLSv1.3",
  redirects: [],
  latencyMs: 123,
  ...over,
});
const refused = (reason: SafeFetchReason): SafeFetchResult => ({ ok: false, reason, detail: "detail that must not be stored", url: "https://a.example.com/", redirects: [], latencyMs: 77 });

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-16T12:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
const endpoint = (url: string, lastCheckedAt: Date | null = null, over: Partial<CheckableEndpoint> = {}): CheckableEndpoint => ({
  endpointId: `e-${url}`,
  agentId: `agent-${url}`,
  url,
  lastCheckedAt,
  ...over,
});

describe("what a result says", () => {
  it("is an answer for any complete HTTP answer, a 404 and a 500 included, with its status, time and fingerprint", () => {
    for (const status of [200, 204, 301, 401, 404, 500, 503]) {
      expect(factsOf(answered(status)), String(status)).toEqual({ outcome: "answered", reason: null, statusCode: status, latencyMs: 123, bodySha256: "ab".repeat(32) });
    }
  });

  // Typed on every reason, so a reason added to the fetch has to be decided here before this compiles.
  const EXPECTED: Record<SafeFetchReason, CheckOutcome | null> = {
    invalid_url: "skipped",
    not_https: "skipped",
    credentials_in_url: "skipped",
    port_not_allowed: "skipped",
    forbidden_host: "skipped",
    forbidden_address: "skipped",
    redirect_invalid: "skipped",
    too_many_redirects: "skipped",
    robots_disallowed: "skipped",
    robots_unavailable: "skipped",
    unresolvable: "no_answer",
    timeout: "no_answer",
    connection_failed: "no_answer",
    tls_failed: "no_answer",
    response_invalid: "no_answer",
    budget_exhausted: null,
  };

  it.each(Object.entries(EXPECTED))("keeps %s as %s, with the reason and nothing else about the failure", (reason, outcome) => {
    const facts = factsOf(refused(reason as SafeFetchReason));
    if (outcome === null) return expect(facts).toBeNull();
    expect(facts).toEqual({ outcome, reason, statusCode: null, latencyMs: null, bodySha256: null });
  });

  it("is not recorded at all when the run's budget was spent, so the address stays due", () => {
    expect(factsOf(refused("budget_exhausted"))).toBeNull();
  });
});

describe("which endpoints are due", () => {
  it("is every one never checked, and every one whose latest check is a day old, and no other", () => {
    expect(isDue(null, NOW)).toBe(true);
    expect(isDue(new Date(NOW.getTime() - CHECK_INTERVAL_MS), NOW)).toBe(true);
    expect(isDue(new Date(NOW.getTime() - CHECK_INTERVAL_MS + 1), NOW)).toBe(false);
    expect(isDue(ago(1), NOW)).toBe(false);
  });

  it("takes the address never checked first, then the one checked longest ago, and leaves out what is not due", () => {
    const { run, totalDue } = dueAddresses(
      [endpoint("https://c.example.com/", ago(30)), endpoint("https://fresh.example.com/", ago(2)), endpoint("https://a.example.com/", ago(50)), endpoint("https://never.example.com/", null), endpoint("https://b.example.com/", ago(25))],
      NOW,
      40
    );
    expect(run.map(group => group.url)).toEqual(["https://never.example.com/", "https://a.example.com/", "https://c.example.com/", "https://b.example.com/"]);
    expect(totalDue).toBe(4);
  });

  it("asks an address once however many endpoints declare it, and takes it when the latest check of any of them is a day old", () => {
    const shared = "https://shared.example.com/";
    const { run } = dueAddresses([endpoint(shared, ago(30), { endpointId: "one", agentId: "agent-one" }), endpoint(shared, ago(40), { endpointId: "two", agentId: "agent-two" }), endpoint(shared, null, { endpointId: "three", agentId: "agent-three" })], NOW, 40);
    expect(run).toHaveLength(1);
    expect(run[0]!.endpoints.map(item => item.endpointId)).toEqual(["one", "two", "three"]);
    expect(run[0]!.lastCheckedAt).toEqual(ago(30));
    // It is not due while any endpoint that declares it was checked within the day, however old the others are.
    expect(dueAddresses([endpoint(shared, ago(1)), endpoint(shared, ago(50), { endpointId: "other" })], NOW, 40).run).toEqual([]);
  });

  it("does not ask an address again because a new endpoint row declares it: one asked an hour ago is not due", () => {
    const shared = "https://shared.example.com/";
    expect(dueAddresses([endpoint(shared, ago(1)), endpoint(shared, null, { endpointId: "new-row", agentId: "agent-new" })], NOW, 40).run).toEqual([]);
  });

  it("holds back the addresses it is told to, counts them apart from the due ones, and counts only those the database still says are due", () => {
    const { run, totalDue, heldBack } = dueAddresses([endpoint("https://a.example.com/"), endpoint("https://b.example.com/"), endpoint("https://c.example.com/")], NOW, 40, url => url.startsWith("https://b."));
    expect(run.map(group => group.url)).toEqual(["https://a.example.com/", "https://c.example.com/"]);
    expect(totalDue).toBe(2);
    expect(heldBack).toBe(1);
    // An address asked and recorded within the day is held back too, and is not a lost write: the database agrees it is not due.
    expect(dueAddresses([endpoint("https://a.example.com/", ago(1))], NOW, 40, () => true)).toMatchObject({ run: [], totalDue: 0, heldBack: 0 });
  });

  it("deals the addresses out across hosts, one at a time, so a host with many cannot hold up the rest", () => {
    const urls = ["https://a.example.com/1", "https://a.example.com/2", "https://a.example.com/3", "https://b.example.com/1", "https://c.example.com/1"];
    const { run } = dueAddresses(urls.map(url => endpoint(url)), NOW, 40);
    expect(run.map(group => group.url)).toEqual(["https://a.example.com/1", "https://b.example.com/1", "https://c.example.com/1", "https://a.example.com/2", "https://a.example.com/3"]);
    // The same host in another case is the same host.
    expect(dueAddresses([endpoint("https://A.example.com/1"), endpoint("https://a.EXAMPLE.com/2"), endpoint("https://b.example.com/1")], NOW, 40).run.map(group => group.host)).toEqual(["a.example.com", "b.example.com", "a.example.com"]);
  });

  it("is cut at the limit, and says how many were due", () => {
    const many = Array.from({ length: 10 }, (_, index) => endpoint(`https://h${index}.example.com/`, ago(25 + index)));
    const { run, totalDue } = dueAddresses(many, NOW, 4);
    expect(run).toHaveLength(4);
    expect(totalDue).toBe(10);
    // Those cut are the ones checked most recently.
    expect(run.map(group => group.url)).toEqual(["https://h9.example.com/", "https://h8.example.com/", "https://h7.example.com/", "https://h6.example.com/"]);
  });

  it("leaves out an address that is not a URL", () => {
    expect(dueAddresses([endpoint("https://"), endpoint("not a url"), endpoint("https://ok.example.com/")], NOW, 40).run.map(group => group.url)).toEqual(["https://ok.example.com/"]);
  });
});

describe("the limits of a run", () => {
  it("starts no address so late that the last could end after the CDN's minute: a window, and about 25 seconds for one address in the worst case", () => {
    expect(CHECKS_START_WINDOW_MS + 25_000).toBeLessThan(60_000);
  });

  it("asks the endpoints of an A2A source and of no other", () => {
    expect([...CHECKABLE_SOURCE_PROTOCOLS]).toEqual(["a2a"]);
  });
});

describe("a run", () => {
  /** Dependencies for a run with no database and no network. */
  function setup(
    endpoints: CheckableEndpoint[],
    answers: (url: string) => SafeFetchResult | Promise<SafeFetchResult> = () => answered(200),
    over: Partial<ChecksDeps> = {}
  ) {
    const fetched: string[] = [];
    const recorded: CheckRow[] = [];
    let ids = 0;
    let t = 0;
    const deps: Partial<ChecksDeps> = {
      probe: async () => undefined,
      servedAgentIds: async () => Array.from(new Set(endpoints.map(item => item.agentId))),
      endpointsOf: async () => endpoints.map(({ endpointId, agentId, url }) => ({ endpointId, agentId, url })),
      latestChecks: async () => new Map(endpoints.filter(item => item.lastCheckedAt).map(item => [item.endpointId, item.lastCheckedAt!])),
      record: async rows => void recorded.push(...rows),
      fetcher: () =>
        ({
          fetch: async (url: string) => {
            fetched.push(url);
            t += 1;
            return answers(url);
          },
          remainingBudget: () => 100,
          spent: () => fetched.length,
        }) as unknown as ReturnType<ChecksDeps["fetcher"]>,
      now: () => NOW,
      clock: () => t * 1000,
      askedAt: new Map<string, number>(),
      id: () => `id-${(ids += 1)}`,
      ...over,
    };
    return { deps, fetched, recorded, tick: (ms: number) => (t += ms / 1000) };
  }

  it("asks each due address once, and records one row for each endpoint that declares it, with the same facts and the same time", async () => {
    const shared = "https://shared.example.com/";
    const { deps, fetched, recorded } = setup([endpoint(shared, null, { endpointId: "e1", agentId: "a1" }), endpoint(shared, null, { endpointId: "e2", agentId: "a2" }), endpoint("https://solo.example.com/", null, { endpointId: "e3", agentId: "a3" })]);
    const result = await runLivenessChecks(deps);
    expect(fetched.slice().sort()).toEqual([shared, "https://solo.example.com/"]);
    expect(result).toMatchObject({ state: "completed", due: 2, taken: 2, asked: 2, answered: 2, noAnswer: 0, skipped: 0, notReached: 0, recorded: 3, failedToRecord: 0 });
    expect(recorded.map(row => [row.endpointId, row.agentId]).sort()).toEqual([["e1", "a1"], ["e2", "a2"], ["e3", "a3"]]);
    for (const row of recorded) expect(row).toMatchObject({ kind: CHECK_KIND, checkedAt: NOW, outcome: "answered", reason: null, statusCode: 200, latencyMs: 123, bodySha256: "ab".repeat(32) });
    expect(new Set(recorded.map(row => row.id)).size).toBe(3);
  });

  it("records what came back as it came: an answer of any status, a host that did not answer, an ask that a rule stopped", async () => {
    const results: Record<string, SafeFetchResult> = {
      "https://ok.example.com/": answered(404),
      "https://down.example.com/": refused("timeout"),
      "https://optout.example.com/": refused("robots_disallowed"),
    };
    const { deps, recorded } = setup(Object.keys(results).map(url => endpoint(url)), url => results[url]!);
    const result = await runLivenessChecks(deps);
    expect(result).toMatchObject({ state: "completed", asked: 3, answered: 1, noAnswer: 1, skipped: 1, recorded: 3 });
    const by = (id: string) => recorded.find(row => row.endpointId === `e-${id}`)!;
    expect(by("https://ok.example.com/")).toMatchObject({ outcome: "answered", statusCode: 404 });
    expect(by("https://down.example.com/")).toMatchObject({ outcome: "no_answer", reason: "timeout", statusCode: null, latencyMs: null, bodySha256: null });
    expect(by("https://optout.example.com/")).toMatchObject({ outcome: "skipped", reason: "robots_disallowed" });
  });

  it("asks nothing and writes nothing when nothing is due", async () => {
    const make = vi.fn();
    const { deps, fetched, recorded } = setup([endpoint("https://a.example.com/", ago(2))], undefined, { fetcher: make });
    expect(await runLivenessChecks(deps)).toMatchObject({ state: "completed", due: 0, taken: 0, asked: 0, recorded: 0 });
    expect(make).not.toHaveBeenCalled();
    expect(fetched).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("is unavailable, and asks nobody anything, when the checks table cannot be read", async () => {
    const make = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, fetched } = setup([endpoint("https://a.example.com/")], undefined, { probe: async () => Promise.reject(new Error("Table 'x.agent_checks' doesn't exist")), fetcher: make });
    expect(await runLivenessChecks(deps)).toEqual({ state: "unavailable" });
    expect(make).not.toHaveBeenCalled();
    expect(fetched).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain("nooscape_checks_failed");
  });

  it("is unavailable, and asks nobody anything, when what is due cannot be worked out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const failing of ["servedAgentIds", "endpointsOf", "latestChecks"] as const) {
      const make = vi.fn();
      const { deps } = setup([endpoint("https://a.example.com/")], undefined, { [failing]: async () => Promise.reject(new Error("database gone")), fetcher: make });
      expect(await runLivenessChecks(deps), failing).toEqual({ state: "unavailable" });
      expect(make, failing).not.toHaveBeenCalled();
    }
  });

  it("starts no address after its start window, leaves those it did not reach due, and says how many", async () => {
    const urls = Array.from({ length: 12 }, (_, index) => `https://h${index}.example.com/`);
    // Each ask takes 15 seconds on the run's clock, and no address starts after 40: three are started.
    const { deps, fetched, recorded, tick } = setup(urls.map(url => endpoint(url)), () => (tick(15_000), answered(200)), { startWindowMs: 40_000, limit: 12 });
    const result = await runLivenessChecks(deps);
    expect(fetched).toHaveLength(3);
    expect(result).toMatchObject({ state: "completed", due: 12, taken: 12, asked: 3, notReached: 9, recorded: 3 });
    expect(recorded).toHaveLength(3);
  });

  it("stops at once when the budget is spent, records nothing for the address that met it, and leaves the rest due", async () => {
    const urls = Array.from({ length: 8 }, (_, index) => `https://h${index}.example.com/`);
    let calls = 0;
    const { deps, recorded } = setup(urls.map(url => endpoint(url)), () => ((calls += 1) <= 2 ? answered(200) : refused("budget_exhausted")));
    const result = await runLivenessChecks(deps);
    expect(result).toMatchObject({ state: "completed", taken: 8, asked: 2, answered: 2, recorded: 2 });
    expect(result.state === "completed" && result.notReached).toBe(6);
    expect(recorded).toHaveLength(2);
  });

  it("stops the run when a row cannot be written, so nothing more is asked that cannot be recorded; it counts it, logs it once without an address, and never throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const urls = Array.from({ length: 12 }, (_, index) => `https://h${index}.example.com/`);
    const slow = async () => {
      await new Promise(done => setImmediate(done));
      return answered(200);
    };
    const { deps, fetched } = setup(urls.map(url => endpoint(url)), slow, {
      record: async () => {
        throw new Error("Lock wait timeout");
      },
    });
    const result = await runLivenessChecks(deps);
    // Five were already being asked when the first row failed; the other seven were never started.
    expect(result).toMatchObject({ state: "completed", taken: 12, asked: 5, recorded: 0, failedToRecord: 5, notReached: 7 });
    expect(fetched).toHaveLength(5);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).not.toContain("example.com");
  });

  it("answers busy to a second run while one is going, does nothing for it, and runs again once the first is done", async () => {
    let release: (result: SafeFetchResult) => void = () => undefined;
    const held = new Promise<SafeFetchResult>(done => (release = done));
    const { deps, fetched } = setup([endpoint("https://a.example.com/")], () => held);
    const first = runLivenessChecks(deps);
    await new Promise(done => setImmediate(done));
    expect(await runLivenessChecks(setup([endpoint("https://b.example.com/")]).deps)).toEqual({ state: "busy" });
    release(answered(200));
    expect(await first).toMatchObject({ state: "completed", asked: 1 });
    expect(fetched).toEqual(["https://a.example.com/"]);
    expect(await runLivenessChecks(setup([endpoint("https://b.example.com/")]).deps)).toMatchObject({ state: "completed", asked: 1 });
  });

  it("is unavailable, and lets the next run go, when something it leans on throws where it should not", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps } = setup([endpoint("https://a.example.com/")], undefined, {
      fetcher: () => {
        throw new Error("no fetcher");
      },
    });
    expect(await runLivenessChecks(deps)).toEqual({ state: "unavailable" });
    expect(await runLivenessChecks(setup([endpoint("https://b.example.com/")]).deps)).toMatchObject({ state: "completed", asked: 1 });
  });

  it("does not ask the same address again within a day when its row could not be written, run after run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const urls = Array.from({ length: 12 }, (_, index) => `https://h${String(index).padStart(2, "0")}.example.com/`);
    const slow = async () => {
      await new Promise(done => setImmediate(done));
      return answered(200);
    };
    // One memory for the process across runs, and a database that takes every write badly.
    const askedAt = new Map<string, number>();
    const asks: string[][] = [];
    const held: number[] = [];
    let lastResult: Awaited<ReturnType<typeof runLivenessChecks>> | null = null;
    for (let run = 0; run < 4; run += 1) {
      const { deps, fetched } = setup(urls.map(url => endpoint(url)), slow, {
        askedAt,
        record: async () => {
          throw new Error("read-only");
        },
      });
      lastResult = await runLivenessChecks(deps);
      held.push(lastResult.state === "completed" ? lastResult.heldBack : -1);
      asks.push(fetched.slice().sort());
    }
    // Each run reaches addresses the earlier ones did not; no address is asked twice; once all are asked nothing is.
    expect(asks.flat()).toHaveLength(12);
    expect(new Set(asks.flat()).size).toBe(12);
    expect(asks[3]).toEqual([]);
    // And the answer says so: a run with nothing due that is not "nothing is due", and the log has a line for it.
    expect(held).toEqual([0, 5, 10, 12]);
    expect(lastResult).toMatchObject({ state: "completed", due: 0, taken: 0, heldBack: 12 });
    expect(log).toHaveBeenCalledTimes(4);
    expect(String(log.mock.calls[3]![0])).toContain('"heldBack":12');
  });

  it("asks an address again once a day has passed on the process's clock, even if its row was never written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const askedAt = new Map<string, number>();
    const first = setup([endpoint("https://a.example.com/")], undefined, {
      askedAt,
      record: async () => {
        throw new Error("read-only");
      },
    });
    await runLivenessChecks(first.deps);
    expect(first.fetched).toEqual(["https://a.example.com/"]);
    // A run an hour later skips it; one a day later asks it, and forgets the old entry.
    for (const [seconds, expected] of [[3600, 0], [24 * 3600 + 5, 1]] as const) {
      const later = setup([endpoint("https://a.example.com/")], undefined, { askedAt, clock: () => seconds * 1000 });
      await runLivenessChecks(later.deps);
      expect(later.fetched, String(seconds)).toHaveLength(expected);
    }
  });

  it("records a host that is down as no_answer, not skipped, through the real polite fetcher: its robots.txt fails the same way", async () => {
    const hosts: Record<string, SafeFetchReason> = { "down.example.com": "connection_failed", "slow.example.com": "timeout", "badcert.example.com": "tls_failed" };
    // safeFetch's side of the contract the polite fetcher leans on: it asks the hook before each hop and stops if refused.
    const fakeSafeFetch = async (rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> => {
      const url = new URL(rawUrl);
      const reason = hosts[url.hostname];
      if (url.pathname === "/robots.txt") return reason ? refused(reason) : answered(404);
      const allowed = await options.beforeRequest?.({ url, hop: 0 });
      if (allowed && !allowed.ok) return refused(allowed.reason);
      return answered(200);
    };
    const { deps, recorded } = setup(["https://down.example.com/", "https://slow.example.com/", "https://badcert.example.com/", "https://fine.example.com/"].map(url => endpoint(url)), undefined, {
      fetcher: () => createPoliteFetcher({ perHostGapMs: 0 }, { safeFetch: fakeSafeFetch as never }),
    });
    const result = await runLivenessChecks(deps);
    expect(result).toMatchObject({ state: "completed", asked: 4, answered: 1, noAnswer: 3, skipped: 0 });
    const by = (host: string) => recorded.find(row => row.endpointId === `e-https://${host}/`)!;
    expect(by("down.example.com")).toMatchObject({ outcome: "no_answer", reason: "connection_failed" });
    expect(by("slow.example.com")).toMatchObject({ outcome: "no_answer", reason: "timeout" });
    expect(by("badcert.example.com")).toMatchObject({ outcome: "no_answer", reason: "tls_failed" });
    expect(by("fine.example.com")).toMatchObject({ outcome: "answered", statusCode: 200 });
  });

  it("still records an ask that a host's own robots.txt stopped as skipped, and a robots.txt that answered badly as skipped", async () => {
    const fakeSafeFetch = async (rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> => {
      const url = new URL(rawUrl);
      if (url.pathname === "/robots.txt") return url.hostname === "optout.example.com" ? answered(200, { body: Buffer.from("User-agent: *\nDisallow: /") }) : answered(503);
      const allowed = await options.beforeRequest?.({ url, hop: 0 });
      return allowed && !allowed.ok ? refused(allowed.reason) : answered(200);
    };
    const { deps, recorded } = setup(["https://optout.example.com/", "https://broken.example.com/"].map(url => endpoint(url)), undefined, {
      fetcher: () => createPoliteFetcher({ perHostGapMs: 0 }, { safeFetch: fakeSafeFetch as never }),
    });
    expect(await runLivenessChecks(deps)).toMatchObject({ asked: 2, skipped: 2, noAnswer: 0, answered: 0 });
    expect(recorded.map(row => row.reason).sort()).toEqual(["robots_disallowed", "robots_unavailable"]);
  });

  it("logs the reason for a failure and not the query's parameters: a wrapped driver error leads with its cause and its code", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The shape the ORM gives a driver error: the query and its parameters in the message, the driver's own error in `cause`.
    const wrapped = Object.assign(new Error("Failed query: select `id` from `agent_checks` limit ?\nparams: 1"), {
      cause: Object.assign(new Error("Table 'nooscape.agent_checks' doesn't exist"), { code: "ER_NO_SUCH_TABLE" }),
    });
    const { deps } = setup([endpoint("https://secret-host.example.com/")], undefined, { probe: async () => Promise.reject(wrapped) });
    expect(await runLivenessChecks(deps)).toEqual({ state: "unavailable" });
    const line = JSON.parse(String(error.mock.calls[0]![0])) as { event: string; message: string };
    expect(line.event).toBe("nooscape_checks_failed");
    expect(line.message).toContain("ER_NO_SUCH_TABLE");
    expect(line.message).toContain("doesn't exist");
    expect(line.message).not.toContain("params");
    expect(line.message).not.toContain("secret-host");
  });

  it("puts no address in what it returns or logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { deps } = setup([endpoint("https://secret-host.example.com/private/path?key=1")]);
    const result = await runLivenessChecks(deps);
    expect(JSON.stringify(result)).not.toMatch(/example|secret|private|key/);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("nooscape_checks");
    expect(String(log.mock.calls[0]![0])).not.toMatch(/example|secret|private|key=/);
  });
});

describe("what an agent's page shows", () => {
  const endpointOf = (endpointId: string, url: string) => ({ endpointId, agentId: "agent-1", url });
  const latest = (endpointId: string, over: Partial<LatestCheck> = {}): LatestCheck => ({ endpointId, outcome: "answered", statusCode: 200, latencyMs: 120, checkedAt: ago(2), ...over });
  const show = (endpoints: Array<ReturnType<typeof endpointOf>>, rows: LatestCheck[], over: Partial<PublicChecksDeps> = {}) =>
    readPublicChecks("agent-1", { endpointsOf: async () => endpoints, latestRows: async () => rows, ...over });

  it("is the host, the date, and whether it answered with its status and time, and nothing of the address", async () => {
    const shown = await show([endpointOf("e1", "https://API.Example.com/rpc/v1/secret-path?key=hunter2")], [latest("e1")]);
    expect(shown).toEqual([{ host: "api.example.com", checkedAt: ago(2), outcome: "answered", statusCode: 200, latencyMs: 120, failing: false }]);
    expect(JSON.stringify(shown)).not.toMatch(/rpc|secret|hunter2|key=/);
  });

  it("shows a host that did not answer with no status and no time", async () => {
    const rows = [latest("e1", { outcome: "no_answer", statusCode: 503, latencyMs: 9000 })];
    expect(await show([endpointOf("e1", "https://down.example.com/")], rows)).toEqual([{ host: "down.example.com", checkedAt: ago(2), outcome: "no_answer", statusCode: null, latencyMs: null, failing: false }]);
  });

  it("shows an HTTP error as the answer it is, with its status", async () => {
    const [shown] = await show([endpointOf("e1", "https://a.example.com/")], [latest("e1", { statusCode: 503 })]);
    expect(shown).toMatchObject({ outcome: "answered", statusCode: 503 });
  });

  describe("failing: the last three asks of an endpoint, in a row, got no answer", () => {
    const miss = (endpointId: string, hours: number, over: Partial<LatestCheck> = {}) => latest(endpointId, { outcome: "no_answer", statusCode: null, latencyMs: null, checkedAt: ago(hours), ...over });
    const one = async (rows: LatestCheck[]) => (await show([endpointOf("e1", "https://a.example.com/")], rows))[0]!;
    const twoEndpoints = [endpointOf("e1", "https://a.example.com/one"), endpointOf("e2", "https://a.example.com/two")];

    it("waits for three, which is the number the page says", () => {
      expect(PUBLIC_CHECKS_FAILING_AFTER).toBe(3);
    });

    it("is false for one miss and for two, and true for three", async () => {
      expect((await one([miss("e1", 1)])).failing).toBe(false);
      expect((await one([miss("e1", 1), miss("e1", 25)])).failing).toBe(false);
      expect((await one([miss("e1", 1), miss("e1", 25), miss("e1", 49)])).failing).toBe(true);
    });

    it("is true for more than three too, and the line is still the newest ask", async () => {
      const shown = await one([miss("e1", 1), miss("e1", 25), miss("e1", 49), miss("e1", 73), latest("e1", { checkedAt: ago(97) })]);
      expect(shown).toMatchObject({ outcome: "no_answer", failing: true, checkedAt: ago(1) });
    });

    it("is broken by an answer anywhere among the newest three", async () => {
      expect((await one([miss("e1", 1), miss("e1", 25), latest("e1", { checkedAt: ago(49) })])).failing).toBe(false);
      expect((await one([miss("e1", 1), latest("e1", { checkedAt: ago(25) }), miss("e1", 49)])).failing).toBe(false);
    });

    it("is broken by an ask a rule stopped too, because that was not a miss", async () => {
      const stopped = latest("e1", { outcome: "skipped", statusCode: null, latencyMs: null, checkedAt: ago(25) });
      expect((await one([miss("e1", 1), stopped, miss("e1", 49)])).failing).toBe(false);
    });

    it("is never true for a line that answered, whatever came before it", async () => {
      const shown = await one([latest("e1", { checkedAt: ago(1) }), miss("e1", 25), miss("e1", 49), miss("e1", 73)]);
      expect(shown).toMatchObject({ outcome: "answered", failing: false });
    });

    it("goes by when the asks were made, not by the order the rows arrive in: the line is the newest ask, whichever row came first", async () => {
      // Oldest first: the line is the newest miss, and it is failing.
      expect(await one([miss("e1", 49), miss("e1", 25), miss("e1", 1)])).toMatchObject({ outcome: "no_answer", failing: true, checkedAt: ago(1) });
      // An answer between misses, rows shuffled: the newest ask is a miss, and the answer breaks the run.
      expect(await one([latest("e1", { checkedAt: ago(25) }), miss("e1", 49), miss("e1", 1), miss("e1", 73)])).toMatchObject({ outcome: "no_answer", failing: false, checkedAt: ago(1) });
      // The newest ask is an answer and arrives last: it is the line.
      expect(await one([miss("e1", 49), miss("e1", 25), latest("e1", { checkedAt: ago(1) })])).toMatchObject({ outcome: "answered", failing: false, checkedAt: ago(1) });
    });

    it("counts one endpoint's own asks: another endpoint on the same host does not add its misses to them", async () => {
      // Four misses on the host, two for each endpoint: neither endpoint has three.
      const shown = await show(twoEndpoints, [miss("e1", 1), miss("e1", 25), miss("e2", 2), miss("e2", 26)]);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({ outcome: "no_answer", failing: false });
    });

    it("shows the newest ask of the host, whichever endpoint it was for, and counts that endpoint's own", async () => {
      // e1 has three misses and the newest ask; e2 answered a little before it.
      const failing = await show(twoEndpoints, [miss("e1", 1), miss("e1", 25), miss("e1", 49), latest("e2", { checkedAt: ago(2) })]);
      expect(failing[0]).toMatchObject({ outcome: "no_answer", failing: true });
      // The other way round e2 answered last, so the line is an answer and e1's misses are not shown.
      const answeredLast = await show(twoEndpoints, [miss("e1", 3), miss("e1", 27), miss("e1", 51), latest("e2", { checkedAt: ago(1) })]);
      expect(answeredLast[0]).toMatchObject({ outcome: "answered", failing: false });
    });
  });

  it("shows nothing for an ask that a rule stopped, for an outcome it does not know, or for an endpoint never checked", async () => {
    const endpoints = [endpointOf("e1", "https://a.example.com/"), endpointOf("e2", "https://b.example.com/"), endpointOf("e3", "https://c.example.com/")];
    const rows = [latest("e1", { outcome: "skipped", statusCode: null, latencyMs: null }), latest("e2", { outcome: "something-new" })];
    expect(await show(endpoints, rows)).toEqual([]);
  });

  it("shows one line for a host, the latest check of it, and the lines newest first", async () => {
    const endpoints = [endpointOf("e1", "https://a.example.com/one"), endpointOf("e2", "https://a.example.com/two"), endpointOf("e3", "https://b.example.com/"), endpointOf("e4", "https://c.example.com/")];
    const rows = [latest("e1", { checkedAt: ago(30) }), latest("e2", { checkedAt: ago(3), statusCode: 404 }), latest("e3", { checkedAt: ago(1) }), latest("e4", { checkedAt: ago(1) })];
    const shown = await show(endpoints, rows);
    expect(shown.map(check => [check.host, check.statusCode])).toEqual([["b.example.com", 200], ["c.example.com", 200], ["a.example.com", 404]]);
  });

  it("hides a host whose newest check a rule stopped, and no older answer of another endpoint on it stands in", async () => {
    const endpoints = [endpointOf("e1", "https://a.example.com/one"), endpointOf("e2", "https://a.example.com/two")];
    const stopped = (hours: number) => latest("e2", { outcome: "skipped", statusCode: null, latencyMs: null, checkedAt: ago(hours) });
    expect(await show(endpoints, [latest("e1", { checkedAt: ago(20) }), stopped(1)])).toEqual([]);
    // The other way round the newer answer is shown: the newest check of the host settles it.
    const [shown] = await show(endpoints, [latest("e1", { checkedAt: ago(1), statusCode: 204 }), stopped(20)]);
    expect(shown).toMatchObject({ host: "a.example.com", outcome: "answered", statusCode: 204 });
  });

  it("shows one line for a host written with and without the trailing dot that the fetch strips", async () => {
    const shown = await show([endpointOf("e1", "https://t.example.com./x"), endpointOf("e2", "https://t.example.com/y")], [latest("e1", { checkedAt: ago(5) }), latest("e2", { checkedAt: ago(2) })]);
    expect(shown.map(check => check.host)).toEqual(["t.example.com"]);
  });

  it("skips an address that cannot be parsed, and keeps the rest", async () => {
    const shown = await show([endpointOf("e1", "not a url"), endpointOf("e2", "https://a.example.com/")], [latest("e1"), latest("e2")]);
    expect(shown.map(check => check.host)).toEqual(["a.example.com"]);
  });

  it("does not read the checks at all for an agent with nothing to ask", async () => {
    const latestRows = vi.fn(async () => []);
    expect(await show([], [], { latestRows })).toEqual([]);
    expect(latestRows).not.toHaveBeenCalled();
  });

  it("reads at most PUBLIC_CHECKS_MAX endpoints, the same ones each time, and shows at most that many lines", async () => {
    const endpoints = Array.from({ length: PUBLIC_CHECKS_MAX + 5 }, (_, index) => endpointOf(`e${String(index).padStart(2, "0")}`, `https://h${index}.example.com/`)).reverse();
    const latestRows = vi.fn(async (ids: string[]) => ids.map(id => latest(id)));
    const shown = await show(endpoints, [], { latestRows });
    expect(latestRows.mock.calls[0]![0]).toEqual(endpoints.map(endpoint => endpoint.endpointId).sort().slice(0, PUBLIC_CHECKS_MAX));
    expect(shown).toHaveLength(PUBLIC_CHECKS_MAX);
  });

  describe("when the read fails", () => {
    const failing = (error: unknown) => show([endpointOf("e1", "https://a.example.com/")], [], { latestRows: async () => Promise.reject(error) });

    it("answers an empty list and says why once, without the query's parameters or an address", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const driver = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
      const wrapped = Object.assign(new Error("Failed query: select 1\nparams: https://a.example.com/"), { cause: driver });
      expect(await failing(wrapped)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0]!.join(" ");
      expect(line).toContain("agent checks read failed");
      expect(line).toContain("ETIMEDOUT");
      expect(line).not.toMatch(/params|a\.example\.com/);
    });

    it("is silent while the table is not there yet (the migration has not been run), however the driver wraps it", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const driver = Object.assign(new Error("Table 'db.agent_checks' doesn't exist"), { code: "ER_NO_SUCH_TABLE" });
      expect(await failing(Object.assign(new Error("Failed query"), { cause: driver }))).toEqual([]);
      expect(await failing(driver)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("is silent while the connection breaker is open, because the breaker has already said so", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(await failing(Object.assign(new Error("not dialling"), { code: "DB_CIRCUIT_OPEN" }))).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("also answers an empty list when the endpoints cannot be read, and when a thing that is not an error is thrown", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(await readPublicChecks("agent-1", { endpointsOf: async () => Promise.reject(new Error("down")) })).toEqual([]);
      expect(await readPublicChecks("agent-1", { endpointsOf: async () => Promise.reject("a string") })).toEqual([]);
    });
  });
});

/**
 * The rules the page at /checker makes promises about. The code cannot do what it never touches: this module writes one
 * table, its own, and only the operator's token reaches it.
 */
describe("what it can touch", () => {
  const read = (relative: string) => readFileSync(path.resolve(import.meta.dirname, relative), "utf8").replace(/\r\n/g, "\n");
  const module = read("./agentChecks.ts").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("writes the checks table and nothing else: no tier, no listing, no order, no health flag", () => {
    expect([...module.matchAll(/\.insert\(([A-Za-z]+)\)/g)].map(match => match[1])).toEqual(["agentChecks"]);
    // The only delete in it is the process's own Map of what it asked; any other `.delete(` or any `.update(` fails.
    expect(module.replace(/askedAt\.delete\(/g, "")).not.toMatch(/\.update\(|\.delete\(|lastHealth|evidenceTier|agentReadModel|agentPublicSnapshots|hidden|withdraw/i);
  });

  it("is reached by the operator's route and by no public one", () => {
    const router = read("./routers/liveData.ts");
    expect(router).toContain("runChecks: operatorProcedure.mutation(async () => runLivenessChecks())");
    expect(router).not.toMatch(/publicProcedure\s*\.\s*(?:input\([^)]*\)\s*\.\s*)?mutation\([^)]*runLivenessChecks/);
    expect(router.match(/runLivenessChecks/g)).toHaveLength(2);
  });
});
