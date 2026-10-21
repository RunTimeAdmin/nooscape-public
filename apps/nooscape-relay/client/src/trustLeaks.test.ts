import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Two things the page must not do, guarded at the source because the repo has no browser
 * test runner.
 *
 * 1. Show a score. The home page used to print "Trust vector 92/100". For observed records
 *    that number was 72 or 42 depending on the publisher state, and for the demo records a
 *    fixed value. A figure out of 100 reads as a measurement of an agent, and nothing here
 *    measures that. What the page says instead comes from lib/evidenceReadout.ts.
 * 2. Take the End key (or Home) from the page. Those keys scroll. The scan map's record list
 *    handles them, but only while focus is inside that list, through its own onKeyDown, and the
 *    chain tabs are Radix tabs, which do the same inside the tablist.
 */
const root = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const sources = sourceFiles(root).map(path => ({ file: relative(root, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }));

describe("no score on the page", () => {
  it("has no figure out of 100 in any component", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\/100(?![\d%])(?=["'`<}\s)])/);
    }
  });

  it("has no number written over 100 however it is spaced", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\d+\s*\/\s*100/);
    }
  });

  it("does not read a trust number off a record", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\.trust\b(?!\s*[:(])/);
      expect(text, file).not.toMatch(/\btrust:\s*\d/);
    }
  });

  it("has no block of weighted trust dimensions (28% identity integrity and so on), which was a score in pieces", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/Trust dimensions|trustEvidenceDimensions|dimension scoring/i);
    }
  });

  it("no longer exports the note that apologised for the number", () => {
    expect(sources.find(source => source.file === "lib/evidenceExplain.ts")?.text).not.toContain("trustVectorNote");
  });
});

describe("the word score", () => {
  /**
   * The site says that nothing on it is a score, so the word appears in copy only where it is denied: "not a
   * score", "No scores for sale", "does not score". A new use that is not denied fails here, and says where.
   * Code that happens to use the word, and a list of what Nooscape is not, are named below with the reason.
   */
  const CODE_USES: Record<string, number> = { "components/home/constellationModel.ts": 7 };
  const LISTED_AS_NOT = [{ file: "pages/WhatNooscapeIs.tsx", phrase: "a universal reputation score" }];
  const DENIAL = /\b(no|not|never|nothing|without|nor|cannot|neither|isn't|doesn't)\b/i;
  const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const uses = sources.flatMap(({ file, text }) => {
    const code = withoutComments(text);
    return Array.from(code.matchAll(/\bscores?\b/gi), match => {
      // The sentence so far: back to the last full stop, question mark or line that opens a string.
      const before = code.slice(Math.max(0, match.index - 200), match.index).split(/[.!?]\s|\n/).pop() ?? "";
      return { file, word: match[0], before, around: code.slice(Math.max(0, match.index - 40), match.index + 30).replace(/\s+/g, " ") };
    });
  });

  it("appears in copy only where it is denied", () => {
    const undenied = uses.filter(use => !DENIAL.test(use.before) && !(use.file in CODE_USES) && !LISTED_AS_NOT.some(item => item.file === use.file && use.around.includes(item.phrase.split(" ")[0]!)));
    expect(undenied.map(use => `${use.file}: ...${use.around}...`)).toEqual([]);
  });

  it("is used as code in only the places named, and nowhere new", () => {
    for (const [file, count] of Object.entries(CODE_USES)) {
      expect(uses.filter(use => use.file === file && !DENIAL.test(use.before)).length, file).toBe(count);
    }
  });

  it("is said by the hero in the words of the brief, and nowhere as a claim", () => {
    const hero = sources.find(source => source.file === "components/home/heroModel.ts")!.text;
    expect(hero).toContain("No scores for sale. No rankings for hire.");
    expect(hero).toContain("Light is evidence, not a score.");
  });

  it("finds the uses it is looking for, so a pass means something", () => {
    expect(uses.length).toBeGreaterThan(10);
    expect(uses.some(use => use.file === "pages/home/LandingHero.tsx" && /nothing here is a/i.test(use.before))).toBe(true);
  });
});

describe("the End and Home keys", () => {
  const handlers = sources.filter(({ text }) => /(["'])(End|Home)\1/.test(text));

  it("are handled by something", () => {
    // Guards the guard: if the scan map's list stops handling them this list is empty and the checks below say nothing.
    expect(handlers.map(({ file }) => file)).toContain("components/home/AgentConstellation.tsx");
  });

  it("are only handled in files that register no listener on the whole page", () => {
    for (const { file, text } of handlers) {
      expect(text, file).not.toMatch(/(window|document)\.addEventListener\(\s*["'`](keydown|keyup|keypress)/);
    }
  });

  it("are handled through an element's own onKeyDown, so only while focus is inside it", () => {
    for (const { file, text } of handlers) {
      expect(text, file).toMatch(/onKeyDown=/);
    }
  });

  it("are never swallowed without scrolling being the thing that changed: only the list's handler calls preventDefault for them", () => {
    const scanMap = sources.find(source => source.file === "components/home/AgentConstellation.tsx")!.text;
    const handler = scanMap.slice(scanMap.indexOf("const move ="), scanMap.indexOf("const summary"));
    expect(handler).toContain('event.key === "End"');
    // Every preventDefault sits in a branch that tests a key first, so a key the handler does not know is left alone.
    const firstBranch = handler.indexOf("if (event.key");
    expect(firstBranch).toBeGreaterThan(-1);
    expect(handler.slice(0, firstBranch)).not.toContain("preventDefault");
    for (const branch of handler.slice(firstBranch).split(/\n    (?:\} else )?if \(/)) {
      if (branch.includes("preventDefault()")) expect(branch.split("\n")[0], branch.slice(0, 60)).toContain("event.key");
    }
    expect(handler).toContain("event.preventDefault()");
  });
});
