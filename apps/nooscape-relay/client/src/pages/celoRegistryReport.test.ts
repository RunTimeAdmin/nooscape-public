import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { CHAIN_GROUP_REPORT } from "@/lib/chainExplorerModel";
import { CELO_DOC, CELO_SQL, CHAIN, DERIVED as d, MEASURED, PASS_TIME, PUBLIC, REGISTRY, RULES, THRESHOLDS, formatPercent as pc, percent } from "@/lib/celoRegistryReport";
import CeloRegistryReport from "./CeloRegistryReport";

/**
 * The Celo registry census report states numbers that people will quote, so they are held to their source. The page reads
 * lib/celoRegistryReport.ts and nothing else; these render it, check every number on it is one of that file's figures, check each
 * measured row against the document that holds the query output, check the totals add up, and keep the page to the rules the other
 * censuses set: no per-agent rows, no ranking, no score, no tier, no glow, no host, wallet or person named.
 *
 * Celo's figures differ from Gnosis's in ways the words of the page depend on, so the facts each of those sentences rests on are
 * pinned here too: two wallets in the largest bucket and six that reach 50; no host name past the cap; four host names that reach 50;
 * no profile link used by 50 or more; one name shared by 10 or more; registrations edited more often than not; no month with none; and
 * blocks that are exactly one second apart, so a date is exact and the day of the pass is the day of the newest registration.
 */
