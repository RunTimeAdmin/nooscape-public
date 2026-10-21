import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEDGE_INSET, OWL_SIZE, perchedBox, perchPoint } from "../owl/owlRig";
import { HERO_COPY, LEGEND } from "./heroModel";

/**
 * The hero is a canvas, an animation frame loop and a layout grid, and the repo has no browser test runner, so
 * these read the source for the parts the brief makes rules of: the words, the reserved space, what loads when,
 * what moves, and what stops moving. The arithmetic is tested in heroModel.test.ts; the behaviour in a real
 * browser was checked by hand for the pull request.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const scene = read("./HeroScene.tsx");
const backdrop = read("./NoosphereBackdrop.tsx");
const home = read("../../pages/Home.tsx");
const css = read("../../index.css");
const rig = read("../owl/useOwlRig.ts");
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The hero's rules, from the start of its block to the end of the file. */
const heroCss = css.slice(css.indexOf("/* The home hero:"));

describe("Home", () => {
  it("opens with the hero scene wired to the same Ask the Owl action as the header", () => {
    expect(home).toContain('import { HeroScene } from "@/components/home/HeroScene";');
    expect(home).toContain("<HeroScene onAskTheOwl={askTheOwl} />");
    expect(home.indexOf("<HeroScene")).toBeGreaterThan(home.indexOf('<main id="top"'));
    expect(home.indexOf("<HeroScene")).toBeLessThan(home.indexOf("<LandingHero"));
    expect(home.match(/onAskTheOwl=\{askTheOwl\}/g)).toHaveLength(2);
  });

  it("no longer has the old headline, and keeps its counts in a closed How we count disclosure", () => {
    expect(home).not.toContain("Where agents");
    expect(home).not.toContain("become visible");
    const details = home.slice(home.indexOf('<details data-owl-avoid="" className="how-we-count'), home.indexOf("</details>"));
    expect(details).toContain(">How we count</summary>");
    expect(details).toContain('aria-label="Live observatory population"');
    expect(details).toContain("<PopulationSkeleton />");
    expect(details.slice(0, 200)).not.toMatch(/\bopen\b/);
  });
});

describe("the hero's words", () => {
  it("are the brief's headline, subcopy and buttons, drawn from the one constant the shell test also reads", () => {
    for (const piece of ["HERO_COPY.headline[0]", "HERO_COPY.headline[1]", "HERO_COPY.subcopy", "HERO_COPY.primaryCta", "HERO_COPY.secondaryCta", "LEGEND.steady", "LEGEND.fleet", "LEGEND.plain", "LEGEND.rule"]) {
      expect(scene, piece).toContain(`{${piece}}`);
    }
    expect(HERO_COPY.primaryCta).toBe("Ask the Owl");
    expect(LEGEND.rule).toContain("not a score");
  });

  it("is one h1 that names the section", () => {
    expect(scene.match(/<h1\b/g)).toHaveLength(1);
    expect(scene).toContain('<h1 id="hero-heading"');
    expect(scene).toContain('aria-labelledby="hero-heading"');
  });

  it("has no copy of its own beyond the model's, except the states of a read that failed", () => {
    const strings = Array.from(stripComments(scene).matchAll(/>\s*([A-Z][^<>{}]{12,})\s*</g), match => match[1]!.trim());
    expect(strings).toEqual(["The Owl's figures are unavailable right now. Nothing is shown in their place.", "See the fleets"]);
  });
});

describe("the buttons", () => {
  it("send Ask the Owl to the shared action and Explore the Noosphere to the map the header's Atlas link goes to", () => {
    expect(scene).toMatch(/<Button onClick=\{onAskTheOwl\}/);
    expect(scene).toContain('const MAP_ANCHOR = "#scan-field-heading";');
    expect(scene).toContain("href={MAP_ANCHOR}");
    expect(read("../../pages/home/LandingHero.tsx")).toContain('id="scan-field-heading"');
  });

  it("send the fleet tooltip and the See the fleets link to where the fleets are listed", () => {
    expect(scene).toContain('const FLEET_ANCHOR = "#fleet-heading";');
    expect(scene.match(/href=\{FLEET_ANCHOR\}/g)).toHaveLength(2);
    expect(read("./FleetCards.tsx")).toContain('id="fleet-heading"');
  });

  it("take their type from the row they sit in, since a global rule gives every button its parent's font", () => {
    expect(heroCss).toMatch(/\.hero-actions \{[^}]*font-size: 1rem; font-weight: 600/);
    expect(css).toMatch(/button, input \{ font: inherit; \}/);
  });
});

