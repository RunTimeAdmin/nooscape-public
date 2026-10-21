import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Home header used to be nine controls and three status chips on one row that needed about
 * 1,530 px and ran off the screen. It is now the brand, three links, one button and a menu, with a
 * sheet in place of the menu on a phone. The repo has no browser test runner, so these guard the
 * parts that hold that: what is in the bar, how it sticks, how it is reached, and the way out of
 * focus mode, which a dimming rule once made unreachable.
 */
const header = readFileSync(new URL("./SiteHeader.tsx", import.meta.url), "utf8");
const home = readFileSync(new URL("../../pages/Home.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
const owlToggle = readFileSync(new URL("../owl/OwlToggle.tsx", import.meta.url), "utf8");

describe("the bar", () => {
  it("has one filled primary button, and it says what it does", () => {
    expect(header.match(/Ask the Owl/g)).toHaveLength(1);
    const button = header.slice(header.indexOf("onClick={onAskTheOwl}"), header.indexOf("Ask the Owl"));
    // The fill itself, not the hover state that happens to repeat it.
    expect(button).toMatch(/\sbg-ns-radar\s/);
  });

  it("shows the links and the menu from the lg breakpoint, and a sheet button below it", () => {
    expect(header).toMatch(/<nav aria-label="Primary" className="[^"]*\bhidden\b[^"]*\blg:flex\b/);
    expect(header).toMatch(/<Button variant="ghost" className="hidden [^"]*\blg:inline-flex\b/);
    expect(header).toMatch(/aria-label="Open menu" className="[^"]*\blg:hidden\b/);
  });

  it("names the icon-only menu button", () => {
    expect(header).toContain('aria-label="Open menu"');
  });

  it("makes every control at least 44px tall", () => {
    for (const element of header.match(/<Button\b[^>]*>/g) ?? []) expect(element, element.slice(0, 60)).toMatch(/\bh-11\b/);
    expect(header).toMatch(/<a href="#top" className="[^"]*\bmin-h-11\b[^"]*\bmin-w-11\b/);
    expect(header).toMatch(/const NAV_LINK = "[^"]*\bmin-h-11\b/);
    expect(header).toMatch(/const ROW = "[^"]*\bmin-h-11\b/);
    for (const item of header.match(/<DropdownMenu(?:Item|CheckboxItem)\b[^>]*>/g) ?? []) expect(item, item.slice(0, 60)).toMatch(/\bmin-h-11\b/);
  });
});

describe("sticking to the top", () => {
  it("sticks, and takes a glass background once the page has scrolled", () => {
    expect(header).toContain("sticky top-0");
    expect(header).toContain("data-[scrolled]:bg-[color-mix(in_oklab,var(--ns-void)_72%,transparent)]");
    expect(header).toContain("data-[scrolled]:backdrop-blur-xl");
    expect(header).toContain("isScrolled(window.scrollY)");
  });

  it("animates only its background and shadow, never its size", () => {
    expect(header).toContain("transition-[background-color,box-shadow]");
  });

  it("sits in a shell that clips sideways overflow without becoming a scroll container, which would stop it sticking", () => {
    expect(home).toContain("nooscape-shell min-h-screen overflow-x-clip");
    expect(home).not.toContain("nooscape-shell min-h-screen overflow-x-hidden");
  });

  it("leaves room under it for whatever an in-page link scrolls to", () => {
    expect(css).toMatch(/\[id\$="-heading"\] \{ scroll-margin-top: 6rem; \}/);
  });
});

describe("the menu and the sheet", () => {
  it("carry the same destinations: the page links, the sections, the deep map and the owl switch", () => {
    for (const container of [header.slice(header.indexOf("<DropdownMenuContent"), header.indexOf("</DropdownMenuContent>")), header.slice(header.indexOf("<SheetContent"), header.indexOf("</SheetContent>"))]) {
      expect(container).toContain("PAGE_LINKS.map");
      expect(container).toContain("MORE_ANCHORS");
      expect(container).toContain("Deep map");
      expect(container).toContain("<StatusRows");
    }
    expect(header).toMatch(/<DropdownMenuCheckboxItem checked=\{owlOn\} onCheckedChange=\{setOwlOn\}/);
    expect(header).toContain("<OwlToggle />");
  });

  it("gives the sheet a title and a description, which the dialog needs to be announced", () => {
    expect(header).toContain("<SheetTitle");
    expect(header).toContain("<SheetDescription");
  });

  it("puts the status chips' words in the menu, and the old chips are gone", () => {
    expect(header).toContain("function StatusRows");
    expect(home).not.toContain("StatusChip");
    expect(home).not.toContain("header-status");
  });

  it("keeps the owl switch labelled in the sheet, as the row's own text and as the switch's name", () => {
    expect(owlToggle).toContain('aria-label="Owl guide"');
    expect(owlToggle).toContain("<span>Owl guide</span>");
    expect(owlToggle).toContain("setEnabled");
  });
});

describe("the way out of focus mode", () => {
  it("keeps an Exit focus button in the bar while focus mode is on, and marks it as the one thing not dimmed", () => {
    expect(header).toMatch(/\{focused && \(\s*<Button\s+data-focus-toggle\s+onClick=\{onToggleFocus\}\s+aria-pressed=\{focused\}/);
    expect(header).toContain("Exit focus");
    expect(css).toContain(".signal-focused .site-header-inner > :not(.header-actions)");
    expect(css).toContain(".signal-focused .header-actions > :not([data-focus-toggle])");
  });

  it("offers Focus field in the menu only while it is off", () => {
    expect(header.match(/\{!focused && /g)).toHaveLength(2);
  });

  it("leaves focus mode on Escape as well", () => {
    const escape = home.slice(home.indexOf('event.key === "Escape"'), home.indexOf('window.addEventListener("keydown", handleShortcut)'));
    expect(escape).toContain("setFocused(false)");
  });
});

describe("the old header's styles", () => {
  it("are gone", () => {
    expect(css).not.toContain(".verification-nav-link");
    expect(home).not.toContain("verification-nav-link");
    expect(home).not.toMatch(/@min-\[\d+px\]:inline/);
  });
});

describe("what sits above and below the menus", () => {
  const sheet = readFileSync(new URL("../ui/sheet.tsx", import.meta.url), "utf8");

  it("keeps the owl under the menu and the sheet, which are controls, so it never covers them", () => {
    const owl = Number(/\.owl-companion \{[^}]*z-index: (\d+)/.exec(css)?.[1]);
    const overlay = Number(/fixed z-(\d+) flex flex-col/.exec(sheet)?.[1]);
    expect(owl).toBeGreaterThan(0);
    expect(overlay).toBeGreaterThan(owl);
  });

  it("makes the sheet's close button a 44px target", () => {
    expect(sheet).toMatch(/<SheetPrimitive\.Close className="[^"]*\bsize-11\b/);
  });

  it("draws the page's grain and glow as pseudo-elements behind the content, not as fixed layers in the element stack", () => {
    expect(css).toMatch(/\.nooscape-shell::before, \.nooscape-shell::after \{[^}]*position: fixed;[^}]*z-index: -1;[^}]*pointer-events: none;/);
    expect(css).toContain(".shell-deep-open::before, .shell-deep-open::after { visibility: hidden; }");
    expect(home).not.toContain("aurora-veil");
    expect(home).not.toContain("nooscape-noise");
  });
});
