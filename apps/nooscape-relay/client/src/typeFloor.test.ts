import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No text on the site is meant to be smaller than 12 px. About half of what the home
 * page showed was (down to 7 px), and fixing that in one sweep would restyle every page,
 * so this is a ratchet: each file may hold only the number of smaller sizes listed
 * below. New text has to be 12 px or more (`text-xs` is 12 px), and a surface that gets
 * rebuilt lowers its entry, or removes it, in the same change. The count is exact on
 * purpose, so a gain cannot be quietly spent again later.
 */
const BELOW_FLOOR: Record<string, number> = {
  "index.css": 235,
  "pages/home/DeepSpace.tsx": 6,
  "pages/home/FieldView.tsx": 15,
  "pages/WhatNooscapeIs.tsx": 18,
};

const FLOOR_PX = 12;

/** A size below the floor, in a Tailwind arbitrary value (`text-[9px]`) or a CSS declaration (`font-size: 9px`). */
export function countBelowFloor(text: string) {
  const below = ([, value, unit]: RegExpMatchArray) => (unit === "px" ? Number(value) < FLOOR_PX : Number(value) < FLOOR_PX / 16);
  return (
    [...text.matchAll(/text-\[(\d*\.?\d+)(px|rem)\]/g)].filter(below).length + [...text.matchAll(/font-size:\s*(\d*\.?\d+)(px|rem)/g)].filter(below).length
  );
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the counter", () => {
  it("counts a size below 12 px in a class or a declaration, and nothing else", () => {
    expect(countBelowFloor('<p className="text-[9px] text-[11.5px] text-[0.7rem]">')).toBe(3);
    expect(countBelowFloor(".a { font-size: 10px; } .b { font-size: .6rem; }")).toBe(2);
    expect(countBelowFloor('<p className="text-xs text-[12px] text-[13px] text-[0.75rem] text-sm">')).toBe(0);
    expect(countBelowFloor(".a { font-size: 12px; } .b { font-size: 0.875rem; } .c { font-size: var(--ns-text-floor); }")).toBe(0);
  });
});

describe("the type floor", () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const counts = Object.fromEntries(
    sourceFiles(root)
      .map(path => [relative(root, path).replaceAll("\\", "/"), countBelowFloor(readFileSync(path, "utf8"))] as const)
      .filter(([, count]) => count > 0)
  );

  it("holds no more sizes below 12 px than the ratchet allows, in any file", () => {
    for (const [file, count] of Object.entries(counts)) {
      expect(count, `${file} has ${count} sizes below 12px, the ratchet allows ${BELOW_FLOOR[file] ?? 0}. New text must be 12px or more (text-xs).`).toBeLessThanOrEqual(BELOW_FLOOR[file] ?? 0);
    }
  });

  it("has been lowered to match, so a gain is locked in", () => {
    for (const [file, allowed] of Object.entries(BELOW_FLOOR)) {
      expect(counts[file] ?? 0, `${file} is down to ${counts[file] ?? 0}, so lower its ratchet entry from ${allowed}.`).toBe(allowed);
    }
  });
});
