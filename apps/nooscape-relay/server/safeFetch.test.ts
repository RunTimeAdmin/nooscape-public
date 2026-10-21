import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKER_USER_AGENT, SAFE_FETCH_MAX_BODY_BYTES, SAFE_FETCH_MAX_BODY_CEILING, safeFetch, type ResolvedAddress, type SafeFetchDeps, type SafeFetchOptions } from "./safeFetch";

/**
 * safeFetch with the network replaced: a table for DNS, and a scripted request that records the options it was given.
 * What these prove is what safeFetch asks of Node (the name it resolves, the addresses it lets the socket use, the
 * checks on every hop) and what it makes of the answers. safeFetch.network.test.ts proves the same against a real TLS
 * server.
 */

const PUBLIC_A: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const PUBLIC_B: ResolvedAddress = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };

type Script = { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; error?: { code: string }; hang?: boolean; remoteAddress?: string; endAfterDestroy?: boolean };

/** A request that plays the scripts in order (the last one repeats) and records the options of each. */
function scripted(scripts: Script[]) {
  const seen: RequestOptions[] = [];
  const destroyed: string[] = [];
  const request: SafeFetchDeps["request"] = (options, onResponse) => {
    const script = scripts[Math.min(seen.length, scripts.length - 1)]!;
    seen.push(options);
    const fake = new EventEmitter() as unknown as ClientRequest;
    Object.assign(fake, {
      destroy: () => {
        destroyed.push("request");
        return fake;
      },
      end: () => {
        queueMicrotask(() => {
          if (script.hang) return;
          if (script.error) {
            fake.emit("error", Object.assign(new Error("simulated"), script.error));
            return;
          }
          const response = new EventEmitter() as unknown as IncomingMessage & { gone: boolean };
          response.gone = false;
          response.statusCode = script.status ?? 200;
          response.headers = script.headers ?? {};
          response.socket = { remoteAddress: script.remoteAddress ?? PUBLIC_A.address, getProtocol: () => "TLSv1.3" } as unknown as IncomingMessage["socket"];
          response.destroy = () => {
            response.gone = true;
            destroyed.push("response");
            queueMicrotask(() => response.emit("close"));
            return response;
          };
          onResponse(response);
          queueMicrotask(() => {
            for (const chunk of script.chunks ?? []) {
              if (response.gone) break;
              response.emit("data", chunk);
            }
            // Node has queued 'end' already when the read that crossed the cap also ended the message, and destroy() does not cancel it.
            if (!response.gone || script.endAfterDestroy) {
              response.emit("end");
              response.emit("close");
            }
          });
        });
      },
    });
    return fake;
  };
  return { request, seen, destroyed };
}

/** DNS from a table. A name that is not in it does not resolve. */
const dns = (table: Record<string, ResolvedAddress[]>) => {
  const asked: string[] = [];
  const resolve: SafeFetchDeps["resolve"] = async hostname => {
    asked.push(hostname);
    const answers = table[hostname];
    if (!answers) throw new Error("ENOTFOUND");
    return answers;
  };
  return { resolve, asked };
};

const redirectTo = (location: string, status = 302): Script => ({ status, headers: { location } });

afterEach(() => vi.useRealTimers());

