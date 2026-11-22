import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportDates, NO_EXPORT_DAY_MESSAGE, NO_EXPORT_MESSAGE } from "./apiExports";
import { registerApiV1, type ApiV1Deps, type KeyAccess } from "./apiV1";
import { problems, schemaOf } from "./apiV1Testing";
import { resetRateLimits } from "./rateLimit";

/**
 * The daily export's downloads: a day is offered only when both its files are there, the newest day is the latest, a day's manifest is
 * served byte for byte as written, and its gzip file as a download. Free, and the same for every caller.
 */

const KEY = `nsk_${"a".repeat(40)}`;
const consumed: string[] = [];
const keys: KeyAccess = {
  resolve: async raw => (raw === KEY ? { id: "key-free", tier: "free", prefix: "nsk_aaaaaa" } : null),
  consume: async (_id, perDay, endpoint) => {
    consumed.push(endpoint);
    return { allowed: true, limit: perDay, used: 1, remaining: perDay - 1, resetsAt: new Date("2026-11-23T00:00:00Z") };
  },
  usage: async () => ({ today: { date: "2026-11-22", used: 0, remaining: 1000, limit: 1000, resetsAt: new Date() }, days: [] }),
};

const unused = async () => {
  throw new Error("not read by an export route");
};
const deps = (exportsDir: string | null): ApiV1Deps => ({
  now: () => new Date("2026-11-22T12:00:00Z"),
  findEntries: unused,
  getEntry: unused,
  search: unused,
  keysOf: unused,
  claimOf: unused,
  claimHistory: unused,
  checkFacts: unused,
  stats: unused,
  keys,
  exportsDir: () => exportsDir,
});

const manifestOf = (date: string, bytes: number) => {
  const payload = {
    format: "nooscape-export-v1",
    dataset: "agents",
    date,
    generated_at: `${date}T02:00:00.000Z`,
    file: { name: `agents-${date}.jsonl.gz`, bytes, sha256: "0".repeat(64) },
    rows: 1,
    rows_by_chain: { celo: 1 },
    chains_last_pass: { celo: `${date}T01:00:00.000Z`, monad: null },
    fields: ["chain"],
    statement: "Acknowledged means a source listed this agent.",
    license: { name: "CC BY 4.0" },
  };
  return {
    format: "nooscape-export-v1",
    payload,
    signed_payload: JSON.stringify(payload),
    signature: { algorithm: "Ed25519", value: "c2ln", payload_sha256: "1".repeat(64), key_id: "relay-1", public_key_pem: "-----BEGIN PUBLIC KEY-----", key_list: "https://nooscape.si/.well-known/nooscape-keys.json" },
  };
};

let dir = "";
let server: Server | null = null;
let base = "";

async function start(exportsDir: string | null) {
  await stop();
  const app = express();
  registerApiV1(app, deps(exportsDir));
  await new Promise<void>(done => {
    server = app.listen(0, "127.0.0.1", () => done());
  });
  const address = server!.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}
async function stop() {
  if (!server) return;
  await new Promise<void>(done => server!.close(() => done()));
  server = null;
}
const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nooscape-exports-"));
  const gz = (date: string) => Buffer.from(`gzip bytes for ${date}`);
  for (const date of ["2026-11-20", "2026-11-22"]) {
    await writeFile(join(dir, `agents-${date}.jsonl.gz`), gz(date));
    await writeFile(join(dir, `agents-${date}.manifest.json`), `${JSON.stringify(manifestOf(date, gz(date).length), null, 2)}\n`);
  }
  // A manifest whose file is gone, and a file still being written with no manifest yet: neither day is offered.
  await writeFile(join(dir, "agents-2026-11-23.manifest.json"), JSON.stringify(manifestOf("2026-11-23", 1)));
  await writeFile(join(dir, "agents-2026-11-24.jsonl.gz.part"), "partial");
  await writeFile(join(dir, "agents-2026-11-24.jsonl.gz"), "whole but no manifest");
});
beforeEach(() => {
  resetRateLimits();
  consumed.length = 0;
});
afterAll(async () => {
  await stop();
  await rm(dir, { recursive: true, force: true });
});

