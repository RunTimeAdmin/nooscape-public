/**
 * Every figure on the Ethereum registry census report (/field/ethereum-registry-2026-10-28), in one place. The page reads only this file,
 * and client/src/pages/ethereumRegistryReport.test.ts fails if a number on the page is not one of these, if one of these does not
 * appear in the measurement document, or if a total here does not add up.
 *
 * MEASURED holds each row of each query exactly as the query returned it, so that the document can be checked against it line by
 * line. The document is docs/ethereum-census-2026-10-28.md and the queries are in docs/ethereum-census-queries-2026-10-28.sql.
 * Nothing was recomputed or filtered after the run. DERIVED holds the totals and percentages the page states, each worked out here
 * from MEASURED, so the page writes no figure of its own.
 *
 * A share is given to one decimal place and rounded to the nearest.
 */
export const ETHEREUM_DOC = "docs/ethereum-census-2026-10-28.md";
export const ETHEREUM_SQL = "docs/ethereum-census-queries-2026-10-28.sql";

/** The thresholds the queries use: a wallet counts as large from this many registrations, a host name and a profile link from this many, a name is widely shared from this many. */
export const THRESHOLDS = { largeWallet: 50, tenWallet: 10, largeHost: 50, bigLink: 50, sharedName: 10 } as const;

/**
 * What the page says about the chain: its id, the hand-out hour in blocks (`handoutBlockWindow` in server/ingestion/erc8004Chains.ts),
 * the most registry rows one host may keep (`FLOOD_HOST_ROW_CAP`), the seconds in a block when no slot is missed, and the two blocks
 * whose times were read from a public node on 2026-10-28: the registry's first block and the finalized block of the day. The queries
 * date a registration from them, and `dayErrorMinutes` and `monthErrorMinutes` say how far a date can be off in each case.
 */
export const CHAIN = {
  id: 1,
  handoutBlocks: 299,
  hostRowCap: 2_000,
  blockSeconds: 12,
  firstBlock: 24_339_871,
  firstBlockTime: "2026-01-29 10:20:23",
  recentBlock: 26_292_686,
  recentBlockTime: "2026-10-28 17:20:23",
  dayErrorMinutes: 5,
  monthErrorMinutes: 80,
} as const;

/**
 * The seconds a block is taken to last in the two date formulas of the queries, as the file writes them: the average over the last
 * 200,000 blocks for a day (counted back from the finalized block) and the average from the first block to the finalized one for a month.
 */
export const DATING = { daySeconds: "12.038", monthSeconds: "12.04722" } as const;

/**
 * A figure that is not from the queries: the public count of listed entries, read from GET /api/v1/stats on 2026-10-28 at 17:24 UTC.
 * It is one fewer than query 0's entries because one registration is hidden, and a hidden registration is not counted in any public read.
 */
export const PUBLIC = { listed: 5_186 } as const;

/** The first rule that reaches a registration the listing rules hold out, as query 7 words it. The rules run in this order. */
export const RULES = { link: "profile link shared by 2 or more", host: "host shared by 50 or more", wallet: "wallet that registered 10 or more" } as const;

/** Query 0: the registrations stored, how many are hidden, when a pass first and last saw one, when the source last succeeded, and how many the directory lists. */
export type Q0Row = readonly [registrations: number, hidden: number, firstSeen: string, lastSeen: string, lastSuccess: string, inDirectory: number];
/** Query 0b: the flood cap: the hosts past it, the registrations counted and not stored for them, and the largest host's. */
export type Q0bRow = readonly [hostsPastTheCap: number, countedNotStored: number, largestHostOverflow: number];
/** Query 1: size and surface. */
export type Q1Row = readonly [registrations: number, wallets: number, noWallet: number, withHttpsHost: number, hosts: number, distinctProfileLinks: number, noUriSet: number, mintMeasured: number];
/** Query 2: a size bucket of registrations made by one wallet, how many wallets fall in it, the registrations they made, and the largest in it. */
export type Q2Row = readonly [bucket: string, wallets: number, registrations: number, largest: number];
/** Query 3: the 25 largest wallets that made the large-wallet threshold or more, by size and never by address. */
export type Q3Row = readonly [walletRank: number, registrations: number, withHttpsHost: number, onItsLargestHost: number, hosts: number, links: number];
/** Query 3b: all the wallets that made the large-wallet threshold or more, in one row. */
type Q3bRow = readonly [wallets: number, registrations: number, largest: number];
/** Query 4: the ten largest host names by size and never by name. */
export type Q4Row = readonly [hostRank: number, registrations: number];
/** Query 4b: all the host names that hold the large-host threshold or more registrations, in one row. */
type Q4bRow = readonly [hosts: number, registrations: number, largest: number];
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
type Q10aRow = readonly [utcDay: string, registrations: number];
/** Query 10b: registrations in each UTC month. */
type Q10bRow = readonly [utcMonth: string, registrations: number];

