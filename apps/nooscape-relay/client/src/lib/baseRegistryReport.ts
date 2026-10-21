/**
 * Every figure on the Base registry census report (/field/base-registry-2026-10-21), in one place. The page reads only this file,
 * and client/src/pages/baseRegistryReport.test.ts fails if a number on the page is not one of these, if one of these does not
 * appear in the measurement document, or if a total here does not add up.
 *
 * MEASURED holds each row of each query exactly as the query returned it, so that the document can be checked against it line by
 * line. The document is docs/base-census-2026-10-21.md and the queries are in docs/base-census-queries-2026-10-21.sql. Nothing was
 * recomputed or filtered after the run. DERIVED holds the totals and percentages the page states, each worked out here from
 * MEASURED, so the page writes no figure of its own.
 *
 * A share is given to one decimal place and rounded to the nearest.
 */
export const BASE_DOC = "docs/base-census-2026-10-21.md";
export const BASE_SQL = "docs/base-census-queries-2026-10-21.sql";

/** The thresholds the queries use: a wallet counts as large from this many registrations, a host name and a profile link from this many, a name is widely shared from this many. */
export const THRESHOLDS = { largeWallet: 50, tenWallet: 10, largeHost: 50, bigLink: 50, sharedName: 10 } as const;

/**
 * What the page says about the chain: its id, the hand-out hour in blocks (`handoutBlockWindow` in server/ingestion/erc8004Chains.ts),
 * the seconds in a block, and the registry's first block with its time in UTC, from which the queries date a registration.
 */
export const CHAIN = { id: 8453, handoutBlocks: 1_800, blockSeconds: 2, firstBlock: 41_663_783, firstBlockTime: "2026-02-03 11:08:33" } as const;

/** The first rule that reaches a registration the listing rules hold out, as query 7 words it. The rules run in this order. */
export const RULES = { link: "profile link shared by 2 or more", host: "host shared by 50 or more", wallet: "wallet that registered 10 or more" } as const;

/** Query 0: the registrations stored, how many are hidden, when a pass first and last saw one, when the source last succeeded, and how many the directory lists. */
export type Q0Row = readonly [registrations: number, hidden: number, firstSeen: string, lastSeen: string, lastSuccess: string, inDirectory: number];
/** Query 1: size and surface. */
export type Q1Row = readonly [registrations: number, wallets: number, noWallet: number, withHttpsHost: number, hosts: number, distinctProfileLinks: number, noUriSet: number, mintMeasured: number];
/** Query 2: a size bucket of registrations made by one wallet, how many wallets fall in it, the registrations they made, and the largest in it. */
export type Q2Row = readonly [bucket: string, wallets: number, registrations: number, largest: number];
/** Query 3: the 25 largest wallets that made the large-wallet threshold or more, by size and never by address. */
export type Q3Row = readonly [walletRank: number, registrations: number, withHttpsHost: number, onItsLargestHost: number, hosts: number, links: number];
/** Query 3b: all the wallets that made the large-wallet threshold or more, in one row. */
export type Q3bRow = readonly [wallets: number, registrations: number, largest: number];
/** Query 4: the ten largest host names by size and never by name. */
export type Q4Row = readonly [hostRank: number, registrations: number];
/** Query 4b: all the host names that hold the large-host threshold or more registrations, in one row. */
export type Q4bRow = readonly [hosts: number, registrations: number, largest: number];
/** Query 5: profile links by how many registrations use one. */
export type Q5Row = readonly [bucket: string, links: number, registrations: number, largest: number, withHttpsHost: number];
/** Query 6: names. */
export type Q6Row = readonly [registrations: number, placeholder: number, distinctNames: number, sharingAName: number, inNamesSharedBy10OrMore: number, largestNameGroup: number];
/** Query 7: what the listing rules did, by state and by the first rule that reached a registration held out. */
export type Q7Row = readonly [listing: number, state: string, firstRule: string, registrations: number];
/** Query 8: the totals the directory keeps for each registration's chain activity. */
export type Q8Row = readonly [
  registrations: number,
  mintMeasured: number,
  coveredByTheWalk: number,
  transfersAfterMint: number,
  handouts: number,
  changedHands: number,
  handedOut: number,
  profileLinkEdits: number,
  edited: number,
];
/** Query 9: the activity ledger by kind of event. */
export type Q9Row = readonly [kind: string, events: number, registrations: number, oldestBlock: number, newestBlock: number];
/** Query 10a: registrations in each of the last 21 UTC days that has one. */
export type Q10aRow = readonly [utcDay: string, registrations: number];
/** Query 10b: registrations in each UTC month. */
export type Q10bRow = readonly [utcMonth: string, registrations: number];

