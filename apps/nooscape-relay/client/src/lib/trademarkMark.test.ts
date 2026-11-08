import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The trademark symbol is on the site once and in the README once (the operator's order of 2026-11-07): after the name in the footer's ownership
 * line, "Nooscape™ is run by RunTimeAdmin.", and after the name in the README's title. A mark costs nothing and needs no more than that;
 * written after every mention it would be noise on a page that is about facts. This holds the site to its one place. The README is not read
 * here: a test that names README.md makes the CI scope count every README.md in the repository as read by a test (it matches on the file's
 * name), so a change to the docs index would no longer count as documentation only.
 */
const app = path.resolve(import.meta.dirname, "..", "..", "..");
const MARK = /™|&trade;|&#8482;|&#x2122;/gi;

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : sources(full);
    return /\.(tsx?|html)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("the trademark mark", () => {
  it("is on the site once, on the footer's ownership line", () => {
    const files = ["client", "server", "shared"].flatMap(folder => sources(path.join(app, folder)));
    const found = files.flatMap(file => (readFileSync(file, "utf8").match(MARK) ?? []).map(() => path.relative(app, file).replaceAll("\\", "/")));

    expect(found).toEqual(["client/src/pages/Home.tsx"]);
    const home = readFileSync(path.join(app, "client", "src", "pages", "Home.tsx"), "utf8");
    expect(home).toContain("<span>Nooscape. A public agent observatory. Nooscape has issued no token on any chain");
    expect(home).toContain("Nooscape&trade; is run by RunTimeAdmin.</p>");
  });
});
