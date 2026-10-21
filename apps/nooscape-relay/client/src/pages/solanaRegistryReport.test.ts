import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { DERIVED as d, MEASURED, PASS_WINDOW, REGISTRIES, REGISTRY_LABEL, SAID_REGISTRATION_MONTHS, SOLANA_DOC, registry } from "@/lib/solanaRegistryReport";
import SolanaRegistryReport from "./SolanaRegistryReport";

/**
 * The Solana registry census report states numbers that people will quote, so they are held to their source. The page reads
 * lib/solanaRegistryReport.ts and nothing else; these render it, check every number on it is one of that file's figures,
 * check each measured row against the document that holds the query output, check the totals add up, and keep the page to
 * the rules the BNB census set: no per-agent rows, no ranking, no score, no tier, no glow, no host, wallet or person named.
 */
const here = import.meta.dirname;
const read = (...parts: string[]) => readFileSync(path.resolve(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const docs = (name: string) => read("..", "..", "..", "docs", name);

const markup = renderToStaticMarkup(createElement(Router, { ssrPath: "/field/solana-registries-2026-10-18", children: createElement(SolanaRegistryReport) }));
const decode = (text: string) => text.replace(/&rsquo;/g, "’").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
const text = decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pageSource = read("SolanaRegistryReport.tsx");
const dataSource = read("..", "lib", "solanaRegistryReport.ts");
const doc = docs("solana-census-2026-10-18.md");
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
const n = (value: number) => value.toLocaleString("en-US");

const said = registry("solana_said");
const e8004 = registry("solana_8004");
const metaplex = registry("solana_registry");

/** Every number in a value, however deep, as the page would write it. */
const numbersIn = (value: unknown): number[] => {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(numbersIn);
  return [];
};
/** The digits inside a size-bucket label such as "10-99" or "100+": they are text the page prints, not figures. */
const labelDigits = (value: unknown): string[] => {
  if (typeof value === "string") return value.match(/\d+/g) ?? [];
  if (Array.isArray(value)) return value.flatMap(labelDigits);
  if (value && typeof value === "object") return Object.values(value).flatMap(labelDigits);
  return [];
};

describe("the numbers on the page are the numbers in the data file", () => {
  it("has no number that is not a measured value, a derived value or a label of a size bucket", () => {
    const allowed = new Set([...numbersIn(MEASURED).map(n), ...numbersIn(d).map(n), ...labelDigits(MEASURED.q2), ...labelDigits(MEASURED.q3), ...labelDigits(MEASURED.q6)]);
    const withoutTokens = text
      .replace(MEASURED.date, " ")
      .replace(/\b\d{4}-\d{2}\b/g, " ") // a registration month
      .replace(/\b\d{2}:\d{2}\b/g, " ") // a time of day in the pass window
      .replace(/\b8004\b/g, " ") // the registry's name
      .replace(/\b\d+-\d+\b/g, match => match.replace("-", " ")); // a size bucket such as 10-99, whose parts are checked as labels
    const found = (withoutTokens.match(/\d[\d,]*/g) ?? []).map(token => token.replace(/,$/, ""));
    expect(found.length).toBeGreaterThan(60);
    const stray = found.filter(token => !allowed.has(token));
    expect(stray, `numbers on the page that are not in lib/solanaRegistryReport.ts: ${[...new Set(stray)].join(", ")}`).toEqual([]);
  });

  it("writes no figure into the page's own source, which would let it drift from the file", () => {
    const literal = (stripComments(pageSource).match(/\b\d[\d,]{2,}\b/g) ?? []).filter(token => !["2026", "8004"].includes(token));
    expect(literal, "a number written into SolanaRegistryReport.tsx").toEqual([]);
  });

  it("carries the date and the passes it was counted from in its header", () => {
    expect(text).toContain(`Date ${MEASURED.date}`);
    expect(PASS_WINDOW).toBe("15:30 to 16:00 UTC");
    expect(text).toContain(`Counted from the passes that finished between ${PASS_WINDOW}`);
  });

  it("states the three registries' figures in one table, and says Metaplex records no link", () => {
    for (const key of REGISTRIES) {
      const r = registry(key);
      expect(text).toContain(`${REGISTRY_LABEL[key]} ${n(r.entries)} ${n(r.wallets)}`);
    }
    expect(text).toContain(`Metaplex ${n(metaplex.entries)} ${n(metaplex.wallets)} not recorded ${n(metaplex.withHttpsHost)} ${n(metaplex.hosts)}`);
    expect(text).toContain(`Together they hold ${n(d.totalEntries)} entries.`);
  });

  it("has the findings as sentences, with the denominator stated", () => {
    expect(text).toContain(`In the 8004 registry, ${n(d.wallets8004.holdingMost)} wallets hold ${n(d.wallets8004.holdingMostEntries)} of the ${n(e8004.entries)} entries (${d.wallets8004.holdingMostPercent}%), and ${n(d.wallets8004.holdingTenOrMore)} wallets hold ${n(d.wallets8004.holdingTenOrMoreEntries)} (${d.wallets8004.holdingTenOrMorePercent}%).`);
    expect(text).toContain(`In the Metaplex registry, ${n(d.walletsMetaplex.holdingMost)} wallets hold ${n(d.walletsMetaplex.holdingMostEntries)} of the ${n(metaplex.entries)} entries (${d.walletsMetaplex.holdingMostPercent}%).`);
    expect(text).toContain(`In SAID, each of the ${n(said.entries)} identities has a wallet of its own, because an identity is keyed to its owner.`);
    expect(text).toContain(`${n(d.links8004.entriesSharingALink)} of the ${n(e8004.entries)} entries (${d.links8004.entriesSharingALinkPercent}%) share their link with at least one other entry.`);
    expect(text).toContain(`One host name holds ${n(d.hosts.saidLargest)} of the ${n(said.withHttpsHost)} SAID entries that have an https link (${d.hosts.saidLargestPercent}%)`);
    expect(text).toContain(`${n(d.said.badgeYes)} of the ${n(said.entries)} identities (${d.said.badgePercent}%) carry it.`);
    expect(text).toContain(`hold ${n(d.ratings.ratingsOfThose)} of the ${n(d.ratings.all)} ratings (${d.ratings.ratingsOfThosePercent}%)`);
    expect(text).toContain(`${n(d.crossRegistry.one[1])} wallets are recorded in one registry, ${n(d.crossRegistry.two[1])} in two (holding ${n(d.crossRegistry.two[2])} entries) and ${n(d.crossRegistry.three[1])} in all three (holding ${n(d.crossRegistry.three[2])} entries).`);
  });

  it("says the badge is not an identity check, and a count of ratings is not weighed or endorsed", () => {
    expect(text).toContain("The badge is bought, or granted by a sponsor. It is not an identity check.");
    expect(text).toContain("A rating here is a count of records. Nooscape does not weigh or endorse them, and the counter does not say who wrote them.");
  });

  it("says the SAID name figure is a snapshot that changes, and a shared name is not the same agent", () => {
    expect(text).toContain(`${n(d.names.saidPlaceholder)} of the ${n(said.entries)} identities still had the placeholder, and that figure changes every day.`);
    expect(text).toContain("Two entries with the same name are not necessarily the same agent or the same person.");
  });
});

describe("the totals add up", () => {
  const rows = MEASURED.q1;
  const entriesOf = (key: string) => rows.find(row => row[0] === key)![1];

  it("query 1 agrees with query 0, and the three registries add up to the total", () => {
    for (const row of MEASURED.q0) expect(row[1], row[0]).toBe(entriesOf(row[0]));
    expect(entriesOf("solana_said") + entriesOf("solana_8004") + entriesOf("solana_registry")).toBe(d.totalEntries);
    expect(d.totalEntries).toBe(16881);
  });

  it("wallet buckets add up to the wallets and entries of each registry", () => {
    for (const key of REGISTRIES) {
      const buckets = MEASURED.q2.filter(row => row[0] === key);
      expect(buckets.reduce((sum, row) => sum + row[2], 0), `${key} wallets`).toBe(registry(key).wallets);
      expect(buckets.reduce((sum, row) => sum + row[3], 0), `${key} entries`).toBe(registry(key).entries);
    }
  });

  it("link buckets add up to the links and entries of 8004 and SAID, and Metaplex has none", () => {
    for (const key of ["solana_8004", "solana_said"] as const) {
      const buckets = MEASURED.q3.filter(row => row[0] === key);
      expect(buckets.reduce((sum, row) => sum + row[2], 0), `${key} links`).toBe(registry(key).distinctLinks);
      expect(buckets.reduce((sum, row) => sum + row[3], 0), `${key} entries`).toBe(registry(key).entries);
    }
    expect(MEASURED.q3.map(row => row[0] as string)).not.toContain("solana_registry");
    expect(registry("solana_registry").withLink).toBe(0);
  });

  it("the SAID facts each add up to its identities, and the older layouts are the ones that record no stake", () => {
    const sum = (facet: string) => MEASURED.q5.filter(row => row[0] === facet).reduce((total, row) => total + row[2], 0);
    for (const facet of ["layout", "registered_month", "badge", "stake", "slashes"]) expect(sum(facet), facet).toBe(said.entries);
    expect(SAID_REGISTRATION_MONTHS.reduce((total, row) => total + row.entries, 0)).toBe(said.entries);
    const notRecorded = (facet: string) => MEASURED.q5.find(row => row[0] === facet && row[1].startsWith("(not recorded"))![2];
    expect(notRecorded("stake")).toBe(d.said.olderLayouts);
    expect(notRecorded("slashes")).toBe(d.said.olderLayouts);
    expect(d.said.stakeNone + d.said.stakeSome).toBe(d.said.layoutNewest);
    expect(d.said.slashesZero).toBe(d.said.layoutNewest);
  });

  it("8004's rating buckets add up to its agents and its ratings", () => {
    expect(MEASURED.q6.reduce((total, row) => total + row[1], 0)).toBe(e8004.entries);
    expect(MEASURED.q6.reduce((total, row) => total + row[2], 0)).toBe(MEASURED.q6Totals.all);
    expect(MEASURED.q6Totals.tenMost).toBeLessThanOrEqual(MEASURED.q6Totals.all);
  });

  it("the wallets in more than one registry add up to all the entries, and to the distinct wallets", () => {
    expect(MEASURED.q9.reduce((total, row) => total + row[2], 0)).toBe(d.totalEntries);
    const distinct = said.wallets + e8004.wallets + metaplex.wallets;
    const twice = MEASURED.q9.find(row => row[0] === 2)![1];
    const thrice = MEASURED.q9.find(row => row[0] === 3)![1];
    expect(MEASURED.q9.reduce((total, row) => total + row[1], 0)).toBe(distinct - twice - 2 * thrice);
  });

  it("names: the SAID entries with a name and with the placeholder add up, and every Metaplex entry has a name", () => {
    expect(d.names.saidPlaceholder + d.names.saidNamed).toBe(said.entries);
    expect(MEASURED.q8.find(row => row[0] === "solana_registry")![2]).toBe(0);
    expect(d.names.e8004Placeholder + d.names.e8004Named).toBe(e8004.entries);
  });

  it("the Metaplex rows were all written by the one chain pass", () => {
    expect(MEASURED.q7).toHaveLength(1);
    expect(MEASURED.q7[0][1]).toBe(metaplex.entries);
  });
});

describe("each measured row is in the measurement document", () => {
  const row = (cells: ReadonlyArray<string | number>) => `| ${cells.join(" | ")} |`;

  it("names itself, and says what was and was not selected and fetched", () => {
    expect(SOLANA_DOC).toBe("docs/solana-census-2026-10-18.md");
    expect(doc).toContain("no name, no wallet address and no host name was selected, and nothing was fetched from any site for it");
    expect(doc).toContain("Every statement is a read-only SELECT.");
  });

  const TABLES: Array<[string, ReadonlyArray<ReadonlyArray<string | number>>]> = [
    ["query 0", MEASURED.q0],
    ["query 1", MEASURED.q1],
    ["query 2", MEASURED.q2],
    ["query 3", MEASURED.q3],
    ["query 4", MEASURED.q4],
    ["query 5", MEASURED.q5],
    ["query 6", MEASURED.q6],
    ["query 6, second result", [[MEASURED.q6Totals.tenMost, MEASURED.q6Totals.all]]],
    ["query 7", MEASURED.q7],
    ["query 8", MEASURED.q8],
    ["query 9", MEASURED.q9],
  ];
  for (const [name, rows] of TABLES) {
    it(`has every row of ${name}, as the query returned it`, () => {
      expect(rows.length).toBeGreaterThan(0);
      for (const cells of rows) expect(doc, `${name}: ${row(cells)}`).toContain(row(cells));
    });
  }

  it("has the figures the page works out, worded as the page words them", () => {
    expect(doc).toContain(`${n(d.wallets8004.holdingMost)} wallets hold ${n(d.wallets8004.holdingMostEntries)} of the ${n(e8004.entries)} 8004 entries (${d.wallets8004.holdingMostPercent}%), and ${n(d.wallets8004.holdingTenOrMore)} wallets hold ${n(d.wallets8004.holdingTenOrMoreEntries)} (${d.wallets8004.holdingTenOrMorePercent}%). The largest single holding is ${n(d.wallets8004.largest)} (${d.wallets8004.largestPercent}%).`);
    expect(doc).toContain(`${n(d.walletsMetaplex.holdingMost)} wallets hold ${n(d.walletsMetaplex.holdingMostEntries)} of the ${n(metaplex.entries)} Metaplex entries (${d.walletsMetaplex.holdingMostPercent}%). The largest single holding is ${n(d.walletsMetaplex.largest)} (${d.walletsMetaplex.largestPercent}%).`);
    expect(doc).toContain(`${n(d.links8004.entriesSharingALink)} of the ${n(e8004.entries)} 8004 entries (${d.links8004.entriesSharingALinkPercent}%) share a link with at least one other entry. ${n(d.links8004.linksSharedByTenOrMore)} links are shared by 10 or more entries and hold ${n(d.links8004.entriesInThoseLinks)} entries (${d.links8004.entriesInThoseLinksPercent}%). The largest group is ${n(d.links8004.largestGroup)}.`);
    expect(doc).toContain(`${n(d.hosts.saidLargest)} of the ${n(said.withHttpsHost)} SAID entries with an https link (${d.hosts.saidLargestPercent}%) are on one host name, and the second holds ${n(d.hosts.saidSecond)}.`);
    expect(doc).toContain(`${n(d.hosts.e8004TwoLargest)} of the ${n(e8004.withHttpsHost)} 8004 entries with an https link (${d.hosts.e8004TwoLargestPercent}%) are on the two largest host names (${n(d.hosts.e8004First)} and ${n(d.hosts.e8004Second)}).`);
    expect(doc).toContain(`${n(d.hosts.metaplexLargest)} of the ${n(metaplex.withHttpsHost)} Metaplex entries with an https link (${d.hosts.metaplexLargestPercent}%) are on the largest host name.`);
    expect(doc).toContain(`${n(d.said.badgeYes)} of ${n(said.entries)} SAID identities (${d.said.badgePercent}%) carry the badge.`);
    expect(doc).toContain(`${n(d.ratings.agentsWith100OrMore)} 8004 agents with 100 ratings or more hold ${n(d.ratings.ratingsOfThose)} of the ${n(d.ratings.all)} ratings (${d.ratings.ratingsOfThosePercent}%). The ten agents with the most hold ${n(d.ratings.tenMost)} (${d.ratings.tenMostPercent}%).`);
    expect(doc).toContain(`${n(d.names.metaplexSharing)} Metaplex entries (${d.names.metaplexSharingPercent}%) share a name with at least one other entry.`);
  });

  it("says what the measurement cannot say", () => {
    expect(doc).toContain("## What this measurement cannot say");
    expect(doc).toContain("It is not a count of people.");
    expect(doc).toContain("Metaplex link figures are not recorded");
  });

  it("keeps the queries in the repository, all of them reads", () => {
    const sql = docs("solana-census-queries-2026-10-18.sql");
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT)\b/im);
    expect(sql.match(/^\s*(WITH|SELECT)\b/gim)!.length).toBeGreaterThanOrEqual(11);
    // The visibility rule is the site's, on every statement.
    expect((sql.match(/e\.assetClosedAt IS NULL/g) ?? []).length).toBe((sql.match(/FROM agent_directory_entries e/g) ?? []).length);
  });
});

