import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DETAIL_CHAR_PX, LABEL_LINE_PX, LABEL_MAX_PX, LABEL_PAD_X, LABEL_PAD_Y, NAME_CHAR_PX } from "@/lib/fieldLabels";

/**
 * The /field map: a name at a readable size beside as many agents as fit, and every word in and around the map at 12px or
 * more. There is no browser test runner in the repo, so these read the source for what the plan in lib/fieldLabels relies
 * on (its numbers are the style's), and a run in a real browser checked what that adds up to on the page.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = read("../index.css");
const home = read("./Home.tsx");

/** The body of the first rule in index.css whose selector is exactly `selector`. */
function rule(selector: string) {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(start + selector.length + 3, css.indexOf("}", start));
}
const sizeOf = (body: string) => Number(/font-size:\s*(\d+(?:\.\d+)?)px/.exec(body)?.[1]);

describe("the names beside the agents", () => {
  it("are drawn at the width the plan reserves: its numbers are the style's", () => {
    const label = rule(".agent-label");
    expect(label).toContain(`padding: ${LABEL_PAD_Y}px ${LABEL_PAD_X}px;`);
    expect(label).toContain(`max-width: ${LABEL_MAX_PX}px;`);
    expect(label).toContain("left: 26px;");
    // Words are as wide as the plan thinks: DM Mono is 0.6em across and the names add .02em of spacing, the capability line .04em.
    expect(sizeOf(rule(".agent-label strong"))).toBe(12);
    expect(rule(".agent-label strong")).toContain("letter-spacing: .02em;");
    expect(NAME_CHAR_PX).toBeCloseTo(12 * (0.6 + 0.02), 5);
    expect(sizeOf(rule(".agent-label em"))).toBe(12);
    expect(rule(".agent-label em")).toContain("letter-spacing: .04em;");
    expect(DETAIL_CHAR_PX).toBeCloseTo(12 * (0.6 + 0.04), 5);
    expect(rule(".agent-label strong, .agent-label em")).toContain(`line-height: ${LABEL_LINE_PX}px;`);
  });

  it("shrink to their words, so the room the plan keeps is the room they take", () => {
    expect(rule(".agent-label")).toContain("width: max-content;");
    expect(rule(".agent-label")).not.toContain("min-width");
  });

  it("show the capability only for the selected agent and one pointed at or in focus, and keep it in the page for a screen reader", () => {
    expect(rule(".agent-label em")).toContain("clip-path: inset(50%);");
    expect(css).toContain(".agent-node-active .agent-label em, .agent-node:hover .agent-label em, .agent-node:focus-visible .agent-label em { position: static;");
  });

  it("are left out, not removed, where there is no room: not drawn until the node is pointed at or in focus", () => {
    expect(rule(".agent-label-quiet")).toContain("opacity: 0;");
    expect(css).toContain(".agent-node:hover .agent-label-quiet, .agent-node:focus-visible .agent-label-quiet, .agent-node-active .agent-label-quiet { opacity: 1; }");
    expect(home).toContain('<span className={cn("agent-label", label?.side === "left" && "agent-label-left", !label && "agent-label-quiet")} style={label ? { maxWidth: label.width } : undefined}>');
    expect(home).toContain("label={labelPlan.get(agent.id) ?? null}");
  });

  it("are not drawn on a phone, as before, and leave nothing of their box behind", () => {
    const hidden = "  .agent-label { width: 1px; height: 1px; min-width: 0; max-width: none; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; background: none; }";
    const at = css.indexOf(hidden);
    expect(at, "the phone rule for .agent-label").toBeGreaterThan(-1);
    expect(css.slice(css.lastIndexOf("@media", at), at)).toContain("(max-width: 639px)");
  });
});

describe("the words in and around the map", () => {
  it("are 12px or more in the scene's own rules", () => {
    for (const selector of [".center-label", ".dust-note", ".map-expand", ".agent-label strong", ".agent-label em", ".field-scene .ingress-label strong", ".field-scene .ingress-label em"]) {
      expect(sizeOf(rule(selector)), selector).toBeGreaterThanOrEqual(12);
    }
    expect(sizeOf(rule(".micro-stat span:last-child"))).toBeGreaterThanOrEqual(12);
  });

  it("are 12px or more in the map column of the page, from its title row to its figures", () => {
    const start = home.indexOf('<div className="relative min-h-[535px] p-4 sm:p-6 xl:min-h-[760px]">');
    const end = home.indexOf('<aside className="relative z-10 border-t border-white/[0.09]', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const column = home.slice(start, end);
    const small = [...column.matchAll(/text-\[(\d*\.?\d+)px\]/g)].filter(match => Number(match[1]) < 12).map(match => match[0]);
    expect(small).toEqual([]);
  });

  it("have the two readouts under the map, where they can wrap, and not over it where they met on a phone", () => {
    expect(home).not.toContain("absolute bottom-4 left-4 flex items-center gap-2 rounded bg-black/30");
    expect(home).not.toContain("absolute bottom-4 right-4 flex items-center gap-1 font-mono");
    expect(home).toContain('<div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 font-mono text-xs uppercase tracking-[0.1em]">');
  });
});

describe("the map frame on a phone", () => {
  it("is as wide as the screen: its one column may shrink, so the nav row scrolls and does not stretch it", () => {
    expect(home).toContain('<div className="relative grid min-h-[760px] grid-cols-[minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_320px]">');
  });

  it("puts the arriving agent's label on the side of its node with more room, cut to fit", () => {
    expect(home).toContain('flip && "ingress-node-flip"');
    expect(home).toContain("sceneWidth={sceneSize.width}");
    expect(css).toContain(".field-scene .ingress-node-flip .ingress-label { left: auto; right: 30px; text-align: right; }");
  });
});