describe("the reserved space", () => {
  const areas = (block: string) => Array.from(block.matchAll(/"([a-z ]+)"/g), match => match[1]!.split(" "));
  const mobile = areas(/\.hero-grid \{[^}]*grid-template-areas:([^;]+);/.exec(heroCss)![1]!);
  const desktop = areas(/@media \(min-width: 1024px\) \{[\s\S]*?\.hero-grid \{[^}]*grid-template-areas:([^;]+);/.exec(heroCss)![1]!);

  it("puts the owl's perch and the fleets' sky in the right-hand column, apart from every piece of text", () => {
    const cellsOf = (name: string) => desktop.flatMap((row, r) => row.flatMap((cell, c) => (cell === name ? [[r, c]] : [])));
    for (const reserved of ["owl", "sky"]) expect(cellsOf(reserved).every(([, column]) => column === 1), reserved).toBe(true);
    for (const text of ["headline", "copy", "actions", "figures"]) expect(cellsOf(text).every(([, column]) => column === 0), text).toBe(true);
    expect(desktop.flat().filter(cell => cell === "owl" || cell === "sky").length).toBeGreaterThan(0);
    expect(new Set(desktop.flat())).toEqual(new Set(["headline", "owl", "copy", "sky", "actions", "figures", "legend"]));
  });

  it("stacks them on a phone with the owl small, under the headline, and the sky last", () => {
    expect(mobile.map(row => row[0])).toEqual(["headline", "owl", "copy", "actions", "figures", "legend", "sky"]);
    expect(heroCss).toMatch(/\.hero-owl \{[^}]*width: 6rem; height: 6\.5rem/);
    expect(heroCss).toMatch(/\.hero-owl \{ align-self: start; width: 10rem; height: 9\.5rem; \}/);
  });

  it("puts the owl beside the headline on a tablet and keeps everything else the full width", () => {
    const tablet = areas(/@media \(min-width: 640px\) \{\s*\.hero-grid \{[^}]*grid-template-areas:([^;]+);/.exec(heroCss)![1]!);
    expect(tablet[0]).toEqual(["headline", "owl"]);
    expect(tablet.slice(1).map(row => row[0])).toEqual(["copy", "actions", "figures", "legend", "sky"]);
    for (const row of tablet.slice(1)) expect(new Set(row).size).toBe(1);
  });

  it("gives the owl a fixed box on the perch, hidden from assistive technology, and the owl rig finds it by the same attribute", () => {
    expect(scene).toContain('<div className="hero-owl" data-owl-perch="top-right" aria-hidden="true" />');
    expect(read("../owl/owlWorld.ts")).toContain('"[data-owl-perch]"');
    expect(rig).toContain("createOwlWorld(size)");
  });

  it("keeps the owl inside its reserved box at every size the box takes, for the owl that goes with it", () => {
    const rem = (value: string) => Number(value) * 16;
    const size = (rule: RegExp) => {
      const match = rule.exec(heroCss)!;
      return { width: rem(match[1]!), height: rem(match[2]!) };
    };
    const slots = [
      { name: "touch", slot: size(/\.hero-owl \{ grid-area: owl;[^}]*width: ([\d.]+)rem; height: ([\d.]+)rem; \}/), owl: OWL_SIZE.coarse },
      { name: "mouse", slot: size(/@media \(hover: hover\) and \(pointer: fine\) \{ \.hero-owl \{ width: ([\d.]+)rem; height: ([\d.]+)rem; \} \}/), owl: OWL_SIZE.fine },
      { name: "wide with a mouse", slot: size(/\.hero-owl \{ align-self: start; width: ([\d.]+)rem; height: ([\d.]+)rem; \}/), owl: OWL_SIZE.fine },
      { name: "wide with a touch screen", slot: size(/\.hero-owl \{ align-self: start; width: ([\d.]+)rem; height: ([\d.]+)rem; \}/), owl: OWL_SIZE.coarse },
    ];
    for (const { name, slot, owl } of slots) {
      const box = perchedBox(perchPoint({ left: 0, right: slot.width, bottom: slot.height }), owl);
      expect(box.left, name).toBeGreaterThanOrEqual(0);
      expect(box.top, name).toBeGreaterThanOrEqual(0);
      expect(box.right, name).toBeLessThanOrEqual(slot.width);
      expect(box.bottom, name).toBeLessThanOrEqual(slot.height);
    }
    // The ledge is drawn where the perch point puts the owl's feet: 8px up and 2px thick.
    expect(heroCss).toMatch(/\[data-owl-perch\]::after \{[^}]*bottom: 8px; height: 2px;/);
    expect(LEDGE_INSET).toBe(8 + 2);
    // The wide rule comes after the mouse rule, so the wide size wins on a large screen whichever owl it is.
    expect(heroCss.indexOf("@media (hover: hover) and (pointer: fine)")).toBeLessThan(heroCss.indexOf("align-self: start; width:"));
  });

  it("hands the canvas the sky to place the fleets in, so a ring or tooltip cannot land on the words", () => {
    expect(scene).toContain('<div ref={skyRef} className="hero-sky" aria-hidden="true" />');
    expect(scene).toContain("skyRef={skyRef}");
    expect(backdrop).toContain("sky?.getBoundingClientRect()");
    expect(backdrop).toMatch(/placeLights\(sample, budget, \{ width, height \}, zone\)/);
  });

  it("dims what is behind the words, not the sky", () => {
    expect(heroCss).toMatch(/\.hero-vignette \{[^}]*calc\(100% - 22rem\)[^}]*calc\(100% - 17\.5rem\)/);
    expect(heroCss).toMatch(/\.hero-vignette \{ background: linear-gradient\(90deg, rgba\(5, 7, 10, \.9\) 0%/);
  });
});

describe("the edge-to-edge layers", () => {
  it("run the scene behind the words and the tooltip above them from layers as wide as the viewport, centred on the page's column", () => {
    expect(heroCss).toMatch(/\.hero-layer \{ position: absolute; top: 0; bottom: 0; left: calc\(50% - 50vw\); width: 100vw; \}/);
    expect(heroCss).toMatch(/\.hero-overlay \{ z-index: 4; pointer-events: none; \}/);
    expect(heroCss).toMatch(/\.hero-sighting \{[^}]*pointer-events: auto;/);
    const backdropAt = scene.indexOf('className="hero-layer hero-backdrop"');
    const wordsAt = scene.indexOf('className="hero-inner"');
    const overlayAt = scene.indexOf('className="hero-layer hero-overlay"');
    expect(backdropAt).toBeGreaterThan(-1);
    expect(backdropAt).toBeLessThan(wordsAt);
    expect(wordsAt).toBeLessThan(overlayAt);
    expect(scene).toContain('className="hero-layer hero-backdrop" aria-hidden="true"');
  });

  it("stack the scene behind the words and the tooltip layer above them", () => {
    const layer = (name: string) => Number(new RegExp(String.raw`\.${name}\s*\{[^}]*z-index:\s*(\d+)`).exec(heroCss)?.[1] ?? Number.NaN);
    expect(layer("hero-backdrop")).toBeLessThan(layer("hero-inner"));
    expect(layer("hero-inner")).toBeLessThan(layer("hero-overlay"));
  });

  it("keep the words in the page's own column: the section itself is not widened, and its words add no side padding of their own", () => {
    expect(heroCss).not.toMatch(/\.hero-scene \{[^}]*(width: 100vw|margin-inline|overflow: hidden)/);
    expect(heroCss).toMatch(/\.hero-inner \{[^}]*padding: 1\.5rem 0 2rem;/);
    expect(heroCss).toMatch(/\.hero-inner \{ padding: 1\.75rem 0 2rem; \}/);
    expect(heroCss).not.toMatch(/\.hero-inner \{[^}]*max-width/);
  });

  it("have the canvas measure its own box, since it is wider than the section, and place the sky relative to it", () => {
    expect(backdrop).toContain("const canvasBox = canvas.getBoundingClientRect();");
    expect(backdrop).toContain("x: skyBox.left - canvasBox.left, y: skyBox.top - canvasBox.top");
    expect(backdrop).not.toContain("host.getBoundingClientRect");
    expect(backdrop).toContain("resize?.observe(canvas);");
  });

  it("show keyboard focus on the links with an outline, not only a tint or an underline", () => {
    expect(scene.match(/focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ns-radar/g)).toHaveLength(3);
  });
});

describe("what loads when", () => {
  it("brings the field of lights in after the first paint and the sample, never before the headline", () => {
    expect(scene).toContain('const NoosphereBackdrop = lazy(() => import("./NoosphereBackdrop"));');
    expect(scene).toContain('import type { Sighting } from "./NoosphereBackdrop";');
    expect(scene).not.toMatch(/^import (?!type)[^;]*from "\.\/NoosphereBackdrop"/m);
    expect(scene).toContain("{afterPaint && sample && (");
    expect(scene).toContain("requestIdleCallback");
    expect(scene).toContain("window.setTimeout(() => setReady(true), 250)");
  });

  it("holds a place for the three figures, so nothing moves when they arrive", () => {
    expect(scene).toContain('aria-hidden="true"');
    expect(scene).toMatch(/h-\[clamp\(1\.5rem,4\.2vw,3\.25rem\)\]/);
    expect(scene).toContain("motion-reduce:animate-none");
  });

  it("says a read failed, rather than drawing a figure in its place", () => {
    expect(scene).toMatch(/if \(status === "unavailable"\) \{\s*return <p className="[^"]*">The Owl's figures are unavailable right now\. Nothing is shown in their place\.<\/p>;\s*\}/);
    expect(scene).toContain('const sampleStatus: ReadStatus = sampleQuery.isError || sampleQuery.data?.sample === null ? "unavailable" : sample ? "ready" : "loading";');
  });

  it("reads the sample out of the router's answer, which wraps it as { sample }, and never takes the whole answer for the sample", () => {
    // The page broke in production when the hero read the answer itself as the sample: its fleets were undefined.
    expect(scene).toContain("const sample: NoosphereSample | null = sampleQuery.data?.sample ?? null;");
    expect(scene).not.toMatch(/sampleQuery\.data \?\? null\) as /);
    const router = read("../../../../server/routers/liveData.ts");
    expect(router).toContain("return { sample: await readNoosphereSample() } as const;");
    expect(router).toContain("return { sample: null } as const;");
  });

  it("shares the chain stats read with the chain tabs, so one request serves both", () => {
    const tabs = read("./ChainTabs.tsx");
    const options = "{ refetchInterval: 60_000, refetchOnWindowFocus: true }";
    expect(scene).toContain(`trpc.liveData.chainStats.useQuery(undefined, ${options})`);
    expect(tabs).toContain(`trpc.liveData.chainStats.useQuery(undefined, ${options})`);
  });
});

describe("the canvas", () => {
  const code = stripComments(backdrop);

  it("is one canvas, hidden from assistive technology, with the facts also in text", () => {
    expect(backdrop.match(/<canvas\b/g)).toHaveLength(1);
    expect(backdrop).toContain('<canvas ref={canvasRef} className="hero-canvas" aria-hidden="true" />');
  });

  it("runs one animation frame loop, and stops it when the hero is off screen, the tab is hidden, or motion is reduced", () => {
    expect(code.match(/const tick = /g)).toHaveLength(1);
    expect(code).toContain("const shouldRun = onScreen && !document.hidden && !reduced;");
    expect(code).toContain("new IntersectionObserver(");
    expect(code).toContain('document.addEventListener("visibilitychange", sync)');
    expect(code).toContain('document.removeEventListener("visibilitychange", sync)');
    expect(code).toContain("cancelAnimationFrame(frame)");
    expect(code).not.toMatch(/setInterval|setTimeout/);
  });

  it("draws a still frame with reduced motion: no drift, no parallax, no wedge, one fleet marked", () => {
    expect(code).toContain("if (reduced) {");
    expect(code).toContain("reduced ? (still === null ? null : { fleet: still, progress: 0.5 })");
    expect(code).toContain("if (!reduced) {");
    expect(code).toContain("if (reduced) report(still);");
  });

  it("listens for the pointer only while it runs and only with a fine pointer, and the move is passive", () => {
    expect(code).toContain('if (!coarse) window.addEventListener("pointermove", onPointer, { passive: true });');
    expect(code).toContain('window.removeEventListener("pointermove", onPointer);');
  });

  it("limits the canvas to a few million pixels, a third of that on a phone, and draws 30 times a second, half as often when drawing is slow", () => {
    expect(code).toContain("const MAX_PIXELS = 3_200_000;");
    expect(code).toContain("const MAX_PIXELS_TOUCH = 1_000_000;");
    expect(code).toContain("Math.sqrt((coarse ? MAX_PIXELS_TOUCH : MAX_PIXELS) / (width * height))");
    expect(code).toContain("const FRAME_MS = 1000 / 30;");
    expect(code).toContain("const SLOW_FRAME_GAP_MS = 1000 / 15;");
    expect(code).toContain("if (now - lastDrawAt < (slow ? SLOW_FRAME_GAP_MS : FRAME_MS) - 4) return;");
    // The gate comes first, then the time of the draw is recorded, then the draw: else the gate never closes.
    const gate = code.indexOf("if (now - lastDrawAt < (slow ? SLOW_FRAME_GAP_MS : FRAME_MS) - 4) return;");
    const recorded = code.indexOf("lastDrawAt = now;", gate);
    expect(recorded).toBeGreaterThan(gate);
    expect(code.indexOf("draw();", recorded)).toBeGreaterThan(recorded);
    expect(code).toContain("if (cost > SLOW_FRAME_MS) slow = true;");
  });

  it("holds the sweep while a visitor is on the tooltip, and lets go when it goes", () => {
    expect(code).toContain("if (!holding) sweepMs = sweepMiddle(sweepMs);");
    expect(scene).toContain("onPointerEnter={() => { holdRef.current = true; }}");
    expect(scene).toContain("onPointerLeave={() => { holdRef.current = false; }}");
    expect(scene).toContain("if (!sighting) holdRef.current = false;");
  });

  it("sets nothing on the page but its own size and a ready flag, and runs no string as code", () => {
    expect(code).not.toMatch(/\.style\.|innerHTML|insertAdjacentHTML|eval\(|new Function|dangerouslySetInnerHTML/);
    expect(code).toContain('canvas.dataset.ready = "true";');
  });
});

describe("what moves", () => {
  it("is only opacity and transform, in the rules the hero adds", () => {
    const transitions = Array.from(heroCss.matchAll(/transition:\s*([^;}]+)[;}]/g), match => match[1]!).filter(value => value.trim() !== "none");
    expect(transitions.length).toBeGreaterThan(0);
    for (const value of transitions) expect(value.trim().split(/\s+/)[0], value).toMatch(/^(opacity|transform)$/);
    for (const name of ["hero-sighting-in", "owl-in"]) {
      const keyframes = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\}\\s*\\}`).exec(heroCss + css)?.[1] ?? "";
      expect(keyframes, name).not.toBe("");
      const properties = Array.from(keyframes.matchAll(/([a-z-]+):\s*[^;]+;/g), match => match[1]);
      for (const property of properties) expect(property, name).toMatch(/^(opacity|transform)$/);
    }
  });

  it("stops when motion is reduced", () => {
    expect(heroCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.hero-canvas \{ transition: none; \} \.hero-sighting \{ animation: none; \} \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.owl-companion \{ animation: none; transition: none; \} \}/);
  });
});

describe("the three numbers", () => {
  it("are set by a class of their own, since a utility loses to the page's unlayered type rules, and are never cut short", () => {
    expect(scene).toContain('<dl className="hero-stats">');
    expect(scene).toContain('<div key={figure.label} className="hero-figure">');
    expect(scene).not.toMatch(/truncate|ns-stat|text-ellipsis/);
    expect(heroCss).toMatch(/\.hero-figure dd \{[^}]*font: 400 clamp\(2rem, 4\.2vw, 3\.75rem\)\/1[^}]*white-space: nowrap/);
    expect(heroCss).toMatch(/\.hero-stats \{[^}]*grid-template-columns: repeat\(3, minmax\(0, max-content\)\)/);
  });

  it("are the product, so they are large, and the reviewed records take the steady light's colour while the fleet's number stays plain ink", () => {
    expect(heroCss).toMatch(/\.hero-figures \{[^}]*max-width: 54rem/);
    expect(heroCss).toMatch(/\.hero-figure:nth-child\(2\) dd \{[^}]*color: var\(--ns-radar\)/);
    // A warm colour on the fleet's number would read as a verdict on it.
    expect(heroCss).not.toMatch(/\.hero-figure:nth-child\(3\) dd/);
  });

  it("sit under a hairline that reads as a radar line, and on a phone the figures are smaller and the two buttons share a line where they fit", () => {
    expect(heroCss).toMatch(/\.hero-figures > \.ns-label::after \{[^}]*height: 1px[^}]*var\(--ns-radar\)/);
    const phone = /@media \(max-width: 639px\) \{([\s\S]*?)\n\}/.exec(heroCss)?.[1] ?? "";
    expect(phone).toMatch(/\.hero-actions > \* \{ flex: 1 1 auto; \}/);
    expect(phone).toMatch(/\.hero-actions :is\(button, a\) \{[^}]*white-space: nowrap/);
    expect(phone).toMatch(/\.hero-figure dd \{ font-size: clamp\(1\.5rem, 7\.2vw, 2rem\); \}/);
  });

  it("read label first and number second, whichever way they are drawn", () => {
    expect(scene.indexOf("<dt>{figure.label}</dt>")).toBeGreaterThan(-1);
    expect(scene.indexOf("<dt>{figure.label}</dt>")).toBeLessThan(scene.indexOf("<dd>{figure.value"));
    expect(heroCss).toMatch(/\.hero-figure \{[^}]*flex-direction: column-reverse/);
  });
});

describe("type", () => {
  it("stays at 12px or more in the hero's rules and in the component", () => {
    for (const match of heroCss.matchAll(/font-size:\s*([\d.]+)(rem|px)/g)) {
      expect(Number(match[1]) * (match[2] === "rem" ? 16 : 1), match[0]).toBeGreaterThanOrEqual(12);
    }
    for (const match of scene.matchAll(/text-\[([\d.]+)(rem|px)\]/g)) {
      expect(Number(match[1]) * (match[2] === "rem" ? 16 : 1), match[0]).toBeGreaterThanOrEqual(12);
    }
    expect(scene).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
  });
});

describe("what the hero cannot be paid to do", () => {
  it("has no input about a holder, a payment, a rank or a boost anywhere in its code", () => {
    for (const [name, text] of [["heroModel.ts", read("./heroModel.ts")], ["HeroScene.tsx", scene], ["NoosphereBackdrop.tsx", backdrop]] as const) {
      // The subcopy denies rankings; that is the one place the word belongs.
      expect(stripComments(text).replace(HERO_COPY.subcopy, ""), name).not.toMatch(/\b(holder|holders|paid|payment|stake|staked|sponsor|sponsored|promoted|boost|boosted|rank|ranking|rankings|tier)\b/i);
    }
  });
});
