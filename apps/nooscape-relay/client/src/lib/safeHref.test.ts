import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { safeHttpsHref } from "./safeHref";

describe("safeHttpsHref", () => {
  it("passes an https address, normalized, whatever its case or padding", () => {
    expect(safeHttpsHref("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(safeHttpsHref("  HTTPS://Example.COM/x  ")).toBe("https://example.com/x");
  });

  it("refuses every other scheme", () => {
    for (const value of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "http://example.com", "ftp://example.com", "file:///etc/passwd", "vbscript:x", "blob:https://example.com/x", "mailto:a@example.com"]) {
      expect(safeHttpsHref(value), value).toBeNull();
    }
  });

  it("refuses an address with credentials in it", () => {
    expect(safeHttpsHref("https://user:pass@example.com")).toBeNull();
    expect(safeHttpsHref("https://user@example.com")).toBeNull();
  });

  it("refuses a relative address, a protocol-relative one, an empty one and garbage", () => {
    for (const value of ["/path", "//example.com", "", "   ", "not a url", "https://", "https://exa mple.com"]) {
      expect(safeHttpsHref(value), value).toBeNull();
    }
  });

  it("refuses what is not a string", () => {
    for (const value of [null, undefined, 42, {}, ["https://example.com"]]) expect(safeHttpsHref(value)).toBeNull();
  });
});

describe("the pages that show a stored locator", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("link to it only through safeHttpsHref", () => {
    for (const file of ["../pages/home/DeepSpace.tsx", "../pages/EcosystemContext.tsx"]) {
      const source = read(file);
      expect(source, file).toContain("safeHttpsHref(");
      const lines = source.split("\n").filter(line => /href=\{[^}]*locator/i.test(line));
      expect(lines, `${file} links to a raw locator`).toEqual([]);
    }
  });
});
