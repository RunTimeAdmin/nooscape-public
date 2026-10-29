import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { B1_DOC, B2_DOC, BNB_REGISTRY_REPORT as report, RECOMPUTED, type Figure } from "@/lib/bnbRegistryReport";
import BnbRegistryReport from "./BnbRegistryReport";

/**
 * The BNB registry census report states numbers that people will quote, so they are held to their sources. The page
 * reads lib/bnbRegistryReport.ts and nothing else; these tests render it, check every number on it is one of that
 * file's figures and every figure is on it, check each figure against the document it names, and keep the page to the
 * rules decided for it: no per-agent rows, no ranking, no score, no tier, no glow, no host or operator named, and the
 * word the decision record rules out kept off it.
 */
const here = import.meta.dirname;
const read = (...parts: string[]) => readFileSync(path.resolve(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const docs = (name: string) => read("..", "..", "..", "docs", name);

const markup = renderToStaticMarkup(createElement(Router, { ssrPath: "/field/bnb-registry-2026-10-16", children: createElement(BnbRegistryReport) }));
const decode = (text: string) => text.replace(/&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pageSource = read("BnbRegistryReport.tsx");
const dataSource = read("..", "lib", "bnbRegistryReport.ts");
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
const n = (value: number) => value.toLocaleString("en-US");

const figures = Object.entries(report).filter((entry): entry is [string, Figure] => typeof entry[1] === "object" && entry[1] !== null && "value" in entry[1] && "source" in entry[1]);

describe("the numbers on the page are the numbers in the data file", () => {
  it("has no number that is not one of the data file's figures, the percentage, or a fixed token", () => {
    const allowed = new Set([...figures.map(([, figure]) => n(figure.value)), String(report.noHttpsAddressPercent)]);
    // Tokens that carry digits and are not figures: the date, the user agent's version, the standard's number, HTTP status classes and the A2A name.
    const withoutTokens = text
      .replace(report.date, " ")
      .replace(report.userAgent, " ")
      .replace(/ERC-8004/g, " ")
      .replace(/\b[2-5]xx\b/g, " ")
      .replace(/\b404\b/g, " ")
      .replace(/\bA2A\b/g, " ");
    const found = (withoutTokens.match(/\d[\d,]*/g) ?? []).map(token => token.replace(/,$/, ""));
    expect(found.length).toBeGreaterThan(20);
    const stray = found.filter(token => !allowed.has(token));
    expect(stray, `numbers on the page that are not in lib/bnbRegistryReport.ts: ${stray.join(", ")}`).toEqual([]);
  });

  it("shows every figure in the data file, so the file holds nothing the page does not say", () => {
    for (const [name, figure] of figures) expect(text, name).toContain(n(figure.value));
    expect(text).toContain(`${report.noHttpsAddressPercent}%`);
  });

  it("writes no figure into the page's own source, which would let it drift from the file", () => {
    const code = stripComments(pageSource);
    // The title's year, the standard's number and the status code the caveat names are text, not figures.
    const literal = (code.match(/\b\d[\d,]{2,}\b/g) ?? []).filter(token => !["2026", "8004", "404"].includes(token));
    expect(literal, "a number written into BnbRegistryReport.tsx").toEqual([]);
  });

  it("carries the date and the finalized block in its header, and the method in plain words", () => {
    expect(text).toContain(`Date ${report.date}`);
    expect(text).toContain(`Finalized block ${n(report.finalizedBlock.value)}`);
    expect(text).toContain("We passed over the registry once, over the registration files twice (the figures below are from the second pass) and over the agent addresses once.");
    expect(report.passes).toEqual({ chain: 1, registrationFiles: 2, agentAddresses: 1 });
    expect(text).toContain("The user agent was Nooscape-Checker/1.0.");
  });

  it("adds up: the funnel and the three outcomes agree with each other", () => {
    expect(report.answered.value + report.notAnswered.value + report.notAsked.value).toBe(report.complete.value);
    expect(report.independent.value - report.filesRead.value).toBe(report.filesUnread.value);
    expect(report.listed.value - report.independent.value).toBe(report.templateEntries.value);
    expect(report.noHttpsAddressPercent).toBe(88);
    expect(report.hostNamesComplete.value).toBe(report.hostNamesIndependents.value);
  });
});

describe("each figure matches the document it names", () => {
  const b1 = docs("bsc-b1-measurement-2026-10-16.md");
  const [original, addendum] = b1.split("\n## Addendum, 2026-10-17");
  const b2 = docs("bsc-clusters-2026-10-16.md");

  it("has the addendum the recomputed figures are listed in, and keeps the original numbers in place", () => {
    expect(addendum, "the dated addendum in the B1 document").toBeDefined();
    expect(original).toMatch(/\| G2, live \(A\) \| Not junk, and an address answered once \| \*\*264\*\* \|/);
    expect(original).toMatch(/\| G2, live, strict \| The same, with a 2xx or 3xx answer from at least one address \| 213 \|/);
    expect(original).toContain("(327 of 645)");
  });

  // Each published figure, as the original document words it, built from the data file's own value so that changing the
  // value there fails here. A figure is checked in the original text only.
  const v = (figure: Figure) => n(figure.value);
  const re = (strings: TemplateStringsArray, ...values: string[]) => new RegExp(String.raw(strings, ...values));
  const PUBLISHED: Record<string, (value: string) => RegExp> = {
    finalizedBlock: value => re`Chain scan to finalized block ${value}`,
    registrations: value => re`\| Recorded \| ${value} \|`,
    listed: value => re`\| \*\*${value}\*\* \|`,
    independent: value => re`\| \*\*${value}\*\* \|`,
    filesRead: value => re`\| G2, read \| Independents whose registration file was read \| ${value} \|`,
    filesUnread: value => re`\*\*The ${value} unread entries\*\*`,
    complete: value => re`\| G2, complete \(D\) \| [^|]+ \| ${value} \|`,
    noHttpsAddress: value => re`Of the ${v(report.filesRead)} read, ${value} \(${String(report.noHttpsAddressPercent)}%\) have no https agent address`,
    otherFieldAddress: value => re`A further ${value} of the ${v(report.noHttpsAddress)} give an https address under a field the standard does not use`,
    templateGroups: value => re`\*\*${value} groups holding ${v(report.templateEntries)} entries\*\*`,
    templateEntries: value => re`\*\*${v(report.templateGroups)} groups holding ${value} entries\*\*`,
    hostNamesIndependents: value => re`${value} independents sit on two hosts`,
    filesFetched: value => re`of the ${value} fetched files changed outcome between the two passes`,
    filesChanged: value => re`${value} of the ${v(report.filesFetched)} fetched files changed outcome between the two passes`,
  };
  // Each recomputed figure, as the addendum's table words it: the old value B1 published, then the new one from the data file.
  const RECOMPUTED_ROWS: Record<string, (value: string) => RegExp> = {
    answered: value => re`\| Answered a request \(G2, live\) \| 264 \| ${value} \|`,
    answeredClean: value => re`\| Answered with a 2xx or 3xx status \| 213 \| ${value} \|`,
    notAnswered: value => re`\| Did not answer \| 143 \| ${value} \|`,
    notAsked: value => re`\| Not asked: [^|]+ \| 238 \| ${value} `,
    a2aAsked: value => re`\| 134 of 264 \| ${value} of ${v(report.answered)} \|`,
    a2aValid: value => re`\| Valid A2A cards among them \| 100 \| ${value} \|`,
    hostNamesComplete: value => re`\| 327 of 645 \| ${value} of ${v(report.complete)} \|`,
  };

  for (const [name, figure] of figures) {
    it(`${name}: ${n(figure.value)}, from ${figure.source}`, () => {
      if (figure.source === B1_DOC) {
        expect(PUBLISHED[name], `${name} has a published sentence to check against`).toBeDefined();
        expect(original).toMatch(PUBLISHED[name]!(n(figure.value)));
      } else if (figure.source === B2_DOC) {
        expect(b2).toContain(`${n(report.workerTemplateGroups.value)} groups, ${n(report.workerTemplateEntries.value)} entries`);
      } else {
        expect(figure.source).toBe(RECOMPUTED);
        expect(RECOMPUTED_ROWS[name], `${name} has an addendum row to check against`).toBeDefined();
        expect(addendum).toMatch(RECOMPUTED_ROWS[name]!(n(figure.value)));
        expect(figure.note, `${name} says what B1 published instead`).toMatch(/B1 publishes/);
      }
    });
  }

  it("says every figure that was recomputed is labelled as such, with the same words as the data file", () => {
    expect(RECOMPUTED).toBe("recomputed from the saved B1 output, junk filter removed");
    for (const name of Object.keys(RECOMPUTED_ROWS)) expect((report as unknown as Record<string, Figure>)[name]!.source, name).toBe(RECOMPUTED);
  });

  it("explains the pairs that look alike and are not the same number", () => {
    expect(report.explanations.hostNames327And328).toContain("They are the same entries");
    expect(report.explanations.templateGroupsAndLights).toContain("150 template groups holding 930 entries");
    expect(report.explanations.templateGroupsAndLights).toContain("141 groups holding 908 entries");
    expect(report.explanations.notAskedAndSkipped).toContain("238");
  });
});

describe("what the page says, and does not", () => {
  it("has the three findings as sentences, with the denominator stated for the first", () => {
    expect(text).toContain(`Of the ${n(report.filesRead.value)} registration files we read, ${n(report.noHttpsAddress.value)} (${report.noHttpsAddressPercent}%) list no https agent address.`);
    expect(text).toContain(`${n(report.templateGroups.value)} template groups hold ${n(report.templateEntries.value)} entries.`);
    expect(text).toContain(`Two host names account for ${n(report.hostNamesComplete.value)} of the ${n(report.complete.value)} complete entries.`);
    expect(text).not.toMatch(/points? at nothing/i);
  });

  it("explains why its group count differs from the worker's, and does not say the map draws that count", () => {
    expect(text).toContain(`On the day of the census, run on the same registry, the clustering step the worker uses (it builds the groups behind the home page’s fleet lights) counted ${n(report.workerTemplateGroups.value)} template groups holding ${n(report.workerTemplateEntries.value)} entries, because it then read only registrations that hold their file inside themselves. This report also read the files behind web and ipfs links. The worker now reads those files too, a few at a time, so its count moves toward this report’s.`);
    // The lights draw the ten largest groups of any kind, so they do not "count" the template groups.
    expect(text).not.toMatch(/fleet lights on the home page count/);
    expect(report.explanations.templateGroupsAndLights).toContain("draw only the ten largest groups of any kind");
  });

  it("labels the note on the independent count, and says the count is probably too high", () => {
    expect(text).toContain(`Note on the independent count. ${n(report.hostNamesIndependents.value)} of the ${n(report.independent.value)} independent entries sit on two host names that no rule groups together, so the independent count is probably too high.`);
  });

  it("says the agent-card figure covers only the entries that answered and is not registry-wide", () => {
    expect(text).toContain(`Of the ${n(report.answered.value)} entries that answered, ${n(report.a2aAsked.value)} declare an A2A service.`);
    expect(text).toContain("This covers only the entries that answered. It is not a registry-wide figure.");
  });

  it("has a section called What this does not show, with the caveats the measurement gave", () => {
    expect(text).toContain("What this does not show");
    for (const caveat of [
      "It is not proof that an agent is alive. We sent only a plain GET, once to each address.",
      "Hosting platforms often answer 404 for an app that is gone, so a 404 is a weak sign of life, and it is not proof either way.",
      "It is not a count of independent people.",
      `${n(report.filesUnread.value)} registration files could not be read, so they could not be grouped and are counted as independent.`,
      "Names, descriptions and addresses are written by whoever registered the agent. We have not verified them.",
      `${n(report.filesChanged.value)} of the ${n(report.filesFetched.value)} registration files we fetched changed outcome between the two passes`,
    ]) {
      expect(text).toContain(caveat);
    }
  });

  it("ends by linking /checker and saying the census is a snapshot to be redone and dated again", () => {
    expect(markup).toContain('href="/checker"');
    expect(text).toContain("This census is a snapshot. It will be redone and dated again.");
    expect(text.indexOf("This census is a snapshot")).toBeGreaterThan(text.indexOf("What this does not show"));
  });

  it("keeps the word the decision record rules out off the page, in everything the page shows or says", () => {
    for (const where of [text, markup, pageSource]) expect(where).not.toMatch(/\bjunk\b/i);
    // The data file says, in the label of each recomputed figure and in notes the page never shows, that the filter was
    // removed. That is the one place the word may be, and none of those strings is on the page.
    expect(RECOMPUTED).toContain("junk filter removed");
    for (const [, figure] of figures) if (figure.note && /junk/i.test(figure.note)) expect(text).not.toContain(figure.note);
    for (const explanation of Object.values(report.explanations)) expect(text).not.toContain(explanation);
  });

  it("names no host and no operator, and lists no agent", () => {
    for (const where of [text, markup, pageSource, dataSource]) expect(where).not.toMatch(/singularry|example-agent/i);
    expect(text).not.toMatch(/\boperators?\b/i);
    expect(markup).not.toMatch(/href="\/agents\//);
    expect(markup).not.toMatch(/0x[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
    // Links only: React also writes a preload hint for the logo image.
    const hrefs = [...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map(match => match[1]);
    expect(hrefs.filter(href => !["/", "/checker", "/disputes", "/privacy", "/terms", "/contact", "/about"].includes(href!))).toEqual([]);
  });

  it("has no score, no ranking, no tier and no best or top, and no glow", () => {
    expect(text).not.toMatch(/\bscores?\b|\brank\w*|\bleaderboard\b|\bbest\b|\btop\b|\btiers?\b|\bleading\b|\bwinners?\b/i);
    expect(markup).not.toMatch(/glow|shadow|pulse|animate-|gradient|blur/i);
    // The only light on it is the home page's fleet lights, named once, in the sentence that explains the difference in counts.
    expect([...text.matchAll(/\blights?\b/gi)].length).toBe(1);
    expect(text).toContain("fleet lights");
  });

  it("uses no long dash", () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const where of [text, pageSource, dataSource]) expect(where).not.toMatch(dashes);
  });
});

describe("the address", () => {
  it("is a route the app draws, the server answers 200 for, and the sitemap lists", () => {
    const app = read("..", "App.tsx");
    expect(app).toContain('<Route path="/field/bnb-registry-2026-10-16" component={BnbRegistryReport} />');
    expect(read("..", "..", "..", "server", "clientRoutes.ts")).toContain('"/field/bnb-registry-2026-10-16"');
    expect(read("..", "..", "public", "sitemap.xml")).toContain("<loc>https://nooscape.si/field/bnb-registry-2026-10-16</loc>");
  });
});
