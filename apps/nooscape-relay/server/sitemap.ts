import express, { type Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { featureOn, type Feature } from "@shared/features";
import { catchPath, SITE_ORIGIN } from "@shared/owlsCatch";
import { isCircuitOpenError } from "./dbBreaker";
import { listLiveAtlasRecords } from "./db";
import { readCatchArchive } from "./owlsCatch";

/**
 * The sitemap that /sitemap.xml serves. The fixed pages are listed in client/public/sitemap.xml, which the build copies next to
 * the app; this adds the pages that come and go: one for each reviewed record that is served now (the records the public
 * reads serve, withdrawals out) and one for each day the Owl found a catch. Acknowledged directory entries are not listed: each
 * is a thin page that says what a source listed, and its head asks search engines to leave it out (server/routeHead.ts).
 *
 * A search engine reads this once in a while, so the answer is made at most every ten minutes and sent with a one hour cache
 * header. If the database cannot be read the fixed pages are still sent, with whatever was last read for the other two lists,
 * and never an error: a sitemap that failed would be worse than a short one.
 */

/** The sitemaps protocol allows 50,000 addresses in one file. */
export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_CACHE_MS = 10 * 60 * 1000;
/** How long a list that could not be read is left alone before the next try. */
export const SITEMAP_RETRY_MS = 60 * 1000;
/** The most catch days listed: the archive's own limit (server/owlsCatch.ts). */
const SITEMAP_MAX_CATCH_DAYS = 100;

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const unescapeXml = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The addresses in a sitemap file, in order. */
export function sitemapLocs(xml: string): string[] {
  return Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g), match => unescapeXml(match[1]!.trim()));
}

/** A sitemap for these addresses, in the same layout as the file the fixed pages are kept in. Repeats are dropped and the list stops at the protocol's limit. */
export function sitemapXml(urls: readonly string[]): string {
  const unique = Array.from(new Set(urls)).slice(0, SITEMAP_MAX_URLS);
  const entries = unique.map(url => `  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

/**
 * The pages behind a switch that the sitemap lists once the switch is on. The other pages behind a switch are scaffolds and stay out of it.
 * The list is read as the server runs, so the sitemap and the page agree.
 */
const SITEMAP_FLAGGED_ROUTES: Partial<Record<Feature, readonly string[]>> = {
  chain_arc: ["/chains/arc", "/field/arc-registry-2026-10-20"],
  chain_base: ["/chains/base", "/field/base-registry-2026-10-21"],
  chain_ethereum: ["/chains/ethereum"],
};

export function flaggedSitemapUrls(features: string | undefined = process.env.VITE_FEATURES): string[] {
  return (Object.keys(SITEMAP_FLAGGED_ROUTES) as Feature[]).filter(feature => featureOn(feature, features)).flatMap(feature => (SITEMAP_FLAGGED_ROUTES[feature] ?? []).map(route => `${SITE_ORIGIN}${route}`));
}

export const agentUrl = (agentId: string) => `${SITE_ORIGIN}/agents/${encodeURIComponent(agentId)}`;
export const catchDayUrl = (date: string) => `${SITE_ORIGIN}${catchPath(date)}`;

export type SitemapDeps = {
  /** The ids of the reviewed records served now. */
  readAgentIds: () => Promise<string[]>;
  /** The dates of the days that have a catch, newest first. */
  readCatchDates: () => Promise<string[]>;
  now: () => number;
};

const defaultDeps: SitemapDeps = {
  readAgentIds: async () => (await listLiveAtlasRecords()).map(record => record.agentId),
  readCatchDates: async () => (await readCatchArchive(SITEMAP_MAX_CATCH_DAYS)).map(view => view.date),
  now: () => Date.now(),
};

type List = { urls: string[]; until: number };

/** Makes the lists the sitemap adds to the fixed pages, each held for ten minutes, and keeps the last good one when a read fails. */
export function dynamicSitemapUrls(deps: SitemapDeps = defaultDeps) {
  const held: { agents: List | null; catches: List | null } = { agents: null, catches: null };
  const refresh = async (name: "agents" | "catches", read: () => Promise<string[]>, toUrl: (value: string) => string, sort: boolean) => {
    const at = deps.now();
    const current = held[name];
    if (current && current.until > at) return current.urls;
    try {
      const values = await read();
      const urls = (sort ? [...values].sort() : values).map(toUrl);
      held[name] = { urls, until: at + SITEMAP_CACHE_MS };
      return urls;
    } catch (error) {
      if (!isCircuitOpenError(error)) console.warn(`[Sitemap] The ${name} list could not be read; sending ${current ? "the last one that was read" : "none"}.`);
      held[name] = { urls: current?.urls ?? [], until: at + SITEMAP_RETRY_MS };
      return held[name]!.urls;
    }
  };
  return async (): Promise<string[]> => {
    const [catches, agents] = await Promise.all([refresh("catches", deps.readCatchDates, catchDayUrl, false), refresh("agents", deps.readAgentIds, agentUrl, true)]);
    return [...catches, ...agents];
  };
}

/** `/sitemap.xml`, to mount before the static files, which hold only the fixed pages. */
export function sitemapRoute(distPath: string, deps: SitemapDeps = defaultDeps): Router {
  const router = express.Router();
  const dynamic = dynamicSitemapUrls(deps);
  let fixed: string[] | null = null;
  router.get("/sitemap.xml", async (_req, res, next) => {
    try {
      fixed ??= sitemapLocs(fs.readFileSync(path.resolve(distPath, "sitemap.xml"), "utf8"));
      const body = sitemapXml([...fixed, ...flaggedSitemapUrls(), ...(await dynamic())]);
      res.status(200).set({ "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" }).send(body);
    } catch {
      // No file of fixed pages to build on: leave it to the static handler and the fallback, as before.
      next();
    }
  });
  return router;
}