const here = import.meta.dirname;
const read = (...parts: string[]) => readFileSync(path.resolve(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const docs = (name: string) => read("..", "..", "..", "docs", name);

const ROUTE = "/field/celo-registry-2026-11-20";
const markup = renderToStaticMarkup(createElement(Router, { ssrPath: ROUTE, children: createElement(CeloRegistryReport) }));
const decode = (value: string) => value.replace(/&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pageSource = read("CeloRegistryReport.tsx");
const dataSource = read("..", "lib", "celoRegistryReport.ts");
const doc = docs("celo-census-2026-11-20.md");
const sql = docs("celo-census-queries-2026-11-20.sql");
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
const ledgerKind = (kind: string) => MEASURED.q9.find(row => row[0] === kind)!;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
/** Whole days from one UTC date to another, both written YYYY-MM-DD. */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/** A UTC time as the queries write it, plus whole seconds, as the one-second rule of the queries dates a block. */
const datedAt = (block: number) => new Date(Date.parse(`${CHAIN.firstBlockTime.replace(" ", "T")}Z`) + (block - CHAIN.firstBlock) * CHAIN.blockSeconds * 1000).toISOString().replace("T", " ").slice(0, 19);

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
      .replace(/\b\d{2}:\d{2}(?::\d{2})?\b/g, " ") // a time of day in the header and the first block's time
      .replace(/\b8004\b/g, " ") // the standard's name
      .replace(/\b\d+-\d+\b/g, match => match.replace("-", " ")); // a size bucket such as 10-49, whose parts are checked as labels
    const found = (withoutTokens.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(token => token.replace(/,$/, ""));
    expect(found.length).toBeGreaterThan(80);
    const stray = found.filter(token => !allowed.has(token));
    expect(stray, `numbers on the page that are not in lib/celoRegistryReport.ts: ${[...new Set(stray)].join(", ")}`).toEqual([]);
  });

  it("writes no figure into the page's own source, which would let it drift from the file", () => {
    const literal = (stripComments(pageSource).match(/\b\d[\d,]{2,}\b/g) ?? []).filter(token => !["2026", "8004"].includes(token));
    expect(literal, "a number written into CeloRegistryReport.tsx").toEqual([]);
  });

  it("has every figure a finite number: a least or a most of an empty list does not leave an Infinity or a NaN", () => {
    for (const [name, source] of Object.entries({ MEASURED, DERIVED: d, REGISTRY, PUBLIC, THRESHOLDS, CHAIN })) {
      const numbers = numbersIn(source);
      expect(numbers.length, name).toBeGreaterThan(0);
      for (const value of numbers) expect(Number.isFinite(value), `${name} holds ${value}`).toBe(true);
    }
    expect(text).not.toMatch(/Infinity|NaN|undefined|null/);
  });

  it("carries the date and the pass it was counted from in its header", () => {
    expect(text).toContain(`Date ${MEASURED.date}`);
    // The page's own title carries the same date.
    expect(pageSource).toContain(`title="Celo registry census, ${MEASURED.date}"`);
    expect(PASS_TIME).toBe("19:03 UTC");
    expect(text).toContain(`Counted from the registry pass that finished at ${PASS_TIME}`);
    expect(CELO_DOC).toBe("docs/celo-census-2026-11-20.md");
    expect(CELO_SQL).toBe("docs/celo-census-queries-2026-11-20.sql");
  });

  it("says the pass it was counted from was the first over the whole history and was started by hand, and that the figures are one moment", () => {
    expect(text).toContain("which was the first to read the registry's whole history and was started by hand.");
    expect(text).toContain("It is one moment. The chain is still adding registrations, so the figures are as of the pass named in the header.");
  });

  it("says what the directory counts on the chain, stores, and leaves out of the stored rows", () => {
    expect(text).toContain(
      `The directory counts ${n(REGISTRY.onChain)} registrations on the chain and has stored ${n(registrations)} of them. A host name that holds more than ${n(CHAIN.hostRowCap)} registrations keeps its first ${n(CHAIN.hostRowCap)}, in the order they were made on the chain, and the rest are counted and not stored. No host name on Celo is past that cap: ${n(d.hosts.pastTheCap)} host names, ${n(REGISTRY.overflow)} registrations counted and not stored. Every figure below counts all ${n(REGISTRY.onChain)}.`
    );
  });

  it("states the registry's size and surface in one table, and says none is hidden and what the public counts are", () => {
    expect(text).toContain(
      `What was counted Count Registrations the directory counts on the chain ${n(REGISTRY.onChain)} Registrations the directory has stored ${n(registrations)} Registrations counted past a host's cap and not stored ${n(REGISTRY.overflow)} Registrations the directory lists ${n(REGISTRY.listed)} Registering wallets ${n(REGISTRY.wallets)} Registrations with an https link ${n(REGISTRY.withHttpsHost)} Host names of those links ${n(REGISTRY.hosts)} Different profile links ${n(REGISTRY.profileLinks)}`
    );
    expect(text).toContain(`${n(d.hosts.withoutHost)} registrations (${pc(d.hosts.withoutHostPercent)}) have no https host name recorded, and ${n(REGISTRY.noUriSet)} set no profile link at all.`);
    expect(text).toContain(
      `No registration is hidden, so the public count of listed entries, ${n(PUBLIC.listed)}, is the same as the ${n(REGISTRY.listed)} in the table. No registration was counted past a host's cap, so the public count of registrations on the chain, ${n(PUBLIC.onChain)}, is the ${n(registrations)} stored.`
    );
  });

  it("says what the listing rules did, in one table, with the first rule that reached each registration held out", () => {
    expect(text).toContain(
      `Of the ${n(registrations)} stored registrations, ${n(d.listing.listed)} (${pc(d.listing.listedPercent)}) are listed in the directory. ${n(d.listing.noLink)} (${pc(d.listing.noLinkPercent)}) have no usable profile link. ${n(d.listing.heldOut)} (${pc(d.listing.heldOutPercent)}) are held out as shared, not judged. No registration carries a name that is only a number.`
    );
    expect(text).toContain(
      `What happened Registrations Listed in the directory ${n(d.listing.listed)} No usable profile link ${n(d.listing.noLink)} Held out first: ${RULES.link} ${n(d.listing.byLink)} Held out first: ${RULES.host} ${n(d.listing.byHost)} Held out first: ${RULES.wallet} ${n(d.listing.byWallet)} A name that is only a number ${n(d.listing.numberOnly)}`
    );
    expect(text).toContain(
      `The profile link rule reached ${n(d.listing.byLink)} registrations first (${pc(d.listing.byLinkPercent)} of all of them), the host name rule reached ${n(d.listing.byHost)} (${pc(d.listing.byHostPercent)}), and the wallet rule reached ${n(d.listing.byWallet)} (${pc(d.listing.byWalletPercent)}).`
    );
    expect(text).toContain("These are the rules written for the BNB Chain registry, and they have not been changed for Celo. This census says what they did here. It does not say whether they are right for Celo.");
  });

  it("has the findings as sentences, with the denominator stated", () => {
    expect(text).toContain(
      `${n(d.wallets.tenOrMore)} wallets each registered ${THRESHOLDS.tenWallet} or more. Together they made ${n(d.wallets.tenOrMoreRegistrations)} of the ${n(registrations)} registrations (${pc(d.wallets.tenOrMorePercent)}). ${n(d.wallets.large)} of them registered ${THRESHOLDS.largeWallet} or more, and made ${n(d.wallets.largeRegistrations)} of the ${n(registrations)} (${pc(d.wallets.largePercent)}).`
    );
    expect(text).toContain(
      `The largest bucket, ${d.wallets.topBucket}, holds two wallets, which between them made ${n(d.wallets.topBucketRegistrations)} (${pc(d.wallets.topBucketPercent)}). The largest made ${n(d.wallets.largest)} (${pc(d.wallets.largestPercent)}), and the other ${n(d.wallets.topBucketRegistrations - d.wallets.largest)}. The other ${n(d.wallets.midLargeWallets)} wallets that registered ${THRESHOLDS.largeWallet} or more made ${n(d.wallets.midLargeRegistrations)} between them, and no wallet outside that bucket made more than ${n(d.wallets.nextLargest)}.`
    );
    expect(text).toContain(
      `${n(d.wallets.withOne)} of the ${n(REGISTRY.wallets)} wallets (${pc(d.wallets.withOnePercent)}) registered one each. Together they made ${n(d.wallets.withOneRegistrations)} registrations (${pc(d.wallets.withOneRegistrationsPercent)}).`
    );
    expect(text).toContain(
      `Of the ${n(d.wallets.large)} wallets that registered ${THRESHOLDS.largeWallet} or more, ${n(d.largeWallets.withoutAHost)} made no registration with an https link, and between them they made ${n(d.largeWallets.withoutAHostRegistrations)}. ${n(d.largeWallets.ownLinkEach)} of the ${n(d.wallets.large)} gave every registration a profile link of its own. The large wallets made ${n(d.largeWallets.withHttpsHost)} registrations with an https link between them, and ${n(d.largeWallets.onTheirLargestHost)} of those are on the host name that is the largest for the wallet that made them.`
    );
    expect(text).toContain(
      `${n(d.hosts.withHttps)} of the ${n(registrations)} registrations (${pc(d.hosts.withHttpsPercent)}) have an https link, spread over ${n(REGISTRY.hosts)} host names, the ten largest of them in the table below. One host name holds ${n(d.hosts.largest)} of them (${pc(d.hosts.largestPercent)}), which is ${pc(d.hosts.largestOfAllPercent)} of all the registrations. The next holds ${n(d.hosts.second)} (${pc(d.hosts.secondPercent)}), the third ${n(d.hosts.third)} and the fourth ${n(d.hosts.fourth)}.`
    );
    expect(text).toContain(
      `${n(d.hosts.atLeastThreshold)} host names hold ${THRESHOLDS.largeHost} or more registrations. They hold ${n(d.hosts.atLeastThresholdRegistrations)} between them, ${pc(d.hosts.atLeastThresholdPercent)} of those with an https link and ${pc(d.hosts.atLeastThresholdOfAllPercent)} of all of them. No host name is past the ${n(CHAIN.hostRowCap)} registrations a host may keep, so each of these figures is a host name's whole size.`
    );
    expect(text).toContain(
      `${n(d.links.usedOnce)} of the ${n(d.links.total)} different profile links (${pc(d.links.usedOncePercent)}) are used by one registration each. ${n(d.links.shared)} are used by more than one, by ${n(d.links.sharedRegistrations)} registrations in all (${pc(d.links.sharedRegistrationsPercent)}). No profile link is used by ${THRESHOLDS.bigLink} or more registrations. The most any one link has is ${n(d.links.largest)} (${pc(d.links.largestPercent)} of all the registrations).`
    );
    expect(text).toContain(
      `${n(d.names.placeholder)} of the ${n(registrations)} registrations (${pc(d.names.placeholderPercent)}) have no name of their own. They carry the placeholder the directory gives a registration that has none: the word Agent and its number. The other ${n(d.names.named)} carry ${n(d.names.distinct)} distinct names, and ${n(d.names.sharing)} registrations (${pc(d.names.sharingPercent)}) share a name with at least one other. One name is shared by ${n(d.names.largestGroup)} registrations, and no other name is shared by ${THRESHOLDS.sharedName} or more.`
    );
    expect(text).toContain(`${n(d.activity.transfers)} transfers after the mint are recorded, on ${n(d.activity.changedHands)} registrations (${pc(d.activity.changedHandsPercent)}). ${n(d.activity.noTransfer)} registrations (${pc(d.activity.noTransferPercent)}) have had none.`);
    expect(text).toContain(
      `${n(d.activity.handouts)} hand-outs are recorded, on ${n(d.activity.handedOut)} registrations (${pc(d.activity.handedOutPercent)}). A hand-out is a transfer sent from the wallet the registration was minted to, within about an hour of the mint (${n(CHAIN.handoutBlocks)} blocks on Celo). The other ${n(d.activity.laterTransfers)} transfers came later than the first hour or from another wallet.`
    );
    expect(text).toContain(`${n(d.activity.edits)} edits of a profile link are recorded, on ${n(d.activity.edited)} registrations (${pc(d.activity.editedPercent)}). Most registrations on Celo had their profile link edited after the mint.`);
  });

  it("words the dates for Celo: one rule at one second a block, checked against the logs, so a date is exact", () => {
    expect(text).toContain(
      `Blocks on Celo are exactly ${n(CHAIN.blockSeconds)} second apart, so the date is the time of the registry's first block, ${n(CHAIN.firstBlock)}, at ${CHAIN.firstBlockTime} UTC, plus the blocks since as seconds.`
    );
    expect(text).toContain(
      `The rule was checked against the block times in the logs of ${n(CHAIN.dateChecked)} distinct blocks, from block ${n(CHAIN.checkedFirstBlock)} to block ${n(CHAIN.checkedLastBlock)}, and no block's time differed from it by even a second, so a date is exact.`
    );
  });

  it("words the months: the first month, the busiest, the whole months after it and the month of the pass", () => {
    expect(text).toContain(
      `${n(d.time.firstMonthRegistrations)} of the registrations (${pc(d.time.firstMonthPercent)}) were made in ${d.time.firstMonth}, the registry's first month. The registry began on ${CHAIN.firstBlockTime.slice(0, 10)}, so ${d.time.firstMonth} is not a whole month of it. ${d.time.busiestMonth} was the busiest month, with ${n(d.time.busiestMonthRegistrations)} registrations (${pc(d.time.busiestMonthPercent)}). Of the ${n(d.time.wholeLaterMonths)} whole months after the first, ${n(d.time.laterMonths)} have a registration, between ${n(d.time.laterLow)} and ${n(d.time.laterHigh)} each and ${n(d.time.laterMonthsRegistrations)} in all (${pc(d.time.laterMonthsPercent)}), and ${n(d.time.monthsWithNoneCount)} have none. ${d.time.passMonth}, the month of the pass, has ${n(d.time.passMonthRegistrations)} so far.`
    );
  });

  it("words the days, in a window that ends on the newest registration's day, which is the day of the pass", () => {
    expect(text).toContain(
      `${n(d.time.days)} days have one, between ${n(d.time.dayLeast)} and ${n(d.time.dayMost)} each and ${n(d.time.daysRegistrations)} in all (${pc(d.time.daysPercent)} of the registrations), and the other ${n(d.time.daysWithNone)} days had none. The day of the pass named in the header is ${d.time.passDay}, the same day as the newest stored registration.`
    );
    expect(text).toContain(`among the ${n(CHAIN.dayWindow)} days that end on ${d.time.lastDay}, the day of the newest stored registration.`);
  });

  it("says ratings are not measured here", () => {
    expect(text).toContain(
      "Ratings are not measured here. The directory also reads the reputation registry for a count of ratings, which the Celo tab and the API show once it has read the registry's whole history. This census does not use it."
    );
  });

  it("shows every returned row of the wallet, host, link, month and day tables", () => {
    for (const row of MEASURED.q2) expect(text).toContain(`${row[0]} ${n(row[1])} ${n(row[2])}`);
    for (const row of MEASURED.q4) expect(text).toContain(`${["Largest", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"][row[0] - 1]} ${n(row[1])}`);
    for (const row of MEASURED.q5) expect(text).toContain(`${row[0]} ${n(row[1])} ${n(row[2])}`);
    for (const row of MEASURED.q10b) expect(text).toContain(`${row[0]} ${n(row[1])}`);
    for (const row of MEASURED.q10a) expect(text).toContain(`${row[0]} ${n(row[1])}`);
  });

  it("says a registry row takes a name only from the chain event, and that a name read from a file is on the entry and not counted here", () => {
    expect(text).toContain("A registry row takes a name only from registration data written into the chain event itself.");
    expect(text).toContain("That name is written to the entry and not to the registry row, so it is not counted here.");
  });
});