export const MEASURED = {
  date: "2026-10-21",
  q0: [[389902, 0, "2026-10-20 22:02:41", "2026-10-21 01:12:34", "2026-10-21 01:12:50", 9022]] satisfies Q0Row[],
  q1: [[389902, 320751, 0, 344922, 697, 360379, 23303, 389902]] satisfies Q1Row[],
  q2: [
    ["1", 307107, 307107, 1],
    ["2-9", 13261, 31285, 9],
    ["10-49", 306, 5395, 47],
    ["50-99", 32, 2129, 99],
    ["100-999", 35, 9162, 780],
    ["1000+", 10, 34824, 10272],
  ] satisfies Q2Row[],
  q3: [
    [1, 10272, 10271, 9716, 2, 10272],
    [2, 8592, 8481, 7775, 12, 8555],
    [3, 3408, 0, 0, 0, 1],
    [4, 2293, 0, 0, 0, 2293],
    [5, 2125, 2095, 2095, 1, 2125],
    [6, 1944, 1944, 1931, 3, 1943],
    [7, 1931, 0, 0, 0, 1],
    [8, 1683, 0, 0, 0, 1],
    [9, 1331, 4, 2, 3, 1301],
    [10, 1245, 0, 0, 0, 1245],
    [11, 780, 0, 0, 0, 2],
    [12, 774, 774, 774, 1, 774],
    [13, 697, 0, 0, 0, 1],
    [14, 625, 0, 0, 0, 1],
    [15, 558, 512, 437, 29, 319],
    [16, 502, 0, 0, 0, 265],
    [17, 500, 500, 500, 1, 1],
    [18, 320, 0, 0, 0, 320],
    [19, 313, 0, 0, 0, 250],
    [20, 284, 0, 0, 0, 1],
    [21, 270, 0, 0, 0, 1],
    [22, 255, 235, 235, 1, 3],
    [23, 243, 243, 243, 1, 243],
    [24, 237, 0, 0, 0, 233],
    [25, 233, 158, 154, 2, 227],
  ] satisfies Q3Row[],
  q3b: [[77, 46115, 10272]] satisfies Q3bRow[],
  q4: [
    [1, 286832],
    [2, 27726],
    [3, 9721],
    [4, 7827],
    [5, 2584],
    [6, 2095],
    [7, 1252],
    [8, 774],
    [9, 644],
    [10, 506],
  ] satisfies Q4Row[],
  q4b: [[31, 343229, 286832]] satisfies Q4bRow[],
  q5: [
    ["1", 358951, 358951, 1, 341040],
    ["2-9", 1359, 3595, 9, 1180],
    ["10-49", 56, 1099, 46, 443],
    ["50-999", 11, 1703, 500, 1008],
    ["1000+", 1, 1251, 1251, 1251],
  ] satisfies Q5Row[],
  q6: [[389902, 379466, 7042, 4517, 1366, 100]] satisfies Q6Row[],
  q7: [
    [0, "no usable link", "-", 25308],
    [1, "listed", "-", 9022],
    [2, "held out as shared", "host shared by 50 or more", 339767],
    [2, "held out as shared", "profile link shared by 2 or more", 7139],
    [2, "held out as shared", "wallet that registered 10 or more", 8639],
    [4, "name is only a number", "-", 27],
  ] satisfies Q7Row[],
  q8: [[389902, 389902, 389902, 303475, 291526, 303349, 291525, 20016, 11435]] satisfies Q8Row[],
  q9: [
    ["mint", 389902, 389902, 41673162, 52877361],
    ["secondary", 303475, 303349, 41673308, 52877361],
    ["uri_update", 20016, 11435, 41679043, 52873188],
  ] satisfies Q9Row[],
  q10a: [
    ["2026-10-01", 58],
    ["2026-10-02", 340],
    ["2026-10-03", 334],
    ["2026-10-04", 243],
    ["2026-10-05", 210],
    ["2026-10-06", 316],
    ["2026-10-07", 338],
    ["2026-10-08", 300],
    ["2026-10-09", 278],
    ["2026-10-10", 241],
    ["2026-10-11", 971],
    ["2026-10-12", 7282],
    ["2026-10-13", 7897],
    ["2026-10-14", 12081],
    ["2026-10-15", 23106],
    ["2026-10-16", 15541],
    ["2026-10-17", 34779],
    ["2026-10-18", 42914],
    ["2026-10-19", 37900],
    ["2026-10-20", 103386],
    ["2026-10-21", 4750],
  ] satisfies Q10aRow[],
  q10b: [
    ["2026-02", 21641],
    ["2026-03", 16683],
    ["2026-04", 7903],
    ["2026-05", 7818],
    ["2026-06", 3774],
    ["2026-07", 2497],
    ["2026-08", 20308],
    ["2026-09", 16013],
    ["2026-10", 293265],
  ] satisfies Q10bRow[],
} as const;

