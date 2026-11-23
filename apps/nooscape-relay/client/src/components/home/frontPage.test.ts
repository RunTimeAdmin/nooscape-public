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
  it("sets its second sentence as a subhead in solid ink, with no gradient, here and on the first screen", () => {
    const rule = /\.hero-headline > \.hero-headline-sub \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("font-size: .55em;");
    expect(rule).toContain("font-weight: 400;");
    expect(rule).toContain("color: var(--ns-ink);");
    expect(rule).not.toMatch(/gradient|background-clip/);
    expect(read("./HeroScene.tsx")).toContain('<span className="hero-headline-sub">{HERO_COPY.headline[1]}</span>');
    // The static first screen in index.html draws the same headline until the page takes over, so it matches.
    const boot = read("../../../index.html");
    const bootSub = /\.ns-boot-headline span \+ span \{([^}]*)\}/.exec(boot)?.[1] ?? "";
    expect(bootSub).toContain("font-size: 0.55em;");
    expect(bootSub).not.toMatch(/gradient|background-clip/);
  });

  it("is tracked by hand at -0.02em, not the tight default of a UI face blown up", () => {
    expect(/\.hero-headline \{([^}]*)\}/.exec(css)?.[1]).toContain("letter-spacing: -.02em;");
    expect(/\.ns-boot-headline \{([^}]*)\}/.exec(read("../../../index.html"))?.[1]).toContain("letter-spacing: -0.02em;");
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
