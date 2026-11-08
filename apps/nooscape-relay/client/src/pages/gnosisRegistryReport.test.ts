import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { CHAIN_GROUP_REPORT } from "@/lib/chainExplorerModel";
import { CHAIN, DERIVED as d, GNOSIS_DOC, GNOSIS_SQL, MEASURED, PASS_TIME, PUBLIC, REGISTRY, RULES, THRESHOLDS, formatPercent as pc, percent } from "@/lib/gnosisRegistryReport";
import GnosisRegistryReport from "./GnosisRegistryReport";

/**
 * The Gnosis registry census report states numbers that people will quote, so they are held to their source. The page reads
 * lib/gnosisRegistryReport.ts and nothing else; these render it, check every number on it is one of that file's figures, check each
 * measured row against the document that holds the query output, check the totals add up, and keep the page to the rules the other
 * censuses set: no per-agent rows, no ranking, no score, no tier, no glow, no host, wallet or person named.
 *
 * Gnosis's figures differ from Monad's in ways the words of the page depend on, so the facts each of those sentences rests on are
 * pinned here too: one host name past the cap, which holds 92 percent of the chain and 2,000 stored rows that one wallet made; one
 * wallet and one host name that reach 50; no profile link used by 50 or more; a state-4 row (a name that is only a number); one
 * transfer that was not a hand-out; two days with a registration, which end 20 days before the pass; months with none; and block
 * times that are close to constant, so the same stretches date the days and the months.
 */
