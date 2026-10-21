import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Owl's Catch card and its pages, as the briefs make rules of them: the server's words shown as they are, a
 * share link that is only a link, a disclosure that starts closed, a state for a day with no catch, nothing that
 * moves, and the place it sits. The repo has no browser test runner, so these read the source; a run in a real
 * browser checked the layout, the states, the links, the keyboard and the owl.
 */
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const card = read("./OwlsCatch.tsx");
const page = read("../../pages/Catch.tsx");
const evidence = read("../../pages/home/LandingEvidence.tsx");
const css = read("../../index.css");
const app = read("../../App.tsx");
const sitemap = read("../../../public/sitemap.xml");
const count = (text: string, mark: string) => (text.match(new RegExp(mark, "g")) ?? []).length;

describe("the card", () => {
  it("shows the headline, the detail and the how-we-know text the server built, and writes no figure of its own", () => {
    for (const field of ["view.headline", "view.detail", "view.howWeKnow"]) expect(card, field).toContain(`{${field}}`);
    expect(card).not.toContain("dangerouslySetInnerHTML");
    expect(card).not.toMatch(/toLocaleString|toFixed|Math\./);
  });

  it("starts a post on X with a plain link that opens a new tab and hands the page nothing", () => {
    expect(card).toContain("href={shareHref(view)}");
    expect(card).toContain('target="_blank"');
    expect(card).toContain('rel="noopener noreferrer"');
    expect(card).toContain("Share on X");
    expect(card).toContain("(opens in a new tab)");
    expect(card).not.toMatch(/<a[^>]*onClick/);
    expect(card).not.toMatch(/window\.open|<script/);
  });

  it("holds how we know in a disclosure that starts closed", () => {
    expect(card).toMatch(/<details data-owl-avoid="" className="catch-know [^"]*">/);
    expect(card).not.toMatch(/<details[^>]*\bopen\b/);
    expect(card).toContain(">How we know</summary>");
  });

  it("says what is true when there is no catch, offers the newest that was found, and never shows an example", () => {
    expect(card).toContain("QUIET_COPY[state.reason].title");
    expect(card).toContain("QUIET_COPY[state.reason].detail");
    expect(card).toContain("{state.latest && <Newest view={state.latest} />}");
    expect(card).toContain("Newest catch, {dateLabel(view.date)}");
    expect(card.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/example|sample|placeholder|lorem/i);
  });

  it("links the list of every catch whatever the state, and the identities it names by their pages", () => {
    expect(card.match(/All catches/g)).toHaveLength(2);
    expect(card).toContain("href={agentPath(agent.id)}");
    expect(card).toContain("{agent.name}");
  });

  it("is still: nothing in it moves or fades", () => {
    expect(card).not.toMatch(/animate|transition|motion|setInterval|requestAnimationFrame/i);
    expect(css.match(/\.catch-card \{[^}]*\}/)?.[0] ?? "").not.toMatch(/animation|transition/);
  });

  it("marks its text, its disclosure and its links for the owl to keep clear of", () => {
    expect(count(card, "data-owl-avoid")).toBeGreaterThanOrEqual(10);
    expect(count(page, "data-owl-avoid")).toBeGreaterThanOrEqual(8);
  });

  it("is a section named by its heading, with tap targets of 44 pixels on its two links", () => {
    expect(card).toContain('<section aria-labelledby="owls-catch-heading"');
    expect(card).toContain('<h2 id="owls-catch-heading"');
    expect(count(card, "min-h-11")).toBeGreaterThanOrEqual(3);
  });

  it("says in one sentence what it is, and that it is a count and never a score", () => {
    expect(card).toContain("One find a day, picked by a fixed rule and not by hand; a count, never a score.");
  });
});

describe("where it sits", () => {
  it("is beside the field reports, in a row that stretches both to the same height, and after them", () => {
    expect(evidence).toContain('<div className="grid grid-cols-1 items-stretch gap-5 lg:grid-cols-[1.1fr_.9fr]">\n        <FieldNotes />\n        <OwlsCatch />\n      </div>');
    expect(card).toContain('className="catch-card flex h-full flex-col rounded-2xl p-5"');
  });

  it("is a card on the dusk with an amber top edge, so it reads as the day's one find beside the log", () => {
    const rule = css.match(/\.catch-card \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("background-color: var(--ns-dusk)");
    expect(rule).toContain("inset 0 3px 0 color-mix(in oklab, var(--ns-amber)");
  });

  it("is in the header's menu and the sitemap", () => {
    expect(read("./headerModel.ts")).toContain('{ label: "The Owl\'s Catch", href: "/catch" },');
    expect(sitemap).toContain("<loc>https://nooscape.si/catch</loc>");
  });
});

describe("the pages", () => {
  it("are routes at /catch and /catch/:date, both the one lazy page so going between them does not flash the skeleton, and keyed by the day so no state is carried from one day to the next", () => {
    expect(app).toContain('const Catch = lazy(() => import("./pages/Catch"));');
    expect(app).toContain('<Route path="/catch">{() => <Catch />}</Route>');
    expect(app).toContain('<Route path="/catch/:date">{params => <Catch date={params.date} />}</Route>');
    expect(app.match(/import\("\.\/pages\/Catch"\)/g)).toHaveLength(1);
    expect(page).toContain("export default function CatchPage({ date }: { date?: string }) {");
    expect(page).toContain("return date === undefined ? <CatchArchive /> : <CatchDay key={date} date={date} />;");
  });

  it("set the tab's title while they are open and put the old one back", () => {
    expect(page).toContain("document.title = title;");
    expect(page).toMatch(/return \(\) => \{\n\s+document\.title = before;/);
    expect(page).toContain("usePageTitle(valid ? dayTitle(date) : ARCHIVE_TITLE);");
  });

  it("do not ask the server for something that is not a date", () => {
    expect(page).toContain("{ enabled: valid,");
    expect(page).toContain("const valid = isCatchDate(date);");
    expect(page).toContain('"That is not a date"');
  });

  it("list the newest thirty catches and offer up to a hundred, and say that a day with no catch is not listed", () => {
    expect(page).toContain("const FIRST_PAGE = 30;");
    expect(page).toContain("const MOST = 100;");
    expect(page).toContain("A day with no catch is not listed.");
    // The way to more shows only while there may be more to show, and asks for the most.
    expect(page).toContain("{limit < MOST && catches.length >= limit && (");
    expect(page).toContain("onClick={() => setLimit(MOST)}");
  });

  it("say what is true when the read fails or there is nothing yet, and show nothing in its place", () => {
    expect(page).toContain("The catches cannot be read right now. Nothing is shown in their place.");
    expect(page).toContain("No catch has been chosen yet.");
    expect(page).toContain("The catch cannot be read right now. Nothing is shown in its place.");
  });
});