describe("the URL", () => {
  const refused: Array<[string, string]> = [
    ["http://a.example.com/", "not_https"],
    ["ftp://a.example.com/", "not_https"],
    ["https://user:pass@a.example.com/", "credentials_in_url"],
    ["https://user@a.example.com/", "credentials_in_url"],
    ["https://a.example.com:8443/", "port_not_allowed"],
    ["https://localhost/", "forbidden_host"],
    ["https://app.localhost/", "forbidden_host"],
    ["https://printer.local/", "forbidden_host"],
    ["https://db.internal/", "forbidden_host"],
    ["https://127.0.0.1/", "forbidden_host"],
    ["https://10.0.0.5/", "forbidden_host"],
    ["https://2130706433/", "forbidden_host"],
    ["https://[::1]/", "forbidden_host"],
    ["https://[::ffff:7f00:1]/", "forbidden_host"],
    ["https://intranet/", "forbidden_host"],
    ["https://a..example.com/", "forbidden_host"],
    ["https://a.example.com../", "forbidden_host"],
    ["https://-a.example.com/", "forbidden_host"],
    ["https://a$b.example.com/", "forbidden_host"],
    ["", "invalid_url"],
    ["not a url", "invalid_url"],
    [`https://a.example.com/${"x".repeat(3000)}`, "invalid_url"],
  ];

  it.each(refused)("is refused before anything is resolved or sent: %s", async (url, reason) => {
    const { resolve, asked } = dns({});
    const { request, seen } = scripted([{}]);
    const result = await safeFetch(url, {}, { resolve, request });
    expect(result).toMatchObject({ ok: false, reason });
    expect(asked).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("takes a name with an underscore or in punycode, and gives whoever is asked the name without its trailing dot", async () => {
    const { resolve, asked } = dns({ "my_app.example.com": [PUBLIC_A], "xn--mnchen-3ya.de": [PUBLIC_A] });
    const { request } = scripted([{}]);
    const hosts: string[] = [];
    const beforeRequest: SafeFetchOptions["beforeRequest"] = async ({ url }) => (hosts.push(url.hostname), { ok: true });
    expect((await safeFetch("https://my_app.example.com./x", { beforeRequest }, { resolve, request })).ok).toBe(true);
    expect((await safeFetch("https://m\u00fcnchen.de/", { beforeRequest }, { resolve, request })).ok).toBe(true);
    expect(asked).toEqual(["my_app.example.com", "xn--mnchen-3ya.de"]);
    expect(hosts).toEqual(["my_app.example.com", "xn--mnchen-3ya.de"]);
  });

  it("may name the default port, which is no port at all", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request, seen } = scripted([{}]);
    const result = await safeFetch("https://a.example.com:443/path?q=1", {}, { resolve, request });
    expect(result.ok).toBe(true);
    expect(seen[0]).toMatchObject({ host: "a.example.com", port: 443, path: "/path?q=1" });
  });
});

describe("the name", () => {
  it("is refused when it does not resolve, or resolves to nothing", async () => {
    const { request, seen } = scripted([{}]);
    expect(await safeFetch("https://nope.example.com/", {}, { resolve: dns({}).resolve, request })).toMatchObject({ ok: false, reason: "unresolvable" });
    expect(await safeFetch("https://empty.example.com/", {}, { resolve: dns({ "empty.example.com": [] }).resolve, request })).toMatchObject({ ok: false, reason: "unresolvable" });
    expect(seen).toEqual([]);
  });

  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:7f00:1", "64:ff9b::7f00:1"])("is refused when it resolves to %s", async address => {
    const family = address.includes(":") ? 6 : 4;
    const { resolve } = dns({ "evil.example.com": [{ address, family }] });
    const { request, seen } = scripted([{}]);
    const result = await safeFetch("https://evil.example.com/", {}, { resolve, request });
    expect(result).toMatchObject({ ok: false, reason: "forbidden_address" });
    expect(seen).toEqual([]);
  });

  it("is refused when even one of its answers is not public, because the socket could be handed that one", async () => {
    const { resolve } = dns({ "mixed.example.com": [PUBLIC_A, { address: "10.0.0.7", family: 4 }, PUBLIC_B] });
    const { request, seen } = scripted([{}]);
    const result = await safeFetch("https://mixed.example.com/", {}, { resolve, request });
    expect(result).toMatchObject({ ok: false, reason: "forbidden_address" });
    // The answer is not named in the result: what a resolver says for a name can be a fact about the network it runs in.
    expect(result.ok === false && result.detail).not.toContain("10.0.0.7");
    expect(seen).toEqual([]);
  });

  it("is not waited for past the deadline", async () => {
    vi.useFakeTimers();
    const { request } = scripted([{}]);
    const slow: SafeFetchDeps["resolve"] = () => new Promise(() => {});
    const pending = safeFetch("https://slow.example.com/", { timeoutMs: 1000 }, { resolve: slow, request });
    await vi.advanceTimersByTimeAsync(1100);
    expect(await pending).toMatchObject({ ok: false, reason: "timeout" });
  });
});

