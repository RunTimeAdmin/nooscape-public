import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECKER_USER_AGENT, SAFE_FETCH_MAX_POST_BYTES, safeFetch, type ResolvedAddress, type SafeFetchDeps } from "./safeFetch";

/**
 * A POST through safeFetch (docs/data-access-2026-10-19.md, stage D5): the call to a webhook address its owner gave us. It sends one body
 * with a few plain headers, follows no redirect, and goes through every check a GET does. First with the network replaced, then against a
 * real TLS server on loopback, where the body, the headers and the length are the real ones.
 */
const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const resolve: SafeFetchDeps["resolve"] = async () => [PUBLIC];
const URL_OK = "https://hooks.example.com/nooscape";

function recording(script: { status?: number; headers?: Record<string, string> } = {}) {
  const seen: Array<{ options: Parameters<SafeFetchDeps["request"]>[0]; body: unknown }> = [];
  const request: SafeFetchDeps["request"] = (options, onResponse) => {
    const fake = new EventEmitter() as unknown as ClientRequest;
    Object.assign(fake, {
      destroy: () => fake,
      end: (body?: unknown) => {
        seen.push({ options, body });
        queueMicrotask(() => {
          const response = new EventEmitter() as unknown as IncomingMessage;
          response.statusCode = script.status ?? 204;
          response.headers = script.headers ?? {};
          response.socket = { remoteAddress: PUBLIC.address, getProtocol: () => "TLSv1.3" } as unknown as IncomingMessage["socket"];
          response.destroy = () => response;
          onResponse(response);
          queueMicrotask(() => {
            response.emit("end");
            response.emit("close");
          });
        });
      },
    });
    return fake;
  };
  return { request, seen };
}

describe("a POST", () => {
  it("sends its body and its headers, with the length, a user agent that is the caller's, and a connection that is not kept", async () => {
    const { request, seen } = recording();
    const answer = await safeFetch(URL_OK, { method: "POST", body: '{"a":1}', headers: { "Content-Type": "application/json", "X-Nooscape-Event": "ownership_changed" }, userAgent: "Nooscape-Webhooks/1.0 (+https://nooscape.si/developers)" }, { resolve, request });
    expect(answer).toMatchObject({ ok: true, status: 204 });
    expect(seen).toHaveLength(1);
    const { options, body } = seen[0]!;
    expect(options).toMatchObject({ method: "POST", hostname: "hooks.example.com", path: "/nooscape", rejectUnauthorized: true });
    expect(options.headers).toMatchObject({ "content-type": "application/json", "x-nooscape-event": "ownership_changed", "content-length": "7", "user-agent": "Nooscape-Webhooks/1.0 (+https://nooscape.si/developers)", connection: "close", "accept-encoding": "identity" });
    expect(Buffer.isBuffer(body) && body.toString("utf8")).toBe('{"a":1}');
  });

  it("uses the checker's user agent when none is given, and counts a body's length in bytes, not characters", async () => {
    const { request, seen } = recording();
    await safeFetch(URL_OK, { method: "POST", body: "é" }, { resolve, request });
    expect(seen[0]!.options.headers).toMatchObject({ "user-agent": CHECKER_USER_AGENT, "content-length": "2" });
  });

  it("is refused, and nothing is sent, for a body that is missing, empty or too large, and for headers that are not plain", async () => {
    const bad: Array<[string, Parameters<typeof safeFetch>[1]]> = [
      ["no body", { method: "POST" }],
      ["empty body", { method: "POST", body: "" }],
      ["too large", { method: "POST", body: "x".repeat(SAFE_FETCH_MAX_POST_BYTES + 1) }],
      ["host header", { method: "POST", body: "x", headers: { Host: "internal.example" } }],
      ["content-length header", { method: "POST", body: "x", headers: { "Content-Length": "1" } }],
      ["transfer-encoding", { method: "POST", body: "x", headers: { "Transfer-Encoding": "chunked" } }],
      ["cookie", { method: "POST", body: "x", headers: { Cookie: "a=b" } }],
      ["a header with a line break", { method: "POST", body: "x", headers: { "x-a": "ok\r\nx-injected: 1" } }],
      ["a header name with a space", { method: "POST", body: "x", headers: { "x a": "1" } }],
      ["the same header twice", { method: "POST", body: "x", headers: { "X-A": "1", "x-a": "2" } }],
      ["too many headers", { method: "POST", body: "x", headers: Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`x-h${index}`, "1"])) }],
      ["a user agent with a line break", { method: "POST", body: "x", userAgent: "a\r\nb" }],
    ];
    for (const [label, options] of bad) {
      const { request, seen } = recording();
      expect(await safeFetch(URL_OK, options, { resolve, request }), label).toMatchObject({ ok: false, reason: "invalid_url" });
      expect(seen, label).toHaveLength(0);
    }
  });

  it("goes through the same checks as a GET: https only, no port, no address that is not public, and a name that is not an address", async () => {
    for (const [url, reason] of [["http://hooks.example.com/x", "not_https"], ["https://hooks.example.com:8443/x", "port_not_allowed"], ["https://user:pw@hooks.example.com/x", "credentials_in_url"], ["https://127.0.0.1/x", "forbidden_host"]] as const) {
      const { request, seen } = recording();
      expect(await safeFetch(url, { method: "POST", body: "x" }, { resolve, request }), url).toMatchObject({ ok: false, reason });
      expect(seen).toHaveLength(0);
    }
    const inside = recording();
    expect(await safeFetch(URL_OK, { method: "POST", body: "x" }, { resolve: async () => [{ address: "10.0.0.5", family: 4 }], request: inside.request })).toMatchObject({ ok: false, reason: "forbidden_address" });
    expect(inside.seen).toHaveLength(0);
    const mixed = recording();
    expect(await safeFetch(URL_OK, { method: "POST", body: "x" }, { resolve: async () => [PUBLIC, { address: "169.254.169.254", family: 4 }], request: mixed.request })).toMatchObject({ ok: false, reason: "forbidden_address" });
    expect(mixed.seen).toHaveLength(0);
  });

  it("follows no redirect, whatever it is told: a 3xx is a failure and the body goes to one address only", async () => {
    const { request, seen } = recording({ status: 307, headers: { location: "https://elsewhere.example.com/" } });
    expect(await safeFetch(URL_OK, { method: "POST", body: "x", maxRedirects: 3 }, { resolve, request })).toMatchObject({ ok: false, reason: "too_many_redirects" });
    expect(seen).toHaveLength(1);
  });

  it("reports an answer of any status as an answer: a 500 is a status for the caller to judge", async () => {
    const { request } = recording({ status: 500 });
    expect(await safeFetch(URL_OK, { method: "POST", body: "x" }, { resolve, request })).toMatchObject({ ok: true, status: 500 });
  });
});

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const NAME = "pinned.example.test";