const here = import.meta.dirname;
const read = (...parts: string[]) => readFileSync(path.resolve(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const docs = (name: string) => read("..", "..", "..", "docs", name);

const ROUTE = "/field/gnosis-registry-2026-11-06";
const markup = renderToStaticMarkup(createElement(Router, { ssrPath: ROUTE, children: createElement(GnosisRegistryReport) }));
const decode = (value: string) => value.replace(/&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pageSource = read("GnosisRegistryReport.tsx");
const dataSource = read("..", "lib", "gnosisRegistryReport.ts");
const doc = docs("gnosis-census-2026-11-06.md");
const sql = docs("gnosis-census-queries-2026-11-06.sql");
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
const n = (value: number) => value.toLocaleString("en-US");
/** A number as the chain table writes it in source: with underscores, as in 44_505_010. */
const underscored = (value: number) => value.toLocaleString("en-US").replace(/,/g, "_");

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
/** Whole days from one UTC date to another, both written YYYY-MM-DD. */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/** The months strictly between two months written YYYY-MM, listed by stepping the calendar. */
const monthsStrictlyBetween = (from: string, to: string) => {
  const found: string[] = [];
  // Date.UTC takes a month from 0, so the month number of `from` as it is written is the index of the month after it.
  const cursor = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 1));
  for (let guard = 0; guard < 240; guard += 1) {
    const label = cursor.toISOString().slice(0, 7);
    if (label >= to) break;
    found.push(label);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return found;
};

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
    expect(stray, `numbers on the page that are not in lib/gnosisRegistryReport.ts: ${[...new Set(stray)].join(", ")}`).toEqual([]);
  });

  it("writes no figure into the page's own source, which would let it drift from the file", () => {
    const literal = (stripComments(pageSource).match(/\b\d[\d,]{2,}\b/g) ?? []).filter(token => !["2026", "8004"].includes(token));
    expect(literal, "a number written into GnosisRegistryReport.tsx").toEqual([]);
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
    expect(PASS_TIME).toBe("21:12 UTC");
    expect(text).toContain(`Counted from the registry pass that finished at ${PASS_TIME}`);
  });

  it("says Gnosis is read once a day, and that the pass it was counted from was started by hand because the first scheduled pass had not finished", () => {
    expect(text).toContain(
      "Gnosis is read by a scheduled pass once a day. Query 0 shows the last pass that succeeded, and when the queries were run that was a pass started by hand, because the first scheduled pass had not finished."
    );
    expect(text).toContain("It is one moment. Gnosis is read by a scheduled pass once a day and the chain is still adding registrations, so the figures are as of the pass named in the header.");
  });

  it("says what the directory counts on the chain, stores, and leaves out of the stored rows", () => {
    expect(text).toContain(
      `The directory counts ${n(REGISTRY.onChain)} registrations on the chain and has stored ${n(registrations)} of them. A host name that holds more than ${n(CHAIN.hostRowCap)} registrations keeps its first ${n(CHAIN.hostRowCap)}, in the order they were made on the chain, and the rest are counted and not stored: ${n(REGISTRY.overflow)} registrations, for ${n(d.hosts.pastTheCap)} host name. Every figure below counts the stored registrations, so those ${n(REGISTRY.overflow)} are in none of them.`
    );
  });

  it("states the registry's size and surface in one table, and says none is hidden and what the public counts are", () => {
    expect(text).toContain(
      `What was counted Count Registrations the directory counts on the chain ${n(REGISTRY.onChain)} Registrations the directory has stored ${n(registrations)} Registrations counted past a host's cap and not stored ${n(REGISTRY.overflow)} Registrations the directory lists ${n(REGISTRY.listed)} Registering wallets ${n(REGISTRY.wallets)} Registrations with an https link ${n(REGISTRY.withHttpsHost)} Host names of those links ${n(REGISTRY.hosts)} Different profile links ${n(REGISTRY.profileLinks)}`
    );
    expect(text).toContain(`${n(d.hosts.withoutHost)} registrations (${pc(d.hosts.withoutHostPercent)}) have no https host name recorded, and ${n(REGISTRY.noUriSet)} set no profile link at all.`);
    expect(text).toContain(
      `No registration is hidden, so the public count of listed entries, ${n(PUBLIC.listed)}, is the same as the ${n(REGISTRY.listed)} in the table. The public count of registrations on the chain, ${n(PUBLIC.onChain)}, is the ${n(REGISTRY.registrations)} stored plus the ${n(REGISTRY.overflow)} counted and not stored.`
    );
  });

  it("says what the listing rules did, in one table, with the first rule that reached each registration held out and the registration whose name is only a number", () => {
    expect(text).toContain(
      `Of the ${n(registrations)} stored registrations, ${n(d.listing.listed)} (${pc(d.listing.listedPercent)}) are listed in the directory, which is ${pc(d.listing.listedOfChainPercent)} of the ${n(REGISTRY.onChain)} the directory counts on the chain. ${n(d.listing.noLink)} (${pc(d.listing.noLinkPercent)}) have no usable profile link. ${n(d.listing.heldOut)} (${pc(d.listing.heldOutPercent)}) are held out as shared, not judged. ${n(d.listing.numberOnly)} carries a name that is only a number, and is not listed.`
    );
    expect(text).toContain(
      `What happened Registrations Listed in the directory ${n(d.listing.listed)} No usable profile link ${n(d.listing.noLink)} Held out first: ${RULES.link} ${n(d.listing.byLink)} Held out first: ${RULES.host} ${n(d.listing.byHost)} Held out first: ${RULES.wallet} ${n(d.listing.byWallet)} A name that is only a number ${n(d.listing.numberOnly)}`
    );
    expect(text).not.toContain("None carries a name that is only a number");
    expect(text).toContain("or because it has no usable profile link or a name that is only a number.");
    expect(text).toContain("A rule that reaches a registration first is not the only one that would have.");
    expect(text).toContain(
      `The profile link rule reached ${n(d.listing.byLink)} registrations first, ${pc(d.listing.byLinkPercent)} of all of them, and the host name rule reached ${n(d.listing.byHost)}, ${pc(d.listing.byHostPercent)}.`
    );
    expect(text).toContain("These are the rules written for the BNB Chain registry, and they have not been changed for Gnosis. This census says what they did here. It does not say whether they are right for Gnosis.");
  });

  it("has the findings as sentences, with the denominator stated", () => {
    expect(text).toContain(
      `${n(d.wallets.tenOrMore)} wallets each registered ${THRESHOLDS.tenWallet} or more. Together they made ${n(d.wallets.tenOrMoreRegistrations)} of the ${n(registrations)} registrations (${pc(d.wallets.tenOrMorePercent)}). Only one of them registered ${THRESHOLDS.largeWallet} or more, and it made ${n(d.wallets.largeRegistrations)} of the ${n(registrations)} (${pc(d.wallets.largePercent)}).`
    );
    expect(text).toContain(
      `At the other end, ${n(d.wallets.withOne)} of the ${n(REGISTRY.wallets)} wallets (${pc(d.wallets.withOnePercent)}) registered one each. Together they made ${n(d.wallets.withOneRegistrations)} registrations (${pc(d.wallets.withOneRegistrationsPercent)}).`
    );
    expect(text).toContain(
      `The largest bucket, ${d.wallets.topBucket}, holds that one wallet, and no other wallet made more than ${n(d.wallets.nextLargest)}. All ${n(d.largeWallets.registrations)} of its stored registrations are on one host name, and it gave each of them a profile link of its own.`
    );
    expect(text).toContain(
      `${n(d.hosts.withHttps)} of the ${n(registrations)} registrations (${pc(d.hosts.withHttpsPercent)}) have an https link, spread over ${n(REGISTRY.hosts)} host names, all of them in the table below. One host name holds ${n(d.hosts.largest)} of them (${pc(d.hosts.largestPercent)}), which is ${pc(d.hosts.largestOfAllPercent)} of all the registrations. The next holds ${n(d.hosts.second)} (${pc(d.hosts.secondPercent)}) and the one after holds ${n(d.hosts.third)}. The two largest together hold ${n(d.hosts.twoLargest)} (${pc(d.hosts.twoLargestPercent)}).`
    );
    expect(text).toContain(
      `The largest host name is at the ${n(CHAIN.hostRowCap)} registrations a host may keep, and the one wallet in the largest bucket of the wallet table made all of them. The directory counted ${n(d.hosts.overflowLargest)} more for it, with no wallet recorded, so it holds ${n(d.hosts.largestHeld)} in all, ${pc(d.hosts.largestHeldPercent)} of the ${n(REGISTRY.onChain)} the directory counts on the chain. The ${n(REGISTRY.overflow)} registrations counted and not stored are ${pc(d.hosts.overflowPercent)} of the ${n(REGISTRY.onChain)}, and none of them is listed.`
    );
    expect(text).toContain(
      `Only one host name holds ${THRESHOLDS.largeHost} or more registrations. It holds ${n(d.hosts.atLeastThresholdRegistrations)}, ${pc(d.hosts.atLeastThresholdPercent)} of those with an https link and ${pc(d.hosts.atLeastThresholdOfAllPercent)} of all of them.`
    );
    expect(text).toContain(
      `${n(d.links.usedOnce)} of the ${n(d.links.total)} different profile links (${pc(d.links.usedOncePercent)}) are used by one registration each. ${n(d.links.shared)} are used by more than one, by ${n(d.links.sharedRegistrations)} registrations in all (${pc(d.links.sharedRegistrationsPercent)}). No profile link is used by ${THRESHOLDS.bigLink} or more registrations. The most any one link has is ${n(d.links.largest)} (${pc(d.links.largestPercent)} of all the registrations).`
    );
    expect(text).toContain(`${n(d.names.placeholder)} of the ${n(registrations)} registrations (${pc(d.names.placeholderPercent)}) have no name of their own.`);
    expect(text).toContain(
      `The other ${n(d.names.named)} carry ${n(d.names.distinct)} distinct names, and ${n(d.names.sharing)} registrations (${pc(d.names.sharingPercent)}) share a name with at least one other. No name is shared by ${THRESHOLDS.sharedName} or more, and the largest group is ${n(d.names.largestGroup)}.`
    );
    expect(text).toContain(`all ${n(d.activity.measured)} registrations have been measured.`);
    expect(text).toContain(
      `${n(d.activity.transfers)} transfers after the mint are recorded, on ${n(d.activity.changedHands)} registrations (${pc(d.activity.changedHandsPercent)}). ${n(d.activity.noTransfer)} registrations (${pc(d.activity.noTransferPercent)}) have had none.`
    );
    expect(text).toContain(
      `${n(d.activity.handouts)} hand-outs are recorded, on ${n(d.activity.handedOut)} registrations (${pc(d.activity.handedOutPercent)}). A hand-out is a transfer sent from the wallet the registration was minted to, within about an hour of the mint (${n(CHAIN.handoutBlocks)} blocks on Gnosis). The other transfer came later than the first hour or from another wallet.`
    );
    expect(text).toContain(`${n(d.activity.edits)} edits of a profile link are recorded, on ${n(d.activity.edited)} registrations (${pc(d.activity.editedPercent)}).`);
  });

  it("words the dates for Gnosis: one set of stretches for the days and the months, no day rate, and the margins checked against the logs of every registration", () => {
    expect(text).toContain(
      `The date of a registration is worked out from its mint block and the time of a block that is known. A day and a month are dated through the same ${n(CHAIN.stretches)} stretches of ${n(CHAIN.stretchBlocks)} blocks, the last one shorter, from the registry's first block, ${n(CHAIN.firstBlock)}, at ${CHAIN.firstBlockTime} UTC, to the finalized block, ${n(CHAIN.recentBlock)}, at ${CHAIN.recentBlockTime} UTC. Each stretch has the time of its first block and the seconds a block took in it, read from the chain. A block on Gnosis takes about ${CHAIN.blockSecondsLow} to ${CHAIN.blockSecondsHigh} seconds, with a slot missed now and then. A date is within about ${CHAIN.dateErrorMinutes} minutes of the real time at the worst and ${CHAIN.dateMedianErrorMinutes} minutes at the median, checked against the block times in the logs of all ${n(CHAIN.dateChecked)} registrations.`
    );
    // Monad counted a day back from the finalized block at the rate of its last 200,000 blocks; Gnosis has no such rate.
    expect(text).not.toMatch(/counted back|at the rate of|until block/);
    expect(dataSource).not.toMatch(/daySeconds|rateBlocks|DATING/);
    expect(CHAIN.dateChecked, "the margins were checked against every registration on the chain, stored or not").toBe(REGISTRY.onChain);
  });

  it("words the months for Gnosis: the first month holds most, the later months that have a registration, the whole months with none, and the month of the pass with none so far", () => {
    expect(d.time.monthsWithNone).toHaveLength(3);
    const [first, second, third] = d.time.monthsWithNone;
    expect(text).toContain(
      `${n(d.time.firstMonthRegistrations)} of the registrations (${pc(d.time.firstMonthPercent)}) were made in ${d.time.firstMonth}, the registry's first month. Of the ${n(d.time.wholeLaterMonths)} whole months after it, ${n(d.time.laterMonths)} have a registration, between ${n(d.time.laterLow)} and ${n(d.time.laterHigh)} each and ${n(d.time.laterMonthsRegistrations)} in all (${pc(d.time.laterMonthsPercent)}), and ${n(d.time.monthsWithNoneCount)} have none: ${first}, ${second} and ${third}. ${d.time.passMonth}, the month of the pass, has none so far.`
    );
  });

  it("says plainly that the registrations counted and not stored have no month or day, were made after the host's first 2,000, and make the history longer than the table", () => {
    expect(text).toContain(
      `A host name past the cap keeps its first registrations in chain order, so the ${n(REGISTRY.overflow)} registrations counted and not stored have no month and no day here. They were made after the ${n(CHAIN.hostRowCap)} their host kept. The months and days below therefore show fewer registrations than the chain had: the months after the first look thinner here than they were on the chain, and the registry's own history is longer than this table shows.`
    );
  });

  it("words the days for two days, in a window that ends on the newest registration's day, 20 days before the day of the pass", () => {
    expect(text).toContain(
      `The table of days below shows the UTC days that have a registration among the ${n(CHAIN.dayWindow)} days that end on ${d.time.lastDay}, the day of the newest stored registration. ${n(d.time.days)} days have one, ${d.time.firstDay} and ${d.time.lastDay}, with one registration each (${n(d.time.daysRegistrations)} in all, ${pc(d.time.daysPercent)} of the registrations), and the other ${n(d.time.daysWithNone)} days had none. The day of the pass named in the header is ${d.time.passDay}, ${n(d.time.daysBeforeThePass)} days after the day of the newest stored registration, and no stored registration is dated later.`
    );
    // Monad's sentences about the busiest day and the days after it, and about a window that ends on the day of the pass, are not true of two days.
    expect(text).not.toMatch(/busiest|which is also the day of the pass/);
  });

  it("says ratings are not measured here", () => {
    expect(text).toContain(
      "Ratings are not measured here. The directory also reads the reputation registry for a count of ratings, which the Gnosis tab and the API show once it has read the registry's whole history. This census does not use it."
    );
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
    expect(percent(41, 2328)).toBe(1.8);
    expect(pc(percent(41, 2328))).toBe("1.8%");
    expect(percent(41, 4179)).toBe(1);
    expect(pc(percent(41, 4179))).toBe("1.0%");
    expect(pc(percent(3851, 4179))).toBe("92.2%");
    expect(pc(percent(1851, 4179))).toBe("44.3%");
    expect(pc(percent(2, 2328))).toBe("0.1%");
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
    expect(registrations).toBe(2328);
    expect(q.q0[5]).toBe(d.listing.listed);
  });

  it("no registration is hidden, so the public counts are the table's, and the public count on the chain is the stored plus the counted", () => {
    expect(REGISTRY.hidden).toBe(0);
    expect(PUBLIC.listed).toBe(REGISTRY.listed - REGISTRY.hidden);
    expect(PUBLIC.onChain).toBe(REGISTRY.onChain);
    expect(PUBLIC).toEqual({ listed: 41, onChain: 4179 });
  });

  it("the registrations the directory counts on the chain are the stored ones and the ones counted past a host's cap, and one host is past it", () => {
    expect(REGISTRY.onChain).toBe(registrations + q.q0b[1]);
    expect(REGISTRY.onChain).toBe(4179);
    // The page words the cap in the singular and gives the host's whole overflow as the count, so there is exactly one host.
    expect(q.q0b[0]).toBe(1);
    expect(d.hosts.pastTheCap).toBe(1);
    expect(q.q0b[2]).toBe(q.q0b[1]);
    expect(d.hosts.overflowLargest).toBe(q.q0b[1]);
    expect(CHAIN.hostRowCap).toBe(2000);
    expect(MEASURED.q4[0][1], "a host past the cap keeps exactly the cap").toBe(CHAIN.hostRowCap);
    expect(MEASURED.q4[1][1], "only one host is at the cap").toBeLessThan(CHAIN.hostRowCap);
    expect(d.hosts.largestHeld).toBe(CHAIN.hostRowCap + q.q0b[2]);
    expect(d.hosts.largestHeld).toBe(3851);
    expect(d.hosts.largestHeld).toBeGreaterThan(d.hosts.overflowLargest);
    // The page says the largest host name holds about 92 percent of the chain.
    expect(d.hosts.largestHeldPercent).toBe(92.2);
  });

  it("every registration has a wallet, and every one was measured by the activity walk", () => {
    expect(REGISTRY.noWallet).toBe(0);
    expect(REGISTRY.mintMeasured).toBe(registrations);
    expect(q.q8[1]).toBe(registrations);
    expect(q.q8[2]).toBe(registrations);
  });

  it("wallet buckets add up to the wallets and the registrations, and the one wallet that reaches 50 is alone in the 1000+ bucket, the largest", () => {
    expect(sum(MEASURED.q2.map(row => row[1]))).toBe(REGISTRY.wallets);
    expect(sum(MEASURED.q2.map(row => row[2]))).toBe(registrations);
    for (const row of MEASURED.q2) expect(row[3], `${row[0]}: the largest in a bucket cannot be more than the bucket`).toBeLessThanOrEqual(row[2]);
    // No wallet made 50 to 999, so those two buckets did not come back; the page names the last bucket the query returned as the largest.
    expect(MEASURED.q2.map(row => row[0])).toEqual(["1", "2-9", "10-49", "1000+"]);
    expect(d.wallets.topBucket).toBe("1000+");
    expect(d.wallets.topBucketWallets, "the page says the largest bucket holds that one wallet").toBe(1);
    expect(walletBucket("1000+")[2]).toBe(walletBucket("1000+")[3]);
    // The page says no other wallet made more than the largest of the 10-49 bucket, which is below the bar for a large wallet.
    expect(d.wallets.nextLargest).toBe(walletBucket("10-49")[3]);
    expect(d.wallets.nextLargest).toBeLessThan(THRESHOLDS.largeWallet);
  });

  it("query 3b is the buckets of query 2 that reach the large-wallet bar, and query 3 is all of those wallets, in order", () => {
    const upper = MEASURED.q2.filter(row => ["50-99", "100-999", "1000+"].includes(row[0]));
    expect(upper.map(row => row[0])).toEqual(["1000+"]);
    expect(q.q3b[0]).toBe(sum(upper.map(row => row[1])));
    expect(q.q3b[1]).toBe(sum(upper.map(row => row[2])));
    expect(q.q3b[2]).toBe(walletBucket("1000+")[3]);
    expect(MEASURED.q3[0][1]).toBe(q.q3b[2]);
    // Fewer than 25 wallets reach the bar, so query 3 holds every one of them and its registrations are all of theirs.
    expect(q.q3b[0]).toBeLessThan(25);
    expect(MEASURED.q3.length).toBe(q.q3b[0]);
    expect(sum(MEASURED.q3.map(row => row[1]))).toBe(q.q3b[1]);
    expect(Math.min(...MEASURED.q3.map(row => row[1]))).toBeGreaterThanOrEqual(THRESHOLDS.largeWallet);
    MEASURED.q3.forEach((row, index) => {
      expect(row[0]).toBe(index + 1);
      if (index > 0) expect(row[1]).toBeLessThanOrEqual(MEASURED.q3[index - 1]![1]);
    });
    expect(d.wallets.large, "the page says only one wallet registered 50 or more").toBe(1);
    expect(d.wallets.largeRegistrations).toBe(walletBucket("1000+")[2]);
    expect(d.wallets.tenOrMore).toBe(walletBucket("10-49")[1] + d.wallets.large);
  });

  it("the one large wallet has every registration on one host name and a link of its own for each, and that host name is the largest one, so the host's stored rows are all its", () => {
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
    expect(d.largeWallets.shown).toBe(d.wallets.large);
    expect(d.largeWallets.onOneHost + d.largeWallets.withoutAHost).toBeLessThanOrEqual(d.largeWallets.shown);
    expect(d.largeWallets.ownLinkEach + d.largeWallets.oneLinkForAll + d.largeWallets.between, "the three groups the page names make the wallets it counts").toBe(d.largeWallets.shown);
    // The page words these for one wallet: all its stored registrations on one host name, a link of its own for each.
    expect(d.largeWallets.onOneHost).toBe(1);
    expect(d.largeWallets.withoutAHost).toBe(0);
    expect(d.largeWallets.ownLinkEach).toBe(1);
    expect(d.largeWallets.oneLinkForAll).toBe(0);
    expect(d.largeWallets.between).toBe(0);
    expect(d.largeWallets.registrations).toBe(d.wallets.largeRegistrations);
    // Its registrations are the largest host name's: it has one host name, all of them on it, and no other host name reaches the cap, so no other host name could hold them.
    const wallet = MEASURED.q3[0];
    expect(wallet[4]).toBe(1);
    expect(wallet[3]).toBe(wallet[1]);
    expect(wallet[1]).toBe(MEASURED.q4[0][1]);
    expect(wallet[1]).toBe(CHAIN.hostRowCap);
    expect(MEASURED.q4[1][1]).toBeLessThan(wallet[1]);
  });

  it("host sizes fall from the largest, are parts of the registrations with a link, and are all the host names there are", () => {
    MEASURED.q4.forEach((row, index) => {
      expect(row[0]).toBe(index + 1);
      if (index > 0) expect(row[1]).toBeLessThanOrEqual(MEASURED.q4[index - 1]![1]);
    });
    expect(sum(MEASURED.q4.map(row => row[1]))).toBeLessThanOrEqual(REGISTRY.withHttpsHost);
    expect(d.hosts.withHttps + d.hosts.withoutHost).toBe(registrations);
    // Query 4 asks for ten and only 8 host names exist, so it returns all of them and they hold every registration with an https link.
    expect(MEASURED.q4.length).toBeLessThan(10);
    expect(REGISTRY.hosts).toBe(MEASURED.q4.length);
    expect(sum(MEASURED.q4.map(row => row[1]))).toBe(REGISTRY.withHttpsHost);
    // Query 4b counts every host name at the threshold or more, so it holds at least those of the ten that reach it, and no more than all the https registrations.
    const reaching = MEASURED.q4.filter(row => row[1] >= THRESHOLDS.largeHost);
    expect(q.q4b[0]).toBeGreaterThanOrEqual(reaching.length);
    expect(q.q4b[0]).toBeLessThanOrEqual(REGISTRY.hosts);
    expect(q.q4b[1]).toBeGreaterThanOrEqual(sum(reaching.map(row => row[1])));
    expect(q.q4b[1]).toBeLessThanOrEqual(REGISTRY.withHttpsHost);
    expect(q.q4b[2]).toBe(MEASURED.q4[0][1]);
    expect(d.hosts.largest).toBeGreaterThanOrEqual(d.hosts.second);
    // The page words it as one host name that reaches 50, and says it holds all the registrations at or over the bar.
    expect(d.hosts.atLeastThreshold).toBe(1);
    expect(d.hosts.atLeastThresholdRegistrations).toBe(d.hosts.largest);
    expect(THRESHOLDS.largeHost).toBe(THRESHOLDS.largeWallet);
  });

  it("profile links add up to the different links and the registrations, and none is used by 50 or more", () => {
    expect(d.links.total).toBe(REGISTRY.profileLinks);
    expect(sum(MEASURED.q5.map(row => row[2])) + REGISTRY.noUriSet).toBe(registrations);
    expect(sum(MEASURED.q5.map(row => row[4])), "the registrations with a link that has an https host are the registrations with an https host").toBe(REGISTRY.withHttpsHost);
    for (const row of MEASURED.q5) {
      expect(row[3], `${row[0]}: the largest cannot be more than the bucket`).toBeLessThanOrEqual(row[2]);
      expect(row[4], `${row[0]}: registrations with a host cannot be more than the bucket`).toBeLessThanOrEqual(row[2]);
    }
    expect(linkBucket("1")[1]).toBe(linkBucket("1")[2]);
    // A registration on a shared link is held out by the link rule first, unless an earlier state (no usable link, a name that is only a number) took it.
    expect(d.listing.byLink).toBeLessThanOrEqual(d.links.sharedRegistrations);
    expect(d.links.shared).toBe(sum(MEASURED.q5.filter(row => row[0] !== "1").map(row => row[1])));
    // The page says no link is used by 50 or more registrations, and the most any one link has is the largest in the top bucket that came back.
    expect(MEASURED.q5.map(row => row[0])).toEqual(["1", "2-9", "10-49"]);
    expect(d.links.big).toBe(0);
    expect(d.links.bigRegistrations).toBe(0);
    expect(d.links.largest).toBe(linkBucket("10-49")[3]);
    expect(d.links.largest, "no link reaches the bar for a large link").toBeLessThan(THRESHOLDS.bigLink);
  });

  it("names: the placeholders and the named registrations add up, the shared names are among the named, and none is shared by 10 or more", () => {
    expect(d.names.placeholder + d.names.named).toBe(registrations);
    expect(d.names.distinct).toBeLessThanOrEqual(d.names.named);
    expect(d.names.sharing).toBeLessThanOrEqual(d.names.named);
    expect(d.names.sharedByTenOrMore).toBeLessThanOrEqual(d.names.sharing);
    // The page says no name is shared by 10 or more, and that the largest group is smaller than that.
    expect(d.names.sharedByTenOrMore).toBe(0);
    expect(d.names.largestGroup).toBeLessThan(THRESHOLDS.sharedName);
    expect(d.names.largestGroup).toBeGreaterThanOrEqual(2);
  });

  it("the listing states add up to the registrations, the rules reached held-out registrations in the order they run, and one name is only a number", () => {
    expect(sum(MEASURED.q7.map(row => row[3]))).toBe(registrations);
    expect(d.listing.listed + d.listing.noLink + d.listing.heldOut + d.listing.numberOnly).toBe(registrations);
    expect(d.listing.byLink + d.listing.byHost + d.listing.byWallet).toBe(d.listing.heldOut);
    for (const row of MEASURED.q7) expect(row[2] === "-", `${row[1]}: only a registration held out as shared has a first rule`).toBe(row[0] !== 2);
    expect(MEASURED.q7.filter(row => row[0] === 2).map(row => row[2]).sort()).toEqual([RULES.host, RULES.link, RULES.wallet].sort());
    // Monad had no state 4; Gnosis has one registration in it, and the page's table has a row for it. No state 3 came back.
    expect(MEASURED.q7.map(row => row[0])).toEqual([0, 1, 2, 2, 2, 4]);
    expect(MEASURED.q7.find(row => row[0] === 4)![1]).toBe("name is only a number");
    expect(d.listing.numberOnly, "the page says one carries a name that is only a number").toBe(1);
  });

  it("transfers, hand-outs and edits agree with the activity ledger, and one transfer was not a hand-out", () => {
    expect(ledgerKind("secondary")[1]).toBe(q.q8[3]);
    expect(ledgerKind("secondary")[2]).toBe(q.q8[5]);
    expect(ledgerKind("uri_update")[1]).toBe(q.q8[7]);
    expect(ledgerKind("uri_update")[2]).toBe(q.q8[8]);
    for (const row of MEASURED.q9) expect(row[3]).toBeLessThanOrEqual(row[4]);
    expect(MEASURED.q9.map(row => row[0])).toEqual(["mint", "secondary", "uri_update"]);
    expect(d.activity.handouts).toBeLessThanOrEqual(d.activity.transfers);
    expect(d.activity.handedOut).toBeLessThanOrEqual(d.activity.changedHands);
    expect(d.activity.laterTransfers, "the page says the other transfer, in the singular, came later or from another wallet").toBe(1);
    expect(d.activity.noTransfer + d.activity.changedHands).toBe(registrations);
  });

  it("the months add up to the registrations, the first month holds more than any later one, and the whole months with none are those the query did not return", () => {
    expect(sum(MEASURED.q10b.map(row => row[1]))).toBe(registrations);
    expect(d.time.months).toBe(MEASURED.q10b.length);
    expect(d.time.firstMonth).toBe(MEASURED.q10b[0]![0]);
    expect(d.time.laterMonths + 1).toBe(d.time.months);
    expect(d.time.firstMonthRegistrations + d.time.laterMonthsRegistrations).toBe(registrations);
    expect(d.time.firstMonthRegistrations, "the page says the registry's first month had the most").toBeGreaterThan(d.time.laterHigh);
    expect(d.time.laterLow).toBeLessThan(d.time.laterHigh);
    // The first month is the month of the registry's first block, and the months run in order, each once.
    expect(d.time.firstMonth).toBe(CHAIN.firstBlockTime.slice(0, 7));
    const monthNames = MEASURED.q10b.map(row => row[0]);
    expect(monthNames).toEqual([...monthNames].sort());
    expect(new Set(monthNames).size).toBe(monthNames.length);
    // The whole months are those between the first month and the month of the pass; the page says 3 of them have none, and names them.
    const whole = monthsStrictlyBetween(d.time.firstMonth, d.time.passMonth);
    expect(d.time.wholeLaterMonths).toBe(whole.length);
    expect(d.time.monthsWithNone).toEqual(whole.filter(month => !monthNames.includes(month)));
    expect(d.time.monthsWithNone).toEqual(["2026-05", "2026-07", "2026-09"]);
    expect(d.time.monthsWithNoneCount).toBe(d.time.monthsWithNone.length);
    expect(d.time.wholeLaterMonths).toBe(d.time.laterMonths + d.time.monthsWithNoneCount);
    expect(d.time.wholeLaterMonths).toBe(8);
    expect(d.time.laterMonths).toBe(5);
    // Every month the query returned lies between the first month and the month of the pass, so the last returned month is a whole month.
    for (const month of monthNames.slice(1)) expect(whole).toContain(month);
  });

  it("the month of the pass has no registration stored, so the newest month the query returned is before it", () => {
    expect(d.time.passMonth).toBe(MEASURED.date.slice(0, 7));
    expect(d.time.passMonth).toBe(d.time.passDay.slice(0, 7));
    expect(MEASURED.q10b.some(row => row[0] === d.time.passMonth)).toBe(false);
    expect(d.time.passMonthRegistrations, "the page says the month of the pass has none so far").toBe(0);
    expect(MEASURED.q10b[MEASURED.q10b.length - 1]![0] < d.time.passMonth).toBe(true);
  });

  it("the days are in order, inside the window the query looks back over, fewer than three, and add up to no more than the months they fall in", () => {
    const sorted = MEASURED.q10a.map(row => row[0]);
    expect(sorted).toEqual([...sorted].sort());
    expect(new Set(sorted).size).toBe(sorted.length);
    // The page words two days with one registration each: it says "one each", and calls no day the busiest.
    expect(d.time.days).toBeLessThan(3);
    expect(d.time.days).toBe(2);
    expect(d.time.dayLeast).toBe(1);
    expect(d.time.dayMost).toBe(1);
    expect(d.time.daysRegistrations).toBe(sum(MEASURED.q10a.map(row => row[1])));
    // The window ends on the newest registration's day, which is the last day the query returned. It is not the day of the pass.
    expect(d.time.lastDay).toBe(sorted[sorted.length - 1]);
    expect(d.time.firstDay).toBe(sorted[0]);
    expect(d.time.passDay).toBe(MEASURED.date);
    expect(d.time.lastDay < d.time.passDay).toBe(true);
    expect(d.time.daysBeforeThePass).toBe(daysBetween(d.time.lastDay, d.time.passDay));
    expect(d.time.daysBeforeThePass).toBe(20);
    expect(daysBetween(d.time.firstDay, d.time.lastDay)).toBeLessThanOrEqual(CHAIN.dayWindow - 1);
    expect(d.time.days + d.time.daysWithNone).toBe(CHAIN.dayWindow);
    expect(d.time.daysWithNone).toBeGreaterThan(0);
    // Each day falls in a month the query returned, and the days of a month add up to no more than that month's registrations.
    for (const row of MEASURED.q10a) expect(MEASURED.q10b.some(month => row[0].startsWith(month[0])), `${row[0]} is in no month the query returned`).toBe(true);
    for (const [month, count] of MEASURED.q10b) expect(sum(MEASURED.q10a.filter(row => row[0].startsWith(month)).map(row => row[1])), month).toBeLessThanOrEqual(count);
    // The pass the census is counted from finished at 21:12 on its day.
    expect(d.time.passDay).toBe(q.q0[4].slice(0, 10));
    expect(q.q0[4].slice(11, 13)).toBe("21");
  });
});

