import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The front page's look, held at the source (the repo has no browser test runner). One accent in the headline so the chain
 * colours are the only ones that mean a chain, the fleets' bars in the dotted language of Clear the Fog, a quiet edge on the
 * panels under a pointer, and the map ahead of the new-entries section.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const css = read("../../index.css");
const home = read("../../pages/Home.tsx");
const fleets = read("./FleetCards.tsx");

describe("the headline", () => {
  it("has one accent, radar mint toward white, and none of the chain colours", () => {
    const rule = /\.holographic-text \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("var(--ns-radar)");
    expect(rule).toContain("-webkit-background-clip: text");
    for (const colour of ["#bfff76", "#d7cbff", "#65ecff"]) expect(rule.toLowerCase(), colour).not.toContain(colour);
  });
});

describe("the fleets' bars", () => {
  it("are dotted like the Clear the Fog bars, from two classes, and no longer a solid bar from utilities", () => {
    expect(fleets).toContain('className="fleet-track"');
    expect(fleets).toContain('className="fleet-fill"');
    expect(fleets).not.toContain("bg-white/[.06]");
    expect(css).toMatch(/\.fleet-track \{[^}]*radial-gradient\(circle[^}]*6px 6px/);
    expect(css).toMatch(/\.fleet-fill \{[^}]*radial-gradient\(circle[^}]*6px 6px/);
  });
});

describe("the panels", () => {
  it("take a mint edge under a pointer, and only where there is a pointer", () => {
    expect(css).toMatch(/@media \(hover: hover\) \{ \.ns-glass:hover \{ border-color: color-mix\(in oklab, var\(--ns-radar\) 35%, var\(--ns-glass-border\)\); \} \}/);
  });
});

describe("the order of the sections", () => {
  it("puts the map before the new-entries section, so the map is the first section a visitor reaches", () => {
    expect(home.indexOf("<LandingHero")).toBeGreaterThan(-1);
    expect(home.indexOf("<LandingHero")).toBeLessThan(home.indexOf("<JustArrived />"));
    expect(home.indexOf("<HeroScene")).toBeLessThan(home.indexOf("<LandingHero"));
    expect(home.indexOf("<JustArrived />")).toBeLessThan(home.indexOf("<LandingEvidence"));
  });
});