describe.skipIf(!hasOpenssl)("a POST against a real TLS server", { timeout: 30_000 }, () => {
  let dir: string;
  let credentials: { key: Buffer; cert: Buffer };
  let server: https.Server;
  let port = 0;
  const received: Array<{ method?: string; headers: Record<string, string | string[] | undefined>; body: string; url?: string }> = [];

  const deps = (): Partial<SafeFetchDeps> => ({
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    isForbidden: () => false,
    request: (options, onResponse) => https.request({ ...options, port, ca: credentials.cert }, onResponse),
  });

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "safepost-"));
    const config = path.join(dir, "c.cnf");
    writeFileSync(config, ["[req]", "distinguished_name = dn", "x509_extensions = ext", "prompt = no", "[dn]", `CN = ${NAME}`, "[ext]", `subjectAltName = DNS:${NAME}`, ""].join("\n"));
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.key"), "-out", path.join(dir, "c.crt"), "-days", "2", "-config", config], { encoding: "utf8" });
    if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`);
    credentials = { key: readFileSync(path.join(dir, "k.key")), cert: readFileSync(path.join(dir, "c.crt")) };
    server = https.createServer(credentials, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk as Buffer));
      req.on("end", () => {
        received.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), url: req.url });
        if (req.url === "/moved") {
          res.writeHead(302, { location: "/ok" });
          res.end();
        } else if (req.url === "/down") {
          res.writeHead(503);
          res.end("later");
        } else {
          res.writeHead(200);
          res.end("ok");
        }
      });
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(done => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers the body whole with its headers and the right length, to the pinned address, over real TLS", async () => {
    received.length = 0;
    const body = JSON.stringify({ id: "d1", text: "café ✓", n: 1 });
    const answer = await safeFetch(`https://${NAME}/hook?x=1`, { method: "POST", body, headers: { "content-type": "application/json", "x-nooscape-signature": "v1=abc" }, userAgent: "Nooscape-Webhooks/1.0" }, deps());
    expect(answer).toMatchObject({ ok: true, status: 200 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "POST", url: "/hook?x=1", body });
    expect(received[0]!.headers).toMatchObject({ "content-type": "application/json", "x-nooscape-signature": "v1=abc", "user-agent": "Nooscape-Webhooks/1.0", "content-length": String(Buffer.byteLength(body)), connection: "close" });
  });

  it("does not follow a redirect, and reports a failing status as a status", async () => {
    received.length = 0;
    expect(await safeFetch(`https://${NAME}/moved`, { method: "POST", body: "x" }, deps())).toMatchObject({ ok: false, reason: "too_many_redirects" });
    expect(received.map(item => item.url)).toEqual(["/moved"]);
    expect(await safeFetch(`https://${NAME}/down`, { method: "POST", body: "x" }, deps())).toMatchObject({ ok: true, status: 503 });
  });
});