export const MEASURED = {
  date: "2026-10-28",
  q0: [[47434, 1, "2026-10-27 12:01:09", "2026-10-28 05:00:07", "2026-10-28 05:00:08", 5187]] satisfies Q0Row[],
  q0b: [[2, 8022, 8000]] satisfies Q0bRow[],
  q1: [[47434, 10877, 0, 13970, 200, 21553, 19579, 47434]] satisfies Q1Row[],
  q2: [
    ["1", 9163, 9163, 1],
    ["2-9", 1405, 5687, 9],
    ["10-49", 268, 3549, 46],
    ["50-99", 14, 851, 81],
    ["100-999", 23, 8072, 779],
    ["1000+", 4, 20112, 9989],
  ] satisfies Q2Row[],
  q3: [
    [1, 9989, 0, 0, 0, 3],
    [2, 7252, 6974, 2000, 15, 7060],
    [3, 1615, 1615, 1615, 1, 1615],
    [4, 1256, 1256, 1256, 1, 1256],
    [5, 779, 0, 0, 0, 1],
    [6, 639, 0, 0, 0, 1],
    [7, 616, 0, 0, 0, 1],
    [8, 569, 0, 0, 0, 1],
    [9, 501, 0, 0, 0, 501],
    [10, 495, 0, 0, 0, 1],
    [11, 430, 0, 0, 0, 1],
    [12, 422, 0, 0, 0, 1],
    [13, 410, 0, 0, 0, 1],
    [14, 396, 0, 0, 0, 1],
    [15, 384, 0, 0, 0, 1],
    [16, 345, 0, 0, 0, 1],
    [17, 289, 289, 289, 1, 289],
    [18, 270, 0, 0, 0, 1],
    [19, 254, 0, 0, 0, 1],
    [20, 254, 0, 0, 0, 1],
    [21, 213, 0, 0, 0, 1],
    [22, 204, 0, 0, 0, 1],
    [23, 182, 182, 182, 1, 182],
    [24, 110, 0, 0, 0, 1],
    [25, 108, 108, 108, 1, 108],
  ] satisfies Q3Row[],
  q3b: [[41, 29035, 9989]] satisfies Q3bRow[],
  q4: [
    [1, 2000],
    [2, 2000],
    [3, 1983],
    [4, 1615],
    [5, 1547],
    [6, 1184],
    [7, 1118],
    [8, 974],
    [9, 226],
    [10, 182],
  ] satisfies Q4Row[],
  q4b: [[17, 13398, 2000]] satisfies Q4bRow[],
  q5: [
    ["1", 20731, 20731, 1, 10569],
    ["2-9", 810, 1926, 8, 1398],
    ["10-49", 6, 77, 17, 20],
    ["50-999", 3, 1095, 731, 0],
    ["1000+", 2, 4026, 2043, 1983],
  ] satisfies Q5Row[],
  q6: [[47434, 37537, 6443, 3881, 2957, 2046]] satisfies Q6Row[],
  q7: [
    [0, "no usable link", "-", 22260],
    [1, "listed", "-", 5187],
    [2, "held out as shared", "host shared by 50 or more", 10073],
    [2, "held out as shared", "profile link shared by 2 or more", 6703],
    [2, "held out as shared", "wallet that registered 10 or more", 3146],
    [4, "name is only a number", "-", 65],
  ] satisfies Q7Row[],
  q8: [[47434, 47434, 47434, 18387, 13728, 14831, 13727, 1580, 623]] satisfies Q8Row[],
  q9: [
    ["mint", 47434, 47434, 24339925, 26284921],
    ["secondary", 18387, 14831, 24340998, 26271450],
    ["uri_update", 1580, 623, 24341020, 26287829],
  ] satisfies Q9Row[],
  q10a: [
    ["2026-10-07", 87],
    ["2026-10-08", 91],
    ["2026-10-09", 68],
    ["2026-10-10", 2],
    ["2026-10-11", 90],
    ["2026-10-12", 71],
    ["2026-10-13", 1221],
    ["2026-10-14", 204],
    ["2026-10-15", 16],
    ["2026-10-16", 65],
    ["2026-10-17", 8],
    ["2026-10-18", 46],
    ["2026-10-19", 27],
    ["2026-10-20", 30],
    ["2026-10-21", 876],
    ["2026-10-22", 44],
    ["2026-10-23", 50],
    ["2026-10-24", 43],
    ["2026-10-25", 54],
    ["2026-10-26", 15],
    ["2026-10-27", 16],
  ] satisfies Q10aRow[],
  q10b: [
    ["2026-01", 22695],
    ["2026-02", 5228],
    ["2026-03", 3854],
    ["2026-04", 270],
    ["2026-05", 2036],
    ["2026-06", 1841],
    ["2026-07", 3025],
    ["2026-08", 3708],
    ["2026-09", 1326],
    ["2026-10", 3451],
  ] satisfies Q10bRow[],
} as const;

