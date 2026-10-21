import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import type { MapFleet } from "@shared/mapFleets";
import { CHAIN_GROUP_REPORT, registrationShare } from "@/lib/chainExplorerModel";
import { DERIVED as d, MEASURED, PASS_TIME, REGISTRY, ROBINHOOD_DOC, ROBINHOOD_SQL, THRESHOLDS, formatPercent as pc, percent } from "@/lib/robinhoodRegistryReport";
import RobinhoodRegistryReport from "./RobinhoodRegistryReport";

/**
 * The Robinhood Chain registry census report states numbers that people will quote, so they are held to their source. The page
 * reads lib/robinhoodRegistryReport.ts and nothing else; these render it, check every number on it is one of that file's figures,
 * check each measured row against the document that holds the query output, check the totals add up, and keep the page to the
 * rules the BNB and Solana censuses set: no per-agent rows, no ranking, no score, no tier, no glow, no host, wallet or person named.
 */
const here = import.meta.dirname;
const read = (...parts: string[]) => readFileSync(path.resolve(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const docs = (name: string) => read("..", "..", "..", "docs", name);

const ROUTE = "/field/robinhood-registry-2026-10-20";
const markup = renderToStaticMarkup(createElement(Router, { ssrPath: ROUTE, children: createElement(RobinhoodRegistryReport) }));
const decode = (value: string) => value.replace(/&rsquo;/g, "’").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
const text = decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pageSource = read("RobinhoodRegistryReport.tsx");
const dataSource = read("..", "lib", "robinhoodRegistryReport.ts");
const doc = docs("robinhood-census-2026-10-20.md");
const sql = docs("robinhood-census-queries-2026-10-20.sql");
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
/** The digits inside a size-bucket label such as "10-99" or "100+": they are text the page prints, not figures. */
const labelDigits = (value: unknown): string[] => {
  if (typeof value === "string") return value.match(/\d+/g) ?? [];
  if (Array.isArray(value)) return value.flatMap(labelDigits);
  if (value && typeof value === "object") return Object.values(value).flatMap(labelDigits);
  return [];
};
/** How a figure is written on the page: with thousands separators, or as a share to one decimal place. */
const written = (value: number) => [n(value), value.toFixed(1)];

const entriesOf = REGISTRY.entries;
const q = {
  q1: MEASURED.q1[0],
  q5: MEASURED.q5[0],
  q6: MEASURED.q6[0],
};
const walletBucket = (name: string) => MEASURED.q2.find(row => row[0] === name)!;
const perEntry = (what: "transfers" | "edits", bucket: string) => MEASURED.q6b.find(row => row[0] === what && row[1] === bucket)?.[2] ?? 0;
const ledgerKind = (kind: string) => MEASURED.q7.find(row => row[0] === kind)!;
const reputationKind = (kind: string) => MEASURED.q8.find(row => row[0] === kind)!;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const plural = (count: number) => `${n(count)} wallet${count === 1 ? "" : "s"}`;

describe("the numbers on the page are the numbers in the data file", () => {
  it("has no number that is not a measured value, a derived value, a threshold or a label of a size bucket", () => {
    const allowed = new Set([
      ...[...numbersIn(MEASURED), ...numbersIn(d), ...numbersIn(THRESHOLDS)].flatMap(written),
      ...labelDigits(MEASURED.q2),
      ...labelDigits(MEASURED.q6b),
      ...labelDigits(MEASURED.q9),
    ]);
    const withoutTokens = text
      .replace(MEASURED.date, " ")
      .replace(/\b\d{2}:\d{2}\b/g, " ") // a time of day in the header
      .replace(/\b8004\b/g, " ") // the standard's name
      .replace(/\b\d+-\d+\b/g, match => match.replace("-", " ")); // a size bucket such as 10-99, whose parts are checked as labels
    const found = (withoutTokens.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(token => token.replace(/,$/, ""));
    expect(found.length).toBeGreaterThan(80);
    const stray = found.filter(token => !allowed.has(token));
    expect(stray, `numbers on the page that are not in lib/robinhoodRegistryReport.ts: ${[...new Set(stray)].join(", ")}`).toEqual([]);
  });

  it("writes no figure into the page's own source, which would let it drift from the file", () => {
    const literal = (stripComments(pageSource).match(/\b\d[\d,]{2,}\b/g) ?? []).filter(token => !["2026", "8004"].includes(token));
    expect(literal, "a number written into RobinhoodRegistryReport.tsx").toEqual([]);
  });

  it("carries the date and the pass it was counted from in its header", () => {
    expect(text).toContain(`Date ${MEASURED.date}`);
    expect(PASS_TIME).toBe("02:15 UTC");
    expect(text).toContain(`Counted from the registry pass that finished at ${PASS_TIME}`);
  });

  it("states the registry's size and surface in one table", () => {
    expect(text).toContain(
      `What was counted Count Entries the directory shows ${n(entriesOf)} Registering wallets ${n(REGISTRY.wallets)} Entries with an https link ${n(REGISTRY.withHttpsHost)} Host names of those links ${n(REGISTRY.hosts)}`
    );
    expect(text).toContain(`${n(d.hosts.withoutHost)} entries (${pc(d.hosts.withoutHostPercent)}) have no https host name recorded.`);
  });

  it("has the findings as sentences, with the denominator stated", () => {
    expect(text).toContain(
      `${n(d.wallets.large)} wallets are each recorded against ${THRESHOLDS.largeWallet} or more entries. Together they hold ${n(d.wallets.largeEntries)} of the ${n(entriesOf)} entries (${pc(d.wallets.largePercent)}), and the ${n(d.wallets.tenOrMore)} wallets with ten or more hold ${n(d.wallets.tenOrMoreEntries)} (${pc(d.wallets.tenOrMorePercent)}). The largest single wallet holds ${n(d.wallets.largest)} (${pc(d.wallets.largestPercent)}).`
    );
    expect(text).toContain(
      `At the other end, ${n(d.wallets.withOne)} of the ${n(REGISTRY.wallets)} wallets (${pc(d.wallets.withOnePercent)}) hold one entry each. Together they hold ${n(d.wallets.withOneEntries)} entries (${pc(d.wallets.withOneEntriesPercent)}).`
    );
    expect(text).toContain(
      `The ${n(d.wallets.large)} wallets with ${THRESHOLDS.largeWallet} or more entries use few host names. ${n(d.largeWallets.onOneHost)} of them have every entry on one host name. The other uses ${n(d.largeWallets.severalHosts)} host names, and ${n(d.largeWallets.severalOnLargest)} of its ${n(d.largeWallets.severalWithHttps)} entries that have an https link are on the largest.`
    );
    expect(text).toContain(
      `The largest wallet${R}s ${n(d.largeWallets.largestWalletEntries)} entries are all on one host name. That is the largest host name of all, and it holds no other wallet${R}s entry.`
    );
    expect(text).toContain(
      `${n(d.hosts.withHttps)} of the ${n(entriesOf)} entries (${pc(d.hosts.withHttpsPercent)}) have an https link, spread over ${n(REGISTRY.hosts)} host names. One host name holds ${n(d.hosts.largest)} of them (${pc(d.hosts.largestPercent)}), the next holds ${n(d.hosts.second)}, and the two together hold ${n(d.hosts.twoLargest)} (${pc(d.hosts.twoLargestPercent)}). ${n(d.hosts.atLeastThreshold)} host names hold ${THRESHOLDS.largeHost} or more entries each.`
    );
    expect(text).toContain(
      `${n(d.names.placeholder)} of the ${n(entriesOf)} entries (${pc(d.names.placeholderPercent)}) have no name of their own.`
    );
    expect(text).toContain(
      `The other ${n(d.names.named)} carry ${n(d.names.distinct)} distinct names, and ${n(d.names.sharing)} entries (${pc(d.names.sharingPercent)}) share a name with at least one other. No name is shared by ten entries or more, and the largest group is ${n(d.names.largestGroup)}.`
    );
    expect(text).toContain(`all ${n(d.activity.measured)} entries have been measured.`);
    expect(text).toContain(
      `${n(d.activity.transfers)} transfers after the mint are recorded, on ${n(d.activity.changedHands)} entries (${pc(d.activity.changedHandsPercent)}). ${n(d.activity.noTransfer)} entries (${pc(d.activity.noTransferPercent)}) have had none.`
    );
    expect(text).toContain(
      `${n(d.activity.handedOut)} entries (${pc(d.activity.handedOutPercent)}) were handed out, each once. A hand-out is a transfer sent from the wallet the entry was minted to, within about an hour of the mint. The other ${n(d.activity.laterTransfers)} transfers came later than the first hour or from another wallet.`
    );
    expect(text).toContain(`${n(d.activity.edits)} edits of a registration link are recorded, on ${n(d.activity.edited)} entries (${pc(d.activity.editedPercent)}).`);
    expect(text).toContain(
      `${n(d.ratings.written)} ratings were written, about ${n(d.ratings.agentsRated)} agents, by ${n(d.ratings.raters)} wallets. ${n(d.ratings.revoked)} revocations were recorded, about ${n(d.ratings.revokedAgents)} agents, by ${plural(d.ratings.revokers)}.`
    );
    expect(text).toContain(
      `The ${n(d.ratings.biggestRaters)} wallets in the largest bucket wrote ${n(d.ratings.biggestRatersRatings)} of the ${n(d.ratings.written)} ratings (${pc(d.ratings.biggestRatersPercent)}), and the largest wrote ${n(d.ratings.largestRater)} (${pc(d.ratings.largestRaterPercent)}). No agent holds more than ${n(d.ratings.mostPerAgent)} ratings.`
    );
  });

  it("shows every returned row of the wallet, per-entry and rating tables", () => {
    for (const row of MEASURED.q2) expect(text).toContain(`${row[0]} ${n(row[1])} ${n(row[2])}`);
    for (const bucket of ["0", "1", "2-4", "5+"]) expect(text).toContain(`${bucket} ${n(perEntry("transfers", bucket))} ${n(perEntry("edits", bucket))}`);
    for (const row of MEASURED.q9) expect(text).toContain(`${row[1]} ${n(row[2])} ${n(row[3])}`);
  });

  it("says a rating is a count of records that is not weighed, and the name figure is a snapshot", () => {
    expect(text).toContain("A rating here is a count of records. Nooscape does not weigh or endorse them, and this census does not read what any of them says.");
    expect(text).toContain("The placeholder count falls every day, so it is a snapshot of a figure that moves.");
    expect(text).toContain("Two entries with the same name are not necessarily the same agent or the same person.");
  });
});

describe("shares are given to one decimal place and agree with the chain page", () => {
  it("rounds to the nearest tenth and writes it with one decimal", () => {
    expect(percent(8137, 9191)).toBe(88.5);
    expect(percent(6892, 9191)).toBe(75);
    expect(pc(percent(6892, 9191))).toBe("75.0%");
    expect(pc(percent(6901, 9191))).toBe("75.1%");
    expect(pc(percent(1, 3))).toBe("33.3%");
  });

  it("gives the same shares as the Robinhood Chain page does for the same wallets and entries", () => {
    const wallets: MapFleet[] = MEASURED.q3.map(row => ({ id: `w${row[0]}`, kind: "wallet", chain: "robinhood", name: null, wallet: null, registry: null, count: row[1], wallets: null }));
    const share = registrationShare(wallets, entriesOf)!;
    // The page's headline rounds down to a whole number, and its chips give one decimal place.
    expect(share.held).toBe(d.wallets.largeEntries);
    expect(share.wallets).toBe(d.wallets.large);
    expect(share.percent).toBe(Math.floor(d.wallets.largePercent));
    expect(share.segments.map(segment => segment.percent)).toEqual(MEASURED.q3.map(row => percent(row[1], entriesOf)));
  });
});

describe("the totals add up", () => {
  it("queries 0, 1, 5 and 6 and the mints in query 7 agree on the entries", () => {
    expect(MEASURED.q0[0][0]).toBe(entriesOf);
    expect(q.q5[0]).toBe(entriesOf);
    expect(q.q6[0]).toBe(entriesOf);
    expect(ledgerKind("mint")[1]).toBe(entriesOf);
    expect(ledgerKind("mint")[2]).toBe(entriesOf);
    expect(entriesOf).toBe(9191);
  });

  it("every entry has a wallet, and every entry was measured by the activity walk", () => {
    expect(REGISTRY.noWallet).toBe(0);
    expect(REGISTRY.mintMeasured).toBe(entriesOf);
    expect(q.q6[1]).toBe(entriesOf);
    expect(q.q6[2]).toBe(entriesOf);
  });

  it("wallet buckets add up to the wallets and the entries", () => {
    expect(sum(MEASURED.q2.map(row => row[1]))).toBe(REGISTRY.wallets);
    expect(sum(MEASURED.q2.map(row => row[2]))).toBe(entriesOf);
    for (const row of MEASURED.q2) expect(row[3], `${row[0]}: the largest holding cannot be more than the bucket`).toBeLessThanOrEqual(row[2]);
  });

  it("the wallets of query 3 are the wallets of the two largest buckets of query 2, with the same entries", () => {
    const upper = [walletBucket("100-999"), walletBucket("1000+")];
    expect(MEASURED.q3.length).toBe(sum(upper.map(row => row[1])));
    expect(sum(MEASURED.q3.map(row => row[1]))).toBe(sum(upper.map(row => row[2])));
    expect(MEASURED.q3[0][1]).toBe(walletBucket("1000+")[3]);
    expect(Math.min(...MEASURED.q3.map(row => row[1]))).toBeGreaterThanOrEqual(THRESHOLDS.largeWallet);
    // In order of the entries column, with the same ranks 1, 2, 3 and on.
    MEASURED.q3.forEach((row, index) => {
      expect(row[0]).toBe(index + 1);
      if (index > 0) expect(row[1]).toBeLessThanOrEqual(MEASURED.q3[index - 1]![1]);
    });
  });

  it("each large wallet's entries with a link, and the part on its largest host name, are parts of its entries", () => {
    for (const row of MEASURED.q3) {
      expect(row[2]).toBeLessThanOrEqual(row[1]);
      expect(row[3]).toBeLessThanOrEqual(row[2]);
      expect(row[4]).toBeGreaterThanOrEqual(1);
    }
    expect(sum(MEASURED.q3.map(row => row[2]))).toBeLessThanOrEqual(REGISTRY.withHttpsHost);
    expect(d.largeWallets.onOneHost + d.largeWallets.onSeveralHosts).toBe(MEASURED.q3.length);
    expect(d.largeWallets.onSeveralHosts, "the page speaks of one wallet that uses several host names").toBe(1);
  });

  it("host sizes fall from the largest, and are parts of the entries with a link", () => {
    const ranked = MEASURED.q4.filter(row => row[0] > 0);
    ranked.forEach((row, index) => {
      expect(row[0]).toBe(index + 1);
      if (index > 0) expect(row[1]).toBeLessThanOrEqual(ranked[index - 1]![1]);
    });
    expect(sum(ranked.map(row => row[1]))).toBeLessThanOrEqual(REGISTRY.withHttpsHost);
    expect(d.hosts.withHttps + d.hosts.withoutHost).toBe(entriesOf);
    expect(REGISTRY.hosts).toBeGreaterThanOrEqual(ranked.length);
    // Every host name in the five largest holds the threshold or more, so at least that many hold it.
    expect(d.hosts.atLeastThreshold).toBeGreaterThanOrEqual(ranked.filter(row => row[1] >= THRESHOLDS.largeHost).length);
    expect(d.hosts.atLeastThreshold).toBeLessThanOrEqual(REGISTRY.hosts);
  });

  it("the largest wallet's entries are the whole of the largest host name", () => {
    const wallet = MEASURED.q3[0];
    // Every one of its entries has an https link, all on one host name, so that host name holds at least that many.
    expect(wallet[4]).toBe(1);
    expect(wallet[1]).toBe(wallet[2]);
    expect(wallet[2]).toBe(wallet[3]);
    // No host name holds more than the largest, which holds exactly that many, and the next is smaller: one host name, and no other entry on it.
    expect(d.hosts.largest).toBe(wallet[1]);
    expect(d.hosts.largest).toBeGreaterThan(d.hosts.second);
    expect(d.largeWallets.largestWalletIsLargestHost).toBe(true);
  });

  it("names: the placeholders and the named entries add up, and the shared names are among the named", () => {
    expect(d.names.placeholder + d.names.named).toBe(entriesOf);
    expect(d.names.distinct).toBeLessThanOrEqual(d.names.named);
    expect(d.names.sharing).toBeLessThanOrEqual(d.names.named);
    expect(d.names.sharedByTenOrMore, "the page says no name is shared by ten entries or more").toBe(0);
    expect(d.names.sharedByTenOrMore).toBeLessThanOrEqual(d.names.sharing);
    expect(d.names.largestGroup).toBeLessThan(THRESHOLDS.sharedName);
  });

  it("the entries by transfers and by edits each add up to the entries, and agree with the totals", () => {
    const transferBuckets = MEASURED.q6b.filter(row => row[0] === "transfers");
    const editBuckets = MEASURED.q6b.filter(row => row[0] === "edits");
    expect(sum(transferBuckets.map(row => row[2]))).toBe(entriesOf);
    expect(sum(editBuckets.map(row => row[2]))).toBe(entriesOf);
    expect(perEntry("transfers", "0")).toBe(entriesOf - q.q6[5]);
    expect(perEntry("transfers", "1") + perEntry("transfers", "2-4") + perEntry("transfers", "5+")).toBe(q.q6[5]);
    expect(perEntry("edits", "1") + perEntry("edits", "2-4") + perEntry("edits", "5+")).toBe(q.q6[8]);
    // The totals fit the buckets: at least the least the buckets allow, and for transfers (no bucket of five or more) at most the most.
    expect(q.q6[3]).toBeGreaterThanOrEqual(perEntry("transfers", "1") + 2 * perEntry("transfers", "2-4") + 5 * perEntry("transfers", "5+"));
    expect(perEntry("transfers", "5+")).toBe(0);
    expect(q.q6[3]).toBeLessThanOrEqual(perEntry("transfers", "1") + 4 * perEntry("transfers", "2-4"));
    expect(q.q6[7]).toBeGreaterThanOrEqual(perEntry("edits", "1") + 2 * perEntry("edits", "2-4") + 5 * perEntry("edits", "5+"));
  });

  it("hand-outs are a part of the transfers, and each handed-out entry was handed out once", () => {
    expect(d.activity.handouts).toBeLessThanOrEqual(d.activity.transfers);
    expect(d.activity.handedOut).toBeLessThanOrEqual(d.activity.changedHands);
    expect(d.activity.handouts, "the page says each entry was handed out once").toBe(d.activity.handedOut);
    expect(d.activity.laterTransfers).toBe(d.activity.transfers - d.activity.handouts);
    expect(d.activity.handedOutPercent, "the page speaks of most entries").toBeGreaterThan(50);
  });

  it("the activity ledger agrees with the totals kept for the entries", () => {
    expect(ledgerKind("secondary")[1]).toBe(q.q6[3]);
    expect(ledgerKind("secondary")[2]).toBe(q.q6[5]);
    expect(ledgerKind("uri_update")[1]).toBe(q.q6[7]);
    expect(ledgerKind("uri_update")[2]).toBe(q.q6[8]);
    for (const row of MEASURED.q7) expect(row[3]).toBeLessThanOrEqual(row[4]);
    expect(MEASURED.q7.map(row => row[0])).toEqual(["mint", "secondary", "uri_update"]);
  });

  it("the ratings by agent and by wallet each add up to the ratings written, and to the agents and wallets that appear", () => {
    const byAgent = MEASURED.q9.filter(row => row[0] === "agents");
    const byWallet = MEASURED.q9.filter(row => row[0] === "wallets");
    const newFeedback = reputationKind("new_feedback");
    expect(sum(byAgent.map(row => row[2]))).toBe(newFeedback[2]);
    expect(sum(byAgent.map(row => row[3]))).toBe(newFeedback[1]);
    expect(sum(byWallet.map(row => row[2]))).toBe(newFeedback[3]);
    expect(sum(byWallet.map(row => row[3]))).toBe(newFeedback[1]);
    for (const row of MEASURED.q9) expect(row[4], `${row[0]} ${row[1]}`).toBeLessThanOrEqual(row[3]);
    expect(MEASURED.q8.map(row => row[0])).toEqual(["new_feedback", "feedback_revoked"]);
    for (const row of MEASURED.q8) expect(row[4]).toBeLessThanOrEqual(row[5]);
    // The page says no agent holds more than the largest of the buckets, and that a revocation is a record of its own.
    expect(d.ratings.mostPerAgent).toBe(Math.max(...byAgent.map(row => row[4])));
    expect(d.ratings.written).toBe(newFeedback[1]);
    expect(d.ratings.revoked).toBe(reputationKind("feedback_revoked")[1]);
  });
});

describe("each measured row is in the measurement document", () => {
  const row = (cells: ReadonlyArray<string | number>) => `| ${cells.join(" | ")} |`;

  it("names itself, and says what was and was not selected and fetched", () => {
    expect(ROBINHOOD_DOC).toBe("docs/robinhood-census-2026-10-20.md");
    expect(ROBINHOOD_SQL).toBe("docs/robinhood-census-queries-2026-10-20.sql");
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
    ["query 6b", MEASURED.q6b],
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

  it("has the figures the page works out, worded as the document words them", () => {
    expect(doc).toContain(
      `${n(d.wallets.large)} wallets hold ${n(d.wallets.largeEntries)} of the ${n(entriesOf)} entries (${pc(d.wallets.largePercent)}), and ${n(d.wallets.tenOrMore)} wallets hold ${n(d.wallets.tenOrMoreEntries)} (${pc(d.wallets.tenOrMorePercent)}). The largest single holding is ${n(d.wallets.largest)} (${pc(d.wallets.largestPercent)}).`
    );
    expect(doc).toContain(
      `${n(d.wallets.withOne)} of the ${n(REGISTRY.wallets)} wallets (${pc(d.wallets.withOnePercent)}) hold one entry each, and together they hold ${n(d.wallets.withOneEntries)} entries (${pc(d.wallets.withOneEntriesPercent)}).`
    );
    expect(doc).toContain(
      `${n(d.largeWallets.onOneHost)} of the ${n(d.wallets.large)} wallets that hold ${THRESHOLDS.largeWallet} or more entries have every entry on one host name. The other uses ${n(d.largeWallets.severalHosts)}, with ${n(d.largeWallets.severalOnLargest)} of its ${n(d.largeWallets.severalWithHttps)} entries that have an https link on the largest.`
    );
    expect(doc).toContain(
      `The largest wallet's ${n(d.largeWallets.largestWalletEntries)} entries are on one host name. The largest host name holds ${n(d.hosts.largest)} entries and the next holds ${n(d.hosts.second)}, so the largest wallet's entries are the whole of the largest host name.`
    );
    expect(doc).toContain(
      `${n(d.hosts.withHttps)} of the ${n(entriesOf)} entries (${pc(d.hosts.withHttpsPercent)}) have an https link, on ${n(REGISTRY.hosts)} host names. The largest host name holds ${n(d.hosts.largest)} of them (${pc(d.hosts.largestPercent)}) and the next holds ${n(d.hosts.second)}. The two together hold ${n(d.hosts.twoLargest)} (${pc(d.hosts.twoLargestPercent)}). ${n(d.hosts.atLeastThreshold)} host names hold ${THRESHOLDS.largeHost} or more entries.`
    );
    expect(doc).toContain(
      `${n(d.names.placeholder)} of the ${n(entriesOf)} entries (${pc(d.names.placeholderPercent)}) carry the placeholder name. The other ${n(d.names.named)} carry ${n(d.names.distinct)} distinct names, and ${n(d.names.sharing)} entries (${pc(d.names.sharingPercent)}) share a name with at least one other. No name is shared by ${THRESHOLDS.sharedName} or more entries, and the largest group is ${n(d.names.largestGroup)}.`
    );
    expect(doc).toContain(
      `${n(d.activity.transfers)} transfers after the mint are recorded, on ${n(d.activity.changedHands)} entries (${pc(d.activity.changedHandsPercent)}). ${n(d.activity.noTransfer)} entries (${pc(d.activity.noTransferPercent)}) have had none.`
    );
    expect(doc).toContain(
      `${n(d.activity.handedOut)} entries (${pc(d.activity.handedOutPercent)}) were handed out, each once. The other ${n(d.activity.laterTransfers)} transfers came later than the first hour or from another wallet.`
    );
    expect(doc).toContain(
      `${n(d.activity.edits)} profile-link edits are recorded, on ${n(d.activity.edited)} entries (${pc(d.activity.editedPercent)}): ${n(d.activity.editedOnce)} entries were edited once, ${n(d.activity.editedTwoToFour)} two to four times and ${n(d.activity.editedFiveOrMore)} five times or more.`
    );
    expect(doc).toContain(
      `${n(d.ratings.written)} ratings were written about ${n(d.ratings.agentsRated)} agents, by ${n(d.ratings.raters)} wallets. ${n(d.ratings.revoked)} revocations were recorded, about ${n(d.ratings.revokedAgents)} agents, by ${n(d.ratings.revokers)} wallet.`
    );
    expect(doc).toContain(
      `The ${n(d.ratings.biggestRaters)} wallets in the largest rating bucket wrote ${n(d.ratings.biggestRatersRatings)} of the ${n(d.ratings.written)} ratings (${pc(d.ratings.biggestRatersPercent)}). The largest wrote ${n(d.ratings.largestRater)} (${pc(d.ratings.largestRaterPercent)}). No agent holds more than ${n(d.ratings.mostPerAgent)} ratings.`
    );
  });

  it("defines a hand-out as the code does, and says what the measurement cannot say", () => {
    expect(read("..", "..", "..", "server", "ingestion", "robinhood.ts")).toContain("export const ROBINHOOD_HANDOUT_BLOCK_WINDOW = 36_000;");
    expect(doc).toContain("(36,000 blocks, `ROBINHOOD_HANDOUT_BLOCK_WINDOW` in `server/ingestion/robinhood.ts`)");
    expect(doc).toContain("## What this measurement cannot say");
    expect(doc).toContain("**It is not a count of people.**");
    expect(doc).toContain("**The registering wallet is not the holder.**");
    expect(doc).toContain("**A hand-out is a timing fact.**");
    expect(doc).toContain("**The ratings are the ledger's, whole.**");
  });

  it("keeps the queries in the repository, all of them reads, with the thresholds the page speaks of", () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|GRANT)\b/im);
    expect(sql.match(/^\s*(WITH|SELECT)\b/gim)!.length).toBeGreaterThanOrEqual(11);
    // The visibility rule is the site's, on every statement that reads entries.
    const reads = (sql.match(/FROM agent_directory_entries e/g) ?? []).length;
    expect(reads).toBeGreaterThanOrEqual(8);
    for (const condition of ["e.assetClosedAt IS NULL", "e.hidden = 0", "s.state = 'active'"]) {
      expect(sql.split(condition).length - 1, condition).toBe(reads);
    }
    // The registry's protocol is named once for each read of the entries, and once more by the query that reads the activity ledger.
    expect(sql.split("s.protocol = 'erc8004'").length - 1).toBe(reads + 1);
    expect(sql).toContain(`HAVING COUNT(*) >= ${THRESHOLDS.largeWallet}`);
    expect(sql).toContain(`WHERE n >= ${THRESHOLDS.largeHost}`);
    expect(sql).toContain(`WHERE n >= ${THRESHOLDS.sharedName}`);
  });
});

describe("what the page says, and does not", () => {
  it("has a section called What this does not show, with the caveats", () => {
    expect(text).toContain("What this does not show");
    for (const caveat of [
      "It is not a count of people. A platform can register many agents under one wallet, and one person can use many wallets.",
      "The registering wallet says who registered an entry and not who holds it. Most entries were handed out to another wallet soon after they were minted.",
      "It does not say whether an agent runs. Nothing was asked of any address.",
      "A hand-out is a timing fact. It does not say why an entry was sent on or who received it.",
      "A shared link, host name, wallet or name is a recorded fact. It does not say that one person is behind the entries, or that anything is wrong.",
      "It counts the registrations the directory holds. It does not compare that count with a total from the registry itself.",
      "Names, links and ratings are written by the registrants or by the wallets that used the registry. We have not verified them.",
      "It is one moment. The registry is read again about every half hour, and the figures move with it.",
    ]) {
      expect(text).toContain(caveat);
    }
    expect(text).toContain("The ratings are every rating event the directory has recorded, including a rating of an entry the directory does not show.");
  });

  it("ends by linking /checker and saying the census is a snapshot to be redone and dated again", () => {
    expect(markup).toContain('href="/checker"');
    expect(text).toContain("This census is a snapshot. It will be redone and dated again.");
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

  it("uses no long dash", () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
    for (const where of [text, pageSource, dataSource, doc, sql]) expect(where).not.toMatch(dashes);
  });
});

describe("the address", () => {
  it("is a route the app draws, the server answers 200 for, the sitemap lists, and the Robinhood pages link to", () => {
    expect(read("..", "App.tsx")).toContain(`<Route path="${ROUTE}" component={RobinhoodRegistryReport} />`);
    expect(read("..", "..", "..", "server", "clientRoutes.ts")).toContain(`"${ROUTE}"`);
    expect(read("..", "..", "public", "sitemap.xml")).toContain(`<loc>https://nooscape.si${ROUTE}</loc>`);
    const head = read("..", "..", "..", "server", "routeHead.ts");
    expect(head).toContain(`"${ROUTE}": {`);
    expect(head).toContain('title: "Robinhood Chain registry census, 2026-10-20"');
    // The home tab, the map's caption, the chain page's selected wallet and its share note all link to it.
    expect(read("..", "components", "home", "ChainTabs.tsx")).toContain(`<Link href="${ROUTE}"`);
    expect(read("home", "LandingHero.tsx")).toContain(`<Link href="${ROUTE}"`);
    expect(CHAIN_GROUP_REPORT.robinhood).toEqual({ href: ROUTE, label: "Robinhood Chain registry census, 20 October 2026" });
    expect(read("..", "components", "chain", "RegistrationShare.tsx")).toContain("CHAIN_GROUP_REPORT.robinhood");
  });
});