describe("the days on offer", () => {
  it("are the days with both files, newest first, and a folder that does not exist offers none", async () => {
    expect(await exportDates(dir)).toEqual(["2026-11-22", "2026-11-20"]);
    expect(await exportDates(join(dir, "missing"))).toEqual([]);
  });
});

describe("the export downloads", () => {
  beforeAll(() => start(dir));

  it("answers the newest day's manifest as latest, byte for byte as written, public for five minutes", async () => {
    const response = await get("/api/v1/exports/agents/latest");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.text()).toBe(await readFile(join(dir, "agents-2026-11-22.manifest.json"), "utf8"));
  });

  it("answers a day's manifest, and the manifest is what the document describes", async () => {
    const response = await get("/api/v1/exports/agents/2026-11-20");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const manifest = await response.json();
    expect(manifest.payload.date).toBe("2026-11-20");
    expect(problems(schemaOf("ExportManifest"), manifest)).toEqual([]);
  });

  it("serves a day's file as a gzip download with its length, and HEAD gives the headers alone", async () => {
    const response = await get("/api/v1/exports/agents/2026-11-22/data");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="agents-2026-11-22.jsonl.gz"');
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.equals(await readFile(join(dir, "agents-2026-11-22.jsonl.gz")))).toBe(true);
    const head = await get("/api/v1/exports/agents/2026-11-22/data", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
  });

  it("offers no day whose file is gone or whose manifest is not written yet", async () => {
    for (const path of ["/api/v1/exports/agents/2026-11-23", "/api/v1/exports/agents/2026-11-23/data", "/api/v1/exports/agents/2026-11-24", "/api/v1/exports/agents/2026-11-24/data", "/api/v1/exports/agents/2026-11-21/data"]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect((await response.json()).error).toEqual({ code: "not_found", message: NO_EXPORT_DAY_MESSAGE });
    }
  });

  it("refuses a date that is not a day, and serves nothing outside the folder", async () => {
    for (const path of ["/api/v1/exports/agents/2026-1-2", "/api/v1/exports/agents/yesterday/data", "/api/v1/exports/agents/..%2F..%2Fpackage.json/data"]) {
      const response = await get(path);
      expect(response.status, path).toBe(400);
      expect((await response.json()).error.code).toBe("bad_request");
    }
  });

  it("needs no key, and with one counts the request as an export", async () => {
    expect((await get("/api/v1/exports/agents/latest")).status).toBe(200);
    expect(consumed).toEqual([]);
    expect((await get("/api/v1/exports/agents/latest", { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(200);
    expect(consumed).toEqual(["exports"]);
  });

  it("is listed in the API's index", async () => {
    const index = await (await get("/api/v1")).json();
    const paths = (index.endpoints as Array<{ method: string; path: string }>).filter(endpoint => endpoint.path.startsWith("/api/v1/exports/")).map(endpoint => `${endpoint.method} ${endpoint.path}`);
    expect(paths).toEqual(["GET /api/v1/exports/agents/latest", "GET /api/v1/exports/agents/{date}", "GET /api/v1/exports/agents/{date}/data"]);
  });

  it("is read only", async () => {
    const response = await fetch(`${base}/api/v1/exports/agents/latest`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});

describe("with no export yet", () => {
  it("says none has been published, with no folder set and with an empty one", async () => {
    const empty = await mkdtemp(join(tmpdir(), "nooscape-exports-empty-"));
    try {
      for (const folder of [null, empty, join(empty, "missing")]) {
        await start(folder);
        const response = await get("/api/v1/exports/agents/latest");
        expect(response.status).toBe(404);
        expect((await response.json()).error).toEqual({ code: "not_found", message: NO_EXPORT_MESSAGE });
        expect((await get("/api/v1/exports/agents/2026-11-22")).status).toBe(404);
      }
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
