import express from "express";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { archiveMeta, dayMeta, noCatchMeta, type PublicCatch } from "@shared/owlsCatch";
import { buildCspFromHtml } from "./_core/securityHeaders";
import { catchPages, injectHead } from "./catchPage";
import { CIRCUIT_OPEN_CODE } from "./dbBreaker";

/**
 * The head the server writes for /catch and /catch/:date, so a link preview reads the day's finding: what changes in the
 * page and what must not, the status each kind of path gets, and that a failure to read the catch sends the ordinary
 * page. The shell is the site's real index.html with an inline script added, as the built page has one.
 */
const SCRIPT = "window.__RUNTIME__ = 1;\n(function () { /* inline */ })();";
const SOURCE_SHELL = fs.readFileSync(path.resolve(import.meta.dirname, "../client/index.html"), "utf8").replace("</head>", `<script id="runtime">${SCRIPT}</script></head>`);

const view = (over: Partial<PublicCatch> = {}): PublicCatch => ({
  date: "2026-10-15",
  rule: "fleet",
  headline: "One registering wallet is recorded against 5,593 identities.",
  detail: "Wallet 0x62d3…575c.",
  howWeKnow: "Chosen on 2026-10-15 (UTC) by a fixed rule.",
  agents: [{ id: "a1", name: "Agent 1" }],
  selectedAt: "2026-10-15T00:15:02.000Z",
  ...over,
});

const tag = (html: string, pattern: RegExp) => pattern.exec(html)?.[0] ?? "";
const flat = (html: string) => html.replace(/\s+/g, " ");