describe("the facts the words of the page rest on", () => {
  it("has two wallets in the largest bucket, six that reach 50, and four of those that are not in it", () => {
    expect(d.wallets.topBucket).toBe("1000+");
    expect(d.wallets.topBucketWallets).toBe(2);
    expect(d.wallets.large).toBe(6);
    expect(d.wallets.midLargeWallets).toBe(4);
    expect(d.wallets.largest).toBe(Math.max(...MEASURED.q3.map(row => row[1])));
    expect(d.wallets.nextLargest).toBe(105);
  });

  it("has no host name past the cap, four that reach 50, and no profile link used by 50 or more", () => {
    expect(q.q0b).toEqual([0, 0, 0]);
    expect(REGISTRY.overflow).toBe(0);
    expect(d.hosts.pastTheCap).toBe(0);
    expect(MEASURED.q4[0]![1]).toBeLessThan(CHAIN.hostRowCap);
    expect(d.hosts.atLeastThreshold).toBe(4);
    expect(d.links.big).toBe(0);
    expect(d.links.largest).toBeLessThan(THRESHOLDS.bigLink);
  });

  it("has one name shared by 10 or more, no registration named by a number alone, and edits on more than half the registrations", () => {
    expect(d.names.sharedByTenOrMore).toBe(d.names.largestGroup);
    expect(d.names.largestGroup).toBeGreaterThanOrEqual(THRESHOLDS.sharedName);
    expect(d.listing.numberOnly).toBe(0);
    expect(MEASURED.q7.map(row => row[0])).toEqual([0, 1, 2, 2, 2]);
    expect(d.activity.editedPercent).toBeGreaterThan(50);
  });

  it("has no month with none, whole months that are all the months between the first and the month of the pass, and the day of the pass the newest registration's", () => {
    expect(d.time.monthsWithNoneCount).toBe(0);
    expect(d.time.laterMonths).toBe(d.time.wholeLaterMonths);
    expect(d.time.passMonth).toBe(MEASURED.q10b[MEASURED.q10b.length - 1]![0]);
    expect(d.time.daysBeforeThePass).toBe(0);
    expect(d.time.lastDay).toBe(d.time.passDay);
    expect(CHAIN.blockSeconds).toBe(1);
    expect(CHAIN.dateErrorSeconds).toBe(0);
  });
});

