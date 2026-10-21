import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "./owlLines";

/**
 * The bubble is a component with timers, a live region and a measured placement, and the repo has no browser test
 * runner, so these read the source for the parts the brief makes rules of; a run in a real browser checked them.
 * What it may say is tested in owlLines.test.ts and where it may go in owlAvoid.test.ts.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const bubble = read("./OwlBubble.tsx");
const css = read("../../index.css");

describe("what the bubble says", () => {
  it("comes from owlLines alone: the component holds no sentence of the owl's", () => {
    expect(bubble).toContain("nextLine(facts, new Date(), memoryNow.said.get(facts.key) ?? [])");
    for (const phrase of ["The Owl has kept", "Last seen", "Evidence on record", "Publisher:", "Its registry", "Read from", "have seen it", "has seen it"]) expect(bubble, phrase).not.toContain(phrase);
    // And every phrase the templates use is in owlLines, not in the page that tells the owl its facts.
    const hero = read("../../pages/home/LandingHero.tsx");
    for (const template of TEMPLATES) expect(hero, template.id).not.toContain(`"${template.id}"`);
  });

  it("speaks only from a perch beside the records, never on a touch screen, and is told its facts by the page", () => {
    expect(bubble).toContain('if (!rest || rest.topic !== "records" || !facts || coarse) {');
    expect(read("../../pages/home/LandingHero.tsx")).toContain('data-owl-topic="records"');
    const hook = read("./useOwlRig.ts");
    expect(hook).toContain("onRest?.({ topic: restPerch.topic, box: perchedBox(target, size), since: restingSince });");
    // Said again, as null, when it leaves: in the loop, and when the owl goes.
    expect(hook).toMatch(/restingSince = null;\s*reported = undefined;\s*onRest\?\.\(null\);/);
    expect(hook).toContain("if (restingSince !== null) onRest?.(null);");
    // At rest means standing on a perch, perched and there, not flying past.
    expect(hook).toContain('const settled = restPerch !== null && state.mode === "perched" && Math.hypot(state.x - target.x, state.y - target.y) < 4;');
  });

  it("keeps to the brief's timing: after a moment at rest, one in eight seconds, and quiet for a minute after a dismissal", () => {
    expect(bubble).toContain("SETTLE_MS - (now - rest.since)");
    expect(bubble).toContain("SPEAK_GAP_MS - (now - memoryNow.lastSpokeAt)");
    expect(bubble).toContain("(memoryNow.quiet.get(facts.key) ?? 0) - now");
    expect(bubble).toContain("memory.current.quiet.set(facts.key, performance.now() + DISMISS_QUIET_MS);");
    expect(bubble).toContain("timers.current.hide = window.setTimeout(hide, SHOW_MS);");
  });

  it("remembers what it has said about a record and does not say it twice", () => {
    expect(bubble).toContain("memoryNow.said.set(facts.key, [...(memoryNow.said.get(facts.key) ?? []), pending.id]);");
  });

  it("is about one record: when the card moves to another, the note goes", () => {
    expect(bubble).toContain("noteKey.current = facts.key;");
    expect(bubble).toContain("if (noteKey.current !== null && noteKey.current !== facts.key) hide();");
    expect(bubble).toMatch(/const hide = useCallback\(\(\) => \{[^}]*noteKey\.current = null;/);
  });
});

describe("where the bubble goes", () => {
  it("is measured on the page, hidden, and placed clear of everything marked, or not said", () => {
    expect(bubble).toContain("placeBubble({");
    expect(bubble).toContain("rects: readAvoidRects(),");
    // Marked boxes with no size on the page (not displayed) are not boxes to keep clear of.
    expect(read("./owlWorld.ts")).toMatch(/export function readAvoidRects\(\): Rect\[\] \{[^}]*\.filter\(box => box\.width >= 1 && box\.height >= 1\)/);
    expect(bubble).toContain("bubble: { width: bubble.current.offsetWidth, height: bubble.current.offsetHeight },");
    expect(bubble).toContain('visibility: shown ? "visible" : "hidden"');
    expect(bubble).toMatch(/if \(!place\) return;/);
  });

  it("keeps the owl with its note: while one is up, a pointer is not a pointer calling the owl away", () => {
    const hook = read("./useOwlRig.ts");
    expect(hook).toContain('const speaking = document.querySelector("[data-owl-note]") !== null;');
    expect(hook).toContain("pointer.x = speaking ? state.x : event.clientX;");
    expect(hook).toContain("pointer.y = speaking ? state.y : event.clientY;");
  });

  it("goes when the owl does: it is hidden the moment the owl leaves its perch", () => {
    expect(bubble).toMatch(/if \(!rest \|\| rest\.topic !== "records" \|\| !facts \|\| coarse\) \{\s*hide\(\);\s*return;\s*\}/);
  });
});

describe("how the bubble is read and dismissed", () => {
  it("has a live region of its own that is always on the page, polite, and read whole", () => {
    expect(bubble).toContain('<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">');
    expect(bubble).toContain("setLive(pending.text);");
    expect(bubble).toContain('setLive("");');
  });

  it("shows its words to the eye only, so a screen reader hears them once, from the live region", () => {
    expect(bubble).toContain('<span aria-hidden="true">{text}</span>');
  });

  it("can be dismissed by a button with a name, and by Escape", () => {
    expect(bubble).toContain('aria-label="Dismiss the Owl\'s note"');
    expect(bubble).toContain('if (event.key === "Escape") dismiss();');
    expect(bubble).toContain('document.addEventListener("keydown", onKey);');
    expect(bubble).toContain('document.removeEventListener("keydown", onKey);');
  });

  it("stays while the pointer is on it or its button has focus, but never longer than HOLD_MAX_MS, and counts its six seconds again after", () => {
    expect(bubble).toMatch(/const hold = useCallback\(\(\) => \{\s*window\.clearTimeout\(timers\.current\.hide\);\s*timers\.current\.hide = window\.setTimeout\(hide, HOLD_MAX_MS\);\s*\}, \[hide\]\);/);
    expect(bubble).toContain('data-owl-note="" onPointerEnter={hold} onPointerLeave={arm} onFocus={hold} onBlur={arm}');
    // The note carries the mark the rig looks for.
    expect(read("./useOwlRig.ts")).toContain("[data-owl-note]");
    expect(bubble).toMatch(/const arm = useCallback\(\(\) => \{\s*window\.clearTimeout\(timers\.current\.hide\);\s*timers\.current\.hide = window\.setTimeout\(hide, SHOW_MS\);/);
    expect(bubble).toMatch(/arm\(\);\s*\}, \[pending, rest, facts, arm\]\);/);
  });

  it("clears its timers when it goes", () => {
    expect(bubble).toContain("window.clearTimeout(current.speak);");
    expect(bubble).toContain("window.clearTimeout(current.hide);");
  });
});

describe("how the bubble looks", () => {
  it("is a glass note above the owl, with a dismiss button that sets its own type and shows its focus", () => {
    expect(css).toMatch(/\.owl-bubble \{ position: fixed; z-index: 41;/);
    expect(css).toMatch(/\.owl-bubble-x \{[^}]*font: 600 1rem\/1 /);
    expect(css).toMatch(/\.owl-bubble-x:focus-visible \{[^}]*outline: 2px solid var\(--ns-radar\);/);
    expect(css).toMatch(/\.owl-bubble-x \{ flex: none; min-width: 1\.75rem; min-height: 1\.75rem;/);
  });

  it("animates only opacity and transform, and not with reduced motion", () => {
    const keyframes = /@keyframes owl-bubble-in \{([^}]*\{[^}]*\}[^}]*\{[^}]*\}[^}]*)\}/.exec(css)?.[1] ?? "";
    expect(keyframes).not.toBe("");
    for (const property of Array.from(keyframes.matchAll(/([a-z-]+):\s*[^;]+;/g), match => match[1]!)) expect(property).toMatch(/^(opacity|transform)$/);
    expect(css).toContain("@media (prefers-reduced-motion: reduce) { .owl-bubble { animation: none; } }");
  });

  it("sits in the owl's company: rendered by the owl, which tells it where it rests", () => {
    const companion = read("./OwlCompanion.tsx");
    expect(companion).toContain("useOwlRig({ boxRef, reducedMotion, coarse, onRest: setRest });");
    expect(companion).toContain("<OwlBubble rest={rest} coarse={coarse} />");
  });
});

describe("what the page tells the owl", () => {
  it("is set from the card's record, and withdrawn only when the map goes", () => {
    const hero = read("../../pages/home/LandingHero.tsx");
    expect(hero).toContain("setOwlFacts(bubbleFacts(node, evidence, record));");
    expect(hero).toContain("useEffect(() => () => setOwlFacts(null), []);");
    // Not withdrawn on every change: a read of the same data would end the note the moment it began.
    expect(hero).not.toContain("return () => setOwlFacts(null);");
  });
});