/** A share of a whole, as a percent to one decimal place. */
export const percent = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;
export const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const q0: Q0Row = MEASURED.q0[0];
const q1: Q1Row = MEASURED.q1[0];
const q3b: Q3bRow = MEASURED.q3b[0];
const q4b: Q4bRow = MEASURED.q4b[0];
const q6: Q6Row = MEASURED.q6[0];
const q8: Q8Row = MEASURED.q8[0];

/** A bucket the query did not return has nothing in it, so it reads as zero. */
const walletBucket = (name: string): Q2Row => MEASURED.q2.find(row => row[0] === name) ?? [name, 0, 0, 0];
const linkBucket = (name: string): Q5Row => MEASURED.q5.find(row => row[0] === name) ?? [name, 0, 0, 0, 0];
const host = (rank: number): number => MEASURED.q4.find(row => row[0] === rank)?.[1] ?? 0;
const listingRows = (listing: number): number => sum(MEASURED.q7.filter(row => row[0] === listing).map(row => row[3]));
const firstRule = (rule: string): number => sum(MEASURED.q7.filter(row => row[2] === rule).map(row => row[3]));

/** The registry as the directory holds it, named for what each figure is. */
export const REGISTRY = {
  registrations: q1[0],
  hidden: q0[1],
  listed: q0[5],
  wallets: q1[1],
  noWallet: q1[2],
  withHttpsHost: q1[3],
  hosts: q1[4],
  /** The different profile links recorded, not counting the registrations that set none (they share the hash of the empty link, which is one value). */
  profileLinks: q1[5] - (q1[6] > 0 ? 1 : 0),
  noUriSet: q1[6],
  mintMeasured: q1[7],
};

const registrations = REGISTRY.registrations;
const one = walletBucket("1");
const ten = walletBucket("10-49");
const thousand = walletBucket("1000+");
const largeWalletCount = q3b[0];
const largeWalletRegistrations = q3b[1];
const tenOrMoreWallets = ten[1] + largeWalletCount;
const tenOrMoreRegistrations = ten[2] + largeWalletRegistrations;

