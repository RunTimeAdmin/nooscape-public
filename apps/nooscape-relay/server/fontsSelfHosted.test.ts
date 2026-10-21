import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCspFromHtml, FALLBACK_CSP_POLICY } from "./_core/securityHeaders";

/**
 * The site's two typefaces are served from the site (docs/self-hosted-fonts-2026-10-18.md), so the page links no font host
 * and the content security policy that is derived from it allows none. A policy that still named Google's two hosts would be
 * a standing permission for a request the site no longer makes.
 */
const app = path.resolve(import.meta.dirname, "..");
const html = readFileSync(path.join(app, "client", "index.html"), "utf8");
const directive = (policy: string, name: string) => policy.split("; ").find(part => part.startsWith(`${name} `)) ?? "";

describe("the page and its policy", () => {
  it("links no font host and no external stylesheet", () => {
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
    expect(html).not.toMatch(/<link[^>]*rel=["']?stylesheet["']?[^>]*href=["']https?:/i);
  });

  it("derives a policy that allows fonts and styles from the site only", () => {
    const { policy } = buildCspFromHtml(html);
    expect(directive(policy, "font-src")).toBe("font-src 'self'");
    expect(directive(policy, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(policy).not.toMatch(/google|gstatic/i);
  });

  it("serves a fallback policy that names no font host either", () => {
    expect(directive(FALLBACK_CSP_POLICY, "font-src")).toBe("font-src 'self'");
    expect(directive(FALLBACK_CSP_POLICY, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(FALLBACK_CSP_POLICY).not.toMatch(/google|gstatic/i);
  });
});

describe("the font packages", () => {
  const manifest = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8")) as { dependencies: Record<string, string> };

  it("are dependencies the build bundles, and the licence of each is the SIL Open Font License, which allows serving them", () => {
    for (const name of ["@fontsource/space-grotesk", "@fontsource/dm-mono"]) {
      expect(manifest.dependencies[name], name).toBeDefined();
      const licence = readFileSync(path.join(app, "node_modules", name, "LICENSE"), "utf8");
      expect(licence, name).toMatch(/SIL OPEN FONT LICENSE/i);
    }
  });
});