describe("the options", () => {
  const { resolve } = dns({ "a.example.com": [PUBLIC_A] });

  it("cannot read more than the ceiling, and a number that is not a number is not a limit", async () => {
    const body = Buffer.alloc(300_000, "a");
    const read = async (maxBodyBytes: number | undefined) => {
      const result = await safeFetch("https://a.example.com/", { maxBodyBytes }, { resolve, request: scripted([{ chunks: [body] }]).request });
      return result.ok ? result.body.length : -1;
    };
    expect(await read(undefined)).toBe(SAFE_FETCH_MAX_BODY_BYTES);
    expect(await read(Number.NaN)).toBe(SAFE_FETCH_MAX_BODY_BYTES);
    expect(await read(Number.POSITIVE_INFINITY)).toBe(SAFE_FETCH_MAX_BODY_BYTES);
    expect(await read(1e12)).toBe(SAFE_FETCH_MAX_BODY_CEILING);
    expect(await read(100)).toBe(100);
    expect(await read(-5)).toBe(0);
  });

  it("cannot wait longer than 5 seconds, and a number that is not a number is not a limit", async () => {
    for (const timeoutMs of [60_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      vi.useFakeTimers();
      const pending = safeFetch("https://a.example.com/", { timeoutMs }, { resolve, request: scripted([{ hang: true }]).request });
      await vi.advanceTimersByTimeAsync(5100);
      expect(await pending, String(timeoutMs)).toMatchObject({ ok: false, reason: "timeout" });
      vi.useRealTimers();
    }
  });

  it("cannot follow more than 3 redirects, and a number that is not a number is not a limit", async () => {
    for (const maxRedirects of [50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { request, seen } = scripted([redirectTo("/again")]);
      expect(await safeFetch("https://a.example.com/", { maxRedirects }, { resolve, request }), String(maxRedirects)).toMatchObject({ ok: false, reason: "too_many_redirects" });
      expect(seen).toHaveLength(4);
    }
  });

  it("asks with GET or HEAD, any other method is a GET, and a POST is made only with a body (server/safeFetchPost.test.ts holds the rest)", async () => {
    const { request, seen } = scripted([{}]);
    await safeFetch("https://a.example.com/", { method: "DELETE" as unknown as "GET" }, { resolve, request });
    expect(seen[0]).toMatchObject({ method: "GET" });
    const bodyless = scripted([{}]);
    expect(await safeFetch("https://a.example.com/", { method: "POST" }, { resolve, request: bodyless.request })).toMatchObject({ ok: false, reason: "invalid_url" });
    expect(bodyless.seen).toHaveLength(0);
  });
});

describe("the default resolver", () => {
  it("asks the name servers directly and not through dns.lookup, which would hold one of the four threads the rest of the server shares until the system resolver gave up", () => {
    const source = readFileSync(new URL("./safeFetch.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import \{ Resolver \} from "node:dns\/promises"/);
    expect(source).not.toMatch(/import[^;]*\blookup\b[^;]*from "node:dns/);
  });
});

describe("the connection", () => {
  it("is made to the name that was resolved, by the addresses that were checked, and by no lookup of its own", async () => {
    const { resolve, asked } = dns({ "a.example.com": [PUBLIC_A, PUBLIC_B] });
    const { request, seen } = scripted([{ chunks: [Buffer.from("hello")] }]);
    const result = await safeFetch("https://a.example.com/status", {}, { resolve, request });
    expect(result.ok).toBe(true);
    expect(asked).toEqual(["a.example.com"]);
    const options = seen[0]!;
    // The name is what TLS names and the certificate is checked against; it is never swapped for an address.
    expect(options).toMatchObject({ host: "a.example.com", hostname: "a.example.com", servername: "a.example.com", rejectUnauthorized: true, agent: false, protocol: "https:", port: 443 });
    // Node asks for every address when it tries them in turn, and for one when it does not.
    const lookup = options.lookup as unknown as (name: string, options: unknown, callback: (...args: unknown[]) => void) => void;
    const all = vi.fn();
    lookup("a.example.com", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: PUBLIC_A.address, family: 4 }, { address: PUBLIC_B.address, family: 6 }]);
    const one = vi.fn();
    lookup("a.example.com", {}, one);
    expect(one).toHaveBeenCalledWith(null, PUBLIC_A.address, 4);
    // Whatever the socket asks for, it is told the same: a second lookup is never consulted.
    const other = vi.fn();
    lookup("somewhere-else.example.org", { all: true }, other);
    expect(other).toHaveBeenCalledWith(null, [{ address: PUBLIC_A.address, family: 4 }, { address: PUBLIC_B.address, family: 6 }]);
  });

  it("is not steered by a host that answers differently the second time (DNS rebinding)", async () => {
    let calls = 0;
    const resolve: SafeFetchDeps["resolve"] = async () => {
      calls += 1;
      return calls === 1 ? [PUBLIC_A] : [{ address: "169.254.169.254", family: 4 }];
    };
    const { request, seen } = scripted([{}]);
    const result = await safeFetch("https://rebind.example.com/", {}, { resolve, request });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    const lookup = seen[0]!.lookup as unknown as (name: string, options: unknown, callback: (...args: unknown[]) => void) => void;
    const answered = vi.fn();
    lookup("rebind.example.com", { all: true }, answered);
    expect(answered).toHaveBeenCalledWith(null, [{ address: PUBLIC_A.address, family: 4 }]);
  });

  it("sends who it is, takes no compression, and carries no cookie or credential", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request, seen } = scripted([{}]);
    await safeFetch("https://a.example.com/", { accept: "application/json" }, { resolve, request });
    expect(seen[0]!.headers).toEqual({ "user-agent": CHECKER_USER_AGENT, accept: "application/json", "accept-encoding": "identity", connection: "close" });
    expect(CHECKER_USER_AGENT).toMatch(/^Nooscape-Checker\/[\d.]+ \(\+https:\/\/nooscape\.si\/checker\)$/);
  });

  it("takes an Accept header of plain media-type characters and nothing else", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    for (const accept of ["text/html\r\nCookie: a=b", "x".repeat(300), "<script>"]) {
      const { request, seen } = scripted([{}]);
      await safeFetch("https://a.example.com/", { accept }, { resolve, request });
      expect(seen[0]!.headers).toMatchObject({ accept: "*/*" });
    }
  });

  it("is a HEAD request when asked, with no body kept", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request, seen } = scripted([{ status: 200, headers: { "content-length": "999" }, chunks: [Buffer.from("never read")] }]);
    const result = await safeFetch("https://a.example.com/", { method: "HEAD" }, { resolve, request });
    expect(seen[0]!.method).toBe("HEAD");
    expect(result).toMatchObject({ ok: true, status: 200, truncated: false });
    expect(result.ok && result.body.length).toBe(0);
  });
});