const wallets: readonly Q3Row[] = MEASURED.q3;
const onOneHost = wallets.filter(row => row[2] > 0 && row[1] === row[2] && row[2] === row[3]);
const withoutAHost = wallets.filter(row => row[2] === 0);
const ownLinkEach = wallets.filter(row => row[5] === row[1]);
const oneLinkForAll = wallets.filter(row => row[5] === 1);

const sharedLinks = MEASURED.q5.filter(row => row[0] !== "1");
const bigLinks = [linkBucket("50-999"), linkBucket("1000+")];
const links = sum(MEASURED.q5.map(row => row[1]));

const days = MEASURED.q10a;
const months = MEASURED.q10b;
/** The first UTC day of the run of larger days: every day from here on has more registrations than the busiest day before it (the test checks that). */
const SURGE_FROM = "2026-10-11";
const beforeTheRise = days.filter(row => row[0] < SURGE_FROM);
const sinceTheRise = days.filter(row => row[0] >= SURGE_FROM);
const busiestDay = [...days].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
const busiestMonth = [...months].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
/** The least and most registrations in a UTC day before the rise. */
const dayLow = Math.min(...beforeTheRise.map(row => row[1]));
const dayHigh = Math.max(...beforeTheRise.map(row => row[1]));

export const DERIVED = {
  /** What the listing rules did, over every registration stored. */
  listing: {
    listed: listingRows(1),
    listedPercent: percent(listingRows(1), registrations),
    noLink: listingRows(0),
    noLinkPercent: percent(listingRows(0), registrations),
    heldOut: listingRows(2),
    heldOutPercent: percent(listingRows(2), registrations),
    byLink: firstRule(RULES.link),
    byHost: firstRule(RULES.host),
    byHostPercent: percent(firstRule(RULES.host), registrations),
    byWallet: firstRule(RULES.wallet),
    numberOnly: listingRows(4),
  },
  /** Which wallets made the registrations. */
  wallets: {
    withOne: one[1],
    withOnePercent: percent(one[1], REGISTRY.wallets),
    withOneRegistrations: one[2],
    withOneRegistrationsPercent: percent(one[2], registrations),
    large: largeWalletCount,
    largeRegistrations: largeWalletRegistrations,
    largePercent: percent(largeWalletRegistrations, registrations),
    tenOrMore: tenOrMoreWallets,
    tenOrMoreRegistrations,
    tenOrMorePercent: percent(tenOrMoreRegistrations, registrations),
    thousandOrMore: thousand[1],
    thousandOrMoreRegistrations: thousand[2],
    thousandOrMorePercent: percent(thousand[2], registrations),
    largest: q3b[2],
    largestPercent: percent(q3b[2], registrations),
  },
  /** The 25 largest wallets, and how their registrations are spread across host names and profile links. */
  largeWallets: {
    shown: wallets.length,
    registrations: sum(wallets.map(row => row[1])),
    registrationsPercent: percent(sum(wallets.map(row => row[1])), registrations),
    onOneHost: onOneHost.length,
    withoutAHost: withoutAHost.length,
    ownLinkEach: ownLinkEach.length,
    oneLinkForAll: oneLinkForAll.length,
    oneLinkRegistrations: sum(oneLinkForAll.map(row => row[1])),
    between: wallets.length - ownLinkEach.length - oneLinkForAll.length,
  },
  /** Host names, by size. */
  hosts: {
    withHttps: REGISTRY.withHttpsHost,
    withHttpsPercent: percent(REGISTRY.withHttpsHost, registrations),
    withoutHost: registrations - REGISTRY.withHttpsHost,
    withoutHostPercent: percent(registrations - REGISTRY.withHttpsHost, registrations),
    largest: host(1),
    largestPercent: percent(host(1), REGISTRY.withHttpsHost),
    largestOfAllPercent: percent(host(1), registrations),
    second: host(2),
    secondPercent: percent(host(2), REGISTRY.withHttpsHost),
    third: host(3),
    twoLargest: host(1) + host(2),
    twoLargestPercent: percent(host(1) + host(2), REGISTRY.withHttpsHost),
    atLeastThreshold: q4b[0],
    atLeastThresholdRegistrations: q4b[1],
    atLeastThresholdPercent: percent(q4b[1], REGISTRY.withHttpsHost),
    atLeastThresholdOfAllPercent: percent(q4b[1], registrations),
  },
  /** Profile links, by how many registrations use one. */
  links: {
    total: links,
    usedOnce: linkBucket("1")[1],
    usedOncePercent: percent(linkBucket("1")[1], links),
    shared: sum(sharedLinks.map(row => row[1])),
    sharedRegistrations: sum(sharedLinks.map(row => row[2])),
    sharedRegistrationsPercent: percent(sum(sharedLinks.map(row => row[2])), registrations),
    big: sum(bigLinks.map(row => row[1])),
    bigRegistrations: sum(bigLinks.map(row => row[2])),
    bigPercent: percent(sum(bigLinks.map(row => row[2])), registrations),
    largest: Math.max(...bigLinks.map(row => row[3])),
    largestPercent: percent(Math.max(...bigLinks.map(row => row[3])), registrations),
    largestWithHost: linkBucket("1000+")[4],
  },
  /** Names. */
  names: {
    placeholder: q6[1],
    placeholderPercent: percent(q6[1], registrations),
    named: registrations - q6[1],
    distinct: q6[2],
    sharing: q6[3],
    sharingPercent: percent(q6[3], registrations),
    sharedByTenOrMore: q6[4],
    largestGroup: q6[5],
  },
  /** What the chain records for each registration: transfers after the mint, hand-outs and profile-link edits. */
  activity: {
    measured: q8[2],
    transfers: q8[3],
    changedHands: q8[5],
    changedHandsPercent: percent(q8[5], registrations),
    noTransfer: registrations - q8[5],
    noTransferPercent: percent(registrations - q8[5], registrations),
    handouts: q8[4],
    handedOut: q8[6],
    handedOutPercent: percent(q8[6], registrations),
    /** Transfers that were not a hand-out: they came later than the first hour, or from a wallet other than the one the registration was minted to. */
    laterTransfers: q8[3] - q8[4],
    edits: q8[7],
    edited: q8[8],
    editedPercent: percent(q8[8], registrations),
  },
  /** When the registrations were made, in UTC days and months worked out from the mint block's time. */
  time: {
    months: months.length,
    earlierMonths: months.length - 1,
    busiestMonth: busiestMonth[0],
    busiestMonthRegistrations: busiestMonth[1],
    busiestMonthPercent: percent(busiestMonth[1], registrations),
    firstDay: days[0]?.[0] ?? "",
    lastDay: days[days.length - 1]?.[0] ?? "",
    days: days.length,
    beforeDays: beforeTheRise.length,
    beforeRegistrations: sum(beforeTheRise.map(row => row[1])),
    beforeLow: dayLow,
    beforeHigh: dayHigh,
    riseFrom: SURGE_FROM,
    riseFromRegistrations: days.find(row => row[0] === SURGE_FROM)?.[1] ?? 0,
    sinceDays: sinceTheRise.length,
    sinceRegistrations: sum(sinceTheRise.map(row => row[1])),
    sincePercent: percent(sum(sinceTheRise.map(row => row[1])), registrations),
    busiestDay: busiestDay[0],
    busiestDayRegistrations: busiestDay[1],
    busiestDayPercent: percent(busiestDay[1], registrations),
    /** The last day in query 10a is part of a day: the pass ran at 01:12 UTC. */
    lastDayRegistrations: days[days.length - 1]?.[1] ?? 0,
  },
  /** Query 0, for the header: the time of day, UTC, that the registry's source last succeeded. */
  passTime: q0[4].slice(11, 16),
} as const;

export const PASS_TIME = `${DERIVED.passTime} UTC`;
