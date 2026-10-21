import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createRobotsGate, parseRobots, robotsAllows, ROBOTS_MAX_BYTES, ROBOTS_MAX_PATTERN_CHARS, ROBOTS_MAX_RULES } from "./robots";
import type { SafeFetchResult } from "./safeFetch";

const allows = (text: string, path: string) => robotsAllows(parseRobots(text), path);

describe("which group is read", () => {
  it("allows everything when there is no group for this visitor or for everyone", () => {
    expect(allows("User-agent: Googlebot\nDisallow: /", "/anything")).toBe(true);
    expect(allows("", "/anything")).toBe(true);
    expect(allows("# only a comment", "/anything")).toBe(true);
  });

  it("uses the group for everyone when none names this visitor", () => {
    expect(allows("User-agent: *\nDisallow: /private", "/private/x")).toBe(false);
    expect(allows("User-agent: *\nDisallow: /private", "/public")).toBe(true);
  });

  it("uses the group that names this visitor, and then ignores the one for everyone", () => {
    const text = "User-agent: *\nDisallow: /\n\nUser-agent: Nooscape-Checker\nAllow: /";
    expect(allows(text, "/status")).toBe(true);
    expect(allows("User-agent: *\nAllow: /\n\nUser-agent: nooscape-checker\nDisallow: /", "/status")).toBe(false);
  });

  it("answers to Nooscape and to Nooscape-Checker, with or without a version, in any case", () => {
    for (const name of ["Nooscape-Checker", "nooscape-checker", "NOOSCAPE-CHECKER/1.0", "Nooscape", "nooscape/2"]) {
      expect(allows(`User-agent: ${name}\nDisallow: /`, "/x"), name).toBe(false);
    }
    // A name that only starts like it does not count.
    expect(allows("User-agent: Noo\nDisallow: /", "/x")).toBe(true);
    expect(allows("User-agent: Nooscape-Checker-Pro\nDisallow: /", "/x")).toBe(true);
  });

  it("shares one group between consecutive User-agent lines, and starts another after a rule", () => {
    const text = "User-agent: Googlebot\nUser-agent: Nooscape-Checker\nDisallow: /shared\n\nUser-agent: Bingbot\nDisallow: /bing";
    expect(allows(text, "/shared/x")).toBe(false);
    expect(allows(text, "/bing/x")).toBe(true);
    const split = "User-agent: Googlebot\nDisallow: /g\nUser-agent: Nooscape-Checker\nDisallow: /n";
    expect(allows(split, "/g")).toBe(true);
    expect(allows(split, "/n")).toBe(false);
  });

  it("joins the rules of every group that names this visitor", () => {
    const text = "User-agent: Nooscape-Checker\nDisallow: /a\n\nUser-agent: Nooscape\nDisallow: /b";
    expect(allows(text, "/a")).toBe(false);
    expect(allows(text, "/b")).toBe(false);
    expect(allows(text, "/c")).toBe(true);
  });
});

