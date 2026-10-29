import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { CHAIN_GROUP_REPORT } from "@/lib/chainExplorerModel";
import { BASE_DOC, BASE_SQL, CHAIN, DERIVED as d, MEASURED, PASS_TIME, REGISTRY, RULES, THRESHOLDS, formatPercent as pc, percent } from "@/lib/baseRegistryReport";
import BaseRegistryReport from "./BaseRegistryReport";

/**
 * The Base registry census report states numbers that people will quote, so they are held to their source. The page reads
 * lib/baseRegistryReport.ts and nothing else; these render it, check every number on it is one of that file's figures, check each
 * measured row against the document that holds the query output, check the totals add up, and keep the page to the rules the other
 * censuses set: no per-agent rows, no ranking, no score, no tier, no glow, no host, wallet or person named.
 */
const here = import.meta.dirname;
const read = (...parts: string[]) => readFileSync(path.resolve(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const docs = (name: string) => read("..", "..", "..", "docs", name);

const ROUTE = "/field/base-registry-2026-10-21";
const markup = renderToStaticMarkup(createElement(Router, { ssrPath: ROUTE, children: createElement(BaseRegistryReport) }));
const decode = (value: string) => value.replace(/&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pageSource = read("BaseRegistryReport.tsx");
const dataSource = read("..", "lib", "baseRegistryReport.ts");
const doc = docs("base-census-2026-10-21.md");
const sql = docs("base-census-queries-2026-10-21.sql");
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
const n = (value: number) => value.toLocaleString("en-US");

/** Every number in a value, however deep, as the page would write it. */
const numbersIn = (value: unknown): number[] => {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(numbersIn);
  return [];
};
/** The digits inside a size-bucket label such as "10-49" or "1000+": they are text the page prints, not figures. */
const labelDigits = (value: unknown): string[] => {
  if (typeof value === "string") return value.match(/\d+/g) ?? [];
  if (Array.isArray(value)) return value.flatMap(labelDigits);
  if (value && typeof value === "object") return Object.values(value).flatMap(labelDigits);
  return [];
};
/** How a figure is written on the page: with thousands separators, or as a share to one decimal place. */
const written = (value: number) => [n(value), value.toFixed(1)];

const registrations = REGISTRY.registrations;
const q = { q0: MEASURED.q0[0], q1: MEASURED.q1[0], q3b: MEASURED.q3b[0], q4b: MEASURED.q4b[0], q6: MEASURED.q6[0], q8: MEASURED.q8[0] };
const walletBucket = (name: string) => MEASURED.q2.find(row => row[0] === name)!;
const linkBucket = (name: string) => MEASURED.q5.find(row => row[0] === name)!;
const ledgerKind = (kind: string) => MEASURED.q9.find(row => row[0] === kind)!;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe("the numbers on the page are the numbers in the data file", () => {
  it("has no number that is not a measured value, a derived value, a threshold, a fact about the chain or a label of a size bucket", () => {
    const allowed = new Set([
      ...[...numbersIn(MEASURED), ...numbersIn(d), ...numbersIn(THRESHOLDS), ...numbersIn(CHAIN)].flatMap(written),
      ...labelDigits(MEASURED.q2),
      ...labelDigits(MEASURED.q5),
      ...labelDigits(RULES),
      // A chain id is an identifier and is written as it is, with no thousands separator.
      String(CHAIN.id),
    ]);
    const withoutTokens = text
      .replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, " ") // a UTC month or day, and the date in the header
      .replace(/\b\d{2}:\d{2}(?::\d{2})?\b/g, " ") // a time of day in the header and the first block's time
      .replace(/\b8004\b/g, " ") // the standard's name
      .replace(/\b\d+-\d+\b/g, match => match.replace("-", " ")); // a size bucket such as 10-49, whose parts are checked as labels
    const found = (withoutTokens.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(token => token.replace(/,$/, ""));
    expect(found.length).toBeGreaterThan(80);
    const stray = found.filter(token => !allowed.has(token));
    expect(stray, `numbers on the page that are not in lib/baseRegistryReport.ts: ${[...new Set(stray)].join(", ")}`).toEqual([]);
  });

  it("writes no figure into the page's own source, which would let it drift from the file", () => {
    const literal = (stripComments(pageSource).match(/\b\d[\d,]{2,}\b/g) ?? []).filter(token => !["2026", "8004"].includes(token));
    expect(literal, "a number written into BaseRegistryReport.tsx").toEqual([]);
  });

  it("carries the date and the pass it was counted from in its header", () => {
    expect(text).toContain(`Date ${MEASURED.date}`);
    expect(PASS_TIME).toBe("01:12 UTC");
    expect(text).toContain(`Counted from the registry pass that finished at ${PASS_TIME}`);
  });

  it("states the registry's size and surface in one table", () => {
    expect(text).toContain(
      `What was counted Count Registrations the directory has stored ${n(registrations)} Registrations the directory lists ${n(REGISTRY.listed)} Registering wallets ${n(REGISTRY.wallets)} Registrations with an https link ${n(REGISTRY.withHttpsHost)} Host names of those links ${n(REGISTRY.hosts)} Different profile links ${n(REGISTRY.profileLinks)}`
    );
    expect(text).toContain(`${n(d.hosts.withoutHost)} registrations (${pc(d.hosts.withoutHostPercent)}) have no https host name recorded, and ${n(REGISTRY.noUriSet)} set no profile link at all.`);
  });

  it("says what the listing rules did, in one table, with the first rule that reached each registration held out", () => {
    expect(text).toContain(
      `Of the ${n(registrations)} registrations, ${n(d.listing.listed)} (${pc(d.listing.listedPercent)}) are listed in the directory. ${n(d.listing.noLink)} (${pc(d.listing.noLinkPercent)}) have no usable profile link. ${n(d.listing.heldOut)} (${pc(d.listing.heldOutPercent)}) are held out as shared, not judged. ${n(d.listing.numberOnly)} carry a name that is only a number, and are not listed.`
    );
    expect(text).toContain(
      `What happened Registrations Listed in the directory ${n(d.listing.listed)} No usable profile link ${n(d.listing.noLink)} Held out first: ${RULES.link} ${n(d.listing.byLink)} Held out first: ${RULES.host} ${n(d.listing.byHost)} Held out first: ${RULES.wallet} ${n(d.listing.byWallet)} A name that is only a number ${n(d.listing.numberOnly)}`
    );
    expect(text).toContain("A rule that reaches a registration first is not the only one that would have.");
    expect(text).toContain(`The host name rule reached ${n(d.listing.byHost)} registrations first, ${pc(d.listing.byHostPercent)} of all of them.`);
    expect(text).toContain("These are the rules written for the BNB Chain registry, and they have not been changed for Base. This census says what they did here. It does not say whether they are right for Base.");
  });

  it("has the findings as sentences, with the denominator stated", () => {
    expect(text).toContain(
      `${n(d.wallets.tenOrMore)} wallets each registered ${THRESHOLDS.tenWallet} or more. Together they made ${n(d.wallets.tenOrMoreRegistrations)} of the ${n(registrations)} registrations (${pc(d.wallets.tenOrMorePercent)}), and the ${n(d.wallets.large)} wallets that registered ${THRESHOLDS.largeWallet} or more made ${n(d.wallets.largeRegistrations)} (${pc(d.wallets.largePercent)}). The largest single wallet made ${n(d.wallets.largest)} (${pc(d.wallets.largestPercent)}).`
    );
    expect(text).toContain(
      `At the other end, ${n(d.wallets.withOne)} of the ${n(REGISTRY.wallets)} wallets (${pc(d.wallets.withOnePercent)}) registered one each. Together they made ${n(d.wallets.withOneRegistrations)} registrations (${pc(d.wallets.withOneRegistrationsPercent)}).`
    );
    expect(text).toContain(`The ${n(d.wallets.thousandOrMore)} wallets in the largest bucket made ${n(d.wallets.thousandOrMoreRegistrations)} registrations (${pc(d.wallets.thousandOrMorePercent)}).`);
    expect(text).toContain(
      `The ${n(d.largeWallets.shown)} largest wallets made ${n(d.largeWallets.registrations)} registrations between them (${pc(d.largeWallets.registrationsPercent)}). ${n(d.largeWallets.onOneHost)} of them have every registration on one host name, and ${n(d.largeWallets.withoutAHost)} have no https host name for any registration. ${n(d.largeWallets.ownLinkEach)} gave every registration a profile link of its own. ${n(d.largeWallets.oneLinkForAll)} used one profile link for every registration they made, ${n(d.largeWallets.oneLinkRegistrations)} registrations between them. The other ${n(d.largeWallets.between)} are in between.`
    );
    expect(text).toContain(
      `${n(d.hosts.withHttps)} of the ${n(registrations)} registrations (${pc(d.hosts.withHttpsPercent)}) have an https link, spread over ${n(REGISTRY.hosts)} host names. One host name holds ${n(d.hosts.largest)} of them (${pc(d.hosts.largestPercent)}), which is ${pc(d.hosts.largestOfAllPercent)} of all the registrations. The next holds ${n(d.hosts.second)} (${pc(d.hosts.secondPercent)}) and the one after holds ${n(d.hosts.third)}. The two largest together hold ${n(d.hosts.twoLargest)} (${pc(d.hosts.twoLargestPercent)}).`
    );
    expect(text).toContain(
      `${n(d.hosts.atLeastThreshold)} host names hold ${THRESHOLDS.largeHost} or more registrations each. Together they hold ${n(d.hosts.atLeastThresholdRegistrations)} registrations, ${pc(d.hosts.atLeastThresholdPercent)} of those with an https link and ${pc(d.hosts.atLeastThresholdOfAllPercent)} of all of them.`
    );
    expect(text).toContain(
      `${n(d.links.usedOnce)} of the ${n(d.links.total)} different profile links (${pc(d.links.usedOncePercent)}) are used by one registration each. ${n(d.links.shared)} are used by more than one, by ${n(d.links.sharedRegistrations)} registrations in all (${pc(d.links.sharedRegistrationsPercent)}). ${n(d.links.big)} links are used by ${THRESHOLDS.bigLink} or more registrations each, ${n(d.links.bigRegistrations)} registrations in all (${pc(d.links.bigPercent)}). The largest is used by ${n(d.links.largest)} (${pc(d.links.largestPercent)}), and all of them have an https host name.`
    );
    expect(text).toContain(`${n(d.names.placeholder)} of the ${n(registrations)} registrations (${pc(d.names.placeholderPercent)}) have no name of their own.`);
    expect(text).toContain(
      `The other ${n(d.names.named)} carry ${n(d.names.distinct)} distinct names, and ${n(d.names.sharing)} registrations (${pc(d.names.sharingPercent)}) share a name with at least one other. ${n(d.names.sharedByTenOrMore)} registrations are in names shared by ${THRESHOLDS.sharedName} or more, and the largest group is ${n(d.names.largestGroup)}.`
    );
    expect(text).toContain(`all ${n(d.activity.measured)} registrations have been measured.`);
    expect(text).toContain(
      `${n(d.activity.transfers)} transfers after the mint are recorded, on ${n(d.activity.changedHands)} registrations (${pc(d.activity.changedHandsPercent)}). ${n(d.activity.noTransfer)} registrations (${pc(d.activity.noTransferPercent)}) have had none.`
    );
    expect(text).toContain(
      `${n(d.activity.handouts)} hand-outs are recorded, on ${n(d.activity.handedOut)} registrations (${pc(d.activity.handedOutPercent)}). A hand-out is a transfer sent from the wallet the registration was minted to, within about an hour of the mint (${n(CHAIN.handoutBlocks)} blocks on Base). The other ${n(d.activity.laterTransfers)} transfers came later than the first hour or from another wallet.`
    );
    expect(text).toContain(`${n(d.activity.edits)} edits of a profile link are recorded, on ${n(d.activity.edited)} registrations (${pc(d.activity.editedPercent)}).`);
    expect(text).toContain(
      `The date of a registration is worked out from its mint block. The first block of the registry is ${CHAIN.firstBlockTime} UTC, and a block on Base takes ${CHAIN.blockSeconds} seconds. ${n(d.time.busiestMonthRegistrations)} of the registrations (${pc(d.time.busiestMonthPercent)}) were made in ${d.time.busiestMonth}, the month of this census, more than in all the ${n(d.time.earlierMonths)} months before it together.`
    );
    expect(text).toContain(
      `The table of days below starts at ${d.time.firstDay}. In the ${n(d.time.beforeDays)} days before ${d.time.riseFrom}, a UTC day had between ${n(d.time.beforeLow)} and ${n(d.time.beforeHigh)} registrations, ${n(d.time.beforeRegistrations)} in all. From ${d.time.riseFrom} every day has had more than any day before it: ${n(d.time.riseFromRegistrations)} on ${d.time.riseFrom}, rising to ${n(d.time.busiestDayRegistrations)} on ${d.time.busiestDay}, which is ${pc(d.time.busiestDayPercent)} of all the registrations in one UTC day. The ${n(d.time.sinceDays)} days from ${d.time.riseFrom} to ${d.time.lastDay} hold ${n(d.time.sinceRegistrations)} registrations (${pc(d.time.sincePercent)}). ${d.time.lastDay} is part of a day: the pass ran at ${PASS_TIME}, and it has ${n(d.time.lastDayRegistrations)}.`
    );
    expect(text).toContain("Ratings are not measured for Base. Nooscape reads no reputation registry for it, so this census says nothing about ratings.");
  });

  it("shows every returned row of the wallet, host, link, month and day tables", () => {
    for (const row of MEASURED.q2) expect(text).toContain(`${row[0]} ${n(row[1])} ${n(row[2])}`);
    const places = ["Largest", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];
    for (const row of MEASURED.q4) expect(text).toContain(`${places[row[0] - 1]} ${n(row[1])}`);
    for (const row of MEASURED.q5) expect(text).toContain(`${row[0]} ${n(row[1])} ${n(row[2])}`);
    for (const row of MEASURED.q10b) expect(text).toContain(`${row[0]} ${n(row[1])}`);
    for (const row of MEASURED.q10a) expect(text).toContain(`${row[0]} ${n(row[1])}`);
  });

  it("says Base reads a name only from the chain event, so the placeholder count is not a figure that falls", () => {
    expect(text).toContain("Nooscape reads a name only from registration data written into the chain event itself. It fetches no registration link for Base, so the placeholder count changes only as new registrations are made.");
    expect(text).toContain("Two registrations with the same name are not necessarily the same agent or the same person.");
  });
});

describe("shares are given to one decimal place", () => {
  it("rounds to the nearest tenth and writes it with one decimal", () => {
    expect(percent(9022, 389902)).toBe(2.3);
    expect(pc(percent(9022, 389902))).toBe("2.3%");
    expect(percent(355545, 389902)).toBe(91.2);
    expect(pc(percent(1, 3))).toBe("33.3%");
  });
});

describe("the totals add up", () => {
  it("queries 0, 1, 6 and 8 and the mints in query 9 agree on the registrations, and the directory's count is the listed row of query 7", () => {
    expect(q.q0[0]).toBe(registrations);
    expect(q.q6[0]).toBe(registrations);
    expect(q.q8[0]).toBe(registrations);
    expect(ledgerKind("mint")[1]).toBe(registrations);
    expect(ledgerKind("mint")[2]).toBe(registrations);
    expect(registrations).toBe(389902);
    expect(q.q0[5]).toBe(d.listing.listed);
    expect(REGISTRY.hidden, "the document says none is hidden").toBe(0);
  });

  it("every registration has a wallet, and every one was measured by the activity walk", () => {
    expect(REGISTRY.noWallet).toBe(0);
    expect(REGISTRY.mintMeasured).toBe(registrations);
    expect(q.q8[1]).toBe(registrations);
    expect(q.q8[2]).toBe(registrations);
  });

  it("wallet buckets add up to the wallets and the registrations", () => {
    expect(sum(MEASURED.q2.map(row => row[1]))).toBe(REGISTRY.wallets);
    expect(sum(MEASURED.q2.map(row => row[2]))).toBe(registrations);
    for (const row of MEASURED.q2) expect(row[3], `${row[0]}: the largest in a bucket cannot be more than the bucket`).toBeLessThanOrEqual(row[2]);
  });

  it("query 3b is the three largest buckets of query 2, and query 3 is those wallets' 25 largest, in order", () => {
    const upper = [walletBucket("50-99"), walletBucket("100-999"), walletBucket("1000+")];
    expect(q.q3b[0]).toBe(sum(upper.map(row => row[1])));
    expect(q.q3b[1]).toBe(sum(upper.map(row => row[2])));
    expect(q.q3b[2]).toBe(walletBucket("1000+")[3]);
    expect(MEASURED.q3[0][1]).toBe(q.q3b[2]);
    expect(MEASURED.q3.length).toBe(25);
    expect(MEASURED.q3.length).toBeLessThanOrEqual(q.q3b[0]);
    expect(sum(MEASURED.q3.map(row => row[1]))).toBeLessThanOrEqual(q.q3b[1]);
    expect(Math.min(...MEASURED.q3.map(row => row[1]))).toBeGreaterThanOrEqual(THRESHOLDS.largeWallet);
    MEASURED.q3.forEach((row, index) => {
      expect(row[0]).toBe(index + 1);
      if (index > 0) expect(row[1]).toBeLessThanOrEqual(MEASURED.q3[index - 1]![1]);
    });
  });

  it("each large wallet's registrations with a link, and the part on its largest host name, are parts of its registrations", () => {
    for (const row of MEASURED.q3) {
      expect(row[2]).toBeLessThanOrEqual(row[1]);
      expect(row[3]).toBeLessThanOrEqual(row[2]);
      expect(row[5]).toBeGreaterThanOrEqual(1);
      expect(row[5]).toBeLessThanOrEqual(row[1]);
      // A wallet with no https link has no host name, and one with a link has at least one.
      expect(row[4] === 0).toBe(row[2] === 0);
    }
    expect(sum(MEASURED.q3.map(row => row[2]))).toBeLessThanOrEqual(REGISTRY.withHttpsHost);
    expect(d.largeWallets.shown).toBe(MEASURED.q3.length);
    expect(d.largeWallets.onOneHost + d.largeWallets.withoutAHost).toBeLessThanOrEqual(d.largeWallets.shown);
    expect(d.largeWallets.ownLinkEach + d.largeWallets.oneLinkForAll + d.largeWallets.between, "the three groups the page names make the wallets it counts").toBe(d.largeWallets.shown);
    expect(d.largeWallets.between).toBeGreaterThanOrEqual(0);
    // A wallet with 50 or more registrations cannot have both a link of its own for each and one link for all.
    expect(MEASURED.q3.filter(row => row[5] === row[1] && row[5] === 1)).toEqual([]);
  });

  it("host sizes fall from the largest, and are parts of the registrations with a link", () => {
    MEASURED.q4.forEach((row, index) => {
      expect(row[0]).toBe(index + 1);
      if (index > 0) expect(row[1]).toBeLessThanOrEqual(MEASURED.q4[index - 1]![1]);
    });
    expect(sum(MEASURED.q4.map(row => row[1]))).toBeLessThanOrEqual(REGISTRY.withHttpsHost);
    expect(d.hosts.withHttps + d.hosts.withoutHost).toBe(registrations);
    expect(REGISTRY.hosts).toBeGreaterThanOrEqual(MEASURED.q4.length);
    // Query 4b counts every host name at the threshold or more, so it holds at least those of the ten that reach it, and no more than all the https registrations.
    const reaching = MEASURED.q4.filter(row => row[1] >= THRESHOLDS.largeHost);
    expect(q.q4b[0]).toBeGreaterThanOrEqual(reaching.length);
    expect(q.q4b[0]).toBeLessThanOrEqual(REGISTRY.hosts);
    expect(q.q4b[1]).toBeGreaterThanOrEqual(sum(reaching.map(row => row[1])));
    expect(q.q4b[1]).toBeLessThanOrEqual(REGISTRY.withHttpsHost);
    expect(q.q4b[2]).toBe(MEASURED.q4[0][1]);
    expect(d.hosts.largest).toBeGreaterThan(d.hosts.second);
  });

  it("profile links add up to the different links and the registrations, and the largest link has an https host on each registration", () => {
    expect(d.links.total).toBe(REGISTRY.profileLinks);
    expect(sum(MEASURED.q5.map(row => row[2])) + REGISTRY.noUriSet).toBe(registrations);
    for (const row of MEASURED.q5) {
      expect(row[3], `${row[0]}: the largest cannot be more than the bucket`).toBeLessThanOrEqual(row[2]);
      expect(row[4], `${row[0]}: registrations with a host cannot be more than the bucket`).toBeLessThanOrEqual(row[2]);
    }
    expect(linkBucket("1")[1]).toBe(linkBucket("1")[2]);
    // A registration on a shared link is held out by the link rule first, unless an earlier state (no usable link, a name that is only a number) took it.
    expect(d.listing.byLink).toBeLessThanOrEqual(d.links.sharedRegistrations);
    expect(d.links.shared).toBe(sum(MEASURED.q5.filter(row => row[0] !== "1").map(row => row[1])));
    expect(linkBucket("1000+")[1], "the page says the largest link is the only one in the largest bucket").toBe(1);
    expect(d.links.largest).toBe(linkBucket("1000+")[3]);
    expect(d.links.largestWithHost, "the page says all the registrations of the largest link have an https host name").toBe(d.links.largest);
    expect(d.links.big).toBe(linkBucket("50-999")[1] + linkBucket("1000+")[1]);
  });

  it("names: the placeholders and the named registrations add up, and the shared names are among the named", () => {
    expect(d.names.placeholder + d.names.named).toBe(registrations);
    expect(d.names.distinct).toBeLessThanOrEqual(d.names.named);
    expect(d.names.sharing).toBeLessThanOrEqual(d.names.named);
    expect(d.names.sharedByTenOrMore).toBeLessThanOrEqual(d.names.sharing);
    expect(d.names.largestGroup).toBeGreaterThanOrEqual(THRESHOLDS.sharedName);
  });

  it("the listing states add up to the registrations, and the rules reached held-out registrations in the order they run", () => {
    expect(sum(MEASURED.q7.map(row => row[3]))).toBe(registrations);
    expect(d.listing.listed + d.listing.noLink + d.listing.heldOut + d.listing.numberOnly).toBe(registrations);
    expect(d.listing.byLink + d.listing.byHost + d.listing.byWallet).toBe(d.listing.heldOut);
    for (const row of MEASURED.q7) expect(row[2] === "-", `${row[1]}: only a registration held out as shared has a first rule`).toBe(row[0] !== 2);
    expect(MEASURED.q7.filter(row => row[0] === 2).map(row => row[2]).sort()).toEqual([RULES.host, RULES.link, RULES.wallet].sort());
  });

  it("transfers, hand-outs and edits agree with the activity ledger", () => {
    expect(ledgerKind("secondary")[1]).toBe(q.q8[3]);
    expect(ledgerKind("secondary")[2]).toBe(q.q8[5]);
    expect(ledgerKind("uri_update")[1]).toBe(q.q8[7]);
    expect(ledgerKind("uri_update")[2]).toBe(q.q8[8]);
    for (const row of MEASURED.q9) expect(row[3]).toBeLessThanOrEqual(row[4]);
    expect(MEASURED.q9.map(row => row[0])).toEqual(["mint", "secondary", "uri_update"]);
    expect(d.activity.handouts).toBeLessThanOrEqual(d.activity.transfers);
    expect(d.activity.handedOut).toBeLessThanOrEqual(d.activity.changedHands);
    expect(d.activity.laterTransfers, "the page says the other transfers came later or from another wallet, so there are some").toBeGreaterThan(0);
    expect(d.activity.noTransfer + d.activity.changedHands).toBe(registrations);
  });

  it("the months and the days add up to the registrations and to each other, and the days before the rise are each smaller than any day from it", () => {
    expect(sum(MEASURED.q10b.map(row => row[1]))).toBe(registrations);
    expect(d.time.months).toBe(MEASURED.q10b.length);
    expect(d.time.busiestMonth).toBe(MEASURED.q10b[MEASURED.q10b.length - 1]![0]);
    expect(d.time.busiestMonthRegistrations, "the page says the month holds more than all the earlier ones together").toBeGreaterThan(registrations - d.time.busiestMonthRegistrations);
    // Query 10a's days all fall in the last month, so they add up to it.
    for (const row of MEASURED.q10a) expect(row[0].startsWith(d.time.busiestMonth)).toBe(true);
    expect(sum(MEASURED.q10a.map(row => row[1]))).toBe(d.time.busiestMonthRegistrations);
    const sorted = [...MEASURED.q10a].map(row => row[0]);
    expect(sorted).toEqual([...sorted].sort());
    expect(d.time.beforeDays + d.time.sinceDays).toBe(d.time.days);
    expect(d.time.beforeHigh, "every day from the rise has more than the busiest day before it").toBeLessThan(Math.min(...MEASURED.q10a.filter(row => row[0] >= d.time.riseFrom).map(row => row[1])));
    expect(d.time.busiestDayRegistrations).toBe(Math.max(...MEASURED.q10a.map(row => row[1])));
    // The last day is the day of the pass the census is counted from, and it is the part day.
    expect(d.time.lastDay).toBe(q.q0[4].slice(0, 10));
    expect(q.q0[4].slice(11, 13)).toBe("01");
  });
});

describe("each measured row is in the measurement document", () => {
  const row = (cells: ReadonlyArray<string | number>) => `| ${cells.join(" | ")} |`;

  it("names itself, and says what was and was not selected and fetched", () => {
    expect(BASE_DOC).toBe("docs/base-census-2026-10-21.md");
    expect(BASE_SQL).toBe("docs/base-census-queries-2026-10-21.sql");
    expect(doc).toContain("no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it");
    expect(doc).toContain("Every statement is a read-only SELECT.");
  });

  const TABLES: Array<[string, ReadonlyArray<ReadonlyArray<string | number>>]> = [
    ["query 0", MEASURED.q0],
    ["query 1", MEASURED.q1],
    ["query 2", MEASURED.q2],
    ["query 3", MEASURED.q3],
    ["query 3b", MEASURED.q3b],
    ["query 4", MEASURED.q4],
    ["query 4b", MEASURED.q4b],
    ["query 5", MEASURED.q5],
    ["query 6", MEASURED.q6],
    ["query 7", MEASURED.q7],
    ["query 8", MEASURED.q8],
    ["query 9", MEASURED.q9],
    ["query 10a", MEASURED.q10a],
    ["query 10b", MEASURED.q10b],
  ];
  for (const [name, rows] of TABLES) {
    it(`has every row of ${name}, as the query returned it`, () => {
      expect(rows.length).toBeGreaterThan(0);
      for (const cells of rows) expect(doc, `${name}: ${row(cells)}`).toContain(row(cells));
    });
  }

  it("has the figures the page works out, worded as the document words them", () => {
    expect(doc).toContain(
      `${n(d.listing.listed)} of the ${n(registrations)} registrations (${pc(d.listing.listedPercent)}) are listed. ${n(d.listing.noLink)} (${pc(d.listing.noLinkPercent)}) have no usable profile link. ${n(d.listing.heldOut)} (${pc(d.listing.heldOutPercent)}) are held out as shared: ${n(d.listing.byLink)} reached first by a shared profile link, ${n(d.listing.byHost)} by a shared host name and ${n(d.listing.byWallet)} by a wallet that registered ${THRESHOLDS.tenWallet} or more. ${n(d.listing.numberOnly)} carry a name that is only a number.`
    );
    expect(doc).toContain(
      `${n(d.wallets.tenOrMore)} wallets made ${n(d.wallets.tenOrMoreRegistrations)} of the ${n(registrations)} registrations (${pc(d.wallets.tenOrMorePercent)}), and ${n(d.wallets.large)} wallets made ${n(d.wallets.largeRegistrations)} (${pc(d.wallets.largePercent)}). The largest single wallet made ${n(d.wallets.largest)} (${pc(d.wallets.largestPercent)}).`
    );
    expect(doc).toContain(
      `${n(d.wallets.withOne)} of the ${n(REGISTRY.wallets)} wallets (${pc(d.wallets.withOnePercent)}) registered one each, and together they made ${n(d.wallets.withOneRegistrations)} registrations (${pc(d.wallets.withOneRegistrationsPercent)}). The ${n(d.wallets.thousandOrMore)} wallets in the largest bucket made ${n(d.wallets.thousandOrMoreRegistrations)} registrations (${pc(d.wallets.thousandOrMorePercent)}).`
    );
    expect(doc).toContain(
      `The ${n(d.largeWallets.shown)} largest wallets made ${n(d.largeWallets.registrations)} registrations between them (${pc(d.largeWallets.registrationsPercent)}). ${n(d.largeWallets.onOneHost)} of them have every registration on one host name, and ${n(d.largeWallets.withoutAHost)} have no https host name for any registration. ${n(d.largeWallets.ownLinkEach)} gave every registration a profile link of its own. ${n(d.largeWallets.oneLinkForAll)} used one link for every registration they made, ${n(d.largeWallets.oneLinkRegistrations)} registrations between them. The other ${n(d.largeWallets.between)} are in between.`
    );
    expect(doc).toContain(
      `${n(d.hosts.withHttps)} of the ${n(registrations)} registrations (${pc(d.hosts.withHttpsPercent)}) have an https link, on ${n(REGISTRY.hosts)} host names. The largest host name holds ${n(d.hosts.largest)} of them (${pc(d.hosts.largestPercent)}), which is ${pc(d.hosts.largestOfAllPercent)} of all the registrations. The next holds ${n(d.hosts.second)} (${pc(d.hosts.secondPercent)}) and the third holds ${n(d.hosts.third)}. The two largest together hold ${n(d.hosts.twoLargest)} (${pc(d.hosts.twoLargestPercent)}). ${n(d.hosts.atLeastThreshold)} host names hold ${THRESHOLDS.largeHost} or more registrations, ${n(d.hosts.atLeastThresholdRegistrations)} between them (${pc(d.hosts.atLeastThresholdPercent)} of those with an https link and ${pc(d.hosts.atLeastThresholdOfAllPercent)} of all).`
    );
    expect(doc).toContain(
      `${n(d.links.usedOnce)} of the ${n(d.links.total)} different profile links (${pc(d.links.usedOncePercent)}) are used by one registration each. ${n(d.links.shared)} are used by more than one, by ${n(d.links.sharedRegistrations)} registrations (${pc(d.links.sharedRegistrationsPercent)}). ${n(d.links.big)} links are used by ${THRESHOLDS.bigLink} or more registrations, ${n(d.links.bigRegistrations)} in all (${pc(d.links.bigPercent)}). The largest is used by ${n(d.links.largest)} (${pc(d.links.largestPercent)}), all with an https host name. ${n(REGISTRY.noUriSet)} registrations set no profile link.`
    );
    expect(doc).toContain(
      `${n(d.names.placeholder)} of the ${n(registrations)} registrations (${pc(d.names.placeholderPercent)}) carry the placeholder name. The other ${n(d.names.named)} carry ${n(d.names.distinct)} distinct names, and ${n(d.names.sharing)} registrations (${pc(d.names.sharingPercent)}) share a name with at least one other. ${n(d.names.sharedByTenOrMore)} registrations are in names shared by ${THRESHOLDS.sharedName} or more, and the largest group is ${n(d.names.largestGroup)}.`
    );
    expect(doc).toContain(
      `${n(d.activity.transfers)} transfers after the mint are recorded, on ${n(d.activity.changedHands)} registrations (${pc(d.activity.changedHandsPercent)}). ${n(d.activity.noTransfer)} registrations (${pc(d.activity.noTransferPercent)}) have had none. ${n(d.activity.handouts)} hand-outs are recorded, on ${n(d.activity.handedOut)} registrations (${pc(d.activity.handedOutPercent)}), and the other ${n(d.activity.laterTransfers)} transfers came later than the first hour or from another wallet.`
    );
    expect(doc).toContain(`${n(d.activity.edits)} profile-link edits are recorded, on ${n(d.activity.edited)} registrations (${pc(d.activity.editedPercent)}).`);
    expect(doc).toContain(
      `${n(d.time.busiestMonthRegistrations)} of the registrations (${pc(d.time.busiestMonthPercent)}) were made in ${d.time.busiestMonth}, more than in the ${n(d.time.earlierMonths)} months before it together. In the ${n(d.time.beforeDays)} days before ${d.time.riseFrom} a UTC day had between ${n(d.time.beforeLow)} and ${n(d.time.beforeHigh)} registrations, ${n(d.time.beforeRegistrations)} in all. From ${d.time.riseFrom} every day has had more than any day before it: ${n(d.time.riseFromRegistrations)} on ${d.time.riseFrom}, rising to ${n(d.time.busiestDayRegistrations)} on ${d.time.busiestDay}, which is ${pc(d.time.busiestDayPercent)} of all the registrations in one UTC day. The ${n(d.time.sinceDays)} days from ${d.time.riseFrom} to ${d.time.lastDay} hold ${n(d.time.sinceRegistrations)} registrations (${pc(d.time.sincePercent)}), and ${d.time.lastDay} is part of a day with ${n(d.time.lastDayRegistrations)}.`
    );
  });

  it("defines a hand-out and the dates as the code does, and says what the measurement cannot say", () => {
    const chains = read("..", "..", "..", "server", "ingestion", "erc8004Chains.ts");
    expect(chains).toContain(`handoutBlockWindow: ${CHAIN.handoutBlocks.toLocaleString("en-US").replace(",", "_")},`);
    expect(chains).toContain(`chainId: ${CHAIN.id},`);
    expect(chains).toContain(`deployBlock: ${CHAIN.firstBlock.toLocaleString("en-US").replace(/,/g, "_")},`);
    expect(chains).toContain("2026-02-03 11:08:33 UTC");
    expect(doc).toContain(`(${n(CHAIN.handoutBlocks)} blocks, \`handoutBlockWindow\` in \`server/ingestion/erc8004Chains.ts\`)`);
    expect(doc).toContain(`**UTC day and month**: the date of the mint block, worked out as ${CHAIN.firstBlockTime} UTC (block ${n(CHAIN.firstBlock)}, the registry's first) plus ${CHAIN.blockSeconds} seconds for each block after it.`);
    expect(doc).toContain("## What this measurement cannot say");
    expect(doc).toContain("**It is not a count of people.**");
    expect(doc).toContain("**The registering wallet is not the holder.**");
    expect(doc).toContain("**A hand-out is a timing fact.**");
    expect(doc).toContain("**There are no ratings.**");
    expect(doc).toContain("**The listing rules were not changed.**");
  });

  it("keeps the queries in the repository, all of them reads, with the thresholds the page speaks of", () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT)\b/im);
    expect(sql.match(/^\s*(WITH|SELECT)\b/gim)!.length).toBeGreaterThanOrEqual(14);
    // Every statement that reads the registry's registrations reads the active source of Base's protocol.
    const reads = (sql.match(/FROM agent_directory_registry_rows r/g) ?? []).length;
    expect(reads).toBeGreaterThanOrEqual(13);
    expect(sql.split("s.protocol = 'erc8004_base'").length - 1).toBeGreaterThanOrEqual(reads);
    expect(sql.split("s.state = 'active'").length - 1).toBeGreaterThanOrEqual(reads);
    // The wallet bar is read in queries 3 and 3b and the host bar in query 4b, each as a HAVING on the count.
    expect(sql.split(`HAVING COUNT(*) >= ${THRESHOLDS.largeWallet}`).length - 1).toBeGreaterThanOrEqual(3);
    expect(THRESHOLDS.largeHost).toBe(THRESHOLDS.largeWallet);
    expect(sql).toContain(`WHERE n >= ${THRESHOLDS.sharedName}`);
    // The first rule that reached a registration is worked out in the order, and with the numbers, the listing rules run.
    expect(sql).toContain("WHEN link_n >= 2");
    expect(sql).toContain(`WHEN host_n >= ${THRESHOLDS.largeHost}`);
    expect(sql).toContain(`WHEN wallet_n >= ${THRESHOLDS.tenWallet}`);
    expect(sql.indexOf("WHEN link_n >= 2")).toBeLessThan(sql.indexOf("WHEN host_n >= 50"));
    expect(sql.indexOf("WHEN host_n >= 50")).toBeLessThan(sql.indexOf("WHEN wallet_n >= 10"));
    // The dates are worked out from the mint block with the first block and its time, and the file says so.
    expect(sql).toContain(`TIMESTAMPADD(SECOND, ${CHAIN.blockSeconds} * (r.mintBlock - ${CHAIN.firstBlock}), '${CHAIN.firstBlockTime}')`);
  });

  it("uses the rules the code uses: a link shared by 2, a host by 50, a wallet of 10", () => {
    const rules = read("..", "..", "..", "server", "ingestion", "erc8004Chains.ts");
    expect(rules).toContain("BASE_LISTING_RULES");
    const bsc = read("..", "..", "..", "server", "agentRegistryRows.ts");
    expect(bsc).toContain("sharedProfileLinkFrom: 2,");
    expect(bsc).toContain(`sharedHostFrom: ${THRESHOLDS.largeHost},`);
    expect(bsc).toContain(`sharedWalletFrom: ${THRESHOLDS.tenWallet},`);
    expect(RULES).toEqual({ link: "profile link shared by 2 or more", host: "host shared by 50 or more", wallet: "wallet that registered 10 or more" });
  });
});