describe("what the head says", () => {
  it("gives a day's page its own title, description, preview text, address and robots rule", () => {
    const html = flat(injectHead(SOURCE_SHELL, dayMeta(view())));
    expect(html).toContain("<title>The Owl&#39;s Catch, 15 Oct 2026 | Nooscape</title>");
    expect(html).toContain('content="One registering wallet is recorded against 5,593 identities. One finding a day from Nooscape&#39;s public record, picked by a fixed rule; a count, never a score."');
    expect(tag(html, /<meta property="og:title"[^>]*>/)).toContain('content="The Owl&#39;s Catch, 15 Oct 2026"');
    expect(tag(html, /<meta property="og:url"[^>]*>/)).toContain('content="https://nooscape.si/catch/2026-10-15"');
    expect(tag(html, /<meta name="twitter:title"[^>]*>/)).toContain('content="The Owl&#39;s Catch, 15 Oct 2026"');
    expect(tag(html, /<meta property="og:description"[^>]*>/)).toContain("One registering wallet is recorded against 5,593 identities.");
    expect(tag(html, /<meta name="twitter:description"[^>]*>/)).toContain("One registering wallet is recorded against 5,593 identities.");
    expect(tag(html, /<link rel="canonical"[^>]*>/)).toContain('href="https://nooscape.si/catch/2026-10-15"');
    expect(tag(html, /<meta name="robots"[^>]*>/)).toContain('content="index, follow, max-image-preview:large"');
  });

  it("keeps a day with no catch out of search", () => {
    const html = flat(injectHead(SOURCE_SHELL, noCatchMeta("2026-10-12")));
    expect(html).toContain("<title>No catch on 12 Oct 2026 | Nooscape</title>");
    expect(tag(html, /<meta name="robots"[^>]*>/)).toContain('content="noindex, follow"');
  });

  it("changes nothing else: the image, the card type, the site name and every other tag stay as they were", () => {
    const after = injectHead(SOURCE_SHELL, dayMeta(view()));
    const names = (html: string) => (html.match(/<(?:meta|link)\b[^>]*>/g) ?? []).map(found => found.replace(/\s+/g, " ").replace(/\bcontent="[^"]*"|\bhref="[^"]*"/g, "")).sort();
    expect(names(after)).toEqual(names(SOURCE_SHELL));
    for (const kept of ['property="og:image"', 'property="og:type"', 'property="og:site_name"', 'name="twitter:card"', 'name="twitter:image"', 'name="theme-color"', 'rel="manifest"']) {
      expect(tag(flat(after), new RegExp(`<(?:meta|link)\\b[^>]*${kept}[^>]*>`))).toBe(tag(flat(SOURCE_SHELL), new RegExp(`<(?:meta|link)\\b[^>]*${kept}[^>]*>`)));
    }
  });

  it("leaves every script as it was, so the policy the server derives from the page does not change", () => {
    const after = injectHead(SOURCE_SHELL, dayMeta(view()));
    expect(after).toContain(`<script id="runtime">${SCRIPT}</script>`);
    expect(buildCspFromHtml(after)).toEqual(buildCspFromHtml(SOURCE_SHELL));
    expect(buildCspFromHtml(after).inlineScriptHashes).toEqual([`'sha256-${createHash("sha256").update(SCRIPT, "utf8").digest("base64")}'`]);
  });

  it("escapes what a headline could hold, and treats replacement patterns in it as text", () => {
    const hostile = 'a "quoted" <b>bold</b> & $& $1 $` \'x\' </title><script>alert(1)</script>';
    const escaped = "a &quot;quoted&quot; &lt;b&gt;bold&lt;/b&gt; &amp; $&amp; $1 $` &#39;x&#39; &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;";
    const html = injectHead(SOURCE_SHELL, { ...dayMeta(view()), description: hostile, heading: hostile, title: hostile, url: `https://nooscape.si/catch/${hostile}` });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>bold</b>");
    expect(tag(flat(html), /<title>[^<]*<\/title>/)).toBe(`<title>${escaped}</title>`);
    // Every tag that takes the text holds it exactly, so none of them reads `$&` or `$1` as a replacement pattern.
    for (const pattern of [/<meta name="description"[^>]*>/, /<meta property="og:title"[^>]*>/, /<meta property="og:description"[^>]*>/, /<meta name="twitter:title"[^>]*>/, /<meta name="twitter:description"[^>]*>/]) {
      expect(tag(flat(html), pattern), String(pattern)).toContain(`content="${escaped}"`);
    }
    for (const pattern of [/<meta property="og:url"[^>]*>/, /<link rel="canonical"[^>]*>/]) {
      expect(tag(flat(html), pattern), String(pattern)).toContain(`https://nooscape.si/catch/${escaped}"`);
    }
  });

  it("adds no tag the page does not have", () => {
    const bare = "<!doctype html><html><head><title>T</title><meta name=\"description\" content=\"d\"></head><body></body></html>";
    const out = injectHead(bare, dayMeta(view()));
    expect(out).toContain("<title>The Owl&#39;s Catch, 15 Oct 2026 | Nooscape</title>");
    expect(out).not.toContain("og:title");
    expect(out).not.toContain("canonical");
    expect(out).toContain("One registering wallet is recorded against 5,593 identities.");
  });

  it("is the archive's own head for /catch", () => {
    const html = flat(injectHead(SOURCE_SHELL, archiveMeta()));
    expect(html).toContain("<title>The Owl&#39;s Catch | Nooscape</title>");
    expect(tag(html, /<link rel="canonical"[^>]*>/)).toContain('href="https://nooscape.si/catch"');
  });
});

