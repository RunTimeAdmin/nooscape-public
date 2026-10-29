import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { ADDENDUM, BNB_RATINGS_REPORT as report, RATERS_DOC, RULES, type Figure } from "@/lib/bnbRatingsReport";
import { CONCENTRATED_MIN_AGENTS, MIN_INDEPENDENT_RATERS, OWNER_FLEET_MIN, UNIFORM_MIN_EVENTS, UNIFORM_MIN_SHARE } from "../../../server/bscRaters";
import BnbRatingsReport from "./BnbRatingsReport";

/**
 * The BNB rating report states numbers that people will quote, so they are held to their sources. The page reads
 * lib/bnbRatingsReport.ts and nothing else; these tests render it, check every number on it is one of that file's figures
 * and every figure is on it, check each figure against the document or the code it names, and keep the page to the rules
 * decided for the census report: no per-agent rows, no wallet or host named, no ranking, no score, no tier, no glow, and no
 * word that reads as a verdict on an agent.
 */
const here = import.meta.dirname;
const read = (...parts: string[]) => readFileSync(path.resolve(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const docs = (name: string) => read("..", "..", "..", "docs", name);

const markup = renderToStaticMarkup(createElement(Router, { ssrPath: "/field/bnb-ratings-2026-10-16", children: createElement(BnbRatingsReport) }));
const decode = (text: string) => text.replace(/&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pageSource = read("BnbRatingsReport.tsx");
const dataSource = read("..", "lib", "bnbRatingsReport.ts");
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
const n = (value: number) => value.toLocaleString("en-US");

const isFigure = (value: unknown): value is Figure => typeof value === "object" && value !== null && "value" in value && "source" in value;
const topLevel = Object.entries(report).filter((entry): entry is [string, Figure] => isFigure(entry[1]));
const rules = Object.entries(report.rules) as Array<[string, Figure]>;
const figures = [...topLevel, ...rules];

describe("the numbers on the page are the numbers in the data file", () => {
  it("has no number that is not one of the data file's figures or a fixed token", () => {
    const allowed = new Set(figures.map(([, figure]) => n(figure.value)));
    // Tokens that carry digits and are not figures: the date and the standard's number.
    const withoutTokens = text.replace(report.date, " ").replace(/ERC-8004/g, " ");
    const found = (withoutTokens.match(/\d[\d,]*/g) ?? []).map(token => token.replace(/,$/, ""));
    expect(found.length).toBeGreaterThan(30);
    const stray = found.filter(token => !allowed.has(token));
    expect(stray, `numbers on the page that are not in lib/bnbRatingsReport.ts: ${stray.join(", ")}`).toEqual([]);
  });

  it("shows every figure in the data file, so the file holds nothing the page does not say", () => {
    for (const [name, figure] of figures) expect(text, name).toContain(n(figure.value));
  });

  it("writes no figure into the page's own source, which would let it drift from the file", () => {
    const literal = (stripComments(pageSource).match(/\b\d[\d,]{2,}\b/g) ?? []).filter(token => !["2026", "8004"].includes(token));
    expect(literal, "a number written into BnbRatingsReport.tsx").toEqual([]);
  });

  it("carries the date and the finalized block in its header, and says the read used the chain only", () => {
    expect(text).toContain(`Date ${report.date}`);
    expect(text).toContain(`Finalized block ${n(report.finalizedBlock.value)}`);
    expect(text).toContain("This read used the chain and nothing else, passed over it once, and asked no agent and no website anything.");
  });

  it("adds up", () => {
    expect(report.events.value).toBe(report.ratingsSent.value + report.revocations.value);
    expect(report.ratingsStand.value).toBe(report.ratingsSent.value - report.revocations.value);
    expect(report.raters.value).toBeLessThanOrEqual(report.senders.value);
    expect(report.concentratedRatings.value).toBeLessThan(report.ratingsStand.value);
    expect(report.ratedValueFromConcentrated.value).toBeLessThanOrEqual(report.ratedValueRatings.value);
    expect(report.ratedValuePercent.value).toBe(Math.round((report.ratedValueRatings.value / report.ratingsStand.value) * 100));
    expect(report.agentsRated.value).toBeGreaterThan(report.threeOrMoreWallets.value);
    expect(report.threeOrMoreWallets.value).toBeGreaterThan(report.registeredByFewerThanFleetWallets.value);
    expect(report.afterEveryRule.value).toBeLessThanOrEqual(report.threeOrMoreOutsideConcentrated.value);
    expect(report.concentratedAgentsFewest.value).toBeGreaterThan(report.nextBusiestAgents.value);
    expect(report.concentratedAgentsFewest.value).toBeGreaterThanOrEqual(report.rules.concentratedMinAgents.value);
    // Four of the nine share one set of raters, so the nine come from six groups.
    expect(report.groupsOfRaters.value).toBe(report.afterEveryRule.value - report.sharedSetAgents.value + 1);
  });
});

describe("each figure matches the document or the code it names", () => {
  const rater = docs("bsc-rater-credibility-2026-10-16.md");
  const [body, addendumText] = rater.split("\n## Addendum, 2026-10-17");
  const v = (figure: Figure) => n(figure.value);
  const re = (strings: TemplateStringsArray, ...values: string[]) => new RegExp(String.raw(strings, ...values));

  it("has the addendum the extra figures are listed in", () => {
    expect(addendumText, "the dated addendum in the rater document").toBeDefined();
    expect(body).toMatch(/\| Events \| 29,995: 29,994 ratings and 1 revocation,/);
  });

  // Each figure from the document's own tables, as the document words it, built from the data file's value so that changing
  // the value there fails here.
  const PUBLISHED: Record<string, RegExp> = {
    events: re`\| Events \| ${v(report.events)}: `,
    ratingsSent: re`: ${v(report.ratingsSent)} ratings and ${v(report.revocations)} revocation`,
    revocations: re`ratings and ${v(report.revocations)} revocation`,
    ratingsStand: re`\| Ratings that stand \| ${v(report.ratingsStand)} \|`,
    senders: re`\(${v(report.senders)} sent one\)`,
    raters: re`\| Raters \| ${v(report.raters)} wallets with a rating that stands`,
    agentsRated: re`\| Agents rated \| ${v(report.agentsRated)} \|`,
    concentratedWallets: re`\| Rated ${v(report.rules.concentratedMinAgents)} agents or more \| ${v(report.concentratedWallets)} wallets, `,
    concentratedRatings: re`wallets, ${v(report.concentratedRatings)} ratings \(98\.5%\), `,
    concentratedAgentsFewest: re`ratings \(98\.5%\), ${v(report.concentratedAgentsFewest)} to ${v(report.concentratedAgentsMost)} agents each`,
    concentratedAgentsMost: re`, ${v(report.concentratedAgentsFewest)} to ${v(report.concentratedAgentsMost)} agents each`,
    nextBusiestAgents: re`the next wallet rated ${v(report.nextBusiestAgents)} \|`,
    ratedValue: re`\| Value exactly ${v(report.ratedValue)} \|`,
    ratedValuePercent: re`\| Value exactly ${v(report.ratedValue)} \| ${v(report.ratedValuePercent)}% of the ratings`,
    selfRatings: re`\| A wallet rating its own agent \| ${v(report.selfRatings)} \|`,
    sendersAlsoRegistered: re`\| Wallets that also registered an agent \| ${v(report.sendersAlsoRegistered)} of the ${v(report.senders)} that sent a rating \|`,
    largestOwnerPercent: re`\| The owner that received the most \| ${v(report.largestOwnerPercent)}% of the ratings`,
    threeOrMoreWallets: re`\| Three raters or more \(the raw upper bound\) \| ${v(report.threeOrMoreWallets)} \|`,
    registeredByFewerThanFleetWallets: re`\| The same, less the agents whose owner is a fleet wallet \| ${v(report.registeredByFewerThanFleetWallets)} \|`,
    threeOrMoreOutsideConcentrated: re`\| Three raters or more outside the concentrated wallets \| ${v(report.threeOrMoreOutsideConcentrated)} \|`,
    afterEveryRule: re`\| \*\*Qualify\*\* \([^|]+\) \| \*\*${v(report.afterEveryRule)}\*\* \|`,
  };
  // The figures the addendum lists.
  const LISTED: Record<string, RegExp> = {
    finalizedBlock: re`\| Finalized block the read stopped at \| ${v(report.finalizedBlock)} \|`,
    ratedValueRatings: re`\| Ratings with the value ${v(report.ratedValue)} \| ${v(report.ratedValueRatings)} \|`,
    ratedValueFromConcentrated: re`\| Of those, from the ${v(report.concentratedWallets)} concentrated wallets \| ${v(report.ratedValueFromConcentrated)} \|`,
    sharedSetAgents: re`\| Agents among the nine that share a set of raters \| ${v(report.sharedSetAgents)} \|`,
    sharedSetWallets: re`\| Wallets in that shared set \| ${v(report.sharedSetWallets)} \|`,
    groupsOfRaters: re`\| The nine, counted as groups of raters \| ${v(report.groupsOfRaters)} \|`,
  };
  // The bars, from the code.
  const BARS: Record<string, number> = {
    concentratedMinAgents: CONCENTRATED_MIN_AGENTS,
    uniformMinRatings: UNIFORM_MIN_EVENTS,
    uniformMinSharePercent: Math.round(UNIFORM_MIN_SHARE * 100),
    fleetWalletMin: OWNER_FLEET_MIN,
    minWallets: MIN_INDEPENDENT_RATERS,
  };

  for (const [name, figure] of topLevel) {
    it(`${name}: ${n(figure.value)}, from ${figure.source}`, () => {
      if (figure.source === RATERS_DOC) {
        expect(PUBLISHED[name], `${name} has a sentence in the document to check against`).toBeDefined();
        expect(body).toMatch(PUBLISHED[name]!);
      } else {
        expect(figure.source).toBe(ADDENDUM);
        expect(LISTED[name], `${name} has an addendum row to check against`).toBeDefined();
        expect(addendumText).toMatch(LISTED[name]!);
      }
    });
  }

  for (const [name, figure] of rules) {
    it(`rule ${name}: ${n(figure.value)}, from the code`, () => {
      expect(figure.source).toBe(RULES);
      expect(BARS[name], `${name} has a constant in server/bscRaters.ts`).toBeDefined();
      expect(figure.value).toBe(BARS[name]);
    });
  }

  it("says nothing in the data file but figures, the sources and the date", () => {
    expect(Object.keys(report).sort()).toEqual([...topLevel.map(([name]) => name), "date", "rules"].sort());
  });
});

describe("what the page says, and does not", () => {
  it("has the four findings as sentences, with the denominators stated", () => {
    expect(text).toContain(`${n(report.concentratedWallets.value)} wallets sent almost every rating.`);
    expect(text).toContain(`together they sent ${n(report.concentratedRatings.value)} of the ${n(report.ratingsStand.value)} ratings that stand.`);
    expect(text).toContain(`${n(report.ratedValueRatings.value)} ratings (${n(report.ratedValuePercent.value)}%) carry the value ${n(report.ratedValue.value)}, and ${n(report.ratedValueFromConcentrated.value)} of them were sent by the concentrated wallets.`);
    expect(text).toContain(`No wallet rated an agent that it registered itself: ${n(report.selfRatings.value)} of the ${n(report.ratingsStand.value)} ratings.`);
    expect(text).toContain(`The agents registered by one wallet received ${n(report.largestOwnerPercent.value)}% of all the ratings.`);
  });

  it("says the nine are six groups of raters, and does not merge them", () => {
    expect(text).toContain(`${n(report.sharedSetAgents.value)} of them are consecutive agents that were rated by the same ${n(report.sharedSetWallets.value)} wallets, so the ${n(report.afterEveryRule.value)} come from ${n(report.groupsOfRaters.value)} groups of raters.`);
    expect(text).toContain("This page counts agents and does not merge those groups.");
  });

  it("states the three rules in plain words, with the bars from the data file", () => {
    expect(text).toContain(`A concentrated wallet: it rated ${n(report.rules.concentratedMinAgents.value)} or more different agents.`);
    expect(text).toContain(`${n(report.rules.uniformMinSharePercent.value)}% or more of them carrying one identical value`);
    expect(text).toContain(`a wallet that registered ${n(report.rules.fleetWalletMin.value)} agents or more`);
  });

  it("has a section called What this does not show, with the caveats of the read", () => {
    expect(text).toContain("What this does not show");
    for (const caveat of [
      "It is not a verdict on any agent.",
      "says nothing about whether an agent works or is any good, and being rated by fewer says nothing either.",
      "It counts wallets, not people.",
      "The ties are approximations.",
      "The value of a rating is whatever the sender chose. We have not checked it and never use it as a measure of quality.",
      "The figures are a moment in time.",
      "It covers the ratings on this one registry.",
    ]) {
      expect(text).toContain(caveat);
    }
  });

  it("ends by linking the census report and saying the report is a snapshot of one date", () => {
    expect(markup).toContain('href="/field/bnb-registry-2026-10-16"');
    expect(text).toContain("This report is a snapshot of one date.");
    expect(text.indexOf("This report is a snapshot")).toBeGreaterThan(text.indexOf("What this does not show"));
  });

  it("names no wallet, host or operator, and lists no agent", () => {
    for (const where of [text, markup, pageSource, dataSource]) expect(where).not.toMatch(/marque|singularry|example-agent/i);
    expect(text).not.toMatch(/\boperators?\b/i);
    expect(markup).not.toMatch(/href="\/agents\//);
    expect(markup).not.toMatch(/0x[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
    // Links only: React also writes a preload hint for the logo image.
    const hrefs = [...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map(match => match[1]);
    expect(hrefs.filter(href => !["/", "/field/bnb-registry-2026-10-16", "/checker", "/disputes", "/privacy", "/terms", "/contact", "/about"].includes(href!))).toEqual([]);
  });

  it("has no score, no ranking, no tier, no best or top, no glow, and no word that reads as a verdict on an agent", () => {
    expect(text).not.toMatch(/\bscores?\b|\brank\w*|\bleaderboard\b|\bbest\b|\btop\b|\btiers?\b|\bleading\b|\bwinners?\b/i);
    expect(text).not.toMatch(/\bqualif\w*|\bindependent\b|\bfake\b|\bscams?\b|\bbots?\b|\bmanipulat\w*|\binflat\w*|\bsybil\b|\btrust\w*|\breliab\w*|\bhonest\b/i);
    expect(markup).not.toMatch(/glow|shadow|pulse|animate-|gradient|blur/i);
  });

  it("uses no long dash", () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const where of [text, pageSource, dataSource]) expect(where).not.toMatch(dashes);
  });
});

describe("the home page", () => {
  it("links both BNB reports under the map, beside the sentence about the BNB circles, by the titles the reports carry", () => {
    const hero = read("home", "LandingHero.tsx");
    expect(hero).toContain('<Link href="/field/bnb-registry-2026-10-16" className="underline underline-offset-4 hover:text-ns-ink">BNB Chain registry census</Link>');
    expect(hero).toContain('<Link href="/field/bnb-ratings-2026-10-16" className="underline underline-offset-4 hover:text-ns-ink">BNB Chain rating census</Link>');
    expect(hero).toContain("Two reports, both dated 16 October 2026:");
    // It sits with the circles' caption and shows only when the circles are drawn, so it is never a link with nothing beside it.
    expect(hero.indexOf("{fleetNote}")).toBeGreaterThan(-1);
    expect(hero.indexOf("Two reports, both dated")).toBeGreaterThan(hero.indexOf("{fleetNote}"));
    // Both reports are dated the day the figures were read, and the link text names the same date.
    expect(report.date).toBe("2026-10-16");
  });
});

describe("the address", () => {
  it("is a route the app draws, the server answers 200 for, and the sitemap lists", () => {
    const app = read("..", "App.tsx");
    expect(app).toContain('<Route path="/field/bnb-ratings-2026-10-16" component={BnbRatingsReport} />');
    expect(read("..", "..", "..", "server", "clientRoutes.ts")).toContain('"/field/bnb-ratings-2026-10-16"');
    expect(read("..", "..", "public", "sitemap.xml")).toContain("<loc>https://nooscape.si/field/bnb-ratings-2026-10-16</loc>");
  });
});
