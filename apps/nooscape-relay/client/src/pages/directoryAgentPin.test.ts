import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * An entry the operator pinned into the listing says so on its page (docs/pin-disclosure-2026-11-05.md). The repo has no browser test
 * runner, so the page is guarded at the source: the part is there, shows only for an entry that has a pin, carries the words of
 * lib/pinText.ts and the operator's note when there is one, and sits in the Registry entry section between the source note and the
 * explanation of why the page is sparse.
 */
const source = readFileSync(fileURLToPath(new URL("./DirectoryAgent.tsx", import.meta.url)), "utf8");
const start = source.indexOf("{entry.pin && (");
const end = source.indexOf('<Part label="Why this page is sparse">', start);
const part = source.slice(start, end);

describe("the pin on an entry's page", () => {
  it("is found, so the checks below mean something", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(part.length).toBeGreaterThan(150);
  });

  it("shows only for an entry that has a pin, headed and worded as lib/pinText.ts has it", () => {
    expect(part.startsWith("{entry.pin && (")).toBe(true);
    expect(part).toContain("<Part label={PIN_TITLE}>");
    expect(part).toContain("{pinSentence(formatDate(entry.pin.pinnedAt))}");
    expect(source).toContain('import { PIN_TITLE, pinSentence } from "@/lib/pinText";');
  });

  it("shows the operator's note only when there is one", () => {
    expect(part).toContain("{entry.pin.note && <p className={note}>The operator's note: {entry.pin.note}</p>}");
  });

  it("sits after the source note and before the explanation of why the page is sparse", () => {
    expect(source.lastIndexOf('<Part label="Source note">', start)).toBeGreaterThan(0);
    expect(source.indexOf('<Part label="Why this page is sparse">', start)).toBe(end);
  });

  it("is a field of the entry the page reads, null when there is none", () => {
    expect(source).toContain("pin?: { pinnedAt: Date; note: string | null } | null;");
  });
});