describe("the routes", () => {
  let dist: string;
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base: string;
  const reads: string[] = [];
  let next: () => Promise<PublicCatch | null> = async () => null;

  beforeAll(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "catch-page-"));
    fs.writeFileSync(path.join(dist, "index.html"), SOURCE_SHELL);
    const app = express();
    app.use(
      catchPages(dist, {
        readCatch: async date => {
          reads.push(date);
          return next();
        },
      }),
    );
    app.use("*", (_req, res) => {
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

  afterEach(() => {
    reads.length = 0;
    next = async () => null;
    vi.restoreAllMocks();
  });

  const get = async (pathname: string, init?: RequestInit) => {
    const response = await fetch(base + pathname, init);
    return { status: response.status, headers: response.headers, body: await response.text() };
  };

  it("serves the archive with its own head, as a page that may be cached for a minute", async () => {
    const page = await get("/catch");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("public, max-age=60");
    expect(page.body).toContain("<title>The Owl&#39;s Catch | Nooscape</title>");
    expect(reads).toEqual([]);
  });

  it("serves a day that has a catch as 200 with that day's head", async () => {
    next = async () => view();
    const page = await get("/catch/2026-10-15");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>The Owl&#39;s Catch, 15 Oct 2026 | Nooscape</title>");
    expect(page.body).toContain("recorded against 5,593 identities.");
    expect(reads).toEqual(["2026-10-15"]);
  });

  it("serves a date with no catch as 404 with the same page, kept out of search", async () => {
    const page = await get("/catch/2026-10-12");
    expect(page.status).toBe(404);
    expect(page.body).toContain("<title>No catch on 12 Oct 2026 | Nooscape</title>");
    expect(page.body).toContain('content="noindex, follow"');
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("serves a path that is not a date as 404, without asking for it and without repeating it", async () => {
    for (const bad of ["yesterday", "2026-02-30", "2026-13-01", "%3Cscript%3Ealert(1)%3C%2Fscript%3E", "20261015"]) {
      const page = await get(`/catch/${bad}`);
      expect(page.status, bad).toBe(404);
      expect(page.body, bad).toContain("<title>That is not a date | Nooscape</title>");
      expect(page.body, bad).not.toContain("alert(1)");
    }
    expect(reads).toEqual([]);
  });

  it("ignores a query string, and answers HEAD with the headers only", async () => {
    next = async () => view();
    expect((await get("/catch/2026-10-15?utm_source=x")).status).toBe(200);
    expect((await get("/catch?ref=x")).status).toBe(200);
    const head = await get("/catch/2026-10-15", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("leaves a path that is not exactly the route to the ordinary fallback: a trailing slash, another method, another path", async () => {
    next = async () => view();
    expect((await get("/catch/")).body).toBe("FALLBACK");
    expect((await get("/catch/2026-10-15/")).body).toBe("FALLBACK");
    expect((await get("/catch/2026-10-15", { method: "POST" })).body).toBe("FALLBACK");
    expect((await get("/agents/abc")).body).toBe("FALLBACK");
    expect((await get("/catchall")).body).toBe("FALLBACK");
    expect(reads).toEqual([]);
  });

  it("sends the ordinary page, not an error, when the catch cannot be read, and says so once in the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    next = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3306 password=hunter2");
    };
    const page = await get("/catch/2026-10-15");
    expect(page.status).toBe(200);
    expect(page.body).toBe("FALLBACK");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("hunter2");
  });

  it("says nothing in the log when the database breaker has already said it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    next = async () => {
      throw Object.assign(new Error("paused"), { code: CIRCUIT_OPEN_CODE });
    };
    expect((await get("/catch/2026-10-15")).body).toBe("FALLBACK");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("a deploy with no built page", () => {
  it("falls through to the ordinary fallback rather than failing", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "catch-page-empty-"));
    const app = express();
    app.use(catchPages(empty, { readCatch: async () => view() }));
    app.use("*", (_req, res) => {
      res.status(200).send("FALLBACK");
    });
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await (await fetch(`${base}/catch`)).text()).toBe("FALLBACK");
      expect(await (await fetch(`${base}/catch/2026-10-15`)).text()).toBe("FALLBACK");
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("where the routes are mounted", () => {
  it("come in serveStatic after the static files and before the fallback, so a built file is never shadowed and the fallback never answers first", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "_core/vite.ts"), "utf8").split("\r\n").join("\n");
    const at = (text: string) => source.indexOf(text);
    expect(at("app.use(express.static(distPath));")).toBeGreaterThan(-1);
    expect(at("app.use(express.static(distPath));")).toBeLessThan(at("app.use(catchPages(distPath));"));
    expect(at("app.use(catchPages(distPath));")).toBeLessThan(at('app.use("*", (req, res) => {'));
  });
});
