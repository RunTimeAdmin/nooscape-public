import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { immutableAssets } from "./_core/vite";

/** Hashed build files may be cached for a year and never revalidated; the HTML that names them may not. */
describe("static caching", () => {
  let dir = "";
  let server: Server;
  let base = "";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "nooscape-static-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets", "index-8phthGM6.js"), "console.log(1)");
    writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
    writeFileSync(path.join(dir, "robots.txt"), "User-agent: *");
    const app = express();
    // The order serveStatic uses.
    app.use("/assets", immutableAssets(dir));
    app.use(express.static(dir));
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets a browser keep a hashed asset for a year", async () => {
    const response = await fetch(`${base}/assets/index-8phthGM6.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("still revalidates the page and the files that are not hashed", async () => {
    for (const file of ["/index.html", "/robots.txt"]) {
      const cache = (await fetch(`${base}${file}`)).headers.get("cache-control") ?? "";
      expect(cache).not.toContain("immutable");
      expect(cache).toContain("max-age=0");
    }
  });

  it("does not serve a file outside the assets folder under /assets", async () => {
    expect((await fetch(`${base}/assets/../index.html`)).headers.get("cache-control") ?? "").not.toContain("immutable");
    expect((await fetch(`${base}/assets/robots.txt`)).status).toBe(404);
  });
});
