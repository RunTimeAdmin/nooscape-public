import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchUnderDeadline } from "./deadlineFetch";

class DomainError extends Error {}

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"hello":"world"}');
    } else if (req.url === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      res.end();
    } else if (req.url === "/stalled-body") {
      // Headers arrive, then the body never completes.
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const adapter = {
  init: { method: "GET" } as const,
  timeoutMs: 300,
  isDomainError: (error: unknown) => error instanceof DomainError,
  onTimeout: () => new DomainError("timed out"),
  onFailure: () => new DomainError("failed"),
};

describe("fetchUnderDeadline", () => {
  it("returns the response and the value read under the deadline", async () => {
    const { response, body } = await fetchUnderDeadline({
      ...adapter,
      url: `${base}/ok`,
      read: res => res.json() as Promise<{ hello: string }>,
    });
    expect(response.status).toBe(200);
    expect(body).toEqual({ hello: "world" });
  });

  it("keeps the timer armed through the body read, so a stalled body times out", async () => {
    const started = Date.now();
    await expect(
      fetchUnderDeadline({ ...adapter, url: `${base}/stalled-body`, read: res => res.text() })
    ).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("passes a domain error thrown by read through untouched", async () => {
    await expect(
      fetchUnderDeadline({
        ...adapter,
        url: `${base}/ok`,
        read: async () => {
          throw new DomainError("HTTP 500");
        },
      })
    ).rejects.toThrow("HTTP 500");
  });

  it("refuses to follow a redirect and reports it as the adapter's failure", async () => {
    await expect(
      fetchUnderDeadline({ ...adapter, url: `${base}/redirect`, read: res => res.text() })
    ).rejects.toThrow("failed");
  });
});
