import express from "express";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Google Search Console proves the operator owns nooscape.si by fetching this file from the root of the site and reading the
 * one line in it. The check is repeated from time to time, so removing or changing the file ends the verification without any
 * error here. These tests keep it: the file is in the public folder the build copies to the site's root, it holds exactly the
 * line Google gave, and a static handler serves it as it is.
 */
const NAME = "google4fa61f7c28f469e7.html";
const LINE = `google-site-verification: ${NAME}`;
const FILE = path.resolve(import.meta.dirname, "..", "client", "public", NAME);

describe("the Google Search Console verification file", () => {
  it("is in the public folder, named for its own token, and holds exactly the one line Google gave, with nothing else", () => {
    expect(fs.existsSync(FILE)).toBe(true);
    const bytes = fs.readFileSync(FILE);
    expect(bytes.toString("utf8")).toBe(LINE);
    // Plain ASCII: no byte-order mark and no trailing newline for a client to trip on.
    expect(bytes.length).toBe(LINE.length);
    expect(bytes.every(byte => byte < 0x80)).toBe(true);
  });

  describe("served from the root of the site", () => {
    let dist: string;
    let server: Server;
    let base: string;

    beforeAll(async () => {
      // What the build does: the public folder's files become the site's root. The server mounts express.static on that folder first.
      dist = fs.mkdtempSync(path.join(os.tmpdir(), "google-verify-"));
      fs.copyFileSync(FILE, path.join(dist, NAME));
      const app = express();
      app.use(express.static(dist));
      app.use((_req, res) => {
        res.status(404).send("FALLBACK");
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

    it("answers 200 with the line and nothing else", async () => {
      const response = await fetch(`${base}/${NAME}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(LINE);
    });
  });

  it("is mounted ahead of the page heads and the fallback, which would answer with the app's shell or a 404", () => {
    const vite = fs.readFileSync(path.resolve(import.meta.dirname, "_core", "vite.ts"), "utf8");
    const staticAt = vite.indexOf("app.use(express.static(distPath));");
    expect(staticAt).toBeGreaterThan(-1);
    expect(staticAt).toBeLessThan(vite.indexOf("app.use(routeHeads(distPath));"));
    // The fallback that follows it (the development server has a handler of its own earlier in the file).
    const fallbackAt = vite.indexOf('app.use("*"', staticAt);
    expect(fallbackAt).toBeGreaterThan(staticAt);
  });
});