describe("shares are given to one decimal place", () => {
  it("rounds to the nearest tenth and writes it with one decimal", () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(2, 3)).toBe(66.7);
    expect(percent(1, 2)).toBe(50);
    expect(pc(percent(1, 2))).toBe("50.0%");
    expect(pc(percent(517, 10_080))).toBe("5.1%");
  });
});

describe("the totals add up", () => {
  it("queries 0, 1, 6 and 8 and the mints in query 9 agree on the registrations, and the directory's entries are the listed row of query 7", () => {
    const mint = ledgerKind("mint");
    expect(new Set([q.q0[0], q.q1[0], q.q6[0], q.q8[0], mint[1], mint[2]]).size).toBe(1);
    expect(q.q0[5]).toBe(MEASURED.q7.find(row => row[0] === 1)![3]);
    expect(q.q0[1]).toBe(0);
  });

  it("no registration is hidden or counted past a cap, so the public counts are the table's", () => {
    expect(PUBLIC.listed).toBe(REGISTRY.listed);
    expect(PUBLIC.onChain).toBe(registrations + REGISTRY.overflow);
    expect(REGISTRY.onChain).toBe(PUBLIC.onChain);
  });

  it("every registration has a wallet, and every one was measured by the activity walk", () => {
    expect(q.q1[2]).toBe(0);
    expect(q.q1[7]).toBe(registrations);
    expect(q.q8[1]).toBe(registrations);
    expect(q.q8[2]).toBe(registrations);
  });

  it("wallet buckets add up to the wallets and the registrations, and the buckets that reach 50 are query 3b's wallets", () => {
    expect(sum(MEASURED.q2.map(row => row[1]))).toBe(REGISTRY.wallets);
    expect(sum(MEASURED.q2.map(row => row[2]))).toBe(registrations);
    const reaching = MEASURED.q2.filter(row => row[0] === "50-99" || row[0] === "100-999" || row[0] === "1000+");
    expect(q.q3b[0]).toBe(sum(reaching.map(row => row[1])));
    expect(q.q3b[1]).toBe(sum(reaching.map(row => row[2])));
    expect(q.q3b[2]).toBe(Math.max(...reaching.map(row => row[3])));
    expect(q.q3b[2]).toBe(walletBucket("1000+")[3]);
    expect(walletBucket("10-49")[3]).toBeLessThan(THRESHOLDS.largeWallet);
  });

  it("query 3 is all the wallets that reach 50, in order, and its sums are query 3b's", () => {
    expect(MEASURED.q3.map(row => row[0])).toEqual(MEASURED.q3.map((_, index) => index + 1));
    expect(MEASURED.q3).toHaveLength(q.q3b[0]);
    expect(sum(MEASURED.q3.map(row => row[1]))).toBe(q.q3b[1]);
    const sizes = MEASURED.q3.map(row => row[1]);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    for (const row of MEASURED.q3) {
      expect(row[1]).toBeGreaterThanOrEqual(THRESHOLDS.largeWallet);
      expect(row[2], "registrations with an https host").toBeLessThanOrEqual(row[1]);
      expect(row[3], "on its largest host").toBeLessThanOrEqual(row[2]);
      expect(row[5], "links").toBeLessThanOrEqual(row[1]);
    }
  });

  it("host sizes fall from the largest, are parts of the registrations with a link, and the four that reach 50 are query 4b's", () => {
    const sizes = MEASURED.q4.map(row => row[1]);
    expect(MEASURED.q4.map(row => row[0])).toEqual(MEASURED.q4.map((_, index) => index + 1));
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(sum(sizes)).toBeLessThanOrEqual(REGISTRY.withHttpsHost);
    expect(REGISTRY.hosts).toBeGreaterThanOrEqual(sizes.length);
    const reaching = sizes.filter(size => size >= THRESHOLDS.largeHost);
    expect(q.q4b[0]).toBe(reaching.length);
    expect(q.q4b[1]).toBe(sum(reaching));
    expect(q.q4b[2]).toBe(sizes[0]);
  });

  it("profile links add up to the different links and the registrations, and none is used by 50 or more", () => {
    expect(sum(MEASURED.q5.map(row => row[1]))).toBe(REGISTRY.profileLinks);
    expect(sum(MEASURED.q5.map(row => row[2])) + REGISTRY.noUriSet).toBe(registrations);
    expect(Math.max(...MEASURED.q5.map(row => row[3]))).toBeLessThan(THRESHOLDS.bigLink);
    for (const row of MEASURED.q5) expect(row[4]).toBeLessThanOrEqual(row[2]);
  });

  it("names: the placeholders and the named registrations add up, the shared names are among the named", () => {
    expect(d.names.placeholder + d.names.named).toBe(registrations);
    expect(d.names.sharing).toBeLessThanOrEqual(d.names.named);
    expect(d.names.distinct).toBeLessThanOrEqual(d.names.named);
    expect(d.names.sharedByTenOrMore).toBeLessThanOrEqual(d.names.sharing);
  });

  it("the listing states add up to the registrations, and the rules reached held-out registrations in the order they run", () => {
    expect(sum(MEASURED.q7.map(row => row[3]))).toBe(registrations);
    expect(MEASURED.q7.filter(row => row[0] === 2).map(row => row[2])).toEqual([RULES.host, RULES.link, RULES.wallet]);
    expect(d.listing.heldOut).toBe(d.listing.byLink + d.listing.byHost + d.listing.byWallet);
  });

  it("transfers, hand-outs and edits agree with the activity ledger", () => {
    const secondary = ledgerKind("secondary");
    const edits = ledgerKind("uri_update");
    expect(q.q8[3]).toBe(secondary[1]);
    expect(q.q8[5]).toBe(secondary[2]);
    expect(q.q8[7]).toBe(edits[1]);
    expect(q.q8[8]).toBe(edits[2]);
    expect(q.q8[4]).toBeLessThanOrEqual(q.q8[3]);
    expect(q.q8[6]).toBeLessThanOrEqual(q.q8[4]);
    expect(d.activity.laterTransfers).toBe(q.q8[3] - q.q8[4]);
  });

  it("the months add up to the registrations, and the days are in order, inside the window the query looks back over, and no more than the months they fall in", () => {
    expect(sum(MEASURED.q10b.map(row => row[1]))).toBe(registrations);
    expect(MEASURED.q10b.map(row => row[0])).toEqual([...MEASURED.q10b.map(row => row[0])].sort());
    const days = MEASURED.q10a.map(row => row[0]);
    expect(days).toEqual([...days].sort());
    expect(daysBetween(days[0]!, days[days.length - 1]!)).toBeLessThan(CHAIN.dayWindow);
    const perMonth = new Map<string, number>();
    for (const row of MEASURED.q10a) perMonth.set(row[0].slice(0, 7), (perMonth.get(row[0].slice(0, 7)) ?? 0) + row[1]);
    for (const [month, count] of perMonth) expect(count, month).toBeLessThanOrEqual(MEASURED.q10b.find(row => row[0] === month)![1]);
  });

  it("dates the oldest and the newest mint block of query 9 in the first month of query 10b and on the last day of query 10a, by the one-second rule", () => {
    const mint = ledgerKind("mint");
    expect(datedAt(CHAIN.firstBlock)).toBe(CHAIN.firstBlockTime);
    expect(datedAt(mint[3]).slice(0, 7), "the oldest mint is in the registry's first month").toBe(d.time.firstMonth);
    expect(datedAt(mint[4]).slice(0, 10), "the newest mint is on the last day of the window").toBe(d.time.lastDay);
    expect(datedAt(mint[4]).slice(0, 7), "the newest mint is in the newest month the query returned").toBe(MEASURED.q10b[MEASURED.q10b.length - 1]![0]);
    expect(mint[3]).toBeGreaterThanOrEqual(CHAIN.firstBlock);
    expect(CHAIN.checkedFirstBlock).toBeGreaterThanOrEqual(CHAIN.firstBlock);
    expect(CHAIN.checkedLastBlock).toBeGreaterThan(CHAIN.checkedFirstBlock);
  });
});

