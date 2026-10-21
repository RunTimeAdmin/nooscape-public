import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { initTRPC } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRPC_MAX_BATCH_SIZE } from "@shared/trpcBatch";

/**
 * The rate limiter counts HTTP requests, so a batch with no cap lets one request carry hundreds of procedure calls (a
 * review sent 30 calls in one request and got 30 answers). The server refuses a batch over the shared cap, and the client
 * batches up to the same number, so neither side can drift from the other.
 */
describe("the tRPC batch cap", () => {
  const t = initTRPC.create();
  const router = t.router({ ping: t.procedure.query(() => "pong") });
  let server: Server;
  let base = "";

  beforeAll(async () => {
    const app = express();
    // The same options the relay mounts its router with (server/_core/index.ts), on a router that does nothing.
    app.use("/api/trpc", createExpressMiddleware({ router, maxBatchSize: TRPC_MAX_BATCH_SIZE }));
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const batch = (count: number) => fetch(`${base}/api/trpc/${Array.from({ length: count }, () => "ping").join(",")}?batch=1`);

  it("is ten, the size of the client's batches", () => {
    expect(TRPC_MAX_BATCH_SIZE).toBe(10);
  });

  it("answers a batch of exactly the cap, call by call", async () => {
    const response = await batch(TRPC_MAX_BATCH_SIZE);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ result?: { data: string } }>;
    expect(body).toHaveLength(TRPC_MAX_BATCH_SIZE);
    expect(body.every(entry => entry.result?.data === "pong")).toBe(true);
  });

  it("refuses a batch over the cap with a 400 and answers none of its calls", async () => {
    const response = await batch(TRPC_MAX_BATCH_SIZE + 1);
    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("pong");
  });

  it("refuses the 30-call batch the review sent", async () => {
    expect((await batch(30)).status).toBe(400);
  });
});

describe("the relay and the client use the one cap", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("mounts the real router with it", () => {
    expect(read("./_core/index.ts")).toMatch(/createExpressMiddleware\(\{[^}]*maxBatchSize: TRPC_MAX_BATCH_SIZE/s);
  });

  it("batches the client's calls up to it", () => {
    expect(read("../client/src/lib/trpcLinks.ts")).toMatch(/maxItems: TRPC_MAX_BATCH_SIZE/);
    expect(read("../client/src/main.tsx")).toMatch(/apiLinks\(\)/);
  });
});
