import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listLiveAtlasRecords: vi.fn(async () => [{ agentId: "reviewed-7", displayName: "Reviewed Seven" }]),
  readAgentDirectoryHeadFacts: vi.fn(async (_id: string) => null),
}));
vi.mock("./db", async importOriginal => ({ ...(await importOriginal<typeof import("./db")>()), ...mocks }));

import { routeHeads } from "./routeHead";

/**
 * /agents/:id with the reader the server mounts, over a database that is a pair of counters. An id that is not a directory entry
 * is looked up among the reviewed records, which is a join over every reviewed snapshot: any number of ids, all of them new, must
 * cost one such read and not one each (the route has no rate limit of its own, and its per-id cache is keyed by the id asked for).
 */
const SHELL = fs.readFileSync(path.resolve(import.meta.dirname, "../client/index.html"), "utf8");

describe("/agents/:id with the default reader", () => {
  let dist: string;
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base: string;

  beforeAll(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "route-head-live-"));
    fs.writeFileSync(path.join(dist, "index.html"), SHELL);
    const app = express();
    app.use(routeHeads(dist));
    app.use((_req, res) => {
      res.status(200).send("FALLBACK");
    });
    await new Promise<void>(resolve => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it("reads the reviewed records once for any number of unknown ids, and still finds a reviewed record by its id", async () => {
    for (let index = 0; index < 150; index += 1) {
      const response = await fetch(`${base}/agents/${randomUUID()}`);
      expect(response.status).toBe(404);
      await response.text();
    }
    expect(mocks.readAgentDirectoryHeadFacts).toHaveBeenCalledTimes(150);
    expect(mocks.listLiveAtlasRecords).toHaveBeenCalledTimes(1);

    const reviewed = await (await fetch(`${base}/agents/reviewed-7`)).text();
    expect(reviewed).toContain("<title>Reviewed Seven | Nooscape</title>");
    expect(mocks.listLiveAtlasRecords).toHaveBeenCalledTimes(1);
  });
});
