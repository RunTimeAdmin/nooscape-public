import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECKER_USER_AGENT, safeFetch, type SafeFetchDeps } from "./safeFetch";

/**
 * safeFetch against a real TLS server on loopback: a real handshake, a real socket, real bytes. The server's name is
 * `pinned.example.test`, which no DNS can resolve, so the only way a request reaches it is the pinned lookup (that is the
 * proof that the connection is made to the address that was checked and by no lookup of its own). The certificate is
 * made for the run with openssl and is never kept; the suite skips where openssl is not there.
 */
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const NAME = "pinned.example.test";

function makeCertificate(dir: string, commonName: string) {
  const config = path.join(dir, `${commonName}.cnf`);
  const key = path.join(dir, `${commonName}.key`);
  const cert = path.join(dir, `${commonName}.crt`);
  writeFileSync(config, ["[req]", "distinguished_name = dn", "x509_extensions = ext", "prompt = no", "[dn]", `CN = ${commonName}`, "[ext]", `subjectAltName = DNS:${commonName}`, ""].join("\n"));
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-config", config], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`);
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

describe.skipIf(!hasOpenssl)("safeFetch against a real TLS server", { timeout: 30_000 }, () => {
  let dir: string;
  let good: { key: Buffer; cert: Buffer };
  let other: { key: Buffer; cert: Buffer };
  let server: https.Server;
  let wrongNameServer: https.Server;
  let port = 0;
  let wrongNamePort = 0;
  const received: IncomingHttpHeaders[] = [];

  /** Loopback is not public space, so the guard is switched off here, and only here; the lookup and the TLS are the real ones. */
  const deps = (serverPort: () => number, trust: Buffer | null = good.cert): Partial<SafeFetchDeps> => ({
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    isForbidden: () => false,
    request: (options, onResponse) => https.request({ ...options, port: serverPort(), ca: trust ?? undefined }, onResponse),
  });

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "safefetch-"));
    good = makeCertificate(dir, NAME);
    other = makeCertificate(dir, "other.example.test");
    server = https.createServer(good, (req, res) => {
      received.push(req.headers);
      const url = new URL(req.url ?? "/", "https://x.test");
      if (url.pathname === "/hello") {
        res.writeHead(200, { "content-type": "text/plain", "set-cookie": "session=secret" });
        res.end(req.method === "HEAD" ? undefined : "hello");
      } else if (url.pathname === "/redirect") {
        res.writeHead(302, { location: "/hello" });
        res.end("moved");
      } else if (url.pathname === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (url.pathname === "/big") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        for (let i = 0; i < 100; i += 1) res.write(Buffer.alloc(1024, "a"));
        res.end();
      } else if (url.pathname === "/oneshot") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.alloc(5000, "a"));
      } else if (url.pathname === "/slow") {
        res.writeHead(200);
        res.write("started");
        // Never ends.
      } else if (url.pathname === "/drop") {
        req.socket.destroy();
      } else {
        res.writeHead(404);
        res.end("no");
      }
    });
    wrongNameServer = https.createServer(other, (_req, res) => res.end("wrong"));
    await Promise.all([
      new Promise<void>(done => server.listen(0, "127.0.0.1", done)),
      new Promise<void>(done => wrongNameServer.listen(0, "127.0.0.1", done)),
    ]);
    port = (server.address() as AddressInfo).port;
    wrongNamePort = (wrongNameServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    wrongNameServer.closeAllConnections();
    await Promise.all([new Promise(done => server.close(done)), new Promise(done => wrongNameServer.close(done))]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reaches a name no DNS can resolve, because the connection goes to the address that was checked", async () => {
    const result = await safeFetch(`https://${NAME}/hello`, {}, deps(() => port));
    expect(result).toMatchObject({ ok: true, status: 200, address: "127.0.0.1", truncated: false });
    expect(result.ok && result.body.toString()).toBe("hello");
    expect(result.ok && result.tlsProtocol).toMatch(/^TLSv1\.[23]$/);
    // The cookie the server set is not kept.
    expect(result.ok && result.headers).toMatchObject({ "content-type": "text/plain" });
    expect(result.ok && result.headers).not.toHaveProperty("set-cookie");
  });

  it("does the name lookup itself nowhere: with the real resolver the same name is unresolvable, and nothing is connected to", async () => {
    const result = await safeFetch(`https://${NAME}/hello`, {}, { request: deps(() => port).request });
    expect(result).toMatchObject({ ok: false, reason: "unresolvable" });
  });

  it("tells the server who it is, takes no compression, keeps no connection and sends no cookie or credential", async () => {
    received.length = 0;
    await safeFetch(`https://${NAME}/hello`, {}, deps(() => port));
    expect(received).toHaveLength(1);
    // The test points the request at the server's own port, so Node adds it to Host; on port 443 it would not.
    expect(received[0]).toMatchObject({ host: expect.stringMatching(/^pinned\.example\.test(:\d+)?$/), "user-agent": CHECKER_USER_AGENT, accept: "*/*", "accept-encoding": "identity", connection: "close" });
    expect(received[0]).not.toHaveProperty("cookie");
    expect(received[0]).not.toHaveProperty("authorization");
  });

  it("refuses a certificate it does not trust: certificate checking is on", async () => {
    const result = await safeFetch(`https://${NAME}/hello`, {}, deps(() => port, null));
    expect(result).toMatchObject({ ok: false, reason: "tls_failed" });
  });

  it("keeps checking certificates when the environment says not to", async () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      expect(await safeFetch(`https://${NAME}/hello`, {}, deps(() => port, null))).toMatchObject({ ok: false, reason: "tls_failed" });
    } finally {
      if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
    }
  });

  it("refuses a certificate made for another name, even a trusted one", async () => {
    const result = await safeFetch(`https://${NAME}/`, {}, deps(() => wrongNamePort, other.cert));
    expect(result).toMatchObject({ ok: false, reason: "tls_failed", detail: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("follows a relative redirect to the final answer", async () => {
    const result = await safeFetch(`https://${NAME}/redirect`, {}, deps(() => port));
    expect(result).toMatchObject({ ok: true, status: 200, url: `https://${NAME}/hello`, redirects: [`https://${NAME}/hello`] });
  });

  it("gives up on a redirect loop after three hops", async () => {
    expect(await safeFetch(`https://${NAME}/loop`, {}, deps(() => port))).toMatchObject({ ok: false, reason: "too_many_redirects" });
  });

  it("makes a HEAD request and keeps no body", async () => {
    const result = await safeFetch(`https://${NAME}/hello`, { method: "HEAD" }, deps(() => port));
    expect(result).toMatchObject({ ok: true, status: 200, truncated: false });
    expect(result.ok && result.body.length).toBe(0);
  });

  it("reads a long body only up to the cap and drops the connection", async () => {
    const result = await safeFetch(`https://${NAME}/big`, { maxBodyBytes: 4096 }, deps(() => port));
    expect(result).toMatchObject({ ok: true, status: 200, truncated: true });
    expect(result.ok && result.body.length).toBe(4096);
    expect(result.ok && result.body.every(byte => byte === 0x61)).toBe(true);
  });

  it("reads a body that ends in the same read that crosses the cap, and does not finish twice", async () => {
    const result = await safeFetch(`https://${NAME}/oneshot`, { maxBodyBytes: 4096 }, deps(() => port));
    expect(result).toMatchObject({ ok: true, status: 200, truncated: true });
    expect(result.ok && result.body.length).toBe(4096);
    expect(result.ok && result.bodySha256).toBe(createHash("sha256").update(Buffer.alloc(4096, "a")).digest("hex"));
    // The response's own 'end' is queued behind this; finishing twice would throw there and fail the run.
    await new Promise(done => setTimeout(done, 50));
  });

  it("is a 404 answer, a fact, and not a failure", async () => {
    expect(await safeFetch(`https://${NAME}/missing`, {}, deps(() => port))).toMatchObject({ ok: true, status: 404 });
  });

  it("gives up on a host that starts to answer and never finishes, at the deadline", async () => {
    const started = Date.now();
    const result = await safeFetch(`https://${NAME}/slow`, { timeoutMs: 400 }, deps(() => port));
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("is a reason when the host drops the connection", async () => {
    const result = await safeFetch(`https://${NAME}/drop`, {}, deps(() => port));
    expect(result.ok).toBe(false);
    expect(result.ok === false && ["connection_failed", "tls_failed"]).toContain(result.ok === false ? result.reason : "");
  });

  it("is refused to a port that nothing listens on, as a reason", async () => {
    const result = await safeFetch(`https://${NAME}/hello`, {}, deps(() => 1));
    expect(result).toMatchObject({ ok: false, reason: "connection_failed" });
  });
});