describe("the answer", () => {
  it("is a result with the facts of the connection: the status, the address used, the TLS version, the headers (cookies left out)", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request } = scripted([{ status: 402, headers: { "content-type": "application/json", "set-cookie": "session=secret", server: "nginx" }, chunks: [Buffer.from('{"error":"payment required"}')], remoteAddress: "93.184.216.34" }]);
    const result = await safeFetch("https://a.example.com/pay", {}, { resolve, request });
    expect(result).toMatchObject({ ok: true, status: 402, url: "https://a.example.com/pay", address: "93.184.216.34", tlsProtocol: "TLSv1.3", truncated: false, redirects: [] });
    expect(result.ok && result.headers).toEqual({ "content-type": "application/json", server: "nginx" });
    expect(result.ok && result.body.toString()).toBe('{"error":"payment required"}');
    expect(result.ok && result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps the first bytes up to the cap, says it was cut, and hashes what it kept", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const big = Buffer.alloc(SAFE_FETCH_MAX_BODY_BYTES * 3, "x");
    const { request, destroyed } = scripted([{ chunks: [big.subarray(0, 3000), big.subarray(3000, 9000), big.subarray(9000)] }]);
    const result = await safeFetch("https://a.example.com/", {}, { resolve, request });
    expect(result.ok && result.truncated).toBe(true);
    expect(result.ok && result.body.length).toBe(SAFE_FETCH_MAX_BODY_BYTES);
    expect(result.ok && result.bodySha256).toBe(createHash("sha256").update(big.subarray(0, SAFE_FETCH_MAX_BODY_BYTES)).digest("hex"));
    // The rest is not read: the connection is dropped.
    expect(destroyed).toContain("response");
  });

  it("does not finish twice when the end of the message comes in the read that crossed the cap", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request } = scripted([{ chunks: [Buffer.alloc(5000, "a")], endAfterDestroy: true }]);
    const result = await safeFetch("https://a.example.com/", { maxBodyBytes: 4096 }, { resolve, request });
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok && result.body.length).toBe(4096);
    expect(result.ok && result.bodySha256).toBe(createHash("sha256").update(Buffer.alloc(4096, "a")).digest("hex"));
    // Let the queued end run: finishing twice would throw here, and the run would fail on the unhandled error.
    await new Promise(done => setTimeout(done, 10));
  });

  it("is not cut when the body is exactly the cap", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const exact = Buffer.alloc(100, "y");
    const { request } = scripted([{ chunks: [exact] }]);
    const result = await safeFetch("https://a.example.com/", { maxBodyBytes: 100 }, { resolve, request });
    expect(result.ok && result.truncated).toBe(false);
    expect(result.ok && result.body.length).toBe(100);
  });

  it("takes an empty body for a host that sends none", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request } = scripted([{ status: 204 }]);
    const result = await safeFetch("https://a.example.com/", {}, { resolve, request });
    expect(result).toMatchObject({ ok: true, status: 204, truncated: false, bodySha256: createHash("sha256").update("").digest("hex") });
  });

  it("keeps time by a clock that cannot be set back", async () => {
    vi.useFakeTimers();
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request } = scripted([{ hang: true }]);
    const pending = safeFetch("https://a.example.com/", { timeoutMs: 1000 }, { resolve, request });
    await vi.advanceTimersByTimeAsync(200);
    // The system clock is set back an hour while the host is silent.
    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(900);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(900);
    expect(result.latencyMs).toBeLessThan(1500);
  });

  it("gives up on a host that never answers, at the deadline", async () => {
    vi.useFakeTimers();
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request, destroyed } = scripted([{ hang: true }]);
    const pending = safeFetch("https://a.example.com/", { timeoutMs: 2000 }, { resolve, request });
    await vi.advanceTimersByTimeAsync(2100);
    expect(await pending).toMatchObject({ ok: false, reason: "timeout" });
    expect(destroyed).toContain("request");
  });

  it.each([
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_failed"],
    ["CERT_HAS_EXPIRED", "tls_failed"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls_failed"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_failed"],
    ["ECONNREFUSED", "connection_failed"],
    ["ECONNRESET", "connection_failed"],
    ["EHOSTUNREACH", "connection_failed"],
    ["HPE_INVALID_CONSTANT", "response_invalid"],
  ])("is a reason, never an error: %s", async (code, reason) => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request } = scripted([{ error: { code } }]);
    const result = await safeFetch("https://a.example.com/", {}, { resolve, request });
    expect(result).toMatchObject({ ok: false, reason, detail: code });
  });

  it("never throws, even when its own dependencies do", async () => {
    const thrower: SafeFetchDeps["request"] = () => {
      throw new Error("boom");
    };
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    expect(await safeFetch("https://a.example.com/", {}, { resolve, request: thrower })).toMatchObject({ ok: false, reason: "connection_failed" });
    const exploding: SafeFetchDeps["resolve"] = () => {
      throw new Error("sync boom");
    };
    expect((await safeFetch("https://a.example.com/", {}, { resolve: exploding, request: scripted([{}]).request })).ok).toBe(false);
  });
});

