import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No long dash in the words the site shows. A long dash in running copy reads as a pause the writer did not finish
 * deciding, and the site's voice is short sentences. The home page and everything it draws, the glossary, the evidence
 * explanations and the Owl's Catch pages are held to none. The older pages still have some; they are named below with
 * how many, which can only go down, and each is cleared in the change that rebuilds that page. Guarded at the source
 * because the repo has no browser test runner.
 */
const root = fileURLToPath(new URL(".", import.meta.url));
const DASH = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]", "g");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
const files = sourceFiles(root).map(path => ({ file: relative(root, path).replaceAll("\\", "/"), code: withoutComments(readFileSync(path, "utf8")) }));
const dashesIn = (file: string) => (files.find(entry => entry.file === file)?.code.match(DASH) ?? []).length;

/** The older pages, and how many long dashes each still has. A count that goes down must be lowered here. */
const OLDER_PAGES: Record<string, number> = {
  "pages/WhatChanged.tsx": 9,
  "pages/SourceOperations.tsx": 8,
  "pages/DeveloperApi.tsx": 7,
  "pages/WhatNooscapeIs.tsx": 4,
  "pages/EcosystemContext.tsx": 1,
  "pages/SourceStatus.tsx": 1,
};

describe("the words of the home page and what it draws", () => {
  const held = files.filter(({ file }) => /^(components\/home\/|pages\/home\/)/.test(file) || ["pages/Home.tsx", "pages/Catch.tsx", "pages/DirectoryAgent.tsx", "components/Term.tsx", "lib/glossary.ts", "lib/evidenceExplain.ts", "lib/evidenceReadout.ts"].includes(file));

  it("holds the files it means to, so a pass means something", () => {
    const names = held.map(({ file }) => file);
    for (const named of ["pages/Home.tsx", "pages/Catch.tsx", "pages/DirectoryAgent.tsx", "lib/glossary.ts", "lib/evidenceExplain.ts", "components/home/OwlsCatch.tsx", "components/home/HeroScene.tsx", "pages/home/LandingHero.tsx"]) expect(names, named).toContain(named);
    expect(held.length).toBeGreaterThan(25);
  });

  it("has no long dash in any of them", () => {
    for (const { file, code } of held) expect(code.match(DASH)?.length ?? 0, file).toBe(0);
  });
});

describe("the older pages", () => {
  it("have no more long dashes than they had, and are listed with the count they have", () => {
    for (const [file, count] of Object.entries(OLDER_PAGES)) expect(dashesIn(file), file).toBe(count);
  });

  it("are the only other files with a long dash in them, so a new one cannot come in elsewhere", () => {
    const others = files.filter(({ code, file }) => (code.match(DASH) ?? []).length > 0 && !(file in OLDER_PAGES)).map(({ file }) => file);
    expect(others).toEqual([]);
  });
});