describe("which rule wins", () => {
  it("is the longest pattern, and an Allow wins a tie", () => {
    const text = "User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /a/b/c";
    expect(allows(text, "/a/x")).toBe(false);
    expect(allows(text, "/a/b/x")).toBe(true);
    expect(allows(text, "/a/b/c/d")).toBe(false);
    expect(allows("User-agent: *\nDisallow: /p\nAllow: /p", "/p")).toBe(true);
    expect(allows("User-agent: *\nAllow: /p\nDisallow: /p", "/p")).toBe(true);
  });

  it("reads * as any run of characters and a trailing $ as the end", () => {
    const text = "User-agent: *\nDisallow: /*.json$\nDisallow: /tmp*/x\nAllow: /*.json$";
    expect(allows("User-agent: *\nDisallow: /*.json$", "/data/file.json")).toBe(false);
    expect(allows("User-agent: *\nDisallow: /*.json$", "/data/file.json?x=1")).toBe(true);
    expect(allows("User-agent: *\nDisallow: /*.json$", "/data/file.jsonl")).toBe(true);
    expect(allows("User-agent: *\nDisallow: /tmp*/x", "/tmp123/x/y")).toBe(false);
    expect(allows(text, "/data/file.json")).toBe(true);
  });

  it("matches a path as a prefix, with the query, and treats the characters of a pattern as themselves", () => {
    expect(allows("User-agent: *\nDisallow: /api", "/api/v1?x=1")).toBe(false);
    expect(allows("User-agent: *\nDisallow: /api?key=", "/api?key=abc")).toBe(false);
    expect(allows("User-agent: *\nDisallow: /a.b", "/aXb")).toBe(true);
    expect(allows("User-agent: *\nDisallow: /a+b(c)", "/a+b(c)")).toBe(false);
  });

  it("disallows nothing with an empty Disallow, and ignores what it does not know", () => {
    expect(allows("User-agent: *\nDisallow:", "/anything")).toBe(true);
    expect(allows("User-agent: *\nCrawl-delay: 10\nSitemap: https://x.test/s.xml\nDisallow: /no", "/no")).toBe(false);
    expect(allows("Disallow: /\nUser-agent: *\nAllow: /", "/x")).toBe(true);
    expect(allows("USER-AGENT: *\nDISALLOW: /no # why not", "/no")).toBe(false);
  });

  it("does not let another record end a run of User-agent lines: a Crawl-delay or a Sitemap between them is ignored", () => {
    expect(allows("User-agent: Nooscape-Checker\nCrawl-delay: 5\nUser-agent: *\nDisallow: /", "/x")).toBe(false);
    expect(allows("User-agent: Googlebot\nSitemap: https://x.test/s.xml\nUser-agent: Nooscape-Checker\nDisallow: /", "/x")).toBe(false);
    // A rule still starts the next group.
    expect(allows("User-agent: Googlebot\nDisallow: /g\nCrawl-delay: 5\nUser-agent: Nooscape-Checker\nDisallow: /n", "/g")).toBe(true);
  });

  it("reads any line ending", () => {
    expect(allows("User-agent: *\r\nDisallow: /a\r\nDisallow: /b\r", "/b")).toBe(false);
    expect(allows("User-agent: *\rDisallow: /a", "/a")).toBe(false);
  });
});