describe("a redirect", () => {
  it("is followed by hand, and the hops are named in order", async () => {
    const { resolve, asked } = dns({ "a.example.com": [PUBLIC_A], "b.example.org": [PUBLIC_B] });
    const { request, seen } = scripted([redirectTo("/next"), redirectTo("https://b.example.org/final?x=1", 301), { chunks: [Buffer.from("done")] }]);
    const result = await safeFetch("https://a.example.com/start", {}, { resolve, request });
    expect(result).toMatchObject({ ok: true, url: "https://b.example.org/final?x=1", redirects: ["https://a.example.com/next", "https://b.example.org/final?x=1"] });
    // Each hop resolves its own name and connects by its own name.
    expect(asked).toEqual(["a.example.com", "a.example.com", "b.example.org"]);
    expect(seen.map(options => options.host)).toEqual(["a.example.com", "a.example.com", "b.example.org"]);
    expect(seen.map(options => options.path)).toEqual(["/start", "/next", "/final?x=1"]);
  });

  it("keeps a HEAD a HEAD", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request, seen } = scripted([redirectTo("/there", 307), {}]);
    await safeFetch("https://a.example.com/", { method: "HEAD" }, { resolve, request });
    expect(seen.map(options => options.method)).toEqual(["HEAD", "HEAD"]);
  });

  it("goes three times and no more", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const three = scripted([redirectTo("/1"), redirectTo("/2"), redirectTo("/3"), { chunks: [Buffer.from("ok")] }]);
    expect(await safeFetch("https://a.example.com/", {}, { resolve, request: three.request })).toMatchObject({ ok: true, redirects: ["https://a.example.com/1", "https://a.example.com/2", "https://a.example.com/3"] });
    const four = scripted([redirectTo("/1"), redirectTo("/2"), redirectTo("/3"), redirectTo("/4"), {}]);
    const result = await safeFetch("https://a.example.com/", {}, { resolve, request: four.request });
    expect(result).toMatchObject({ ok: false, reason: "too_many_redirects" });
    expect(four.seen).toHaveLength(4);
  });

  it("is a refusal when it leaves https, and the new hop is never connected to", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A], "b.example.org": [PUBLIC_A] });
    const { request, seen } = scripted([redirectTo("http://b.example.org/plain"), {}]);
    const result = await safeFetch("https://a.example.com/", {}, { resolve, request });
    expect(result).toMatchObject({ ok: false, reason: "not_https", url: "http://b.example.org/plain" });
    expect(seen).toHaveLength(1);
  });

  it.each([
    ["https://user:pass@b.example.org/", "credentials_in_url"],
    ["https://b.example.org:9443/", "port_not_allowed"],
    ["https://127.0.0.1/admin", "forbidden_host"],
    ["https://metadata.internal/", "forbidden_host"],
  ])("is checked like the first URL: %s", async (location, reason) => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request, seen } = scripted([redirectTo(location), {}]);
    expect(await safeFetch("https://a.example.com/", {}, { resolve, request })).toMatchObject({ ok: false, reason });
    expect(seen).toHaveLength(1);
  });

  it("is refused when the next host resolves to space the first hop never showed (the redirect hole)", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A], "sneaky.example.org": [{ address: "169.254.169.254", family: 4 }] });
    const { request, seen } = scripted([redirectTo("https://sneaky.example.org/latest/meta-data"), {}]);
    const result = await safeFetch("https://a.example.com/", {}, { resolve, request });
    expect(result).toMatchObject({ ok: false, reason: "forbidden_address" });
    expect(seen).toHaveLength(1);
  });

  it("is a refusal when it has no usable Location", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    expect(await safeFetch("https://a.example.com/", {}, { resolve, request: scripted([{ status: 302 }]).request })).toMatchObject({ ok: false, reason: "redirect_invalid" });
    expect(await safeFetch("https://a.example.com/", {}, { resolve, request: scripted([redirectTo("http://[bad")]).request })).toMatchObject({ ok: false, reason: "redirect_invalid" });
  });

  it("is refused when its Location is longer than a URL may be, and not followed cut short", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request, seen } = scripted([redirectTo(`https://a.example.com/${"x".repeat(3000)}`), {}]);
    expect(await safeFetch("https://a.example.com/", {}, { resolve, request })).toMatchObject({ ok: false, reason: "redirect_invalid" });
    expect(seen).toHaveLength(1);
    // Dot segments would bring one cut short back under the limit and lose its target.
    const dotted = scripted([redirectTo(`${"./".repeat(1100)}x`), {}]);
    expect(await safeFetch("https://a.example.com/", {}, { resolve, request: dotted.request })).toMatchObject({ ok: false, reason: "redirect_invalid" });
    expect(dotted.seen).toHaveLength(1);
  });

  it("shares one deadline with the rest of the chain", async () => {
    vi.useFakeTimers();
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request } = scripted([redirectTo("/slow"), { hang: true }]);
    const pending = safeFetch("https://a.example.com/", { timeoutMs: 1500 }, { resolve, request });
    await vi.advanceTimersByTimeAsync(1600);
    expect(await pending).toMatchObject({ ok: false, reason: "timeout" });
  });
});

