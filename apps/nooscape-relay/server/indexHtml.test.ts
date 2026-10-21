import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCspFromHtml } from "./_core/securityHeaders";
import { HERO_COPY } from "../client/src/components/home/heroModel";

/**
 * The shipped page shell. The analytics tag used to carry unresolved
 * `%VITE_ANALYTICS_*%` placeholders that every visitor's browser requested
 * verbatim (a 400 on every page load). These tests read the real client/index.html
 * so a placeholder cannot come back, and so the CSP derived from it lets the
 * tracker load and, separately, lets its beacon out: the umami cloud script posts
 * to its gateway, not to its own origin.
 */
const html = readFileSync(path.resolve(import.meta.dirname, "..", "client", "index.html"), "utf8");

describe("client/index.html analytics tag", () => {
  it("carries exactly one umami cloud tag with the website id", () => {
    const tags = html.match(/<script[^>]*cloud\.umami\.is[^>]*><\/script>/g) ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('src="https://cloud.umami.is/script.js"');
    expect(tags[0]).toContain('data-website-id="a007d65a-2990-479a-9480-8af3cef59de9"');
    expect(tags[0]).toContain("defer");
  });

  it("only records visits on the site's own hostnames, so local previews and mirrors stay out of the numbers", () => {
    const tag = html.match(/<script[^>]*cloud\.umami\.is[^>]*><\/script>/)?.[0] ?? "";
    expect(tag).toContain('data-domains="nooscape.si,www.nooscape.si"');
  });

  it("has no unresolved Vite placeholders left in it", () => {
    expect(html).not.toMatch(/%VITE_[A-Z_]+%/);
  });

  it("derives a policy that lets the tracker load and its beacon out, and nothing broader", () => {
    const { policy } = buildCspFromHtml(html);
    const directive = (name: string) => policy.split("; ").find(part => part.startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).toContain("https://cloud.umami.is");
    expect(directive("connect-src")).toContain("https://gateway.umami.is");
    expect(directive("script-src")).not.toContain("'unsafe-inline'");
    expect(directive("connect-src")).not.toMatch(/\*|https:(?!\/\/)/);
  });
});

describe("client/index.html device metas", () => {
  it("lets people zoom: a viewport that caps the scale fails WCAG 1.4.4", () => {
    const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(viewport).toContain("width=device-width");
    expect(viewport).not.toMatch(/maximum-scale|minimum-scale|user-scalable/);
  });

  it("uses the standard web-app meta, since Chrome deprecated the Apple-only one", () => {
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />');
    expect(html).not.toContain("apple-mobile-web-app-capable");
  });

  it("keeps the Apple status bar and title metas", () => {
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Nooscape" />');
  });
});

describe("client/index.html first paint", () => {
  const root = /<div id="root">([\s\S]*?)<\/div>\s*<script type="module"/.exec(html)?.[1] ?? "";

  it("puts a real page inside the root, so the first paint is never a blank dark screen", () => {
    expect(root).toContain("Nooscape");
    expect(root).toContain(HERO_COPY.headline[0]);
    expect(root).toContain(HERO_COPY.headline[1]);
    expect(root).toMatch(/<h1[^>]*>/);
  });

  it("carries the hero's subcopy word for word", () => {
    expect(root).toContain(HERO_COPY.subcopy);
  });

  it("holds the place of the buttons and the three figures without making them look pressable", () => {
    expect(root).toMatch(/class="ns-boot-actions" aria-hidden="true"/);
    expect(root).toMatch(/class="ns-boot-figures" aria-hidden="true"/);
    expect(root).not.toMatch(/<(a|button)\b/);
  });

  it("runs no script and no inline handler, so the policy needs nothing new", () => {
    expect(root).not.toMatch(/<script|\son[a-z]+=/i);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(style).toContain(".ns-boot");
    expect(style).not.toMatch(/@import|url\(\s*["']?https?:/);
  });

  it("keeps its text at 12px or more", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    for (const match of style.matchAll(/(?:font-size:\s*|font:\s*)(\d*\.?\d+)px/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(12);
    }
  });

  it("looks like the page it stands in for: the same background, and the hero's own headline size, line height and tracking", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(style).toContain("#05070a");
    const css = readFileSync(path.resolve(import.meta.dirname, "..", "client", "src", "index.css"), "utf8");
    const declarations = (text: string, selector: string, property: string) => {
      const rule = new RegExp(`${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`).exec(text)?.[1] ?? "";
      const value = new RegExp(`${property}:\\s*([^;]+);`).exec(rule)?.[1] ?? "";
      // .045em and 0.045em are the same length.
      return value.trim().replace(/(^|[\s(,-])\.(\d)/g, "$10.$2");
    };
    for (const property of ["font-size", "line-height", "letter-spacing"]) {
      const hero = declarations(css, ".hero-headline", property);
      expect(hero, property).not.toBe("");
      expect(declarations(html, ".ns-boot-headline", property), property).toBe(hero);
    }
  });
});
