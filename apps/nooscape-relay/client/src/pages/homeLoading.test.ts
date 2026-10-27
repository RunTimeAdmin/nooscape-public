import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Home used to return a full-screen spinner until a query answered, so the first thing a visitor
 * saw after the scripts loaded was a black screen, even though the hero, the scan map and the
 * funnel read the live directory and needed nothing else. Now the page draws at once and only the
 * field, which is built from the live records, waits for one to select. The repo has no browser
 * test runner, so these guard the parts that hold that.
 */
const home = readFileSync(new URL("./Home.tsx", import.meta.url), "utf8");
const field = readFileSync(new URL("./home/FieldView.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

describe("Home while the field's records load", () => {
  it("never replaces the whole page with a loading or error screen", () => {
    expect(home).not.toMatch(/if \(liveRecordsQuery\.isLoading\)/);
    expect(home).not.toMatch(/atlas\.overview/);
    expect(home).not.toContain('return <main className="grid min-h-screen place-items-center');
  });

  it("holds the field's place with a placeholder that says whether it is loading or unavailable", () => {
    expect(home).toContain("const atlasReady = Boolean(selected);");
    expect(field).toContain('<AtlasPlaceholder state={liveRecordsQuery.isLoading ? "loading" : "unavailable"} />');
  });

  it("opens the Deep map only once there is a record to draw, so the page is never hidden behind a map that cannot draw", () => {
    expect(home).toContain("const deepSpaceOpen = deepSpace && atlasReady;");
    expect(home).toContain('deepSpaceOpen && "shell-deep-open"');
    expect(home).toContain("{deepSpaceOpen && (");
    expect(home).toContain("<Suspense fallback={<DeepSpaceOpening />}>");
    expect(home.indexOf("{deepSpaceOpen && (")).toBeLessThan(home.indexOf("<DeepSpaceMap "));
    expect(home).not.toMatch(/\{deepSpace && <DeepSpaceMap/);
  });

  it("draws the hero, the scan map and the funnel outside the atlas gate", () => {
    const start = field.indexOf("{atlasReady ? <>");
    const end = field.indexOf("</> : <AtlasPlaceholder");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const gated = field.slice(start, end);
    expect(gated).toContain("observatory-frame");
    // The hero and the funnel are on the home page, the unknowns and the ribbon on the full field; none of them waits for the atlas.
    for (const outside of ["<LandingHero", "<LandingEvidence"]) {
      expect(gated, outside).not.toContain(outside);
      expect(home, outside).toContain(outside);
    }
    for (const outside of ['aria-label="What nobody can measure yet"', "protocol-ribbon"]) {
      expect(gated, outside).not.toContain(outside);
      expect(field, outside).toContain(outside);
    }
  });
});

describe("Home while the live read loads", () => {
  it("shows a skeleton for the population card, not a count that stands in when there are no live records", () => {
    expect(home).toContain("{liveRecordsQuery.isLoading ? <PopulationSkeleton /> : <section aria-label=\"Live observatory population\"");
    expect(home).toContain("function PopulationSkeleton()");
  });

  it("tells the header's status lines the read is pending, so they say Loading and not SEED or DEMO ONLY", () => {
    expect(home).toContain("loading: liveRecordsQuery.isLoading,");
    expect(home).not.toContain('"SEED / 06"');
  });
});

describe("lazy pages", () => {
  it("show a shell while they load, not a blank dark box", () => {
    expect(app).toContain("<Suspense fallback={<PageShell />}>");
    expect(app).not.toMatch(/fallback=\{<div className="min-h-screen bg-\[#06070b\]"/);
  });
});