describe("each measured row is in the measurement document", () => {
  const row = (cells: readonly (string | number)[]) => `| ${cells.join(" | ")} |`;

  it("names itself, and says what was and was not selected and fetched", () => {
    expect(doc).toContain("# Celo registry census: the measurement (2026-11-20)");
    expect(doc).toContain(`\`${ROUTE}\``);
    expect(doc).toContain("no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it.");
  });

  it("says when the queries were run, and that the pass they were counted from was the last of the runs that read the whole history for the first time", () => {
    expect(doc).toContain("on 2026-11-20 at 19:44 UTC, after the registry pass that finished at 19:03 UTC.");
    expect(doc).toContain("it was the last of the 67 runs, started by hand through the operator's admin API");
  });

  it("holds every row of every query exactly as it came back", () => {
    for (const cells of MEASURED.q0) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q0b) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q1) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q2) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q3) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q3b) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q4) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q4b) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q5) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q6) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q7) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q8) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q9) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q10a) expect(doc).toContain(row(cells));
    for (const cells of MEASURED.q10b) expect(doc).toContain(row(cells));
  });

  it("has the figures the page works out, worded as the document words them", () => {
    expect(doc).toContain(
      `${n(d.listing.listed)} of the ${n(registrations)} registrations (${pc(d.listing.listedPercent)}) are listed, which is ${pc(d.listing.listedOfChainPercent)} of the ${n(REGISTRY.onChain)} the directory counts on the chain. ${n(d.listing.noLink)} (${pc(d.listing.noLinkPercent)}) have no usable profile link. ${n(d.listing.heldOut)} (${pc(d.listing.heldOutPercent)}) are held out as shared: ${n(d.listing.byLink)} reached first by a shared profile link, ${n(d.listing.byHost)} by a shared host name and ${n(d.listing.byWallet)} by a wallet that registered 10 or more.`
    );
    expect(doc).toContain(`${n(d.wallets.tenOrMore)} wallets made ${n(d.wallets.tenOrMoreRegistrations)} of the ${n(registrations)} registrations (${pc(d.wallets.tenOrMorePercent)}), and ${n(d.wallets.large)} wallets made ${n(d.wallets.largeRegistrations)} (${pc(d.wallets.largePercent)}).`);
    expect(doc).toContain(`${n(d.wallets.withOne)} of the ${n(REGISTRY.wallets)} wallets (${pc(d.wallets.withOnePercent)}) registered one each, and together they made ${n(d.wallets.withOneRegistrations)} registrations (${pc(d.wallets.withOneRegistrationsPercent)}).`);
    expect(doc).toContain(`holds two wallets, which made ${n(d.wallets.topBucketRegistrations)} registrations (${pc(d.wallets.topBucketPercent)}): the largest ${n(d.wallets.largest)} (${pc(d.wallets.largestPercent)}) and the other ${n(d.wallets.topBucketRegistrations - d.wallets.largest)}.`);
    expect(doc).toContain(`${n(d.hosts.withHttps)} of the ${n(registrations)} registrations (${pc(d.hosts.withHttpsPercent)}) have an https link, on ${n(REGISTRY.hosts)} host names. The largest host name holds ${n(d.hosts.largest)} of them (${pc(d.hosts.largestPercent)}), which is ${pc(d.hosts.largestOfAllPercent)} of all the registrations.`);
    expect(doc).toContain(`${n(d.links.usedOnce)} of the ${n(d.links.total)} different profile links (${pc(d.links.usedOncePercent)}) are used by one registration each. ${n(d.links.shared)} are used by more than one, by ${n(d.links.sharedRegistrations)} registrations (${pc(d.links.sharedRegistrationsPercent)}).`);
    expect(doc).toContain(`${n(d.names.placeholder)} of the ${n(registrations)} registrations (${pc(d.names.placeholderPercent)}) carry the placeholder name. The other ${n(d.names.named)} carry ${n(d.names.distinct)} distinct names, and ${n(d.names.sharing)} registrations (${pc(d.names.sharingPercent)}) share a name with at least one other.`);
    expect(doc).toContain(`${n(d.activity.transfers)} transfers after the mint are recorded, on ${n(d.activity.changedHands)} registrations (${pc(d.activity.changedHandsPercent)}).`);
    expect(doc).toContain(`${n(d.activity.edits)} profile-link edits are recorded, on ${n(d.activity.edited)} registrations (${pc(d.activity.editedPercent)}).`);
    expect(doc).toContain(`${n(d.time.firstMonthRegistrations)} of the registrations (${pc(d.time.firstMonthPercent)}) were made in ${d.time.firstMonth}, the registry's first month, and ${n(d.time.busiestMonthRegistrations)} (${pc(d.time.busiestMonthPercent)}) in ${d.time.busiestMonth}, the busiest.`);
    expect(doc).toContain(`${d.time.passMonth}, the month of the pass, has ${n(d.time.passMonthRegistrations)} so far.`);
  });

  it("states the figures that are not from the queries, with their source", () => {
    expect(doc).toContain(`${n(PUBLIC.listed)}, the public count of listed entries, and ${n(PUBLIC.onChain)}, the public count of registrations on the chain, read from \`GET /api/v1/stats\` on 2026-11-20 at 19:54 UTC.`);
    expect(doc).toContain(`(${n(CHAIN.firstBlock)} at ${CHAIN.firstBlockTime} UTC)`);
    expect(doc).toContain(`${n(CHAIN.dateChecked)} distinct blocks, from ${n(CHAIN.checkedFirstBlock)} to ${n(CHAIN.checkedLastBlock)}`);
    expect(doc).toContain(`the largest difference was ${CHAIN.dateErrorSeconds} seconds.`);
  });

  it("defines a hand-out, the cap and the dates as the code does, and says what the measurement cannot say", () => {
    const rules = read("..", "..", "..", "server", "ingestion", "erc8004Chains.ts");
    expect(doc).toContain(`(${n(CHAIN.handoutBlocks)} blocks, \`handoutBlockWindow\` in \`server/ingestion/erc8004Chains.ts\`)`);
    expect(rules).toContain(`handoutBlockWindow: ${underscored(CHAIN.handoutBlocks)},`);
    expect(rules).toContain("export const FLOOD_HOST_ROW_CAP = 2_000;".replace("2_000", underscored(CHAIN.hostRowCap)));
    expect(rules).toContain(`deployBlock: ${underscored(CHAIN.firstBlock)},`);
    expect(doc).toContain("## What this measurement cannot say");
    for (const caveat of ["It is not a count of people.", "The registering wallet is not the holder.", "It says nothing about whether an agent runs.", "A hand-out is a timing fact.", "It is one moment.", "The dates are worked out.", "The listing rules were not changed."]) {
      expect(doc).toContain(`**${caveat}**`);
    }
  });

  it("keeps the queries in the repository, all of them reads, with the thresholds the page speaks of", () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT)\b/im);
    const statements = sql
      .split("\n")
      .filter(line => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map(statement => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(15);
    for (const statement of statements) {
      expect(statement.slice(0, 80), "a statement that is not a read").toMatch(/^(WITH|SELECT)\b/);
      if (/agent_directory_registry_rows|agent_directory_registry_overflow|agent_directory_chain_activity/.test(statement)) {
        expect(statement, "a statement that reads the registry and not Celo's source").toContain("protocol = 'erc8004_celo'");
      }
      if (/agent_directory_registry_rows|agent_directory_registry_overflow/.test(statement)) expect(statement, "a statement that reads a source that is not active").toContain("state = 'active'");
    }
    expect([...new Set([...sql.matchAll(/protocol = '([a-z0-9_]+)'/g)].map(match => match[1]))]).toEqual(["erc8004_celo"]);
    expect(sql, "a name of another chain left in the queries").not.toMatch(/gnosis|monad|ethereum|erc8004_base|erc8004_arc/i);
    expect(sql).toContain("FROM agent_directory_registry_overflow o");
    expect(sql.split(`HAVING COUNT(*) >= ${THRESHOLDS.largeWallet}`).length - 1).toBeGreaterThanOrEqual(3);
    expect(THRESHOLDS.largeHost).toBe(THRESHOLDS.largeWallet);
    expect(sql).toContain(`WHERE n >= ${THRESHOLDS.sharedName}`);
    expect(sql.indexOf("WHEN link_n >= 2")).toBeLessThan(sql.indexOf(`WHEN host_n >= ${THRESHOLDS.largeHost}`));
    expect(sql.indexOf(`WHEN host_n >= ${THRESHOLDS.largeHost}`)).toBeLessThan(sql.indexOf(`WHEN wallet_n >= ${THRESHOLDS.tenWallet}`));
    expect(sql).toContain(`${n(CHAIN.handoutBlocks)} blocks on Celo`);
    expect(sql).toContain("mintBlock is unsigned, so it is cast before the subtraction");
    expect(sql).toContain(`INTERVAL ${CHAIN.dayWindow} DAY`);
    expect(sql).toContain(`chain id ${CHAIN.id}`);
    // The day query and the month query date a block by the one rule: the blocks since the first, as seconds, from the first block's time.
    const rule = `TIMESTAMPADD(SECOND, b - ${CHAIN.firstBlock}, '${CHAIN.firstBlockTime}')`;
    expect(sql.split(rule).length - 1).toBe(2);
    expect(sql).not.toContain("CASE\n    WHEN b >=");
  });

  it("uses the rules the code uses: a link shared by 2, a host by 50, a wallet of 10", () => {
    const rules = read("..", "..", "..", "server", "ingestion", "erc8004Chains.ts");
    expect(rules).toContain("CELO_LISTING_RULES");
    const bsc = read("..", "..", "..", "server", "agentRegistryRows.ts");
    expect(bsc).toContain("sharedProfileLinkFrom: 2,");
    expect(bsc).toContain(`sharedHostFrom: ${THRESHOLDS.largeHost},`);
    expect(bsc).toContain(`sharedWalletFrom: ${THRESHOLDS.tenWallet},`);
    expect(RULES).toEqual({ link: "profile link shared by 2 or more", host: "host shared by 50 or more", wallet: "wallet that registered 10 or more" });
  });
});