describe("each measured row is in the measurement document", () => {
  const row = (cells: ReadonlyArray<string | number>) => `| ${cells.join(" | ")} |`;

  it("names itself, and says what was and was not selected and fetched", () => {
    expect(GNOSIS_DOC).toBe("docs/gnosis-census-2026-11-06.md");
    expect(GNOSIS_SQL).toBe("docs/gnosis-census-queries-2026-11-06.sql");
    expect(doc).toContain("no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it");
    expect(doc).toContain("Every statement is a read-only SELECT.");
  });

  it("says when the queries were run, and that the pass they were counted from was started by hand because the first scheduled pass had not finished", () => {
    expect(doc).toContain("were run against the production database on 2026-11-06 at about 23:30 UTC, after the registry pass that finished at 21:12 UTC.");
    expect(doc).toContain(
      "Query 0 shows the last pass that succeeded, and that pass was started by hand: Gnosis's source has been read by a scheduled pass once a day since the deploy at 23:05 UTC that day"
    );
    expect(doc).toContain("and the first scheduled pass had not finished when the queries were run.");
    expect(doc).toContain("## Running it again");
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
      `${n(d.listing.listed)} of the ${n(registrations)} registrations (${pc(d.listing.listedPercent)}) are listed, which is ${pc(d.listing.listedOfChainPercent)} of the ${n(REGISTRY.onChain)} the directory counts on the chain. ${n(d.listing.noLink)} (${pc(d.listing.noLinkPercent)}) have no usable profile link. ${n(d.listing.heldOut)} (${pc(d.listing.heldOutPercent)}) are held out as shared: ${n(d.listing.byLink)} reached first by a shared profile link, ${n(d.listing.byHost)} by a shared host name and ${n(d.listing.byWallet)} by a wallet that registered ${THRESHOLDS.tenWallet} or more. ${n(d.listing.numberOnly)} carries a name that is only a number, and is not listed.`
    );
    expect(doc).toContain(
      `${n(d.wallets.tenOrMore)} wallets made ${n(d.wallets.tenOrMoreRegistrations)} of the ${n(registrations)} registrations (${pc(d.wallets.tenOrMorePercent)}), and ${n(d.wallets.large)} wallet made ${n(d.wallets.largeRegistrations)} (${pc(d.wallets.largePercent)}).`
    );
    expect(doc).toContain(
      `${n(d.wallets.withOne)} of the ${n(REGISTRY.wallets)} wallets (${pc(d.wallets.withOnePercent)}) registered one each, and together they made ${n(d.wallets.withOneRegistrations)} registrations (${pc(d.wallets.withOneRegistrationsPercent)}). The largest bucket, ${d.wallets.topBucket}, holds one wallet. No other wallet made more than ${n(d.wallets.nextLargest)}.`
    );
    expect(doc).toContain(
      `The one wallet that registered ${THRESHOLDS.largeWallet} or more made ${n(d.largeWallets.registrations)} registrations. All ${n(d.largeWallets.registrations)} are on one host name, and it gave each of them a profile link of its own. That host name is the largest, and every registration stored for it was made by this wallet.`
    );
    expect(doc).toContain(
      `${n(d.hosts.withHttps)} of the ${n(registrations)} registrations (${pc(d.hosts.withHttpsPercent)}) have an https link, on ${n(REGISTRY.hosts)} host names. The largest host name holds ${n(d.hosts.largest)} of them (${pc(d.hosts.largestPercent)}), which is ${pc(d.hosts.largestOfAllPercent)} of all the registrations. The next holds ${n(d.hosts.second)} (${pc(d.hosts.secondPercent)}) and the third holds ${n(d.hosts.third)}. The two largest together hold ${n(d.hosts.twoLargest)} (${pc(d.hosts.twoLargestPercent)}). One host name holds ${THRESHOLDS.largeHost} or more registrations, ${n(d.hosts.atLeastThresholdRegistrations)} of them (${pc(d.hosts.atLeastThresholdPercent)} of those with an https link and ${pc(d.hosts.atLeastThresholdOfAllPercent)} of all).`
    );
    expect(doc).toContain(
      `The largest host name is at the ${n(CHAIN.hostRowCap)} rows a host may keep. Query 0b counts ${n(d.hosts.overflowLargest)} more registrations for it, so it holds ${n(d.hosts.largestHeld)} in all, ${pc(d.hosts.largestHeldPercent)} of the ${n(REGISTRY.onChain)}. The ${n(REGISTRY.overflow)} are ${pc(d.hosts.overflowPercent)} of the ${n(REGISTRY.onChain)}.`
    );
    expect(doc).toContain(
      `${n(d.links.usedOnce)} of the ${n(d.links.total)} different profile links (${pc(d.links.usedOncePercent)}) are used by one registration each. ${n(d.links.shared)} are used by more than one, by ${n(d.links.sharedRegistrations)} registrations (${pc(d.links.sharedRegistrationsPercent)}). No profile link is used by ${THRESHOLDS.bigLink} or more registrations, and the most any one link has is ${n(d.links.largest)} (${pc(d.links.largestPercent)} of all the registrations). ${n(REGISTRY.noUriSet)} registrations set no profile link.`
    );
    expect(doc).toContain(
      `${n(d.names.placeholder)} of the ${n(registrations)} registrations (${pc(d.names.placeholderPercent)}) carry the placeholder name. The other ${n(d.names.named)} carry ${n(d.names.distinct)} distinct names, and ${n(d.names.sharing)} registrations (${pc(d.names.sharingPercent)}) share a name with at least one other. No name is shared by ${THRESHOLDS.sharedName} or more, and the largest group is ${n(d.names.largestGroup)}.`
    );
    expect(doc).toContain(
      `${n(d.activity.transfers)} transfers after the mint are recorded, on ${n(d.activity.changedHands)} registrations (${pc(d.activity.changedHandsPercent)}). ${n(d.activity.noTransfer)} registrations (${pc(d.activity.noTransferPercent)}) have had none. ${n(d.activity.handouts)} hand-outs are recorded, on ${n(d.activity.handedOut)} registrations (${pc(d.activity.handedOutPercent)}), and the other transfer came later than the first hour or from another wallet.`
    );
    expect(doc).toContain(`${n(d.activity.edits)} profile-link edits are recorded, on ${n(d.activity.edited)} registrations (${pc(d.activity.editedPercent)}).`);
    const [first, second, third] = d.time.monthsWithNone;
    expect(doc).toContain(
      `${n(d.time.firstMonthRegistrations)} of the registrations (${pc(d.time.firstMonthPercent)}) were made in ${d.time.firstMonth}, the registry's first month. Of the ${n(d.time.wholeLaterMonths)} whole months after it, ${n(d.time.laterMonths)} have a registration, between ${n(d.time.laterLow)} and ${n(d.time.laterHigh)} each and ${n(d.time.laterMonthsRegistrations)} in all (${pc(d.time.laterMonthsPercent)}), and ${n(d.time.monthsWithNoneCount)} have none: ${first}, ${second} and ${third}. ${d.time.passMonth}, the month of the pass, has none so far. The ${n(d.time.days)} days from ${d.time.firstDay} to ${d.time.lastDay} that have a registration hold ${n(d.time.daysRegistrations)} registrations (${pc(d.time.daysPercent)}), one each, and the other ${n(d.time.daysWithNone)} of the ${n(CHAIN.dayWindow)} days that end on ${d.time.lastDay} had none. The newest stored registration is dated ${d.time.lastDay}, ${n(d.time.daysBeforeThePass)} days before the day of the pass, ${d.time.passDay}.`
    );
  });

  it("states the figures that are not from the queries, with their source", () => {
    expect(doc).toContain("## Figures that are not from the queries");
    expect(doc).toContain(
      `${n(PUBLIC.listed)}, the public count of listed entries, and ${n(PUBLIC.onChain)}, the public count of registrations on the chain, read from \`GET /api/v1/stats\` on 2026-11-06 at 23:17 UTC.`
    );
    expect(doc).toContain(`The two block times (${n(CHAIN.firstBlock)} at ${CHAIN.firstBlockTime} UTC and ${n(CHAIN.recentBlock)} at ${CHAIN.recentBlockTime} UTC)`);
    expect(doc).toContain(
      `${CHAIN.dateErrorMinutes} minutes and ${CHAIN.dateMedianErrorMinutes} minutes, the worst and the median distance of a date from the real block time, over the ${n(CHAIN.dateChecked)} registrations whose logs carry one`
    );
  });

  it("defines a hand-out, the cap and the dates as the code does, and says what the measurement cannot say", () => {
    const chains = read("..", "..", "..", "server", "ingestion", "erc8004Chains.ts");
    // Gnosis's entry is the last one before the list of all of them, so the slice is its entry and nothing of another chain.
    const gnosis = chains.slice(chains.indexOf("export const GNOSIS_CHAIN"), chains.indexOf("export const ERC8004_CHAINS"));
    expect(gnosis.length).toBeGreaterThan(500);
    expect(gnosis).not.toMatch(/MONAD|BASE_CHAIN|ARC_CHAIN/);
    expect(gnosis).toContain(`handoutBlockWindow: ${CHAIN.handoutBlocks},`);
    expect(gnosis).toContain(`chainId: ${CHAIN.id},`);
    expect(gnosis).toContain(`deployBlock: ${underscored(CHAIN.firstBlock)},`);
    expect(chains).toContain(`deploy block ${n(CHAIN.firstBlock)} (${CHAIN.firstBlockTime} UTC)`);
    expect(chains).toContain(`export const FLOOD_HOST_ROW_CAP = ${underscored(CHAIN.hostRowCap)};`);
    expect(gnosis).toContain("hostRowCap: FLOOD_HOST_ROW_CAP,");
    expect(doc).toContain(`(${n(CHAIN.handoutBlocks)} blocks, \`handoutBlockWindow\` in \`server/ingestion/erc8004Chains.ts\`)`);
    expect(doc).toContain(`Gnosis's block time is close to constant, about ${CHAIN.blockSecondsLow} to ${CHAIN.blockSecondsHigh} seconds a block, with a slot missed now and then`);
    expect(doc).toContain(
      `A day and a month are both dated through the same ${CHAIN.stretches} stretches of ${n(CHAIN.stretchBlocks)} blocks, the last one shorter, so there is no separate rate for a day`
    );
    expect(doc).toContain(
      `The first stretch starts at the registry's first block, ${n(CHAIN.firstBlock)} (${CHAIN.firstBlockTime} UTC), the last runs to the finalized block, ${n(CHAIN.recentBlock)} (${CHAIN.recentBlockTime} UTC)`
    );
    expect(doc).toContain(
      `A date is within about ${CHAIN.dateErrorMinutes} minutes of the real time at the worst and ${CHAIN.dateMedianErrorMinutes} minutes at the median (checked against the block times in the logs of all ${n(CHAIN.dateChecked)} registrations, stored or not)`
    );
    expect(doc).not.toMatch(/last 200,000 blocks|0\.30268|counted back/);
    expect(doc).toContain("## What this measurement cannot say");
    expect(doc).toContain("**It is not a count of people.**");
    expect(doc).toContain("**The registering wallet is not the holder.**");
    expect(doc).toContain("**A hand-out is a timing fact.**");
    expect(doc).toContain("**The stored registrations are not a sample of the chain.**");
    expect(doc).toContain("**The months and days are the most affected.**");
    expect(doc).toContain("**Ratings are not measured here.**");
    expect(doc).toContain("**The dates are worked out.**");
    expect(doc).toContain("**The listing rules were not changed.**");
  });

  it("keeps the queries in the repository, all of them reads, with the thresholds the page speaks of", () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT)\b/im);
    expect(sql.match(/^\s*(WITH|SELECT)\b/gim)!.length).toBeGreaterThanOrEqual(15);
    // Fifteen statements, each a WITH or a SELECT, and each that reads the registry's rows, its cap counts or its ledger reads Gnosis's protocol and no other.
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
        expect(statement, "a statement that reads the registry and not Gnosis's source").toContain("protocol = 'erc8004_gnosis'");
      }
      // The registry's rows and its cap counts are read from the active source only.
      if (/agent_directory_registry_rows|agent_directory_registry_overflow/.test(statement)) expect(statement, "a statement that reads a source that is not active").toContain("state = 'active'");
    }
    expect([...new Set([...sql.matchAll(/protocol = '([a-z0-9_]+)'/g)].map(match => match[1]))]).toEqual(["erc8004_gnosis"]);
    expect(sql, "a name of another chain left in the queries").not.toMatch(/monad|ethereum|erc8004_base|erc8004_arc/i);
    const reads = (sql.match(/FROM agent_directory_registry_rows r/g) ?? []).length;
    expect(reads).toBeGreaterThanOrEqual(13);
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
    // The hand-out hour of query 8's comment is the chain's, and the window of query 10a is the page's.
    expect(sql).toContain(`${n(CHAIN.handoutBlocks)} blocks on Gnosis`);
    expect(sql).toContain("mintBlock is unsigned, so it is cast before the subtraction");
    expect(sql).toContain(`INTERVAL ${CHAIN.dayWindow} DAY`);
    expect(sql).toContain(`chain id ${CHAIN.id}`);
  });

  /** The stretches of a CASE in the queries file, in the order the file lists them, with the position of each in the file. */
  const stretchesInFile = () =>
    [...sql.matchAll(/WHEN b >= (\d+) THEN TIMESTAMPADD\(SECOND, ROUND\(([0-9.]+) \* \(b - \1\)\), '([0-9-]+ [0-9:]+)'\)/g)].map(match => ({
      start: Number(match[1]),
      seconds: Number(match[2]),
      time: match[3]!,
      at: match.index!,
    }));
  const utc = (stamp: string) => Date.parse(`${stamp.replace(" ", "T")}Z`) / 1000;
  const stamp = (seconds: number) => new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);

  it("dates a day and a month through the same stretches, listed later start first, from the registry's first block to the finalized block, each meeting the next", () => {
    const all = stretchesInFile();
    // Two CASE blocks, the day query's and the month query's, with the same stretches in each.
    expect(all.length).toBe(2 * CHAIN.stretches);
    const forDays = all.slice(0, CHAIN.stretches);
    const forMonths = all.slice(CHAIN.stretches);
    expect(forDays.every(stretch => stretch.at < sql.indexOf("-- Q10b."))).toBe(true);
    expect(forMonths.every(stretch => stretch.at > sql.indexOf("-- Q10b."))).toBe(true);
    expect(forDays.map(({ start, seconds, time }) => ({ start, seconds, time })), "the day query and the month query use different stretches").toEqual(
      forMonths.map(({ start, seconds, time }) => ({ start, seconds, time }))
    );
    // A CASE takes the first WHEN that matches, so the starts must fall: a stretch listed after a later one would never be reached.
    forMonths.forEach((stretch, index) => {
      if (index > 0) expect(stretch.start, `stretch ${index + 1} starts before the one after it`).toBeLessThan(forMonths[index - 1]!.start);
    });
    const ascending = [...forMonths].reverse();
    // The first stretch starts at the registry's first block, and each starts one step of 250,000 blocks after the one before.
    expect(ascending[0]!.start).toBe(CHAIN.firstBlock);
    expect(ascending[0]!.time).toBe(CHAIN.firstBlockTime);
    ascending.forEach((stretch, index) => expect(stretch.start).toBe(CHAIN.firstBlock + index * CHAIN.stretchBlocks));
    // The last stretch starts before the finalized block and is the shorter: less than a step of blocks lies between its start and the finalized block.
    const last = ascending[ascending.length - 1]!;
    expect(last.start).toBeLessThan(CHAIN.recentBlock);
    expect(CHAIN.recentBlock - last.start).toBeLessThan(CHAIN.stretchBlocks);
    // Each stretch's rate carries its start time to the next stretch's start time (the last one to the finalized block's time), within two seconds of rounding.
    ascending.forEach((stretch, index) => {
      const next = ascending[index + 1];
      const reachesBlock = next ? next.start : CHAIN.recentBlock;
      const reachesTime = next ? next.time : CHAIN.recentBlockTime;
      const arrives = utc(stretch.time) + Math.round(stretch.seconds * (reachesBlock - stretch.start));
      expect(Math.abs(arrives - utc(reachesTime)), `stretch ${index + 1} does not reach the time of the block after it`).toBeLessThanOrEqual(2);
      if (next) expect(utc(next.time)).toBeGreaterThan(utc(stretch.time));
    });
    // The block time is close to constant: the page says about 5.1 to 5.2 seconds, and the lowest and the highest stretch are those two.
    const rates = forMonths.map(stretch => stretch.seconds);
    for (const rate of rates) expect(Math.round(rate * 10) / 10, `a stretch of ${rate} seconds a block`).toBeGreaterThanOrEqual(CHAIN.blockSecondsLow);
    for (const rate of rates) expect(Math.round(rate * 10) / 10, `a stretch of ${rate} seconds a block`).toBeLessThanOrEqual(CHAIN.blockSecondsHigh);
    expect(Math.round(Math.min(...rates) * 10) / 10).toBe(CHAIN.blockSecondsLow);
    expect(Math.round(Math.max(...rates) * 10) / 10).toBe(CHAIN.blockSecondsHigh);
    expect(sql).toContain(`${ascending.length} stretches of ${n(CHAIN.stretchBlocks)} blocks`);
  });

  it("dates the oldest and the newest mint block of query 9 in the first month of query 10b and on the last day of query 10a, through those stretches", () => {
    const stretches = stretchesInFile().slice(CHAIN.stretches);
    const datedAt = (block: number) => {
      const stretch = stretches.find(candidate => block >= candidate.start);
      return stretch ? stamp(utc(stretch.time) + Math.round(stretch.seconds * (block - stretch.start))) : null;
    };
    const mint = ledgerKind("mint");
    expect(datedAt(mint[3])!.slice(0, 7), "the oldest mint is in the registry's first month").toBe(d.time.firstMonth);
    expect(datedAt(mint[4])!.slice(0, 10), "the newest mint is on the last day of the window").toBe(d.time.lastDay);
    expect(datedAt(mint[4])!.slice(0, 7), "the newest mint is in the newest month the query returned").toBe(MEASURED.q10b[MEASURED.q10b.length - 1]![0]);
    expect(datedAt(CHAIN.firstBlock)).toBe(CHAIN.firstBlockTime);
    expect(Math.abs(utc(datedAt(CHAIN.recentBlock)!) - utc(CHAIN.recentBlockTime))).toBeLessThanOrEqual(2);
    // Every block of the ledger is dated, and none is dated after the finalized block.
    for (const kind of MEASURED.q9) for (const block of [kind[3], kind[4]]) expect(utc(datedAt(block)!)).toBeLessThanOrEqual(utc(CHAIN.recentBlockTime));
  });

  it("uses the rules the code uses: a link shared by 2, a host by 50, a wallet of 10", () => {
    const rules = read("..", "..", "..", "server", "ingestion", "erc8004Chains.ts");
    expect(rules).toContain("GNOSIS_LISTING_RULES");
    expect(rules).toContain("export const GNOSIS_LISTING_RULES: RegistryListingRules = { sharedProfileLinkFrom: 2, sharedHostFrom: 50, sharedWalletFrom: 10 };");
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
      `The stored registrations are not a sample of the chain. A host name past the cap keeps its first registrations in chain order, so the figures for hosts, wallets, links, months and days describe the stored rows and not all ${n(REGISTRY.onChain)}. Most of the stored rows are the first ${n(CHAIN.hostRowCap)} of one host name.`,
      `The months and days are the most affected. The registrations counted and not stored were made after the ${n(CHAIN.hostRowCap)} their host kept, so the registry's own history is longer than the table shows, and the months after the first look thinner here than they were on the chain.`,
      "Names and links are written by the registrants. We have not verified them.",
      "A date is worked out from a block time, within the margins given above, and is not a clock the chain keeps for the registration.",
    ]) {
      expect(text).toContain(caveat);
    }
    // "Most" is true: the host's stored rows are most of the stored rows.
    expect(MEASURED.q4[0][1] / registrations).toBeGreaterThan(0.5);
  });

  it("ends by saying the census is a snapshot to be redone and dated again, and that nothing here changes the listing rules", () => {
    expect(text).toContain("This census is a snapshot. It will be redone and dated again. Whether the listing rules should change for Gnosis is a decision for later, and nothing here changes them.");
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
    for (const where of [text, pageSource, dataSource, doc, read("gnosisRegistryReport.test.ts")]) expect(where).not.toMatch(domainLike);
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
    for (const where of [text, pageSource, dataSource, doc, sql, read("gnosisRegistryReport.test.ts")]) expect(where).not.toMatch(dashes);
  });
});

