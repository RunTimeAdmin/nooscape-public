import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The first screen of /developers is what an integrator reads before deciding to go on. It says what the API is for and names the three
 * calls to start with, in plain words, and the internal terms stay further down the page. Guarded at the source because the repo has no
 * browser test runner.
 */
const source = readFileSync(fileURLToPath(new URL("./DeveloperApi.tsx", import.meta.url)), "utf8");
const start = source.indexOf('<section className="developer-hero"');
const hero = source.slice(start, source.indexOf("</section>", start));

describe("the first screen of /developers", () => {
  it("is found, so the checks below mean something", () => {
    expect(start).toBeGreaterThan(0);
    expect(hero.length).toBeGreaterThan(400);
  });

  it("names the three calls an integrator starts with, the check last", () => {
    const lookup = hero.indexOf("GET /api/v1/agents/");
    const search = hero.indexOf("GET /api/v1/agents/search");
    const check = hero.indexOf("POST /api/v1/check");
    expect(lookup).toBeGreaterThan(-1);
    expect(search).toBeGreaterThan(lookup);
    expect(check).toBeGreaterThan(search);
  });

  it("says what the check costs and that nothing is scored", () => {
    expect(hero).toContain("$0.01 in USDC over x402");
    expect(hero).toContain("There is no score and no verdict.");
  });

  it("keeps the internal terms out of the first screen", () => {
    for (const word of ["transport", "publisher-key", "operator-gated", "time-boxed", "evidence graph"]) expect(hero.toLowerCase(), word).not.toContain(word);
  });
});
