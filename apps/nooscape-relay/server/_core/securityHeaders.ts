import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express } from "express";

/**
 * Security response headers for the public relay surface.
 *
 * The content security policy is derived from the built client HTML so the
 * strict `script-src` can pin inline scripts (the Manus runtime bundle baked
 * into index.html) by SHA-256 hash instead of allowing `'unsafe-inline'`.
 * Hashes are computed from the file that this server actually serves
 * (dist/public/index.html), so they stay correct across rebuilds and CDN
 * pass-through. `style-src` keeps `'unsafe-inline'` because the runtime
 * overlay and several UI primitives set style attributes; that is a low-risk
 * vector compared with script execution.
 */

const DIST_INDEX_PATH = path.resolve(import.meta.dirname, "public", "index.html");

const INLINE_SCRIPT_PATTERN = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const SCRIPT_SRC_PATTERN = /<script[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi;
const LINK_TAG_PATTERN = /<link[^>]*>/gi;
const LINK_HREF_PATTERN = /\bhref=(["'])(.*?)\1/i;

/**
 * Analytics scripts whose beacon goes to a different origin than the script.
 * The umami cloud script posts to its gateway (its `data-host-url` is unset),
 * so allowing only the script's own origin in `connect-src` would load the
 * script and then silently drop every beacon.
 */
const SCRIPT_COLLECTOR_ORIGINS: Record<string, string> = {
  "https://cloud.umami.is": "https://gateway.umami.is",
};

type CspBuildResult = {
  policy: string;
  inlineScriptHashes: string[];
};

function externalOrigin(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  if (url.includes("%")) return null; // unresolved Vite env placeholder
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Iterates a global pattern without relying on iterator protocols (the server
 * tsconfig compiles to a pre-ES2015 target without downlevelIteration).
 */
function collectMatches(html: string, pattern: RegExp, group = 0): string[] {
  const results: string[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    results.push(match[group]);
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return results;
}

/** Pure policy builder; exported for tests. */
export function buildCspFromHtml(html: string): CspBuildResult {
  const inlineScriptHashes: string[] = [];
  for (const content of collectMatches(html, INLINE_SCRIPT_PATTERN, 1)) {
    if (content.length === 0) continue;
    const digest = crypto.createHash("sha256").update(content, "utf8").digest("base64");
    inlineScriptHashes.push(`'sha256-${digest}'`);
  }

  const scriptOrigins: string[] = [];
  for (const src of collectMatches(html, SCRIPT_SRC_PATTERN, 2)) {
    const origin = externalOrigin(src);
    if (origin && scriptOrigins.indexOf(origin) === -1) scriptOrigins.push(origin);
  }

  const connectOrigins = scriptOrigins.slice();
  for (const origin of scriptOrigins) {
    const collector = SCRIPT_COLLECTOR_ORIGINS[origin];
    if (collector && connectOrigins.indexOf(collector) === -1) connectOrigins.push(collector);
  }

  const styleOrigins: string[] = [];
  let usesGoogleFonts = false;
  for (const tag of collectMatches(html, LINK_TAG_PATTERN)) {
    if (!/\brel=["']?stylesheet["']?/i.test(tag)) continue;
    const href = LINK_HREF_PATTERN.exec(tag)?.[2];
    if (!href) continue;
    const origin = externalOrigin(href);
    if (!origin) continue;
    if (styleOrigins.indexOf(origin) === -1) styleOrigins.push(origin);
    if (origin === "https://fonts.googleapis.com") usesGoogleFonts = true;
  }

  const fontSources = ["'self'", ...(usesGoogleFonts ? ["https://fonts.gstatic.com"] : [])];

  const policy = [
    "default-src 'self'",
    `script-src ${["'self'", ...inlineScriptHashes, ...scriptOrigins].join(" ")}`,
    `style-src ${["'self'", "'unsafe-inline'", ...styleOrigins].join(" ")}`,
    `font-src ${fontSources.join(" ")}`,
    "img-src 'self' data: blob:",
    `connect-src ${["'self'", ...connectOrigins].join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self'",
  ].join("; ");

  return { policy, inlineScriptHashes };
}

let cachedPolicy: string | null | undefined;

/**
 * Served when the built index.html cannot be read (a broken deploy artifact).
 * Fail-closed: a conservative same-origin-only policy instead of no policy at
 * all. The derived policy pins exact inline-script hashes, so the fallback
 * admits only what the client needs to boot — its own scripts, the inline
 * styles the UI primitives set, and its own fonts (served from this site
 * since 2026-10-18; it used to name Google's two font hosts as well).
 */
export const FALLBACK_CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self'",
].join("; ");

function resolveCspPolicy(): string | null {
  if (cachedPolicy !== undefined) return cachedPolicy;
  try {
    const html = fs.readFileSync(DIST_INDEX_PATH, "utf8");
    const { policy, inlineScriptHashes } = buildCspFromHtml(html);
    console.log(`[SecurityHeaders] CSP derived from ${DIST_INDEX_PATH} (${inlineScriptHashes.length} inline script hash(es)).`);
    cachedPolicy = policy;
  } catch (error) {
    console.error(`[SecurityHeaders] Could not derive a CSP from ${DIST_INDEX_PATH}; serving the conservative fallback policy.`, error);
    cachedPolicy = FALLBACK_CSP_POLICY;
  }
  return cachedPolicy;
}

/**
 * Registers the baseline headers on every response. HSTS and the CSP are
 * production-only: dev serves Vite-transformed HTML whose inline scripts are
 * not covered by the hashes. includeSubDomains is on: the only published
 * nooscape.si subdomain (www) is HTTPS-only — plain http answers 301 to
 * https — so there is no plain-HTTP subdomain the policy could lock out.
 * Revisit before publishing any new subdomain.
 */
export function registerSecurityHeaders(app: Express) {
  const isProduction = process.env.NODE_ENV === "production";

  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    // Isolate the browsing context, and keep other sites from embedding our files. A route meant to be embedded
    // elsewhere (a badge image, later) sets its own Cross-Origin-Resource-Policy.
    res.set("Cross-Origin-Opener-Policy", "same-origin");
    res.set("Cross-Origin-Resource-Policy", "same-site");
    if (isProduction) {
      res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      const policy = resolveCspPolicy();
      if (policy) res.set("Content-Security-Policy", policy);
    }
    next();
  });
}

/**
 * API responses are never cacheable. Batched tRPC GET queries repeat with
 * byte-identical URLs on every poll, and the public read endpoints fail
 * closed (a transient database error answers 200 with empty records); any
 * cache layer that captured such a response would keep serving stale empty
 * data long after the database recovered, and the client would render the
 * seed fallback instead of the live index.
 */
export function registerApiCachePolicy(app: Express) {
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
}
