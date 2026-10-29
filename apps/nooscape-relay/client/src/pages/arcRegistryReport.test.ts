import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import type { MapFleet } from "@shared/mapFleets";
import { CHAIN_GROUP_REPORT, registrationShare } from "@/lib/chainExplorerModel";
import { ARC_DOC, ARC_SQL, CHAIN, DERIVED as d, MEASURED, PASS_TIME, REGISTRY, RULES, THRESHOLDS, formatPercent as pc, percent } from "@/lib/arcRegistryReport";
import ArcRegistryReport from "./ArcRegistryReport";

/**
 * The Arc registry census report states numbers that people will quote, so they are held to their source. The page reads
 * lib/arcRegistryReport.ts and nothing else; these render it, check every number on it is one of that file's figures, check each
 * measured row against the document that holds the query output, check the totals add up, and keep the page to the rules the other
 * censuses set: no per-agent rows, no ranking, no score, no tier, no glow, no host, wallet or person named.
 */
const here = import.meta.dirname;
const read = (...parts: string[]) => readFileSync(path.resolve(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const docs = (name: string) => read("..", "..", "..", "docs", name);

const ROUTE = "/field/arc-registry-2026-10-20";
const markup = renderToStaticMarkup(createElement(Router, { ssrPath: ROUTE, children: createElement(ArcRegistryReport) }));
const decode = (value: string) => value.replace(/&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pageSource = read("ArcRegistryReport.tsx");
const dataSource = read("..", "lib", "arcRegistryReport.ts");
const doc = docs("arc-census-2026-10-20.md");
const sql = docs("arc-census-queries-2026-10-20.sql");
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
const n = (value: number) => value.toLocaleString("en-US");
/** The apostrophe the page writes, a right single quotation mark. */
const R = String.fromCharCode(0x2019);

/** Every number in a value, however deep, as the page would write it. */
const numbersIn = (value: unknown): number[] => {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(numbersIn);
  return [];
};
/** The digits inside a size-bucket label such as "10-49" or "50+": they are text the page prints, not figures. */
const labelDigits = (value: unknown): string[] => {
  if (typeof value === "string") return value.match(/\d+/g) ?? [];
  if (Array.isArray(value)) return value.flatMap(labelDigits);
  if (value && typeof value === "object") return Object.values(value).flatMap(labelDigits);
  return [];
};
/** How a figure is written on the page: with thousands separators, or as a share to one decimal place. */
const written = (value: number) => [n(value), value.toFixed(1)];

const registrations = REGISTRY.registrations;
const q = { q0: MEASURED.q0[0], q1: MEASURED.q1[0], q6: MEASURED.q6[0], q8: MEASURED.q8[0] };
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
      ...labelDigits(d.days.buckets),
      // A chain id is an identifier and is written as it is, with no thousands separator.
      String(CHAIN.id),
    ]);
    const withoutTokens = text
      .replace(MEASURED.date, " ")
      .replace(/\b\d{2}:\d{2}\b/g, " ") // a time of day in the header
      .replace(/\b8004\b/g, " ") // the standard's name
      .replace(/\b\d+-\d+\b/g, match => match.replace("-", " ")); // a size bucket such as 10-49, whose parts are checked as labels
    const found = (withoutTokens.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(token => token.replace(/,$/, ""));
    expect(found.length).toBeGreaterThan(80);
    const stray = found.filter(token => !allowed.has(token));
    expect(stray, `numbers on the page that are not in lib/arcRegistryReport.ts: ${[...new Set(stray)].join(", ")}`).toEqual([]);
  });

  it("writes no figure into the page's own source, which would let it drift from the file", () => {
    const literal = (stripComments(pageSource).match(/\b\d[\d,]{2,}\b/g) ?? []).filter(token => !["2026", "8004"].includes(token));
    expect(literal, "a number written into ArcRegistryReport.tsx").toEqual([]);
  });

  it("carries the date and the pass it was counted from in its header", () => {
    expect(text).toContain(`Date ${MEASURED.date}`);
    expect(PASS_TIME).toBe("16:45 UTC");
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
      `Of the ${n(registrations)} registrations, ${n(d.listing.listed)} (${pc(d.listing.listedPercent)}) are listed in the directory. ${n(d.listing.noLink)} (${pc(d.listing.noLinkPercent)}) have no usable profile link. The other ${n(d.listing.heldOut)} (${pc(d.listing.heldOutPercent)}) are held out as shared, not judged.`
    );
    expect(text).toContain(
      `What happened Registrations Listed in the directory ${n(d.listing.listed)} No usable profile link ${n(d.listing.noLink)} Held out first: ${RULES.link} ${n(d.listing.byLink)} Held out first: ${RULES.host} ${n(d.listing.byHost)} Held out first: ${RULES.wallet} ${n(d.listing.byWallet)}`
    );
    expect(text).toContain("A rule that reaches a registration first is not the only one that would have.");
    expect(text).toContain("These are the rules written for the BNB Chain registry, and they have not been changed for Arc. This census says what they did here. It does not say whether they are right for Arc.");
  });

  it("has the findings as sentences, with the denominator stated", () => {
    expect(text).toContain(
      `${n(d.wallets.tenOrMore)} wallets each registered ${THRESHOLDS.tenWallet} or more. Together they made ${n(d.wallets.tenOrMoreRegistrations)} of the ${n(registrations)} registrations (${pc(d.wallets.tenOrMorePercent)}), and the ${n(d.wallets.large)} wallets that registered ${THRESHOLDS.largeWallet} or more made ${n(d.wallets.largeRegistrations)} (${pc(d.wallets.largePercent)}). The largest single wallet made ${n(d.wallets.largest)} (${pc(d.wallets.largestPercent)}).`
    );
    expect(text).toContain(
      `At the other end, ${n(d.wallets.withOne)} of the ${n(REGISTRY.wallets)} wallets (${pc(d.wallets.withOnePercent)}) registered one each. Together they made ${n(d.wallets.withOneRegistrations)} registrations (${pc(d.wallets.withOneRegistrationsPercent)}).`
    );
    expect(text).toContain(
      `Of the ${n(d.largeWallets.count)} wallets that registered ${THRESHOLDS.largeWallet} or more, ${n(d.largeWallets.onOneHost)} have every registration on one host name, and ${n(d.largeWallets.withoutAHost)} have no https host name for any registration. ${n(d.largeWallets.ownLinkEach)} gave every registration a profile link of its own. The other ${n(d.largeWallets.oneLinkForAll)} used one profile link for every registration they made.`
    );
    expect(text).toContain(
      `One wallet${R}s ${n(d.largeWallets.walletIsLargestHostRegistrations)} registrations are all on one host name. That is the largest host name of all, and it holds no other wallet${R}s registration.`
    );
    expect(text).toContain(
      `The ${n(d.largeWallets.oneLinkForAll)} wallets that used one profile link made ${n(d.largeWallets.oneLinkRegistrations)} registrations between them. Only one profile link in the registry is shared by ${THRESHOLDS.bigLink} or more registrations, and each of these wallets has ${THRESHOLDS.bigLink} or more on one link, so all of their registrations are on that one link.`
    );
    expect(text).toContain(
      `${n(d.hosts.withHttps)} of the ${n(registrations)} registrations (${pc(d.hosts.withHttpsPercent)}) have an https link, spread over ${n(REGISTRY.hosts)} host names. One host name holds ${n(d.hosts.largest)} of them (${pc(d.hosts.largestPercent)}), the next holds ${n(d.hosts.second)} and the one after holds ${n(d.hosts.third)}. The two largest together hold ${n(d.hosts.twoLargest)} (${pc(d.hosts.twoLargestPercent)}). ${n(d.hosts.atLeastThreshold)} host names hold ${THRESHOLDS.largeHost} or more registrations each.`
    );
    expect(text).toContain(
      `${n(d.links.usedOnce)} of the ${n(d.links.total)} different profile links (${pc(d.links.usedOncePercent)}) are used by one registration each. ${n(d.links.shared)} are used by more than one, by ${n(d.links.sharedRegistrations)} registrations in all. One link is used by ${n(d.links.bigRegistrations)} registrations (${pc(d.links.bigPercent)}), and ${n(d.links.bigWithHost)} of them have an https host name.`
    );
    expect(text).toContain(`${n(d.names.placeholder)} of the ${n(registrations)} registrations (${pc(d.names.placeholderPercent)}) have no name of their own.`);
    expect(text).toContain(
      `The other ${n(d.names.named)} carry ${n(d.names.distinct)} distinct names, and ${n(d.names.sharing)} registrations (${pc(d.names.sharingPercent)}) share a name with at least one other. No name is shared by ten registrations or more, and the largest group is ${n(d.names.largestGroup)}.`
    );
    expect(text).toContain(`all ${n(d.activity.measured)} registrations have been measured.`);
    expect(text).toContain(
      `${n(d.activity.transfers)} transfers after the mint are recorded, on ${n(d.activity.changedHands)} registrations (${pc(d.activity.changedHandsPercent)}). ${n(d.activity.noTransfer)} registrations (${pc(d.activity.noTransferPercent)}) have had none.`
    );
    expect(text).toContain(
      `${n(d.activity.handedOut)} registrations (${pc(d.activity.handedOutPercent)}) were handed out, each once. A hand-out is a transfer sent from the wallet the registration was minted to, within about an hour of the mint (${n(CHAIN.handoutBlocks)} blocks on Arc). Every transfer after a mint was a hand-out.`
    );
    expect(text).toContain(`${n(d.activity.edits)} edits of a profile link are recorded, on ${n(d.activity.edited)} registrations (${pc(d.activity.editedPercent)}).`);
    expect(text).toContain(
      `The registrations were made over ${n(d.days.count)} chain-days, counted from the first registration. ${n(d.days.twoBusiest)} of them (${pc(d.days.twoBusiestPercent)}) were made on two of those days, one with ${n(d.days.busiest)} and one with ${n(d.days.second)}. No other chain-day has more than ${n(d.days.otherBusiest)}. A chain-day is ${n(CHAIN.dayBlocks)} blocks, about a day at the block time of Arc. It is not a calendar day, and the dates are not stored.`
    );
    expect(text).toContain("Ratings are not measured for Arc. Nooscape reads no reputation registry for it, so this census says nothing about ratings.");
  });

  it("shows every returned row of the wallet, link and chain-day tables", () => {
    for (const row of MEASURED.q2) expect(text).toContain(`${row[0]} ${n(row[1])} ${n(row[2])}`);
    for (const row of MEASURED.q5) expect(text).toContain(`${row[0]} ${n(row[1])} ${n(row[2])}`);
    for (const row of d.days.buckets) expect(text).toContain(`${row[0]} ${n(row[1])} ${n(row[2])}`);
  });

  it("says Arc reads a name only from the chain event, so the placeholder count is not a figure that falls", () => {
    expect(text).toContain("Nooscape reads a name only from registration data written into the chain event itself. It fetches no registration link for Arc, so the placeholder count changes only as new registrations are made.");
    expect(text).toContain("Two registrations with the same name are not necessarily the same agent or the same person.");
  });
});

