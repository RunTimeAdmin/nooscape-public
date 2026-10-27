import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The owl does not cover what the page marks `data-owl-avoid`, and rests only where the page marks `data-owl-perch`,
 * so the marks are as much a part of the behaviour as the geometry. The repo has no browser test runner, so these
 * read the source for them; a real browser run checked that the marked boxes and the perches really are clear.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const count = (text: string, mark: string) => (text.match(new RegExp(mark, "g")) ?? []).length;

describe("what the owl must not cover", () => {
  // The least number of marks each part of the home page carries: its headings, paragraphs, cards and controls.
  const AT_LEAST: Array<[string, string, number]> = [
    ["the hero", "../home/HeroScene.tsx", 6],
    ["the scan map section", "../../pages/home/LandingHero.tsx", 4],
    ["the check card", "../home/CheckCard.tsx", 2],
    ["the scan status line", "../home/ScanStatusLine.tsx", 1],
    ["How it works", "../home/HowItWorks.tsx", 3],
    ["the funnel", "../home/NoiseFunnel.tsx", 6],
    ["the fleets", "../home/FleetCards.tsx", 5],
    ["the chains", "../home/ChainTabs.tsx", 4],
    ["the field notes", "../home/FieldNotes.tsx", 8],
    ["the Owl's Catch card", "../home/OwlsCatch.tsx", 10],
    ["Home's own disclosure and footer", "../../pages/Home.tsx", 2],
    ["the full field's sections", "../../pages/home/FieldView.tsx", 8],
  ];

  it.each(AT_LEAST)("is marked in %s", (_name, file, least) => {
    expect(count(read(file), "data-owl-avoid")).toBeGreaterThanOrEqual(least);
  });

  it("marks each of Home's own sections, its closed disclosure and its footer", () => {
    const home = read("../../pages/Home.tsx");
    const field = read("../../pages/home/FieldView.tsx");
    for (const opening of ['<details data-owl-avoid="" className="how-we-count', '<footer data-owl-avoid="" className=']) expect(home, opening).toContain(opening);
    for (const opening of [
      '<section data-owl-avoid="" className="protocol-ribbon',
      '<section data-owl-avoid="" aria-label="What we can prove"',
      '<section data-owl-avoid="" className="observatory-frame',
      '<section data-owl-avoid="" className="mt-5" aria-label="What nobody can measure yet">',
      '<section data-owl-avoid="" className="mt-5 grid gap-5 lg:grid-cols-[1.25fr_.75fr]" aria-label="Money moving on Robinhood">',
      '<section data-owl-avoid="" className="mt-5 grid gap-5 lg:grid-cols-[.8fr_1.2fr]">',
      '<section data-owl-avoid="" aria-label="The field"',
    ]) {
      expect(field, opening).toContain(opening);
    }
  });

  it("marks the header as one that stays put on screen, so its box is read as it is and not shifted with the scroll", () => {
    expect(read("../home/SiteHeader.tsx")).toMatch(/<header\s+data-owl-avoid="fixed"/);
  });

  it("marks the headings by a box as wide as the text can be, not the whole row, so the empty side of a heading stays free", () => {
    for (const file of ["../../pages/home/LandingHero.tsx", "../home/HowItWorks.tsx", "../home/FleetCards.tsx", "../home/ChainTabs.tsx"]) {
      expect(read(file), file).toMatch(/<div data-owl-avoid="" className="max-w-(?:2xl|3xl)(?: [^"]*)?">/);
    }
  });

  it("leaves the scan map's canvas unmarked: the owl scans it, and it holds no text", () => {
    expect(read("../home/AgentConstellation.tsx")).not.toContain("data-owl-avoid");
  });

  it("marks the tooltip on a swept fleet, which comes and goes", () => {
    const hero = read("../home/HeroScene.tsx");
    expect(hero).toMatch(/className="hero-sighting"\s+data-owl-avoid=""/);
  });
});