/** A share of a whole, as a percent to one decimal place. */
export const percent = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;
export const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const q0: Q0Row = MEASURED.q0[0];
const q0b: Q0bRow = MEASURED.q0b[0];
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
  /** The registrations the directory has stored: the rows the queries count. */
  registrations: q1[0],
  hidden: q0[1],
  /** The entries the directory holds for the registry, hidden or not. */
  listed: q0[5],
  wallets: q1[1],
  noWallet: q1[2],
  withHttpsHost: q1[3],
  hosts: q1[4],
  /** The different profile links recorded, not counting the registrations that set none (they share the hash of the empty link, which is one value). */
  profileLinks: q1[5] - (q1[6] > 0 ? 1 : 0),
  noUriSet: q1[6],
  mintMeasured: q1[7],
  /** The registrations counted and not stored, because their host was past the cap. */
  overflow: q0b[1],
  /** Every registration the directory has counted on the chain: stored and counted. */
  onChain: q1[0] + q0b[1],
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
const firstMonth = months[0] ?? ["", 0];
const laterMonths = months.slice(1);
const byCount = (rows: ReadonlyArray<readonly [string, number]>) => [...rows].sort((a, b) => b[1] - a[1]);
const busiestDays = byCount(days);
const otherDays = busiestDays.slice(2);

export const DERIVED = {
  /** What the listing rules did, over every registration stored. */
  listing: {
    listed: listingRows(1),
    listedPercent: percent(listingRows(1), registrations),
    /** The same listed entries as a share of every registration the directory has counted on the chain, stored or not. */
    listedOfChainPercent: percent(listingRows(1), REGISTRY.onChain),
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
  /** Host names, by size, and the host row cap. A host past the cap keeps `CHAIN.hostRowCap` rows, so query 4 shows it at that size. */
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
    /** The hosts past the cap, and the registrations counted and not stored for them. */
    pastTheCap: q0b[0],
    overflow: q0b[1],
    overflowLargest: q0b[2],
    overflowSecond: q0b[1] - q0b[2],
    /** What the two hosts past the cap hold in all: the rows kept and the registrations counted. */
    largestHeld: host(1) + q0b[2],
    secondHeld: host(2) + (q0b[1] - q0b[2]),
    overflowPercent: percent(q0b[1], REGISTRY.onChain),
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
    inLargestBucket: linkBucket("1000+")[1],
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
  /** When the registrations were made, in UTC months and days worked out from the mint block's time. */
  time: {
    months: months.length,
    firstMonth: firstMonth[0],
    firstMonthRegistrations: firstMonth[1],
    firstMonthPercent: percent(firstMonth[1], registrations),
    /** The months after the first one, and the least and most registrations in one of them. */
    laterMonths: laterMonths.length,
    laterMonthsRegistrations: sum(laterMonths.map(row => row[1])),
    laterMonthsPercent: percent(sum(laterMonths.map(row => row[1])), registrations),
    laterLow: Math.min(...laterMonths.map(row => row[1])),
    laterHigh: Math.max(...laterMonths.map(row => row[1])),
    lastMonth: months[months.length - 1]?.[0] ?? "",
    days: days.length,
    firstDay: days[0]?.[0] ?? "",
    lastDay: days[days.length - 1]?.[0] ?? "",
    daysRegistrations: sum(days.map(row => row[1])),
    daysPercent: percent(sum(days.map(row => row[1])), registrations),
    busiestDay: busiestDays[0]?.[0] ?? "",
    busiestDayRegistrations: busiestDays[0]?.[1] ?? 0,
    busiestDayPercent: percent(busiestDays[0]?.[1] ?? 0, registrations),
    nextBusiestDay: busiestDays[1]?.[0] ?? "",
    nextBusiestDayRegistrations: busiestDays[1]?.[1] ?? 0,
    /** The days other than the two busiest, and the least and most registrations in one of them. */
    otherDays: otherDays.length,
    otherLow: Math.min(...otherDays.map(row => row[1])),
    otherHigh: Math.max(...otherDays.map(row => row[1])),
    /** The UTC day of the pass the census is counted from. No registration is dated after the last day above, which is the day before it. */
    passDay: q0[4].slice(0, 10),
  },
  /** Query 0, for the header: the time of day, UTC, that the registry's source last succeeded. */
  passTime: q0[4].slice(11, 16),
} as const;

export const PASS_TIME = `${DERIVED.passTime} UTC`;