describe("what the page says, and does not", () => {
  it("has a section called What this does not show, with the caveats", () => {
    expect(text).toContain("What this does not show");
    for (const caveat of [
      "It is not a count of people. A platform can register many agents under one wallet, and one person can use many wallets.",
      "It does not say whether an agent runs. Nothing was asked of any address.",
      "Only SAID accounts record a registration date. The other two registries are counted as they stood on the date above.",
      "The directory records no link for Metaplex entries, so its link figures are not recorded. That is not the same as none.",
      "A shared link, host name, wallet or name is a recorded fact. It does not say that one person is behind the entries, or that anything is wrong.",
      "Names, links and counters are written by the registrants or by the registries. We have not verified them.",
    ]) {
      expect(text).toContain(caveat);
    }
  });

  it("ends by linking /checker and saying the census is a snapshot to be redone and dated again", () => {
    expect(markup).toContain('href="/checker"');
    expect(text).toContain("This census is a snapshot. It will be redone and dated again.");
    expect(text.indexOf("This census is a snapshot")).toBeGreaterThan(text.indexOf("What this does not show"));
  });

  it("names no host, no wallet and no person, and lists no agent", () => {
    for (const where of [text, markup, pageSource, dataSource, doc]) {
      expect(where).not.toMatch(/api\.saidprotocol|saidprotocol\.com|atelierai|clawpump|api\.metaplex|ipfs\.filebase/i);
      // A Solana address is 32 to 44 base58 characters: none is on the page, in the data file or in the document.
      expect(where).not.toMatch(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    }
    expect(text).not.toMatch(/\boperators?\b/i);
    expect(markup).not.toMatch(/href="\/agents\//);
    const hrefs = [...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map(match => match[1]);
    expect(hrefs.filter(href => !["/", "/checker", "/disputes", "/privacy", "/terms", "/contact", "/about"].includes(href!))).toEqual([]);
  });

  it("has no score, no ranking, no tier and no best or top, and no glow", () => {
    expect(text).not.toMatch(/\bscores?\b|\brank\w*|\bleaderboard\b|\bbest\b|\btop\b|\btiers?\b|\bleading\b|\bwinners?\b/i);
    expect(markup).not.toMatch(/glow|shadow|pulse|animate-|gradient|blur/i);
  });

  it("uses no long dash", () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const where of [text, pageSource, dataSource, doc]) expect(where).not.toMatch(dashes);
  });
});

describe("the address", () => {
  it("is a route the app draws, the server answers 200 for, the sitemap lists, and the Solana tab links to", () => {
    const app = read("..", "App.tsx");
    expect(app).toContain('<Route path="/field/solana-registries-2026-10-18" component={SolanaRegistryReport} />');
    expect(read("..", "..", "..", "server", "clientRoutes.ts")).toContain('"/field/solana-registries-2026-10-18"');
    expect(read("..", "..", "public", "sitemap.xml")).toContain("<loc>https://nooscape.si/field/solana-registries-2026-10-18</loc>");
    const tabs = read("..", "components", "home", "ChainTabs.tsx");
    expect(tabs).toContain('chain === "solana" && (');
    expect(tabs).toContain('<Link href="/field/solana-registries-2026-10-18"');
  });
});
