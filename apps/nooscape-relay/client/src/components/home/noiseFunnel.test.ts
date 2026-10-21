import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { directoryFunnelStepCopy } from "@/lib/glossary";
import { EVIDENCE_FROM, FOG_STAGE_MS } from "./noiseModel";

/**
 * The funnel is a component with a button, a live region and a stylesheet, and the repo has no browser test runner, so
 * these read the source for the parts the briefs make rules of; a run in a real browser checked them. The arithmetic is
 * tested in noiseModel.test.ts.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const funnel = read("./NoiseFunnel.tsx");
const home = read("../../pages/Home.tsx");
const evidence = read("../../pages/home/LandingEvidence.tsx");
const css = read("../../index.css").replace(/\r\n/g, "\n");
/** The funnel's own rules: from its first comment to the reduced-motion block's end. */
const fogCss = css.slice(css.indexOf(".noise-funnel {"), css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .fog-row"));

describe("one funnel", () => {
  it("is the only one on the home page: the second funnel and its styles are gone", () => {
    for (const gone of ["Honesty funnel", "From acknowledged to proven", "funnel-row", "funnel-list", "directoryFunnelStepCopy"]) expect(home, gone).not.toContain(gone);
    expect(css).not.toMatch(/\.funnel-/);
    expect(evidence.match(/<NoiseFunnel /g)).toHaveLength(1);
    expect(evidence).not.toContain("NoiseFilter");
    expect(home.match(/<LandingEvidence/g)).toHaveLength(1);
  });

  it("keeps what the second funnel said about the activity walk, in a disclosure, fed by the read Home already makes", () => {
    expect(home).toContain("activity={directoryFunnel?.activityTotals ?? null}");
    expect(evidence).toContain("activity: { secondaryTransfers: number; handoutTransfers: number; uriUpdates: number } | null;");
    expect(evidence).toContain("<NoiseFunnel steps={funnelSteps} status={funnelStatus} asOfBlock={asOfBlock} activity={activity} />");
    const markup = strip(funnel);
    expect(markup).toContain("<summary>How these were counted</summary>");
    expect(markup).toContain('<Term k="handout">hand-outs</Term>');
    expect(markup).toContain('<Link href="/changes" className="fog-link">See what changed</Link>');
    expect(markup).toContain("as of block");
  });

  it("splits at a step that has copy, so every row can be drawn", () => {
    expect(directoryFunnelStepCopy[EVIDENCE_FROM]).toBeDefined();
  });
});

describe("the Clear the Fog button", () => {
  const markup = strip(funnel);

  it("is a toggle that says what it will do, and is shown only when the funnel can say who is left", () => {
    expect(markup).toContain('<button type="button" data-owl-avoid="" aria-pressed={cleared} onClick={() => setCleared(value => !value)} className="fog-button">');
    expect(markup).toContain('{cleared ? "Show all" : "Clear the Fog"}');
    expect(markup).toContain("{ready && split && (");
    expect(fogCss).toMatch(/\.fog-button \{[^}]*min-height: 2\.75rem;/);
    // Its width holds both labels, so the button stays where it is when its words change.
    expect(fogCss).toMatch(/\.fog-button \{[^}]*min-width: 9rem;/);
  });

  it("tells the list whether the fog is cleared, and gives each row its place, its true bar and the bar it has once the fog is cleared", () => {
    expect(markup).toContain('data-fog={cleared ? "clear" : "all"}');
    expect(markup).toContain('"--stage": row.stage, "--w": (row.full ?? 0) / 100, "--z": (row.zoomed ?? row.full ?? 0) / 100');
    expect(markup).toContain("data-role={row.role}");
  });

  it("says its state in words, in a polite live region that is in the page from the start", () => {
    expect(markup).toContain('<p role="status" data-owl-avoid="" className="fog-state">');
    expect(markup).toContain("Fog cleared.");
    expect(markup).toContain("showing, every bar drawn against the longest.");
    // Both states take the same room on a narrow screen, so toggling moves nothing.
    expect(fogCss).toContain("@container (max-width: 559px) { .fog-state { min-height: 3em; } }");
  });

  it("moves the figure in view down the funnel as the fog clears, one step of it at a time, each a count the server gave", () => {
    expect(markup).toContain("stageDelays(split).map((delay, index) => window.setTimeout(() => setStage(index + 1), delay))");
    expect(markup).toContain("const inView = known[Math.min(stage, known.length - 1)];");
    expect(markup).toContain('<CountUp value={inView.value} durationMs={FOG_STAGE_MS} />');
    expect(markup).toContain("in view: {directoryFunnelStepCopy[inView.key]!.label}");
    expect(markup).toContain("setStage(cleared ? fogCount : 0);");
    expect(FOG_STAGE_MS).toBe(600);
    expect(fogCss).toContain("--fog-stage");
    expect(funnel).toContain('"--fog-stage": `${FOG_STAGE_MS}ms`');
  });
});

describe("on a phone", () => {
  it("lets the funnel and the wallet cards shrink to the screen: one real column, and cards that may be narrower than their longest word", () => {
    expect(evidence).toContain('<div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.1fr_.9fr]">');
    const fleet = read("./FleetCards.tsx");
    expect(fleet).toContain('className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"');
    expect(fleet).toContain("<li key={card.registrant} className={`min-w-0 ");
  });

  it("shows six wallet cards on a phone, where they stack, and all twelve from 640 pixels", () => {
    const fleet = read("./FleetCards.tsx");
    expect(fleet).toContain("const PHONE_CARDS = 6;");
    expect(fleet).toContain('${index >= PHONE_CARDS ? "hidden sm:block" : ""}');
  });

  it("stacks the figure in view over its label, and keeps both sentences the same height, so toggling moves nothing", () => {
    expect(fogCss).toContain(".fog-view { display: grid; gap: .3rem;");
  });
});

describe("what the funnel says", () => {
  const copy = strip(funnel);

  it("keeps to what the control does: it dims the steps that count listings, and says nothing of fleets, scores or verdicts", () => {
    // One sentence of lead-in, and it says what the button does.
    expect(copy).toContain("Most of what registries list has never been checked by anyone; Clear the Fog dims the steps that only count listings.");
    expect(copy).not.toMatch(/\bfleets?\b|score|rank|verdict|trusted|verified/i);
  });

  it("shows a step that is not measured as not measured yet, never a zero, and nothing when it has no counts", () => {
    expect(copy).toContain('row.value === null ? <span className="fog-na">not measured yet</span>');
    expect(copy).toContain('row.value === null ? "?"');
    expect(copy).toContain("cannot be read right now. Public reads fail closed rather than guess.");
  });

  it("has no long dash anywhere in what it writes", () => {
    expect(funnel).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("static first, and only transform and opacity move", () => {
  it("draws every bar as a transform of a full-width bar, not an inline width, and every row from the first paint", () => {
    expect(funnel).not.toMatch(/style=\{\{\s*width/);
    expect(fogCss).toMatch(/\.fog-bar \{[^}]*width: 100%;[^}]*transform: scaleX\(var\(--w\)\);/);
    expect(strip(funnel)).toContain("rows.map(row => {");
  });

  it("arms the draw-in before the first paint when the section is already in view, so a bar is never seen complete and then empty", () => {
    expect(funnel).toContain("useLayoutEffect(() => {");
    expect(funnel).toMatch(/if \(box\.bottom > 0 && box\.top < window\.innerHeight \+ 120\) \{\s*setArmed\(true\);\s*return;\s*\}/);
    expect(funnel).toContain('{ rootMargin: "0px 0px 120px 0px" }');
    expect(funnel).toContain("if (!element || reduced || armed || !ready) return;");
  });

  it("transitions and animates nothing but opacity and transform", () => {
    for (const declaration of Array.from(fogCss.matchAll(/transition:\s*([^;]+);/g), match => match[1]!)) {
      for (const part of declaration.split(",")) expect(part.trim(), declaration).toMatch(/^(opacity|transform)\b/);
    }
    const keyframes = /@keyframes fog-draw \{([^}]*\{[^}]*\}[^}]*)\}/.exec(fogCss)?.[1] ?? "";
    expect(keyframes).not.toBe("");
    for (const property of Array.from(keyframes.matchAll(/([a-z-]+):\s*[^;]+;/g), match => match[1]!)) expect(property).toBe("transform");
  });

  it("keeps every dimmed row at AA contrast: the dimmest text, the notes, is at least 4.5 to 1 on the void at this opacity", () => {
    expect(fogCss).toContain('.fog-list[data-fog="clear"] .fog-row[data-role="fog"] { opacity: .76; }');
  });

  it("collapses the fog a stage at a time and draws what is left against its own longest, then clears all of it by hand with Show all", () => {
    expect(fogCss).toContain('.fog-list[data-fog="clear"] .fog-row { transition-delay: calc(var(--stage) * var(--fog-stage)); }');
    expect(fogCss).toContain('.fog-list[data-fog="clear"] .fog-row[data-role="fog"] .fog-bar { transform: scaleX(0); }');
    expect(fogCss).toContain('.fog-list[data-fog="clear"] .fog-row[data-role="left"] .fog-bar { transform: scaleX(var(--z)); }');
  });

  it("stops moving with reduced motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce) {\n  .fog-row, .fog-bar, .fog-track::before { transition: none; }");
    expect(css).toContain('.noise-funnel[data-armed="true"] .fog-bar { animation: none; }');
    expect(funnel).toContain("if (!element || reduced || armed || !ready) return;");
  });

  it("holds no type under 12 px, and shows focus", () => {
    for (const size of Array.from(fogCss.matchAll(/font-size:\s*([\d.]+)(px|rem)/g))) {
      const px = size[2] === "px" ? Number(size[1]) : Number(size[1]) * 16;
      expect(px, size[0]).toBeGreaterThanOrEqual(12);
    }
    expect(fogCss).toContain(".fog-button:focus-visible, .fog-how summary:focus-visible, .fog-link:focus-visible { outline: 2px solid var(--ns-radar); outline-offset: 2px; }");
  });
});