describe("the hook before a request", () => {
  it("runs for every hop, after the address was checked, and can refuse one", async () => {
    const { resolve } = dns({ "a.example.com": [PUBLIC_A], "b.example.org": [PUBLIC_A] });
    const { request, seen } = scripted([redirectTo("https://b.example.org/there"), { chunks: [Buffer.from("x")] }]);
    const hops: string[] = [];
    const result = await safeFetch("https://a.example.com/", { beforeRequest: async ({ url, hop }) => (hops.push(`${hop}:${url.hostname}`), { ok: true }) }, { resolve, request });
    expect(result.ok).toBe(true);
    expect(hops).toEqual(["0:a.example.com", "1:b.example.org"]);

    const refusing = scripted([redirectTo("https://b.example.org/there"), {}]);
    const refused = await safeFetch("https://a.example.com/", { beforeRequest: async ({ url }) => (url.hostname === "b.example.org" ? { ok: false, reason: "robots_disallowed", detail: "no" } : { ok: true }) }, { resolve, request: refusing.request });
    expect(refused).toMatchObject({ ok: false, reason: "robots_disallowed", detail: "no" });
    expect(refusing.seen).toHaveLength(1);
    expect(seen).toHaveLength(2);
  });

  it("is not counted against the deadline or in the latency: the time it takes is manners, not the host", async () => {
    vi.useFakeTimers();
    const { resolve } = dns({ "a.example.com": [PUBLIC_A] });
    const { request } = scripted([{ chunks: [Buffer.from("x")] }]);
    // The hook waits three times as long as the whole deadline.
    const pending = safeFetch("https://a.example.com/", { timeoutMs: 1000, beforeRequest: () => new Promise(done => setTimeout(() => done({ ok: true }), 3000)) }, { resolve, request });
    await vi.advanceTimersByTimeAsync(3100);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeLessThan(500);
  });

  it("is not run for a hop whose address was refused", async () => {
    const { resolve } = dns({ "a.example.com": [{ address: "10.0.0.1", family: 4 }] });
    const hook = vi.fn(async () => ({ ok: true as const }));
    await safeFetch("https://a.example.com/", { beforeRequest: hook }, { resolve, request: scripted([{}]).request });
    expect(hook).not.toHaveBeenCalled();
  });
});
