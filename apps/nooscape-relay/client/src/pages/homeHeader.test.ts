import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRIMARY_LINKS } from "@/components/home/headerModel";

/**
 * The Home header must never be wider than the screen. At 1440 px the old header's last button ran 73 px off the right
 * edge, and on a phone it was off the screen entirely: nine labelled controls and three status chips on one row needed
 * about 1,530 px. The old header was replaced by the SiteHeader, a bar of the brand, a few links, one button and a menu,
 * with a sheet in place of the menu on a phone. This file replaces the test that guarded the old header and keeps what
 * still matters of it: that the header fits every width, that there is always a way out of focus mode, and that the Owl
 * guide switch can always be reached. siteHeader.test.ts guards the bar's own parts; a browser would be needed to test
 * the layout itself, so this reads the source.
 */
const home = readFileSync(new URL("./Home.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const header = readFileSync(new URL("../components/home/SiteHeader.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const toggle = readFileSync(new URL("../components/owl/OwlToggle.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = readFileSync(new URL("../index.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("the Home header", () => {
  it("is the one SiteHeader, and the old row of nine controls and three chips is gone", () => {
    expect(home.match(/<SiteHeader\b/g)).toHaveLength(1);
    expect(home).not.toContain('<header className="@container ');
    expect(home).not.toContain("header-status");
    expect(header.match(/<header\b/g)).toHaveLength(1);
  });

  it("fits any width: the brand's words leave a phone's bar, and the links and the menu appear only from lg, the sheet's button only below it", () => {
    expect(header).toContain("max-[429px]:sr-only");
    expect(header).toMatch(/<nav aria-label="Primary" className="[^"]*\bhidden\b[^"]*\blg:flex\b/);
    expect(header).toMatch(/<Button variant="ghost" className="hidden [^"]*\blg:inline-flex\b/);
    expect(header).toMatch(/aria-label="Open menu" className="[^"]*\blg:hidden\b/);
  });

  it("keeps the bar short enough to fit: a few links, one button, a menu, and a label hidden by a width only for the brand's strapline", () => {
    expect(PRIMARY_LINKS.length).toBeLessThanOrEqual(4);
    expect(header).not.toMatch(/hidden (?:sm|md|xl|2xl):inline/);
    expect(header).toContain('<span className="mt-0.5 hidden font-mono text-xs');
  });

  it("keeps the way out of focus mode usable while the rest of the header is dimmed", () => {
    const dim = css.split("\n").find(line => line.startsWith(".signal-focused .site-header-inner"));
    expect(dim).toBeDefined();
    // The actions row is not dimmed as a whole (it holds the way out); each control in it is, except the toggle.
    expect(dim).toContain(".site-header-inner > :not(.header-actions)");
    expect(dim).toContain(".header-actions > :not([data-focus-toggle])");
    expect(header).toContain("data-focus-toggle");
    expect(header).toContain("aria-pressed={focused}");
    expect(header).toContain("Exit focus");
  });

  it("leaves focus mode on Escape as well", () => {
    const escape = home.slice(home.indexOf('event.key === "Escape"'), home.indexOf('window.addEventListener("keydown", handleShortcut)'));
    expect(escape).toContain("setFocused(false)");
  });

  it("carries the Owl guide switch at every width: a checkbox in the menu on a wide screen, the switch in the sheet on a phone", () => {
    expect(header).toMatch(/<DropdownMenuCheckboxItem checked=\{owlOn\} onCheckedChange=\{setOwlOn\}[^>]*>\s*Owl guide/);
    expect(header).toContain("<OwlToggle />");
    expect(toggle).not.toMatch(/hidden (?:sm|md|lg|xl|2xl):inline/);
    expect(toggle).toContain("<span>Owl guide</span>");
    expect(toggle).toContain('aria-label="Owl guide"');
  });
});