describe("what the page says, and does not", () => {
  it("has a section called What this does not show, with the caveats", () => {
    expect(text).toContain("What this does not show");
    for (const caveat of [
      "It is not a count of people. A platform can register many agents under one wallet, and one person can use many wallets.",
      `${n(d.activity.handedOut)} registrations were handed out within about an hour of the mint, so for those the wallet is not the holder.`,
      "It does not say whether an agent runs. Nothing was asked of any address.",
      "A hand-out is a timing fact. It does not say why a registration was sent on or who received it.",
      "A shared link, host name, wallet or name is a recorded fact. It does not say that one person is behind the registrations, or that anything is wrong. A registration the directory holds out is held out as shared, and is not called fake.",
      "It counts the registrations the directory holds. It does not compare that count with a total from the registry itself.",
      "Names and links are written by the registrants. We have not verified them.",
      "It is one moment. Base is read by a scheduled pass and the chain is still adding registrations, so the figures are as of the pass named in the header.",
    ]) {
      expect(text).toContain(caveat);
    }
  });

  it("ends by saying the census is a snapshot to be redone and dated again, and that nothing here changes the listing rules", () => {
    expect(text).toContain("This census is a snapshot. It will be redone and dated again. Whether the listing rules should change for Base is a decision for later, and nothing here changes them.");
    expect(text.indexOf("This census is a snapshot")).toBeGreaterThan(text.indexOf("What this does not show"));
  });

  it("names no host, no wallet and no person, and lists no agent", () => {
    for (const where of [text, markup, pageSource, dataSource, doc, sql]) {
      // An Ethereum address is 0x and 40 hex digits: none is on the page, in the data file, in the document or in the queries.
      expect(where).not.toMatch(/0x[0-9a-fA-F]{40}/);
    }
    for (const where of [text, markup]) expect(where).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/\boperators?\b/i);
    expect(markup).not.toMatch(/href="\/agents\//);
    const hrefs = [...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map(match => match[1]);
    expect(hrefs.filter(href => !["/", "/checker", "/disputes", "/privacy", "/terms", "/contact", "/about"].includes(href!))).toEqual([]);
  });

  it("has no score, no ranking, no tier and no best or top, and no glow", () => {
    expect(text).not.toMatch(/\bscores?\b|\brank\w*|\bleaderboard\b|\bbest\b|\btop\b|\btiers?\b|\bleading\b|\bwinners?\b/i);
    expect(markup).not.toMatch(/glow|shadow|pulse|animate-|gradient|blur/i);
  });

  it("calls nothing fake, safe, trusted or verified, apart from saying a held-out registration is not called fake and that it has not verified what the registrants wrote", () => {
    const unverified = text.replace(/\b(?:have|has) not (?:been )?verified\b/g, "");
    expect(unverified).not.toMatch(/\bsafe\b|\btrusted?\b|\bverified\b|\bguarantee/i);
    // Every use of the word fake is to say that a held-out registration is not called that.
    expect(text.match(/\bfake\b/gi) ?? []).toHaveLength(2);
    expect(text.match(/not called fake/gi) ?? []).toHaveLength(2);
  });

  it("uses no long dash", () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const where of [text, pageSource, dataSource, doc, sql]) expect(where).not.toMatch(dashes);
  });
});

describe("the address", () => {
  it("is a route the app draws only while Base's switch is on, the server answers 200 for then, the sitemap lists then, and the Base tab links to", () => {
    expect(read("..", "App.tsx")).toContain(`{featureOn("chain_base", FEATURES) && <Route path="${ROUTE}" component={BaseRegistryReport} />}`);
    expect(read("..", "..", "..", "server", "clientRoutes.ts")).toContain(`"${ROUTE}"`);
    const sitemap = read("..", "..", "..", "server", "sitemap.ts");
    expect(sitemap).toContain(`"${ROUTE}"`);
    const head = read("..", "..", "..", "server", "routeHead.ts");
    expect(head).toContain(`"${ROUTE}": {`);
    expect(head).toContain('title: "Base registry census, 2026-10-21"');
    // The home tab for Base links to it, and so does the inspector of a group on Base's page.
    expect(read("..", "components", "home", "ChainTabs.tsx")).toContain(`<Link href="${ROUTE}"`);
    expect(CHAIN_GROUP_REPORT.base).toEqual({ href: ROUTE, label: "Base registry census, 21 October 2026" });
    expect(read("ChainExplorer.tsx")).toContain("CHAIN_GROUP_REPORT[chain]");
  });
});
