import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anchorId, isScrolled, MORE_ANCHORS, PAGE_LINKS, PRIMARY_LINKS, SCROLL_PAST_PX, statusLines } from "./headerModel";

const root = fileURLToPath(new URL("../../", import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.tsx$/.test(entry.name) ? [readFileSync(path, "utf8")] : [];
  });
}
const allSource = sources(root).join("\n");

describe("the bar", () => {
  it("holds three links, so with the button and the menu there are five things to reach", () => {
    expect(PRIMARY_LINKS).toHaveLength(3);
    // The places are called what the sections are called.
    expect(PRIMARY_LINKS.map(link => link.label)).toEqual(["Atlas", "Regions", "How the Owl sees"]);
    expect(MORE_ANCHORS.map(link => link.label)).toEqual(["Field Reports"]);
    expect(PRIMARY_LINKS.length + 2).toBeLessThanOrEqual(5);
  });

  it("points every in-page link at a heading that exists on the page", () => {
    for (const link of [...PRIMARY_LINKS, ...MORE_ANCHORS]) {
      const id = anchorId(link.href);
      expect(id, link.label).not.toBeNull();
      expect(allSource, `${link.label} -> #${id}`).toContain(`id="${id}"`);
    }
  });

  it("gives every link a distinct label and target", () => {
    const all = [...PRIMARY_LINKS, ...MORE_ANCHORS, ...PAGE_LINKS];
    expect(new Set(all.map(link => link.label)).size).toBe(all.length);
    expect(new Set(all.map(link => link.href)).size).toBe(all.length);
  });
});

describe("the menu", () => {
  it("still reaches every page the old header linked to, and the full field the home page no longer holds", () => {
    expect(PAGE_LINKS.map(link => link.href)).toEqual(["/field", "/catch", "/developers", "/verify", "/sources", "/context", "/about"]);
  });

  it("names the destination in words, never only an icon", () => {
    for (const link of PAGE_LINKS) expect(link.label.length).toBeGreaterThan(2);
  });
});

describe("the glass background", () => {
  it("begins after 24px of scrolling", () => {
    expect(SCROLL_PAST_PX).toBe(24);
    expect(isScrolled(0)).toBe(false);
    expect(isScrolled(24)).toBe(false);
    expect(isScrolled(25)).toBe(true);
    expect(isScrolled(2400)).toBe(true);
  });
});

describe("statusLines", () => {
  const base = { loading: false, recordCount: 82, publicRecordCount: 82, coveragePercent: 100 };

  it("states what was observed and how much has provenance", () => {
    expect(statusLines(base)).toEqual([
      { label: "Live records", value: "Observed / 82" },
      { label: "Provenance", value: "100% ready" },
      { label: "Discovery", value: "Multi-protocol" },
    ]);
  });

  it("pads a small count to two digits, as the chips did", () => {
    expect(statusLines({ ...base, recordCount: 7, publicRecordCount: 7 })[0]!.value).toBe("Observed / 07");
  });

  it("uses the records read when the coverage read has no public count", () => {
    expect(statusLines({ ...base, publicRecordCount: null, recordCount: 9 })[0]!.value).toBe("Observed / 09");
  });

  it("says Checking until the coverage read returns", () => {
    expect(statusLines({ ...base, coveragePercent: null })[1]!.value).toBe("Checking");
  });

  it("says Loading, with no figure, while the live read is pending", () => {
    const lines = statusLines({ ...base, loading: true, recordCount: 0 });
    expect(lines[0]!.value).toBe("Loading");
    expect(lines[1]!.value).toBe("Loading");
    expect(JSON.stringify(lines)).not.toMatch(/\d/);
  });

  it("says None observed, with no figure, when there are no live records", () => {
    const lines = statusLines({ ...base, recordCount: 0, publicRecordCount: null, coveragePercent: null });
    expect(lines[0]!.value).toBe("None observed");
    expect(lines[1]!.value).toBe("None observed");
    expect(JSON.stringify(lines)).not.toMatch(/\d|demo/i);
  });
});

describe("anchorId", () => {
  it("reads the id from an in-page anchor and nothing else", () => {
    expect(anchorId("#chains-heading")).toBe("chains-heading");
    expect(anchorId("/verify")).toBeNull();
    expect(anchorId("#")).toBeNull();
  });
});
