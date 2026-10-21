import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The night survey tokens in index.css: the palette, the type floor and the way the
 * shadcn variables hang off them. The checks that matter are the ones a later edit could
 * break without anyone seeing it: a colour that stops being readable on the surfaces it is
 * used on, a variable that stops pointing at its token, a label class that drops below
 * 12 px.
 */
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function color(name: string) {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (!match) throw new Error(`--${name} is not a hex colour in index.css`);
  return match[1]!;
}

function luminance(hex: string) {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2 contrast ratio. */
function contrast(foreground: string, background: string) {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}

const surfaces = ["ns-void", "ns-night", "ns-dusk"];
const inks = ["ns-ink", "ns-ink-dim", "ns-radar", "ns-amber", "ns-chain-robinhood", "ns-chain-solana", "ns-chain-bnb"];

describe("the night survey palette", () => {
  it("defines every token", () => {
    for (const name of [...surfaces, ...inks, "ns-glass", "ns-glass-border", "ns-glow", "ns-text-display", "ns-text-h2", "ns-text-h3", "ns-text-stat", "ns-text-floor", "ns-section-y", "ns-measure", "ns-ease"]) {
      expect(css, name).toContain(`--${name}:`);
    }
  });

  it("keeps every text and accent colour at WCAG AA (4.5:1) on every surface it can sit on", () => {
    for (const ink of inks) {
      for (const surface of surfaces) {
        expect(contrast(color(ink), color(surface)), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the label on the accent button readable", () => {
    expect(contrast(color("ns-void"), color("ns-radar"))).toBeGreaterThanOrEqual(4.5);
  });

  it("paints the page with the void colour and tells the browser chrome the same", () => {
    expect(css).toMatch(/html \{[^}]*background: var\(--ns-void\)/);
    expect(css).toMatch(/body \{[^}]*background: var\(--ns-void\)/);
    expect(/<meta name="theme-color" content="(#[0-9a-fA-F]{6})"/.exec(html)?.[1]?.toLowerCase()).toBe(color("ns-void"));
  });
});

describe("the shadcn variables", () => {
  it("hang off the tokens, so components added later match the page", () => {
    for (const [variable, token] of [
      ["background", "ns-void"],
      ["foreground", "ns-ink"],
      ["card", "ns-night"],
      ["popover", "ns-dusk"],
      ["primary", "ns-radar"],
      ["primary-foreground", "ns-void"],
      ["muted-foreground", "ns-ink-dim"],
      ["ring", "ns-radar"],
    ] as const) {
      expect(css, variable).toMatch(new RegExp(`--${variable}:\\s*var\\(--${token}\\);`));
    }
  });
});

describe("the type floor", () => {
  it("is 12 px", () => {
    expect(css).toMatch(/--ns-text-floor:\s*0\.75rem;/);
  });

  it("sizes the shared label classes", () => {
    for (const selector of [".eyebrow", ".ns-label"]) {
      const rule = new RegExp(`${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      expect(rule, selector).toContain("font-size: var(--ns-text-floor)");
    }
  });

  it("gives the dimmed label colour the secondary ink, which clears AA", () => {
    for (const selector of [".eyebrow", ".ns-label"]) {
      const rule = new RegExp(`${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      expect(rule, selector).toContain("color: var(--ns-ink-dim)");
    }
  });
});