/** A number as the chain table writes it in source: with underscores, as in 58_396_724. */
function underscored(value: number) {
  return value.toLocaleString("en-US").replace(/,/g, "_");
}

describe("what the page says, and does not", () => {
  it("has a section called What this does not show, with the caveats", () => {
    expect(text).toContain("What this does not show");
    for (const caveat of [
      "It is not a count of people. A platform can register many agents under one wallet, and one person can use many wallets.",
      `${n(d.activity.handedOut)} registrations were handed out within about an hour of the mint, so for those the wallet is not the holder.`,
      "It does not say whether an agent runs. Nothing was asked of any address.",
      "A hand-out is a timing fact. It does not say why a registration was sent on or who received it.",
      "A shared link, host name, wallet or name is a recorded fact. It does not say that one person is behind the registrations, or that anything is wrong. A registration the directory holds out is held out as shared, and is not called fake.",
      `It counts the registrations the directory has stored, ${n(registrations)}, which are all ${n(REGISTRY.onChain)} it counts on the chain. It does not compare that count with a total from the registry's own contract.`,
      "An edit of a profile link is a recorded change and nothing more.",
      "Names and links are written by the registrants. We have not verified them.",
      "A date is worked out from the mint block and the chain's one-second blocks, and is not a clock the chain keeps for the registration.",
    ]) {
      expect(text).toContain(caveat);
    }
  });

  it("ends by saying the census is a snapshot to be redone and dated again, and that nothing here changes the listing rules", () => {
    expect(text).toContain("This census is a snapshot. It will be redone and dated again. Whether the listing rules should change for Celo is a decision for later, and nothing here changes them.");
    expect(text.indexOf("This census is a snapshot")).toBeGreaterThan(text.indexOf("What this does not show"));
  });

  it("names no host, no wallet and no person, and lists no agent", () => {
    for (const where of [text, markup, pageSource, dataSource, doc, sql]) {
      // An address is 0x and 40 hex digits: none is on the page, in the data file, in the document or in the queries.
      expect(where).not.toMatch(/0x[0-9a-fA-F]{40}/);
    }
    for (const where of [text, markup]) expect(where).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/\boperators?\b/i);
    expect(markup).not.toMatch(/href="\/agents\//);
    const hrefs = [...markup.matchAll(/<a [^>]*href="([^"]+)"/g)].map(match => match[1]);
    expect(hrefs.filter(href => !["/", "/checker", "/disputes", "/privacy", "/terms", "/contact", "/about"].includes(href!))).toEqual([]);
    // No host name is written: a word with a dot and a top-level domain is nowhere on the page, in the data file, in the test or in the document.
    const domainLike = /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|xyz|fun|dev|app|ai|network|finance|gg|so|co|me|eth|cloud|site|online|tech|info)\b/i;
    for (const where of [text, pageSource, dataSource, read("celoRegistryReport.test.ts")]) expect(where).not.toMatch(domainLike);
  });

  it("has no score, no ranking, no tier and no best or top, and no glow", () => {
    expect(text).not.toMatch(/\bscores?\b|\brank\w*|\bleaderboard\b|\bbest\b|\btop\b|\btiers?\b|\bleading\b|\bwinners?\b/i);
    expect(markup).not.toMatch(/glow|shadow|pulse|animate-|gradient|blur/i);
  });

  it("calls nothing fake, safe, trusted or verified, apart from saying a held-out registration is not called fake and that it has not verified what the registrants wrote", () => {
    const unverified = text.replace(/\b(?:have|has) not (?:been )?verified\b/g, "");
    expect(unverified).not.toMatch(/\bsafe\b|\btrusted?\b|\bverified\b|\bguarantee/i);
    expect(text.match(/\bfake\b/gi) ?? []).toHaveLength(2);
    expect(text.match(/not called fake/gi) ?? []).toHaveLength(2);
  });

  it("uses no long dash", () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const where of [text, pageSource, dataSource, doc, sql, read("celoRegistryReport.test.ts")]) expect(where).not.toMatch(dashes);
  });
});