describe("a rule from a host", () => {
  it("cannot make the match slow, however many stars it has and however long the path is", () => {
    const path = `/${"a".repeat(2000)}`;
    const started = Date.now();
    expect(allows("User-agent: *\nDisallow: /a*a*a*a*b$", path)).toBe(true);
    expect(allows(`User-agent: *\nDisallow: /${"a*".repeat(2000)}b$`, path)).toBe(true);
    expect(allows(`User-agent: *\nDisallow: /${"*a".repeat(30000)}b`, path)).toBe(true);
    expect(allows(`User-agent: *\nDisallow: /${"a*".repeat(500)}`, path)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("gives the same answers as the plain regular-expression reading of a pattern, on many small patterns and paths", () => {
    // The reading the matcher replaced, kept here as the reference. It is only safe to run on inputs this small.
    const reference = (pattern: string, path: string) => {
      const anchored = pattern.endsWith("$");
      const source = (anchored ? pattern.slice(0, -1) : pattern)
        .split("*")
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
    };
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const alphabet = ["a", "b", "/", ".", "*", "$", "a", "b"];
    const pick = (size: number) => Array.from({ length: size }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
    for (let i = 0; i < 20000; i += 1) {
      const pattern = pick(1 + Math.floor(next() * 7));
      const path = pick(Math.floor(next() * 10));
      expect(allows(`User-agent: *\nDisallow: ${pattern}`, path), `${pattern} on ${path}`).toBe(!reference(pattern, path));
    }
  });

  it("is matched without a regular expression, which is where the slowness would come from", () => {
    const source = readFileSync(new URL("./robots.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/new RegExp\(/);
  });

  it("is read the way the path is spelled by the host and by the visitor: percent-escapes are compared as one thing", () => {
    expect(allows("User-agent: *\nDisallow: /private", "/%70rivate/x")).toBe(false);
    expect(allows("User-agent: *\nDisallow: /%70rivate", "/private/x")).toBe(false);
    expect(allows("User-agent: *\nDisallow: /a%2fb", "/a%2Fb")).toBe(false);
    // An escape of a reserved character is not that character.
    expect(allows("User-agent: *\nDisallow: /a/b", "/a%2Fb")).toBe(true);
    expect(allows("User-agent: *\nDisallow: /caf\u00e9", "/caf%C3%A9")).toBe(false);
  });

  it("is still read when the file starts with a byte order mark", () => {
    expect(allows("\uFEFFUser-agent: *\nDisallow: /", "/x")).toBe(false);
  });
});

describe("the gate", () => {
  const answer = (over: Partial<Extract<SafeFetchResult, { ok: true }>> = {}): SafeFetchResult => ({
    ok: true,
    url: "https://a.example.com/robots.txt",
    status: 200,
    headers: {},
    body: Buffer.from(""),
    truncated: false,
    bodySha256: "",
    address: "93.184.216.34",
    tlsProtocol: "TLSv1.3",
    redirects: [],
    latencyMs: 5,
    ...over,
  });
  const failure = (reason: Extract<SafeFetchResult, { ok: false }>["reason"]): SafeFetchResult => ({ ok: false, reason, detail: reason, url: "https://a.example.com/robots.txt", redirects: [], latencyMs: 5 });
  const url = (path: string, host = "a.example.com") => new URL(`https://${host}${path}`);

  it("reads the host's robots.txt, and allows or refuses by what it says", async () => {
    const fetchRobots = vi.fn(async () => answer({ body: Buffer.from("User-agent: *\nDisallow: /private") }));
    const gate = createRobotsGate({ fetchRobots });
    expect(await gate.check(url("/status"))).toEqual({ allowed: true });
    expect(await gate.check(url("/private/x"))).toMatchObject({ allowed: false, reason: "robots_disallowed" });
    expect(fetchRobots).toHaveBeenCalledWith("https://a.example.com/robots.txt");
  });

  it("asks once for a host, however many things are asked of it, even at the same moment", async () => {
    let calls = 0;
    const fetchRobots = async () => {
      calls += 1;
      await new Promise(done => setTimeout(done, 10));
      return answer({ body: Buffer.from("User-agent: *\nDisallow: /no") });
    };
    const gate = createRobotsGate({ fetchRobots });
    const decisions = await Promise.all([gate.check(url("/a")), gate.check(url("/b")), gate.check(url("/no"))]);
    expect(decisions.map(decision => decision.allowed)).toEqual([true, true, false]);
    expect(calls).toBe(1);
    await gate.check(url("/c"));
    expect(calls).toBe(1);
    await gate.check(url("/x", "b.example.org"));
    expect(calls).toBe(2);
  });

  it("allows everything when robots.txt is missing, whatever 4xx says so", async () => {
    for (const status of [404, 410, 403, 401]) {
      const gate = createRobotsGate({ fetchRobots: async () => answer({ status, body: Buffer.from("Disallow: /") }) });
      expect(await gate.check(url("/anything")), String(status)).toEqual({ allowed: true });
    }
  });

  it("allows nothing when robots.txt cannot be read: a 5xx, no answer, or a file longer than what is read", async () => {
    const cases: Array<[string, () => Promise<SafeFetchResult>]> = [
      ["a 503", async () => answer({ status: 503 })],
      ["a 429, a host asking to be asked less", async () => answer({ status: 429 })],
      ["a timeout", async () => failure("timeout")],
      ["a refused connection", async () => failure("connection_failed")],
      ["a long file", async () => answer({ truncated: true, body: Buffer.alloc(ROBOTS_MAX_BYTES, "#") })],
    ];
    for (const [name, fetchRobots] of cases) {
      const gate = createRobotsGate({ fetchRobots });
      expect(await gate.check(url("/anything")), name).toMatchObject({ allowed: false, reason: "robots_unavailable" });
    }
    // And it says why, when the file was fetched and refused.
    const refused = createRobotsGate({ fetchRobots: async () => failure("forbidden_address") });
    expect(await refused.check(url("/x"))).toMatchObject({ reason: "robots_unavailable", cause: "forbidden_address" });
  });

  it("reads no more rules than its limit, and treats a file with more as one that cannot be read", async () => {
    const withRules = (count: number) => `User-agent: *\n${Array.from({ length: count }, (_, index) => `Disallow: /p${index}`).join("\n")}`;
    const atLimit = createRobotsGate({ fetchRobots: async () => answer({ body: Buffer.from(withRules(ROBOTS_MAX_RULES)) }) });
    expect(await atLimit.check(url("/p5"))).toMatchObject({ allowed: false, reason: "robots_disallowed" });
    const over = createRobotsGate({ fetchRobots: async () => answer({ body: Buffer.from(withRules(ROBOTS_MAX_RULES + 1)) }) });
    expect(await over.check(url("/other"))).toMatchObject({ allowed: false, reason: "robots_unavailable" });
  });

  it("reads no more pattern characters than its limit, counted as they are stored: one long rule is as much memory as many short ones", async () => {
    // Each of these is under the 64 KiB read, and one rule. A character outside ASCII is stored as nine.
    const long = createRobotsGate({ fetchRobots: async () => answer({ body: Buffer.from(`User-agent: *\nDisallow: /${"\u20ac".repeat(10_000)}`) }) });
    expect(await long.check(url("/x"))).toMatchObject({ allowed: false, reason: "robots_unavailable" });
    const room = Math.floor(ROBOTS_MAX_PATTERN_CHARS / 2);
    const fits = createRobotsGate({ fetchRobots: async () => answer({ body: Buffer.from(`User-agent: *\nDisallow: /${"a".repeat(room)}`) }) });
    expect(await fits.check(url("/x"))).toEqual({ allowed: true });
  });

  it("keeps only the groups that can apply to it", () => {
    const rules = parseRobots("User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /all\n\nUser-agent: Nooscape-Checker\nDisallow: /us");
    expect(rules.map(group => group.agents)).toEqual([["*"], ["nooscape-checker"]]);
  });

  it("remembers a readable file for a day and an unreadable one for ten minutes", async () => {
    let clock = 0;
    let readable = true;
    const fetchRobots = vi.fn(async () => (readable ? answer({ body: Buffer.from("User-agent: *\nDisallow: /no") }) : failure("timeout")));
    const gate = createRobotsGate({ fetchRobots, now: () => clock });
    await gate.check(url("/a"));
    clock += 23 * 60 * 60 * 1000;
    await gate.check(url("/a"));
    expect(fetchRobots).toHaveBeenCalledTimes(1);
    clock += 2 * 60 * 60 * 1000;
    readable = false;
    expect(await gate.check(url("/a"))).toMatchObject({ reason: "robots_unavailable" });
    expect(fetchRobots).toHaveBeenCalledTimes(2);
    clock += 5 * 60 * 1000;
    await gate.check(url("/a"));
    expect(fetchRobots).toHaveBeenCalledTimes(2);
    clock += 6 * 60 * 1000;
    readable = true;
    expect(await gate.check(url("/a"))).toEqual({ allowed: true });
    expect(fetchRobots).toHaveBeenCalledTimes(3);
  });

  it("does not remember a run that has spent its fetches as a host that cannot be read", async () => {
    let budget = false;
    const fetchRobots = vi.fn(async () => (budget ? answer({ body: Buffer.from("") }) : failure("budget_exhausted")));
    const gate = createRobotsGate({ fetchRobots });
    expect(await gate.check(url("/a"))).toMatchObject({ allowed: false, reason: "budget_exhausted" });
    budget = true;
    expect(await gate.check(url("/a"))).toEqual({ allowed: true });
    expect(fetchRobots).toHaveBeenCalledTimes(2);
  });

  it("keeps no more than its limit of hosts", async () => {
    const fetchRobots = vi.fn(async () => answer());
    const gate = createRobotsGate({ fetchRobots, maxHosts: 2 });
    for (const host of ["a.example.com", "b.example.com", "c.example.com"]) await gate.check(url("/", host));
    expect(fetchRobots).toHaveBeenCalledTimes(3);
    // The first was dropped to make room, so it is asked for again; the last is still known.
    await gate.check(url("/", "c.example.com"));
    expect(fetchRobots).toHaveBeenCalledTimes(3);
    await gate.check(url("/", "a.example.com"));
    expect(fetchRobots).toHaveBeenCalledTimes(4);
  });

  it("reads a path with its query", async () => {
    const gate = createRobotsGate({ fetchRobots: async () => answer({ body: Buffer.from("User-agent: *\nDisallow: /api?key=") }) });
    expect(await gate.check(url("/api?key=abc"))).toMatchObject({ allowed: false });
    expect(await gate.check(url("/api?x=1"))).toEqual({ allowed: true });
  });
});