describe("where the owl rests", () => {
  it("has a perch in the hero and, on a wide screen only, one in the scan map's empty top right", () => {
    expect(read("../home/HeroScene.tsx")).toContain('data-owl-perch="top-right"');
    const map = read("../../pages/home/LandingHero.tsx");
    expect(map).toMatch(/data-owl-perch="top-right" data-owl-topic="records" aria-hidden="true" className="pointer-events-none absolute right-6 top-3 hidden h-\[8\.25rem\] w-28 xl:block"/);
    expect(map).toMatch(/<section aria-labelledby="scan-field-heading" className="radar-grid relative /);
  });

  it("looks for perches by the same attribute the page uses, and reads them with the avoid boxes", () => {
    const world = read("./owlWorld.ts");
    expect(world).toContain('"[data-owl-avoid]"');
    expect(world).toContain('"[data-owl-perch]"');
    expect(world).toContain('element.dataset.owlAvoid === "fixed"');
  });

  it("turns page coordinates into screen ones from the scroll position, except for what stays put", () => {
    const world = read("./owlWorld.ts");
    expect(world).toContain("const dx = item.fixed ? 0 : -window.scrollX;");
    expect(world).toContain("const dy = item.fixed ? 0 : -window.scrollY;");
    expect(world).toContain("const dx = fixed ? 0 : window.scrollX;");
    expect(world).toContain("const dy = fixed ? 0 : window.scrollY;");
  });

  it("only counts a perch whose whole owl is on screen and clear of every avoid box", () => {
    const world = read("./owlWorld.ts");
    expect(world).toMatch(/box\.left >= 0 && box\.top >= 0 && box\.right <= window\.innerWidth && box\.bottom <= window\.innerHeight && !overlaps\(point, size, blocked, 0\)/);
  });
});

describe("the radar eye", () => {
  it("turns while a field marked data-owl-search has focus, and stops when it loses it, asked of the page each frame", () => {
    const rig = read("./useOwlRig.ts");
    expect(rig).toContain('document.activeElement.matches("[data-owl-search]")');
    expect(rig).toContain("const seeing = scanning.current || searching();");
    expect(rig).not.toContain("focusin");
  });

  it("is on the search field of the Deep map", () => {
    expect(read("../../pages/home/DeepSpace.tsx")).toMatch(/<input ref=\{searchRef\} data-owl-search=""/);
  });

  it("glows in the brand colour", () => {
    expect(read("../../index.css")).toContain('.owl-companion[data-scanning="true"] [data-owl-glow] { stroke: var(--ns-radar);');
  });
});

describe("the owl's own loop", () => {
  const rig = read("./useOwlRig.ts");

  it("keeps a perched owl on its perch with reduced motion, and until the pointer first moves", () => {
    expect(rig).toContain("if (reducedMotion) {");
    expect(rig).toContain("} else if (!pointerSeen && perch) {");
    expect(rig).toContain("target = perch ?? here;");
  });

  it("fades over text, is gone when nowhere is clear and it would be over text, and sets the opacity only when it changes", () => {
    expect(rig).toContain("const perches = world.perches(true);");
    expect(rig).toContain("rects, perches, size, viewport: view(), busy: scanning.current");
    expect(rig).toContain("busy: scanning.current");
    expect(rig).toContain("const covering = overlaps({ x: state.x, y: state.y }, size, rects, 0);");
    expect(rig).toContain("coveringMs = covering ? coveringMs + Math.min(frameMs, 50) : 0;");
    expect(rig).toContain("owlOpacity({ covering, coveringMs, stranded })");
    expect(rig).toContain('stranded = choice.kind === "hold";');
    expect(rig).toContain("if (opacity !== shown) {");
    expect(read("../../index.css")).toMatch(/\.owl-companion \{ animation: owl-in \.6s var\(--ns-ease\) backwards; transition: opacity \.12s linear; \}/);
  });

  it("does not stop the rest of the page's loops: one loop, cancelled when the tab is hidden, while Deep Space covers the page and when it is unmounted", () => {
    expect(count(rig, "requestAnimationFrame\\(step\\)")).toBe(2);
    expect(rig).toContain("cancelAnimationFrame(frame);");
    expect(rig).toMatch(/if \(document\.hidden \|\| pageCovered\(\)\) \{\s*cancelAnimationFrame\(frame\);\s*frame = 0;/);
    expect(rig).toContain('document.addEventListener("visibilitychange", sync);');
    expect(rig).toContain("world.dispose();");
  });

  it("is told it is on a perch only when the choice is one", () => {
    expect(rig).toContain('onPerch = choice.kind === "perch";');
  });
});