describe("the address", () => {
  it("is a route the app draws only while Celo's switch is on, the server answers 200 for then, the sitemap lists then, and the Celo tab links to", () => {
    expect(read("..", "App.tsx")).toContain(`{featureOn("chain_celo", FEATURES) && <Route path="${ROUTE}" component={CeloRegistryReport} />}`);
    expect(read("..", "..", "..", "server", "clientRoutes.ts")).toContain(`"${ROUTE}"`);
    const sitemap = read("..", "..", "..", "server", "sitemap.ts");
    expect(sitemap).toContain(`"${ROUTE}"`);
    const head = read("..", "..", "..", "server", "routeHead.ts");
    expect(head).toContain(`"${ROUTE}": {`);
    expect(head).toContain('title: "Celo registry census, 2026-11-20"');
    // The home tab for Celo links to it, and so does the inspector of a group on Celo's page.
    expect(read("..", "components", "home", "ChainTabs.tsx")).toContain(`<Link href="${ROUTE}"`);
    expect(CHAIN_GROUP_REPORT.celo).toEqual({ href: ROUTE, label: "Celo registry census, 20 November 2026" });
    expect(read("ChainExplorer.tsx")).toContain("CHAIN_GROUP_REPORT[chain]");
    // The line under the map links it beside the Celo lights.
    // The home map links the report from the same entry, under the chain's caption.
    expect(read("home", "LandingHero.tsx")).toContain("report: CHAIN_GROUP_REPORT[lights.chain]");
  });
});