describe("the address", () => {
  it("is a route the app draws only while Gnosis's switch is on, the server answers 200 for then, the sitemap lists then, and the Gnosis tab links to", () => {
    expect(read("..", "App.tsx")).toContain(`{featureOn("chain_gnosis", FEATURES) && <Route path="${ROUTE}" component={GnosisRegistryReport} />}`);
    expect(read("..", "..", "..", "server", "clientRoutes.ts")).toContain(`"${ROUTE}"`);
    const sitemap = read("..", "..", "..", "server", "sitemap.ts");
    expect(sitemap).toContain(`"${ROUTE}"`);
    const head = read("..", "..", "..", "server", "routeHead.ts");
    expect(head).toContain(`"${ROUTE}": {`);
    expect(head).toContain('title: "Gnosis registry census, 2026-11-06"');
    // The home tab for Gnosis links to it, and so does the inspector of a group on Gnosis's page.
    expect(read("..", "components", "home", "ChainTabs.tsx")).toContain(`<Link href="${ROUTE}"`);
    expect(CHAIN_GROUP_REPORT.gnosis).toEqual({ href: ROUTE, label: "Gnosis registry census, 6 November 2026" });
    expect(read("ChainExplorer.tsx")).toContain("CHAIN_GROUP_REPORT[chain]");
    // The line under the map links it beside the Gnosis lights.
    expect(read("home", "LandingHero.tsx")).toContain(`<Link href="${ROUTE}"`);
  });
});
