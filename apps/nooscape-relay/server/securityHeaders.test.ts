import { createHash } from "node:crypto";
import type { Express } from "express";
import { describe, expect, it, vi } from "vitest";
import { buildCspFromHtml, registerApiCachePolicy, registerSecurityHeaders } from "./_core/securityHeaders";

vi.mock("node:fs", () => ({
  default: { readFileSync: vi.fn() },
}));

const inlineScript = "window.__MANUS_HOST_DEV__ = false;\n(function(){ /* runtime */ })();";

const html = [
  "<!doctype html><html><head>",
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
  '<link href="https://fonts.googleapis.com/css2?family=DM+Mono&display=swap" rel="stylesheet" />',
  '<link rel="stylesheet" crossorigin href="/assets/index-abc.css" />',
  '<script defer src="%VITE_ANALYTICS_ENDPOINT%/umami" data-website-id="x"></script>',
  "</head><body>",
  `<script id="manus-runtime">${inlineScript}</script>`,
  '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
  '<script defer src="https://analytics.example.com/umami" data-website-id="x"></script>',
  "</body></html>",
].join("\n");

function directive(policy: string, name: string): string {
  return policy.split("; ").find(part => part.startsWith(`${name} `)) ?? "";
}

describe("CSP derivation from built client HTML", () => {
  it("pins inline scripts with sha256 hashes instead of unsafe-inline", () => {
    const { inlineScriptHashes, policy } = buildCspFromHtml(html);
    const expected = `'sha256-${createHash("sha256").update(inlineScript, "utf8").digest("base64")}'`;
    expect(inlineScriptHashes).toEqual([expected]);
    const scriptSrc = directive(policy, "script-src");
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain(expected);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("collects external origins and skips unresolved placeholders and relative URLs", () => {
    const { policy } = buildCspFromHtml(html);
    expect(directive(policy, "script-src")).toContain("https://analytics.example.com");
    expect(directive(policy, "style-src")).toContain("https://fonts.googleapis.com");
    expect(directive(policy, "font-src")).toContain("https://fonts.gstatic.com");
    expect(directive(policy, "connect-src")).toContain("https://analytics.example.com");
    expect(policy).not.toContain("%VITE");
  });

  it("allows the umami cloud gateway for connections, because the cloud script posts there and not to its own origin", () => {
    const { policy } = buildCspFromHtml('<script defer src="https://cloud.umami.is/script.js" data-website-id="x"></script>');
    expect(directive(policy, "script-src")).toContain("https://cloud.umami.is");
    expect(directive(policy, "script-src")).not.toContain("gateway.umami.is");
    expect(directive(policy, "connect-src")).toBe("connect-src 'self' https://cloud.umami.is https://gateway.umami.is");
  });

  it("does not extend connect-src to the gateway for any other analytics origin", () => {
    const { policy } = buildCspFromHtml(html);
    expect(policy).not.toContain("gateway.umami.is");
    expect(directive(policy, "connect-src")).toBe("connect-src 'self' https://analytics.example.com");
  });

  it("keeps the baseline directives and the style escape hatch", () => {
    const { policy } = buildCspFromHtml(html);
    for (const expected of [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "worker-src 'self'",
    ]) {
      expect(policy).toContain(expected);
    }
    expect(directive(policy, "style-src")).toContain("'unsafe-inline'");
  });

  it("omits Google font hosts when no Google stylesheet is linked", () => {
    const { policy } = buildCspFromHtml("<html><head></head><body></body></html>");
    expect(directive(policy, "font-src")).toBe("font-src 'self'");
    expect(policy).not.toContain("fonts.googleapis.com");
    expect(policy).not.toContain("fonts.gstatic.com");
  });
});

describe("API cache policy", () => {
  it("marks every /api response no-store and passes control through", () => {
    const mounted: Array<(req: unknown, res: { set: (name: string, value: string) => void }, next: () => void) => void> = [];
    const app = {
      use(path: string, handler: (req: unknown, res: { set: (name: string, value: string) => void }, next: () => void) => void) {
        if (path === "/api") mounted.push(handler);
      },
    } as unknown as Express;
    registerApiCachePolicy(app);

    const handler = mounted[0];
    if (!handler) throw new Error("registerApiCachePolicy did not mount on /api");
    const headers: Record<string, string> = {};
    let passedThrough = false;
    handler({}, { set: (name, value) => { headers[name] = value; } }, () => { passedThrough = true; });

    expect(headers["Cache-Control"]).toBe("no-store");
    expect(passedThrough).toBe(true);
  });
});

describe("baseline security headers", () => {
  it("pins HSTS to the apex and every subdomain in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      type HeaderSetter = (name: string, value: string) => void;
      const mounted: Array<(req: unknown, res: { set: HeaderSetter }, next: () => void) => void> = [];
      const app = {
        disable: () => {},
        use: (handler: (req: unknown, res: { set: HeaderSetter }, next: () => void) => void) => {
          mounted.push(handler);
        },
      } as unknown as Express;
      registerSecurityHeaders(app);

      const handler = mounted[0];
      if (!handler) throw new Error("registerSecurityHeaders did not mount");
      const headers: Record<string, string> = {};
      handler({}, { set: (name, value) => { headers[name] = value; } }, () => {});

      expect(headers["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["X-Frame-Options"]).toBe("DENY");
      expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
      expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-site");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("withholds HSTS and the CSP outside production", () => {
    type HeaderSetter = (name: string, value: string) => void;
    const mounted: Array<(req: unknown, res: { set: HeaderSetter }, next: () => void) => void> = [];
    const app = {
      disable: () => {},
      use: (handler: (req: unknown, res: { set: HeaderSetter }, next: () => void) => void) => {
        mounted.push(handler);
      },
    } as unknown as Express;
    registerSecurityHeaders(app);

    const handler = mounted[0];
    if (!handler) throw new Error("registerSecurityHeaders did not mount");
    const headers: Record<string, string> = {};
    handler({}, { set: (name, value) => { headers[name] = value; } }, () => {});

    expect(headers["Strict-Transport-Security"]).toBeUndefined();
    expect(headers["Content-Security-Policy"]).toBeUndefined();
  });
});

describe("CSP fallback", () => {
  it("serves the conservative fallback policy when the built HTML cannot be read", async () => {
    vi.resetModules();
    const fs = await import("node:fs");
    vi.mocked(fs.default.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, open dist/public/index.html");
    });
    type HeaderSetter = (name: string, value: string) => void;
    const mounted: Array<(req: unknown, res: { set: HeaderSetter }, next: () => void) => void> = [];
    const app = {
      disable: () => {},
      use: (handler: (req: unknown, res: { set: HeaderSetter }, next: () => void) => void) => {
        mounted.push(handler);
      },
    } as unknown as Express;
    vi.stubEnv("NODE_ENV", "production");
    try {
      const { FALLBACK_CSP_POLICY, registerSecurityHeaders } = await import("./_core/securityHeaders");
      registerSecurityHeaders(app);

      const handler = mounted[0];
      if (!handler) throw new Error("registerSecurityHeaders did not mount");
      const headers: Record<string, string> = {};
      handler({}, { set: (name, value) => { headers[name] = value; } }, () => {});

      // A broken deploy artifact fails closed: the fallback policy ships
      // instead of no policy at all.
      expect(headers["Content-Security-Policy"]).toBe(FALLBACK_CSP_POLICY);
      // And the fallback stays strict where it matters: no inline script
      // escape hatch, same-origin scripts only.
      expect(directive(FALLBACK_CSP_POLICY, "script-src")).toBe("script-src 'self'");
    } finally {
      vi.unstubAllEnvs();
      vi.mocked(fs.default.readFileSync).mockReset();
    }
  });
});
