import express from "express";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SITE_ORIGIN } from "@shared/owlsCatch";
import { EXACT_CLIENT_ROUTES } from "./clientRoutes";
import { CIRCUIT_OPEN_CODE } from "./dbBreaker";
import { ROUTE_HEADS, ROUTES_WITH_THEIR_OWN_HEAD } from "./routeHead";
import { agentUrl, catchDayUrl, dynamicSitemapUrls, flaggedSitemapUrls, SITEMAP_CACHE_MS, SITEMAP_MAX_URLS, SITEMAP_RETRY_MS, sitemapLocs, sitemapRoute, sitemapXml, type SitemapDeps } from "./sitemap";

/**
 * /sitemap.xml is what a search engine is told to read, so it must list every page that may be indexed, only those, and never
 * fail. The fixed pages are kept in client/public/sitemap.xml and checked here against the routes and the page heads: a page
 * that asks to be indexed has to be listed, and a page that asks to be left out may not be. The reviewed records and the catch
 * days are added by the server and are tested here with a database that can be made to fail.
 */
const here = import.meta.dirname;
const read = (...parts: string[]) => fs.readFileSync(path.resolve(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const STATIC_FILE = read("..", "client", "public", "sitemap.xml");
const FIXED = sitemapLocs(STATIC_FILE);

describe("the sitemap text", () => {
  it("reads the addresses of a file, and unescapes them", () => {
    expect(sitemapLocs("<urlset><url><loc>https://x.test/a?b=1&amp;c=2</loc></url><url><loc> https://x.test/b </loc></url></urlset>")).toEqual(["https://x.test/a?b=1&c=2", "https://x.test/b"]);
    expect(sitemapLocs("")).toEqual([]);
  });

  it("writes the same layout as the file the fixed pages are kept in, so the two cannot drift apart", () => {
    expect(sitemapXml(FIXED)).toBe(STATIC_FILE.endsWith("\n") ? STATIC_FILE : `${STATIC_FILE}\n`);
  });

  it("escapes what must be escaped, drops repeats, and stops at the protocol's limit", () => {
    expect(sitemapXml(["https://x.test/a?b=1&c=<2>"])).toContain("<loc>https://x.test/a?b=1&amp;c=&lt;2&gt;</loc>");
    expect(sitemapLocs(sitemapXml(["https://x.test/a", "https://x.test/b", "https://x.test/a"]))).toEqual(["https://x.test/a", "https://x.test/b"]);
    const many = Array.from({ length: SITEMAP_MAX_URLS + 10 }, (_, index) => `https://x.test/${index}`);
    expect(sitemapLocs(sitemapXml(many))).toHaveLength(SITEMAP_MAX_URLS);
  });

  it("addresses a reviewed record and a catch day on the site's own origin", () => {
    expect(agentUrl("6f1c2d3e-aaaa-bbbb-cccc-0123456789ab")).toBe(`${SITE_ORIGIN}/agents/6f1c2d3e-aaaa-bbbb-cccc-0123456789ab`);
    expect(agentUrl("a b/c")).toBe(`${SITE_ORIGIN}/agents/a%20b%2Fc`);
    expect(catchDayUrl("2026-10-15")).toBe(`${SITE_ORIGIN}/catch/2026-10-15`);
  });
});

describe("the pages behind a switch that the sitemap lists", () => {
  it("lists the Arc, Base and Ethereum pages and the census reports of Arc and Base once their switches are on, and no scaffold page", () => {
    expect(flaggedSitemapUrls(undefined)).toEqual([]);
    expect(flaggedSitemapUrls("")).toEqual([]);
    expect(flaggedSitemapUrls("watch,patrols,claims")).toEqual([]);
    expect(flaggedSitemapUrls("chain_ethereum")).toEqual([`${SITE_ORIGIN}/chains/ethereum`]);
    expect(flaggedSitemapUrls("chain_ethereum,chain_base,chain_arc")).toEqual([
      `${SITE_ORIGIN}/chains/arc`,
      `${SITE_ORIGIN}/field/arc-registry-2026-10-20`,
      `${SITE_ORIGIN}/chains/base`,
      `${SITE_ORIGIN}/field/base-registry-2026-10-21`,
      `${SITE_ORIGIN}/chains/ethereum`,
    ]);
    expect(flaggedSitemapUrls("chain_base")).toEqual([`${SITE_ORIGIN}/chains/base`, `${SITE_ORIGIN}/field/base-registry-2026-10-21`]);
    expect(flaggedSitemapUrls("chain_base,chain_arc")).toEqual([
      `${SITE_ORIGIN}/chains/arc`,
      `${SITE_ORIGIN}/field/arc-registry-2026-10-20`,
      `${SITE_ORIGIN}/chains/base`,
      `${SITE_ORIGIN}/field/base-registry-2026-10-21`,
    ]);
    expect(flaggedSitemapUrls("chain_arc")).toEqual([`${SITE_ORIGIN}/chains/arc`, `${SITE_ORIGIN}/field/arc-registry-2026-10-20`]);
    expect(flaggedSitemapUrls(" Watch , CHAIN_ARC ")).toEqual([`${SITE_ORIGIN}/chains/arc`, `${SITE_ORIGIN}/field/arc-registry-2026-10-20`]);
  });
});

describe("the lists the server adds", () => {
  const make = (over: Partial<SitemapDeps> = {}) => {
    const clock = { now: 1_000_000 };
    const reads = { agents: 0, catches: 0 };
    const deps: SitemapDeps = {
      readAgentIds: async () => {
        reads.agents += 1;
        return ["b-agent", "a-agent"];
      },
      readCatchDates: async () => {
        reads.catches += 1;
        return ["2026-10-17", "2026-10-15"];
      },
      now: () => clock.now,
      ...over,
    };
    return { clock, reads, deps, urls: dynamicSitemapUrls(deps) };
  };

  afterEach(() => vi.restoreAllMocks());

  it("lists the catch days as they were given, newest first, then the reviewed records in a fixed order", async () => {
    const { urls } = make();
    expect(await urls()).toEqual([`${SITE_ORIGIN}/catch/2026-10-17`, `${SITE_ORIGIN}/catch/2026-10-15`, `${SITE_ORIGIN}/agents/a-agent`, `${SITE_ORIGIN}/agents/b-agent`]);
  });

  it("reads each list once in ten minutes, and again after that", async () => {
    const { urls, reads, clock } = make();
    await urls();
    await urls();
    clock.now += SITEMAP_CACHE_MS - 1;
    await urls();
    expect(reads).toEqual({ agents: 1, catches: 1 });
    clock.now += 2;
    await urls();
    expect(reads).toEqual({ agents: 2, catches: 2 });
  });

  it("keeps the last list it read when a read fails, tries again after a minute, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = false;
    const { urls, reads, clock } = make({
      readAgentIds: async () => {
        if (fail) throw new Error("database down");
        return ["a-agent"];
      },
    });
    expect(await urls()).toContain(`${SITE_ORIGIN}/agents/a-agent`);
    fail = true;
    clock.now += SITEMAP_CACHE_MS + 1;
    expect(await urls()).toContain(`${SITE_ORIGIN}/agents/a-agent`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("sending the last one that was read");
    // Within the minute it is not asked again; after it, it is.
    clock.now += SITEMAP_RETRY_MS - 1;
    await urls();
    expect(warn).toHaveBeenCalledTimes(1);
    clock.now += 2;
    fail = false;
    await urls();
    expect(reads.catches).toBeGreaterThanOrEqual(2);
  });

  it("sends none of a list it has never read when the read fails, and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { urls } = make({
      readAgentIds: async () => {
        throw new Error("database down");
      },
      readCatchDates: async () => {
        throw new Error("database down");
      },
    });
    await expect(urls()).resolves.toEqual([]);
    expect(String(warn.mock.calls[0]![0])).toContain("sending none");
  });

  it("does not log a read that failed because the database connections are paused, which the site already reports", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { urls } = make({
      readAgentIds: async () => {
        throw Object.assign(new Error("paused"), { code: CIRCUIT_OPEN_CODE });
      },
    });
    await urls();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("GET /sitemap.xml", () => {
  let dist: string;
  let server: Server;
  let base: string;
  let agents: () => Promise<string[]> = async () => [];
  let catches: () => Promise<string[]> = async () => [];

  beforeAll(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "sitemap-"));
    fs.writeFileSync(path.join(dist, "sitemap.xml"), STATIC_FILE);
    const app = express();
    // A fresh route for each request would hide the cache; one route, as the server mounts it, and a clock that does not move.
    app.use(sitemapRoute(dist, { readAgentIds: () => agents(), readCatchDates: () => catches(), now: () => 5 }));
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

  it("sends the fixed pages, the catch days and the reviewed records as XML that may be cached for an hour", async () => {
    agents = async () => ["id-one", "id-two"];
    catches = async () => ["2026-10-15"];
    const response = await fetch(`${base}/sitemap.xml`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const locs = sitemapLocs(await response.text());
    expect(locs.slice(0, FIXED.length)).toEqual(FIXED);
    expect(locs.slice(FIXED.length)).toEqual([`${SITE_ORIGIN}/catch/2026-10-15`, `${SITE_ORIGIN}/agents/id-one`, `${SITE_ORIGIN}/agents/id-two`]);
  });

  it("adds Arc's page right after the fixed pages while its switch is on, and leaves it out otherwise", async () => {
    const arc = `${SITE_ORIGIN}/chains/arc`;
    const census = `${SITE_ORIGIN}/field/arc-registry-2026-10-20`;
    const saved = process.env.VITE_FEATURES;
    try {
      delete process.env.VITE_FEATURES;
      expect(sitemapLocs(await (await fetch(`${base}/sitemap.xml`)).text())).not.toContain(arc);
      expect(sitemapLocs(await (await fetch(`${base}/sitemap.xml`)).text())).not.toContain(census);
      process.env.VITE_FEATURES = "chain_arc";
      const on = sitemapLocs(await (await fetch(`${base}/sitemap.xml`)).text());
      expect(on.slice(0, FIXED.length)).toEqual(FIXED);
      expect(on.slice(FIXED.length, FIXED.length + 2)).toEqual([arc, census]);
      expect(on.filter(url => url === arc || url === census)).toHaveLength(2);
    } finally {
      if (saved === undefined) delete process.env.VITE_FEATURES;
      else process.env.VITE_FEATURES = saved;
    }
  });

  it("adds Base's page and its census right after the fixed pages while its switch is on, after Arc's when both are, and leaves them out otherwise", async () => {
    const page = `${SITE_ORIGIN}/chains/base`;
    const census = `${SITE_ORIGIN}/field/base-registry-2026-10-21`;
    const saved = process.env.VITE_FEATURES;
    try {
      delete process.env.VITE_FEATURES;
      expect(sitemapLocs(await (await fetch(`${base}/sitemap.xml`)).text())).not.toContain(page);
      process.env.VITE_FEATURES = "chain_arc";
      expect(sitemapLocs(await (await fetch(`${base}/sitemap.xml`)).text())).not.toContain(page);
      process.env.VITE_FEATURES = "chain_base";
      const on = sitemapLocs(await (await fetch(`${base}/sitemap.xml`)).text());
      expect(on.slice(0, FIXED.length)).toEqual(FIXED);
      expect(on.slice(FIXED.length, FIXED.length + 2)).toEqual([page, census]);
      expect(on.filter(url => url === page || url === census)).toHaveLength(2);
      process.env.VITE_FEATURES = "chain_base,chain_arc";
      const both = sitemapLocs(await (await fetch(`${base}/sitemap.xml`)).text());
      expect(both.slice(FIXED.length, FIXED.length + 4)).toEqual([`${SITE_ORIGIN}/chains/arc`, `${SITE_ORIGIN}/field/arc-registry-2026-10-20`, page, census]);
    } finally {
      if (saved === undefined) delete process.env.VITE_FEATURES;
      else process.env.VITE_FEATURES = saved;
    }
  });

  it("answers a HEAD request like the GET, with no body", async () => {
    const response = await fetch(`${base}/sitemap.xml`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await response.text()).toBe("");
  });
});

describe("GET /sitemap.xml when the database cannot be read", () => {
  it("still sends the fixed pages, with a 200", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "sitemap-down-"));
    fs.writeFileSync(path.join(dist, "sitemap.xml"), STATIC_FILE);
    const down = async (): Promise<string[]> => {
      throw new Error("database down");
    };
    const app = express();
    app.use(sitemapRoute(dist, { readAgentIds: down, readCatchDates: down, now: () => 5 }));
    const server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/sitemap.xml`);
      expect(response.status).toBe(200);
      expect(sitemapLocs(await response.text())).toEqual(FIXED);
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });

  it("leaves the request to the static handler and the fallback when there is no file of fixed pages", async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "sitemap-none-"));
    const app = express();
    app.use(sitemapRoute(dist, { readAgentIds: async () => [], readCatchDates: async () => [], now: () => 5 }));
    app.use((_req, res) => {
      res.status(200).send("FALLBACK");
    });
    const server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      expect(await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/sitemap.xml`)).text()).toBe("FALLBACK");
    } finally {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe("the fixed pages in the file", () => {
  const pathOf = (url: string) => url.slice(SITE_ORIGIN.length);
  // A page asks to be left out with a robots rule of its own in the table of page heads; the home page and the catch archive keep their own heads.
  const asksToBeIndexed = (route: string) => ROUTES_WITH_THEIR_OWN_HEAD.includes(route) || (route in ROUTE_HEADS && ROUTE_HEADS[route]!.robots === undefined);

  it("are each on the site's origin, a route the app draws, and listed once", () => {
    expect(FIXED.length).toBeGreaterThan(10);
    expect(new Set(FIXED).size).toBe(FIXED.length);
    for (const url of FIXED) {
      expect(url.startsWith(SITE_ORIGIN), url).toBe(true);
      expect(EXACT_CLIENT_ROUTES as readonly string[], url).toContain(pathOf(url));
    }
  });

  it("are only pages that ask to be indexed, so the sitemap never contradicts a page's own head", () => {
    for (const url of FIXED) expect(asksToBeIndexed(pathOf(url)), `${url} asks to be left out of search`).toBe(true);
  });

  it("are every page that asks to be indexed, so a page added to the app has to be listed", () => {
    const listed = new Set(FIXED.map(pathOf));
    const missing = EXACT_CLIENT_ROUTES.filter(route => asksToBeIndexed(route) && !listed.has(route));
    expect(missing, `routes that may be indexed and are not in client/public/sitemap.xml: ${missing.join(", ")}`).toEqual([]);
  });

  it("do not list a page that comes and goes, which the server adds, or a page behind a feature switch", () => {
    for (const url of FIXED) expect(pathOf(url)).not.toMatch(/^\/(agents|catch\/|watch|patrols|admin)/);
  });
});

describe("how it is mounted and found", () => {
  it("is served before the static files, which would send the fixed pages alone", () => {
    const vite = read("_core", "vite.ts");
    expect(vite).toContain("app.use(sitemapRoute(distPath));");
    expect(vite.indexOf("app.use(sitemapRoute(distPath));")).toBeLessThan(vite.indexOf("app.use(express.static(distPath));"));
  });

  it("lists the reviewed records that are served, and never the directory's entries", () => {
    const source = read("sitemap.ts");
    expect(source).toContain("(await listLiveAtlasRecords()).map(record => record.agentId)");
    expect(source).not.toMatch(/agentDirectoryEntries|searchAgentDirectory|listAgentDirectory/);
  });

  it("is the sitemap the robots file names", () => {
    expect(read("..", "client", "public", "robots.txt")).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });
});
