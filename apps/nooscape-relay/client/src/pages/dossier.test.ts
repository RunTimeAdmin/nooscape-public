import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Dossier is the agent page, and the repo has no browser test runner, so these read the source for what the
 * brief makes rules of: its name and its parts, the footer, raters marked unverified, a measure that is missing shown
 * as missing and never as a zero, and no score. What it draws was checked in a real browser against the built server.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const page = read("./DirectoryAgent.tsx");
const checkText = read("../lib/checkText.ts");
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the Dossier", () => {
  it("is named by the glossary on its eyebrow, and says what the record shows", () => {
    expect(page).toContain('<p className="eyebrow"><Term k="dossier">Dossier</Term></p>');
    expect(page).toContain(">What the record shows</h2>");
  });

  it("gives an acknowledged entry the brief's five parts, in the brief's order", () => {
    // A reviewed record's own registry entry comes first in the file, so the entry's is the last one.
    const registry = page.lastIndexOf('title="Registry entry"');
    expect(registry).toBeGreaterThan(page.indexOf('title="Evidence timeline"'));
    const rest = ["Owner", "Host and links", "Feedback", "Fleet membership"].map(title => page.indexOf(`title="${title}"`));
    expect(rest.every(position => position > registry)).toBe(true);
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
  });

  it("gives a reviewed record its registry entry and its evidence timeline", () => {
    expect(page).toContain('title="Registry entry"');
    expect(page).toContain('title="Evidence timeline"');
  });

  it("gives a reviewed record a Checks section after its evidence timeline, only when there are checks, and not an acknowledged entry", () => {
    const checks = page.indexOf('<Section id="dossier-checks" title="Checks">');
    expect(checks).toBeGreaterThan(page.indexOf('title="Evidence timeline"'));
    // Inside the reviewed record's block, which ends before the acknowledged entry's begins.
    expect(checks).toBeLessThan(page.indexOf("{entry && ("));
    expect(page.slice(page.lastIndexOf("{checks.length > 0 && (", checks), checks)).toMatch(/^\{checks\.length > 0 && \(\s*$/);
  });

  it("reads the checks by typed access, never a cast of the whole answer", () => {
    expect(page).toContain("const checks: AgentCheck[] = profile?.checks ?? [];");
    expect(page).not.toMatch(/\bas\s+AgentCheck/);
    expect(page).not.toMatch(/profileQuery\.data\s+as\b|\(profile\s+as\b/);
  });

  it("states each check as a fact with its date: the host, then one sentence of what the ask got and when, and links to the page about the checker", () => {
    const start = page.indexOf('<Section id="dossier-checks"');
    const section = page.slice(start, page.indexOf("</Section>", start));
    expect(section).toContain("{check.host}");
    expect(section).toContain("{checkSentence(check, formatWhen(check.checkedAt))}");
    expect(section).toContain('href="/checker"');
    // The time is in the sentence, in the viewer's own zone, and the numeric date of the older line is gone.
    expect(section).not.toContain("formatDate(");
    expect(page).toContain('import { checkSentence, formatWhen, type AgentCheck } from "@/lib/checkText";');
  });

  it("says what the ask got and never that the host answered, and says that redirects are followed, because the last answer can be another host's", () => {
    const sentences = stripComments(checkText.slice(checkText.indexOf("export function checkSentence")));
    expect(sentences).not.toMatch(/answered|replied|responded/i);
    expect(page).toContain("The checker follows redirects, so a status can come from another host than the one named.");
  });

  it("lights no line: the dot beside a check is a neutral grey, not the protocol's colour", () => {
    const start = page.indexOf('<Section id="dossier-checks"');
    const section = page.slice(start, page.indexOf("</Section>", start));
    expect(section).toContain('<Dot color="#9AA8B8" />');
    expect(section).not.toContain("<Dot color={tone} />");
  });

  it("grades no host: no verdict word in the Checks section or in what it says of a check, except the operator's own word, failing, which is said of three misses in a row and defined", () => {
    const start = page.indexOf('<Section id="dossier-checks"');
    const sentences = stripComments(checkText.slice(checkText.indexOf("export function checkSentence")));
    const words = stripComments(page.slice(start, page.indexOf("</Section>", start))) + sentences;
    expect(words).toContain("never a verdict");
    expect(words).not.toMatch(/\b(?:healthy|unhealthy|alive|dead|offline|online|down|trusted|verified|reliable|uptime|working|broken|passed|good|bad)\b/i);
    // "failing" has two places: the note that defines it, and the sentence of a line whose last three asks got no answer.
    expect(words).toContain("A line says failing only when the last three asks in a row got no answer, and that says nothing about why.");
    expect(sentences).toMatch(/check\.failing\s*\?\s*`Failing: the last three asks got no answer/);
    const rest = words.replace(/A line says failing only when[^.]*\./, "").replace(/check\.failing/g, "").replace(/`Failing: the last three asks got no answer[^`]*`/, "");
    expect(rest).not.toMatch(/failing/i);
  });

  it("sets nothing under 12px in the Checks section", () => {
    const start = page.indexOf('<Section id="dossier-checks"');
    const section = page.slice(start, page.indexOf("</Section>", start));
    for (const [, size] of section.matchAll(/text-\[(\d+)px\]/g)) expect(Number(size)).toBeGreaterThanOrEqual(12);
  });

  it("ends with the footer the brief gives", () => {
    expect(page).toContain("Evidence, not a verdict. You decide.");
    expect(page.indexOf("Evidence, not a verdict. You decide.")).toBeGreaterThan(page.indexOf('title="Fleet membership"'));
  });

  it("marks every rater unverified, and says the registry counter is not a Nooscape rating", () => {
    expect(page).toContain("Raters are unverified: Nooscape has not checked who they are.");
    expect(page).toMatch(/by \{event\.clientAddress\} <span className=\{`\$\{chip\}[^`]*`\}>unverified<\/span>/);
    expect(page).toContain("It is not a Nooscape rating.");
  });

  it("says a measure is not measured, rather than showing a zero it does not have", () => {
    expect(page).toContain("Chain activity is not measured for this entry.");
    expect(page).toContain("Feedback is not measured for this entry.");
    expect(page).toContain("Look-alike groups are not measured for this entry right now.");
    expect(page).toContain('"?"');
  });

  it("keeps every fact the old page held: the owner's wallet and chain activity, the host, the twin, the fleet counts", () => {
    for (const kept of ["registrantLabel(entry.protocol)", "Minted at block", "Changes of hands", "Profile-link edits", "Locator host", "Linked chain twin", "lookalikeLine(", "sameName", "sameHost", "registryRatingsExplanation", "chainActivityExplanation", "acknowledgedExplanation"]) {
      expect(page, kept).toContain(kept);
    }
  });

  it("links to Fleet sightings on the home page, and that section is there to be linked to", () => {
    expect(page).toContain('href="/#fleet-heading"');
    expect(read("../components/home/FleetCards.tsx")).toContain('id="fleet-heading"');
  });

  it("claims no score, and shows no figure out of 100", () => {
    const words = stripComments(page);
    expect(words).not.toMatch(/\bscores?\b/i);
    expect(words).not.toMatch(/\d+\s*\/\s*100/);
  });

  it("sets the tab's title with a bar, not a long dash", () => {
    expect(page).toContain("`${name} | Nooscape`");
  });
});
