import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { CHAIN_GROUP_REPORT } from "@/lib/chainExplorerModel";
import { CHAIN, DATING, DERIVED as d, ETHEREUM_DOC, ETHEREUM_SQL, MEASURED, PASS_TIME, PUBLIC, REGISTRY, RULES, THRESHOLDS, formatPercent as pc, percent } from "@/lib/ethereumRegistryReport";
import EthereumRegistryReport from "./EthereumRegistryReport";

/**
 * The Ethereum registry census report states numbers that people will quote, so they are held to their source. The page reads
 * lib/ethereumRegistryReport.ts and nothing else; these render it, check every number on it is one of that file's figures, check each
 * measured row against the document that holds the query output, check the totals add up, and keep the page to the rules the other
 * censuses set: no per-agent rows, no ranking, no score, no tier, no glow, no host, wallet or person named.
 */
const here = import.meta.dirname;
const read = (...parts: string[]) => readFileSync(path.resolve(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const docs = (name: string) => read("..", "..", "..", "docs", name);

const ROUTE = "/field/ethereum-registry-2026-10-28";
const markup = renderToStaticMarkup(createElement(Router, { ssrPath: ROUTE, children: createElement(EthereumRegistryReport) }));
const decode = (value: string) => value.replace(/&rsquo;/g, "’").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
const text = decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pageSource = read("EthereumRegistryReport.tsx");
const dataSource = read("..", "lib", "ethereumRegistryReport.ts");
const doc = docs("ethereum-census-2026-10-28.md");
const sql = docs("ethereum-census-queries-2026-10-28.sql");
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
const q = { q0: MEASURED.q0[0], q0b: MEASURED.q0b[0], q1: MEASURED.q1[0], q3b: MEASURED.q3b[0], q4b: MEASURED.q4b[0], q6: MEASURED.q6[0], q8: MEASURED.q8[0] };
const walletBucket = (name: string) => MEASURED.q2.find(row => row[0] === name)!;
const linkBucket = (name: string) => MEASURED.q5.find(row => row[0] === name)!;
const ledgerKind = (kind: string) => MEASURED.q9.find(row => row[0] === kind)!;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe("the numbers on the page are the numbers in the data file", () => {
  it("has no number that is not a measured value, a derived value, a threshold, a fact about the chain or a label of a size bucket", () => {
    const allowed = new Set([
      ...[...numbersIn(MEASURED), ...numbersIn(d), ...numbersIn(REGISTRY), ...numbersIn(PUBLIC), ...numbersIn(THRESHOLDS), ...numbersIn(CHAIN)].flatMap(written),
      ...labelDigits(MEASURED.q2),
      ...labelDigits(MEASURED.q5),
      ...labelDigits(RULES),
      // A chain id is an identifier and is written as it is, with no thousands separator.
      String(CHAIN.id),
    ]);
    const withoutTokens = text
      .replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, " ") // a UTC month or day, and the date in the header
      .replace(/\b\d{2}:\d{2}(?::\d{2})?\b/g, " ") // a time of day in the header and the two block times
      .replace(/\b8004\b/g, " ") // the standard's name
      .replace(/\b\d+-\d+\b/g, match => match.replace("-", " ")); // a size bucket such as 10-49, whose parts are checked as labels
    const found = (withoutTokens.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(token => token.replace(/,$/, ""));
    expect(found.length).toBeGreaterThan(80);
    const stray = found.filter(token => !allowed.has(token));
    expect(stray, `numbers on the page that are not in lib/ethereumRegistryReport.ts: ${[...new Set(stray)].join(", ")}`).toEqual([]);
  });

  it("writes no figure into the page's own source, which would let it drift from the file", () => {
    const literal = (stripComments(pageSource).match(/\b\d[\d,]{2,}\b/g) ?? []).filter(token => !["2026", "8004"].includes(token));
    expect(literal, "a number written into EthereumRegistryReport.tsx").toEqual([]);
  });

  it("carries the date and the pass it was counted from in its header", () => {
    expect(text).toContain(`Date ${MEASURED.date}`);
    expect(PASS_TIME).toBe("05:00 UTC");
    expect(text).toContain(`Counted from the registry pass that finished at ${PASS_TIME}`);
  });

  it("says what the directory counts on the chain, stores, and leaves out of the stored rows", () => {
    expect(text).toContain(
      `The directory counts ${n(REGISTRY.onChain)} registrations on the chain and has stored ${n(registrations)} of them. A host name that holds more than ${n(CHAIN.hostRowCap)} registrations keeps ${n(CHAIN.hostRowCap)} of them, and the rest are counted and not stored: ${n(REGISTRY.overflow)} registrations, for ${n(d.hosts.pastTheCap)} host names. Every figure below counts the stored registrations, so those ${n(REGISTRY.overflow)} are in none of them.`
    );
  });

  it("states the registry's size and surface in one table, and says one registration is hidden and what that does to the public count", () => {
    expect(text).toContain(
      `What was counted Count Registrations the directory counts on the chain ${n(REGISTRY.onChain)} Registrations the directory has stored ${n(registrations)} Registrations counted past a host's cap and not stored ${n(REGISTRY.overflow)} Registrations the directory lists ${n(REGISTRY.listed)} Registering wallets ${n(REGISTRY.wallets)} Registrations with an https link ${n(REGISTRY.withHttpsHost)} Host names of those links ${n(REGISTRY.hosts)} Different profile links ${n(REGISTRY.profileLinks)}`
    );
    expect(text).toContain(`${n(d.hosts.withoutHost)} registrations (${pc(d.hosts.withoutHostPercent)}) have no https host name recorded, and ${n(REGISTRY.noUriSet)} set no profile link at all.`);
    expect(text).toContain(`${n(REGISTRY.hidden)} registration is hidden. A hidden registration is not counted in any public read, so the public count of listed entries, ${n(PUBLIC.listed)}, is one fewer than the ${n(REGISTRY.listed)} in the table.`);
  });

  it("says what the listing rules did, in one table, with the first rule that reached each registration held out", () => {
    expect(text).toContain(
      `Of the ${n(registrations)} stored registrations, ${n(d.listing.listed)} (${pc(d.listing.listedPercent)}) are listed in the directory, which is ${pc(d.listing.listedOfChainPercent)} of the ${n(REGISTRY.onChain)} the directory counts on the chain. ${n(d.listing.noLink)} (${pc(d.listing.noLinkPercent)}) have no usable profile link. ${n(d.listing.heldOut)} (${pc(d.listing.heldOutPercent)}) are held out as shared, not judged. ${n(d.listing.numberOnly)} carry a name that is only a number, and are not listed.`
    );
    expect(text).toContain(
      `What happened Registrations Listed in the directory ${n(d.listing.listed)} No usable profile link ${n(d.listing.noLink)} Held out first: ${RULES.link} ${n(d.listing.byLink)} Held out first: ${RULES.host} ${n(d.listing.byHost)} Held out first: ${RULES.wallet} ${n(d.listing.byWallet)} A name that is only a number ${n(d.listing.numberOnly)}`
    );
    expect(text).toContain("A rule that reaches a registration first is not the only one that would have.");
    expect(text).toContain(`The host name rule reached ${n(d.listing.byHost)} registrations first, ${pc(d.listing.byHostPercent)} of all of them.`);
    expect(text).toContain("These are the rules written for the BNB Chain registry, and they have not been changed for Ethereum. This census says what they did here. It does not say whether they are right for Ethereum.");
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
      `The two largest host names are at the ${n(CHAIN.hostRowCap)} registrations a host may keep. The directory counted ${n(d.hosts.overflowLargest)} more for the first and ${n(d.hosts.overflowSecond)} more for the second, so they hold ${n(d.hosts.largestHeld)} and ${n(d.hosts.secondHeld)} in all. The ${n(REGISTRY.overflow)} registrations counted and not stored are ${pc(d.hosts.overflowPercent)} of the ${n(REGISTRY.onChain)}, and none of them is listed.`
    );
    expect(text).toContain(
      `${n(d.hosts.atLeastThreshold)} host names hold ${THRESHOLDS.largeHost} or more registrations each. Together they hold ${n(d.hosts.atLeastThresholdRegistrations)} registrations, ${pc(d.hosts.atLeastThresholdPercent)} of those with an https link and ${pc(d.hosts.atLeastThresholdOfAllPercent)} of all of them.`
    );
    expect(text).toContain(
      `${n(d.links.usedOnce)} of the ${n(d.links.total)} different profile links (${pc(d.links.usedOncePercent)}) are used by one registration each. ${n(d.links.shared)} are used by more than one, by ${n(d.links.sharedRegistrations)} registrations in all (${pc(d.links.sharedRegistrationsPercent)}). ${n(d.links.big)} links are used by ${THRESHOLDS.bigLink} or more registrations each, ${n(d.links.bigRegistrations)} registrations in all (${pc(d.links.bigPercent)}). ${n(d.links.inLargestBucket)} of them are in the largest bucket of the table. The largest is used by ${n(d.links.largest)} (${pc(d.links.largestPercent)}), and ${n(d.links.largestWithHost)} of them have an https host name.`
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
      `${n(d.activity.handouts)} hand-outs are recorded, on ${n(d.activity.handedOut)} registrations (${pc(d.activity.handedOutPercent)}). A hand-out is a transfer sent from the wallet the registration was minted to, within about an hour of the mint (${n(CHAIN.handoutBlocks)} blocks on Ethereum). The other ${n(d.activity.laterTransfers)} transfers came later than the first hour or from another wallet.`
    );
    expect(text).toContain(`${n(d.activity.edits)} edits of a profile link are recorded, on ${n(d.activity.edited)} registrations (${pc(d.activity.editedPercent)}).`);
    expect(text).toContain(
      `The date of a registration is worked out from its mint block and the time of a block that is known: the registry's first block, ${n(CHAIN.firstBlock)}, at ${CHAIN.firstBlockTime} UTC for a month, and the finalized block of the day, ${n(CHAIN.recentBlock)}, at ${CHAIN.recentBlockTime} UTC for a day. A block on Ethereum takes ${CHAIN.blockSeconds} seconds when no slot is missed and a little more when one is, so a day is within about ${CHAIN.dayErrorMinutes} minutes and a month within about ${CHAIN.monthErrorMinutes}. ${n(d.time.firstMonthRegistrations)} of the registrations (${pc(d.time.firstMonthPercent)}) were made in ${d.time.firstMonth}, in the first three days of the registry. In each of the ${n(d.time.laterMonths)} months after it a month had between ${n(d.time.laterLow)} and ${n(d.time.laterHigh)} registrations, ${n(d.time.laterMonthsRegistrations)} in all (${pc(d.time.laterMonthsPercent)}).`
    );
    expect(text).toContain(
      `The table of days below starts at ${d.time.firstDay} and ends at ${d.time.lastDay}. Its ${n(d.time.days)} days hold ${n(d.time.daysRegistrations)} registrations (${pc(d.time.daysPercent)}). The busiest day, ${d.time.busiestDay}, has ${n(d.time.busiestDayRegistrations)}, which is ${pc(d.time.busiestDayPercent)} of all the registrations in one UTC day, and the next, ${d.time.nextBusiestDay}, has ${n(d.time.nextBusiestDayRegistrations)}. The other ${n(d.time.otherDays)} days had between ${n(d.time.otherLow)} and ${n(d.time.otherHigh)}. No registration is dated ${d.time.passDay}, the day of the pass named in the header.`
    );
    expect(text).toContain("Ratings are not measured here. The directory keeps a count of the ratings in the reputation registry, shown on the Ethereum tab and in the API, and this census does not use it.");
  });

  it("shows every returned row of the wallet, host, link, month and day tables", () => {
    for (const row of MEASURED.q2) expect(text).toContain(`${row[0]} ${n(row[1])} ${n(row[2])}`);
    const places = ["Largest", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];
    for (const row of MEASURED.q4) expect(text).toContain(`${places[row[0] - 1]} ${n(row[1])}`);
    for (const row of MEASURED.q5) expect(text).toContain(`${row[0]} ${n(row[1])} ${n(row[2])}`);
    for (const row of MEASURED.q10b) expect(text).toContain(`${row[0]} ${n(row[1])}`);
    for (const row of MEASURED.q10a) expect(text).toContain(`${row[0]} ${n(row[1])}`);
  });

  it("says a registry row takes a name only from the chain event, and that a name read from a file is on the entry and not counted here", () => {
    expect(text).toContain("A registry row takes a name only from registration data written into the chain event itself. The directory also reads a name for some listed entries from the file their registration link names. That name is written to the entry and not to the registry row, so it is not counted here.");
    expect(text).toContain("Two registrations with the same name are not necessarily the same agent or the same person.");
  });
});

describe("shares are given to one decimal place", () => {
  it("rounds to the nearest tenth and writes it with one decimal", () => {
    expect(percent(5187, 47434)).toBe(10.9);
    expect(pc(percent(5187, 47434))).toBe("10.9%");
    expect(percent(5187, 55456)).toBe(9.4);
    expect(pc(percent(19922, 47434))).toBe("42.0%");
    expect(pc(percent(1, 3))).toBe("33.3%");
  });
});

describe("the totals add up", () => {
  it("queries 0, 1, 6 and 8 and the mints in query 9 agree on the registrations, and the directory's entries are the listed row of query 7", () => {
    expect(q.q0[0]).toBe(registrations);
    expect(q.q6[0]).toBe(registrations);
    expect(q.q8[0]).toBe(registrations);
    expect(ledgerKind("mint")[1]).toBe(registrations);
    expect(ledgerKind("mint")[2]).toBe(registrations);
    expect(registrations).toBe(47434);
    expect(q.q0[5]).toBe(d.listing.listed);
  });

  it("one registration is hidden, so the public count of listed entries is one fewer than the entries in query 0", () => {
    expect(REGISTRY.hidden).toBe(1);
    expect(PUBLIC.listed).toBe(REGISTRY.listed - REGISTRY.hidden);
  });

  it("the registrations the directory counts on the chain are the stored ones and the ones counted past a host's cap, and the two hosts past it are the two largest", () => {
    expect(REGISTRY.onChain).toBe(registrations + q.q0b[1]);
    expect(REGISTRY.onChain).toBe(55456);
    // The page words the second host's overflow as what is left of the count after the first, so there are exactly two hosts.
    expect(q.q0b[0]).toBe(2);
    expect(q.q0b[2]).toBeLessThan(q.q0b[1]);
    expect(d.hosts.overflowLargest + d.hosts.overflowSecond).toBe(q.q0b[1]);
    expect(CHAIN.hostRowCap).toBe(2000);
    expect(MEASURED.q4[0][1], "a host past the cap keeps exactly the cap").toBe(CHAIN.hostRowCap);
    expect(MEASURED.q4[1][1], "a host past the cap keeps exactly the cap").toBe(CHAIN.hostRowCap);
    expect(MEASURED.q4[2][1]).toBeLessThan(CHAIN.hostRowCap);
    expect(d.hosts.largestHeld).toBe(CHAIN.hostRowCap + q.q0b[2]);
    expect(d.hosts.secondHeld).toBe(CHAIN.hostRowCap + d.hosts.overflowSecond);
    expect(d.hosts.largestHeld).toBeGreaterThan(d.hosts.secondHeld);
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
    expect(d.hosts.largest).toBeGreaterThanOrEqual(d.hosts.second);
  });

  it("profile links add up to the different links and the registrations, and the largest link has an https host on some of its registrations", () => {
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
    expect(d.links.inLargestBucket, "the page counts the links in the largest bucket").toBe(linkBucket("1000+")[1]);
    expect(d.links.largest).toBe(Math.max(linkBucket("50-999")[3], linkBucket("1000+")[3]));
    expect(d.links.largestWithHost, "the page says some, not all, of the largest link's registrations have an https host name").toBeLessThan(d.links.largest);
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

  it("the months and the days add up to the registrations and to each other, and the first month holds more than any later one", () => {
    expect(sum(MEASURED.q10b.map(row => row[1]))).toBe(registrations);
    expect(d.time.months).toBe(MEASURED.q10b.length);
    expect(d.time.firstMonth).toBe(MEASURED.q10b[0]![0]);
    expect(d.time.laterMonths + 1).toBe(d.time.months);
    expect(d.time.firstMonthRegistrations + d.time.laterMonthsRegistrations).toBe(registrations);
    expect(d.time.firstMonthRegistrations, "the page says the registry's first month had the most").toBeGreaterThan(d.time.laterHigh);
    expect(d.time.laterLow).toBeLessThan(d.time.laterHigh);
    // The first month is the month of the registry's first block, and a month of the table starts at it.
    expect(d.time.firstMonth).toBe(CHAIN.firstBlockTime.slice(0, 7));
    // Query 10a's days all fall in the last month, so they cannot add up to more than it, and they are in order.
    for (const row of MEASURED.q10a) expect(row[0].startsWith(d.time.lastMonth)).toBe(true);
    expect(sum(MEASURED.q10a.map(row => row[1]))).toBeLessThanOrEqual(MEASURED.q10b[MEASURED.q10b.length - 1]![1]);
    const sorted = [...MEASURED.q10a].map(row => row[0]);
    expect(sorted).toEqual([...sorted].sort());
    expect(d.time.otherDays + 2).toBe(d.time.days);
    expect(d.time.busiestDayRegistrations).toBe(Math.max(...MEASURED.q10a.map(row => row[1])));
    expect(d.time.nextBusiestDayRegistrations).toBeLessThanOrEqual(d.time.busiestDayRegistrations);
    expect(d.time.otherHigh, "the other days are each smaller than the two the page names").toBeLessThan(d.time.nextBusiestDayRegistrations);
    // The pass the census is counted from ran on the day after the last day with a registration, so the page says none is dated that day.
    expect(d.time.passDay).toBe(q.q0[4].slice(0, 10));
    expect(d.time.passDay).toBe(MEASURED.date);
    expect(d.time.lastDay < d.time.passDay).toBe(true);
    expect(q.q0[4].slice(11, 13)).toBe("05");
  });
});

describe("each measured row is in the measurement document", () => {
  const row = (cells: ReadonlyArray<string | number>) => `| ${cells.join(" | ")} |`;

  it("names itself, and says what was and was not selected and fetched", () => {
    expect(ETHEREUM_DOC).toBe("docs/ethereum-census-2026-10-28.md");
    expect(ETHEREUM_SQL).toBe("docs/ethereum-census-queries-2026-10-28.sql");
    expect(doc).toContain("no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it");
    expect(doc).toContain("Every statement is a read-only SELECT.");
  });

  const TABLES: Array<[string, ReadonlyArray<ReadonlyArray<string | number>>]> = [
    ["query 0", MEASURED.q0],
    ["query 0b", MEASURED.q0b],
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
      `${n(d.listing.listed)} of the ${n(registrations)} registrations (${pc(d.listing.listedPercent)}) are listed, which is ${pc(d.listing.listedOfChainPercent)} of the ${n(REGISTRY.onChain)} the directory counts on the chain. ${n(d.listing.noLink)} (${pc(d.listing.noLinkPercent)}) have no usable profile link. ${n(d.listing.heldOut)} (${pc(d.listing.heldOutPercent)}) are held out as shared: ${n(d.listing.byLink)} reached first by a shared profile link, ${n(d.listing.byHost)} by a shared host name and ${n(d.listing.byWallet)} by a wallet that registered ${THRESHOLDS.tenWallet} or more. ${n(d.listing.numberOnly)} carry a name that is only a number.`
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
      `The two largest host names are at the ${n(CHAIN.hostRowCap)} rows a host may keep. Query 0b counts ${n(d.hosts.overflowLargest)} more registrations for the first and ${n(d.hosts.overflowSecond)} more for the second, so they hold ${n(d.hosts.largestHeld)} and ${n(d.hosts.secondHeld)} in all. The ${n(REGISTRY.overflow)} are ${pc(d.hosts.overflowPercent)} of the ${n(REGISTRY.onChain)}.`
    );
    expect(doc).toContain(
      `${n(d.links.usedOnce)} of the ${n(d.links.total)} different profile links (${pc(d.links.usedOncePercent)}) are used by one registration each. ${n(d.links.shared)} are used by more than one, by ${n(d.links.sharedRegistrations)} registrations (${pc(d.links.sharedRegistrationsPercent)}). ${n(d.links.big)} links are used by ${THRESHOLDS.bigLink} or more registrations, ${n(d.links.bigRegistrations)} in all (${pc(d.links.bigPercent)}). ${n(d.links.inLargestBucket)} of them are used by 1,000 or more. The largest is used by ${n(d.links.largest)} (${pc(d.links.largestPercent)}), and ${n(d.links.largestWithHost)} of them have an https host name. ${n(REGISTRY.noUriSet)} registrations set no profile link.`
    );
    expect(doc).toContain(
      `${n(d.names.placeholder)} of the ${n(registrations)} registrations (${pc(d.names.placeholderPercent)}) carry the placeholder name. The other ${n(d.names.named)} carry ${n(d.names.distinct)} distinct names, and ${n(d.names.sharing)} registrations (${pc(d.names.sharingPercent)}) share a name with at least one other. ${n(d.names.sharedByTenOrMore)} registrations are in names shared by ${THRESHOLDS.sharedName} or more, and the largest group is ${n(d.names.largestGroup)}.`
    );
    expect(doc).toContain(
      `${n(d.activity.transfers)} transfers after the mint are recorded, on ${n(d.activity.changedHands)} registrations (${pc(d.activity.changedHandsPercent)}). ${n(d.activity.noTransfer)} registrations (${pc(d.activity.noTransferPercent)}) have had none. ${n(d.activity.handouts)} hand-outs are recorded, on ${n(d.activity.handedOut)} registrations (${pc(d.activity.handedOutPercent)}), and the other ${n(d.activity.laterTransfers)} transfers came later than the first hour or from another wallet.`
    );
    expect(doc).toContain(`${n(d.activity.edits)} profile-link edits are recorded, on ${n(d.activity.edited)} registrations (${pc(d.activity.editedPercent)}).`);
    expect(doc).toContain(
      `${n(d.time.firstMonthRegistrations)} of the registrations (${pc(d.time.firstMonthPercent)}) were made in ${d.time.firstMonth}, in the first three days of the registry. In each of the ${n(d.time.laterMonths)} months after it a month had between ${n(d.time.laterLow)} and ${n(d.time.laterHigh)} registrations, ${n(d.time.laterMonthsRegistrations)} in all (${pc(d.time.laterMonthsPercent)}). The ${n(d.time.days)} days from ${d.time.firstDay} to ${d.time.lastDay} hold ${n(d.time.daysRegistrations)} registrations (${pc(d.time.daysPercent)}). The busiest, ${d.time.busiestDay}, has ${n(d.time.busiestDayRegistrations)} (${pc(d.time.busiestDayPercent)} of all the registrations) and the next, ${d.time.nextBusiestDay}, has ${n(d.time.nextBusiestDayRegistrations)}. The other ${n(d.time.otherDays)} days had between ${n(d.time.otherLow)} and ${n(d.time.otherHigh)}. No registration is dated ${d.time.passDay}, the day of the pass.`
    );
  });

  it("states the figures that are not from the queries, with their source", () => {
    expect(doc).toContain("## Figures that are not from the queries");
    expect(doc).toContain(`${n(PUBLIC.listed)}, the public count of listed entries, read from \`GET /api/v1/stats\` on 2026-10-28 at 17:24 UTC.`);
    expect(doc).toContain(`The two block times (${n(CHAIN.firstBlock)} at ${CHAIN.firstBlockTime} UTC and ${n(CHAIN.recentBlock)} at ${CHAIN.recentBlockTime} UTC)`);
  });

  it("defines a hand-out, the cap and the dates as the code does, and says what the measurement cannot say", () => {
    const chains = read("..", "..", "..", "server", "ingestion", "erc8004Chains.ts");
    expect(chains).toContain(`handoutBlockWindow: ${CHAIN.handoutBlocks},`);
    expect(chains).toContain(`chainId: ${CHAIN.id},`);
    expect(chains).toContain(`deployBlock: ${CHAIN.firstBlock.toLocaleString("en-US").replace(/,/g, "_")},`);
    expect(chains).toContain(`${CHAIN.firstBlockTime} UTC`);
    expect(chains).toContain(`export const FLOOD_HOST_ROW_CAP = ${CHAIN.hostRowCap.toLocaleString("en-US").replace(/,/g, "_")};`);
    expect(doc).toContain(`(${n(CHAIN.handoutBlocks)} blocks, \`handoutBlockWindow\` in \`server/ingestion/erc8004Chains.ts\`)`);
    expect(doc).toContain(`For a day it is ${CHAIN.recentBlockTime} UTC (block ${n(CHAIN.recentBlock)}, the finalized block of the day) less ${DATING.daySeconds} seconds for each block before it`);
    expect(doc).toContain(`For a month it is ${CHAIN.firstBlockTime} UTC (block ${n(CHAIN.firstBlock)}, the registry's first) plus ${DATING.monthSeconds} seconds for each block after it`);
    expect(doc).toContain(`A day is within about ${CHAIN.dayErrorMinutes} minutes of the real time and a month within about ${CHAIN.monthErrorMinutes}`);
    expect(doc).toContain("## What this measurement cannot say");
    expect(doc).toContain("**It is not a count of people.**");
    expect(doc).toContain("**The registering wallet is not the holder.**");
    expect(doc).toContain("**A hand-out is a timing fact.**");
    expect(doc).toContain("**Ratings are not measured here.**");
    expect(doc).toContain("**The dates are worked out.**");
    expect(doc).toContain("**The listing rules were not changed.**");
  });

  it("keeps the queries in the repository, all of them reads, with the thresholds the page speaks of", () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT)\b/im);
    expect(sql.match(/^\s*(WITH|SELECT)\b/gim)!.length).toBeGreaterThanOrEqual(15);
    // Every statement that reads the registry's registrations reads the active source of Ethereum's protocol.
    const reads = (sql.match(/FROM agent_directory_registry_rows r/g) ?? []).length;
    expect(reads).toBeGreaterThanOrEqual(13);
    expect(sql.split("s.protocol = 'erc8004_eth'").length - 1).toBeGreaterThanOrEqual(reads);
    expect(sql.split("s.state = 'active'").length - 1).toBeGreaterThanOrEqual(reads);
    // Query 0b reads the cap's overflow counts of the same source.
    expect(sql).toContain("FROM agent_directory_registry_overflow o");
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
    // The dates are worked out from the mint block with a block and its time, cast first because the column is unsigned, and the file says so.
    expect(sql).toContain(`TIMESTAMPADD(SECOND, ROUND(${DATING.daySeconds} * (CAST(r.mintBlock AS SIGNED) - ${CHAIN.recentBlock})), '${CHAIN.recentBlockTime}')`);
    expect(sql).toContain(`TIMESTAMPADD(SECOND, ROUND(${DATING.monthSeconds} * (CAST(r.mintBlock AS SIGNED) - ${CHAIN.firstBlock})), '${CHAIN.firstBlockTime}')`);
    expect(sql).toContain("mintBlock is unsigned, so it is cast before the subtraction");
  });

  it("uses the rules the code uses: a link shared by 2, a host by 50, a wallet of 10", () => {
    const rules = read("..", "..", "..", "server", "ingestion", "erc8004Chains.ts");
    expect(rules).toContain("ETHEREUM_LISTING_RULES");
    expect(rules).toContain("export const ETHEREUM_LISTING_RULES: RegistryListingRules = { sharedProfileLinkFrom: 2, sharedHostFrom: 50, sharedWalletFrom: 10 };");
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
      `It counts the registrations the directory has stored, ${n(registrations)} of the ${n(REGISTRY.onChain)} it counts on the chain. The other ${n(REGISTRY.overflow)} were counted past a host's cap and are in no figure here but their count. It does not compare either count with a total from the registry itself.`,
      "Names and links are written by the registrants. We have not verified them.",
      "A date is worked out from a block time, within the margins given above, and is not a clock the chain keeps for the registration.",
      "It is one moment. Ethereum is read by a scheduled pass once a day and the chain is still adding registrations, so the figures are as of the pass named in the header.",
    ]) {
      expect(text).toContain(caveat);
    }
  });

  it("ends by saying the census is a snapshot to be redone and dated again, and that nothing here changes the listing rules", () => {
    expect(text).toContain("This census is a snapshot. It will be redone and dated again. Whether the listing rules should change for Ethereum is a decision for later, and nothing here changes them.");
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
  it("is a route the app draws only while Ethereum's switch is on, the server answers 200 for then, the sitemap lists then, and the Ethereum tab links to", () => {
    expect(read("..", "App.tsx")).toContain(`{featureOn("chain_ethereum", FEATURES) && <Route path="${ROUTE}" component={EthereumRegistryReport} />}`);
    expect(read("..", "..", "..", "server", "clientRoutes.ts")).toContain(`"${ROUTE}"`);
    const sitemap = read("..", "..", "..", "server", "sitemap.ts");
    expect(sitemap).toContain(`"${ROUTE}"`);
    const head = read("..", "..", "..", "server", "routeHead.ts");
    expect(head).toContain(`"${ROUTE}": {`);
    expect(head).toContain('title: "Ethereum registry census, 2026-10-28"');
    // The home tab for Ethereum links to it, and so does the inspector of a group on Ethereum's page.
    expect(read("..", "components", "home", "ChainTabs.tsx")).toContain(`<Link href="${ROUTE}"`);
    expect(CHAIN_GROUP_REPORT.ethereum).toEqual({ href: ROUTE, label: "Ethereum registry census, 28 October 2026" });
    expect(read("ChainExplorer.tsx")).toContain("CHAIN_GROUP_REPORT[chain]");
    // The line under the map links it beside the Ethereum lights.
    expect(read("home", "LandingHero.tsx")).toContain(`<Link href="${ROUTE}"`);
  });
});