describe("shares are given to one decimal place and agree with the Arc page", () => {
  it("rounds to the nearest tenth and writes it with one decimal", () => {
    expect(percent(2268, 2587)).toBe(87.7);
    expect(percent(897, 2587)).toBe(34.7);
    expect(pc(percent(897, 2587))).toBe("34.7%");
    expect(pc(percent(1000, 2587))).toBe("38.7%");
    expect(pc(percent(1, 3))).toBe("33.3%");
  });

  it("gives the same shares as the Arc page does for the same wallets and registrations", () => {
    const wallets: MapFleet[] = MEASURED.q3.map(row => ({ id: `w${row[0]}`, kind: "wallet", chain: "arc", name: null, wallet: null, registry: null, count: row[1], wallets: 1 }));
    const share = registrationShare(wallets, registrations)!;
    // The page's headline rounds down to a whole number, and its chips give one decimal place.
    expect(share.held).toBe(d.wallets.largeRegistrations);
    expect(share.wallets).toBe(d.wallets.large);
    expect(share.percent).toBe(Math.floor(d.wallets.largePercent));
    expect(share.segments.map(segment => segment.percent)).toEqual(MEASURED.q3.map(row => percent(row[1], registrations)));
  });
});

describe("the totals add up", () => {
  it("queries 0, 1, 6 and 8 and the mints in query 9 agree on the registrations, and the directory's count is the listed row of query 7", () => {
    expect(q.q0[0]).toBe(registrations);
    expect(q.q6[0]).toBe(registrations);
    expect(q.q8[0]).toBe(registrations);
    expect(ledgerKind("mint")[1]).toBe(registrations);
    expect(ledgerKind("mint")[2]).toBe(registrations);
    expect(registrations).toBe(2587);
    expect(q.q0[5]).toBe(d.listing.listed);
    expect(REGISTRY.hidden, "the page says nothing is hidden by saying nothing, and the document says none is").toBe(0);
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

  it("the wallets of query 3 are the wallets of the three largest buckets of query 2, with the same registrations", () => {
    const upper = [walletBucket("50-99"), walletBucket("100-999"), walletBucket("1000+")];
    expect(MEASURED.q3.length).toBe(sum(upper.map(row => row[1])));
    expect(sum(MEASURED.q3.map(row => row[1]))).toBe(sum(upper.map(row => row[2])));
    expect(MEASURED.q3[0][1]).toBe(walletBucket("1000+")[3]);
    expect(Math.min(...MEASURED.q3.map(row => row[1]))).toBeGreaterThanOrEqual(THRESHOLDS.largeWallet);
    // In order of the registrations column, with the same ranks 1, 2, 3 and on.
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
    expect(d.largeWallets.count).toBe(MEASURED.q3.length);
    expect(d.largeWallets.onOneHost + d.largeWallets.withoutAHost).toBeLessThanOrEqual(d.largeWallets.count);
    expect(d.largeWallets.ownLinkEach + d.largeWallets.oneLinkForAll, "the page says the other wallets used one link for every registration").toBe(d.largeWallets.count);
  });

  it("host sizes fall from the largest, and are parts of the registrations with a link", () => {
    const ranked = MEASURED.q4.filter(row => row[0] > 0);
    ranked.forEach((row, index) => {
      expect(row[0]).toBe(index + 1);
      if (index > 0) expect(row[1]).toBeLessThanOrEqual(ranked[index - 1]![1]);
    });
    expect(sum(ranked.map(row => row[1]))).toBeLessThanOrEqual(REGISTRY.withHttpsHost);
    expect(d.hosts.withHttps + d.hosts.withoutHost).toBe(registrations);
    expect(REGISTRY.hosts).toBeGreaterThanOrEqual(ranked.length);
    // Every host name in the five largest that holds the threshold or more is counted at rank 0, so at least that many hold it, and no more than all of them.
    expect(d.hosts.atLeastThreshold).toBe(ranked.filter(row => row[1] >= THRESHOLDS.largeHost).length);
    expect(d.hosts.atLeastThreshold).toBeLessThanOrEqual(REGISTRY.hosts);
  });

  it("one wallet's registrations are the whole of the largest host name", () => {
    const wallet = MEASURED.q3.find(row => row[4] === 1 && row[1] === row[2] && row[2] === row[3] && row[1] === d.hosts.largest)!;
    // Every one of its registrations has an https link, all on one host name, so that host name holds at least that many.
    expect(wallet).toBeDefined();
    // No host name holds more than the largest, which holds exactly that many, and the next is smaller: one host name, and no other registration on it.
    expect(d.hosts.largest).toBe(wallet[1]);
    expect(d.hosts.largest).toBeGreaterThan(d.hosts.second);
    expect(d.largeWallets.walletIsLargestHost).toBe(true);
    expect(d.largeWallets.walletIsLargestHostRegistrations).toBe(wallet[1]);
  });

  it("profile links add up to the different links and the registrations, and the shared ones are the registrations the link rule reached first", () => {
    expect(d.links.total).toBe(REGISTRY.profileLinks);
    expect(sum(MEASURED.q5.map(row => row[2])) + REGISTRY.noUriSet).toBe(registrations);
    for (const row of MEASURED.q5) {
      expect(row[3], `${row[0]}: the largest cannot be more than the bucket`).toBeLessThanOrEqual(row[2]);
      expect(row[4], `${row[0]}: registrations with a host cannot be more than the bucket`).toBeLessThanOrEqual(row[2]);
    }
    expect(linkBucket("1")[1]).toBe(linkBucket("1")[2]);
    expect(d.links.sharedRegistrations).toBe(d.listing.byLink);
    expect(d.links.shared).toBe(sum(MEASURED.q5.filter(row => row[0] !== "1").map(row => row[1])));
  });

  it("only one link is shared by 50 or more registrations, and the wallets that used one link for everything are all on it", () => {
    expect(linkBucket("50+")[1], "the page says only one profile link is shared by 50 or more registrations").toBe(1);
    expect(d.links.bigWithHost, "the document says none of its registrations has an https host name").toBe(0);
    const oneLink = MEASURED.q3.filter(row => row[5] === 1);
    expect(oneLink.length).toBe(d.largeWallets.oneLinkForAll);
    for (const row of oneLink) expect(row[1], "each has the threshold or more on a single link").toBeGreaterThanOrEqual(THRESHOLDS.bigLink);
    // They cannot be on different links of that size, since there is only one, so their registrations are parts of it.
    expect(d.largeWallets.oneLinkRegistrations).toBeLessThanOrEqual(linkBucket("50+")[3]);
    expect(d.links.bigRegistrations).toBe(linkBucket("50+")[2]);
  });

  it("names: the placeholders and the named registrations add up, and the shared names are among the named", () => {
    expect(d.names.placeholder + d.names.named).toBe(registrations);
    expect(d.names.distinct).toBeLessThanOrEqual(d.names.named);
    expect(d.names.sharing).toBeLessThanOrEqual(d.names.named);
    expect(d.names.sharedByTenOrMore, "the page says no name is shared by ten registrations or more").toBe(0);
    expect(d.names.largestGroup).toBeLessThan(THRESHOLDS.sharedName);
  });

  it("the listing states add up to the registrations, and the rules reached held-out registrations in the order they run", () => {
    expect(sum(MEASURED.q7.map(row => row[3]))).toBe(registrations);
    expect(d.listing.listed + d.listing.noLink + d.listing.heldOut).toBe(registrations);
    expect(d.listing.byLink + d.listing.byHost + d.listing.byWallet).toBe(d.listing.heldOut);
    for (const row of MEASURED.q7) expect(row[2] === "-", `${row[1]}: only a registration held out as shared has a first rule`).toBe(row[0] !== 2);
    expect(MEASURED.q7.filter(row => row[0] === 2).map(row => row[2]).sort()).toEqual([RULES.host, RULES.link, RULES.wallet].sort());
  });

  it("transfers, hand-outs and edits agree with the activity ledger, and every transfer was a hand-out", () => {
    expect(ledgerKind("secondary")[1]).toBe(q.q8[3]);
    expect(ledgerKind("secondary")[2]).toBe(q.q8[5]);
    expect(ledgerKind("uri_update")[1]).toBe(q.q8[7]);
    expect(ledgerKind("uri_update")[2]).toBe(q.q8[8]);
    for (const row of MEASURED.q9) expect(row[3]).toBeLessThanOrEqual(row[4]);
    expect(MEASURED.q9.map(row => row[0])).toEqual(["mint", "secondary", "uri_update"]);
    expect(d.activity.handouts).toBeLessThanOrEqual(d.activity.transfers);
    expect(d.activity.handedOut).toBeLessThanOrEqual(d.activity.changedHands);
    expect(d.activity.laterTransfers, "the page says every transfer after a mint was a hand-out").toBe(0);
    expect(d.activity.handouts, "the page says each registration was handed out once").toBe(d.activity.handedOut);
    expect(d.activity.noTransfer + d.activity.changedHands).toBe(registrations);
  });

  it("the chain-days add up to the registrations, count from day zero without a gap, and the two busiest are the two the page says", () => {
    expect(sum(MEASURED.q10.map(row => row[1]))).toBe(registrations);
    MEASURED.q10.forEach((row, index) => expect(row[0]).toBe(index));
    expect(d.days.count).toBe(MEASURED.q10.length);
    const counts = MEASURED.q10.map(row => row[1]).sort((a, b) => b - a);
    expect([d.days.busiest, d.days.second, d.days.otherBusiest]).toEqual(counts.slice(0, 3));
    expect(d.days.busiest).toBeGreaterThan(d.days.second);
    expect(d.days.second).toBeGreaterThan(d.days.otherBusiest);
    expect(sum(d.days.buckets.map(row => row[1]))).toBe(d.days.count);
    expect(sum(d.days.buckets.map(row => row[2]))).toBe(registrations);
  });
});

describe("each measured row is in the measurement document", () => {
  const row = (cells: ReadonlyArray<string | number>) => `| ${cells.join(" | ")} |`;

  it("names itself, and says what was and was not selected and fetched", () => {
    expect(ARC_DOC).toBe("docs/arc-census-2026-10-20.md");
    expect(ARC_SQL).toBe("docs/arc-census-queries-2026-10-20.sql");
    expect(doc).toContain("no name, no wallet address, no host name and no profile link was selected, and nothing was fetched from any site for it");
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
    ["query 7", MEASURED.q7],
    ["query 8", MEASURED.q8],
    ["query 9", MEASURED.q9],
    ["query 10", MEASURED.q10],
  ];
  for (const [name, rows] of TABLES) {
    it(`has every row of ${name}, as the query returned it`, () => {
      expect(rows.length).toBeGreaterThan(0);
      for (const cells of rows) expect(doc, `${name}: ${row(cells)}`).toContain(row(cells));
    });
  }

  it("has the figures the page works out, worded as the document words them", () => {
    expect(doc).toContain(
      `${n(d.listing.listed)} of the ${n(registrations)} registrations (${pc(d.listing.listedPercent)}) are listed. ${n(d.listing.noLink)} (${pc(d.listing.noLinkPercent)}) have no usable profile link. ${n(d.listing.heldOut)} (${pc(d.listing.heldOutPercent)}) are held out as shared: ${n(d.listing.byLink)} reached first by a shared profile link, ${n(d.listing.byHost)} by a shared host name and ${n(d.listing.byWallet)} by a wallet that registered ${THRESHOLDS.tenWallet} or more.`
    );
    expect(doc).toContain(
      `${n(d.wallets.tenOrMore)} wallets made ${n(d.wallets.tenOrMoreRegistrations)} of the ${n(registrations)} registrations (${pc(d.wallets.tenOrMorePercent)}), and ${n(d.wallets.large)} wallets made ${n(d.wallets.largeRegistrations)} (${pc(d.wallets.largePercent)}). The largest single wallet made ${n(d.wallets.largest)} (${pc(d.wallets.largestPercent)}).`
    );
    expect(doc).toContain(
      `${n(d.wallets.withOne)} of the ${n(REGISTRY.wallets)} wallets (${pc(d.wallets.withOnePercent)}) registered one each, and together they made ${n(d.wallets.withOneRegistrations)} registrations (${pc(d.wallets.withOneRegistrationsPercent)}).`
    );
    expect(doc).toContain(
      `${n(d.largeWallets.onOneHost)} of the ${n(d.largeWallets.count)} wallets that made ${THRESHOLDS.largeWallet} or more have every registration on one host name, and ${n(d.largeWallets.withoutAHost)} have no https host name for any registration. ${n(d.largeWallets.ownLinkEach)} gave every registration a profile link of its own. The other ${n(d.largeWallets.oneLinkForAll)} used one link for every registration they made, ${n(d.largeWallets.oneLinkRegistrations)} registrations between them.`
    );
    expect(doc).toContain(
      `One wallet's ${n(d.largeWallets.walletIsLargestHostRegistrations)} registrations are all on one host name. The largest host name holds ${n(d.hosts.largest)} registrations and the next holds ${n(d.hosts.second)}, so that wallet's registrations are the whole of the largest host name.`
    );
    expect(doc).toContain(
      `${n(d.hosts.withHttps)} of the ${n(registrations)} registrations (${pc(d.hosts.withHttpsPercent)}) have an https link, on ${n(REGISTRY.hosts)} host names. The largest host name holds ${n(d.hosts.largest)} of them (${pc(d.hosts.largestPercent)}), the next holds ${n(d.hosts.second)} and the third holds ${n(d.hosts.third)}. The two largest together hold ${n(d.hosts.twoLargest)} (${pc(d.hosts.twoLargestPercent)}). ${n(d.hosts.atLeastThreshold)} host names hold ${THRESHOLDS.largeHost} or more registrations.`
    );
    expect(doc).toContain(
      `${n(d.links.usedOnce)} of the ${n(d.links.total)} different profile links (${pc(d.links.usedOncePercent)}) are used by one registration each. ${n(d.links.shared)} are used by more than one, by ${n(d.links.sharedRegistrations)} registrations. One link is used by ${n(d.links.bigRegistrations)} registrations (${pc(d.links.bigPercent)}), and none of them has an https host name. ${n(REGISTRY.noUriSet)} registrations set no profile link.`
    );
    expect(doc).toContain(
      `${n(d.names.placeholder)} of the ${n(registrations)} registrations (${pc(d.names.placeholderPercent)}) carry the placeholder name. The other ${n(d.names.named)} carry ${n(d.names.distinct)} distinct names, and ${n(d.names.sharing)} registrations (${pc(d.names.sharingPercent)}) share a name with at least one other. No name is shared by ${THRESHOLDS.sharedName} or more registrations, and the largest group is ${n(d.names.largestGroup)}.`
    );
    expect(doc).toContain(
      `${n(d.activity.transfers)} transfers after the mint are recorded, on ${n(d.activity.changedHands)} registrations (${pc(d.activity.changedHandsPercent)}). ${n(d.activity.noTransfer)} registrations (${pc(d.activity.noTransferPercent)}) have had none. ${n(d.activity.handedOut)} registrations (${pc(d.activity.handedOutPercent)}) were handed out, each once, and every transfer after a mint was a hand-out.`
    );
    expect(doc).toContain(`${n(d.activity.edits)} profile-link edits are recorded, on ${n(d.activity.edited)} registrations (${pc(d.activity.editedPercent)}).`);
    expect(doc).toContain(
      `The registrations were made over ${n(d.days.count)} chain-days. ${n(d.days.twoBusiest)} of them (${pc(d.days.twoBusiestPercent)}) were made on two days, one with ${n(d.days.busiest)} and one with ${n(d.days.second)}. No other chain-day has more than ${n(d.days.otherBusiest)}.`
    );
    const [thousand, hundred, tens, units] = d.days.buckets;
    expect(doc).toContain(
      `${n(thousand![1])} chain-day had 1,000 or more, ${n(hundred![1])} had 100 to 999, ${n(tens![1])} had 10 to 99 and ${n(units![1])} had 1 to 9.`
    );
  });

  it("defines a hand-out as the code does, and says what the measurement cannot say", () => {
    expect(read("..", "..", "..", "server", "ingestion", "erc8004Chains.ts")).toContain(`handoutBlockWindow: ${CHAIN.handoutBlocks.toLocaleString("en-US").replace(",", "_")},`);
    expect(read("..", "..", "..", "server", "ingestion", "erc8004Chains.ts")).toContain(`chainId: ${CHAIN.id},`);
    expect(doc).toContain(`(${n(CHAIN.handoutBlocks)} blocks, \`handoutBlockWindow\` in \`server/ingestion/erc8004Chains.ts\`)`);
    expect(doc).toContain(`**chain-day**: ${n(CHAIN.dayBlocks)} blocks`);
    expect(doc).toContain("## What this measurement cannot say");
    expect(doc).toContain("**It is not a count of people.**");
    expect(doc).toContain("**The registering wallet is not the holder.**");
    expect(doc).toContain("**A hand-out is a timing fact.**");
    expect(doc).toContain("**There are no ratings.**");
    expect(doc).toContain("**The listing rules were not changed.**");
  });

  it("keeps the queries in the repository, all of them reads, with the thresholds the page speaks of", () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT)\b/im);
    expect(sql.match(/^\s*(WITH|SELECT)\b/gim)!.length).toBeGreaterThanOrEqual(11);
    // Every statement that reads the registry's registrations reads the active source of Arc's protocol.
    const reads = (sql.match(/FROM agent_directory_registry_rows r/g) ?? []).length;
    expect(reads).toBeGreaterThanOrEqual(10);
    expect(sql.split("s.protocol = 'erc8004_arc'").length - 1).toBeGreaterThanOrEqual(reads);
    expect(sql.split("s.state = 'active'").length - 1).toBeGreaterThanOrEqual(reads);
    expect(sql).toContain(`HAVING COUNT(*) >= ${THRESHOLDS.largeWallet}`);
    expect(sql).toContain(`WHERE n >= ${THRESHOLDS.largeHost}`);
    expect(sql).toContain(`WHERE n >= ${THRESHOLDS.sharedName}`);
    // The first rule that reached a registration is worked out in the order, and with the numbers, the listing rules run.
    expect(sql).toContain("WHEN link_n >= 2");
    expect(sql).toContain(`WHEN host_n >= ${THRESHOLDS.largeHost}`);
    expect(sql).toContain(`WHEN wallet_n >= ${THRESHOLDS.tenWallet}`);
    expect(sql.indexOf("WHEN link_n >= 2")).toBeLessThan(sql.indexOf("WHEN host_n >= 50"));
    expect(sql.indexOf("WHEN host_n >= 50")).toBeLessThan(sql.indexOf("WHEN wallet_n >= 10"));
    expect(sql).toContain(`/ ${CHAIN.dayBlocks}`);
  });

  it("uses the rules the code uses: a link shared by 2, a host by 50, a wallet of 10", () => {
    const rules = read("..", "..", "..", "server", "ingestion", "erc8004Chains.ts");
    expect(rules).toContain("ARC_LISTING_RULES");
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
      "It is one moment. Arc is read only when a pass is started by hand, so the figures move only when one is.",
    ]) {
      expect(text).toContain(caveat);
    }
  });

  it("ends by saying the census is a snapshot to be redone and dated again, and that nothing here changes the listing rules", () => {
    expect(text).toContain("This census is a snapshot. It will be redone and dated again. Whether the listing rules should change for Arc is a decision for later, and nothing here changes them.");
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
  it("is a route the app draws only while Arc's switch is on, the server answers 200 for then, the sitemap lists then, and the Arc pages link to", () => {
    expect(read("..", "App.tsx")).toContain(`{featureOn("chain_arc", FEATURES) && <Route path="${ROUTE}" component={ArcRegistryReport} />}`);
    expect(read("..", "..", "..", "server", "clientRoutes.ts")).toContain(`"${ROUTE}"`);
    const sitemap = read("..", "..", "..", "server", "sitemap.ts");
    expect(sitemap).toContain(`"${ROUTE}"`);
    const head = read("..", "..", "..", "server", "routeHead.ts");
    expect(head).toContain(`"${ROUTE}": {`);
    expect(head).toContain('title: "Arc registry census, 2026-10-20"');
    // The home tab, the map's caption, the Arc page's share note and the card of a selected group all link to it.
    expect(read("..", "components", "home", "ChainTabs.tsx")).toContain(`<Link href="${ROUTE}"`);
    expect(read("home", "LandingHero.tsx")).toContain(`<Link href="${ROUTE}"`);
    expect(CHAIN_GROUP_REPORT.arc).toEqual({ href: ROUTE, label: "Arc registry census, 20 October 2026" });
    expect(read("..", "components", "chain", "RegistrationShare.tsx")).toContain("CHAIN_GROUP_REPORT.arc");
  });
});
