import type { Express, NextFunction, Request, Response } from "express";
import { SITE_ORIGIN } from "@shared/owlsCatch";

/**
 * www.nooscape.si answered every page itself, with 200, so each page had a second address. The canonical tags point at
 * nooscape.si, but a search engine still crawled both and had to choose (Search Console, 2026-11-16: "Google chose
 * different canonical than user"). Every request for the www host is now sent to the same path on nooscape.si:
 * 301 for GET and HEAD, 308 for anything else, so a POST keeps its method and body.
 */

export const WWW_HOST = "www.nooscape.si";

export function wwwRedirect(req: Request, res: Response, next: NextFunction): void {
  const host = (req.hostname || "").toLowerCase().replace(/\.+$/, "");
  if (host !== WWW_HOST) return next();
  const status = req.method === "GET" || req.method === "HEAD" ? 301 : 308;
  res.redirect(status, `${SITE_ORIGIN}${req.originalUrl || "/"}`);
}

/** Mounted first, after `trust proxy`, so the host is read from the proxy's X-Forwarded-Host when it sends one. */
export function registerWwwRedirect(app: Express): void {
  app.use(wwwRedirect);
}
