import express, { type Request, type Response, type Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { ARCHIVE_PATH, archiveMeta, dayMeta, isCatchDate, noCatchMeta, notADateMeta, SITE_ORIGIN, type PageMeta, type PublicCatch } from "@shared/owlsCatch";
import { isCircuitOpenError } from "./dbBreaker";
import { readCatchForDate } from "./owlsCatch";

/**
 * The head of the pages around the Owl's Catch. The site is a single page app, so a crawler that runs no script (the
 * one behind a post on X, a chat's link preview, a search engine) sees only the shell's head. For /catch and
 * /catch/:date the server writes that page's own title, description, address and robots rule into the shell before
 * it sends it, so a shared link previews the day's finding. Only the title, the description, the card text and the
 * canonical address are changed: the image stays the site's card, and no script is touched, so the policy hashes
 * derived from the shell still match.
 *
 * Honest statuses: a day with a catch is 200; a date with none, and a path that is not a date, are 404 with the same
 * shell (the page says so) and are kept out of search. If the catch cannot be read the answer is 503 with
 * Retry-After (sendUnavailable, below), because the server cannot tell which it is.
 */

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Sets the content of the first meta tag whose `attribute` is `key`. A tag the shell does not have is not added. */
function setMeta(html: string, attribute: "name" | "property", key: string, value: string): string {
  const tag = new RegExp(`<meta\\b[^>]*?\\b${attribute}="${key}"[^>]*>`, "i");
  return html.replace(tag, found => found.replace(/\bcontent="[^"]*"/i, () => `content="${escapeHtml(value)}"`));
}

/** The shell with this page's head and boot text. Nothing but the title, meta and canonical tags and the boot headline and copy is touched, and the card's tags only when the page has a card of its own. */
export function injectHead(html: string, meta: PageMeta): string {
  let out = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(meta.title)}</title>`);
  out = setMeta(out, "name", "description", meta.description);
  out = setMeta(out, "name", "robots", meta.robots);
  out = setMeta(out, "property", "og:title", meta.heading);
  out = setMeta(out, "property", "og:description", meta.description);
  out = setMeta(out, "property", "og:url", meta.url);
  out = setMeta(out, "name", "twitter:title", meta.heading);
  out = setMeta(out, "name", "twitter:description", meta.description);
  if (meta.image) {
    // The shell's own type, width and height stay: every card is a 1200 by 630 PNG, which a test holds.
    out = setMeta(out, "property", "og:image", meta.image.url);
    out = setMeta(out, "property", "og:image:secure_url", meta.image.url);
    out = setMeta(out, "property", "og:image:alt", meta.image.alt);
    out = setMeta(out, "name", "twitter:image", meta.image.url);
    out = setMeta(out, "name", "twitter:image:alt", meta.image.alt);
  }
  out = out.replace(/<link\b[^>]*\brel="canonical"[^>]*>/i, found => found.replace(/\bhref="[^"]*"/i, () => `href="${escapeHtml(meta.url)}"`));
  // The boot screen inside #root is the homepage's headline and copy. Every page used to carry it, so to a crawler whose render
  // did not finish every page read as the homepage. It now says this page's heading and description. React's createRoot
  // replaces it on mount, so a reader never sees the difference, and no script or style is touched.
  out = out.replace(/(<h1 class="ns-boot-headline">)[\s\S]*?(<\/h1>)/i, (_found, open: string, close: string) => `${open}<span>${escapeHtml(meta.heading)}</span>${close}`);
  return out.replace(/(<p class="ns-boot-copy">)[\s\S]*?(<\/p>)/i, (_found, open: string, close: string) => `${open}${escapeHtml(meta.description)}${close}`);
}

/** How long a crawler is asked to wait when the database cannot be read. */
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 120;

/**
 * The shell with a 503 and a noindex head, for a page whose facts could not be read. A browser still gets the app, which
 * reads its own data; a crawler is told to come back later and not to index or canonicalise what it got.
 */
export function sendUnavailable(res: Response, shell: string, url: string): void {
  const meta: PageMeta = {
    title: "Temporarily unavailable | Nooscape",
    heading: "Temporarily unavailable",
    description: "This page could not be read just now. Try again in a moment.",
    url,
    robots: "noindex, follow",
  };
  res
    .status(503)
    .set({ "Retry-After": String(UNAVAILABLE_RETRY_AFTER_SECONDS), "Cache-Control": "no-store" })
    .send(injectHead(shell, meta));
}

type CatchPageDeps = { readCatch: (date: string) => Promise<PublicCatch | null> };

const exactPath = (req: Request) => (req.originalUrl || "").split("?")[0]!;

/** Routes for /catch and /catch/:date, to mount before the static fallback. `distPath` holds the built index.html. */
export function catchPages(distPath: string, deps: CatchPageDeps = { readCatch: readCatchForDate }): Router {
  const router = express.Router();
  let shell: string | null = null;
  const readShell = () => (shell ??= fs.readFileSync(path.resolve(distPath, "index.html"), "utf8"));
  const send = (res: Response, status: number, meta: PageMeta) => {
    // Express sends a string as text/html; charset=utf-8, which the tests keep as a rule.
    res.status(status).set("Cache-Control", "public, max-age=60").send(injectHead(readShell(), meta));
  };

  router.get(ARCHIVE_PATH, (req, res, next) => {
    if (exactPath(req) !== ARCHIVE_PATH) return next();
    try {
      send(res, 200, archiveMeta());
    } catch {
      next();
    }
  });

  router.get(`${ARCHIVE_PATH}/:date`, async (req, res, next) => {
    // The segment as it arrived: a trailing slash is not this route, and a percent-encoded one is read before it is judged.
    const segment = new RegExp(`^${ARCHIVE_PATH}/([^/]+)$`).exec(exactPath(req))?.[1];
    if (segment === undefined) return next();
    let date: string;
    try {
      date = decodeURIComponent(segment);
    } catch {
      date = "";
    }
    try {
      if (!isCatchDate(date)) return send(res, 404, notADateMeta());
      let view: PublicCatch | null;
      try {
        view = await deps.readCatch(date);
      } catch (error) {
        if (!isCircuitOpenError(error)) console.warn("[CatchPage] The catch could not be read; answering 503 so a crawler comes back later.");
        return sendUnavailable(res, readShell(), `${SITE_ORIGIN}${ARCHIVE_PATH}/${encodeURIComponent(date)}`);
      }
      send(res, view ? 200 : 404, view ? dayMeta(view) : noCatchMeta(date));
    } catch {
      next();
    }
  });

  return router;
}
